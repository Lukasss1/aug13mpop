#!/usr/bin/env bash
# Explicit later-stage activation for the still-developing POS/Web Till product.
# Do not run this as part of the public-website launch.
set -euo pipefail

if ! command -v supabase >/dev/null 2>&1; then
  echo "deploy-pos-functions: Supabase CLI is required" >&2
  exit 2
fi

PROJECT_ARGS=()
if [[ -n "${MP_SUPABASE_PROJECT_REF:-}" ]]; then
  PROJECT_ARGS=(--project-ref "$MP_SUPABASE_PROJECT_REF")
fi

for fn in pos-pair pos-ingest pos-catalog; do
  echo "Deploying $fn (Verify JWT OFF; device/pairing credential enforced inside)…"
  supabase functions deploy "$fn" "${PROJECT_ARGS[@]}" --no-verify-jwt
done

echo "POS_FUNCTION_DEPLOY_PASS (3 functions)"
