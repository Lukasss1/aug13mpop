#!/usr/bin/env node
/* ============================================================================
 * MILK POP — OPT-01 CONTRACT CHECKS (deploy/config correctness & fail-closed launch)
 *
 * Locks the OPT-01 deliverables in place:
 *   A. launch/launch.sh delegates the COMPLETE launch set to the code-owned
 *      Edge Function inventory (incl. media-upload + media-cleanup, JWT ON) and runs the FULL `npm run verify` chain
 *      plus the env validator inside the final gate.
 *   B. supabase/config.toml is the source-controlled Verify-JWT record and
 *      AGREES with the code-owned inventory and the Gate-10 runbook.
 *   C. The deployment-environment validator actually enforces its rules —
 *      proven BEHAVIOURALLY by executing it against 15 env matrices.
 *   D. VITE_CAREERS_CV_UPLOAD is default-OFF in source.
 *   E. media-cleanup stays inert without MEDIA_CLEANUP_ENABLED=true, checked
 *      BEFORE any delete path (the carry-over blocker's guard).
 *   F. The baseline-migration and RLS-matrix suites are CI jobs.
 *   G. The shared CORS helper exists and is consistently used by every
 *      browser-reachable Edge Function, while worker-only functions emit no CORS.
 * ==========================================================================*/
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_FUNCTIONS, POS_FUNCTIONS } from './lib/edge-function-inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

let passed = 0, failed = 0;
const ok = (name) => { passed++; console.log(`✔ ${name}`); };
const bad = (name, detail) => { failed++; console.log(`✖ ${name}${detail ? `\n    ${detail}` : ''}`); };
const check = (name, cond, detail) => (cond ? ok(name) : bad(name, detail));

/* ---------------- A. launch driver ---------------------------------------- */
const launch = read('launch/launch.sh');
const publicDeploy = read('launch/deploy-public-functions.sh');
check('launch.sh delegates public/staff Edge Function publication to the canonical inventory-driven helper',
  /bash launch\/deploy-public-functions\.sh/.test(launch));
check('canonical deploy helper includes media-upload with JWT ON',
  PUBLIC_FUNCTIONS.some(([name, mode]) => name === 'media-upload' && mode === 'on'));
check('canonical deploy helper includes media-cleanup with JWT ON',
  PUBLIC_FUNCTIONS.some(([name, mode]) => name === 'media-cleanup' && mode === 'on'));
check('canonical helper maps JWT ON to ordinary deploy and JWT OFF to --no-verify-jwt',
  publicDeploy.includes('if [[ "$verify_mode" = "on" ]]')
    && publicDeploy.includes('supabase functions deploy "$fn" "${PROJECT_ARGS[@]}"')
    && publicDeploy.includes('elif [[ "$verify_mode" = "off" ]]')
    && publicDeploy.includes('--no-verify-jwt'));
{
  const publicNames = PUBLIC_FUNCTIONS.map(([name]) => name);
  const functionCount = publicNames.length;
  check(`public launch announces its ACTUAL deployed function count (${functionCount})`,
    functionCount === 14
      && publicDeploy.includes('FUNCTION_DEPLOY_PASS count=14')
      && launch.includes(`All ${functionCount} public website/staff Edge Functions deployed from the source-controlled inventory.`),
    `code-owned public inventory count: ${functionCount}`);
  check('deferred POS functions are absent from the public deploy set',
    POS_FUNCTIONS.every(([name]) => !publicNames.includes(name))
      && POS_FUNCTIONS.every(([name]) => !new RegExp(`functions deploy ["']?${name}`).test(publicDeploy)));
}
check('launch.sh warns that media-cleanup deploys INERT (flag stays unset)',
  /media-cleanup deploys INERT/.test(launch) && /MEDIA_CLEANUP_ENABLED=true function secret/.test(launch));
check('final gate runs the env validator first',
  /1\/5 deployment environment validation/.test(launch) && /npm run validate:env/.test(launch));
check('final gate runs the COMPLETE verify chain',
  /2\/5 full verification chain \(npm run verify\)/.test(launch) && /^\s*npm run verify\s*$/m.test(launch));
