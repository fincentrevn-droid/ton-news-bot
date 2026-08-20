import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "./logger";
import type { CryptoPolicyResult } from "./crypto-policy";

const execFileAsync = promisify(execFile);

const URL_OR_HANDLE = /(?:https?:\/\/|www\.|t\.me\/|telegram\.me\/|(?:^|\s)@[a-z0-9_]{3,}|[a-z0-9.-]+\.(?:com|io|net|org|me|cc|co)(?:\/|$))/i;
const PROMO_OR_REFERRAL = /\b(?:promo(?:\s*code)?|ref(?:erral)?(?:\s*code)?|affiliate|coupon|bonus|discount|sponsored|advertisement|ad\b|promo[\s_-]*код|промокод|реф(?:ерал(?:ьн\w*)?)?|бонус|скидк\w*|реклам\w*|партн[её]рск\w*)\b/i;
const WATERMARK_MARKERS = /\b(?:watermark|stock\s*photo|shutterstock|getty(?:images)?|istock|depositphotos|alamy|©)\b/i;

// These are deliberately explicit rather than treating every word on a chart
// as branding. A source's own name is allowed; other known media/channel marks
// are not.
const KNOWN_CHANNEL_BRANDS = [
  "bitcoin magazine",
  "cointelegraph",
  "coindesk",
  "the block",
  "decrypt",
  "wu blockchain",
  "glassnode",
  "cryptoslate",
  "u today",
  "beincrypto",
  "ambcrypto",
  "coinmarketcap",
  "binance",
  "coinbase",
  "okx",
  "bybit",
  "tradingview",
];

interface CommandOutput {
  stdout: string;
}

export interface CryptoMediaSafetyResult extends CryptoPolicyResult {
  scanned: boolean;
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "");
}

function sourceBrandIsAllowed(brand: string, sourceChannel: string): boolean {
  const brandKey = compact(brand);
  const sourceKey = compact(sourceChannel);
  return Boolean(sourceKey && (sourceKey.includes(brandKey) || brandKey.includes(sourceKey)));
}

async function runImageMagick(inputPath: string, outputPath: string): Promise<void> {
  const args = [
    inputPath,
    "-auto-orient",
    "-strip",
    "-resize",
    "2400x2400>",
    outputPath,
  ];
  try {
    await execFileAsync("magick", args);
  } catch (err) {
    // Some deployments expose ImageMagick 6 as `convert` only.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await execFileAsync("convert", args);
  }
}

async function availableOcrLanguage(): Promise<string | null> {
  try {
    const result = await execFileAsync("tesseract", ["--list-langs"]) as CommandOutput;
    const languages = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line !== "List of available languages");
    const selected = ["eng", "rus"].filter((language) => languages.includes(language));
    return selected.length > 0 ? selected.join("+") : null;
  } catch {
    return null;
  }
}

async function scanQrAndBarcodes(imagePath: string): Promise<CryptoPolicyResult> {
  try {
    const result = await execFileAsync("zbarimg", ["--quiet", "--raw", imagePath]) as CommandOutput;
    return result.stdout.trim()
      ? { accepted: false, reasons: ["на изображении найден QR-код или barcode"] }
      : { accepted: true, reasons: [] };
  } catch (err) {
    // zbarimg uses non-zero "no symbol" exit codes across builds (commonly
    // 1 or 4). Any other failure, including a missing binary, is inconclusive
    // and fails closed for the photo only.
    const exitCode = Number((err as { code?: number | string }).code);
    if (exitCode === 1 || exitCode === 4) {
      return { accepted: true, reasons: [] };
    }
    return { accepted: false, reasons: ["QR/barcode-проверка не подтверждена"] };
  }
}

async function scanOcr(imagePath: string, language: string): Promise<CryptoPolicyResult & { text: string }> {
  try {
    const result = await execFileAsync("tesseract", [
      imagePath,
      "stdout",
      "-l",
      language,
      "--psm",
      "11",
    ]) as CommandOutput;
    const text = result.stdout.trim();
    const reasons: string[] = [];

    if (URL_OR_HANDLE.test(text)) reasons.push("на изображении найден URL или Telegram handle");
    if (PROMO_OR_REFERRAL.test(text)) reasons.push("на изображении найден рекламный или referral-маркер");
    if (WATERMARK_MARKERS.test(text)) reasons.push("на изображении найден watermark");

    return { accepted: reasons.length === 0, reasons, text };
  } catch {
    return { accepted: false, reasons: ["OCR-проверка не подтверждена"], text: "" };
  }
}

function assessRecognizedBranding(ocrText: string, sourceChannel: string): CryptoPolicyResult {
  const reasons = KNOWN_CHANNEL_BRANDS
    .filter((brand) => !sourceBrandIsAllowed(brand, sourceChannel) && compact(ocrText).includes(compact(brand)))
    .map((brand) => `обнаружен брендинг другого канала или сервиса: ${brand}`);
  return { accepted: reasons.length === 0, reasons };
}

/**
 * Runs only for crypto source photos. It fails closed for the media itself:
 * an unavailable or inconclusive scanner returns accepted=false, while the
 * caller continues with the generated text.
 */
export async function inspectCryptoMedia(
  mediaBuffer: Buffer,
  sourceChannel: string,
): Promise<CryptoMediaSafetyResult> {
  if (!mediaBuffer.length) {
    return { accepted: false, reasons: ["пустой файл изображения"], scanned: false };
  }

  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "pankoff-media-"));
    const inputPath = join(directory, "source-image");
    const normalizedPath = join(directory, "normalized.png");
    const ocrPath = join(directory, "ocr.png");
    await writeFile(inputPath, mediaBuffer);
    await runImageMagick(inputPath, normalizedPath);
    await execFileAsync("magick", [
      normalizedPath,
      "-colorspace",
      "Gray",
      "-contrast-stretch",
      "0x15%",
      ocrPath,
    ]);

    const language = await availableOcrLanguage();
    if (!language) {
      return { accepted: false, reasons: ["локальный Tesseract недоступен"], scanned: false };
    }

    const [barcodeResult, ocrResult] = await Promise.all([
      scanQrAndBarcodes(normalizedPath),
      scanOcr(ocrPath, language),
    ]);
    const brandingResult = assessRecognizedBranding(ocrResult.text, sourceChannel);
    const reasons = [
      ...barcodeResult.reasons,
      ...ocrResult.reasons,
      ...brandingResult.reasons,
    ];
    return { accepted: reasons.length === 0, reasons, scanned: true };
  } catch (err) {
    logger.warn({ err, sourceChannel }, "Crypto visual media scan failed — publishing text without photo");
    return { accepted: false, reasons: ["visual media scan failed"], scanned: false };
  } finally {
    if (directory) {
      await rm(directory, { recursive: true, force: true }).catch((err) => {
        logger.debug({ err, directory }, "Failed to remove temporary media-scan directory");
      });
    }
  }
}
