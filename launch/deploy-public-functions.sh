#!/usr/bin/env bash
# Deploy exactly the code-owned public/staff Edge Function inventory. POS/Web
# Till functions are intentionally excluded until separately commissioned.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

for cmd in supabase node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "deploy-public-functions: $cmd is required" >&2
    exit 2
  fi
done

PROJECT_ARGS=()
if [[ -n "${MP_SUPABASE_PROJECT_REF:-}" ]]; then
  PROJECT_ARGS=(--project-ref "$MP_SUPABASE_PROJECT_REF")
fi

SHARED_SHA="$(node scripts/lib/release-hash.mjs --dir supabase/functions/_shared)"
PUBLIC_SET_SHA="$(node scripts/public-function-set-hash.mjs)"
echo "FUNCTION_SHARED_SOURCE sha256=$SHARED_SHA"
echo "PUBLIC_FUNCTION_SET_SOURCE sha256=$PUBLIC_SET_SHA"

mapfile -t FUNCTION_ROWS < <(node --input-type=module -e '
  import { PUBLIC_FUNCTIONS } from "./scripts/lib/edge-function-inventory.mjs";
  for (const [name, mode] of PUBLIC_FUNCTIONS) process.stdout.write(`${name}\t${mode}\n`);
')

if [[ ${#FUNCTION_ROWS[@]} -ne 14 ]]; then
  echo "deploy-public-functions: code-owned public function inventory must contain exactly 14 functions" >&2
  exit 2
fi

DEPLOYED_FUNCTIONS=()
on_deploy_error() {
  local rc=$?
  trap - ERR
  local joined="none"
  if [[ ${#DEPLOYED_FUNCTIONS[@]} -gt 0 ]]; then
    joined="$(IFS=,; printf '%s' "${DEPLOYED_FUNCTIONS[*]}")"
  fi
  echo "FUNCTION_DEPLOY_INCOMPLETE deployed_count=${#DEPLOYED_FUNCTIONS[@]} deployed=$joined" >&2
  echo "FUNCTION_DEPLOY_RECOVERY_REQUIRED — production may contain a mixed function set. Restore the complete previously trusted 14-function set before continuing, or on first release re-run this exact candidate after correcting the provider failure." >&2
  exit "$rc"
}
trap on_deploy_error ERR

deploy() {
  local fn="$1"
  local verify_mode="$2"
  local fn_sha
  fn_sha="$(node scripts/lib/release-hash.mjs --dir "supabase/functions/$fn")"
  echo "FUNCTION_SOURCE name=$fn sha256=$fn_sha shared_sha256=$SHARED_SHA verify_jwt=$verify_mode"
  if [[ "$verify_mode" = "on" ]]; then
    echo "Deploying $fn (Verify JWT ON)…"
    supabase functions deploy "$fn" "${PROJECT_ARGS[@]}"
  elif [[ "$verify_mode" = "off" ]]; then
    echo "Deploying $fn (Verify JWT OFF; code-owned inventory)…"
    supabase functions deploy "$fn" "${PROJECT_ARGS[@]}" --no-verify-jwt
  else
    echo "deploy-public-functions: unsupported verify_jwt mode for $fn: $verify_mode" >&2
    return 2
  fi
  echo "FUNCTION_DEPLOYED name=$fn sha256=$fn_sha shared_sha256=$SHARED_SHA verify_jwt=$verify_mode"
  DEPLOYED_FUNCTIONS+=("$fn")
}

for row in "${FUNCTION_ROWS[@]}"; do
  IFS=$'\t' read -r fn verify_mode <<< "$row"
  deploy "$fn" "$verify_mode"
done

trap - ERR
echo "FUNCTION_DEPLOY_PASS count=14 public_function_set_sha256=$PUBLIC_SET_SHA pos_deferred=3"
echo "PUBLIC_FUNCTION_DEPLOY_PASS (14 functions; POS deferred)"
