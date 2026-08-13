/**
 * opt02-request-wrapper.test.ts — EXECUTABLE unit tests for OPT-02C / F2, the
 * central authenticated-request wrapper. Every boundary is injected
 * (snapshot/rebind/refresh/exact-clear/emit/fetch/config); behaviour is proven,
 * not grepped. Preserves the original §14–§19 intent and adds the v8/audit F2
 * rules: basis-explicit refresh, rebind-only retry, replay policy, guarded
 * clears, emit-iff-empty, expectedLineage binding, and apikey handling.
 *
 * Run: npm exec --offline -- tsx scripts/opt02-request-wrapper.test.ts
 */
import type { AuthSession, RefreshResult, SessionLineage, AuthSnapshot } from '../src/lib/authState';
import type { AuthLifecycleEvent } from '../src/lib/authEvents';
import type { AuthedRequestDeps } from '../src/lib/authClient';
import { authenticatedRequest } from '../src/lib/authClient';

let passed = 0, failed = 0;
const check = (n: string, cond: boolean, d = '') => {
  if (cond) { passed++; console.log(`\u2714 ${n}`); }
  else { failed++; console.error(`\u2716 ${n}\n    ${d}`); }
};

const L = (userId: string, authEpoch: string): SessionLineage => ({ userId, authEpoch });
const baseLineage = L('user-a', 'epoch-1');
const sess = (token = 'tok-1', refresh = 'r-1'): AuthSession => ({ accessToken: token, refreshToken: refresh, expiresAt: Date.now() / 1000 + 3600 });
const jsonResponse = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json' } });

/**
 * A harness modelling the storage authority as a small mutable cell, so refresh
 * and fetch closures can rotate/replace the "stored" session mid-flight exactly
 * as a real concurrent login/rotation would. `getSessionIfLineage` and
 * `clearIfCurrent` read/write that cell, matching the real semantics.
 */
function harness(opts: {
  responses: Array<(init: RequestInit) => Promise<Response>>;
  refresh?: (basis: AuthSession) => Promise<RefreshResult>;
  session?: AuthSession | null;
  lineage?: SessionLineage | null;
  getConfig?: () => { url: string; anonKey: string } | null;
}) {
  const entrySession = opts.session === undefined ? sess() : opts.session;
  const entryLineage = opts.lineage === undefined ? baseLineage : opts.lineage;
  // The mutable "store": current session + the lineage it belongs to.
  const store: { session: AuthSession | null; lineage: SessionLineage | null } = {
    session: entrySession, lineage: entrySession ? entryLineage : null,
  };
  let fetchCalls = 0, cleared = 0;
  const events: AuthLifecycleEvent[] = [];
  const sameLc = (a: SessionLineage | null, b: SessionLineage | null) =>
    !!a && !!b && a.userId === b.userId && a.authEpoch === b.authEpoch;
  const deps: Partial<AuthedRequestDeps> = {
    readSnapshot: (): AuthSnapshot => ({ session: store.session, lineage: store.session ? store.lineage : null }),
    getSessionIfLineage: (expected) => (sameLc(store.lineage, expected) ? store.session : null),
    refresh: (async (basis: AuthSession) =>
      opts.refresh ? opts.refresh(basis) : ({ status: 'invalid_session' } as RefreshResult)) as AuthedRequestDeps['refresh'],
    clearIfCurrent: (basis: AuthSession) => {
      if (store.session && store.session.refreshToken === basis.refreshToken) {
        store.session = null; store.lineage = null; cleared++; return true;
      }
      return false;
    },
    emit: (e) => { events.push(e); },
    getConfig: opts.getConfig ?? (() => ({ url: 'https://proj.supabase.co', anonKey: 'anon-key' })),
    fetchImpl: (async (_i: any, init: any) => {
      const idx = Math.min(fetchCalls, opts.responses.length - 1);
      fetchCalls++;
      return opts.responses[idx](init);
    }) as typeof fetch,
  };
  return {
    deps, store, events,
    get fetchCalls() { return fetchCalls; },
    get cleared() { return cleared; },
    /** Install a rotated/replaced session (models a concurrent login/rotation). */
    put(session: AuthSession | null, lineage: SessionLineage | null) { store.session = session; store.lineage = lineage; },
  };
}

