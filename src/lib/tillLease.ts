/**
 * @file tillLease.ts — R4.2: ONE ACTIVE TILL TAB per browser profile.
 *
 * WHY: the durable payment store is a single localStorage key mutated by
 * read-modify-write. persistVerified() proves a tab wrote what it intended;
 * it cannot prove another tab did not overwrite it a moment later. Two tabs
 * can therefore both hold "verified" states while one tab's money-bearing
 * record has been destroyed. Rather than redesign the store into a
 * multi-writer schema, R4.2 enforces the database-like property the store
 * was missing: A SINGLE WRITER. The first till tab takes a lease; every
 * other tab is read-only for money (zero money-bearing RPCs) until the
 * primary goes away.
 *
 * STATES
 *   'solo'      — no cross-tab environment exists (no window: tests, tooling).
 *                 Mutual exclusion is trivially satisfied; money is allowed.
 *   'unknown'   — a browser tab before acquire() resolves. FAIL CLOSED:
 *                 money is NOT allowed.
 *   'primary'   — this tab holds the lease. Money is allowed ONLY when the
 *                 lease is held via Web Locks; a heartbeat primary is
 *                 presence/diagnostics only (R4.4 / F-02).
 *   'secondary' — another tab holds it; money is NOT allowed.
 *
 * TRANSPORT (mirrors src/lib/authChannel.ts's graceful degradation):
 *   1. Web Locks (`navigator.locks`) — the lock is held for the tab's
 *      lifetime and released by the browser on close or crash. This is the
 *      real guarantee on every modern target (Chrome/Edge/Safari/Firefox and
 *      the Capacitor webview).
 *   2. Fallback: a localStorage heartbeat claim (tabId + timestamp, refreshed
 *      every 2s, stale after 6s) with a settle-and-re-read step to shrink the
 *      claim race. This path is DEGRADED and (R4.4 / F-02) NEVER money-capable:
 *      timer throttling can freeze a heartbeat primary past the stale window,
 *      so exclusivity cannot be guaranteed. A heartbeat 'primary' exists for
 *      presence/diagnostics only; every tick reads BEFORE writing, and a
 *      primary that finds a fresh foreign claim demotes itself rather than
 *      stealing the claim back.
 */

export type LeaseState = 'solo' | 'unknown' | 'primary' | 'secondary';

const LOCK_NAME = 'milkpop_till_primary_v1';
const CLAIM_KEY = 'milkpop_till_lease_v1';
const HEARTBEAT_MS = 2000;
const STALE_MS = 6000;
const SETTLE_MS = 250;

interface ClaimRow { tabId: string; ts: number }

export interface LeaseEnv {
  /** true in a real browser tab; false in tests/tooling (→ 'solo'). */
  hasWindow: boolean;
  locks: { request: (name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => unknown) => Promise<unknown> } | null;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  now: () => number;
  tabId: string;
  /** injectable for deterministic fallback tests */
  sleep: (ms: number) => Promise<void>;
  /** injectable cadence for deterministic fallback tests (default 2000 / 6000) */
  heartbeatMs?: number;
  staleMs?: number;
}

export interface LeaseCore {
  state(): LeaseState;
  /** Resolve this tab's role. Idempotent; re-callable after 'secondary' (a
   *  "Make this tab the till" retry) — it re-checks availability. */
  acquire(): Promise<LeaseState>;
  subscribe(listener: (s: LeaseState) => void): () => void;
  /** The one question money-bearing code asks. */
  moneyAllowed(): boolean;
  /** Durable browser storage is part of the financial safety boundary. A tab
   * may hold the Web Lock but must still remain read-only when storage access
   * is blocked. Solo tooling runtimes are treated as available. */
  storageAvailable(): boolean;
  /** Which primitive holds the lease — 'locks' is the production-grade path
   *  (required for strict financial exclusivity); 'heartbeat' is the DEGRADED
   *  fallback and is surfaced as such in the UI; 'none' = solo runtimes. */
  mechanism(): 'locks' | 'heartbeat' | 'none';
  /** Fallback-path tidy-up (and tests): drop a held heartbeat claim. */
  release(): void;
}

