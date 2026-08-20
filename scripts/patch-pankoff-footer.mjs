import { readFile, writeFile } from "node:fs/promises";

const profile = (process.env.CHANNEL_PROFILE ?? process.env.CONTENT_PROFILE ?? "")
  .trim()
  .toLowerCase();

if (profile !== "crypto" && profile !== "pankoff_crypto") {
  process.exit(0);
}

const telegramPath = "artifacts/api-server/src/lib/telegram.ts";
const postsPath = "artifacts/dashboard/src/pages/posts.tsx";

let telegram = await readFile(telegramPath, "utf8");
const originalTelegram = telegram;

telegram = telegram
  .replace('customEmoji("PANKOFF_FOOTER_CHAT_EMOJI_ID", "🟢", useCustomEmoji)', 'customEmoji("PANKOFF_FOOTER_CHAT_EMOJI_ID", "🐸", useCustomEmoji)')
  .replace('customEmoji("PANKOFF_FOOTER_X_EMOJI_ID", "𝕏", useCustomEmoji)', 'customEmoji("PANKOFF_FOOTER_X_EMOJI_ID", "🐣", useCustomEmoji)')
  .replace('customEmoji("PANKOFF_FOOTER_TT_EMOJI_ID", "♪", useCustomEmoji)', 'customEmoji("PANKOFF_FOOTER_TT_EMOJI_ID", "📹", useCustomEmoji)')
  .replace('customEmoji("PANKOFF_FOOTER_IN_EMOJI_ID", "◉", useCustomEmoji)', 'customEmoji("PANKOFF_FOOTER_IN_EMOJI_ID", "📷", useCustomEmoji)')
  .replace('customEmoji("PANKOFF_FOOTER_YT_EMOJI_ID", "▶️", useCustomEmoji)', 'customEmoji("PANKOFF_FOOTER_YT_EMOJI_ID", "📹", useCustomEmoji)')
  .replace('`<a href="${PANKOFF_FOOTER_LINKS.chat}">${chatIcon} Чат</a>`', '`<a href="${PANKOFF_FOOTER_LINKS.chat}">${chatIcon} <b>Чат</b></a>`')
  .replace('`<a href="${PANKOFF_FOOTER_LINKS.x}">${xIcon} X</a>`', '`<a href="${PANKOFF_FOOTER_LINKS.x}">${xIcon}X</a>`')
  .replace('`<a href="${PANKOFF_FOOTER_LINKS.tg}">${tgIcon} TG</a>`', '`<a href="${PANKOFF_FOOTER_LINKS.tg}">${tgIcon}TG</a>`')
  .replace('`<a href="${PANKOFF_FOOTER_LINKS.tt}">${ttIcon} TT</a>`', '`<a href="${PANKOFF_FOOTER_LINKS.tt}">${ttIcon}TT</a>`')
  .replace('`<a href="${PANKOFF_FOOTER_LINKS.instagram}">${instagramIcon} IN</a>`', '`<a href="${PANKOFF_FOOTER_LINKS.instagram}">${instagramIcon}IN</a>`')
  .replace('`<a href="${PANKOFF_FOOTER_LINKS.youtube}">${youtubeIcon} YT</a>`', '`<a href="${PANKOFF_FOOTER_LINKS.youtube}">${youtubeIcon}YT</a>`')
  .replace('].join(" · ");', '].join(" ");')
  .replace('const visibleFooter = "🟢 Чат · 𝕏 X · ✈️ TG · ♪ TT · ◉ IN · ▶️ YT";', 'const visibleFooter = "🐸 Чат 🐣X ✈️TG 📹TT 📷IN 📹YT";');

if (telegram !== originalTelegram) {
  await writeFile(telegramPath, telegram);
  console.log("Updated PANKOFF Telegram footer format");
}

let posts = await readFile(postsPath, "utf8");
const originalPosts = posts;

if (!posts.includes("PANKOFF_FOOTER_PREVIEW")) {
  posts = posts.replace(
    'const STATUS_COLORS: Record<string, string> = {',
    `const PANKOFF_FOOTER_PREVIEW = (\n  <div className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-sm text-muted-foreground">\n    <a href="https://t.me/pankoff_chat" target="_blank" rel="noreferrer" className="hover:text-foreground">🐸 <strong>Чат</strong></a>\n    <a href="https://x.com/pankoffcrypto" target="_blank" rel="noreferrer" className="hover:text-foreground">🐣X</a>\n    <a href="https://t.me/pankoff_crypto" target="_blank" rel="noreferrer" className="hover:text-foreground">✈️TG</a>\n    <a href="https://www.tiktok.com/@pankoff33" target="_blank" rel="noreferrer" className="hover:text-foreground">📹TT</a>\n    <a href="https://instagram.com/_pankoff" target="_blank" rel="noreferrer" className="hover:text-foreground">📷IN</a>\n    <a href="https://youtube.com/@pankoff33" target="_blank" rel="noreferrer" className="hover:text-foreground">📹YT</a>\n  </div>\n);\n\nconst STATUS_COLORS: Record<string, string> = {`,
  );

  posts = posts.replace(
    '        )}\n\n        <div className="mt-4 flex flex-wrap items-center gap-2 pt-4 border-t border-border">',
    '        )}\n\n        {PANKOFF_FOOTER_PREVIEW}\n\n        <div className="mt-4 flex flex-wrap items-center gap-2 pt-4 border-t border-border">',
  );
}

if (posts !== originalPosts) {
  await writeFile(postsPath, posts);
  console.log("Added PANKOFF footer preview to Post Queue");
}
