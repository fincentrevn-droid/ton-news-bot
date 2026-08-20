import { readFile, writeFile } from "node:fs/promises";

const profile = (process.env.CHANNEL_PROFILE ?? process.env.CONTENT_PROFILE ?? "")
  .trim()
  .toLowerCase();

if (profile !== "crypto" && profile !== "pankoff_crypto") {
  process.exit(0);
}

async function patch(path, transform, label) {
  const source = await readFile(path, "utf8");
  const next = transform(source);
  if (next !== source) {
    await writeFile(path, next);
    console.log(label);
  }
}

// ── Telegram footer + custom emoji pack + final publish gate ────────────────
await patch(
  "artifacts/api-server/src/lib/telegram.ts",
  (input) => {
    let s = input;

    if (!s.includes('assessCryptoPublicBody } from "./crypto-policy"')) {
      s = s.replace(
        'import { isCryptoProfile } from "./channel-profile";',
        'import { isCryptoProfile } from "./channel-profile";\nimport { assessCryptoPublicBody } from "./crypto-policy";',
      );
    }

    s = s
      .replace('customEmoji("PANKOFF_FOOTER_CHAT_EMOJI_ID", "🟢", useCustomEmoji)', 'customEmoji("PANKOFF_FOOTER_CHAT_EMOJI_ID", "🐸", useCustomEmoji)')
      .replace('customEmoji("PANKOFF_FOOTER_X_EMOJI_ID", "𝕏", useCustomEmoji)', 'customEmoji("PANKOFF_FOOTER_X_EMOJI_ID", "🐣", useCustomEmoji)')
      .replace('customEmoji("PANKOFF_FOOTER_TT_EMOJI_ID", "♪", useCustomEmoji)', 'customEmoji("PANKOFF_FOOTER_TT_EMOJI_ID", "📹", useCustomEmoji)')
      .replace('customEmoji("PANKOFF_FOOTER_IN_EMOJI_ID", "◉", useCustomEmoji)', 'customEmoji("PANKOFF_FOOTER_IN_EMOJI_ID", "📷", useCustomEmoji)')
      .replace('customEmoji("PANKOFF_FOOTER_YT_EMOJI_ID", "▶️", useCustomEmoji)', 'customEmoji("PANKOFF_FOOTER_YT_EMOJI_ID", "📹", useCustomEmoji)')
      .replace('`<a href="${PANKOFF_FOOTER_LINKS.chat}">${chatIcon} Чат</a>`', '`<a href="${PANKOFF_FOOTER_LINKS.chat}">${chatIcon} <b>Чат</b></a>`')
      .replace('`<a href="${PANKOFF_FOOTER_LINKS.x}">${xIcon} X</a>`', '`<a href="${PANKOFF_FOOTER_LINKS.x}">${xIcon}X</a>`')
      .replace('`<a href="${PANKOFF_FOOTER_LINKS.tg}">${tgIcon} TG</a>`', '`<a href="${PANKOFF_FOOTER_LINKS.tg}">${tgIcon}TG</a>`')
      .replace('`<a href="${PANKOFF_FOOTER_LINKS.tt}">${ttIcon} TT</a>`', '`<a href="${PANKOFF_FOOTER_LINKS.tt}">${ttIcon}TT</a>`')
      .replace('`<a href="${PANKOFF_FOOTER_LINKS.instagram}">${instagramIcon} IN</a>`', '`<a href="${PANKOFF_FOOTER_LINKS.instagram}">${instagramIcon}IN</a>`')
      .replace('`<a href="${PANKOFF_FOOTER_LINKS.youtube}">${youtubeIcon} YT</a>`', '`<a href="${PANKOFF_FOOTER_LINKS.youtube}">${youtubeIcon}YT</a>`')
      .replace('].join(" · ");', '].join(" ");')
      .replace('const visibleFooter = "🟢 Чат · 𝕏 X · ✈️ TG · ♪ TT · ◉ IN · ▶️ YT";', 'const visibleFooter = "🐸 Чат 🐣X ✈️TG 📹TT 📷IN 📹YT";');

    if (!s.includes("PANKOFF_EMOJI_SET_NAME")) {
      const marker = '} as const;\n\nfunction customEmoji';
      const discovery = `} as const;\n\nconst PANKOFF_EMOJI_SET_NAME = "Flags_kotletovv";\nconst discoveredCustomEmojiIds: Record<string, string> = {};\nlet customEmojiPackPromise: Promise<void> | null = null;\n\nfunction normalizeEmojiFallback(value: string): string {\n  return value.replace(/\\uFE0F/g, "");\n}\n\nasync function ensurePankoffCustomEmojiPack(): Promise<void> {\n  if (!isCryptoProfile() || process.env.TELEGRAM_CUSTOM_EMOJI_ENABLED === "false") return;\n  if (customEmojiPackPromise) return customEmojiPackPromise;\n\n  customEmojiPackPromise = (async () => {\n    try {\n      const data = await telegramPost(getBotToken(), "getStickerSet", { name: PANKOFF_EMOJI_SET_NAME }) as {\n        ok: boolean;\n        result?: { stickers?: Array<{ emoji?: string; custom_emoji_id?: string }> };\n        description?: string;\n      };\n      if (!data.ok || !Array.isArray(data.result?.stickers)) {\n        logger.warn({ description: data.description }, "PANKOFF custom emoji pack unavailable — Unicode fallback will be used");\n        return;\n      }\n\n      const stickers = data.result.stickers.filter((item) => Boolean(item.custom_emoji_id));\n      const byFallback = (fallback: string) => stickers.filter(\n        (item) => normalizeEmojiFallback(item.emoji ?? "") === normalizeEmojiFallback(fallback),\n      );\n      const assign = (envName: string, item?: { custom_emoji_id?: string }) => {\n        if (item?.custom_emoji_id) discoveredCustomEmojiIds[envName] = item.custom_emoji_id;\n      };\n\n      assign("PANKOFF_FOOTER_CHAT_EMOJI_ID", byFallback("🐸")[0]);\n      assign("PANKOFF_FOOTER_X_EMOJI_ID", byFallback("🐣")[0]);\n      assign("PANKOFF_FOOTER_TG_EMOJI_ID", byFallback("✈️")[0] ?? byFallback("✈")[0]);\n      assign("PANKOFF_FOOTER_IN_EMOJI_ID", byFallback("📷")[0]);\n      const videos = byFallback("📹");\n      assign("PANKOFF_FOOTER_TT_EMOJI_ID", videos[0]);\n      assign("PANKOFF_FOOTER_YT_EMOJI_ID", videos[1] ?? videos[0]);\n\n      logger.info({ resolved: Object.keys(discoveredCustomEmojiIds).length }, "Loaded PANKOFF custom emoji pack");\n    } catch (err) {\n      logger.warn({ err }, "Failed to load PANKOFF custom emoji pack — Unicode fallback will be used");\n    }\n  })();\n\n  return customEmojiPackPromise;\n}\n\nfunction customEmoji`;
      if (s.includes(marker)) s = s.replace(marker, discovery);
    }

    s = s.replace(
      'const id = process.env[envName]?.trim();',
      'const id = process.env[envName]?.trim() || discoveredCustomEmojiIds[envName];',
    );

    if (!s.includes("PANKOFF_FINAL_BODY_GATE")) {
      s = s.replace(
        'export async function sendTelegramMessage(text: string): Promise<number> {\n  const token = getBotToken();',
        'export async function sendTelegramMessage(text: string): Promise<number> {\n  // PANKOFF_FINAL_BODY_GATE: every publication path, including manual Publish Now, must pass the same crypto policy.\n  if (isCryptoProfile()) {\n    const bodyAssessment = assessCryptoPublicBody(text);\n    if (!bodyAssessment.accepted) {\n      throw new Error(`PANKOFF post blocked before publish: ${bodyAssessment.reasons.join(", ")}`);\n    }\n    await ensurePankoffCustomEmojiPack();\n  }\n  const token = getBotToken();',
      );

      s = s.replace(
        '): Promise<PhotoPublishResult> {\n  const token = getBotToken();',
        '): Promise<PhotoPublishResult> {\n  if (isCryptoProfile()) {\n    const bodyAssessment = assessCryptoPublicBody(caption);\n    if (!bodyAssessment.accepted) {\n      throw new Error(`PANKOFF post blocked before publish: ${bodyAssessment.reasons.join(", ")}`);\n    }\n    await ensurePankoffCustomEmojiPack();\n  }\n  const token = getBotToken();',
      );
    }

    s = s.replace(
      '].some((name) => /^\\d+$/.test(process.env[name]?.trim() ?? ""));',
      '].some((name) => /^\\d+$/.test(process.env[name]?.trim() ?? "")) || Object.keys(discoveredCustomEmojiIds).length > 0;',
    );

    return s;
  },
  "Updated PANKOFF footer, custom emoji pack and final publish gate",
);

