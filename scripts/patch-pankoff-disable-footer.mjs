import { readFile, writeFile } from "node:fs/promises";

const profile = (process.env.CHANNEL_PROFILE ?? process.env.CONTENT_PROFILE ?? "")
  .trim()
  .toLowerCase();

if (profile !== "crypto" && profile !== "pankoff_crypto") process.exit(0);

async function patch(path, transform, label) {
  const source = await readFile(path, "utf8");
  const next = transform(source);
  if (next !== source) {
    await writeFile(path, next);
    console.log(label);
  }
}

// PANKOFF_SOCIAL_FOOTER_DISABLED
// Keep the existing publication safety gates, media handling and formatting,
// but publish only the generated post body. No social links or footer emojis.
await patch(
  "artifacts/api-server/src/lib/telegram.ts",
  (input) => {
    const start = input.indexOf("function publicPostHtml(");
    const end = input.indexOf("function usesCustomFooterEmoji()", start);
    if (start < 0 || end < 0) {
      throw new Error("publicPostHtml block not found while disabling PANKOFF footer");
    }

    const replacement = `function publicPostHtml(text: string, maxVisibleChars: number, _useCustomEmoji = true): string {\n  // Preserve the legacy publisher byte-for-byte for the business profile.\n  if (!isCryptoProfile()) {\n    return maxVisibleChars === 1024 ? escapeHtml(text).slice(0, 1024) : escapeHtml(text);\n  }\n\n  // PANKOFF_SOCIAL_FOOTER_DISABLED: publish only the post body.\n  return escapeHtml(truncatePlainText(text, maxVisibleChars));\n}\n\n`;

    return input.slice(0, start) + replacement + input.slice(end);
  },
  "Disabled PANKOFF social footer in Telegram publishing",
);

// Remove the footer preview from Post Queue so the dashboard matches the
// actual message that will be published.
await patch(
  "artifacts/dashboard/src/pages/posts.tsx",
  (input) => input
    .replace(/const PANKOFF_FOOTER_PREVIEW = \([\s\S]*?\n\);\n\n/, "")
    .replace(/\n\s*\{PANKOFF_FOOTER_PREVIEW\}\n/g, "\n"),
  "Removed PANKOFF social footer preview from Post Queue",
);

console.log("PANKOFF posts will publish without social footer");
