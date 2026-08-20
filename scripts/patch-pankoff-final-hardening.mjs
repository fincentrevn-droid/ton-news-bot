import { readFile, writeFile } from "node:fs/promises";

const profile = (process.env.CHANNEL_PROFILE ?? process.env.CONTENT_PROFILE ?? "")
  .trim()
  .toLowerCase();

if (profile !== "crypto" && profile !== "pankoff_crypto") process.exit(0);

async function patch(path, transform, label) {
  const source = await readFile(path, "utf8");
  const next = transform(source);
  if (next !== source) {
    await writeFile(path, next);
    console.log(label);
  }
}

// PANKOFF must use only the explicitly configured source policy. If Telegram is
// unavailable, fail loudly instead of silently switching to disabled RSS feeds.
await patch(
  "artifacts/api-server/src/lib/sources.ts",
  (input) => {
    let s = input;

    s = s.replace(
      '  if (tgPosts.status === "rejected") {\n    logger.warn({ err: tgPosts.reason }, "Telegram channel fetch pipeline failed");\n  }',
      '  if (tgPosts.status === "rejected") {\n    logger.warn({ err: tgPosts.reason }, "Telegram channel fetch pipeline failed");\n    if (getContentProfile().id === "crypto") {\n      throw tgPosts.reason instanceof Error\n        ? tgPosts.reason\n        : new Error("Telegram source pipeline failed for PANKOFF CRYPTO");\n    }\n  }',
    );

    s = s.replace(
      '  if (tgList.length === 0 && process.env.ENABLE_SECONDARY_SOURCES !== "true") {',
      '  // PANKOFF_NO_EMERGENCY_RSS: crypto never bypasses ENABLE_SECONDARY_SOURCES.\n  if (getContentProfile().id !== "crypto" && tgList.length === 0 && process.env.ENABLE_SECONDARY_SOURCES !== "true") {',
    );

    return s;
  },
  "Disabled hidden RSS fallback and made Telegram failures explicit for PANKOFF",
);

// Credentials being present is not the same as a healthy MTProto connection.
// For PANKOFF, a failed connection must propagate to the caller and dashboard.
await patch(
  "artifacts/api-server/src/lib/telegram-reader.ts",
  (input) => input.replace(
    '  if (!client) {\n    logger.warn("Telegram MTProto client unavailable — skipping channel read");\n    return [];\n  }',
    '  if (!client) {\n    if (contentProfile.id === "crypto") {\n      throw new Error("Telegram MTProto connection failed for PANKOFF CRYPTO");\n    }\n    logger.warn("Telegram MTProto client unavailable — skipping channel read");\n    return [];\n  }',
  ),
  "Made PANKOFF MTProto connection failures explicit",
);

// Dashboard Publish Now must preserve a source photo when it passed the crypto
// visual-safety gate. The existing Telegram review and scheduler paths already do.
await patch(
  "artifacts/api-server/src/routes/posts.ts",
  (input) => {
    let s = input;
    s = s.replace(
      'import { sendTelegramMessage, sendReviewMessage, notifyOwner } from "../lib/telegram";',
      'import { sendTelegramMessage, sendPhotoPost, sendReviewMessage, notifyOwner } from "../lib/telegram";',
    );

    if (!s.includes("PANKOFF_DASHBOARD_MEDIA_PUBLISH")) {
      s = s.replace(
        '  try {\n    const messageId = await sendTelegramMessage(claimed.content);\n    const [updated] = await db\n      .update(postsTable)\n      .set({ status: "published", telegramMessageId: messageId, publishedAt: new Date() })',
        '  try {\n    // PANKOFF_DASHBOARD_MEDIA_PUBLISH\n    let messageId: number;\n    let newFileId: string | null = claimed.mediaFileId ?? null;\n    const canPublishPhoto = Boolean(\n      claimed.hasMedia\n      && claimed.mediaFileId\n      && claimed.mediaDownloadStatus === "visual_safe"\n    );\n\n    if (canPublishPhoto && claimed.mediaFileId) {\n      const result = await sendPhotoPost(claimed.mediaFileId, claimed.content);\n      messageId = result.messageId;\n      newFileId = result.fileId || claimed.mediaFileId;\n    } else {\n      messageId = await sendTelegramMessage(claimed.content);\n    }\n\n    const [updated] = await db\n      .update(postsTable)\n      .set({\n        status: "published",\n        telegramMessageId: messageId,\n        publishedAt: new Date(),\n        ...(newFileId ? { mediaFileId: newFileId } : {}),\n      })',
      );
    }

    return s;
  },
  "Preserved safe PANKOFF photos for dashboard Publish Now",
);