// ── Post Queue final-post footer preview ────────────────────────────────────
await patch(
  "artifacts/dashboard/src/pages/posts.tsx",
  (input) => {
    let s = input;
    if (!s.includes("PANKOFF_FOOTER_PREVIEW")) {
      s = s.replace(
        'const STATUS_COLORS: Record<string, string> = {',
        `const PANKOFF_FOOTER_PREVIEW = (\n  <div className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-sm text-muted-foreground">\n    <a href="https://t.me/pankoff_chat" target="_blank" rel="noreferrer" className="hover:text-foreground">🐸 <strong>Чат</strong></a>\n    <a href="https://x.com/pankoffcrypto" target="_blank" rel="noreferrer" className="hover:text-foreground">🐣X</a>\n    <a href="https://t.me/pankoff_crypto" target="_blank" rel="noreferrer" className="hover:text-foreground">✈️TG</a>\n    <a href="https://www.tiktok.com/@pankoff33" target="_blank" rel="noreferrer" className="hover:text-foreground">📹TT</a>\n    <a href="https://instagram.com/_pankoff" target="_blank" rel="noreferrer" className="hover:text-foreground">📷IN</a>\n    <a href="https://youtube.com/@pankoff33" target="_blank" rel="noreferrer" className="hover:text-foreground">📹YT</a>\n  </div>\n);\n\nconst STATUS_COLORS: Record<string, string> = {`,
      );
      s = s.replace(
        '        )}\n\n        <div className="mt-4 flex flex-wrap items-center gap-2 pt-4 border-t border-border">',
        '        )}\n\n        {PANKOFF_FOOTER_PREVIEW}\n\n        <div className="mt-4 flex flex-wrap items-center gap-2 pt-4 border-t border-border">',
      );
    }
    return s;
  },
  "Added PANKOFF footer preview to Post Queue",
);

