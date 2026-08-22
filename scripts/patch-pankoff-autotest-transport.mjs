import { readFile, writeFile } from "node:fs/promises";

const profile = (process.env.CHANNEL_PROFILE ?? process.env.CONTENT_PROFILE ?? "")
  .trim()
  .toLowerCase();
if (profile !== "crypto" && profile !== "pankoff_crypto") process.exit(0);

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

// Add a safe publisher transport probe. It verifies bot/channel permissions and,
// when delete rights are available, performs a silent send -> immediate delete.
await patch(
  "artifacts/api-server/src/lib/telegram.ts",
  (input) => {
    if (input.includes("PANKOFF_AUTOTEST_TRANSPORT_PROBE")) return input;
    const marker = "// ─── Text publish ────────────────────────────────────────────────────────────";
    if (!input.includes(marker)) throw new Error("telegram text publish marker not found");
    const helper = `// PANKOFF_AUTOTEST_TRANSPORT_PROBE\nexport async function testTelegramChannelTransport(): Promise<{ mode: "send_delete" | "permissions"; messageId?: number }> {\n  const token = getBotToken();\n  const chatId = getChannelId();\n\n  const me = await telegramPost(token, "getMe", {}) as { ok: boolean; result?: { id: number }; description?: string };\n  if (!me.ok || !me.result?.id) {\n    throw new Error(\`Telegram getMe failed: \${me.description ?? "unknown error"}\`);\n  }\n\n  const member = await telegramPost(token, "getChatMember", {\n    chat_id: chatId,\n    user_id: me.result.id,\n  }) as {\n    ok: boolean;\n    result?: {\n      status?: string;\n      can_post_messages?: boolean;\n      can_delete_messages?: boolean;\n    };\n    description?: string;\n  };\n  if (!member.ok) {\n    throw new Error(\`Telegram getChatMember failed: \${member.description ?? "unknown error"}\`);\n  }\n\n  const status = member.result?.status ?? "unknown";\n  const canPost = status === "creator" || (status === "administrator" && member.result?.can_post_messages !== false);\n  if (!canPost) {\n    throw new Error(\`Bot cannot post to channel (status: \${status})\`);\n  }\n\n  const canDelete = status === "creator" || member.result?.can_delete_messages === true;\n  if (!canDelete) {\n    logger.info({ status }, "PANKOFF transport probe: posting permission confirmed; delete right unavailable, visible test skipped");\n    return { mode: "permissions" };\n  }\n\n  const sent = await telegramPost(token, "sendMessage", {\n    chat_id: chatId,\n    text: "✅ PANKOFF autopublish test",\n    disable_notification: true,\n  }) as { ok: boolean; result?: { message_id: number }; description?: string };\n  if (!sent.ok || !sent.result?.message_id) {\n    throw new Error(\`Telegram transport test send failed: \${sent.description ?? "unknown error"}\`);\n  }\n\n  const messageId = sent.result.message_id;\n  let deleteDescription = "unknown error";\n  for (let attempt = 0; attempt < 3; attempt++) {\n    const deleted = await telegramPost(token, "deleteMessage", {\n      chat_id: chatId,\n      message_id: messageId,\n    }) as { ok: boolean; description?: string };\n    if (deleted.ok) {\n      logger.info({ messageId }, "PANKOFF transport probe passed with send/delete");\n      return { mode: "send_delete", messageId };\n    }\n    deleteDescription = deleted.description ?? deleteDescription;\n    await new Promise((resolve) => setTimeout(resolve, 300));\n  }\n\n  throw new Error(\`Transport test message #\${messageId} was sent but could not be deleted: \${deleteDescription}\`);\n}\n\n`;
    return input.replace(marker, helper + marker);
  },
  "Added PANKOFF safe Telegram transport probe",
);

// If there is no suitable today-only news (or AI budget is temporarily blocked),
// Test Auto Publish should verify the publisher transport instead of showing a
// misleading red error. Normal autopost remains today-only and unchanged.
await patch(
  "artifacts/api-server/src/routes/schedule.ts",
  (input) => {
    if (input.includes("PANKOFF_AUTOTEST_NO_NEWS_TRANSPORT")) return input;
    let s = input;
    if (!s.includes("testTelegramChannelTransport")) {
      s = s.replace(
        'import { tickPublisher } from "../lib/scheduler";',
        'import { tickPublisher } from "../lib/scheduler";\nimport { testTelegramChannelTransport } from "../lib/telegram";',
      );
    }

    const oldLimit = `    const limitCheck = await checkAiLimitReached();\n    if (limitCheck.blocked) {\n      res.status(429).json({ success: false, message: limitCheck.reason ?? "AI limit reached" });\n      return;\n    }`;
    const newLimit = `    const limitCheck = await checkAiLimitReached();\n    if (limitCheck.blocked) {\n      // PANKOFF_AUTOTEST_NO_NEWS_TRANSPORT: verify channel transport even when AI budget is blocked.\n      const transport = await testTelegramChannelTransport();\n      res.json({\n        success: true,\n        published: false,\n        transportMode: transport.mode,\n        message: \`✅ Publisher/Telegram тест пройден. AI-генерация сейчас ограничена: \${limitCheck.reason ?? "AI limit reached"}\`,\n      });\n      return;\n    }`;
    if (s.includes(oldLimit)) s = s.replace(oldLimit, newLimit);

    const oldNoNews = `    const generated = await generateAndQueuePost();\n    if (!generated) {\n      res.status(422).json({ success: false, message: "Сегодняшняя подходящая крипто-новость не найдена. Старые новости тест не публикует." });\n      return;\n    }`;
    const newNoNews = `    const generated = await generateAndQueuePost();\n    if (!generated) {\n      const transport = await testTelegramChannelTransport();\n      res.json({\n        success: true,\n        published: false,\n        transportMode: transport.mode,\n        message: transport.mode === "send_delete"\n          ? "✅ Автопубликация технически работает: тестовое сообщение отправлено в канал и сразу удалено. Подходящей новости за сегодняшний день по Киеву пока нет, поэтому старый материал не публикуется."\n          : "✅ Права бота на публикацию в канал подтверждены. Подходящей новости за сегодняшний день по Киеву пока нет; видимый тест пропущен, потому что у бота нет права удаления сообщений.",\n      });\n      return;\n    }`;
    if (!s.includes(oldNoNews)) throw new Error("PANKOFF no-news autotest block not found");
    s = s.replace(oldNoNews, newNoNews);
    return s;
  },
  "Made PANKOFF Test Auto Publish useful when no today news exists",
);

console.log("PANKOFF autotest transport fallback complete");
