/**
 * @file authClient.ts
 * @description OPT-02C / OPT-02-C1 (F2) — the lineage-safe authenticated
 * request primitive used where automatic refresh/replay semantics are required.
 * Domain clients that need server-confirmed mutation-specific error mapping use
 * their own narrow transports instead; those production paths are bounded by
 * requestTimeout.ts so neither approach can wait indefinitely.
 *
 * ALGORITHM (v8 §4 F2 + §1 rules 1, 2, 5, 6, 8):
 *   0. SNAPSHOT + sameLifecycle ENTRY. Capture the session AND its lineage once.
 *      When the caller supplies `expectedLineage` (an operation begun earlier —
 *      e.g. F3's profile load), the wrapper binds to THAT ceremony: if the store
 *      no longer holds it, bail `superseded` with zero fetches and zero side
 *      effects — an obsolete operation never adopts a newer login's session.
 *   1. Send the request with the captured token. The anon apikey is attached
 *      ONLY for same-origin Supabase URLs (never leaked to a third-party host)
 *      and ONLY when the caller has not already supplied one.
 *   2. On the FIRST 401 the single-flight refresh ALWAYS runs (rule 8) — against
 *      the CAPTURED basis session (basis-explicit; never "whatever is current").
 *        - refreshed  → REBIND via getSessionIfLineage(basisLineage) or bail
 *          `superseded` (rule 5). Retry only when the request is REPLAY-SAFE,
 *          and only with the REBOUND current same-ceremony token (never the raw
 *          refresh result — another operation may have rotated it further).
 *          Healed-but-not-replayed → `retry_required` (rule 8).
 *        - stale_session → the commit was dropped; the basis was overtaken →
 *          `superseded` (rule 6: nothing was proven dead).
 *        - temporarily_unavailable → recoverable; do NOT sign out.
 *        - invalid_session → the coordinator has already performed its OWN
 *          exact-basis guarded clear; the wrapper NEVER clears here. Emit
 *          session-expiry IFF the store is now empty; a surviving session
 *          (same-epoch rotation or a newer login) → `superseded`.
 *   3. Retried request STILL 401 (round-7 precision): attempt the EXACT-TOKEN
 *      clear of the session we retried with (`clearSessionIfCurrent`). Success →
 *      the death is proven → emit + `unauthorised`. Failure means something
 *      newer survives (a same-lineage rotation or a new ceremony) → `superseded`
 *      and the survivor is untouched. The unconditional clear is explicit-
 *      logout-only and is never imported or called from this module.
 *   4. On 403: do NOT sign out — emit profile revalidation, return `forbidden`.
 *   5. On network / 5xx: do NOT clear the session — retryable temporary failure.
 *   6. On 2xx: LINEAGE POST-CHECK — if the ceremony changed while the request
 *      was in flight, the body belongs to the OLD identity → `superseded`; User
 *      A's response is never rendered under User B.
 *
 * REPLAY SAFETY (rule 8, audit finding 4): requests are auto re-sent after a
 * refresh only when replay-safe. Default policy `'safe-method'` replays GET/HEAD
 * only; `'explicitly-idempotent'` lets a caller vouch for a mutation it knows is
 * idempotent (e.g. idempotency-keyed); `'never'` disables replay. A streaming
 * body is never replayable (it was consumed), whatever the policy. A blocked
 * replay after a successful refresh returns `retry_required` — the session is
 * healed; the CALLER decides to re-issue its mutation.
 *
 * A `hasRetried` flag makes infinite refresh loops structurally impossible: at
 * most one refresh + one retry per call.
 */
import type {
  AuthenticatedRequestResult,
  AuthErrorCode,
  AuthSession,
  AuthSnapshot,
  SessionLineage,
} from './authState';
import {
  readAuthSnapshot,
  getSessionIfLineage,
  clearSessionIfCurrent,
  sameLifecycle,
} from './authStorage';
import { refreshSessionSingleFlight } from './authRefresh';
import { emitAuthLifecycleEvent } from './authEvents';
import { getSupabaseConfig } from './supabase';
import { timedFetch } from './requestTimeout';

