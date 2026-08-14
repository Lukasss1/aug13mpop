#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createPublicKey } from 'node:crypto';
import {
  EDGE_FUNCTIONS,
  PUBLIC_FUNCTIONS,
  POS_FUNCTIONS,
  assertExactEdgeFunctionInventory,
} from './lib/edge-function-inventory.mjs';
import {
  RELEASE_SECRET_NAMES,
  COMMISSIONING_ACCEPTANCE_SECRET_NAMES,
} from './lib/production-inputs.mjs';

const ROOT = process.cwd();
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0;
const check = (name, ok) => { assert.equal(Boolean(ok), true, name); passed++; console.log(`✓ ${name}`); };

const env = read('.env.example');
const release = read('.github/workflows/release.yml');
const commission = read('.github/workflows/commission-production-backend.yml');
const deploy = read('launch/deploy-public-functions.sh');
const restore = read('scripts/restore-public-functions-from-git.sh');
const floor = read('scripts/check-live-release-floor.mjs');
const seal = read('scripts/release-seal.sh');
const manifestWriter = read('scripts/generate-release-manifest.mjs');
const setWriter = read('scripts/write-release-set.mjs');
const materializer = read('scripts/materialize-verified-dist.mjs');
const migrationManifest = read('launch/migration-manifest.sh');
const p0Gate = read('scripts/p0-source-gates.mjs');
const trust = JSON.parse(read('ops/milkpop-trust-policy.json'));

check('source-owned final identity is T13.3.30',
  /^VITE_RELEASE_IDENTITY=r4\.10\.15-t13\.3\.30-final-production-closure$/m.test(env));
check('production trust anchor is final and target-bound', (() => {
  try {
    const key = createPublicKey(trust.ed25519_public_key_pem);
    return trust.key_purpose === 'production'
      && trust.approved_site_domain === 'milkpop.uk'
      && trust.approved_supabase_project_ref === 'upvbfscpfpkwiuuaplhu'
      && trust.minimum_release_number === 1
      && key.asymmetricKeyType === 'ed25519'
      && !JSON.stringify(trust).includes('REPLACE-WITH');
  } catch { return false; }
})());
check('active launch guide never instructs the operator to rewrite the sealed trust anchor',
  /Verify `ops\/milkpop-trust-policy\.json` already pins/.test(read('PUBLIC-LAUNCH.md'))
    && /Do \*\*not\*\* edit the sealed trust anchor during release/.test(read('PUBLIC-LAUNCH.md'))
    && !/Replace the placeholders in `ops\/milkpop-trust-policy\.json`/.test(read('PUBLIC-LAUNCH.md')));
check('Netlify production auto-publishing is locked before the final production-branch push and API publishing remains allowed',
  /Before pushing the final production source[\s\S]*stop auto publishing/.test(read('PUBLIC-LAUNCH.md'))
    && /Enforce Git-based deployments\*\* setting off/.test(read('PUBLIC-LAUNCH.md'))
    && /before the final production-branch push/.test(read('PRODUCTION-COMMISSIONING-T13.3.30.md'))
    && /must remain disabled afterwards/.test(read('PRODUCTION-COMMISSIONING-T13.3.30.md'))
    && /Before the final production-branch push[\s\S]*lock Netlify production auto-publishing/.test(read('docs/COMMISSIONING-CHECKLIST.md'))
    && /Enforce Git-based deployments/.test(read('docs/COMMISSIONING-CHECKLIST.md')));
check('first production release requires a directly reachable exact HTTPS 404 marker state',
  /milkpop\.uk\/\.well-known\/milkpop-release\.json[\s\S]*HTTP 404[\s\S]*no redirect/.test(read('PUBLIC-LAUNCH.md'))
    && /milkpop\.uk\/\.well-known\/milkpop-release\.json[\s\S]*exact HTTP `404`[\s\S]*without redirecting/.test(read('PRODUCTION-COMMISSIONING-T13.3.30.md'))
    && /releaseNumber !== 1/.test(floor)
    && /response\.status === 404/.test(floor)
    && /redirect: 'error'/.test(floor));
check('production release has one human initiation path only',
  /on:\n {2}workflow_dispatch:/.test(release)
    && !/\n {2}push:\n/.test(release)
    && !/if \[ -z "\$N" \]; then N=/.test(release));
check('production release runs the complete canonical verify chain before any deployment mutation',
  /Run the complete locked source verification for this exact release commit[\s\S]*npm run verify/.test(release)
    && release.indexOf('npm run verify') < release.indexOf('Verify the live production database exactly matches this source')
    && release.indexOf('npm run verify') < release.indexOf('Seal — ONE production build'));
