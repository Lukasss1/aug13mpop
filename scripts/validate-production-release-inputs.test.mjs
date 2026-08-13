#!/usr/bin/env node
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/validate-production-release-inputs.mjs');
const signingPem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ref = 'abcdefghijklmnopqrst';
const base = {
  MP_SIGNING_KEY_TEXT: signingPem,
  SUPABASE_ACCESS_TOKEN: 'tok',
  SUPABASE_URL: `https://${ref}.supabase.co`,
  SUPABASE_DB_URL: `postgresql://postgres.${ref}:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`,
  SUPABASE_ANON_KEY: 'a.b.c', SUPABASE_SERVICE_ROLE_KEY: 'd.e.f',
  PROBE_USER_EMAIL: 'p@x.test', PROBE_USER_PASSWORD: 'p',
  PRODUCTION_OWNER_EMAIL: 'owner@x.test', PRODUCTION_OWNER_PASSWORD: 'p',
  PRODUCTION_OWNER_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
  NETLIFY_AUTH_TOKEN: 'n', NETLIFY_SITE_ID: 'site',
  MP_SITE_DOMAIN: 'milkpop.uk', MP_SUPABASE_PROJECT_REF: ref,
  VITE_TURNSTILE_SITE_KEY: '', TURNSTILE_SERVER_ENABLED: 'false', TURNSTILE_SECRET_SET: 'false',
  FORM_ALLOWED_ORIGINS_SET: 'true', CV_ALLOWED_ORIGINS_SET: 'true', EMAIL_ALLOWED_ORIGINS_SET: 'true',
  NOTIFICATION_RECIPIENT_SET: 'true', VITE_MEDIA_V2: 'false', MEDIA_BACKEND_READY: 'false',
  MP_ALLOW_FIRST_DEPLOY_WITHOUT_MARKER: 'true',
};
const run = (over = {}) => spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, ...base, ...over } });
let p = 0; let f = 0;
const ck = (n, x) => { if (x) { p++; console.log(`✓ ${n}`); } else { f++; console.error(`✗ ${n}`); } };
let r = run(); ck('complete inventory passes', r.status === 0);
r = run({ NETLIFY_AUTH_TOKEN: '' }); ck('missing late deploy secret fails early', r.status !== 0 && /NETLIFY_AUTH_TOKEN/.test(r.stderr));
r = run({ SUPABASE_URL: 'https://wrong.supabase.co' }); ck('wrong Supabase project URL rejected', r.status !== 0 && /SUPABASE_URL/.test(r.stderr));
r = run({ SUPABASE_DB_URL: `postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres` }); ck('wrong Supabase DB project rejected', r.status !== 0 && /SUPABASE_DB_URL/.test(r.stderr));
r = run({ SUPABASE_DB_URL: `postgresql://postgres.${ref}:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres` }); ck('transaction pooler port rejected', r.status !== 0 && /SUPABASE_DB_URL/.test(r.stderr));
r = run({ SUPABASE_ANON_KEY: 'sb_publishable_x' }); ck('opaque key rejected in legacy contract', r.status !== 0 && /legacy JWT/.test(r.stderr));
r = run({ MP_SIGNING_KEY_TEXT: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----' }); ck('malformed signing key rejected', r.status !== 0 && /PEM private key/.test(r.stderr));
r = run({ PRODUCTION_OWNER_TOTP_SECRET: 'abc!' }); ck('malformed owner TOTP rejected', r.status !== 0 && /TOTP/.test(r.stderr));
r = run({ MP_SITE_DOMAIN: 'https://milkpop.uk' }); ck('site domain must be hostname only', r.status !== 0 && /MP_SITE_DOMAIN/.test(r.stderr));
r = run({ TURNSTILE_SERVER_ENABLED: 'yes' }); ck('boolean attestations must be explicit', r.status !== 0 && /TURNSTILE_SERVER_ENABLED/.test(r.stderr));
r = run({ EMAIL_ALLOWED_ORIGINS_SET: 'false' }); ck('release refuses incomplete origin readiness before mutation', r.status !== 0 && /ALLOWED_ORIGINS/.test(r.stderr));
r = run({ NOTIFICATION_RECIPIENT_SET: 'false' }); ck('release refuses missing notification recipient before mutation', r.status !== 0 && /NOTIFICATION_RECIPIENT_SET/.test(r.stderr));
r = run({ TURNSTILE_SERVER_ENABLED: 'true', TURNSTILE_SECRET_SET: 'true', VITE_TURNSTILE_SITE_KEY: '' }); ck('enabled Turnstile requires browser site key', r.status !== 0 && /VITE_TURNSTILE_SITE_KEY/.test(r.stderr));
r = run({ VITE_TURNSTILE_SITE_KEY: 'site-key' }); ck('disabled Turnstile rejects stray browser site key', r.status !== 0 && /VITE_TURNSTILE_SITE_KEY/.test(r.stderr));
r = run({ VITE_MEDIA_V2: 'true', MEDIA_BACKEND_READY: 'false' }); ck('media v2 refuses unready backend', r.status !== 0 && /MEDIA_BACKEND_READY/.test(r.stderr));
console.log(`\nProduction release input gate: ${p}/${p + f} checks passed.`);
if (f) process.exit(1);
