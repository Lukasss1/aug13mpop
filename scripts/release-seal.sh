#!/usr/bin/env bash
# ============================================================================
#  release:seal  —  the ONE command that produces the deployable release
# ============================================================================
#
#  P0-4 round 1 built once and froze the deployable, but the browser lane that
#  exercised the frozen build wrote its logs to out/ and produced NO receipts,
#  and out/ never entered the logs archive. So nothing bound the SHIPPED dist to
#  a TESTED dist: an auditor swapped dist/index.html, regenerated the manifest
#  for the new build, repacked, and the release still verified.
#
#  Round 2 closes that. The frozen build is restored into dist/ BEFORE the
#  authoritative lane runs, that lane writes real receipts recording the build's
#  hash, and those receipts ship inside the logs archive. The verifier requires
#  every build-bound receipt's build_output_sha256 to equal the dist/ it
#  extracts from the package. Tested build and shipped build are now the same
#  object by cryptographic construction, not by procedure.
#
#  BUILD PROFILE. The deployable must come from `npm run build:production`,
#  which refuses to run without a real production environment (VITE_DEPLOYMENT_
#  MODE=production plus live Supabase configuration). Where that environment is
#  absent the seal does NOT quietly fall back: it stops unless the operator
#  passes MP_SEAL_ALLOW_NONPRODUCTION=1, and then the whole release is STAMPED
#  build_profile:"development" in the manifest and the set. A verifier run in
#  production mode rejects such a release outright — same honest pattern as the
#  STUB signature: the artefact declares what it is.
#
#  Usage:
#    OUT_DIR=release-out \
#      MP_RELEASE_IDENTITY=r4.10.15-t13.3.30-final-production-closure \
#      MP_EVIDENCE_DOC=CURRENT-RELEASE-EVIDENCE.md \
#      bash scripts/release-seal.sh
# ============================================================================
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)" || { echo "release-seal: could not resolve repository root" >&2; exit 1; }
cd "$ROOT" || { echo "release-seal: could not enter repository root" >&2; exit 1; }
OUT_DIR="${OUT_DIR:-$ROOT/release-out}"
IDENT="${MP_RELEASE_IDENTITY:?set MP_RELEASE_IDENTITY, e.g. r4.10.15-t13.3.30-final-production-closure}"
RELEASE_NUMBER="${MP_RELEASE_NUMBER:-}"
if [ -n "$RELEASE_NUMBER" ]; then
  case "$RELEASE_NUMBER" in *[!0-9]*) echo "release-seal: MP_RELEASE_NUMBER must be a positive integer" >&2; exit 1 ;; esac
  [ "$RELEASE_NUMBER" -gt 0 ] || { echo "release-seal: MP_RELEASE_NUMBER must be a positive integer" >&2; exit 1; }
fi
RUN_ID="${MP_RUN_ID:-seal-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
export MP_RUN_ID="$RUN_ID"
FROZEN="$ROOT/out/release/dist"
ART="$ROOT/artifacts/release-verification"
RECEIPTS="$ART/receipts"
say() { printf '\n=== %s ===\n' "$1"; }
die() { echo "release-seal: $1" >&2; exit 1; }

# release-out/ is the one safe in-repository output boundary: canonical source
# hashing and source packaging both exclude it. Any other custom OUT_DIR must
# live outside the repository so stale release artefacts cannot enter the next
# source identity.
OUT_DIR="$(node -e "const path=require('path');process.stdout.write(path.resolve(process.argv[1]))" "$OUT_DIR")" || die "could not resolve OUT_DIR"
case "$OUT_DIR" in
  "$ROOT/release-out"|"$ROOT/release-out/"*) ;;
  "$ROOT"|"$ROOT/"*) die "OUT_DIR inside the repository must be release-out/ (or a subdirectory); choose an external directory otherwise" ;;
  *) ;;
esac

# Direct invocations must receive the same fail-fast production binding as CI.
# Development diagnostic seals may explicitly opt out; production never does.
if [ "${MP_SEAL_ALLOW_NONPRODUCTION:-0}" != "1" ]; then
  say "0. production release preflight"
  node scripts/production-release-preflight.mjs || die "production release preflight failed"
