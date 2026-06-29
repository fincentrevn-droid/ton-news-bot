import { logger } from "./logger";

const TELEGRAM_API = "https://api.telegram.org";

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  return token;
}

function getChannelId(): string {
  const id = process.env.TELEGRAM_CHANNEL_ID;
  if (!id) throw new Error("TELEGRAM_CHANNEL_ID is not set");
  return id;
}

function getReviewChatId(): string | null {
  return process.env.REVIEW_CHAT_ID ?? process.env.OWNER_TELEGRAM_ID ?? null;
}

function getOwnerChatId(): string | null {
  return process.env.OWNER_TELEGRAM_ID ?? null;
}

async function telegramPost(token: string, method: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function sendTelegramMessage(text: string): Promise<number> {
  const token = getBotToken();
  const chatId = getChannelId();

  const data = await telegramPost(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  }) as { ok: boolean; result?: { message_id: number }; description?: string };

  if (!data.ok) {
    logger.error({ description: data.description }, "Telegram sendMessage failed");
    throw new Error(`Telegram error: ${data.description}`);
  }

  logger.info({ messageId: data.result?.message_id }, "Post published to Telegram");
  return data.result!.message_id;
}

export async function sendReviewMessage(
  postId: number,
  content: string,
  safetyWarnings: string[] = [],
  postType?: string,
  topic?: string,
): Promise<number | null> {
  const token = getBotToken();
  const chatId = getReviewChatId();
  if (!chatId) {
    logger.warn("No REVIEW_CHAT_ID or OWNER_TELEGRAM_ID set — skipping Telegram review");
    return null;
  }

  const label = postType ? `[${postType.toUpperCase()}]` : "";
  const topicLine = topic ? `📌 ${topic}\n\n` : "";
  const warningBlock =
    safetyWarnings.length > 0
      ? `\n\n⚠️ <b>Удалены подозрительные ссылки:</b>\n${safetyWarnings.map((w) => `• ${w}`).join("\n")}`
      : "";

  const text =
    `${label} <b>Новый черновик #${postId}</b>\n\n` +
    `${topicLine}${escapeHtml(content)}` +
    warningBlock;

  const data = await telegramPost(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Опубликовать", callback_data: `publish:${postId}` },
          { text: "🔁 Переписать", callback_data: `rewrite:${postId}` },
          { text: "❌ Пропустить", callback_data: `skip:${postId}` },
        ],
      ],
    },
  }) as { ok: boolean; result?: { message_id: number }; description?: string };

  if (!data.ok) {
    logger.error({ description: data.description }, "Failed to send review message");
    return null;
  }

  logger.info({ postId, reviewMessageId: data.result?.message_id }, "Review message sent");
  return data.result?.message_id ?? null;
}

export async function editReviewMessage(
  chatId: string,
  messageId: number,
  newText: string,
): Promise<void> {
  const token = getBotToken();
  await telegramPost(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: newText,
    parse_mode: "HTML",
  });
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  const token = getBotToken();
  await telegramPost(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text ?? "",
    show_alert: false,
  });
}

export async function notifyOwner(message: string): Promise<void> {
  const token = getBotToken();
  const chatId = getOwnerChatId();
  if (!chatId) return;

  await (telegramPost(token, "sendMessage", {
    chat_id: chatId,
    text: message,
    parse_mode: "HTML",
  }) as Promise<unknown>).catch((err) => logger.warn({ err }, "Failed to notify owner"));
}

export async function setupBotCommands(): Promise<void> {
  const token = getBotToken();
  const commands = [
    { command: "status", description: "Статус: посты, публикации, AI-вызовы сегодня" },
    { command: "generate_now", description: "Запустить генерацию поста вручную" },
    { command: "sources", description: "Показать активные источники" },
    { command: "costs", description: "AI-расходы сегодня" },
    { command: "help", description: "Показать команды" },
  ];

  const data = await telegramPost(token, "setMyCommands", { commands }) as { ok: boolean };
  if (data.ok) {
    logger.info("Bot commands registered");
  } else {
    logger.warn("Failed to register bot commands");
  }
}

export async function setWebhook(webhookUrl: string): Promise<void> {
  const token = getBotToken();
  const data = await telegramPost(token, "setWebhook", {
    url: webhookUrl,
    allowed_updates: ["message", "callback_query"],
  }) as { ok: boolean; description?: string };

  if (data.ok) {
    logger.info({ webhookUrl }, "Telegram webhook registered");
  } else {
    logger.warn({ description: data.description }, "Failed to set webhook");
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
