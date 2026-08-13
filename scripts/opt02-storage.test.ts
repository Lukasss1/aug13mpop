/**
 * opt02-storage.test.ts — EXECUTABLE unit tests for the OPT-02-C1 lineage/epoch
 * storage authority. Proves, by behaviour against an in-memory store:
 *   - a ceremony (authEpoch) is minted on authoritative login and DIFFERS per login;
 *   - MFA step-up installs ONLY within the same ceremony (replaceSessionIfLineage);
 *   - refresh rotation PRESERVES the ceremony;
 *   - get/take by lineage distinguish a same-ceremony survivor from a supersession;
 *   - a v3 envelope round-trips a reload (session + epoch + version restored);
 *   - pre-C1.1 (v2 / legacy) blobs are MIGRATED to v3 in place (the upgrade keeps
 *     the user signed in; the forced re-login is the downgrade direction); a
 *     malformed blob is dropped and swept.
 *
 * No Vite, browser or Supabase required.
 *
 * Run: npm exec --offline -- tsx scripts/opt02-storage.test.ts
 */
import type { AuthSession } from '../src/lib/authState';
import {
  __resetAuthStorageForTests,
  __createMemoryStoreForTests,
  setAuthoritativeSession,
  replaceSessionIfLineage,
  commitRefreshedSession,
  clearSessionUnconditional,
  takeSessionIfLineage,
  takeSessionIfUser,
  getSessionIfLineage,
  currentLineage,
  readAuthSnapshot,
  readSession,
  hasSession,
  currentSessionVersion,
  currentUserId,
  mintEpoch,
  sameLifecycle,
  decodeSub,
} from '../src/lib/authStorage';

let passed = 0, failed = 0;
const check = (n: string, cond: boolean, d = '') => {
  if (cond) { passed++; console.log(`\u2714 ${n}`); }
  else { failed++; console.error(`\u2716 ${n}\n    ${d}`); }
};

/** Build a syntactically-valid JWT carrying a given `sub`, so decodeSub works. */
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (sub: string) => `x.${b64url(JSON.stringify({ sub }))}.y`;

const session = (over: Partial<AuthSession> & { sub?: string } = {}): AuthSession => ({
  accessToken: jwt(over.sub ?? 'user-a'),
  refreshToken: over.refreshToken ?? 'refresh-1',
  expiresAt: over.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
});

/** The white-box storage key (module-private in authStorage); used only to prove
 *  the stale-blob sweep on load removes the old material. */
const TOKEN_KEY = 'milkpop_auth_token';

/* 1. mintEpoch + sameLifecycle: identity is user + ceremony, equality only. --- */
{
  const e1 = mintEpoch();
  const e2 = mintEpoch();
  check('1: mintEpoch never repeats', e1 !== e2, `${e1} vs ${e2}`);
  const L = { userId: 'u', authEpoch: e1 };
  check('1: sameLifecycle is reflexive', sameLifecycle(L, { ...L }) === true);
  check('1: sameLifecycle differs on epoch', sameLifecycle(L, { userId: 'u', authEpoch: e2 }) === false);
  check('1: sameLifecycle differs on user', sameLifecycle(L, { userId: 'v', authEpoch: e1 }) === false);
  check('1: sameLifecycle rejects null', sameLifecycle(L, null) === false && sameLifecycle(null, L) === false);
}

/* 2. Authoritative login mints a lineage; two logins differ by epoch. -------- */
__resetAuthStorageForTests(__createMemoryStoreForTests());
{
  const l1 = setAuthoritativeSession(session({ sub: 'user-a', refreshToken: 'r1' }));
  check('2: login returns a lineage for the JWT sub', l1.userId === 'user-a' && !!l1.authEpoch);
  check('2: currentLineage matches the returned lineage', sameLifecycle(currentLineage(), l1));
  const l2 = setAuthoritativeSession(session({ sub: 'user-a', refreshToken: 'r2' }));
  check('2: a second login mints a NEW ceremony (different epoch, same user)',
    l2.userId === 'user-a' && l2.authEpoch !== l1.authEpoch && sameLifecycle(l1, l2) === false,
    `${l1.authEpoch} vs ${l2.authEpoch}`);
  check('2: the first lineage is no longer current', getSessionIfLineage(l1) === null);
}

