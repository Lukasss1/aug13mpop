#!/usr/bin/env bash
# =============================================================================
#  Milk Pop — Launch Driver  (launch/launch.sh)
#
#  A runnable, fail-fast launch driver. It executes every
#  [CODE] step in the correct order and STOPS at every [HUMAN] step with a clear
#  instruction and a confirmation gate — it will never silently perform a
#  credential-bearing, destructive, or legal-judgement action for you.
#
#  DESIGN RULES
#    • Ordered to match OWNERS-GUIDE.md "Going live". Do not reorder.
#    • Fail-fast: any command error aborts the whole run (set -Eeuo pipefail).
#    • Idempotent where possible: re-running is safe; already-done [CODE] steps
#      are cheap to repeat. [HUMAN] steps are gated, never auto-run.
#    • Nothing here needs the service-role key on your workstation EXCEPT the
#      optional live-RLS test (§6), which you run in a controlled window.
#
#  USAGE
#    bash launch/launch.sh                 # interactive, walks every phase
#    bash launch/launch.sh --checks-only   # run ONLY the §9 final gate (safe, local)
#    bash launch/launch.sh --db-fresh         # DB §1: fresh install on a NEW empty project
#    bash launch/launch.sh --db-adopt-ledger  # DB §1: record history as the verified baseline
#                                             #        on an EXISTING pre-ledger project (runs nothing)
#    bash launch/launch.sh --db-upgrade       # DB §1: apply only NEW migrations (no schema/seed/replay)
#    bash launch/launch.sh --help
#
#  SUPPORTED ENVIRONMENT
#    Release & database operations below require a Unix shell: WSL2, macOS or
#    Linux. Native Windows PowerShell/CMD is NOT supported for this driver
#    (ordinary `npm run dev` / `npm run build` / `npm run clean` are
#    cross-platform; this script, psql and the bash test harnesses are not).
#
#  PREREQUISITES ON YOUR MACHINE
#    • Node 22.23.2; npm >=10.9.8 <11   (Node is the exact supported baseline;
#                                   npm 10.9.8 is the preferred release baseline)
#    • psql                        (PostgreSQL client — REQUIRED for --db-fresh /
#                                   --db-adopt-ledger / --db-upgrade. SUPABASE_DB_URL
#                                   is MANDATORY for every DB path — there is no
#                                   SQL-editor replay fallback. psql is the only
#                                   supported way this script applies SQL, checked
#                                   before anything touches the DB.)
#    • a SHA-256 tool              (sha256sum, shasum or openssl — for the
#                                   migration ledger; checked up front too)
#    • Supabase CLI (`supabase`)   (for DB push + function deploy) — optional if
#                                   you prefer the SQL editor / dashboard, in
#                                   which case the script prints what to paste.
#    • curl                        (for the header verification in §5)
# =============================================================================

set -Eeuo pipefail

# ---- pretty output ---------------------------------------------------------
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'
BLU=$'\033[34m'; RST=$'\033[0m'
say()   { printf '%s\n' "$*"; }
head2() { printf '\n%s══ %s ══%s\n' "$BOLD" "$*" "$RST"; }
ok()    { printf '%s✔%s %s\n' "$GRN" "$RST" "$*"; }
warn()  { printf '%s⚠%s %s\n' "$YEL" "$RST" "$*"; }
die()   { printf '%s✖ %s%s\n' "$RED" "$*" "$RST" >&2; exit 1; }
human() { printf '\n%s[HUMAN]%s %s\n' "$BLU$BOLD" "$RST" "$*"; }

# Confirmation gate for [HUMAN] steps. Aborts unless the operator types the word.
gate() {
  local prompt="$1" ; local want="${2:-DONE}"
  printf '%s   Type %s to confirm you have completed this, or Ctrl-C to stop: %s' "$DIM" "$want" "$RST"
  read -r reply
  [[ "$reply" == "$want" ]] || die "Not confirmed ($reply != $want). Stopping — resume when the step is done."
}

# CI/commissioning equivalent of a HUMAN gate. It is deliberately opt-in and
# requires a distinct named environment variable with the exact expected
# phrase; MP_NONINTERACTIVE by itself never bypasses a confirmation.
confirmed_gate() {
  local env_name="$1" prompt="$2" want="${3:-DONE}"
  if [[ "${MP_NONINTERACTIVE:-0}" == "1" ]]; then
    local supplied="${!env_name:-}"
    [[ "$supplied" == "$want" ]] || die "Non-interactive confirmation $env_name is missing or incorrect (expected exact phrase: $want)."
    ok "$prompt — confirmed non-interactively by $env_name"
    return 0
  fi
  gate "$prompt" "$want"
}

trap 'die "Aborted at line $LINENO. Nothing after this point has run."' ERR

# OPT-01.2A §3 — ONE global EXIT cleanup for the whole script: it both kills the
# preview server (if started) and removes the 0600 PGPASSFILE + releases the
# deployment lock. Installed once here and never overwritten, so no later trap
# (e.g. the old preview-only trap in final_gate) can leak the password file.
PREVIEW_PID="${PREVIEW_PID:-}"
exit_cleanup() {
  [[ -n "${PREVIEW_PID:-}" ]] && kill "$PREVIEW_PID" 2>/dev/null
  db_cleanup 2>/dev/null || true
  return 0
}
trap 'exit_cleanup' EXIT

# Must be run from repo root (where package.json lives).
[[ -f package.json ]] || die "Run this from the repository root (package.json not found)."

# Resolve this script's own directory so the migration manifest can be sourced
# regardless of the caller's working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
#  Sub-command: final gate only (§9) — safe to run anytime, local-only.
# ---------------------------------------------------------------------------
final_gate() {
  head2 "§9  FINAL GATE — all five must pass"
  # OPT-01: configuration coherence comes FIRST. Advisory when
  # VITE_DEPLOYMENT_MODE is unset/development; a HARD fail in production —
  # the same script the "prebuild" hook runs on the host, so an incoherent
  # production configuration cannot build there either.
  say "1/5 deployment environment validation…"
  npm run validate:env
  ok "environment validation passed"
  # OPT-01: the final gate runs the COMPLETE verify chain — typecheck,
  # security regression, static RLS, POS + WP-01..04 + OPT-01 contracts,
  # safeurl, css-assets, allowlist, site content, and the built-bundle
  # secret scan — not a hand-picked subset that can drift from it.
  say "2/5 full verification chain (npm run verify)…"
  npm run verify
  ok "verify chain green"
  # Steps 3–5 drive the BUILT site in headless Chromium.
  # One-time setup on a new machine: npm exec --offline -- playwright install chromium
  say "3–5 starting vite preview for the browser-driven suites…"
  ./node_modules/.bin/vite preview --port 4173 >/dev/null 2>&1 &
  PREVIEW_PID=$!
  # The global exit_cleanup (installed at startup) kills PREVIEW_PID on exit; do
  # not install a preview-only EXIT trap here — it would drop the PGPASSFILE
  # cleanup (OPT-01.2A §3).
  sleep 3
  say "3/5 routing + SEO smoke (38 checks)…"
  npm run test:routing
  ok "routing smoke passed"
  say "4/5 prelaunch click audit (29 checks)…"
  npm run audit:clicks
  ok "click audit passed"
  say "5/5 final deployment audit (99 checks: every route, head parity, forms fail-closed, mobile)…"
  npm run audit:final
  ok "final deployment audit passed"
  kill "$PREVIEW_PID" 2>/dev/null; PREVIEW_PID=""
  printf '\n%s✔ FINAL GATE GREEN.%s Still required before launch: a clean live-RLS run (§6) and header verification (§5).\n' "$GRN$BOLD" "$RST"
}

