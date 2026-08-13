#!/usr/bin/env bash
# ============================================================================
# prove-stage2-closure.sh — the re-audit's "exact remaining action" list as
# ONE fail-fast command. Run after replacing the Stage-2.1 migration with the
# byte-exact original. Each step maps 1:1 to the auditor's checklist:
#
#   1/5  check:stage21-restoration → PASS      (authenticity of the 2.1 bytes)
#   2/5  fresh migration replay    → PASS      (schema + full chain, clean DB)
#   3/5  upgrade from ledgered 2.1 → PASS      (real launch.sh, real PG17)
#   4/5  direct manager salary query → DENIED  (full behavioural matrix; the
#                                               same denial is also proven
#                                               live on the UPGRADED database
#                                               inside step 3, check P3.1)
#   5/5  full verify               → PASS      (the standing regression gate)
#
# Usage:
#   npm run prove:stage2-closure                      # heuristic sha check
#   MP_STAGE21_SHA256=<full sha> npm run prove:stage2-closure
#   SUPABASE_DB_URL=<prod url> npm run prove:stage2-closure -- --from-ledger
#
# Fails at the FIRST unmet requirement — until the true Stage-2.1 bytes are
# in place, that is step 1, by design. A full pass here is the evidence set
# the auditor asked for before closing Stage 2; the GO decision itself
# remains the auditor's.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

step() { echo; echo "==============================================================="; echo "  $1"; echo "==============================================================="; }

step "1/5  Stage-2.1 restoration authenticity"
bash scripts/check-stage21-restoration.sh "${1:-}"

step "2/5  Fresh migration replay (schema + full chain)"
npm run --silent test:baseline

step "3/5  Upgrade from a ledgered Stage-2.1 database (incl. live salary denial P3.1)"
npm run --silent test:stage21-upgrade

step "4/5  Direct manager salary query DENIED (full behavioural matrix)"
npm run --silent test:rls-local

step "5/5  Full verify (standing regression gate)"
npm run --silent verify >/tmp/milkpop-prove-verify.log 2>&1 \
  && echo "verify: exit 0 (log: /tmp/milkpop-prove-verify.log)" \
  || { echo "✖ verify failed — see /tmp/milkpop-prove-verify.log" >&2; exit 1; }

echo
echo "==============================================================="
echo "  STAGE-2 CLOSURE EVIDENCE — all five auditor requirements met"
echo "==============================================================="
echo "  1/5 restoration authenticity ✔"
echo "  2/5 fresh replay             ✔"
echo "  3/5 ledgered-2.1 upgrade     ✔  (manager pay query denied live: P3.1)"
echo "  4/5 behavioural matrix       ✔  (salary confidentiality §12)"
echo "  5/5 full verify              ✔"
echo
echo "  Hand this output with the package to the auditor. The GO decision"
echo "  is the auditor's; this script only assembles the required evidence."
