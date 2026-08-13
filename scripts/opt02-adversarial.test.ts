/**
 * opt02-adversarial.test.ts — INTEGRATION replays of every race the audit
 * reproduced, wired end-to-end: the REAL storage authority + the REAL basis-
 * explicit coordinator + the REAL request wrapper. Only the two network
 * endpoints (auth-refresh + the API call) and the config are faked. If any of
 * the audit's findings 1–6/10 regressed, one of these fails.
 *
 * Run: npm exec --offline -- tsx scripts/opt02-adversarial.test.ts
 */
import { readFileSync } from 'node:fs';
import type { AuthSession } from '../src/lib/authState';
import type { AuthLifecycleEvent } from '../src/lib/authEvents';
import { authenticatedRequest, type AuthedRequestDeps } from '../src/lib/authClient';
import { getAccessToken } from '../src/lib/auth';
import { refreshSessionSingleFlight, __resetRefreshInFlightForTests } from '../src/lib/authRefresh';
import {
  __resetAuthStorageForTests, __createMemoryStoreForTests,
  setAuthoritativeSession, commitRefreshedSession, clearSessionIfCurrent,
  replaceSessionIfLineage, takeSessionIfUser,
  readAuthSnapshot, getSessionIfLineage, readSession, currentLineage,
} from '../src/lib/authStorage';