# ---------------------------------------------------------------------------
#  Database sub-commands (§1) — the migration ORDER comes from the single
#  authoritative manifest (launch/migration-manifest.sh); nothing here keeps
#  its own copy. Two explicit paths so a normal upgrade can NEVER run the
#  clean-slate schema:
#     --db-fresh          brand-new EMPTY project: schema + seed + chain
#     --db-adopt-ledger   EXISTING project already at the verified final
#                         pre-ledger baseline: RECORD the chain, run nothing
#     --db-resume-install bootstrap-pending partial FRESH: finish only NEW
#                         migrations; refuses any real user/business data
#     --db-upgrade        ledger-managed operating project: apply only GENUINELY
#                         NEW migrations (never replays history)
#  Application uses psql with ON_ERROR_STOP=1 (spec: no unproven `supabase db
#  execute`). SUPABASE_DB_URL must be a production-compatible PostgreSQL URI.
#  GitHub Actions uses Supabase's Session Pooler path; direct Postgres is also
#  valid from environments that can reach the project's direct endpoint. The
#  URL is REQUIRED for every DB path (there is no SQL-editor replay fallback).
# ---------------------------------------------------------------------------
# shellcheck source=launch/migration-manifest.sh
source "$SCRIPT_DIR/migration-manifest.sh"

# OPT-01.2 §7 — one deployment advisory-lock key shared by --db-upgrade and
# --db-adopt-ledger, so two runners can never modify the same database at once.
MP_LOCK_KEY1=79215   # 'MP'
MP_LOCK_KEY2=76207   # 'LG'
BASELINE_VERSION_TAG=""   # set by mp_baseline_version() lazily

# OPT-01.2 §8 — CREDENTIALS STAY OUT OF THE PROCESS TABLE. The URL (and its
# password) is parsed ONCE into libpq environment variables; the password goes
# into a 0600 PGPASSFILE, never into argv and never into the process
# environment. Every psql call then connects via the environment with NO
# conninfo argument. `pg` is that wrapper.
pg() { psql -v ON_ERROR_STOP=1 -X "$@"; }

MP_PGPASS=""
db_connect_init() {
  [[ -n "${SUPABASE_DB_URL:-}" ]] || die \
    "SUPABASE_DB_URL is not set. The verified ledger runner needs a PostgreSQL connection URI. GitHub Actions should use the Supabase Session Pooler URI; a direct URI is also valid from environments that can reach it. There is NO SQL-editor replay fallback — set SUPABASE_DB_URL and re-run."
  require_db_tools
  local u="$SUPABASE_DB_URL" rest userinfo hostportdb hostport host port db query user pass
  rest="${u#*://}"
  userinfo=""; if [[ "$rest" == *@* ]]; then userinfo="${rest%@*}"; rest="${rest##*@}"; fi
  hostportdb="$rest"; query=""
  if [[ "$hostportdb" == *\?* ]]; then query="${hostportdb#*\?}"; hostportdb="${hostportdb%%\?*}"; fi
  hostport="${hostportdb%%/*}"; db="${hostportdb#"$hostport"}"; db="${db#/}"
  host="$hostport"; port="5432"
  if [[ "$hostport" == *:* ]]; then host="${hostport%:*}"; port="${hostport##*:}"; fi
  user=""; pass=""
  if [[ -n "$userinfo" ]]; then user="${userinfo%%:*}"; [[ "$userinfo" == *:* ]] && pass="${userinfo#*:}"; fi
  # minimal percent-decoding for userinfo (%40 → '@', etc.)
  [[ -n "$user" ]] && user="$(printf '%b' "${user//%/\\x}")"
  [[ -n "$pass" ]] && pass="$(printf '%b' "${pass//%/\\x}")"
  export PGHOST="$host" PGPORT="$port" PGDATABASE="${db:-postgres}"
  [[ -n "$user" ]] && export PGUSER="$user"
  if [[ "$query" == *sslmode=* ]]; then local sm="${query#*sslmode=}"; sm="${sm%%&*}"; export PGSSLMODE="$sm"; fi
  if [[ -n "$pass" ]]; then
    MP_PGPASS="$(mktemp "${TMPDIR:-/tmp}/mp-pgpass.XXXXXX")"; chmod 600 "$MP_PGPASS"
    # OPT-01.2A §5 — .pgpass is colon-delimited with backslash escaping; a field
    # containing ':' or '\' MUST be escaped or libpq mis-parses it and auth fails.
    printf '%s:%s:%s:%s:%s\n' \
      "$(pgpass_escape "$host")" "$(pgpass_escape "$port")" \
      "$(pgpass_escape "${db:-postgres}")" "$(pgpass_escape "${user:-*}")" \
      "$(pgpass_escape "$pass")" > "$MP_PGPASS"
    export PGPASSFILE="$MP_PGPASS"
  fi
  # OPT-01.2A §3 — cleanup is handled by the single global EXIT trap
  # (exit_cleanup, installed at startup); do NOT install a second EXIT trap here,
  # or a later trap (e.g. final_gate's preview-kill) would silently replace it and
  # leak the 0600 PGPASSFILE.
}
# .pgpass field escaping: backslash first, then colon (order matters).
pgpass_escape() { local v="$1"; v="${v//\\/\\\\}"; v="${v//:/\\:}"; printf '%s' "$v"; }
db_cleanup() { deploy_lock_release; [[ -n "${MP_PGPASS:-}" ]] && rm -f "$MP_PGPASS" 2>/dev/null; MP_PGPASS=""; }

run_sql_file() { pg -f "$1"; }   # ON_ERROR_STOP=1; set -Eeuo pipefail then aborts

# T13.3.29: fresh schema + production seed + empty ledger are one atomic baseline. If seed
# and schema drift, the whole baseline rolls back instead of leaving a
# half-installed project. The ordered migrations remain separately ledgered.
run_fresh_baseline_atomic() {
  [[ "${#MP_FRESH_ONLY[@]}" -eq 2 ]] \
    || die "FRESH BASELINE CONTRACT: MP_FRESH_ONLY must contain exactly schema + seed."
  [[ "${MP_FRESH_ONLY[0]}" == "supabase/schema.FRESH-INSTALL-ONLY.sql" ]] \
    || die "FRESH BASELINE CONTRACT: schema must be first."
  [[ "${MP_FRESH_ONLY[1]}" == "supabase/seed.sql" ]] \
    || die "FRESH BASELINE CONTRACT: seed must be second."
  say "  applying atomic fresh baseline: ${MP_FRESH_ONLY[0]} + ${MP_FRESH_ONLY[1]} + migration-ledger bootstrap"
  # Include the empty ledger in the SAME transaction. Therefore every committed
  # fresh baseline is explicitly resumable even if migration 1 later fails.
  ledger_ddl | pg -q -1 -f "${MP_FRESH_ONLY[0]}" -f "${MP_FRESH_ONLY[1]}" -f - \
    || die "FRESH BASELINE FAILED: schema + seed + empty migration ledger were rolled back together. Fix the source and re-run."
  ok "atomic fresh baseline applied: schema + public seed + empty migration ledger committed together"
}

# OPT-01.1-FIX §1 — CREDENTIALS ARE NEVER PRINTED. Prints host:port/dbname
# ONLY: everything up to the LAST '@' (the whole userinfo, even a password
# containing '@') is discarded, and query parameters are dropped.
db_display_target() {
  local rest="${SUPABASE_DB_URL#*://}"
  rest="${rest##*@}"
  local hostport="${rest%%/*}"
  local db="${rest#"$hostport"}"; db="${db#/}"; db="${db%%\?*}"
  local host="$hostport" port="5432"
  if [[ "$hostport" == *:* ]]; then host="${hostport%:*}"; port="${hostport##*:}"; fi
  printf '%s:%s/%s' "$host" "$port" "${db:-postgres}"
}

file_sha256() {
  if   command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum    >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl   >/dev/null 2>&1; then openssl dgst -sha256 -r "$1" | awk '{print $1}'
  else return 127; fi
}
sha256_str() {
  printf '%s' "$1" | { if   command -v sha256sum >/dev/null 2>&1; then sha256sum
                       elif command -v shasum    >/dev/null 2>&1; then shasum -a 256
                       else openssl dgst -sha256 -r; fi; } | awk '{print $1}'
}
# A stable fingerprint of the ordered chain + current checksums; pins the
# adopted baseline_version to exactly this manifest.
mp_baseline_version() {
  [[ -n "$BASELINE_VERSION_TAG" ]] && { printf '%s' "$BASELINE_VERSION_TAG"; return; }
  local acc="" f; for f in "${MP_MIGRATIONS[@]}"; do acc+="$f:$(file_sha256 "$f")"$'\n'; done
  local h; h="$(sha256_str "$acc")"
  BASELINE_VERSION_TAG="opt01.2-${#MP_MIGRATIONS[@]}-${h:0:12}"
  printf '%s' "$BASELINE_VERSION_TAG"
}
require_db_tools() {
  command -v psql >/dev/null 2>&1 \
    || die "PREREQUISITE MISSING: psql not found on PATH. Install the PostgreSQL client (Debian/Ubuntu: apt install postgresql-client · macOS: brew install libpq · Windows: the PostgreSQL installer's command-line tools) and re-run."
  file_sha256 "$SCRIPT_DIR/migration-manifest.sh" >/dev/null \
    || die "PREREQUISITE MISSING: no SHA-256 tool found (need sha256sum, shasum or openssl) — required by the migration ledger."
}

# T13.3.29: a destructive FRESH install must prove more than "zero public
# tables". A Supabase project with existing Auth users, Storage data, public
# views/sequences/functions/types is not a brand-new disposable target. The
# checks fail closed on any query error. Platform-owned extension objects are
# ignored. The only non-extension public exception is the exact Supabase-
# documented rls_auto_enable()/ensure_rls safety pair, verified by function
# body/owner/trigger identity and preserved; every other public object fails.
MP_FRESH_CONFLICT=""
db_known_relation_row_count() {   # $1=schema-qualified known relation; absent => 0
  local rel="$1" exists n
  exists="$(pg -qtA -v rel="$rel" -f - <<'EOSQL' 2>/dev/null
select to_regclass(:'rel') is not null;
EOSQL
)" || return 2
  [[ "$exists" == "t" ]] || { echo 0; return 0; }
  case "$rel" in
    auth.users)       n="$(pg -qtA -c 'select count(*) from auth.users;' 2>/dev/null)" || return 2 ;;
    storage.buckets)  n="$(pg -qtA -c 'select count(*) from storage.buckets;' 2>/dev/null)" || return 2 ;;
    storage.objects)  n="$(pg -qtA -c 'select count(*) from storage.objects;' 2>/dev/null)" || return 2 ;;
    *) return 2 ;;
  esac
  [[ "$n" =~ ^[0-9]+$ ]] || return 2
  echo "$n"
}
db_rls_auto_enable_safety_state() { # prints absent|safe|unsafe; query failure => nonzero
  pg -qtA -f - <<'EOSQL' 2>/dev/null
with f as (
  select p.*, l.lanname, pg_get_userbyid(p.proowner) as owner_name
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_language l on l.oid = p.prolang
   where n.nspname = 'public' and p.proname = 'rls_auto_enable'
), e as (
  select * from pg_catalog.pg_event_trigger where evtname = 'ensure_rls'
), expected as (
  select $body$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$body$::text as body
)
select case
  when (select count(*) from f) = 0 and (select count(*) from e) = 0 then 'absent'
  when (select count(*) from f) = 1 and (select count(*) from e) = 1 and exists (
    select 1 from f cross join e cross join expected x
     where f.pronargs = 0
       and f.prokind = 'f'
       and f.prorettype = 'event_trigger'::regtype
       and f.lanname = 'plpgsql'
       and f.prosecdef is true
       and f.owner_name = 'postgres'
       and f.proconfig = array['search_path=pg_catalog']::text[]
       and btrim(regexp_replace(f.prosrc, '[[:space:]]+', ' ', 'g'))
           = btrim(regexp_replace(x.body, '[[:space:]]+', ' ', 'g'))
       and e.evtevent = 'ddl_command_end'
       and e.evtenabled = 'O'
       and e.evtfoid = f.oid
       and e.evttags @> array['CREATE TABLE','CREATE TABLE AS','SELECT INTO']::text[]
       and e.evttags <@ array['CREATE TABLE','CREATE TABLE AS','SELECT INTO']::text[]
       and (select count(*) from pg_catalog.pg_event_trigger x2 where x2.evtfoid = f.oid) = 1
  ) then 'safe'
  else 'unsafe'
end;
EOSQL
}