/** v8 rule 8 — when may the wrapper automatically re-send after a refresh? */
export type RetryPolicy = 'never' | 'safe-method' | 'explicitly-idempotent';

export interface AuthedRequestDeps {
  /** Capture the current session + lineage as one coherent snapshot. */
  readSnapshot: () => AuthSnapshot;
  /** The current session IFF the given ceremony still holds (rebind primitive). */
  getSessionIfLineage: (expected: SessionLineage) => AuthSession | null;
  /** Basis-explicit single-flight refresh of EXACTLY the given session chain. */
  refresh: (basis: AuthSession) => ReturnType<typeof refreshSessionSingleFlight>;
  /** EXACT-token guarded clear (the only clear this module may perform). */
  clearIfCurrent: (basis: AuthSession) => boolean;
  /** Emit lifecycle events (expiry / revalidate). */
  emit: typeof emitAuthLifecycleEvent;
  /** Fetch implementation. */
  fetchImpl: typeof fetch;
  /** Supabase config, for the origin-scoped apikey injection. */
  getConfig: () => { url: string; anonKey: string } | null;
}

const defaultDeps: AuthedRequestDeps = {
  readSnapshot: readAuthSnapshot,
  getSessionIfLineage,
  refresh: (basis) => refreshSessionSingleFlight(basis),
  clearIfCurrent: clearSessionIfCurrent,
  emit: emitAuthLifecycleEvent,
  fetchImpl: timedFetch.auth,
  getConfig: getSupabaseConfig,
};

export interface AuthenticatedRequestOptions {
  /**
   * How to interpret a 2xx body. 'json' parses JSON (default), 'text' returns
   * the raw string, 'none' returns undefined (e.g. 204). In every mode the body
   * is fully read BEFORE the final lineage check, so a slow read can never leak
   * an old identity's data. (A raw 'response' mode was removed: handing back an
   * unconsumed Response re-opened exactly that window for a later read.)
   */
  parse?: 'json' | 'text' | 'none';
  /**
   * Bind this request to a ceremony captured EARLIER by the calling operation
   * (F3/F4 provenance). If the store no longer holds that ceremony, the wrapper
   * bails `superseded` before any network activity. Omitted → binds to the
   * ceremony current at entry.
   */
  expectedLineage?: SessionLineage;
  /** Replay policy after a successful mid-request refresh. Default 'safe-method'. */
  retryPolicy?: RetryPolicy;
  /** Override dependencies (tests only). */
  deps?: Partial<AuthedRequestDeps>;
}

/**
 * True iff `input` is an ABSOLUTE URL whose origin equals the Supabase origin.
 * Relative inputs are rejected unconditionally (single-arg `new URL` throws on
 * them) — with no reliance on `globalThis.location`, the boundary holds
 * identically in the browser, Node, SSR and workers, and can never resolve a
 * relative path against the Supabase base and then leak the bearer to it. The
 * wrapper is Supabase-only, so requiring absolute Supabase URLs is correct.
 */
function targetsSupabaseOrigin(input: string, base: string): boolean {
  try {
    return new URL(input).origin === new URL(base).origin;
  } catch {
    return false; // relative or malformed input → not a trusted absolute target
  }
}

/**
 * Attach the Authorization bearer AND the anon apikey — but ONLY when the request
 * actually targets the Supabase origin. The access JWT is more sensitive than the
 * anon key, so it must never be sent to a third-party host, an analytics
 * endpoint, or the app's own origin via a relative route. (The wrapper also
 * rejects such destinations outright before fetching — see below — this is the
 * defence-in-depth layer.) The wrapper OWNS the Authorization header for Supabase
 * requests: any caller-supplied Authorization is replaced with the session token.
 * A caller-supplied `apikey` is preserved.
 */
function applyAuthHeaders(
  init: RequestInit,
  token: string,
  input: string,
  cfg: { url: string; anonKey: string } | null,
): RequestInit {
  const headers = new Headers(init.headers as HeadersInit | undefined);
  if (cfg && targetsSupabaseOrigin(input, cfg.url)) {
    headers.set('Authorization', `Bearer ${token}`);
    if (!headers.has('apikey')) headers.set('apikey', cfg.anonKey);
  }
  return { ...init, headers };
}

