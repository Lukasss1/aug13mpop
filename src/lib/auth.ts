/**
 * @file auth.ts
 * @description Supabase Auth client (GoTrue over fetch) — zero dependency,
 * matching the style of lib/supabase.ts.
 *
 * SECURITY MODEL (Block B — read before editing)
 * ----------------------------------------------
 *  - Identity comes ONLY from a Supabase Auth session (a verified JWT issued by
 *    GoTrue after a real password/OTP check). We NEVER reconstruct a session,
 *    a role, or an EmployeeProfile from localStorage. The old forgeable
 *    `milkpop_session` key stays dead.
 *  - The access token IS persisted (GoTrue refresh token) so a browser refresh
 *    keeps the user signed in — but the token is opaque and server-verified;
 *    editing it in devtools just makes it invalid, it cannot mint a role.
 *  - The signed-in user's ROLE and STORE are read from the database
 *    (staff_profiles) through RLS using the session token — never trusted from
 *    the client. This mirrors the per-role RLS migration (Block A).
 *  - When Supabase is not configured, every function is a safe no-op and the
 *    portal shows the honest "sign-in unavailable" notice.
 */
import type { EmployeeProfile } from '../types';
import { bestEffortRevokeSession } from './authRaw';
import { getSupabaseConfig, fromRow } from './supabase';
import { timedFetch } from './requestTimeout';
// OPT-02: session persistence is centralised behind the single storage
// authority; refresh is coalesced through the single-flight coordinator.
import type { AuthSession, MfaFactorsResult } from './authState';
import {
  readSession,
  readAuthSnapshot,
  getSessionIfLineage,
  setAuthoritativeSession,
  clearSessionUnconditional,
  hasSession,
  takeSessionIfUser,
} from './authStorage';
import type { RefreshDeps } from './authRefresh';
import { refreshSessionSingleFlight } from './authRefresh';

// OPT-02: `AuthSession` is now defined once in authState.ts (the single source
// of truth for the auth vocabulary) and re-exported here so existing importers
// — `import { AuthSession } from '.../lib/auth'` — keep working unchanged. The
// persisted-token storage key itself now lives in authStorage.ts, the single
// session-persistence authority; no other module reads or writes it directly.
export type { AuthSession };

export interface AuthResult {
  status: 'ok' | 'not_configured' | 'invalid_credentials' | 'mfa_required' | 'error';
  session?: AuthSession;
  message?: string;
  /** When status === 'mfa_required', the TOTP factor to challenge. */
  factorId?: string;
}

/** A single MFA factor as GoTrue reports it. */
export interface MfaFactor {
  id: string;
  status: 'verified' | 'unverified';
  factor_type: string;   // 'totp'
  friendly_name?: string;
}

// OPT-02: reads go through the single storage authority (authStorage), which
// owns migration of the legacy bare-session shape, the in-memory mirror used in
// tab-only mode, and the monotonic version counter. This thin wrapper keeps the
// existing call sites in this file readable.
function readStoredSession(): AuthSession | null {
  return readSession();
}

