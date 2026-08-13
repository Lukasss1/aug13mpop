#!/usr/bin/env node
/**
 * wp02-contract.test.mjs — STATIC checks for WP-02 (Turnstile, idempotent
 * public forms and honest form UX). Offline, zero-dependency, same style as
 * security-regression.test.mjs. Live pairing is scripts/turnstile-pairing.live.mjs.
 */
import { readFileSync, existsSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log(`\u2714 ${n}`); };
const fail = (n, d) => { failed++; console.error(`\u2716 ${n}\n    ${d}`); };
const check = (n, cond, d = '') => (cond ? ok(n) : fail(n, d));
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

const TW = 'src/components/TurnstileWidget.tsx';
const HOOK = 'src/hooks/usePublicSubmission.ts';
const PP = 'src/components/PublicPages.tsx';
const APP = 'src/App.tsx';
const FN = 'supabase/functions/public-form/index.ts';
const MIG = 'supabase/migration_wp02_atomic_submission.sql';
const PAIR = 'scripts/turnstile-pairing.live.mjs';

for (const f of [TW, HOOK, PP, APP, FN, MIG, PAIR]) {
  check(`${f} exists`, existsSync(f), 'file missing');
}
const tw = read(TW), hook = read(HOOK), pp = read(PP), app = read(APP), fn = read(FN), mig = read(MIG);

/* ---- 1. Turnstile frontend ---------------------------------------------- */
check('widget: site key comes from VITE_TURNSTILE_SITE_KEY only',
  /VITE_TURNSTILE_SITE_KEY/.test(tw) && !/VITE_TURNSTILE_SITE_KEY/.test(pp),
  'site key handling leaked outside the widget module');
check('widget: script loads ONCE in explicit-render mode',
  /render=explicit/.test(tw) && /scriptPromise/.test(tw),
  'single explicit script loader missing');
check('widget: execute-mode with reset before each token (single-use safe)',
  /execution: 'execute'/.test(tw) && /ts\.reset\(id\)/.test(tw) && /ts\.execute\(id\)/.test(tw),
  'fresh-token-per-call flow missing');
check('widget: expiry/error/timeout callbacks handled',
  /'error-callback'/.test(tw) && /'expired-callback'/.test(tw) && /'timeout-callback'/.test(tw),
  'reset callbacks missing');
check('widget: disabled build renders nothing and loads nothing',
  /if \(!bind\.enabled\) return null/.test(tw) && /if \(!turnstileEnabled\) return undefined/.test(tw),
  'no-site-key path not inert');
check('env: paired configuration documented',
  /VITE_TURNSTILE_SITE_KEY=/.test(read('.env.example')) && /TURNSTILE_SECRET/.test(read('.env.example')),
  '.env.example pairing docs missing');

/* ---- 2. Submission discipline (P0-03) ----------------------------------- */
check('hook: ref-based pending lock (double click → one call)',
  /pendingRef\.current\) return/.test(hook) && /pendingRef\.current = true/.test(hook),
  'pending lock missing or state-only (raceable)');
check('hook: token acquired per attempt inside the lock',
  /await turnstile\.getToken\(\)/.test(hook),
  'token orchestration missing');
