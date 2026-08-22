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

    const replacement = `// AI_STRUCTURED_OUTPUT_REPAIR
function repairCommonJsonDamage(raw: string): string {
  let input = raw.trim();
  const firstBrace = input.indexOf("{");
  const lastBrace = input.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    input = input.slice(firstBrace, lastBrace + 1);
  }

  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === "\\r" || ch === "\\n") {
        if (ch === "\\r" && input[i + 1] === "\\n") i++;
        out += "\\\\n";
        continue;
      }
      out += ch;
      continue;
    }

    out += ch;
    if (ch === '"') inString = true;
  }

  return out.replace(/,\\s*([}\\]])/g, "$1");
}

function looksLikeStructuredAiPayload(raw: string): boolean {
  const firstBrace = raw.indexOf("{");
  if (firstBrace < 0) return false;
  return /"(?:headline|paragraphs|takeaway|post_format|confidence|source_used|public_post_text)"\\s*:/.test(raw.slice(firstBrace));
}

function parseAiResponse(raw: string): AiJsonResponse | null {
  const tryParse = (candidate: string): AiJsonResponse | null => {
    try {
      const obj = JSON.parse(candidate) as AiJsonResponse;
      if (obj && typeof obj === "object" && (obj.headline !== undefined || obj.public_post_text !== undefined)) {
        return obj;
      }
    } catch { /* try repair/fallback below */ }
    return null;
  };

  const direct = tryParse(raw.trim());
  if (direct) return direct;

  const repaired = repairCommonJsonDamage(raw);
  const repairedParsed = tryParse(repaired);
  if (repairedParsed) {
    logger.warn("Repaired malformed structured AI JSON response before assembly");
    return repairedParsed;
  }

  return null;
}

`;
    s = s.slice(0, start) + replacement + s.slice(end);

    const oldFallback = `  if (parsed) {
    assembled = assemblePost(parsed);
    if (!assembled && raw.length > 0) assembled = raw;
  } else {
    assembled = raw;
  }`;
    const newFallback = `  if (parsed) {
    assembled = assemblePost(parsed);
    if (!assembled && raw.length > 0 && !looksLikeStructuredAiPayload(raw)) assembled = raw;
  } else {
    // Never publish model protocol/JSON as user-facing Telegram content.
    if (looksLikeStructuredAiPayload(raw)) {
      logger.warn({ raw: raw.slice(0, 240) }, "Malformed structured AI payload blocked from public output");
      throw new Error("AI_FORMAT_ERROR");
    }
    assembled = raw;
  }`;
    if (!s.includes(oldFallback)) throw new Error("AI raw fallback block not found");
    s = s.replace(oldFallback, newFallback);
    return s;
  },
  "Applied structured AI output repair and raw fallback block",
);

