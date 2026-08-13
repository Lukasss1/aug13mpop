/**
 * @file sessionCleanup.ts
 * @description OPT-02E — the extensible registry that clears ALL session-scoped
 * private state on a session boundary, and the identity-boundary rule that
 * guarantees "purge the old identity BEFORE hydrating the new one".
 *
 * The pre-OPT-02 app already had a good `resetPrivateState()` and a
 * `lastHydratedFor` identity guard inside App.tsx. This module generalises that
 * so every domain (documents, media temp ids, signed URLs, pending mutations,
 * query caches, future resources) can register its own teardown without editing
 * one giant function, and so the ordering rule lives in one tested place:
 *
 *     old user id !== new user id  →  purge first  →  then hydrate
 *
 * A delayed response from User A must never populate the UI after User B signs
 * in; the request-generation guard (`makeIdentityGuard`) below is the primitive
 * for that — capture a token before an await, and refuse to commit the result
 * if the identity changed while the request was in flight.
 */

export type SessionCleanupFn = () => void;

const cleanups = new Map<string, SessionCleanupFn>();

/**
 * Register (or replace) a named teardown. Naming makes it idempotent — calling
 * twice for the same domain does not run it twice.
 */
export function registerSessionCleanup(name: string, fn: SessionCleanupFn): void {
  cleanups.set(name, fn);
}

/** Remove a previously-registered teardown (e.g. when a feature unmounts). */
export function unregisterSessionCleanup(name: string): void {
  cleanups.delete(name);
}

/** The names currently registered (diagnostics / tests). */
export function registeredCleanups(): string[] {
  return Array.from(cleanups.keys());
}

/**
 * Run every registered teardown. A throwing cleanup is isolated so one bad
 * domain cannot leave the others un-purged. Returns the names that threw.
 */
export function runSessionCleanup(): string[] {
  const failed: string[] = [];
  for (const [name, fn] of Array.from(cleanups.entries())) {
    try { fn(); } catch { failed.push(name); }
  }
  return failed;
}

/**
 * Apply the identity boundary. If the identity changed, purge FIRST (registered
 * cleanups + the caller's `purge`), then hydrate the new identity. If it did
 * not change, nothing is purged (a same-identity refresh keeps its data).
 *
 * Returns whether the identity changed (so the caller can, e.g., set state).
 */
export function applyIdentityBoundary(opts: {
  previousUserId: string | null;
  nextUserId: string | null;
  /** App-level purge (React state resets) run alongside registered cleanups. */
  purge?: () => void;
  /** Runs only AFTER the purge, and only when identity changed or is present. */
  hydrate?: (userId: string) => void;
}): { changed: boolean } {
  const changed = opts.previousUserId !== opts.nextUserId;
  if (changed) {
    // Purge before hydrate — always, in this order.
    opts.purge?.();
    runSessionCleanup();
  }
  if (opts.nextUserId) {
    // Hydrate is the caller's responsibility; we only guarantee it runs after
    // the purge when identity changed. For an unchanged identity we do NOT
    // re-run hydrate here (the caller decides via `changed`).
    if (changed) opts.hydrate?.(opts.nextUserId);
  }
  return { changed };
}

/**
 * A request-generation guard for stale-response protection. Usage:
 *
 *     const guard = makeIdentityGuard(() => currentUserId());
 *     const gen = guard.begin();
 *     const data = await fetchSomething();
 *     if (!guard.isCurrent(gen)) return;   // identity changed mid-flight — drop
 *     commit(data);
 *
 * `begin()` snapshots the identity + a monotonic generation. `isCurrent()` is
 * true only if neither changed. This is what stops User A's late response from
 * repopulating User B's UI (spec §6 "Account switch").
 */
export function makeIdentityGuard(getUserId: () => string | null) {
  let generation = 0;
  return {
    begin(): { gen: number; userId: string | null } {
      generation += 1;
      return { gen: generation, userId: getUserId() };
    },
    isCurrent(snapshot: { gen: number; userId: string | null }): boolean {
      return snapshot.gen === generation && snapshot.userId === getUserId();
    },
    /** Invalidate all outstanding snapshots (e.g. on explicit sign-out). */
    invalidate(): void { generation += 1; },
  };
}

/** TEST-ONLY: clear the registry between cases. */
export function __resetSessionCleanupForTests(): void {
  cleanups.clear();
}
