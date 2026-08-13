#!/usr/bin/env bash
# ============================================================================
# stage3-build-baseline.sh — WS13 (launch baseline) + WS14 (equivalence).
#
# REPRODUCIBLE, never hand-concatenated:
#   1. db_chain  ← shim + schema.FRESH-INSTALL-ONLY.sql + full manifest chain   (the truth)
#   2. supabase/launch-baseline-v1.sql ← pg_dump of db_chain's PUBLIC schema
#      (schema-only, no owners; grants/policies/functions/triggers/indexes
#      included) + storage POLICIES and bucket REFERENCE ROWS captured from
#      the live catalogs + an EMPTY-DATABASE GUARD preamble + immutability
#      covenant + chain provenance fingerprint.
#   3. db_base   ← the SAME shim + launch-baseline-v1.sql
#   4. snapshot(db_chain) vs snapshot(db_base) via the WS1 engine, compared
#      canonically by scripts/stage3-baseline-equivalence.test.mjs — FAILS on
#      any meaningful drift. (Both databases are chain-applied without a
#      ledger, so no ledger exclusion is even needed; the dev migration
#      chain itself remains archived as launch/migration-manifest.sh.)
#
# Contains NO business data: staff/stores/orders/applicants never exist in
# the build database. storage.buckets rows are system reference data.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN="/usr/lib/postgresql/17/bin"
[ -x "$PGBIN/psql" ] || { echo "PostgreSQL 17 binaries required at $PGBIN" >&2; exit 1; }
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres "$(pwd)" 2>/dev/null || true
  exec su postgres -s /bin/bash -c "cd '$(pwd)' && bash scripts/stage3-build-baseline.sh"
