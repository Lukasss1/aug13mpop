#!/usr/bin/env node
/* ============================================================================
 *  MILK POP — machine-readable release manifest (R4.8, Workstream J5)
 *  Emits release-manifest.json binding this source tree: file/migration
 *  manifests + hashes, Edge Function hashes, feature-gate defaults, tool
 *  versions. Build-output hash + archive hash are appended by the packaging
 *  step (they do not exist until then) — absent fields are null, not faked.
 * ========================================================================== */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
/* P0-4: the source and build digests come from the ONE canonical hasher, the
 * same module verify-release.sh, the archive writer and the verifier use, so
 * "the tested tree" is a single definition rather than three near-copies. */
import { hashSourceTree, hashBuildDir, countSourceFiles } from './lib/release-hash.mjs';
import {
  EDGE_FUNCTIONS,
  assertExactEdgeFunctionInventory,
  assertExactEdgeFunctionHashMap,
  computePublicFunctionSetSha256,
} from './lib/edge-function-inventory.mjs';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const walk = (dir, out = []) => { for (const e of readdirSync(dir)) { const f = path.join(dir, e); const st = statSync(f);
  if (st.isDirectory()) { if (!/node_modules|^\.git$|dist/.test(e)) walk(f, out); } else out.push(f); } return out; };
const manifestSh = readFileSync('launch/migration-manifest.sh', 'utf8');
const migrations = [...manifestSh.matchAll(/"(supabase\/[^"]+\.sql)"/g)].map((m) => m[1]);
const migrationHashes = Object.fromEntries(migrations.filter(existsSync).map((m) => [m, sha(m)]));
const fingerprint = createHash('sha256').update(migrations.map((m) => `${m}:${migrationHashes[m] || 'MISSING'}`).join('\n')).digest('hex');
const fnDirs = readdirSync('supabase/functions')
  .filter((d) => d !== '_shared' && statSync(`supabase/functions/${d}`).isDirectory())
  .sort();
assertExactEdgeFunctionInventory(fnDirs, 'supabase/functions directories');
for (const name of EDGE_FUNCTIONS) {
  if (!existsSync(`supabase/functions/${name}/index.ts`)) {
    throw new Error(`Edge Function ${name} is missing index.ts`);
  }
}
const fnHashes = Object.fromEntries(EDGE_FUNCTIONS.map((d) => [d, sha(`supabase/functions/${d}/index.ts`)]));
const fnTreeHashes = Object.fromEntries(EDGE_FUNCTIONS.map((d) => [d, hashBuildDir(`supabase/functions/${d}`)]));
assertExactEdgeFunctionHashMap(fnHashes, 'generated Edge Function entry hashes');
assertExactEdgeFunctionHashMap(fnTreeHashes, 'generated Edge Function tree hashes');
/* P0-4: a change to an imported _shared module does NOT change the importing
 * index.ts's hash, so index hashes alone cannot detect it. Hash every file in
 * the _shared closure explicitly; the verifier checks these too. */
const sharedDir = 'supabase/functions/_shared';
const edgeShared = existsSync(sharedDir)
  ? Object.fromEntries(walk(sharedDir).sort().map((f) => [path.relative('.', f).split(path.sep).join('/'), sha(f)]))
  : {};
const edgeSharedTreeSha = existsSync(sharedDir) ? hashBuildDir(sharedDir) : null;
const publicFunctionSetSha = computePublicFunctionSetSha256(fnTreeHashes, edgeSharedTreeSha);
const flags = readFileSync('src/lib/featureFlags.ts', 'utf8');
/* AUDIT #8 (provenance): a deterministic digest of the SOURCE CONTENT itself —
 * sha256 over sorted "path:filehash" lines for every tracked source file
 * (dist/, node_modules/ and .git/ are excluded by `walk`). Archive hashes vary
 * with compression and timestamps; this does not. It is what lets an auditor
 * extract the shipped zip and confirm the tree is the tree that was tested,
 * independently of how it was packed. Reproduce with:
 *   node scripts/verify-archive-manifest.mjs <archive> <archive>.manifest.json */
/* release-manifest.json is EXCLUDED from its own digest. It records the value,
 * so it cannot be inside it — writing the file would change the answer, and a
 * re-extracted tree would never reproduce it. Exactly the same self-reference
 * as "a file cannot carry the hash of the archive that contains it", one level
 * down. The inner manifest stays cryptographically bound anyway: the detached
 * archive manifest records its sha256 separately. */
/* Generated release-verification output is excluded by the canonical source
 * collector. Ordinary source files are not excluded merely because of their
 * extension; the digest describes exactly the canonical source content that
 * the archive writer and independent verifier also count. */
const sourceTreeSha = hashSourceTree('.');
/* R4.10 (third audit, blocker 12): the manifest must carry a TRUE identity
 * and hashes, and must reference result files that actually exist.
 *  - release_identity names the increment (MP_RELEASE_IDENTITY, e.g.
 *    "r4.10-inc10"); release_version stays the platform version.
 *  - build_output_sha256 is computed here whenever dist/ exists: a sha256
 *    over the sorted (path, file-sha) lines of the build output, so two
 *    builds agree iff their files agree.
 *  - output_archive_sha256 stays null IN-TREE because a file cannot contain
 *    its own archive's hash; the packaging step writes it into the detached
 *    <archive>.manifest.json alongside the zip. The note says so instead of
 *    leaving an unexplained null.
 *  - commit_sha carries an explicit reason when absent, never a bare null. */
