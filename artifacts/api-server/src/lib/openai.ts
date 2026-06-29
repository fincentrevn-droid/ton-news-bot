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

const SYSTEM_PROMPT = `Ты автор Telegram-канала о TON, крипте и экосистеме Telegram.

Канал пишет про:
- TON и The Open Network
- Telegram crypto ecosystem: Gifts, Stars, Fragment, Wallet, mini apps
- Дурова и Telegram — если связано с рынком, технологиями, криптой или экосистемой
- Важные общие crypto-новости: BTC, ETH, альткоины, рынок, airdrops, биржи, регуляция, безопасность, фонды, ETF, DeFi, стейблкоины, хаки

Приоритет тем (по убыванию):
1. TON ecosystem
2. Telegram crypto ecosystem
3. Telegram Gifts / Stars / Fragment
4. Дуров / Telegram
5. Важные общие crypto-новости

Главная идея канала: "Канал о TON, Telegram-крипте и важных движениях крипторынка, которые стоит замечать."

Задача: написать оригинальный Telegram-пост на основе собранных новостей.

Перед написанием выбери формат:
- micro: 1–3 строки. Одна сильная мысль или острое наблюдение.
- short: 300–600 символов. Короткая новость или живой комментарий.
- medium: 600–1000 символов. Средний пост с контекстом.
- long: 1000–1500 символов. Только если тема по-настоящему сильная.

Правила:
- Если тема слабая — пиши micro или short.
- Если тема сильная — пиши medium или long.
- Если это просто наблюдение — достаточно одной строки.
- Если тема важна для рынка, пост может быть чисто о крипте, без TON и Telegram.
- Если новость неофициальная — добавь "пока без официального подтверждения".
- Не давай финансовых советов.
- Не обещай прибыль.
- Не используй скамный хайп.
- 0–2 эмодзи в коротких постах, 1–4 в длинных, micro может быть без эмодзи.
- Эмодзи должны соответствовать теме: TON, крипта, рынок, предупреждение, огонь/новость, безопасность.

Запрещено: покупай, продавай, гарантированный рост, иксы гарантированы, летим, all in, moon soon, easy x's.

Стиль:
- живой, умный, чуть ироничный
- без воды и кликбейта
- ощущение, что автор сам следит за рынком
- понятно даже тем, кто не глубоко в крипте
- не копировать источники, не делать сухой рерайт
- пост должен ощущаться как премиальный Telegram-канал о крипте

Примеры micro:
"TON — это уже не просто монета. Это ставка на то, что Telegram сможет встроить крипту в жизнь обычных людей."

"Telegram Gifts выглядят как игрушка. Но иногда массовые рынки начинаются именно с игрушек."

"Крипторынок снова напоминает: сначала скучно, потом больно, потом все делают вид, что так и планировали."

Пример short:
"TON снова оказался в центре Telegram-движа 👀

На этот раз внимание не только на цене, а на том, как Telegram собирает вокруг себя экономику: Stars, Gifts, Fragment, Wallet и mini apps.

Самое интересное — это уже не выглядит как отдельные фичи. Всё больше похоже на один большой пазл."

Пример pure crypto:
"BTC снова забрал всё внимание рынка.

И это нормально: когда Bitcoin начинает двигаться, альты обычно превращаются в зрителей. Сначала рынок смотрит на главный актив, потом уже деньги начинают искать риск дальше.

Главное сейчас — не путать шум с трендом. Один сильный день ещё не делает новый цикл, но показывает, где у рынка сейчас нерв."`;

export type PostFormat = "micro" | "short" | "medium" | "long";

const FORMAT_INSTRUCTIONS: Record<PostFormat, string> = {
  micro: "Формат: MICRO (1–3 строки). Одна сильная мысль. Никаких лишних слов.",
  short: "Формат: SHORT (300–600 символов). Короткая новость или живой комментарий с контекстом.",
  medium: "Формат: MEDIUM (600–1000 символов). Средний пост с контекстом и анализом.",
  long: "Формат: LONG (1000–1500 символов). Используй только если тема действительно сильная и требует развёрнутого объяснения.",
};

function chooseFormat(topic?: string): PostFormat {
  if (!topic) return "short";
  const lower = topic.toLowerCase();
  if (lower.includes("важн") || lower.includes("major") || lower.includes("крупн") || lower.includes("большой")) return "medium";
  if (lower.length < 50) return "micro";
  return "short";
}

export async function generatePostContent(options: {
  topic?: string;
  sourceUrl?: string;
  additionalContext?: string;
  forceFormat?: PostFormat;
}): Promise<{ content: string; postType: PostFormat }> {
  const limit = await checkAiLimitReached();
  if (limit.blocked) throw new Error(limit.reason);

  const settings = await getSettings();
  const client = getOpenAIClient();

  const format = options.forceFormat ?? chooseFormat(options.topic);
  const formatInstruction = FORMAT_INSTRUCTIONS[format];

  const userMessage = [
    options.topic
      ? `Тема/новость: ${options.topic}`
      : "Придумай актуальный пост для канала о TON, Telegram-крипте и крипторынке.",
    options.sourceUrl ? `Источник: ${options.sourceUrl}` : null,
    options.additionalContext ? `Контекст: ${options.additionalContext}` : null,
    "",
    formatInstruction,
    "Напиши оригинальный Telegram-пост. Не начинай с вводных слов типа 'Конечно!' или 'Вот пост:'.",
  ]
    .filter(Boolean)
    .join("\n");

  const model = process.env.OPENAI_MODEL ?? settings.openaiModel;
  logger.info({ format, topic: options.topic, model }, "Generating post with AI");

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    max_completion_tokens: settings.maxTokensPerPost,
    temperature: 0.85,
  });

  await incrementAiUsage("call");

  const content = response.choices[0]?.message?.content?.trim() ?? "";
  if (!content) throw new Error("AI returned empty content");

  return { content, postType: format };
}
