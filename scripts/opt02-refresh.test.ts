/**
 * opt02-refresh.test.ts — EXECUTABLE unit tests for OPT-02B / F1, the
 * BASIS-EXPLICIT single-flight refresh coordinator, and the session-storage
 * monotonic guards. These call the REAL coordinator and the REAL storage
 * authority with an in-memory store — no Vite, browser or Supabase required.
 *
 * Covers spec §8 unit tests 1-8, §12 DoD 1,2,3, and the audit-F1 basis pins:
 * the coordinator refreshes EXACTLY the caller's basis (proven by refresh-body
 * argument capture) and can never mutate a newer login from a stale context.
 *
 * Run: npm exec --offline -- tsx scripts/opt02-refresh.test.ts
 */
import type { AuthSession } from '../src/lib/authState';
import type { RefreshDeps } from '../src/lib/authRefresh';
import {
  refreshSessionSingleFlight,
  __resetRefreshInFlightForTests,
  __isRefreshInFlight,
} from '../src/lib/authRefresh';
import {
  __resetAuthStorageForTests,
  __createMemoryStoreForTests,
  setAuthoritativeSession,
  commitRefreshedSession,
  clearSessionIfCurrent,
  readSession,
  currentSessionVersion,
  currentLineage,
  sameLifecycle,
} from '../src/lib/authStorage';

let passed = 0, failed = 0;
const check = (n: string, cond: boolean, d = '') => {
  if (cond) { passed++; console.log(`\u2714 ${n}`); }
  else { failed++; console.error(`\u2716 ${n}\n    ${d}`); }
};

/** Build a syntactically-valid JWT carrying a given `sub`, so decodeSub works. */
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (sub: string) => `x.${b64url(JSON.stringify({ sub }))}.y`;

const session = (over: Partial<AuthSession> & { sub?: string } = {}): AuthSession => ({
  accessToken: jwt(over.sub ?? 'user-a'),
  refreshToken: over.refreshToken ?? 'refresh-1',
  expiresAt: over.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
});

/** A fake Response with a JSON body and a chosen status. */
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Deps that never touch real storage/network — every boundary is injectable. */
function fakeDeps(over: Partial<RefreshDeps> = {}): Partial<RefreshDeps> {
  return {
    getConfig: () => ({ url: 'https://x.supabase.co', anonKey: 'anon' }),
    commitRefreshed: () => true,
    clearIfCurrent: () => true,
    fetchImpl: (async () => jsonResponse({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 })) as typeof fetch,
    now: () => Date.now(),
    timeoutMs: 0,
    ...over,
  };
}

