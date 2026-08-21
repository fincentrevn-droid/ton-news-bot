import { readFile, writeFile } from "node:fs/promises";

const profile = (process.env.CHANNEL_PROFILE ?? process.env.CONTENT_PROFILE ?? "")
  .trim()
  .toLowerCase();

if (profile === "crypto" || profile === "pankoff_crypto") process.exit(0);

async function patch(path, transform, label) {
  const source = await readFile(path, "utf8");
  const next = transform(source);
  if (next === source) {
    console.log(`No change needed: ${label}`);
    return;
  }
  await writeFile(path, next);
  console.log(label);
}

await patch(
  "artifacts/api-server/src/lib/business-filter.ts",
  (input) => input.replace(
    "export const MIN_BUSINESS_RELEVANCE_SCORE = 2;",
    "export const MIN_BUSINESS_RELEVANCE_SCORE = 1;",
  ),
  "Relaxed FINCENTRE minimum business relevance score",
);

await patch(
  "artifacts/api-server/src/lib/telegram-reader.ts",
  (input) => {
    const oldBlock = `        if (isHardBlockedSource(text)) continue;\n        if (!ch.isPrimary && hasHighRiskRegulatoryClaim(text)) continue;\n        const score = scoreText(text);\n        // A photo never overrides relevance: hard filters apply to every source post.\n        if (score < (ch.isPrimary ? 1 : MIN_BUSINESS_RELEVANCE_SCORE)) continue;`;
    const newBlock = `        if (isHardBlockedSource(text)) continue;\n        const score = scoreText(text);\n        // User-configured FINCENTRE sources are curated. Non-primary regulatory\n        // stories are allowed when they have strong business relevance instead\n        // of being discarded outright. Promo/crypto hard blocks still apply.\n        if (score < (ch.isPrimary ? 1 : MIN_BUSINESS_RELEVANCE_SCORE)) continue;\n        if (!ch.isPrimary && hasHighRiskRegulatoryClaim(text) && score < 2) continue;`;
    if (!input.includes(oldBlock)) throw new Error("FINCENTRE Telegram regulatory gate block not found");
    return input.replace(oldBlock, newBlock);
  },
  "Hardened FINCENTRE Telegram regulatory relevance gate",
);

await patch(
  "artifacts/api-server/src/lib/sources.ts",
  (input) => {
    let s = input;
    const oldRss = `        if (isHardBlockedSource(post.fullText)) continue;\n        if (!post.isPrimarySource && hasHighRiskRegulatoryClaim(post.fullText)) continue;\n        all.push({ ...post, relevanceScore: scoreRelevance(post) });`;
    const newRss = `        if (isHardBlockedSource(post.fullText)) continue;\n        const score = scoreRelevance(post);\n        if (score < (post.isPrimarySource ? 1 : MIN_BUSINESS_RELEVANCE_SCORE)) continue;\n        if (!post.isPrimarySource && hasHighRiskRegulatoryClaim(post.fullText) && score < 2) continue;\n        all.push({ ...post, relevanceScore: score });`;
    if (!s.includes(oldRss)) throw new Error("FINCENTRE RSS regulatory gate block not found");
    s = s.replace(oldRss, newRss);

    const oldEmergency = `              if (isHardBlockedSource(p.fullText)) continue;\n              if (!p.isPrimarySource && hasHighRiskRegulatoryClaim(p.fullText)) continue;\n              const score = scoreRelevance(p);\n              if (\n                score >= (p.isPrimarySource ? 1 : MIN_BUSINESS_RELEVANCE_SCORE) &&\n                p.pubDate >= cutoff\n              ) {`;
    const newEmergency = `              if (isHardBlockedSource(p.fullText)) continue;\n              const score = scoreRelevance(p);\n              const regulatoryOk = p.isPrimarySource || !hasHighRiskRegulatoryClaim(p.fullText) || score >= 2;\n              if (\n                score >= (p.isPrimarySource ? 1 : MIN_BUSINESS_RELEVANCE_SCORE) &&\n                regulatoryOk &&\n                p.pubDate >= cutoff\n              ) {`;
    if (!s.includes(oldEmergency)) throw new Error("FINCENTRE emergency RSS regulatory gate block not found");
    return s.replace(oldEmergency, newEmergency);
  },
  "Hardened FINCENTRE RSS regulatory relevance gates",
);

