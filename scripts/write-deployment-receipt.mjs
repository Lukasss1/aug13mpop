#!/usr/bin/env node
/**
 * Write the final production receipt only after frontend and backend proof for
 * the exact signed release exists. Evidence is named, hashed and marker-checked;
 * previous-live owner checks may be explicitly inapplicable only on a proven first deployment; new-live owner authentication remains mandatory.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { validateFunctionDeployEvidence, assertFunctionDeployMatchesIdentity } from './lib/function-deploy-evidence.mjs';
import { assertPublicFunctionSetSha256 } from './lib/edge-function-inventory.mjs';

const [, , setPath, policyPath, outPath, ...evidencePaths] = process.argv;
if (!setPath || !policyPath || !outPath) {
  console.error('usage: write-deployment-receipt.mjs <release-set.json> <trust-policy.json> <out.json> <all-required-evidence...>');
  process.exit(2);
}
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const set = JSON.parse(readFileSync(setPath, 'utf8'));
const required = [
  'signed-release-verification.log',
  'deployed-acceptance.log',
  'secret-inventory.log',
  'auth-before-backend.log',
  'function-deploy.log',
  'auth-after-backend.log',
  'public-form-live.log',
  'turnstile-live.log',
  'edge-cors-live.log',
  'email-delivery-live.log',
  'outbox-delivery-live.log',
  'netlify-draft.json',
  'draft-headers.log',
  'draft-seo.log',
  'netlify-publish.json',
  'live-marker.log',
  'headers-live.log',
  'seo-live.log',
  'auth-browser-chromium.log',
  'auth-browser-webkit.log',
];
const evidenceByName = new Map(evidencePaths.map((file) => [basename(file), file]));
if (evidencePaths.length !== required.length || required.some((name) => !evidenceByName.has(name))) {
  throw new Error(`deployment receipt requires exactly: ${required.join(', ')}`);
}

const markers = {
  'signed-release-verification.log': /PROVENANCE VERIFIED/,
  'deployed-acceptance.log': /DEPLOYED ACCEPTANCE[^\n]*PASSED/,
  'secret-inventory.log': /SUPABASE SECRET INVENTORY PASS/,
  'auth-before-backend.log': /(?:AUTHENTICATED BROWSER SMOKE PASS \[chromium\]|FIRST_DEPLOY_NO_PREVIOUS_LIVE_SITE)/,
  'function-deploy.log': /(?:FUNCTION_DEPLOY_PASS|FUNCTION_DEPLOY_SKIPPED_UNCHANGED)/,
  'auth-after-backend.log': /(?:AUTHENTICATED BROWSER SMOKE PASS \[chromium\]|FIRST_DEPLOY_NO_PREVIOUS_LIVE_SITE)/,
  'public-form-live.log': /PUBLIC-FORM REJECTION PROBES[^\n]*0 failed/,
  'turnstile-live.log': /Turnstile pairing OK/,
  'edge-cors-live.log': /EDGE CORS LIVE[^\n]*0 failed/,
  'email-delivery-live.log': /EMAIL DELIVERY LIVE PASS/,
  'outbox-delivery-live.log': /OUTBOX DELIVERY LIVE PASS/,
  'draft-headers.log': /HEADERS SMOKE[^\n]*0 failed/,
  'draft-seo.log': /seo-live-parity: IN SYNC/,
  'live-marker.log': /LIVE RELEASE MARKER PASS/,
  'headers-live.log': /HEADERS SMOKE[^\n]*0 failed/,
  'seo-live.log': /seo-live-parity: IN SYNC/,
  'auth-browser-chromium.log': /AUTHENTICATED BROWSER SMOKE PASS \[chromium\]/,
  'auth-browser-webkit.log': /AUTHENTICATED BROWSER SMOKE PASS \[webkit\]/,
};
for (const [name, marker] of Object.entries(markers)) {
  const text = readFileSync(evidenceByName.get(name), 'utf8');
  if (!marker.test(text)) throw new Error(`required PASS marker missing from ${name}`);
}

const authBeforeText = readFileSync(evidenceByName.get('auth-before-backend.log'), 'utf8');
const authAfterText = readFileSync(evidenceByName.get('auth-after-backend.log'), 'utf8');
const firstDeployCompatibilitySkipped = /FIRST_DEPLOY_NO_PREVIOUS_LIVE_SITE/.test(authBeforeText) || /FIRST_DEPLOY_NO_PREVIOUS_LIVE_SITE/.test(authAfterText);
if (firstDeployCompatibilitySkipped && !(/FIRST_DEPLOY_NO_PREVIOUS_LIVE_SITE/.test(authBeforeText) && /FIRST_DEPLOY_NO_PREVIOUS_LIVE_SITE/.test(authAfterText))) {
  throw new Error('first-deploy previous-live compatibility evidence must be consistent before and after backend deployment');
}

const functionText = readFileSync(evidenceByName.get('function-deploy.log'), 'utf8');
let functionDeployment;
const skipped = functionText.match(/^FUNCTION_DEPLOY_SKIPPED_UNCHANGED public_function_set_sha256=([a-f0-9]{64})$/m);
if (skipped) {
  assertPublicFunctionSetSha256(set.public_function_set_sha256, 'signed release public function-set hash');
  if (skipped[1] !== set.public_function_set_sha256) {
    throw new Error('skipped function deployment does not match the signed release backend identity');
  }
  functionDeployment = {
    status: 'skipped_unchanged',
    public_function_set_sha256: skipped[1],
  };
} else {
  functionDeployment = validateFunctionDeployEvidence(functionText);
  assertFunctionDeployMatchesIdentity(functionDeployment, set);
  functionDeployment = { status: 'deployed', ...functionDeployment };
}

const draft = JSON.parse(readFileSync(evidenceByName.get('netlify-draft.json'), 'utf8'));
const published = JSON.parse(readFileSync(evidenceByName.get('netlify-publish.json'), 'utf8'));
if (draft.kind !== 'milkpop-netlify-draft' || draft.draft !== true || draft.state !== 'ready') {
  throw new Error('netlify-draft.json is not a ready non-live draft receipt');
}
if (published.kind !== 'milkpop-netlify-publish' || published.deploy_id !== draft.deploy_id) {
  throw new Error('netlify-publish.json does not publish the verified draft deploy');
}
for (const [name, record] of [['draft', draft], ['published', published]]) {
  for (const key of ['release_identity', 'release_number', 'git_commit', 'build_output_sha256', 'public_function_set_sha256']) {
    if (record[key] !== set[key]) throw new Error(`${name} Netlify receipt does not match release set: ${key}`);
  }
}

const evidence = Object.fromEntries(required.map((name) => {
  const file = evidenceByName.get(name);
  const bytes = readFileSync(file).length;
  return [name, { sha256: sha(file), bytes }];
}));
const receipt = {
  kind: 'milkpop-deployment-receipt',
  schema: 5,
  deployed_at: new Date().toISOString(),
  release_number: set.release_number ?? null,
  release_identity: set.release_identity,
  git_commit: set.git_commit ?? null,
  build_output_sha256: set.build_output_sha256,
  public_function_set_sha256: set.public_function_set_sha256,
  source_tree_sha256: set.source_tree_sha256,
  site_domain: set.site_domain ?? null,
  supabase_project_ref: set.supabase_project_ref ?? null,
  build_profile: set.build_profile,
  signature_scheme: set.signature?.scheme ?? null,
  netlify_deploy_id: published.deploy_id,
  previous_netlify_deploy_id: published.previous_deploy_id ?? null,
  previous_live_compatibility: firstDeployCompatibilitySkipped ? 'not_applicable_first_deploy' : 'verified',
  function_deployment: functionDeployment,
  release_set_sha256: sha(setPath),
  trust_policy_sha256: sha(policyPath),
  verifier_sha256: sha(new URL('./verify-archive-manifest.mjs', import.meta.url).pathname),
  verification_result: 'PROVENANCE, BACKEND COMPATIBILITY AND LIVE FRONTEND VERIFIED (production)',
  evidence,
};
writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`deployment receipt written: ${outPath}`);
console.log(`  release ${receipt.release_number} · deploy ${receipt.netlify_deploy_id} · ${receipt.site_domain}`);
