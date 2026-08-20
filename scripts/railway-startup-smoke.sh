#!/bin/sh
set -e

# CI-only smoke test for the variables required by Vite during Railway runtime rebuilds.
unset PORT
unset BASE_PATH
export PORT="${PORT:-3000}"
export BASE_PATH="${BASE_PATH:-/}"

[ "$PORT" = "3000" ]
[ "$BASE_PATH" = "/" ]
sh -n scripts/start-railway.sh

echo "Railway startup defaults are valid"
