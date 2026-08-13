#!/usr/bin/env node
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { EDGE_FUNCTIONS, PUBLIC_FUNCTIONS, computePublicFunctionSetSha256 } from './lib/edge-function-inventory.mjs';

const functionNames = PUBLIC_FUNCTIONS;
const sharedFunctionHash = 'd'.repeat(64);
const functionTreeHashes = Object.fromEntries(EDGE_FUNCTIONS.map((name, index) =>
  [name, String(index + 1).padStart(64, '0')]));
const publicFunctionSetSha = computePublicFunctionSetSha256(functionTreeHashes, sharedFunctionHash);
const functionDeployLog = () => {
  const rows = functionNames.map(([name, mode]) =>
    `FUNCTION_DEPLOYED name=${name} sha256=${functionTreeHashes[name]} shared_sha256=${sharedFunctionHash} verify_jwt=${mode}`);
  return [`FUNCTION_SHARED_SOURCE sha256=${sharedFunctionHash}`,
    `PUBLIC_FUNCTION_SET_SOURCE sha256=${publicFunctionSetSha}`,
    ...rows,
    `FUNCTION_DEPLOY_PASS count=14 public_function_set_sha256=${publicFunctionSetSha} pos_deferred=3`].join('\n') + '\n';
};

const dir = mkdtempSync(join(tmpdir(), 'mp-deploy-receipt-'));
const setPath = join(dir, 'release-set.json');
const policyPath = join(dir, 'policy.json');
const outPath = join(dir, 'receipt.json');
const set = {
  release_number: 12, release_identity: 'r4.10-test', git_commit: 'a'.repeat(40),
  build_output_sha256: 'b'.repeat(64), source_tree_sha256: 'c'.repeat(64),
  site_domain: 'example.invalid', supabase_project_ref: 'abcdefghijklmnopqrst',
  build_profile: 'production', signature: { scheme: 'ed25519' },
  edge_function_count: EDGE_FUNCTIONS.length, edge_function_inventory: EDGE_FUNCTIONS,
  edge_function_trees: functionTreeHashes, edge_shared_tree_sha256: sharedFunctionHash,
  public_function_set_sha256: publicFunctionSetSha,
};
writeFileSync(setPath, JSON.stringify(set)); writeFileSync(policyPath, '{}');
const content = {
  'signed-release-verification.log': 'PROVENANCE VERIFIED\n',
  'deployed-acceptance.log': 'DEPLOYED ACCEPTANCE — 20 passed, 0 failed — PASSED\n',
  'secret-inventory.log': 'SUPABASE SECRET INVENTORY PASS\n',
  'auth-before-backend.log': 'AUTHENTICATED BROWSER SMOKE PASS [chromium] — pre-backend baseline\n',
  'function-deploy.log': functionDeployLog(),
  'auth-after-backend.log': 'AUTHENTICATED BROWSER SMOKE PASS [chromium] — old frontend with new backend\n',
  'public-form-live.log': 'PUBLIC-FORM REJECTION PROBES — 7 passed, 0 failed\n',
  'turnstile-live.log': 'Turnstile pairing OK\n',
  'edge-cors-live.log': 'EDGE CORS LIVE — 9 passed, 0 failed\n',
  'email-delivery-live.log': 'EMAIL DELIVERY LIVE PASS\n',
  'outbox-delivery-live.log': 'OUTBOX DELIVERY LIVE PASS\n',
  'netlify-draft.json': JSON.stringify({ kind: 'milkpop-netlify-draft', draft: true, state: 'ready', deploy_id: 'deploy-1', site_id: 'site-1', ...set }),
  'draft-headers.log': 'HEADERS SMOKE — 14 passed, 0 failed\n',
  'draft-seo.log': 'seo-live-parity: IN SYNC — deployed SEO matches live Supabase\n',
  'netlify-publish.json': JSON.stringify({ kind: 'milkpop-netlify-publish', deploy_id: 'deploy-1', previous_deploy_id: 'deploy-0', site_id: 'site-1', ...set }),
  'live-marker.log': 'LIVE RELEASE MARKER PASS — release 12 matches the signed build\n',
  'headers-live.log': 'HEADERS SMOKE — 14 passed, 0 failed\n',
  'seo-live.log': 'seo-live-parity: IN SYNC — deployed SEO matches live Supabase\n',
  'auth-browser-chromium.log': 'AUTHENTICATED BROWSER SMOKE PASS [chromium] — owner login\n',
  'auth-browser-webkit.log': 'AUTHENTICATED BROWSER SMOKE PASS [webkit] — owner login\n',
};
const files = Object.entries(content).map(([name, value]) => { const file = join(dir, name); writeFileSync(file, value); return file; });
const run = (list = files) => spawnSync(process.execPath,
  ['scripts/write-deployment-receipt.mjs', setPath, policyPath, outPath, ...list], { encoding: 'utf8' });
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; } };

