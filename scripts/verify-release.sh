#!/usr/bin/env bash
# ============================================================================
#  verify-release.sh — ONE command that runs EVERYTHING (audit-3, blocker 10)
# ============================================================================
#  `npm run verify` is the CI-safe static chain: typecheck, lint, and every
#  suite that needs no PostgreSQL, because the CI job has none. That split is
#  deliberate — but it left "run everything" as tribal knowledge spread over
#  a dozen commands, and the third external audit required a single documented
#  command whose output can be attached to a release.
#
#  This script IS that command:
#
#      npm run verify:release
#
#  It runs, in order: the static verify chain, the production-parity build,
#  and every database/browser suite, against a LOCAL PostgreSQL. Each stage's
#  full output is written to artifacts/release-verification/<stage>.log; a
#  summary lands in artifacts/release-verification/summary.txt. The script
#  exits non-zero if ANY stage fails — no partial credit.
#
#  Requirements: a local PostgreSQL 17 with `su postgres` access (the same
#  environment every DB suite in scripts/ already documents), node 22, and
#  the repo's node_modules installed.
# ============================================================================
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT="artifacts/release-verification"
mkdir -p "$OUT"

# ---------------------------------------------------------------------------
#  RESUMABLE EXECUTION (MP_VERIFY_RESUME=1)
#
#  A complete release verification runs for tens of minutes. Some environments
#  (constrained CI runners, sandboxes with a wall clock) cannot hold a single
#  process that long, and the alternative — shipping a partial or stale
#  summary.txt — is worse than shipping none, because it reads as a PASS for a
#  tree that was never fully checked.
#
#  With MP_VERIFY_RESUME=1 a stage whose log already exists AND already
#  recorded a pass is skipped, so the run can be continued until it completes.
#  Every stage is still genuinely EXECUTED once; nothing is inferred.
#
#  GUARD: resume is refused if the source tree changed since the run began.
#  The digest below is the same source_tree_sha256 the release manifest
#  carries, so a resumed run cannot silently mix results from two trees.
# ---------------------------------------------------------------------------
RESUME="${MP_VERIFY_RESUME:-0}"
# P0-4: one run id + one canonical source digest for every receipt this run
# writes. RUN_ID is inherited from release-seal when sealing, or generated for a
# standalone run. SRC_SHA comes from the ONE hasher — the same value the
# manifest and the verifier use — and FAILS CLOSED (the hasher exits non-zero
# rather than printing a placeholder, so a bad tree cannot be hashed to "unknown").
RUN_ID="${MP_RUN_ID:-run-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
SRC_SHA="$(node scripts/lib/release-hash.mjs --source)" || {
  echo "✖ release-hash failed — refusing to run on an un-hashable tree"; exit 1; }
export MP_RUN_ID="$RUN_ID"
RECEIPTS="$OUT/receipts"; mkdir -p "$RECEIPTS"

TREE_STAMP="$OUT/.tree"
# P0-4: the resume guard uses the SAME canonical digest as everything else
# (SRC_SHA, computed above), not a second inline walker with different
# exclusions. One definition of "the tested tree" — the divergent copy that
# hashed a different file set than the manifest is gone.
CURRENT_TREE="$SRC_SHA"

if [ "$RESUME" = "1" ] && [ -f "$TREE_STAMP" ]; then
  PRIOR="$(cat "$TREE_STAMP")"
  if [ "$PRIOR" != "$CURRENT_TREE" ]; then
    echo "✖ resume refused: the source tree changed since this run began"
    echo "   was $PRIOR"
    echo "   now $CURRENT_TREE"
    echo "   remove $OUT and start a fresh run."
    exit 2
  fi
  echo "── resuming: stages already passed will be skipped (tree unchanged) ──"