const workflowFiles = readdirSync('.github/workflows').filter((name) => name.endsWith('.yml'));
const workflowText = workflowFiles.map((name) => read(`.github/workflows/${name}`)).join('\n');
check('GitHub workflow OS baseline is pinned to Ubuntu 24.04 rather than a moving latest alias',
  workflowFiles.length > 0
    && !/runs-on:\s*ubuntu-latest/.test(workflowText)
    && workflowFiles.every((name) => /runs-on:\s*ubuntu-24\.04/.test(read(`.github/workflows/${name}`))));
check('production database proof and backup tooling are aligned to hosted PostgreSQL 17',
  /install-postgresql-17\.sh/.test(read('.github/workflows/commission-production-backend.yml'))
    && /install-postgresql-17\.sh/.test(read('.github/workflows/release.yml'))
    && /PostgreSQL 17 pg_dump is required/.test(read('scripts/backup-export.sh'))
    && /PostgreSQL 17 pg_restore is required/.test(read('scripts/restore-verify.sh'))
    && !/PostgreSQL 16/.test(read('PRODUCTION-COMMISSIONING-T13.3.30.md')));


const obsoleteIdentityNames = [
  'RLS_OWNER_EMAIL', 'RLS_OWNER_PASSWORD', 'RLS_OWNER_TOTP_SECRET',
  'PRODUCTION_SMOKE_OWNER_EMAIL', 'PRODUCTION_SMOKE_OWNER_PASSWORD', 'PRODUCTION_SMOKE_OWNER_TOTP_SECRET',
  'EMAIL_TEST_USER_EMAIL', 'EMAIL_TEST_USER_PASSWORD',
];
const activeIdentityText = [release, commission, read('scripts/lib/production-inputs.mjs'), read('scripts/email-delivery.live.mjs'), read('scripts/edge-cors.live.mjs'), read('scripts/outbox-delivery.live.mjs')].join('\n');
check('production identities are founder-minimal: one owner plus one low-role probe',
  ['PRODUCTION_OWNER_EMAIL', 'PRODUCTION_OWNER_PASSWORD', 'PRODUCTION_OWNER_TOTP_SECRET', 'PROBE_USER_EMAIL', 'PROBE_USER_PASSWORD']
    .every((name) => RELEASE_SECRET_NAMES.includes(name))
    && ['PRODUCTION_OWNER_EMAIL', 'PRODUCTION_OWNER_PASSWORD', 'PRODUCTION_OWNER_TOTP_SECRET', 'PROBE_USER_EMAIL', 'PROBE_USER_PASSWORD']
      .every((name) => COMMISSIONING_ACCEPTANCE_SECRET_NAMES.includes(name))
    && obsoleteIdentityNames.every((name) => !activeIdentityText.includes(name)));
check('only one verified-dist materializer is active',
  existsSync('scripts/materialize-verified-dist.mjs')
    && !existsSync('scripts/extract-verified-deploy.mjs')
    && /materialize-verified-dist\.mjs/.test(release));

const recoveryFiles = readdirSync('ops').filter((name) => /^RECOVER-PARTIAL-FRESH.*\.sql$/.test(name));
check('one canonical one-time partial-fresh recovery SQL exists',
  recoveryFiles.length === 1 && recoveryFiles[0] === 'RECOVER-PARTIAL-FRESH-T13.3.28.sql');
check('known-partial recovery is database-only and independent of Edge Function provider secrets',
  /COMMISSIONING_RECOVERY_SECRET_NAMES/.test(read('scripts/lib/production-inputs.mjs'))
    && /SUPABASE SECRET INVENTORY SKIPPED RECOVERY ONLY/.test(commission)
    && /inputs\.database_mode != 'recover-known-partial'/.test(commission));

check('known-partial recovery is a protected terminal commissioning mode',
  /recover-known-partial/.test(commission)
    && /RECOVER KNOWN PARTIAL/.test(commission)
    && /KNOWN PARTIAL RECOVERY COMPLETE — RUN FRESH/.test(commission));
check('known live Supabase RLS auto-enable safety pair is exact-validated and preserved across recovery/fresh',
  /rls_auto_enable\(\)\/ensure_rls/.test(read('ops/RECOVER-PARTIAL-FRESH-T13.3.28.sql'))
    && /db_rls_auto_enable_safety_state/.test(read('launch/launch.sh'))
    && /RLS auto-enable safety helper mismatch/.test(read('launch/launch.sh'))
    && /fresh accepts and preserves the exact Supabase RLS safety pair/.test(read('scripts/upgrade-replay.test.sh')));
check('legacy pre-ledger adoption is retained internally but hidden from the normal owner workflow',
  /options: \[verify-only, recover-known-partial, fresh, resume, upgrade\]/.test(commission)
    && !/adopt\) EXPECT=/.test(commission)
    && /--db-adopt-ledger/.test(read('launch/launch.sh'))
    && existsSync('scripts/pre-ledger-adopt.test.sh'));

const functionDirs = readdirSync('supabase/functions')
  .filter((name) => name !== '_shared' && statSync(path.join('supabase/functions', name)).isDirectory())
  .sort();
