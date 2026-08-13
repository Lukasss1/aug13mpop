/* r48-turnstile.test.ts — R4.8 Workstream D: explicit fail-closed Turnstile. */
import { decideTurnstile } from '../supabase/functions/_shared/appEnv.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
let passed = 0, failed = 0;
const ok = (n: string) => { passed++; console.log('✔', n); };
const bad = (n: string, d = '') => { failed++; console.log('✘', n, d); };
const check = (n: string, c: boolean, d = '') => (c ? ok(n) : bad(n, d));
let g = decideTurnstile({ APP_ENV: 'production', TURNSTILE_SERVER_ENABLED: 'true', TURNSTILE_SECRET: 's3cr3t' });
check('prod enabled+secret ⇒ enforce', g.mode === 'enforce');
g = decideTurnstile({ APP_ENV: 'production', TURNSTILE_SERVER_ENABLED: 'true' });
check('prod enabled+NO secret ⇒ refuse (fail closed)', g.mode === 'refuse');
g = decideTurnstile({ APP_ENV: 'production' });
check('prod UNDECLARED ⇒ refuse (no implicit off)', g.mode === 'refuse');
g = decideTurnstile({ APP_ENV: 'production', TURNSTILE_SERVER_ENABLED: 'false' });
check('prod explicit false ⇒ off (a declared decision)', g.mode === 'off');
g = decideTurnstile({ TURNSTILE_SERVER_ENABLED: 'true' });
check('dev enabled+no secret still refuses (never half-on)', g.mode === 'refuse');
g = decideTurnstile({});
check('dev undeclared ⇒ off (dev ergonomics preserved)', g.mode === 'off');
for (const [fn, name] of [['public-form', 'public-form'], ['cv-upload', 'cv-upload']] as const) {
  const src = readFileSync(`supabase/functions/${fn}/index.ts`, 'utf8');
  check(`${name} wires the gate and 503s on refuse`, /turnstileGate\(\)/.test(src) && /TS_GATE.mode === 'refuse'/.test(src) && /503/.test(src));
}
const base = { VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: 'k',
  FORM_ALLOWED_ORIGINS_SET: 'true', CV_ALLOWED_ORIGINS_SET: 'true', EMAIL_ALLOWED_ORIGINS_SET: 'true' };
const run = (env: Record<string, string>) =>
  spawnSync('node', ['scripts/validate-deployment-env.mjs'], { env: { ...process.env, ...env }, encoding: 'utf8' });
let r = run({ ...base, VITE_DEPLOYMENT_MODE: 'production', TURNSTILE_SERVER_ENABLED: 'banana' });
check('validator: undeclared/typo Turnstile state fails a production deploy', r.status !== 0 && /R11/.test(r.stdout));
r = run({ ...base, VITE_DEPLOYMENT_MODE: 'production', TURNSTILE_SERVER_ENABLED: 'false' });
check('validator: coherent production config passes', r.status === 0, r.stdout.split('\n').filter(l => /FAIL/.test(l)).join(' | '));
r = run({ ...base, VITE_DEPLOYMENT_MODE: 'production', TURNSTILE_SERVER_ENABLED: 'false', VITE_CAREERS_CV_UPLOAD: 'true', CAREERS_CV_E2E_PASSED: 'true' });
check('validator: CV upload without scanner attestation fails production (R14)', r.status !== 0 && /R14/.test(r.stdout));
r = run({ VITE_DEPLOYMENT_MODE: 'development', TURNSTILE_SERVER_ENABLED: 'banana' });
check('validator: development stays advisory', r.status === 0);
console.log(`\nR48-TURNSTILE — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
