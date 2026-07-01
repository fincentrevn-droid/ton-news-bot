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

// ─── Multipart helper (for photo uploads) ───────────────────────────────────

async function telegramMultipart(token: string, method: string, fields: Record<string, string>, photoBuffer: Buffer): Promise<unknown> {
  const form = new FormData();
  for (const [key, val] of Object.entries(fields)) {
    form.append(key, val);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form.append("photo", new Blob([photoBuffer as any], { type: "image/jpeg" }), "photo.jpg");
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, { method: "POST", body: form });
  return res.json();
}

// Extract largest file_id from sendPhoto result
function extractFileId(result: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const photos = (result as any)?.photo as Array<{ file_id: string }> | undefined;
  return photos?.at(-1)?.file_id ?? "";
}

// ─── Text publish ────────────────────────────────────────────────────────────

export async function sendTelegramMessage(text: string): Promise<number> {
  const token = getBotToken();
  const chatId = getChannelId();

  const data = await telegramPost(token, "sendMessage", {
    chat_id: chatId,
    text: escapeHtml(text),
    parse_mode: "HTML",
  }) as { ok: boolean; result?: { message_id: number }; description?: string };

  if (!data.ok) {
    logger.error({ description: data.description }, "Telegram sendMessage failed");
    throw new Error(`Telegram error: ${data.description}`);
  }

  logger.info({ messageId: data.result?.message_id }, "Post published to Telegram (text)");
  return data.result!.message_id;
}

// ─── Photo publish ───────────────────────────────────────────────────────────

export interface PhotoPublishResult {
  messageId: number;
  fileId: string;
}

/**
 * Publish a photo post to the channel.
 * @param photoSource  Buffer = new upload; string = reuse existing file_id
 * @param caption      Post content (plain text — will be HTML-escaped, max 1024 chars)
 */
