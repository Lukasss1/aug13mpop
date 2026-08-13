#!/usr/bin/env node
/* ============================================================================
 *  MILK POP — deployment environment validation (OPT-01 §5.1, hardened R4.5.1)
 *
 *  Runs automatically before EVERY build (package.json "prebuild") and as the
 *  first step of the launch driver's final gate. Its one job: make an
 *  incomplete or contradictory PRODUCTION configuration fail BEFORE a build
 *  can be deployed — a green build with broken production services must be
 *  impossible.
 *
 *  Modes (VITE_DEPLOYMENT_MODE):
 *    development  (default when unset)  → rules are advisory (warnings only)
 *    preview                            → rules are advisory (warnings only)
 *    production                         → every rule below is a HARD FAIL
 *    anything else                      → HARD FAIL in every mode (a typo'd
 *                                         mode must never silently soften)
 *
 *  Production rules:
 *    R1   VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are a PAIR — exactly
 *         one of them set is always a misconfiguration.
 *    R2   PRODUCTION ALWAYS REQUIRES THE SUPABASE PAIR (R4.5.1 hardening).
 *         Backend-less production is forbidden and there is NO override:
 *         VITE_ALLOW_BACKENDLESS=true is itself a HARD FAIL in production.
 *         The escape hatch exists only for development/preview builds.
 *    R3   VITE_SUPABASE_URL must be an https:// URL.
 *    R4   Turnstile halves are a PAIR: VITE_TURNSTILE_SITE_KEY (frontend) and
 *         the CI-side marker TURNSTILE_SERVER_ENABLED=true (recorded when the
 *         TURNSTILE_SECRET function secret is set). One without the other
 *         means either an unwinnable CAPTCHA or a silently-disabled one.
 *    R5a  No VITE_ name may look like a secret: any set variable matching
 *         VITE_*SECRET*, VITE_*SERVICE_ROLE*, VITE_*PRIVATE_KEY* (or the
 *         historic VITE_*TURNSTILE*SECRET*) is a HARD FAIL in EVERY mode —
 *         VITE_* compiles into the public bundle.
 *    R5b  No VITE_ VALUE may be secret material: a Supabase secret key
 *         (sb_secret_…), a service_role JWT, or a PEM private-key block under
 *         ANY VITE_ name is a HARD FAIL in EVERY mode.
 *    R5c  Server-only secrets must not sit in the frontend build environment:
 *         TURNSTILE_SECRET, RESEND_API_KEY and SUPABASE_SERVICE_ROLE_KEY
 *         belong ONLY in Supabase/server-side configuration. Any of them
 *         present where the frontend builds is a production HARD
 *         FAIL (advisory elsewhere).
 *    R6   VITE_MEDIA_V2=true requires MEDIA_BACKEND_READY=true — the flag may
 *         only go live after the media functions are deployed and their live
 *         gate has passed.
 *    R7   VITE_CAREERS_CV_UPLOAD=true requires CAREERS_CV_E2E_PASSED=true —
 *         the flag may only go live after the Careers+CV staging E2E gate.
 *    R8   MEDIA_CLEANUP_ENABLED=true requires RETENTION_INVARIANT_TESTS_
 *         PASSED=true in EVERY mode. R4.5.1 ships the claim-time reference
 *         re-check (migration_stage3_ws9_retention.sql) and its executable
 *         proof (npm run test:retention); the marker records that the proof
 *         ran green against the deployed chain. Without the marker, cleanup
 *         enablement remains forbidden exactly as before.
 *    R9   VITE_CONFIRMED_CONTACT_EMAIL, when set, must be one valid address.
 *    R10  When MP_REQUIRE_PRODUCTION_MODE=1 (set by `npm run build:production`,
 *         the release verifier and the deploy driver), the RESOLVED mode MUST
 *         be `production` — a release/deploy build can never silently run
 *         under development or preview rules.
 *
 *  Sources: Vite .env files (base → mode-specific → .local, matching Vite's
 *  own precedence) with process.env overriding everything, exactly as a
 *  hosted build (Netlify / Vercel / Cloudflare Pages) sees it.
 * ==========================================================================*/
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---- assemble the environment the build will actually see --------------- */
function parseDotEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/* ---- resolve the deployment mode (explicit → Netlify context → local) ----
 * OPT-01.1: the mode must not depend solely on a human remembering to set
 * VITE_DEPLOYMENT_MODE. On Netlify, the platform's own CONTEXT is authoritative
 * when no explicit mode is given, and an explicit mode that CONTRADICTS a
 * Netlify production context is a hard error (a mislabelled production deploy
 * must never slip through as "preview"). */
