#!/usr/bin/env node
/**
 * ============================================================================
 *  RELEASE-SET MANIFEST  (P0-4)  —  generated FROM receipts, fail-closed
 * ============================================================================
 *
 *  The authoritative descriptor of a sealed release: it names the three
 *  archives with their hashes, records the run id and the tested source/build
 *  digests, lists the stages that produced passing receipts, and carries the
 *  signature block. The verifier consumes THIS.
 *
 *  It is generated FROM the receipts, not from a trusted summary: this writer
 *  reads every stage receipt, refuses unless each carries the run id and the
 *  manifest's source digest and exited 0, and refuses unless a required core of
 *  stages is present. A release whose receipts do not add up cannot be sealed.
 *
 *  Signature is STUBBED here (scheme "STUB") by design. The protected
 *  release-seal path replaces this block with the pinned Ed25519 signature
 *  before production verification. The verifier treats STUB as development
 *  self-consistency only and production verification fails closed on it.
 *
 *  Usage:
 *    node scripts/write-release-set.mjs <identity> <run_id> <out_dir> <pkg.zip> <evidence.zip> <logs.zip>
 * ============================================================================
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { BUILD_BOUND_STAGES, commandFor, diffStages, stagesForProfile } from './lib/release-contract.mjs';
import {
  EDGE_FUNCTIONS,
  assertExactEdgeFunctionInventory,
  assertExactEdgeFunctionHashMap,
  assertPublicFunctionSetSha256,
  computePublicFunctionSetSha256,
} from './lib/edge-function-inventory.mjs';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const die = (m) => { console.error(`write-release-set: ${m}`); process.exit(1); };

const [, , identity, runId, outDir, pkg, evid, logs] = process.argv;
if (!identity || !runId || !outDir || !pkg || !evid || !logs) {
  die('usage: write-release-set.mjs <identity> <run_id> <out_dir> <pkg.zip> <evidence.zip> <logs.zip>');
}
for (const a of [pkg, evid, logs]) if (!existsSync(a)) die(`archive missing: ${a}`);

const manifest = JSON.parse(readFileSync('release-manifest.json', 'utf8'));
if (manifest.run_id !== runId) die(`release-manifest run_id ${manifest.run_id} != ${runId}`);
try {
  if (manifest.edge_function_count !== EDGE_FUNCTIONS.length) {
    throw new Error(`edge_function_count ${manifest.edge_function_count} != ${EDGE_FUNCTIONS.length}`);
  }
  assertExactEdgeFunctionInventory(manifest.edge_function_inventory, 'release manifest Edge Function inventory');
  assertExactEdgeFunctionHashMap(manifest.edge_functions, 'release manifest Edge Function entry hashes');
  assertExactEdgeFunctionHashMap(manifest.edge_function_trees, 'release manifest Edge Function tree hashes');
  assertPublicFunctionSetSha256(manifest.public_function_set_sha256, 'release manifest public function-set hash');
  const calculatedPublicSet = computePublicFunctionSetSha256(manifest.edge_function_trees, manifest.edge_shared_tree_sha256);
  if (calculatedPublicSet !== manifest.public_function_set_sha256) {
    throw new Error('release manifest public function-set hash does not match its Edge source-tree identity');
  }
} catch (error) {
  die(error.message);
}

/* Validate receipts. The set is only as trustworthy as the receipts it is
 * generated from, so every one is checked here. */
const rdir = 'artifacts/release-verification/receipts';
if (!existsSync(rdir)) die('no receipts directory — run verify-release first');
const receipts = readdirSync(rdir).filter((f) => f.endsWith('.receipt.json'))
  .map((f) => JSON.parse(readFileSync(path.join(rdir, f), 'utf8')));
if (!receipts.length) die('no receipts found');

