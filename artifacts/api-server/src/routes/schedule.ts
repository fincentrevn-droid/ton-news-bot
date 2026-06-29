import { Router } from "express";
import { db, schedulesTable, postsTable } from "@workspace/db";
import { eq, and, gte, sql } from "drizzle-orm";
import { UpdateScheduleBody } from "@workspace/api-zod";
import { generatePostContent, checkAiLimitReached, incrementAiUsage } from "../lib/openai";
import { sendTelegramMessage, notifyOwner } from "../lib/telegram";
import { logger } from "../lib/logger";

const router = Router();

async function getOrCreateSchedule() {
  const rows = await db.select().from(schedulesTable);
  if (rows.length > 0) return rows[0];
  const [created] = await db.insert(schedulesTable).values({}).returning();
  return created;
}

router.get("/schedule", async (_req, res): Promise<void> => {
  const schedule = await getOrCreateSchedule();
  res.json(schedule);
});

router.patch("/schedule", async (req, res): Promise<void> => {
  const parsed = UpdateScheduleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const schedule = await getOrCreateSchedule();
  const d = parsed.data;
  const updateData: Record<string, unknown> = {};

  if (d.enabled !== undefined) updateData.enabled = d.enabled;
  if (d.intervalHours !== undefined) updateData.intervalHours = d.intervalHours;
  if (d.maxPostsPerDay !== undefined) updateData.maxPostsPerDay = d.maxPostsPerDay;
  if (d.autoPublish !== undefined) updateData.autoPublish = d.autoPublish;
  // Posting window
  if (d.postingTimezone !== undefined) updateData.postingTimezone = d.postingTimezone;
  if (d.postingStartTime !== undefined) updateData.postingStartTime = d.postingStartTime;
  if (d.postingEndTime !== undefined) updateData.postingEndTime = d.postingEndTime;
  // Night pause
  if (d.nightPauseEnabled !== undefined) updateData.nightPauseEnabled = d.nightPauseEnabled;
  if (d.nightPauseStart !== undefined) updateData.nightPauseStart = d.nightPauseStart;
  if (d.nightPauseEnd !== undefined) updateData.nightPauseEnd = d.nightPauseEnd;
  // Daily targets
  if (d.minPostsPerDay !== undefined) updateData.minPostsPerDay = d.minPostsPerDay;
  if (d.targetPostsPerDay !== undefined) updateData.targetPostsPerDay = d.targetPostsPerDay;
  // Spacing
  if (d.minMinutesBetweenPosts !== undefined) updateData.minMinutesBetweenPosts = d.minMinutesBetweenPosts;
  if (d.maxMinutesBetweenPosts !== undefined) updateData.maxMinutesBetweenPosts = d.maxMinutesBetweenPosts;
  if (d.randomDelayEnabled !== undefined) updateData.randomDelayEnabled = d.randomDelayEnabled;
  if (d.randomDelayMinutes !== undefined) updateData.randomDelayMinutes = d.randomDelayMinutes;

  if (d.enabled && !schedule.enabled) {
    const nextRun = new Date();
    nextRun.setHours(nextRun.getHours() + (d.intervalHours ?? schedule.intervalHours));
    updateData.nextRunAt = nextRun;
  }

  const [updated] = await db
    .update(schedulesTable)
    .set(updateData)
    .where(eq(schedulesTable.id, schedule.id))
    .returning();
  res.json(updated);
});

router.post("/schedule/trigger", async (req, res): Promise<void> => {
  const limitCheck = await checkAiLimitReached();
  if (limitCheck.blocked) {
    await notifyOwner(limitCheck.reason!);
    res.status(429).json({ success: false, message: limitCheck.reason, postsGenerated: 0 });
    return;
  }

  let generated = 0;
  const topics = [
    "Последние новости TON ecosystem",
    "Обновления Telegram Gifts и Stars",
    "Важные новости крипторынка сегодня",
  ];

  try {
    for (const topic of topics) {
      const check = await checkAiLimitReached();
      if (check.blocked) break;

      const { content, postType } = await generatePostContent({ topic });
      await incrementAiUsage("post");

      const schedule = await getOrCreateSchedule();

      const [post] = await db
        .insert(postsTable)
        .values({ content, postType, topic, aiCallsUsed: 1, status: "draft" })
        .returning();

      if (schedule.autoPublish) {
        try {
          const messageId = await sendTelegramMessage(content);
          await db
            .update(postsTable)
            .set({ status: "published", telegramMessageId: messageId, publishedAt: new Date() })
            .where(eq(postsTable.id, post.id));
        } catch (err) {
          logger.error({ err, postId: post.id }, "Auto-publish failed");
        }
      }

      generated++;
    }

    const now = new Date();
    const schedule = await getOrCreateSchedule();
    const next = new Date(now.getTime() + schedule.intervalHours * 60 * 60 * 1000);
    await db
      .update(schedulesTable)
      .set({ lastRunAt: now, nextRunAt: next })
      .where(eq(schedulesTable.id, schedule.id));

    res.json({ success: true, message: `Сгенерировано ${generated} постов`, postsGenerated: generated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Generation cycle failed";
    req.log.error({ err }, "Trigger generation error");
    res.status(500).json({ success: false, message, postsGenerated: generated });
  }
});

export { getOrCreateSchedule };
export default router;
