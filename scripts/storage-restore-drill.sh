#!/usr/bin/env bash
# ============================================================================
# MILK POP — Storage restore and byte-for-byte verification drill
#
# Usage:
#   SUPABASE_ACCESS_TOKEN=... \
#   SUPABASE_PROJECT_REF=<disposable-target-ref> \
#   SUPABASE_URL=https://<disposable-target-ref>.supabase.co \
#   MP_STORAGE_RESTORE_CONFIRMATION="RESTORE STORAGE <disposable-target-ref>" \
#   scripts/storage-restore-drill.sh <backup-package-dir>
#
# The repository must be linked to exactly the disposable target project. The
# script uploads all four bucket trees, downloads every bucket again (including
# buckets expected to be empty), and compares every object byte-for-byte against
# the backup manifest. Never use this drill casually against a live project.
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
umask 077
PACKAGE="${1:?usage: storage-restore-drill.sh <backup-package-dir>}"
PACKAGE="$(cd "$PACKAGE" && pwd)"
: "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN}"
: "${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF to the disposable target}"
: "${SUPABASE_URL:?set SUPABASE_URL to the disposable target URL}"
: "${MP_STORAGE_RESTORE_CONFIRMATION:?set the exact restore confirmation phrase}"
[[ "$SUPABASE_PROJECT_REF" =~ ^[a-z0-9-]{3,64}$ ]] || {
  echo 'FATAL: SUPABASE_PROJECT_REF is invalid' >&2
  exit 1
}

command -v supabase >/dev/null || { echo 'FATAL: supabase CLI not found' >&2; exit 1; }
command -v node >/dev/null || { echo 'FATAL: node not found' >&2; exit 1; }
command -v sha256sum >/dev/null || { echo 'FATAL: sha256sum not found' >&2; exit 1; }
[ "$(supabase --version)" = '2.84.2' ] || { echo 'FATAL: Supabase CLI 2.84.2 is required' >&2; exit 1; }
EXPECTED_URL="https://${SUPABASE_PROJECT_REF}.supabase.co"
[ "${SUPABASE_URL%/}" = "$EXPECTED_URL" ] || { echo 'FATAL: SUPABASE_URL/project-ref mismatch' >&2; exit 1; }
[ "$MP_STORAGE_RESTORE_CONFIRMATION" = "RESTORE STORAGE $SUPABASE_PROJECT_REF" ] || {
  echo 'FATAL: destructive confirmation phrase mismatch' >&2
  exit 1
}
LINK_FILE="${MP_LINKED_PROJECT_REF_FILE:-$ROOT/supabase/.temp/project-ref}"
[ -f "$LINK_FILE" ] || { echo "FATAL: linked project file missing: $LINK_FILE" >&2; exit 1; }
[ "$(tr -d '\r\n' < "$LINK_FILE")" = "$SUPABASE_PROJECT_REF" ] || {
  echo 'FATAL: linked Supabase project does not match the requested target' >&2
  exit 1
}
node scripts/verify-backup-package.mjs "$PACKAGE" release-manifest.json
SOURCE_PROJECT_REF="$(node -e "console.log(require(process.argv[1]).project_ref)" "$PACKAGE/backup-manifest.json")"
if [ "$SUPABASE_PROJECT_REF" = "$SOURCE_PROJECT_REF" ]; then
  EXPECTED_SOURCE_OVERRIDE="RESTORE SOURCE STORAGE $SUPABASE_PROJECT_REF"
  [ "${MP_ALLOW_SOURCE_PROJECT_STORAGE_RESTORE:-}" = "$EXPECTED_SOURCE_OVERRIDE" ] || {
    echo 'FATAL: normal recovery drills must use a different disposable project; restoring into the source project requires MP_ALLOW_SOURCE_PROJECT_STORAGE_RESTORE="RESTORE SOURCE STORAGE <project-ref>"' >&2
    exit 1
  }
fi

VERIFY_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$VERIFY_ROOT"; }
trap cleanup EXIT
BUCKETS=(cvs menu-media staff-documents training-media)
for bucket in "${BUCKETS[@]}"; do
  COUNT="$(node -e "const x=require(process.argv[1]); console.log(x.bucket_counts[process.argv[2]]||0)" "$PACKAGE/storage-manifest.json" "$bucket")"
  if [ "$COUNT" -gt 0 ]; then
    echo "Restoring Storage bucket $bucket ($COUNT objects)..."
    supabase storage cp "$PACKAGE/storage/$bucket" "ss://$bucket" -r --experimental --linked
  else
    echo "Storage bucket $bucket should be empty; verifying the target contains no extra objects..."
  fi
  # Always download the target bucket. Skipping an expected-empty bucket would
  # allow stale or unexpected target objects to escape verification.
  mkdir -p "$VERIFY_ROOT/$bucket"
  supabase storage cp "ss://$bucket" "$VERIFY_ROOT/$bucket" -r --experimental --linked
 done
node scripts/storage-backup-manifest.mjs \
  "$PACKAGE/storage-objects.json" "$VERIFY_ROOT" "$VERIFY_ROOT/restored-storage-manifest.json"
cmp -s "$PACKAGE/storage-manifest.json" "$VERIFY_ROOT/restored-storage-manifest.json" || {
  echo 'FATAL: restored Storage manifest differs from the backup' >&2
  exit 1
}
OBJECT_COUNT="$(node -e "console.log(require(process.argv[1]).object_count)" "$PACKAGE/storage-manifest.json")"
TOTAL_BYTES="$(node -e "console.log(require(process.argv[1]).total_bytes)" "$PACKAGE/storage-manifest.json")"
PACKAGE_MANIFEST_SHA256="$(sha256sum "$PACKAGE/backup-manifest.json" | cut -d' ' -f1)"
SOURCE_TREE_SHA256="$(node -e "console.log(require(process.argv[1]).source_tree_sha256)" "$PACKAGE/backup-manifest.json")"
MIGRATION_FINGERPRINT="$(node -e "console.log(require(process.argv[1]).migration_fingerprint_sha256)" "$PACKAGE/backup-manifest.json")"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT_JSON="${MP_STORAGE_RESTORE_REPORT:-storage-restore-report-${TS}.json}"
[ ! -e "$REPORT_JSON" ] || { echo "FATAL: Storage restore receipt already exists: $REPORT_JSON" >&2; exit 1; }
REPORT_JSON_TMP="${REPORT_JSON}.tmp.$$"
cat > "$REPORT_JSON_TMP" <<EOF_JSON
{
  "format_version": 1,
  "kind": "storage_restore",
  "status": "pass",
  "verified_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "backup_manifest_sha256": "$PACKAGE_MANIFEST_SHA256",
  "source_tree_sha256": "$SOURCE_TREE_SHA256",
  "migration_fingerprint_sha256": "$MIGRATION_FINGERPRINT",
  "target_project_ref": "$SUPABASE_PROJECT_REF",
  "storage_object_count": $OBJECT_COUNT,
  "storage_total_bytes": $TOTAL_BYTES
}
EOF_JSON
chmod 600 "$REPORT_JSON_TMP"
mv "$REPORT_JSON_TMP" "$REPORT_JSON"
echo "STORAGE_RESTORE_DRILL_PASS project=$SUPABASE_PROJECT_REF objects=$OBJECT_COUNT bytes=$TOTAL_BYTES report=$REPORT_JSON"
