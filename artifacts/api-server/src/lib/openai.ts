import OpenAI from "openai";
import { logger } from "./logger";
import { db } from "@workspace/db";
import { aiUsageTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAI({ apiKey });
}

function todayDate(): string {
  return new Date().toISOString().split("T")[0];
}

export async function getOrCreateTodayUsage() {
  const today = todayDate();
  const existing = await db.select().from(aiUsageTable).where(eq(aiUsageTable.date, today));
  if (existing.length > 0) return existing[0];
  const [created] = await db.insert(aiUsageTable).values({ date: today }).returning();
  return created;
}

export async function getSettings() {
  const rows = await db.select().from(settingsTable);
  if (rows.length > 0) return rows[0];
  const [created] = await db.insert(settingsTable).values({}).returning();
  return created;
}

export async function checkAiLimitReached(): Promise<{ blocked: boolean; reason?: string }> {
  const settings = await getSettings();
  if (!settings.enableCostGuard) return { blocked: false };

  const usage = await getOrCreateTodayUsage();
  if (usage.callsUsed >= settings.maxAiCallsPerDay) {
    return {
      blocked: true,
      reason: `⚠️ Daily AI limit reached (${usage.callsUsed}/${settings.maxAiCallsPerDay}). Generation stopped to avoid extra costs.`,
    };
  }
  if (usage.postsGenerated >= settings.maxPostsPerDay) {
    return {
      blocked: true,
      reason: `⚠️ Daily post limit reached (${usage.postsGenerated}/${settings.maxPostsPerDay}). Generation stopped.`,
    };
  }
  return { blocked: false };
}

export async function incrementAiUsage(type: "call" | "post" | "rewrite") {
  const today = todayDate();
  await getOrCreateTodayUsage();

  if (type === "call") {
    await db.execute(`UPDATE ai_usage SET calls_used = calls_used + 1 WHERE date = '${today}'`);
  } else if (type === "post") {
    await db.execute(`UPDATE ai_usage SET posts_generated = posts_generated + 1 WHERE date = '${today}'`);
  } else if (type === "rewrite") {
    await db.execute(`UPDATE ai_usage SET rewrites_used = rewrites_used + 1 WHERE date = '${today}'`);
  }
}

// ─── Prompts ────────────────────────────────────────────────────────────────

const SOURCE_SYSTEM_PROMPT = `Ты пишешь посты для Telegram-канала TONKOFF о TON, Telegram-крипте и крипторынке.

Тебе дан текст оригинального источника.
Используй ТОЛЬКО информацию из источника. Не придумывай факты.

СТРОГИЕ ПРАВИЛА:
- Только факты, цифры, имена и даты из источника
- Не копируй дословно, перепиши своим авторским голосом
- Если информация неофициальная: добавь "пока без официального подтверждения"
- Если источник слабый или нерелевантен: ответь ровно одним словом NO_POST

Приоритет тем:
1. TON / The Open Network
2. Telegram: Gifts, Stars, Fragment, Wallet, mini apps
3. Дуров / Telegram
4. BTC, ETH, важные крипто-новости

ЗАПРЕЩЁННЫЙ СИМВОЛ: не используй тире "—" нигде в посте. Никогда.
Вместо него: запятая, двоеточие, точка, скобки или обычный дефис.

ФОРМАТЫ (выбери сам по силе темы):

MICRO (одна сильная мысль, до 250 симв):
Короткий хук.
Одно ключевое наблюдение.
Опционально: 1 строка вывода.

SHORT (250–550 симв):
Сильный хук.
[пустая строка]
Факт + контекст одним абзацем.
[пустая строка]
Короткий вывод.

MEDIUM (550–950 симв):
Сильный хук.
[пустая строка]
Что произошло.
[пустая строка]
Почему важно / контекст.
[пустая строка]
Короткий вывод.

LONG (950–1400 симв, только для действительно важных тем):
Хук.
[пустая строка]
Факт.
[пустая строка]
Контекст / анализ.
[пустая строка]
Последствия.
[пустая строка]
Итог.

По умолчанию пиши SHORT или MEDIUM. LONG только если тема очень сильная.

СТИЛЬ:
- Живой, умный, чуть ироничный
- Человеческий голос, не AI-текст
- Первая строка: зацепка, интрига или чёткий факт
- Короткие абзацы, пустая строка между ними
- Эмодзи: 0 или 1 в micro/short, 1-2 в medium, до 3 в long, только когда уместно
- Без хэштегов
- Без воды и вводных фраз

ЗАПРЕЩЕНО: "—", покупай, продавай, иксы, летим, all in, гарантированный рост, финансовые советы.

Пиши только сам пост. Не начинай с "Конечно!", "Вот пост:", "Отлично!".`;

const FREE_SYSTEM_PROMPT = `Ты пишешь посты для Telegram-канала TONKOFF о TON, Telegram-крипте и крипторынке.

Темы: TON, Telegram (Gifts, Stars, Fragment, Wallet, mini apps), Дуров, BTC, ETH, крипторынок.

ЗАПРЕЩЁННЫЙ СИМВОЛ: не используй тире "—" нигде. Никогда.
Вместо него: запятая, двоеточие, точка, скобки.

Форматы: micro (до 250 симв), short (250-550), medium (550-950), long (950-1400, только сильные темы).
По умолчанию: short или medium.

Структура: хук → пустая строка → абзацы с пустыми строками → вывод.
Стиль: живой, умный, чуть ироничный, человеческий голос.
Эмодзи: 0-2 уместных. Без хэштегов.
Запрещено: покупай, продавай, иксы, летим, all in, гарантированный рост.

Пиши только сам пост. Не начинай с "Конечно!", "Вот пост!", "Отлично!".`;