assertExactEdgeFunctionInventory(functionDirs, 'source Edge Function directories');
check('v0.1 function topology remains exactly 17 source / 14 public-staff / 3 deferred POS',
  EDGE_FUNCTIONS.length === 17 && PUBLIC_FUNCTIONS.length === 14 && POS_FUNCTIONS.length === 3);
check('function deployment consumes the code-owned inventory instead of a duplicate literal list',
  /PUBLIC_FUNCTIONS/.test(deploy)
    && !/^deploy\s+[a-z0-9-]+\s+(?:on|off)(?:\s|$)/m.test(deploy)
    && /PUBLIC_FUNCTION_SET_SOURCE/.test(deploy));
check('deferred POS functions are never named as deploy commands',
  !/functions deploy pos-(?:pair|ingest|catalog)|deploy pos-(?:pair|ingest|catalog)/.test(deploy));

check('signed frontend marker carries the aggregate public-backend identity',
  /public_function_set_sha256/.test(seal)
    && /public_function_set_sha256/.test(manifestWriter)
    && /public_function_set_sha256/.test(setWriter)
    && /public_function_set_sha256/.test(materializer));
check('unchanged signed backend can skip Supabase mutation',
  /decide-public-function-deploy\.mjs/.test(release)
    && /FUNCTION_DEPLOY_SKIPPED_UNCHANGED/.test(release));
check('backend rollback is bound to exact predecessor commit and backend fingerprint',
  /\^\[a-f0-9\]\{40\}\$/.test(restore)
    && /\^\[a-f0-9\]\{64\}\$/.test(restore)
    && /merge-base --is-ancestor/.test(restore)
    && /does not match trusted live marker/.test(restore));
check('release workflow restores predecessor functions on partial, pre-publication and post-publication failure paths',
  /partial deployment failure/.test(release)
    && /failed pre-publication backend proof/.test(release)
    && /failed post-publication proof/.test(release)
    && (release.match(/restore-public-functions-from-git\.sh/g) || []).length >= 3);
check('first-deploy bypass cannot survive beyond release 1',
  /releaseNumber !== 1/.test(floor) && /only for release_number=1/.test(floor));

const sqlEntries = [...migrationManifest.matchAll(/"(supabase\/[^"]+\.sql)"/g)].map((m) => m[1]);
check('database chain remains frozen at 107 migrations / 109 SQL entries',
  sqlEntries.filter((p) => /\/migration_/.test(p)).length === 107 && sqlEntries.length === 109);
check('incident recovery is not part of the migration ledger',
  !sqlEntries.some((p) => /RECOVER-PARTIAL-FRESH/.test(p)));
check('live acceptance readiness fails before production mutation in commissioning and release',
  /validateLiveAcceptanceReadiness/.test(read('scripts/lib/production-inputs.mjs'))
    && /VITE_TURNSTILE_SITE_KEY:\s*\$\{\{ vars\.VITE_TURNSTILE_SITE_KEY \}\}/.test(commission)
    && /VITE_TURNSTILE_SITE_KEY:\s*\$\{\{ vars\.VITE_TURNSTILE_SITE_KEY \}\}/.test(release)
    && /FORM_ALLOWED_ORIGINS_SET:\s*\$\{\{ vars\.FORM_ALLOWED_ORIGINS_SET \}\}/.test(commission)
    && /NOTIFICATION_RECIPIENT_SET:\s*\$\{\{ vars\.NOTIFICATION_RECIPIENT_SET \}\}/.test(commission));

check('P0 umbrella retains the full-verify contracts that caught final-closure drift',
  /write-backend-commissioning-receipt\.test\.mjs/.test(p0Gate)
    && /opt01-contract\.test\.mjs/.test(p0Gate)
    && /t13324-public-deployment-handoff\.test\.mjs/.test(p0Gate));
check('first-owner bootstrap authority is current and the staff-auth help points to it',
  /bootstrap_owner\('OWNER_EMAIL_HERE', 'OWNER_NAME_HERE'\)/.test(read('PRODUCTION-COMMISSIONING-T13.3.30.md'))
    && /link_staff_profile\(\)/.test(read('PRODUCTION-COMMISSIONING-T13.3.30.md'))
    && /https:\/\/milkpop\.uk\/staff`/.test(read('PRODUCTION-COMMISSIONING-T13.3.30.md'))
    && /https:\/\/milkpop\.uk\/staff\/`/.test(read('PRODUCTION-COMMISSIONING-T13.3.30.md'))
    && /PRODUCTION-COMMISSIONING-T13\.3\.30\.md/.test(read('src/components/staff/StaffAuthPanel.tsx'))
    && !/OWNERS-GUIDE\.md<\/span> step 6/.test(read('src/components/staff/StaffAuthPanel.tsx')));

console.log(`\nT13.3.30 final closure invariants: ${passed}/${passed} passed`);