/** Sign in with email + password via GoTrue. */
export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { status: 'not_configured' };
  const base = cfg.url.replace(/\/$/, '');
  try {
    const res = await timedFetch.auth(`${base}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    });
    if (res.status === 400 || res.status === 401) {
      // GoTrue returns 400 for bad credentials; 401 for MFA-gated flows.
      const body = await res.json().catch(() => ({} as any));
      if (String(body?.error || body?.msg || '').toLowerCase().includes('mfa')) {
        return { status: 'mfa_required', message: 'Additional verification required.' };
      }
      return { status: 'invalid_credentials', message: 'Email or password not recognised.' };
    }
    if (!res.ok) return { status: 'error', message: `Sign-in failed (${res.status}).` };
    const data = await res.json();
    const session: AuthSession = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    };
    // The password grant returns an aal1 session. If the account has a VERIFIED
    // TOTP factor, we must step up to aal2 before treating the user as signed
    // in. GoTrue signals this via the assurance level: currentLevel aal1,
    // nextLevel aal2. We persist the aal1 session so the challenge/verify calls
    // can authenticate, but report `mfa_required` so the UI collects the code.
    const stepUp = detectAal2Required(data);
    if (stepUp.required && stepUp.factorId) {
      setAuthoritativeSession(session);
      return { status: 'mfa_required', session, factorId: stepUp.factorId, message: 'Enter your 6-digit authentication code.' };
    }
    setAuthoritativeSession(session);
    return { status: 'ok', session };
  } catch {
    return { status: 'error', message: 'Network error during sign-in.' };
  }
}

/**
 * Inspect the token grant response for an aal1→aal2 step-up requirement and the
 * TOTP factor to challenge. GoTrue exposes assurance levels and factors on the
 * user object; we read them defensively across shapes.
 */
function detectAal2Required(data: any): { required: boolean; factorId?: string } {
  const user = data?.user || {};
  const factors: MfaFactor[] = (user?.factors || []) as MfaFactor[];
  const verifiedTotp = factors.find((f) => f.status === 'verified' && f.factor_type === 'totp');
  if (!verifiedTotp) return { required: false };
  // aal claims may appear on the response or need decoding from the JWT.
  const current = data?.aal || decodeAal(data?.access_token);
  // A fresh password login is aal1; the presence of a verified factor means the
  // account's assured level should be aal2, so any current level below that
  // requires a step-up.
  if (current === 'aal2') return { required: false };
  return { required: true, factorId: verifiedTotp.id };
}

/** Best-effort AAL read from a JWT payload without any dependency. */
export function decodeAal(jwt?: string): string | null {
  if (!jwt) return null;
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return payload?.aal ?? null;
  } catch { return null; }
}

/** Best-effort `sub` (auth user id) from a JWT payload, no dependency. */
function decodeSub(jwt?: string): string | null {
  if (!jwt) return null;
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return payload?.sub ?? null;
  } catch { return null; }
}

/**
 * Complete an MFA challenge: create a challenge for the factor, then verify the
 * 6-digit TOTP code. On success GoTrue returns a fresh aal2 session, which we
 * persist and return. The caller passes the aal1 session from signInWithPassword.
 */
export async function verifyMfaCode(session: AuthSession, factorId: string, code: string): Promise<AuthResult> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { status: 'not_configured' };
  const base = cfg.url.replace(/\/$/, '');
  const authHeaders = {
    apikey: cfg.anonKey,
    Authorization: `Bearer ${session.accessToken}`,
    'Content-Type': 'application/json',
  };
  try {
    // 1. Create a challenge for the factor.
    const chRes = await timedFetch.auth(`${base}/auth/v1/factors/${factorId}/challenge`, {
      method: 'POST', headers: authHeaders, body: '{}',
    });
    if (!chRes.ok) return { status: 'error', message: 'Could not start verification. Please try again.' };
    const challenge = await chRes.json().catch(() => ({}));
    const challengeId = challenge?.id;
    if (!challengeId) return { status: 'error', message: 'Could not start verification. Please try again.' };

    // 2. Verify the user-entered code against that challenge.
    const vRes = await timedFetch.auth(`${base}/auth/v1/factors/${factorId}/verify`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({ challenge_id: challengeId, code: code.trim() }),
    });
    if (vRes.status === 400 || vRes.status === 401 || vRes.status === 422) {
      return { status: 'invalid_credentials', message: 'That code was not correct. Please try again.' };
    }
    if (!vRes.ok) return { status: 'error', message: `Verification failed (${vRes.status}).` };
    const data = await vRes.json();
    const stepped: AuthSession = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    };
    setAuthoritativeSession(stepped);
    return { status: 'ok', session: stepped };
  } catch {
    return { status: 'error', message: 'Network error during verification.' };
  }
}

/**
 * The injectable boundary for the MFA-factor read (OPT-02G). Production code
 * calls the factor functions with no `deps`, taking the real Supabase config +
 * global fetch. Tests pass fakes so the HTTP→taxonomy mapping is exercised
 * without Vite/browser/Supabase — mirroring authRefresh/authClient. No
 * production auth decision changes: the default deps are the real ones.
 */
export interface MfaFactorsDeps {
  getConfig: () => { url: string; anonKey: string } | null;
  fetchImpl: typeof fetch;
}
const defaultMfaFactorsDeps: MfaFactorsDeps = {
  getConfig: getSupabaseConfig,
  fetchImpl: timedFetch.auth,
};

/**
 * List the caller's MFA factors as a TYPED result (OPT-02G). This is the honest
 * primitive: it separates "the service told us this account has zero factors"
 * from "we could not reach the service", so an enrolled owner is never shoved
 * back into enrolment because /user returned 500 or timed out.
 *
 * GoTrue has NO `GET /factors` route (POST /factors is enrol-only) — the caller's
 * factors are exposed on the /user object. A 2xx with a missing/empty `factors`
 * field is the legitimate "no factors enrolled" signal.
 */
export async function listMfaFactorsResult(
  session: AuthSession,
  deps: MfaFactorsDeps = defaultMfaFactorsDeps,
): Promise<MfaFactorsResult> {
  const cfg = deps.getConfig();
  // Not configured is a deterministic "no MFA subsystem", which for enrolment
  // purposes reads as an empty—but successful—factor list.
  if (!cfg) return { status: 'success', factors: [] };
  const base = cfg.url.replace(/\/$/, '');
  let res: Response;
  try {
    res = await deps.fetchImpl(`${base}/auth/v1/user`, {
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${session.accessToken}` },
    });
  } catch {
    // Network/DNS/timeout — transient by nature, always retryable.
    return { status: 'temporarily_unavailable', retryable: true };
  }
  if (res.status === 401) return { status: 'unauthorised' };
  // 5xx and the standard transient statuses must NOT look like "no factors".
  if (res.status >= 500 || res.status === 408 || res.status === 429) {
    return { status: 'temporarily_unavailable', retryable: true };
  }
  if (!res.ok) return { status: 'failed', retryable: false };
  const data = await res.json().catch(() => null);
  if (data == null) return { status: 'failed', retryable: false };
  const factors = data?.factors;
  return { status: 'success', factors: Array.isArray(factors) ? (factors as MfaFactor[]) : [] };
}

