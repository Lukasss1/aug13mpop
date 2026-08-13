/**
 * opt02-logout-scope.test.ts — EXECUTABLE unit tests for the OPT-02-C1 round-8
 * revocation-scope rule. Every assertion is by URL ARGUMENT CAPTURE on a fake
 * fetchImpl — the scope is pinned by the actual request URL, NOT by behaviour
 * (a globally-revoked session's access JWT stays valid ~1h, so a behavioural
 * check would pass while the bug shipped).
 *
 * Proves:
 *   - lifecycle revocation (bestEffortRevokeSession) is scope=local, bearer = the
 *     held chain's token, exactly one call;
 *   - postLogout requires an explicit scope and emits it verbatim (local/global/others);
 *   - the URL is built via `URL` (correct encoding, trailing-slash safe);
 *   - NEGATIVE PIN: no logout URL emitted by these helpers ever lacks a scope=
 *     parameter — the implicit server default is banned by test, not just by rule;
 *   - the raw layer is storage-inert: revoking never mutates the session store.
 *
 * Run: npm exec --offline -- tsx scripts/opt02-logout-scope.test.ts
 */
import type { RawAuthDeps } from '../src/lib/authState';
import { postLogout, bestEffortRevokeSession } from '../src/lib/authRaw';
import {
  __resetAuthStorageForTests,
  __createMemoryStoreForTests,
  setAuthoritativeSession,
  readSession,
  currentSessionVersion,
} from '../src/lib/authStorage';

let passed = 0, failed = 0;
const check = (n: string, cond: boolean, d = '') => {
  if (cond) { passed++; console.log(`\u2714 ${n}`); }
  else { failed++; console.error(`\u2716 ${n}\n    ${d}`); }
};

interface Captured { url: string; init: RequestInit }
/** Every logout call captured across the WHOLE suite — for the final negative pin. */
const allCalls: Captured[] = [];

