import { createHash } from "crypto";
import { createRequire } from "node:module";
import { logger } from "./logger";
import type { SourcePost } from "./sources";

// Load gramjs as CJS via require — avoids ESM/CJS interop issues with esbuild
const _req = createRequire(import.meta.url);

function loadGram() {
  const gram = _req("telegram") as typeof import("telegram");
  const sessions = _req("telegram/sessions") as { StringSession: new (s?: string) => unknown };
  return { TelegramClient: gram.TelegramClient, StringSession: sessions.StringSession };
}

// Gramjs client singleton — connects once, stays alive
let clientInstance: unknown = null;
let clientConnected = false;

function isSessionConfigured(): boolean {
  return Boolean(
    process.env.TELEGRAM_STRING_SESSION &&
    process.env.TELEGRAM_API_ID &&
    process.env.TELEGRAM_API_HASH,
  );
}

export function isTelegramReaderAvailable(): boolean {
  return isSessionConfigured();
}

async function getClient(): Promise<import("telegram").TelegramClient | null> {
  if (!isSessionConfigured()) return null;

  if (clientConnected && clientInstance) {
    return clientInstance as import("telegram").TelegramClient;
  }

  try {
    const { TelegramClient, StringSession } = loadGram();

    const apiId = parseInt(process.env.TELEGRAM_API_ID!, 10);
    const apiHash = process.env.TELEGRAM_API_HASH!;
    const session = new (StringSession as new (s?: string) => unknown)(process.env.TELEGRAM_STRING_SESSION!);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new TelegramClient(session as any, apiId, apiHash, {
      connectionRetries: 3, autoReconnect: true, maxConcurrentDownloads: 2,
    });

    await client.connect();
    clientInstance = client;
    clientConnected = true;
    logger.info("Telegram MTProto client connected");
    return client;
  } catch (err) {
    logger.error({ err }, "Failed to connect Telegram MTProto client");
    clientConnected = false;
    clientInstance = null;
    return null;
  }
}

const RELEVANT_KEYWORDS = [
  "ton", "the open network", "toncoin",
  "telegram gifts", "gifts", "telegram stars", "stars", "fragment",
  "telegram wallet", "telegram mini app", "durov", "pavel durov",
  "btc", "bitcoin", "eth", "ethereum",
  "crypto", "blockchain", "defi", "nft", "airdrop", "etf",
  "stablecoin", "usdt", "usdc", "exchange", "binance", "coinbase",
  "regulation", "sec", "hack", "exploit", "layer 2", "solana",
];

function scoreText(text: string): number {
  const lower = text.toLowerCase();
  return RELEVANT_KEYWORDS.filter((kw) => lower.includes(kw)).length;
}

function hasPhotoMedia(msg: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const media = (msg as any)?.media;
  if (!media) return false;
  const cls = media.className as string | undefined;
  return cls === "MessageMediaPhoto" || Boolean(media.photo);
}

async function downloadPhoto(
  client: import("telegram").TelegramClient,
  msg: unknown,
  channelName: string,
): Promise<Buffer | undefined> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.downloadMedia(msg as any, {});
    if (!result) return undefined;
    if (Buffer.isBuffer(result)) return result;
    // gramjs may return Uint8Array on some platforms
    if (result && typeof result === "object" && "length" in result) return Buffer.from(result as Uint8Array);
    return undefined;
  } catch (err) {
    logger.warn({ err, channel: channelName }, "Failed to download photo from Telegram message");
    return undefined;
  }
}

export async function fetchTelegramChannelPosts(
  channels: { name: string; url: string }[],
  lookbackHours = 72,
): Promise<SourcePost[]> {
  const client = await getClient();
  if (!client) {
    logger.warn("Telegram MTProto client unavailable — skipping channel read");
    return [];
  }

  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
  const all: SourcePost[] = [];

  const results = await Promise.allSettled(
    channels.map(async (ch) => {
      // Normalise: "@username", "https://t.me/username", "t.me/username" → "username"
      const username = ch.url
        .replace(/^https?:\/\//i, "")
        .replace(/^t\.me\//i, "")
        .replace(/^@/, "")
        .split("/")[0]
        .trim();
      const messages = await client.getMessages(username, { limit: 50 });
      logger.info({ channel: ch.name, username, count: messages.length }, "Fetched messages from Telegram channel");

      const posts: SourcePost[] = [];
      for (const msg of messages) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msgAny = msg as any;
        const text = (msgAny.message ?? "") as string;
        // Accept posts with photo even if text is short (caption may be brief)
        const hasPhoto = hasPhotoMedia(msg);
        if (!text || (text.trim().length < 30 && !hasPhoto)) continue;

        const date = new Date((msgAny.date ?? 0) * 1000);
        if (date < cutoff) continue;

        const score = scoreText(text);
        // Skip completely irrelevant text-only posts, but keep photo posts
        if (score === 0 && !hasPhoto) continue;

        const fullText = text.slice(0, 1200);
        const textHash = createHash("sha256")
          .update((fullText || username + msgAny.id).slice(0, 500))
          .digest("hex")
          .slice(0, 16);

        const msgId = (msgAny.id ?? 0) as number;
        const link = `https://t.me/${username}/${msgId}`;

        // Download photo if present
        let mediaBuffer: Buffer | undefined;
        let mediaType: "photo" | "none" = "none";
        if (hasPhoto) {
          mediaBuffer = await downloadPhoto(client, msg, ch.name);
          if (mediaBuffer) {
            mediaType = "photo";
            logger.info({ channel: ch.name, msgId, bytes: mediaBuffer.length }, "Downloaded photo from Telegram post");
          }
        }

        posts.push({
          title: text.split("\n")[0].slice(0, 100),
          description: text.slice(0, 800),
          fullText,
          link,
          pubDate: date,
          channel: ch.name,
          channelUrl: ch.url,
          textHash,
          preview: fullText.slice(0, 450),
          relevanceScore: score,
          mediaType,
          mediaBuffer,
        });
      }
      return posts;
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      all.push(...r.value);
    } else {
      logger.warn({ err: r.reason, channel: channels[i].name }, "Telegram channel read failed");
    }
  }

  return all.filter((p) => p.relevanceScore > 0 || p.mediaType === "photo");
}

export async function disconnectTelegramClient(): Promise<void> {
  if (clientInstance && clientConnected) {
    try {
      await (clientInstance as import("telegram").TelegramClient).disconnect();
    } catch {
      // ignore
    }
    clientInstance = null;
    clientConnected = false;
  }
}