await patch(
  "artifacts/api-server/src/lib/auto-generate.ts",
  (input) => {
    let s = input;

    const marker = "const silentNotify: NotifyFn = async (_msg) => { /* no-op */ };";
    if (!s.includes("FINCENTRE_NO_POST_TTL_MS")) {
      if (!s.includes(marker)) throw new Error("silentNotify marker not found");
      s = s.replace(
        marker,
        `${marker}\n\n// FINCENTRE anti-stall memory: an AI-rejected source should not be retried on\n// every scheduler cycle. This rotates the candidate pool without persisting\n// editorial rejections forever.\nconst FINCENTRE_NO_POST_TTL_MS = 6 * 60 * 60 * 1000;\nconst fincentreNoPostUntil = new Map<string, number>();`,
      );
    }

    const oldRecent = `  // Avoid re-using source posts from the last 7 days\n  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);\n  const recentHashes = await db\n    .select({ hash: postsTable.sourceTextHash })\n    .from(postsTable)\n    .where(and(gte(postsTable.createdAt, sevenDaysAgo), eq(postsTable.generatedFromSource, true)));\n\n  const usedHashes = new Set(recentHashes.map((r) => r.hash).filter(Boolean));\n\n  const candidates = sourcePosts.filter((p) => !usedHashes.has(p.textHash));\n  // Legacy behavior deliberately keeps its reuse fallback. PANKOFF must never\n  // fill the feed with a duplicate if there is no fresh, unprocessed fact.\n  if (candidates.length === 0 && !cryptoProfile) candidates.push(...sourcePosts);`;
    const newRecent = `  // Avoid re-using published source posts from the last 7 days. FINCENTRE\n  // drafts/rejections must not block the entire source pool for a week.\n  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);\n  const recentHashes = cryptoProfile\n    ? await db\n      .select({ hash: postsTable.sourceTextHash })\n      .from(postsTable)\n      .where(and(gte(postsTable.createdAt, sevenDaysAgo), eq(postsTable.generatedFromSource, true)))\n    : await db\n      .select({ hash: postsTable.sourceTextHash })\n      .from(postsTable)\n      .where(and(\n        gte(postsTable.createdAt, sevenDaysAgo),\n        eq(postsTable.generatedFromSource, true),\n        eq(postsTable.status, "published"),\n      ));\n\n  const usedHashes = new Set(recentHashes.map((r) => r.hash).filter(Boolean));\n  const nowMs = Date.now();\n  const candidates = sourcePosts.filter((p) =>\n    !usedHashes.has(p.textHash) &&\n    (cryptoProfile || (fincentreNoPostUntil.get(p.textHash) ?? 0) <= nowMs),\n  );`;
    if (!s.includes(oldRecent)) throw new Error("FINCENTRE candidate filter block not found");
    s = s.replace(oldRecent, newRecent);

    s = s.replace(
      "  for (let attempt = 0; attempt < Math.min(candidates.length, 5); attempt++) {",
      "  const maxSourceAttempts = cryptoProfile ? 5 : Math.min(candidates.length, 10);\n  for (let attempt = 0; attempt < maxSourceAttempts; attempt++) {",
    );

    const oldNoPost = `      if (err instanceof Error && err.message === "NO_POST") {\n        logger.info({ channel: candidate.channel }, "Source returned NO_POST — trying next");\n        skippedHashes.add(candidate.textHash);\n        continue;\n      }`;
    const newNoPost = `      if (err instanceof Error && err.message === "NO_POST") {\n        logger.info({ channel: candidate.channel }, "Source returned NO_POST — trying next");\n        if (!cryptoProfile) {\n          fincentreNoPostUntil.set(candidate.textHash, Date.now() + FINCENTRE_NO_POST_TTL_MS);\n        }\n        skippedHashes.add(candidate.textHash);\n        continue;\n      }`;
    if (!s.includes(oldNoPost)) throw new Error("NO_POST handler not found");
    s = s.replace(oldNoPost, newNoPost);

    return s;
  },
  "Restored FINCENTRE anti-stall source rotation",
);

await patch(
  "artifacts/api-server/src/index.ts",
  (input) => {
    const oldDefaults = `const BUSINESS_DEFAULT_SOURCES = [\n  { name: "TON Blockchain", url: "@ton_blockchain", type: "telegram_channel", isPrimary: true,  category: "TON" },\n  { name: "TON Community",  url: "@toncoin",        type: "telegram_channel", isPrimary: true,  category: "TON" },\n  { name: "Durov",          url: "@durov",          type: "telegram_channel", isPrimary: true,  category: "Telegram" },\n];`;
    const newDefaults = `const BUSINESS_DEFAULT_SOURCES = [\n  { name: "Державна податкова служба України", url: "@tax_gov_ua", type: "telegram_channel", isPrimary: true, category: "Податки" },\n  { name: "Національний банк України", url: "@nbu_ua", type: "telegram_channel", isPrimary: true, category: "Фінанси" },\n];`;
    if (!input.includes(oldDefaults)) throw new Error("Incorrect FINCENTRE fallback sources block not found");
    return input.replace(oldDefaults, newDefaults);
  },
  "Replaced incorrect FINCENTRE crypto fallback sources",
);

console.log("FINCENTRE BUSINESS anti-stall patch applied");
