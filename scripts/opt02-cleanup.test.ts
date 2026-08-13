/**
 * opt02-cleanup.test.ts — EXECUTABLE unit tests for OPT-02E, the session-scoped
 * cleanup registry, the identity-boundary rule (purge BEFORE hydrate), and the
 * request-generation guard that stops User A's late response from repopulating
 * User B's UI. All pure/synchronous — proven by behaviour.
 *
 * Covers spec §8 unit tests 25-27 and §12 DoD 11,12.
 *
 * Run: npm exec --offline -- tsx scripts/opt02-cleanup.test.ts
 */
import {
  registerSessionCleanup,
  unregisterSessionCleanup,
  registeredCleanups,
  runSessionCleanup,
  applyIdentityBoundary,
  makeIdentityGuard,
  __resetSessionCleanupForTests,
} from '../src/lib/sessionCleanup';

let passed = 0, failed = 0;
const check = (n: string, cond: boolean, d = '') => {
  if (cond) { passed++; console.log(`\u2714 ${n}`); }
  else { failed++; console.error(`\u2716 ${n}\n    ${d}`); }
};

/* 25. The registry runs every teardown, isolates throwers, is idempotent. -- */
__resetSessionCleanupForTests();
{
  const ran: string[] = [];
  registerSessionCleanup('documents', () => ran.push('documents'));
  registerSessionCleanup('media', () => ran.push('media'));
  const failedNames = runSessionCleanup();
  check('25: all registered cleanups run', ran.includes('documents') && ran.includes('media') && ran.length === 2, ran.join(','));
  check('25: no failures when none throw', failedNames.length === 0);
}
__resetSessionCleanupForTests();
{
  const ran: string[] = [];
  registerSessionCleanup('ok-before', () => ran.push('ok-before'));
  registerSessionCleanup('bad', () => { throw new Error('boom'); });
  registerSessionCleanup('ok-after', () => ran.push('ok-after'));
  const failedNames = runSessionCleanup();
  check('25: a throwing cleanup is isolated — the others still run',
    ran.includes('ok-before') && ran.includes('ok-after'), ran.join(','));
  check('25: runSessionCleanup reports the name that threw', failedNames.length === 1 && failedNames[0] === 'bad', failedNames.join(','));
}
__resetSessionCleanupForTests();
{
  let calls = 0;
  registerSessionCleanup('dupe', () => { calls++; });
  registerSessionCleanup('dupe', () => { calls++; });   // replaces, not adds
  check('25: registering the same name twice is idempotent (one entry)', registeredCleanups().length === 1, registeredCleanups().join(','));
  runSessionCleanup();
  check('25: idempotent name runs exactly once', calls === 1, `calls=${calls}`);
  unregisterSessionCleanup('dupe');
  check('25: unregister removes the teardown', registeredCleanups().length === 0);
}

/* 26. Identity boundary: purge BEFORE hydrate, only when identity changed. -- */
__resetSessionCleanupForTests();
{
  const order: string[] = [];
  registerSessionCleanup('domain', () => order.push('cleanup'));
  const res = applyIdentityBoundary({
    previousUserId: 'user-a',
    nextUserId: 'user-b',
    purge: () => order.push('purge'),
    hydrate: (u) => order.push(`hydrate:${u}`),
  });
  check('26: identity changed -> purge, then registered cleanup, then hydrate (STRICT order)',
    order.join('|') === 'purge|cleanup|hydrate:user-b', order.join('|'));
  check('26: reports changed = true', res.changed === true);
}
__resetSessionCleanupForTests();
{
  const order: string[] = [];
  registerSessionCleanup('domain', () => order.push('cleanup'));
  const res = applyIdentityBoundary({
    previousUserId: 'user-a',
    nextUserId: 'user-a',                       // SAME identity — a refresh
    purge: () => order.push('purge'),
    hydrate: (u) => order.push(`hydrate:${u}`),
  });
  check('26: same identity -> nothing purged, no re-hydrate (data preserved)',
    order.length === 0 && res.changed === false, order.join('|'));
}
{
  const order: string[] = [];
  const res = applyIdentityBoundary({
    previousUserId: 'user-a',
    nextUserId: null,                           // sign-out
    purge: () => order.push('purge'),
    hydrate: (u) => order.push(`hydrate:${u}`),
  });
  check('26: sign-out (next=null) -> purge runs, hydrate does NOT',
    order.join('|') === 'purge' && res.changed === true, order.join('|'));
}
{
  // First-ever sign-in (previous null -> a user): purge (of empty) then hydrate.
  __resetSessionCleanupForTests();
  const order: string[] = [];
  const res = applyIdentityBoundary({
    previousUserId: null,
    nextUserId: 'user-a',
    purge: () => order.push('purge'),
    hydrate: (u) => order.push(`hydrate:${u}`),
  });
  check('26: first sign-in (null -> user) -> purge then hydrate, changed = true',
    order.join('|') === 'purge|hydrate:user-a' && res.changed === true, order.join('|'));
}

/* 27. The request-generation guard drops stale in-flight responses. -------- */
{
  let userId: string | null = 'user-a';
  const guard = makeIdentityGuard(() => userId);

  // Same identity, no newer request -> the snapshot is still current.
  const snap1 = guard.begin();
  check('27: snapshot is current when identity unchanged and no newer request', guard.isCurrent(snap1) === true);

  // Identity changes mid-flight -> the in-flight snapshot must be dropped.
  const snap2 = guard.begin();
  userId = 'user-b';
  check('27: identity changed mid-flight -> stale snapshot dropped (User A cannot fill User B UI)',
    guard.isCurrent(snap2) === false);

  // A newer request supersedes an older one even for the SAME user.
  userId = 'user-c';
  const older = guard.begin();
  const newer = guard.begin();
  check('27: newer request supersedes older (older snapshot no longer current)',
    guard.isCurrent(older) === false && guard.isCurrent(newer) === true);

  // invalidate() drops all outstanding snapshots (e.g. explicit sign-out).
  const live = guard.begin();
  guard.invalidate();
  check('27: invalidate() drops outstanding snapshots', guard.isCurrent(live) === false);
}

console.log(`\nOPT-02 CLEANUP UNIT — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