/* 3. MFA step-up: replaceSessionIfLineage installs WITHIN the same ceremony. -- */
__resetAuthStorageForTests(__createMemoryStoreForTests());
{
  const aal1 = session({ sub: 'user-a', refreshToken: 'aal1' });
  const L = setAuthoritativeSession(aal1);
  const vAfterLogin = currentSessionVersion();
  const stepped = session({ sub: 'user-a', refreshToken: 'aal2' });
  const L2 = replaceSessionIfLineage(L, stepped);
  check('3: step-up succeeds under the matching lineage', L2 !== null);
  check('3: the ceremony (authEpoch) is PRESERVED across step-up', !!L2 && L2.authEpoch === L.authEpoch);
  check('3: the stepped session is now stored', readSession()?.refreshToken === 'aal2');
  check('3: the write bumped the monotonic version', currentSessionVersion() === vAfterLogin + 1);
}
{
  // A step-up that arrives after a NEWER login is discarded, never installed.
  const stale = currentLineage()!;                       // ceremony from above
  setAuthoritativeSession(session({ sub: 'user-a', refreshToken: 'new-login' })); // new ceremony
  const before = readSession()?.refreshToken;
  const vBefore = currentSessionVersion();
  const res = replaceSessionIfLineage(stale, session({ sub: 'user-a', refreshToken: 'ghost' }));
  check('3: step-up under a stale lineage returns null', res === null);
  check('3: stale step-up does NOT change the stored session', readSession()?.refreshToken === before);
  check('3: stale step-up does NOT bump the version', currentSessionVersion() === vBefore);
}

