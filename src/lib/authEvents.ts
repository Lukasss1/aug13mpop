/**
 * @file authEvents.ts
 * @description A tiny in-PROCESS publish/subscribe bus for auth lifecycle
 * signals within a single tab. It is deliberately independent of React (so the
 * network layer can emit without importing the UI) and independent of
 * BroadcastChannel (that is the CROSS-tab layer, authChannel.ts).
 *
 * The authenticated request wrapper (OPT-02C) emits `session_expired` after a
 * refresh-then-retry still returns 401, and `revalidate_profile` after a 403,
 * so `useAuth`/`App` can move the lifecycle state and purge private data
 * without the network layer reaching up into React.
 */

export type AuthLifecycleEvent =
  /** A refresh was confirmed invalid, or a retried request still got 401. */
  | { type: 'session_expired'; reason: 'refresh_rejected' | 'unauthorised' }
  /** A refresh ROTATED the stored session — peers should adopt it (no re-refresh). */
  | { type: 'session_refreshed'; userId: string }
  /** A previously-permitted call returned 403 → confirm the profile from server. */
  | { type: 'revalidate_profile'; trigger: 'forbidden' | 'broadcast' | 'focus' | 'interval' }
  /** A recoverable outage was observed (offline / 5xx). UX may show a banner. */
  | { type: 'temporarily_unavailable'; reason: 'offline' | 'auth_service' | 'profile_service' }
  /** The session store degraded to tab-only (write rejected). */
  | { type: 'storage_unavailable' };

type Listener = (e: AuthLifecycleEvent) => void;

const listeners = new Set<Listener>();

/** Subscribe to lifecycle events. Returns an unsubscribe function. */
export function onAuthLifecycleEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Emit a lifecycle event to every subscriber. Never throws to the emitter. */
export function emitAuthLifecycleEvent(e: AuthLifecycleEvent): void {
  for (const fn of Array.from(listeners)) {
    try { fn(e); } catch { /* a bad listener must not break the emitter */ }
  }
}

/** TEST-ONLY: drop all listeners between cases. */
export function __resetAuthEventsForTests(): void {
  listeners.clear();
}
