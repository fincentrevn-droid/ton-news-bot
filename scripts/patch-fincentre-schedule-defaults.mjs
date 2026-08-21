import { readFile, writeFile } from "node:fs/promises";

const profile = (process.env.CHANNEL_PROFILE ?? process.env.CONTENT_PROFILE ?? "")
  .trim()
  .toLowerCase();
if (profile === "crypto" || profile === "pankoff_crypto") process.exit(0);

const path = "artifacts/api-server/src/lib/runtime-schedule.ts";
let source = await readFile(path, "utf8");

if (!source.includes('import { getChannelProfile } from "./channel-profile";')) {
  source = source.replace(
    'import { logger } from "./logger";',
    'import { logger } from "./logger";\nimport { getChannelProfile } from "./channel-profile";',
  );
}

const oldBlock = `  const explicitAutoPublish = envBool("AUTO_PUBLISH");\n  const requiresApproval = envBool("POSTING_REQUIRES_APPROVAL");\n  const desiredAutoPublish = explicitAutoPublish ?? (\n    requiresApproval === undefined ? undefined : !requiresApproval\n  );\n\n  const explicitScheduleEnabled = envBool("SCHEDULE_ENABLED");\n  const desiredEnabled = explicitScheduleEnabled ?? (\n    desiredAutoPublish === true ? true : undefined\n  );`;

const newBlock = `  const explicitAutoPublish = envBool("AUTO_PUBLISH");\n  const requiresApproval = envBool("POSTING_REQUIRES_APPROVAL");\n  const isBusiness = getChannelProfile() === "business";\n\n  // FINCENTRE BUSINESS is an unattended autopost service. Its legacy Railway\n  // deployment may not define AUTO_PUBLISH/SCHEDULE_ENABLED at all. In that\n  // case the persisted DB defaults (false) must not silently disable the bot.\n  // Explicit Railway false still wins and can intentionally pause publishing.\n  const desiredAutoPublish = explicitAutoPublish ?? (\n    requiresApproval === undefined ? (isBusiness ? true : undefined) : !requiresApproval\n  );\n\n  const explicitScheduleEnabled = envBool("SCHEDULE_ENABLED");\n  const desiredEnabled = explicitScheduleEnabled ?? (\n    desiredAutoPublish === true ? true : (isBusiness ? true : undefined)\n  );`;

if (!source.includes(oldBlock)) {
  throw new Error("runtime schedule reconciliation block not found");
}
source = source.replace(oldBlock, newBlock);
await writeFile(path, source);
console.log("FINCENTRE schedule defaults forced to unattended autopublish when env is unspecified");