// ── Telegram source URL normalization on create + edit ─────────────────────
await patch(
  "artifacts/api-server/src/routes/sources.ts",
  (input) => {
    let s = input;
    if (!s.includes("normalizeSourceUrl")) {
      s = s.replace(
        'const router = Router();',
        `const router = Router();\n\nfunction normalizeSourceUrl(raw: string): string {\n  const value = raw.trim();\n  if (value.startsWith("@")) {\n    const handle = value.slice(1).split(/[/?#]/)[0].trim();\n    return handle ? \`@\${handle}\` : value;\n  }\n  const withoutProtocol = value.replace(/^https?:\\/\\//i, "").replace(/^www\\./i, "");\n  const match = withoutProtocol.match(/^(?:t\\.me|telegram\\.me)\\/([^/?#]+)/i);\n  return match?.[1] ? \`@\${match[1]}\` : value;\n}`,
      );
      const oldBlock = `  // Normalise Telegram channel URLs: "https://t.me/foo", "t.me/foo" → "@foo"\n  let url = parsed.data.url.trim();\n  if (parsed.data.type === "telegram_channel") {\n    const clean = url\n      .replace(/^https?:\\/\\//i, "")\n      .replace(/^t\\.me\\//i, "")\n      .replace(/^@/, "")\n      .split("/")[0]\n      .trim();\n    url = \`@\${clean}\`;\n  }`;
      s = s.replace(oldBlock, '  const url = parsed.data.type === "telegram_channel" ? normalizeSourceUrl(parsed.data.url) : parsed.data.url.trim();');
      s = s.replace(
        'if (parsed.data.url !== undefined) updateData.url = parsed.data.url;',
        'if (parsed.data.url !== undefined) updateData.url = normalizeSourceUrl(parsed.data.url);',
      );
    }
    return s;
  },
  "Hardened Telegram source URL normalization",
);

