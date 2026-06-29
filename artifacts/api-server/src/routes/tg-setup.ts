/**
 * One-time Telegram MTProto setup endpoint.
 * Protected by TELEGRAM_SETUP_SECRET env var.
 * Remove TELEGRAM_SETUP_SECRET from Railway Variables after use.
 *
 * Step 1 — send code:
 *   curl -X POST https://your-app.up.railway.app/api/setup/tg/send-code \
 *     -H "Content-Type: application/json" \
 *     -d '{"secret":"YOUR_SECRET","phone":"+79001234567"}'
 *
 * Step 2 — sign in (no 2FA):
 *   curl -X POST https://your-app.up.railway.app/api/setup/tg/sign-in \
 *     -H "Content-Type: application/json" \
 *     -d '{"secret":"YOUR_SECRET","phone":"+79001234567","phoneCodeHash":"HASH","code":"12345"}'
 *
 * Step 2 — sign in (with 2FA password):
 *   Add "password":"your2FApassword" to the JSON above.
 *
 * Response contains sessionString — save as TELEGRAM_STRING_SESSION in Railway Variables.
 */
import { Router } from "express";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { computeCheck } from "telegram/Password.js";
import { logger } from "../lib/logger";

const router = Router();

interface PendingAuth {
  client: unknown;
  phoneCodeHash: string;
}

const pending = new Map<string, PendingAuth>();

