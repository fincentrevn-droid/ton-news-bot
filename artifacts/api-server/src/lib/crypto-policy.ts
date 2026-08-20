import { isCryptoProfile } from "./channel-profile";

export const PANKOFF_CRYPTO_MAX_SOURCE_AGE_HOURS = 24;
const CRYPTO_MAX_BODY_LENGTH = 600;

const HARD_PROMO_PATTERNS = [
  /\b(?:referral|affiliate|ambassador)\b/i,
  /\b(?:promo\s*code|promocode|casino)\b/i,
  /\b(?:claim|connect\s*wallet|connect-wallet|wallet-connect)\b/i,
  /\b(?:реферал(?:ьн\w*)?|промокод|казино)\b/i,
  /\b(?:кэшбэк|партн[её]рск\w*\s+ссылк\w*)\b/i,
];

const CTA_PATTERNS = [
  /\b(?:sign\s*up|register|join\s+now|subscribe|follow\s+us)\b/i,
  /\b(?:подписывай(?:тесь|ся)|регистрируй(?:тесь|ся)|переходите|забирайте)\b/i,
  /\b(?:курс(?:ы|а)?\s+(?:по|для)|платн\w*\s+сервис)\b/i,
];

const TRADE_SIGNAL_PATTERNS = [
  /\b(?:buy|sell|long|short|leverage|all\s*in)\b/i,
  /\b(?:покупай(?:те)?|продавай(?:те)?|лонг|шорт|плеч[оа]|вкладывай(?:те)?|инвестируй(?:те)?)\b/i,
  /\b(?:сейл|presale|token\s*sale)\b/i,
];

const PUBLIC_LINK_OR_HANDLE = /(?:https?:\/\/|(?:t\.me|telegram\.me)\/|(?:^|\s)@[a-z0-9_]{3,})/i;
const SOURCE_REPORTER_WORDING = /(?:в источнике пишут|источник сообщает|по данным источника|согласно источнику)/i;

export interface CryptoPolicyResult {
  accepted: boolean;
  reasons: string[];
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function cryptoSourceAgeHours(): number {
  const configured = Number.parseInt(process.env.PANKOFF_CRYPTO_MAX_SOURCE_AGE_HOURS ?? "", 10);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, PANKOFF_CRYPTO_MAX_SOURCE_AGE_HOURS)
    : PANKOFF_CRYPTO_MAX_SOURCE_AGE_HOURS;
}

/**
 * Cheap, deterministic source gate before an AI call. It blocks clearly
 * promotional material and trading calls while leaving mixed news for the
 * source prompt/QC to extract safely or reject.
 */
export function assessCryptoSource(text: string, publishedAt: Date): CryptoPolicyResult {
  const reasons: string[] = [];
  const ageMs = Date.now() - publishedAt.getTime();
  if (!Number.isFinite(publishedAt.getTime()) || ageMs > cryptoSourceAgeHours() * 60 * 60 * 1000) {
    reasons.push("устаревший источник");
  }
  if (hasAny(text, HARD_PROMO_PATTERNS)) reasons.push("реклама, рефералка или опасный CTA");
  if (hasAny(text, TRADE_SIGNAL_PATTERNS)) reasons.push("торговый сигнал или инвестиционный призыв");
  return { accepted: reasons.length === 0, reasons };
}

/**
 * Must be true before a crypto post can be queued for auto-publishing. The
 * generated body intentionally excludes the PANKOFF footer, which is attached
 * only by the Telegram publisher after QC and safety checks have completed.
 */
export function assessCryptoPublicBody(text: string): CryptoPolicyResult {
  const reasons: string[] = [];
  const trimmed = text.trim();
  const paragraphs = trimmed.split(/\n\s*\n/).filter(Boolean);
  const emojiCount = (trimmed.match(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu) ?? []).length;

  if (!trimmed) reasons.push("пустой текст");
  if (trimmed.length > CRYPTO_MAX_BODY_LENGTH) reasons.push("текст длиннее 600 символов");
  if (paragraphs.length < 1 || paragraphs.length > 3) reasons.push("некорректное число абзацев");
  if (emojiCount > 1) reasons.push("слишком много эмодзи");
  if (PUBLIC_LINK_OR_HANDLE.test(trimmed)) reasons.push("ссылка или чужой Telegram handle в публичном тексте");
  if (hasAny(trimmed, HARD_PROMO_PATTERNS) || hasAny(trimmed, CTA_PATTERNS)) reasons.push("реклама, рефералка или CTA");
  if (hasAny(trimmed, TRADE_SIGNAL_PATTERNS)) reasons.push("финансовый совет или торговый сигнал");
  if (SOURCE_REPORTER_WORDING.test(trimmed)) reasons.push("репортёрская формулировка");

  return { accepted: reasons.length === 0, reasons };
}

/**
 * Source captions are the only local signal available before publishing a
 * downloaded Telegram photo. If they carry a handle, link, QR-oriented CTA or
 * promotion, the photo is unsafe. In crypto mode the caller omits media when
 * this gate fails but can still publish the verified text.
 */
export function canUseCryptoSourceMedia(sourceText: string): CryptoPolicyResult {
  if (!isCryptoProfile()) return { accepted: true, reasons: [] };

  const reasons: string[] = [];
  if (PUBLIC_LINK_OR_HANDLE.test(sourceText)) reasons.push("ссылка или handle рядом с изображением");
  if (hasAny(sourceText, HARD_PROMO_PATTERNS) || hasAny(sourceText, CTA_PATTERNS)) {
    reasons.push("рекламный или CTA-контекст изображения");
  }
  return { accepted: reasons.length === 0, reasons };
}