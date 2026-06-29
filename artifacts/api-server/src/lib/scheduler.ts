import { db, schedulesTable, postsTable } from "@workspace/db";
import { eq, and, isNull, gte, sql } from "drizzle-orm";
import { sendTelegramMessage, sendPhotoPost } from "./telegram";
import { logger } from "./logger";

// ─── Time helpers ────────────────────────────────────────────────────────────

/** Returns "HH:MM" in the given timezone */
function localHHMM(timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

/** "HH:MM" → minutes since midnight */
function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True if nowMin is within [start, end) (handles midnight-spanning ranges) */
function inRange(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin;
  // Midnight-spanning range (e.g. 23:00 → 06:00)
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
  // How many minutes elapsed since local midnight
  const [hStr, mStr] = localHHMM(timezone).split(":");
  const minutesSinceMidnight = Number(hStr) * 60 + Number(mStr);
  const since = new Date(Date.now() - minutesSinceMidnight * 60 * 1000);

  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(postsTable)
    .where(
      and(
        eq(postsTable.status, "published"),
        gte(postsTable.publishedAt, since),
      ),
    );
  return Number(row?.count ?? 0);
}

// ─── Quality gate ─────────────────────────────────────────────────────────────

function passesAutoPublishQuality(post: {
  confidence: string | null;
  safetyStatus: string | null;
  generatedFromSource: boolean | null;
  content: string;
}): boolean {
  if (!post.generatedFromSource) return false;
  if (post.confidence === "low") return false;
  if (post.safetyStatus === "rejected") return false;
  if (post.safetyStatus === "warning") return false;
  if (!post.content.trim()) return false;
  return true;
}

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

    // Minimum spacing check
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

    // Find the oldest queued draft ready for auto-publish:
    //   - status = draft
    //   - reviewMessageId IS NULL (not in manual review)
    //   - passes quality gate
    const candidates = await db
      .select()
      .from(postsTable)
      .where(
        and(
          eq(postsTable.status, "draft"),
          isNull(postsTable.reviewMessageId),
        ),
      )
      .orderBy(postsTable.createdAt)
      .limit(10);

    const post = candidates.find((p) => passesAutoPublishQuality(p));
    if (!post) {
      logger.debug({ candidatesChecked: candidates.length }, "Scheduler tick: no qualifying draft to publish");
      return;
    }

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

// ─── Startup ─────────────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes

export function startSchedulerLoop(): void {
  logger.info({ intervalMs: TICK_INTERVAL_MS }, "Posting scheduler started");
  setInterval(() => {
    tickPublisher().catch((err) => logger.error({ err }, "Unhandled scheduler tick error"));
  }, TICK_INTERVAL_MS);
}
