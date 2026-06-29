import { createHash } from "crypto";
import { db, sourcesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { fetchTelegramChannelPosts, isTelegramReaderAvailable } from "./telegram-reader";

export interface SourcePost {
  title: string;
  description: string;
  fullText: string;
  link: string;
  pubDate: Date;
  channel: string;
  channelUrl: string;
  textHash: string;
  preview: string;
  relevanceScore: number;
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

function extractTag(xml: string, tag: string): string {
  const pattern = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    "i",
  );
  const match = xml.match(pattern);
  if (!match) return "";
  let val = match[1].trim();
  val = val.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  return val;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLink(itemXml: string): string {
  const standard = extractTag(itemXml, "link");
  if (standard) return standard.trim().replace(/\s+/g, "");
  const atomMatch = itemXml.match(/<link[^>]+href=["']([^"']+)["']/i);
  return atomMatch?.[1] ?? "";
}

function parseItems(
  xml: string,
  sourceName: string,
  sourceUrl: string,
): Omit<SourcePost, "relevanceScore">[] {
  const items: Omit<SourcePost, "relevanceScore">[] = [];
  const matches = xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi);

  for (const [, itemXml] of matches) {
    const title = stripHtml(extractTag(itemXml, "title"));
    const rawDesc =
      extractTag(itemXml, "content:encoded") ||
      extractTag(itemXml, "description");
    const description = stripHtml(rawDesc).slice(0, 800);
    const link = extractLink(itemXml);
    const pubDateStr =
      extractTag(itemXml, "pubDate") || extractTag(itemXml, "dc:date");

    if (!title && !description) continue;

    const pubDate = pubDateStr ? new Date(pubDateStr) : new Date();
    if (isNaN(pubDate.getTime())) continue;

    const fullText = [title, description].filter(Boolean).join("\n\n");
    const textHash = createHash("sha256")
      .update(fullText.slice(0, 500))
      .digest("hex")
      .slice(0, 16);
    const preview = fullText.slice(0, 450);

    items.push({
      title,
      description,
      fullText,
      link,
      pubDate,
      channel: sourceName,
      channelUrl: sourceUrl,
      textHash,
      preview,
    });
  }

  return items;
}

function scoreRelevance(post: Omit<SourcePost, "relevanceScore">): number {
  const text = `${post.title} ${post.description}`.toLowerCase();
  return RELEVANT_KEYWORDS.filter((kw) => text.includes(kw)).length;
}

async function fetchRssPosts(): Promise<SourcePost[]> {
  // Secondary (RSS) sources are OFF by default — enabled only when ENABLE_SECONDARY_SOURCES=true
  if (process.env.ENABLE_SECONDARY_SOURCES !== "true") return [];

  const sources = await db
    .select()
    .from(sourcesTable)
    .where(and(eq(sourcesTable.enabled, true), eq(sourcesTable.type, "rss")));

  if (sources.length === 0) return [];

  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const all: SourcePost[] = [];

  const results = await Promise.allSettled(
    sources.map(async (src) => {
      const res = await fetch(src.url, {
        signal: AbortSignal.timeout(12_000),
        headers: { "User-Agent": "TONNewsBot/1.0 RSS Reader" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      return parseItems(xml, src.name, src.url);
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      for (const post of r.value) {
        all.push({ ...post, relevanceScore: scoreRelevance(post) });
      }
    } else {
      logger.warn({ err: r.reason, source: sources[i].name }, "RSS fetch failed");
    }
  }

  return all.filter((p) => p.relevanceScore > 0 && p.pubDate >= cutoff);
}

async function fetchTelegramPosts(): Promise<SourcePost[]> {
  if (!isTelegramReaderAvailable()) return [];

  const channels = await db
    .select()
    .from(sourcesTable)
    .where(
      and(
        eq(sourcesTable.enabled, true),
        eq(sourcesTable.type, "telegram_channel"),
      ),
    );

  if (channels.length === 0) return [];

  return fetchTelegramChannelPosts(
    channels.map((c) => ({ name: c.name, url: c.url })),
  );
}

export async function fetchSourcePosts(): Promise<SourcePost[]> {
  const [rssPosts, tgPosts] = await Promise.allSettled([
    fetchRssPosts(),
    fetchTelegramPosts(),
  ]);

  const all: SourcePost[] = [
    ...(rssPosts.status === "fulfilled" ? rssPosts.value : []),
    ...(tgPosts.status === "fulfilled" ? tgPosts.value : []),
  ];

  if (rssPosts.status === "rejected") {
    logger.warn({ err: rssPosts.reason }, "RSS fetch pipeline failed");
  }
  if (tgPosts.status === "rejected") {
    logger.warn({ err: tgPosts.reason }, "Telegram channel fetch pipeline failed");
  }

  if (all.length === 0) {
    logger.warn("No source posts found from any source");
    return [];
  }

  // Telegram posts (primary) get a +3 relevance boost
  const boosted = all.map((p) =>
    p.channelUrl.startsWith("@")
      ? { ...p, relevanceScore: p.relevanceScore + 3 }
      : p,
  );

  const sorted = boosted.sort(
    (a, b) =>
      b.relevanceScore - a.relevanceScore ||
      b.pubDate.getTime() - a.pubDate.getTime(),
  );

  return sorted.slice(0, 15);
}
