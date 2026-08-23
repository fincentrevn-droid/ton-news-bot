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
# Daily AI accounting must use the same Europe/Kyiv day as posting/news freshness.
# Also repairs the legacy PANKOFF internal generated-post budget of 8 -> 12.
node scripts/patch-local-day-accounting.mjs

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
  # Apply PANKOFF-only runtime hardening and editorial style.
  node scripts/patch-pankoff-footer.mjs
  node scripts/patch-pankoff-hardening-2.mjs
  node scripts/patch-pankoff-style-v2.mjs
  node scripts/patch-pankoff-publish-recovery.mjs
  node scripts/patch-pankoff-final-hardening.mjs
  node scripts/patch-pankoff-disable-footer.mjs

  # Shared reliability, output safety and QC structured-output resilience.
  node scripts/patch-autopost-reliability.mjs
  node scripts/patch-ai-output-safety.mjs
  node scripts/patch-quality-check-resilience.mjs

  # Final PANKOFF passes: today-only Kyiv sources/event-first style, instant
  # autopublish test and a safe Telegram transport fallback when no news exists.
  node scripts/patch-pankoff-today-v3.mjs
  node scripts/patch-pankoff-autotest-transport.mjs

  # Natural scheduler throughput: rotate QC rejects quickly, then immediately
  # try a few different sources in the same cycle before falling back to retry.
  node scripts/patch-autopost-throughput-v1.mjs
  node scripts/patch-autopost-catchup-v2.mjs

  pnpm --filter @workspace/api-server run build
  pnpm --filter @workspace/dashboard run build
else
  # FINCENTRE BUSINESS has its own anti-stall hardening, schedule self-heal and
  # Ukrainian business editorial prompt. These patches are business-only.
  node scripts/patch-fincentre-stall-v2.mjs
  node scripts/patch-fincentre-schedule-defaults.mjs
  node scripts/patch-fincentre-editorial-v1.mjs

  # Shared reliability, output safety and QC structured-output resilience.
  node scripts/patch-autopost-reliability.mjs
  node scripts/patch-ai-output-safety.mjs
  node scripts/patch-quality-check-resilience.mjs

  # Final business-only publisher pass: restore @fincentre_business and expose
  # a one-shot production autopublish test without changing normal intervals.
  node scripts/patch-fincentre-publisher-v2.mjs

  # Natural scheduler throughput: a rejected source is rotated out, then other
  # fresh sources are tried in the same cycle instead of waiting for another hour.
  node scripts/patch-autopost-throughput-v1.mjs
  node scripts/patch-autopost-catchup-v2.mjs

  pnpm --filter @workspace/api-server run build
  pnpm --filter @workspace/dashboard run build
fi

if [ -n "${DATABASE_URL:-}" ]; then
  pnpm --filter @workspace/db run push-force
fi

exec pnpm run start
