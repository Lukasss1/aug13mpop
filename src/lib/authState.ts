/**
 * @file authState.ts
 * @description OPT-02A — the single, explicit, typed vocabulary for the staff
 * authentication lifecycle, plus the OPT-02 error taxonomy (spec §7) and the
 * shared result types used by the refresh coordinator (OPT-02B), the
 * authenticated request wrapper (OPT-02C) and the cross-tab coordinator
 * (OPT-02D).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before OPT-02 the lifecycle was expressed as `employee: EmployeeProfile | null`
 * plus a separate `mfaPending`. That collapses six genuinely different
 * situations into one falsy value:
 *
 *   - signed out                     (nothing to do)
 *   - a temporary network/service    (RETRY — do NOT sign the user out)
 *     outage while we hold a token
 *   - a CONFIRMED revoked session    (sign out + purge private state)
 *   - a missing / disabled profile   (access disabled, distinct message)
 *   - MFA enrolment required         (privileged role, no factor yet)
 *   - MFA challenge required         (has a factor, must present a code)
 *
 * Treating an outage the same as a revocation is exactly how a flaky network
 * turns into a spurious logout or — worse — a spurious MFA *re-enrolment*. The
 * union below forces every consumer to handle those cases distinctly.
 *
 * This module is TYPES ONLY. It has no runtime imports beyond `import type`,
 * so it is safe to import from anywhere (client, tests, edge shims) without
 * pulling in `import.meta.env`, `localStorage`, or `fetch`.
 */
import type { EmployeeProfile } from '../types';

/**
 * A verified Supabase Auth session. The tokens are opaque and server-verified;
 * editing them client-side only makes them invalid — it can never mint a role.
 * (Kept structurally identical to the pre-OPT-02 `AuthSession` in auth.ts,
 * which now re-exports this type for backward compatibility.)
 */
export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** epoch SECONDS at which `accessToken` expires. */
  expiresAt: number;
}

/**
 * OPT-02-C1 — the IDENTITY of a login lifecycle, as opposed to a single token.
 *
 * `authEpoch` names ONE authentication ceremony (spec §1 rule 3: "one authEpoch
 * = one ceremony"). A password grant MINTS a new epoch; an MFA step-up REPLACES
 * the session within the SAME epoch (same ceremony, aal1 → aal2); a refresh
 * rotation PRESERVES the epoch; a clear removes it. Two logins therefore differ
 * by epoch even for the same user, which is exactly what lets the lifecycle code
 * tell "still the same login" from "a different login has taken over" without
 * ever comparing raw tokens.
 *
 * The tokens live in `AuthSession`; the lineage is what `sameLifecycle`
 * compares. This is deliberately NOT the monotonic write-counter
 * (`sessionVersion`): that answers "which write is newer" for the storage /
 * cross-tab guards, whereas the lineage answers "is this the same ceremony".
 */
export interface SessionLineage {
  /** The auth user id (JWT `sub`) this ceremony belongs to. */
  userId: string;
  /** Opaque, per-ceremony identifier. Compared by equality only, never ordered. */
  authEpoch: string;
}

/**
 * OPT-02-C1 — a CONSISTENT read of the stored session together with its lineage,
 * taken as one snapshot so a caller cannot observe the token from one moment and
 * the lineage from another. `readAuthSnapshot()` is the single reader the
 * request wrapper (F2) and the useAuth adapter (F5) capture at entry, so every
 * subsequent "is this still current?" check compares against a coherent basis.
 */
export interface AuthSnapshot {
  session: AuthSession | null;
  lineage: SessionLineage | null;
}

/**
 * OPT-02-C1 rule 4(a) — the injected boundary for the RAW auth network calls
 * (direct GoTrue over `fetchImpl`). It exposes ONLY the config and a fetch: there
 * is deliberately NO auth-SDK client here.
 *
 * THE NO-AUTO-PERSISTING-CLIENT PROHIBITION: nothing reachable through
 * `RawAuthDeps` may write session storage. Network authentication proves who you
 * are; it must never, as a side effect, decide the app is signed in. Installs
 * happen exactly once, later, in useAuth AFTER the commit gate. Keeping the raw
 * layer to { getConfig, fetchImpl } makes an accidental storage write from the
 * network path unrepresentable — and the sentinel/spy tests prove it stays inert.
 */
