/**
 * @file authChannel.ts
 * @description OPT-02D — the cross-tab authentication coordinator. Keeps every
 * open Milk Pop tab in agreement about who is signed in.
 *
 * GUARANTEES (spec §2 / §4 OPT-02D):
 *   - Sign-out in one tab signs out every tab.
 *   - Sign-in / account switch in one tab updates every tab.
 *   - Refresh events propagate WITHOUT every tab starting its own refresh.
 *   - A stale, delayed event can never overwrite a newer login (monotonic
 *     `sessionVersion` guard).
 *   - An event from a DIFFERENT user forces an identity-boundary reset before
 *     the receiving tab renders anything for the new identity.
 *   - Tokens are NEVER broadcast; receiving tabs read the session from the
 *     shared session store. Locally-originated events are ignored (no loops).
 *
 * Transport: BroadcastChannel when available, otherwise a `storage` event on a
 * dedicated key. Transient storage keys are removed after posting so they do
 * not accumulate.
 *
 * The DECISION logic (`decideBroadcast`) is a pure function so the stale-guard,
 * loop-guard and identity-reset rules are unit-tested directly; the channel
 * wiring below is a thin shell over it.
 */
import type { AuthBroadcastEvent, AuthBroadcastEnvelope } from './authState';

/** Versioned channel name — bump the suffix if the schema changes incompatibly. */
export const AUTH_CHANNEL = 'milkpop-auth-v1';
/** Dedicated localStorage key used only for the storage-event fallback. */
const FALLBACK_KEY = 'milkpop_auth_broadcast_v1';

