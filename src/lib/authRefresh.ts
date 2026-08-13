/**
 * @file authRefresh.ts
 * @description OPT-02B / OPT-02-C1 (F1) — the BASIS-EXPLICIT single-flight
 * access-token refresh coordinator.
 *
 * BASIS-EXPLICIT (v8 F1, audit finding 1)
 * ---------------------------------------
 * The caller PASSES the session it wants refreshed — the coordinator never reads
 * storage to choose its basis. This is what stops an obsolete request from
 * refreshing (mutating) a NEWER login: an old request captured Session E1; if a
 * newer login E2 has replaced it, the old request still refreshes E1 — which the
 * server rejects or whose commit the storage guard drops — and E2 is never
 * touched by the stale context.
 *
 * THE INVARIANTS (spec §2 / §8):
 *   1. At most one refresh runs per session chain (keyed by `basis.refreshToken`).
 *      Concurrent callers refreshing the SAME chain coalesce onto one network
 *      call; a refresh of a different chain never collapses onto it.
 *   2. Concurrent callers of the same chain await the SAME promise and get the
 *      SAME result.
 *   3. A confirmed-invalid refresh token clears the session via the EXACT-basis
 *      guard (`clearSessionIfCurrent(basis)`), inside the coordinator only.
 *   4. A network timeout / DNS failure / temporary 5xx does NOT clear the
 *      session — it returns a recoverable `temporarily_unavailable`.
 *   5. The in-flight handle for a chain is removed after BOTH success and
 *      failure (identity-guarded, so only our own entry is removed), so a later
 *      genuine refresh is never blocked by a stale promise and there is no loop.
 *   6. COMMIT-RESPECT → `stale_session`: if the rotated session cannot be
 *      committed because the basis is no longer the stored session, the refresh
 *      reports `stale_session` — a losing refresh says it lost rather than
 *      pretending it refreshed. The stored (newer) session wins.
 *   7. The network call and successful response-body parse abort after `timeoutMs` (default 12 000, per v8 F1);
 *      the timeout keeps the loop alive until it fires (so a hung refresh always
 *      resolves to `temporarily_unavailable`) and is cleared on the normal path.
 *
 * The pre-OPT-02 `refreshSession()` in auth.ts did `storeSession(null)` on ANY
 * `!res.ok`, which meant a single 500 or 503 signed the user out. That bug stays
 * fixed here: only a response that PROVES the refresh token is invalid clears
 * the session, and only under the exact basis.
 *
 * Testability: the network + storage boundary is injected via `RefreshDeps`
 * with real defaults, so the concurrency and error-mapping tests exercise this
 * exact code with a counting fake fetch — no Vite/browser/Supabase required.
 */
import type { AuthSession, RefreshResult } from './authState';
import { getSupabaseConfig } from './supabase';
import {
  commitRefreshedSession,
  clearSessionIfCurrent,
  decodeSub,
} from './authStorage';
import { emitAuthLifecycleEvent } from './authEvents';

export interface RefreshDeps {
  /** Resolve the Supabase config (url + anon key), or null when unconfigured. */
  getConfig: () => { url: string; anonKey: string } | null;
  /** Commit the rotated session iff `basis` is still current. Returns applied. */
  commitRefreshed: (next: AuthSession, basis: AuthSession) => boolean;
  /** Clear the session because refresh was confirmed invalid (exact-basis guard). */
  clearIfCurrent: (basis: AuthSession) => boolean;
  /** Fetch implementation. */
  fetchImpl: typeof fetch;
  /** Milliseconds clock (for computing expiresAt). */
  now: () => number;
  /** Abort the refresh network call after this many ms (0 disables). */
  timeoutMs: number;
}

const defaultDeps: RefreshDeps = {
  getConfig: getSupabaseConfig,
  commitRefreshed: commitRefreshedSession,
  clearIfCurrent: clearSessionIfCurrent,
  fetchImpl: (input, init) => fetch(input, init),
  now: () => Date.now(),
  timeoutMs: 12000,
};

/**
 * Build an abort signal that fires after `ms`, with a timer that never keeps the
 * event loop alive. Returns a `cancel` to clear it on the normal path.
 */