check('§4 documents the deployment mode + pairing markers',
  ['VITE_DEPLOYMENT_MODE=production', 'TURNSTILE_SERVER_ENABLED=true',
   'MEDIA_BACKEND_READY=true', 'CAREERS_CV_E2E_PASSED=true', 'MEDIA_CLEANUP_ENABLED']
    .every((s) => launch.includes(s)));

/* ---------------- B. config.toml agrees with the drivers ------------------- */
check('supabase/config.toml exists', existsSync(path.join(root, 'supabase/config.toml')));
const toml = read('supabase/config.toml');
const tomlJwt = {};
for (const m of toml.matchAll(/\[functions\.([a-z0-9-]+)\]\s*\nverify_jwt\s*=\s*(true|false)/g)) {
  tomlJwt[m[1]] = m[2] === 'true';
}
const EXPECTED = Object.fromEntries(
  [...PUBLIC_FUNCTIONS, ...POS_FUNCTIONS].map(([name, mode]) => [name, mode === 'on']),
);
check(`config.toml declares verify_jwt for all ${Object.keys(EXPECTED).length} functions`,
  Object.keys(EXPECTED).every((f) => f in tomlJwt) && Object.keys(tomlJwt).length === Object.keys(EXPECTED).length,
  `found: ${Object.keys(tomlJwt).join(', ')}`);
// R4.8 strengthening: no function may exist on disk without a declared
// verify_jwt mode — a new function directory can no longer ship undeclared.
{
  const onDisk = readdirSync(path.join(root, 'supabase/functions'))
    .filter((d) => d !== '_shared' && existsSync(path.join(root, 'supabase/functions', d, 'index.ts')));
  const undeclared = onDisk.filter((f) => !(f in tomlJwt));
  check('every Edge Function on disk has a declared verify_jwt mode', undeclared.length === 0, undeclared.join(', '));
}
check('config.toml verify_jwt map matches the intended matrix',
  Object.entries(EXPECTED).every(([f, v]) => tomlJwt[f] === v),
  Object.entries(EXPECTED).filter(([f, v]) => tomlJwt[f] !== v).map(([f]) => f).join(', '));
{
  // Cross-check the platform config against the code-owned deployment authority.
  const drift = [...PUBLIC_FUNCTIONS, ...POS_FUNCTIONS]
    .filter(([name, mode]) => tomlJwt[name] !== (mode === 'on'))
    .map(([name, mode]) => `${name}: toml=${tomlJwt[name]} inventory=${mode === 'on'}`);
  check('config.toml agrees with every code-owned function JWT mode', drift.length === 0, drift.join('; '));
}
{
  const runbook = read('docs/GATE10-RUNBOOK.md');
  const posOff = ['pos-pair', 'pos-ingest', 'pos-catalog'].every((fn) =>
    new RegExp(`deploy ${fn}\\s+--no-verify-jwt`).test(runbook) && tomlJwt[fn] === false);
  check('config.toml agrees with the Gate-10 runbook for the POS trio', posOff);
}

