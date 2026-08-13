/**
 * @file useAuth.ts
 * @description Owns the staff authentication lifecycle for the app.
 *
 * SECURITY: `employee` is derived exclusively from a live Supabase Auth session
 * plus a DB-backed profile read (fetchOwnProfile). It is NEVER hydrated from a
 * stored EmployeeProfile. On load we try to refresh an existing token; if that
 * yields a valid session we fetch the profile through RLS. Sign-out clears
 * everything. If Supabase is unconfigured, `configured` is false and the UI
 * shows the honest fail-closed notice instead of a login form.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { startAuthChannel, type AuthChannelController } from '../lib/authChannel';
import { runSessionCleanup } from '../lib/sessionCleanup';
import { onAuthLifecycleEvent } from '../lib/authEvents';
import { readSession, currentSessionVersion, currentUserId, syncFromPersistedSession, persistedRevision, decodeSub, REVISION_STORAGE_KEY, TOKEN_STORAGE_KEY } from '../lib/authStorage';
import type { PersistedRevision } from '../lib/authStorage';
import { reconcileAction, shouldReconcile } from '../lib/authReconcile';
import type { EmployeeProfile } from '../types';
import { isCloudConfigured } from '../lib/supabase';
import {
  signInWithPassword,
  refreshSession,
  signOut as authSignOut,
  loadOwnProfileTyped,
  revokeSessionIfLineage,
  revalidateOwnProfileTyped,
  hasStoredSession,
  verifyMfaCode,
  verifiedMfaStatus,
  listMfaFactors,
  decodeAal,
  roleRequiresMfa,
  type AuthResult,
  type AuthSession,
} from '../lib/auth';

/** A pending MFA step surfaced to the sign-in UI. */
export interface MfaPending {
  /** 'challenge' → user has a factor and must enter a code to finish sign-in.
   *  'enrol'     → privileged role with NO factor; must enrol before access. */
  kind: 'challenge' | 'enrol';
  session: AuthSession;
  factorId?: string | undefined;   // present for 'challenge'
  message?: string | undefined;
}

export interface UseAuth {
  employee: EmployeeProfile | null;
  /** True until the initial session-restore attempt finishes. */
  loading: boolean;
  /** Whether a Supabase backend is configured at all. */
  configured: boolean;
  /** Non-null when sign-in needs a second step (MFA challenge or enrolment). */
  mfaPending: MfaPending | null;
  signIn: (email: string, password: string) => Promise<AuthResult>;
  /** Submit a 6-digit code for the pending challenge. Returns an error string or null. */
  submitMfaCode: (code: string) => Promise<string | null>;
  /** Called by the enrolment UI once a factor is verified, to finish sign-in. */
  completeMfaEnrolment: (session: AuthSession) => Promise<string | null>;
  /** Abandon a pending MFA step (e.g. user cancels). Clears session too. */
  cancelMfa: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Transient recoverable auth condition for the UI (never a sign-out). */
  authNotice: string | null;
  /** Replace the in-memory profile (e.g. after a self-service profile edit). */
  setEmployee: (e: EmployeeProfile | null) => void;
}

