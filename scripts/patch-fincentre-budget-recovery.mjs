import { readFile, writeFile } from "node:fs/promises";

const profile = (process.env.CHANNEL_PROFILE ?? process.env.CONTENT_PROFILE ?? "business")
  .trim()
  .toLowerCase();
if (profile === "crypto" || profile === "pankoff_crypto") process.exit(0);

const path = "artifacts/api-server/src/lib/runtime-schedule.ts";
let source = await readFile(path, "utf8");

if (source.includes("FINCENTRE_LEGACY_AI_BUDGET_RECOVERY")) {
  console.log("FINCENTRE legacy AI budget recovery already applied");
  process.exit(0);
}

const declaration = `  const explicitMaxAiCalls = envInt("MAX_AI_CALLS_PER_DAY", "AI_MAX_CALLS_PER_DAY");`;
if (!source.includes(declaration)) {
  throw new Error("MAX_AI_CALLS_PER_DAY declaration not found");
}
source = source.replace(
  declaration,
  `${declaration}\n  // FINCENTRE_LEGACY_AI_BUDGET_RECOVERY: the old production template used 12\n  // calls/day. Generation + QC + occasional rewrites can consume that before\n  // the public channel reaches its daily posting target. Treat only that legacy\n  // small value as stale; any larger explicit custom limit is preserved.\n  const effectiveMaxAiCalls =\n    profile === "business" && explicitMaxAiCalls !== undefined && explicitMaxAiCalls <= 12\n      ? recommendedCalls\n      : explicitMaxAiCalls;`,
);

const createLine = `    settingsUpdates.maxAiCallsPerDay = explicitMaxAiCalls ?? recommendedCalls;`;
if (!source.includes(createLine)) {
  throw new Error("new settings AI budget line not found");
}
source = source.replace(
  createLine,
  `    settingsUpdates.maxAiCallsPerDay = effectiveMaxAiCalls ?? recommendedCalls;`,
);

const existingBlock = `    if (explicitMaxAiCalls !== undefined) {\n      settingsUpdates.maxAiCallsPerDay = explicitMaxAiCalls;\n    } else if (settings.maxAiCallsPerDay <= 12) {\n      settingsUpdates.maxAiCallsPerDay = recommendedCalls;\n    }`;
const recoveredBlock = `    if (effectiveMaxAiCalls !== undefined) {\n      settingsUpdates.maxAiCallsPerDay = effectiveMaxAiCalls;\n    } else if (settings.maxAiCallsPerDay <= 12) {\n      settingsUpdates.maxAiCallsPerDay = recommendedCalls;\n    }`;
if (!source.includes(existingBlock)) {
  throw new Error("existing settings AI budget block not found");
}
source = source.replace(existingBlock, recoveredBlock);

await writeFile(path, source);
console.log("FINCENTRE legacy 12-call AI budget upgraded to production-safe budget");
