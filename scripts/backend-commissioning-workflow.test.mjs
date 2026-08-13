#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const w = readFileSync('.github/workflows/commission-production-backend.yml', 'utf8');
const inputs = readFileSync('scripts/lib/production-inputs.mjs', 'utf8');
const pos = (needle) => w.indexOf(needle);
const checks = [
  ['manual protected workflow', /workflow_dispatch:[\s\S]*environment: production/.test(w)],
  ['serialized production mutations', /concurrency:[\s\S]*milkpop-production-mutation/.test(w)],
  ['commissioning is restricted to main', /production commissioning may run only from main/.test(w)],
  ['exact project ref confirmation', /confirm_project_ref[\s\S]*project ref confirmation mismatch/.test(w)],
  ['explicit owner-facing confirmation phrases', /RECOVER KNOWN PARTIAL[\s\S]*ERASE AND INSTALL[\s\S]*RESUME INSTALL[\s\S]*APPLY MIGRATIONS/.test(w) && !/adopt: ADOPT EXISTING BASELINE/.test(w)],
  ['PostgreSQL 17 server and client are installed for rehearsal', /install-postgresql-17\.sh/.test(w)],
  ['exact npm lock and complete verify chain run before any production mutation', /npm ci/.test(w) && /npm run verify/.test(w) && pos('npm ci') < pos('Apply or verify the database ledger') && pos('npm run verify') < pos('Apply or verify the database ledger')],
  ['pinned Supabase CLI action', /supabase\/setup-cli@[a-f0-9]{40}/.test(w)],
  ['exact launch database path is rehearsed before production mutation', /upgrade-replay\.test\.sh/.test(w) && pos('upgrade-replay.test.sh') < pos('Apply or verify the database ledger')],
  ['seed/schema honesty gate runs before production mutation', /seed-honesty\.test\.mjs/.test(w) && pos('seed-honesty.test.mjs') < pos('Apply or verify the database ledger')],
  ['committed release manifest matches the exact commissioning source tree', /SOURCE MANIFEST CURRENT PASS/.test(w) && /release-hash\.mjs --source \./.test(w) && /release-manifest\.json is stale for this source tree/.test(w) && pos('SOURCE MANIFEST CURRENT PASS') < pos('Apply or verify the database ledger')],
  ['protected production inputs are validated before database mutation', /validate-production-commissioning-inputs\.mjs/.test(w) && pos('validate-production-commissioning-inputs.mjs') < pos('Apply or verify the database ledger')],
  ['upgrade live-acceptance readiness is wired into the pre-mutation validator', /MP_SITE_DOMAIN:.*vars\.MP_SITE_DOMAIN/.test(w) && /VITE_TURNSTILE_SITE_KEY:.*vars\.VITE_TURNSTILE_SITE_KEY/.test(w) && /TURNSTILE_SECRET_SET:.*vars\.TURNSTILE_SECRET_SET/.test(w) && /FORM_ALLOWED_ORIGINS_SET:.*vars\.FORM_ALLOWED_ORIGINS_SET/.test(w) && /CV_ALLOWED_ORIGINS_SET:.*vars\.CV_ALLOWED_ORIGINS_SET/.test(w) && /EMAIL_ALLOWED_ORIGINS_SET:.*vars\.EMAIL_ALLOWED_ORIGINS_SET/.test(w) && /NOTIFICATION_RECIPIENT_SET:.*vars\.NOTIFICATION_RECIPIENT_SET/.test(w) && pos('validate-production-commissioning-inputs.mjs') < pos('Apply or verify the database ledger')],
  ['commissioning shares fail-fast legacy JWT semantics with release validation', /validate-production-commissioning-inputs\.mjs/.test(w) && /legacy JWT-shaped key/.test(inputs) && /startsWith\('sb_'\)/.test(inputs)],
  ['Supabase Edge Function secrets are verified before database mutation for modes that use the backend', /Verify production Edge Function secret inventory before database mutation/.test(w) && /inputs\.database_mode != 'recover-known-partial'/.test(w) && pos('verify-supabase-secrets.mjs /tmp/supabase-secrets.json') < pos('Apply or verify the database ledger')],
  ['known-partial recovery does not depend on unrelated Edge Function provider secrets', /SUPABASE SECRET INVENTORY SKIPPED RECOVERY ONLY/.test(w)],
  ['custom ledger runner used', /commission-database\.sh/.test(w)],
  ['normal mutating modes deploy the fixed 14-function public set while recovery does not', /inputs\.database_mode != 'verify-only' && inputs\.database_mode != 'recover-known-partial'[\s\S]*bash launch\/deploy-public-functions\.sh/.test(w) && /FUNCTION_DEPLOY_SKIPPED_RECOVERY_ONLY/.test(w) && !/deploy_functions:/.test(w)],
  ['verify-only does not redeploy functions', /FUNCTION_SOURCE_NOT_VERIFIED/.test(w)],
  ['production schedulers are commissioned before acceptance', pos('commission-production-schedulers.mjs') < pos('deployed-acceptance-probe.mjs 2>&1')],
  ['fresh/resume end as an honest owner-bootstrap handoff', /database_mode == 'fresh' \|\| inputs\.database_mode == 'resume'/.test(w) && /BACKEND INSTALL COMPLETE — OWNER SETUP REQUIRED/.test(w) && /BOOTSTRAP_REQUIRED/.test(w)],
  ['known-partial recovery has its own protected mode and stops before function/scheduler/live mutation', /options: \[verify-only, recover-known-partial, fresh, resume, upgrade\]/.test(w) && /RECOVER KNOWN PARTIAL/.test(w) && /FUNCTION_DEPLOY_SKIPPED_RECOVERY_ONLY/.test(w) && /SCHEDULER_SKIPPED_RECOVERY_ONLY/.test(w) && /RECOVERY_ONLY/.test(w) && /KNOWN PARTIAL RECOVERY COMPLETE — RUN FRESH/.test(w)],
  ['exact-incident recovery contract and executable PostgreSQL rehearsal run before production database mutation', /partial-fresh-recovery\.test\.mjs/.test(w) && pos('partial-fresh-recovery.test.mjs') < pos('Apply or verify the database ledger') && /Rehearse the exact database install and ledger path on local PostgreSQL 17/.test(w) && /inputs\.database_mode != 'verify-only'/.test(w) && pos('Rehearse the exact database install and ledger path on local PostgreSQL 17') < pos('Apply or verify the database ledger')],
  ['identity-dependent live gates are skipped during fresh/resume/recovery', (w.match(/inputs\.database_mode != 'fresh' && inputs\.database_mode != 'resume' && inputs\.database_mode != 'recover-known-partial'/g) || []).length >= 3],
  ['production RLS uses an AAL2 owner and the existing low-role probe without a fake second store', /rls-production-smoke\.mjs/.test(w) && /OWNER_TOTP_SECRET:.*PRODUCTION_OWNER_TOTP_SECRET/.test(w) && /STAFF_EMAIL:.*PROBE_USER_EMAIL/.test(w) && !/MGR_A_TOTP_SECRET:/.test(w)],
  ['forms, Turnstile, CORS, direct email and outbox run after bootstrap', /public-form-rejection\.live\.mjs[\s\S]*turnstile-pairing\.live\.mjs[\s\S]*edge-cors\.live\.mjs[\s\S]*email-delivery\.live\.mjs[\s\S]*outbox-delivery\.live\.mjs/.test(w)],
  ['public-form live probes receive protected cleanup key', /SUPABASE_SERVICE_ROLE_KEY:.*secrets\.SUPABASE_SERVICE_ROLE_KEY/.test(w)],
  ['commissioning receipt created', /write-backend-commissioning-receipt\.mjs/.test(w)],
  ['evidence uploads even on failure', /if: always\(\)/.test(w)],
];

let passed = 0;
for (const [name, condition] of checks) {
  try { assert.equal(condition, true); passed += 1; console.log(`PASS ${name}`); }
  catch { console.error(`FAIL ${name}`); process.exitCode = 1; }
}
if (!process.exitCode) console.log(`BACKEND COMMISSIONING WORKFLOW — ${passed}/${checks.length} passed`);