export interface RawAuthDeps {
  getConfig: () => { url: string; anonKey: string } | null;
  fetchImpl: typeof fetch;
}

/**
 * OPT-02A — the authentication lifecycle state machine.
 *
 * The exact string tags are an implementation detail, but the machine MUST be
 * able to distinguish every case below. Consumers should switch on `status`
 * exhaustively; do NOT collapse this back into `employee | null`.
 */
export type AuthLifecycleState =
  /** First render, before the initial session-restore attempt resolves. */
  | { status: 'initialising' }
  /** No session, no pending step — show the login form. */
  | { status: 'signed_out' }
  /** A password grant is in flight. */
  | { status: 'authenticating' }
  /** Privileged role with NO verified factor — must enrol before access. */
  /** Privileged role with NO verified factor — must enrol before access.
   *  v8 strict state: lineage is MANDATORY (provenance of the ceremony). */
  | { status: 'mfa_enrolment_required'; session: AuthSession; lineage: SessionLineage; message?: string }
  /** Has a verified factor — must present a 6-digit code to reach aal2.
   *  v8 strict state: lineage AND factorId are MANDATORY (an impossible
   *  challenge-without-a-factor state is unrepresentable). */
  | { status: 'mfa_challenge_required'; session: AuthSession; lineage: SessionLineage; factorId: string; message?: string }
  /** Session is valid; the DB-backed profile is still loading. */
  | { status: 'profile_loading'; session: AuthSession }
  /** Fully authenticated (aal2 where required) with a live profile. */
  | { status: 'active'; session: AuthSession; employee: EmployeeProfile }
  /** Shared-device inactivity lock (OPT-02H). Session is retained; UI is hidden. */
  | { status: 'locked'; session: AuthSession; employee: EmployeeProfile; lockedAt: string }
  /**
   * A RECOVERABLE outage. We still hold what may be a valid session, but the
   * backend could not be reached / errored. This is NOT a logout and NOT a
   * reason to re-enrol MFA. The UI shows "authentication unavailable" and
   * retries.
   */
  | { status: 'temporarily_unavailable'; reason: 'offline' | 'auth_service' | 'profile_service'; recoverable: true }
  /**
   * Access has been withdrawn out-of-band (profile disabled/deleted, or the
   * account was revoked) even though a token may still be technically present.
   */
  | { status: 'access_disabled'; reason: 'profile_disabled' | 'profile_deleted' | 'account_revoked' }
  /** The session is CONFIRMED invalid (refresh rejected / 401 after retry). */
  | { status: 'session_expired'; reason: 'refresh_rejected' | 'unauthorised' };

/** Narrow helper: does this state represent a signed-in, interactive user? */
export function isActiveState(s: AuthLifecycleState): s is Extract<AuthLifecycleState, { status: 'active' }> {
  return s.status === 'active';
}

/** Narrow helper: is this a recoverable outage (retry, do not sign out)? */
export function isRecoverableState(s: AuthLifecycleState): boolean {
  return s.status === 'temporarily_unavailable';
}

/**
 * OPT-02B — the result of a refresh attempt. The critical distinction is
 * between `invalid_session` (the refresh token is dead → clear + sign out) and
 * `temporarily_unavailable` (transport/5xx → keep the session, retry later).
 */
