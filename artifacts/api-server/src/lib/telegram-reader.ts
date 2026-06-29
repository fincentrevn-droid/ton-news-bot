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
      connectionRetries: 3, autoReconnect: true, maxConcurrentDownloads: 1,
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

export async function fetchTelegramChannelPosts(
  channels: { name: string; url: string }[],
  lookbackHours = 24,
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
      const username = ch.url.replace(/^@/, "");
      const messages = await client.getMessages(username, { limit: 20 });

      const posts: SourcePost[] = [];
      for (const msg of messages) {
        const text = (msg as { message?: string }).message;
        if (!text || text.trim().length < 30) continue;

        const date = new Date(((msg as { date?: number }).date ?? 0) * 1000);
        if (date < cutoff) continue;

        const score = scoreText(text);
        const fullText = text.slice(0, 1200);
        const textHash = createHash("sha256")
          .update(fullText.slice(0, 500))
          .digest("hex")
          .slice(0, 16);

        const msgId = (msg as { id?: number }).id ?? 0;
        const link = `https://t.me/${username}/${msgId}`;

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

  return all.filter((p) => p.relevanceScore > 0);
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
