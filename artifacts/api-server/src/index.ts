import app from "./app";
import { logger } from "./lib/logger";
import { setupBotCommands, setWebhook } from "./lib/telegram";

const port = Number(process.env.PORT ?? 3000);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env.PORT}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

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
      "RAILWAY_PUBLIC_DOMAIN and WEBHOOK_URL not set — register webhook manually via POST /api/settings or curl",
    );
  }
});