export type RefreshResult =
  | { status: 'refreshed'; session: AuthSession }
  | { status: 'invalid_session' }
  | { status: 'temporarily_unavailable'; reason: 'offline' | 'server_error' }
  /**
   * OPT-02-C1 (F1) — the network refresh succeeded, but the rotated session was
   * NOT committed because the basis we refreshed is no longer the stored session
   * (a newer authoritative login superseded it while we were in flight). The
   * caller must NOT install `next`; the current stored session wins. This is the
   * "commit-respect → stale_session" rule: a losing refresh reports that it lost
   * rather than pretending it refreshed.
   */
  | { status: 'stale_session' };

/**
 * OPT-02G — the result of listing MFA factors. Replaces the old API that
 * returned `[]` on EVERY failure, which made a 500 or a timeout look identical
 * to "this account has no factors" and shoved enrolled owners back into
 * enrolment. Only `success` with zero verified factors means "enrol".
 */
export type MfaFactorsResult =
  | { status: 'success'; factors: MfaFactorLike[] }
  | { status: 'unauthorised' }
  | { status: 'temporarily_unavailable'; retryable: true }
  | { status: 'failed'; retryable: boolean };

/** Minimal shape of an MFA factor as GoTrue reports it (kept in sync with auth.ts). */
export interface MfaFactorLike {
  id: string;
  status: 'verified' | 'unverified';
  factor_type: string;
  friendly_name?: string;
}

/**
 * OPT-02C — the result of an authenticated request. Every high-risk call site
 * gets a typed outcome instead of a thrown/`null` ambiguity, so callers can
 * tell "you were signed out" apart from "the network hiccuped, try again".
 */
export type AuthenticatedRequestResult<T> =
  | { status: 'success'; data: T; response: Response }
  | { status: 'unauthorised' }
  | { status: 'forbidden' }
  | { status: 'temporarily_unavailable'; retryable: boolean }
  | { status: 'failed'; code: AuthErrorCode; retryable: boolean }
  /**
   * OPT-02-C1 (F2) — the call was made against a session lineage that is no
   * longer current (a newer login/account-switch replaced it mid-flight). NOTE
   * the distinction from `unauthorised`: nothing was proven dead here, so the
   * caller must NOT sign anyone out — it should simply re-drive off the current
   * session. Superseded is preferred over unauthorised wherever a same-lineage
   * survivor could not be confirmed dead (spec §1 rule 6).
   */
  | { status: 'superseded' }
  /**
   * OPT-02-C1 (F2) — the session was healed (refreshed) but the original request
   * could not be safely auto-replayed (e.g. a consumed/streamed body), so the
   * caller must re-issue it with a fresh token. Distinct from a transient
   * failure: the session is fine; only THIS request needs to be sent again.
   */
  | { status: 'retry_required' };

/**
 * OPT-02 spec §7 — a small, STABLE error taxonomy. Raw provider errors are
 * never surfaced to ordinary users; they are mapped to one of these codes.
 */
export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'SESSION_EXPIRED'
  | 'REFRESH_REJECTED'
  | 'AUTH_SERVICE_UNAVAILABLE'
  | 'NETWORK_UNAVAILABLE'
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_DISABLED'
  | 'MFA_REQUIRED'
  | 'MFA_UNAVAILABLE'
  | 'MFA_CODE_INVALID'
  | 'PERMISSION_CHANGED'
  | 'SESSION_STORAGE_UNAVAILABLE'
  /** The request target was outside the configured Supabase origin — the wrapper
   *  refuses to attach the session JWT / anon key to, or fetch from, an untrusted
   *  origin (a mis-built URL, a third-party host, or a relative app route). */
  | 'UNTRUSTED_ORIGIN'
  /** A 2xx response body was not valid JSON where JSON was expected. */
  | 'MALFORMED_RESPONSE';