const buildDir = process.env.MP_RELEASE_BUILD_DIR || 'dist';
const distHash = existsSync(buildDir) ? hashBuildDir(buildDir) : null;
const resultDir = 'artifacts/release-verification';
const resultFiles = existsSync(resultDir)
  ? readdirSync(resultDir).filter((f) => /\.(log|txt)$/.test(f)).sort()
      .map((f) => ({ file: `${resultDir}/${f}`, sha256: sha(`${resultDir}/${f}`) }))
  : [];
const manifest = {
  release_identity: process.env.MP_RELEASE_IDENTITY || null,
  release_version: JSON.parse(readFileSync('package.json', 'utf8')).version,
  /* P0-4: one release run ties the manifest, the receipts and the archives
   * together. release-seal sets it; the verifier requires every receipt and
   * every detached manifest to carry the same value. */
  run_id: process.env.MP_RUN_ID || null,
  /* Which build produced the dist in this release: only "production" (from
     npm run build:production) is deployable. Stamped, never inferred. */
  build_profile: process.env.MP_BUILD_PROFILE || 'development',

  /* ---- PRODUCTION BINDING (P0-4, small-business scope) -------------------
     A signature proves who signed some bytes. These fields make the release
     say WHICH release it is and WHERE it is allowed to run, so verification
     can refuse a correctly-signed artefact that points at the wrong backend,
     came from the wrong commit, or is older than what is already live. */
  release_number: process.env.MP_RELEASE_NUMBER
    ? Number(process.env.MP_RELEASE_NUMBER) : null,
  git_commit: (() => {
    try {
      return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch { return null; }
  })(),
  git_tree_clean: (() => {
    try {
      return execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === '';
    } catch { return null; }
  })(),
  site_domain: process.env.MP_SITE_DOMAIN || null,
  supabase_project_ref: process.env.MP_SUPABASE_PROJECT_REF || null,
  generated_at: new Date().toISOString(),
  source_archive_sha256: process.env.MP_SOURCE_ARCHIVE_SHA || null,
  output_archive_sha256: null,
  output_archive_note: 'A file cannot carry the hash of the archive that contains it; the packaging step writes this into the detached <archive>.manifest.json shipped NEXT TO the zip.',
  build_output_sha256: distHash,
  commit_sha: (() => { try { return execSync('git rev-parse HEAD 2>/dev/null').toString().trim(); } catch { return null; } })(),
  commit_sha_note: (() => { try { execSync('git rev-parse HEAD 2>/dev/null'); return null; } catch { return 'no git repository in the build environment — provenance is the source_archive_sha256 of the increment archive instead'; } })(),
  package_lock_sha256: sha('package-lock.json'),
  source_tree_sha256: sourceTreeSha,
  source_tree_note: 'Deterministic sha256 over sorted path:filehash lines for every source file in this tree (dist, node_modules and .git excluded). Recompute it from an extracted archive to prove the archive carries the tested source.',
  node_version: process.version,
  // Canonical count of the files covered by source_tree_sha256.
  // Generated artifacts and release-manifest.json itself are excluded.
  file_count: countSourceFiles('.'),
  // R4.9: `migrations` is every .sql entry named in the manifest, which
  // includes the two FRESH-ONLY files. Reporting that as `migration_count`
  // overstated the chain by two, so the three quantities are now separate.
  migration_count: migrations.filter((m) => /\/migration_/.test(m)).length,
  fresh_only_sql_count: migrations.filter((m) => !/\/migration_/.test(m)).length,
  sql_ledger_entry_count: migrations.length,
  migration_fingerprint_sha256: fingerprint,
  /* The ORDER matters to the fingerprint, and a map does not preserve it in a
   * way the verifier can rely on, so the ordered ledger is recorded explicitly.
   * The verifier recomputes the fingerprint from this against the archive. */
  _migration_order: migrations,
  migrations: migrationHashes,
  edge_function_count: EDGE_FUNCTIONS.length,
  edge_function_inventory: EDGE_FUNCTIONS,
  edge_functions: fnHashes,
  edge_function_trees: fnTreeHashes,
  edge_shared: edgeShared,
  edge_shared_tree_sha256: edgeSharedTreeSha,
  public_function_set_sha256: publicFunctionSetSha,
  pos_schema_version: (() => { for (const c of ['SYNC-CONTRACT.md', 'docs/SYNC-CONTRACT.md', 'supabase/functions/_shared/SYNC-CONTRACT.md']) {
    if (existsSync(c)) return (readFileSync(c, 'utf8').match(/version[:\s]+([0-9.]+)/i) || [undefined, null])[1]; } return null; })(),
  min_native_app_version: null,
  feature_gate_defaults: {
    CAREERS_CV_UPLOAD: /CAREERS_CV_UPLOAD = String\(import\.meta\.env\.VITE_CAREERS_CV_UPLOAD \|\| ''\)\.trim\(\) === 'true'/.test(flags) ? 'off-by-default' : 'CHECK-MANUALLY',
  },
  /* Result files are LISTED WITH HASHES and only if they exist — the R4.8
   * manifest referenced two JSON files nothing produced, which the external
   * audit rightly called out. Run `npm run verify:release` first; its
   * artifacts/release-verification/ output is what gets recorded here. */
  test_result_files: resultFiles,
};
const manifestOutput = process.env.MP_RELEASE_MANIFEST_OUTPUT || 'release-manifest.json';
writeFileSync(manifestOutput, JSON.stringify(manifest, null, 2));
console.log(`${manifestOutput} written (fingerprint ${fingerprint.slice(0, 16)}…, ${migrations.length} migrations, ${Object.keys(fnHashes).length} functions)`);