db_target_empty() {   # 0=brand-new enough for MilkPop fresh, 1=state exists, 2=unknown
  MP_FRESH_CONFLICT=""
  local n authn buckets objects rls_safety
  n="$(pg -qtA -c "
    select count(*)
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public'
       and c.relkind in ('r','p','v','m','f','S')
       and not exists (select 1 from pg_catalog.pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e');
  " 2>/dev/null)" || return 2
  [[ "$n" =~ ^[0-9]+$ ]] || return 2
  if [[ "$n" -ne 0 ]]; then MP_FRESH_CONFLICT="public relations/sequences=$n"; return 1; fi

  rls_safety="$(db_rls_auto_enable_safety_state)" || return 2
  case "$rls_safety" in
    absent|safe) ;;
    unsafe) MP_FRESH_CONFLICT="public RLS auto-enable safety helper mismatch"; return 1 ;;
    *) return 2 ;;
  esac

  n="$(pg -qtA -c "
    select count(*)
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public'
       and p.proname <> 'rls_auto_enable'
       and not exists (select 1 from pg_catalog.pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e');
  " 2>/dev/null)" || return 2
  [[ "$n" =~ ^[0-9]+$ ]] || return 2
  if [[ "$n" -ne 0 ]]; then MP_FRESH_CONFLICT="public application routines=$n"; return 1; fi

  n="$(pg -qtA -c "
    select count(*)
      from pg_catalog.pg_type t
      join pg_catalog.pg_namespace n on n.oid=t.typnamespace
     where n.nspname='public' and t.typrelid=0
       and not exists (select 1 from pg_catalog.pg_depend d where d.classid='pg_type'::regclass and d.objid=t.oid and d.deptype='e');
  " 2>/dev/null)" || return 2
  [[ "$n" =~ ^[0-9]+$ ]] || return 2
  if [[ "$n" -ne 0 ]]; then MP_FRESH_CONFLICT="public user types=$n"; return 1; fi

  authn="$(db_known_relation_row_count auth.users)" || return 2
  buckets="$(db_known_relation_row_count storage.buckets)" || return 2
  objects="$(db_known_relation_row_count storage.objects)" || return 2
  if [[ "$authn" -ne 0 || "$buckets" -ne 0 || "$objects" -ne 0 ]]; then
    MP_FRESH_CONFLICT="auth.users=$authn, storage.buckets=$buckets, storage.objects=$objects"
    return 1
  fi
  return 0
}
# OPT-01.2 §1: does the target already hold Milk Pop application tables?
db_app_tables_present() {   # 0=yes, 1=no, 2=unknown
  local n
  n="$(pg -qtA -c "select count(*) from pg_catalog.pg_tables where schemaname='public' and tablename in ('staff_profiles','menu_items','orders','job_applications','media_objects');" 2>/dev/null)" || return 2
  [[ "$n" =~ ^[0-9]+$ ]] || return 2
  [[ "$n" -gt 0 ]]
}
# Ledger row count — prints 0 when the table is absent; NONZERO EXIT only on a
# real connection failure (so callers can fail closed). Existence is checked
# first because a CASE cannot guard a parse-time reference to a missing table.
db_ledger_count() {
  local exists
  exists="$(pg -qtA -c "select to_regclass('public.mp_migration_ledger') is not null;")" || return 1
  [[ "$exists" == "t" ]] || { echo 0; return 0; }
  pg -qtA -c "select count(*) from public.mp_migration_ledger;"
}