const buildProfile = process.env.MP_BUILD_PROFILE || manifest.build_profile || 'development';
const stages = [];
const seenStage = new Set();
for (const r of receipts) {
  /* P0-4 round 2: a receipt now has to prove FIVE things, not three. */
  if (seenStage.has(r.stage)) die(`duplicate receipt for stage ${r.stage} — a stage may be attested exactly once`);
  seenStage.add(r.stage);
  if (r.run_id !== runId) die(`receipt ${r.stage} has run_id ${r.run_id}, expected ${runId}`);
  if (r.source_tree_sha256 !== manifest.source_tree_sha256) die(`receipt ${r.stage} source digest disagrees with the manifest`);
  if (r.exit_code !== 0) die(`receipt ${r.stage} did not pass (exit ${r.exit_code})`);
  /* the command is CHECKED against the code-owned contract, not merely recorded:
     a receipt claiming "command":"true" used to satisfy every other field. */
  const expectedCmd = commandFor(r.stage);
  if (expectedCmd === undefined) die(`receipt ${r.stage} is not a contract stage`);
  if (r.command !== expectedCmd) {
    die(`receipt ${r.stage} ran "${r.command}" but the contract requires "${expectedCmd}"`);
  }
  /* build-bound stages must attest the build they exercised, and it must be
     the build this release ships — this is the tested==shipped binding. */
  if (BUILD_BOUND_STAGES.includes(r.stage) && stagesForProfile(buildProfile).includes(r.stage)) {
    if (!r.build_output_sha256) die(`receipt ${r.stage} is build-bound but records no build_output_sha256`);
    if (r.build_output_sha256 !== manifest.build_output_sha256) {
      die(`receipt ${r.stage} attests build ${r.build_output_sha256} but the manifest ships ${manifest.build_output_sha256}`);
    }
  }
  stages.push(r.stage);
}
stages.sort();

/* The COMPLETE contract stage set is required — not a "core". Round 1 required
   13 of them, so a release could omit real stages and still seal. */
const { missing, unknown } = diffStages(stages, process.env.MP_BUILD_PROFILE || 'development');
if (missing.length) die(`stages required by the release contract have no passing receipt: ${missing.join(', ')}`);
if (unknown.length) die(`receipts present for stages outside the release contract: ${unknown.join(', ')}`);

const arc = (p) => ({ name: path.basename(p), sha256: sha(p), bytes: statSync(p).size });

const set = {
  kind: 'milkpop-release-set',
  schema: 2,
  release_identity: identity,
  release_version: manifest.release_version,
  run_id: runId,
  generated_at: new Date().toISOString(),
  source_tree_sha256: manifest.source_tree_sha256,
  build_output_sha256: manifest.build_output_sha256,
  migration_count: manifest.migration_count,
  migration_fingerprint_sha256: manifest.migration_fingerprint_sha256,
  edge_function_count: EDGE_FUNCTIONS.length,
  edge_function_inventory: EDGE_FUNCTIONS,
  edge_function_trees: manifest.edge_function_trees,
  edge_shared_tree_sha256: manifest.edge_shared_tree_sha256,
  public_function_set_sha256: manifest.public_function_set_sha256,
  build_profile: buildProfile,
  /* production binding — copied from the manifest so the signature covers them */
  release_number: manifest.release_number ?? null,
  git_commit: manifest.git_commit ?? null,
  git_tree_clean: manifest.git_tree_clean ?? null,
  site_domain: manifest.site_domain ?? null,
  supabase_project_ref: manifest.supabase_project_ref ?? null,
  contract_stages: stagesForProfile(buildProfile),
  archives: { package: arc(pkg), evidence: arc(evid), logs: arc(logs) },
  signature: {
    scheme: 'STUB',
    run_id: runId,
    note: 'Unsigned intermediate. The protected release-seal path must replace this STUB with the pinned Ed25519 signature before production verification.',
  },
};

const out = path.join(outDir, 'release-set.json');
writeFileSync(out, `${JSON.stringify(set, null, 2)}\n`);
console.log(`${out} written from ${receipts.length} validated receipts (all ${stagesForProfile(buildProfile).length} contract stages for a ${buildProfile} build, commands verified, ${BUILD_BOUND_STAGES.filter((b) => stages.includes(b)).length} build-bound)`);
console.log(`  package  ${set.archives.package.sha256.slice(0, 16)}…`);
console.log(`  evidence ${set.archives.evidence.sha256.slice(0, 16)}…`);
console.log(`  logs     ${set.archives.logs.sha256.slice(0, 16)}…`);
console.log('  signature: STUB — protected release-seal must apply the pinned Ed25519 signature before production verification');