else
  rm -f "$OUT"/*.log "$OUT/summary.txt" 2>/dev/null || true
fi
echo "$CURRENT_TREE" > "$TREE_STAMP"
: > "$OUT/summary.txt"

FAILED=0
declare -a RESULTS=()

# P0-4: every stage writes a structured receipt, not a one-line marker. A
# `.passed` file containing a display string cannot prove which source produced
# it, which command ran, or that its log is intact — copied markers or logs from
# another run would sail through. The receipt records run_id + source digest +
# command + exit code + a sha256 of the log, and resume requires all of them to
# still agree (same run id, same source, and the log on disk must still hash to
# the receipt's value).
write_receipt() {
  local name="$1" cmd="$2" code="$3" log="$4" started="$5" completed="$6"
  local logsha; logsha="$(node -e "const{createHash}=require('crypto'),fs=require('fs');process.stdout.write(createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$log")"
  # P0-4 round 2: record the hash of the BUILD THIS STAGE EXERCISED. Without it
  # a receipt proved only which SOURCE was tested, so a release could swap dist/,
  # regenerate the manifest for the new build, and still present receipts that
  # "matched" — the shipped build was never tied to a tested build. Empty when
  # dist/ does not exist yet (early stages), which the contract allows; the
  # build-bound stages in release-contract.mjs MUST have it and the verifier
  # requires it to equal the dist/ extracted from the package.
  local buildsha; buildsha="$(node scripts/lib/release-hash.mjs --dir dist 2>/dev/null || echo '')"
  node -e "const fs=require('fs');fs.writeFileSync(process.argv[1],JSON.stringify({kind:'release-stage-receipt',run_id:process.argv[2],stage:process.argv[3],source_tree_sha256:process.argv[4],build_output_sha256:process.argv[11]||null,command:process.argv[5],exit_code:Number(process.argv[6]),log:process.argv[7],log_sha256:process.argv[8],started_at:process.argv[9],completed_at:process.argv[10]},null,2)+'\n')" \
    "$RECEIPTS/${name}.receipt.json" "$RUN_ID" "$name" "$SRC_SHA" "$cmd" "$code" "${name}.log" "$logsha" "$started" "$completed" "$buildsha"
}

stage() {
  local name="$1"; shift
  local cmd="$*"
  local log="$OUT/${name}.log"
  local receipt="$RECEIPTS/${name}.receipt.json"
  # Resume only if the receipt is valid FOR THIS RUN and its log is intact.
  if [ "$RESUME" = "1" ] && [ -f "$log" ] && [ -f "$receipt" ]; then
    local ok
    ok="$(node -e "
      const fs=require('fs'),{createHash}=require('crypto');
      const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
      const logsha=createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex');
      process.stdout.write(
        r.run_id===process.argv[3] && r.source_tree_sha256===process.argv[4] &&
        r.command===process.argv[5] && r.exit_code===0 && r.log_sha256===logsha ? 'yes':'no');
    " "$receipt" "$log" "$RUN_ID" "$SRC_SHA" "$cmd" 2>/dev/null || echo no)"
    if [ "$ok" = "yes" ]; then
      # Report the stage's REAL recorded result, re-read from the log the
      # receipt just proved intact — not a bare "skipped" marker. A resumed run
      # is how a full verification completes in a bounded environment, so the
      # shipped summary.txt must still carry every stage's actual numbers.
      local prior
      prior="$(grep -E "passed|PASS|EXIT|✔" "$log" | tail -1 | sed 's/^[[:space:]]*//')"
      RESULTS+=("PASS  ${name}  ${prior}  [resumed: receipt + log verified]")
      echo "── ${name} ── (receipt valid for this run, skipped)"
      return
    fi
    echo "── ${name} ── (receipt stale/invalid — re-running)"
  fi
  echo "── ${name} ──"
  local started; started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if "$@" > "$log" 2>&1; then
    local completed; completed="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    local line; line="$(grep -E "passed|PASS|EXIT|✔" "$log" | tail -1 | sed 's/^[[:space:]]*//')"
    write_receipt "$name" "$cmd" 0 "$log" "$started" "$completed"
    printf '%s' "$line" > "$OUT/${name}.passed"
    RESULTS+=("PASS  ${name}  ${line}")
    echo "   PASS  ${line}"
  else
    local code=$?; local completed; completed="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    FAILED=1
    rm -f "$OUT/${name}.passed"
    write_receipt "$name" "$cmd" "$code" "$log" "$started" "$completed"
    local line; line="$(tail -3 "$log" | tr '\n' ' ' | cut -c1-160)"
    RESULTS+=("FAIL  ${name}  ${line}")
    echo "   FAIL  see ${log}"
  fi
}

# 1. The static verification chain (what CI runs).
stage "verify-static"          npm run verify

# 2. Build parity: the same compile+prerender a deployment performs. The SEO
#    step runs in suppressed development-defaults mode here — production mode
#    requires a reachable Supabase and is exercised at staging commissioning
#    (docs/STAGING-COMMISSIONING.md), where prohibiting seed fallback is
#    itself one of the assertions.
stage "build"                  npm run build