const explicitMode = (process.env.VITE_DEPLOYMENT_MODE
  || parseDotEnv(path.join(root, '.env.local')).VITE_DEPLOYMENT_MODE
  || parseDotEnv(path.join(root, '.env')).VITE_DEPLOYMENT_MODE
  || '').trim();
const onNetlify = String(process.env.NETLIFY ?? '').trim() === 'true';
const netlifyCtx = String(process.env.CONTEXT ?? '').trim();
const netlifyMode = onNetlify
  ? (netlifyCtx === 'production' ? 'production'
    : (netlifyCtx === 'deploy-preview' || netlifyCtx === 'branch-deploy') ? 'preview'
    : netlifyCtx === 'dev' ? 'development'
    : 'preview')  // any other Netlify context is treated as preview (advisory)
  : '';

let contradiction = null;
let modeSource;
let modeRaw;
if (onNetlify && netlifyCtx === 'production' && explicitMode && explicitMode !== 'production') {
  // Evaluate under production so the contradiction cannot escape the hard rules.
  contradiction = `Netlify reports CONTEXT=production but VITE_DEPLOYMENT_MODE="${explicitMode}" was supplied.`;
  modeRaw = 'production';
  modeSource = 'contradiction→production';
} else if (explicitMode) {
  modeRaw = explicitMode;
  modeSource = 'VITE_DEPLOYMENT_MODE';
} else if (onNetlify) {
  modeRaw = netlifyMode;
  modeSource = `Netlify CONTEXT=${netlifyCtx || '(unset)'}`;
} else {
  modeRaw = 'development';
  modeSource = 'default (no explicit mode, not on Netlify)';
}

const env = {
  ...parseDotEnv(path.join(root, '.env')),
  ...parseDotEnv(path.join(root, `.env.${modeRaw}`)),
  ...parseDotEnv(path.join(root, '.env.local')),
  ...parseDotEnv(path.join(root, `.env.${modeRaw}.local`)),
  ...process.env,
};

/* ---- rule engine --------------------------------------------------------- */
const MODES = ['development', 'preview', 'production'];
const production = modeRaw === 'production';
const failures = [];
const warnings = [];
const fail = (rule, msg) => failures.push(`${rule}: ${msg}`);
const advise = (rule, msg) => (production ? failures : warnings).push(`${rule}: ${msg}`);
const isSet = (k) => String(env[k] ?? '').trim() !== '';
const isTrue = (k) => String(env[k] ?? '').trim() === 'true';

if (contradiction) {
  fail('MODE', contradiction + ' Set VITE_DEPLOYMENT_MODE=production or leave it unset on Netlify.');
}
if (!MODES.includes(modeRaw)) {
  fail('MODE', `resolved deployment mode "${modeRaw}" is not one of ${MODES.join('|')}. ` +
    'A typo here must never silently soften the production rules.');
}

// R10 — a release/deploy invocation pins the mode. `npm run build:production`,
// `npm run release:verify` and the launch driver set MP_REQUIRE_PRODUCTION_MODE=1;
// any resolution other than `production` is then a hard failure in every mode.
if (String(env.MP_REQUIRE_PRODUCTION_MODE ?? '').trim() === '1' && modeRaw !== 'production') {
  fail('R10', `this invocation requires VITE_DEPLOYMENT_MODE=production but the resolved mode is "${modeRaw}" ` +
    `[${modeSource}]. Release and deploy builds never run under softened rules.`);
}