/** A per-tab origin id so a tab can ignore its own echoes. */
function makeOrigin(): string {
  try {
    const c = (globalThis as any)?.crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch { /* fall through */ }
  return 'tab-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** The context the decision function evaluates an incoming envelope against. */
export interface BroadcastContext {
  /** This tab's origin id (to detect own echoes). */
  origin: string;
  /** Highest sessionVersion this tab has already applied. */
  lastVersion: number;
  /** The auth user id this tab currently believes is signed in (or null). */
  currentUserId: string | null;
}

/** The decision for an incoming envelope. */
export type BroadcastDecision =
  | { apply: false; reason: 'own_origin' | 'stale' | 'malformed' }
  | { apply: true; event: AuthBroadcastEvent; identityReset: boolean };

/**
 * PURE — decide whether and how to apply an incoming broadcast envelope.
 *
 *  - Ignore our own echoes (loop prevention).
 *  - Ignore anything not strictly newer than what we've applied (stale guard).
 *    Because sign-out/expiry also bump the monotonic version before they are
 *    broadcast, this single rule protects a newer login from an older delayed
 *    sign-out just as it protects against a duplicate.
 *  - Flag an identity reset when the event names a different user than the one
 *    this tab currently shows (or on any ACCOUNT_SWITCHED).
 */
export function decideBroadcast(env: AuthBroadcastEnvelope, ctx: BroadcastContext): BroadcastDecision {
  if (!env || !env.event || typeof (env.event as any).sessionVersion !== 'number') {
    return { apply: false, reason: 'malformed' };
  }
  if (env.origin === ctx.origin) return { apply: false, reason: 'own_origin' };
  if (env.event.sessionVersion <= ctx.lastVersion) return { apply: false, reason: 'stale' };

  const ev = env.event;
  let identityReset = false;
  switch (ev.type) {
    case 'ACCOUNT_SWITCHED':
      identityReset = true;
      break;
    case 'SIGNED_IN':
    case 'SESSION_REFRESHED':
    case 'PROFILE_CHANGED':
      identityReset = ctx.currentUserId !== null && ctx.currentUserId !== ev.userId;
      break;
    case 'SESSION_EXPIRED':
      identityReset = false;
      break;
    case 'SIGNED_OUT':
      identityReset = false;
      break;
  }
  return { apply: true, event: ev, identityReset };
}

/* ------------------------------------------------------------------ */
/*  Channel shell                                                      */
/* ------------------------------------------------------------------ */

/** Callbacks the app supplies to react to (already-filtered) cross-tab events. */
export interface AuthChannelHandlers {
  /** Purge private state for the previous identity BEFORE hydrating a new one. */
  onIdentityReset?: (nextUserId: string | null) => void;
  onSignedOut?: (reason: string) => void;
  onSignedIn?: (userId: string) => void;
  onSessionRefreshed?: (userId: string) => void;
  onSessionExpired?: (userId?: string) => void;
  onProfileChanged?: (userId: string) => void;
  onAccountSwitched?: (previousUserId: string | undefined, userId: string) => void;
}

export interface AuthChannelController {
  /** Post an event to the other tabs. Bumps nothing itself — the caller passes
   *  the current monotonic `sessionVersion` from the session store. */
  post: (event: AuthBroadcastEvent) => void;
  /** Tear down listeners. */
  stop: () => void;
  /** This tab's origin id (exposed for diagnostics/tests). */
  origin: string;
}

/**
 * Start the cross-tab coordinator. `getContext` returns the live version +
 * current user id at dispatch time (so the guard always compares against the
 * freshest local state).
 */
export function startAuthChannel(
  handlers: AuthChannelHandlers,
  getContext: () => Pick<BroadcastContext, 'lastVersion' | 'currentUserId'>,
): AuthChannelController {
  const origin = makeOrigin();
  let bc: BroadcastChannel | null = null;
  let storageHandler: ((e: StorageEvent) => void) | null = null;

  const dispatch = (env: AuthBroadcastEnvelope) => {
    const ctx: BroadcastContext = { origin, ...getContext() };
    const decision = decideBroadcast(env, ctx);
    if (!decision.apply) return;
    const ev = decision.event;
    // Identity boundary FIRST — purge before any hydrate the app may kick off.
    if (decision.identityReset) {
      const nextUser =
        ev.type === 'SIGNED_OUT' || ev.type === 'SESSION_EXPIRED' ? null : (ev as any).userId ?? null;
      handlers.onIdentityReset?.(nextUser);
    }
    switch (ev.type) {
      case 'SIGNED_OUT': handlers.onSignedOut?.(ev.reason); break;
      case 'SIGNED_IN': handlers.onSignedIn?.(ev.userId); break;
      case 'SESSION_REFRESHED': handlers.onSessionRefreshed?.(ev.userId); break;
      case 'SESSION_EXPIRED': handlers.onSessionExpired?.(ev.userId); break;
      case 'PROFILE_CHANGED': handlers.onProfileChanged?.(ev.userId); break;
      case 'ACCOUNT_SWITCHED': handlers.onAccountSwitched?.(ev.previousUserId, ev.userId); break;
    }
  };

  // Preferred transport: BroadcastChannel.
  try {
    if (typeof (globalThis as any).BroadcastChannel === 'function') {
      bc = new BroadcastChannel(AUTH_CHANNEL);
      bc.onmessage = (e: MessageEvent) => {
        if (e?.data) dispatch(e.data as AuthBroadcastEnvelope);
      };
    }
  } catch { bc = null; }

  // Fallback / additional path: storage events (fires in OTHER tabs only).
  if (!bc && typeof (globalThis as any).addEventListener === 'function') {
    storageHandler = (e: StorageEvent) => {
      if (e.key !== FALLBACK_KEY || !e.newValue) return;
      try { dispatch(JSON.parse(e.newValue) as AuthBroadcastEnvelope); } catch { /* ignore */ }
    };
    (globalThis as any).addEventListener('storage', storageHandler);
  }

  const post = (event: AuthBroadcastEvent) => {
    const env: AuthBroadcastEnvelope = { event, origin, timestamp: Date.now() };
    if (bc) {
      try { bc.postMessage(env); return; } catch { /* fall through to storage */ }
    }
    // Storage fallback: write then immediately remove the transient key so it
    // does not accumulate; the mutation still fires a `storage` event in peers.
    try {
      const ls = (globalThis as any)?.localStorage;
      if (ls) {
        ls.setItem(FALLBACK_KEY, JSON.stringify(env));
        ls.removeItem(FALLBACK_KEY);
      }
    } catch { /* best effort */ }
  };

  const stop = () => {
    try { bc?.close(); } catch { /* ignore */ }
    if (storageHandler && typeof (globalThis as any).removeEventListener === 'function') {
      (globalThis as any).removeEventListener('storage', storageHandler);
    }
  };

  return { post, stop, origin };
}