export function useAuth(): UseAuth {
  const configured = isCloudConfigured();
  const [employee, setEmployee] = useState<EmployeeProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(configured && hasStoredSession());
  const [mfaPending, setMfaPending] = useState<MfaPending | null>(null);
  /** Cross-tab coordinator (OPT-02E integration): set by the channel effect. */
  const channelRef = useRef<AuthChannelController | null>(null);
  /** Mirror of `employee` for non-reactive reads inside handlers/guards. */
  const employeeRef = useRef<EmployeeProfile | null>(null);
  useEffect(() => { employeeRef.current = employee; }, [employee]);
  const lastRevalidatedAt = useRef(0);
  /** The auth user id the LAST successful finalise adopted (identity anchor). */
  const lastUserIdRef = useRef<string | null>(null);
  /** Re-audit C3: a monotonic identity generation. Every identity transition
   *  bumps it; every async identity operation captures it before awaiting and
   *  refuses to commit (or terminate!) if it moved — a delayed User-A result
   *  can neither repopulate nor sign out User B. */
  const identityGen = useRef(0);
  /** The exact persisted mutation this tab last reconciled (at-most-once gate). */
  const lastAppliedRef = useRef<PersistedRevision | null>(null);
  /** Trampolines (defined below; refs break the declaration-order cycle). */
  const reconcileRef = useRef<() => void>(() => { /* set below */ });
  const terminateIfUserRef = useRef<(expectedUserId: string, reason: string) => Promise<void>>(async () => { /* set below */ });
  /** Item-7: the ONE session-termination path, reachable from finalise via ref. */
  const terminateRef = useRef<(reason: string) => Promise<void>>(async () => { /* set below */ });
  /** Transient, recoverable auth condition for the UI (never clears a session). */
  const [authNotice, setAuthNotice] = useState<string | null>(null);

  /**
   * Finalise a fully-authenticated (aal2 where required) session: load the
   * profile, then enforce MFA enrolment for privileged roles. Returns an error
   * string, or null on success (employee is set). A privileged role without a
   * verified factor is parked in `mfaPending` with kind 'enrol' — it does NOT
   * become a signed-in employee until it enrols.
   */
  const finalise = useCallback(async (
    session: AuthSession,
    opts?: { source?: 'local' | 'remote' | 'restore' | undefined },
  ): Promise<string | null> => {
    const source = opts?.source ?? 'local';
    const expectedUid = decodeSub(session.accessToken);
    identityGen.current += 1;
    const gen = identityGen.current;
    const loaded = await loadOwnProfileTyped(session);
    if (identityGen.current !== gen) return null; // superseded mid-flight — commit nothing
    // Re-audit C2: PERSISTENT guard — if another tab moved the shared session
    // to a different user while we awaited, this result is for a dead identity.
    const truthNow = syncFromPersistedSession();
    if (truthNow.status !== 'unavailable' && truthNow.userId !== expectedUid) { reconcileRef.current(); return null; }
    if (loaded.status === 'temporarily_unavailable') {
      // Re-audit H4: a transient outage KEEPS the shared session — no terminate,
      // no broadcast; the UI stays neutral and the user simply retries.
      setAuthNotice('Your staff profile could not be reached — check the connection and try again.');
      return 'Your staff profile could not be reached — check the connection and try again.';
    }
    if (loaded.status === 'not_found') {
      await terminateIfUserRef.current(expectedUid ?? '', 'no_staff_profile');
      return 'No staff profile is linked to this account yet.';
    }
    if (loaded.status === 'disabled') {
      await terminateIfUserRef.current(expectedUid ?? '', 'profile_disabled');
      return 'This account has been disabled.';
    }
    if (loaded.status === 'unauthorised') {
      await terminateIfUserRef.current(expectedUid ?? '', 'profile_unauthorised');
      return 'This account is not permitted to sign in.';
    }
    const profile = loaded.profile;
    if (roleRequiresMfa(profile.role)) {
      const mfaStatus = await verifiedMfaStatus(session);
      if (identityGen.current !== gen) return null; // superseded — commit nothing
      if (mfaStatus === 'unknown') {
        // OPT-02G: the factor service could not be consulted (offline / 5xx /
        // timeout). We must NOT sign the user out and must NOT force enrolment —
        // either would be a destructive reaction to a transient blip that would
        // strand an already-enrolled owner. Surface a retryable message: signIn
        // returns it to the form, and the mount-time restore path ignores the
        // return value, so the user simply retries in a moment.
        return 'Two-factor verification is temporarily unavailable. Please try again in a moment.';
      }
      if (mfaStatus === 'none') {
        // Confirmed empty factor list: owner / store-manager MUST enrol. Park
        // them in enrolment; not signed in.
        setMfaPending({ kind: 'enrol', session, message: 'Two-factor authentication is required for this role.' });
        return null;
      }
      // mfaStatus === 'has': a verified factor exists for this account.
      // FIX (audit AUTH-003): enrolment proves a factor EXISTS; it does not
      // prove THIS token presented it. The server now rejects every
      // privileged call below aal2 (migration_fix8), so a restored/unusual
      // aal1 session must step up here rather than render a broken portal.
      if (decodeAal(session.accessToken) !== 'aal2') {
        const factors = await listMfaFactors(session);
        if (identityGen.current !== gen) return null; // superseded — commit nothing
        const totp = factors.find((f) => f.status === 'verified' && f.factor_type === 'totp');
        setMfaPending({
          kind: 'challenge',
          session,
          factorId: totp?.id,
          message: 'Enter your 6-digit authenticator code to continue.',
        });
        return null;
      }
    }
    if (identityGen.current !== gen) return null; // superseded — commit nothing
    setMfaPending(null);
    setEmployee(profile);
    const uid = currentUserId();
    lastUserIdRef.current = uid;
    setAuthNotice(null);
    // The persisted mutation we now embody is APPLIED for this tab, whatever
    // the source — but only a LOCAL mutation may broadcast (re-audit C1: a
    // remote adoption or a boot restore must NEVER echo the event it serves).
    const rev = persistedRevision();
    if (rev) lastAppliedRef.current = rev;
    if (uid && source === 'local') {
      channelRef.current?.post({ type: 'SIGNED_IN', userId: uid, sessionVersion: currentSessionVersion(), mutation: rev ? { writerId: rev.writerId, mutationId: rev.mutationId } : undefined });
    }
    return null;
  }, []);

  // On mount: attempt to restore a session from the stored refresh token.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!configured || !hasStoredSession()) { setLoading(false); return; }
      const session = await refreshSession();
      if (cancelled) return;
      if (!session) { setLoading(false); return; }
      await finalise(session, { source: 'restore' });
      if (cancelled) return;
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [configured, finalise]);

  const signIn = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    const result = await signInWithPassword(email, password);
    if (result.status === 'mfa_required' && result.session && result.factorId) {
      // Park the aal1 session; the UI collects the 6-digit code next.
      setMfaPending({ kind: 'challenge', session: result.session, factorId: result.factorId, message: result.message });
      return result;
    }
    if (result.status === 'ok' && result.session) {
      const err = await finalise(result.session);
      if (err) return { status: 'error', message: err };
    }
    return result;
  }, [finalise]);

  const submitMfaCode = useCallback(async (code: string): Promise<string | null> => {
    if (!mfaPending || mfaPending.kind !== 'challenge' || !mfaPending.factorId) {
      return 'No verification is in progress.';
    }
    const result = await verifyMfaCode(mfaPending.session, mfaPending.factorId, code);
    if (result.status === 'ok' && result.session) {
      return await finalise(result.session);
    }
    if (result.status === 'invalid_credentials') return result.message || 'That code was not correct.';
    return result.message || 'Verification failed.';
  }, [mfaPending, finalise]);

  const completeMfaEnrolment = useCallback(async (session: AuthSession): Promise<string | null> => {
    // After the enrolment UI verifies the first code, the session is aal2 and
    // has a verified factor — finalise will now let the user in.
    return await finalise(session);
  }, [finalise]);

  const terminateSession = useCallback(async (reason: string): Promise<void> => {
    // ONE authoritative session-ending path (audit item 7): local-scope revoke
    // + storage clear (authSignOut), registered private-state purge, cross-tab
    // notification, then React identity teardown. EVERY ending flows through
    // here — manual sign-out, MFA cancel, missing/disabled profile, confirmed
    // expiry, failed adoption.
    identityGen.current += 1; // kill every in-flight identity operation first
    await authSignOut();
    runSessionCleanup();
    const rev = persistedRevision();
    if (rev) lastAppliedRef.current = rev;
    channelRef.current?.post({ type: 'SIGNED_OUT', reason, sessionVersion: currentSessionVersion(), mutation: rev ? { writerId: rev.writerId, mutationId: rev.mutationId } : undefined });
    setMfaPending(null);
    setEmployee(null);
    lastUserIdRef.current = null;
  }, []);
  useEffect(() => { terminateRef.current = terminateSession; }, [terminateSession]);

  /** Re-audit C2 — CONDITIONAL termination for profile-derived decisions: the
   *  storage primitive clears the shared session ONLY if it still belongs to
   *  `expectedUserId`; a stale User-A denial leaves a newer User-B untouched
   *  (the UI then simply realigns to the persisted truth). */
  const terminateIfCurrentUser = useCallback(async (expectedUserId: string, reason: string): Promise<void> => {
    // C1.2 (F3): atomic take through the userId guard + best-effort revoke of
    // the TAKEN chain — which may be a NEWER login of the same identity; the
    // identity's access is gone regardless of ceremony (v8 §1 rule 2). A
    // different user's session is a no-op: realign the UI to the truth.
    const revoked = revokeSessionIfLineage(expectedUserId);
    if (!revoked) { reconcileRef.current(); return; }
    identityGen.current += 1;
    runSessionCleanup();
    const rev = persistedRevision();
    if (rev) lastAppliedRef.current = rev;
    channelRef.current?.post({ type: 'SIGNED_OUT', reason, sessionVersion: currentSessionVersion(), mutation: rev ? { writerId: rev.writerId, mutationId: rev.mutationId } : undefined });
    setMfaPending(null);
    setEmployee(null);
    lastUserIdRef.current = null;
  }, []);
  useEffect(() => { terminateIfUserRef.current = terminateIfCurrentUser; }, [terminateIfCurrentUser]);

  const cancelMfa = useCallback(async () => { await terminateSession('mfa_cancelled'); }, [terminateSession]);

  const signOut = useCallback(async () => { await terminateSession('user_signout'); }, [terminateSession]);

  /** Clear THIS tab's identity without touching shared storage (a peer already
   *  owns the storage transition we are reacting to). */
  const clearLocalIdentity = useCallback((): void => {
    identityGen.current += 1; // in-flight results for the old identity must die
    setMfaPending(null);
    setEmployee(null);
    lastUserIdRef.current = null;
  }, []);

  /** THE receiving-tab rule (re-audit prescribed architecture): storage is the
   *  truth; a broadcast only announces that it changed; reconcile ONCE per
   *  persisted mutation, derive the action from the stored result — never from
   *  the (possibly delayed, possibly superseded) event type — and NEVER
   *  rebroadcast. */
  const reconcileFromTruth = useCallback((): void => {
    const rev = persistedRevision();
    if (!shouldReconcile(rev, lastAppliedRef.current)) return; // already applied this truth
    const synced = syncFromPersistedSession();
    if (synced.status === 'unavailable') return;
    // Nothing persisted AND nothing changed: a first-contact no-op, not an
    // application — consume no gate state (a later visible write triggers).
    if (rev === null && synced.status === 'unchanged') return;
    if (rev) {
      lastAppliedRef.current = rev;
    } else {
      // Applied real state ahead of the revision record's visibility (per-key
      // skew): remember it by version so the record's own event gate-skips
      // while any strictly newer mutation still applies.
      lastAppliedRef.current = { counter: synced.version, writerId: '', mutationId: '' };
    }
    const action = reconcileAction(synced.userId, synced.session !== null, lastUserIdRef.current);
    if (action === 'clear_identity') {
      clearLocalIdentity();
      runSessionCleanup();
      return;
    }
    if (action === 'adopt_session' && synced.session) {
      clearLocalIdentity();       // the OLD identity disappears synchronously
      runSessionCleanup();
      void finalise(synced.session, { source: 'remote' });
    }
  }, [finalise, clearLocalIdentity]);
  useEffect(() => { reconcileRef.current = reconcileFromTruth; }, [reconcileFromTruth]);

  /** Finding-5 fix: typed outcomes. Only CONFIRMED states terminate; a network
   *  blip keeps the session and surfaces a recoverable notice. */
  const revalidateOwnProfile = useCallback(async (trigger: 'focus' | 'broadcast' | 'lifecycle'): Promise<void> => {
    if (!employeeRef.current) return;
    const now = Date.now();
    if (trigger === 'focus' && now - lastRevalidatedAt.current < 60_000) return;
    lastRevalidatedAt.current = now;
    const session = readSession();
    if (!session) { clearLocalIdentity(); return; }
    const gen = identityGen.current;
    const anchoredUid = lastUserIdRef.current;
    const result = await revalidateOwnProfileTyped(session);
    // Re-audit C3: a delayed result for a PREVIOUS identity commits nothing —
    // it may neither install a stale profile nor terminate the newer session.
    if (identityGen.current !== gen || lastUserIdRef.current !== anchoredUid) return;
    if (!anchoredUid) return;
    // Re-audit C2: PERSISTENT guard — another tab may have switched the shared
    // session BEFORE its broadcast reached us. Truth moved on → realign, and
    // never act on this stale result.
    const truthNow = syncFromPersistedSession();
    if (truthNow.status !== 'unavailable' && truthNow.userId !== anchoredUid) { reconcileFromTruth(); return; }
    switch (result.status) {
      case 'ok':
        setAuthNotice(null);
        setEmployee(result.profile);
        return;
      case 'disabled':
        await terminateIfCurrentUser(anchoredUid, 'profile_disabled');
        return;
      case 'not_found':
        await terminateIfCurrentUser(anchoredUid, 'profile_removed');
        return;
      case 'unauthorised':
        await terminateIfCurrentUser(anchoredUid, 'profile_unauthorised');
        return;
      case 'temporarily_unavailable':
        setAuthNotice('Connection problem — your sign-in is unchanged. Retrying shortly.');
        return;
    }
  }, [terminateIfCurrentUser, clearLocalIdentity, reconcileFromTruth]);

  // OPT-02E integration — the cross-tab coordinator, behaviour-correct:
  //  • Finding 6: the OLD identity disappears SYNCHRONOUSLY (before any async
  //    profile read) so User A is never rendered while User B loads;
  //  • Audit C1: every adoption path re-reads the persisted envelope;
  //  • handlers never re-broadcast (loop-safe with the own-origin/stale rules).
  useEffect(() => {
    // EVERY inbound event is only a change-notification: reconcile from truth.
    const ctrl = startAuthChannel({
      onSignedOut: reconcileFromTruth,
      onSessionExpired: reconcileFromTruth,
      onSignedIn: reconcileFromTruth,
      onAccountSwitched: reconcileFromTruth,
      onSessionRefreshed: reconcileFromTruth,
      onProfileChanged: () => { reconcileFromTruth(); void revalidateOwnProfile('broadcast'); },
    }, () => ({ lastVersion: lastAppliedRef.current?.counter ?? 0, currentUserId: lastUserIdRef.current }));
    channelRef.current = ctrl;
    // Whatever mutation is persisted right now predates this tab's coordination.
    lastAppliedRef.current = persistedRevision();
    // REAL-BROWSER race (found by the multi-tab suite): BroadcastChannel can
    // outrun cross-process localStorage visibility, so a delivered event may
    // gate-skip against a not-yet-visible revision and be consumed forever.
    // The `storage` event on the revision key fires in a peer EXACTLY when the
    // write becomes visible there — reconciling on it makes (channel + storage)
    // an at-least-once trigger pair, while the mutation gate keeps application
    // at-most-once. Same-tab writes don't fire it, which is correct: local
    // mutations already set lastApplied themselves.
    const onRevisionVisible = (e: StorageEvent): void => {
      if (e.key === REVISION_STORAGE_KEY || e.key === TOKEN_STORAGE_KEY) reconcileFromTruth();
    };
    window.addEventListener('storage', onRevisionVisible);
    return () => {
      window.removeEventListener('storage', onRevisionVisible);
      ctrl.stop();
      channelRef.current = null;
    };
  }, [reconcileFromTruth, revalidateOwnProfile]);

  // Audit item 6: the request wrapper's lifecycle events now have a LIVE
  // subscriber — a confirmed expiry tears down React identity in every tab, a
  // 403 triggers immediate revalidation, transient conditions surface a notice.
  useEffect(() => {
    const off = onAuthLifecycleEvent((e) => {
      switch (e.type) {
        case 'session_expired':
          void terminateSession(`session_expired:${e.reason}`);
          return;
        case 'session_refreshed': {
          const rev = persistedRevision();
          if (rev) lastAppliedRef.current = rev;
          channelRef.current?.post({ type: 'SESSION_REFRESHED', userId: e.userId, sessionVersion: currentSessionVersion(), mutation: rev ? { writerId: rev.writerId, mutationId: rev.mutationId } : undefined });
          return;
        }
        case 'revalidate_profile':
          void revalidateOwnProfile('lifecycle');
          return;
        case 'temporarily_unavailable':
          setAuthNotice('Connection problem — your sign-in is unchanged.');
          return;
        case 'storage_unavailable':
          setAuthNotice('Browser storage is unavailable — this sign-in lasts for this tab only.');
          return;
      }
    });
    return off;
  }, [terminateSession, revalidateOwnProfile]);

  // Revalidate on tab focus / wake — throttled inside the callback.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void revalidateOwnProfile('focus');
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [revalidateOwnProfile]);

  return {
    employee, loading, configured, mfaPending, authNotice,
    signIn, submitMfaCode, completeMfaEnrolment, cancelMfa, signOut, setEmployee,
  };
}
