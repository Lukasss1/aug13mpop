#!/usr/bin/env bash
# ============================================================================
# MILK POP — complete operator backup package
#
# Usage:
#   DATABASE_URL=postgres://... \
#   SUPABASE_URL=https://<project-ref>.supabase.co \
#   SUPABASE_ACCESS_TOKEN=... \
#   SUPABASE_PROJECT_REF=<project-ref> \
#   scripts/backup-export.sh [output-root]
#
# The repository must be linked to exactly SUPABASE_PROJECT_REF. The package
# contains a PostgreSQL custom-format dump, the exact migration ledger and all
# objects from the four application Storage buckets. It is created privately
# (umask 077) and is NOT accepted until the database and Storage restore drills
# have both passed.
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
umask 077

: "${DATABASE_URL:?set DATABASE_URL to the source database}"
: "${SUPABASE_URL:?set SUPABASE_URL to the source project URL}"
: "${SUPABASE_ACCESS_TOKEN:?set SUPABASE_ACCESS_TOKEN for the linked Storage CLI}"
: "${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF to the linked source project}"
[[ "$SUPABASE_PROJECT_REF" =~ ^[a-z0-9-]{3,64}$ ]] || {
  echo 'FATAL: SUPABASE_PROJECT_REF is invalid' >&2
  exit 1
}
# Keep the connection string out of command arguments and shell output.
export PGDATABASE="$DATABASE_URL"

for tool in pg_dump pg_restore psql node sha256sum supabase; do
  command -v "$tool" >/dev/null || { echo "FATAL: $tool not found" >&2; exit 1; }
done
pg_dump --version | grep -Eq ' 17\.' || { echo 'FATAL: PostgreSQL 17 pg_dump is required' >&2; exit 1; }
pg_restore --version | grep -Eq ' 17\.' || { echo 'FATAL: PostgreSQL 17 pg_restore is required' >&2; exit 1; }
psql --version | grep -Eq ' 17\.' || { echo 'FATAL: PostgreSQL 17 psql is required' >&2; exit 1; }
[ "$(supabase --version)" = '2.84.2' ] || { echo 'FATAL: Supabase CLI 2.84.2 is required' >&2; exit 1; }

EXPECTED_URL="https://${SUPABASE_PROJECT_REF}.supabase.co"
[ "${SUPABASE_URL%/}" = "$EXPECTED_URL" ] || {
  echo 'FATAL: SUPABASE_URL does not match SUPABASE_PROJECT_REF' >&2
  exit 1
}
LINK_FILE="${MP_LINKED_PROJECT_REF_FILE:-$ROOT/supabase/.temp/project-ref}"
[ -f "$LINK_FILE" ] || {
  echo "FATAL: Supabase project is not linked ($LINK_FILE missing)" >&2
  exit 1
}
[ "$(tr -d '\r\n' < "$LINK_FILE")" = "$SUPABASE_PROJECT_REF" ] || {
  echo 'FATAL: linked Supabase project does not match SUPABASE_PROJECT_REF' >&2
  exit 1
}

OUT_ROOT="${1:-backups}"
TS="${MP_BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
CREATED_AT="${MP_BACKUP_CREATED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
NAME="milkpop-backup-${TS}"
FINAL="$OUT_ROOT/$NAME"
TMP="$OUT_ROOT/.${NAME}.tmp.$$"
[ ! -e "$FINAL" ] || { echo "FATAL: backup target already exists: $FINAL" >&2; exit 1; }
mkdir -p "$OUT_ROOT" "$TMP/storage"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

storage_inventory() {
  psql -X -v ON_ERROR_STOP=1 -Atc \
    "select coalesce(json_agg(json_build_object('bucket', bucket_id, 'name', name, 'declared_size', metadata->>'size', 'content_type', metadata->>'mimetype', 'updated_at', to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by bucket_id, name), '[]'::json)::text from storage.objects where bucket_id in ('cvs','menu-media','staff-documents','training-media')"
}

# The dump and Storage API cannot form one distributed transaction. Requiring
# the metadata inventory to stay unchanged across the whole operation prevents
# a package whose database snapshot and file inventory clearly disagree.
printf 'Capturing pre-dump Storage inventory...\n'
storage_inventory > "$TMP/storage-objects-before.json"

printf 'Creating PostgreSQL dump...\n'
pg_dump --format=custom --no-owner --file="$TMP/database.dump"
[ -s "$TMP/database.dump" ] || { echo 'FATAL: database dump is empty' >&2; exit 1; }
pg_restore --list "$TMP/database.dump" >/dev/null
(
  cd "$TMP"
  sha256sum database.dump > database.dump.sha256
)

printf 'Capturing exact migration ledger...\n'
psql -X -v ON_ERROR_STOP=1 -Atc \
  "select coalesce(json_agg(json_build_object('ordinal', ordinal, 'filename', filename, 'checksum', checksum) order by ordinal), '[]'::json)::text from public.mp_migration_ledger" \
  > "$TMP/database-ledger.json"
node scripts/verify-backup-ledger.mjs "$TMP/database-ledger.json" release-manifest.json

printf 'Capturing post-dump Storage inventory...\n'
storage_inventory > "$TMP/storage-objects.json"
cmp -s "$TMP/storage-objects-before.json" "$TMP/storage-objects.json" || {
  echo 'FATAL: Storage inventory changed while the database dump was being created; retry during a quiet window' >&2
  exit 1
}

BUCKETS=(cvs menu-media staff-documents training-media)
for bucket in "${BUCKETS[@]}"; do
  mkdir -p "$TMP/storage/$bucket"
  COUNT="$(node -e "const x=require(process.argv[1]); console.log(x.filter(o=>o.bucket===process.argv[2]).length)" "$TMP/storage-objects.json" "$bucket")"
  if [ "$COUNT" -gt 0 ]; then
    printf 'Downloading Storage bucket %s (%s objects)...\n' "$bucket" "$COUNT"
    supabase storage cp "ss://$bucket" "$TMP/storage/$bucket" -r --experimental --linked
  else
    printf 'Storage bucket %s is empty; recording empty directory.\n' "$bucket"
  fi
done

printf 'Confirming Storage inventory remained stable during object download...\n'
storage_inventory > "$TMP/storage-objects-after.json"
cmp -s "$TMP/storage-objects.json" "$TMP/storage-objects-after.json" || {
  echo 'FATAL: Storage inventory changed while file bytes were downloading; discard this package and retry' >&2
  exit 1
}
rm -f "$TMP/storage-objects-before.json" "$TMP/storage-objects-after.json"

node scripts/storage-backup-manifest.mjs \
  "$TMP/storage-objects.json" "$TMP/storage" "$TMP/storage-manifest.json"

MP_BACKUP_CREATED_AT="$CREATED_AT" node scripts/write-backup-package-manifest.mjs \
  "$TMP" release-manifest.json "$TMP/backup-manifest.json"
(
  cd "$TMP"
  sha256sum backup-manifest.json > backup-manifest.json.sha256
)
node scripts/verify-backup-package.mjs "$TMP" release-manifest.json

mv "$TMP" "$FINAL"
trap - EXIT
printf '\nCOMPLETE_BACKUP_CREATED %s\n' "$FINAL"
printf 'Database and Storage bytes are included. This package is NOT accepted until both restore drills pass.\n'
