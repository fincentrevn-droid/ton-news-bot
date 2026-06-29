import app from "./app";
import { logger } from "./lib/logger";
import { setupBotCommands, setWebhook } from "./lib/telegram";
import { startSchedulerLoop } from "./lib/scheduler";
import { db, sourcesTable } from "@workspace/db";
import { sql, eq } from "drizzle-orm";

const port = Number(process.env.PORT ?? 3000);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
}

// Default seed — Telegram channels only (RSS is secondary, off by default)
const DEFAULT_SOURCES = [
  { name: "TON Blockchain", url: "@ton_blockchain", type: "telegram_channel", isPrimary: true,  category: "TON" },
  { name: "TON Community",  url: "@toncoin",        type: "telegram_channel", isPrimary: true,  category: "TON" },
  { name: "Durov",          url: "@durov",          type: "telegram_channel", isPrimary: true,  category: "Telegram" },
];

async function seedSourcesIfEmpty(): Promise<void> {
  try {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(sourcesTable);
    if (Number(count) > 0) return;

    await db.insert(sourcesTable).values(DEFAULT_SOURCES);
    logger.info({ count: DEFAULT_SOURCES.length }, "Seeded default sources");
  } catch (err) {
    logger.warn({ err }, "Could not seed sources (DB may not be ready)");
  }
}

// Remove RSS sources that were auto-seeded in older deploys.
// RSS is off by default; users can add them back via dashboard if needed.
async function removeAutoSeededRss(): Promise<void> {
  try {
    const AUTO_RSS_URLS = [
      "https://cointelegraph.com/rss",
      "https://decrypt.co/feed",
      "https://www.theblock.co/rss.xml",
      "https://ton.org/feed",
    ];
    const rows = await db
      .select({ id: sourcesTable.id, name: sourcesTable.name, url: sourcesTable.url })
      .from(sourcesTable)
      .where(eq(sourcesTable.type, "rss"));

    const toRemove = rows.filter((r) => AUTO_RSS_URLS.includes(r.url));
    if (toRemove.length === 0) return;

    for (const row of toRemove) {
      await db.delete(sourcesTable).where(eq(sourcesTable.id, row.id));
    }
    logger.info({ removed: toRemove.map((r) => r.name) }, "Removed auto-seeded RSS sources");
  } catch (err) {
    logger.warn({ err }, "Could not remove auto-seeded RSS sources");
  }
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  seedSourcesIfEmpty().catch((err) => logger.warn({ err }, "Source seeding failed"));
  removeAutoSeededRss().catch((err) => logger.warn({ err }, "RSS cleanup failed"));
  startSchedulerLoop();

  // Auto-register Telegram webhook on startup.
  const domain =
    process.env.RAILWAY_PUBLIC_DOMAIN ??
    process.env.WEBHOOK_URL ??
    null;

  if (process.env.TELEGRAM_BOT_TOKEN && domain) {
    const webhookUrl = domain.startsWith("http")
      ? `${domain}/api/telegram/webhook`
      : `https://${domain}/api/telegram/webhook`;

    setupBotCommands()
      .then(() => setWebhook(webhookUrl))
      .then(() => logger.info({ webhookUrl }, "Telegram webhook registered on startup"))
      .catch((err) => logger.warn({ err }, "Failed to register Telegram webhook on startup"));
  } else if (!process.env.TELEGRAM_BOT_TOKEN) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — skipping webhook registration");
  } else {
    logger.warn(
      "RAILWAY_PUBLIC_DOMAIN and WEBHOOK_URL not set — register webhook manually",
    );
  }
});
