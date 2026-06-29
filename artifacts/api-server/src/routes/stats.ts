import { Router } from "express";
import { db, postsTable, sourcesTable, aiUsageTable, settingsTable } from "@workspace/db";
import { eq, and, gte, sql } from "drizzle-orm";
import { getOrCreateTodayUsage, getSettings } from "../lib/openai";
import { getChannelStats, isTelegramReaderAvailable } from "../lib/telegram-reader";

const router = Router();

router.get("/stats/dashboard", async (_req, res): Promise<void> => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [
    allPosts,
    publishedToday,
    drafts,
    approved,
    rejected,
    skipped,
    pendingReview,
    safetyRejected,
    sources,
    telegramSources,
    todayUsage,
    settings,
    lastPublished,
  ] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(postsTable),
    db.select({ count: sql<number>`count(*)` }).from(postsTable)
      .where(and(eq(postsTable.status, "published"), gte(postsTable.publishedAt, todayStart))),
    db.select({ count: sql<number>`count(*)` }).from(postsTable).where(eq(postsTable.status, "draft")),
    db.select({ count: sql<number>`count(*)` }).from(postsTable).where(eq(postsTable.status, "approved")),
    db.select({ count: sql<number>`count(*)` }).from(postsTable).where(eq(postsTable.status, "rejected")),
    db.select({ count: sql<number>`count(*)` }).from(postsTable).where(eq(postsTable.status, "skipped")),
    db.select({ count: sql<number>`count(*)` }).from(postsTable)
      .where(and(eq(postsTable.status, "draft"), sql`${postsTable.reviewMessageId} IS NOT NULL`)),
    db.select({ count: sql<number>`count(*)` }).from(postsTable).where(eq(postsTable.safetyStatus, "rejected")),
    db.select({ count: sql<number>`count(*)` }).from(sourcesTable),
    db.select({ count: sql<number>`count(*)` }).from(sourcesTable)
      .where(and(eq(sourcesTable.type, "telegram_channel"), eq(sourcesTable.enabled, true))),
    getOrCreateTodayUsage(),
    getSettings(),
    db.select({ publishedAt: postsTable.publishedAt }).from(postsTable)
      .where(eq(postsTable.status, "published"))
      .orderBy(sql`${postsTable.publishedAt} desc`)
      .limit(1),
  ]);

  const currentModel = process.env.OPENAI_MODEL ?? settings.openaiModel;

  res.json({
    totalPosts: Number(allPosts[0]?.count ?? 0),
    publishedToday: Number(publishedToday[0]?.count ?? 0),
    drafts: Number(drafts[0]?.count ?? 0),
    approved: Number(approved[0]?.count ?? 0),
    rejected: Number(rejected[0]?.count ?? 0),
    skipped: Number(skipped[0]?.count ?? 0),
    pendingReview: Number(pendingReview[0]?.count ?? 0),
    safetyRejected: Number(safetyRejected[0]?.count ?? 0),
    aiCallsToday: todayUsage.callsUsed,
    aiCallsLimit: settings.maxAiCallsPerDay,
    sourcesCount: Number(sources[0]?.count ?? 0),
    telegramSourcesCount: Number(telegramSources[0]?.count ?? 0),
    lastPublishedAt: lastPublished[0]?.publishedAt?.toISOString() ?? null,
    autoPublish: settings.autoPublish,
    postingRequiresApproval: settings.postingRequiresApproval,
    currentModel,
    secondarySourcesEnabled: settings.enableSecondarySourcesi,
  });
});

router.get("/stats/channel", async (_req, res): Promise<void> => {
  if (!isTelegramReaderAvailable()) {
    res.json({ available: false, subscribersCount: null, avgViews: null, avgComments: null, totalForwards: null, postsLast24h: 0 });
    return;
  }
  const stats = await getChannelStats();
  if (!stats) {
    res.json({ available: false, subscribersCount: null, avgViews: null, avgComments: null, totalForwards: null, postsLast24h: 0 });
    return;
  }
  res.json({ available: true, ...stats });
});

router.get("/stats/ai-usage", async (_req, res): Promise<void> => {
  const today = new Date().toISOString().split("T")[0];
  const [usage, settings] = await Promise.all([getOrCreateTodayUsage(), getSettings()]);

  const limitReached =
    usage.callsUsed >= settings.maxAiCallsPerDay ||
    usage.postsGenerated >= settings.maxPostsPerDay;

  res.json({
    date: today,
    callsUsed: usage.callsUsed,
    callsLimit: settings.maxAiCallsPerDay,
    postsGenerated: usage.postsGenerated,
    postsLimit: settings.maxPostsPerDay,
    rewritesUsed: usage.rewritesUsed,
    rewritesLimit: settings.maxRewritePerPost,
    costGuardEnabled: settings.enableCostGuard,
    limitReached,
  });
});

export default router;
