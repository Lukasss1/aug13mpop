/**
 * @file auth-harness.ts
 * @description Browser-side model of useAuth's COORDINATION layer, built on the
 * REAL production modules — real `localStorage`, real `BroadcastChannel`, the
 * real `authStorage`/`authChannel`/`authReconcile` code. The multi-tab browser
 * suite (`scripts/auth-multitab.browser.test.mjs`) opens this page in several
 * genuine Chromium tabs and drives it, upgrading the node-level behavioural
 * evidence to real transport. Scope: the coordination layer exactly as the
 * hook implements it (reconcile-from-truth, at-most-once per mutation, never
 * rebroadcast); the profile/React layer is Stage-10's job.
 */
import {
  setAuthoritativeSession,
  clearSessionUnconditional,
  commitRefreshedSession,
  syncFromPersistedSession,
  persistedRevision,
  currentSessionVersion,
  currentUserId,
  readSession,
} from '../src/lib/authStorage';
import type { PersistedRevision } from '../src/lib/authStorage';
import { REVISION_STORAGE_KEY, TOKEN_STORAGE_KEY } from '../src/lib/authStorage';
import { startAuthChannel, decideBroadcast, AUTH_CHANNEL } from '../src/lib/authChannel';
import type { AuthBroadcastEvent, AuthSession } from '../src/lib/authState';
import { reconcileAction, shouldReconcile } from '../src/lib/authReconcile';

const b64 = (o: object): string => btoa(JSON.stringify(o)).replace(/=+$/, '');
const jwt = (sub: string, mark: string): string => `h.${b64({ sub, mark })}.s`;
const makeSession = (sub: string, mark: string): AuthSession =>
  ({ accessToken: jwt(sub, mark), refreshToken: `r-${sub}-${mark}`, expiresAt: 9_999_999_999 });

interface HarnessState {
  localUser: string | null;
  processed: number;
  posted: number;
  version: number;
  userId: string | null;
  token: string | null;
  lastAppliedCounter: number;
  clears: number;
}

let localUser: string | null = null;
let lastApplied: PersistedRevision | null = null;
let processed = 0;
let posted = 0;
let lastPostedEvent: AuthBroadcastEvent | null = null;
/** How many times reconcile CLEARED the local identity (ghost-proof counter). */
let clears = 0;

/** Diagnostic ring: every envelope seen on the wire + its decide verdict. */
const debugLog: string[] = [];
try {
  const shadow = new BroadcastChannel(AUTH_CHANNEL);
  shadow.onmessage = (e: MessageEvent) => {
    const env = e.data as { event?: { type?: string; sessionVersion?: number } };
    const d = decideBroadcast(e.data, { origin: '__debug__', lastVersion: lastApplied?.counter ?? 0, currentUserId: localUser });
    debugLog.push(`wire ${env?.event?.type}@v${env?.event?.sessionVersion} lastApplied=${lastApplied?.counter ?? 0} myV=${currentSessionVersion()} -> ${d.apply ? 'APPLY' : d.reason}`);
  };
} catch { /* no BroadcastChannel */ }

/** The receiving pipeline — the SAME rule the hook runs. Never posts. */
function reconcileFromTruth(): void {
  const rev = persistedRevision();
  if (!shouldReconcile(rev, lastApplied)) { debugLog.push(`reconcile: gate-skip rev=${rev?.counter}/${rev?.mutationId?.slice(0, 6)}`); return; }
  const synced = syncFromPersistedSession();
  debugLog.push(`reconcile: rev=${rev?.counter} sync=${synced.status} user=${String(synced.userId)}`);
  if (synced.status === 'unavailable') return;
  if (rev === null && synced.status === 'unchanged') return; // first-contact no-op
  if (rev) {
    lastApplied = rev;
  } else {
    lastApplied = { counter: synced.version, writerId: '', mutationId: '' };
  }
  processed += 1;
  const action = reconcileAction(synced.userId, synced.session !== null, localUser);
  if (action === 'clear_identity') { localUser = null; clears += 1; }
  if (action === 'adopt_session') localUser = synced.userId;
}

const channel = startAuthChannel({
  onSignedOut: reconcileFromTruth,
  onSessionExpired: reconcileFromTruth,
  onSignedIn: reconcileFromTruth,
  onAccountSwitched: reconcileFromTruth,
  onSessionRefreshed: reconcileFromTruth,
  onProfileChanged: reconcileFromTruth,
}, () => ({ lastVersion: lastApplied?.counter ?? 0, currentUserId: localUser }));

// Mirrors the hook: reconcile when a peer's revision write becomes VISIBLE.
window.addEventListener('storage', (e: StorageEvent): void => {
  if (e.key === REVISION_STORAGE_KEY || e.key === TOKEN_STORAGE_KEY) { debugLog.push(`storage-visible(${e.key === TOKEN_STORAGE_KEY ? 'token' : 'rev'}) -> reconcile`); reconcileFromTruth(); }
});

function post(event: AuthBroadcastEvent): void {
  posted += 1;
  lastPostedEvent = event;
  channel.post(event);
}

function mutationRef(): { writerId: string; mutationId: string } | undefined {
  const rev = persistedRevision();
  return rev ? { writerId: rev.writerId, mutationId: rev.mutationId } : undefined;
}

const harness = {
  /** A LOCAL login ceremony: write storage, adopt locally, broadcast once. */
  login(sub: string, mark: string): void {
    setAuthoritativeSession(makeSession(sub, mark));
    localUser = currentUserId();
    lastApplied = persistedRevision();
    post({ type: 'SIGNED_IN', userId: localUser ?? '', sessionVersion: currentSessionVersion(), mutation: mutationRef() });
  },
  /** A LOCAL sign-out: clear storage, broadcast once. */
  logout(): void {
    clearSessionUnconditional();
    localUser = null;
    lastApplied = persistedRevision();
    post({ type: 'SIGNED_OUT', reason: 'user_signout', sessionVersion: currentSessionVersion(), mutation: mutationRef() });
  },
  /** A LOCAL token rotation landing: commit against the current basis, broadcast once. */
  refresh(mark: string): boolean {
    const basis = readSession();
    const sub = currentUserId();
    if (!basis || !sub) return false;
    const applied = commitRefreshedSession(makeSession(sub, mark), basis);
    if (!applied) return false;
    lastApplied = persistedRevision();
    post({ type: 'SESSION_REFRESHED', userId: sub, sessionVersion: currentSessionVersion(), mutation: mutationRef() });
    return true;
  },
  /** Craft an arbitrary (possibly stale) event — the H3/B6 probe. */
  postRaw(event: AuthBroadcastEvent): void {
    post(event);
  },
  /** Re-deliver the last posted event verbatim (duplicate-delivery probe). */
  repostLast(): boolean {
    if (!lastPostedEvent) return false;
    post(lastPostedEvent);
    return true;
  },
  debug(): string[] { return debugLog.slice(-20); },
  state(): HarnessState {
    return {
      localUser,
      processed,
      posted,
      version: currentSessionVersion(),
      userId: currentUserId(),
      token: readSession()?.accessToken ?? null,
      lastAppliedCounter: lastApplied?.counter ?? 0,
      clears,
    };
  },
};

declare global {
  interface Window { __h: typeof harness }
}
window.__h = harness;
document.title = 'auth-harness ready';
