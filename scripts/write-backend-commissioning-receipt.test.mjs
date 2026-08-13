#!/usr/bin/env node
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const functionNames = [
  ['send-email', 'on'], ['cv-signed-url', 'on'], ['cv-upload', 'off'], ['public-form', 'off'],
  ['training-media', 'on'], ['staff-doc-upload', 'on'], ['staff-doc-url', 'on'], ['staff-doc-delete', 'on'],
  ['staff-invite', 'on'], ['media-upload', 'on'], ['media-cleanup', 'on'], ['request-seo-rebuild', 'on'],
  ['outbox-dispatch', 'off'], ['employee-access-revoke', 'on'],
];
const manifestIdentity = JSON.parse(readFileSync('release-manifest.json', 'utf8'));
const functionDeployLog = () => {
  const shared = manifestIdentity.edge_shared_tree_sha256;
  const rows = functionNames.map(([name, mode]) =>
    `FUNCTION_DEPLOYED name=${name} sha256=${manifestIdentity.edge_function_trees[name]} shared_sha256=${shared} verify_jwt=${mode}`);
  return [
    `FUNCTION_SHARED_SOURCE sha256=${shared}`,
    `PUBLIC_FUNCTION_SET_SOURCE sha256=${manifestIdentity.public_function_set_sha256}`,
    ...rows,
    `FUNCTION_DEPLOY_PASS count=14 public_function_set_sha256=${manifestIdentity.public_function_set_sha256} pos_deferred=3`,
    'PUBLIC_FUNCTION_DEPLOY_PASS (14 functions; POS deferred)',
  ].join('\n') + '\n';
};

const dir = mkdtempSync(join(tmpdir(), 'mp-backend-receipt-'));
const common = {
  'secret-inventory.log': 'SUPABASE SECRET INVENTORY PASS\n',
  'deployed-acceptance.log': 'DEPLOYED ACCEPTANCE — 20 passed, 0 failed, 0 skipped — PASSED\n',
  'rls-live.log': '40 passed, 0 failed\n',
  'public-form-live.log': 'PUBLIC-FORM REJECTION PROBES — 7 passed, 0 failed\n',
  'turnstile-live.log': 'Turnstile pairing OK\n',
  'edge-cors-live.log': 'EDGE CORS LIVE — 9 passed, 0 failed\n',
  'email-delivery-live.log': 'EMAIL DELIVERY LIVE PASS\n',
  'outbox-delivery-live.log': 'OUTBOX DELIVERY LIVE PASS\n',
};
const out = join(dir, 'receipt.json');
const writeLogs = (extra) => {
  const files = [];
  for (const [name, value] of Object.entries({ ...common, ...extra })) {
    const file = join(dir, name); writeFileSync(file, value); files.push(file);
  }
  return files;
};
const run = (mode, files) => spawnSync(process.execPath,
  ['scripts/write-backend-commissioning-receipt.mjs', out, ...files], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MP_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
      MP_DATABASE_MODE: mode,
      MP_GIT_COMMIT: 'a'.repeat(40),
      MP_MANIFEST: 'release-manifest.json',
    },
  });
let passed = 0;
const test = (name, fn) => { try { fn(); passed += 1; console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; } };

const verifyFiles = writeLogs({
  'database-commission.log': 'DATABASE_VERIFY_ONLY\n',
  'function-deploy.log': 'FUNCTION_SOURCE_NOT_VERIFIED (verify-only does not redeploy functions)\n',
  'scheduler-commission.log': 'SCHEDULER_VERIFY_ONLY_NOT_COMMISSIONED\n',
});
test('verify-only writes an honest limited receipt', () => {
  const result = run('verify-only', verifyFiles); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(out));
  assert.equal(receipt.status, 'PASS_WITH_LIMITATIONS');
  assert.equal(receipt.database_mutated, false);
  assert.equal(receipt.function_source_verified, false);
  assert.equal(receipt.schedulers_commissioned, false);
  assert.equal(receipt.edge_function_count, 17);
  assert.equal(receipt.edge_function_inventory.length, 17);
  assert.equal(Object.keys(receipt.edge_function_trees).length, 17);
});
test('verify-only rejects a false function-deploy claim', () => {
  const files = writeLogs({
    'database-commission.log': 'DATABASE_VERIFY_ONLY\n',
    'function-deploy.log': functionDeployLog(),
    'scheduler-commission.log': 'SCHEDULER_VERIFY_ONLY_NOT_COMMISSIONED\n',
  });
  assert.notEqual(run('verify-only', files).status, 0);
});