# T13.3.29 bootstrap-resume classification. This lane exists ONLY for a fresh
# installation that committed its baseline/ledger but stopped before owner
# bootstrap. It deliberately refuses any real operating data. MilkPop's own
# empty Storage buckets may exist because migrations create them; objects may not.
MP_RESUME_CONFLICT=""
db_resume_install_safe() {   # 0=safe bootstrap-pending state, 1=not safe, 2=unknown
  MP_RESUME_CONFLICT=""
  local exists n authn objects bucket_bad
  exists="$(pg -qtA -c "select to_regclass('public.mp_migration_ledger') is not null;" 2>/dev/null)" || return 2
  [[ "$exists" == "t" ]] || { MP_RESUME_CONFLICT="migration ledger absent"; return 1; }

  authn="$(db_known_relation_row_count auth.users)" || return 2
  [[ "$authn" -eq 0 ]] || { MP_RESUME_CONFLICT="auth.users=$authn"; return 1; }
  objects="$(db_known_relation_row_count storage.objects)" || return 2
  [[ "$objects" -eq 0 ]] || { MP_RESUME_CONFLICT="storage.objects=$objects"; return 1; }

  # These are the only buckets a partial MilkPop install itself may create.
  bucket_bad="$(pg -qtA -c "
    select count(*) from storage.buckets
     where id not in ('cvs','menu-media','staff-documents','training-media');
  " 2>/dev/null)" || return 2
  [[ "$bucket_bad" =~ ^[0-9]+$ ]] || return 2
  [[ "$bucket_bad" -eq 0 ]] || { MP_RESUME_CONFLICT="unexpected storage buckets=$bucket_bad"; return 1; }

  # No user, staffing, customer, order, payroll or submitted-form state may
  # exist. Seeded catalogue/settings rows are intentionally not counted here.
  n="$(pg -qtA -c "
    select
      (select count(*) from staff_profiles) +
      (select count(*) from stores) +
      (select count(*) from orders) +
      (select count(*) from customers) +
      (select count(*) from job_applications) +
      (select count(*) from contact_messages) +
      (select count(*) from franchise_inquiries) +
      (select count(*) from work_shifts) +
      (select count(*) from payslips);
  " 2>/dev/null)" || return 2
  [[ "$n" =~ ^[0-9]+$ ]] || return 2
  [[ "$n" -eq 0 ]] || { MP_RESUME_CONFLICT="business/staff/form rows=$n"; return 1; }
  return 0
}

# ---------------------------------------------------------------------------
#  DEPLOYMENT ADVISORY LOCK (OPT-01.2 §7) — a SESSION-level advisory lock held
#  by a long-lived psql co-process for the whole of --db-upgrade, so the
#  independent per-file psql invocations all run under one lock. A second
#  runner sees the lock and waits, then fails after MP_LOCK_TIMEOUT.
#  (--db-adopt-ledger uses a transaction-level try-lock inside its single
#  atomic transaction; both share the same key and therefore exclude.)
# ---------------------------------------------------------------------------
DEPLOY_LOCK_PID=""
deploy_lock_acquire() {
  local timeout="${MP_LOCK_TIMEOUT:-30}" waited=0 line=""
  coproc MP_LOCKP { exec psql -X -q -v ON_ERROR_STOP=1 -At -f - 2>/dev/null; }
  DEPLOY_LOCK_PID="$MP_LOCKP_PID"
  while :; do
    printf 'select case when pg_try_advisory_lock(%s,%s) then %s else %s end;\n' \
      "$MP_LOCK_KEY1" "$MP_LOCK_KEY2" "'GOT'" "'BUSY'" 1>&"${MP_LOCKP[1]}" \
      || { deploy_lock_release; die "Deployment lock: the lock session ended unexpectedly (connection failed)."; }
    if IFS= read -r -t 15 line <&"${MP_LOCKP[0]}"; then
      [[ "$line" == "GOT"  ]] && return 0
      [[ "$line" == "BUSY" ]] || { deploy_lock_release; die "Deployment lock: unexpected response '$line'."; }
    else
      deploy_lock_release; die "Deployment lock: no response from the database (connection failed)."
    fi
    (( waited >= timeout )) && { deploy_lock_release; die "Deployment lock is held by another run (waited ${timeout}s). Another --db-upgrade/--db-adopt-ledger is in progress — re-run when it finishes."; }
    sleep 2; waited=$((waited + 2))
  done
}
deploy_lock_release() {
  [[ -n "${DEPLOY_LOCK_PID:-}" ]] || return 0
  kill "$DEPLOY_LOCK_PID" 2>/dev/null || true
  wait "$DEPLOY_LOCK_PID" 2>/dev/null || true
  DEPLOY_LOCK_PID=""
}

# ---------------------------------------------------------------------------
#  MIGRATION LEDGER — public.mp_migration_ledger
#  filename (PK, manifest-relative), checksum (SHA-256 as applied), applied_at,
#  and OPT-01.2 adoption metadata: method ('executed' | 'verified_existing_
#  baseline'), adopted_at, baseline_version — so ADOPTED rows are never
#  misrepresented as migrations this runner executed. RLS on, zero policies,
#  revoked from the API roles. Bootstrap is idempotent and evolves an existing
#  (OPT-01.1) ledger in place.
# ---------------------------------------------------------------------------
ledger_ddl() {
  cat <<'SQL'
set client_min_messages to warning;   -- silence expected re-run notices
create table if not exists public.mp_migration_ledger (
  filename   text primary key,
  checksum   text not null,
  applied_at timestamptz not null default now()
);
alter table public.mp_migration_ledger add column if not exists method text not null default 'executed';
alter table public.mp_migration_ledger add column if not exists adopted_at timestamptz;
alter table public.mp_migration_ledger add column if not exists baseline_version text;
alter table public.mp_migration_ledger add column if not exists ordinal integer;
do $mpddl$ begin
  if not exists (select 1 from pg_constraint where conname='mp_ledger_checksum_hex')
    then alter table public.mp_migration_ledger add constraint mp_ledger_checksum_hex check (checksum ~ '^[0-9a-f]{64}$'); end if;
  if not exists (select 1 from pg_constraint where conname='mp_ledger_method_ck')
    then alter table public.mp_migration_ledger add constraint mp_ledger_method_ck check (method in ('executed','verified_existing_baseline')); end if;
end $mpddl$;
comment on table public.mp_migration_ledger is
  'Deployment bookkeeping written only by launch/launch.sh: one row per migration recorded on this database. method=executed → run by this runner; method=verified_existing_baseline → present before the ledger and adopted after baseline verification (NOT executed here). Not application data.';
alter table public.mp_migration_ledger enable row level security;
revoke all on table public.mp_migration_ledger from public, anon, authenticated;
SQL
}
ledger_bootstrap() { ledger_ddl | pg -q; }

ledger_recorded_checksum() {   # $1 = filename → prints checksum or nothing
  pg -qtA -v fn="$1" -f - <<'EOSQL'
select checksum from public.mp_migration_ledger where filename = :'fn';
EOSQL
}

apply_migration_ledgered() {   # $1 = filename; $2 = manifest ordinal; records method='executed'
  local f="$1" ord="$2" sum rec
  sum="$(file_sha256 "$f")" || die "Could not hash $f — stopping."
  rec="$(ledger_recorded_checksum "$f")" \
    || die "Ledger lookup failed for $f — stopping (fail closed, nothing applied for this file)."
  if [[ -n "$rec" ]]; then
    [[ "$rec" == "$sum" ]] && { say "  ${DIM}= skip${RST}   $f (already applied)"; MP_SKIPPED=$((MP_SKIPPED+1)); return 0; }
    die "CHECKSUM MISMATCH: $f is recorded with SHA-256 ${rec}, but the file now hashes to ${sum}. An applied migration must NEVER be edited — restore the original and ship the change as a NEW migration. Stopping before applying anything further."
  fi
  say "  → apply    $f"
  # File + its ledger row commit in ONE transaction (-1 wraps every -f). The
  # insert rides in via `-f -` because psql interpolates :'var' only in file/
  # stdin input, not -c.
  pg -q -1 -v fn="$f" -v cs="$sum" -v ord="$ord" -f "$f" -f - <<'EOSQL' \
    || die "MIGRATION FAILED: $f — the transaction was rolled back, no ledger entry was recorded, and the run stops here (first error). Fix the migration, then re-run: completed files are skipped via the ledger."
insert into public.mp_migration_ledger (filename, checksum, method, ordinal) values (:'fn', :'cs', 'executed', :'ord');
EOSQL
  ok "applied + recorded $f"
  MP_APPLIED=$((MP_APPLIED + 1))
}

