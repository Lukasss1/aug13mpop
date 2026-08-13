#!/usr/bin/env bash
# ============================================================================
# MILK POP — fail-closed database restore verification
#
# Usage:
#   STAGING_URL=postgres://... scripts/restore-verify.sh <backup-package-dir>
#
# Restores the database dump into a CLEAN disposable PostgreSQL database,
# verifies the exact migration ledger, RLS and critical invariants, and proves
# that Storage metadata matches the backed-up object inventory. Actual Storage
# bytes are verified separately by storage-restore-drill.sh against a linked
# disposable Supabase project.
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
umask 077
: "${STAGING_URL:?set STAGING_URL to a CLEAN disposable database}"
# Keep the connection string out of command arguments and shell output.
export PGDATABASE="$STAGING_URL"
TARGET_IDENTITY="${MP_RESTORE_TARGET_IDENTITY:-disposable-database}"
[[ "$TARGET_IDENTITY" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] || {
  echo 'FATAL: MP_RESTORE_TARGET_IDENTITY contains unsafe characters' >&2
  exit 1
}
PACKAGE="${1:?usage: restore-verify.sh <backup-package-dir>}"
PACKAGE="$(cd "$PACKAGE" && pwd)"

for tool in pg_restore psql node sha256sum; do
  command -v "$tool" >/dev/null || { echo "FATAL: $tool not found" >&2; exit 1; }
done
pg_restore --version | grep -Eq ' 17\.' || { echo 'FATAL: PostgreSQL 17 pg_restore is required' >&2; exit 1; }
psql --version | grep -Eq ' 17\.' || { echo 'FATAL: PostgreSQL 17 psql is required' >&2; exit 1; }

[ -f "$PACKAGE/backup-manifest.json" ] || { echo 'FATAL: backup-manifest.json missing' >&2; exit 1; }
(
  cd "$PACKAGE"
  sha256sum -c backup-manifest.json.sha256
  sha256sum -c database.dump.sha256
)
node scripts/verify-backup-package.mjs "$PACKAGE" release-manifest.json

EXISTING="$(psql -X -v ON_ERROR_STOP=1 -Atc "select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')")"
[ "$EXISTING" = '0' ] || { echo "REFUSED: staging database is not empty ($EXISTING non-system tables)" >&2; exit 1; }

pg_restore --no-owner --dbname="$PGDATABASE" "$PACKAGE/database.dump"

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
psql -X -v ON_ERROR_STOP=1 -Atc \
  "select coalesce(json_agg(json_build_object('ordinal', ordinal, 'filename', filename, 'checksum', checksum) order by ordinal), '[]'::json)::text from public.mp_migration_ledger" \
  > "$TMP/restored-ledger.json"
node scripts/verify-backup-ledger.mjs "$TMP/restored-ledger.json" release-manifest.json
cmp -s "$PACKAGE/database-ledger.json" "$TMP/restored-ledger.json" || {
  echo 'FATAL: restored migration ledger differs from the backup snapshot' >&2
  exit 1
}

psql -X -v ON_ERROR_STOP=1 -Atc \
  "select coalesce(json_agg(json_build_object('bucket', bucket_id, 'name', name, 'declared_size', metadata->>'size', 'content_type', metadata->>'mimetype', 'updated_at', to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by bucket_id, name), '[]'::json)::text from storage.objects where bucket_id in ('cvs','menu-media','staff-documents','training-media')" \
  > "$TMP/restored-storage-objects.json"
cmp -s "$PACKAGE/storage-objects.json" "$TMP/restored-storage-objects.json" || {
  echo 'FATAL: restored Storage metadata differs from the backup snapshot' >&2
  exit 1
}

CHECKS_SQL="$TMP/checks.sql"
cat > "$CHECKS_SQL" <<'SQL'
\set ON_ERROR_STOP on
select case when (select count(*) from pg_tables where schemaname='public') > 0 then 1 else 1/0 end;
select case when not exists (
  select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r','p')
     and c.relname not in ('mp_migration_ledger')
     and not c.relrowsecurity
) then 1 else 1/0 end;
select case when not exists (
  select 1 from public.mp_migration_ledger
   where ordinal is null or checksum !~ '^[0-9a-f]{64}$'
) then 1 else 1/0 end;
select case when (select count(*) from public.mp_migration_ledger) > 0 then 1 else 1/0 end;
select case when not exists (select 1 from public.orders where total < 0 or subtotal < 0) then 1 else 1/0 end;
select case when not exists (select 1 from public.clock_history where total_decimal_hours < 0) then 1 else 1/0 end;
select case when not exists (select 1 from public.staff_profiles where auth_id is not null and auth_id::text = '') then 1 else 1/0 end;
SQL
psql -X -v ON_ERROR_STOP=1 -q -f "$CHECKS_SQL" >/dev/null

TS="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="${MP_RESTORE_REPORT:-restore-report-${TS}.md}"
REPORT_JSON="${MP_RESTORE_REPORT_JSON:-restore-report-${TS}.json}"
[ ! -e "$REPORT" ] || { echo "FATAL: restore report already exists: $REPORT" >&2; exit 1; }
[ ! -e "$REPORT_JSON" ] || { echo "FATAL: restore JSON receipt already exists: $REPORT_JSON" >&2; exit 1; }
PUBLIC_TABLES="$(psql -X -v ON_ERROR_STOP=1 -Atc "select count(*) from pg_tables where schemaname='public'")"
LEDGER_COUNT="$(psql -X -v ON_ERROR_STOP=1 -Atc 'select count(*) from public.mp_migration_ledger')"
STORAGE_COUNT="$(node -e "console.log(require(process.argv[1]).length)" "$PACKAGE/storage-objects.json")"
REPORT_TMP="${REPORT}.tmp.$$"
cat > "$REPORT_TMP" <<EOF_REPORT
# Restore verification report — $TS

- Backup package: $PACKAGE
- Database dump SHA-256: $(cut -d' ' -f1 "$PACKAGE/database.dump.sha256")
- Public tables restored: $PUBLIC_TABLES
- Migration ledger entries verified: $LEDGER_COUNT
- Storage metadata rows verified: $STORAGE_COUNT
- RLS enabled across public application tables: yes
- Critical financial/time invariants: passed
- Database restore accepted: yes
- Storage file bytes restored: not part of this database-only drill

The complete backup is accepted only after `scripts/storage-restore-drill.sh`
also passes against a disposable linked Supabase project.
EOF_REPORT
chmod 600 "$REPORT_TMP"
mv "$REPORT_TMP" "$REPORT"

PACKAGE_MANIFEST_SHA256="$(sha256sum "$PACKAGE/backup-manifest.json" | cut -d' ' -f1)"
SOURCE_TREE_SHA256="$(node -e "console.log(require(process.argv[1]).source_tree_sha256)" "$PACKAGE/backup-manifest.json")"
MIGRATION_FINGERPRINT="$(node -e "console.log(require(process.argv[1]).migration_fingerprint_sha256)" "$PACKAGE/backup-manifest.json")"
REPORT_JSON_TMP="${REPORT_JSON}.tmp.$$"
cat > "$REPORT_JSON_TMP" <<EOF_JSON
{
  "format_version": 1,
  "kind": "database_restore",
  "status": "pass",
  "verified_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "backup_manifest_sha256": "$PACKAGE_MANIFEST_SHA256",
  "source_tree_sha256": "$SOURCE_TREE_SHA256",
  "migration_fingerprint_sha256": "$MIGRATION_FINGERPRINT",
  "target_database_identity": "$TARGET_IDENTITY",
  "public_table_count": $PUBLIC_TABLES,
  "migration_count": $LEDGER_COUNT,
  "storage_metadata_count": $STORAGE_COUNT
}
EOF_JSON
chmod 600 "$REPORT_JSON_TMP"
mv "$REPORT_JSON_TMP" "$REPORT_JSON"
echo "DATABASE_RESTORE_VERIFY_PASS report=$REPORT json=$REPORT_JSON tables=$PUBLIC_TABLES migrations=$LEDGER_COUNT storage_metadata=$STORAGE_COUNT"
