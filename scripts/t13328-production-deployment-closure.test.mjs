#!/usr/bin/env node
/** T13.3.28 — bounded first-production deployment closure. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));
let passed = 0, failed = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`); ok ? passed++ : failed++; };

const pkg = json('package.json');
const lock = json('package-lock.json');
const env = read('.env.example');
const schema = read('supabase/schema.FRESH-INSTALL-ONLY.sql');
const launch = read('launch/launch.sh');
const baseline = read('scripts/migration-baseline.test.sh');
const replay = read('scripts/upgrade-replay.test.sh');
const workflow = read('.github/workflows/commission-production-backend.yml');
const releaseWorkflow = read('.github/workflows/release.yml');
const deploymentReceipt = read('scripts/write-deployment-receipt.mjs');
const rls = read('scripts/rls-live.test.mjs');
const formProbe = read('scripts/public-form-rejection.live.mjs');
const formFixture = read('scripts/lib/public-form-live-fixture.mjs');
const captchaProbe = read('scripts/turnstile-pairing.live.mjs');
const secretVerifier = read('scripts/verify-supabase-secrets.mjs');
const productionInputs = read('scripts/lib/production-inputs.mjs');
const commissioningInputs = read('scripts/validate-production-commissioning-inputs.mjs');
const recovery = read('ops/RECOVER-PARTIAL-FRESH-T13.3.28.sql');
const hosting = read('docs/HOSTING.md');

check('current release retains the T13.3.28 deployment corrections', pkg.version === '4.10.15' && lock.version === '4.10.15' && /^VITE_RELEASE_IDENTITY=r4\.10\.15-t13\.3\.30-final-production-closure$/m.test(env));
check('T13.3.28 history is archived while T13.3.30 is current', fs.existsSync(path.join(ROOT, 'PRODUCTION-COMMISSIONING-T13.3.30.md')) && fs.existsSync(path.join(ROOT, 'docs/archive/commissioning/PRODUCTION-COMMISSIONING-T13.3.28.md')) && fs.existsSync(path.join(ROOT, 'docs/releases/T13.3.28-PRODUCTION-DEPLOYMENT-CLOSURE.md')));
check('T13.3.27 commissioning authority is preserved historically', fs.existsSync(path.join(ROOT, 'docs/archive/commissioning/PRODUCTION-COMMISSIONING-T13.3.27.md')));
check('fresh menu schema contains the seed-required availability field', /create table(?: if not exists)? menu_items[\s\S]*available\s+boolean\s+not null\s+default true/i.test(schema));
check('fresh schema and seed are applied in one psql transaction', /run_fresh_baseline_atomic[\s\S]*pg -q -1 -f "\$\{MP_FRESH_ONLY\[0\]\}" -f "\$\{MP_FRESH_ONLY\[1\]\}"/.test(launch));
check('baseline regression uses schema plus seed atomically', /MP_FRESH_ONLY\[0\][\s\S]*MP_FRESH_ONLY\[1\][\s\S]*psql[\s\S]*-1/.test(baseline));
check('upgrade replay proves a forced seed failure leaves no baseline state', /S0b[\s\S]*schema \+ seed were rolled back together/.test(replay) && /no public tables survive the failed baseline/.test(replay) && /no cvs bucket metadata survives the failed baseline/.test(replay) && /no migration ledger survives the failed baseline/.test(replay));
check('production commissioning is main-only and rehearses PostgreSQL before mutation', /SOURCE_REF[\s\S]*refs\/heads\/main/.test(workflow) && /Rehearse the exact database install and ledger path on local PostgreSQL 17/.test(workflow) && workflow.indexOf('Rehearse the exact database install') < workflow.indexOf('Apply or verify the database ledger'));
check('production commissioning refuses a stale committed release manifest before mutation', /SOURCE MANIFEST CURRENT PASS/.test(workflow) && /release-hash\.mjs --source \./.test(workflow) && /release-manifest\.json is stale for this source tree/.test(workflow) && workflow.indexOf('SOURCE MANIFEST CURRENT PASS') < workflow.indexOf('Apply or verify the database ledger'));
check('fresh mode ends as owner-setup handoff instead of running identity-dependent gates', /BACKEND INSTALL COMPLETE — OWNER SETUP REQUIRED/.test(workflow) && /inputs\.database_mode != 'fresh' && inputs\.database_mode != 'resume'/.test(workflow));
check('functional commissioning modes deploy the fixed public function list while recovery stays database-only', !/deploy_functions:/.test(workflow) && /bash launch\/deploy-public-functions\.sh/.test(workflow) && /inputs\.database_mode != 'recover-known-partial'/.test(workflow) && /FUNCTION_DEPLOY_SKIPPED_RECOVERY_ONLY/.test(workflow));
check('database commissioning no longer self-certifies live RLS', !/MP_CONFIRM_RLS_VERIFIED/.test(read('scripts/commission-database.sh')) && /Live role\/store verification remains a separate production commissioning gate/.test(launch));
check('live RLS requires privileged TOTP and has no deferred POS behaviour', /OWNER_TOTP_SECRET/.test(rls) && /MGR_A_TOTP_SECRET/.test(rls) && /aal2/.test(rls) && !/create_pos_pairing_code|pos_pairing_codes|pos_devices/.test(rls));
check('public-form and Turnstile probes use the current privacy-notice fixture', /getCurrentPrivacyNotice|buildContactProbe/.test(formProbe) && /getCurrentPrivacyNotice|buildContactProbe/.test(captchaProbe));
check('successful public-form probes remove their queued synthetic e-mail before the contact row', /notification_outbox\?entity_type=eq\.contact&entity_id=eq\./.test(formFixture) && formFixture.indexOf('notification_outbox?') < formFixture.indexOf('contact_messages?id=eq.'));
check('Turnstile probe describes server/client pairing without overstating browser E2E', /CAPTCHA pairing configured; browser E2E still required/.test(captchaProbe) && !/CAPTCHA active end-to-end/.test(captchaProbe));
check('production secret inventory requires the abuse HMAC secret', /ABUSE_HMAC_SECRET/.test(secretVerifier));
check('current deployment fails early on opaque Supabase keys until the separate key-model migration is done', /validateLegacyJwt\(env\.SUPABASE_ANON_KEY/.test(productionInputs) && /validateLegacyJwt\(env\.SUPABASE_SERVICE_ROLE_KEY/.test(productionInputs) && /legacy JWT-shaped key for this release/.test(productionInputs) && /validateCommissioningInputs/.test(commissioningInputs) && /validate-production-commissioning-inputs\.mjs/.test(workflow));
check('one-time recovery refuses real business/Auth/Storage state before cleanup', /mp_migration_ledger/.test(recovery) && /auth\.users/.test(recovery) && /storage\.objects/.test(recovery) && /storage\.buckets/.test(recovery) && /id = 'cvs' and name = 'cvs' and public is false/.test(recovery) && /raise exception/i.test(recovery));
check('GitHub database guidance names the Session Pooler path', /Session Pooler/.test(hosting) && /Session Pooler/.test(launch));
check('protected first frontend release does not require a nonexistent previous live site', /id: live_floor/.test(releaseWorkflow) && /FIRST_DEPLOY_NO_PREVIOUS_LIVE_SITE/.test(releaseWorkflow) && /first_deploy/.test(releaseWorkflow) && /not_applicable_first_deploy/.test(deploymentReceipt));

console.log(`\nT13.3.28 PRODUCTION DEPLOYMENT CLOSURE — ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
