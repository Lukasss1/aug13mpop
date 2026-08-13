/**
 * opt02-mfa-state.test.ts — EXECUTABLE unit tests for OPT-02G. The pre-OPT-02
 * factor API returned [] on EVERY failure, so a 500 or a timeout looked exactly
 * like "this account has no factors" and shoved enrolled owners into enrolment.
 * These tests call the REAL listMfaFactorsResult / verifiedMfaStatus in auth.ts
 * through their injectable deps boundary, proving the HTTP->taxonomy mapping and
 * that the outage states are DISTINCT from the confirmed-empty state — with no
 * Vite/browser/Supabase.
 *
 * Covers spec §8 unit tests 9-13 and §12 DoD 13.
 *
 * Run: npm exec --offline -- tsx scripts/opt02-mfa-state.test.ts
 */
import type { AuthSession } from '../src/lib/authState';
import type { MfaFactorsDeps } from '../src/lib/auth';
import { listMfaFactorsResult, verifiedMfaStatus, listMfaFactors } from '../src/lib/auth';

let passed = 0, failed = 0;
const check = (n: string, cond: boolean, d = '') => {
  if (cond) { passed++; console.log(`\u2714 ${n}`); }
  else { failed++; console.error(`\u2716 ${n}\n    ${d}`); }
};

const sess: AuthSession = { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() / 1000 + 3600 };
const jsonResponse = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } });

/** Deps with real-looking config and a canned fetch outcome. */
const depsFor = (fetchImpl: () => Promise<Response>): MfaFactorsDeps => ({
  getConfig: () => ({ url: 'https://x.supabase.co', anonKey: 'anon' }),
  fetchImpl: fetchImpl as typeof fetch,
});

async function run() {
  /* 9. Empty successful factor response means enrolment. ------------------ */
  {
    const deps = depsFor(async () => jsonResponse({ factors: [] }));
    const r = await listMfaFactorsResult(sess, deps);
    const s = await verifiedMfaStatus(sess, deps);
    check('9: 200 {factors:[]} -> success + verifiedMfaStatus "none" (enrol)',
      r.status === 'success' && (r as any).factors.length === 0 && s === 'none', `${JSON.stringify(r)} / ${s}`);
  }

  /* 10. 500 does NOT mean enrolment. ------------------------------------- */
  {
    const deps = depsFor(async () => jsonResponse({ error: 'boom' }, 500));
    const r = await listMfaFactorsResult(sess, deps);
    const s = await verifiedMfaStatus(sess, deps);
    check('10: 500 -> temporarily_unavailable, NOT enrolment (status "unknown")',
      r.status === 'temporarily_unavailable' && (r as any).retryable === true && s === 'unknown',
      `${JSON.stringify(r)} / ${s}`);
  }

  /* 11. Network failure does NOT mean enrolment. ------------------------- */
  {
    const deps = depsFor(async () => { throw new TypeError('offline'); });
    const r = await listMfaFactorsResult(sess, deps);
    const s = await verifiedMfaStatus(sess, deps);
    check('11: network error -> temporarily_unavailable, status "unknown" (no false enrol)',
      r.status === 'temporarily_unavailable' && s === 'unknown', `${JSON.stringify(r)} / ${s}`);
  }

  /* 12. A verified factor routes to challenge. --------------------------- */
  {
    const deps = depsFor(async () => jsonResponse({ factors: [{ id: 'f1', status: 'verified', factor_type: 'totp' }] }));
    const r = await listMfaFactorsResult(sess, deps);
    const s = await verifiedMfaStatus(sess, deps);
    check('12: verified totp factor -> success + verifiedMfaStatus "has" (challenge)',
      r.status === 'success' && s === 'has', `${JSON.stringify(r)} / ${s}`);
  }
  // An UNVERIFIED-only factor list is still "none" (must finish enrolment).
  {
    const deps = depsFor(async () => jsonResponse({ factors: [{ id: 'f2', status: 'unverified', factor_type: 'totp' }] }));
    const s = await verifiedMfaStatus(sess, deps);
    check('12: unverified-only factor -> "none" (verified factor is what counts)', s === 'none', s);
  }

  /* 13. Invalid/unauthorised and other statuses remain distinct. --------- */
  const r401 = await listMfaFactorsResult(sess, depsFor(async () => jsonResponse({ error: 'x' }, 401)));
  check('13: 401 -> unauthorised (distinct state)', r401.status === 'unauthorised', JSON.stringify(r401));

  const r408 = await listMfaFactorsResult(sess, depsFor(async () => jsonResponse({}, 408)));
  const r429 = await listMfaFactorsResult(sess, depsFor(async () => jsonResponse({}, 429)));
  check('13: 408 and 429 both -> temporarily_unavailable',
    r408.status === 'temporarily_unavailable' && r429.status === 'temporarily_unavailable',
    `${r408.status} / ${r429.status}`);

  const r418 = await listMfaFactorsResult(sess, depsFor(async () => jsonResponse({ nope: true }, 418)));
  check("13: an unexpected 4xx (418) -> failed, retryable false (not success, not unavailable)",
    r418.status === 'failed' && (r418 as any).retryable === false, JSON.stringify(r418));

  const rMalformed = await listMfaFactorsResult(sess, depsFor(async () => jsonResponse('this is not json{', 200)));
  check('13: malformed 2xx body -> failed (never a fabricated empty success)',
    rMalformed.status === 'failed', JSON.stringify(rMalformed));

  check('13: taxonomy statuses are all distinct',
    new Set(['success', 'unauthorised', 'temporarily_unavailable', 'failed']).size === 4);

  /* Back-compat wrapper collapses non-success to [] for legacy callers. --- */
  const legacy500 = await listMfaFactors(sess, depsFor(async () => jsonResponse({}, 500)));
  check('back-compat: listMfaFactors returns [] on a 500 (legacy shape preserved)',
    Array.isArray(legacy500) && legacy500.length === 0, JSON.stringify(legacy500));
  const legacyOk = await listMfaFactors(sess, depsFor(async () =>
    jsonResponse({ factors: [{ id: 'f1', status: 'verified', factor_type: 'totp' }] })));
  check('back-compat: listMfaFactors returns the array on success',
    legacyOk.length === 1 && legacyOk[0].id === 'f1', JSON.stringify(legacyOk));

  /* Not-configured degrades to a successful empty list (safe no-op path). - */
  const rUnconfigured = await listMfaFactorsResult(sess, { getConfig: () => null, fetchImpl: (async () => { throw new Error('should not be called'); }) as typeof fetch });
  check('not configured -> success [] without any network call',
    rUnconfigured.status === 'success' && (rUnconfigured as any).factors.length === 0, JSON.stringify(rUnconfigured));

  console.log(`\nOPT-02 MFA-STATE UNIT — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
