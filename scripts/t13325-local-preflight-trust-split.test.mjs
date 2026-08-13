#!/usr/bin/env node
/** T13.3.25 — local preflight never requires the CI-held private signing key. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));
let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  ok ? passed++ : failed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'milkpop-t13325-'));
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const wrong = generateKeyPairSync('ed25519').privateKey;
const keyPath = path.join(tmp, 'key.pem');
const wrongPath = path.join(tmp, 'wrong.pem');
const policyPath = path.join(tmp, 'policy.json');
const evidencePath = path.join(ROOT, '.t13325-preflight-evidence.md');
fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(wrongPath, wrong.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(policyPath, JSON.stringify({
  key_purpose: 'production',
  key_id: 'test-only',
  ed25519_public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  approved_site_domain: 'milkpop.uk',
  approved_supabase_project_ref: 'abcdefghijklmnopqrst',
  minimum_release_number: 1,
}, null, 2));
fs.writeFileSync(evidencePath, '# test evidence\n');

const base = {
  ...process.env,
  MP_RELEASE_IDENTITY: 'r4.10.13-t13.3.25-local-preflight-trust-split',
  VITE_RELEASE_IDENTITY: 'r4.10.13-t13.3.25-local-preflight-trust-split',
  MP_RELEASE_NUMBER: '2',
  MP_GIT_COMMIT: '0123456789abcdef0123456789abcdef01234567',
  MP_SITE_DOMAIN: 'milkpop.uk',
  MP_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
  VITE_DEPLOYMENT_MODE: 'production',
  VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIn0.signature-test-value',
  SITE_URL: 'https://milkpop.uk',
  MP_EVIDENCE_DOC: '.t13325-preflight-evidence.md',
  MP_TRUST_POLICY: policyPath,
  TURNSTILE_SERVER_ENABLED: 'false',
  TURNSTILE_SECRET_SET: 'false',
  FORM_ALLOWED_ORIGINS_SET: 'true',
  CV_ALLOWED_ORIGINS_SET: 'true',
  EMAIL_ALLOWED_ORIGINS_SET: 'true',
  NOTIFICATION_RECIPIENT_SET: 'true',
  VITE_MEDIA_V2: 'false',
  MEDIA_BACKEND_READY: 'false',
  VITE_CAREERS_CV_UPLOAD: 'false',
  CAREERS_CV_E2E_PASSED: 'false',
  CV_SCANNER_ATTESTED: 'false',
  MEDIA_CLEANUP_ENABLED: 'false',
  RETENTION_INVARIANT_TESTS_PASSED: 'false',
  VITE_LEGACY_IMPORT: 'false',
  VITE_ALLOW_BACKENDLESS: 'false',
};
const run = (args = [], overrides = {}) => {
  const env = { ...base, ...overrides };
  if (overrides.MP_SIGNING_KEY === undefined) delete env.MP_SIGNING_KEY;
  const r = spawnSync(process.execPath, ['scripts/production-release-preflight.mjs', ...args], {
    cwd: ROOT, env, encoding: 'utf8',
  });
  return { code: r.status, text: `${r.stdout}\n${r.stderr}` };
};

try {
  const pkg = json('package.json');
  const lock = json('package-lock.json');
  const envExample = read('.env.example');
  const localWrapper = read('scripts/public-launch.mjs');
  const releaseWorkflow = read('.github/workflows/release.yml');
  const backendWorkflow = read('.github/workflows/commission-production-backend.yml');
  const publicGuide = read('PUBLIC-LAUNCH.md');
  const commissioning = read('docs/archive/commissioning/PRODUCTION-COMMISSIONING-T13.3.25.md');

  check('application version retains or advances beyond 4.10.13', pkg.version === '4.10.15' && lock.version === '4.10.15' && lock.packages?.['']?.version === '4.10.15');
  check('current release retains the T13.3.25 trust split', /VITE_RELEASE_IDENTITY=r4\.10\.15-t13\.3\.30-final-production-closure/.test(envExample));
  check('current T13.3.25 authority exists', fs.existsSync(path.join(ROOT, 'docs/archive/commissioning/PRODUCTION-COMMISSIONING-T13.3.25.md')));
  check('local wrapper retains CI key deferral', /--defer-ci-signing-key/.test(localWrapper));
  check('protected release workflow does not use the deferral flag', !/defer-ci-signing-key/.test(releaseWorkflow));

  let r = run(['--defer-ci-signing-key']);
  check('local production preflight passes without a private key', r.code === 0 && /deferred to the protected release workflow/.test(r.text), r.text.slice(-500));

  r = run();
  check('full production preflight still requires the private key', r.code !== 0 && /MP_SIGNING_KEY.*required value is missing/s.test(r.text), r.text.slice(-500));

  r = run(['--defer-ci-signing-key'], { MP_SIGNING_KEY: wrongPath });
  check('provided wrong private key still fails even in local mode', r.code !== 0 && /private\/public key mismatch/.test(r.text), r.text.slice(-500));

  r = run([], { MP_SIGNING_KEY: keyPath });
  check('full CI-style preflight passes with the matching key', r.code === 0 && /private signing key matches/.test(r.text), r.text.slice(-500));

  check('public guide explains the safe trust split', /deliberately defers the monotonic release number, commit hash and private signing-key verification/.test(publicGuide) && /protected GitHub release workflow/.test(publicGuide));
  check('commissioning authority explains CI-only private key verification', /does \*\*not\*\* request the production private signing key/.test(commissioning) && /protected GitHub `production` environment/.test(commissioning));
  check('backend functional mutating modes deploy the fixed 14-function public set while incident recovery never does',
    /Deploy the 14 public website and staff Edge Functions/.test(backendWorkflow)
    && /inputs\.database_mode != 'verify-only' && inputs\.database_mode != 'recover-known-partial'/.test(backendWorkflow)
    && /bash launch\/deploy-public-functions\.sh/.test(backendWorkflow)
    && /inputs\.database_mode == 'recover-known-partial'/.test(backendWorkflow)
    && /FUNCTION_DEPLOY_SKIPPED_RECOVERY_ONLY/.test(backendWorkflow));
} finally {
  fs.rmSync(evidencePath, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nT13.3.25 LOCAL PREFLIGHT TRUST SPLIT — ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
