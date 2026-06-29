import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { db, postsTable, sourcesTable } from "@workspace/db";
import { generatePostContent, incrementAiUsage, getOrCreateTodayUsage, getSettings } from "../lib/openai";
import { sendTelegramMessage, sendReviewMessage, answerCallbackQuery, notifyOwner } from "../lib/telegram";
import { checkSafety, cleanContent } from "../lib/safety";
import { logger } from "../lib/logger";

const router = Router();

interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
}

interface CallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: CallbackQuery;
}

router.post("/telegram/webhook", async (req, res): Promise<void> => {
  res.status(200).json({ ok: true });

  const update = req.body as TelegramUpdate;

  try {
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    } else if (update.message?.text) {
      await handleBotCommand(update.message);
    }
  } catch (err) {
    logger.error({ err }, "Webhook handler error");
  }
});

async function handleCallbackQuery(query: CallbackQuery): Promise<void> {
  const data = query.data ?? "";
  const [action, idStr] = data.split(":");
  const postId = parseInt(idStr ?? "", 10);

  if (!action || isNaN(postId)) {
    await answerCallbackQuery(query.id, "Неизвестная команда");
    return;
  }

  const [post] = await db.select().from(postsTable).where(eq(postsTable.id, postId));
  if (!post) {
    await answerCallbackQuery(query.id, "Пост не найден");
    return;
  }

  if (action === "publish") {
    if (post.status === "published") {
      await answerCallbackQuery(query.id, "Уже опубликован");
      return;
    }
    try {
      const messageId = await sendTelegramMessage(post.content);
      await db.update(postsTable)
        .set({ status: "published", telegramMessageId: messageId, publishedAt: new Date() })
        .where(eq(postsTable.id, postId));
      await answerCallbackQuery(query.id, "✅ Опубликован в канал!");
    } catch (err) {
      logger.error({ err }, "Publish via button failed");
      await answerCallbackQuery(query.id, "❌ Ошибка при публикации");
    }
  } else if (action === "rewrite") {
    await answerCallbackQuery(query.id, "🔁 Генерирую новую версию...");
    try {
      const { content, postType } = await generatePostContent({
        topic: post.topic ?? undefined,
        sourceUrl: post.sourceUrl ?? undefined,
        forceFormat: post.postType as "micro" | "short" | "medium" | "long",
      });

      const safety = checkSafety(content);
      const cleanedContent = cleanContent(content, safety);
      await incrementAiUsage("rewrite");

      await db.update(postsTable)
        .set({
          content: cleanedContent,
          postType,
          status: "draft",
          safetyStatus: safety.status,
          aiCallsUsed: (post.aiCallsUsed ?? 0) + 1,
        })
        .where(eq(postsTable.id, postId));

      const reviewMsgId = await sendReviewMessage(
        postId,
        cleanedContent,
        safety.warnings,
        postType,
        post.topic ?? undefined,
      );
      if (reviewMsgId) {
        await db.update(postsTable)
          .set({ reviewMessageId: reviewMsgId })
          .where(eq(postsTable.id, postId));
      }
    } catch (err) {
      logger.error({ err }, "Rewrite via button failed");
      await notifyOwner(`❌ Ошибка при перегенерации поста #${postId}: ${err instanceof Error ? err.message : "unknown"}`);
    }
  } else if (action === "skip") {
    await db.update(postsTable)
      .set({ status: "skipped" })
      .where(eq(postsTable.id, postId));
    await answerCallbackQuery(query.id, "❌ Пропущен");
  }
}

