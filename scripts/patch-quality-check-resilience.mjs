import { readFile, writeFile } from "node:fs/promises";

const path = "artifacts/api-server/src/lib/openai.ts";
let source = await readFile(path, "utf8");

if (source.includes("QC_STRUCTURED_OUTPUT_RESILIENCE")) {
  console.log("QC structured-output resilience already applied");
  process.exit(0);
}

const start = source.indexOf("export async function runQualityCheck(");
const end = source.indexOf("/**\n * Rewrite a post based on quality check feedback.", start);
if (start < 0 || end < 0) throw new Error("runQualityCheck block not found");

const replacement = `// QC_STRUCTURED_OUTPUT_RESILIENCE
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
    '\"\"\"',
    content,
    '\"\"\"',
    sourceText
      ? \`\\nОригинальный источник:\\n\"\"\"\\n\${sourceText.slice(0, 800)}\\n\"\"\"\`
      : "",
    isCryptoProfile() && sourceDate
      ? \`\\nВремя публикации источника (UTC): \${sourceDate.toISOString()}\`
      : "",
  ]
    .filter(Boolean)
    .join("\\n");

  const parseQuality = (raw: string): QualityCheckResult | null => {
    const tryParse = (candidate: string): QualityCheckResult | null => {
      try {
        const obj = JSON.parse(candidate);
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
      } catch { /* try repaired form below */ }
      return null;
    };

    const direct = tryParse(raw.trim());
    if (direct) return direct;

    // Reuse the same tolerant JSON repair already used for generated posts.
    const repaired = repairCommonJsonDamage(raw);
    const repairedResult = tryParse(repaired);
    if (repairedResult) {
      logger.warn("Repaired malformed QC JSON response");
      return repairedResult;
    }

    return null;
  };

  const requestQc = async (retry: boolean): Promise<string> => {
    const retryInstruction = retry
      ? "\\n\\nВАЖНО: предыдущий ответ не удалось разобрать. Верни ОДНУ строку строго валидного JSON, без markdown, без пояснений и без переносов внутри строк."
      : "";
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: qualityCheckSystemPrompt() },
        { role: "user", content: userMsg + retryInstruction },
      ],
      // 400 was too tight for reasoning-capable models and could truncate JSON.
      max_completion_tokens: retry ? 900 : 800,
    });
    await incrementAiUsage("call");
    return response.choices[0]?.message?.content?.trim() ?? "";
  };

  const firstRaw = await requestQc(false);
  const first = parseQuality(firstRaw);
  if (first) return first;

  logger.warn(
    { raw: firstRaw.slice(0, 240) },
    "QC returned malformed structured output — retrying once",
  );

  // Do not retry through a hard account/app limit.
  const retryLimit = await checkAiLimitReached();
  if (!retryLimit.blocked) {
    const secondRaw = await requestQc(true);
    const second = parseQuality(secondRaw);
    if (second) {
      logger.info("QC structured-output retry succeeded");
      return second;
    }
    logger.warn(
      { raw: secondRaw.slice(0, 240) },
      "QC retry also returned malformed output — manual review required",
    );
  }

  return {
    quality_score: 50,
    passed: false,
    issues: ["Не удалось получить корректный структурированный ответ QC после повторной проверки"],
    needs_rewrite: false,
    rewrite_instruction: "",
    safe_for_autopublish: false,
  };
}

`;

source = source.slice(0, start) + replacement + source.slice(end);
await writeFile(path, source);
console.log("Added resilient QC JSON repair and one-shot retry");