fi

say "1. canonical source hash (before testing)"
mkdir -p "$ROOT/out" || die "could not create working output directory"
SRC_BEFORE="$(node scripts/lib/release-hash.mjs --source)" || die "source hash failed"
echo "source_tree_sha256 (before): $SRC_BEFORE"

say "2. build the deployable ONCE and freeze it"
BUILD_PROFILE="production"
if npm run build:production > "$ROOT/out/build.log" 2>&1; then
  echo "built with build:production"
else
  if [ "${MP_SEAL_ALLOW_NONPRODUCTION:-0}" != "1" ]; then
    tail -5 "$ROOT/out/build.log" >&2
    die "build:production failed and MP_SEAL_ALLOW_NONPRODUCTION is not set — refusing to seal a non-production build silently"
  fi
  BUILD_PROFILE="development"
  npm run build > "$ROOT/out/build.log" 2>&1 || die "build failed (see out/build.log)"
  echo "!! build:production unavailable in this environment — sealed as build_profile=development"
  echo "!! this release is NOT deployable; a production verifier will reject it"
fi
# The live release marker is written into dist AFTER the build hash is computed
# (the hasher excludes it, so the value cannot contain itself). After deployment
# the workflow fetches https://<domain>/.well-known/milkpop-release.json and
# confirms it matches the signed release.
BUILD_ONLY_SHA="$(node scripts/lib/release-hash.mjs --dir dist)" || die "build hash failed"
PUBLIC_FUNCTION_SET_SHA="$(node scripts/public-function-set-hash.mjs)" || die "public function-set hash failed"
mkdir -p dist/.well-known || die "could not create release-marker directory"
node -e "
const fs=require('fs');
fs.writeFileSync('dist/.well-known/milkpop-release.json', JSON.stringify({
  release_identity: process.env.MP_RELEASE_IDENTITY || null,
  release_number: process.env.MP_RELEASE_NUMBER ? Number(process.env.MP_RELEASE_NUMBER) : null,
  git_commit: process.env.MP_GIT_COMMIT || null,
  build_output_sha256: process.argv[1],
  public_function_set_sha256: process.argv[3],
  build_profile: process.argv[2],
  site_domain: process.env.MP_SITE_DOMAIN || null,
}, null, 2) + '\n');
" "$BUILD_ONLY_SHA" "$BUILD_PROFILE" "$PUBLIC_FUNCTION_SET_SHA" || die "could not write live release marker"
echo "live release marker written (build $BUILD_ONLY_SHA; public functions $PUBLIC_FUNCTION_SET_SHA)"

rm -rf "$FROZEN" || die "could not clear frozen build"
mkdir -p "$FROZEN" || die "could not create frozen build directory"
cp -a dist/. "$FROZEN/" || die "could not freeze dist"
BUILD_LOG_SRC="$ROOT/out/build.log"
BUILD_FROZEN="$(node scripts/lib/release-hash.mjs --dir "$FROZEN")" || die "frozen build hash failed"
echo "build_output_sha256 (frozen): $BUILD_FROZEN"
echo "build_profile: $BUILD_PROFILE"
if [ "$BUILD_PROFILE" = "production" ] && [ -z "$RELEASE_NUMBER" ]; then
  die "a production seal requires MP_RELEASE_NUMBER (positive monotonic integer)"
fi

say "3. full release verification (per-stage receipts)"
MP_RUN_ID="$RUN_ID" MP_VERIFY_RESUME="${MP_VERIFY_RESUME:-1}" bash scripts/verify-release.sh || die "verify-release did not pass"

say "4. restore the frozen deployable into dist/ — everything after this tests what ships"
rm -rf dist || die "could not clear dist before restore"
mkdir -p dist || die "could not recreate dist"
cp -a "$FROZEN/." dist/ || die "could not restore frozen build"
DIST_NOW="$(node scripts/lib/release-hash.mjs --dir dist)" || die "restored dist hash failed"
[ "$DIST_NOW" = "$BUILD_FROZEN" ] || die "restored dist does not match the frozen build"

