import { logger } from "./logger";

const SUSPICIOUS_PATTERNS = [
  /bit\.ly\//i,
  /tinyurl\.com\//i,
  /t\.co\//i,
  /freeclaim/i,
  /free[-_]?claim/i,
  /wallet[-_]?connect/i,
  /connect[-_]?wallet/i,
  /verify[-_]?wallet/i,
  /airdrop[^s]/i,
  /free\s+airdrop/i,
  /claim\s+your/i,
  /seed\s*phrase/i,
  /private\s*key/i,
  /secret\s*phrase/i,
  /mnemonic/i,
  /fake\s*giveaway/i,
  /guaranteed\s*(profit|return|gain|yield)/i,
  /100%\s*(profit|return|gain)/i,
  /\bscam\b/i,
];

const SCAM_DOMAIN_PATTERNS = [
  /freeclaim\./i,
  /wallet-connect\./i,
  /connect-wallet\./i,
  /airdrop-/i,
  /claim-/i,
  /-airdrop\./i,
  /-claim\./i,
  /ton-gift\./i,
  /ton-free\./i,
  /telegram-gift\./i,
];

const SCAM_CONTENT_PATTERNS = [
  /send\s+\d+\s+(ton|btc|eth|usdt|usdc)\s+.*(get|receive|back|double)/i,
  /double\s+your\s+(ton|btc|eth|crypto)/i,
  /private\s+key\s*[:=]/i,
  /seed\s*phrase\s*[:=]/i,
  /enter\s+your\s+(seed|mnemonic|private)/i,
];

export interface SafetyResult {
  safe: boolean;
  status: "ok" | "flagged" | "rejected";
  removedLinks: string[];
  warnings: string[];
  isScam: boolean;
}

function extractLinks(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"]+|t\.me\/[^\s<>"]+/gi;
  return text.match(urlRegex) ?? [];
}

function isScamDomain(url: string): boolean {
  return SCAM_DOMAIN_PATTERNS.some((p) => p.test(url));
}

function isSuspiciousLink(url: string): boolean {
  return SUSPICIOUS_PATTERNS.some((p) => p.test(url)) || isScamDomain(url);
}

export function checkSafety(content: string): SafetyResult {
  const removedLinks: string[] = [];
  const warnings: string[] = [];
  let processedContent = content;
  let isScam = false;

  for (const pattern of SCAM_CONTENT_PATTERNS) {
    if (pattern.test(content)) {
      isScam = true;
      warnings.push(`Scam pattern detected: content matches known fraud template`);
      logger.warn({ pattern: pattern.toString() }, "Scam content pattern detected");
    }
  }

  const links = extractLinks(content);
  for (const link of links) {
    if (isScamDomain(link)) {
      isScam = true;
      removedLinks.push(link);
      warnings.push(`Scam domain removed: ${link}`);
      processedContent = processedContent.replace(link, "[ссылка удалена]");
    } else if (isSuspiciousLink(link)) {
      removedLinks.push(link);
      warnings.push(`Suspicious link removed: ${link}`);
      processedContent = processedContent.replace(link, "[ссылка удалена]");
    }
  }

  if (isScam) {
    return {
      safe: false,
      status: "rejected",
      removedLinks,
      warnings,
      isScam: true,
    };
  }

  if (removedLinks.length > 0) {
    return {
      safe: true,
      status: "flagged",
      removedLinks,
      warnings,
      isScam: false,
    };
  }

  return {
    safe: true,
    status: "ok",
    removedLinks: [],
    warnings: [],
    isScam: false,
  };
}

export function cleanContent(content: string, safetyResult: SafetyResult): string {
  if (safetyResult.removedLinks.length === 0) return content;
  let cleaned = content;
  for (const link of safetyResult.removedLinks) {
    cleaned = cleaned.replace(link, "[ссылка удалена]");
  }
  return cleaned;
}