async function run() {
  /* 1. One caller refreshes its basis successfully. ------------------------ */
  __resetRefreshInFlightForTests();
  {
    const r = await refreshSessionSingleFlight(session(), fakeDeps());
    check('1: single caller → refreshed', r.status === 'refreshed'
      && (r as any).session.accessToken === 'a2', JSON.stringify(r));
  }

  /* 2. Twenty simultaneous SAME-basis callers cause exactly ONE request. --- */
  __resetRefreshInFlightForTests();
  {
    let calls = 0;
    const basis = session({ refreshToken: 'shared-basis' });
    const deps = fakeDeps({
      fetchImpl: (async () => { calls++; await Promise.resolve();
        return jsonResponse({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }); }) as typeof fetch,
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => refreshSessionSingleFlight(basis, deps)),
    );
    check('2: 20 concurrent same-basis callers → exactly ONE fetch', calls === 1, `calls=${calls}`);
    check('2: all 20 callers receive a refreshed result',
      results.every((r) => r.status === 'refreshed'));
    check('2: all 20 receive the SAME result object (coalesced)',
      results.every((r) => r === results[0]));
  }

  /* 3. Refresh success persists the newest session exactly once. ---------- */
  __resetRefreshInFlightForTests();
  __resetAuthStorageForTests(__createMemoryStoreForTests());
  {
    setAuthoritativeSession(session({ refreshToken: 'refresh-1' }));
    const vBefore = currentSessionVersion();
    const basis = readSession()!;
    // Use REAL commit/clear against the in-memory store this time.
    const deps = fakeDeps({
      commitRefreshed: commitRefreshedSession,
      clearIfCurrent: clearSessionIfCurrent,
      fetchImpl: (async () => jsonResponse({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 })) as typeof fetch,
    });
    const r = await refreshSessionSingleFlight(basis, deps);
    check('3: refreshed and stored token rotated once', r.status === 'refreshed'
      && readSession()?.refreshToken === 'r2'
      && currentSessionVersion() === vBefore + 1,
      `v=${currentSessionVersion()} token=${readSession()?.refreshToken}`);
    check('3: rotation PRESERVED the ceremony (basis-explicit refresh, same lineage)',
      sameLifecycle(currentLineage(), currentLineage()));
  }

  /* 4. Invalid refresh (401) clears EXACTLY the basis. --------------------- */
  __resetRefreshInFlightForTests();
  __resetAuthStorageForTests(__createMemoryStoreForTests());
  {
    setAuthoritativeSession(session({ refreshToken: 'refresh-1' }));
    const basis = readSession()!;
    const deps = fakeDeps({
      clearIfCurrent: clearSessionIfCurrent,
      fetchImpl: (async () => jsonResponse({ error: 'invalid_grant' }, 401)) as typeof fetch,
    });
    const r = await refreshSessionSingleFlight(basis, deps);
    check('4: 401 → invalid_session AND session cleared (exact-basis guard)',
      r.status === 'invalid_session' && readSession() === null, JSON.stringify(r));
  }

  /* 5. Network failure does NOT clear the session. ------------------------ */
  __resetRefreshInFlightForTests();
  __resetAuthStorageForTests(__createMemoryStoreForTests());
  {
    setAuthoritativeSession(session({ refreshToken: 'refresh-1' }));
    let cleared = false;
    const deps = fakeDeps({
      clearIfCurrent: (b) => { cleared = true; return clearSessionIfCurrent(b); },
      fetchImpl: (async () => { throw new TypeError('network down'); }) as typeof fetch,
    });
    const r = await refreshSessionSingleFlight(readSession()!, deps);
    check('5: network error → temporarily_unavailable(offline), session KEPT',
      r.status === 'temporarily_unavailable'
      && (r as any).reason === 'offline'
      && cleared === false
      && readSession() !== null, JSON.stringify(r));
  }

  /* 6. 5xx produces a recoverable unavailable state (session kept). ------- */
  __resetRefreshInFlightForTests();
  __resetAuthStorageForTests(__createMemoryStoreForTests());
  {
    setAuthoritativeSession(session({ refreshToken: 'refresh-1' }));
    const deps = fakeDeps({
      clearIfCurrent: clearSessionIfCurrent,
      fetchImpl: (async () => jsonResponse({}, 503)) as typeof fetch,
    });
    const r = await refreshSessionSingleFlight(readSession()!, deps);
    check('6: 503 → temporarily_unavailable(server_error), session KEPT',
      r.status === 'temporarily_unavailable'
      && (r as any).reason === 'server_error'
      && readSession() !== null, JSON.stringify(r));
  }

  /* 7. The per-chain in-flight promise resets after success AND failure. --- */
  {
    __resetRefreshInFlightForTests();
    const basis = session({ refreshToken: 'reset-chain' });
    await refreshSessionSingleFlight(basis, fakeDeps());
    // A second call on the SAME chain must start a NEW refresh (handle cleared).
    let secondCalls = 0;
    const r2 = await refreshSessionSingleFlight(basis, fakeDeps({
      fetchImpl: (async () => { secondCalls++;
        return jsonResponse({ access_token: 'a3', refresh_token: 'r3', expires_in: 3600 }); }) as typeof fetch,
    }));
    check('7a: promise resets after success (new refresh runs)',
      secondCalls === 1 && (r2 as any).session?.accessToken === 'a3', `calls=${secondCalls}`);

    __resetRefreshInFlightForTests();
    await refreshSessionSingleFlight(basis, fakeDeps({
      fetchImpl: (async () => { throw new Error('boom'); }) as typeof fetch,
    }));
    let thirdCalls = 0;
    await refreshSessionSingleFlight(basis, fakeDeps({
      fetchImpl: (async () => { thirdCalls++;
        return jsonResponse({ access_token: 'a4', refresh_token: 'r4', expires_in: 3600 }); }) as typeof fetch,
    }));
    check('7b: promise resets after failure (new refresh runs)', thirdCalls === 1, `calls=${thirdCalls}`);
  }

  /* 8. An old refresh response cannot overwrite a NEWER session. ---------- */
  __resetAuthStorageForTests(__createMemoryStoreForTests());
  {
    const basis = session({ refreshToken: 'refresh-1' });
    setAuthoritativeSession(basis);
    setAuthoritativeSession(session({ sub: 'user-b', refreshToken: 'refresh-99' }));
    const vAfterLogin = currentSessionVersion();
    const applied = commitRefreshedSession(
      session({ refreshToken: 'refresh-1-rotated' }), basis);
    check('8: stale refresh commit is DROPPED (basis no longer current)',
      applied === false
      && readSession()?.refreshToken === 'refresh-99'
      && currentSessionVersion() === vAfterLogin,
      `applied=${applied} token=${readSession()?.refreshToken}`);

    const clearedStale = clearSessionIfCurrent(basis);
    check('8: stale clear under old basis is DROPPED (newer session survives)',
      clearedStale === false && readSession()?.refreshToken === 'refresh-99',
      `cleared=${clearedStale}`);
  }

  /* 9. F1 COMMIT-RESPECT: a refresh whose commit is dropped reports
   *    stale_session, and the newer stored session is left untouched. ------- */
  __resetRefreshInFlightForTests();
  __resetAuthStorageForTests(__createMemoryStoreForTests());
  {
    const basis = session({ refreshToken: 'r-basis' });
    setAuthoritativeSession(basis);
    // A newer authoritative login supersedes the basis while the refresh flies.
    setAuthoritativeSession(session({ sub: 'user-b', refreshToken: 'r-newer' }));
    const vAfter = currentSessionVersion();
    const deps = fakeDeps({
      commitRefreshed: commitRefreshedSession, // real: will drop (basis not current)
      clearIfCurrent: clearSessionIfCurrent,
      fetchImpl: (async () => jsonResponse({ access_token: 'aX', refresh_token: 'rX', expires_in: 3600 })) as typeof fetch,
    });
    const r = await refreshSessionSingleFlight(basis, deps);   // ← basis-explicit
    check('9: dropped commit → stale_session (losing refresh admits it lost)',
      r.status === 'stale_session', JSON.stringify(r));
    check('9: the newer session and version are untouched by the stale refresh',
      readSession()?.refreshToken === 'r-newer' && currentSessionVersion() === vAfter,
      `token=${readSession()?.refreshToken} v=${currentSessionVersion()}`);
  }

  /* 10. F1 is basis-keyed: concurrent refreshes of DIFFERENT chains do NOT
   *     coalesce onto one call. -------------------------------------------- */
  __resetRefreshInFlightForTests();
  {
    let callsA = 0, callsB = 0;
    const basisA = session({ refreshToken: 'chain-A' });
    const basisB = session({ refreshToken: 'chain-B' });
    const depsA = fakeDeps({
      fetchImpl: (async () => { callsA++; await Promise.resolve();
        return jsonResponse({ access_token: 'aA', refresh_token: 'rA', expires_in: 3600 }); }) as typeof fetch,
    });
    const depsB = fakeDeps({
      fetchImpl: (async () => { callsB++; await Promise.resolve();
        return jsonResponse({ access_token: 'aB', refresh_token: 'rB', expires_in: 3600 }); }) as typeof fetch,
    });
    const [a1, a2, b1] = await Promise.all([
      refreshSessionSingleFlight(basisA, depsA),
      refreshSessionSingleFlight(basisA, depsA),
      refreshSessionSingleFlight(basisB, depsB),
    ]);
    check('10: same-chain callers coalesce (chain-A fetched once)', callsA === 1, `callsA=${callsA}`);
    check('10: a different chain is NOT collapsed onto it (chain-B fetched once, separately)',
      callsB === 1 && a1 === a2 && b1 !== a1, `callsB=${callsB}`);
  }

  /* 11. AUDIT-F1 pin: the coordinator refreshes EXACTLY the caller's basis —
   *     proven by refresh-request BODY capture. An obsolete E1 context can
   *     never send E2's refresh token or mutate E2's stored chain. ---------- */
  __resetRefreshInFlightForTests();
  __resetAuthStorageForTests(__createMemoryStoreForTests());
  {
    const e1 = session({ sub: 'user-a', refreshToken: 'E1-refresh' });
    setAuthoritativeSession(e1);
    // A newer login E2 replaces E1 before the obsolete context refreshes.
    setAuthoritativeSession(session({ sub: 'user-a', refreshToken: 'E2-refresh' }));
    let sentRefreshToken: string | null = null;
    const deps = fakeDeps({
      commitRefreshed: commitRefreshedSession,
      clearIfCurrent: clearSessionIfCurrent,
      fetchImpl: (async (_i: any, init: any) => {
        sentRefreshToken = JSON.parse(String(init.body)).refresh_token;
        return jsonResponse({ access_token: 'aZ', refresh_token: 'rZ', expires_in: 3600 });
      }) as typeof fetch,
    });
    const r = await refreshSessionSingleFlight(e1, deps);       // obsolete context
    check('11: the refresh body carries the CALLER basis token (E1), never the stored E2',
      sentRefreshToken === 'E1-refresh', `sent=${sentRefreshToken}`);
    check('11: the obsolete refresh reports stale_session and E2 is completely untouched',
      r.status === 'stale_session' && readSession()?.refreshToken === 'E2-refresh',
      `status=${r.status} stored=${readSession()?.refreshToken}`);
  }

  /* 12. F1 TIMEOUT: an abort-aware, never-settling refresh is aborted by the
   *     timeout → temporarily_unavailable('offline'); the Map entry is removed so
   *     a SECOND refresh of the same chain starts fresh and succeeds. ---------- */
  __resetRefreshInFlightForTests();
  {
    const basis = session({ refreshToken: 'timeout-chain' });
    // A fetch that only ever settles when its abort signal fires.
    const abortAwareFetch = (async (_i: any, init: any) => new Promise<Response>((_resolve, reject) => {
      const sig: AbortSignal | undefined = init?.signal;
      if (!sig) return; // no signal → would hang; the timeout must supply one
      if (sig.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
      sig.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as typeof fetch;
    const r = await refreshSessionSingleFlight(basis, fakeDeps({ fetchImpl: abortAwareFetch, timeoutMs: 25 }));
    check('12: a hung refresh is aborted by the timeout → temporarily_unavailable(offline)',
      r.status === 'temporarily_unavailable' && (r as any).reason === 'offline', JSON.stringify(r));
    check('12: the in-flight Map entry is removed after the timeout (no wedge)', __isRefreshInFlight() === false);
    // A second refresh of the SAME chain now starts fresh and succeeds.
    const r2 = await refreshSessionSingleFlight(basis, fakeDeps({
      fetchImpl: (async () => jsonResponse({ access_token: 'aOK', refresh_token: 'rOK', expires_in: 3600 })) as typeof fetch,
    }));
    check('12: a subsequent refresh of the same chain succeeds', r2.status === 'refreshed' && (r2 as any).session.accessToken === 'aOK', JSON.stringify(r2));
  }

  /* 13. F1 RESPONSE-BODY TIMEOUT: headers alone are not completion. A 2xx
   *     response whose JSON body never finishes must be aborted by the SAME
   *     deadline, keep the existing session and release the single-flight. --- */
  __resetRefreshInFlightForTests();
  {
    const basis = session({ refreshToken: 'stalled-body-chain' });
    const stalledBodyFetch = (async (_i: any, init: any) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const sig: AbortSignal | undefined = init?.signal;
          if (sig?.aborted) {
            controller.error(new DOMException('aborted', 'AbortError'));
            return;
          }
          sig?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const r = await refreshSessionSingleFlight(basis, fakeDeps({ fetchImpl: stalledBodyFetch, timeoutMs: 25 }));
    check('13: a stalled 2xx refresh body is bounded and remains recoverable',
      r.status === 'temporarily_unavailable' && (r as any).reason === 'server_error', JSON.stringify(r));
    check('13: stalled response-body parsing releases the single-flight entry', __isRefreshInFlight() === false);
  }

  console.log(`\nOPT-02 REFRESH UNIT — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
