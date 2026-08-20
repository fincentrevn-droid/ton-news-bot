#!/bin/sh
set -e

PROFILE="${CHANNEL_PROFILE:-${CONTENT_PROFILE:-}}"

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
  # GPT-5.6 Luna only supports its default temperature.
  if [ "${OPENAI_MODEL:-}" = "gpt-5.6-luna" ] && grep -q "^[[:space:]]*temperature:" artifacts/api-server/src/lib/openai.ts; then
    sed -i '/^[[:space:]]*temperature:/d' artifacts/api-server/src/lib/openai.ts
    echo "Removed unsupported temperature overrides for PANKOFF gpt-5.6-luna"
  fi

  # Apply PANKOFF-only footer formatting and dashboard final-post preview.
  node scripts/patch-pankoff-footer.mjs

  # The Railway image was built before the runtime profile-specific patch, so
  # rebuild only the two affected bundles for the crypto service.
  pnpm --filter @workspace/api-server run build
  pnpm --filter @workspace/dashboard run build
fi

if [ -n "${DATABASE_URL:-}" ]; then
  pnpm --filter @workspace/db run push-force
fi

exec pnpm run start
