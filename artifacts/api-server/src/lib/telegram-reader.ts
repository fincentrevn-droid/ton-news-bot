import { createHash } from "crypto";
import { createRequire } from "node:module";
import { logger } from "./logger";
import type { SourcePost } from "./sources";
import {
  hasHighRiskRegulatoryClaim,
  isHardBlockedSource,
  MIN_BUSINESS_RELEVANCE_SCORE,
  scoreBusinessRelevance,
} from "./business-filter";
import { getContentProfile } from "../config/content-profile";

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
const contentProfile = getContentProfile();

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

function scoreText(text: string): number {
  return scoreBusinessRelevance(text);
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
  channels: { name: string; url: string; isPrimary?: boolean }[],
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

        if (isHardBlockedSource(text)) continue;
        if (!ch.isPrimary && hasHighRiskRegulatoryClaim(text)) continue;
        const score = scoreText(text);
        // A photo never overrides relevance: hard filters apply to every source post.
        if (score < (ch.isPrimary ? 1 : MIN_BUSINESS_RELEVANCE_SCORE)) continue;

        const fullText = text.slice(0, 1200);
        const textHash = createHash("sha256")
          .update((fullText || username + msgAny.id).slice(0, 500))
          .digest("hex")
          .slice(0, 16);

        const msgId = (msgAny.id ?? 0) as number;
        const link = `https://t.me/${username}/${msgId}`;

        // PANKOFF CRYPTO keeps the existing eager download behaviour. For
        // FINCENTRE BUSINESS the selected photo is downloaded later and must
        // pass the local safety scan before it can be attached.
        let mediaBuffer: Buffer | undefined;
        let mediaLoader: (() => Promise<Buffer | undefined>) | undefined;
        let mediaType: "photo" | "none" = "none";
        if (hasPhoto && process.env.ENABLE_MEDIA_DOWNLOAD === "true") {
          if (contentProfile.id === "business") {
            mediaType = "photo";
            let downloadPromise: Promise<Buffer | undefined> | null = null;
            mediaLoader = () => {
              downloadPromise ??= downloadPhoto(client, msg, ch.name).then((buffer) => {
                if (buffer) {
                  logger.info(
                    { channel: ch.name, msgId, bytes: buffer.length },
                    "Downloaded selected business photo for safety scan",
                  );
                }
                return buffer;
              });
              return downloadPromise;
            };
          } else {
            mediaBuffer = await downloadPhoto(client, msg, ch.name);
            if (mediaBuffer) {
              mediaType = "photo";
              logger.info({ channel: ch.name, msgId, bytes: mediaBuffer.length }, "Downloaded photo from Telegram post");
            }
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
          isPrimarySource: Boolean(ch.isPrimary),
          mediaType,
          mediaBuffer,
          mediaLoader,
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

  return all.filter(
    (p) => p.relevanceScore >= (p.isPrimarySource ? 1 : MIN_BUSINESS_RELEVANCE_SCORE),
  );
}

export interface ChannelStatsResult {
  subscribersCount: number | null;
  avgViews: number | null;
  avgComments: number | null;
  totalForwards: number | null;
  postsLast24h: number;
}

export async function getChannelStats(): Promise<ChannelStatsResult | null> {
  const client = await getClient();
  if (!client) return null;

  const rawId = process.env.TELEGRAM_CHANNEL_ID;
  if (!rawId) return null;

  const gram = _req("telegram") as typeof import("telegram");

  // Resolve either a public @username or a Bot API numeric channel ID.
  let entity: unknown;
  try {
    if (rawId.startsWith("@") || rawId.includes("t.me/")) {
      entity = await client.getEntity(rawId);
    } else {
      const numericStr = rawId.startsWith("-100")
        ? rawId.slice(4)
        : rawId.replace("-", "");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const peer = new gram.Api.PeerChannel({ channelId: BigInt(numericStr) as any });
      entity = await client.getEntity(peer);
    }
  } catch (err) {
    logger.warn({ err, rawId }, "getChannelStats: could not resolve channel entity");
    return null;
  }

  // Get subscriber count via full channel info
  let subscribersCount: number | null = null;
  try {
    const full = await client.invoke(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new gram.Api.channels.GetFullChannel({ channel: entity as any }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subscribersCount = (full as any).fullChat?.participantsCount ?? null;
  } catch (err) {
    logger.warn({ err }, "getChannelStats: GetFullChannel failed");
  }

  // Get recent messages for engagement stats (last 24h of our own channel posts)
  const cutoffSec = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  let avgViews: number | null = null;
  let avgComments: number | null = null;
  let totalForwards: number | null = null;
  let postsLast24h = 0;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = await client.getMessages(entity as any, { limit: 100 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recent = (messages as any[]).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (m: any) => m.date >= cutoffSec && m.message != null,
    );
    postsLast24h = recent.length;

    if (recent.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const views = recent.map((m: any) => m.views ?? 0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const comments = recent.map((m: any) => m.replies?.replies ?? 0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const forwards = recent.map((m: any) => m.forwards ?? 0);
      const avg = (arr: number[]) =>
        Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
      avgViews = avg(views);
      avgComments = avg(comments);
      totalForwards = forwards.reduce((a, b) => a + b, 0);
    }
  } catch (err) {
    logger.warn({ err }, "getChannelStats: getMessages failed");
  }

  return { subscribersCount, avgViews, avgComments, totalForwards, postsLast24h };
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