# 3. Database suites — every one builds its own database from
#    launch/migration-manifest.sh, so ordering is free; this order puts the
#    fastest failures first.
stage "db-baseline"            npm run test:baseline
stage "db-rls-local"           npm run test:rls-local
stage "db-r48-upgrade"         npm run test:r48-upgrade
stage "db-adopt"               npm run test:adopt
stage "db-r410-contract"       npm run test:r410-contract
stage "db-r410-authz"          npm run test:r410-authz
stage "db-r410-lifecycle"      npm run test:r410-lifecycle
stage "db-r410-launch"         npm run test:r410-launch-candidate
stage "db-r410-form-matrix"    npm run test:r410-form-matrix
stage "db-r410-publish-mech"   npm run test:r410-publish-record
stage "db-r49-publish-safety"  npm run test:r49-publish-safety

# ---------------------------------------------------------------------------
#  INC11 + audit-response database suites. These were reachable only by hand
#  until an auditor pointed out the obvious consequence: the official release
#  command could pass while a dedicated suite was broken or never run. The
#  RLS matrix carries several of the same protections, but it does NOT carry
#  the pre-fix positive control, the historical 84->87 upgrade, the deliberate
#  privilege re-grant, the production-baseline behaviour test or the complete
#  four-caller matrix. Those live only in db-inc11-view-authority.
# ---------------------------------------------------------------------------
stage "client-wire"            npm run test:client-wire
stage "db-stage3-equivalence"  npm run stage3:baseline
stage "db-inc11-view-authority" npm run test:inc11-view-authority
stage "db-inc11-boundary"      npm run test:inc11-boundary
stage "db-inc11-notices"       npm run test:inc11-notices
stage "db-inc11-studio"        npm run test:inc11-studio
stage "db-inc11-lifecycle"     npm run test:inc11-lifecycle
stage "db-inc11-revisions"     npm run test:inc11-revisions
stage "db-retention"           npm run test:retention
stage "db-backup-restore"      npm run test:backup-restore
stage "db-concurrency-repeat"  npm run test:ws7-concurrency-repeat
stage "db-smallbiz-closure"    npm run test:smallbiz
stage "closure-hydration"      npm run test:closure-hydration
stage "db-closure-2nd-store"   npm run test:closure-second-store
stage "t13-behaviour"          npm run test:t13

# 4. Artefact scans that need the fresh build output.
stage "seed-scan"              npm run test:seed-honesty
stage "bundle-scan"            npm run scan:bundle
# P0-4: the release-provenance attack suite runs as a gated stage. It builds a
# genuine release set and proves all thirteen tampering attacks are rejected —
# including the exact junk-ZIP false-positive that started P0-4. dist exists by
# now (the build stage ran above), which the suite needs.
stage "provenance"            npm run test:provenance

# 5. Browser-level suites drive the BUILT site in headless Chromium. The
#    routing and click audits expect `vite preview` on :4173 (their headers
#    say "start it yourself"); verify:release exists to be ONE command, so it
#    starts and stops the server itself. r49-browser brings its own server.
#    `playwright install` is idempotent and a no-op when the browser is
#    already present — priced in so a fresh machine still needs no manual
#    step before this command.
"$ROOT/node_modules/.bin/playwright" install chromium > "$OUT/playwright-install.log" 2>&1 || true
"$ROOT/node_modules/.bin/vite" preview --port 4173 --strictPort > "$OUT/preview-server.log" 2>&1 &
PREVIEW_PID=$!
PREVIEW_UP=0
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:4173/ > /dev/null 2>&1; then PREVIEW_UP=1; break; fi
  sleep 1
done
if [ "$PREVIEW_UP" = "1" ]; then
  stage "browser-routing"        npm run test:routing
  stage "browser-clicks"         npm run audit:clicks
  stage "browser-launch-polish"  npm run audit:launch-polish
else
  FAILED=1
  RESULTS+=("FAIL  browser-preview  vite preview never answered on :4173 — see preview-server.log")
  echo "   FAIL  vite preview never answered on :4173"
fi
kill "$PREVIEW_PID" 2>/dev/null || true
stage "browser-auth-multitab" npm run test:auth-multitab-browser

# r49-browser REBUILDS dist/ against a stub origin (that is its whole method —
# prove the app fails closed when its backend never answers). It therefore
# runs LAST, and dist/ afterwards is the STUB build, not a release build.
# Anything that hashes or ships dist (release-manifest generation, packaging)
# must run a fresh `npm run build` first — the runbook says so too.
stage "browser-r49"            npm run test:r49-browser

{
  echo "RELEASE VERIFICATION — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "node $(node --version) · $(git rev-parse --short HEAD 2>/dev/null || echo 'no git')"
  echo ""
  printf '%s\n' "${RESULTS[@]}"
  echo ""
  if [ "$FAILED" = "0" ]; then echo "VERDICT: every stage passed."; else echo "VERDICT: FAILED — do not release."; fi
} | tee "$OUT/summary.txt"

exit "$FAILED"
