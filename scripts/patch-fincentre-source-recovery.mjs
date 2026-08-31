import { readFile, writeFile } from "node:fs/promises";

const profile = (process.env.CHANNEL_PROFILE ?? process.env.CONTENT_PROFILE ?? "business")
  .trim()
  .toLowerCase();

if (profile === "crypto" || profile === "pankoff_crypto") process.exit(0);

const path = "artifacts/api-server/src/index.ts";
let source = await readFile(path, "utf8");

if (source.includes("FINCENTRE_SOURCE_RECOVERY")) {
  console.log("FINCENTRE source recovery already applied");
  process.exit(0);
}

const defaultsPattern = /const BUSINESS_DEFAULT_SOURCES = \[[\s\S]*?\n\];/;
if (!defaultsPattern.test(source)) {
  throw new Error("BUSINESS_DEFAULT_SOURCES block not found");
}

const fullBusinessDefaults = `const BUSINESS_DEFAULT_SOURCES = [
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
];`;

source = source.replace(defaultsPattern, fullBusinessDefaults);

const cleanupMarker = "// Remove RSS sources that were auto-seeded in older deploys.";
if (!source.includes(cleanupMarker)) {
  throw new Error("RSS cleanup marker not found in index.ts");
}

const recoveryFunction = `// FINCENTRE_SOURCE_RECOVERY
// Preserve user-configured sources, but make sure the unattended business bot
// always has its core official sources and two RSS fallbacks available. This
// prevents a revoked/missing Telegram reader session from silently stopping all
// news generation. Existing rows are never overwritten or re-enabled.
async function ensureBusinessRecoverySources(): Promise<void> {
  if (isCryptoProfile()) return;

  try {
    const before = await db.select().from(sourcesTable);
    const existingUrls = new Set(before.map((row) => row.url));
    const recoverySources = BUSINESS_DEFAULT_SOURCES.filter(
      (item) => (item.isPrimary || item.type === "rss") && !existingUrls.has(item.url),
    );

    if (recoverySources.length > 0) {
      await db.insert(sourcesTable).values(recoverySources);
      logger.info(
        { added: recoverySources.map((item) => item.name) },
        "FINCENTRE restored missing recovery sources",
      );
    }

    const rows = await db.select().from(sourcesTable);
    const enabledTelegram = rows.filter(
      (row) => row.enabled && row.type === "telegram_channel",
    ).length;
    const enabledRss = rows.filter(
      (row) => row.enabled && row.type === "rss",
    ).length;
    const telegramReaderConfigured = Boolean(
      process.env.TELEGRAM_STRING_SESSION &&
      process.env.TELEGRAM_API_ID &&
      process.env.TELEGRAM_API_HASH,
    );
    const publisherConfigured = Boolean(
      process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHANNEL_ID,
    );
    const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);

    logger.info(
      {
        profile: "business",
        enabledTelegram,
        enabledRss,
        telegramReaderConfigured,
        publisherConfigured,
        openaiConfigured,
        targetChannelConfigured: Boolean(process.env.TELEGRAM_CHANNEL_ID),
      },
      "FINCENTRE autopost startup health",
    );

    if (!publisherConfigured) {
      logger.error("FINCENTRE autopost cannot publish: TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID is missing");
    }
    if (!openaiConfigured) {
      logger.error("FINCENTRE autopost cannot generate: OPENAI_API_KEY is missing");
    }
    if (!telegramReaderConfigured && enabledRss > 0) {
      logger.warn("FINCENTRE Telegram reader is unavailable; RSS emergency fallback remains available");
    }
    if (!telegramReaderConfigured && enabledRss === 0) {
      logger.error("FINCENTRE has neither Telegram reader credentials nor enabled RSS fallback sources");
    }
  } catch (err) {
    logger.warn({ err }, "FINCENTRE source recovery/health check failed");
  }
}

`;

source = source.replace(cleanupMarker, recoveryFunction + cleanupMarker);

const oldStartup = `  seedSourcesIfEmpty().catch((err) => logger.warn({ err }, "Source seeding failed"));
  removeAutoSeededRss().catch((err) => logger.warn({ err }, "RSS cleanup failed"));

  // Start the long-running loop immediately, then reconcile Railway env with
  // persisted DB state and perform one first tick. This prevents a healthy
  // deployment from sitting idle when AUTO_PUBLISH/SCHEDULE_ENABLED in Railway
  // disagree with an older schedules row.
  startSchedulerLoop();
  reconcileScheduleFromEnv()
    .then(() => tickPublisher())
    .catch((startupErr) => logger.error({ startupErr }, "Posting scheduler startup reconciliation failed"));`;

const newStartup = `  // Prepare/repair sources before the first scheduler tick. A fresh database or
  // a missing Telegram reader must not make the first production cycle silently empty.
  const sourceReady = seedSourcesIfEmpty()
    .then(() => ensureBusinessRecoverySources())
    .then(() => removeAutoSeededRss())
    .catch((err) => logger.warn({ err }, "FINCENTRE source startup preparation failed"));

  startSchedulerLoop();
  Promise.all([sourceReady, reconcileScheduleFromEnv()])
    .then(() => tickPublisher())
    .catch((startupErr) => logger.error({ startupErr }, "Posting scheduler startup reconciliation failed"));`;

if (!source.includes(oldStartup)) {
  throw new Error("FINCENTRE scheduler startup block not found");
}
source = source.replace(oldStartup, newStartup);

await writeFile(path, source);
console.log("FINCENTRE source recovery and startup health checks applied");
