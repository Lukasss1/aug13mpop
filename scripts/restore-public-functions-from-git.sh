#!/usr/bin/env bash
# Restore the complete public/staff Edge Function source from a previously live
# trusted Git commit. Previous function SOURCE comes from history; today's
# audited 14-function inventory/JWT policy remains the deployment authority.
# This helper never changes database state, frontend state, or deferred POS.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT="${1:-}"
EXPECTED_SET_SHA="${2:-}"
[[ "$COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo 'function rollback: expected a 40-character lowercase Git commit' >&2; exit 2; }
[[ "$EXPECTED_SET_SHA" =~ ^[a-f0-9]{64}$ ]] || { echo 'function rollback: expected predecessor public function-set sha256' >&2; exit 2; }
[[ -n "${MP_SUPABASE_PROJECT_REF:-}" ]] || { echo 'function rollback: MP_SUPABASE_PROJECT_REF is required' >&2; exit 2; }
for cmd in git tar supabase node; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "function rollback: $cmd is required" >&2; exit 2; }
done

git -C "$ROOT" cat-file -e "${COMMIT}^{commit}" 2>/dev/null \
  || { echo "function rollback: previous live commit is not present in repository history: $COMMIT" >&2; exit 1; }
git -C "$ROOT" merge-base --is-ancestor "$COMMIT" HEAD 2>/dev/null \
  || { echo "function rollback: previous live commit is not an ancestor of the reviewed release source: $COMMIT" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/milkpop-function-rollback.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
mkdir -p "$TMP/launch" "$TMP/scripts/lib" "$TMP/supabase"

# Only historical function source comes from the predecessor commit. Current
# deployment code remains authoritative, preventing an old helper/config from
# widening today's v0.1 production surface.
git -C "$ROOT" archive "$COMMIT" -- supabase/functions | tar -x -C "$TMP"
cp "$ROOT/launch/deploy-public-functions.sh" "$TMP/launch/deploy-public-functions.sh"
cp "$ROOT/scripts/public-function-set-hash.mjs" "$TMP/scripts/public-function-set-hash.mjs"
cp "$ROOT/scripts/lib/release-hash.mjs" "$TMP/scripts/lib/release-hash.mjs"
cp "$ROOT/scripts/lib/edge-function-inventory.mjs" "$TMP/scripts/lib/edge-function-inventory.mjs"
if [[ -f "$ROOT/supabase/config.toml" ]]; then cp "$ROOT/supabase/config.toml" "$TMP/supabase/config.toml"; fi
chmod +x "$TMP/launch/deploy-public-functions.sh" "$TMP/scripts/public-function-set-hash.mjs"

ACTUAL_SET_SHA="$(cd "$TMP" && node scripts/public-function-set-hash.mjs)"
if [[ "$ACTUAL_SET_SHA" != "$EXPECTED_SET_SHA" ]]; then
  echo "function rollback: predecessor function source hash $ACTUAL_SET_SHA does not match trusted live marker $EXPECTED_SET_SHA" >&2
  exit 1
fi

echo "FUNCTION_ROLLBACK_SOURCE commit=$COMMIT public_function_set_sha256=$ACTUAL_SET_SHA"
(
  cd "$TMP"
  bash launch/deploy-public-functions.sh
)
echo "FUNCTION_ROLLBACK_PASS commit=$COMMIT public_function_set_sha256=$ACTUAL_SET_SHA count=14 pos_deferred=3"