/**
 * Verified-MFA state as a tri-state (OPT-02G). `'unknown'` is the critical new
 * value: it means the factor service could not be consulted, so the caller must
 * show a retryable "MFA temporarily unavailable" state — NOT sign the user out
 * and NOT force enrolment. Only `'none'` (a confirmed empty list) means enrol.
 */
export async function verifiedMfaStatus(
  session: AuthSession,
  deps?: MfaFactorsDeps,
): Promise<'has' | 'none' | 'unknown'> {
  const result = await listMfaFactorsResult(session, deps);
  if (result.status !== 'success') return 'unknown';
  const hasVerified = result.factors.some(
    (f) => f.status === 'verified' && f.factor_type === 'totp',
  );
  return hasVerified ? 'has' : 'none';
}

/**
 * List the caller's MFA factors (used to enforce enrolment for privileged roles).
 *
 * Back-compat wrapper over listMfaFactorsResult: legacy call sites that only need
 * the array (e.g. the abandoned-enrolment sweep in startMfaEnrolment) keep their
 * old shape. A non-success result yields `[]` here — callers that must react to
 * an outage differently should use listMfaFactorsResult / verifiedMfaStatus.
 */
export async function listMfaFactors(session: AuthSession, deps?: MfaFactorsDeps): Promise<MfaFactor[]> {
  const result = await listMfaFactorsResult(session, deps);
  return result.status === 'success' ? (result.factors as MfaFactor[]) : [];
}

/** True if the caller has at least one verified TOTP factor. */
export async function hasVerifiedMfa(session: AuthSession): Promise<boolean> {
  const factors = await listMfaFactors(session);
  return factors.some((f) => f.status === 'verified' && f.factor_type === 'totp');
}

