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

// Exact custom emoji mapping: do not reuse TT custom emoji for YT when the pack has only one 📹.
await patch(
  "artifacts/api-server/src/lib/telegram.ts",
  (s) => s.replace(
    'assign("PANKOFF_FOOTER_YT_EMOJI_ID", videos[1] ?? videos[0]);',
    'assign("PANKOFF_FOOTER_YT_EMOJI_ID", videos[1]);',
  ),
  "Adjusted PANKOFF duplicate video emoji fallback",
);

// Keep very short Russian crypto headlines valid while still rejecting English/Ukrainian bodies.
await patch(
  "artifacts/api-server/src/lib/crypto-policy.ts",
  (s) => s.replace(
    'return russian.length >= 12 && russian.length >= Math.max(12, Math.round(latin.length * 0.65));',
    'return russian.length >= 6 && russian.length >= Math.max(6, Math.round(latin.length * 0.45));',
  ),
  "Relaxed Russian gate for short crypto headlines",
);

// Explicitly fail when MTProto credentials are absent and track successful RSS reads too.
await patch(
  "artifacts/api-server/src/lib/sources.ts",
  (input) => {
    let s = input;
    if (!s.includes("MTProto reader не настроен")) {
      s = s.replace(
        'export async function fetchSourcePosts(): Promise<SourcePost[]> {',
        'export async function fetchSourcePosts(): Promise<SourcePost[]> {\n  if (getContentProfile().id === "crypto" && !isTelegramReaderAvailable()) {\n    throw new Error("Telegram MTProto reader не настроен. Заполните TELEGRAM_STRING_SESSION, TELEGRAM_API_ID и TELEGRAM_API_HASH.");\n  }',
      );
    }
    if (!s.includes("PANKOFF_RSS_LAST_FETCHED")) {
      s = s.replaceAll(
        '      const xml = await res.text();\n      return parseItems(xml, src.name, src.url, src.isPrimary);',
        '      const xml = await res.text();\n      // PANKOFF_RSS_LAST_FETCHED: record only a successful HTTP read.\n      await db.update(sourcesTable).set({ lastFetchedAt: new Date() }).where(eq(sourcesTable.id, src.id));\n      return parseItems(xml, src.name, src.url, src.isPrimary);',
      );
    }
    return s;
  },
  "Completed PANKOFF source health diagnostics",
);

// If the model answers in the wrong language, spend the single allowed rewrite on a Russian version and re-run QC.
await patch(
  "artifacts/api-server/src/lib/auto-generate.ts",
  (input) => {
    let s = input;
    if (!s.includes("PANKOFF_LANGUAGE_REWRITE")) {
      s = s.replace(
        '  // ── Decide: auto-publish queue or manual review ───────────────────────────',
        `  // PANKOFF_LANGUAGE_REWRITE: wrong-language output gets at most one grounded rewrite.\n  if (cryptoProfile && rewriteAttempts < maxQualityRewrites) {\n    const languageAssessment = assessCryptoPublicBody(finalContent);\n    if (languageAssessment.reasons.some((reason) => reason.includes("русском языке"))) {\n      try {\n        const rewritten = await rewriteWithFeedback({\n          content: finalContent,\n          issues: languageAssessment.reasons,\n          instruction: "Перепиши весь публичный текст строго на русском языке. Сохрани только факты исходного материала, цифры и имена. Не добавляй аналитику или новые сведения.",\n          sourceText: candidate.fullText,\n          sourceChannel: candidate.channel,\n          originalFormat: postType,\n        });\n        rewriteAttempts++;\n        const recheck = qualityCheckEnabled\n          ? await runQualityCheck(rewritten, candidate.fullText, candidate.pubDate)\n          : qualityResult;\n        finalContent = rewritten;\n        if (recheck) qualityResult = recheck;\n        logger.info({ rewriteAttempts, qualityScore: qualityResult?.quality_score }, "PANKOFF language rewrite completed");\n      } catch (languageRewriteErr) {\n        logger.warn({ languageRewriteErr }, "PANKOFF language rewrite failed");\n      }\n    }\n  }\n\n  // ── Decide: auto-publish queue or manual review ───────────────────────────`,
      );
    }
    return s;
  },
  "Added grounded one-shot Russian rewrite for PANKOFF",
);