// ── MTProto reader: crypto must not use business ranking; record Last fetched ─
await patch(
  "artifacts/api-server/src/lib/telegram-reader.ts",
  (input) => {
    let s = input;
    if (!s.includes('sourcesTable } from "@workspace/db"')) {
      s = s.replace(
        'import { getContentProfile } from "../config/content-profile";',
        'import { getContentProfile } from "../config/content-profile";\nimport { db, sourcesTable } from "@workspace/db";\nimport { eq } from "drizzle-orm";',
      );
    }
    if (!s.includes("isTelegramReaderConnected")) {
      s = s.replace(
        'export function isTelegramReaderAvailable(): boolean {\n  return isSessionConfigured();\n}',
        'export function isTelegramReaderAvailable(): boolean {\n  return isSessionConfigured();\n}\n\nexport function isTelegramReaderConnected(): boolean {\n  return clientConnected;\n}',
      );
    }
    if (!s.includes("PANKOFF_LAST_FETCHED")) {
      s = s.replace(
        '      const messages = await client.getMessages(username, { limit: 50 });\n      logger.info({ channel: ch.name, username, count: messages.length }, "Fetched messages from Telegram channel");',
        '      const messages = await client.getMessages(username, { limit: 50 });\n      // PANKOFF_LAST_FETCHED: only a successful Telegram read updates source health.\n      await db.update(sourcesTable).set({ lastFetchedAt: new Date() }).where(eq(sourcesTable.url, ch.url));\n      logger.info({ channel: ch.name, username, count: messages.length }, "Fetched messages from Telegram channel");',
      );
    }
    const oldFilters = `        if (isHardBlockedSource(text)) continue;\n        if (!ch.isPrimary && hasHighRiskRegulatoryClaim(text)) continue;\n        const score = scoreText(text);\n        // A photo never overrides relevance: hard filters apply to every source post.\n        if (score < (ch.isPrimary ? 1 : MIN_BUSINESS_RELEVANCE_SCORE)) continue;`;
    const newFilters = `        let score = 1;\n        if (contentProfile.id !== "crypto") {\n          if (isHardBlockedSource(text)) continue;\n          if (!ch.isPrimary && hasHighRiskRegulatoryClaim(text)) continue;\n          score = scoreText(text);\n          // Business-only relevance gate. Crypto is filtered later by crypto-policy.\n          if (score < (ch.isPrimary ? 1 : MIN_BUSINESS_RELEVANCE_SCORE)) continue;\n        }`;
    s = s.replace(oldFilters, newFilters);
    s = s.replace(
      '  return all.filter(\n    (p) => p.relevanceScore >= (p.isPrimarySource ? 1 : MIN_BUSINESS_RELEVANCE_SCORE),\n  );',
      '  if (contentProfile.id === "crypto") return all;\n  return all.filter(\n    (p) => p.relevanceScore >= (p.isPrimarySource ? 1 : MIN_BUSINESS_RELEVANCE_SCORE),\n  );',
    );
    return s;
  },
  "Hardened PANKOFF MTProto source reading and Last fetched tracking",
);

// ── Source pipeline: explicit MTProto failure + no hidden RSS fallback in crypto ─
await patch(
  "artifacts/api-server/src/lib/sources.ts",
  (input) => {
    let s = input;
    s = s.replace(
      'import { fetchTelegramChannelPosts, isTelegramReaderAvailable } from "./telegram-reader";',
      'import { fetchTelegramChannelPosts, isTelegramReaderAvailable, isTelegramReaderConnected } from "./telegram-reader";',
    );
    s = s.replace(
      '  const tgList = tgPosts.status === "fulfilled" ? tgPosts.value : [];',
      '  if (getContentProfile().id === "crypto" && isTelegramReaderAvailable() && !isTelegramReaderConnected()) {\n    throw new Error("Telegram MTProto reader не подключён. Проверьте TELEGRAM_STRING_SESSION, TELEGRAM_API_ID и TELEGRAM_API_HASH.");\n  }\n\n  const tgList = tgPosts.status === "fulfilled" ? tgPosts.value : [];',
    );
    s = s.replace(
      'if (tgList.length === 0 && process.env.ENABLE_SECONDARY_SOURCES !== "true") {',
      'if (tgList.length === 0 && process.env.ENABLE_SECONDARY_SOURCES !== "true" && getContentProfile().id !== "crypto") {',
    );
    return s;
  },
  "Made PANKOFF source-only diagnostics explicit and disabled hidden RSS fallback",
);

