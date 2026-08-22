#!/bin/sh
set -e

PROFILE="${CHANNEL_PROFILE:-${CONTENT_PROFILE:-}}"

# Railway normally injects PORT, but runtime rebuilds must not depend on optional env vars.
# Vite requires both PORT and BASE_PATH, so provide safe production defaults here.
export PORT="${PORT:-3000}"
export BASE_PATH="${BASE_PATH:-/}"
export NODE_ENV="${NODE_ENV:-production}"

# Keep OpenAI request parameters compatible for both Railway services.
# Luna rejects explicit temperature overrides; prompts/QC define editorial style.
node scripts/patch-openai-default-temperature.mjs

# PANKOFF CRYPTO may use a Telethon StringSession copied without trailing base64 padding.
# GramJS detects Telethon IPv4 sessions by the encoded body length, so normalize only
# when the payload safely decodes to the expected Telethon IPv4 structure (263 bytes).
if [ "$PROFILE" = "crypto" ] && [ -n "${TELEGRAM_STRING_SESSION:-}" ]; then
  normalized_session="$(node -e '
    const s = process.env.TELEGRAM_STRING_SESSION || "";
    if (!s.startsWith("1")) {
      process.stdout.write(s);
      process.exit(0);
    }
    const body = s.slice(1);
    const padding = "=".repeat((4 - (body.length % 4)) % 4);
    let decoded;
    try {
      decoded = Buffer.from(body + padding, "base64");
    } catch {
      process.stdout.write(s);
      process.exit(0);
    }
    if (decoded.length === 263 && body.length !== 352) {
      process.stdout.write(s + padding);
    } else {
      process.stdout.write(s);
    }
  ')"

  if [ "$normalized_session" != "$TELEGRAM_STRING_SESSION" ]; then
    export TELEGRAM_STRING_SESSION="$normalized_session"
    echo "Normalized PANKOFF Telegram StringSession padding"
  fi
fi

if [ "$PROFILE" = "crypto" ]; then
  # Apply PANKOFF-only runtime hardening and editorial style before rebuilding production bundles.
  node scripts/patch-pankoff-footer.mjs
  node scripts/patch-pankoff-hardening-2.mjs
  node scripts/patch-pankoff-style-v2.mjs
  node scripts/patch-pankoff-publish-recovery.mjs
  node scripts/patch-pankoff-final-hardening.mjs
  node scripts/patch-pankoff-disable-footer.mjs

  pnpm --filter @workspace/api-server run build
  pnpm --filter @workspace/dashboard run build
else
  # FINCENTRE BUSINESS has its own anti-stall hardening, schedule self-heal and
  # Ukrainian business editorial prompt. These patches are business-only.
  node scripts/patch-fincentre-stall-v2.mjs
  node scripts/patch-fincentre-schedule-defaults.mjs
  node scripts/patch-fincentre-editorial-v1.mjs
  pnpm --filter @workspace/api-server run build
fi

if [ -n "${DATABASE_URL:-}" ]; then
  pnpm --filter @workspace/db run push-force
fi

exec pnpm run start