const recoveryFiles = writeLogs({
  'secret-inventory.log': 'SUPABASE SECRET INVENTORY SKIPPED RECOVERY ONLY — database-only incident recovery does not deploy or invoke Edge Functions\n',
  'database-commission.log': 'RECOVERY_SQL_SOURCE file=ops/RECOVER-PARTIAL-FRESH-T13.3.28.sql sha256=' + 'a'.repeat(64) + '\nKNOWN PARTIAL RECOVERY COMPLETE — RUN FRESH\nDATABASE_COMMISSION_PASS mode=recover-known-partial\n',
  'function-deploy.log': 'FUNCTION_DEPLOY_SKIPPED_RECOVERY_ONLY — recovery changes only the known partial database baseline\n',
  'scheduler-commission.log': 'SCHEDULER_SKIPPED_RECOVERY_ONLY — recovery does not mutate scheduler configuration\n',
  'deployed-acceptance.log': 'RECOVERY_ONLY\n',
  'rls-live.log': 'RECOVERY_ONLY\n',
  'public-form-live.log': 'RECOVERY_ONLY\n',
  'turnstile-live.log': 'RECOVERY_ONLY\n',
  'edge-cors-live.log': 'RECOVERY_ONLY\n',
  'email-delivery-live.log': 'RECOVERY_ONLY\n',
  'outbox-delivery-live.log': 'RECOVERY_ONLY\n',
});
test('known-partial recovery writes RECOVERY_COMPLETE without claiming function/scheduler/live acceptance', () => {
  const result = run('recover-known-partial', recoveryFiles); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(out));
  assert.equal(receipt.schema, 'milkpop-backend-commissioning-receipt/v4');
  assert.equal(receipt.status, 'RECOVERY_COMPLETE');
  assert.equal(receipt.database_mutated, true);
  assert.equal(receipt.function_source_verified, false);
  assert.equal(receipt.schedulers_commissioned, false);
  assert.ok(receipt.limitations.some((item) => item.includes('fresh installation must run next')));
});
test('known-partial recovery rejects a false function deployment claim', () => {
  const bad = writeLogs({
    'secret-inventory.log': 'SUPABASE SECRET INVENTORY SKIPPED RECOVERY ONLY — database-only incident recovery does not deploy or invoke Edge Functions\n',
    'database-commission.log': 'KNOWN PARTIAL RECOVERY COMPLETE — RUN FRESH\nDATABASE_COMMISSION_PASS mode=recover-known-partial\n',
    'function-deploy.log': functionDeployLog(),
    'scheduler-commission.log': 'SCHEDULER_SKIPPED_RECOVERY_ONLY\n',
    'deployed-acceptance.log': 'RECOVERY_ONLY\n',
    'rls-live.log': 'RECOVERY_ONLY\n',
    'public-form-live.log': 'RECOVERY_ONLY\n',
    'turnstile-live.log': 'RECOVERY_ONLY\n',
    'edge-cors-live.log': 'RECOVERY_ONLY\n',
    'email-delivery-live.log': 'RECOVERY_ONLY\n',
    'outbox-delivery-live.log': 'RECOVERY_ONLY\n',
  });
  assert.notEqual(run('recover-known-partial', bad).status, 0);
});

