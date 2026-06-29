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

const SOURCE_SYSTEM_PROMPT = `Ты редактор Telegram-канала о TON, крипте и экосистеме Telegram.

Тебе дан оригинальный текст новости из источника.
Твоя задача — написать готовый, опубликуемый Telegram-пост на основе ТОЛЬКО предоставленного текста.

СТРОГИЕ ПРАВИЛА:
- Используй ТОЛЬКО факты, цифры, имена и даты из текста источника.
- НЕ придумывай факты которых нет в источнике.
- НЕ добавляй цены, даты, события, имена если их нет в тексте.
- НЕ копируй текст дословно — перепиши своими словами с авторским взглядом.
- Если информация неофициальная или предварительная — добавь: пока без официального подтверждения.
- Если источник слабый, скучный или нерелевантен аудитории — ответь ровно словом: NO_POST

Приоритет тем (по убыванию):
1. TON / The Open Network
2. Telegram: Gifts, Stars, Fragment, Wallet, mini apps
3. Durov / Telegram
4. BTC, ETH, важные крипто-новости

ОБЯЗАТЕЛЬНАЯ СТРУКТУРА ПОСТА:
Пиши готовый Telegram-пост. Никаких преамбул, заголовков, маркировок.
Используй пустую строку между абзацами.

Структура (по формату):

Для MICRO (одна сильная мысль, < 300 симв):
  Строка-хук → 1 абзац с фактом → опционально: 1 короткий вывод

Для SHORT (300–600 симв):
  Строка-хук
  [пустая строка]
  1 абзац: ключевой факт + контекст
  [пустая строка]
  1 строка: вывод или что это значит

Для MEDIUM (600–1000 симв):
  Строка-хук
  [пустая строка]
  Абзац: что произошло (факт)
  [пустая строка]
  Абзац: почему это важно / контекст
  [пустая строка]
  1–2 строки: вывод

Для LONG (1000–1500 симв, только для важных тем):
  Строка-хук
  [пустая строка]
  Абзац: факт
  [пустая строка]
  Абзац: контекст / анализ
  [пустая строка]
  Абзац: последствия / что дальше
  [пустая строка]
  Итог

СТИЛЬ:
- Живой, умный, чуть ироничный, как у премиального крипто-канала
- Не водянистый, не кликбейтный, не академичный
- Первая строка — зацепка, интрига или чёткий факт
- Эмодзи: 1–2 уместных, строго по теме, без спама
- Без hashtags
- Без воды, без лишних вводных слов

ЗАПРЕЩЕНО: покупай, продавай, иксы, летим, all in, moon soon, гарантированный рост, финансовые советы.

ВЫВОД: пиши только сам пост. Не начинай со слов "Конечно!", "Вот пост:", "Пост:", "Отлично!".`;

const FREE_SYSTEM_PROMPT = `Ты автор Telegram-канала о TON, крипте и экосистеме Telegram.

Канал пишет про:
- TON и The Open Network
- Telegram crypto ecosystem: Gifts, Stars, Fragment, Wallet, mini apps
- Дурова и Telegram — если связано с рынком, технологиями, криптой
- Важные общие крипто-новости: BTC, ETH, рынок, DeFi, стейблкоины

СТРУКТУРА ПОСТА:
Строка-хук → пустая строка → 1–2 абзаца → пустая строка → вывод

Форматы:
- micro: < 300 симв, одна сильная мысль
- short: 300–600 симв
- medium: 600–1000 симв
- long: 1000–1500 симв (только для очень сильных тем)

Стиль: живой, умный, чуть ироничный, без воды и кликбейта.
Эмодзи: 1–2 уместных. Без hashtags.
Запрещено: покупай, продавай, гарантированный рост, иксы, летим, all in.

Пиши только сам пост. Не начинай со слов "Конечно!", "Вот пост:", "Отлично!".`;

// ─── Types ───────────────────────────────────────────────────────────────────

export type PostFormat = "micro" | "short" | "medium" | "long";
export type Confidence = "high" | "medium" | "low";

const FORMAT_INSTRUCTIONS: Record<PostFormat, string> = {
  micro: "Формат: MICRO. Одна сильная мысль, максимум 3 строки. Никаких лишних слов.",
  short: "Формат: SHORT (300–600 симв). Хук + факт + контекст + короткий вывод.",
  medium: "Формат: MEDIUM (600–1000 симв). Хук + факт + контекст + последствия + вывод.",
  long: "Формат: LONG (1000–1500 симв). Только если тема действительно важная и богатая деталями.",
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
  if (len < 200) return "micro";
  if (len < 600) return "short";
  return "medium";
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

  const content = response.choices[0]?.message?.content?.trim() ?? "";
  if (!content) throw new Error("AI returned empty content");
  if (content.trim() === "NO_POST") {
    throw new Error("NO_POST");
  }

  const confidence: Confidence = hasSource ? "high" : "low";
  return { content, postType: format, confidence };
}