// ── HTML setup page ──────────────────────────────────────────────────────────
router.get("/setup/tg", (_req, res): void => {
  const secret = process.env.TELEGRAM_SETUP_SECRET;
  if (!secret) {
    res.send(`<html><body style="font-family:sans-serif;max-width:500px;margin:60px auto;padding:0 20px">
      <h2>⚠️ Не настроено</h2>
      <p>Добавь в Railway Variables:</p>
      <pre style="background:#f4f4f4;padding:12px;border-radius:6px">TELEGRAM_SETUP_SECRET=любой_пароль</pre>
      <p>Потом перезапусти сервис и открой эту страницу снова.</p>
    </body></html>`);
    return;
  }
  res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram Session Setup</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 20px;color:#1a1a1a}
  h1{font-size:1.4rem;margin-bottom:4px}
  p.sub{color:#666;margin-top:0;font-size:.9rem}
  label{display:block;margin-top:16px;font-weight:600;font-size:.9rem}
  input{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #ccc;border-radius:8px;font-size:1rem;margin-top:4px}
  button{margin-top:20px;width:100%;padding:11px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer}
  button:hover{background:#1d4ed8}
  .box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px;margin-top:12px}
  .step{font-size:.8rem;font-weight:700;text-transform:uppercase;color:#2563eb;letter-spacing:.05em;margin-bottom:8px}
  #result{margin-top:20px;white-space:pre-wrap;background:#f4f4f4;padding:14px;border-radius:8px;font-size:.85rem;display:none}
  .err{color:#dc2626}
  .ok{color:#16a34a}
</style>
</head>
<body>
<h1>📱 Telegram Session Setup</h1>
<p class="sub">Одноразовая авторизация для чтения каналов</p>

<div class="box" id="step1box">
  <div class="step">Шаг 1 — Отправить код</div>
  <label>Секретный пароль (TELEGRAM_SETUP_SECRET)</label>
  <input id="secret" type="password" placeholder="твой секрет из Railway Variables">
  <label>Номер телефона</label>
  <input id="phone" type="tel" placeholder="+79001234567">
  <button onclick="sendCode()">Отправить код в Telegram</button>
</div>

<div class="box" id="step2box" style="display:none">
  <div class="step">Шаг 2 — Ввести код</div>
  <p style="margin:0 0 12px;font-size:.9rem">Код пришёл в Telegram-приложение — проверь телефон, десктоп или веб-версию.</p>
  <label>Код из Telegram</label>
  <input id="code" type="text" placeholder="12345" maxlength="10">
  <label>Пароль 2FA (если есть, иначе оставь пустым)</label>
  <input id="twofa" type="password" placeholder="необязательно">
  <button onclick="signIn()">Войти и получить сессию</button>
</div>

<div id="result"></div>

<script>
let phoneVal = '', hashVal = '', secretVal = '';

async function sendCode() {
  secretVal = document.getElementById('secret').value.trim();
  phoneVal  = document.getElementById('phone').value.trim();
  if (!secretVal || !phoneVal) { alert('Заполни оба поля'); return; }
  showResult('⏳ Отправляю запрос...');
  try {
    const r = await fetch('/api/setup/tg/send-code', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ secret: secretVal, phone: phoneVal })
    });
    const d = await r.json();
    if (d.ok) {
      hashVal = d.phoneCodeHash;
      showResult('✅ Код отправлен! Проверь Telegram (телефон, десктоп или web.telegram.org).', true);
      document.getElementById('step2box').style.display = 'block';
    } else {
      showResult('❌ Ошибка: ' + (d.error || JSON.stringify(d)), false);
    }
  } catch(e) { showResult('❌ ' + e.message, false); }
}

async function signIn() {
  const code  = document.getElementById('code').value.trim();
  const twofa = document.getElementById('twofa').value.trim();
  if (!code) { alert('Введи код из Telegram'); return; }
  showResult('⏳ Авторизуюсь...');
  try {
    const body = { secret: secretVal, phone: phoneVal, phoneCodeHash: hashVal, code };
    if (twofa) body.password = twofa;
    const r = await fetch('/api/setup/tg/sign-in', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.ok) {
      showResult('✅ Готово! Скопируй значение TELEGRAM_STRING_SESSION:\\n\\n' + d.sessionString + '\\n\\nДобавь в Railway Variables, потом удали TELEGRAM_SETUP_SECRET и задеплой.', true);
    } else {
      showResult('❌ ' + (d.error || JSON.stringify(d)), false);
    }
  } catch(e) { showResult('❌ ' + e.message, false); }
}

function showResult(msg, ok) {
  const el = document.getElementById('result');
  el.style.display = 'block';
  el.textContent = msg;
  el.className = ok === true ? 'ok' : ok === false ? 'err' : '';
}
</script>
</body>
</html>`);
});

function requireSecret(
  body: Record<string, unknown>,
  res: Parameters<Parameters<typeof router.post>[1]>[1],
): boolean {
  const secret = process.env.TELEGRAM_SETUP_SECRET;
  if (!secret) {
    res.status(503).json({
      error: "TELEGRAM_SETUP_SECRET not set. Add it to Railway Variables first, then call this endpoint.",
    });
    return false;
  }
  if (body.secret !== secret) {
    res.status(401).json({ error: "Wrong secret" });
    return false;
  }
  return true;
}

router.post("/setup/tg/send-code", async (req, res): Promise<void> => {
  if (!requireSecret(req.body as Record<string, unknown>, res)) return;

  const { phone } = req.body as { phone?: string };
  if (!phone) { res.status(400).json({ error: "phone required (+79001234567)" }); return; }

  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "", 10);
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  if (!apiId || !apiHash) {
    res.status(503).json({ error: "TELEGRAM_API_ID / TELEGRAM_API_HASH not set in Railway Variables" });
    return;
  }

  try {
    const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
      connectionRetries: 3,
    });
    await client.connect();

    const result = await client.sendCode({ apiId, apiHash }, phone);
    pending.set(phone, { client, phoneCodeHash: result.phoneCodeHash });

    logger.info({ phone }, "Telegram setup: code sent");
    res.json({
      ok: true,
      phoneCodeHash: result.phoneCodeHash,
      next: `Now call /api/setup/tg/sign-in with code from Telegram (check ALL devices where your account is logged in)`,
    });
  } catch (err) {
    logger.error({ err }, "Telegram setup send-code failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/setup/tg/sign-in", async (req, res): Promise<void> => {
  if (!requireSecret(req.body as Record<string, unknown>, res)) return;

  const { phone, phoneCodeHash, code, password } = req.body as {
    phone?: string;
    phoneCodeHash?: string;
    code?: string;
    password?: string;
  };

  if (!phone || !phoneCodeHash || !code) {
    res.status(400).json({ error: "phone, phoneCodeHash, and code are required" });
    return;
  }

  const entry = pending.get(phone);
  if (!entry) {
    res.status(400).json({
      error: "No pending auth for this phone. Call /api/setup/tg/send-code first.",
    });
    return;
  }

  try {
    const client = entry.client as InstanceType<typeof TelegramClient>;

    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash,
          phoneCode: code,
        }),
      );
    } catch (err: unknown) {
      const tgErr = err as { errorMessage?: string; message?: string };
      const msg = tgErr.errorMessage ?? tgErr.message ?? "";

      if (msg.includes("SESSION_PASSWORD_NEEDED")) {
        if (!password) {
          res.status(400).json({
            error: "2FA password required. Add 'password' field and retry /api/setup/tg/sign-in.",
          });
          return;
        }
        const pwdInfo = await client.invoke(new Api.account.GetPassword());
        await client.invoke(
          new Api.auth.CheckPassword({
            password: await computeCheck(pwdInfo, password),
          }),
        );
      } else {
        throw err;
      }
    }

    const sessionString = String(client.session.save());
    pending.delete(phone);
    await client.disconnect();

    logger.info({ phone }, "Telegram setup: sign-in success");
    res.json({
      ok: true,
      sessionString,
      instructions: [
        "1. Copy sessionString value above",
        "2. Add to Railway Variables: TELEGRAM_STRING_SESSION=<value>",
        "3. Remove TELEGRAM_SETUP_SECRET from Railway Variables",
        "4. Redeploy — bot will now read Telegram channels directly",
      ],
    });
  } catch (err) {
    logger.error({ err }, "Telegram setup sign-in failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
