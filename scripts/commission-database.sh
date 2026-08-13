#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${1:-}"
REF="${MP_SUPABASE_PROJECT_REF:-}"
CONFIRM_REF="${MP_CONFIRM_PROJECT_REF:-}"
URL="${SUPABASE_DB_URL:-}"

fail() { printf 'COMMISSION DATABASE: %s\n' "$*" >&2; exit 1; }
[[ "$MODE" =~ ^(fresh|recover-known-partial|resume|upgrade|adopt)$ ]] || fail "mode must be fresh, recover-known-partial, resume, upgrade, or adopt"
[[ "$REF" =~ ^[a-z0-9]{20}$ ]] || fail "MP_SUPABASE_PROJECT_REF must be the exact 20-character project ref"
[[ "$CONFIRM_REF" == "$REF" ]] || fail "MP_CONFIRM_PROJECT_REF does not exactly match the protected project ref"
[[ -n "$URL" ]] || fail "SUPABASE_DB_URL is required"
MP_SUPABASE_PROJECT_REF="$REF" SUPABASE_DB_URL="$URL" node scripts/validate-supabase-db-target.mjs >/dev/null \
  || fail "SUPABASE_DB_URL is not exactly bound to the confirmed Supabase project / supported Session Pooler"

export MP_NONINTERACTIVE=1
case "$MODE" in
  fresh)
    [[ "${MP_COMMISSION_CONFIRMATION:-}" == "ERASE AND INSTALL $REF" ]] \
      || fail "fresh mode requires MP_COMMISSION_CONFIRMATION='ERASE AND INSTALL $REF'"
    export MP_CONFIRM_FRESH_INSTALL='ERASE AND INSTALL'
    exec bash launch/launch.sh --db-fresh
    ;;
  recover-known-partial)
    [[ "${MP_COMMISSION_CONFIRMATION:-}" == "RECOVER KNOWN PARTIAL $REF" ]] \
      || fail "recover-known-partial mode requires MP_COMMISSION_CONFIRMATION='RECOVER KNOWN PARTIAL $REF'"
    RECOVERY_SQL='ops/RECOVER-PARTIAL-FRESH-T13.3.28.sql'
    [[ -f "$RECOVERY_SQL" && ! -L "$RECOVERY_SQL" ]] \
      || fail "canonical recovery SQL is missing or is not a regular source file"
    RECOVERY_SHA="$(sha256sum "$RECOVERY_SQL" | awk '{print $1}')"
    printf 'RECOVERY_SQL_SOURCE file=%s sha256=%s\n' "$RECOVERY_SQL" "$RECOVERY_SHA"
    psql "$URL" -X -v ON_ERROR_STOP=1 -f "$RECOVERY_SQL" \
      || fail "known-partial recovery refused or failed; the transaction was not committed"
    printf '%s\n' 'KNOWN PARTIAL RECOVERY COMPLETE — RUN FRESH'
    ;;
  resume)
    [[ "${MP_COMMISSION_CONFIRMATION:-}" == "RESUME INSTALL $REF" ]] \
      || fail "resume mode requires MP_COMMISSION_CONFIRMATION='RESUME INSTALL $REF'"
    export MP_CONFIRM_RESUME_INSTALL='RESUME INSTALL'
    exec bash launch/launch.sh --db-resume-install
    ;;
  upgrade)
    [[ "${MP_COMMISSION_CONFIRMATION:-}" == "APPLY MIGRATIONS $REF" ]] \
      || fail "upgrade mode requires MP_COMMISSION_CONFIRMATION='APPLY MIGRATIONS $REF'"
    export MP_CONFIRM_BACKUP='BACKED UP'
    export MP_CONFIRM_APPLY_MIGRATIONS='APPLY MIGRATIONS'
    exec bash launch/launch.sh --db-upgrade
    ;;
  adopt)
    [[ "${MP_COMMISSION_CONFIRMATION:-}" == "ADOPT EXISTING BASELINE $REF" ]] \
      || fail "adopt mode requires MP_COMMISSION_CONFIRMATION='ADOPT EXISTING BASELINE $REF'"
    export MP_CONFIRM_BACKUP='BACKED UP'
    export MP_CONFIRM_ADOPT_BASELINE='ADOPT EXISTING BASELINE'
    exec bash launch/launch.sh --db-adopt-ledger
    ;;
esac
