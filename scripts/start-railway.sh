#!/bin/sh
set -e

PROFILE="${CHANNEL_PROFILE:-${CONTENT_PROFILE:-business}}"
RUNTIME_BASELINE=".runtime-baseline"
RUNTIME_READY=".runtime-build-ready-${PROFILE}"

# Railway normally injects PORT, but runtime rebuilds must not depend on optional env vars.
# Vite requires both PORT and BASE_PATH, so provide safe production defaults here.
export PORT="${PORT:-3000}"
export BASE_PATH="${BASE_PATH:-/}"
export NODE_ENV="${NODE_ENV:-production}"
# Media is part of the production product for both channels. Force it on so a
# legacy Railway variable cannot silently disable the entire image pipeline.
export ENABLE_MEDIA_DOWNLOAD="true"

echo "[startup] profile=${PROFILE} node_env=${NODE_ENV}"

# The project intentionally applies compatibility/editorial patches at runtime.
# Several historical patch scripts expect pristine source text and are not safe
# to run twice against an already-mutated Railway filesystem. Keep a pristine
# baseline on the first process start. If a previous startup failed halfway,
# restore that baseline before retrying. After a successful runtime build, later
# process restarts reuse the already-built dist instead of re-patching source.
prepare_runtime_sources() {
  if [ -f "$RUNTIME_READY" ]; then
    echo "[startup] runtime patches already built; reusing existing dist"
    return 1
  fi

  if [ ! -d "$RUNTIME_BASELINE" ]; then
    echo "[startup] saving pristine runtime source baseline"
    mkdir -p "$RUNTIME_BASELINE"
    cp -R artifacts/api-server/src "$RUNTIME_BASELINE/api-server-src"
    cp -R artifacts/dashboard/src "$RUNTIME_BASELINE/dashboard-src"
    cp -R lib/db/src "$RUNTIME_BASELINE/db-src"
  else
    echo "[startup] restoring pristine source after incomplete previous startup"
    rm -rf artifacts/api-server/src artifacts/dashboard/src lib/db/src
    cp -R "$RUNTIME_BASELINE/api-server-src" artifacts/api-server/src
    cp -R "$RUNTIME_BASELINE/dashboard-src" artifacts/dashboard/src
    cp -R "$RUNTIME_BASELINE/db-src" lib/db/src
  fi

  return 0
}

run_patch() {
  echo "[startup] applying $1"
  node "$1"
}

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
    echo "[startup] normalized PANKOFF Telegram StringSession padding"
  fi
fi

if prepare_runtime_sources; then
  # Keep OpenAI request parameters compatible for both Railway services.
  run_patch scripts/patch-openai-default-temperature.mjs
  # Daily AI accounting must use the same Europe/Kyiv day as posting/news freshness.
  run_patch scripts/patch-local-day-accounting.mjs

  if [ "$PROFILE" = "crypto" ]; then
    # Apply PANKOFF-only runtime hardening and editorial style.
    run_patch scripts/patch-pankoff-footer.mjs
    run_patch scripts/patch-pankoff-hardening-2.mjs
    run_patch scripts/patch-pankoff-style-v2.mjs
    run_patch scripts/patch-pankoff-publish-recovery.mjs
    run_patch scripts/patch-pankoff-final-hardening.mjs
    run_patch scripts/patch-pankoff-disable-footer.mjs

    # Shared reliability, output safety and QC structured-output resilience.
    run_patch scripts/patch-autopost-reliability.mjs
    run_patch scripts/patch-ai-output-safety.mjs
    run_patch scripts/patch-quality-check-resilience.mjs

    # Final PANKOFF passes.
    run_patch scripts/patch-pankoff-today-v3.mjs
    run_patch scripts/patch-pankoff-autotest-transport.mjs
    run_patch scripts/patch-autopost-throughput-v1.mjs
    run_patch scripts/patch-shared-media-pipeline-v1.mjs
  else
    # FINCENTRE BUSINESS anti-stall, source recovery, schedule self-heal and style.
    run_patch scripts/patch-fincentre-stall-v2.mjs
    run_patch scripts/patch-fincentre-source-recovery.mjs
    run_patch scripts/patch-fincentre-schedule-defaults.mjs
    run_patch scripts/patch-fincentre-budget-recovery.mjs
    run_patch scripts/patch-fincentre-editorial-v1.mjs

    # Shared reliability, output safety and QC structured-output resilience.
    run_patch scripts/patch-autopost-reliability.mjs
    run_patch scripts/patch-ai-output-safety.mjs
    run_patch scripts/patch-quality-check-resilience.mjs

    # Final business publisher/retry/media passes.
    run_patch scripts/patch-fincentre-publisher-v2.mjs
    run_patch scripts/patch-autopost-throughput-v1.mjs
    run_patch scripts/patch-shared-media-pipeline-v1.mjs
  fi

  echo "[startup] rebuilding patched API and dashboard"
  pnpm --filter @workspace/api-server run build
  pnpm --filter @workspace/dashboard run build
  touch "$RUNTIME_READY"
  echo "[startup] runtime build completed successfully"
fi

if [ -n "${DATABASE_URL:-}" ]; then
  echo "[startup] applying database schema"
  pnpm --filter @workspace/db run push-force
else
  echo "[startup] WARNING: DATABASE_URL is not set"
fi

exec pnpm run start