let passed = 0, failed = 0;
const check = (n: string, cond: boolean, d = '') => {
  if (cond) { passed++; console.log(`\u2714 ${n}`); }
  else { failed++; console.error(`\u2716 ${n}\n    ${d}`); }
};

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (sub: string) => `x.${b64url(JSON.stringify({ sub }))}.y`;
const mk = (sub: string, refresh: string, access = jwt(sub)): AuthSession => ({ accessToken: access, refreshToken: refresh, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
const cfg = () => ({ url: 'https://proj.supabase.co', anonKey: 'anon' });
const json = (b: unknown, status = 200) => new Response(typeof b === 'string' ? b : JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const reset = () => { __resetRefreshInFlightForTests(); __resetAuthStorageForTests(__createMemoryStoreForTests()); };

/** The real coordinator, with ONLY the auth network + config + clock faked. */
const realRefreshDep = (refreshFetch: typeof fetch): AuthedRequestDeps['refresh'] =>
  (basis: AuthSession) => refreshSessionSingleFlight(basis, {
    getConfig: cfg, fetchImpl: refreshFetch,
    commitRefreshed: commitRefreshedSession, clearIfCurrent: clearSessionIfCurrent,
    now: () => Date.now(), timeoutMs: 0,
  });

/** Real-storage wrapper deps: only fetch/refresh/config/emit are supplied. */
function wrapperDeps(apiFetch: typeof fetch, refreshFetch: typeof fetch, events: AuthLifecycleEvent[]): Partial<AuthedRequestDeps> {
  return {
    readSnapshot: readAuthSnapshot,
    getSessionIfLineage,
    clearIfCurrent: clearSessionIfCurrent,
    refresh: realRefreshDep(refreshFetch),
    emit: (e) => { events.push(e); },
    getConfig: cfg,
    fetchImpl: apiFetch,
  };
}

async function run() {
  /* AF1 (finding 1) — basis-explicit coordinator: an obsolete E1 refresh sends
   *  E1's token and NEVER mutates the newer E2 login. --------------------------- */
  reset();
  {
    const e1 = mk('user-a', 'E1-refresh');
    setAuthoritativeSession(e1);
    setAuthoritativeSession(mk('user-a', 'E2-refresh'));   // newer login supersedes E1
    let sentToken: string | null = null;
    const refreshFetch = (async (_i: any, init: any) => { sentToken = JSON.parse(String(init.body)).refresh_token; return json({ access_token: jwt('user-a'), refresh_token: 'E1-rotated', expires_in: 3600 }); }) as typeof fetch;
    const r = await refreshSessionSingleFlight(e1, { getConfig: cfg, fetchImpl: refreshFetch, commitRefreshed: commitRefreshedSession, clearIfCurrent: clearSessionIfCurrent, now: () => Date.now(), timeoutMs: 0 });
    check('AF1: obsolete refresh sends E1 token (never the stored E2)', sentToken === 'E1-refresh', `sent=${sentToken}`);
    check('AF1: commit dropped → stale_session, and E2 is completely untouched',
      r.status === 'stale_session' && readSession()?.refreshToken === 'E2-refresh', `status=${r.status} stored=${readSession()?.refreshToken}`);
  }

  /* AF2 (finding 2) — a retried 401 can NOT delete a newer same-lineage token.
   *  A1→refresh commits A2→retry; store rotates A2→A3 during the retry; the
   *  retried 401's exact clear misses → superseded, A3 SURVIVES. ---------------- */
  reset();
  {
    const events: AuthLifecycleEvent[] = [];
    const l1 = setAuthoritativeSession(mk('user-a', 'a1r'));
    let apiN = 0;
    const apiFetch = (async () => {
      apiN++;
      if (apiN === 1) return json({}, 401);
      // During the retry, another op rotates the CURRENT session A2 → A3 (same ceremony).
      const cur = getSessionIfLineage(l1)!;
      commitRefreshedSession(mk('user-a', 'a3r'), cur);
      return json({}, 401);
    }) as typeof fetch;
    const refreshFetch = (async () => json({ access_token: jwt('user-a'), refresh_token: 'a2r', expires_in: 3600 })) as typeof fetch;
    const r = await authenticatedRequest('https://proj.supabase.co/rest/v1/x', {}, { deps: wrapperDeps(apiFetch, refreshFetch, events) });
    check('AF2: retried 401 → superseded (obsolete op cannot clear), newer A3 SURVIVES',
      r.status === 'superseded' && readSession()?.refreshToken === 'a3r' && !events.some((e) => e.type === 'session_expired'),
      `status=${r.status} stored=${readSession()?.refreshToken} events=${JSON.stringify(events)}`);
  }

  /* AF3 (finding 3) — invalid_session must NOT delete a newer same-epoch session.
   *  refreshFetch rotates F1→F2 then 400s; coordinator's exact clear misses;
   *  wrapper sees F2 survive → superseded, no emit. ---------------------------- */
  reset();
  {
    const events: AuthLifecycleEvent[] = [];
    const l1 = setAuthoritativeSession(mk('user-a', 'f1r'));
    const apiFetch = (async () => json({}, 401)) as typeof fetch;
    const refreshFetch = (async () => {
      const cur = getSessionIfLineage(l1)!;
      commitRefreshedSession(mk('user-a', 'f2r'), cur);   // store advances to F2 in the same epoch
      return json({ error: 'invalid_grant' }, 400);
    }) as typeof fetch;
    const r = await authenticatedRequest('https://proj.supabase.co/rest/v1/x', {}, { deps: wrapperDeps(apiFetch, refreshFetch, events) });
    check('AF3: invalid_session with a surviving same-epoch F2 → superseded, F2 kept, no emit',
      r.status === 'superseded' && readSession()?.refreshToken === 'f2r' && !events.some((e) => e.type === 'session_expired'),
      `status=${r.status} stored=${readSession()?.refreshToken}`);
  }

  /* AF3b — emit-iff-empty (positive): a genuine dead refresh with NO survivor
   *  clears (in the coordinator) and DOES emit refresh_rejected. --------------- */
  reset();
  {
    const events: AuthLifecycleEvent[] = [];
    setAuthoritativeSession(mk('user-a', 'g1r'));
    const apiFetch = (async () => json({}, 401)) as typeof fetch;
    const refreshFetch = (async () => json({ error: 'invalid_grant' }, 400)) as typeof fetch;  // no rotation
    const r = await authenticatedRequest('https://proj.supabase.co/rest/v1/x', {}, { deps: wrapperDeps(apiFetch, refreshFetch, events) });
    check('AF3b: genuinely dead refresh (no survivor) → unauthorised + session_expired(refresh_rejected), store empty',
      r.status === 'unauthorised' && readSession() === null
      && events.some((e) => e.type === 'session_expired' && (e as any).reason === 'refresh_rejected'),
      `status=${r.status} stored=${readSession()?.refreshToken} events=${JSON.stringify(events)}`);
  }

  /* AF4 (finding 4) — an unsafe POST is NEVER auto-replayed, but the refresh
   *  still runs (rule 8). Then a GET on a healed session replays. ------------- */
  reset();
  {
    const events: AuthLifecycleEvent[] = [];
    setAuthoritativeSession(mk('user-a', 'p1r'));
    let apiN = 0, refreshN = 0;
    const apiFetch = (async () => { apiN++; return apiN === 1 ? json({}, 401) : json({ ok: true }, 200); }) as typeof fetch;
    const refreshFetch = (async () => { refreshN++; return json({ access_token: jwt('user-a'), refresh_token: 'p2r', expires_in: 3600 }); }) as typeof fetch;
    const r = await authenticatedRequest('https://proj.supabase.co/rest/v1/x', { method: 'POST', body: '{"a":1}' }, { deps: wrapperDeps(apiFetch, refreshFetch, events) });
    check('AF4: unsafe POST → retry_required; refresh RAN (1×) but the POST was sent only ONCE',
      r.status === 'retry_required' && apiN === 1 && refreshN === 1, `status=${r.status} api=${apiN} refresh=${refreshN}`);
    // The session is healed; a GET now replays cleanly.
    let apiN2 = 0;
    const apiFetch2 = (async () => { apiN2++; return apiN2 === 1 ? json({}, 401) : json({ ok: true }, 200); }) as typeof fetch;
    const refreshFetch2 = (async () => json({ access_token: jwt('user-a'), refresh_token: 'p3r', expires_in: 3600 })) as typeof fetch;
    const r2 = await authenticatedRequest('https://proj.supabase.co/rest/v1/x', { method: 'GET' }, { deps: wrapperDeps(apiFetch2, refreshFetch2, events) });
    check('AF4: a safe GET on the healed session replays → success (2 api calls)', r2.status === 'success' && apiN2 === 2, `api=${apiN2}`);
  }

  /* AF5 (finding 5) — the retry carries the REBOUND live token, not the raw
   *  refresh result. Store rotates A2→A3 between refresh and retry. ----------- */
  reset();
  {
    const events: AuthLifecycleEvent[] = [];
    const l1 = setAuthoritativeSession(mk('user-a', 'a1r', jwt('user-a')));
    const sentAuth: string[] = [];
    const apiFetch = (async (_i: any, init: any) => {
      const auth = new Headers(init.headers).get('Authorization') || '';
      sentAuth.push(auth);
      return sentAuth.length === 1 ? json({}, 401) : json({ ok: true }, 200);
    }) as typeof fetch;
    // refresh commits A2; then (modelling a concurrent op) the store is rotated to A3 before the retry.
    const refreshFetch = (async () => json({ access_token: 'ACCESS-A2', refresh_token: 'a2r', expires_in: 3600 })) as typeof fetch;
    const refreshWithRotate: AuthedRequestDeps['refresh'] = async (basis) => {
      const res = await realRefreshDep(refreshFetch)(basis);
      const cur = getSessionIfLineage(l1);             // A2 now
      if (cur) commitRefreshedSession(mk('user-a', 'a3r', 'ACCESS-A3'), cur);   // → A3, same ceremony
      return res;
    };
    const deps: Partial<AuthedRequestDeps> = { ...wrapperDeps(apiFetch, refreshFetch, events), refresh: refreshWithRotate };
    const r = await authenticatedRequest('https://proj.supabase.co/rest/v1/x', {}, { deps });
    check('AF5: retry Authorization is the REBOUND current token ACCESS-A3 (not the raw refresh A2)',
      r.status === 'success' && sentAuth[1] === 'Bearer ACCESS-A3', `retryAuth=${sentAuth[1]}`);
  }

  /* AF6 (finding 6) — real storage refuses a foreign-sub replacement. -------- */
  reset();
  {
    const l1 = setAuthoritativeSession(mk('user-1', 'u1r'));
    const res = replaceSessionIfLineage(l1, mk('user-2', 'u2r'));
    check('AF6: foreign-sub replacement rejected by real storage; user-1 session intact',
      res === null && readSession()?.refreshToken === 'u1r' && currentLineage()?.userId === 'user-1', `stored=${readSession()?.refreshToken}`);
  }

  /* AF9 — identity-level revocation reaches a NEWER same-user ceremony; a
   *  different user's session is untouched. ----------------------------------- */
  reset();
  {
    setAuthoritativeSession(mk('user-a', 'cer1'));
    setAuthoritativeSession(mk('user-a', 'cer2'));   // new ceremony, same identity
    const taken = takeSessionIfUser('user-a');
    check('AF9: takeSessionIfUser revokes the newer same-user ceremony', taken?.session.refreshToken === 'cer2' && readSession() === null);
    setAuthoritativeSession(mk('user-b', 'br'));
    check('AF9: a different user’s session is never taken', takeSessionIfUser('user-a') === null && readSession()?.refreshToken === 'br');
  }

  /* AF10 (finding 10) — a caller-supplied apikey is preserved end-to-end. ---- */
  reset();
  {
    const events: AuthLifecycleEvent[] = [];
    setAuthoritativeSession(mk('user-a', 'k1r'));
    let sawApiKey: string | null = 'ABSENT';
    const apiFetch = (async (_i: any, init: any) => { sawApiKey = new Headers(init.headers).get('apikey'); return json({ ok: true }, 200); }) as typeof fetch;
    const refreshFetch = (async () => json({}, 500)) as typeof fetch;
    const r = await authenticatedRequest('https://proj.supabase.co/rest/v1/x', { headers: { apikey: 'custom' } }, { deps: wrapperDeps(apiFetch, refreshFetch, events) });
    check('AF10: caller-supplied apikey preserved through the real wrapper', r.status === 'success' && sawApiKey === 'custom', `apikey=${sawApiKey}`);
  }

  /* AF-GAT (blocker 1) — getAccessToken() is lineage-bound: it NEVER returns a
   *  different lifecycle's token. Uses the real helper + real storage; only the
   *  refresh network is faked via the overrides param. ------------------------- */
  const nearExpiry = (sub: string, refresh: string, access: string): AuthSession =>
    ({ accessToken: access, refreshToken: refresh, expiresAt: Math.floor(Date.now() / 1000) + 10 }); // < 60s → forces refresh
  const gatOverrides = (fetchImpl: typeof fetch) => ({
    getConfig: cfg, fetchImpl, commitRefreshed: commitRefreshedSession,
    clearIfCurrent: clearSessionIfCurrent, now: () => Date.now(), timeoutMs: 0,
  });

  // GAT1: refresh overtaken by user B → null (never B's token).
  reset();
  {
    setAuthoritativeSession(nearExpiry('user-a', 'a1r', 'ACCESS-A1'));
    const fetchImpl = (async () => {
      setAuthoritativeSession(mk('user-b', 'b1r', 'ACCESS-B1'));   // B signs in mid-refresh
      return json({ access_token: 'ACCESS-A2', refresh_token: 'a2r', expires_in: 3600 });
    }) as typeof fetch;
    const tok = await getAccessToken(gatOverrides(fetchImpl));
    check('AF-GAT1: refresh overtaken by user B → null (never returns B’s token)',
      tok === null && readSession()?.accessToken === 'ACCESS-B1', `tok=${tok} stored=${readSession()?.accessToken}`);
  }

  // GAT2: temporary outage after user B signs in → null (never A’s stale token, never B’s).
  reset();
  {
    setAuthoritativeSession(nearExpiry('user-a', 'a1r', 'ACCESS-A1'));
    const fetchImpl = (async () => {
      setAuthoritativeSession(mk('user-b', 'b1r', 'ACCESS-B1'));
      throw new TypeError('offline');
    }) as typeof fetch;
    const tok = await getAccessToken(gatOverrides(fetchImpl));
    check('AF-GAT2: outage after B signs in → null (our ceremony is gone; no stale/foreign token)',
      tok === null && readSession()?.accessToken === 'ACCESS-B1', `tok=${tok}`);
  }

  // GAT3: a clean refresh returns the REBOUND current same-ceremony token.
  reset();
  {
    setAuthoritativeSession(nearExpiry('user-a', 'a1r', 'ACCESS-A1'));
    const fetchImpl = (async () => json({ access_token: 'ACCESS-A2', refresh_token: 'a2r', expires_in: 3600 })) as typeof fetch;
    const tok = await getAccessToken(gatOverrides(fetchImpl));
    check('AF-GAT3: a clean refresh returns the rebound current token (A2)',
      tok === 'ACCESS-A2' && readSession()?.accessToken === 'ACCESS-A2', `tok=${tok}`);
  }

  // GAT4: an unexpired token short-circuits without any refresh.
  reset();
  {
    setAuthoritativeSession(mk('user-a', 'a1r', 'ACCESS-FRESH'));   // expiresAt now+3600
    let refreshed = false;
    const fetchImpl = (async () => { refreshed = true; return json({}, 200); }) as typeof fetch;
    const tok = await getAccessToken(gatOverrides(fetchImpl));
    check('AF-GAT4: an unexpired token is returned with NO refresh', tok === 'ACCESS-FRESH' && refreshed === false, `tok=${tok} refreshed=${refreshed}`);
  }

  // GAT5: a token that EXPIRES during a slow (timed-out) refresh is not returned.
  reset();
  {
    const baseMs = 1_000_000_000_000; // whole seconds
    const baseSec = Math.floor(baseMs / 1000);
    let nowMs = baseMs;
    // 1 second of life left at entry (< 60 → forces a refresh).
    setAuthoritativeSession({ accessToken: 'ACCESS-EXPIRING', refreshToken: 'e1r', expiresAt: baseSec + 1 });
    const fetchImpl = (async () => { nowMs = baseMs + 2000; throw new TypeError('slow-timeout'); }) as typeof fetch; // clock passes expiry, then the refresh fails
    const overrides = { getConfig: cfg, fetchImpl, commitRefreshed: commitRefreshedSession, clearIfCurrent: clearSessionIfCurrent, now: () => nowMs, timeoutMs: 0 };
    const tok = await getAccessToken(overrides);
    check('AF-GAT5: a token that expired during a slow refresh is NOT returned (time re-read after await)',
      tok === null, `tok=${tok}`);
  }

  /* Static pin — the wrapper CANNOT perform an unconditional clear (the root
   *  cause of findings 2 & 3). The symbol must not appear in authClient.ts. --- */
  {
    const src = readFileSync('src/lib/authClient.ts', 'utf8');
    check('STATIC: authClient.ts never references clearSessionUnconditional (no unconditional clear path)',
      !src.includes('clearSessionUnconditional'));
  }

  console.log(`\nOPT-02 ADVERSARIAL INTEGRATION — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
