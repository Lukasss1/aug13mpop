/**
 * @file authRaw.ts
 * @description OPT-02-C1 — RAW GoTrue network calls, spoken directly over an
 * injected `fetchImpl` (no auth-SDK client). Round 8 lands the logout helpers
 * here first, because at this point in the patch sequence they have no dependents
 * yet — the cheapest, safest moment to introduce them.
 *
 * THE ONE RULE THIS FILE ENFORCES (spec §1 rule 10, §4)
 * -----------------------------------------------------
 * Every `/auth/v1/logout` call states its scope EXPLICITLY. No call may inherit
 * GoTrue's server default — which is `global`, and would sign the employee out of
 * every device they hold, including the one they are actively using. The failure
 * is insidious (the winning session's access JWT stays valid ~1h, so smoke tests
 * pass and the "signed out everywhere" mystery only surfaces later), so the
 * requirement is encoded structurally: `scope` is a REQUIRED parameter, and
 * lifecycle code is handed only `bestEffortRevokeSession`, which is `local` by
 * construction. A global revocation from lifecycle code is unrepresentable.
 *
 * STORAGE-INERT (rule 4a): nothing here touches session storage. Authenticating,
 * or revoking, is a network fact — it must never, as a side effect, mutate what
 * the app believes about being signed in. Proven by the sentinel/spy tests.
 */
import type { RawAuthDeps } from './authState';
import { getSupabaseConfig } from './supabase';

/** GoTrue logout scopes. `local` = this session chain only; `global` = all of
 *  the user's sessions; `others` = every session EXCEPT the presented one. */
export type LogoutScope = 'local' | 'global' | 'others';

/** The default raw dependencies: real config + global fetch, and NOTHING that
 *  could persist a session (see RawAuthDeps' no-auto-persisting-client rule). */
export const defaultRawAuthDeps: RawAuthDeps = {
  getConfig: getSupabaseConfig,
  fetchImpl: (input, init) => fetch(input, init),
};

/**
 * A bounded abort signal for the logout call, built from a manual
 * AbortController so it works in environments where `AbortSignal.timeout` is not
 * available (older runtimes, some SSR/edge shims, test doubles). Relying on
 * `AbortSignal.timeout` alone would throw there and the logout fetch would never
 * be attempted at all. Returns a `cancel` to clear the timer on the normal path.
 */
function createTimeoutSignal(ms: number): { signal: AbortSignal | undefined; cancel: () => void } {
  if (typeof AbortController === 'undefined') {
    return { signal: undefined, cancel: () => { /* no-op */ } };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

/**
 * Low-level logout. `scope` is REQUIRED — no call site may inherit the server
 * default. Best-effort by nature (a revoked GoTrue access JWT can remain valid
 * until it expires; logout's real job is to stop future refreshes), so callers
 * do not depend on its success to hide private data — that is done locally first.
 *
 * The URL is built through `URL` so the `scope` query parameter is always encoded
 * correctly and a trailing slash on the configured base is handled safely.
 */
export async function postLogout(
  accessToken: string,
  scope: LogoutScope,
  deps: RawAuthDeps = defaultRawAuthDeps,
): Promise<void> {
  const cfg = deps.getConfig();
  if (!cfg) return;
  const base = cfg.url.replace(/\/$/, '');
  const url = new URL(`${base}/auth/v1/logout`);
  url.searchParams.set('scope', scope);
  // Short, self-cancelling: a hanging logout must not wedge a sign-out flow.
  // Manual controller (not AbortSignal.timeout) so it degrades gracefully.
  const { signal, cancel } = createTimeoutSignal(4000);
  try {
    await deps.fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${accessToken}`,
      },
      signal: signal ?? null,
    });
  } finally {
    cancel();
  }
}

/**
 * The ONLY revocation entry point for lifecycle code. The name states the
 * semantics: it revokes THIS session chain (`scope=local`) and can never sign the
 * user out elsewhere. Swallows all errors — a failed server revoke never blocks
 * the local sign-out that already happened.
 *
 * Lifecycle modules import this and NOT `postLogout`, so a global revocation from
 * lifecycle code cannot be written by accident.
 */
export function bestEffortRevokeSession(accessToken: string, deps?: RawAuthDeps): void {
  void postLogout(accessToken, 'local', deps).catch(() => { /* best effort */ });
}
