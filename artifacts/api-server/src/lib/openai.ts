import OpenAI from "openai";
import { logger } from "./logger";
import { db } from "@workspace/db";
import { aiUsageTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { isCryptoProfile } from "./channel-profile";

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
  // Atomic upsert: safe under concurrent requests (avoids SELECT→INSERT race)
  await db.insert(aiUsageTable).values({ date: today }).onConflictDoNothing();
  const [row] = await db.select().from(aiUsageTable).where(eq(aiUsageTable.date, today));
  return row;
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

Тебе дан текст источника. Используй только факты из него.

ГЛАВНОЕ ПРАВИЛО: пиши как автор канала, не как пересказчик новостей.
Читатель должен чувствовать, что TONKOFF сам рассказывает историю.

КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО в тексте:
- "в источнике пишут" / "источник сообщает" / "там сказано" / "по данным источника"
- "source" / "confidence" / "Черновик" / "[SHORT]" / "[MEDIUM]" / "[MICRO]" / "[LONG]"
- любые слова, раскрывающие что ты пересказываешь чужой текст
- символ "—" (длинное тире). Вместо него: запятая, двоеточие, точка, скобки или "-".

Если источник слабый/нерелевантен: верни "NO_POST" в поле headline.
Если информация неофициальная: добавь "пока без официального подтверждения" в один из абзацев.

Приоритет тем: TON, Telegram (Gifts/Stars/Fragment/Wallet/mini apps), Дуров, BTC/ETH/крипторынок.

СТИЛЬ:
- Живой, умный, чуть ироничный. Человеческий голос, не AI-шаблон.
- Первая строка: зацепка или чёткий факт.
- Короткие предложения. Каждое несёт одну идею.
- Эмодзи: 0-1 в micro/short, 0-2 в medium, 0-3 в long. Только когда уместно.
- Без хэштегов.
ЗАПРЕЩЕНО: покупай, продавай, иксы, летим, all in, гарантированный рост, финансовые советы.

ФОРМАТ (выбери по силе темы): micro/short/medium/long.
По умолчанию: short или medium. Long только для важных тем с богатыми деталями.

ФОРМАТ ОТВЕТА: верни ТОЛЬКО JSON без преамбул.
Для micro: headline + takeaway (paragraphs может быть пустым).
Для short/medium/long: headline + 1-3 коротких абзаца + takeaway.

{
  "headline": "одна сильная первая строка",
  "paragraphs": ["абзац с главным фактом", "абзац с контекстом или выводом"],
  "takeaway": "короткая финальная мысль (или пустая строка для micro)",
  "post_format": "micro|short|medium|long",
  "confidence": "high|medium|low",
  "source_used": true
}`;

const FREE_SYSTEM_PROMPT = `Ты автор Telegram-канала TONKOFF о TON, Telegram-крипте и крипторынке.

Темы: TON, Telegram (Gifts, Stars, Fragment, Wallet, mini apps), Дуров, BTC, ETH, крипторынок.

ЗАПРЕЩЕНО в тексте: "—", источник, "[SHORT]", "Черновик", метаданные.
ЗАПРЕЩЕНО: покупай, продавай, иксы, летим, all in, гарантированный рост.

Пиши живо, умно, с человеческим голосом. Короткие предложения. Эмодзи: 0-2. Без хэштегов.
По умолчанию: short или medium.

ФОРМАТ ОТВЕТА: верни ТОЛЬКО JSON:
{
  "headline": "одна сильная первая строка",
  "paragraphs": ["абзац 1", "абзац 2"],
  "takeaway": "короткий вывод",
  "post_format": "micro|short|medium|long",
  "confidence": "high|medium|low",
  "source_used": false
}`;

const PANKOFF_CRYPTO_SOURCE_SYSTEM_PROMPT = `Ты автор Telegram-канала PANKOFF CRYPTO. Канал публикует только важные, достоверные и актуальные новости крипторынка и интересные проверяемые истории.

Тебе дан один источник. Используй ТОЛЬКО подтверждённые факты из него. Ничего не достраивай, не объясняй причины и последствия от себя.

ОТБОР:
- Подходит только значимый новый факт: BTC, ETH, крупные альткоины, стейблкоины, биржи, ETF, регулирование, безопасность, крупные взломы, инфраструктура, крупные сделки, заметные on-chain события, TON, Telegram или необычная проверяемая история.
- Реклама, партнёрские посты, рефералки, промокоды, казино, конкурсы, курсы, платные сервисы, affiliate/ambassador-посты, self-promo, «подписывайтесь», «регистрируйтесь», claim, connect wallet и подобные CTA не подходят.
- Торговые сигналы, прогнозы цены, мнение автора, призывы купить, продать, шортить, лонговать, использовать плечо, участвовать в сейле или вложить деньги не являются новостью.
- Если рекламный материал содержит отдельный важный факт, используй только этот факт, полностью отбросив рекламу. Если его нельзя безопасно отделить, верни NO_POST.
- Слухи, неподтверждённые инсайды, кликбейт и перепечатки без нового факта: NO_POST.

СТИЛЬ:
- Русский язык, дружелюбный, живой, уверенный Telegram-тон.
- Обычно 2 коротких абзаца, допустимо 1-3. Главный факт сразу в первом предложении. Второй абзац только для полезного контекста.
- Основной текст ориентировочно 180-500 символов, жёсткий максимум 600.
- 0-1 обычный эмодзи, только если уместно.
- Не повторяй один факт в headline и тексте. Без аналитики, финансовых рекомендаций, хештегов, ссылок, Telegram handles, названий других каналов, подписи источника и символа "—".
- Нельзя писать «в источнике пишут», «по данным источника», «источник сообщает» и похожие репортёрские формулировки.

Верни ТОЛЬКО JSON без преамбулы:
{
  "headline": "главный факт, без повтора в абзацах",
  "paragraphs": ["короткое раскрытие факта", "необязательный полезный контекст"],
  "takeaway": "",
  "post_format": "short",
  "confidence": "high|medium|low",
  "source_used": true
}

Если материал не подходит, верни {"headline":"NO_POST","paragraphs":[],"takeaway":"","post_format":"short","confidence":"low","source_used":false}.`;

const PANKOFF_CRYPTO_QUALITY_CHECK_SYSTEM_PROMPT = `Ты строгий редактор Telegram-канала PANKOFF CRYPTO. Проверь готовый основной текст поста по оригинальному источнику перед автопубликацией.

Автопубликация запрещена, если есть хотя бы одно из условий:
1. Не все факты, цифры, даты, имена или причинно-следственные связи подтверждены источником.
2. Источник или текст содержит рекламу, рефералку, промокод, казино, конкурс, курс, платный сервис, affiliate/ambassador, self-promo, CTA, ссылку, Telegram handle, claim или connect wallet.
3. Есть торговый сигнал, финансовый совет, прогноз цены, призыв купить/продать/лонговать/шортить/использовать плечо/участвовать в сейле или вкладывать деньги.
4. Новость старая, повторяет уже известный факт, является слухом, неподтверждённым инсайдом, мнением автора или кликбейтом.
5. Текст длиннее 600 символов, содержит больше трёх абзацев, больше одного обычного эмодзи, звучит как пресс-релиз или сухая сводка.
6. Главный факт не начинается в первом предложении, есть выдуманная аналитика, повтор headline в тексте, «—», хештеги, подпись источника, ссылки или репортёрские формулировки.

Требование для оценки 85+: короткая, дружеская, точная новость по свежему достоверному источнику. Если есть сомнение, safe_for_autopublish должен быть false.

Верни ТОЛЬКО JSON без преамбул:
{
  "quality_score": 0-100,
  "passed": true/false,
  "issues": ["список проблем, если есть"],
  "needs_rewrite": true/false,
  "rewrite_instruction": "краткая инструкция что исправить (или пустая строка)",
  "safe_for_autopublish": true/false
}`;

function sourceSystemPrompt(): string {
  return isCryptoProfile() ? PANKOFF_CRYPTO_SOURCE_SYSTEM_PROMPT : SOURCE_SYSTEM_PROMPT;
}

function qualityCheckSystemPrompt(): string {
  return isCryptoProfile() ? PANKOFF_CRYPTO_QUALITY_CHECK_SYSTEM_PROMPT : QUALITY_CHECK_SYSTEM_PROMPT;
}

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
  // Collapse multiple SPACES only (NOT newlines — those are paragraph breaks)
  s = s.replace(/ {2,}/g, " ");

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

function sanitizeCryptoPost(text: string): string {
  const sanitised = sanitizePost(text);
  const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
  let seen = 0;
  return sanitised.replace(emojiRegex, (emoji) => {
    seen++;
    return seen <= 1 ? emoji : "";
  }).trim();
}

// ─── JSON response parser + assembler ────────────────────────────────────────

interface AiJsonResponse {
  headline?: string;
  paragraphs?: string[];
  takeaway?: string;
  // Backward-compat flat field (AI sometimes still returns this)
  public_post_text?: string;
  post_format?: string;
  confidence?: string;
  source_used?: boolean;
}

/**
 * Try to parse AI JSON response. Extracts JSON block even if AI adds preamble.
 * Falls back to null so caller can treat raw text as a plain-text response.
 */
function parseAiResponse(raw: string): AiJsonResponse | null {
  const tryParse = (s: string): AiJsonResponse | null => {
    try {
      const obj = JSON.parse(s) as AiJsonResponse;
      if (obj && typeof obj === "object" && (obj.headline !== undefined || obj.public_post_text !== undefined)) {
        return obj;
      }
    } catch { /* ignore */ }
    return null;
  };

  const direct = tryParse(raw);
  if (direct) return direct;

  // Try to extract JSON block (handles preamble/postamble from AI)
  const match = raw.match(/\{[\s\S]*?"(?:headline|public_post_text)"[\s\S]*?\}/);
  if (match) return tryParse(match[0]);

  return null;
}

/**
 * Assemble the public post text from structured AI JSON.
 * Guarantees paragraph breaks between sections.
 */
function assemblePost(parsed: AiJsonResponse): string {
  // Structured format: headline + paragraphs[] + takeaway
  if (parsed.headline !== undefined || parsed.paragraphs !== undefined) {
    const parts: string[] = [];
    if (parsed.headline?.trim()) parts.push(parsed.headline.trim());
    if (Array.isArray(parsed.paragraphs)) {
      for (const p of parsed.paragraphs) {
        const t = p?.trim();
        if (t) parts.push(t);
      }
    }
    if (parsed.takeaway?.trim()) parts.push(parsed.takeaway.trim());
    if (parts.length > 0) return parts.join("\n\n");
  }
  // Flat fallback
  return parsed.public_post_text?.trim() ?? "";
}

/**
 * Validate that a non-micro post has paragraph breaks.
 * If it's a wall of text, split it into paragraphs at sentence boundaries.
 */
function validateAndReformat(text: string, format: PostFormat): string {
  if (format === "micro") return text;
  const breakCount = (text.match(/\n\n/g) ?? []).length;
  if (breakCount >= 1) return text; // Already has structure

  // Wall-of-text: split into paragraphs at sentence boundaries
  // Split after ". ", "! ", "? " — keep the separator
  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length <= 1) return text; // Can't split — leave as-is

  // Group into 2-3 meaningful blocks
  const total = sentences.length;
  const blockSize = Math.max(1, Math.ceil(total / 3));
  const blocks: string[] = [];
  for (let i = 0; i < total; i += blockSize) {
    const block = sentences.slice(i, i + blockSize).join(" ").trim();
    if (block) blocks.push(block);
  }
  const result = blocks.join("\n\n");
  logger.warn({ original: text.length, blocks: blocks.length }, "Wall-of-text post reformatted");
  return result;
}

// ─── Main generation ─────────────────────────────────────────────────────────

export async function generatePostContent(options: {
  topic?: string;
  sourceText?: string;
  sourceUrl?: string;
  sourceChannel?: string;
  sourceDate?: Date;
  additionalContext?: string;
  forceFormat?: PostFormat;
}): Promise<{ content: string; postType: PostFormat; confidence: Confidence }> {
  const limit = await checkAiLimitReached();
  if (limit.blocked) throw new Error(limit.reason);

  const settings = await getSettings();
  const client = getOpenAIClient();
  const model = process.env.OPENAI_MODEL ?? settings.openaiModel;

  const hasSource = Boolean(options.sourceText?.trim());
  if (isCryptoProfile() && !hasSource) {
    throw new Error("NO_POST");
  }

  const format = isCryptoProfile()
    ? "short"
    : options.forceFormat ?? (
    hasSource
      ? chooseFormatFromSource(options.sourceText!)
      : chooseFormat(options.topic)
    );
  const formatInstruction = FORMAT_INSTRUCTIONS[format];

  let systemPrompt: string;
  let userMessage: string;

  if (hasSource) {
    systemPrompt = sourceSystemPrompt();
    userMessage = [
      `Источник: ${options.sourceChannel ?? "RSS"}`,
      options.sourceUrl ? `Ссылка: ${options.sourceUrl}` : null,
      isCryptoProfile() && options.sourceDate
        ? `Опубликовано источником: ${options.sourceDate.toISOString()}`
        : null,
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

  // Parse JSON response from AI
  const parsed = parseAiResponse(raw);

  // Check for NO_POST signal
  const noPostSignal =
    parsed?.headline?.trim() === "NO_POST" ||
    parsed?.public_post_text?.trim() === "NO_POST" ||
    (!parsed && raw.trim() === "NO_POST");
  if (noPostSignal) throw new Error("NO_POST");

  // Resolve format and confidence: prefer what AI chose over our hint
  const VALID_FORMATS: PostFormat[] = ["micro", "short", "medium", "long"];
  const VALID_CONFIDENCES: Confidence[] = ["high", "medium", "low"];
  const aiFormat = parsed?.post_format as PostFormat | undefined;
  const aiConfidence = parsed?.confidence as Confidence | undefined;
  const resolvedFormat: PostFormat = (aiFormat && VALID_FORMATS.includes(aiFormat)) ? aiFormat : format;
  const resolvedConfidence: Confidence = (aiConfidence && VALID_CONFIDENCES.includes(aiConfidence))
    ? aiConfidence
    : (hasSource ? "high" : "low");

  // Assemble text from structured JSON (headline + paragraphs[] + takeaway)
  // Falls back to flat public_post_text or raw response if JSON parsing failed
  let assembled: string;
  if (parsed) {
    assembled = assemblePost(parsed);
    if (!assembled && raw.length > 0) assembled = raw;
  } else {
    assembled = raw;
  }

  // Sanitise (fixes dashes, hashtags, emoji cap, collapses multiple spaces — NOT newlines)
  const sanitised = isCryptoProfile() ? sanitizeCryptoPost(assembled) : sanitizePost(assembled);
  if (!sanitised) throw new Error("AI returned empty content after sanitization");

  // Validate paragraph structure; auto-reformat wall-of-text posts
  const content = validateAndReformat(sanitised, resolvedFormat);

  logger.info(
    { resolvedFormat, resolvedConfidence, len: content.length, breaks: (content.match(/\n\n/g) ?? []).length, wasJson: Boolean(parsed) },
    "Post generated"
  );
  return { content, postType: resolvedFormat, confidence: resolvedConfidence };
}

// ─── Quality control ──────────────────────────────────────────────────────────

const QUALITY_CHECK_SYSTEM_PROMPT = `Ты строгий редактор Telegram-канала TONKOFF о крипте и TON.

Твоя задача — проверить готовый пост перед публикацией.

Проверь:
1. ИСТОЧНИК: основан только на фактах из источника? нет выдуманных цифр, дат, партнёрств, заявлений?
2. ФОРМАТИРОВАНИЕ: не стена текста? есть абзацы? читается на мобильном?
3. СТИЛЬ: звучит как живой автор, а не как пересказ? нет "в источнике пишут", "там сказано", "по данным источника"?
4. БЕЗОПАСНОСТЬ: нет финансовых советов? нет "покупай/продавай/иксы"? нет подозрительных ссылок?
5. ЧИСТОТА: нет "—" (длинное тире)? нет "[SHORT]", "Черновик", "confidence", метаданных в тексте?
6. ОБЩЕЕ: интересно? стоит публиковать?

Верни ТОЛЬКО JSON без преамбул:
{
  "quality_score": 0-100,
  "passed": true/false,
  "issues": ["список проблем, если есть"],
  "needs_rewrite": true/false,
  "rewrite_instruction": "краткая инструкция что исправить (или пустая строка)",
  "safe_for_autopublish": true/false
}

Правила оценки:
- 80-100: можно публиковать автоматически
- 60-79: нужна доработка
- 0-59: отправить на ручную проверку`;

export interface QualityCheckResult {
  quality_score: number;
  passed: boolean;
  issues: string[];
  needs_rewrite: boolean;
  rewrite_instruction: string;
  safe_for_autopublish: boolean;
}

/**
 * AI quality check: evaluates the post before auto-publishing.
 * Increments the daily AI calls counter.
 */
export async function runQualityCheck(
  content: string,
  sourceText?: string,
  sourceDate?: Date,
): Promise<QualityCheckResult> {
  const defaultFail: QualityCheckResult = {
    quality_score: 0,
    passed: false,
    issues: ["AI limit reached — quality check skipped"],
    needs_rewrite: false,
    rewrite_instruction: "",
    safe_for_autopublish: false,
  };

  const limit = await checkAiLimitReached();
  if (limit.blocked) return defaultFail;

  const client = getOpenAIClient();
  const settings = await getSettings();
  const model = process.env.OPENAI_MODEL ?? settings.openaiModel;

  const userMsg = [
    "Проверь этот пост:",
    '"""',
    content,
    '"""',
    sourceText
      ? `\nОригинальный источник:\n"""\n${sourceText.slice(0, 800)}\n"""`
      : "",
      isCryptoProfile() && sourceDate
        ? `\nВремя публикации источника (UTC): ${sourceDate.toISOString()}`
        : "",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: qualityCheckSystemPrompt() },
      { role: "user", content: userMsg },
    ],
    max_completion_tokens: 400,
    temperature: 0.2,
  });

  await incrementAiUsage("call");

  const raw = response.choices[0]?.message?.content?.trim() ?? "";

  const tryParse = (s: string): QualityCheckResult | null => {
    try {
      const obj = JSON.parse(s);
      if (typeof obj?.quality_score === "number") {
        return {
          quality_score: Math.max(0, Math.min(100, obj.quality_score)),
          passed: Boolean(obj.passed),
          issues: Array.isArray(obj.issues) ? (obj.issues as string[]) : [],
          needs_rewrite: Boolean(obj.needs_rewrite),
          rewrite_instruction: String(obj.rewrite_instruction ?? ""),
          safe_for_autopublish: Boolean(obj.safe_for_autopublish),
        };
      }
    } catch { /* ignore */ }
    return null;
  };

  const direct = tryParse(raw);
  if (direct) return direct;

  const match = raw.match(/\{[\s\S]*"quality_score"[\s\S]*\}/);
  if (match) {
    const extracted = tryParse(match[0]);
    if (extracted) return extracted;
  }

  logger.warn({ raw: raw.slice(0, 200) }, "Quality check returned unparseable response — treating as low quality");
  return { quality_score: 50, passed: false, issues: ["Не удалось получить оценку качества"], needs_rewrite: false, rewrite_instruction: "", safe_for_autopublish: false };
}

/**
 * Rewrite a post based on quality check feedback.
 * Increments the daily rewrite counter.
 */
export async function rewriteWithFeedback(opts: {
  content: string;
  issues: string[];
  instruction: string;
  sourceText?: string;
  sourceChannel?: string;
  originalFormat?: PostFormat;
}): Promise<string> {
  const limit = await checkAiLimitReached();
  if (limit.blocked) throw new Error("AI limit reached — cannot rewrite");

  const client = getOpenAIClient();
  const settings = await getSettings();
  const model = process.env.OPENAI_MODEL ?? settings.openaiModel;

  const issueList = opts.issues.length > 0
    ? opts.issues.map((i) => `- ${i}`).join("\n")
    : "- Общее качество недостаточно";

  const userMsg = [
    "Улучши пост по замечаниям редактора. Сохрани все факты из источника.",
    "Не придумывай новых фактов. Исправь только указанные проблемы.",
    "",
    "ЗАМЕЧАНИЯ РЕДАКТОРА:",
    issueList,
    opts.instruction ? `\nИНСТРУКЦИЯ: ${opts.instruction}` : "",
    "",
    "ТЕКУЩИЙ ТЕКСТ ПОСТА:",
    '"""',
    opts.content,
    '"""',
    opts.sourceText
      ? `\nОРИГИНАЛЬНЫЙ ИСТОЧНИК:\n"""\n${opts.sourceText.slice(0, 1000)}\n"""`
      : "",
    "",
    "Верни ТОЛЬКО JSON в том же структурированном формате (headline, paragraphs, takeaway).",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: sourceSystemPrompt() },
      { role: "user", content: userMsg },
    ],
    max_completion_tokens: settings.maxTokensPerPost,
    temperature: 0.65,
  });

  await incrementAiUsage("rewrite");

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  if (!raw) return opts.content;

  const parsedJson = parseAiResponse(raw);
  if (parsedJson) {
    const assembled = assemblePost(parsedJson);
    if (assembled) {
      const sanitised = isCryptoProfile() ? sanitizeCryptoPost(assembled) : sanitizePost(assembled);
      if (sanitised) return validateAndReformat(sanitised, opts.originalFormat ?? "short");
    }
  }

  const fallback = isCryptoProfile() ? sanitizeCryptoPost(raw) : sanitizePost(raw);
  return fallback || opts.content;
}
