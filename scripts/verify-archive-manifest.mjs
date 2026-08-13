#!/usr/bin/env node
/**
 * ============================================================================
 *  RELEASE VERIFIER — extracts the archive and checks its CONTENTS  (P0-4)
 * ============================================================================
 *
 *  The previous verifier hashed the archive's bytes, then walked the CURRENT
 *  WORKING DIRECTORY and compared THAT to source_tree_sha256. It never opened
 *  the archive. Standing in the real tree with a junk ZIP therefore produced
 *  "PROVENANCE VERIFIED": the junk ZIP's bytes matched the byte hash its own
 *  writer had recorded, and the working directory matched its own digest —
 *  two unrelated facts.
 *
 *  This verifier NEVER consults the working directory for a semantic value.
 *  It:
 *    1. verifies the archive's byte hash and size against the manifest;
 *    2. inspects the ZIP's entries for traversal, symlinks, duplicates and
 *       case collisions — refusing before extracting;
 *    3. extracts into a fresh temporary directory;
 *    4. reads the inner release-manifest.json FROM that extraction;
 *    5. recomputes source_tree_sha256 and build_output_sha256 over the
 *       extracted content, through the one canonical hasher, and compares them
 *       to the inner manifest AND the detached/set manifest;
 *    6. verifies every migration named in the inner manifest exists in the
 *       extraction and hashes correctly, that NO unlisted migration is present,
 *       and that the migration fingerprint matches;
 *    7. verifies every Edge Function hash the inner manifest records;
 *    8. compares every identity field across inner and detached manifests;
 *    9. for a release-SET manifest, verifies every companion archive's hash and
 *       size, validates the test receipts inside the logs archive against the
 *       expected stage list and their logs, and checks the release signature.
 *
 *  Accepts either a single detached-archive-manifest (verifies that one
 *  archive) or a milkpop-release-set manifest (verifies the whole set).
 *
 *  Usage:
 *    node scripts/verify-archive-manifest.mjs <archive.zip> <manifest.json>
 *    node scripts/verify-archive-manifest.mjs --set <release-set.json>
 * ============================================================================
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashSourceTree, hashBuildDir, countSourceFiles } from './lib/release-hash.mjs';
import { inspectZipEntries, extractZip } from './lib/zip-inspect.mjs';
import {
  BUILD_BOUND_STAGES, commandFor, diffStages, stagesForProfile,
} from './lib/release-contract.mjs';
import {
  verifyEd25519, verifyCosign, REAL_SCHEMES, PINNED_KEY_FILE, loadTrustPolicy, keyFingerprint,
} from './lib/release-signature.mjs';
import { EXCLUDE_DIRS, SOURCE_EXCLUDE_EXACT } from './lib/release-hash.mjs';
import {
  EDGE_FUNCTIONS,
  assertExactEdgeFunctionInventory,
  assertExactEdgeFunctionHashMap,
  assertPublicFunctionSetSha256,
  computePublicFunctionSetSha256,
} from './lib/edge-function-inventory.mjs';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

let failed = 0;
let unauthenticated = false;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const shortpair = (a, b) => `${String(a).slice(0, 16)}… vs ${String(b).slice(0, 16)}…`;

/** Every APPLIED-CHAIN migration file present under supabase/ in the extraction.
 *  A migration is a file named `migration_*.sql`. Non-chain SQL — the canonical
 *  baseline snapshot (launch-baseline-v1.sql) and dev seed (seed.dev.sql) — is
 *  ordinary source, already bound by source_tree_sha256; it is not a migration
 *  and must not trip the "unlisted migration" guard. The listed FRESH-ONLY
 *  files (schema.FRESH-INSTALL-ONLY.sql, seed.sql) are verified by the
 *  presence+hash check instead. This guard exists to catch an INJECTED or
 *  RENAMED migration that the manifest does not list. */
