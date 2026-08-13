import app from "./app";
import { logger } from "./lib/logger";
import { setupBotCommands, setWebhook, verifyPublishingAccess } from "./lib/telegram";
import { startSchedulerLoop } from "./lib/scheduler";
import {
  db,
  postsTable,
  schedulesTable,
  settingsTable,
  sourcesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const port = Number(process.env.PORT ?? 3000);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
}

const BUSINESS_SOURCES = [
  { name: "Державна податкова служба", url: "@tax_gov_ua", type: "telegram_channel", isPrimary: true, category: "Податки" },
  { name: "Національний банк України", url: "@nbu_ua", type: "telegram_channel", isPrimary: true, category: "Економіка" },
  { name: "Міністерство економіки України", url: "@mineconomdevUA", type: "telegram_channel", isPrimary: true, category: "Бізнес" },
  { name: "Міністерство фінансів України", url: "@MOF_ua", type: "telegram_channel", isPrimary: true, category: "Фінанси" },
  { name: "Уряд online", url: "@uriad24", type: "telegram_channel", isPrimary: true, category: "Регулювання" },
  { name: "Дія", url: "@diia_gov", type: "telegram_channel", isPrimary: true, category: "Держпослуги" },
  { name: "Економічна правда", url: "@epravda", type: "telegram_channel", isPrimary: false, category: "Бізнес-медіа" },
  { name: "Forbes Ukraine", url: "@Forbes_Ukraine_official", type: "telegram_channel", isPrimary: false, category: "Бізнес-медіа" },
  { name: "Опендатамедіа", url: "@OpendatabotChannel", type: "telegram_channel", isPrimary: false, category: "Бізнес-дані" },
  { name: "European Central Bank", url: "https://www.ecb.europa.eu/rss/press.html", type: "rss", isPrimary: true, category: "Світова економіка" },
  { name: "Federal Reserve Monetary Policy", url: "https://www.federalreserve.gov/feeds/press_monetary.xml", type: "rss", isPrimary: true, category: "Світова економіка" },
];

const LEGACY_TON_SOURCE_URLS = new Set([
  // Sources stored in the original TONKOFF production database.
  "@cryptwit",
  "@TON_ins",
  "@ruton",
  "@tonienftik",
  "@ton_vseznayka",
  "@givemetonru",
  "@gramlow",
  "@tonEnternity",
  "@investkingyru",
  "@ton_blockchain",
  "@toncoin",
  "@durov",
  "@telegram",
  "@the_open_network",
  "https://cointelegraph.com/rss",
  "https://decrypt.co/feed",
  "https://www.theblock.co/rss.xml",
  "https://ton.org/feed",
]);

/**
 * One-time repurpose migration. It runs only while legacy TON sources are still
 * present (or the source table is empty), so later dashboard edits are preserved.
 */
async function migrateTonkoffToFincentre(): Promise<boolean> {
  try {
    const rows = await db.select().from(sourcesTable);
    const needsMigration =
      rows.length === 0 || rows.some((source) => LEGACY_TON_SOURCE_URLS.has(source.url));

    if (!needsMigration) return false;

    // Prevent an old queued TON draft from being published to the new channel.
    await db
      .update(postsTable)
      .set({ status: "skipped" })
      .where(eq(postsTable.status, "draft"));

    await db.delete(sourcesTable);
    await db.insert(sourcesTable).values(BUSINESS_SOURCES);

    const schedules = await db.select().from(schedulesTable).limit(1);
    const scheduleValues = {
      // Keep the repurposed bot paused until the final source list, signature
      // and post template are approved by the owner.
      enabled: false,
      intervalHours: 4,
      maxPostsPerDay: 5,
      autoPublish: false,
      postingTimezone: "Europe/Kyiv",
      postingStartTime: "09:00",
      postingEndTime: "21:30",
      nightPauseEnabled: true,
      nightPauseStart: "22:00",
      nightPauseEnd: "08:30",
      minPostsPerDay: 3,
      targetPostsPerDay: 4,
      minMinutesBetweenPosts: 180,
      maxMinutesBetweenPosts: 300,
      randomDelayEnabled: true,
      randomDelayMinutes: 45,
      lastPublishedAt: null,
      lastRunAt: null,
      nextRunAt: null,
    };
    if (schedules[0]) {
      await db
        .update(schedulesTable)
        .set(scheduleValues)
        .where(eq(schedulesTable.id, schedules[0].id));
    } else {
      await db.insert(schedulesTable).values(scheduleValues);
    }

    const settings = await db.select().from(settingsTable).limit(1);
    const settingsValues = {
      maxAiCallsPerDay: 24,
      maxPostsPerDay: 10,
      minPostsPerDay: 3,
      maxRewritePerPost: 1,
      maxTokensPerPost: 1400,
      maxSourcePostsPerChannel: 20,
      lookbackHours: 36,
      enableCostGuard: true,
      autoPublish: false,
      postingRequiresApproval: true,
      enableSecondarySourcesi: true,
    };
    if (settings[0]) {
      await db
        .update(settingsTable)
        .set(settingsValues)
        .where(eq(settingsTable.id, settings[0].id));
    } else {
      await db.insert(settingsTable).values(settingsValues);
    }

    logger.info(
      { sources: BUSINESS_SOURCES.length },
      "Migrated TONKOFF deployment to Fincentre Business",
    );
    return true;
  } catch (err) {
    logger.error({ err }, "Could not migrate TONKOFF deployment to Fincentre Business");
    throw err;
  }
}

async function initializeRuntime(): Promise<void> {
  // Scheduler starts only after the old queue and sources are safely migrated.
  await migrateTonkoffToFincentre();
  await verifyPublishingAccess();
  startSchedulerLoop();

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  initializeRuntime().catch((err) => {
    logger.error({ err }, "Runtime initialization failed — scheduler not started");
  });
});