/* ---------------- C. env validator — BEHAVIOURAL matrix -------------------- */
const VALIDATOR = path.join(root, 'scripts/validate-deployment-env.mjs');
check('scripts/validate-deployment-env.mjs exists', existsSync(VALIDATOR));
const PAIR = {
  VITE_SUPABASE_URL: 'https://abc.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJ-anon-key',
};
// R4.8 (Workstreams D + E) tightened the definition of a COMPLETE production
// configuration: production must DECLARE the Turnstile server state and must
// record an exact-origin CORS allow-list for every browser-called function
// group. These markers therefore join the production fixture — the PASS cases
// below still assert exactly what they always did ("a complete production
// configuration passes"), under the current definition of complete. The new
// rules' fail-side is asserted immediately after the matrix (R4.8-1..4) and in
// scripts/r48-turnstile.test.ts, so nothing is merely relaxed.
const R48_PROD = {
  TURNSTILE_SERVER_ENABLED: 'false',
  FORM_ALLOWED_ORIGINS_SET: 'true',
  CV_ALLOWED_ORIGINS_SET: 'true',
  EMAIL_ALLOWED_ORIGINS_SET: 'true',
};
function runValidator(extraEnv) {
  const r = spawnSync(process.execPath, [VALIDATOR], {
    cwd: root,
    env: { PATH: process.env.PATH, ...extraEnv },  // hermetic: no ambient VITE_*
    encoding: 'utf8',
  });
  return r.status;
}
const cases = [
  ['production + complete Supabase pair PASSES',
    { VITE_DEPLOYMENT_MODE: 'production', ...PAIR, ...R48_PROD }, 0],
  ['production + URL without anon key FAILS',
    { VITE_DEPLOYMENT_MODE: 'production', VITE_SUPABASE_URL: PAIR.VITE_SUPABASE_URL }, 1],
  ['production + anon key without URL FAILS',
    { VITE_DEPLOYMENT_MODE: 'production', VITE_SUPABASE_ANON_KEY: PAIR.VITE_SUPABASE_ANON_KEY }, 1],
  ['production + NO Supabase config (silent backend-less) FAILS',
    { VITE_DEPLOYMENT_MODE: 'production' }, 1],
  // R4.5.1 hardening: production fails CLOSED with no override. The old
  // VITE_ALLOW_BACKENDLESS=true escape is itself an error in production.
  ['production backend-less FAILS even when "authorised" (no production override)',
    { VITE_DEPLOYMENT_MODE: 'production', VITE_ALLOW_BACKENDLESS: 'true' }, 1],
  ['production + Supabase pair + dangling VITE_ALLOW_BACKENDLESS=true FAILS',
    { VITE_DEPLOYMENT_MODE: 'production', ...PAIR, VITE_ALLOW_BACKENDLESS: 'true' }, 1],
  ['development backend-less still PASSES when explicitly authorised',
    { VITE_DEPLOYMENT_MODE: 'development', VITE_ALLOW_BACKENDLESS: 'true' }, 0],
  ['production + non-https Supabase URL FAILS',
    { VITE_DEPLOYMENT_MODE: 'production', VITE_SUPABASE_URL: 'http://abc.supabase.co', VITE_SUPABASE_ANON_KEY: PAIR.VITE_SUPABASE_ANON_KEY }, 1],
  ['production + Turnstile site key WITHOUT server marker FAILS',
    { VITE_DEPLOYMENT_MODE: 'production', ...PAIR, VITE_TURNSTILE_SITE_KEY: '0xAA' }, 1],
  ['production + Turnstile server marker WITHOUT site key FAILS',
    { VITE_DEPLOYMENT_MODE: 'production', ...PAIR, TURNSTILE_SERVER_ENABLED: 'true' }, 1],
  ['production + BOTH Turnstile halves PASSES',
    { VITE_DEPLOYMENT_MODE: 'production', ...PAIR, ...R48_PROD, VITE_TURNSTILE_SITE_KEY: '0xAA',
      TURNSTILE_SERVER_ENABLED: 'true', TURNSTILE_SECRET_SET: 'true' }, 0],
  ['a Turnstile SECRET under a VITE_ name FAILS',
    { VITE_DEPLOYMENT_MODE: 'production', ...PAIR, VITE_TURNSTILE_SECRET: 'sk-leak' }, 1],
  // R4.5.1 R5a/R5b/R5c: generalised secret-placement rules.
  ['ANY VITE_*SECRET name FAILS in every mode (R5a)',
    { VITE_DEPLOYMENT_MODE: 'development', VITE_PAYMENT_SECRET: 'x' }, 1],
  ['a VITE_*SERVICE_ROLE name FAILS (R5a)',
    { VITE_DEPLOYMENT_MODE: 'development', VITE_SUPABASE_SERVICE_ROLE_KEY: 'x' }, 1],
  ['a Supabase sb_secret_ VALUE under a VITE_ name FAILS (R5b)',
    { VITE_DEPLOYMENT_MODE: 'development', VITE_SOME_KEY: 'sb_secret_abcdefghijkl' }, 1],
  ['a service_role JWT VALUE under a VITE_ name FAILS (R5b)',
    { VITE_DEPLOYMENT_MODE: 'development',
      VITE_SOME_KEY: 'eyJhbGciOiJIUzI1NiJ9.' +
        Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url') +
        '.c2lnbmF0dXJl' }, 1],
  ['a PEM private-key VALUE under a VITE_ name FAILS (R5b)',
    { VITE_DEPLOYMENT_MODE: 'development', VITE_SOME_KEY: '-----BEGIN RSA PRIVATE KEY-----' }, 1],
  ['the anon-role JWT VALUE under a VITE_ name still PASSES (R5b is role-aware)',
    { VITE_DEPLOYMENT_MODE: 'development',
      VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.' +
        Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url') +
        '.c2lnbmF0dXJl' }, 0],
  ['TURNSTILE_SECRET present in the production build env FAILS (R5c)',
    { VITE_DEPLOYMENT_MODE: 'production', ...PAIR, TURNSTILE_SECRET: 'real-secret' }, 1],
  ['SUPABASE_SERVICE_ROLE_KEY present in the production build env FAILS (R5c)',
    { VITE_DEPLOYMENT_MODE: 'production', ...PAIR, SUPABASE_SERVICE_ROLE_KEY: 'x' }, 1],
  // R4.5.1 R10: release/deploy invocations pin the mode to production.
  ['MP_REQUIRE_PRODUCTION_MODE=1 under development FAILS (R10)',
    { VITE_DEPLOYMENT_MODE: 'development', MP_REQUIRE_PRODUCTION_MODE: '1' }, 1],
  ['MP_REQUIRE_PRODUCTION_MODE=1 under production with the pair PASSES (R10)',
    { VITE_DEPLOYMENT_MODE: 'production', MP_REQUIRE_PRODUCTION_MODE: '1', ...PAIR, ...R48_PROD }, 0],
  // R4.5.1 R8: cleanup enablement now pairs with the retention-proof marker.
  ['MEDIA_CLEANUP_ENABLED=true WITH RETENTION_INVARIANT_TESTS_PASSED=true PASSES (R8)',
    { VITE_DEPLOYMENT_MODE: 'production', ...PAIR,
      ...R48_PROD, MEDIA_CLEANUP_ENABLED: 'true', RETENTION_INVARIANT_TESTS_PASSED: 'true' }, 0],
  ['production + VITE_MEDIA_V2 without MEDIA_BACKEND_READY FAILS',
    { VITE_DEPLOYMENT_MODE: 'production', ...PAIR, VITE_MEDIA_V2: 'true' }, 1],
  ['production + VITE_MEDIA_V2 WITH MEDIA_BACKEND_READY PASSES',
    { VITE_DEPLOYMENT_MODE: 'production', ...PAIR, ...R48_PROD, VITE_MEDIA_V2: 'true', MEDIA_BACKEND_READY: 'true' }, 0],
  ['production + VITE_CAREERS_CV_UPLOAD without its E2E marker FAILS',
    { VITE_DEPLOYMENT_MODE: 'production', ...PAIR, VITE_CAREERS_CV_UPLOAD: 'true' }, 1],
  ['development mode with nothing set PASSES (advisory only)',
    {}, 0],
  ['an unknown deployment mode FAILS in every mode (no silent softening)',
    { VITE_DEPLOYMENT_MODE: 'prod', ...PAIR }, 1],
];
for (const [name, env, want] of cases) {
  const got = runValidator(env);
  check(`validator: ${name}`, got === want, `exit=${got}, expected ${want}`);
}
check('prebuild hook runs the validator on every build', (() => {
  const pkg = JSON.parse(read('package.json'));
  return pkg.scripts.prebuild === 'node scripts/validate-deployment-env.mjs'
      && pkg.scripts['validate:env'] === 'node scripts/validate-deployment-env.mjs';
})());
check('verify chain includes the OPT-01 contract test', (() => {
  const pkg = JSON.parse(read('package.json'));
  return /npm run test:opt01/.test(pkg.scripts.verify);
})());