/** Roles for which MFA enrolment is MANDATORY before portal access. */
export const MFA_REQUIRED_ROLES = ['owner', 'store_manager'] as const;
export const roleRequiresMfa = (role?: string | null): boolean =>
  !!role && (MFA_REQUIRED_ROLES as readonly string[]).includes(role);

export interface MfaEnrolStart {
  status: 'ok' | 'error' | 'not_configured';
  factorId?: string;
  /** otpauth:// URI for the authenticator QR. */
  uri?: string;
  /** The shared secret, for manual entry. */
  secret?: string;
  message?: string;
}

/**
 * Begin TOTP enrolment: GoTrue returns a new unverified factor with a QR URI +
 * secret. The user scans it, then calls verifyMfaCode(session, factorId, code)
 * with the first code to activate the factor.
 */
export async function startMfaEnrolment(session: AuthSession, friendlyName = 'Authenticator'): Promise<MfaEnrolStart> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { status: 'not_configured' };
  const base = cfg.url.replace(/\/$/, '');
  const authHeaders = {
    apikey: cfg.anonKey,
    Authorization: `Bearer ${session.accessToken}`,
    'Content-Type': 'application/json',
  };

  // Self-heal: an abandoned half-finished enrolment leaves an UNVERIFIED
  // factor behind whose friendly name blocks every retry with a 422. Deleting
  // one's own unverified factor is permitted, so sweep them before enrolling.
  // (Verified factors are never touched — removing a working authenticator
  // must stay a deliberate, separate action.)
  try {
    const existing = await listMfaFactors(session);
    for (const f of existing) {
      if (f.factor_type === 'totp' && f.status !== 'verified') {
        await timedFetch.auth(`${base}/auth/v1/factors/${f.id}`, { method: 'DELETE', headers: authHeaders });
      }
    }
  } catch { /* best effort — the enrol call below surfaces any real error */ }

  try {
    const res = await timedFetch.auth(`${base}/auth/v1/factors`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ factor_type: 'totp', friendly_name: friendlyName }),
    });
    if (res.status === 422) {
      return { status: 'error', message: 'An authenticator is already registered for this account. Return to sign-in and log in again — you should be asked for its 6-digit code instead.' };
    }
    if (!res.ok) return { status: 'error', message: `Could not begin enrolment (${res.status}).` };
    const data = await res.json().catch(() => ({}));
    const totp = data?.totp || {};
    return {
      status: 'ok',
      factorId: data?.id,
      uri: totp?.uri,
      secret: totp?.secret,
    };
  } catch {
    return { status: 'error', message: 'Network error during enrolment.' };
  }
}

/**
 * Exchange the refresh token for a fresh access token (used on page load and by
 * getAccessToken). OPT-02B: this now delegates to the module-scoped single-flight
 * coordinator, so N concurrent callers collapse onto ONE network refresh and a
 * losing caller can never clobber a session another caller already rotated.
 *
 * The signature is preserved for backward compatibility (`AuthSession | null`),
 * but the semantics are corrected: a transient outage (offline / 5xx / timeout)
 * returns `null` WITHOUT clearing the stored session — only a server-confirmed
 * invalid refresh token clears it (inside the coordinator, basis-guarded). A
 * caller that needs to tell "signed out" from "try again later" apart should use
 * refreshSessionSingleFlight() directly and switch on the typed result.
 */
export async function refreshSession(overrides?: Partial<RefreshDeps>): Promise<AuthSession | null> {
  // OPT-02-C1 (F1): basis-explicit + lineage-bound. Refresh exactly the session
  // captured at entry, and only ever hand back a session that still belongs to
  // THAT ceremony — never a newer login's session that raced in behind us.
  const snapshot = readAuthSnapshot();
  if (!snapshot.session || !snapshot.lineage) return null;
  const result = await refreshSessionSingleFlight(snapshot.session, overrides);
  if (result.status === 'refreshed') return getSessionIfLineage(snapshot.lineage);
  return null; // invalid_session / stale_session / temporarily_unavailable → no session
}

