import { readFile, writeFile } from "node:fs/promises";

async function patch(path, transform, label) {
  const source = await readFile(path, "utf8");
  const next = transform(source);
  if (next !== source) {
    await writeFile(path, next);
    console.log(label);
  } else {
    console.log(`${label}: already applied`);
  }
}

// Never let a malformed structured AI response fall back to raw public text.
await patch(
  "artifacts/api-server/src/lib/openai.ts",
  (input) => {
    if (input.includes("AI_STRUCTURED_OUTPUT_REPAIR")) return input;
    let s = input;
    const start = s.indexOf("function parseAiResponse(raw: string): AiJsonResponse | null {");
    const end = s.indexOf("/**\n * Assemble the public post text", start);
    if (start < 0 || end < 0) throw new Error("parseAiResponse block not found");

    const replacement = `// AI_STRUCTURED_OUTPUT_REPAIR\nfunction stripJsonFence(raw: string): string {\n  return raw\n    .trim()\n    .replace(/^\\s*\\`\\`\\`(?:json)?\\s*/i, "")\n    .replace(/\\s*\\`\\`\\`\\s*$/i, "")\n    .trim();\n}\n\nfunction repairCommonJsonDamage(raw: string): string {\n  const input = stripJsonFence(raw);\n  let out = "";\n  let inString = false;\n  let escaped = false;\n\n  for (let i = 0; i < input.length; i++) {\n    const ch = input[i];\n    if (inString) {\n      if (escaped) {\n        out += ch;\n        escaped = false;\n        continue;\n      }\n      if (ch === "\\\\") {\n        out += ch;\n        escaped = true;\n        continue;\n      }\n      if (ch === '"') {\n        out += ch;\n        inString = false;\n        continue;\n      }\n      if (ch === "\\r" || ch === "\\n") {\n        if (ch === "\\r" && input[i + 1] === "\\n") i++;\n        out += "\\\\n";\n        continue;\n      }\n      out += ch;\n      continue;\n    }\n\n    out += ch;\n    if (ch === '"') inString = true;\n  }\n\n  // Models occasionally leave a trailing comma before ] or }.\n  return out.replace(/,\\s*([}\\]])/g, "$1");\n}\n\nfunction looksLikeStructuredAiPayload(raw: string): boolean {\n  const text = stripJsonFence(raw);\n  return /[\\{\\[]/.test(text.slice(0, 3))\n    && /"(?:headline|paragraphs|takeaway|post_format|confidence|source_used|public_post_text)"\\s*:/.test(text);\n}\n\nfunction parseAiResponse(raw: string): AiJsonResponse | null {\n  const tryParse = (candidate: string): AiJsonResponse | null => {\n    try {\n      const obj = JSON.parse(candidate) as AiJsonResponse;\n      if (obj && typeof obj === "object" && (obj.headline !== undefined || obj.public_post_text !== undefined)) {\n        return obj;\n      }\n    } catch { /* try repair/fallback below */ }\n    return null;\n  };\n\n  const stripped = stripJsonFence(raw);\n  const direct = tryParse(stripped);\n  if (direct) return direct;\n\n  const repaired = repairCommonJsonDamage(stripped);\n  const repairedParsed = tryParse(repaired);\n  if (repairedParsed) {\n    logger.warn("Repaired malformed structured AI JSON response before assembly");\n    return repairedParsed;\n  }\n\n  const firstBrace = stripped.indexOf("{");\n  const lastBrace = stripped.lastIndexOf("}");\n  if (firstBrace >= 0 && lastBrace > firstBrace) {\n    const extracted = stripped.slice(firstBrace, lastBrace + 1);\n    const parsedExtracted = tryParse(extracted) ?? tryParse(repairCommonJsonDamage(extracted));\n    if (parsedExtracted) return parsedExtracted;\n  }\n\n  return null;\n}\n\n`;
    s = s.slice(0, start) + replacement + s.slice(end);

    const oldFallback = `  if (parsed) {\n    assembled = assemblePost(parsed);\n    if (!assembled && raw.length > 0) assembled = raw;\n  } else {\n    assembled = raw;\n  }`;
    const newFallback = `  if (parsed) {\n    assembled = assemblePost(parsed);\n    if (!assembled && raw.length > 0 && !looksLikeStructuredAiPayload(raw)) assembled = raw;\n  } else {\n    // Never publish model protocol/JSON as user-facing Telegram content.\n    if (looksLikeStructuredAiPayload(raw)) {\n      logger.warn({ raw: raw.slice(0, 240) }, "Malformed structured AI payload blocked from public output");\n      throw new Error("AI_FORMAT_ERROR");\n    }\n    assembled = raw;\n  }`;
    if (!s.includes(oldFallback)) throw new Error("AI raw fallback block not found");
    s = s.replace(oldFallback, newFallback);
    return s;
  },
  "Applied structured AI output repair and raw fallback block",
);