/* ---------------- D. CV upload flag default-off ---------------------------- */
const flags = read('src/lib/featureFlags.ts');
check('CAREERS_CV_UPLOAD is strict opt-in (=== \'true\')',
  /CAREERS_CV_UPLOAD = String\(import\.meta\.env\.VITE_CAREERS_CV_UPLOAD \|\| ''\)\.trim\(\) === 'true'/.test(flags));
check('no feature flag defaults itself on with ?? \'true\'',
  !flags.includes("?? 'true'"));

/* ---------------- E. cleanup stays inert without its flag ------------------ */
const cleanup = read('supabase/functions/media-cleanup/index.ts');
{
  const gateAt = cleanup.indexOf("MEDIA_CLEANUP_ENABLED");
  const firstDelete = cleanup.indexOf('storageDelete');
  check('media-cleanup checks MEDIA_CLEANUP_ENABLED before ANY delete path',
    gateAt > -1 && firstDelete > -1 && gateAt < firstDelete,
    `flag@${gateAt} delete@${firstDelete}`);
  check('the cleanup gate is strict (!== \'true\' refuses)',
    /MEDIA_CLEANUP_ENABLED'\) \|\| ''\)\.trim\(\) !== 'true'/.test(cleanup));
}

/* ---------------- F. CI gates ---------------------------------------------- */
const ci = read('.github/workflows/security.yml');
check('CI runs the migration baseline on real PostgreSQL',
  /migration-baseline:/.test(ci) && /npm run test:baseline/.test(ci));
check('CI runs the RLS matrix on real PostgreSQL',
  /rls-matrix:/.test(ci) && /npm run test:rls-local/.test(ci));

/* ---------------- G. shared CORS helper: contained adoption ---------------- */
check('supabase/functions/_shared/cors.ts exists',
  existsSync(path.join(root, 'supabase/functions/_shared/cors.ts')));
check('media-upload uses the shared CORS helper',
  read('supabase/functions/media-upload/index.ts').includes("from '../_shared/cors.ts'"));
check('media-cleanup uses the shared CORS helper',
  cleanup.includes("from '../_shared/cors.ts'"));
// R4.8 SUPERSEDES the OPT-01 containment decision (Workstream E requires ONE
// shared implementation used by ALL functions). The assertion is inverted and
// STRENGTHENED: every function must use the shared builder, and no local
// wildcard fallback may survive anywhere.
{
  const dirs = readdirSync(path.join(root, 'supabase/functions'))
    .filter((d) => d !== '_shared' && existsSync(path.join(root, 'supabase/functions', d, 'index.ts')));
  // A function is compliant if it EITHER delegates to the shared builder, OR
  // has no browser surface at all — in which case it must emit NO CORS headers
  // whatsoever (a worker that answered CORS would be a browser surface).
  const NO_BROWSER_SURFACE = ['outbox-dispatch'];   // scheduler-invoked, service-role only
  const notShared = dirs.filter((d) => !NO_BROWSER_SURFACE.includes(d)
    && !read(`supabase/functions/${d}/index.ts`).includes("_shared/cors.ts"));
  check('EVERY browser-reachable Edge Function uses the shared CORS builder (R4.8 E)',
    notShared.length === 0, notShared.join(', '));
  const leaky = NO_BROWSER_SURFACE.filter((d) => /Access-Control-Allow/i.test(read(`supabase/functions/${d}/index.ts`)));
  check('no-browser-surface workers emit NO CORS headers at all', leaky.length === 0, leaky.join(', '));
  const localWildcard = dirs.filter((d) => /allowOrigin\s*=\s*'\*'/.test(read(`supabase/functions/${d}/index.ts`)));
  check('no function retains a local wildcard CORS fallback', localWildcard.length === 0, localWildcard.join(', '));
  const shared = read('supabase/functions/_shared/cors.ts');
  check('the shared builder fails closed in production (no * fallback)',
    /isProd/.test(shared) && /misconfigured/.test(shared) && !/if \(isProd\)[\s\S]{0,120}'\*'/.test(shared));
}

/* ================= OPT-01.1 CORRECTION PACKAGE ============================= */

/* H. Automatic deployment-mode detection (validator + netlify.toml) --------- */
/* ---- R4.8 fail-side: each new production requirement is load-bearing ------ */
{
  const drop = (k) => { const e = { VITE_DEPLOYMENT_MODE: 'production', ...PAIR, ...R48_PROD }; delete e[k]; return e; };
  check('R4.8-1 validator: production WITHOUT a declared Turnstile state FAILS',
    runValidator(drop('TURNSTILE_SERVER_ENABLED')) === 1);
  check('R4.8-2 validator: production WITHOUT the form CORS allow-list FAILS',
    runValidator(drop('FORM_ALLOWED_ORIGINS_SET')) === 1);
  check('R4.8-3 validator: production WITHOUT the CV/staff CORS allow-list FAILS',
    runValidator(drop('CV_ALLOWED_ORIGINS_SET')) === 1);
  check('R4.8-4 validator: production WITHOUT the e-mail CORS allow-list FAILS',
    runValidator(drop('EMAIL_ALLOWED_ORIGINS_SET')) === 1);
  check('R4.8-5 validator: CV upload without the malware-scanner attestation FAILS',
    runValidator({ VITE_DEPLOYMENT_MODE: 'production', ...PAIR, ...R48_PROD,
      VITE_CAREERS_CV_UPLOAD: 'true', CAREERS_CV_E2E_PASSED: 'true' }) === 1);
}

const netlifyCases = [
  ['Netlify CONTEXT=production auto-arms production (pair present) PASSES',
    { NETLIFY: 'true', CONTEXT: 'production', ...PAIR, ...R48_PROD }, 0],
  ['Netlify CONTEXT=production auto-arms production — missing pair FAILS',
    { NETLIFY: 'true', CONTEXT: 'production' }, 1],
  ['Netlify deploy-preview resolves to preview (advisory) PASSES',
    { NETLIFY: 'true', CONTEXT: 'deploy-preview' }, 0],
  ['Netlify branch-deploy resolves to preview (advisory) PASSES',
    { NETLIFY: 'true', CONTEXT: 'branch-deploy' }, 0],
  ['contradiction: Netlify production + explicit preview FAILS',
    { NETLIFY: 'true', CONTEXT: 'production', VITE_DEPLOYMENT_MODE: 'preview', ...PAIR }, 1],
  ['MEDIA_CLEANUP_ENABLED=true FAILS readiness even in development',
    { VITE_DEPLOYMENT_MODE: 'development', MEDIA_CLEANUP_ENABLED: 'true' }, 1],
];
for (const [name, env, want] of netlifyCases) {
  const got = runValidator(env);
  check(`validator: ${name}`, got === want, `exit=${got}, expected ${want}`);
}

const nt = read('netlify.toml');
check('netlify.toml pins production context → VITE_DEPLOYMENT_MODE="production"',
  /\[context\.production\.environment\][\s\S]*?VITE_DEPLOYMENT_MODE\s*=\s*"production"/.test(nt));
check('netlify.toml pins deploy-preview → "preview"',
  /\[context\.deploy-preview\.environment\][\s\S]*?VITE_DEPLOYMENT_MODE\s*=\s*"preview"/.test(nt));
check('netlify.toml pins branch-deploy → "preview"',
  /\[context\.branch-deploy\.environment\][\s\S]*?VITE_DEPLOYMENT_MODE\s*=\s*"preview"/.test(nt));

/* I. .env.example matches the OPT-01 contract ------------------------------- */
const envex = read('.env.example');
const kv = (k, v) => new RegExp(`^${k}=${v}\\s*$`, 'm').test(envex);
check('.env.example: VITE_CAREERS_CV_UPLOAD default OFF', kv('VITE_CAREERS_CV_UPLOAD', 'false'));
check('.env.example: VITE_MEDIA_V2 default OFF', kv('VITE_MEDIA_V2', 'false'));
check('.env.example: TURNSTILE_SERVER_ENABLED default false (attestation, not the secret)',
  kv('TURNSTILE_SERVER_ENABLED', 'false'));
check('.env.example: VITE_ALLOW_BACKENDLESS default false', kv('VITE_ALLOW_BACKENDLESS', 'false'));
check('.env.example: documents VITE_DEPLOYMENT_MODE', /^VITE_DEPLOYMENT_MODE=/m.test(envex));
check('.env.example: NO Turnstile SECRET under a VITE_ name',
  !/^VITE_[A-Z0-9_]*TURNSTILE[A-Z0-9_]*SECRET/m.test(envex));
check('.env.example: states TURNSTILE_SERVER_ENABLED is an attestation, not the secret',
  /attestation/i.test(envex) && /never use a VITE_ prefix/i.test(envex));

/* J. Safe database paths (fresh vs upgrade; no unproven CLI verb) ----------- */
check('launch.sh exposes --db-fresh', /--db-fresh\)/.test(launch));
check('launch.sh exposes --db-upgrade', /--db-upgrade\)/.test(launch));
check('launch.sh REJECTS the ambiguous bare --db', /--db\)\s+die /.test(launch));
check('launch.sh does NOT use the unproven `supabase db execute`',
  !/supabase db execute/.test(launch));