async function run() {
  /* 14. 401 -> refresh OK (same ceremony) -> retry once -> success. -------- */
  {
    const h = harness({
      responses: [async () => jsonResponse({}, 401), async () => jsonResponse({ ok: true }, 200)],
      refresh: async () => { h.put(sess('tok-2', 'r-2'), baseLineage); return { status: 'refreshed', session: sess('tok-2', 'r-2') }; },
    });
    const r = await authenticatedRequest<{ ok: boolean }>('https://proj.supabase.co/x', {}, { deps: h.deps });
    check('14: 401 -> refresh -> retry -> success (2 fetches, no clear)',
      r.status === 'success' && (r as any).data.ok === true && h.fetchCalls === 2 && h.cleared === 0,
      `status=${r.status} fetches=${h.fetchCalls} cleared=${h.cleared}`);
  }

  /* 15. 401 -> refresh invalid, coordinator emptied the store -> unauthorised. */
  {
    const h = harness({
      responses: [async () => jsonResponse({}, 401)],
      // The coordinator performs its OWN exact-basis clear on invalid_session.
      refresh: async () => { h.put(null, null); return { status: 'invalid_session' }; },
    });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps });
    check('15: 401 + dead refresh (store now empty) -> unauthorised + session_expired(refresh_rejected), wrapper did NOT clear',
      r.status === 'unauthorised' && h.cleared === 0
      && h.events.some((e) => e.type === 'session_expired' && (e as any).reason === 'refresh_rejected'),
      `status=${r.status} cleared=${h.cleared} events=${JSON.stringify(h.events)}`);
  }

  /* 16. 401 -> refresh OK -> STILL 401 (same token current) -> exact clear. - */
  {
    const h = harness({
      responses: [async () => jsonResponse({}, 401), async () => jsonResponse({}, 401)],
      refresh: async () => { h.put(sess('tok-2', 'r-2'), baseLineage); return { status: 'refreshed', session: sess('tok-2', 'r-2') }; },
    });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps });
    check('16: 401 -> refresh -> 401 stops after one retry; exact-token clear + session_expired(unauthorised)',
      r.status === 'unauthorised' && h.fetchCalls === 2 && h.cleared === 1
      && h.events.some((e) => e.type === 'session_expired' && (e as any).reason === 'unauthorised'),
      `status=${r.status} fetches=${h.fetchCalls} cleared=${h.cleared}`);
  }

  /* 17. 403 -> revalidate profile, NO logout. ----------------------------- */
  {
    const h = harness({ responses: [async () => jsonResponse({ error: 'forbidden' }, 403)] });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps });
    check('17: 403 -> forbidden, NO clear, emits revalidate_profile(forbidden)',
      r.status === 'forbidden' && h.cleared === 0
      && h.events.some((e) => e.type === 'revalidate_profile' && (e as any).trigger === 'forbidden'),
      `status=${r.status} cleared=${h.cleared}`);
  }

  /* 18. 5xx / network -> temporary, session kept. ------------------------- */
  {
    const h = harness({ responses: [async () => jsonResponse({}, 503)] });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps });
    check('18: 503 -> temporarily_unavailable retryable, NO clear',
      r.status === 'temporarily_unavailable' && (r as any).retryable === true && h.cleared === 0, `status=${r.status}`);
  }
  {
    const h = harness({ responses: [async () => { throw new TypeError('offline'); }] });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps });
    check('18: network throw -> temporarily_unavailable, NO clear',
      r.status === 'temporarily_unavailable' && h.cleared === 0, `status=${r.status}`);
  }

  /* 19. 401 -> refresh temporarily unavailable -> recoverable, NO logout. -- */
  {
    const h = harness({
      responses: [async () => jsonResponse({}, 401)],
      refresh: async () => ({ status: 'temporarily_unavailable', reason: 'offline' }),
    });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps });
    check('19: 401 but refresh unreachable -> temporarily_unavailable, NO clear',
      r.status === 'temporarily_unavailable' && h.cleared === 0, `status=${r.status}`);
  }

  /* No session at all -> unauthorised, no fetch. -------------------------- */
  {
    const h = harness({ responses: [async () => jsonResponse({}, 200)], session: null });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps });
    check('no session -> unauthorised immediately, zero fetches, session_expired(unauthorised)',
      r.status === 'unauthorised' && h.fetchCalls === 0
      && h.events.some((e) => e.type === 'session_expired' && (e as any).reason === 'unauthorised'),
      `status=${r.status} fetches=${h.fetchCalls}`);
  }

  /* Parse modes on 2xx. --------------------------------------------------- */
  {
    const h = harness({ responses: [async () => jsonResponse('plain text body', 200)] });
    const r = await authenticatedRequest<string>('https://proj.supabase.co/x', {}, { deps: h.deps, parse: 'text' });
    check("parse 'text' returns the raw string", r.status === 'success' && (r as any).data === 'plain text body');
  }
  {
    const h = harness({ responses: [async () => new Response(null, { status: 204 })] });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps, parse: 'none' });
    check("parse 'none' + 204 -> success with undefined data", r.status === 'success' && (r as any).data === undefined);
  }
  {
    // A malformed JSON body on a 2xx is a typed failure, not a silent success.
    const h = harness({ responses: [async () => new Response('{ not json', { status: 200, headers: { 'content-type': 'application/json' } })] });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps });
    check('malformed JSON 2xx -> failed(MALFORMED_RESPONSE), not success-with-undefined',
      r.status === 'failed' && (r as any).code === 'MALFORMED_RESPONSE', `status=${r.status} code=${(r as any).code}`);
  }

  /* ---- AUDIT-F5: retry carries the REBOUND current token, not the raw refresh result ---- */
  {
    let sentTokens: string[] = [];
    const h = harness({
      responses: [
        async () => jsonResponse({}, 401),
        async (init) => { sentTokens.push(new Headers(init.headers).get('Authorization') || ''); return jsonResponse({ ok: true }, 200); },
      ],
      // refresh returns A2, but the store is rotated further to A3 (same ceremony) BEFORE retry.
      refresh: async () => { h.put(sess('tok-A3', 'r-A3'), baseLineage); return { status: 'refreshed', session: sess('tok-A2', 'r-A2') }; },
    });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps });
    check('F5: retry uses the REBOUND current token (A3), not the raw refresh result (A2)',
      r.status === 'success' && sentTokens[0] === 'Bearer tok-A3', `sent=${sentTokens[0]}`);
  }

  /* ---- AUDIT-F2/round-7: retried-401 under a same-lineage SURVIVOR -> superseded, survivor kept ---- */
  {
    const h = harness({
      responses: [
        async () => jsonResponse({}, 401),
        async () => { h.put(sess('tok-A3', 'r-A3'), baseLineage); return jsonResponse({}, 401); }, // A2 rebound retried; store rotates to A3 during retry
      ],
      refresh: async () => { h.put(sess('tok-A2', 'r-A2'), baseLineage); return { status: 'refreshed', session: sess('tok-A2', 'r-A2') }; },
    });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps });
    check('F2: retried 401 but a same-lineage rotation (A3) survives -> superseded, NO clear, A3 preserved',
      r.status === 'superseded' && h.cleared === 0 && h.store.session?.refreshToken === 'r-A3'
      && !h.events.some((e) => e.type === 'session_expired'),
      `status=${r.status} cleared=${h.cleared} stored=${h.store.session?.refreshToken}`);
  }

  /* ---- AUDIT-F3: invalid_session but a same-epoch session SURVIVES -> superseded (wrapper never clears) ---- */
  {
    const h = harness({
      responses: [async () => jsonResponse({}, 401)],
      // coordinator's exact-basis clear misses because the store already rotated to F2 (same ceremony).
      refresh: async () => { h.put(sess('tok-F2', 'r-F2'), baseLineage); return { status: 'invalid_session' }; },
    });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps });
    check('F3: invalid_session with a surviving same-epoch session -> superseded, F2 kept, no emit, no wrapper clear',
      r.status === 'superseded' && h.cleared === 0 && h.store.session?.refreshToken === 'r-F2'
      && !h.events.some((e) => e.type === 'session_expired'),
      `status=${r.status} cleared=${h.cleared} stored=${h.store.session?.refreshToken}`);
  }

  /* ---- AUDIT-F2 stale_session -> superseded ---- */
  {
    const h = harness({
      responses: [async () => jsonResponse({}, 401)],
      refresh: async () => ({ status: 'stale_session' }),
    });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps });
    check('F2: refresh stale_session -> superseded, NO clear', r.status === 'superseded' && h.cleared === 0, `status=${r.status}`);
  }

  /* ---- AUDIT-F4: replay policy — unsafe POST is NOT auto-replayed ---- */
  {
    // Default policy: a POST is not replay-safe. After a successful refresh -> retry_required, ONE fetch.
    const h = harness({
      responses: [async () => jsonResponse({}, 401), async () => jsonResponse({ ok: true }, 200)],
      refresh: async () => { h.put(sess('tok-2', 'r-2'), baseLineage); return { status: 'refreshed', session: sess('tok-2', 'r-2') }; },
    });
    const r = await authenticatedRequest('https://proj.supabase.co/x', { method: 'POST', body: '{"a":1}' }, { deps: h.deps });
    check('F4: unsafe POST healed but NOT replayed -> retry_required, exactly ONE fetch (refresh DID run)',
      r.status === 'retry_required' && h.fetchCalls === 1, `status=${r.status} fetches=${h.fetchCalls}`);
  }
  {
    // A GET IS replay-safe -> retried -> success, two fetches (matches §14 path for GET).
    const h = harness({
      responses: [async () => jsonResponse({}, 401), async () => jsonResponse({ ok: true }, 200)],
      refresh: async () => { h.put(sess('tok-2', 'r-2'), baseLineage); return { status: 'refreshed', session: sess('tok-2', 'r-2') }; },
    });
    const r = await authenticatedRequest('https://proj.supabase.co/x', { method: 'GET' }, { deps: h.deps });
    check('F4: safe GET is replayed -> success, two fetches', r.status === 'success' && h.fetchCalls === 2, `fetches=${h.fetchCalls}`);
  }
  {
    // A POST the caller VOUCHES is idempotent IS replayed.
    const h = harness({
      responses: [async () => jsonResponse({}, 401), async () => jsonResponse({ ok: true }, 200)],
      refresh: async () => { h.put(sess('tok-2', 'r-2'), baseLineage); return { status: 'refreshed', session: sess('tok-2', 'r-2') }; },
    });
    const r = await authenticatedRequest('https://proj.supabase.co/x', { method: 'POST', body: '{"a":1}' }, { deps: h.deps, retryPolicy: 'explicitly-idempotent' });
    check("F4: 'explicitly-idempotent' POST IS replayed -> success, two fetches", r.status === 'success' && h.fetchCalls === 2, `fetches=${h.fetchCalls}`);
  }
  {
    // 'never' disables replay even for a GET.
    const h = harness({
      responses: [async () => jsonResponse({}, 401), async () => jsonResponse({ ok: true }, 200)],
      refresh: async () => { h.put(sess('tok-2', 'r-2'), baseLineage); return { status: 'refreshed', session: sess('tok-2', 'r-2') }; },
    });
    const r = await authenticatedRequest('https://proj.supabase.co/x', { method: 'GET' }, { deps: h.deps, retryPolicy: 'never' });
    check("F4: retryPolicy 'never' -> retry_required, ONE fetch", r.status === 'retry_required' && h.fetchCalls === 1, `fetches=${h.fetchCalls}`);
  }

  /* ---- AUDIT-F7: expectedLineage binding ---- */
  {
    // Caller bound to a ceremony the store no longer holds -> superseded, ZERO fetches, no side effects.
    const h = harness({ responses: [async () => jsonResponse({ ok: true }, 200)] });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps, expectedLineage: L('user-a', 'epoch-OLD') });
    check('F7: expectedLineage mismatch -> superseded, ZERO fetches, no clear, no emit',
      r.status === 'superseded' && h.fetchCalls === 0 && h.cleared === 0 && h.events.length === 0, `status=${r.status} fetches=${h.fetchCalls}`);
  }
  {
    // Matching expectedLineage proceeds normally.
    const h = harness({ responses: [async () => jsonResponse({ ok: true }, 200)] });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps, expectedLineage: baseLineage });
    check('F7: matching expectedLineage proceeds -> success', r.status === 'success' && h.fetchCalls === 1);
  }

  /* ---- 2xx lineage POST-CHECK: identity changed mid-flight -> superseded ---- */
  {
    const h = harness({
      responses: [async () => { h.put(sess('tok-B', 'r-B'), L('user-b', 'epoch-2')); return jsonResponse({ secret: 'user-a data' }, 200); }],
    });
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps: h.deps });
    check('2xx post-check: identity changed mid-flight -> superseded (old data not surfaced)', r.status === 'superseded', `status=${r.status}`);
  }

  /* ---- 2xx PARSE-WINDOW: identity changes WHILE the body is being read -> superseded.
   *      The check must be AFTER parseBody, so a slow/large body cannot leak. ---- */
  {
    let fetchCalls = 0;
    const store: { session: AuthSession | null; lineage: SessionLineage | null } = { session: sess(), lineage: baseLineage };
    const sameLc = (a: SessionLineage | null, b: SessionLineage | null) => !!a && !!b && a.userId === b.userId && a.authEpoch === b.authEpoch;
    // A body whose READ (pull) flips the stored identity to user-b, modelling an
    // account switch during response.text().
    const bodyThatFlipsOnRead = () => new ReadableStream<Uint8Array>({
      pull(controller) {
        store.session = sess('tok-B', 'r-B'); store.lineage = L('user-b', 'epoch-2');
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ secret: 'user-a private' })));
        controller.close();
      },
    });
    const deps: Partial<AuthedRequestDeps> = {
      readSnapshot: () => ({ session: store.session, lineage: store.session ? store.lineage : null }),
      getSessionIfLineage: (e) => (sameLc(store.lineage, e) ? store.session : null),
      refresh: (async () => ({ status: 'invalid_session' as const })) as AuthedRequestDeps['refresh'],
      clearIfCurrent: () => false,
      emit: () => {},
      getConfig: () => ({ url: 'https://proj.supabase.co', anonKey: 'anon-key' }),
      fetchImpl: (async () => { fetchCalls++; return new Response(bodyThatFlipsOnRead(), { status: 200, headers: { 'content-type': 'application/json' } }); }) as typeof fetch,
    };
    const r = await authenticatedRequest('https://proj.supabase.co/x', {}, { deps });
    check('2xx parse-window: identity flips DURING body read -> superseded (post-parse check catches it)',
      r.status === 'superseded' && fetchCalls === 1, `status=${r.status}`);
  }

  /* ---- TRUSTED-ORIGIN header scoping + rejection (both Authorization AND apikey) ---- */
  const cfgSupabase = () => ({ url: 'https://proj.supabase.co', anonKey: 'anon-key' });
  const originHarness = () => {
    let sawAuth: string | null = 'ABSENT';
    let sawApiKey: string | null = 'ABSENT';
    const h = harness({
      responses: [async (init) => {
        sawAuth = new Headers(init.headers).get('Authorization');
        sawApiKey = new Headers(init.headers).get('apikey');
        return jsonResponse({ ok: true }, 200);
      }],
      getConfig: cfgSupabase,
    });
    return { h, auth: () => sawAuth, apikey: () => sawApiKey };
  };
  {
    // Absolute Supabase URL -> BOTH bearer and apikey attached.
    const { h, auth, apikey } = originHarness();
    const r = await authenticatedRequest('https://proj.supabase.co/rest/v1/staff_profiles', {}, { deps: h.deps });
    check('origin: absolute Supabase URL -> bearer AND apikey attached',
      r.status === 'success' && auth() === 'Bearer tok-1' && apikey() === 'anon-key', `auth=${auth()} apikey=${apikey()}`);
  }
  {
    // Absolute third-party URL -> REJECTED before any fetch; JWT never sent.
    const { h, auth } = originHarness();
    const r = await authenticatedRequest('https://evil.example.com/steal', {}, { deps: h.deps });
    check('origin: absolute third-party URL -> failed(UNTRUSTED_ORIGIN), NOT fetched, JWT never sent',
      r.status === 'failed' && (r as any).code === 'UNTRUSTED_ORIGIN' && h.fetchCalls === 0 && auth() === 'ABSENT',
      `status=${r.status} code=${(r as any).code} fetches=${h.fetchCalls}`);
  }
  {
    // A relative input is rejected in EVERY environment — including when there is
    // no globalThis.location (Node/SSR/worker) — with zero fetch and no header
    // able to leave. This is the fail-closed absolute-URL-only contract.
    const prior = (globalThis as any).location;
    delete (globalThis as any).location;               // simulate Node/SSR: no page origin
    try {
      const { h, auth } = originHarness();
      const r = await authenticatedRequest('/internal', {}, { deps: h.deps });
      check('origin: relative input with NO global location -> failed(UNTRUSTED_ORIGIN), zero fetch, JWT never sent',
        r.status === 'failed' && (r as any).code === 'UNTRUSTED_ORIGIN' && h.fetchCalls === 0 && auth() === 'ABSENT',
        `status=${r.status} code=${(r as any).code} fetches=${h.fetchCalls} auth=${auth()}`);
    } finally {
      if (prior === undefined) delete (globalThis as any).location; else (globalThis as any).location = prior;
    }
  }
  {
    // And also rejected WITH a (non-Supabase) page origin present.
    const prior = (globalThis as any).location;
    (globalThis as any).location = { origin: 'https://milkpop.uk' };
    try {
      const { h } = originHarness();
      const r = await authenticatedRequest('/internal', {}, { deps: h.deps });
      check('origin: relative input WITH an app page origin -> still failed(UNTRUSTED_ORIGIN), zero fetch',
        r.status === 'failed' && (r as any).code === 'UNTRUSTED_ORIGIN' && h.fetchCalls === 0, `status=${r.status} fetches=${h.fetchCalls}`);
    } finally {
      if (prior === undefined) delete (globalThis as any).location; else (globalThis as any).location = prior;
    }
  }
  {
    // A caller-supplied apikey on a Supabase URL is PRESERVED; the wrapper OWNS
    // Authorization and overwrites any caller value with the session bearer.
    const { h, auth, apikey } = originHarness();
    const r = await authenticatedRequest('https://proj.supabase.co/rest/v1/x',
      { headers: { apikey: 'custom', Authorization: 'Bearer CALLER-VALUE' } }, { deps: h.deps });
    check('origin: Supabase URL -> caller apikey preserved, caller Authorization OVERWRITTEN with session bearer',
      r.status === 'success' && apikey() === 'custom' && auth() === 'Bearer tok-1', `auth=${auth()} apikey=${apikey()}`);
  }

  console.log(`\nOPT-02 REQUEST-WRAPPER UNIT — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
