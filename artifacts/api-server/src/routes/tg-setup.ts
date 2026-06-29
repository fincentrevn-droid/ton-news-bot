/**
 * One-time Telegram MTProto setup — web UI at GET /api/setup/tg
 * Supports two login methods:
 *   1. QR code — scan from a logged-in Telegram account (easiest)
 *   2. Phone number — enter number + code sent to Telegram app
 *
 * Protected by TELEGRAM_SETUP_SECRET env var.
 * Remove it from Railway Variables after getting the session string.
 */
import { Router } from "express";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";

const _req = createRequire(import.meta.url);

function loadGram() {
  const gram = _req("telegram") as typeof import("telegram");
  const sessions = _req("telegram/sessions") as { StringSession: new (s?: string) => unknown };
  const pwd = _req("telegram/Password") as { computeCheck: typeof import("telegram/Password").computeCheck };
  return {
    TelegramClient: gram.TelegramClient,
    Api: gram.Api,
    StringSession: sessions.StringSession,
    computeCheck: pwd.computeCheck,
  };
}

const router = Router();

// ── State ─────────────────────────────────────────────────────────────────────
interface PhonePending { client: unknown; phoneCodeHash: string }
interface QrState {
  client: unknown;
  url: string;
  done: boolean;
  sessionString: string | null;
  expired: boolean;
  apiId: number;
  apiHash: string;
}

const phonePending = new Map<string, PhonePending>();
const qrPending    = new Map<string, QrState>();

// ── Auth guard ────────────────────────────────────────────────────────────────
function requireSecret(
  body: Record<string, unknown>,
  res: Parameters<Parameters<typeof router.post>[1]>[1],
): boolean {
  const secret = process.env.TELEGRAM_SETUP_SECRET;
  if (!secret) {
    res.status(503).json({ error: "TELEGRAM_SETUP_SECRET not set in Railway Variables" });
    return false;
  }
  if (body.secret !== secret) {
    res.status(401).json({ error: "Wrong secret" });
    return false;
  }
  return true;
}

function getApiCreds(res: Parameters<Parameters<typeof router.post>[1]>[1]): { apiId: number; apiHash: string } | null {
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? "", 10);
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  if (!apiId || !apiHash) {
    res.status(503).json({ error: "TELEGRAM_API_ID / TELEGRAM_API_HASH not set in Railway Variables" });
    return null;
  }
  return { apiId, apiHash };
}

