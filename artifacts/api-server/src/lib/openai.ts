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

Тебе дан оригинальный текст новости из внешнего источника.
Твоя задача — написать пост для нашего канала на основе ТОЛЬКО предоставленного текста.

СТРОГИЕ ПРАВИЛА:
- Используй ТОЛЬКО факты, цифры, имена и даты из текста источника.
- НЕ придумывай факты которых нет в источнике.
- НЕ добавляй цены, даты, события, партнёрства, запуски если их нет в исходном тексте.
- НЕ копируй текст дословно — перепиши своими словами с авторским комментарием.
- Если информация неофициальная или предварительная — добавь "пока без официального подтверждения".
- Если источник слабый или неинтересен нашей аудитории — ответь ровно словом: NO_POST

Приоритет тем (по убыванию):
1. TON / The Open Network
2. Telegram crypto ecosystem: Gifts, Stars, Fragment, Wallet, mini apps
3. Durov / Telegram
4. BTC, ETH, важные crypto-новости

Форматы:
- micro: 1–3 строки, одна сильная мысль
- short: 300–600 символов, короткая новость с контекстом
- medium: 600–1000 символов, пост с контекстом и анализом
- long: 1000–1500 символов, только для по-настоящему важных тем

Стиль: живой, умный, чуть ироничный, без воды и кликбейта, как у премиального Telegram-канала.
Запрещено: покупай, продавай, гарантированный рост, иксы, летим, all in, moon soon.
Эмодзи: 0–2 в коротких, 1–4 в длинных. Только по теме.

Не начинай ответ со слов "Конечно!", "Вот пост:", "Отлично!".`;

const FREE_SYSTEM_PROMPT = `Ты автор Telegram-канала о TON, крипте и экосистеме Telegram.

Канал пишет про:
- TON и The Open Network
- Telegram crypto ecosystem: Gifts, Stars, Fragment, Wallet, mini apps
- Дурова и Telegram — если связано с рынком, технологиями, криптой
- Важные общие crypto-новости: BTC, ETH, рынок, DeFi, стейблкоины

Форматы:
- micro: 1–3 строки, одна сильная мысль
- short: 300–600 символов
- medium: 600–1000 символов
- long: 1000–1500 символов (только для очень сильных тем)

Стиль: живой, умный, чуть ироничный, без воды и кликбейта.
Запрещено: покупай, продавай, гарантированный рост, иксы, летим, all in.
Эмодзи: 0–2 в коротких, 1–4 в длинных.

Не начинай со слов "Конечно!", "Вот пост:", "Отлично!".`;

// ─── Types ───────────────────────────────────────────────────────────────────

export type PostFormat = "micro" | "short" | "medium" | "long";
export type Confidence = "high" | "medium" | "low";

const FORMAT_INSTRUCTIONS: Record<PostFormat, string> = {
  micro: "Формат: MICRO (1–3 строки). Одна сильная мысль. Никаких лишних слов.",
  short: "Формат: SHORT (300–600 символов). Короткая новость или живой комментарий с контекстом.",
  medium: "Формат: MEDIUM (600–1000 символов). Средний пост с контекстом и анализом.",
  long: "Формат: LONG (1000–1500 символов). Используй только если тема действительно сильная.",
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
      "Напиши пост для нашего канала. Если материал не подходит — ответь: NO_POST",
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
