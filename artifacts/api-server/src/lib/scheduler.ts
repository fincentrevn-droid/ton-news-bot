import { db, schedulesTable, postsTable } from "@workspace/db";
import { eq, and, isNull, gte, sql } from "drizzle-orm";
import { sendTelegramMessage, sendPhotoPost, notifyOwner } from "./telegram";
import { checkAiLimitReached, getOrCreateTodayUsage, getSettings } from "./openai";
import { generateAndQueuePost } from "./auto-generate";
import { logger } from "./logger";

// ─── Time helpers ────────────────────────────────────────────────────────────

function localHHMM(timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function inRange(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

// ─── Window check ─────────────────────────────────────────────────────────────

export function isInActiveWindow(schedule: {
  postingTimezone: string;
  postingStartTime: string;
  postingEndTime: string;
  nightPauseEnabled: boolean;
  nightPauseStart: string;
  nightPauseEnd: string;
}): boolean {
  const now = toMin(localHHMM(schedule.postingTimezone));

  if (schedule.nightPauseEnabled) {
    const ps = toMin(schedule.nightPauseStart);
    const pe = toMin(schedule.nightPauseEnd);
    if (ps !== pe && inRange(now, ps, pe)) return false;
  }

  const ws = toMin(schedule.postingStartTime);
  const we = toMin(schedule.postingEndTime);
  return inRange(now, ws, we);
}

// ─── Daily count (approximate, timezone-aware) ────────────────────────────────

async function countPublishedToday(timezone: string): Promise<number> {
  const [hStr, mStr] = localHHMM(timezone).split(":");
  const minutesSinceMidnight = Number(hStr) * 60 + Number(mStr);
  const since = new Date(Date.now() - minutesSinceMidnight * 60 * 1000);

  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(postsTable)
    .where(and(eq(postsTable.status, "published"), gte(postsTable.publishedAt, since)));
  return Number(row?.count ?? 0);
}

// ─── Quality gate for scheduler ──────────────────────────────────────────────

function passesAutoPublishQuality(post: {
  confidence: string | null;
  safetyStatus: string | null;
  generatedFromSource: boolean | null;
  content: string;
}): boolean {
  if (!post.generatedFromSource) return false;
  if (post.confidence === "low") return false;
  if (post.safetyStatus === "rejected") return false; // "flagged" = links stripped but ok
  if (!post.content.trim()) return false;
  return true;
}

// ─── Auto-generation cooldown (in-memory, resets on restart) ─────────────────

let lastAutoGenerateAttemptMs = 0;
let autoGenerateInProgress = false;

// ─── Main tick ───────────────────────────────────────────────────────────────

export async function tickPublisher(): Promise<void> {
  try {
    const rows = await db.select().from(schedulesTable).limit(1);
    const schedule = rows[0];
    if (!schedule) return;
    if (!schedule.enabled || !schedule.autoPublish) return;

    // Time window check
    if (!isInActiveWindow(schedule)) {
      logger.debug("Scheduler tick: outside active window — skipping");
      return;
    }

    // Daily limit check
    const todayCount = await countPublishedToday(schedule.postingTimezone);
    if (todayCount >= schedule.maxPostsPerDay) {
      logger.debug({ todayCount, max: schedule.maxPostsPerDay }, "Scheduler tick: daily limit reached");
      return;
    }

    // Minimum spacing check (only applies to publishing, not generation trigger)
    if (schedule.lastPublishedAt) {
      let minMs = schedule.minMinutesBetweenPosts * 60 * 1000;
      if (schedule.randomDelayEnabled) {
        const jitter = Math.floor(Math.random() * schedule.randomDelayMinutes * 60 * 1000);
        minMs += jitter;
      }
      const elapsed = Date.now() - new Date(schedule.lastPublishedAt).getTime();
      if (elapsed < minMs) {
        logger.debug(
          { elapsedMin: Math.round(elapsed / 60000), minMin: Math.round(minMs / 60000) },
          "Scheduler tick: too soon since last publish",
        );
        return;
      }
    }

    // Find the oldest queued draft ready for auto-publish
    const candidates = await db
      .select()
      .from(postsTable)
      .where(and(eq(postsTable.status, "draft"), isNull(postsTable.reviewMessageId)))
      .orderBy(postsTable.createdAt)
      .limit(10);

    const post = candidates.find((p) => passesAutoPublishQuality(p));

    if (!post) {
      // Queue is empty — trigger auto-generation if cooldown has passed
      await maybeAutoGenerate(schedule.minMinutesBetweenPosts);
      return;
    }

    // ── Publish the queued post ──────────────────────────────────────────────
    logger.info({ postId: post.id, format: post.postType, confidence: post.confidence }, "Scheduler: auto-publishing post");

    let messageId: number;
    let newFileId: string | null = post.mediaFileId ?? null;

    if (post.hasMedia && post.mediaFileId) {
      const result = await sendPhotoPost(post.mediaFileId, post.content);
      messageId = result.messageId;
      newFileId = result.fileId || post.mediaFileId;
    } else {
      messageId = await sendTelegramMessage(post.content);
    }

    await db
      .update(postsTable)
      .set({
        status: "published",
        telegramMessageId: messageId,
        publishedAt: new Date(),
        ...(newFileId ? { mediaFileId: newFileId } : {}),
      })
      .where(eq(postsTable.id, post.id));

    await db
      .update(schedulesTable)
      .set({ lastPublishedAt: new Date() })
      .where(eq(schedulesTable.id, schedule.id));

    logger.info({ postId: post.id, messageId }, "Scheduler: post published successfully");
  } catch (err) {
    logger.error({ err }, "Scheduler tick error");
  }
}

/**
 * Trigger a background post generation when the queue is empty.
 * Uses a per-process cooldown to avoid generating on every 2-min tick.
 */
async function maybeAutoGenerate(minMinutesBetweenPosts: number): Promise<void> {
  if (autoGenerateInProgress) {
    logger.debug("Scheduler: generation already in progress — skipping");
    return;
  }

  // Cooldown: wait at least minMinutesBetweenPosts between generation attempts
  const cooldownMs = Math.max(minMinutesBetweenPosts, 75) * 60 * 1000;
  const elapsed = Date.now() - lastAutoGenerateAttemptMs;
  if (lastAutoGenerateAttemptMs > 0 && elapsed < cooldownMs) {
    logger.debug(
      { elapsedMin: Math.round(elapsed / 60000), cooldownMin: Math.round(cooldownMs / 60000) },
      "Scheduler: generation cooldown active",
    );
    return;
  }

  // Check AI limits before triggering
  const limit = await checkAiLimitReached();
  if (limit.blocked) {
    logger.info({ reason: limit.reason }, "Scheduler: AI limit reached — skipping auto-generation");
    return;
  }

  // Check daily post count from AI usage table
  const [usage, settings] = await Promise.all([getOrCreateTodayUsage(), getSettings()]);
  if (usage.postsGenerated >= settings.maxPostsPerDay) {
    logger.debug({ generated: usage.postsGenerated, max: settings.maxPostsPerDay }, "Scheduler: daily post limit — skipping generation");
    return;
  }

  lastAutoGenerateAttemptMs = Date.now();
  autoGenerateInProgress = true;
  logger.info("Scheduler: queue empty — triggering auto-generation");

  generateAndQueuePost(notifyOwner)
    .then((result) => {
      if (result) {
        logger.info({ postId: result.postId, queued: result.queued, qc: result.qualityScore }, "Scheduler: auto-generation completed");
      } else {
        logger.info("Scheduler: auto-generation returned no post (no sources or all NO_POST)");
      }
    })
    .catch((err) => {
      logger.error({ err }, "Scheduler: auto-generation failed");
    })
    .finally(() => {
      autoGenerateInProgress = false;
    });
}

// ─── Startup ─────────────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes

export function startSchedulerLoop(): void {
  logger.info({ intervalMs: TICK_INTERVAL_MS }, "Posting scheduler started");
  setInterval(() => {
    tickPublisher().catch((err) => logger.error({ err }, "Unhandled scheduler tick error"));
  }, TICK_INTERVAL_MS);
}