const freshFiles = writeLogs({
  'database-commission.log': 'DATABASE_COMMISSION_PASS mode=fresh\n',
  'function-deploy.log': functionDeployLog(),
  'scheduler-commission.log': 'PRODUCTION SCHEDULERS PASS\n',
  'deployed-acceptance.log': 'BOOTSTRAP_REQUIRED\n',
  'rls-live.log': 'BOOTSTRAP_REQUIRED\n',
  'public-form-live.log': 'BOOTSTRAP_REQUIRED\n',
  'turnstile-live.log': 'BOOTSTRAP_REQUIRED\n',
  'edge-cors-live.log': 'BOOTSTRAP_REQUIRED\n',
  'email-delivery-live.log': 'BOOTSTRAP_REQUIRED\n',
  'outbox-delivery-live.log': 'BOOTSTRAP_REQUIRED\n',
});
test('fresh commissioning writes INSTALL_COMPLETE without pretending live acceptance ran', () => {
  const result = run('fresh', freshFiles); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(out));
  assert.equal(receipt.status, 'INSTALL_COMPLETE');
  assert.equal(receipt.database_mutated, true);
  assert.equal(receipt.function_source_verified, true);
  assert.equal(receipt.schedulers_commissioned, true);
  assert.ok(receipt.limitations.some((item) => item.includes('one-time bootstrap')));
});
test('resume commissioning is also an INSTALL_COMPLETE bootstrap handoff', () => {
  const resumeFiles = writeLogs({
    'database-commission.log': 'DATABASE_COMMISSION_PASS mode=resume\n',
    'function-deploy.log': functionDeployLog(),
    'scheduler-commission.log': 'PRODUCTION SCHEDULERS PASS\n',
    'deployed-acceptance.log': 'BOOTSTRAP_REQUIRED\n',
    'rls-live.log': 'BOOTSTRAP_REQUIRED\n',
    'public-form-live.log': 'BOOTSTRAP_REQUIRED\n',
    'turnstile-live.log': 'BOOTSTRAP_REQUIRED\n',
    'edge-cors-live.log': 'BOOTSTRAP_REQUIRED\n',
    'email-delivery-live.log': 'BOOTSTRAP_REQUIRED\n',
    'outbox-delivery-live.log': 'BOOTSTRAP_REQUIRED\n',
  });
  const result = run('resume', resumeFiles); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(out));
  assert.equal(receipt.status, 'INSTALL_COMPLETE');
  assert.equal(receipt.database_mode, 'resume');
  assert.ok(receipt.limitations.some((item) => item.includes('one-time bootstrap')));
});

const commissionFiles = writeLogs({
  'database-commission.log': 'DATABASE_COMMISSION_PASS mode=upgrade\n',
  'function-deploy.log': functionDeployLog(),
  'scheduler-commission.log': 'PRODUCTION SCHEDULERS PASS\n',
});
test('full commissioning writes a complete PASS receipt', () => {
  const result = run('upgrade', commissionFiles); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(out));
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.database_mutated, true);
  assert.equal(receipt.function_source_verified, true);
  assert.equal(receipt.schedulers_commissioned, true);
  assert.equal(Object.keys(receipt.logs).length, 11);
  assert.equal(receipt.edge_function_count, 17);
  assert.equal(Object.keys(receipt.edge_function_trees).length, 17);
});
test('missing evidence log fails closed', () => assert.notEqual(run('upgrade', commissionFiles.slice(1)).status, 0));
test('missing live PASS marker fails closed', () => {
  const bad = writeLogs({
    'secret-inventory.log': 'SUPABASE SECRET INVENTORY SKIPPED RECOVERY ONLY — database-only incident recovery does not deploy or invoke Edge Functions\n',
    'database-commission.log': 'DATABASE_COMMISSION_PASS mode=upgrade\n',
    'function-deploy.log': functionDeployLog(),
    'scheduler-commission.log': 'PRODUCTION SCHEDULERS PASS\n',
    'email-delivery-live.log': 'EMAIL DELIVERY FAILED\n',
  });
  assert.notEqual(run('upgrade', bad).status, 0);
});

rmSync(dir, { recursive: true, force: true });
if (!process.exitCode) console.log(`BACKEND RECEIPT CONTRACT — ${passed}/${passed} passed`);