# A stage of the authoritative lane: runs against the restored (= shipping)
# build, logs into the artifacts directory that gets packaged, and writes a
# receipt carrying THIS build's hash.
seal_stage() {
  local name="$1"; shift
  local cmd="$*"
  local log="$ART/${name}.log"
  local started; started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "── ${name} ──"
  if "$@" > "$log" 2>&1; then
    local completed; completed="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    local logsha; logsha="$(node -e "const{createHash}=require('crypto'),fs=require('fs');process.stdout.write(createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$log")" || die "could not hash ${name} log"
    node -e "const fs=require('fs');fs.writeFileSync(process.argv[1],JSON.stringify({kind:'release-stage-receipt',run_id:process.argv[2],stage:process.argv[3],source_tree_sha256:process.argv[4],build_output_sha256:process.argv[5],command:process.argv[6],exit_code:0,log:process.argv[3]+'.log',log_sha256:process.argv[7],started_at:process.argv[8],completed_at:process.argv[9]},null,2)+'\n')" \
      "$RECEIPTS/${name}.receipt.json" "$RUN_ID" "$name" "$SRC_BEFORE" "$BUILD_FROZEN" "$cmd" "$logsha" "$started" "$completed" || die "could not write ${name} receipt"
    echo "   PASS  $(grep -E 'passed|PASS|✔' "$log" | tail -1 | sed 's/^[[:space:]]*//' | cut -c1-110)"
  else
    tail -4 "$log" >&2
    die "${name} FAILED against the frozen build — see ${log}"
  fi
}

# When this IS a production release, the production build itself is attested as
# a build-bound stage — so "build_profile: production" rests on evidence rather
# than on a string in a manifest.
if [ "$BUILD_PROFILE" = "production" ]; then
  cp "$BUILD_LOG_SRC" "$ART/production-build.log" || die "could not copy production build log"
  PB_SHA="$(node -e "const{createHash}=require('crypto'),fs=require('fs');process.stdout.write(createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))" "$ART/production-build.log")" || die "could not hash production build log"
  node -e "const fs=require('fs');fs.writeFileSync(process.argv[1],JSON.stringify({kind:'release-stage-receipt',run_id:process.argv[2],stage:'production-build',source_tree_sha256:process.argv[3],build_output_sha256:process.argv[4],command:'npm run build:production',exit_code:0,log:'production-build.log',log_sha256:process.argv[5],started_at:process.argv[6],completed_at:process.argv[6]},null,2)+'\n')" \
    "$RECEIPTS/production-build.receipt.json" "$RUN_ID" "$SRC_BEFORE" "$BUILD_FROZEN" "$PB_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || die "could not write production-build receipt"
  echo "production-build receipt written (attests the shipped build came from build:production)"
fi

say "5. authoritative lane against the frozen build (receipts bind tested == shipped)"
PV=""
cleanup_preview() {
  if [ -n "${PV:-}" ]; then
    kill "$PV" 2>/dev/null || true
    wait "$PV" 2>/dev/null || true
    PV=""
  fi
}
trap cleanup_preview EXIT
"$ROOT/node_modules/.bin/vite" preview --port 4173 --strictPort > "$ROOT/out/preview-frozen.log" 2>&1 &
PV=$!; UP=0
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:4173/ >/dev/null 2>&1 && { UP=1; break; }; sleep 1; done
[ "$UP" = 1 ] || die "frozen-build preview never answered"
seal_stage "frozen-routing" npm run test:routing
seal_stage "frozen-clicks"  npm run audit:clicks
seal_stage "frozen-final"   npm run audit:final
cleanup_preview
seal_stage "frozen-bundle"  npm run scan:bundle