/** Sign out: clear the local token, then revoke THIS session on the server.
 *
 *  C1.2 decision — LOCAL scope. An ordinary logout ends only the session the
 *  user acted in (the office tablet), never their other devices. The revoke
 *  goes through the single tested implementation (`bestEffortRevokeSession`:
 *  explicit `scope=local`, bounded timeout, errors swallowed) so there is no
 *  second logout code path to drift. Local state is cleared FIRST so a hung
 *  network call can never delay the sign-out. */
export async function signOut(): Promise<void> {
  const session = readStoredSession();
  clearSessionUnconditional();
  if (!session) return;
  bestEffortRevokeSession(session.accessToken);
}

export interface RevokeSessionDeps { revoke?: ((accessToken: string) => void) | undefined }

/** OPT-02 C1.2 (F3) — confirmed ACCESS revocation. Atomically TAKES the
 *  installed session through the userId guard (`takeSessionIfUser`: v8 §1
 *  rule 2 — "Access revocation: userId alone, intentional"; a confirmed
 *  profile-level withdrawal revokes even a NEWER login of the same identity,
 *  whichever ceremony it came from) and best-effort revokes the TAKEN chain
 *  at the server (scope=local, bounded, errors swallowed). If the identity
 *  differs or no session is installed, nothing is taken, nothing is revoked,
 *  and the newer/different user's session survives untouched. Returns true
 *  iff this call performed the take + revoke. */
export function revokeSessionIfLineage(expectedUserId: string, deps?: RevokeSessionDeps): boolean {
  const taken = takeSessionIfUser(expectedUserId);
  if (!taken) return false;
  (deps?.revoke ?? bestEffortRevokeSession)(taken.session.accessToken);
  return true;
}

/** Finding-4 fix — revalidation OUTCOMES. `fetchOwnProfile`'s `null` conflates
 *  "disabled" with "the wifi blinked"; acting on that signs employees out
 *  during outages. This variant distinguishes confirmed states from transient
 *  ones. 401 is deliberately TRANSIENT here (an expiring token is the refresh
 *  path's job, not grounds to terminate); 403 is a confirmed denial. */
export type ProfileRevalidation =
  | { status: 'ok'; profile: EmployeeProfile }
  | { status: 'disabled' }
  | { status: 'not_found' }
  | { status: 'unauthorised' }
  | { status: 'temporarily_unavailable' };

export interface ProfileRevalidationDeps {
  fetchFn?: typeof fetch | undefined;
  /** Test seam: resolve the Supabase config (defaults to the real resolver). */
  getConfig?: (() => { url: string; anonKey: string } | null) | undefined;
}

/** Re-audit H4: INITIAL profile loading gets the same typed outcomes as focus
 *  revalidation — a wifi blink during login/adoption must keep the shared
 *  session and surface a retry, never terminate every tab. The first-login
 *  claim (link_staff_profile) stays best-effort. */