// ── HTML page ─────────────────────────────────────────────────────────────────
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
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;max-width:520px;margin:36px auto;padding:0 18px;color:#111;background:#fff}
h1{font-size:1.35rem;margin:0 0 4px}
p.sub{color:#666;margin:0 0 20px;font-size:.9rem}
.tabs{display:flex;gap:8px;margin-bottom:16px}
.tab{flex:1;padding:9px;border:2px solid #e2e8f0;border-radius:10px;cursor:pointer;background:#f8fafc;font-size:.9rem;font-weight:600;text-align:center;transition:.15s}
.tab.active{border-color:#2563eb;background:#eff6ff;color:#2563eb}
.panel{display:none}.panel.active{display:block}
.box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:12px}
label{display:block;margin-top:14px;font-weight:600;font-size:.875rem}
input{width:100%;padding:9px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:1rem;margin-top:4px}
button{margin-top:16px;width:100%;padding:11px;background:#2563eb;color:#fff;border:none;border-radius:9px;font-size:1rem;cursor:pointer;font-weight:600}
button:hover{background:#1d4ed8}
button:disabled{background:#94a3b8;cursor:default}
#qr-box{display:none;text-align:center;margin:16px 0}
#qr-box canvas,#qr-box img{margin:auto;display:block}
.hint{font-size:.83rem;color:#64748b;margin-top:8px}
#result{margin-top:16px;white-space:pre-wrap;background:#f1f5f9;padding:14px;border-radius:10px;font-size:.82rem;display:none;word-break:break-all;border:1px solid #e2e8f0}
.ok{color:#16a34a;font-weight:700}
.err{color:#dc2626;font-weight:700}
.badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:.75rem;font-weight:700}
.badge-ok{background:#dcfce7;color:#15803d}
.badge-wait{background:#fef9c3;color:#92400e}
#session-out{display:none;margin-top:16px;padding:14px;background:#f0fdf4;border:1px solid #86efac;border-radius:10px}
#session-out h3{margin:0 0 8px;color:#166534;font-size:.95rem}
#session-val{font-family:monospace;font-size:.75rem;word-break:break-all;background:#fff;padding:10px;border-radius:6px;border:1px solid #bbf7d0;user-select:all}
#copy-btn{margin-top:10px;background:#16a34a}
#copy-btn:hover{background:#15803d}
</style>
</head>
<body>
<h1>📱 Telegram Session Setup</h1>
<p class="sub">Получи TELEGRAM_STRING_SESSION для чтения каналов</p>

<div class="tabs">
  <div class="tab active" onclick="switchTab('qr')">📷 QR-код <span style="font-weight:400;font-size:.8rem">(проще)</span></div>
  <div class="tab" onclick="switchTab('phone')">📞 Телефон</div>
</div>

<!-- QR TAB -->
<div class="panel active" id="tab-qr">
  <div class="box">
    <b>Как использовать:</b>
    <ol style="margin:10px 0 0;padding-left:20px;font-size:.9rem;line-height:1.7">
      <li>Введи секрет и нажми <b>«Показать QR»</b></li>
      <li>Открой Telegram на аккаунте-читателе</li>
      <li>Настройки → Устройства → <b>Подключить устройство</b></li>
      <li>Отсканируй QR-код</li>
    </ol>
    <label>Секрет (TELEGRAM_SETUP_SECRET)</label>
    <input id="qr-secret" type="password" placeholder="твой пароль из Railway Variables">
    <button id="qr-start-btn" onclick="startQR()">Показать QR-код</button>
  </div>

  <div id="qr-box">
    <div id="qr-canvas"></div>
    <p class="hint" id="qr-status">⏳ Ожидаю сканирования…</p>
    <p class="hint">Сканируй в Telegram → Настройки → Устройства → Подключить устройство</p>
  </div>
</div>

<!-- PHONE TAB -->
<div class="panel" id="tab-phone">
  <div class="box" id="phone-step1">
    <b>Шаг 1 — Отправить код</b>
    <label>Секрет (TELEGRAM_SETUP_SECRET)</label>
    <input id="ph-secret" type="password" placeholder="твой пароль из Railway Variables">
    <label>Номер телефона</label>
    <input id="ph-phone" type="tel" placeholder="+79001234567">
    <button onclick="sendCode()">Отправить код в Telegram</button>
  </div>
  <div class="box" id="phone-step2" style="display:none">
    <b>Шаг 2 — Ввести код</b>
    <p class="hint" style="margin:6px 0 0">Проверь Telegram (телефон / десктоп / web.telegram.org) — сообщение от «Telegram»</p>
    <label>Код из Telegram</label>
    <input id="ph-code" type="text" placeholder="12345" maxlength="10">
    <label>Пароль 2FA (если есть)</label>
    <input id="ph-2fa" type="password" placeholder="необязательно">
    <button onclick="signIn()">Войти и получить сессию</button>
  </div>
</div>

<div id="session-out">
  <h3>✅ Сессия получена!</h3>
  <p style="margin:0 0 6px;font-size:.85rem;color:#166534">Скопируй и добавь в Railway Variables как <b>TELEGRAM_STRING_SESSION</b></p>
  <div id="session-val"></div>
  <button id="copy-btn" onclick="copySession()">📋 Копировать</button>
  <p class="hint" style="margin-top:10px">После добавления в Railway — удали <b>TELEGRAM_SETUP_SECRET</b> и задеплой.</p>
</div>

<div id="result"></div>

<script>
let phHash='', phPhone='', phSecret='';
let qrId='', qrPollTimer=null;

function switchTab(t){
  document.querySelectorAll('.tab').forEach((el,i)=>el.classList.toggle('active',['qr','phone'][i]===t));
  document.querySelectorAll('.panel').forEach((el,i)=>el.classList.toggle('active',['tab-qr','tab-phone'][i]==='tab-'+t));
  clearResult();
}

// ── QR flow ──────────────────────────────────────────────────────────────────
async function startQR(){
  const secret = document.getElementById('qr-secret').value.trim();
  if(!secret){alert('Введи секрет');return;}
  document.getElementById('qr-start-btn').disabled=true;
  document.getElementById('qr-start-btn').textContent='⏳ Загружаю…';
  showResult('');
  try{
    const r=await post('/api/setup/tg/qr-start',{secret});
    if(!r.ok){showErr('❌ '+r.error);resetQrBtn();return;}
    qrId=r.id;
    renderQR(r.url);
    pollQR(secret);
  }catch(e){showErr('❌ '+e.message);resetQrBtn();}
}

function renderQR(url){
  const box=document.getElementById('qr-box');
  const canvas=document.getElementById('qr-canvas');
  canvas.innerHTML='';
  box.style.display='block';
  new QRCode(canvas,{text:url,width:220,height:220,correctLevel:QRCode.CorrectLevel.L});
}

function pollQR(secret){
  let tries=0;
  function check(){
    post('/api/setup/tg/qr-check',{secret,id:qrId}).then(r=>{
      if(r.done){
        document.getElementById('qr-status').textContent='✅ Авторизован!';
        document.getElementById('qr-start-btn').style.display='none';
        showSession(r.sessionString);
      } else if(r.url && r.url!==document.getElementById('qr-canvas').dataset.url){
        document.getElementById('qr-canvas').dataset.url=r.url;
        renderQR(r.url);
        document.getElementById('qr-status').textContent='🔄 QR обновлён — отсканируй снова';
        if(++tries<60) qrPollTimer=setTimeout(check,2000);
      } else {
        if(++tries<60) qrPollTimer=setTimeout(check,2000);
        else document.getElementById('qr-status').textContent='⏰ Время вышло — обнови страницу';
      }
    }).catch(()=>{if(++tries<60) qrPollTimer=setTimeout(check,3000);});
  }
  qrPollTimer=setTimeout(check,2000);
}

function resetQrBtn(){
  const b=document.getElementById('qr-start-btn');
  b.disabled=false;b.textContent='Показать QR-код';
}

// ── Phone flow ────────────────────────────────────────────────────────────────
async function sendCode(){
  phSecret=document.getElementById('ph-secret').value.trim();
  phPhone=document.getElementById('ph-phone').value.trim();
  if(!phSecret||!phPhone){alert('Заполни оба поля');return;}
  showResult('⏳ Отправляю…');
  const r=await post('/api/setup/tg/send-code',{secret:phSecret,phone:phPhone});
  if(r.ok){
    phHash=r.phoneCodeHash;
    showResult('');
    document.getElementById('phone-step2').style.display='block';
  } else showErr('❌ '+r.error);
}

async function signIn(){
  const code=document.getElementById('ph-code').value.trim();
  const twofa=document.getElementById('ph-2fa').value.trim();
  if(!code){alert('Введи код из Telegram');return;}
  showResult('⏳ Авторизуюсь…');
  const body={secret:phSecret,phone:phPhone,phoneCodeHash:phHash,code};
  if(twofa) body.password=twofa;
  const r=await post('/api/setup/tg/sign-in',body);
  if(r.ok) showSession(r.sessionString);
  else showErr('❌ '+r.error);
}

// ── Shared ────────────────────────────────────────────────────────────────────
async function post(url,body){
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return r.json();
}

function showSession(s){
  document.getElementById('session-out').style.display='block';
  document.getElementById('session-val').textContent=s;
  clearResult();
}

function copySession(){
  const t=document.getElementById('session-val').textContent;
  navigator.clipboard.writeText(t).then(()=>{
    document.getElementById('copy-btn').textContent='✅ Скопировано!';
    setTimeout(()=>document.getElementById('copy-btn').textContent='📋 Копировать',2000);
  });
}

function showResult(msg){const el=document.getElementById('result');el.style.display=msg?'block':'none';el.textContent=msg;el.className='';}
function showErr(msg){const el=document.getElementById('result');el.style.display='block';el.textContent=msg;el.className='err';}
function clearResult(){showResult('');}
</script>
</body>
</html>`);
});

// ── QR endpoints ──────────────────────────────────────────────────────────────
router.post("/setup/tg/qr-start", async (req, res): Promise<void> => {
  if (!requireSecret(req.body as Record<string, unknown>, res)) return;
  const creds = getApiCreds(res);
  if (!creds) return;
  const { apiId, apiHash } = creds;

  // Optional 2FA password in case the reader account has it
  const { password: twoFaPassword } = req.body as { password?: string };

  try {
    const { TelegramClient, StringSession } = loadGram();
    const session = new (StringSession as new (s?: string) => unknown)("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new TelegramClient(session as any, apiId, apiHash, { connectionRetries: 5 });

    const id = randomUUID();
    const state: QrState = { client, url: "", done: false, sessionString: null, expired: false, apiId, apiHash };
    qrPending.set(id, state);

    // Connect first (signInUserWithQrCode requires an active connection)
    await client.connect();

    // Wait for the FIRST QR code before responding so the browser gets a URL to display
    await new Promise<void>((resolveFirst) => {
      let firstQR = true;

      // signInUserWithQrCode is the correct gramjs method for QR login.
      // client.start() without phoneNumber routes to signInBot — wrong!
      void client.signInUserWithQrCode(
        { apiId, apiHash },
        {
          qrCode: async (code: { token: Buffer; expires: number }) => {
            const tokenB64 = Buffer.from(code.token).toString("base64url");
            state.url = `tg://login?token=${tokenB64}`;
            logger.info({ id }, "QR token generated/refreshed");
            if (firstQR) {
              firstQR = false;
              resolveFirst(); // unblock the HTTP response after first token
            }
          },
          password: async () => twoFaPassword ?? "",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onError: ((err: Error): void => {
            logger.error({ err, id }, "QR login onError");
            state.expired = true;
            if (firstQR) { firstQR = false; resolveFirst(); }
          }) as any,
        },
      ).then(() => {
        state.done = true;
        state.sessionString = String(client.session.save());
        logger.info({ id }, "QR login success — session saved");
        void client.disconnect().catch(() => undefined);
      }).catch((err: Error) => {
        logger.error({ err, id }, "QR signInUserWithQrCode failed");
        state.expired = true;
        if (firstQR) { firstQR = false; resolveFirst(); }
      });
    });

    if (state.expired || !state.url) {
      qrPending.delete(id);
      res.status(500).json({ error: "Failed to generate QR code — check TELEGRAM_API_ID / TELEGRAM_API_HASH" });
      return;
    }

    res.json({ ok: true, id, url: state.url });
  } catch (err) {
    logger.error({ err }, "QR start failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/setup/tg/qr-check", (req, res): void => {
  if (!requireSecret(req.body as Record<string, unknown>, res)) return;
  const { id } = req.body as { id?: string };
  if (!id) { res.status(400).json({ error: "id required" }); return; }

  const state = qrPending.get(id);
  if (!state) { res.status(404).json({ error: "QR session not found or expired" }); return; }

  if (state.done) {
    qrPending.delete(id);
    res.json({ ok: true, done: true, sessionString: state.sessionString });
    return;
  }

  res.json({ ok: true, done: false, url: state.url, expired: state.expired });
});

// ── Phone endpoints ───────────────────────────────────────────────────────────
router.post("/setup/tg/send-code", async (req, res): Promise<void> => {
  if (!requireSecret(req.body as Record<string, unknown>, res)) return;
  const creds = getApiCreds(res);
  if (!creds) return;
  const { apiId, apiHash } = creds;

  const { phone } = req.body as { phone?: string };
  if (!phone) { res.status(400).json({ error: "phone required (+79001234567)" }); return; }

  try {
    const { TelegramClient, StringSession } = loadGram();
    const session = new (StringSession as new (s?: string) => unknown)("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new TelegramClient(session as any, apiId, apiHash, { connectionRetries: 3 });
    await client.connect();

    const result = await client.sendCode({ apiId, apiHash }, phone);
    phonePending.set(phone, { client, phoneCodeHash: result.phoneCodeHash });

    logger.info({ phone }, "Telegram setup: code sent");
    res.json({ ok: true, phoneCodeHash: result.phoneCodeHash });
  } catch (err) {
    logger.error({ err }, "send-code failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/setup/tg/sign-in", async (req, res): Promise<void> => {
  if (!requireSecret(req.body as Record<string, unknown>, res)) return;

  const { phone, phoneCodeHash, code, password } = req.body as {
    phone?: string; phoneCodeHash?: string; code?: string; password?: string;
  };
  if (!phone || !phoneCodeHash || !code) {
    res.status(400).json({ error: "phone, phoneCodeHash, and code are required" });
    return;
  }

  const entry = phonePending.get(phone);
  if (!entry) {
    res.status(400).json({ error: "No pending auth — call /send-code first" });
    return;
  }

  try {
    const { TelegramClient, Api, computeCheck } = loadGram();
    const client = entry.client as InstanceType<typeof TelegramClient>;

    try {
      await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
    } catch (err: unknown) {
      const msg = ((err as { errorMessage?: string; message?: string }).errorMessage ?? (err as Error).message ?? "");
      if (msg.includes("SESSION_PASSWORD_NEEDED")) {
        if (!password) {
          res.status(400).json({ error: "2FA password required — add 'password' field and retry" });
          return;
        }
        const pwdInfo = await client.invoke(new Api.account.GetPassword());
        await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pwdInfo, password) }));
      } else throw err;
    }

    const sessionString = String(client.session.save());
    phonePending.delete(phone);
    await client.disconnect();

    logger.info({ phone }, "Telegram setup: sign-in success");
    res.json({ ok: true, sessionString });
  } catch (err) {
    logger.error({ err }, "sign-in failed");
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export default router;