# P0-5: judge the ARTEFACT that is about to ship, and prove its public/commercial
# output is real. Production-only — a development seal must not carry these.
if [ "$BUILD_PROFILE" = "production" ]; then
  [ -n "${MP_TRUST_POLICY:-}" ] || die "a production seal needs MP_TRUST_POLICY (approved domain + Supabase project) to judge the artefact"
  # The receipt records the command VERBATIM and the contract compares it
  # exactly, so the policy is passed through the environment (which the scanner
  # already reads) rather than on argv. Extra flags here would fail contract
  # validation AFTER the entire run — a late failure for no benefit.
  export MP_TRUST_POLICY
  seal_stage "production-artifact" npm run verify:production-artifact
  seal_stage "production-seo" npm run test:seo
fi

say "6. canonical source hash (after testing) — must equal before"
SRC_AFTER="$(node scripts/lib/release-hash.mjs --source)" || die "source hash failed"
[ "$SRC_AFTER" = "$SRC_BEFORE" ] || die "SOURCE CHANGED DURING TESTING: $SRC_BEFORE -> $SRC_AFTER"
BUILD_NOW="$(node scripts/lib/release-hash.mjs --dir dist)" || die "shipping build hash failed"
[ "$BUILD_NOW" = "$BUILD_FROZEN" ] || die "SHIPPING BUILD CHANGED DURING THE LANE: $BUILD_FROZEN -> $BUILD_NOW"
echo "source and build both unchanged across the run"

say "7. generate the release manifest"
MP_RELEASE_IDENTITY="$IDENT" MP_RUN_ID="$RUN_ID" MP_BUILD_PROFILE="$BUILD_PROFILE" \
  node scripts/generate-release-manifest.mjs || die "manifest generation failed"
MSRC="$(node -e "process.stdout.write(require('./release-manifest.json').source_tree_sha256)")" || die "could not read manifest source digest"
MBUILD="$(node -e "process.stdout.write(require('./release-manifest.json').build_output_sha256)")" || die "could not read manifest build digest"
[ "$MSRC" = "$SRC_AFTER" ] || die "manifest source digest disagrees with the hasher"
[ "$MBUILD" = "$BUILD_FROZEN" ] || die "manifest build digest disagrees with the frozen build"

say "8. package the three archives"
# Release identity and monotonic release number are deliberately independent.
# Older code required an identity ending in -tN and hard-coded INC11 filenames,
# which made semantic tags and manual releases impossible to seal. Derive a
# filesystem-safe slug from any approved identity, or accept an explicit slug.
ARTIFACT_SLUG="${MP_ARTIFACT_SLUG:-$(printf '%s' "$IDENT" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//')}"
[ -n "$ARTIFACT_SLUG" ] || die "release identity produced an empty artifact slug"
case "$ARTIFACT_SLUG" in *[!a-z0-9._-]*) die "unsafe MP_ARTIFACT_SLUG: $ARTIFACT_SLUG" ;; esac

