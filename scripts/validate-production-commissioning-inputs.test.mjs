#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const ref = 'abcdefghijklmnopqrst';
const base = {
  MP_SUPABASE_PROJECT_REF: ref,
  SUPABASE_ACCESS_TOKEN: 'token', SUPABASE_URL: `https://${ref}.supabase.co`,
  SUPABASE_DB_URL: `postgresql://postgres.${ref}:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`,
  SUPABASE_ANON_KEY: 'a.b.c', SUPABASE_SERVICE_ROLE_KEY: 'd.e.f',
  PROBE_USER_EMAIL: 'probe@example.test', PROBE_USER_PASSWORD: 'pw',
  PRODUCTION_OWNER_EMAIL: 'owner@example.test', PRODUCTION_OWNER_PASSWORD: 'pw', PRODUCTION_OWNER_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
  MP_SITE_DOMAIN: 'milkpop.uk', VITE_TURNSTILE_SITE_KEY: '', TURNSTILE_SERVER_ENABLED: 'false', TURNSTILE_SECRET_SET: 'false',
  FORM_ALLOWED_ORIGINS_SET: 'true', CV_ALLOWED_ORIGINS_SET: 'true', EMAIL_ALLOWED_ORIGINS_SET: 'true', NOTIFICATION_RECIPIENT_SET: 'true',
  VITE_MEDIA_V2: 'false', MEDIA_BACKEND_READY: 'false',
};
const run = (mode, patch = {}) => spawnSync(process.execPath, ['scripts/validate-production-commissioning-inputs.mjs', mode], {
  encoding: 'utf8', env: { ...process.env, ...base, ...patch },
});
let p = 0; let f = 0; const ck = (n, x) => { if (x) { p++; console.log(`✓ ${n}`); } else { f++; console.error(`✗ ${n}`); } };
ck('recovery needs only exact project-bound Supabase URL and DB URL', run('recover-known-partial', {
  SUPABASE_ACCESS_TOKEN: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '',
  PROBE_USER_EMAIL: '', PRODUCTION_OWNER_EMAIL: '',
}).status === 0);
ck('fresh needs only base protected Supabase inputs', run('fresh', { PROBE_USER_EMAIL: '', PRODUCTION_OWNER_EMAIL: '' }).status === 0);
ck('recovery still refuses the wrong project URL', run('recover-known-partial', { SUPABASE_URL: 'https://wrong.supabase.co' }).status !== 0);
ck('recovery still refuses the wrong DB target', run('recover-known-partial', { SUPABASE_DB_URL: `postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres` }).status !== 0);
ck('upgrade requires acceptance identities', run('upgrade', { PROBE_USER_EMAIL: '' }).status !== 0);
ck('verify-only requires acceptance identities', run('verify-only', { PRODUCTION_OWNER_EMAIL: '' }).status !== 0);
ck('wrong DB target is rejected in commissioning too', run('fresh', { SUPABASE_DB_URL: `postgresql://postgres.zzzzzzzzzzzzzzzzzzzz:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres` }).status !== 0);
ck('opaque Supabase key is rejected in commissioning too', run('fresh', { SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x' }).status !== 0);
ck('owner TOTP semantics are shared', run('upgrade', { PRODUCTION_OWNER_TOTP_SECRET: 'not-base32!' }).status !== 0);

ck('upgrade refuses missing production domain before mutation', run('upgrade', { MP_SITE_DOMAIN: '' }).status !== 0);
ck('upgrade refuses incomplete CORS readiness before mutation', run('upgrade', { EMAIL_ALLOWED_ORIGINS_SET: 'false' }).status !== 0);
ck('upgrade refuses missing notification recipient before mutation', run('upgrade', { NOTIFICATION_RECIPIENT_SET: 'false' }).status !== 0);
ck('Turnstile enabled requires both secret attestation and browser site key', run('upgrade', { TURNSTILE_SERVER_ENABLED: 'true', TURNSTILE_SECRET_SET: 'true', VITE_TURNSTILE_SITE_KEY: '' }).status !== 0);
ck('Turnstile disabled refuses a stray browser site key', run('upgrade', { VITE_TURNSTILE_SITE_KEY: 'site-key' }).status !== 0);
ck('Media v2 cannot be enabled before backend readiness', run('upgrade', { VITE_MEDIA_V2: 'true', MEDIA_BACKEND_READY: 'false' }).status !== 0);
console.log(`\nProduction commissioning input gate: ${p}/${p + f} checks passed.`); if (f) process.exit(1);