// A malformed response should skip that candidate and try another fresh source,
// not abort the entire generation cycle.
await patch(
  "artifacts/api-server/src/lib/auto-generate.ts",
  (input) => {
    if (input.includes("AI_FORMAT_ERROR_SOURCE_SKIP")) return input;
    const oldCatch = `      if (err instanceof Error && err.message === "NO_POST") {\n        logger.info({ channel: candidate.channel }, "Source returned NO_POST — trying next");\n        skippedHashes.add(candidate.textHash);\n        continue;\n      }`;
    const newCatch = `      // AI_FORMAT_ERROR_SOURCE_SKIP: malformed structured output is never public.\n      if (err instanceof Error && (err.message === "NO_POST" || err.message === "AI_FORMAT_ERROR")) {\n        logger.info(\n          { channel: candidate.channel, reason: err.message },\n          err.message === "AI_FORMAT_ERROR"\n            ? "Source produced malformed structured output — trying next"\n            : "Source returned NO_POST — trying next",\n        );\n        skippedHashes.add(candidate.textHash);\n        continue;\n      }`;
    if (!input.includes(oldCatch)) throw new Error("auto-generate candidate catch block not found");
    return input.replace(oldCatch, newCatch);
  },
  "Added malformed-output source skip",
);

// Last line of defence: no manual, scheduler, review-button or photo publication
// can send an AI JSON protocol payload already stored in the database.
await patch(
  "artifacts/api-server/src/lib/telegram.ts",
  (input) => {
    if (input.includes("RAW_AI_PAYLOAD_PUBLISH_GUARD")) return input;
    let s = input;
    const marker = `function getOwnerChatId(): string | null {\n  return process.env.OWNER_TELEGRAM_ID ?? null;\n}`;
    const helper = `${marker}\n\n// RAW_AI_PAYLOAD_PUBLISH_GUARD\nfunction assertPublicTelegramText(text: string): void {\n  const trimmed = text.trim().replace(/^\\`\\`\\`(?:json)?\\s*/i, "");\n  const structured = /[\\{\\[]/.test(trimmed.slice(0, 3))\n    && /"(?:headline|paragraphs|takeaway|post_format|confidence|source_used|public_post_text)"\\s*:/.test(trimmed);\n  if (structured) {\n    throw new Error("Blocked raw AI JSON payload before Telegram publish");\n  }\n}`;
    if (!s.includes(marker)) throw new Error("telegram owner helper marker not found");
    s = s.replace(marker, helper);

    s = s.replace(
      `export async function sendTelegramMessage(text: string): Promise<number> {\n  const token = getBotToken();`,
      `export async function sendTelegramMessage(text: string): Promise<number> {\n  assertPublicTelegramText(text);\n  const token = getBotToken();`,
    );
    s = s.replace(
      `): Promise<PhotoPublishResult> {\n  const token = getBotToken();`,
      `): Promise<PhotoPublishResult> {\n  assertPublicTelegramText(caption);\n  const token = getBotToken();`,
    );
    return s;
  },
  "Added final Telegram raw-AI-payload publication guard",
);

// Skip any legacy bad drafts already persisted before this fix, so they cannot
// starve valid newer drafts or repeatedly fail the publisher.
await patch(
  "artifacts/api-server/src/lib/scheduler.ts",
  (input) => {
    if (input.includes("LEGACY_RAW_AI_DRAFT_SKIP")) return input;
    const old = `  if (!post.content.trim()) return false;\n\n  if (isCryptoProfile()) {`;
    const next = `  if (!post.content.trim()) return false;\n\n  // LEGACY_RAW_AI_DRAFT_SKIP: old malformed JSON drafts are never publishable.\n  const trimmedContent = post.content.trim().replace(/^\\`\\`\\`(?:json)?\\s*/i, "");\n  if (/[\\{\\[]/.test(trimmedContent.slice(0, 3))\n      && /"(?:headline|paragraphs|takeaway|post_format|confidence|source_used|public_post_text)"\\s*:/.test(trimmedContent)) {\n    return false;\n  }\n\n  if (isCryptoProfile()) {`;
    if (!input.includes(old)) throw new Error("scheduler content quality marker not found");
    return input.replace(old, next);
  },
  "Added legacy malformed-draft scheduler skip",
);

console.log("AI output safety hardening complete");