// Atomic Publish Now from dashboard.
await patch(
  "artifacts/api-server/src/routes/posts.ts",
  (input) => {
    const start = input.indexOf('router.post("/posts/:id/publish"');
    const end = input.indexOf('router.post("/posts/:id/regenerate"');
    if (start < 0 || end < 0 || input.slice(start, end).includes("PANKOFF_MANUAL_ATOMIC_CLAIM")) return input;

    const replacement = `router.post("/posts/:id/publish", async (req, res): Promise<void> => {\n  const params = PublishPostParams.safeParse(req.params);\n  if (!params.success) {\n    res.status(400).json({ error: params.error.message });\n    return;\n  }\n  const [post] = await db.select().from(postsTable).where(eq(postsTable.id, params.data.id));\n  if (!post) {\n    res.status(404).json({ error: "Post not found" });\n    return;\n  }\n  if (post.status === "published") {\n    res.status(400).json({ error: "Post already published" });\n    return;\n  }\n  if (post.status === "publishing") {\n    res.status(409).json({ error: "Post is already being published" });\n    return;\n  }\n\n  // PANKOFF_MANUAL_ATOMIC_CLAIM\n  const [claimed] = await db\n    .update(postsTable)\n    .set({ status: "publishing" })\n    .where(and(eq(postsTable.id, params.data.id), eq(postsTable.status, post.status)))\n    .returning();\n  if (!claimed) {\n    res.status(409).json({ error: "Post was claimed by another publisher" });\n    return;\n  }\n\n  try {\n    const messageId = await sendTelegramMessage(claimed.content);\n    const [updated] = await db\n      .update(postsTable)\n      .set({ status: "published", telegramMessageId: messageId, publishedAt: new Date() })\n      .where(and(eq(postsTable.id, params.data.id), eq(postsTable.status, "publishing")))\n      .returning();\n    if (!updated) {\n      await notifyOwner(\`⚠️ Telegram принял пост #\${params.data.id}, но БД не подтвердила статус published. Пост оставлен в publishing для защиты от дубля.\`);\n      res.status(500).json({ error: "Telegram publish succeeded but DB confirmation failed" });\n      return;\n    }\n    res.json(updated);\n  } catch (err: unknown) {\n    const message = err instanceof Error ? err.message : "Telegram publish failed";\n    await notifyOwner(\`⚠️ Публикация поста #\${params.data.id} не подтверждена. Статус publishing сохранён, чтобы исключить дубль. Проверьте пост вручную.\`);\n    req.log.error({ err }, "Publish failed after atomic claim");\n    res.status(500).json({ error: message });\n  }\n});\n\n`;
    return input.slice(0, start) + replacement + input.slice(end);
  },
  "Protected dashboard Publish Now from duplicate sends",
);

