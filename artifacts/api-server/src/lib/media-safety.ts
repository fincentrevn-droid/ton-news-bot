import { spawn } from "node:child_process";

const MIN_IMAGE_BYTES = 10 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIN_SHORT_SIDE = 320;
const MIN_PIXELS = 320 * 480;
const TOOL_TIMEOUT_MS = 15_000;
const MAX_TOOL_OUTPUT_BYTES = 512 * 1024;

const OVERLAY_PROMO_PATTERN =
  /(?:https?:\/\/|www\.|t\.me\/?|@[a-z0-9_]{4,}|підпис(?:уй|ка)|подпис(?:ывай|ка)|наш\s+канал|telegram|телеграм|реклам|sponsor|promo\s*code|промокод|знижк|скидк|розіграш|giveaway)/iu;

const SOURCE_PROMO_PATTERN =
  /(?:підпис(?:уй|ка)|подпис(?:ывай|ка)|наш\s+канал|реклам|sponsor|promo\s*code|промокод|знижк|скидк|розіграш|giveaway|партнерськ(?:ий|а)\s+матеріал)/iu;

const KNOWN_MEDIA_BRANDS = new Set([
  "epravda",
  "forbes",
  "opendatabot",
  "telegram",
  "instagram",
  "facebook",
  "youtube",
  "tiktok",
]);

export interface ImageMetadata {
  format: "jpeg" | "png";
  width: number;
  height: number;
}

export interface OcrWord {
  text: string;
  confidence: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BusinessImageDecision {
  allowed: boolean;
  reason:
    | "approved"
    | "invalid_size"
    | "unsupported_format"
    | "invalid_dimensions"
    | "promotional_source"
    | "qr_or_barcode"
    | "qr_scan_failed"
    | "ocr_failed"
    | "channel_brand"
    | "promotional_overlay"
    | "edge_watermark"
    | "text_overlay";
  format?: "jpeg" | "png";
  width?: number;
  height?: number;
  detectedWords?: number;
}

interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
  failed: boolean;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("uk-UA")
    .replace(/[^\p{L}\p{N}@._:/-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jpegDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8)
    return null;

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) break;
    if (offset + 4 > buffer.length) break;

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) break;

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + segmentLength;
  }

  return null;
}

export function readImageMetadata(buffer: Buffer): ImageMetadata | null {
  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(pngSignature)) {
    return {
      format: "png",
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  const jpeg = jpegDimensions(buffer);
  return jpeg ? { format: "jpeg", ...jpeg } : null;
}

function runMediaTool(
  command: string,
  args: string[],
  input: Buffer,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let finished = false;

    const finish = (result: ToolResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout: "", stderr: "timeout", failed: true });
    }, TOOL_TIMEOUT_MS);

    const collect = (chunks: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_TOOL_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish({
          code: null,
          stdout: "",
          stderr: "output_limit",
          failed: true,
        });
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => collect(stdoutChunks, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderrChunks, chunk));
    child.on("error", (error) => {
      finish({ code: null, stdout: "", stderr: error.message, failed: true });
    });
    child.on("close", (code) => {
      finish({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        failed: false,
      });
    });

    child.stdin.on("error", () => {
      /* process may exit before consuming stdin */
    });
    child.stdin.end(input);
  });
}

export function parseTesseractTsv(tsv: string): OcrWord[] {
  return tsv
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 12 && parts[0] === "5")
    .map((parts) => ({
      left: Number.parseInt(parts[6] ?? "0", 10),
      top: Number.parseInt(parts[7] ?? "0", 10),
      width: Number.parseInt(parts[8] ?? "0", 10),
      height: Number.parseInt(parts[9] ?? "0", 10),
      confidence: Number.parseFloat(parts[10] ?? "-1"),
      text: parts.slice(11).join("\t").trim(),
    }))
    .filter((word) => word.text.length > 0 && Number.isFinite(word.confidence));
}