test('complete backend and frontend evidence writes a bound production receipt', () => {
  const result = run(); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(outPath));
  assert.equal(receipt.schema, 5);
  assert.equal(receipt.previous_live_compatibility, 'verified');
  assert.equal(receipt.netlify_deploy_id, 'deploy-1');
  assert.equal(receipt.function_deployment.status, 'deployed');
  assert.equal(receipt.public_function_set_sha256, publicFunctionSetSha);
  assert.equal(Object.keys(receipt.evidence).length, files.length);
  assert.match(receipt.verification_result, /BACKEND COMPATIBILITY AND LIVE FRONTEND VERIFIED/);
});

test('proven first deployment may record previous-live compatibility as not applicable while new-live auth stays mandatory', () => {
  const before = join(dir, 'auth-before-backend.log');
  const after = join(dir, 'auth-after-backend.log');
  writeFileSync(before, 'FIRST_DEPLOY_NO_PREVIOUS_LIVE_SITE\n');
  writeFileSync(after, 'FIRST_DEPLOY_NO_PREVIOUS_LIVE_SITE\n');
  const result = run(); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(outPath));
  assert.equal(receipt.previous_live_compatibility, 'not_applicable_first_deploy');
  writeFileSync(before, content['auth-before-backend.log']);
  writeFileSync(after, content['auth-after-backend.log']);
});
test('first-deploy compatibility marker must be consistent before and after backend deployment', () => {
  const before = join(dir, 'auth-before-backend.log');
  writeFileSync(before, 'FIRST_DEPLOY_NO_PREVIOUS_LIVE_SITE\n');
  assert.notEqual(run().status, 0);
  writeFileSync(before, content['auth-before-backend.log']);
});
test('unchanged signed backend may skip Supabase mutation while retaining live acceptance', () => {
  const fn = join(dir, 'function-deploy.log');
  writeFileSync(fn, `FUNCTION_DEPLOY_SKIPPED_UNCHANGED public_function_set_sha256=${publicFunctionSetSha}\n`);
  const result = run(); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(outPath));
  assert.equal(receipt.function_deployment.status, 'skipped_unchanged');
  assert.equal(receipt.function_deployment.public_function_set_sha256, publicFunctionSetSha);
  writeFileSync(fn, content['function-deploy.log']);
});
test('skipped backend with a different fingerprint is rejected', () => {
  const fn = join(dir, 'function-deploy.log');
  writeFileSync(fn, `FUNCTION_DEPLOY_SKIPPED_UNCHANGED public_function_set_sha256=${'f'.repeat(64)}\n`);
  assert.notEqual(run().status, 0);
  writeFileSync(fn, content['function-deploy.log']);
});
test('missing evidence is rejected', () => assert.notEqual(run(files.slice(1)).status, 0));
test('a missing authenticated release-verification marker is rejected', () => {
  const proof = join(dir, 'signed-release-verification.log'); writeFileSync(proof, 'SELF CONSISTENCY ONLY\n');
  assert.notEqual(run().status, 0); writeFileSync(proof, content['signed-release-verification.log']);
});
test('skipped or absent authenticated smoke is rejected', () => {
  const auth = join(dir, 'auth-browser-webkit.log'); writeFileSync(auth, 'AUTHENTICATED_BROWSER_SMOKE_SKIPPED\n');
  assert.notEqual(run().status, 0); writeFileSync(auth, content['auth-browser-webkit.log']);
});
test('failed backend evidence is rejected', () => {
  const email = join(dir, 'email-delivery-live.log'); writeFileSync(email, 'EMAIL DELIVERY FAILED\n');
  assert.notEqual(run().status, 0); writeFileSync(email, content['email-delivery-live.log']);
});
test('failed old-frontend compatibility proof is rejected', () => {
  const compat = join(dir, 'auth-after-backend.log'); writeFileSync(compat, 'AUTHENTICATED BROWSER SMOKE FAILED\n');
  assert.notEqual(run().status, 0); writeFileSync(compat, content['auth-after-backend.log']);
});
test('publishing a different draft id is rejected', () => {
  const pub = join(dir, 'netlify-publish.json'); writeFileSync(pub, JSON.stringify({ kind: 'milkpop-netlify-publish', deploy_id: 'other', ...set }));
  assert.notEqual(run().status, 0); writeFileSync(pub, content['netlify-publish.json']);
});
test('function source hashes that differ from the signed release are rejected', () => {
  const fn = join(dir, 'function-deploy.log');
  writeFileSync(fn, functionDeployLog().replace(functionTreeHashes['send-email'], 'f'.repeat(64)));
  assert.notEqual(run().status, 0); writeFileSync(fn, content['function-deploy.log']);
});
rmSync(dir, { recursive: true, force: true });
if (!process.exitCode) console.log(`DEPLOYMENT RECEIPT CONTRACT — ${passed}/${passed} passed`);
