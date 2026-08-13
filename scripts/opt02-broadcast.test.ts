/**
 * opt02-broadcast.test.ts — EXECUTABLE unit tests for OPT-02D, the cross-tab
 * coordinator. The DECISION core (`decideBroadcast`) is a pure function, so the
 * loop-guard, stale-guard and identity-reset rules are proven directly. A second
 * block drives the real `startAuthChannel` shell over a FAKE storage transport
 * (BroadcastChannel forced off) to prove inbound routing and purge-before-hydrate
 * ordering, plus that outbound posts write+clear the transient fallback key.
 *
 * Covers spec §8 unit tests 20-24 and §12 DoD 8,9,10.
 *
 * Run: npm exec --offline -- tsx scripts/opt02-broadcast.test.ts
 */
import type { AuthBroadcastEnvelope, AuthBroadcastEvent } from '../src/lib/authState';
import { decideBroadcast, startAuthChannel } from '../src/lib/authChannel';
import type { BroadcastContext } from '../src/lib/authChannel';

let passed = 0, failed = 0;
const check = (n: string, cond: boolean, d = '') => {
  if (cond) { passed++; console.log(`\u2714 ${n}`); }
  else { failed++; console.error(`\u2716 ${n}\n    ${d}`); }
};

const envOf = (event: AuthBroadcastEvent, origin = 'tab-remote', timestamp = Date.now()): AuthBroadcastEnvelope =>
  ({ event, origin, timestamp });
const ctxOf = (over: Partial<BroadcastContext> = {}): BroadcastContext =>
  ({ origin: 'tab-local', lastVersion: 0, currentUserId: null, ...over });

function pureTests() {
  /* 20. Own echoes are ignored (loop prevention). ------------------------- */
  {
    const d = decideBroadcast(
      envOf({ type: 'SIGNED_OUT', reason: 'x', sessionVersion: 5 }, 'tab-local'),
      ctxOf({ origin: 'tab-local', lastVersion: 1 }));
    check('20: own-origin envelope ignored (no loop)', d.apply === false && (d as any).reason === 'own_origin');
  }

  /* Malformed envelopes are rejected. ------------------------------------- */
  check('malformed (no event) ignored',
    decideBroadcast({ origin: 'r', timestamp: 1 } as any, ctxOf()).apply === false);
  check('malformed (no numeric sessionVersion) ignored',
    decideBroadcast(envOf({ type: 'SIGNED_OUT', reason: 'x' } as any), ctxOf()).apply === false);

  /* 21. Stale guard: version <= lastVersion is dropped. ------------------- */
  {
    const equal = decideBroadcast(envOf({ type: 'SIGNED_IN', userId: 'u', sessionVersion: 3 }), ctxOf({ lastVersion: 3 }));
    const below = decideBroadcast(envOf({ type: 'SIGNED_IN', userId: 'u', sessionVersion: 2 }), ctxOf({ lastVersion: 3 }));
    const newer = decideBroadcast(envOf({ type: 'SIGNED_IN', userId: 'u', sessionVersion: 4 }), ctxOf({ lastVersion: 3 }));
    check('21: equal version dropped as stale', equal.apply === false && (equal as any).reason === 'stale');
    check('21: older version dropped as stale', below.apply === false && (below as any).reason === 'stale');
    check('21: strictly-newer version applied', newer.apply === true);
  }

  /* 22. HEADLINE: a delayed OLD sign-out cannot override a NEWER login. ---- */
  // Tab logged in locally at version 10; a sign-out broadcast from before (v7)
  // arrives late. The monotonic guard drops it, so the fresh login survives.
  {
    const d = decideBroadcast(
      envOf({ type: 'SIGNED_OUT', reason: 'remote', sessionVersion: 7 }),
      ctxOf({ lastVersion: 10, currentUserId: 'user-b' }));
    check('22: delayed old sign-out (v7) cannot override newer login (v10) — dropped as stale',
      d.apply === false && (d as any).reason === 'stale');
  }

  /* 23. Identity reset only when the user actually differs. --------------- */
  {
    const sameUser = decideBroadcast(
      envOf({ type: 'SIGNED_IN', userId: 'user-a', sessionVersion: 2 }),
      ctxOf({ lastVersion: 1, currentUserId: 'user-a' }));
    const diffUser = decideBroadcast(
      envOf({ type: 'SIGNED_IN', userId: 'user-b', sessionVersion: 2 }),
      ctxOf({ lastVersion: 1, currentUserId: 'user-a' }));
    const noPrior = decideBroadcast(
      envOf({ type: 'SIGNED_IN', userId: 'user-b', sessionVersion: 2 }),
      ctxOf({ lastVersion: 1, currentUserId: null }));
    check('23: SIGNED_IN same user -> apply, NO identity reset',
      sameUser.apply === true && (sameUser as any).identityReset === false);
    check('23: SIGNED_IN different user -> apply, identity reset',
      diffUser.apply === true && (diffUser as any).identityReset === true);
    check('23: SIGNED_IN with no prior identity -> apply, NO reset (nothing to purge)',
      noPrior.apply === true && (noPrior as any).identityReset === false);
  }

  /* 24. Per-type identity-reset semantics. -------------------------------- */
  {
    const acct = decideBroadcast(
      envOf({ type: 'ACCOUNT_SWITCHED', previousUserId: 'user-a', userId: 'user-b', sessionVersion: 2 }),
      ctxOf({ lastVersion: 1, currentUserId: 'user-a' }));
    check('24: ACCOUNT_SWITCHED -> always identity reset', acct.apply === true && (acct as any).identityReset === true);

    const refDiff = decideBroadcast(
      envOf({ type: 'SESSION_REFRESHED', userId: 'user-b', sessionVersion: 2 }),
      ctxOf({ lastVersion: 1, currentUserId: 'user-a' }));
    check('24: SESSION_REFRESHED different user -> reset', (refDiff as any).identityReset === true);

    const profSame = decideBroadcast(
      envOf({ type: 'PROFILE_CHANGED', userId: 'user-a', sessionVersion: 2 }),
      ctxOf({ lastVersion: 1, currentUserId: 'user-a' }));
    check('24: PROFILE_CHANGED same user -> apply, NO reset',
      profSame.apply === true && (profSame as any).identityReset === false);

    const expired = decideBroadcast(
      envOf({ type: 'SESSION_EXPIRED', sessionVersion: 2 }),
      ctxOf({ lastVersion: 1, currentUserId: 'user-a' }));
    check('24: SESSION_EXPIRED -> apply, NO identity reset (same user signed out)',
      expired.apply === true && (expired as any).identityReset === false);
  }
}