apply_migration_loop() {
  MP_APPLIED=0; MP_SKIPPED=0
  local i; for i in "${!MP_MIGRATIONS[@]}"; do apply_migration_ledgered "${MP_MIGRATIONS[$i]}" "$i"; done
}
run_migration_chain_ledgered() {   # FRESH path: create ledger, execute+record all
  ledger_bootstrap || die "Could not create/verify public.mp_migration_ledger — stopping (fail closed)."
  apply_migration_loop
}

# OPT-01.2 §5 — FULL PREFLIGHT before any new migration executes. Validates the
# manifest AND the ledger against reality; any mismatch aborts before the DB is
# touched.
preflight_manifest_ledger() {
  local seen=" " f dupes=""
  for f in "${MP_MIGRATIONS[@]}"; do
    [[ "$seen" == *" $f "* ]] && dupes+="$f "
    seen+="$f "
    [[ -f "$f" ]] || die "PREFLIGHT: manifest lists $f but it is not on disk."
  done
  [[ -z "$dupes" ]] || die "PREFLIGHT: duplicate manifest entries: $dupes"
  # 'Order valid' at runtime = a well-formed, de-duplicated, on-disk sequence that
  # is applied in listed order. (The CURRENT chain's phase-B-last rule is enforced
  # by scripts/migration-manifest.test.mjs at build time, not here, so that a
  # genuinely new migration appended after phase B is not wrongly rejected.)
  local rows lf lc lo curr idx
  rows="$(pg -qtA -F $'\t' -c "select filename, checksum, coalesce(ordinal::text,'') from public.mp_migration_ledger order by filename;")" \
    || die "PREFLIGHT: could not read the ledger (fail closed)."
  # Map each manifest filename to its current index, for the prefix/order proof.
  declare -A MP_IDX=(); local k=0 fpath
  for fpath in "${MP_MIGRATIONS[@]}"; do MP_IDX["$fpath"]="$k"; k=$((k+1)); done
  local applied=0
  while IFS=$'\t' read -r lf lc lo; do
    [[ -z "$lf" ]] && continue
    applied=$((applied+1))
    [[ -n "${MP_IDX["$lf"]+x}" ]] || die "PREFLIGHT: the ledger records '$lf', which is NOT in the manifest (renamed or removed?). Aborting before any migration runs."
    [[ -f "$lf" ]] || die "PREFLIGHT: the ledger references '$lf' but the file is missing on disk. Aborting."
    curr="$(file_sha256 "$lf")"
    [[ "$curr" == "$lc" ]] || die "CHECKSUM MISMATCH: $lf is recorded with SHA-256 ${lc} but the file now hashes to ${curr}. An applied migration must NEVER be edited — restore the original and ship the change as a NEW migration. Preflight aborts before any new migration runs."
    idx="${MP_IDX["$lf"]}"
    # OPT-01.2A §2 — applied migrations must be an exact ordered PREFIX of the
    # manifest: no new migration may be inserted before an already-applied one.
    if [[ -n "$lo" ]]; then
      [[ "$lo" == "$idx" ]] || die "PREFLIGHT: migration order drift — '$lf' was applied at position ${lo} but now sits at manifest position ${idx}. A migration was reordered or inserted before an already-applied one; the historical order is immutable (append new migrations only). Aborting before any migration runs."
    fi
  done <<< "$rows"
  # Prefix proof (independent of the ordinal column, for any legacy row): the K
  # applied files must be exactly manifest[0..K-1].
  local j
  for (( j=0; j<applied; j++ )); do
    local want="${MP_MIGRATIONS[$j]}"
    grep -qxF "$want" <<< "$(printf '%s\n' "$rows" | cut -f1)" \
      || die "PREFLIGHT: applied migrations are not a contiguous prefix of the manifest — expected '$want' (position ${j}) to be among the ${applied} recorded migrations, but it is not. A new migration was inserted before an already-applied one. Aborting before any migration runs."
  done
}

db_fresh() {
  head2 "§1  DATABASE — FRESH INSTALL (new, empty project ONLY)"
  warn "CLEAN SLATE: schema.FRESH-INSTALL-ONLY.sql DROPS ALL TABLES. This path is for a brand-new"
  warn "Supabase project only. It refuses to run if the target already holds Milk"
  warn "Pop data. For an EXISTING project use --db-adopt-ledger (first time, to"
  warn "record the baseline) or --db-upgrade (thereafter)."
  echo
  db_connect_init
  say "Target: $(db_display_target)   (host:port/db — credentials are never shown)"
  local rc=0; db_target_empty || rc=$?
  if [[ $rc -eq 1 ]]; then
    local existing=""
    existing="$(pg -qtA -c "select string_agg(tablename, ', ' order by tablename) from (select tablename from pg_catalog.pg_tables where schemaname='public' limit 5) t;" 2>/dev/null || true)"
    die "Target is NOT a brand-new empty project${MP_FRESH_CONFLICT:+ (${MP_FRESH_CONFLICT})}. Refusing destructive fresh install. Use the appropriate recovery/adopt/upgrade path instead."
  elif [[ $rc -eq 2 ]]; then
    die "FAIL CLOSED: the emptiness check could not be completed (query/connection failed), so this target CANNOT be verified as a brand-new project. A fresh install is destructive and will not proceed on an unverified target — there is no manual override. Fix connectivity/credentials and re-run."
  fi
  ok "Target verified brand-new for MilkPop — no public application objects, Auth users, Storage buckets or Storage objects."
  human "About to ERASE (clean slate) and INSTALL a fresh schema on the project above."
  confirmed_gate MP_CONFIRM_FRESH_INSTALL "Fresh install on the project above" "ERASE AND INSTALL"
  run_fresh_baseline_atomic
  run_migration_chain_ledgered
  ok "Fresh install complete: schema + public seed + ${MP_APPLIED} migrations applied and recorded in public.mp_migration_ledger (method=executed)."
  echo
  ok "RLS policy source installed. Live role/store verification remains a separate production commissioning gate."
}

db_resume_install() {
  head2 "§1  DATABASE — RESUME FIRST INSTALL (bootstrap not started)"
  say "Resumes a ledger-managed fresh installation that stopped after its atomic"
  say "baseline committed but BEFORE any owner/user/business bootstrap. It applies"
  say "only unrecorded migrations; schema and seed are never replayed. It refuses"
  say "to run once Auth users, business/staff/form rows, Storage objects or foreign"
  say "Storage buckets exist. Use --db-upgrade for an operating database."
  echo
  db_connect_init
  say "Target: $(db_display_target)   (host:port/db — credentials are never shown)"
  local rc=0; db_resume_install_safe || rc=$?
  [[ $rc -eq 2 ]] && die "FAIL CLOSED: could not prove this is a bootstrap-pending partial install. Fix connectivity and inspect the target."
  [[ $rc -eq 1 ]] && die "Target is NOT safe for first-install resume${MP_RESUME_CONFLICT:+ (${MP_RESUME_CONFLICT})}. Use the normal upgrade/recovery path instead."
  ok "Bootstrap-pending state verified: ledger present; no Auth users, business/staff/form data or Storage objects."
  human "About to resume ONLY the unrecorded migration suffix on this bootstrap-pending install."
  confirmed_gate MP_CONFIRM_RESUME_INSTALL "Resume first installation" "RESUME INSTALL"

  deploy_lock_acquire
  preflight_manifest_ledger
  apply_migration_loop
  deploy_lock_release
  ok "First-install database resume complete: ${MP_APPLIED} migration(s) applied, ${MP_SKIPPED} already-applied skipped; schema/seed were NOT replayed."
  ok "Database is ready for the remaining backend install steps; owner setup is still required."
}