/** A user-safe message for each taxonomy code. Never leaks server internals. */
export function authErrorMessage(code: AuthErrorCode): string {
  switch (code) {
    case 'INVALID_CREDENTIALS': return 'Email or password not recognised.';
    case 'SESSION_EXPIRED': return 'Your session has expired. Please sign in again.';
    case 'REFRESH_REJECTED': return 'Your session is no longer valid. Please sign in again.';
    case 'AUTH_SERVICE_UNAVAILABLE': return 'Sign-in is temporarily unavailable. Please try again shortly.';
    case 'NETWORK_UNAVAILABLE': return 'Network problem — please check your connection and try again.';
    case 'PROFILE_NOT_FOUND': return 'No staff profile is linked to this account yet.';
    case 'PROFILE_DISABLED': return 'This account has been disabled. Contact your manager.';
    case 'MFA_REQUIRED': return 'Additional verification is required for this account.';
    case 'MFA_UNAVAILABLE': return 'Two-factor verification is temporarily unavailable. Please try again shortly.';
    case 'MFA_CODE_INVALID': return 'That code was not correct. Please try again.';
    case 'PERMISSION_CHANGED': return 'Your permissions changed. The view has been updated.';
    case 'SESSION_STORAGE_UNAVAILABLE': return 'This browser is blocking storage — you are signed in for this tab only.';
    case 'UNTRUSTED_ORIGIN': return 'That request could not be completed securely.';
    case 'MALFORMED_RESPONSE': return 'The server returned an unexpected response. Please try again.';
  }
}

/**
 * OPT-02D — the cross-tab broadcast event schema. Tokens are NEVER broadcast;
 * receiving tabs read the current session from the shared session store. Every
 * event carries a monotonically increasing `sessionVersion` so a delayed,
 * stale event can never overwrite a newer login (the stale-event guard).
 */
/** Identifies the exact persisted mutation an event announces (re-audit H3). */
export interface BroadcastMutationRef { writerId: string; mutationId: string }

export type AuthBroadcastEvent =
  | { type: 'SIGNED_IN'; userId: string; sessionVersion: number; mutation?: BroadcastMutationRef | undefined }
  | { type: 'SIGNED_OUT'; reason: string; sessionVersion: number; mutation?: BroadcastMutationRef | undefined }
  | { type: 'SESSION_REFRESHED'; userId: string; sessionVersion: number; mutation?: BroadcastMutationRef | undefined }
  | { type: 'SESSION_EXPIRED'; userId?: string; sessionVersion: number; mutation?: BroadcastMutationRef | undefined }
  | { type: 'PROFILE_CHANGED'; userId: string; sessionVersion: number; mutation?: BroadcastMutationRef | undefined }
  | { type: 'ACCOUNT_SWITCHED'; previousUserId?: string; userId: string; sessionVersion: number; mutation?: BroadcastMutationRef | undefined };

/** The envelope every broadcast rides in — adds provenance + a stale guard. */
export interface AuthBroadcastEnvelope {
  event: AuthBroadcastEvent;
  /** Random per-tab id; lets a tab ignore its own echoes (loop prevention). */
  origin: string;
  /** epoch ms; secondary stale guard alongside sessionVersion. */
  timestamp: number;
}

/**
 * OPT-02 spec §5 — the versioned session envelope persisted to storage. The
 * `sessionVersion` is the monotonic counter that both the storage guard and
 * the cross-tab guard key off, so "which write is newer" has one answer.
 */
export interface StoredSessionEnvelope {
  /**
   * OPT-02-C1 bumped 2 → 3: the envelope now carries `authEpoch` so a persisted
   * session restored after a reload continues the SAME ceremony (its lineage is
   * stable across reloads). A v3 envelope is trusted verbatim; a pre-C1.1 v2 or
   * legacy shape is MIGRATED to v3 in place (minting a ceremony, keeping the user
   * signed in). The one deliberate forced re-login is the DOWNGRADE direction —
   * rolling back to the pre-opt02-c1 build, which cannot read v3 (see
   * authStorage.normaliseStoredBlob).
   */
  schemaVersion: 3;
  session: AuthSession;
  /** Per-ceremony identity (see SessionLineage.authEpoch). */
  authEpoch: string;
  /** Monotonic write counter — the storage + cross-tab "which write is newer" guard. */
  sessionVersion: number;
  userId: string;
  updatedAt: string;
}