check('launch.sh applies SQL via psql with ON_ERROR_STOP=1 and keeps credentials out of argv (OPT-01.2 §8)',
  /psql -v ON_ERROR_STOP=1 -X/.test(launch) && !/psql "\$SUPABASE_DB_URL"/.test(launch));
check('launch.sh upgrade path states it never runs schema/seed and never replays history',
  /schema\.FRESH-INSTALL-ONLY\.sql and seed\.sql were NOT run/.test(launch) && /NEVER runs/.test(launch) && /no history replayed/.test(launch));
check('launch.sh --db-fresh refuses a non-empty target',
  /db_target_empty/.test(launch) && /NOT a brand-new empty project/.test(launch));
check('launch.sh --db-fresh requires a destructive confirmation phrase',
  /ERASE AND INSTALL/.test(launch));
check('launch.sh --db-upgrade requires a backup confirmation',
  /BACKED UP/.test(launch) && /BACK UP FIRST/.test(launch));

/* K. Media-cleanup deployment readiness gate ------------------------------- */
check('launch.sh gates deploy on MEDIA_CLEANUP_ENABLED absence (readiness)',
  /supabase secrets list/.test(launch) && /MEDIA_CLEANUP_ENABLED/.test(launch) && /READINESS FAILED/.test(launch));