db_upgrade() {
  head2 "§1  DATABASE — UPGRADE (ledger-managed project)"
  say "Applies ONLY migrations from the manifest that are NOT yet recorded in the"
  say "migration ledger (public.mp_migration_ledger). It NEVER runs schema.FRESH-INSTALL-ONLY.sql or"
  say "seed.sql, and NEVER replays historical migrations. Per file: recorded + same"
  say "SHA-256 → skipped; recorded + different SHA-256 → HARD FAIL (applied"
  say "migrations are immutable); new → applied together with its ledger row in ONE"
  say "transaction, under a deployment advisory lock. Stops at the first error."
  say "An EXISTING pre-ledger database must first be adopted with --db-adopt-ledger."
  echo
  db_connect_init
  say "Target: $(db_display_target)   (host:port/db — credentials are never shown)"

  # OPT-01.2 §1 — refuse to replay history on a pre-ledger database.
  local apprc=0; db_app_tables_present || apprc=$?
  [[ $apprc -eq 2 ]] && die "FAIL CLOSED: could not query the target to classify it (connection failed). Aborting before any change."
  local lcount; lcount="$(db_ledger_count)" \
    || die "FAIL CLOSED: could not read the migration ledger (connection failed). Aborting before any change."
  if [[ $apprc -eq 0 && "$lcount" -eq 0 ]]; then
    printf 'Existing pre-ledger Milk Pop database detected.\nHistorical migrations will not be replayed automatically.\nRun --db-adopt-ledger after creating and verifying a backup.\n' >&2
    exit 1
  fi

  warn "BACK UP FIRST. On production a verified, restorable backup (or a PITR"
  warn "restore point you have tested) is MANDATORY before running this."
  human "Confirm a restorable backup of the project above exists."
  confirmed_gate MP_CONFIRM_BACKUP "Backup taken and verified restorable" "BACKED UP"
  human "About to apply only NEW (unrecorded) migrations to the project above."
  confirmed_gate MP_CONFIRM_APPLY_MIGRATIONS "Apply new migrations to the project above" "APPLY MIGRATIONS"

  deploy_lock_acquire   # OPT-01.2 §7 — held for the whole run; excludes a 2nd runner
  ledger_bootstrap || die "Could not create/verify public.mp_migration_ledger — stopping (fail closed)."
  preflight_manifest_ledger   # OPT-01.2 §5 — full manifest+ledger check BEFORE any new migration
  apply_migration_loop
  deploy_lock_release
  ok "Upgrade complete: ${MP_APPLIED} migration(s) applied, ${MP_SKIPPED} already-applied skipped (schema.FRESH-INSTALL-ONLY.sql and seed.sql were NOT run; no history replayed)."
  echo
  ok "RLS policy source installed. Live role/store verification remains a separate production commissioning gate."
}

# OPT-01.2 §2/§4 — adopt the ledger on an EXISTING database that is already at
# the verified final pre-ledger baseline: RECORD the historical migrations
# WITHOUT executing them, atomically, only if strict verification passes.
MP_ADOPT_SQL=""
db_adopt_ledger() {
  head2 "§1  DATABASE — ADOPT LEDGER (existing project already at the final baseline)"
  say "For an EXISTING database that already holds the complete current schema and"
  say "every historical migration but has NO migration ledger. It records the"
  say "historical migrations as the verified baseline (method=verified_existing_"
  say "baseline) WITHOUT executing any of them, inside ONE transaction, and only"
  say "after a strict check that the database already matches the expected final"
  say "state. If verification fails, the transaction rolls back and NO ledger rows"
  say "are written. Historical migrations are never replayed."
  echo
  db_connect_init
  say "Target: $(db_display_target)   (host:port/db — credentials are never shown)"

  local apprc=0; db_app_tables_present || apprc=$?
  [[ $apprc -eq 2 ]] && die "FAIL CLOSED: could not classify the target (connection failed). Aborting."
  [[ $apprc -eq 1 ]] && die "This database has no Milk Pop application tables — there is nothing to adopt. For a brand-new EMPTY project use --db-fresh."
  local lcount; lcount="$(db_ledger_count)" \
    || die "FAIL CLOSED: could not read the migration ledger (connection failed). Aborting."
  [[ "$lcount" -eq 0 ]] \
    || die "This database already has a populated migration ledger (${lcount} row(s)) — it is already ledger-managed. Use --db-upgrade to apply new migrations."

  warn "CREATE AND VERIFY A BACKUP FIRST. Adoption executes no historical migrations,"
  warn "but it writes ledger rows and must run against a database you can restore."
  human "Confirm a restorable backup of the project above exists."
  confirmed_gate MP_CONFIRM_BACKUP "Backup taken and verified restorable" "BACKED UP"
  human "This RECORDS the ${#MP_MIGRATIONS[@]}-migration history as the verified baseline WITHOUT running it."
  confirmed_gate MP_CONFIRM_ADOPT_BASELINE "Adopt the verified existing baseline on the project above" "ADOPT EXISTING BASELINE"

  local bver ddl f cs i
  bver="$(mp_baseline_version)"
  ddl="$(ledger_ddl)"
  local vrows=() fnrows=()
  for i in "${!MP_MIGRATIONS[@]}"; do
    f="${MP_MIGRATIONS[$i]}"
    cs="$(file_sha256 "$f")" || die "Could not hash $f — aborting adoption."
    vrows+=("  ('${f}','${cs}','verified_existing_baseline', now(), '${bver}', ${i})")
    fnrows+=("('${f}')")
  done
  local values_sql fn_values
  printf -v values_sql '%s,\n' "${vrows[@]}";  values_sql="${values_sql%,$'\n'}"
  printf -v fn_values '%s,'    "${fnrows[@]}";  fn_values="${fn_values%,}"

  MP_ADOPT_SQL="$(mktemp "${TMPDIR:-/tmp}/mp-adopt.XXXXXX.sql")"; chmod 600 "$MP_ADOPT_SQL"
  # Atomic adoption (run under `pg -1`). OPT-01.2A §4: the deployment advisory
  # lock is the FIRST database operation, before any DDL — so a second runner is
  # excluded before the ledger table is even touched. Then: bootstrap ledger →
  # assert empty → STRICT baseline verification → seed ledger (with ordinals) →
  # recount + set/order check. Any failure rolls the whole thing back; no
  # historical file is applied.
  cat > "$MP_ADOPT_SQL" <<SQL
set client_min_messages to warning;
do \$mplock\$
begin
  if not pg_try_advisory_xact_lock(${MP_LOCK_KEY1}, ${MP_LOCK_KEY2}) then
    raise exception 'concurrent deployment detected: the advisory lock is held — aborting adoption' using errcode = '55P03';
  end if;
end \$mplock\$;
${ddl}
do \$mpchk0\$
begin
  if (select count(*) from public.mp_migration_ledger) <> 0 then
    raise exception 'the migration ledger is not empty at adoption start — aborting';
  end if;
end \$mpchk0\$;
\i '${SCRIPT_DIR}/verify-current-baseline.sql'
insert into public.mp_migration_ledger (filename, checksum, method, adopted_at, baseline_version, ordinal) values
${values_sql};
do \$mpchk1\$
declare n int;
begin
  select count(*) into n from public.mp_migration_ledger;
  if n <> ${#MP_MIGRATIONS[@]} then
    raise exception 'adoption row-count check failed — the ledger does not hold exactly the expected number of rows';
  end if;
  if exists (select 1 from public.mp_migration_ledger where method <> 'verified_existing_baseline') then
    raise exception 'adoption integrity check failed — a non-adopted ledger row is present';
  end if;
  if exists (select fn from (values ${fn_values}) v(fn)
             except select filename from public.mp_migration_ledger) then
    raise exception 'adoption filename check failed — an expected migration is missing from the ledger';
  end if;
  if exists (select 1 from public.mp_migration_ledger
             where ordinal is null or ordinal < 0 or ordinal >= ${#MP_MIGRATIONS[@]})
     or (select count(distinct ordinal) from public.mp_migration_ledger) <> ${#MP_MIGRATIONS[@]} then
    raise exception 'adoption ordinal check failed — recorded ordinals are not a complete 0..N-1 sequence';
  end if;
end \$mpchk1\$;
SQL

  say "Verifying the existing database against the expected final baseline, then"
  say "recording ${#MP_MIGRATIONS[@]} historical migration(s) — executing none of them…"
  if pg -1 -f "$MP_ADOPT_SQL"; then
    ok "Adoption committed: ${#MP_MIGRATIONS[@]} historical migration(s) recorded as the verified existing baseline (method=verified_existing_baseline, baseline_version=${bver}). NONE were executed; schema.FRESH-INSTALL-ONLY.sql and seed.sql were NOT run."
  else
    die "ADOPTION ABORTED: baseline verification or the atomic ledger seeding failed — the transaction rolled back and NO ledger rows were written. Nothing on the database was changed. Review the error above, bring the database to the expected final baseline, and re-run."
  fi
  rm -f "$MP_ADOPT_SQL"; MP_ADOPT_SQL=""
  echo
  human "Adoption records history without running it. Now use --db-upgrade for any"
  say    "genuinely new migrations; it will apply only files not already recorded."
  ok "RLS policy source installed. Live role/store verification remains a separate production commissioning gate."
}

# ---- arg parsing -----------------------------------------------------------
case "${1:-}" in
  --help|-h)
    grep '^#' "$0" | sed 's/^# \{0,1\}//' ; exit 0 ;;
  --checks-only) final_gate ; exit 0 ;;
  --db-fresh)         db_fresh        ; exit 0 ;;
  --db-adopt-ledger)  db_adopt_ledger  ; exit 0 ;;
  --db-resume-install) db_resume_install ; exit 0 ;;
  --db-upgrade)       db_upgrade       ; exit 0 ;;
  --db)          die "--db was split for safety into explicit paths: --db-fresh (new EMPTY project), --db-adopt-ledger (existing project already at the final baseline — records history without running it), or --db-resume-install (bootstrap-pending first install), or --db-upgrade (ledger-managed project — applies only new migrations). A normal upgrade must never run the clean-slate schema or replay history." ;;
  "" ) : ;;  # full run continues below
  * ) die "Unknown option '$1'. Try --help." ;;