fi
PGDATA="/tmp/milkpop-base-pg"; PGPORT=54333
cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup; rm -rf "$PGDATA"; mkdir -p "$PGDATA"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-c listen_addresses='127.0.0.1' -c port=$PGPORT -c fsync=off" -w start >/dev/null
PS() { "$PGBIN/psql" -v ON_ERROR_STOP=1 -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$1" "${@:2}"; }
shim() { PS "$1" -f /tmp/mp-shim.sql; }
# R4.10 Increment 4: this used to reconstruct the shim by sed-ing the heredoc
# out of scripts/stage3-inventory.build.sh — a text extraction across files that
# broke silently (producing an EMPTY shim) the moment that heredoc moved. It now
# copies the one shared file, which is the thing it was trying to approximate.
cp scripts/lib/supabase-local-privileges.sql /tmp/mp-shim.sql

"$PGBIN/psql" -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres -c "create database db_chain" >/dev/null
shim db_chain
# shellcheck source=/dev/null
source launch/migration-manifest.sh
PS db_chain -f supabase/schema.FRESH-INSTALL-ONLY.sql >/dev/null
for f in "${MP_MIGRATIONS[@]}"; do PS db_chain -f "$f" >/dev/null; done
echo "db_chain: schema + ${#MP_MIGRATIONS[@]} migrations applied"

OUT=supabase/launch-baseline-v1.sql
CHAINPRINT="$(for f in "${MP_MIGRATIONS[@]}"; do sha256sum "$f"; done | sha256sum | awk '{print $1}')"
gen_baseline() {
  echo "-- ============================================================================"
  echo "-- MILKPOP DATABASE LAUNCH BASELINE v1  (byte-reproducible: identity = chain fingerprint below)"
  echo "-- Built REPRODUCIBLY by scripts/stage3-build-baseline.sh from the effective"
  echo "-- state of the ${#MP_MIGRATIONS[@]}-migration development chain."
  echo "-- Dev-chain provenance fingerprint (sha256 of chain checksums): $CHAINPRINT"
  echo "-- COVENANT: once applied to production this file is IMMUTABLE; every later"
  echo "-- database change is an append-only migration. Contains NO business data."
  echo "-- ============================================================================"
  echo "-- EMPTY-DATABASE GUARD: refuses any target already carrying business schema."
  echo "do \$guard\$ begin"
  echo "  if exists (select 1 from information_schema.tables where table_schema = 'public') then"
  echo "    raise exception 'launch_baseline_refused: target public schema is NOT empty';"
  echo "  end if;"
  echo "end \$guard\$;"
  echo "-- Direct database dependency (re-audit finding 3): the schema uses"
  echo "-- digest()/gen_random_*; the platform usually pre-installs this, but the"
  echo "-- baseline must not silently depend on it."
  echo "create extension if not exists pgcrypto;"
  "$PGBIN/pg_dump" -h 127.0.0.1 -p "$PGPORT" -U postgres -d db_chain \
    --schema-only --schema=public --no-owner \
    | sed 's/^CREATE SCHEMA public;$/-- (public schema pre-exists on every PostgreSQL\/Supabase target)/' \
    | sed -E '/^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES).*\bservice_role\b/d' \
    | grep -v -e '^.restrict ' -e '^.unrestrict ' 
  echo ""
  echo "-- ---- ACL AUTHORITY: the baseline OWNS the final grant state ----"
  echo "-- On any target with Supabase's ALTER DEFAULT PRIVILEGES, a grant-only"
  echo "-- dump would RESURRECT rights the chain revoked (default grants fill the"
  echo "-- gaps). So: revoke everything from the API roles, then re-grant EXACTLY"
  echo "-- the chain's effective table, column and function privileges."
  echo "select pg_catalog.set_config('search_path', 'public', false);"
  PS db_chain -tA -c "select 'revoke all on table public.' || quote_ident(table_name) || ' from anon, authenticated;' from information_schema.tables where table_schema = 'public' order by table_name;"
  PS db_chain -tA -c "select 'revoke all on function public.' || proname || '(' || pg_get_function_identity_arguments(oid) || ') from anon, authenticated;' from pg_proc where pronamespace = 'public'::regnamespace and prokind = 'f' order by 1;"
  PS db_chain -tA -c "select 'grant ' || privilege_type || ' on table public.' || quote_ident(table_name) || ' to ' || grantee || ';' from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon','authenticated') order by table_name, grantee, privilege_type;"
  PS db_chain -tA -c "select 'grant ' || privilege_type || ' (' || quote_ident(column_name) || ') on public.' || quote_ident(table_name) || ' to ' || grantee || ';' from information_schema.column_privileges cp where table_schema = 'public' and grantee in ('anon','authenticated') and not exists (select 1 from information_schema.role_table_grants g where g.table_schema = cp.table_schema and g.table_name = cp.table_name and g.grantee = cp.grantee and g.privilege_type = cp.privilege_type) order by table_name, column_name, grantee, privilege_type;"
  PS db_chain -tA -c "select 'grant execute on function public.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') to ' || rp.grantee || ';' from pg_proc p join information_schema.routine_privileges rp on rp.routine_name = p.proname and rp.routine_schema = 'public' where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and rp.grantee in ('anon','authenticated') group by p.oid, p.proname, rp.grantee order by 1;"
  echo "-- ---- user-defined casts (pg_dump omits CREATE CAST entirely) ----"
  echo "-- The Stage-3 WS2 text->timestamptz/date assignment bridge: without it,"
  echo "-- every text-era server writer breaks on a baseline-installed database."
  PS db_chain -tA -c "select 'do \$c\$ begin if not exists (select 1 from pg_cast c join pg_type s on s.oid=c.castsource join pg_type t on t.oid=c.casttarget where s.typname=' || quote_literal(s.typname) || ' and t.typname=' || quote_literal(t.typname) || ') then create cast (' || s.typname || ' as ' || t.typname || ') with inout as ' || case c.castcontext when 'a' then 'assignment' when 'i' then 'implicit' else 'explicit' end || '; end if; end \$c\$;' from pg_cast c join pg_type s on s.oid = c.castsource join pg_type t on t.oid = c.casttarget where c.oid > 16384 order by 1;"
  echo "-- ---- storage policies (captured from the live chain state) ----"
  PS db_chain -tA -c "select 'create policy ' || quote_ident(policyname) || ' on storage.objects for ' || lower(cmd) || ' to ' || array_to_string(roles, ', ') || coalesce(' using (' || qual || ')', '') || coalesce(' with check (' || with_check || ')', '') || ';' from pg_policies where schemaname = 'storage' order by policyname;"
  echo "-- ---- storage bucket reference rows (system data, not business data) ----"
  PS db_chain -tA -c "select 'insert into storage.buckets (id, name, public) values (' || quote_literal(id) || ', ' || quote_literal(name) || ', ' || public || ') on conflict (id) do nothing;' from storage.buckets order by id;"
  echo "-- ---- collection revision bootstrap rows (P0-3: system data, not business data) ----"
  echo "-- The revision guard's authoritative key set. Without these a baseline-"
  echo "-- installed database dead-ends every first save: the client hydrates no"
  echo "-- revision, sends null, and the null refusal rolls back the checkpoint's"
  echo "-- lazy insert — forever. The server installs every authoritative row"
  echo "-- BEFORE any client hydrates it. Captured from the chain state (like the"
  echo "-- bucket rows above); updated_at is left to its install-time default."
  PS db_chain -tA -c "select 'insert into collection_revisions (table_key, revision) values (' || quote_literal(table_key) || ', ' || revision || ') on conflict (table_key) do nothing;' from collection_revisions order by table_key;"
}
gen_baseline > "$OUT"
echo "baseline written: $OUT ($(wc -l < "$OUT") lines)"
# Round-7 item 10: the reproducibility claim is a GATE, not a report line —
# a second independent generation must be byte-identical or the build FAILS.
gen_baseline > /tmp/mp-baseline-b.sql
if cmp -s "$OUT" /tmp/mp-baseline-b.sql; then
  echo "✔ REPRODUCIBILITY GATE: two independent generations are byte-identical ($(sha256sum "$OUT" | cut -c1-16)…)"
else
  echo "✖ REPRODUCIBILITY GATE FAILED: consecutive builds differ"; diff "$OUT" /tmp/mp-baseline-b.sql | head -6; exit 1
fi

"$PGBIN/psql" -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres -c "create database db_base" >/dev/null
shim db_base
PS db_base -f "$OUT" >/dev/null
echo "db_base: baseline applied clean (guard passed on empty target)"
if PS db_base -f "$OUT" >/dev/null 2>&1; then
  echo "✖ guard FAILED to refuse a non-empty target"; exit 1
else
  echo "✔ guard refuses a non-empty target (second application rejected)"
fi

mkdir -p artifacts
PGHOST=127.0.0.1 PGPORT=$PGPORT PGDB=db_chain PGBINDIR="$PGBIN" node scripts/stage3-schema-snapshot.mjs artifacts/snap-chain.json
PGHOST=127.0.0.1 PGPORT=$PGPORT PGDB=db_base  PGBINDIR="$PGBIN" node scripts/stage3-schema-snapshot.mjs artifacts/snap-baseline.json
node scripts/stage3-baseline-equivalence.test.mjs artifacts/snap-chain.json artifacts/snap-baseline.json
