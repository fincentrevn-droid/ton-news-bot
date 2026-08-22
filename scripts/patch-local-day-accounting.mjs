import { readFile, writeFile } from "node:fs/promises";

async function patch(path, transform, label) {
  const source = await readFile(path, "utf8");
  const next = transform(source);
  if (next !== source) {
    await writeFile(path, next);
    console.log(label);
  } else {
    console.log(`${label}: already applied`);
  }
}

// AI usage must roll over at the same local midnight as posting/news freshness.
// The old toISOString() implementation used UTC, so from 00:00 to 02:59 Kyiv
// the new local day was still charged against yesterday's counters.
await patch(
  "artifacts/api-server/src/lib/openai.ts",
  (input) => {
    if (input.includes("LOCAL_AI_USAGE_DAY")) return input;
    const oldBlock = `function todayDate(): string {\n  return new Date().toISOString().split("T")[0];\n}`;
    const newBlock = `// LOCAL_AI_USAGE_DAY: align daily AI budgets with the posting timezone.\nfunction todayDate(): string {\n  const requestedTimezone = process.env.POSTING_TIMEZONE?.trim() || "Europe/Kyiv";\n  let parts: Intl.DateTimeFormatPart[];\n  try {\n    parts = new Intl.DateTimeFormat("en-US", {\n      timeZone: requestedTimezone,\n      year: "numeric",\n      month: "2-digit",\n      day: "2-digit",\n    }).formatToParts(new Date());\n  } catch {\n    parts = new Intl.DateTimeFormat("en-US", {\n      timeZone: "Europe/Kyiv",\n      year: "numeric",\n      month: "2-digit",\n      day: "2-digit",\n    }).formatToParts(new Date());\n  }\n  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";\n  return \`${'${value("year")}'}-${'${value("month")}'}-${'${value("day")}'}\`;\n}`;
    if (!input.includes(oldBlock)) throw new Error("UTC todayDate block not found");
    return input.replace(oldBlock, newBlock);
  },
  "Aligned AI daily counters to Europe/Kyiv posting day",
);

// A persisted value of 8 generated posts/day is not enough for a channel that
// targets up to 8 PUBLIC posts/day because QC rejects and rewrites also consume
// generated-post headroom. Upgrade only that legacy-small crypto value. The
// public scheduler maxPostsPerDay remains unchanged.
await patch(
  "artifacts/api-server/src/lib/runtime-schedule.ts",
  (input) => {
    if (input.includes("CRYPTO_GENERATED_BUDGET_SELF_HEAL")) return input;
    const oldBlock = `    if (explicitMaxGeneratedPosts !== undefined) {\n      settingsUpdates.maxPostsPerDay = explicitMaxGeneratedPosts;\n    } else if (settings.maxPostsPerDay <= 6) {\n      settingsUpdates.maxPostsPerDay = recommendedGeneratedPosts;\n    }`;
    const newBlock = `    if (explicitMaxGeneratedPosts !== undefined) {\n      settingsUpdates.maxPostsPerDay = explicitMaxGeneratedPosts;\n    } else {\n      // CRYPTO_GENERATED_BUDGET_SELF_HEAL: 8 was historically used as both the\n      // public publish cap and the internal generation cap. They are different:\n      // rejected/QC-failed candidates need extra internal headroom.\n      const legacyGeneratedPostCeiling = profile === "crypto" ? 8 : 6;\n      if (settings.maxPostsPerDay <= legacyGeneratedPostCeiling) {\n        settingsUpdates.maxPostsPerDay = recommendedGeneratedPosts;\n      }\n    }`;
    if (!input.includes(oldBlock)) throw new Error("generated-post budget self-heal block not found");
    return input.replace(oldBlock, newBlock);
  },
  "Upgraded legacy PANKOFF 8/day generated-post budget to 12",
);

console.log("Local-day accounting hardening complete");