/**
 * v8 rule 8 + F2 "environment-safe stream check" — may this request be re-sent?
 * A consumed streaming body can never be reconstructed, whatever the policy.
 */
function isReplaySafe(init: RequestInit, policy: RetryPolicy): boolean {
  if (policy === 'never') return false;
  const body: unknown = init.body ?? null;
  if (body !== null
    && typeof ReadableStream !== 'undefined'
    && body instanceof ReadableStream) {
    return false;
  }
  if (policy === 'explicitly-idempotent') return true;
  const method = (init.method ?? 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD';
}

/** Map a non-auth failure status to a stable taxonomy code. */
function codeForStatus(status: number): AuthErrorCode {
  if (status === 0) return 'NETWORK_UNAVAILABLE';
  if (status >= 500) return 'AUTH_SERVICE_UNAVAILABLE';
  return 'SESSION_EXPIRED';
}

/**
 * OPT-02C / F2 — perform an authenticated request with exactly-once refresh+
 * (replay-safe) retry on 401, lineage-aware supersession handling, and correct,
 * non-destructive handling of 403 / 5xx / network errors.
 */
export async function authenticatedRequest<T>(
  input: string,
  init: RequestInit = {},
  options: AuthenticatedRequestOptions = {},
): Promise<AuthenticatedRequestResult<T>> {
  const deps: AuthedRequestDeps = options.deps ? { ...defaultDeps, ...options.deps } : defaultDeps;
  const parse = options.parse ?? 'json';
  const policy = options.retryPolicy ?? 'safe-method';
  const cfg = deps.getConfig();

  const snap = deps.readSnapshot();
  if (!snap.session || !snap.lineage) {
    // No token at all — nothing is signed in (the store is empty, so the
    // expiry emit is consistent with the emit-iff-empty rule).
    deps.emit({ type: 'session_expired', reason: 'unauthorised' });
    return { status: 'unauthorised' };
  }

  // F2 entry binding: an operation that captured its ceremony earlier binds to
  // it here. A mismatch means a newer login/logout overtook the operation —
  // bail with no fetch, no clear, no emit (rule 6).
  if (options.expectedLineage && !sameLifecycle(snap.lineage, options.expectedLineage)) {
    return { status: 'superseded' };
  }

  // TRUSTED-ORIGIN GUARD (fail closed): this wrapper speaks only to Supabase
  // (REST / RPC / Storage / Edge Functions). A destination outside the configured
  // Supabase origin — a mis-built URL, a third-party host, or a relative app
  // route — is refused BEFORE any fetch, so the session JWT and anon key can
  // never be sent anywhere but Supabase. (applyAuthHeaders also scopes the
  // headers, as defence in depth.) When no config is available we cannot verify
  // the origin, so we also refuse rather than risk leaking the token.
  if (!cfg || !targetsSupabaseOrigin(input, cfg.url)) {
    return { status: 'failed', code: 'UNTRUSTED_ORIGIN', retryable: false };
  }

  // The ceremony this request belongs to, and the exact session we captured.
  const basisLineage: SessionLineage = options.expectedLineage ?? snap.lineage;
  const basisSession: AuthSession = snap.session;
  const replayable = isReplaySafe(init, policy);

  let token = basisSession.accessToken;
  /** The exact session whose token the retry carries (guards the retried-401 clear). */
  let retriedWith: AuthSession | null = null;
  let hasRetried = false;

  // A single loop that runs at most twice: initial attempt, then one replay-safe
  // retry after a successful refresh. `hasRetried` is the hard stop.
  while (true) {
    let res: Response;
    try {
      res = await deps.fetchImpl(input, applyAuthHeaders(init, token, input, cfg));
    } catch {
      // Transport failure — keep the session, tell the caller to retry.
      return { status: 'temporarily_unavailable', retryable: true };
    }

    if (res.status === 401) {
      if (hasRetried && retriedWith) {
        // Round-7 precision, corrected (audit F2): the ONLY clear the wrapper may
        // perform is the exact-token guarded clear of the session it retried
        // with. If that exact token is still current, its death is proven →
        // clear + emit + unauthorised. If the guard fails, something NEWER
        // survives (a same-lineage rotation like A3, or a new ceremony) — it is
        // preserved and the obsolete operation reports `superseded`.
        if (deps.clearIfCurrent(retriedWith)) {
          deps.emit({ type: 'session_expired', reason: 'unauthorised' });
          return { status: 'unauthorised' };
        }
        return { status: 'superseded' };
      }
      // First 401 → the basis-explicit single-flight refresh ALWAYS runs
      // (rule 8), against the CAPTURED session — never "whatever is current".
      const refreshed = await deps.refresh(basisSession);
      if (refreshed.status === 'refreshed') {
        // Rebind via the storage authority (rule 5) — the retry token is the
        // CURRENT same-ceremony session, which may already be a further
        // rotation of what the refresh returned. Bail superseded if the
        // ceremony is gone.
        const rebound = deps.getSessionIfLineage(basisLineage);
        if (!rebound) return { status: 'superseded' };
        if (!replayable) {
          // Healed but not replayed (rule 8): the session is fixed; the caller
          // re-issues its (unsafe) request deliberately.
          return { status: 'retry_required' };
        }
        token = rebound.accessToken;
        retriedWith = rebound;
        hasRetried = true;
        continue; // retry once with the rebound token
      }
      if (refreshed.status === 'stale_session') {
        // The refresh's own commit was dropped — the basis was overtaken.
        // Nothing was proven dead (rule 6) → superseded.
        return { status: 'superseded' };
      }
      if (refreshed.status === 'temporarily_unavailable') {
        // Could not reach auth to refresh — recoverable, do NOT sign out.
        return { status: 'temporarily_unavailable', retryable: true };
      }
      // invalid_session — the basis chain is dead. The COORDINATOR has already
      // performed its exact-basis guarded clear; the wrapper never clears here
      // (audit F3). Emit expiry IFF the store is now empty; any survivor (a
      // same-epoch rotation, or a newer login) is preserved → superseded.
      const after = deps.readSnapshot();
      if (!after.session) {
        deps.emit({ type: 'session_expired', reason: 'refresh_rejected' });
        return { status: 'unauthorised' };
      }
      return { status: 'superseded' };
    }

    if (res.status === 403) {
      // Permission/role/store changed — NOT a dead session. Ask the app to
      // reconfirm the profile from the server; return a typed forbidden.
      deps.emit({ type: 'revalidate_profile', trigger: 'forbidden' });
      return { status: 'forbidden' };
    }

    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      return { status: 'temporarily_unavailable', retryable: true };
    }

    if (!res.ok) {
      return { status: 'failed', code: codeForStatus(res.status), retryable: false };
    }

    // 2xx — read the FULL body first (every mode), THEN re-check the lineage.
    // Reading before the check means a slow/large body can't leak: whatever the
    // parse mode, nothing re-readable is handed back, and the ceremony is
    // reconfirmed immediately before returning `success`.
    let bodyText = '';
    try {
      if (res.status !== 204) bodyText = await res.text();
    } catch {
      // Body read failed mid-stream — treat as a transient transport problem.
      return { status: 'temporarily_unavailable', retryable: true };
    }

    // LINEAGE POST-CHECK (after the body is fully consumed). If the ceremony
    // changed at any point during the round-trip OR the read, the body belongs
    // to the OLD identity → superseded (never surfaced).
    if (!deps.getSessionIfLineage(basisLineage)) {
      return { status: 'superseded' };
    }

    if (parse === 'none') return { status: 'success', data: undefined as T, response: res };
    if (parse === 'text') return { status: 'success', data: bodyText as unknown as T, response: res };
    // parse === 'json'
    if (bodyText === '') return { status: 'success', data: undefined as T, response: res };
    try {
      return { status: 'success', data: JSON.parse(bodyText) as T, response: res };
    } catch {
      // A malformed JSON body on a 2xx is a real failure, not a silent success.
      return { status: 'failed', code: 'MALFORMED_RESPONSE', retryable: false };
    }
  }
}