function migrationsOnDisk(root) {
  const dir = path.join(root, 'supabase');
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const f = path.join(d, e);
      const st = lstatSync(f);
      if (st.isDirectory()) walk(f);
      else if (/^migration_.*\.sql$/.test(e)) out.push(path.relative(root, f).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out;
}


function edgeFunctionsOnDisk(root) {
  const dir = path.join(root, 'supabase', 'functions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name !== '_shared' && lstatSync(path.join(dir, name)).isDirectory())
    .sort();
}

function exactInventoryOk(observed, label) {
  try {
    assertExactEdgeFunctionInventory(observed, label);
    return { ok: true, detail: `${EDGE_FUNCTIONS.length} exact functions` };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

function exactHashMapOk(value, label) {
  try {
    assertExactEdgeFunctionHashMap(value, label);
    return { ok: true, detail: `${EDGE_FUNCTIONS.length} exact hashes` };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

/**
 * Full extraction-based verification of ONE archive against an expectation.
 * Every value is derived from inside the ZIP.
 */
function verifyArchiveContents(archivePath, expect, label) {
  console.log(`\n── archive: ${path.basename(archivePath)} ──`);

  /* Declared BEFORE any early return. A previous revision returned `extracted`
     from the hostile-archive branch above its own `const`, which threw a
     ReferenceError instead of rejecting cleanly. It failed closed, but by
     crashing — and the attack suite counted any non-zero exit as a pass, so the
     intended error path was never actually exercised. */
  const extracted = { build: null, inner: null, pub: null, seo: null, marker: null };
  check(`${label}: archive exists`, existsSync(archivePath),
    existsSync(archivePath) ? undefined : archivePath);
  if (!existsSync(archivePath)) return extracted;

  check(`${label}: archive byte hash matches`, sha(archivePath) === expect.archive_sha256,
    shortpair(sha(archivePath), expect.archive_sha256));
  if (expect.archive_bytes != null) {
    check(`${label}: archive byte size matches`, statSync(archivePath).size === expect.archive_bytes,
      `${statSync(archivePath).size} vs ${expect.archive_bytes}`);
  }

  const report = inspectZipEntries(archivePath);
  check(`${label}: no unsafe ZIP entries (traversal / symlink / duplicate / case-collision)`,
    report.problems.length === 0, report.problems.join('; ') || `${report.count} entries clean`);
  if (report.problems.length) return extracted; // do not extract a hostile archive

  const work = mkdtempSync(path.join(tmpdir(), 'mp-verify-'));
  try {
    extractZip(archivePath, work);

    const innerPath = path.join(work, 'release-manifest.json');
    check(`${label}: archive contains release-manifest.json`, existsSync(innerPath));
    if (!existsSync(innerPath)) return extracted;
    const inner = JSON.parse(readFileSync(innerPath, 'utf8'));
    extracted.inner = inner;

    /* 5. content digests, recomputed from the extraction */
    const contentSource = hashSourceTree(work);
    const contentFileCount = countSourceFiles(work);
    check(`${label}: inner manifest file_count matches canonical extracted source files`,
      inner.file_count === contentFileCount, `${inner.file_count} vs ${contentFileCount}`);
    if (expect.source_file_count != null) {
      check(`${label}: canonical source file count matches detached manifest`,
        contentFileCount === expect.source_file_count, `${contentFileCount} vs ${expect.source_file_count}`);
    }
    check(`${label}: extracted source recomputes to the inner manifest's source_tree_sha256`,
      contentSource === inner.source_tree_sha256, shortpair(contentSource, inner.source_tree_sha256));
    if (expect.source_tree_sha256) {
      check(`${label}: …and equals the expected source_tree_sha256`,
        contentSource === expect.source_tree_sha256, shortpair(contentSource, expect.source_tree_sha256));
    }

    const distDir = path.join(work, 'dist');
    const contentBuild = existsSync(distDir) ? hashBuildDir(distDir) : null;
    extracted.build = contentBuild;
    /* read FROM THE EXTRACTION — never from the working directory */
    const pubPath = path.join(work, PINNED_KEY_FILE);
    if (existsSync(pubPath)) extracted.pub = readFileSync(pubPath, 'utf8');
    const markerPath = path.join(distDir, '.well-known', 'milkpop-release.json');
    if (existsSync(markerPath)) {
      try { extracted.marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch { extracted.marker = null; }
    }
    const seoPath = path.join(distDir, 'seo-manifest.json');
    if (existsSync(seoPath)) {
      try { extracted.seo = JSON.parse(readFileSync(seoPath, 'utf8')); } catch { extracted.seo = null; }
    }
    check(`${label}: extracted dist/ recomputes to the inner manifest's build_output_sha256`,
      contentBuild === (inner.build_output_sha256 || null), shortpair(contentBuild, inner.build_output_sha256));
    if (expect.build_output_sha256 !== undefined) {
      check(`${label}: …and equals the expected build_output_sha256`,
        contentBuild === expect.build_output_sha256, shortpair(contentBuild, expect.build_output_sha256));
    }

    /* 6. MIGRATIONS DERIVED FROM THE PACKAGE, not from the manifest's own
       claims. Round 2 trusted `_migration_order` and never recomputed the
       count: declaring an EMPTY order (whose fingerprint is sha256 of the
       empty string) or `migration_count: 0` both verified while the whole
       chain sat in the package. The order is now PARSED from the extracted
       launch/migration-manifest.sh — the same single source of truth the
       generator reads — and every derived quantity is recomputed from it. */
    const chainSh = path.join(work, 'launch', 'migration-manifest.sh');
    check(`${label}: the package carries launch/migration-manifest.sh (the chain's source of truth)`,
      existsSync(chainSh));
    const listed = inner.migrations || {};
    if (existsSync(chainSh)) {
      const parsed = [...readFileSync(chainSh, 'utf8').matchAll(/"(supabase\/[^"]+\.sql)"/g)].map((m) => m[1]);
      check(`${label}: the extracted chain manifest names migrations`, parsed.length > 0, `${parsed.length} entries`);
      check(`${label}: the chain has no duplicate entries`,
        new Set(parsed).size === parsed.length, `${parsed.length} entries, ${new Set(parsed).size} unique`);

      const listedNames = Object.keys(listed).sort();
      const parsedSorted = [...parsed].sort();
      check(`${label}: the manifest's migration set equals the chain declared in the package`,
        JSON.stringify(listedNames) === JSON.stringify(parsedSorted),
        listedNames.length === parsedSorted.length
          ? 'same set'
          : `manifest lists ${listedNames.length}, chain declares ${parsedSorted.length}`);

      /* count and fingerprint RECOMPUTED from the parsed order */
      const realCount = parsed.filter((m) => /\/migration_/.test(m)).length;
      check(`${label}: migration_count recomputed from the package equals the manifest's claim`,
        inner.migration_count === realCount, `manifest ${inner.migration_count} vs package ${realCount}`);
      if (expect.migration_count !== undefined && expect.migration_count !== null) {
        check(`${label}: …and equals the release set's claim`,
          expect.migration_count === realCount, `set ${expect.migration_count} vs package ${realCount}`);
      }
      const realFp = createHash('sha256')
        .update(parsed.map((m) => `${m}:${listed[m] || 'MISSING'}`).join('\n')).digest('hex');
      check(`${label}: migration fingerprint recomputed from the package's own chain order`,
        realFp === inner.migration_fingerprint_sha256, shortpair(realFp, inner.migration_fingerprint_sha256));
    }

    const migBad = [];
    for (const m of Object.keys(listed)) {
      const f = path.join(work, m);
      if (!existsSync(f)) migBad.push(`${m} MISSING`);
      else if (sha(f) !== listed[m]) migBad.push(`${m} HASH`);
    }
    check(`${label}: every listed migration is present and hashes correctly`,
      migBad.length === 0, migBad.slice(0, 4).join(', ') || `${Object.keys(listed).length} migrations`);

    const onDisk = migrationsOnDisk(work).sort();
    const unlisted = onDisk.filter((m) => !(m in listed));
    check(`${label}: no unlisted migration is present in the archive`,
      unlisted.length === 0, unlisted.slice(0, 4).join(', ') || 'none');

    /* 6b. POSITIVE PACKAGE CONTENT ALLOW-LIST. The source digest excludes root
       generated directories, but packaging did not exclude backups/ — so a
       file could ship inside the archive while being represented by NOTHING in
       the tested source identity (an auditor shipped backups/unbound-secret.txt
       this way). Rather than chase directory names, every file in the package
       must now be either covered by the source digest or on a short, explicit
       list of expected extras. Anything else fails. */
    /* Only release-manifest.json is an expected extra. summary.txt used to be
       allowed here but was never hash-checked, so it could be rewritten freely;
       it now travels ONLY in the logs archive, whose bytes the set binds. */
    const allowedExtras = new Set(['release-manifest.json']);
    const unbound = [];
    const walkAll = (dir) => {
      for (const e of readdirSync(dir)) {
        const full = path.join(dir, e);
        const st = lstatSync(full);
        const rel = path.relative(work, full).split(path.sep).join('/');
        if (st.isDirectory()) { walkAll(full); continue; }
        if (rel.startsWith('dist/')) continue;                 // the build, bound by build_output_sha256
        if (allowedExtras.has(rel)) continue;
        const top = rel.split('/')[0];
        const covered = !EXCLUDE_DIRS.has(top) && !SOURCE_EXCLUDE_EXACT.has(rel);
        if (!covered) unbound.push(rel);
      }
    };
    walkAll(work);
    check(`${label}: every file in the package is bound by the source digest or an expected extra`,
      unbound.length === 0,
      unbound.slice(0, 5).join(', ') || 'no unbound files');

    /* 7. Edge Function inventory + shared/index hashes. The code-owned
       inventory is exact: all 17 source trees must ship even though only the
       14 non-POS functions are deployed for the current launch. */
    const diskInventory = exactInventoryOk(edgeFunctionsOnDisk(work), `${label} archive Edge Function directories`);
    check(`${label}: archive carries the exact code-owned Edge Function inventory`,
      diskInventory.ok, diskInventory.detail);
    check(`${label}: manifest records the exact Edge Function count`,
      inner.edge_function_count === EDGE_FUNCTIONS.length,
      `${inner.edge_function_count} vs ${EDGE_FUNCTIONS.length}`);
    const manifestInventory = exactInventoryOk(inner.edge_function_inventory, `${label} manifest Edge Function inventory`);
    check(`${label}: manifest enumerates the exact code-owned Edge Function inventory`,
      manifestInventory.ok, manifestInventory.detail);

    const fns = inner.edge_functions || {};
    const exactEntries = exactHashMapOk(fns, `${label} manifest Edge Function entry hashes`);
    check(`${label}: manifest has exactly one index hash for every Edge Function`,
      exactEntries.ok, exactEntries.detail);
    const fnBad = [];
    for (const [name, h] of Object.entries(fns)) {
      const f = path.join(work, 'supabase', 'functions', name, 'index.ts');
      if (!existsSync(f)) fnBad.push(`${name} MISSING`);
      else if (sha(f) !== h) fnBad.push(`${name} HASH`);
    }
    check(`${label}: every Edge Function index.ts hash matches`,
      fnBad.length === 0, fnBad.slice(0, 4).join(', ') || `${Object.keys(fns).length} functions`);

    const fnTrees = inner.edge_function_trees || {};
    const exactTrees = exactHashMapOk(fnTrees, `${label} manifest Edge Function tree hashes`);
    check(`${label}: manifest has exactly one full-tree hash for every Edge Function`,
      exactTrees.ok, exactTrees.detail);
    const fnTreeBad = [];
    for (const [name, h] of Object.entries(fnTrees)) {
      const dir = path.join(work, 'supabase', 'functions', name);
      if (!existsSync(dir)) fnTreeBad.push(`${name} MISSING`);
      else if (hashBuildDir(dir) !== h) fnTreeBad.push(`${name} TREE_HASH`);
    }
    check(`${label}: every Edge Function full source-tree hash matches`,
      exactTrees.ok && fnTreeBad.length === 0,
      fnTreeBad.slice(0, 4).join(', ') || `${Object.keys(fnTrees).length} function trees`);

    /* 7b. _shared closure: a change here does not move any index.ts hash, so it
       is checked explicitly. */
    const shared = inner.edge_shared || {};
    const sharedBad = [];
    for (const [rel, h] of Object.entries(shared)) {
      const f = path.join(work, rel);
      if (!existsSync(f)) sharedBad.push(`${rel} MISSING`);
      else if (sha(f) !== h) sharedBad.push(`${rel} HASH`);
    }
    check(`${label}: every _shared Edge module hash matches (imported-shared tampering caught)`,
      sharedBad.length === 0, sharedBad.slice(0, 4).join(', ') || `${Object.keys(shared).length} shared modules`);

    const sharedTreeExpected = inner.edge_shared_tree_sha256;
    const sharedTreeActual = existsSync(path.join(work, 'supabase', 'functions', '_shared'))
      ? hashBuildDir(path.join(work, 'supabase', 'functions', '_shared')) : null;
    check(`${label}: imported _shared full source-tree hash matches`,
      typeof sharedTreeExpected === 'string' && sharedTreeExpected === sharedTreeActual,
      `${sharedTreeActual || 'MISSING'} vs ${sharedTreeExpected || 'MISSING'}`);

    let innerPublicSetOk = false;
    try {
      assertPublicFunctionSetSha256(inner.public_function_set_sha256, `${label} manifest public function-set hash`);
      innerPublicSetOk = exactTrees.ok
        && typeof sharedTreeExpected === 'string'
        && computePublicFunctionSetSha256(fnTrees, sharedTreeExpected) === inner.public_function_set_sha256;
    } catch { innerPublicSetOk = false; }
    check(`${label}: public/staff Edge Function set hash matches the complete signed source identity`,
      innerPublicSetOk, inner.public_function_set_sha256 || 'MISSING');

    /* 8. identity fields: inner vs the detached/set expectation */
    for (const field of ['release_identity', 'migration_fingerprint_sha256', 'run_id']) {
      if (expect[field] !== undefined && expect[field] !== null) {
        check(`${label}: ${field} matches between inner manifest and detached/set manifest`,
          inner[field] === expect[field], `${inner[field]} vs ${expect[field]}`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return extracted;
}

/**
 * Validate the receipts bundle inside the logs archive.
 * The expected stage list comes from the CODE-OWNED contract, never from the
 * release set — round 1 trusted `set.expected_stages`, so a release that
 * omitted a stage from both the run and its own list still verified.
 * `shippedBuild` is the dist hash extracted from the package: every build-bound
 * receipt must attest exactly that build, which is what proves the shipped
 * build is the tested build.
 */
function verifyReceipts(logsArchive, set, shippedBuild) {
  console.log(`\n── receipts: ${path.basename(logsArchive)} ──`);
  const report = inspectZipEntries(logsArchive);
  check('logs: no unsafe entries', report.problems.length === 0, report.problems.join('; ') || `${report.count} entries`);
  if (report.problems.length) return;

  const work = mkdtempSync(path.join(tmpdir(), 'mp-receipts-'));
  try {
    extractZip(logsArchive, work);
    const rdir = path.join(work, 'receipts');
    check('logs: a receipts/ directory is present', existsSync(rdir));
    if (!existsSync(rdir)) return;

    const receiptFiles = readdirSync(rdir).filter((f) => f.endsWith('.receipt.json'));
    const byStage = {};
    const duplicates = [];
    for (const rf of receiptFiles) {
      const r = JSON.parse(readFileSync(path.join(rdir, rf), 'utf8'));
      if (byStage[r.stage]) duplicates.push(r.stage);
      byStage[r.stage] = r;
    }
    check('logs: no stage is attested twice', duplicates.length === 0, duplicates.join(', ') || 'none');

    const profile = set.build_profile || 'development';
    const { missing, unknown } = diffStages(Object.keys(byStage), profile);
    check(`logs: every stage the RELEASE CONTRACT requires for a ${profile} build has a receipt`,
      missing.length === 0, missing.slice(0, 8).join(', ') || `${stagesForProfile(profile).length} contract stages`);
    check('logs: no receipt outside the contract (or production-only evidence in a development release)',
      unknown.length === 0, unknown.slice(0, 6).join(', ') || 'none');

    const bad = [];
    const cmdBad = [];
    for (const [stage, r] of Object.entries(byStage)) {
      if (r.run_id !== set.run_id) bad.push(`${stage}:run_id`);
      if (r.source_tree_sha256 !== set.source_tree_sha256) bad.push(`${stage}:source`);
      if (r.exit_code !== 0) bad.push(`${stage}:exit=${r.exit_code}`);
      /* The receipt's `log` is a NAME, not a path. Round 2 joined it onto the
         extraction directory unsanitised, so a receipt naming
         "../../etc/hosts" made the verifier authenticate a file on the
         verifying machine as a database test log. It must be exactly
         "<stage>.log", and the resolved path must stay inside the extraction. */
      const expectedLogName = `${stage}.log`;
      if (r.log !== expectedLogName) { bad.push(`${stage}:log-name`); continue; }
      const logf = path.resolve(work, expectedLogName);
      if (!logf.startsWith(path.resolve(work) + path.sep)) { bad.push(`${stage}:log-escape`); continue; }
      if (!existsSync(logf)) bad.push(`${stage}:log-missing`);
      else if (sha(logf) !== r.log_sha256) bad.push(`${stage}:log-hash`);
      const expected = commandFor(stage);
      if (expected !== undefined && r.command !== expected) cmdBad.push(`${stage}: "${r.command}" != "${expected}"`);
    }
    check('logs: every receipt carries the run id + source digest, exit 0, and a log matching its hash',
      bad.length === 0, bad.slice(0, 6).join(', ') || `${Object.keys(byStage).length} receipts consistent`);
    check('logs: every receipt ran the command the contract specifies for its stage',
      cmdBad.length === 0, cmdBad.slice(0, 4).join(' · ') || 'all commands match the contract');

    /* THE BINDING: tested build == shipped build. */
    const buildBad = [];
    /* only the build-bound stages this profile actually owes: production-build
       is required of a production release and must be absent from a development
       one (checked as `unknown` above). */
    const requiredBuildBound = BUILD_BOUND_STAGES.filter((b) => stagesForProfile(profile).includes(b));
    for (const stage of requiredBuildBound) {
      const r = byStage[stage];
      if (!r) { buildBad.push(`${stage}:absent`); continue; }
      if (!r.build_output_sha256) buildBad.push(`${stage}:no-build-hash`);
      else if (shippedBuild && r.build_output_sha256 !== shippedBuild) buildBad.push(`${stage}:tested-a-different-build`);
    }
    check('logs: every build-bound stage attests THE BUILD THIS PACKAGE SHIPS — the shipped build was browser-tested',
      buildBad.length === 0,
      buildBad.slice(0, 4).join(', ') || `${requiredBuildBound.length} build-bound stages attest ${String(shippedBuild).slice(0, 16)}…`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Signature: supported real schemes are externally authenticated; STUB is development self-consistency only; absence fails. */
function verifySignature(set, productionMode, setPath, packagePub, trust, selfConsistency) {
  console.log('\n── signature + build profile ──');
  const profile = set.build_profile || 'development';
  if (productionMode) {
    check('build profile is production', profile === 'production',
      profile === 'production' ? undefined : `build_profile=${profile} — this artefact was not built with build:production`);
  } else if (profile !== 'production') {
    console.log(`  WARN  build_profile is "${profile}" — NOT a deployable production build. `
      + 'Run with --production (or MP_VERIFY_PRODUCTION=1) to make this a failure.');
  } else {
    console.log('  PASS  build profile is production');
  }

  if (productionMode && !trust) {
    check('an external trust anchor was supplied (required for production verification)', false,
      'run with --trust <policy.json> or --trusted-key <file>; the release cannot vouch for itself');
  }
  const sig = set.signature;
  if (!sig || !sig.scheme) {
    check('release signature is present', false, 'no signature block — a release set must be signed (or explicitly STUB)');
    return;
  }

  if (sig.scheme === 'STUB') {
    /* STUB is rejected in production REGARDLESS of flags: a production build
       must be signed, full stop. */
    if (productionMode || (set.build_profile === 'production')) {
      check('release signature is a real cryptographic signature', false,
        'signature.scheme=STUB — a production release must be signed (ed25519-pinned or cosign-keyless)');
      return;
    }
    /* Outside production, a STUB is only acceptable when the caller explicitly
       asked for self-consistency, and it never counts as authentication. */
    if (!selfConsistency) {
      check('release is authenticated (or --self-consistency was explicitly requested)', false,
        'signature.scheme=STUB — authenticated verification is the default; pass --self-consistency to accept an unsigned set, or --trust <policy> to authenticate one');
      return;
    }
    console.log('  WARN  signature scheme is STUB — NOT cryptographically signed. '
      + 'Accepted only because --self-consistency was requested; this is NOT authentication.');
    check('STUB signature covers this run id', sig.run_id === set.run_id, `${sig.run_id} vs ${set.run_id}`);
    unauthenticated = true;
    return;
  }

  /* A real scheme is verified against an EXTERNAL trust anchor. */
  if (!REAL_SCHEMES.includes(sig.scheme)) {
    check(`release signature scheme "${sig.scheme}" is one this verifier can check`, false,
      `supported: ${REAL_SCHEMES.join(', ')}`);
    return;
  }
  if (!trust) {
    check('an external trust anchor was supplied for signature verification', false,
      'no --trust / --trusted-key / --trusted-identity given. A key carried inside the release cannot authenticate that release — supply the trusted key or identity from outside it.');
    return;
  }
  console.log(`  INFO  trust anchor: ${trust.source}${trust.keyId ? ` (key ${trust.keyId})` : ''}`);
  /* A demonstration key must not be able to sign a production release just
     because someone passed its policy. The restriction is enforced, not noted. */
  if (productionMode) {
    check('the trusted key is authorised for PRODUCTION use',
      trust.keyPurpose === 'production',
      trust.keyPurpose
        ? `trust policy declares key_purpose="${trust.keyPurpose}"`
        : 'trust policy does not declare key_purpose:"production" — refusing to accept it for a production release');
    if (trust.keyPurpose !== 'production') return;
  }

  if (sig.scheme === 'ed25519-pinned') {
    if (!trust.ed25519Pem && !trust.ed25519Fingerprint) {
      check('the trust policy supplies an ed25519 key for this scheme', false,
        'policy has no ed25519 public key or fingerprint');
      return;
    }
    /* If the package also carries a key, it must be the trusted one. A
       different key inside the package IS the forged-signer attack. */
    if (packagePub) {
      let pkgFp = null;
      try { pkgFp = keyFingerprint(packagePub); } catch { pkgFp = null; }
      const trustedFp = trust.ed25519Fingerprint
        || (trust.ed25519Pem ? keyFingerprint(trust.ed25519Pem) : null);
      check('the signing key inside the package is the externally trusted key',
        Boolean(pkgFp) && pkgFp === trustedFp,
        pkgFp ? `package ${String(pkgFp).slice(0, 16)}… vs trusted ${String(trustedFp).slice(0, 16)}…` : 'unreadable key in package');
      if (pkgFp !== trustedFp) return; // do not go on to "verify" an attacker's signature
    }
    if (!trust.ed25519Pem) {
      check('the trust policy supplies the full public key (a fingerprint alone cannot verify)', false,
        'provide ed25519_public_key_pem or ed25519_public_key_file');
      return;
    }
    const r = verifyEd25519(set, trust.ed25519Pem);
    check('release signature verifies against the EXTERNALLY TRUSTED key', r.ok, r.detail);
    check('signature run id matches the release set', sig.run_id === set.run_id,
      `${sig.run_id} vs ${set.run_id}`);
    return;
  }
  const r = verifyCosign(set, setPath, trust);
  check('release signature verifies through cosign against the trusted identity', r.ok, r.detail);
}

/** A key shipped inside the package (ed25519-pinned) must be the externally
 *  trusted one. A different in-package key IS the forged-signer attack, even
 *  when the JSON signature already verified against the trusted key. */
function verifyInPackageKey(set, packagePub, trust) {
  const sig = set.signature || {};
  if (sig.scheme !== 'ed25519-pinned' || !packagePub || !trust) return;
  let pkgFp = null;
  try { pkgFp = keyFingerprint(packagePub); } catch { pkgFp = null; }
  const trustedFp = trust.ed25519Fingerprint
    || (trust.ed25519Pem ? keyFingerprint(trust.ed25519Pem) : null);
  check('the signing key inside the package is the externally trusted key',
    Boolean(pkgFp) && pkgFp === trustedFp,
    pkgFp ? `package ${String(pkgFp).slice(0, 16)}… vs trusted ${String(trustedFp).slice(0, 16)}…` : 'unreadable key in package');
}

/**
 * Bind the release to the ACTUAL production systems it is authorised for.
 * A signature proves authorship; these checks prove the artefact is the right
 * release, for the right site, against the right backend, and not older than
 * what is already deployed. The approved values come from the external trust
 * policy — never from the release.
 */
function verifyProductionBinding(set, inner, trust) {
  console.log('\n── production binding ──');
  if (!trust) {
    check('an external trust policy supplies the approved production configuration', false,
      'no --trust policy given; cannot confirm the approved domain, Supabase project or release number');
    return;
  }
  const val = (k) => (inner && inner[k] !== undefined && inner[k] !== null ? inner[k] : set[k]);

  if (trust.approvedSiteDomain) {
    check('release targets the approved website domain',
      val('site_domain') === trust.approvedSiteDomain,
      `release ${val('site_domain')} vs approved ${trust.approvedSiteDomain}`);
  } else {
    check('the trust policy declares an approved site domain', false, 'approved_site_domain missing from policy');
  }

  if (trust.approvedSupabaseRef) {
    check('release targets the approved Supabase project',
      val('supabase_project_ref') === trust.approvedSupabaseRef,
      `release ${val('supabase_project_ref')} vs approved ${trust.approvedSupabaseRef}`);
  } else {
    check('the trust policy declares an approved Supabase project', false, 'approved_supabase_project_ref missing from policy');
  }

  const rn = val('release_number');
  check('release carries a release number', Number.isInteger(rn), String(rn));
  if (Number.isInteger(rn) && Number.isInteger(trust.minimumReleaseNumber)) {
    /* Anti-rollback: refuse a correctly signed but OLDER release. */
    check('release number is not older than the last deployed release',
      rn >= trust.minimumReleaseNumber,
      `release ${rn} vs last deployed ${trust.minimumReleaseNumber}`);
  }

  check('release records the git commit it was built from',
    typeof val('git_commit') === 'string' && val('git_commit').length >= 7,
    String(val('git_commit')));
  if (val('git_tree_clean') !== null && val('git_tree_clean') !== undefined) {
    check('release was built from a clean git tree', val('git_tree_clean') === true,
      val('git_tree_clean') === true ? undefined : 'working tree had uncommitted changes at build time');
  }
}

/** In production mode the shipped build must not be a development build. */
function verifyProductionBuildEvidence(seoManifest) {
  if (!seoManifest) {
    check('the shipped build carries dist/seo-manifest.json', false, 'absent — cannot confirm production output');
    return;
  }
  check('the shipped build was not produced with development defaults',
    seoManifest.source !== 'development-defaults', `seo-manifest source=${seoManifest.source}`);
  check('the shipped build has commercial output enabled',
    seoManifest.commercialOutputSuppressed !== true, 'seo-manifest reports commercialOutputSuppressed=true');
}

/* ---- entry point -------------------------------------------------------- */
const args = process.argv.slice(2);
const SET_MODE = args[0] === '--set';
/* PRODUCTION IS THE DEFAULT. Previously `npm run verify:set` ran without
   --production, so a development build exited 0 and printed PROVENANCE
   VERIFIED — a deploy script checking only the exit code would accept a
   non-deployable artefact. Development verification is now an explicit
   diagnostic mode with its own verdict. */
const ALLOW_DEV = args.includes('--allow-development');
const PRODUCTION = !ALLOW_DEV;
/* Authenticated verification is the DEFAULT. Accepting a STUB (self-consistent
   but unsigned) set requires an explicit --self-consistency flag, and even then
   the result is never reported as full provenance. */
const SELF_CONSISTENCY = args.includes('--self-consistency');
let TRUST = null;
try { TRUST = loadTrustPolicy(args, process.env); } catch (e) {
  console.error(`trust policy could not be loaded: ${e.message}`); process.exit(2);
}
if (args[0] === '--set') {
  const setPath = args[1];
  if (!setPath || !existsSync(setPath)) { console.error('usage: --set <release-set.json>'); process.exit(2); }
  const set = JSON.parse(readFileSync(setPath, 'utf8'));
  if (set.kind !== 'milkpop-release-set') { console.error('not a milkpop-release-set manifest'); process.exit(2); }
  /* Schema is now actually validated: an unknown future schema must not be
     interpreted under today's rules. */
  const SUPPORTED_SCHEMA = 2;
  if (set.schema !== SUPPORTED_SCHEMA) {
    console.error(`unsupported release-set schema ${set.schema} — this verifier understands schema ${SUPPORTED_SCHEMA}`);
    process.exit(2);
  }
  const dir = path.dirname(setPath);
  console.log(`RELEASE SET — ${set.release_identity} (run ${set.run_id})`);

  /* AUTHENTICATE THE SET BEFORE OPENING ANY ARCHIVE. The set records every
     archive's sha256 and size, and (for a real signature) that record is
     signed. Verifying the signature over release-set.json first means a
     forged or unauthenticated set is rejected before a single ZIP is inspected
     or extracted — an unauthenticated zip bomb cannot consume resources.
     ed25519 needs only the JSON and the external key, so it runs here; cosign
     likewise verifies the JSON blob. The package's build hash and any in-package
     key are cross-checked later, after the (now-authenticated) archive hashes
     have been confirmed. */
  {
    // pass packagePub=null here: the trust anchor is external by construction,
    // and any in-package key is compared against it after extraction.
    verifySignature(set, PRODUCTION, setPath, null, TRUST, SELF_CONSISTENCY);
    if (failed !== 0) {
      console.log('');
      console.log(`PROVENANCE FAILED — ${failed} mismatch(es) authenticating the release set (before extraction)`);
      process.exit(1);
    }
  }

  /* An archive NAME is a filename, not a path: the set must not be able to
     point the verifier at files elsewhere on the machine (the same class as the
     receipt-log traversal). */
  check('set: records the exact Edge Function count',
    set.edge_function_count === EDGE_FUNCTIONS.length,
    `${set.edge_function_count} vs ${EDGE_FUNCTIONS.length}`);
  const setInventory = exactInventoryOk(set.edge_function_inventory, 'signed release-set Edge Function inventory');
  check('set: enumerates the complete code-owned Edge Function inventory',
    setInventory.ok, setInventory.detail);
  const setTrees = exactHashMapOk(set.edge_function_trees, 'signed release-set Edge Function tree hashes');
  check('set: carries exactly one signed full-tree hash for every Edge Function',
    setTrees.ok, setTrees.detail);
  let setPublicHashOk = false;
  try {
    assertPublicFunctionSetSha256(set.public_function_set_sha256, 'signed release-set public function-set hash');
    setPublicHashOk = setTrees.ok
      && typeof set.edge_shared_tree_sha256 === 'string'
      && computePublicFunctionSetSha256(set.edge_function_trees, set.edge_shared_tree_sha256) === set.public_function_set_sha256;
  } catch { setPublicHashOk = false; }
  check('set: public/staff function-set hash matches the signed Edge source identity',
    setPublicHashOk, set.public_function_set_sha256 || 'MISSING');

  const safeName = (n) => typeof n === 'string' && n.length > 0
    && !n.includes('/') && !n.includes('\\') && n !== '.' && n !== '..';
  const resolveArchive = (name, label) => {
    if (!safeName(name)) { check(`${label}: archive name is a plain filename inside the release directory`, false, String(name)); return null; }
    const p = path.resolve(dir, name);
    if (!p.startsWith(path.resolve(dir) + path.sep)) { check(`${label}: archive path stays inside the release directory`, false, name); return null; }
    return p;
  };

  const pkg = set.archives?.package;
  let shippedBuild = null;
  let extractedPub = null;
  let extractedSeo = null;
  let extractedInner = null;
  let extractedMarker = null;
  if (!pkg) { check('release set names a package archive', false); }
  else {
    const pkgPath = resolveArchive(pkg.name, 'package');
    const got = pkgPath === null ? null : verifyArchiveContents(pkgPath, {
      archive_sha256: pkg.sha256, archive_bytes: pkg.bytes,
      source_tree_sha256: set.source_tree_sha256, build_output_sha256: set.build_output_sha256,
      release_identity: set.release_identity, run_id: set.run_id,
      migration_fingerprint_sha256: set.migration_fingerprint_sha256,
      migration_count: set.migration_count,
    }, 'package');
    shippedBuild = got?.build ?? null;
    extractedPub = got?.pub ?? null;
    extractedSeo = got?.seo ?? null;
    extractedInner = got?.inner ?? null;
    extractedMarker = got?.marker ?? null;

    /* EVERY identity field the set asserts is compared with the manifest inside
       the archive. Round 1 compared three and left migration_count and the
       fingerprint unchecked, so a set could claim migration_count:0 and verify. */
    const inner = got?.inner;
    if (inner) {
      const fields = ['release_identity', 'release_version', 'run_id', 'source_tree_sha256',
        'build_output_sha256', 'migration_count', 'migration_fingerprint_sha256', 'build_profile',
        'release_number', 'git_commit', 'site_domain', 'supabase_project_ref', 'edge_function_count',
        'public_function_set_sha256'];
      const mism = fields.filter((k) => set[k] !== undefined && set[k] !== null && set[k] !== inner[k]);
      check('set: every identity field matches the manifest inside the archive',
        mism.length === 0,
        mism.map((k) => `${k}: ${set[k]} vs ${inner[k]}`).slice(0, 4).join(' · ') || `${fields.length} fields agree`);
      const setFnInventory = JSON.stringify(set.edge_function_inventory || []);
      const innerFnInventory = JSON.stringify(inner.edge_function_inventory || []);
      const setFnTrees = JSON.stringify(Object.entries(set.edge_function_trees || {}).sort());
      const innerFnTrees = JSON.stringify(Object.entries(inner.edge_function_trees || {}).sort());
      check('set: Edge Function inventory and source-tree identity match the manifest inside the archive',
        setFnInventory === innerFnInventory
          && setFnTrees === innerFnTrees
          && set.edge_shared_tree_sha256 === inner.edge_shared_tree_sha256
          && set.public_function_set_sha256 === inner.public_function_set_sha256,
        setFnInventory !== innerFnInventory ? 'function inventory differs'
          : setFnTrees !== innerFnTrees ? 'function source-tree hashes differ'
            : set.edge_shared_tree_sha256 !== inner.edge_shared_tree_sha256 ? 'shared source-tree hash differs'
              : 'public function-set hash differs');
    }
  }

  for (const key of ['evidence', 'logs']) {
    const a = set.archives?.[key];
    if (!a) { check(`release set names the ${key} archive`, false); continue; }
    const p = resolveArchive(a.name, key);
    if (p === null) continue;
    check(`${key}: archive exists`, existsSync(p), existsSync(p) ? undefined : a.name);
    if (existsSync(p)) {
      check(`${key}: archive byte hash matches`, sha(p) === a.sha256, shortpair(sha(p), a.sha256));
      check(`${key}: archive byte size matches`, statSync(p).size === a.bytes, `${statSync(p).size} vs ${a.bytes}`);
      /* EVERY archive gets the same structural inspection — the evidence ZIP
         used to receive only a hash+size check, so an evidence archive
         containing ../outside.txt passed. */
      const er = inspectZipEntries(p);
      check(`${key}: no unsafe entries (traversal / symlink / duplicate / case-collision)`,
        er.problems.length === 0, er.problems.slice(0, 3).join('; ') || `${er.count} entries clean`);
    }
  }

  const logs = set.archives?.logs;
  const logsPath = logs ? resolveArchive(logs.name, 'logs') : null;
  if (logsPath && existsSync(logsPath)) verifyReceipts(logsPath, set, shippedBuild);
  if (PRODUCTION) {
    verifyProductionBuildEvidence(extractedSeo);
    verifyProductionBinding(set, extractedInner, TRUST);
    /* The marker the deployed site will serve must already agree with the
       signed release, so the post-deploy fetch is a real comparison. */
    check('the shipped build carries /.well-known/milkpop-release.json',
      Boolean(extractedMarker), extractedMarker ? undefined : 'marker missing from dist');
    if (extractedMarker) {
      const mm = [];
      if (extractedMarker.release_identity !== (set.release_identity ?? null)) mm.push('release_identity');
      if (extractedMarker.release_number !== (set.release_number ?? null)) mm.push('release_number');
      if (extractedMarker.git_commit !== (set.git_commit ?? null)) mm.push('git_commit');
      if (extractedMarker.build_output_sha256 !== shippedBuild) mm.push('build_output_sha256');
      if (extractedMarker.public_function_set_sha256 !== (set.public_function_set_sha256 ?? null)) mm.push('public_function_set_sha256');
      if (extractedMarker.build_profile !== 'production') mm.push('build_profile');
      if (extractedMarker.site_domain !== (set.site_domain ?? null)) mm.push('site_domain');
      check('the live release marker agrees with the signed release set',
        mm.length === 0, mm.join(', ') || 'identity, release number, commit, frontend/backend hashes, profile and domain all agree');
    }
  }
  /* Signature was already authenticated over the JSON before extraction. Here we
     only (a) cross-check that a key shipped INSIDE the package, if any, is the
     externally trusted one, and (b) settle the unauthenticated verdict for a
     self-consistency (STUB) run. */
  verifyInPackageKey(set, extractedPub, TRUST);
} else {
  const [archive, manifestPath] = args;
  if (!archive || !manifestPath) {
    console.error('usage: verify-archive-manifest.mjs <archive.zip> <manifest.json>  |  --set <release-set.json>');
    process.exit(2);
  }
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  console.log(`ARCHIVE PROVENANCE — ${m.archive_name} (${m.release_identity})`);
  verifyArchiveContents(archive, {
    archive_sha256: m.archive_sha256, archive_bytes: m.archive_bytes,
    source_tree_sha256: m.source_tree_sha256, build_output_sha256: m.build_output_sha256,
    release_identity: m.release_identity, run_id: m.run_id,
  }, 'archive');
  if (m.companion_archive_name) {
    const comp = path.join(path.dirname(archive), m.companion_archive_name);
    check('companion archive exists', existsSync(comp), existsSync(comp) ? undefined : m.companion_archive_name);
    if (existsSync(comp)) {
      check('companion archive byte hash matches', sha(comp) === m.companion_archive_sha256,
        shortpair(sha(comp), m.companion_archive_sha256));
    }
  }
}

console.log('');
if (failed !== 0) {
  console.log(`PROVENANCE FAILED — ${failed} mismatch(es)`);
  process.exit(1);
}
if (SET_MODE) {
  if (ALLOW_DEV) {
    console.log('DEVELOPMENT BUILD CHECKED — NOT A PRODUCTION RELEASE, DO NOT DEPLOY.');
    console.log('  Ran in --allow-development diagnostic mode; production rules were not enforced.');
  } else if (unauthenticated) {
    console.log('RELEASE SET SELF-CONSISTENCY VERIFIED — NOT AUTHENTICATED.');
    console.log('  The set is internally consistent but carries no real signature.');
    console.log('  Authenticated acceptance requires a real signature + --trust <policy.json>.');
  } else {
    console.log('PROVENANCE VERIFIED');
  }
} else {
  /* The single-archive mode checks an archive's CONTENTS only: no receipts, no
     evidence or logs archives, no signature, no build profile. Printing
     "PROVENANCE VERIFIED" here overstated what was checked. */
  console.log('ARCHIVE CONTENT VERIFIED — content-only, NOT release acceptance.');
  console.log('  No receipts, evidence, signature or build profile were checked.');
  console.log('  Release acceptance requires: --set <release-set.json> --production --trust <policy.json>');
}
process.exit(0);