check('PublicPages: all three forms run under the lock',
  /subCareers\.run\(/.test(pp) && /subFranchise\.run\(/.test(pp) && /subContact\.run\(/.test(pp),
  'a form bypasses usePublicSubmission');
check('PublicPages: franchise clears fields ONLY on submitted',
  /if \(result\.status === 'submitted'\) \{\s*setFranchiseForm\(/.test(pp),
  'franchise reset is unconditional (P0-03 regressed)');
check('PublicPages: contact clears fields ONLY on submitted',
  /if \(result\.status === 'submitted'\) \{\s*setContactForm\(/.test(pp),
  'contact reset is unconditional (P0-03 regressed)');
check('PublicPages: no unconditional reset outside the submitted gate',
  (() => {
    // every setFranchiseForm/setContactForm FULL-RESET call must sit inside a submitted gate;
    // field onChange spreads ({ ...contactForm, ... }) are exempt.
    const resets = [...pp.matchAll(/set(FranchiseForm|ContactForm)\(\{\s*\n\s*fullName: ''/g)];
    return resets.length === 2;
  })(),
  'found a full form reset outside the success path');
check('PublicPages: three submit buttons disabled while pending',
  /disabled=\{subCareers\.pending(?:\s*\|\|[^}]*)?\}/.test(pp) && /disabled=\{subFranchise\.pending(?:\s*\|\|[^}]*)?\}/.test(pp) && /disabled=\{subContact\.pending(?:\s*\|\|[^}]*)?\}/.test(pp),
  'a submit button lacks the pending lock');
check('PublicPages: a widget is mounted in each form',
  /TurnstileWidget bind=\{tsCareers\}/.test(pp) && /TurnstileWidget bind=\{tsFranchise\}/.test(pp) && /TurnstileWidget bind=\{tsContact\}/.test(pp),
  'a form has no widget mount');
check('PublicPages: CV step obtains a FRESH token',
  /tsCareers\.getToken\(\)/.test(pp) && /uploadCv\(result\.submissionId, cvFile, cvToken\)/.test(pp),
  'CV upload reuses the consumed form token');
// INC11 repoint: the calls gained a 4th argument (the display-evidence
// notice echo), so the exact-arity regexes stopped matching. The protected
// property — captchaToken is the 3rd argument on all three paths — is
// asserted with the trailing delimiter widened from ')' to ',' or ')'.
check('App: captchaToken forwarded on all three submit paths',
  /submitJobApplication\(row, idempotencyKey, captchaToken[,)]/.test(app) &&
  /submitFranchiseInquiry\(toRow\(fran as any\), idempotencyKey, captchaToken[,)]/.test(app) &&
  /submitContactMessage\(toRow\(msg as any\), idempotencyKey, captchaToken[,)]/.test(app),
  'a handler drops the token');

/* ---- 3. Atomic server submission ---------------------------------------- */
check('migration: submit_public_form is SECURITY DEFINER with pinned search_path',
  /security definer/.test(mig) && /set search_path = public/.test(mig),
  'definer/search_path missing');
check('migration: per-IP advisory lock serialises the reservation',
  /pg_advisory_xact_lock\(hashtextextended\('milkpop_public_form:' \|\| p_ip_hash/.test(mig),
  'advisory lock missing — concurrent submissions can exceed the limit');
check('migration: rate decision + insert + audit in ONE function body',
  /v_recent >= v_rate_limit/.test(mig) && /insert into form_submission_log \(ip_hash, form_kind, status\)\s*values \(p_ip_hash, p_kind, 'accepted'\)/.test(mig),
  'accepted audit row is not transactional with the insert');
check('migration: idempotency replay returns the ORIGINAL id without budget use',
  /duplicate_replay/.test(mig) && /'duplicate', true/.test(mig),
  'replay path missing');
check('migration: no dynamic SQL (explicit per-form column lists)',
  !/EXECUTE format|execute format/i.test(mig),
  'dynamic SQL present');
check('migration: browser roles revoked from the RPC (house lock pattern)',
  /revoke all on function public\.submit_public_form\(text, jsonb, uuid, text\) from public, anon, authenticated/.test(mig) &&
  !/grant execute on function public\.submit_public_form/.test(mig),
  'RPC callable by browser roles — CAPTCHA gate bypassable — or a broad grant was added');
check('migration: required fields + enum options re-enforced transactionally',
  /missing_required_field/.test(mig) && /invalid_option/.test(mig) &&
  /£50,000 - £100,000/.test(mig) && /General feedback/.test(mig),
  'server-side validation of record missing');

/* ---- 4. Edge Function rewired ------------------------------------------- */
check('public-form: calls the atomic RPC (no direct table insert remains)',
  /rpc\/submit_public_form/.test(fn) && !/svc\(spec\.table,\s*\{\s*method: 'POST'/.test(fn),
  'direct insert path still present');
check('public-form: the racy HEAD rate count is gone',
  !/Prefer: 'count=exact'/.test(fn),
  'separate rate-limit read still present');
check('public-form: required + enum validation for honest 400s',
  /spec\.required/.test(fn) && /spec\.enums/.test(fn) && /missing_required/.test(fn) && /invalid_option/.test(fn),
  'per-form validation missing');
check('public-form: email normalised server-side',
  /row\['email'\] = email\.toLowerCase\(\)/.test(fn),
  'email normalisation missing');
check('public-form: rate_limited maps to 429; RPC owns the audit rows',
  /out\?\.ok === false && out\.error === 'rate_limited'[\s\S]{0,180}?429, cors\)/.test(fn)
    && !/\blogAttempt\s*\(/.test(fn),
  '429 mapping or direct rejection-log write remains');
check('public-form: CAPTCHA still verified BEFORE the RPC call',
  fn.indexOf('siteverify') > 0 && fn.indexOf('siteverify') < fn.indexOf('rpc/submit_public_form'),
  'captcha ordering changed');

console.log(`\nWP-02 CONTRACT CHECKS — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
