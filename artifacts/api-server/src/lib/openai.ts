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

const SOURCE_SYSTEM_PROMPT = `Ты автор Telegram-канала TONKOFF о TON, Telegram-крипте и крипторынке.

Тебе дан текст источника. Это сырой материал. Используй только факты из него.

ГЛАВНОЕ ПРАВИЛО: пиши как автор канала, а не как пересказчик.
Читатель должен чувствовать, что TONKOFF сам рассказывает историю.

КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО в тексте поста:
- "в источнике пишут" / "источник сообщает" / "там сказано"
- "по данным источника" / "рядом упоминается" / "согласно посту"
- "source" / "confidence" / "ссылка" / "Черновик"
- метки формата: [SHORT] [MEDIUM] [MICRO] [LONG]
- любые слова, которые раскрывают что ты пересказываешь чужой текст

ЗАПРЕЩЁННЫЙ СИМВОЛ: не используй тире "—" нигде. Никогда.
Вместо него: запятая, двоеточие, точка, скобки или обычный дефис (-).

Если источник слабый или нерелевантен: верни NO_POST в поле public_post_text.
Если информация неофициальная: добавь "пока без официального подтверждения".

Приоритет тем:
1. TON / The Open Network
2. Telegram: Gifts, Stars, Fragment, Wallet, mini apps
3. Дуров / Telegram
4. BTC, ETH, важные крипто-новости

ФОРМАТЫ (выбери сам по силе темы):

micro (до 250 симв): хук + одно наблюдение + короткий вывод (1-3 строки).
short (250-550 симв): хук / пустая строка / факт+контекст / пустая строка / вывод.
medium (550-950 симв): хук / пустая строка / что случилось / пустая строка / почему важно / пустая строка / вывод.
long (950-1400 симв, только для сильных тем): хук / факт / контекст / последствия / итог.

По умолчанию: short или medium. Long только если тема очень сильная.

СТИЛЬ:
- Живой, умный, чуть ироничный
- Человеческий голос, не AI-шаблон
- Первая строка: зацепка или чёткий факт
- Короткие абзацы, пустые строки между ними
- Короткие предложения. Если одно предложение несёт слишком много идей, раздели его.
- Эмодзи: 0-1 в micro/short, 0-2 в medium, 0-3 в long (только когда уместно)
- Без хэштегов

ЗАПРЕЩЕНО: "—", покупай, продавай, иксы, летим, all in, гарантированный рост, финансовые советы.

ФОРМАТ ОТВЕТА: верни JSON и ТОЛЬКО JSON без преамбул:
{
  "public_post_text": "готовый текст поста",
  "post_format": "micro|short|medium|long",
  "confidence": "high|medium|low",
  "source_used": true
}`;

const FREE_SYSTEM_PROMPT = `Ты автор Telegram-канала TONKOFF о TON, Telegram-крипте и крипторынке.

Темы: TON, Telegram (Gifts, Stars, Fragment, Wallet, mini apps), Дуров, BTC, ETH, крипторынок.

ЗАПРЕЩЁННЫЙ СИМВОЛ: не используй тире "—" нигде. Никогда.
ЗАПРЕЩЕНО в тексте: источник, "в источнике", "[SHORT]", "Черновик" и любые метаданные.

Форматы: micro (до 250 симв), short (250-550), medium (550-950), long (950-1400, только сильные темы).
По умолчанию: short или medium.

Структура: хук / пустая строка / абзацы / пустая строка / вывод.
Стиль: живой, умный, чуть ироничный, человеческий голос, короткие предложения.
Эмодзи: 0-2 уместных. Без хэштегов.
Запрещено: покупай, продавай, иксы, летим, all in, гарантированный рост.

ФОРМАТ ОТВЕТА: верни JSON и ТОЛЬКО JSON:
{
  "public_post_text": "готовый текст поста",
  "post_format": "micro|short|medium|long",
  "confidence": "high|medium|low",
  "source_used": false
}`;

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

// Phrases that must never appear in the public post — source-reporter language
const FORBIDDEN_PHRASES = [
  /в источнике пиш[а-яё]+/gi,
  /источник сообщ[а-яё]+/gi,
  /там( же)? (сказано|написано|отмеча[а-яё]+|упомина[а-яё]+)/gi,
  /по данным источника/gi,
  /согласно (посту|источнику)/gi,
  /рядом упомина[а-яё]+/gi,
  /📡\s*(<b>)?Источник(<\/b>)?:?[^\n]*/gi,
  /Черновик\s*#?\d*/gi,
  /\[(SHORT|MEDIUM|MICRO|LONG)\]/gi,
  /^(Конечно!?|Вот пост:?|Отлично!?|Пост:)\s*/gi,
];

/**
 * Final cleanup pass on AI-generated post content.
 * Removes em dashes, source-reporter phrases, format labels, normalises whitespace, caps emoji count.
 */
