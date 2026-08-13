#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { validateFunctionDeployEvidence, assertFunctionDeployMatchesIdentity } from './lib/function-deploy-evidence.mjs';
import { EDGE_FUNCTIONS, assertExactEdgeFunctionInventory, assertExactEdgeFunctionHashMap } from './lib/edge-function-inventory.mjs';

const out = process.argv[2];
const logFiles = process.argv.slice(3);
if (!out || !logFiles.length) {
  console.error('usage: write-backend-commissioning-receipt.mjs <output.json> <log...>');
  process.exit(2);
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const manifestPath = process.env.MP_MANIFEST || 'release-manifest.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.edge_function_count !== EDGE_FUNCTIONS.length) {
  throw new Error(`release manifest edge_function_count ${manifest.edge_function_count} != ${EDGE_FUNCTIONS.length}`);
}
assertExactEdgeFunctionInventory(manifest.edge_function_inventory, 'release manifest Edge Function inventory');
assertExactEdgeFunctionHashMap(manifest.edge_function_trees, 'release manifest Edge Function tree hashes');
const mode = process.env.MP_DATABASE_MODE || 'unknown';
const logs = {};
const textByName = new Map();
for (const file of logFiles) {
  if (!statSync(file).isFile()) throw new Error(`not a regular log: ${file}`);
  const buf = readFileSync(file);
  const name = basename(file);
  logs[name] = { sha256: sha(buf), bytes: buf.length };
  textByName.set(name, buf.toString('utf8'));
}

const requireMarker = (name, marker) => {
  const text = textByName.get(name);
  if (text == null) throw new Error(`required log missing: ${name}`);
  if (!marker.test(text)) throw new Error(`required PASS marker missing from ${name}`);
};

if (mode === 'recover-known-partial') {
  requireMarker('secret-inventory.log', /SUPABASE SECRET INVENTORY SKIPPED RECOVERY ONLY/);
} else {
  requireMarker('secret-inventory.log', /SUPABASE SECRET INVENTORY PASS/);
}

const liveMarkers = {
  'deployed-acceptance.log': /DEPLOYED ACCEPTANCE[^\n]*PASSED/,
  'rls-live.log': /\b0 failed\b/,
  'public-form-live.log': /PUBLIC-FORM REJECTION PROBES[^\n]*0 failed/,
  'turnstile-live.log': /Turnstile pairing OK/,
  'edge-cors-live.log': /EDGE CORS LIVE[^\n]*0 failed/,
  'email-delivery-live.log': /EMAIL DELIVERY LIVE PASS/,
  'outbox-delivery-live.log': /OUTBOX DELIVERY LIVE PASS/,
};
if (mode === 'fresh' || mode === 'resume') {
  for (const name of Object.keys(liveMarkers)) requireMarker(name, /BOOTSTRAP_REQUIRED/);
} else if (mode === 'recover-known-partial') {
  for (const name of Object.keys(liveMarkers)) requireMarker(name, /RECOVERY_ONLY/);
} else {
  for (const [name, marker] of Object.entries(liveMarkers)) requireMarker(name, marker);
}

const databaseMarker = mode === 'verify-only'
  ? /DATABASE_VERIFY_ONLY/
  : mode === 'recover-known-partial'
    ? /KNOWN PARTIAL RECOVERY COMPLETE — RUN FRESH[\s\S]*DATABASE_COMMISSION_PASS mode=recover-known-partial/
    : /DATABASE_COMMISSION_PASS/;
requireMarker('database-commission.log', databaseMarker);

const functionText = textByName.get('function-deploy.log');
if (functionText == null) throw new Error('required log missing: function-deploy.log');
const functionSourceVerified = /FUNCTION_DEPLOY_PASS/.test(functionText);
const functionDeployment = functionSourceVerified ? validateFunctionDeployEvidence(functionText) : null;
if (functionDeployment) assertFunctionDeployMatchesIdentity(functionDeployment, manifest);
const functionSourceNotVerified = /FUNCTION_SOURCE_NOT_VERIFIED|FUNCTION_DEPLOY_SKIPPED/.test(functionText);
if (!functionSourceVerified && !functionSourceNotVerified) {
  throw new Error('required function deployment or limitation marker missing from function-deploy.log');
}
if ((mode === 'verify-only' || mode === 'recover-known-partial') && functionSourceVerified) {
  throw new Error(`${mode} receipt cannot claim an Edge Function deployment`);
}

const schedulerText = textByName.get('scheduler-commission.log');
if (schedulerText == null) throw new Error('required log missing: scheduler-commission.log');
const schedulersCommissioned = /PRODUCTION SCHEDULERS PASS/.test(schedulerText);
const schedulersNotCommissioned = /SCHEDULER_VERIFY_ONLY_NOT_COMMISSIONED|SCHEDULER_SKIPPED_RECOVERY_ONLY/.test(schedulerText);
if (!schedulersCommissioned && !schedulersNotCommissioned) {
  throw new Error('required scheduler commissioning or limitation marker missing from scheduler-commission.log');
}
if ((mode === 'verify-only' || mode === 'recover-known-partial') && schedulersCommissioned) {
  throw new Error(`${mode} receipt cannot claim scheduler recommissioning`);
}

const projectRef = process.env.MP_SUPABASE_PROJECT_REF || '';
if (!/^[a-z0-9]{20}$/.test(projectRef)) throw new Error('invalid MP_SUPABASE_PROJECT_REF');
const limited = !functionSourceVerified || !schedulersCommissioned || mode === 'verify-only';
const bootstrapPending = mode === 'fresh' || mode === 'resume';
const recoveryComplete = mode === 'recover-known-partial';
const status = recoveryComplete ? 'RECOVERY_COMPLETE' : (bootstrapPending ? 'INSTALL_COMPLETE' : (limited ? 'PASS_WITH_LIMITATIONS' : 'PASS'));
const receipt = {
  schema: 'milkpop-backend-commissioning-receipt/v4',
  status,
  generated_at: new Date().toISOString(),
  project_ref: projectRef,
  database_mode: mode,
  database_mutated: mode !== 'verify-only',
  function_source_verified: functionSourceVerified,
  function_deployment: functionDeployment,
  schedulers_commissioned: schedulersCommissioned,
  limitations: [
    ...(!functionSourceVerified ? ['deployed Edge Function source identity was not established by this run'] : []),
    ...(!schedulersCommissioned ? ['scheduler configuration was not recommissioned by this run'] : []),
    ...(mode === 'verify-only' ? ['synthetic acceptance probes may create and clean dedicated test records'] : []),
    ...(bootstrapPending ? ['owner/store/MFA/public-form/e-mail live acceptance is pending the one-time bootstrap'] : []),
    ...(recoveryComplete ? ['one-time known partial baseline recovery completed; fresh installation must run next before any backend can be considered installed'] : []),
  ],
  release_identity: manifest.release_identity,
  git_commit: process.env.MP_GIT_COMMIT || '',
  source_tree_sha256: manifest.source_tree_sha256,
  migration_count: manifest.migration_count,
  migration_fingerprint_sha256: manifest.migration_fingerprint_sha256,
  edge_function_count: manifest.edge_function_count,
  edge_function_inventory: manifest.edge_function_inventory,
  edge_functions: manifest.edge_functions,
  edge_function_trees: manifest.edge_function_trees,
  edge_shared: manifest.edge_shared,
  edge_shared_tree_sha256: manifest.edge_shared_tree_sha256,
  logs,
};
writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(`BACKEND COMMISSIONING RECEIPT ${receipt.status} — ${out}`);
