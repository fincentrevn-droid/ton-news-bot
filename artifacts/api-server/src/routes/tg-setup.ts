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
import { logger } from "../lib/logger";

const router = Router();

interface PendingAuth {
  client: unknown;
  phoneCodeHash: string;
}

const pending = new Map<string, PendingAuth>();

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
    const { TelegramClient } = await import("telegram");
    const { StringSession } = await import("telegram/sessions/index.js");

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
    const { TelegramClient, Api } = await import("telegram");
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
        const { computeCheck } = await import("telegram/Password.js");
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