export function sanitizePost(text: string): string {
  let s = text;

  // 0. Strip leaked admin/metadata phrases
  for (const re of FORBIDDEN_PHRASES) {
    s = s.replace(re, "");
  }

  // 1. Remove repeated em-dash sequences (e.g. "——", "———")
  s = s.replace(/—{2,}/g, ".");

  // 2. Replace em dash with context-aware alternatives:
  //    "word — word"  → "word: word"
  //    "word —\n"     → "word.\n"
  //    bare "—"       → ", "
  s = s.replace(/\s—\s/g, ": ");
  s = s.replace(/\s—(\n)/g, ".$1");
  s = s.replace(/—/g, ", ");

  // 3. Remove hashtags
  s = s.replace(/#\w+/g, "");

  // 4. Collapse 3+ consecutive blank lines to max 1 blank line
  s = s.replace(/\n{3,}/g, "\n\n");

  // 5. Fix punctuation artefacts left by dash replace
  s = s.replace(/:\s*,\s*/g, ": ");
  s = s.replace(/,\s*,/g, ",");
  s = s.replace(/\s{2,}/g, " ");

  // 6. Trim trailing spaces on each line
  s = s.split("\n").map(l => l.trimEnd()).join("\n");

  // 7. Cap emoji count based on post length
  const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
  const len = s.length;
  const maxEmoji = len < 300 ? 1 : len < 700 ? 2 : 3;
  const emojis = s.match(emojiRegex) ?? [];
  if (emojis.length > maxEmoji) {
    let kept = 0;
    s = s.replace(emojiRegex, (match) => {
      kept++;
      return kept <= maxEmoji ? match : "";
    });
  }

  return s.trim();
}

// ─── JSON response parser ─────────────────────────────────────────────────────

interface AiJsonResponse {
  public_post_text: string;
  post_format?: string;
  confidence?: string;
  source_used?: boolean;
}

/**
 * Try to parse AI response as JSON. Falls back gracefully if AI returned plain text.
 */
function parseAiResponse(raw: string): AiJsonResponse | null {
  // Try direct parse
  try {
    const parsed = JSON.parse(raw) as AiJsonResponse;
    if (typeof parsed?.public_post_text === "string") return parsed;
  } catch {
    // ignore
  }
  // Try to extract JSON block from response (AI sometimes adds preamble)
  const jsonMatch = raw.match(/\{[\s\S]*"public_post_text"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as AiJsonResponse;
      if (typeof parsed?.public_post_text === "string") return parsed;
    } catch {
      // ignore
    }
  }
  return null;
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
      options.sourceUrl ? `Ссылка: ${options.sourceUrl}` : null,
      "",
      "Текст источника:",
      '"""',
      options.sourceText!.slice(0, 1200),
      '"""',
      "",
      `Рекомендуемый формат: ${format} (но выбирай сам по силе темы).`,
      "Верни JSON. Если материал не подходит: {\"public_post_text\": \"NO_POST\", \"post_format\": \"short\", \"confidence\": \"low\", \"source_used\": false}",
    ].filter(Boolean).join("\n");
  } else {
    systemPrompt = FREE_SYSTEM_PROMPT;
    userMessage = [
      options.topic
        ? `Тема: ${options.topic}`
        : "Напиши актуальный пост для канала о TON, Telegram-крипте и крипторынке.",
      options.sourceUrl ? `Ссылка: ${options.sourceUrl}` : null,
      options.additionalContext ? `Контекст: ${options.additionalContext}` : null,
      "",
      `Рекомендуемый формат: ${format}.`,
      "Верни JSON.",
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
    temperature: hasSource ? 0.72 : 0.85,
  });

  await incrementAiUsage("call");

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  if (!raw) throw new Error("AI returned empty content");

  // Try to parse JSON response; fall back to treating raw text as post content
  const parsed = parseAiResponse(raw);
  const publicText = parsed?.public_post_text ?? raw;

  if (publicText.trim() === "NO_POST") {
    throw new Error("NO_POST");
  }

  // Resolve format and confidence: prefer what AI chose over our hint
  const VALID_FORMATS: PostFormat[] = ["micro", "short", "medium", "long"];
  const VALID_CONFIDENCES: Confidence[] = ["high", "medium", "low"];
  const aiFormat = parsed?.post_format as PostFormat | undefined;
  const aiConfidence = parsed?.confidence as Confidence | undefined;
  const resolvedFormat: PostFormat = (aiFormat && VALID_FORMATS.includes(aiFormat)) ? aiFormat : format;
  const resolvedConfidence: Confidence = (aiConfidence && VALID_CONFIDENCES.includes(aiConfidence))
    ? aiConfidence
    : (hasSource ? "high" : "low");

  const content = sanitizePost(publicText);
  if (!content) throw new Error("AI returned empty content after sanitization");

  logger.info({ resolvedFormat, resolvedConfidence, len: content.length, wasJson: Boolean(parsed) }, "Post generated");
  return { content, postType: resolvedFormat, confidence: resolvedConfidence };
}
