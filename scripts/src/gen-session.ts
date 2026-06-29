/**
 * Генератор TELEGRAM_STRING_SESSION
 *
 * Запуск:
 *   TELEGRAM_API_ID=12345 TELEGRAM_API_HASH=abc123 pnpm --filter @workspace/scripts run gen-session
 *
 * Где взять API_ID и API_HASH:
 *   1. Зайди на https://my.telegram.org/apps
 *   2. Войди в свой аккаунт (не бот, а твой личный аккаунт)
 *   3. Создай приложение: App title = "TON News Bot Reader", Platform = Other
 *   4. Скопируй App api_id и Api hash
 *
 * После запуска:
 *   - Введи номер телефона (+7...)
 *   - Введи код из Telegram
 *   - Введи пароль 2FA если есть
 *   - Скопируй SESSION и добавь в Railway Variables как TELEGRAM_STRING_SESSION
 */
import * as readline from "readline/promises";
import { stdin, stdout } from "process";

async function main() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "", 10);
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";

  if (!apiId || !apiHash) {
    console.error(
      "\n❌ Не заданы переменные окружения!\n\n" +
      "Запусти так:\n" +
      "  TELEGRAM_API_ID=12345 TELEGRAM_API_HASH=abc123 pnpm --filter @workspace/scripts run gen-session\n\n" +
      "Где взять ID и HASH: https://my.telegram.org/apps\n",
    );
    process.exit(1);
  }

  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const session = new StringSession("");

  console.log("\n📱 Генерация TELEGRAM_STRING_SESSION\n");
  console.log(`API ID: ${apiId}`);
  console.log(`API HASH: ${apiHash.slice(0, 6)}...`);
  console.log();

  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: async () => {
      const phone = await rl.question("📞 Номер телефона (+7...): ");
      return phone.trim();
    },
    phoneCode: async () => {
      const code = await rl.question("📨 Код из Telegram: ");
      return code.trim();
    },
    password: async () => {
      const pw = await rl.question("🔐 Пароль 2FA (Enter если нет): ");
      return pw.trim();
    },
    onError: (err) => {
      console.error("Ошибка:", err.message);
    },
  });

  const sessionString = client.session.save() as string;

  console.log("\n✅ Сессия создана!\n");
  console.log("Добавь в Railway Variables:\n");
  console.log(`TELEGRAM_STRING_SESSION=${sessionString}`);
  console.log("\n⚠️  Храни эту строку как секрет — она даёт доступ к аккаунту!\n");

  await client.disconnect();
  rl.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
