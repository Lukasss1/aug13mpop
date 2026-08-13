#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/production-release-preflight.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'milkpop-release-preflight-'));
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const keyPath = path.join(tmp, 'key.pem');
const otherPath = path.join(tmp, 'other.pem');
const policyPath = path.join(tmp, 'policy.json');
fs.writeFileSync(keyPath, privatePem, { mode: 0o600 });
fs.writeFileSync(otherPath, other, { mode: 0o600 });
fs.writeFileSync(path.join(root, '.preflight-test-evidence.md'), '# preflight fixture\n');

const ref = 'abcdefghijklmnopqrst';
const basePolicy = {
  key_purpose: 'production',
  key_id: 'test-release-key',
  ed25519_public_key_pem: publicPem,
  approved_site_domain: 'milkpop.uk',
  approved_supabase_project_ref: ref,
  minimum_release_number: 5,
};
const baseEnv = {
  ...process.env,
  MP_RELEASE_IDENTITY: 'r4.10-closure-t13.3.6-test',
  VITE_RELEASE_IDENTITY: 'r4.10-closure-t13.3.6-test',
  MP_RELEASE_NUMBER: '6',
  MP_GIT_COMMIT: '0123456789abcdef0123456789abcdef01234567',
  MP_SITE_DOMAIN: 'milkpop.uk',
  MP_SUPABASE_PROJECT_REF: ref,
  VITE_DEPLOYMENT_MODE: 'production',
  VITE_SUPABASE_URL: `https://${ref}.supabase.co`,
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIn0.signature-test-value',
  SITE_URL: 'https://milkpop.uk',
  MP_EVIDENCE_DOC: '.preflight-test-evidence.md',
  MP_TRUST_POLICY: policyPath,
  MP_SIGNING_KEY: keyPath,
  TURNSTILE_SERVER_ENABLED: 'true',
  TURNSTILE_SECRET_SET: 'true',
  VITE_TURNSTILE_SITE_KEY: '0x4AAAA-test-site-key',
  FORM_ALLOWED_ORIGINS_SET: 'true',
  CV_ALLOWED_ORIGINS_SET: 'true',
  EMAIL_ALLOWED_ORIGINS_SET: 'true',
  NOTIFICATION_RECIPIENT_SET: 'true',
  VITE_MEDIA_V2: 'true',
  MEDIA_BACKEND_READY: 'true',
  VITE_CAREERS_CV_UPLOAD: 'false',
  CAREERS_CV_E2E_PASSED: 'false',
  CV_SCANNER_ATTESTED: 'false',
  MEDIA_CLEANUP_ENABLED: 'false',
  RETENTION_INVARIANT_TESTS_PASSED: 'false',
  VITE_LEGACY_IMPORT: 'false',
  VITE_ALLOW_BACKENDLESS: 'false',
};

const run = (overrides = {}, policy = basePolicy) => {
  fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2));
  const r = spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...baseEnv, ...overrides },
    encoding: 'utf8',
  });
  return { code: r.status, text: `${r.stdout}\n${r.stderr}` };
};

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`✓ ${name}`); }
  else { failures.push(name); console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

try {
  let r = run();
  check('valid production inputs pass', r.code === 0, r.text.slice(-500));

  r = run({}, { ...basePolicy, ed25519_public_key_pem: 'REPLACE-WITH-KEY' });
  check('template trust policy fails', r.code !== 0 && /template placeholders|valid Ed25519/.test(r.text));

  r = run({ MP_SITE_DOMAIN: 'other.example' });
  check('domain mismatch fails', r.code !== 0 && /trust policy approves this site domain/.test(r.text));

  r = run({ VITE_SUPABASE_URL: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co' });
  check('Supabase URL/ref mismatch fails', r.code !== 0 && /URL matches the approved project ref/.test(r.text));

  r = run({ MP_SIGNING_KEY: otherPath });
  check('private/public signing key mismatch fails', r.code !== 0 && /private\/public key mismatch/.test(r.text));

  r = run({ MP_RELEASE_NUMBER: '4' });
  check('rollback release number fails', r.code !== 0 && /anti-rollback/.test(r.text));

  r = run({ FORM_ALLOWED_ORIGINS_SET: 'false' });
  check('missing exact-origin commissioning fails', r.code !== 0 && /R12/.test(r.text));

  r = run({ TURNSTILE_SECRET_SET: 'false' });
  check('enabled Turnstile without secret marker fails', r.code !== 0 && /R11/.test(r.text));

  r = run({ VITE_RELEASE_IDENTITY: 'different-release' });
  check('browser/seal identity mismatch fails', r.code !== 0 && /browser release identity/.test(r.text));

  r = run({ SITE_URL: 'http://milkpop.uk' });
  check('non-HTTPS canonical URL fails', r.code !== 0 && /SITE_URL matches/.test(r.text));
} finally {
  fs.rmSync(path.join(root, '.preflight-test-evidence.md'), { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nProduction release preflight: ${passed}/${passed + failures.length} passed`);
if (failures.length) process.exit(1);
