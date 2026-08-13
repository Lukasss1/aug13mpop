/**
 * Authentication Integration Closure — BEHAVIOURAL two-tab suite (audit item 8).
 *
 * Two ISOLATED authStorage module instances (distinct module URLs) share ONE
 * persistent store object — a faithful model of two browser tabs over one
 * localStorage. These are the scenarios the regex wiring suite cannot see.
 */
import { makeIdentityGuard } from '../src/lib/sessionCleanup';
import { reconcileAction, shouldReconcile } from '../src/lib/authReconcile';
import type { PersistedRevision } from '../src/lib/authStorage';
import { revalidateOwnProfileTyped, revokeSessionIfLineage } from '../src/lib/auth';
import type { AuthSession } from '../src/lib/authState';

const modA = await import('../src/lib/authStorage');
const modB = await import('../src/lib/authStorage?tab=b');

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `  — ${detail}`}`);
  if (ok) passed += 1; else failed += 1;
};

const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
const jwt = (sub: string, mark = 'x'): string => `h.${b64({ sub, mark })}.s`;
const sess = (sub: string, mark = 'x', exp = 9_999_999_999): AuthSession =>
  ({ accessToken: jwt(sub, mark), refreshToken: `r-${sub}-${mark}`, expiresAt: exp });

// One shared "localStorage" for both tabs.
const store = modA.__createMemoryStoreForTests();
modA.__resetAuthStorageForTests(store);
modB.__resetAuthStorageForTests(store);
check('two isolated module instances share one store', modA !== (modB as unknown), 'query-import produced the same instance');

/* S1 — Tab A login appears in Tab B */
modA.setAuthoritativeSession(sess('user-a'));
check('S1: before sync, Tab B mirror is stale (documents the old bug)', modB.currentUserId() !== 'user-a');
const s1 = modB.syncFromPersistedSession();
check('S1: Tab B adopts the persisted login', s1.status === 'adopted' && modB.currentUserId() === 'user-a', s1.status);

/* S2 — account switch: Tab B never keeps or resurrects User A */
const staleBasisB = modB.readSession() as AuthSession;
modA.setAuthoritativeSession(sess('user-b'));
check('S2: pre-sync readSession() still serves the OLD user (the audit repro)',
  (modB.readSession() as AuthSession).accessToken === jwt('user-a'));
const s2 = modB.syncFromPersistedSession();
check('S2: Tab B adopts user-b, never reloads user-a', s2.status === 'adopted' && modB.currentUserId() === 'user-b', `${s2.status}/${modB.currentUserId()}`);
const clobber = modB.commitRefreshedSession(sess('user-a', 'rotated'), staleBasisB);
const persistedAfter = JSON.parse(store.getItem('milkpop_auth_token') as string) as { userId: string };
check('S2: Tab B\'s stale refresh cannot clobber the switched account (writer resync)',
  clobber === false && persistedAfter.userId === 'user-b', `applied=${String(clobber)} persistedUser=${persistedAfter.userId}`);

/* S4 — refresh in Tab A updates Tab B without Tab B refreshing again */
const basisB2 = modB.syncFromPersistedSession().session as AuthSession;
const rotated = sess('user-b', 'rot2');
check('S4: Tab A commits a rotation', modA.commitRefreshedSession(rotated, basisB2) === true);
const s4 = modB.syncFromPersistedSession();
check('S4: Tab B adopts the rotated token (no second refresh needed)',
  (s4.status === 'adopted') && (modB.readSession() as AuthSession).accessToken === rotated.accessToken
  && modB.currentSessionVersion() === modA.currentSessionVersion(), `${s4.status} vB=${modB.currentSessionVersion()} vA=${modA.currentSessionVersion()}`);

/* S5 — equal local revisions must not hide a different-user switch */
const vBefore = modB.currentSessionVersion();
check('S5: Tab B rotates independently', modB.commitRefreshedSession(sess('user-b', 'rot3'), rotated) === true);
modA.setAuthoritativeSession(sess('user-c'));   // A resyncs to B's revision FIRST, then bumps past it
const s5 = modB.syncFromPersistedSession();
check('S5: the switch outranks the collided revision (global ordering)',
  s5.status === 'adopted' && modB.currentUserId() === 'user-c'
  && modA.currentSessionVersion() > vBefore + 1, `${s5.status}/${modB.currentUserId()} vA=${modA.currentSessionVersion()}`);

/* S10 — a delayed User-A response cannot populate User-B's screen */
const guard = makeIdentityGuard(() => modB.currentUserId());
const snap = guard.begin();
modA.setAuthoritativeSession(sess('user-d'));
modB.syncFromPersistedSession();
check('S10: identity guard drops the in-flight snapshot after a switch', guard.isCurrent(snap) === false);

/* S3 — Tab A logout clears Tab B (session + registered private state) */
modA.clearSessionUnconditional();
const s3 = modB.syncFromPersistedSession();
check('S3: Tab B adopts the sign-out (explicit signed-out persisted state)',
  s3.status === 'signed_out' && modB.readSession() === null && modB.currentUserId() === null, s3.status);

/* S6 — temporary profile-service failure NEVER signs the employee out */
const cfg = { getConfig: () => ({ url: 'https://x.supabase.co', anonKey: 'anon' }) };
const live = sess('user-a');
const outcome = async (fetchFn: typeof fetch) => (await revalidateOwnProfileTyped(live, { ...cfg, fetchFn })).status;
check('S6: network failure → temporarily_unavailable (keep session)',
  (await outcome((() => { throw new Error('offline'); }) as unknown as typeof fetch)) === 'temporarily_unavailable');
check('S6: 500 → temporarily_unavailable', (await outcome((async () => new Response('x', { status: 500 })) as typeof fetch)) === 'temporarily_unavailable');
check('S6: 429 → temporarily_unavailable', (await outcome((async () => new Response('x', { status: 429 })) as typeof fetch)) === 'temporarily_unavailable');
check('S6: 401 (expiring token is the refresh path\'s job) → temporary', (await outcome((async () => new Response('x', { status: 401 })) as typeof fetch)) === 'temporarily_unavailable');
check('S6: 403 → unauthorised (confirmed denial)', (await outcome((async () => new Response('x', { status: 403 })) as typeof fetch)) === 'unauthorised');
check('S6: empty result → not_found', (await outcome((async () => new Response('[]', { status: 200 })) as typeof fetch)) === 'not_found');
check('S6: disabled row → disabled', (await outcome((async () => new Response(JSON.stringify([{ id: 'e1', status: 'disabled' }]), { status: 200 })) as typeof fetch)) === 'disabled');
check('S6: healthy row → ok', (await outcome((async () => new Response(JSON.stringify([{ id: 'e1', status: 'active', full_name: 'A' }]), { status: 200 })) as typeof fetch)) === 'ok');

/* ================= Auth Closure Finalisation scenarios ================= */
const modC = await import('../src/lib/authStorage?tab=c');

/* T1 — logout followed by immediate re-login (re-audit C1 repro) */
{
  const st = modA.__createMemoryStoreForTests();
  modA.__resetAuthStorageForTests(st); modB.__resetAuthStorageForTests(st);
  modA.setAuthoritativeSession(sess('t1-user'));
  modB.syncFromPersistedSession();
  const vLogin = modB.currentSessionVersion();
  modA.clearSessionUnconditional();
  const recv = modB.syncFromPersistedSession();           // receiver path: SYNC ONLY
  const revAfter = JSON.parse(st.getItem('milkpop_auth_revision_v1') as string) as { counter: number; writerId: string };
  check('T1: receiver adopts the sign-out WITHOUT writing (versions align with sender)',
    recv.status === 'signed_out'
    && modB.currentSessionVersion() === modA.currentSessionVersion()
    && revAfter.counter === modA.currentSessionVersion(), `recv=${recv.status} vB=${modB.currentSessionVersion()} vA=${modA.currentSessionVersion()} persisted=${revAfter.counter}`);
  modA.setAuthoritativeSession(sess('t1-user', 'again'));
  check('T1: the immediate re-login is STRICTLY newer for the receiver (never "stale")',
    modA.currentSessionVersion() > modB.currentSessionVersion());
  const s = modB.syncFromPersistedSession();
  check('T1: receiver adopts the re-login', s.status === 'adopted' && modB.currentUserId() === 't1-user' && vLogin < modB.currentSessionVersion());
}

/* T2 — a fresh tab opened AFTER sign-out continues the global revision (C2) */
{
  const st = modA.__createMemoryStoreForTests();
  modA.__resetAuthStorageForTests(st); modB.__resetAuthStorageForTests(st);
  modA.setAuthoritativeSession(sess('t2-a'));
  const basis = modA.readSession() as AuthSession;
  modA.commitRefreshedSession(sess('t2-a', 'r'), basis);
  modB.syncFromPersistedSession();
  modA.clearSessionUnconditional();                        // counter now 3, key absent
  modB.syncFromPersistedSession();
  modC.__resetAuthStorageForTests(st);                     // the FRESH tab
  check('T2: a fresh tab inherits the surviving revision (not version 0)',
    modC.currentSessionVersion() === modA.currentSessionVersion(), `fresh=${modC.currentSessionVersion()} global=${modA.currentSessionVersion()}`);
  modC.setAuthoritativeSession(sess('t2-new'));
  const s = modB.syncFromPersistedSession();
  check('T2: older tabs ACCEPT the fresh tab\'s sign-in (never stale)',
    s.status === 'adopted' && modB.currentUserId() === 't2-new'
    && modC.currentSessionVersion() > 3, `${s.status}/${modB.currentUserId()} vC=${modC.currentSessionVersion()}`);
}

/* T3 — equal counters from DIFFERENT writers do not hide a switch */
{
  const st = modA.__createMemoryStoreForTests();
  modB.__resetAuthStorageForTests(st);
  modB.setAuthoritativeSession(sess('t3-mine'));           // counter 1, writer = tab B
  const foreignEnv = { schemaVersion: 3, session: sess('t3-foreign'), authEpoch: 'e-f', sessionVersion: 1, userId: 't3-foreign', updatedAt: 'x' };
  st.setItem('milkpop_auth_token', JSON.stringify(foreignEnv));
  st.setItem('milkpop_auth_revision_v1', JSON.stringify({ counter: 1, writerId: 'writer-elsewhere', updatedAt: 'x' }));
  const s = modB.syncFromPersistedSession();
  check('T3: the equal-counter foreign identity is adopted (persisted truth wins)',
    s.status === 'adopted' && modB.currentUserId() === 't3-foreign', `${s.status}/${modB.currentUserId()}`);
}

/* T6 — transient profile failure during INITIAL load / remote adoption */
{
  const cfg2 = { getConfig: () => ({ url: 'https://x.supabase.co', anonKey: 'anon' }) };
  const offline: typeof fetch = (() => { throw new Error('offline'); }) as unknown as typeof fetch;
  const { loadOwnProfileTyped } = await import('../src/lib/auth');
  const r1 = await loadOwnProfileTyped(sess('t6'), { ...cfg2, fetchFn: offline });
  check('T6: offline during initial load → temporarily_unavailable (session must survive)', r1.status === 'temporarily_unavailable');
  const linkThrowsReadOk: typeof fetch = (async (input: RequestInfo | URL) => {
    // Stage 2.1.2: the profile READ is rpc/get_my_staff_profile — only the
    // LINK rpc is the best-effort call this scenario breaks.
    if (String(input).includes('/rpc/link_staff_profile')) throw new Error('link blip');
    return new Response(JSON.stringify([{ id: 'e1', status: 'active' }]), { status: 200 });
  }) as typeof fetch;
  const r2 = await loadOwnProfileTyped(sess('t6'), { ...cfg2, fetchFn: linkThrowsReadOk });
  check('T6: a failed best-effort link does not mask a healthy profile', r2.status === 'ok');
}

/* ============ Final-architecture scenarios (third re-audit) ============ */

type TabModel = { mod: typeof modA; lastApplied: PersistedRevision | null; localUser: string | null; processed: number };
const makeTab = (mod: typeof modA): TabModel => ({ mod, lastApplied: null, localUser: null, processed: 0 });
/** A faithful model of the hook's receiving pipeline: reconcile once from
 *  persisted truth, derive the action from the STORED result, NEVER post. */
const receive = (tab: TabModel): { posted: number } => {
  const rev = tab.mod.persistedRevision();
  if (!shouldReconcile(rev, tab.lastApplied)) return { posted: 0 };
  const sync = tab.mod.syncFromPersistedSession();
  if (sync.status === 'unavailable') return { posted: 0 };
  tab.lastApplied = rev;
  tab.processed += 1;
  const action = reconcileAction(sync.userId, sync.session !== null, tab.localUser);
  if (action === 'clear_identity') tab.localUser = null;
  if (action === 'adopt_session') tab.localUser = sync.userId;
  return { posted: 0 };
};

/* T7 — one login, THREE open tabs: a finite, tiny message count (no storm) */
{
  const st = modA.__createMemoryStoreForTests();
  modA.__resetAuthStorageForTests(st); modB.__resetAuthStorageForTests(st); modC.__resetAuthStorageForTests(st);
  const tabB = makeTab(modB); const tabC = makeTab(modC);
  let messages = 0;
  modA.setAuthoritativeSession(sess('storm-user')); messages += 1; // the ONLY broadcast (local mutation)
  // Deliver the announcement to both receivers TWICE (duplicate delivery).
  for (const round of [1, 2]) { void round; messages += receive(tabB).posted + receive(tabC).posted; }
  check('T7: three tabs, one login → exactly ONE message ever on the bus', messages === 1, `messages=${messages}`);
  check('T7: each receiver reconciled AT MOST ONCE and adopted the user',
    tabB.processed === 1 && tabC.processed === 1 && tabB.localUser === 'storm-user' && tabC.localUser === 'storm-user',
    `B=${tabB.processed}/${tabB.localUser} C=${tabC.processed}/${tabC.localUser}`);
}

/* T8 — a stale User-A denial can NEVER clear persisted User-B (re-audit C2) */
{
  const st = modA.__createMemoryStoreForTests();
  modA.__resetAuthStorageForTests(st); modB.__resetAuthStorageForTests(st);
  modA.setAuthoritativeSession(sess('user-b'));            // the NEWER user, written before any broadcast
  const cleared = modB.clearSessionIfUser('user-a');       // the stale tab's confirmed denial for user-a
  const envelope = JSON.parse(st.getItem('milkpop_auth_token') as string) as { userId: string };
  check('T8: stale denial is a NO-OP; shared storage still holds user-b',
    cleared === false && envelope.userId === 'user-b', `cleared=${String(cleared)} persisted=${envelope.userId}`);
  check('T8: the RIGHTFUL owner\'s termination still clears',
    ['adopted', 'unchanged'].includes(modB.syncFromPersistedSession().status) && modB.clearSessionIfUser('user-b') === true
    && st.getItem('milkpop_auth_token') === null);
}

/* T9 — a delayed equal-version SIGNED_OUT cannot clear a live persisted user (re-audit H3) */
{
  const st = modA.__createMemoryStoreForTests();
  modA.__resetAuthStorageForTests(st); modB.__resetAuthStorageForTests(st);
  const tabB = makeTab(modB);
  modA.setAuthoritativeSession(sess('user-old')); receive(tabB);
  modA.setAuthoritativeSession(sess('user-c'));            // the live persisted truth
  // The delayed SIGNED_OUT event arrives — its TYPE is ignored; truth decides.
  receive(tabB);
  check('T9: the receiver keeps/adopts live user-c instead of clearing',
    tabB.localUser === 'user-c', `local=${String(tabB.localUser)}`);
  // And once applied, redelivering the same stale announcement changes nothing.
  receive(tabB);
  check('T9: redelivery is a no-op (at-most-once per persisted mutation)', tabB.processed === 2, `processed=${tabB.processed}`);
}

/* ================= C1.2 scenarios: F3 order + access revocation ================= */

/* T-F3 — read → link → re-read */
{
  const cfg3 = { getConfig: () => ({ url: 'https://x.supabase.co', anonKey: 'anon' }) };
  const { loadOwnProfileTyped } = await import('../src/lib/auth');
  const row = JSON.stringify([{ id: 'e1', status: 'active' }]);

  // a) common path: already linked ⇒ resolves on the FIRST read, ZERO rpc calls
  let reads = 0, rpcs = 0;
  // Stage 2.1.2: profile reads travel over rpc/get_my_staff_profile, so
  // "reads" = profile-RPC calls and "rpcs" = link_staff_profile calls.
  const linkedFetch: typeof fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/rpc/link_staff_profile')) { rpcs += 1; return new Response('null', { status: 200 }); }
    reads += 1; return new Response(row, { status: 200 });
  }) as typeof fetch;
  const a = await loadOwnProfileTyped(sess('f3'), { ...cfg3, fetchFn: linkedFetch });
  check('T-F3a: already-linked profile resolves with ONE read and NO link rpc',
    a.status === 'ok' && reads === 1 && rpcs === 0, `${a.status} reads=${reads} rpcs=${rpcs}`);

  // b) first login: empty read → link → re-read succeeds
  reads = 0; rpcs = 0;
  const firstLoginFetch: typeof fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/rpc/link_staff_profile')) { rpcs += 1; return new Response('null', { status: 200 }); }
    reads += 1; return new Response(reads === 1 ? '[]' : row, { status: 200 });
  }) as typeof fetch;
  const b = await loadOwnProfileTyped(sess('f3'), { ...cfg3, fetchFn: firstLoginFetch });
  check('T-F3b: first login is read → link → re-read (exactly 2 reads, 1 rpc)',
    b.status === 'ok' && reads === 2 && rpcs === 1, `${b.status} reads=${reads} rpcs=${rpcs}`);

  // c) link fails and the re-read is still empty ⇒ a typed not_found, never a throw
  reads = 0; rpcs = 0;
  const brokenLinkFetch: typeof fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/rpc/link_staff_profile')) { rpcs += 1; throw new Error('link outage'); }
    reads += 1; return new Response('[]', { status: 200 });
  }) as typeof fetch;
  const c = await loadOwnProfileTyped(sess('f3'), { ...cfg3, fetchFn: brokenLinkFetch });
  check('T-F3c: failed link + empty re-read is a typed not_found',
    c.status === 'not_found' && reads === 2 && rpcs === 1, `${c.status} reads=${reads} rpcs=${rpcs}`);
}

/* T-RSL — revokeSessionIfLineage: userId-granular ACCESS revocation (v8 §1 rule 2) */
{
  // 1) a confirmed withdrawal revokes even a NEWER login of the SAME identity
  const st = modA.__createMemoryStoreForTests();
  modA.__resetAuthStorageForTests(st);              // modA IS the default instance auth.ts uses
  modA.setAuthoritativeSession(sess('rsl-u', 'first'));
  modA.setAuthoritativeSession(sess('rsl-u', 'newer'));   // a NEW ceremony, same user
  const revoked: string[] = [];
  const took = revokeSessionIfLineage('rsl-u', { revoke: (tkn) => { revoked.push(tkn); } });
  check('T-RSL1: takes + revokes the NEWER chain of the same identity',
    took === true && revoked.length === 1 && revoked[0] === jwt('rsl-u', 'newer')
    && st.getItem('milkpop_auth_token') === null, `took=${String(took)} revoked=${revoked.length}`);

  // 2) a stale denial for a DIFFERENT user takes nothing, revokes nothing
  modA.setAuthoritativeSession(sess('rsl-b'));
  const spy: string[] = [];
  const tookWrong = revokeSessionIfLineage('rsl-a', { revoke: (tkn) => { spy.push(tkn); } });
  const env = JSON.parse(st.getItem('milkpop_auth_token') as string) as { userId: string };
  check('T-RSL2: different-user take is a NO-OP (no revoke, session survives)',
    tookWrong === false && spy.length === 0 && env.userId === 'rsl-b', `took=${String(tookWrong)} persisted=${env.userId}`);

  // 3) the take resyncs from persisted truth first (stale tab mirror is safe)
  const st2 = modA.__createMemoryStoreForTests();
  modB.__resetAuthStorageForTests(st2);             // B's mirror anchored on an EMPTY store
  modA.__resetAuthStorageForTests(st2);
  modA.setAuthoritativeSession(sess('rsl-x'));      // truth written by another tab
  const takenByB = modB.takeSessionIfUser('rsl-x');
  check('T-RSL3: a stale-mirror tab still takes the persisted truth (writer resync)',
    takenByB !== null && takenByB.session.accessToken === jwt('rsl-x')
    && st2.getItem('milkpop_auth_token') === null, `taken=${String(takenByB !== null)}`);
}

console.log(`\nAUTH CROSS-TAB BEHAVIOUR — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