const hasUrl = isSet('VITE_SUPABASE_URL');
const hasKey = isSet('VITE_SUPABASE_ANON_KEY');

if (hasUrl !== hasKey) {
  advise('R1', 'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be configured as a PAIR — ' +
    `only ${hasUrl ? 'the URL' : 'the anon key'} is set.`);
}
if (!hasUrl && !hasKey) {
  if (production) {
    // R4.5.1: production fails CLOSED with no override. The old
    // VITE_ALLOW_BACKENDLESS=true escape is itself an error here.
    fail('R2', isTrue('VITE_ALLOW_BACKENDLESS')
      ? 'VITE_ALLOW_BACKENDLESS=true is FORBIDDEN in production — a production build always requires ' +
        'the VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY pair. Remove the override and set the pair.'
      : 'No Supabase configuration at all — a production build always requires the ' +
        'VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY pair. There is no backend-less production override.');
  } else if (isTrue('VITE_ALLOW_BACKENDLESS')) {
    warnings.push('R2: backend-less mode EXPLICITLY authorised via VITE_ALLOW_BACKENDLESS=true (development/preview only) — ' +
      'no live data, forms, portal or POS will function.');
  } else {
    warnings.push('R2: No Supabase configuration at all — this build would silently enter backend-less mode. ' +
      'Set the pair, or (development/preview only) authorise explicitly with VITE_ALLOW_BACKENDLESS=true.');
  }
} else if (production && isTrue('VITE_ALLOW_BACKENDLESS')) {
  // The pair is set but the override is dangling: forbid it anyway so a later
  // configuration edit cannot silently re-arm the escape hatch.
  fail('R2', 'VITE_ALLOW_BACKENDLESS=true is FORBIDDEN in production even when the Supabase pair is set — ' +
    'remove it (it must be absent or "false").');
}
if (hasUrl && !/^https:\/\/.+/i.test(String(env.VITE_SUPABASE_URL).trim())) {
  advise('R3', `VITE_SUPABASE_URL must be an https:// URL (got "${String(env.VITE_SUPABASE_URL).trim().slice(0, 40)}…").`);
}

const siteKey = isSet('VITE_TURNSTILE_SITE_KEY');
const serverMarker = isTrue('TURNSTILE_SERVER_ENABLED');
if (siteKey !== serverMarker) {
  advise('R4', siteKey
    ? 'VITE_TURNSTILE_SITE_KEY is set but TURNSTILE_SERVER_ENABLED=true is not — the widget would issue tokens no function verifies.'
    : 'TURNSTILE_SERVER_ENABLED=true but VITE_TURNSTILE_SITE_KEY is missing — the server would demand tokens the site cannot produce.');
}

/* ---- R5a/R5b/R5c — secret placement (HARD in every mode) ------------------
 * The frontend half of Turnstile is VITE_TURNSTILE_SITE_KEY and ONLY that;
 * TURNSTILE_SECRET is server-only. Generalised for R4.5.1: no VITE_ NAME may
 * look like a secret, no VITE_ VALUE may be secret material, and the named
 * server secrets must not be present where the frontend builds at all. */