function makeTimeout(ms: number): { signal: AbortSignal | undefined; cancel: () => void } {
  if (!ms || ms <= 0 || typeof AbortController === 'undefined') {
    return { signal: undefined, cancel: () => { /* no-op */ } };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  // NB: the timer is deliberately NOT unref'd. Its job is to settle an awaited
  // authentication promise, so it must keep the event loop alive until it fires
  // (otherwise a hung refresh could let the process exit with an unsettled
  // await). The normal path clears it immediately via `cancel()` in a finally,
  // so it never lingers past the request.
  return { signal: ac.signal, cancel: () => clearTimeout(timer) };
}

/**
 * Do exactly one refresh network round-trip against the caller's `basis` and map
 * it to a typed result. NOT single-flighted itself — callers must go through
 * `refreshSessionSingleFlight` so concurrent callers of the same chain coalesce.
 */
async function performRefresh(basis: AuthSession, deps: RefreshDeps): Promise<RefreshResult> {
  const cfg = deps.getConfig();
  // No config → there is nothing to recover against. Not a transport failure.
  if (!cfg) return { status: 'invalid_session' };

  const base = cfg.url.replace(/\/$/, '');
  const { signal, cancel } = makeTimeout(deps.timeoutMs);
  let data: any;
  try {
    const res = await deps.fetchImpl(`${base}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: basis.refreshToken }),
      signal: signal ?? null,
    });

    // 5xx (and 408/429) are transient server conditions — keep the session.
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      return { status: 'temporarily_unavailable', reason: 'server_error' };
    }

    // 400/401/403 from the token endpoint prove THIS refresh token is dead.
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      // Exact-basis guarded clear — the coordinator's sole destructive act. If a
      // newer session replaced the basis, the guard fails and it survives.
      deps.clearIfCurrent(basis);
      return { status: 'invalid_session' };
    }

    if (!res.ok) {
      // Any other non-OK status: be conservative and treat as recoverable rather
      // than destroying a potentially-valid session on an unexpected code.
      return { status: 'temporarily_unavailable', reason: 'server_error' };
    }

    // Keep the same network deadline active through parsing. `fetch()` resolves
    // at headers; cancelling before `json()` allowed a stalled success body to
    // leave every coalesced refresh caller waiting indefinitely.
    try {
      data = await res.json();
    } catch {
      return { status: 'temporarily_unavailable', reason: 'server_error' };
    }
  } catch {
    // Network down / DNS / timeout / abort — NOT a revocation. Keep the session.
    return { status: 'temporarily_unavailable', reason: 'offline' };
  } finally {
    cancel();
  }
  if (!data?.access_token || !data?.refresh_token) {
    // Malformed success body — don't fabricate a session, don't nuke the old one.
    return { status: 'temporarily_unavailable', reason: 'server_error' };
  }

  const next: AuthSession = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Math.floor(deps.now() / 1000) + (data.expires_in ?? 3600),
  };
  // Commit under the basis guard. COMMIT-RESPECT (F1): if a newer session
  // replaced the basis while we were in flight, the commit is dropped — and we
  // report that we LOST (`stale_session`) rather than handing back a session the
  // store refused to install. The stored session wins.
  const applied = deps.commitRefreshed(next, basis);
  if (!applied) return { status: 'stale_session' };
  // OPT-02E-B2: tell the app layer a rotation LANDED so it can broadcast
  // SESSION_REFRESHED to peer tabs (which adopt the persisted token instead of
  // racing their own refresh with stale credentials).
  emitAuthLifecycleEvent({ type: 'session_refreshed', userId: decodeSub(next.accessToken) ?? '' });
  return { status: 'refreshed', session: next };
}

/** In-flight refreshes, keyed by the basis refresh token being refreshed. */
const inFlight = new Map<string, Promise<RefreshResult>>();

/**
 * OPT-02B / F1 — refresh EXACTLY the caller's `basis` chain, coalescing
 * concurrent refreshes of the same chain into one network call. The coordinator
 * never reads storage to choose a basis (v8: basis-explicit). The per-chain
 * handle is removed in `finally` (only if it is still ours), so the next genuine
 * refresh starts fresh.
 *
 * Production calls this with just the basis (real deps). Tests pass fakes.
 */
export function refreshSessionSingleFlight(
  basis: AuthSession,
  overrides?: Partial<RefreshDeps>,
): Promise<RefreshResult> {
  const deps: RefreshDeps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
  const key = basis.refreshToken;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = performRefresh(basis, deps).finally(() => {
    // Identity-guarded: only remove the entry if it is still the one we set.
    if (inFlight.get(key) === p) inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

/** TEST-ONLY: is any refresh currently in flight? (Used to assert coalescing.) */
export function __isRefreshInFlight(): boolean {
  return inFlight.size > 0;
}

/** TEST-ONLY: force-clear all in-flight handles between test cases. */
export function __resetRefreshInFlightForTests(): void {
  inFlight.clear();
}