export function createLeaseCore(env: LeaseEnv): LeaseCore {
  let state: LeaseState = env.hasWindow ? 'unknown' : 'solo';
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<(s: LeaseState) => void>();
  const setState = (s: LeaseState): void => {
    state = s;
    listeners.forEach((l) => { try { l(s); } catch { /* listeners never break the lease */ } });
  };

  const readClaim = (): ClaimRow | null => {
    try {
      const raw = env.storage?.getItem(CLAIM_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as ClaimRow;
      return p && typeof p.tabId === 'string' && typeof p.ts === 'number' ? p : null;
    } catch { return null; }
  };
  const writeClaim = (): boolean => {
    try {
      env.storage?.setItem(CLAIM_KEY, JSON.stringify({ tabId: env.tabId, ts: env.now() } satisfies ClaimRow));
      return readClaim()?.tabId === env.tabId;
    } catch { return false; }
  };

  const acquireViaLocks = async (): Promise<LeaseState> => new Promise<LeaseState>((resolveOuter) => {
    void env.locks!.request(LOCK_NAME, { ifAvailable: true }, (lock: unknown) => {
      if (!lock) { resolveOuter('secondary'); return undefined; }
      setState('primary');
      resolveOuter('primary');
      // Hold the lock for the tab's lifetime; the browser releases it on
      // close/crash, which is exactly the failover we want.
      return new Promise(() => { /* held forever */ });
    }).catch(() => resolveOuter('secondary'));
  });

  const hbMs = env.heartbeatMs ?? HEARTBEAT_MS;
  const staleMs = env.staleMs ?? STALE_MS;

  /** R4.4 / F-02: a primary that has lost the claim steps DOWN. */
  const demote = (): void => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (state === 'primary') setState('secondary');
  };
  /** Heartbeat upkeep — read FIRST. A fresh foreign claim means ownership
   *  moved while this tab was throttled or suspended: demote, and never
   *  stomp the new primary's claim. Only refresh when the key is ours,
   *  absent, or stale; a refresh that does not stick also demotes. */
  const heartbeatTick = (): void => {
    const cur = readClaim();
    if (cur && cur.tabId !== env.tabId && env.now() - cur.ts < staleMs) { demote(); return; }
    if (!writeClaim()) demote();
  };

  const acquireViaHeartbeat = async (): Promise<LeaseState> => {
    const existing = readClaim();
    if (existing && existing.tabId !== env.tabId && env.now() - existing.ts < staleMs) return 'secondary';
    if (!writeClaim()) return 'secondary';                       // fail closed
    await env.sleep(SETTLE_MS);                                  // let a racing writer land
    if (readClaim()?.tabId !== env.tabId) return 'secondary';    // lost the settle re-read
    if (!heartbeat) {
      heartbeat = setInterval(heartbeatTick, hbMs);
    }
    return 'primary';
  };

  return {
    state: () => state,
    /** R4.4 / F-02: money requires an AUTHORITATIVE lock — a Web Locks
     *  primary or a solo runtime. A heartbeat 'primary' keeps the role for
     *  presence/diagnostics but is NEVER money-capable. */
    moneyAllowed: () => state === 'solo' || (state === 'primary' && !!env.locks && !!env.storage),
    storageAvailable: () => !env.hasWindow || !!env.storage,
    mechanism: () => (env.locks ? 'locks' : env.storage ? 'heartbeat' : 'none'),
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    release: () => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      try { if (readClaim()?.tabId === env.tabId) env.storage?.removeItem(CLAIM_KEY); } catch { /* best effort */ }
      if (state === 'primary') setState('secondary');
    },
    acquire: async () => {
      if (state === 'solo' || state === 'primary') return state;
      const got = env.locks ? await acquireViaLocks() : await acquireViaHeartbeat();
      setState(got);
      return got;
    },
  };
}

/* ------------------------- the app singleton ------------------------- */

/** Browser storage can be disabled by privacy policy, sandboxing or managed
 * browser settings. Merely reading `window.localStorage` may throw a
 * SecurityError, so resolve it defensively during module initialisation. A
 * missing store keeps the lease fail-closed (`secondary`, no money) without
 * preventing the rest of Staff Portal from loading. */
function resolveStorage(hasWindow: boolean): LeaseEnv['storage'] {
  if (!hasWindow) return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function detectEnv(): LeaseEnv {
  const hasWindow = typeof window !== 'undefined';
  const nav = hasWindow ? (navigator as Navigator & { locks?: LeaseEnv['locks'] }) : null;
  return {
    hasWindow,
    locks: nav?.locks ?? null,
    storage: resolveStorage(hasWindow),
    now: () => Date.now(),
    tabId: `tab_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

let core: LeaseCore = createLeaseCore(detectEnv());

export const leaseState = (): LeaseState => core.state();
export const moneyAllowed = (): boolean => core.moneyAllowed();
export const leaseStorageAvailable = (): boolean => core.storageAvailable();
export const leaseMechanism = (): 'locks' | 'heartbeat' | 'none' => core.mechanism();
export const acquireTillLease = (): Promise<LeaseState> => core.acquire();
export const subscribeLease = (l: (s: LeaseState) => void): (() => void) => core.subscribe(l);
export const releaseTillLease = (): void => core.release();

/** TEST SEAM: swap the singleton for an injected core (or force a state). */
export function _replaceCoreForTests(next: LeaseCore): void { core = next; }
