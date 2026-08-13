#!/usr/bin/env bash
# ============================================================================
# check-stage21-restoration.sh — is migration_stage2_1_permission_closure.sql
# the BYTE-EXACT original Stage-2.1 file your production ledger recorded?
#
# The Stage-2.1.2 package ships a SEMANTIC RECONSTRUCTION of that file (the
# archive under remediation did not contain the original bytes). The
# reconstruction is correct for FRESH installs — later migrations supersede
# it — but an UPGRADE compares the file's sha256 against the frozen ledger
# row and fails closed on any mismatch. Before deploying:
#
#   1. copy supabase/migration_stage2_1_permission_closure.sql from your
#      original Stage-2.1 delivery package over the file in this repo;
#   2. run:  npm run check:stage21-restoration
#      (or:  bash scripts/check-stage21-restoration.sh)
#   3. deploy only on PASS.
#
# The authoritative full sha256 of the original lives in the auditor's
# Stage-2.1.1 re-audit report; this script pins the reported prefix/suffix
# (f4715931…d796683). For an exact-match check, pass the full 64-char value:
#     MP_STAGE21_SHA256=<full sha256> npm run check:stage21-restoration
#
# Deliberately NOT part of `npm run verify`: this package intentionally
# carries the reconstruction, so verify must not depend on the true bytes.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

FILE="supabase/migration_stage2_1_permission_closure.sql"
# Known-wrong variants (hard failures):
RECONSTRUCTION="f03023b52aab11ff3a6af08e380936da09c55102774f51310429b0808c163942"
EDITED_2_1_1="173850a7a6c603fba93111107e97343010e72283cd90a76dba955c0105704068"
# The original, as cited (abbreviated) in the re-audit report:
ORIG_PREFIX="f4715931"
ORIG_SUFFIX="d796683"

if [[ ! -f "$FILE" ]]; then
  echo "✖ FAIL — $FILE is missing entirely." >&2
  exit 1
fi

sha="$(sha256sum "$FILE" | awk '{print $1}')"
echo "sha256($FILE)"
echo "  = $sha"

# --from-ledger: the auditor's step 3 — compare against the migration ledger
# itself. Queries the target database's recorded checksum for this file and
# exact-compares. PASS here means DEPLOYMENT CONSISTENCY ("this database's
# upgrade runner will accept this file"), which for a production ledger that
# recorded the true Stage-2.1 bytes is equivalent to authenticity.
if [[ "${1:-}" == "--from-ledger" ]]; then
  if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
    echo "✖ FAIL — --from-ledger needs SUPABASE_DB_URL (same variable launch.sh uses)." >&2
    exit 1
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "✖ FAIL — --from-ledger needs psql on PATH (launch.sh requires it too)." >&2
    exit 1
  fi
  ledger_sha="$(psql "$SUPABASE_DB_URL" -tA \
      -c "select checksum from public.mp_migration_ledger where filename = '$FILE'" 2>/dev/null || true)"
  if [[ -z "$ledger_sha" ]]; then
    echo "✖ FAIL — the target database has NO ledger row for $FILE." >&2
    echo "  Either the ledger is unreachable, or this database never applied" >&2
    echo "  Stage 2.1 (a fresh install does not need this check — the upgrade" >&2
    echo "  checksum comparison only exists for already-ledgered files)." >&2
    exit 1
  fi
  echo "ledger checksum (from the target database)"
  echo "  = $ledger_sha"
  if [[ "$sha" == "$ledger_sha" ]]; then
    echo "✔ PASS — the on-disk file matches THIS database's ledger row."
    echo "  The upgrade runner will accept it. If this is your production"
    echo "  ledger (which recorded the true Stage-2.1 bytes), this is the"
    echo "  authenticity proof the re-audit requires."
    exit 0
  fi
  echo "✖ FAIL — the on-disk file does NOT match this database's ledger row." >&2
  echo "  The upgrade runner will refuse with CHECKSUM MISMATCH. Restore the" >&2
  echo "  byte-exact Stage-2.1 file this database originally applied." >&2
  exit 1
fi

expected="${MP_STAGE21_SHA256:-${1:-}}"
if [[ -n "$expected" ]]; then
  if [[ "$sha" == "$expected" ]]; then
    echo "✔ PASS — exact match against the supplied expected sha256."
    echo "  The ledger's checksum comparison will accept this file. Deploy-safe."
    exit 0
  fi
  echo "✖ FAIL — does not match the supplied expected sha256:" >&2
  echo "  expected $expected" >&2
  exit 1
fi

case "$sha" in
  "$RECONSTRUCTION")
    echo "✖ FAIL — this is still the Stage-2.1.2 SEMANTIC RECONSTRUCTION." >&2
    echo "  Overwrite $FILE with the byte-exact copy from your original" >&2
    echo "  Stage-2.1 delivery package, then re-run this check." >&2
    exit 1 ;;
  "$EDITED_2_1_1")
    echo "✖ FAIL — this is the IN-PLACE-EDITED 2.1.1 variant the audit flagged." >&2
    echo "  Restore the ORIGINAL Stage-2.1 file; the 2.1.1 delta now lives in" >&2
    echo "  migration_stage2_1_1_reaudit_closure.sql (append-only)." >&2
    exit 1 ;;
  "$ORIG_PREFIX"*"$ORIG_SUFFIX")
    echo "✔ PASS — matches the original's reported checksum (${ORIG_PREFIX}…${ORIG_SUFFIX})."
    echo "  Final confirmation: compare the full value above against the sha256"
    echo "  in the auditor's re-audit report (or re-run with MP_STAGE21_SHA256=<full sha>)."
    exit 0 ;;
  *)
    echo "✖ UNKNOWN CONTENT — matches neither the original (${ORIG_PREFIX}…${ORIG_SUFFIX})" >&2
    echo "  nor either known-wrong variant. Compare the full value above against" >&2
    echo "  the auditor's report before deploying; the upgrade fails closed on" >&2
    echo "  any ledger mismatch." >&2
    exit 1 ;;
esac