export async function loadOwnProfileTyped(
  session: AuthSession,
  deps?: ProfileRevalidationDeps,
): Promise<ProfileRevalidation> {
  // F3 (C1.2) — READ → link → RE-READ. The common case (an already-linked
  // profile, i.e. every login after the first) resolves on the first typed
  // read with ZERO extra RPCs. Only a confirmed empty read triggers the
  // best-effort first-login claim, followed by a second typed read that
  // reports the real post-link state. Transient failures pass through typed
  // (never terminate) exactly as before.
  const first = await revalidateOwnProfileTyped(session, deps);
  if (first.status !== 'not_found') return first;
  const cfg = (deps?.getConfig ?? getSupabaseConfig)();
  if (!cfg) return first;
  const doFetch = deps?.fetchFn ?? fetch;
  const base = cfg.url.replace(/\/$/, '');
  try {
    await doFetch(`${base}/rest/v1/rpc/link_staff_profile`, {
      method: 'POST',
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch { /* best-effort claim; the re-read below reports the real state */ }
  return revalidateOwnProfileTyped(session, deps);
}

export async function revalidateOwnProfileTyped(
  session: AuthSession,
  deps?: ProfileRevalidationDeps,
): Promise<ProfileRevalidation> {
  const cfg = (deps?.getConfig ?? getSupabaseConfig)();
  if (!cfg) return { status: 'temporarily_unavailable' };
  const uid = decodeSub(session.accessToken);
  if (!uid) return { status: 'unauthorised' };
  const doFetch = deps?.fetchFn ?? fetch;
  const base = cfg.url.replace(/\/$/, '');
  let res: Response;
  try {
    res = await doFetch(
      // Stage 2.1.2: the self-read goes through get_my_staff_profile(). The
      // base table no longer grants general SELECT — pay/identity columns are
      // server-withheld — and the RPC returns the caller's OWN complete row
      // (their own pay included: they own it). Row selection is auth.uid()
      // inside the function, so no filter or projection travels on the wire.
      `${base}/rest/v1/rpc/get_my_staff_profile`,
      {
        method: 'POST',
        headers: { apikey: cfg.anonKey, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
  } catch { return { status: 'temporarily_unavailable' }; }
  if (res.status === 403) return { status: 'unauthorised' };
  if (res.status === 401) return { status: 'temporarily_unavailable' };
  if (!res.ok) return { status: 'temporarily_unavailable' };
  let rows: unknown;
  try { rows = await res.json(); } catch { return { status: 'temporarily_unavailable' }; }
  if (!Array.isArray(rows)) return { status: 'temporarily_unavailable' };
  if (rows.length === 0) return { status: 'not_found' };
  const profile = fromRow<EmployeeProfile>(rows[0] as Record<string, unknown>);
  if (profile.status === 'disabled') return { status: 'disabled' };
  return { status: 'ok', profile };
}

/** True when a persisted session exists (does not prove it's still valid). */
export const hasStoredSession = () => hasSession();

/**
 * Return a valid access token for calling authenticated Edge Functions,
 * refreshing first if the stored one is within 60s of expiry. Returns null when
 * there is no session (caller should treat that as "not signed in"). The token
 * is a short-lived, server-verified JWT — the server re-checks it regardless.
 *
 * OPT-02B: the near-expiry refresh now goes through the single-flight coordinator
 * and distinguishes the three outcomes. Crucially, a transient outage does NOT
 * yield `null` while the current token is still technically valid — returning the
 * existing token lets the request proceed (the server re-verifies) instead of
 * manufacturing a spurious "signed out" during a brief network blip.
 */
export async function getAccessToken(overrides?: Partial<RefreshDeps>): Promise<string | null> {
  // Use the injected clock if present (deterministic tests), else the real one.
  const clock = overrides?.now ?? (() => Date.now());
  // Capture a coherent snapshot at entry (audit: getAccessToken must be as
  // lineage-aware as the request wrapper). Every value returned below belongs to
  // THIS ceremony — an operation that began for user A can never continue on
  // user B's token because B signed in mid-refresh.
  const snapshot = readAuthSnapshot();
  if (!snapshot.session || !snapshot.lineage) return null;
  if (snapshot.session.expiresAt - Math.floor(clock() / 1000) >= 60) return snapshot.session.accessToken;

  const result = await refreshSessionSingleFlight(snapshot.session, overrides);
  if (result.status === 'refreshed') {
    // Rebind to OUR ceremony: return the current same-lineage token (which may be
    // a further same-ceremony rotation), or null if the ceremony is gone.
    return getSessionIfLineage(snapshot.lineage)?.accessToken ?? null;
  }
  if (result.status === 'invalid_session') return null;
  // stale_session: our basis was overtaken by a NEWER login. That newer session
  // is a different lifecycle — never hand back its token here.
  if (result.status === 'stale_session') return null;
  // temporarily_unavailable (offline / 5xx / timeout): rebind first, then
  // RE-READ the clock — a refresh that waited out a timeout may have pushed us
  // past expiry, and we must never hand back an already-expired token.
  const current = getSessionIfLineage(snapshot.lineage);
  const nowAfter = Math.floor(clock() / 1000);
  return current && current.expiresAt > nowAfter ? current.accessToken : null;
}