// Telegram review-button publishing gets the same recoverable lock semantics as
// dashboard Publish Now: explicit Bot API rejection releases immediately;
// ambiguous network failures keep a short lock to prevent duplicate sends.
await patch(
  "artifacts/api-server/src/routes/webhook.ts",
  (input) => {
    const start = input.indexOf('  if (action === "publish") {');
    const end = input.indexOf('  } else if (action === "rewrite") {');
    if (start < 0 || end < 0) return input;
    if (input.slice(start, end).includes("PANKOFF_REVIEW_RECOVERABLE_LOCK")) return input;

    const replacement = `  if (action === "publish") {\n    if (post.status === "published") {\n      await answerCallbackQuery(query.id, "Уже опубликован");\n      return;\n    }\n\n    // PANKOFF_REVIEW_RECOVERABLE_LOCK\n    const PUBLISH_LOCK_TTL_MS = 3 * 60 * 1000;\n    let claimFromStatus = post.status;\n\n    if (post.status === "publishing") {\n      const lockAgeMs = Date.now() - new Date(post.updatedAt).getTime();\n      if (lockAgeMs < PUBLISH_LOCK_TTL_MS) {\n        const retryAfterSeconds = Math.max(1, Math.ceil((PUBLISH_LOCK_TTL_MS - lockAgeMs) / 1000));\n        await answerCallbackQuery(query.id, \`Пост уже публикуется. Повтор через ~\${retryAfterSeconds}с\`);\n        return;\n      }\n\n      const [released] = await db\n        .update(postsTable)\n        .set({ status: "draft" })\n        .where(and(\n          eq(postsTable.id, postId),\n          eq(postsTable.status, "publishing"),\n          eq(postsTable.updatedAt, post.updatedAt),\n        ))\n        .returning();\n      if (!released) {\n        await answerCallbackQuery(query.id, "Статус изменился. Обнови сообщение и повтори");\n        return;\n      }\n      claimFromStatus = "draft";\n    }\n\n    const [claimed] = await db\n      .update(postsTable)\n      .set({ status: "publishing" })\n      .where(and(eq(postsTable.id, postId), eq(postsTable.status, claimFromStatus)))\n      .returning();\n    if (!claimed) {\n      await answerCallbackQuery(query.id, "Пост уже забрал другой процесс");\n      return;\n    }\n\n    try {\n      let messageId: number;\n      let newFileId: string | null = claimed.mediaFileId ?? null;\n      const canPublishPhoto = Boolean(\n        claimed.hasMedia\n        && claimed.mediaFileId\n        && (!isCryptoProfile() || claimed.mediaDownloadStatus === "visual_safe")\n      );\n\n      if (canPublishPhoto && claimed.mediaFileId) {\n        const result = await sendPhotoPost(claimed.mediaFileId, claimed.content);\n        messageId = result.messageId;\n        newFileId = result.fileId || claimed.mediaFileId;\n      } else {\n        messageId = await sendTelegramMessage(claimed.content);\n      }\n\n      const [updated] = await db.update(postsTable)\n        .set({\n          status: "published",\n          telegramMessageId: messageId,\n          publishedAt: new Date(),\n          ...(newFileId ? { mediaFileId: newFileId } : {}),\n        })\n        .where(and(eq(postsTable.id, postId), eq(postsTable.status, "publishing")))\n        .returning();\n      if (!updated) {\n        await notifyOwner(\`⚠️ Telegram принял пост #\${postId}, но БД не подтвердила published. Не повторяй публикацию ближайшие 3 минуты и проверь канал.\`);\n        await answerCallbackQuery(query.id, "⚠️ Telegram отправил пост, нужна проверка БД");\n        return;\n      }\n      await answerCallbackQuery(query.id, canPublishPhoto ? "✅ Опубликован с фото!" : "✅ Опубликован в канал!");\n    } catch (err) {\n      const message = err instanceof Error ? err.message : "Telegram publish failed";\n      const definitelyRejectedByTelegram = message.startsWith("Telegram error:") || message.startsWith("Telegram sendPhoto error:") || message.startsWith("PANKOFF post blocked before publish:");\n\n      if (definitelyRejectedByTelegram) {\n        await db\n          .update(postsTable)\n          .set({ status: claimFromStatus })\n          .where(and(eq(postsTable.id, postId), eq(postsTable.status, "publishing")));\n        logger.error({ err }, "Telegram explicitly rejected review publish; lock released");\n        await answerCallbackQuery(query.id, "❌ Telegram отклонил пост. Можно исправить и повторить");\n        return;\n      }\n\n      logger.error({ err }, "Ambiguous review publish failure; temporary lock kept");\n      await notifyOwner(\`⚠️ Публикация поста #\${postId} не подтверждена из-за сетевой ошибки. Проверь канал; повтор станет доступен через 3 минуты.\`);\n      await answerCallbackQuery(query.id, "⚠️ Сетевая ошибка. Проверь канал перед повтором");\n    }\n\n`;
    return input.slice(0, start) + replacement + input.slice(end);
  },
  "Added recoverable PANKOFF lock to Telegram review publishing",
);

console.log("PANKOFF final production hardening complete");