const SECRET_NAME_RE = /^VITE_.*(SECRET|SERVICE_ROLE|SERVICE-ROLE|PRIVATE_KEY|PRIVATE-KEY)/i;
const SB_SECRET_VALUE_RE = /\bsb_secret_[A-Za-z0-9_-]{8,}/;
const PEM_VALUE_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
function isServiceRoleJwt(value) {
  const m = String(value).match(/eyJ[A-Za-z0-9_-]{6,}\.([A-Za-z0-9_-]{6,})\.[A-Za-z0-9_-]{6,}/);
  if (!m) return false;
  try {
    const payload = JSON.parse(Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return String(payload?.role || '') === 'service_role';
  } catch {
    return false;
  }
}
for (const k of Object.keys(env)) {
  const v = String(env[k] ?? '');
  if (SECRET_NAME_RE.test(k) && v.trim() !== '') {
    fail('R5a', `${k} — a secret must never live under a VITE_ name; VITE_* compiles into the public bundle.`);
    continue;
  }
  if (/^VITE_/.test(k) && v.trim() !== '') {
    if (SB_SECRET_VALUE_RE.test(v)) {
      fail('R5b', `${k} carries a Supabase SECRET key (sb_secret_…) — only the publishable/anon key may be a VITE_ value.`);
    } else if (isServiceRoleJwt(v)) {
      fail('R5b', `${k} carries a service_role JWT — the service-role key must NEVER reach the frontend build.`);
    } else if (PEM_VALUE_RE.test(v)) {
      fail('R5b', `${k} carries a PEM private-key block — private keys must never be VITE_ values.`);
    }
  }
}
{
  const SERVER_ONLY = ['TURNSTILE_SECRET', 'RESEND_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
  for (const name of SERVER_ONLY) {
    if (isSet(name)) {
      advise('R5c', `${name} is present in the frontend build environment — it belongs ONLY in Supabase ` +
        'function secrets. Move it there and remove it from the host build env before deploying.');
    }
  }
}

if (isTrue('VITE_MEDIA_V2') && !isTrue('MEDIA_BACKEND_READY')) {
  advise('R6', 'VITE_MEDIA_V2=true without MEDIA_BACKEND_READY=true — enable the flag only after ' +
    'media-upload/media-cleanup are deployed and the live media gate has passed.');
}
if (isTrue('VITE_CAREERS_CV_UPLOAD') && !isTrue('CAREERS_CV_E2E_PASSED')) {
  advise('R7', 'VITE_CAREERS_CV_UPLOAD=true without CAREERS_CV_E2E_PASSED=true — enable the flag only after ' +
    'the live Careers+CV staging E2E gate has passed.');
}

// R8 (R4.5.1 revision of OPT-01.1 §6): media cleanup may be enabled ONLY once
// the WS9 claim-time reference re-check is deployed AND its executable proof
// (npm run test:retention, real PostgreSQL) has run green — recorded by the
// RETENTION_INVARIANT_TESTS_PASSED=true marker. Enablement without the marker
// fails outright in EVERY mode, exactly as strictly as the old absolute ban.
if (isTrue('MEDIA_CLEANUP_ENABLED') && !isTrue('RETENTION_INVARIANT_TESTS_PASSED')) {
  fail('R8', 'MEDIA_CLEANUP_ENABLED=true without RETENTION_INVARIANT_TESTS_PASSED=true — media cleanup may only ' +
    'be enabled after migration_stage3_ws9_retention.sql is applied and `npm run test:retention` has passed ' +
    'against the deployed chain (see docs/HOSTING.md). Remove the flag or record the marker.');
}

// R9 (C1.3 finding #6): the OPTIONAL customer-facing fallback contact address is
// blank by default (the site invents no inbox). When it IS set it must be a
// single, syntactically valid address — the public contact form only ever shows
// it after a genuine submission failure, so a malformed value would surface to a
// real customer.
{
  const contactEmail = String(env.VITE_CONFIRMED_CONTACT_EMAIL ?? '').trim();
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    advise('R9', `VITE_CONFIRMED_CONTACT_EMAIL="${contactEmail.slice(0, 40)}" is not a valid e-mail address — ` +
      'leave it blank to offer no fallback, or set a single monitored address.');
  }
}

/* ---- R4.8 launch-closure rules (Workstreams D, E, L, C) ------------------- */
// R11 (D): Turnstile server state must be DECLARED in production — no implicit
// "secret missing therefore CAPTCHA off". TURNSTILE_SERVER_ENABLED must be
// exactly 'true' or 'false'; 'true' additionally requires the CI-side marker
// TURNSTILE_SECRET_SET=true recorded when the function secret was written.
{
  const declared = String(env.TURNSTILE_SERVER_ENABLED ?? '').trim();
  if (production && declared !== 'true' && declared !== 'false') {
    fail('R11', `TURNSTILE_SERVER_ENABLED is "${declared || '(unset)'}" — production requires an EXPLICIT true/false. ` +
      'The Edge Functions fail closed (refuse submissions) on an undeclared state; declare it here first.');
  }
  if (declared === 'true' && String(env.TURNSTILE_SECRET_SET ?? '').trim() !== 'true') {
    advise('R11', 'TURNSTILE_SERVER_ENABLED=true without TURNSTILE_SECRET_SET=true — set the TURNSTILE_SECRET ' +
      'function secret and record the marker, or declare Turnstile false. Enabled-without-secret refuses all submissions.');
  }
}

// R12 (E): production CORS is fail-closed — every browser-called function
// group needs an exact-origin allow-list recorded at deploy time. The shared
// builder answers Access-Control-Allow-Origin: null (never *) without one.
{
  const groups = [
    ['FORM_ALLOWED_ORIGINS_SET', 'public-form'],
    ['CV_ALLOWED_ORIGINS_SET', 'cv-upload / staff-doc / media / pos'],
    ['EMAIL_ALLOWED_ORIGINS_SET', 'send-email'],
  ];
  for (const [marker, what] of groups) {
    if (production && String(env[marker] ?? '').trim() !== 'true') {
      fail('R12', `${marker}=true is required in production — record it after setting the exact-origin ` +
        `allow-list function secret for ${what}. Without a list the functions answer no trusted origin at all.`);
    }
  }
}

// R13 (C): public forms are only commissionable with a durable notification
// path. The recipient lives in the DATABASE (launch_settings, owner-entered
// AFTER first deploy), so this can never be a build blocker — it is a
// deliberate ALWAYS-WARNING that keeps the commissioning step visible in
// every deploy log until the marker is recorded. The DB gate is the enforcer.
{
  if (production && String(env.NOTIFICATION_RECIPIENT_SET ?? '').trim() !== 'true') {
    warnings.push('R13: NOTIFICATION_RECIPIENT_SET=true is not recorded — enter the owner notification recipient in ' +
      'Settings → Launch Facts and record the marker. Armed gates refuse public forms without it.');
  }
}

// R14 (L): CV upload may not ship without the scanner chain. Tightens R7:
// even with the E2E marker, production requires the malware-scanning
// attestation. Where no scanner is configured, the feature stays disabled.
{
  const cv = String(env.VITE_CAREERS_CV_UPLOAD ?? '').trim() === 'true';
  if (cv && production && String(env.CV_SCANNER_ATTESTED ?? '').trim() !== 'true') {
    fail('R14', 'VITE_CAREERS_CV_UPLOAD=true without CV_SCANNER_ATTESTED=true — the quarantine/malware-scan chain ' +
      '(docs/CV-UPLOAD-GATE.md) is mandatory before CV upload can be enabled in production.');
  }
}

/* ---- report -------------------------------------------------------------- */
console.log(`[env-validate] mode=${modeRaw} [${modeSource}]${production ? ' (rules are HARD)' : ' (rules are advisory)'}`);
for (const w of warnings) console.log(`[env-validate] WARN  ${w}`);
for (const f of failures) console.log(`[env-validate] FAIL  ${f}`);
if (failures.length) {
  console.error(`[env-validate] ✖ ${failures.length} blocking problem(s) — refusing to build/deploy.`);
  process.exit(1);
}
console.log(`[env-validate] ✔ configuration is coherent (${warnings.length} warning(s)).`);
