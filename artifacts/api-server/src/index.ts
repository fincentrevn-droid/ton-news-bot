import app from "./app";
import { logger } from "./lib/logger";
import { setupBotCommands, setWebhook } from "./lib/telegram";
import { db, sourcesTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const port = Number(process.env.PORT ?? 3000);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
}

const DEFAULT_SOURCES = [
  { name: "CoinTelegraph",  url: "https://cointelegraph.com/rss",      type: "rss",              isPrimary: false, category: "crypto" },
  { name: "Decrypt",        url: "https://decrypt.co/feed",            type: "rss",              isPrimary: false, category: "crypto" },
  { name: "The Block",      url: "https://www.theblock.co/rss.xml",    type: "rss",              isPrimary: false, category: "crypto" },
  { name: "TON Blockchain", url: "@ton_blockchain",                    type: "telegram_channel", isPrimary: true,  category: "TON" },
  { name: "TON Community",  url: "@toncoin",                           type: "telegram_channel", isPrimary: true,  category: "TON" },
  { name: "Durov",          url: "@durov",                             type: "telegram_channel", isPrimary: true,  category: "Telegram" },
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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Seed default sources if table is empty
  seedSourcesIfEmpty().catch((err) => logger.warn({ err }, "Source seeding failed"));

  // Auto-register Telegram webhook on startup.
  // Railway injects RAILWAY_PUBLIC_DOMAIN; fallback to WEBHOOK_URL for other hosts.
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