PKG="$OUT_DIR/MilkPop-${ARTIFACT_SLUG}.zip"
EVID="$OUT_DIR/MilkPop-${ARTIFACT_SLUG}-evidence.zip"
LOGS="$OUT_DIR/MilkPop-${ARTIFACT_SLUG}-verification-logs.zip"
mkdir -p "$OUT_DIR" || die "could not create output directory"
rm -f "$PKG" "$EVID" "$LOGS" "$PKG.manifest.json" || die "could not clear previous release artifacts"
# backups/ is excluded from the SOURCE DIGEST, so it must also be excluded from
# the package — otherwise a file (a database dump, secrets) ships bound by
# nothing. Generated release-out/ content is excluded too, including the ZIP
# while it is being written. The verifier independently enforces a positive content allow-list.
zip -qr "$PKG" . -x "node_modules/*" -x "*.log" -x "*.zip" -x "*.manifest.json" -x "artifacts/*" -x "out/*" -x "release-out/*" -x ".git/*" -x "backups/*" || die "source package creation failed"
# Use one stable current-release evidence filename. Historical evidence remains
# in the source archive, but the release set binds only the explicitly selected
# current document. Refuse absolute paths or parent traversal.
EVID_DOC="${MP_EVIDENCE_DOC:-CURRENT-RELEASE-EVIDENCE.md}"
case "$EVID_DOC" in /*|*..*) die "unsafe MP_EVIDENCE_DOC: $EVID_DOC" ;; esac
[ -f "$EVID_DOC" ] || die "evidence document $EVID_DOC is missing — refusing to seal"
EVID_REAL="$(realpath -e "$EVID_DOC")" || die "could not resolve evidence document"
case "$EVID_REAL" in "$ROOT"/*) ;; *) die "evidence document resolves outside the source tree" ;; esac
zip -qj "$EVID" "$EVID_REAL" || die "could not package the evidence document"
( cd "$ART" && zip -q "$LOGS" ./*.log summary.txt && zip -qr "$LOGS" receipts ) || die "verification logs package failed"

say "9. detached package manifest + release set"
node scripts/write-archive-manifest.mjs "$PKG" "$EVID" || die "package manifest failed"
MP_BUILD_PROFILE="$BUILD_PROFILE" node scripts/write-release-set.mjs "$IDENT" "$RUN_ID" "$OUT_DIR" "$PKG" "$EVID" "$LOGS" || die "release-set failed"

# Optional real signing: if MP_SIGNING_KEY (an Ed25519 private key OUTSIDE the
# release) is provided, sign the set and verify it AUTHENTICATED against the
# matching trust policy. Otherwise the set stays STUB and this is an UNSIGNED
# DRAFT — the final verification is only self-consistency, and the seal says so.
SIGNED=0
if [ -n "${MP_SIGNING_KEY:-}" ]; then
  node scripts/sign-release-set.mjs "$OUT_DIR/release-set.json" "$MP_SIGNING_KEY" || die "signing failed"
  SIGNED=1
fi

say "10. final verification"
if [ "$SIGNED" = 1 ]; then
  [ -n "${MP_TRUST_POLICY:-}" ] || die "MP_SIGNING_KEY was set but MP_TRUST_POLICY (the matching public trust policy) was not — cannot verify authenticated"
  # Production verification is the DEFAULT. A development seal is verified in
  # the explicit diagnostic mode instead, and says so in its verdict.
  DEV_FLAG=""
  [ "$BUILD_PROFILE" = "production" ] || DEV_FLAG="--allow-development"
  ( cd /tmp && node "$ROOT/scripts/verify-archive-manifest.mjs" --set "$OUT_DIR/release-set.json" --trust "$MP_TRUST_POLICY" $DEV_FLAG ) \
    || die "AUTHENTICATED release-set verification FAILED"
else
  # STUB set: only self-consistency can pass, and only outside production.
  DEV_FLAG=""
  [ "$BUILD_PROFILE" = "production" ] || DEV_FLAG="--allow-development"
  ( cd /tmp && node "$ROOT/scripts/verify-archive-manifest.mjs" --set "$OUT_DIR/release-set.json" --self-consistency $DEV_FLAG ) \
    || die "release-set self-consistency verification FAILED"
fi

if [ "$SIGNED" = 1 ] && [ "$BUILD_PROFILE" = "production" ]; then
  say "SEALED — SIGNED PRODUCTION RELEASE"
elif [ "$SIGNED" = 1 ]; then
  say "SEALED — SIGNED (development profile)"
else
  say "UNSIGNED DRAFT — self-consistent only, NOT an authenticated release"
fi
echo "release identity : $IDENT"
echo "run id           : $RUN_ID"
echo "build profile    : $BUILD_PROFILE"
echo "package          : $PKG"
echo "evidence         : $EVID"
echo "logs+receipts    : $LOGS"
echo "release set      : $OUT_DIR/release-set.json"
echo "signed           : $([ "$SIGNED" = 1 ] && echo yes || echo 'NO — unsigned draft')"
{ [ "$BUILD_PROFILE" = "production" ] && [ "$SIGNED" = 1 ]; } || echo "!! NOT DEPLOYABLE — $([ "$SIGNED" = 1 ] || echo 'unsigned; ')$([ "$BUILD_PROFILE" = production ] || echo 'development build')"
