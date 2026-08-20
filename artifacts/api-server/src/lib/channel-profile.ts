export type ChannelProfile = "business" | "crypto";

/**
 * The default deliberately preserves the legacy/business behavior. PANKOFF
 * enables its editorial rules explicitly with CHANNEL_PROFILE=crypto.
 */
export function getChannelProfile(): ChannelProfile {
  const value = process.env.CHANNEL_PROFILE?.trim().toLowerCase();
  return value === "crypto" || value === "pankoff_crypto" ? "crypto" : "business";
}

export function isCryptoProfile(): boolean {
  return getChannelProfile() === "crypto";
}

export const PANKOFF_CRYPTO_DEFAULT_SOURCES = [
  { name: "Bitcoin Magazine", url: "@BitcoinMagazine", type: "telegram_channel", isPrimary: true, category: "Bitcoin" },
  { name: "Cointelegraph", url: "@cointelegraph", type: "telegram_channel", isPrimary: true, category: "Crypto news" },
  { name: "Wu Blockchain", url: "@WuBlockchain", type: "telegram_channel", isPrimary: true, category: "Market and regulation" },
  { name: "TON Blockchain", url: "@ton_blockchain", type: "telegram_channel", isPrimary: true, category: "TON" },
  { name: "Telegram", url: "@telegram", type: "telegram_channel", isPrimary: true, category: "Telegram" },
];