#!/usr/bin/env node
/** T13.3.26 — local preflight is usable without CI-only metadata or secrets. */
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLocalPublicPreflightEnv } from './lib/public-preflight-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localFile = path.join(ROOT, '.env.production.local');
const policyFile = path.join(ROOT, '.t13326-policy.json');
const evidenceFile = path.join(ROOT, '.t13326-evidence.md');
const previousLocal = fs.existsSync(localFile) ? fs.readFileSync(localFile) : null;
let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  ok ? passed++ : failed++;
};

const { publicKey } = generateKeyPairSync('ed25519');
const projectRef = 'abcdefghijklmnopqrst';
const identity = 'r4.10.15-t13.3.30-final-production-closure';
const cleanProcessEnv = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  TMPDIR: process.env.TMPDIR ?? '',
};

try {
  fs.writeFileSync(policyFile, JSON.stringify({
    key_purpose: 'production',
    key_id: 't13326-test-only',
    ed25519_public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    approved_site_domain: 'milkpop.uk',
    approved_supabase_project_ref: projectRef,
    minimum_release_number: 1,
  }, null, 2));
  fs.writeFileSync(evidenceFile, '# local preflight fixture\n');
  fs.writeFileSync(localFile, [
    `MP_TRUST_POLICY=${path.basename(policyFile)}`,
    `MP_EVIDENCE_DOC=${path.basename(evidenceFile)}`,
    'VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.test-signature',
    'TURNSTILE_SERVER_ENABLED=false',
    'TURNSTILE_SECRET_SET=false',
    'FORM_ALLOWED_ORIGINS_SET=true',
    'CV_ALLOWED_ORIGINS_SET=true',
    'EMAIL_ALLOWED_ORIGINS_SET=true',
    'NOTIFICATION_RECIPIENT_SET=true',
    'VITE_MEDIA_V2=false',
    'MEDIA_BACKEND_READY=false',
    'VITE_CAREERS_CV_UPLOAD=false',
    'CAREERS_CV_E2E_PASSED=false',
    'CV_SCANNER_ATTESTED=false',
    'MEDIA_CLEANUP_ENABLED=false',
    'RETENTION_INVARIANT_TESTS_PASSED=false',
    'VITE_LEGACY_IMPORT=false',
    'VITE_ALLOW_BACKENDLESS=false',
    '',
  ].join('\n'));

  const env = loadLocalPublicPreflightEnv(ROOT, cleanProcessEnv);
  check('source-owned release identity is derived', env.MP_RELEASE_IDENTITY === identity && env.VITE_RELEASE_IDENTITY === identity, `${env.MP_RELEASE_IDENTITY} / ${env.VITE_RELEASE_IDENTITY}`);
  check('trust policy supplies domain and project ref', env.MP_SITE_DOMAIN === 'milkpop.uk' && env.MP_SUPABASE_PROJECT_REF === projectRef);
  check('public Supabase URL and canonical site URL are derived', env.VITE_SUPABASE_URL === `https://${projectRef}.supabase.co` && env.SITE_URL === 'https://milkpop.uk');
  check('local environment contains no CI release metadata or signing key', !env.MP_RELEASE_NUMBER && !env.MP_GIT_COMMIT && !env.MP_SIGNING_KEY);

  let result = spawnSync(process.execPath, [
    'scripts/production-release-preflight.mjs',
    '--defer-ci-signing-key',
    '--defer-ci-release-metadata',
  ], { cwd: ROOT, env, encoding: 'utf8' });
  let text = `${result.stdout}\n${result.stderr}`;
  check('local preflight passes from the non-secret local file alone', result.status === 0 && /release number verification is deferred/.test(text) && /git commit verification is deferred/.test(text), text.slice(-800));

  const opaqueKeyEnv = { ...env, VITE_SUPABASE_ANON_KEY: 'sb_publishable_test_value_not_a_secret' };
  result = spawnSync(process.execPath, [
    'scripts/production-release-preflight.mjs',
    '--defer-ci-signing-key',
    '--defer-ci-release-metadata',
  ], { cwd: ROOT, env: opaqueKeyEnv, encoding: 'utf8' });
  text = `${result.stdout}
${result.stderr}`;
  check('local preflight rejects an opaque publishable key in the legacy anon variable', result.status !== 0 && /legacy JWT contract/.test(text), text.slice(-500));

  result = spawnSync(process.execPath, ['scripts/production-release-preflight.mjs'], { cwd: ROOT, env, encoding: 'utf8' });
  text = `${result.stdout}\n${result.stderr}`;
  check('strict CI preflight still rejects missing release metadata and key', result.status !== 0 && /MP_RELEASE_NUMBER.*required value is missing/s.test(text) && /MP_GIT_COMMIT.*required value is missing/s.test(text) && /MP_SIGNING_KEY.*required value is missing/s.test(text), text.slice(-800));

  const placeholderEnv = { ...env, VITE_SUPABASE_ANON_KEY: 'REPLACE_WITH_PUBLIC_ANON_KEY' };
  result = spawnSync(process.execPath, [
    'scripts/production-release-preflight.mjs',
    '--defer-ci-signing-key',
    '--defer-ci-release-metadata',
  ], { cwd: ROOT, env: placeholderEnv, encoding: 'utf8' });
  text = `${result.stdout}\n${result.stderr}`;
  check('placeholder public key is rejected', result.status !== 0 && /not a template placeholder/.test(text), text.slice(-500));

  fs.appendFileSync(localFile, 'MP_SIGNING_KEY=/tmp/forbidden.pem\n');
  let rejected = false;
  try {
    loadLocalPublicPreflightEnv(ROOT, cleanProcessEnv);
  } catch (error) {
    rejected = /must not be stored in a local dotenv file/.test(String(error.message));
  }
  check('private signing key in local dotenv is rejected', rejected);
  fs.writeFileSync(localFile, fs.readFileSync(localFile, 'utf8').replace(/^MP_SIGNING_KEY=.*\n?/m, ''));

  rejected = false;
  try {
    loadLocalPublicPreflightEnv(ROOT, { ...cleanProcessEnv, MP_SIGNING_KEY: '/tmp/ambient-key.pem' });
  } catch (error) {
    rejected = /not accepted by local public preflight/.test(String(error.message));
  }
  check('ambient private signing key is also rejected by local preflight', rejected);

  const ambientMetadata = loadLocalPublicPreflightEnv(ROOT, {
    ...cleanProcessEnv,
    MP_RELEASE_NUMBER: '999',
    MP_GIT_COMMIT: 'deadbeef',
  });
  check('ambient CI release metadata is ignored locally', !ambientMetadata.MP_RELEASE_NUMBER && !ambientMetadata.MP_GIT_COMMIT);

  const wrapper = fs.readFileSync(path.join(ROOT, 'scripts/public-launch.mjs'), 'utf8');
  const guide = fs.readFileSync(path.join(ROOT, 'PUBLIC-LAUNCH.md'), 'utf8');
  const template = fs.readFileSync(path.join(ROOT, 'ops/public-preflight.env.example'), 'utf8');
  check('public wrapper defers both CI-only trust checks', /--defer-ci-signing-key/.test(wrapper) && /--defer-ci-release-metadata/.test(wrapper));
  check('operator guide names the one local non-secret template', /ops\/public-preflight\.env\.example/.test(guide) && /\.env\.production\.local/.test(guide));
  check('template contains no secret-value fields', !/^(?:MP_SIGNING_KEY|SUPABASE_SERVICE_ROLE_KEY|TURNSTILE_SECRET|RESEND_API_KEY)=/m.test(template));
} finally {
  if (previousLocal === null) fs.rmSync(localFile, { force: true });
  else fs.writeFileSync(localFile, previousLocal);
  fs.rmSync(policyFile, { force: true });
  fs.rmSync(evidenceFile, { force: true });
}

console.log(`\nT13.3.26 LOCAL PREFLIGHT CONFIG — ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