// Atomic Telegram review callback publish.
await patch(
  "artifacts/api-server/src/routes/webhook.ts",
  (input) => {
    const start = input.indexOf('  if (action === "publish") {');
    const end = input.indexOf('  } else if (action === "rewrite") {');
    if (start < 0 || end < 0 || input.slice(start, end).includes("PANKOFF_REVIEW_ATOMIC_CLAIM")) return input;

    const replacement = `  if (action === "publish") {\n    if (post.status === "published") {\n      await answerCallbackQuery(query.id, "Уже опубликован");\n      return;\n    }\n    if (post.status === "publishing") {\n      await answerCallbackQuery(query.id, "Пост уже публикуется");\n      return;\n    }\n\n    // PANKOFF_REVIEW_ATOMIC_CLAIM\n    const [claimed] = await db\n      .update(postsTable)\n      .set({ status: "publishing" })\n      .where(and(eq(postsTable.id, postId), eq(postsTable.status, post.status)))\n      .returning();\n    if (!claimed) {\n      await answerCallbackQuery(query.id, "Пост уже забрал другой процесс");\n      return;\n    }\n\n    try {\n      let messageId: number;\n      let newFileId: string | null = claimed.mediaFileId ?? null;\n      const canPublishPhoto = Boolean(\n        claimed.hasMedia\n        && claimed.mediaFileId\n        && (!isCryptoProfile() || claimed.mediaDownloadStatus === "visual_safe")\n      );\n\n      if (canPublishPhoto && claimed.mediaFileId) {\n        const result = await sendPhotoPost(claimed.mediaFileId, claimed.content);\n        messageId = result.messageId;\n        newFileId = result.fileId || claimed.mediaFileId;\n      } else {\n        messageId = await sendTelegramMessage(claimed.content);\n      }\n\n      const [updated] = await db.update(postsTable)\n        .set({\n          status: "published",\n          telegramMessageId: messageId,\n          publishedAt: new Date(),\n          ...(newFileId ? { mediaFileId: newFileId } : {}),\n        })\n        .where(and(eq(postsTable.id, postId), eq(postsTable.status, "publishing")))\n        .returning();\n      if (!updated) {\n        await notifyOwner(\`⚠️ Telegram принял пост #\${postId}, но БД не подтвердила published. Статус publishing сохранён для защиты от дубля.\`);\n        await answerCallbackQuery(query.id, "⚠️ Telegram отправил пост, нужна проверка БД");\n        return;\n      }\n      await answerCallbackQuery(query.id, canPublishPhoto ? "✅ Опубликован с фото!" : "✅ Опубликован в канал!");\n    } catch (err) {\n      logger.error({ err }, "Publish via button failed after atomic claim");\n      await notifyOwner(\`⚠️ Публикация поста #\${postId} не подтверждена. Статус publishing оставлен для защиты от дубля.\`);\n      await answerCallbackQuery(query.id, "❌ Ошибка при публикации, дубль заблокирован");\n    }\n\n`;
    return input.slice(0, start) + replacement + input.slice(end);
  },
  "Protected Telegram review publish from duplicate sends",
);

// Scheduler: owner alert and DB confirmation after the atomic claim.
await patch(
  "artifacts/api-server/src/lib/scheduler.ts",
  (input) => {
    let s = input;
    if (!s.includes("let claimedPostId: number | null")) {
      s = s.replace(
        'export async function tickPublisher(): Promise<void> {\n  try {',
        'export async function tickPublisher(): Promise<void> {\n  let claimedPostId: number | null = null;\n  try {',
      );
      s = s.replace(
        '    if (!claimed) {\n      logger.debug({ postId: post.id }, "Scheduler: draft already claimed by another worker");\n      return;\n    }',
        '    if (!claimed) {\n      logger.debug({ postId: post.id }, "Scheduler: draft already claimed by another worker");\n      return;\n    }\n    claimedPostId = post.id;',
      );
    }

    const oldPersist = `    await db\n      .update(postsTable)\n      .set({\n        status: "published",\n        telegramMessageId: messageId,\n        publishedAt: new Date(),\n        ...(newFileId ? { mediaFileId: newFileId } : {}),\n      })\n      .where(and(eq(postsTable.id, post.id), eq(postsTable.status, "publishing")));`;
    const newPersist = `    const [persistedPost] = await db\n      .update(postsTable)\n      .set({\n        status: "published",\n        telegramMessageId: messageId,\n        publishedAt: new Date(),\n        ...(newFileId ? { mediaFileId: newFileId } : {}),\n      })\n      .where(and(eq(postsTable.id, post.id), eq(postsTable.status, "publishing")))\n      .returning();\n    if (!persistedPost) {\n      await notifyOwner(\`⚠️ Telegram принял автопост #\${post.id}, но БД не подтвердила published. Статус publishing оставлен для защиты от дубля.\`);\n      throw new Error("Published Telegram message was not persisted in DB");\n    }\n    claimedPostId = null;`;
    s = s.replace(oldPersist, newPersist);

    s = s.replace(
      '  } catch (err) {\n    logger.error({ err }, "Scheduler tick error");\n  }',
      '  } catch (err) {\n    if (claimedPostId !== null) {\n      await notifyOwner(`⚠️ Автопубликация поста #${claimedPostId} не подтверждена. Статус publishing сохранён, чтобы исключить дубль. Проверьте канал и пост вручную.`).catch((notifyErr) => logger.error({ notifyErr }, "Failed to notify owner about publishing lock"));\n    }\n    logger.error({ err, claimedPostId }, "Scheduler tick error");\n  }',
    );
    return s;
  },
  "Completed PANKOFF scheduler duplicate-send recovery",
);