function shellTests() {
  // Force the storage-fallback transport: hide BroadcastChannel, install a fake
  // window-ish global with addEventListener + localStorage we can drive.
  const g = globalThis as any;
  const saved = {
    BroadcastChannel: g.BroadcastChannel,
    addEventListener: g.addEventListener,
    removeEventListener: g.removeEventListener,
    localStorage: g.localStorage,
  };
  const storageListeners: Array<(e: any) => void> = [];
  const store = new Map<string, string>();
  const lastWrites: Array<{ op: string; key: string }> = [];
  g.BroadcastChannel = undefined;
  g.addEventListener = (type: string, fn: (e: any) => void) => { if (type === 'storage') storageListeners.push(fn); };
  g.removeEventListener = (type: string, fn: (e: any) => void) => {
    const i = storageListeners.indexOf(fn); if (i >= 0) storageListeners.splice(i, 1);
  };
  g.localStorage = {
    setItem: (key: string, value: string) => { store.set(key, value); lastWrites.push({ op: 'set', key }); },
    removeItem: (key: string) => { store.delete(key); lastWrites.push({ op: 'remove', key }); },
    getItem: (key: string) => store.get(key) ?? null,
  };

  try {
    const order: string[] = [];
    let currentUserId: string | null = 'user-a';
    let lastVersion = 5;
    const ctrl = startAuthChannel(
      {
        onIdentityReset: (u) => order.push(`reset:${u}`),
        onSignedIn: (u) => order.push(`signedin:${u}`),
        onSignedOut: (r) => order.push(`signedout:${r}`),
        onAccountSwitched: (p, u) => order.push(`switch:${p ?? ''}->${u}`),
      },
      () => ({ lastVersion, currentUserId }),
    );

    check('shell: storage-fallback transport selected (no BroadcastChannel)', storageListeners.length === 1);

    // Inbound: a DIFFERENT-user sign-in must purge BEFORE the sign-in handler.
    const inbound: AuthBroadcastEnvelope = {
      event: { type: 'SIGNED_IN', userId: 'user-b', sessionVersion: 6 },
      origin: 'tab-remote', timestamp: Date.now(),
    };
    storageListeners[0]({ key: 'milkpop_auth_broadcast_v1', newValue: JSON.stringify(inbound) });
    check('shell: inbound different-user sign-in purges BEFORE hydrate (order preserved)',
      order.join('|') === 'reset:user-b|signedin:user-b', order.join('|'));

    // A stale inbound (version <= lastVersion) is ignored by the shell too.
    order.length = 0;
    storageListeners[0]({
      key: 'milkpop_auth_broadcast_v1',
      newValue: JSON.stringify({ event: { type: 'SIGNED_OUT', reason: 'old', sessionVersion: 5 }, origin: 'tab-remote', timestamp: Date.now() }),
    });
    check('shell: stale inbound event ignored (no handler fired)', order.length === 0, order.join('|'));

    // Outbound post over the fallback writes THEN removes the transient key.
    lastWrites.length = 0;
    ctrl.post({ type: 'SIGNED_OUT', reason: 'local', sessionVersion: 7 });
    check('shell: post() writes then immediately removes the fallback key (no accumulation)',
      lastWrites.length === 2 && lastWrites[0].op === 'set' && lastWrites[1].op === 'remove'
      && store.has('milkpop_auth_broadcast_v1') === false,
      JSON.stringify(lastWrites));

    // A tab must ignore its OWN echo even over the fallback path.
    order.length = 0;
    storageListeners[0]({
      key: 'milkpop_auth_broadcast_v1',
      newValue: JSON.stringify({ event: { type: 'SIGNED_OUT', reason: 'echo', sessionVersion: 8 }, origin: ctrl.origin, timestamp: Date.now() }),
    });
    check('shell: own-origin echo ignored over fallback (no loop)', order.length === 0, order.join('|'));

    ctrl.stop();
    check('shell: stop() removes the storage listener', storageListeners.length === 0);
  } finally {
    g.BroadcastChannel = saved.BroadcastChannel;
    g.addEventListener = saved.addEventListener;
    g.removeEventListener = saved.removeEventListener;
    g.localStorage = saved.localStorage;
  }
}

pureTests();
shellTests();
console.log(`\nOPT-02 BROADCAST UNIT — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