esac

# =============================================================================
#  FULL ORDERED RUN
# =============================================================================
head2 "§0  PRECONDITIONS"
human "Confirm: a PRODUCTION Supabase project exists and you hold its service-role key"
say   "        (server-side only — never in the frontend bundle, this repo, or a VITE_ var)."
human "Confirm: deploy target chosen (Netlify / Cloudflare Pages / Vercel / self-hosted)"
say   "        with access to set env vars, secrets and headers there."
gate "Preconditions met"
say "Running clean install against the lockfile…"
npm ci
ok "npm ci complete"

head2 "§1  DATABASE — choose the path"
say "Choose only the database state that actually exists:"
say "  fresh    → clean-slate schema + seed + migrations   (new EMPTY project only)"
say "  resume   → unrecorded migration suffix only          (bootstrap-pending fresh install only)"
say "  adopt    → record history as the verified baseline   (existing project, first time,"
say "             runs NOTHING historical — verifies then seeds the ledger)"
say "  upgrade  → apply only NEW migrations                 (ledger-managed operating project)"
printf '%s   Type %sfresh%s, %sresume%s, %sadopt%s or %supgrade%s: %s' "$DIM" "$BOLD" "$RST$DIM" "$BOLD" "$RST$DIM" "$BOLD" "$RST$DIM" "$BOLD" "$RST$DIM" "$RST"
read -r DB_CHOICE
case "$DB_CHOICE" in
  fresh)   db_fresh ;;
  resume)  db_resume_install ;;
  adopt)   db_adopt_ledger ;;
  upgrade) db_upgrade ;;
  *) die "Answer 'fresh', 'resume', 'adopt' or 'upgrade'. Stopping." ;;
esac

head2 "§2  ROTATE KEYS + GDPR / BREACH ASSESSMENT   (human, legal)"
human "Rotate ANY key ever committed/shared/pasted. The anon key may live in the"
say   "        frontend; the service-role key must be FRESH and only in Edge Function"
say   "        secrets. Confirm the old keys are REVOKED in the Supabase dashboard."
human "GDPR review for CV storage: confirm lawful basis + careers-page privacy notice,"
say   "        and DECIDE the CV retention period for declined candidates. Record it —"
say   "        you will schedule purge_expired_cvs() with this period in §7."
human "Breach-readiness: confirm who is notified and the 72-hour reporting path."
gate "Keys rotated, GDPR/retention decided and recorded, breach path confirmed"

head2 "§3  DEPLOY EDGE FUNCTIONS — with correct Verify-JWT settings"
say "Required toggles (getting these wrong breaks anon flows or weakens controls):"
say "   send-email     Verify JWT: ${BOLD}ON${RST}   (staff-only sender)"
say "   cv-signed-url  Verify JWT: ${BOLD}ON${RST}   (managers/owners only)"
say "   cv-upload      Verify JWT: ${BOLD}OFF${RST}  (anon candidates; self-enforcing)"
say "   public-form    Verify JWT: ${BOLD}OFF${RST}  (anon submitters; self-enforcing)"
say "   training-media Verify JWT: ${BOLD}ON${RST}   (staff-only media)"
say "   staff-doc-upload Verify JWT: ${BOLD}ON${RST} (staff; magic-byte checks inside)"
say "   staff-doc-url  Verify JWT: ${BOLD}ON${RST}   (60s signed URLs after access check)"
say "   staff-doc-delete Verify JWT: ${BOLD}ON${RST} (owner-only removal, audited)"
say "   staff-invite   Verify JWT: ${BOLD}ON${RST}   (owners/managers; set SITE_URL secret)"
say "   media-upload   Verify JWT: ${BOLD}ON${RST}   (WP-04R staff media pipeline)"
say "   media-cleanup  Verify JWT: ${BOLD}ON${RST}   (owner+AAL2 inside; INERT until MEDIA_CLEANUP_ENABLED=true)"
say "   request-seo-rebuild Verify JWT: ${BOLD}ON${RST} (owners/managers; records protected-release SEO refresh only)"
say "   outbox-dispatch Verify JWT: ${BOLD}OFF${RST}  (scheduler service-role authentication inside)"
say "   employee-access-revoke Verify JWT: ${BOLD}ON${RST} (staff JWT + audited intent inside)"
say "These modes are source-controlled in supabase/config.toml — the CLI reads"
say "them from there; the explicit flags below are belt-and-braces and MUST agree."
echo
if command -v supabase >/dev/null 2>&1; then
  human "About to deploy 14 public-website/staff functions via the Supabase CLI. Confirm you are linked to the"
  say   "        RIGHT project (run: supabase link --project-ref <ref> first)."
  gate "Linked to the correct project"
  # OPT-01.1 §6 — DEPLOYMENT READINESS: media cleanup must be DISABLED in this
  # release (the CV reconciliation invariant is unproven). `supabase secrets
  # list` masks values, so the presence of the secret NAME at all is treated
  # as a readiness failure — cleanup enablement is forbidden here, so the
  # secret must be ABSENT. Remove it with: supabase secrets unset MEDIA_CLEANUP_ENABLED
  # OPT-01.1-FIX §4 — FAIL CLOSED: a CLI/auth/network failure is NOT proof the
  # secret is absent. The listing must SUCCEED before its output means anything.
  say "Verifying media-cleanup readiness (the secret must be provably ABSENT)…"
  if ! MP_SECRETS_LIST="$(supabase secrets list 2>&1)"; then
    printf '%s\n' "$MP_SECRETS_LIST" | tail -5 | sed 's/^/    /'
    die "READINESS UNVERIFIED (fail closed): 'supabase secrets list' failed, so the absence of MEDIA_CLEANUP_ENABLED cannot be proven. Fix the CLI session (supabase login / supabase link, network) and re-run — deployment does not continue on an unverified project."
  fi
  if grep -qiE '(^|[[:space:]])MEDIA_CLEANUP_ENABLED([[:space:]]|$)' <<<"$MP_SECRETS_LIST"; then
    die "READINESS FAILED: MEDIA_CLEANUP_ENABLED is set on the target project. Media cleanup must stay disabled this release — run 'supabase secrets unset MEDIA_CLEANUP_ENABLED' and re-run. (See docs/HOSTING.md → 'Media cleanup: deployment ≠ enablement'.)"
  fi
  ok "Readiness verified: media cleanup secret is absent (cleanup will deploy inert)."
  # One source-controlled deployment list keeps the public launch small and
  # prevents the deferred POS endpoints from being exposed accidentally.
  bash launch/deploy-public-functions.sh
  warn "media-cleanup deploys INERT: it refuses every run until the"
  warn "MEDIA_CLEANUP_ENABLED=true function secret is set. Leave it UNSET until"
  warn "the separate retention/reconciliation commissioning gate is complete."
  warn "POS/Web Till is deferred. The pos-pair, pos-ingest and pos-catalog functions"
  warn "are retained in source but are NOT deployed by this public launch."
  ok "All 14 public website/staff Edge Functions deployed from the source-controlled inventory."