export function evaluateOcrWords(
  words: OcrWord[],
  metadata: ImageMetadata,
  sourceChannel: string,
): BusinessImageDecision {
  const confident = words.filter(
    (word) => word.confidence >= 45 && normalizeText(word.text).length >= 2,
  );
  if (confident.length === 0) {
    return { allowed: true, reason: "approved", ...metadata, detectedWords: 0 };
  }

  const rawText = confident.map((word) => word.text).join(" ");
  const normalized = normalizeText(rawText);
  const sourceTokens = normalizeText(sourceChannel)
    .split(" ")
    .filter((token) => token.length >= 5);

  const recognizedTokens = normalized.split(" ").filter(Boolean);
  if (
    sourceTokens.some((token) => recognizedTokens.includes(token)) ||
    recognizedTokens.some((token) =>
      KNOWN_MEDIA_BRANDS.has(token.replace(/^@/, "")),
    )
  ) {
    return {
      allowed: false,
      reason: "channel_brand",
      ...metadata,
      detectedWords: confident.length,
    };
  }

  if (
    OVERLAY_PROMO_PATTERN.test(rawText) ||
    OVERLAY_PROMO_PATTERN.test(normalized)
  ) {
    return {
      allowed: false,
      reason: "promotional_overlay",
      ...metadata,
      detectedWords: confident.length,
    };
  }

  const edgeText = confident.some((word) => {
    const token = normalizeText(word.text);
    if (token.length < 4) return false;
    const right = word.left + word.width;
    const bottom = word.top + word.height;
    return (
      word.left <= metadata.width * 0.08 ||
      word.top <= metadata.height * 0.08 ||
      right >= metadata.width * 0.92 ||
      bottom >= metadata.height * 0.92
    );
  });
  if (edgeText) {
    return {
      allowed: false,
      reason: "edge_watermark",
      ...metadata,
      detectedWords: confident.length,
    };
  }

  const meaningful = confident.filter(
    (word) => normalizeText(word.text).length >= 3,
  );
  const meaningfulChars = meaningful.reduce(
    (sum, word) => sum + normalizeText(word.text).length,
    0,
  );
  if (meaningful.length >= 4 || meaningfulChars >= 24) {
    return {
      allowed: false,
      reason: "text_overlay",
      ...metadata,
      detectedWords: confident.length,
    };
  }

  return {
    allowed: true,
    reason: "approved",
    ...metadata,
    detectedWords: confident.length,
  };
}

export async function assessBusinessImageSafety(options: {
  buffer: Buffer;
  sourceChannel: string;
  sourceText: string;
}): Promise<BusinessImageDecision> {
  const { buffer, sourceChannel, sourceText } = options;
  if (buffer.length < MIN_IMAGE_BYTES || buffer.length > MAX_IMAGE_BYTES) {
    return { allowed: false, reason: "invalid_size" };
  }

  const metadata = readImageMetadata(buffer);
  if (!metadata) return { allowed: false, reason: "unsupported_format" };
  if (
    Math.min(metadata.width, metadata.height) < MIN_SHORT_SIDE ||
    metadata.width * metadata.height < MIN_PIXELS
  ) {
    return { allowed: false, reason: "invalid_dimensions", ...metadata };
  }

  if (SOURCE_PROMO_PATTERN.test(sourceText)) {
    return { allowed: false, reason: "promotional_source", ...metadata };
  }

  const barcodeResult = await runMediaTool(
    "zbarimg",
    ["--quiet", "--raw", "-"],
    buffer,
  );
  if (barcodeResult.failed || ![0, 4].includes(barcodeResult.code ?? -1)) {
    return { allowed: false, reason: "qr_scan_failed", ...metadata };
  }
  if (barcodeResult.code === 0 && barcodeResult.stdout.trim()) {
    return { allowed: false, reason: "qr_or_barcode", ...metadata };
  }

  const ocrResult = await runMediaTool(
    "tesseract",
    ["stdin", "stdout", "-l", "eng+ukr+rus", "--psm", "11", "tsv"],
    buffer,
  );
  if (ocrResult.failed || ocrResult.code !== 0) {
    return { allowed: false, reason: "ocr_failed", ...metadata };
  }

  return evaluateOcrWords(
    parseTesseractTsv(ocrResult.stdout),
    metadata,
    sourceChannel,
  );
}