// ── Deterministic Russian-language gate ─────────────────────────────────────
await patch(
  "artifacts/api-server/src/lib/crypto-policy.ts",
  (input) => {
    let s = input;
    if (!s.includes("isPredominantlyRussian")) {
      s = s.replace(
        '/**\n * Must be true before a crypto post can be queued for auto-publishing.',
        `function isPredominantlyRussian(text: string): boolean {\n  if (/[іїєґ]/i.test(text)) return false;\n  const russian = text.match(/[а-яё]/gi) ?? [];\n  const latin = text.match(/[a-z]/gi) ?? [];\n  // Allow tickers and company names, but the surrounding sentence must be Russian.\n  return russian.length >= 12 && russian.length >= Math.max(12, Math.round(latin.length * 0.65));\n}\n\n/**\n * Must be true before a crypto post can be queued for auto-publishing.`,
      );
      s = s.replace(
        '  if (!trimmed) reasons.push("пустой текст");',
        '  if (!trimmed) reasons.push("пустой текст");\n  if (trimmed && !isPredominantlyRussian(trimmed)) reasons.push("публичный текст должен быть на русском языке");',
      );
    }
    return s;
  },
  "Added deterministic Russian-language gate for PANKOFF",
);

// ── Russian service responses in PANKOFF dashboard trigger ─────────────────
await patch(
  "artifacts/api-server/src/routes/schedule.ts",
  (input) => input
    .replace('`Матеріал #${result.postId} пройшов перевірку та доданий до черги`', '`Материал #${result.postId} прошёл проверку и добавлен в очередь`')
    .replace('"Відповідного матеріалу не знайдено або він не пройшов фільтри"', '"Подходящий материал не найден или не прошёл фильтры"')
    .replace('"Generation cycle failed"', '"Ошибка цикла генерации"'),
  "Localized PANKOFF dashboard generation responses to Russian",
);

// ── Scheduler: atomic claim, short no-source retry, immediate startup tick ──
await patch(
  "artifacts/api-server/src/lib/scheduler.ts",
  (input) => {
    let s = input;
    if (!s.includes("PANKOFF_ATOMIC_CLAIM")) {
      s = s.replace(
        '    // ── Publish the queued post ──────────────────────────────────────────────\n    logger.info({ postId: post.id, format: post.postType, confidence: post.confidence }, "Scheduler: auto-publishing post");',
        '    // PANKOFF_ATOMIC_CLAIM: claim the draft before touching Telegram so concurrent ticks cannot double-send it.\n    const [claimed] = await db\n      .update(postsTable)\n      .set({ status: "publishing" })\n      .where(and(eq(postsTable.id, post.id), eq(postsTable.status, "draft")))\n      .returning();\n    if (!claimed) {\n      logger.debug({ postId: post.id }, "Scheduler: draft already claimed by another worker");\n      return;\n    }\n\n    // ── Publish the queued post ──────────────────────────────────────────────\n    logger.info({ postId: post.id, format: post.postType, confidence: post.confidence }, "Scheduler: auto-publishing post");',
      );
      s = s.replace(
        '      .where(eq(postsTable.id, post.id));',
        '      .where(and(eq(postsTable.id, post.id), eq(postsTable.status, "publishing")));',
      );
    }

    if (!s.includes("AUTO_GENERATE_RETRY_MINUTES")) {
      s = s.replace(
        'let autoGenerateInProgress = false;',
        'let autoGenerateInProgress = false;\nconst AUTO_GENERATE_RETRY_MINUTES = Math.max(5, Number.parseInt(process.env.AUTO_GENERATE_RETRY_MINUTES ?? "30", 10) || 30);',
      );
      s = s.replace(
        '      } else {\n        logger.info("Scheduler: auto-generation returned no post (no sources or all NO_POST)");\n      }',
        '      } else {\n        const cooldownMinutes = Math.max(minMinutesBetweenPosts, 75);\n        lastAutoGenerateAttemptMs = Date.now() - Math.max(0, cooldownMinutes - AUTO_GENERATE_RETRY_MINUTES) * 60 * 1000;\n        logger.info({ retryInMin: AUTO_GENERATE_RETRY_MINUTES }, "Scheduler: auto-generation returned no post; short retry scheduled");\n      }',
      );
    }

    if (!s.includes("Initial scheduler tick")) {
      s = s.replace(
        '  setInterval(() => {\n    tickPublisher().catch((err) => logger.error({ err }, "Unhandled scheduler tick error"));\n  }, TICK_INTERVAL_MS);',
        '  setTimeout(() => {\n    tickPublisher().catch((err) => logger.error({ err }, "Initial scheduler tick error"));\n  }, 5_000);\n  setInterval(() => {\n    tickPublisher().catch((err) => logger.error({ err }, "Unhandled scheduler tick error"));\n  }, TICK_INTERVAL_MS);',
      );
    }
    return s;
  },
  "Hardened PANKOFF scheduler against duplicate sends and slow retries",
);
