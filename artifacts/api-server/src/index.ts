import app from "./app";
import { logger } from "./lib/logger";
import { setupBotCommands, setWebhook, verifyPublishingAccess } from "./lib/telegram";
import { startSchedulerLoop } from "./lib/scheduler";
import {
  botInstanceTable,
  db,
  postsTable,
  schedulesTable,
  settingsTable,
  sourcesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { getContentProfile } from "./config/content-profile";

const port = Number(process.env.PORT ?? 3000);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
}

const contentProfile = getContentProfile();

/**
 * Bind the database to one bot instance before reading or mutating any queue.
 * A second service pointed at the same DATABASE_URL fails closed.
 */
async function assertDatabaseIsolation(): Promise<void> {
  const [existingBinding] = await db
    .select()
    .from(botInstanceTable)
    .where(eq(botInstanceTable.id, 1))
    .limit(1);

  if (!existingBinding) {
    const [existingPost, existingSource, existingSchedule, existingSettings] = await Promise.all([
      db.select({ id: postsTable.id }).from(postsTable).limit(1),
      db.select({ id: sourcesTable.id }).from(sourcesTable).limit(1),
      db.select({ id: schedulesTable.id }).from(schedulesTable).limit(1),
      db.select({ id: settingsTable.id }).from(settingsTable).limit(1),
    ]);
    const containsLegacyData =
      existingPost.length > 0 ||
      existingSource.length > 0 ||
      existingSchedule.length > 0 ||
      existingSettings.length > 0;

    if (containsLegacyData && contentProfile.id !== "business") {
      throw new Error(
        "DATABASE_URL points to an existing unbound database. The crypto profile may only use a new, empty PostgreSQL database.",
      );
    }
  }

  await db
    .insert(botInstanceTable)
    .values({
      id: 1,
      instanceKey: contentProfile.instanceKey,
      contentProfile: contentProfile.id,
    })
    .onConflictDoNothing();

  const [boundInstance] = await db
    .select()
    .from(botInstanceTable)
    .where(eq(botInstanceTable.id, 1))
    .limit(1);

  if (
    !boundInstance ||
    boundInstance.instanceKey !== contentProfile.instanceKey ||
    boundInstance.contentProfile !== contentProfile.id
  ) {
    throw new Error(
      `DATABASE_URL belongs to bot instance "${boundInstance?.instanceKey ?? "unknown"}" ` +
      `(${boundInstance?.contentProfile ?? "unknown"}), but this service is ` +
      `"${contentProfile.instanceKey}" (${contentProfile.id}). Use a separate PostgreSQL database.`,
    );
  }
}

/** Seed defaults only for a brand-new, isolated bot database. */
async function initializeProfileData(): Promise<void> {
  await assertDatabaseIsolation();

  const [sources, schedules, settings] = await Promise.all([
    db.select().from(sourcesTable).limit(1),
    db.select().from(schedulesTable).limit(1),
    db.select().from(settingsTable).limit(1),
  ]);

  if (sources.length === 0) {
    await db.insert(sourcesTable).values(contentProfile.defaultSources);
  }

  if (schedules.length === 0) {
    await db.insert(schedulesTable).values({
      ...contentProfile.scheduleDefaults,
      lastPublishedAt: null,
      lastRunAt: null,
      nextRunAt: null,
    });
  }

  if (settings.length === 0) {
    await db.insert(settingsTable).values(contentProfile.settingsDefaults);
  }

  logger.info(
    {
      instanceKey: contentProfile.instanceKey,
      contentProfile: contentProfile.id,
      seededSources: sources.length === 0 ? contentProfile.defaultSources.length : 0,
    },
    "Bot profile initialized",
  );
}

async function initializeRuntime(): Promise<void> {
  // Nothing is exposed until this service owns an isolated database and can
  // publish only to its configured Telegram channel.
  await initializeProfileData();
  await verifyPublishingAccess();

  const domain = process.env.RAILWAY_PUBLIC_DOMAIN ?? process.env.WEBHOOK_URL ?? null;

  if (process.env.TELEGRAM_BOT_TOKEN && domain) {
    const webhookUrl = domain.startsWith("http")
      ? `${domain}/api/telegram/webhook`
      : `https://${domain}/api/telegram/webhook`;

    await setupBotCommands();
    await setWebhook(webhookUrl);
    logger.info({ webhookUrl }, "Telegram webhook registered on startup");
  } else if (!process.env.TELEGRAM_BOT_TOKEN) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — skipping webhook registration");
  } else {
    logger.warn("RAILWAY_PUBLIC_DOMAIN and WEBHOOK_URL not set — register webhook manually");
  }
}

async function startServer(): Promise<void> {
  await initializeRuntime();

  const server = app.listen(port, () => {
    logger.info({ port, contentProfile: contentProfile.id }, "Server listening");
    startSchedulerLoop();
  });

  server.on("error", (err) => {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  });
}

startServer().catch((err) => {
  logger.fatal({ err }, "Runtime initialization failed — service remains offline");
  process.exit(1);
});