// ─── Types ───────────────────────────────────────────────────────────────────

export type PostFormat = "micro" | "short" | "medium" | "long";
export type Confidence = "high" | "medium" | "low";

const FORMAT_INSTRUCTIONS: Record<PostFormat, string> = {
  micro: "Формат: MICRO (до 250 симв). Одна сильная мысль, 1-3 строки. Без лишних слов.",
  short: "Формат: SHORT (250-550 симв). Хук + факт + контекст + короткий вывод.",
  medium: "Формат: MEDIUM (550-950 симв). Хук + факт + контекст + почему важно + вывод.",
  long: "Формат: LONG (950-1400 симв). Только если тема действительно важная и богатая деталями.",
};

function chooseFormat(topic?: string): PostFormat {
  if (!topic) return "short";
  const lower = topic.toLowerCase();
  if (lower.includes("важн") || lower.includes("major") || lower.includes("крупн")) return "medium";
  if (lower.length < 50) return "micro";
  return "short";
}

function chooseFormatFromSource(sourceText: string): PostFormat {
  const len = sourceText.length;
  if (len < 150) return "micro";
  if (len < 700) return "short";
  if (len < 1400) return "medium";
  return "medium"; // never auto-choose long — AI decides if topic is strong enough
}

// ─── Post sanitizer ──────────────────────────────────────────────────────────

/**
 * Final cleanup pass on AI-generated post content.
 * Removes em dashes, normalises whitespace, caps emoji count.
 */
export function sanitizePost(text: string): string {
  let s = text;

  // 1. Remove repeated em-dash sequences first (e.g. "——", "———")
  s = s.replace(/—{2,}/g, ".");

  // 2. Replace em dash with context-aware alternatives:
  //    "word — word"  → "word: word"  (mid-sentence explanation)
  //    "word —\n"     → "word."       (trailing dash before newline)
  //    "word—word"    → "word, word"  (no spaces, treat as comma)
  s = s.replace(/\s—\s/g, ": ");
  s = s.replace(/\s—(\n)/g, ".$1");
  s = s.replace(/—/g, ", "); // catch any remaining

  // 3. Remove hashtags
  s = s.replace(/#\w+/g, "").replace(/\s{2,}/g, " ");

  // 4. Collapse 3+ consecutive blank lines to max 1 blank line
  s = s.replace(/\n{3,}/g, "\n\n");

  // 5. Fix "colon-space" becoming ": , " or similar artefacts after dash replace
  s = s.replace(/:\s*,\s*/g, ": ");
  s = s.replace(/,\s*,/g, ",");

  // 6. Trim trailing spaces on each line
  s = s.split("\n").map(l => l.trimEnd()).join("\n");

  // 7. Cap emoji count based on post length
  const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
  const emojis = s.match(emojiRegex) ?? [];
  const len = s.length;
  const maxEmoji = len < 300 ? 1 : len < 700 ? 2 : 3;
  if (emojis.length > maxEmoji) {
    // Remove excess emojis (keep first N)
    let kept = 0;
    s = s.replace(emojiRegex, (match) => {
      kept++;
      return kept <= maxEmoji ? match : "";
    });
  }

  // 8. Final trim
  return s.trim();
}

// ─── Main generation ─────────────────────────────────────────────────────────

export async function generatePostContent(options: {
  topic?: string;
  sourceText?: string;
  sourceUrl?: string;
  sourceChannel?: string;
  additionalContext?: string;
  forceFormat?: PostFormat;
}): Promise<{ content: string; postType: PostFormat; confidence: Confidence }> {
  const limit = await checkAiLimitReached();
  if (limit.blocked) throw new Error(limit.reason);

  const settings = await getSettings();
  const client = getOpenAIClient();
  const model = process.env.OPENAI_MODEL ?? settings.openaiModel;

  const hasSource = Boolean(options.sourceText?.trim());
  const format = options.forceFormat ?? (
    hasSource
      ? chooseFormatFromSource(options.sourceText!)
      : chooseFormat(options.topic)
  );
  const formatInstruction = FORMAT_INSTRUCTIONS[format];

  let systemPrompt: string;
  let userMessage: string;

  if (hasSource) {
    systemPrompt = SOURCE_SYSTEM_PROMPT;
    userMessage = [
      `Источник: ${options.sourceChannel ?? "RSS"}`,
      options.sourceUrl ? `Ссылка на оригинал: ${options.sourceUrl}` : null,
      "",
      "Текст источника:",
      '"""',
      options.sourceText!.slice(0, 1200),
      '"""',
      "",
      formatInstruction,
      "Напиши готовый пост. Если материал не подходит — ответь только: NO_POST",
    ].filter(Boolean).join("\n");
  } else {
    systemPrompt = FREE_SYSTEM_PROMPT;
    userMessage = [
      options.topic
        ? `Тема: ${options.topic}`
        : "Напиши актуальный пост для канала о TON, Telegram-крипте и крипторынке.",
      options.sourceUrl ? `Источник: ${options.sourceUrl}` : null,
      options.additionalContext ? `Контекст: ${options.additionalContext}` : null,
      "",
      formatInstruction,
      "Напиши оригинальный Telegram-пост.",
    ].filter(Boolean).join("\n");
  }

  logger.info({ format, hasSource, channel: options.sourceChannel, model }, "Generating post");

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    max_completion_tokens: settings.maxTokensPerPost,
    temperature: hasSource ? 0.75 : 0.85,
  });

  await incrementAiUsage("call");

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  if (!raw) throw new Error("AI returned empty content");
  if (raw.trim() === "NO_POST") {
    throw new Error("NO_POST");
  }

  const content = sanitizePost(raw);
  const confidence: Confidence = hasSource ? "high" : "low";
  return { content, postType: format, confidence };
}