export async function sendPhotoPost(
  photoSource: Buffer | string,
  caption: string,
): Promise<PhotoPublishResult> {
  const token = getBotToken();
  const chatId = getChannelId();
  const safeCaption = escapeHtml(caption).slice(0, 1024);

  let data: { ok: boolean; result?: unknown; description?: string };

  if (typeof photoSource === "string") {
    data = await telegramPost(token, "sendPhoto", {
      chat_id: chatId,
      photo: photoSource,
      caption: safeCaption,
      parse_mode: "HTML",
    }) as typeof data;
  } else {
    data = await telegramMultipart(token, "sendPhoto", {
      chat_id: chatId,
      caption: safeCaption,
      parse_mode: "HTML",
    }, photoSource) as typeof data;
  }

  if (!data.ok) {
    logger.error({ description: data.description }, "Telegram sendPhoto failed");
    throw new Error(`Telegram sendPhoto error: ${data.description}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messageId = (data.result as any)?.message_id as number;
  const fileId = extractFileId(data.result);
  logger.info({ messageId, fileId: fileId.slice(0, 20) }, "Post published to Telegram (photo)");
  return { messageId, fileId };
}

/**
 * Upload a photo buffer to the review chat and return the Telegram file_id.
 * Used to pre-stage media for posts going to the auto-publish queue,
 * where sendReviewMessage is never called (so there's no other chance to get the file_id).
 */
export async function uploadPhotoGetFileId(buffer: Buffer): Promise<string> {
  const token = getBotToken();
  const chatId = process.env.REVIEW_CHAT_ID;
  if (!chatId) throw new Error("REVIEW_CHAT_ID not set — cannot pre-upload media");

  const data = await telegramMultipart(token, "sendPhoto", {
    chat_id: chatId,
    caption: "📸 Медиа для авто-поста",
    disable_notification: "true",
  }, buffer) as { ok: boolean; result?: unknown; description?: string };

  if (!data.ok) {
    throw new Error(`Telegram uploadPhoto error: ${(data as any).description}`);
  }

  const fileId = extractFileId(data.result);
  logger.info({ fileId: fileId.slice(0, 20) }, "Photo pre-uploaded for queued post");
  return fileId;
}

// ─── Review message ──────────────────────────────────────────────────────────

export interface ReviewMeta {
  sourceChannel?: string;
  sourcePreview?: string;
  sourceLink?: string;
  confidence?: string;
  qualityScore?: number;
  qualityIssues?: string[];
  safeForAutopublish?: boolean;
}

const REVIEW_KEYBOARD = (postId: number) => ({
  inline_keyboard: [
    [
      { text: "✅ Опубликовать", callback_data: `publish:${postId}` },
      { text: "🔁 Переписать", callback_data: `rewrite:${postId}` },
      { text: "❌ Пропустить", callback_data: `skip:${postId}` },
    ],
  ],
});

function buildReviewCaption(
  postId: number,
  content: string,
  safetyWarnings: string[],
  postType?: string,
  topic?: string,
  meta?: ReviewMeta,
  maxContentChars = 3000,
): string {
  // ── Public post preview (exactly what will be published) ──────────────────
  const topicLine = topic ? `📌 <i>${escapeHtml(topic)}</i>\n\n` : "";
  const postPreview = `${topicLine}${escapeHtml(content.slice(0, maxContentChars))}`;

  // ── Admin metadata (never published) ──────────────────────────────────────
  const metaLines: string[] = [];
  if (meta?.sourceChannel) {
    const src = meta.sourceChannel;
    const link = meta.sourceLink ? ` · <a href="${meta.sourceLink}">ссылка</a>` : "";
    const conf = meta.confidence ? ` · <b>${meta.confidence}</b>` : "";
    metaLines.push(`📡 ${escapeHtml(src)}${link}${conf}`);
  }
  if (meta?.sourcePreview) {
    metaLines.push(`<i>${escapeHtml(meta.sourcePreview.slice(0, 200))}…</i>`);
  }
  if (safetyWarnings.length > 0) {
    metaLines.push(`⚠️ Удалены ссылки: ${safetyWarnings.map(w => escapeHtml(w)).join(", ")}`);
  }
  if (meta?.qualityScore !== undefined) {
    const emoji = meta.qualityScore >= 80 ? "✅" : meta.qualityScore >= 60 ? "⚠️" : "❌";
    const autoTag = meta.safeForAutopublish === false ? " · ручная проверка" : "";
    metaLines.push(`${emoji} QC: <b>${meta.qualityScore}/100</b>${autoTag}`);
    if (meta.qualityIssues?.length) {
      metaLines.push(`<i>${meta.qualityIssues.slice(0, 3).map(i => escapeHtml(i)).join(" · ")}</i>`);
    }
  }
  const formatLabel = postType ? postType.toUpperCase() : "?";
  metaLines.push(`<code>#${postId} · ${formatLabel}</code>`);

  const adminBlock = metaLines.length > 0
    ? `\n\n<b>— — —</b>\n${metaLines.join("\n")}`
    : `\n\n<code>#${postId}</code>`;

  return postPreview + adminBlock;
}

export interface ReviewSendResult {
  messageId: number | null;
  fileId: string | null;
}

/**
 * Send a review message (text or photo).
 * Returns messageId and, if a new photo was uploaded, the Telegram file_id for reuse.
 */
export async function sendReviewMessage(
  postId: number,
  content: string,
  safetyWarnings: string[] = [],
  postType?: string,
  topic?: string,
  meta?: ReviewMeta,
  photoSource?: Buffer | string,   // Buffer = new upload, string = reuse file_id
): Promise<ReviewSendResult> {
  const token = getBotToken();
  const chatId = getReviewChatId();
  if (!chatId) {
    logger.warn("No REVIEW_CHAT_ID or OWNER_TELEGRAM_ID set — skipping Telegram review");
    return { messageId: null, fileId: null };
  }

  const replyMarkup = REVIEW_KEYBOARD(postId);

  // ── With photo ──────────────────────────────────────────────────────────────
  if (photoSource) {
    // Caption is limited to 1024 chars in sendPhoto
    const captionText = buildReviewCaption(postId, content, safetyWarnings, postType, topic, meta, 700);
    const safeCaption = captionText.slice(0, 1024);

    let data: { ok: boolean; result?: unknown; description?: string };

    if (typeof photoSource === "string") {
      data = await telegramPost(token, "sendPhoto", {
        chat_id: chatId,
        photo: photoSource,
        caption: safeCaption,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      }) as typeof data;
    } else {
      data = await telegramMultipart(token, "sendPhoto", {
        chat_id: chatId,
        caption: safeCaption,
        parse_mode: "HTML",
        reply_markup: JSON.stringify(replyMarkup),
      }, photoSource) as typeof data;
    }

    if (!data.ok) {
      logger.warn({ description: data.description }, "Photo review failed — falling back to text");
      // Fall through to text review below
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messageId = (data.result as any)?.message_id as number;
      const fileId = extractFileId(data.result);
      logger.info({ postId, messageId, hasFileId: Boolean(fileId) }, "Photo review message sent");
      return { messageId, fileId: fileId || null };
    }
  }

  // ── Text only ───────────────────────────────────────────────────────────────
  const text = buildReviewCaption(postId, content, safetyWarnings, postType, topic, meta);

  const data = await telegramPost(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  }) as { ok: boolean; result?: { message_id: number }; description?: string };

  if (!data.ok) {
    logger.error({ description: data.description }, "Failed to send review message");
    return { messageId: null, fileId: null };
  }

  logger.info({ postId, reviewMessageId: data.result?.message_id }, "Review message sent (text)");
  return { messageId: data.result?.message_id ?? null, fileId: null };
}

// ─── Edit review message ─────────────────────────────────────────────────────

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

// ─── Misc ────────────────────────────────────────────────────────────────────

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

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