/* L. One authoritative migration manifest, consumed everywhere -------------- */
check('launch/migration-manifest.sh exists',
  existsSync(path.join(root, 'launch/migration-manifest.sh')));
check('launch.sh SOURCES the manifest (no private migration array)',
  /source "\$SCRIPT_DIR\/migration-manifest\.sh"/.test(launch) && !/^MIGRATIONS=\(/m.test(launch));
check('baseline test SOURCES the manifest',
  /source launch\/migration-manifest\.sh/.test(read('scripts/migration-baseline.test.sh')));
check('rls-matrix reads the manifest (not a launch.sh parse)',
  /migration-manifest\.sh/.test(read('scripts/rls-matrix.local.mjs'))
    && !/launch\/launch\.sh'/.test(read('scripts/rls-matrix.local.mjs')));
check('the manifest integrity test is wired into `npm run verify`',
  /npm run test:manifest/.test(read('package.json')));

/* M. CI runs the COMPLETE verify chain; no silent skips --------------------- */
const ciFile = existsSync(path.join(root, '.github/workflows/security.yml'))
  ? read('.github/workflows/security.yml') : '';
check('CI has a job running the full `npm run verify`',
  /npm ci/.test(ciFile) && /npm run verify\b/.test(ciFile));
check('CI keeps the PostgreSQL baseline + rls-local jobs',
  /npm run test:baseline/.test(ciFile) && /npm run test:rls-local/.test(ciFile));
check('CI workflow has NO continue-on-error',
  !/continue-on-error/i.test(ciFile));

/* ---------------- summary --------------------------------------------------*/
console.log(`\nOPT-01 / OPT-01.1 CONTRACT CHECKS — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