function fakeDeps(over: Partial<RawAuthDeps> = {}): { deps: RawAuthDeps; calls: Captured[] } {
  const calls: Captured[] = [];
  const deps: RawAuthDeps = {
    getConfig: () => ({ url: 'https://proj.supabase.co', anonKey: 'anon-xyz' }),
    fetchImpl: (async (input: any, init: RequestInit = {}) => {
      const rec = { url: String(input), init };
      calls.push(rec); allCalls.push(rec);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    ...over,
  };
  return { deps, calls };
}

/** The reusable rule: a logout URL MUST target the logout path AND carry a
 *  non-empty scope. This is the implicit-default ban expressed as an assertion. */
function isScopedLogout(rawUrl: string): boolean {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.pathname !== '/auth/v1/logout') return false;
  const scope = u.searchParams.get('scope');
  return scope !== null && scope.length > 0;
}
const bearer = (init: RequestInit): string | undefined =>
  (init.headers as Record<string, string> | undefined)?.Authorization;

async function run() {
  /* 1. Lifecycle revocation is scope=local, bearer = the held chain. -------- */
  {
    const { deps, calls } = fakeDeps();
    bestEffortRevokeSession('orphan-token', deps);
    await Promise.resolve();                       // let the fire-and-forget call land
    check('1: bestEffortRevokeSession makes exactly ONE logout call', calls.length === 1, `n=${calls.length}`);
    const u = new URL(calls[0].url);
    check('1: scope=local (by URL capture, not behaviour)', u.searchParams.get('scope') === 'local', calls[0].url);
    check('1: bearer is the orphan chain\u2019s token', bearer(calls[0].init) === 'Bearer orphan-token');
    check('1: apikey header is present', (calls[0].init.headers as any)?.apikey === 'anon-xyz');
  }

  /* 2. postLogout emits the explicit scope verbatim. ----------------------- */
  for (const scope of ['local', 'global', 'others'] as const) {
    const { deps, calls } = fakeDeps();
    await postLogout('tok', scope, deps);
    check(`2: postLogout(_, '${scope}') emits scope=${scope}`,
      calls.length === 1 && new URL(calls[0].url).searchParams.get('scope') === scope, calls[0]?.url);
  }

  /* 3. The URL is built via URL: correct path, trailing-slash safe. --------- */
  {
    const { deps, calls } = fakeDeps({ getConfig: () => ({ url: 'https://proj.supabase.co/', anonKey: 'a' }) });
    await postLogout('tok', 'local', deps);
    const u = new URL(calls[0].url);
    check('3: a trailing slash on the base does not corrupt the path',
      u.pathname === '/auth/v1/logout' && !u.pathname.includes('//'), calls[0].url);
    check('3: scope survives as a proper query parameter', u.searchParams.get('scope') === 'local');
  }

  /* 4. No config → no network call at all. --------------------------------- */
  {
    const { deps, calls } = fakeDeps({ getConfig: () => null });
    await postLogout('tok', 'global', deps);
    check('4: postLogout with no config makes no call', calls.length === 0);
  }

  /* 5. bestEffortRevokeSession never throws, even when the network throws. -- */
  {
    let threw = false;
    const deps: RawAuthDeps = {
      getConfig: () => ({ url: 'https://proj.supabase.co', anonKey: 'a' }),
      fetchImpl: (async () => { throw new Error('network down'); }) as typeof fetch,
    };
    try { bestEffortRevokeSession('tok', deps); } catch { threw = true; }
    await Promise.resolve(); await Promise.resolve();
    check('5: bestEffortRevokeSession swallows a network error (no throw)', threw === false);
  }

  /* 6. Storage-inert sentinel: revoking never mutates the session store. ---- */
  {
    __resetAuthStorageForTests(__createMemoryStoreForTests());
    const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwt = (sub: string) => `x.${b64url(JSON.stringify({ sub }))}.y`;
    setAuthoritativeSession({ accessToken: jwt('u'), refreshToken: 'r-live', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    const vBefore = currentSessionVersion();
    const { deps } = fakeDeps();
    bestEffortRevokeSession('r-live', deps);
    await postLogout('r-live', 'global', deps);
    await Promise.resolve();
    check('6: the raw revoke did NOT clear the stored session', readSession()?.refreshToken === 'r-live');
    check('6: the raw revoke did NOT bump the storage version', currentSessionVersion() === vBefore, `v=${currentSessionVersion()} was=${vBefore}`);
  }

  /* 8. FALLBACK — postLogout still attempts the request in an environment where
   *    AbortSignal.timeout is unavailable (manual-controller fallback). --------- */
  {
    const orig = (AbortSignal as any).timeout;
    try {
      // Simulate a runtime without AbortSignal.timeout.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (AbortSignal as any).timeout = undefined;
      const { deps, calls } = fakeDeps();
      await postLogout('r-fallback', 'local', deps);
      check('8: logout is still ATTEMPTED without AbortSignal.timeout (fallback works)',
        calls.length === 1, `calls=${calls.length}`);
      check('8: the fallback logout still carries the explicit scope and a real signal',
        calls.length === 1 && isScopedLogout(calls[0].url) && !!calls[0].init.signal,
        calls.length ? calls[0].url : 'no call');
    } finally {
      (AbortSignal as any).timeout = orig;
    }
  }

  /* 9. NEGATIVE PIN — every logout URL captured in this suite is scoped. ---- */
  {
    check('9: at least one logout call was captured (guard against a no-op suite)', allCalls.length > 0, `n=${allCalls.length}`);
    const unscoped = allCalls.filter((c) => !isScopedLogout(c.url));
    check('9: NO captured logout URL lacks an explicit scope= (implicit default banned)',
      unscoped.length === 0, unscoped.map((c) => c.url).join(' | '));
    check('9: NO captured logout URL is missing the substring "scope=" ',
      allCalls.every((c) => c.url.includes('scope=')), 'raw substring guard');
  }

  console.log(`\nOPT-02-C1 LOGOUT-SCOPE UNIT — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