// A malformed response should skip that candidate and try another fresh source.
await patch(
  "artifacts/api-server/src/lib/auto-generate.ts",
  (input) => {
    if (input.includes("AI_FORMAT_ERROR_SOURCE_SKIP")) return input;

    const simpleOld = `      if (err instanceof Error && err.message === "NO_POST") {
        logger.info({ channel: candidate.channel }, "Source returned NO_POST — trying next");
        skippedHashes.add(candidate.textHash);
        continue;
      }`;
    const businessOld = `      if (err instanceof Error && err.message === "NO_POST") {
        logger.info({ channel: candidate.channel }, "Source returned NO_POST — trying next");
        if (!cryptoProfile) {
          fincentreNoPostUntil.set(candidate.textHash, Date.now() + FINCENTRE_NO_POST_TTL_MS);
        }
        skippedHashes.add(candidate.textHash);
        continue;
      }`;

    const commonNew = `      // AI_FORMAT_ERROR_SOURCE_SKIP: malformed structured output is never public.
      if (err instanceof Error && (err.message === "NO_POST" || err.message === "AI_FORMAT_ERROR")) {
        logger.info(
          { channel: candidate.channel, reason: err.message },
          err.message === "AI_FORMAT_ERROR"
            ? "Source produced malformed structured output — trying next"
            : "Source returned NO_POST — trying next",
        );
        skippedHashes.add(candidate.textHash);
        continue;
      }`;

    const businessNew = `      // AI_FORMAT_ERROR_SOURCE_SKIP: malformed structured output is never public.
      if (err instanceof Error && (err.message === "NO_POST" || err.message === "AI_FORMAT_ERROR")) {
        logger.info(
          { channel: candidate.channel, reason: err.message },
          err.message === "AI_FORMAT_ERROR"
            ? "Source produced malformed structured output — trying next"
            : "Source returned NO_POST — trying next",
        );
        if (!cryptoProfile && err.message === "NO_POST") {
          fincentreNoPostUntil.set(candidate.textHash, Date.now() + FINCENTRE_NO_POST_TTL_MS);
        }
        skippedHashes.add(candidate.textHash);
        continue;
      }`;

    if (input.includes(businessOld)) return input.replace(businessOld, businessNew);
    if (input.includes(simpleOld)) return input.replace(simpleOld, commonNew);
    throw new Error("auto-generate candidate catch block not found");
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
    const marker = `function getOwnerChatId(): string | null {
  return process.env.OWNER_TELEGRAM_ID ?? null;
}`;
    const helper = `${marker}

// RAW_AI_PAYLOAD_PUBLISH_GUARD
function assertPublicTelegramText(text: string): void {
  const firstBrace = text.indexOf("{");
  const structured = firstBrace >= 0
    && /"(?:headline|paragraphs|takeaway|post_format|confidence|source_used|public_post_text)"\\s*:/.test(text.slice(firstBrace));
  if (structured) {
    throw new Error("Blocked raw AI JSON payload before Telegram publish");
  }
}`;
    if (!s.includes(marker)) throw new Error("telegram owner helper marker not found");
    s = s.replace(marker, helper);

    const textMarker = `export async function sendTelegramMessage(text: string): Promise<number> {
  const token = getBotToken();`;
    if (s.includes(textMarker)) {
      s = s.replace(
        textMarker,
        `export async function sendTelegramMessage(text: string): Promise<number> {
  assertPublicTelegramText(text);
  const token = getBotToken();`,
      );
    } else {
      s = s.replace(
        `export async function sendTelegramMessage(text: string): Promise<number> {`,
        `export async function sendTelegramMessage(text: string): Promise<number> {
  assertPublicTelegramText(text);`,
      );
    }

    const photoMarker = `): Promise<PhotoPublishResult> {
  const token = getBotToken();`;
    if (s.includes(photoMarker)) {
      s = s.replace(
        photoMarker,
        `): Promise<PhotoPublishResult> {
  assertPublicTelegramText(caption);
  const token = getBotToken();`,
      );
    } else {
      const photoFn = `export async function sendPhotoPost(
  photoSource: Buffer | string,
  caption: string,
): Promise<PhotoPublishResult> {`;
      if (s.includes(photoFn)) {
        s = s.replace(photoFn, `${photoFn}
  assertPublicTelegramText(caption);`);
      }
    }
    return s;
  },
  "Added final Telegram raw-AI-payload publication guard",
);

// Skip any legacy bad drafts already persisted before this fix.
await patch(
  "artifacts/api-server/src/lib/scheduler.ts",
  (input) => {
    if (input.includes("LEGACY_RAW_AI_DRAFT_SKIP")) return input;
    const old = `  if (!post.content.trim()) return false;

  if (isCryptoProfile()) {`;
    const next = `  if (!post.content.trim()) return false;

  // LEGACY_RAW_AI_DRAFT_SKIP: old malformed JSON drafts are never publishable.
  const firstBrace = post.content.indexOf("{");
  if (firstBrace >= 0
      && /"(?:headline|paragraphs|takeaway|post_format|confidence|source_used|public_post_text)"\\s*:/.test(post.content.slice(firstBrace))) {
    return false;
  }

  if (isCryptoProfile()) {`;
    if (!input.includes(old)) throw new Error("scheduler content quality marker not found");
    return input.replace(old, next);
  },
  "Added legacy malformed-draft scheduler skip",
);

console.log("AI output safety hardening complete");
