import { readFile, writeFile } from "node:fs/promises";

const profile = (process.env.CHANNEL_PROFILE ?? process.env.CONTENT_PROFILE ?? "business")
  .trim()
  .toLowerCase();
if (profile === "crypto" || profile === "pankoff_crypto") process.exit(0);

async function patch(path, transform, label) {
  const source = await readFile(path, "utf8");
  const next = transform(source);
  if (next === source) {
    console.log(`${label}: already applied`);
    return;
  }
  await writeFile(path, next);
  console.log(label);
}

// Keep one first-party Ukrainian RSS source in the pool even if the Telegram
// reader session is unavailable or returns only items that later fail editorial
// QC. The Cabinet of Ministers exposes this feed publicly at /api/rss.
await patch(
  "artifacts/api-server/src/index.ts",
  (input) => {
    if (input.includes("https://www.kmu.gov.ua/api/rss")) return input;
    const marker = "const BUSINESS_DEFAULT_SOURCES = [\n";
    if (!input.includes(marker)) throw new Error("BUSINESS_DEFAULT_SOURCES marker not found");
    return input.replace(
      marker,
      `${marker}  { name: "Кабінет Міністрів України", url: "https://www.kmu.gov.ua/api/rss", type: "rss", isPrimary: true, category: "Бізнес і регулювання" },\n`,
    );
  },
  "Added official Cabinet of Ministers RSS fallback for FINCENTRE",
);

// Business must continuously combine Telegram and RSS candidates. Previously
// RSS was only an emergency fallback when Telegram returned exactly zero items;
// a few irrelevant Telegram posts could therefore suppress all RSS candidates.
await patch(
  "artifacts/api-server/src/lib/sources.ts",
  (input) => {
    if (input.includes("FINCENTRE_ALWAYS_USE_RSS")) return input;
    const old = `async function fetchRssPosts(): Promise<SourcePost[]> {\n  // Secondary (RSS) sources are OFF by default — enabled only when ENABLE_SECONDARY_SOURCES=true\n  if (process.env.ENABLE_SECONDARY_SOURCES !== "true") return [];`;
    const replacement = `async function fetchRssPosts(): Promise<SourcePost[]> {\n  // FINCENTRE_ALWAYS_USE_RSS: business runs unattended and must keep a second\n  // independent source transport. Crypto preserves the existing opt-in behavior.\n  const businessProfile = getContentProfile().id === "business";\n  if (!businessProfile && process.env.ENABLE_SECONDARY_SOURCES !== "true") return [];`;
    if (!input.includes(old)) throw new Error("RSS enable gate not found");
    return input.replace(old, replacement);
  },
  "Made FINCENTRE consume RSS alongside Telegram sources",
);

// Add explicit reasons to scheduler logs when a business service is configured
// but cannot generate/publish. This turns silent 0-post days into actionable logs.
await patch(
  "artifacts/api-server/src/lib/scheduler.ts",
  (input) => {
    if (input.includes("FINCENTRE_SCHEDULER_STATE_LOG")) return input;
    const old = `    if (!schedule) return;\n    if (!schedule.enabled || !schedule.autoPublish) return;`;
    const replacement = `    if (!schedule) {\n      logger.error("FINCENTRE_SCHEDULER_STATE_LOG: schedule row is missing");\n      return;\n    }\n    if (!schedule.enabled || !schedule.autoPublish) {\n      logger.warn(\n        { enabled: schedule.enabled, autoPublish: schedule.autoPublish },\n        "FINCENTRE_SCHEDULER_STATE_LOG: scheduler disabled; no post can be published",\n      );\n      return;\n    }`;
    if (!input.includes(old)) throw new Error("scheduler state gate not found");
    return input.replace(old, replacement);
  },
  "Added FINCENTRE scheduler state diagnostics",
);

console.log("FINCENTRE unattended autopost v4 hardening complete");
