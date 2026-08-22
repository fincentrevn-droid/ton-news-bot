import { db, schedulesTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { getChannelProfile } from "./channel-profile";

function envBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

function envInt(...names: string[]): number | undefined {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function envString(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

/**
 * Railway env vars are the deployment-level source of truth for whether a bot
 * is meant to run unattended. Historically the DB schedule could remain OFF
 * after a redeploy/new DB even while AUTO_PUBLISH=true in Railway, leaving the
 * service healthy but silently idle. Reconcile only explicitly configured env
 * values, preserving dashboard/DB values for fields that are not set in env.
 *
 * The same startup reconciliation also repairs the original AI budget defaults
 * (12 calls / 6 generated posts), which are too small for a 6-8 post/day bot
 * once generation, QC and occasional rewrites are counted separately.
 */
export async function reconcileScheduleFromEnv(): Promise<void> {
  const explicitAutoPublish = envBool("AUTO_PUBLISH");
  const requiresApproval = envBool("POSTING_REQUIRES_APPROVAL");
  const desiredAutoPublish = explicitAutoPublish ?? (
    requiresApproval === undefined ? undefined : !requiresApproval
  );

  const explicitScheduleEnabled = envBool("SCHEDULE_ENABLED");
  const desiredEnabled = explicitScheduleEnabled ?? (
    desiredAutoPublish === true ? true : undefined
  );

  const updates: Partial<typeof schedulesTable.$inferInsert> = {};

  if (desiredEnabled !== undefined) updates.enabled = desiredEnabled;
  if (desiredAutoPublish !== undefined) updates.autoPublish = desiredAutoPublish;

  const timezone = envString("POSTING_TIMEZONE");
  const postingStart = envString("POSTING_START_TIME");
  const postingEnd = envString("POSTING_END_TIME");
  const nightPauseStart = envString("NIGHT_PAUSE_START");
  const nightPauseEnd = envString("NIGHT_PAUSE_END");
  const nightPauseEnabled = envBool("NIGHT_PAUSE_ENABLED");
  const randomDelayEnabled = envBool("POSTING_RANDOM_DELAY_ENABLED");

  if (timezone) updates.postingTimezone = timezone;
  if (postingStart) updates.postingStartTime = postingStart;
  if (postingEnd) updates.postingEndTime = postingEnd;
  if (nightPauseStart) updates.nightPauseStart = nightPauseStart;
  if (nightPauseEnd) updates.nightPauseEnd = nightPauseEnd;
  if (nightPauseEnabled !== undefined) updates.nightPauseEnabled = nightPauseEnabled;
  if (randomDelayEnabled !== undefined) updates.randomDelayEnabled = randomDelayEnabled;

  const minPosts = envInt("MIN_AUTO_POSTS_PER_DAY", "MIN_POSTS_PER_DAY");
  const targetPosts = envInt("TARGET_AUTO_POSTS_PER_DAY");
  const maxPosts = envInt("MAX_AUTO_POSTS_PER_DAY", "MAX_POSTS_PER_DAY");
  const minSpacing = envInt("MIN_MINUTES_BETWEEN_POSTS");
  const maxSpacing = envInt("MAX_MINUTES_BETWEEN_POSTS");
  const randomDelayMinutes = envInt("POSTING_RANDOM_DELAY_MINUTES");

  if (minPosts !== undefined) updates.minPostsPerDay = minPosts;
  if (targetPosts !== undefined) updates.targetPostsPerDay = targetPosts;
  if (maxPosts !== undefined) updates.maxPostsPerDay = maxPosts;
  if (minSpacing !== undefined) updates.minMinutesBetweenPosts = minSpacing;
  if (maxSpacing !== undefined) updates.maxMinutesBetweenPosts = maxSpacing;
  if (randomDelayMinutes !== undefined) updates.randomDelayMinutes = randomDelayMinutes;

  const rows = await db.select().from(schedulesTable).limit(1);
  let schedule = rows[0];

  if (!schedule) {
    const [created] = await db.insert(schedulesTable).values(updates).returning();
    schedule = created;
  } else if (Object.keys(updates).length > 0) {
    const [updated] = await db
      .update(schedulesTable)
      .set(updates)
      .where(eq(schedulesTable.id, schedule.id))
      .returning();
    schedule = updated;
  }

  // ── AI budget self-heal ──────────────────────────────────────────────────
  // Explicit Railway values always win. Otherwise only upgrade legacy-small
  // persisted defaults; do not overwrite a deliberately larger custom budget.
  const profile = getChannelProfile();
  const recommendedCalls = profile === "crypto" ? 80 : 60;
  const recommendedGeneratedPosts = profile === "crypto" ? 12 : 10;
  const explicitMaxAiCalls = envInt("MAX_AI_CALLS_PER_DAY", "AI_MAX_CALLS_PER_DAY");
  const explicitMaxGeneratedPosts = envInt("MAX_GENERATED_POSTS_PER_DAY", "AI_MAX_POSTS_PER_DAY");

  const settingsRows = await db.select().from(settingsTable).limit(1);
  let settings = settingsRows[0];
  const settingsUpdates: Partial<typeof settingsTable.$inferInsert> = {};

  if (!settings) {
    settingsUpdates.maxAiCallsPerDay = explicitMaxAiCalls ?? recommendedCalls;
    settingsUpdates.maxPostsPerDay = explicitMaxGeneratedPosts ?? recommendedGeneratedPosts;
    if (desiredAutoPublish !== undefined) {
      settingsUpdates.autoPublish = desiredAutoPublish;
      settingsUpdates.postingRequiresApproval = !desiredAutoPublish;
    }
    const [created] = await db.insert(settingsTable).values(settingsUpdates).returning();
    settings = created;
  } else {
    if (explicitMaxAiCalls !== undefined) {
      settingsUpdates.maxAiCallsPerDay = explicitMaxAiCalls;
    } else if (settings.maxAiCallsPerDay <= 12) {
      settingsUpdates.maxAiCallsPerDay = recommendedCalls;
    }

    if (explicitMaxGeneratedPosts !== undefined) {
      settingsUpdates.maxPostsPerDay = explicitMaxGeneratedPosts;
    } else if (settings.maxPostsPerDay <= 6) {
      settingsUpdates.maxPostsPerDay = recommendedGeneratedPosts;
    }

    if (desiredAutoPublish !== undefined) {
      settingsUpdates.autoPublish = desiredAutoPublish;
      settingsUpdates.postingRequiresApproval = !desiredAutoPublish;
    }

    if (Object.keys(settingsUpdates).length > 0) {
      const [updatedSettings] = await db
        .update(settingsTable)
        .set(settingsUpdates)
        .where(eq(settingsTable.id, settings.id))
        .returning();
      settings = updatedSettings;
    }
  }

  logger.info(
    {
      profile,
      enabled: schedule?.enabled ?? false,
      autoPublish: schedule?.autoPublish ?? false,
      postingTimezone: schedule?.postingTimezone,
      postingStartTime: schedule?.postingStartTime,
      postingEndTime: schedule?.postingEndTime,
      minPostsPerDay: schedule?.minPostsPerDay,
      targetPostsPerDay: schedule?.targetPostsPerDay,
      maxPostsPerDay: schedule?.maxPostsPerDay,
      maxAiCallsPerDay: settings?.maxAiCallsPerDay,
      maxGeneratedPostsPerDay: settings?.maxPostsPerDay,
      postingRequiresApproval: settings?.postingRequiresApproval,
    },
    "Reconciled posting schedule and AI budget from Railway environment",
  );
}