/* 4. Refresh rotation PRESERVES the ceremony; basis + monotonic guards hold. -- */
__resetAuthStorageForTests(__createMemoryStoreForTests());
{
  const s0 = session({ sub: 'user-a', refreshToken: 'r-a', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  const L = setAuthoritativeSession(s0);
  const rotated = session({ sub: 'user-a', refreshToken: 'r-b', expiresAt: s0.expiresAt + 3600 });
  const applied = commitRefreshedSession(rotated, s0);
  check('4: rotation under the correct basis applies', applied === true);
  check('4: rotation PRESERVES the ceremony (same epoch, same lineage)',
    sameLifecycle(currentLineage(), L), `${currentLineage()?.authEpoch} vs ${L.authEpoch}`);
  check('4: the rotated session is stored', readSession()?.refreshToken === 'r-b');
}
{
  // Stale basis (a different login took over) → drop, no write, no version bump.
  setAuthoritativeSession(session({ sub: 'user-b', refreshToken: 'r-newer' }));
  const vBefore = currentSessionVersion();
  const staleBasis = session({ sub: 'user-a', refreshToken: 'r-b' });
  const dropped = commitRefreshedSession(session({ refreshToken: 'r-x' }), staleBasis);
  check('4: rotation under a stale basis is DROPPED', dropped === false);
  check('4: stale rotation leaves the newer session + version untouched',
    readSession()?.refreshToken === 'r-newer' && currentSessionVersion() === vBefore);
}
{
  // Monotonic-expiry guard: never move backwards in expiry for the same lineage.
  __resetAuthStorageForTests(__createMemoryStoreForTests());
  const now = Math.floor(Date.now() / 1000);
  const s0 = session({ sub: 'user-a', refreshToken: 'r-a', expiresAt: now + 3600 });
  setAuthoritativeSession(s0);
  const backwards = commitRefreshedSession(session({ refreshToken: 'r-b', expiresAt: now + 60 }), s0);
  check('4: a rotation to an EARLIER expiry is rejected', backwards === false);
  check('4: the earlier-expiry rotation did not replace the session', readSession()?.refreshToken === 'r-a');
}

/* 5. get/takeSessionIfLineage — survivor vs supersession, atomic take. ------- */
__resetAuthStorageForTests(__createMemoryStoreForTests());
{
  const L = setAuthoritativeSession(session({ sub: 'user-a', refreshToken: 'r1' }));
  check('5: getSessionIfLineage returns the session for the current lineage',
    getSessionIfLineage(L)?.refreshToken === 'r1');
  const taken = takeSessionIfLineage(L);
  check('5: takeSessionIfLineage returns the held chain', taken?.session.refreshToken === 'r1');
  check('5: after take, the session is gone (atomic remove)', readSession() === null && hasSession() === false);
  check('5: after take, the lineage is cleared', currentLineage() === null);
  const takeAgain = takeSessionIfLineage(L);
  check('5: a second take under the same (now dead) lineage yields null', takeAgain === null);
}
{
  // Take under a superseded lineage must NOT touch the newer session.
  const stale = setAuthoritativeSession(session({ sub: 'user-a', refreshToken: 'r-old' }));
  setAuthoritativeSession(session({ sub: 'user-b', refreshToken: 'r-new' }));  // newer ceremony
  const res = takeSessionIfLineage(stale);
  check('5: take under a superseded lineage returns null', res === null);
  check('5: the newer session survives an attempted stale take', readSession()?.refreshToken === 'r-new');
  check('5: getSessionIfLineage(stale) is null after supersession', getSessionIfLineage(stale) === null);
}

/* 6. readAuthSnapshot — coherent {session, lineage}; null/null when signed out. */
__resetAuthStorageForTests(__createMemoryStoreForTests());
{
  const L = setAuthoritativeSession(session({ sub: 'user-a', refreshToken: 'r1' }));
  const snap = readAuthSnapshot();
  check('6: snapshot pairs the session with its lineage',
    snap.session?.refreshToken === 'r1' && sameLifecycle(snap.lineage, L));
  clearSessionUnconditional();
  const empty = readAuthSnapshot();
  check('6: after sign-out the snapshot is {null, null}', empty.session === null && empty.lineage === null);
  check('6: sign-out clears the lineage', currentLineage() === null && currentUserId() === null);
}

/* 7. v3 envelope round-trips a reload: session + epoch + version restored. ---- */
{
  const store = __createMemoryStoreForTests();
  __resetAuthStorageForTests(store);
  const L = setAuthoritativeSession(session({ sub: 'user-reload', refreshToken: 'r-persist' }));
  const vBefore = currentSessionVersion();
  // Simulate a reload: re-init the authority from the SAME underlying store.
  __resetAuthStorageForTests(store);
  check('7: the session survives a reload', readSession()?.refreshToken === 'r-persist');
  check('7: the ceremony survives a reload (same authEpoch)', sameLifecycle(currentLineage(), L),
    `${currentLineage()?.authEpoch} vs ${L.authEpoch}`);
  check('7: the monotonic version survives a reload', currentSessionVersion() === vBefore);
  check('7: the restored user id is the JWT sub', currentUserId() === 'user-reload');
}

/* 8. v8 §3 MIGRATION: pre-C1.1 blobs are UPGRADED to v3 in place (upgrade keeps
 *    the user signed in; the forced re-login is the DOWNGRADE direction only). -- */
{
  // v2 envelope (no authEpoch) — the shape written by the pre-C1.1 build.
  const store = __createMemoryStoreForTests();
  store.setItem(TOKEN_KEY, JSON.stringify({
    schemaVersion: 2,
    session: { accessToken: jwt('user-v2'), refreshToken: 'r-v2', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
    sessionVersion: 5, userId: 'user-v2', updatedAt: new Date().toISOString(),
  }));
  __resetAuthStorageForTests(store);
  check('8: a v2 envelope IS restored (migrated, not dropped)',
    readSession()?.refreshToken === 'r-v2' && hasSession() === true);
  check('8: migration MINTS a ceremony for the restored v2 session',
    !!currentLineage() && currentLineage()!.userId === 'user-v2' && !!currentLineage()!.authEpoch);
  check('8: the v2 counter is preserved through migration', currentSessionVersion() === 5);
  // The blob on disk was rewritten as v3 so the old shape never lingers.
  const rewritten = JSON.parse(store.getItem(TOKEN_KEY) as string);
  check('8: the stored blob is rewritten to schemaVersion 3 with a string authEpoch',
    rewritten.schemaVersion === 3 && typeof rewritten.authEpoch === 'string' && rewritten.authEpoch.length > 0);
  const mintedEpoch = currentLineage()!.authEpoch;
  // A SECOND reload from the SAME store must keep the SAME minted ceremony —
  // the epoch is not re-minted on every load (that would change lineage identity).
  __resetAuthStorageForTests(store);
  check('8: the minted ceremony is STABLE across a subsequent reload (not re-minted)',
    currentLineage()?.authEpoch === mintedEpoch, `${currentLineage()?.authEpoch} vs ${mintedEpoch}`);
}
{
  // Legacy bare session { accessToken, refreshToken, expiresAt } → migrated to v3.
  const store = __createMemoryStoreForTests();
  store.setItem(TOKEN_KEY, JSON.stringify({ accessToken: jwt('user-bare'), refreshToken: 'r-bare', expiresAt: Math.floor(Date.now() / 1000) + 3600 }));
  __resetAuthStorageForTests(store);
  check('8: a legacy bare session IS restored and migrated',
    readSession()?.refreshToken === 'r-bare' && currentSessionVersion() === 1);
  check('8: the migrated bare session takes its userId from the JWT sub', currentUserId() === 'user-bare');
  const rewritten = JSON.parse(store.getItem(TOKEN_KEY) as string);
  check('8: the legacy blob is rewritten as v3', rewritten.schemaVersion === 3 && typeof rewritten.authEpoch === 'string');
}
{
  // Malformed JSON is still dropped and swept (not migratable).
  const store = __createMemoryStoreForTests();
  store.setItem(TOKEN_KEY, '{not json');
  __resetAuthStorageForTests(store);
  check('8: a malformed blob yields no session and is swept',
    readSession() === null && store.getItem(TOKEN_KEY) === null);
}
{
  // A well-formed v3 envelope IS restored verbatim (positive control).
  const store = __createMemoryStoreForTests();
  const epoch = 'e-fixed.abcd1234';
  store.setItem(TOKEN_KEY, JSON.stringify({
    schemaVersion: 3, authEpoch: epoch,
    session: { accessToken: jwt('u3'), refreshToken: 'r-v3', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
    sessionVersion: 9, userId: 'u3', updatedAt: new Date().toISOString(),
  }));
  __resetAuthStorageForTests(store);
  check('8: a valid v3 envelope IS restored with its recorded ceremony (verbatim, not re-minted)',
    readSession()?.refreshToken === 'r-v3' && currentLineage()?.authEpoch === epoch && currentSessionVersion() === 9);
}

/* 9. decodeSub is exported and reads the JWT sub. --------------------------- */
{
  check('9: decodeSub reads the sub claim', decodeSub(jwt('claimed')) === 'claimed');
  check('9: decodeSub is null on a non-JWT', decodeSub('not-a-jwt') === null && decodeSub(undefined) === null);
}

/* 10. AUDIT-F6: replaceSessionIfLineage refuses a session whose JWT sub is NOT
 *     the expected user — a foreign session can never be installed under another
 *     identity's ceremony, even when the ceremony matches. --------------------- */
__resetAuthStorageForTests(__createMemoryStoreForTests());
{
  const L = setAuthoritativeSession(session({ sub: 'user-1', refreshToken: 'r-u1' }));
  const vBefore = currentSessionVersion();
  // A step-up result carrying a DIFFERENT user's sub, under the correct ceremony.
  const foreign = replaceSessionIfLineage(L, session({ sub: 'user-2', refreshToken: 'r-u2' }));
  check('10: a foreign-sub replacement is REJECTED', foreign === null);
  check('10: the store is untouched — still user-1, same token, same version',
    currentUserId() === 'user-1' && readSession()?.refreshToken === 'r-u1' && currentSessionVersion() === vBefore);
  // An undecodable token is likewise refused.
  const undecodable = replaceSessionIfLineage(L, { accessToken: 'not-a-jwt', refreshToken: 'r-x', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  check('10: an undecodable-sub replacement is REJECTED', undecodable === null && readSession()?.refreshToken === 'r-u1');
  // The correct-user step-up (same ceremony) still succeeds.
  const ok = replaceSessionIfLineage(L, session({ sub: 'user-1', refreshToken: 'r-u1-stepped' }));
  check('10: the matching-user step-up still installs within the ceremony',
    !!ok && readSession()?.refreshToken === 'r-u1-stepped' && sameLifecycle(ok, L));
}

/* 11. AUDIT-F9: takeSessionIfUser revokes on IDENTITY (userId) alone, across
 *     ceremonies — the access-revocation granularity. A confirmed profile
 *     withdrawal discovered by an older op can take a NEWER same-user session. -- */
__resetAuthStorageForTests(__createMemoryStoreForTests());
{
  // Ceremony 1 for user-a, then a NEW login (ceremony 2) for the SAME user.
  setAuthoritativeSession(session({ sub: 'user-a', refreshToken: 'r-cer1' }));
  setAuthoritativeSession(session({ sub: 'user-a', refreshToken: 'r-cer2' }));
  const taken = takeSessionIfUser('user-a');
  check('11: takeSessionIfUser takes the CURRENT same-user session across ceremonies',
    taken?.session.refreshToken === 'r-cer2');
  check('11: the store is emptied by the identity-level take', readSession() === null && hasSession() === false);
}
{
  // A DIFFERENT user's session is never touched.
  __resetAuthStorageForTests(__createMemoryStoreForTests());
  setAuthoritativeSession(session({ sub: 'user-b', refreshToken: 'r-b' }));
  const wrong = takeSessionIfUser('user-a');
  check('11: takeSessionIfUser does NOT take a different user’s session', wrong === null && readSession()?.refreshToken === 'r-b');
  // An empty userId is refused.
  check('11: an empty userId takes nothing', takeSessionIfUser('') === null && readSession()?.refreshToken === 'r-b');
}

console.log(`\nOPT-02-C1 STORAGE UNIT — ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