else
  warn "Supabase CLI not found. Deploy each function from the dashboard and set its"
  warn "'Verify JWT' toggle to match the 14-function table above, OR install the CLI and re-run."
fi
human "VERIFY each function's Verify-JWT toggle matches the table above."
gate "All 14 deployed functions have the documented Verify-JWT toggle; POS functions are absent"

head2 "§4  ENVIRONMENT VARIABLES & SECRETS"
say "Frontend build env (PUBLIC — anon key only):"
say "   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY      (NEVER the service-role key)"
say "   VITE_DEPLOYMENT_MODE=production                arms the build-time validator:"
say "                                                  an incomplete Supabase pair, a"
say "                                                  half-configured Turnstile or an"
say "                                                  ungated feature flag FAILS the build"
say "   VITE_MEDIA_V2=true            only with the MEDIA_BACKEND_READY=true CI marker"
say "   VITE_CAREERS_CV_UPLOAD=true   only with the CAREERS_CV_E2E_PASSED=true CI marker"
say "                                 (default OFF — the careers form works without CV)"
say "CI-side markers (host build env, NOT function secrets, NOT VITE_*):"
say "   TURNSTILE_SERVER_ENABLED=true   record that TURNSTILE_SECRET is set server-side"
say "   MEDIA_BACKEND_READY=true        record that the live media gate passed"
say "   CAREERS_CV_E2E_PASSED=true      record that the live Careers+CV E2E gate passed"
say "Edge Function secrets (server-side only):"
say "   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY  (platform-injected)"
say "   RESEND_API_KEY (+ EMAIL_FROM)                  per OWNERS-GUIDE.md (E-mail section)"
say "   TURNSTILE_SECRET                               set to ENABLE CAPTCHA (else rate-limit only)"
say "                                                  — if set, ALSO set the CI marker above"
say "   MEDIA_CLEANUP_ENABLED                          leave UNSET/false: cleanup stays inert"
say "   Static SEO refresh                             no deploy-hook secret: request-seo-rebuild records"
say "                                                  SEO_REFRESH_PROTECTED_RELEASE; the next signed"
say "                                                  protected release refreshes crawler artefacts."
say "   CV_ALLOWED_ORIGINS / FORM_ALLOWED_ORIGINS      (optional) lock CORS to your origin(s)"
echo
human "Decide whether CAPTCHA is REQUIRED at launch (sets TURNSTILE_SECRET or not)."
human "Set all frontend env + function secrets in your host + Supabase dashboards now."
gate "All env vars and secrets set; service-role key is ONLY in function secrets"

head2 "§5  SECURITY HEADERS AT THE EDGE"
say "Netlify / Cloudflare Pages: nothing to do — public/_headers ships to dist/_headers."
say "Any other host: apply the header set from docs/HOSTING.md (Vercel/Nginx/Apache/Worker snippets)."
echo
read -r -p "Enter your production URL to verify headers now (or leave blank to skip): " SITE_URL
if [[ -n "${SITE_URL:-}" ]]; then
  say "Fetching security headers from $SITE_URL …"
  curl -sI "$SITE_URL" | grep -iE 'content-security-policy|strict-transport|x-frame|x-content-type|referrer-policy|permissions-policy' \
    || warn "No security headers seen — check host config / that the site is deployed."
  say "Also run it through https://securityheaders.com and watch the browser console for CSP violations."
fi
human "Confirm CSP/HSTS/X-Frame/etc. are present and no CSP violations on first load."
gate "Headers verified at the edge"

head2 "§6  LIVE RLS TEST — against the real project   (human, real creds)"
human "This connects to a live project and signs in as real test users. Use a"
say   "        THROWAWAY/STAGING project or a controlled window. Populate the env vars"
say   "        from the header of scripts/rls-live.test.mjs, then run:"
say   "          SUPABASE_URL=… SUPABASE_ANON_KEY=… OWNER_EMAIL=… OWNER_PW=… \\"
say   "          MGR_A_EMAIL=… MGR_A_PW=… STAFF_B_EMAIL=… STAFF_B_PW=… \\"
say   "          node scripts/rls-live.test.mjs"
say   "        Every assertion must pass (anon can't read private tables; staff can't"
say   "        self-escalate role/store/pay_rate; managers are store-scoped; payslips"
say   "        owner-write/self-read; append-only tables reject client writes)."
gate "Live RLS test run and ALL assertions passed"

head2 "§7  BACKUP / RESTORE DRILL + RETENTION SCHEDULE   (human)"
human "Take a manual Supabase backup, RESTORE it to a scratch project, confirm data +"
say   "        policies come back intact. Confirm PITR / scheduled backups at your tier."
human "Schedule CV retention with the period you chose in §2, e.g. via pg_cron:"
say   "          select cron.schedule('purge-cvs','0 3 * * *',"
say   "            \$\$select purge_expired_cvs(interval '<period>')\$\$);"
gate "Restore drill done, scheduled backups on, CV retention scheduled"

head2 "§8  BOOTSTRAP FIRST OWNER + ENFORCE MFA   (human)"
human "Create the first owner via bootstrap_owner (SQL editor). It refuses if an owner"
say   "        already exists. Then invite the same email in Supabase Auth and sign in;"
say   "        call select link_staff_profile() once to claim the owner row."
human "Sign in as that owner — the portal FORCES TOTP enrolment (owner/manager require"
say   "        MFA). Complete it and store the recovery method safely."
human "VERIFY: sign out/in prompts for the 6-digit code, AND a team-member account can"
say   "        NOT read CVs or write payroll."
gate "First owner bootstrapped, MFA enrolled and challenge verified"

final_gate      # §9

printf '\n%s══════════════════════════════════════════════════════════════%s\n' "$GRN$BOLD" "$RST"
printf '%s ✔ ALL PHASES COMPLETE.%s Cleared to launch when:\n' "$GRN$BOLD" "$RST"
say '   • §9 final gate green (just shown), AND'
say '   • §6 live-RLS run clean, AND'
say '   • §5 headers verified.'
say 'If anything regresses post-deploy, see OWNERS-GUIDE.md → "If something goes wrong".'
printf '%s══════════════════════════════════════════════════════════════%s\n' "$GRN$BOLD" "$RST"
