#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ "${MP_BROWSER_SKIP_BUILD:-0}" != "1" ]; then
  npm run build
fi

PREVIEW_LOG="${MP_BROWSER_PREVIEW_LOG:-artifacts/browser-preview.log}"
mkdir -p "$(dirname "$PREVIEW_LOG")"

"$ROOT/node_modules/.bin/vite" preview --port 4173 --host 127.0.0.1 --strictPort >"$PREVIEW_LOG" 2>&1 &
PREVIEW_PID=$!
cleanup() {
  kill "$PREVIEW_PID" 2>/dev/null || true
  wait "$PREVIEW_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

ready=0
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:4173/ >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "Browser suite: vite preview never answered on 127.0.0.1:4173" >&2
  tail -80 "$PREVIEW_LOG" >&2 || true
  exit 1
fi

npm run test:routing
npm run audit:clicks
npm run audit:final
npm run audit:launch-polish
npm run test:browser-compat

cleanup
trap - EXIT INT TERM

# These suites bring their own isolated servers. r49 runs last because it
# deliberately rebuilds dist/ against a stub backend.
npm run test:auth-multitab-browser
npm run test:r49-browser