async function handleBotCommand(message: TelegramMessage): Promise<void> {
  const text = message.text ?? "";
  const chatId = message.chat.id.toString();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const sendReply = async (msg: string) => {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "HTML" }),
    });
  };

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  if (text.startsWith("/status")) {
    const [usage, settings] = await Promise.all([getOrCreateTodayUsage(), getSettings()]);
    const [drafts, published, pendingReview, skipped, safetyRejected] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(postsTable).where(eq(postsTable.status, "draft")),
      db.select({ count: sql<number>`count(*)` }).from(postsTable).where(eq(postsTable.status, "published")),
      db.select({ count: sql<number>`count(*)` }).from(postsTable)
        .where(sql`status = 'draft' AND review_message_id IS NOT NULL`),
      db.select({ count: sql<number>`count(*)` }).from(postsTable).where(eq(postsTable.status, "skipped")),
      db.select({ count: sql<number>`count(*)` }).from(postsTable).where(eq(postsTable.safetyStatus, "rejected")),
    ]);

    const msg =
      `📊 <b>Статус бота</b>\n\n` +
      `📝 Создано постов: ${usage.postsGenerated}/${settings.maxPostsPerDay}\n` +
      `✅ Опубликовано: ${Number(published[0]?.count ?? 0)}\n` +
      `⏳ Ожидают ревью: ${Number(pendingReview[0]?.count ?? 0)}\n` +
      `📋 Черновики: ${Number(drafts[0]?.count ?? 0)}\n` +
      `⏭️ Пропущено: ${Number(skipped[0]?.count ?? 0)}\n` +
      `🚫 Отклонено safety: ${Number(safetyRejected[0]?.count ?? 0)}\n` +
      `🤖 AI вызовы сегодня: ${usage.callsUsed}/${settings.maxAiCallsPerDay}`;
    await sendReply(msg);

  } else if (text.startsWith("/generate_now")) {
    await sendReply("🔄 Запускаю генерацию поста...");
    try {
      const { content, postType } = await generatePostContent({});
      const safety = checkSafety(content);
      const cleanedContent = cleanContent(content, safety);
      await incrementAiUsage("post");

      const [post] = await db.insert(postsTable).values({
        content: cleanedContent,
        postType,
        safetyStatus: safety.status,
        aiCallsUsed: 1,
      }).returning();

      const reviewMsgId = await sendReviewMessage(post.id, cleanedContent, safety.warnings, postType);
      if (reviewMsgId) {
        await db.update(postsTable).set({ reviewMessageId: reviewMsgId }).where(eq(postsTable.id, post.id));
      }
      await sendReply(`✅ Пост #${post.id} создан и отправлен на ревью.`);
    } catch (err) {
      await sendReply(`❌ Ошибка: ${err instanceof Error ? err.message : "неизвестная"}`);
    }

  } else if (text.startsWith("/sources")) {
    const sources = await db.select().from(sourcesTable).where(eq(sourcesTable.enabled, true));
    const primary = sources.filter((s) => s.isPrimary);
    const secondary = sources.filter((s) => !s.isPrimary);

    let msg = `📡 <b>Активные источники</b>\n\n`;
    if (primary.length) {
      msg += `<b>Telegram (основные):</b>\n${primary.map((s) => `• ${s.name} — ${s.url}`).join("\n")}\n\n`;
    }
    if (secondary.length) {
      msg += `<b>RSS/Web (вторичные):</b>\n${secondary.map((s) => `• ${s.name} — ${s.url}`).join("\n")}`;
    }
    if (!primary.length && !secondary.length) msg = "Нет активных источников.";
    await sendReply(msg);

  } else if (text.startsWith("/costs")) {
    const [usage, settings] = await Promise.all([getOrCreateTodayUsage(), getSettings()]);
    const aiPct = Math.round((usage.callsUsed / settings.maxAiCallsPerDay) * 100);
    const postPct = Math.round((usage.postsGenerated / settings.maxPostsPerDay) * 100);
    const warning = aiPct >= 80 || postPct >= 80
      ? "\n\n⚠️ Лимиты заканчиваются!"
      : "";

    const msg =
      `💰 <b>Расходы AI сегодня</b>\n\n` +
      `🤖 AI вызовы: ${usage.callsUsed}/${settings.maxAiCallsPerDay} (${aiPct}%)\n` +
      `📝 Постов создано: ${usage.postsGenerated}/${settings.maxPostsPerDay} (${postPct}%)\n` +
      `🔁 Перегенераций: ${usage.rewritesUsed}/${settings.maxRewritePerPost}\n` +
      `💡 Cost guard: ${settings.enableCostGuard ? "включён" : "выключен"}` +
      warning;
    await sendReply(msg);

  } else if (text.startsWith("/help")) {
    const msg =
      `🤖 <b>Команды бота</b>\n\n` +
      `/status — статус постов и AI-вызовов\n` +
      `/generate_now — запустить генерацию вручную\n` +
      `/sources — показать активные источники\n` +
      `/costs — AI-расходы и лимиты\n` +
      `/help — эта справка\n\n` +
      `📌 Каждый новый пост отправляется сюда с кнопками:\n` +
      `✅ Опубликовать  🔁 Переписать  ❌ Пропустить`;
    await sendReply(msg);
  }
}

export default router;
