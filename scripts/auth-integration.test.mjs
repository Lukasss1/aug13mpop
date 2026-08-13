/**
 * Authentication Integration Closure — wiring contract.
 *
 * The Stage-1 auth audit found the strongest OPT-02E modules (authChannel,
 * sessionCleanup, the local-scope logout helper) were TESTED but not CONNECTED.
 * The unit suites prove the modules work; this suite proves the live app USES
 * them, and fails if any integration is quietly unwired again.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `  — ${detail}`}`);
  if (ok) passed += 1; else failed += 1;
};

const auth = read('src/lib/auth.ts');
const hook = read('src/hooks/useAuth.ts');
const app = read('src/App.tsx');

/* ---- 1. ONE logout implementation, LOCAL scope (C1.2) --------------------- */
check('signOut clears local state BEFORE the network revoke',
  /clearSessionUnconditional\(\);[\s\S]{0,200}bestEffortRevokeSession\(/.test(auth),
  'clear-first ordering lost');
check('signOut revokes via the tested local-scope helper',
  /bestEffortRevokeSession\(session\.accessToken\)/.test(auth), 'helper not used');
check('no second logout implementation exists outside authRaw',
  !/auth\/v1\/logout/.test(auth) && !/auth\/v1\/logout/.test(hook) && !/auth\/v1\/logout/.test(app),
  'a direct /auth/v1/logout call reappeared outside authRaw.ts');

/* ---- 2. Cross-tab coordinator is LIVE ------------------------------------- */
check('useAuth starts the auth channel', /startAuthChannel\(\{/.test(hook), 'startAuthChannel not called');
check('channel is stopped on unmount', /ctrl\.stop\(\);\s*channelRef\.current = null;/.test(hook), 'no stop() cleanup');
check('EVERY inbound event is only a change-notification (reconcile-from-truth)',
  /onSignedOut: reconcileFromTruth/.test(hook) && /onSessionExpired: reconcileFromTruth/.test(hook)
  && /onSignedIn: reconcileFromTruth/.test(hook) && /onAccountSwitched: reconcileFromTruth/.test(hook)
  && /onSessionRefreshed: reconcileFromTruth/.test(hook)
  && !/clearSessionUnconditional/.test(hook),
  'handlers must funnel into the single reconcile pipeline');
check('receivers NEVER rebroadcast (no post inside the reconcile pipeline)',
  !/reconcileFromTruth = useCallback[\s\S]{0,1200}?channelRef\.current\?\.post/.test(hook),
  'a remote adoption echoed an event (re-audit C1 storm)');
check('the channel context reports the LAST APPLIED revision (no permanent −1)',
  /lastVersion: lastAppliedRef\.current\?\.counter \?\? 0/.test(hook), 'lastApplied context missing');
check('reconcile is at-most-once per persisted mutation',
  /if \(!shouldReconcile\(rev, lastAppliedRef\.current\)\) return;/.test(hook), 'mutation gate missing');
check('storage-visibility trigger pairs with the channel (real-browser race fix)',
  /e\.key === REVISION_STORAGE_KEY \|\| e\.key === TOKEN_STORAGE_KEY\) reconcileFromTruth\(\);/.test(hook)
  && /removeEventListener\('storage', onRevisionVisible\)/.test(hook),
  'BroadcastChannel-vs-localStorage ordering race can silently drop a login');
check('only LOCAL mutations broadcast SIGNED_IN; remote/restore never echo',
  /source === 'local'/.test(hook) && /source: 'remote'/.test(hook) && /source: 'restore'/.test(hook),
  'finalise source gating missing');
check('sign-out persists an ordering tombstone; every persist stamps the revision',
  (read('src/lib/authStorage.ts').match(/persistRevision\(s\);/g) || []).length === 2
  && /REVISION_KEY = 'milkpop_auth_revision_v1'/.test(read('src/lib/authStorage.ts')),
  'revision record missing (re-audit C2)');
check('finalise + revalidate carry live supersession guards (re-audit C3)',
  (hook.match(/identityGen\.current !== gen/g) || []).length >= 5
  && /lastUserIdRef\.current !== anchoredUid/.test(hook),
  'delayed results could commit or terminate a newer identity');
check('initial profile load is TYPED; a transient outage never terminates',
  /loadOwnProfileTyped\(session\)/.test(hook)
  && /temporarily_unavailable'\) \{\s*\/\/ Re-audit H4/.test(hook)
  && !/temporarily_unavailable'\) \{[\s\S]{0,300}terminateRef/.test(hook),
  'H4 regressed: transient initial-load failure terminates');
check('remote adoption clears the OLD identity SYNCHRONOUSLY before hydrating',
  /action === 'adopt_session' && synced\.session\) \{\s*clearLocalIdentity\(\);\s*\/\/[^\n]*\n\s*runSessionCleanup\(\);\s*void finalise\(synced\.session, \{ source: 'remote' \}\);/.test(hook),
  'Finding 6 regressed: old identity may render during adoption');
check('adoption derives the ACTION from stored truth, never the event type (re-audit H3)',
  /reconcileAction\(synced\.userId, synced\.session !== null, lastUserIdRef\.current\)/.test(hook),
  'reconcileAction not driving the pipeline');
check('profile-derived terminations use the C1.2 access-revocation primitive',
  /const revoked = revokeSessionIfLineage\(expectedUserId\);/.test(hook)
  && (hook.match(/terminateIfCurrentUser\(anchoredUid/g) || []).length === 3
  && /terminateIfUserRef\.current\(expectedUid \?\? ''/.test(hook),
  'terminateIfCurrentUser no longer routes through revokeSessionIfLineage');
check('revokeSessionIfLineage: userId-granular take + revoke of the TAKEN chain',
  /export function revokeSessionIfLineage\(expectedUserId: string, deps\?: RevokeSessionDeps\): boolean/.test(read('src/lib/auth.ts'))
  && /const taken = takeSessionIfUser\(expectedUserId\);/.test(read('src/lib/auth.ts'))
  && /\(deps\?\.revoke \?\? bestEffortRevokeSession\)\(taken\.session\.accessToken\);/.test(read('src/lib/auth.ts')),
  'C1.2 primitive missing or reshaped');
check('F3 order: READ first; link + re-read only on a confirmed empty read',
  /const first = await revalidateOwnProfileTyped\(session, deps\);\s*if \(first\.status !== 'not_found'\) return first;/.test(read('src/lib/auth.ts'))
  && !/export async function fetchOwnProfile/.test(read('src/lib/auth.ts')),
  'F3 read→link→re-read order regressed (or legacy null-conflating reader returned)');
check('async identity ops re-check the PERSISTED user after awaiting (re-audit C2)',
  /truthNow\.userId !== expectedUid\) \{ reconcileRef\.current\(\); return null; \}/.test(hook)
  && /truthNow\.userId !== anchoredUid\) \{ reconcileFromTruth\(\); return; \}/.test(hook),
  'persistent-session guard missing');
check('a landed rotation is broadcast to peers',
  /type: 'SESSION_REFRESHED', userId: e\.userId, sessionVersion: currentSessionVersion\(\)/.test(hook)
  && /emitAuthLifecycleEvent\(\{ type: 'session_refreshed'/.test(read('src/lib/authRefresh.ts')),
  'session_refreshed emit/broadcast chain broken');
check('lifecycle events have a LIVE subscriber (audit item 6)',
  /onAuthLifecycleEvent\(\(e\) => \{/.test(hook) && /case 'session_expired':/.test(hook)
  && /case 'revalidate_profile':/.test(hook) && /case 'temporarily_unavailable':/.test(hook)
  && /case 'storage_unavailable':/.test(hook), 'onAuthLifecycleEvent not subscribed / cases missing');
check('every storage writer resyncs from the persisted envelope first (audit C3)',
  (read('src/lib/authStorage.ts').match(/resyncMirrorFromStore\(s\);/g) || []).length === 8,
  'writer resync count changed');
check('the ONE termination path broadcasts SIGNED_OUT to peers',
  /type: 'SIGNED_OUT', reason, sessionVersion: currentSessionVersion\(\)/.test(hook), 'no broadcast in terminateSession');
check('exactly ONE low-level sign-out call exists (single termination path)',
  (hook.match(/await authSignOut\(\)/g) || []).length === 1, `found ${(hook.match(/await authSignOut\(\)/g) || []).length}`);
check('finalise\'s confirmed denials terminate conditionally for the session\'s own user',
  /await terminateIfUserRef\.current\(expectedUid \?\? '', 'no_staff_profile'\)/.test(hook),
  'finalise denial path regressed');
check('local login broadcasts SIGNED_IN with the exact persisted mutation',
  /type: 'SIGNED_IN', userId: uid, sessionVersion: currentSessionVersion\(\), mutation: rev \? \{ writerId: rev\.writerId, mutationId: rev\.mutationId \} : undefined/.test(hook),
  'SIGNED_IN not mutation-stamped');
check('the storage revision carries a mutation id and the conditional-clear primitive exists',
  /mutationId: mintMutationId\(\)/.test(read('src/lib/authStorage.ts'))
  && /export function clearSessionIfUser\(expectedUserId: string\): boolean/.test(read('src/lib/authStorage.ts')),
  'storage primitives missing');

/* ---- 3. ONE authoritative cleanup mechanism ------------------------------- */
check("App registers its private-state reset as 'app-private-state'",
  /registerSessionCleanup\('app-private-state', \(\) => \{\s*resetPrivateState\(\);\s*lastHydratedFor\.current = null;/.test(app),
  'registration missing or shape changed');
/* T13-2 repoint (repointed, not weakened): this matched the trailing COMMENT
   text "// purge old identity", so rewording the comment broke it while the
   mechanism was untouched — a pin on prose, not on behaviour. It now requires
   the boundary to compare the SCOPE signature (id|role|storeId, so a demotion
   or store transfer purges like a different user) AND to purge through the
   registry, which is strictly more than the original asserted. */
check('identity-boundary hydrate purges through the registry, keyed on the scope signature',
  /if \(lastHydratedFor\.current !== employeeScopeKey\) \{\s*runSessionCleanup\(\);/.test(app),
  'hydrate purge no longer routed through runSessionCleanup on a scope change');
check('no ad-hoc resetPrivateState() invocation remains',
  (app.match(/resetPrivateState\(\)/g) || []).length === 1,
  `expected exactly 1 invocation (inside the registration), got ${(app.match(/resetPrivateState\(\)/g) || []).length}`);
check('the termination path purges via the registry',
  /await authSignOut\(\);\s*runSessionCleanup\(\);/.test(hook), 'terminateSession no longer runs registered cleanups');

/* ---- 4. Disabled-user / role-change revalidation (Finding 5) -------------- */
check('profile revalidates on tab focus/visibility',
  /addEventListener\('visibilitychange', onVisible\)/.test(hook) && /addEventListener\('focus', onVisible\)/.test(hook),
  'focus revalidation listeners missing');
check('CONFIRMED disabled/removed/denied profiles terminate CONDITIONALLY',
  /case 'disabled':[\s\S]{0,120}terminateIfCurrentUser\(anchoredUid, 'profile_disabled'\)/.test(hook)
  && /case 'not_found':[\s\S]{0,120}terminateIfCurrentUser\(anchoredUid, 'profile_removed'\)/.test(hook)
  && /case 'unauthorised':[\s\S]{0,120}terminateIfCurrentUser\(anchoredUid, 'profile_unauthorised'\)/.test(hook),
  'typed confirmed outcomes not terminating conditionally');
check('a TRANSIENT failure keeps the session (Finding 4)',
  /case 'temporarily_unavailable':\s*setAuthNotice\(/.test(hook) && !/case 'temporarily_unavailable':[\s\S]{0,120}terminateSession/.test(hook),
  'transient outcome must never sign out');
check('focus revalidation is throttled',
  /lastRevalidatedAt\.current < 60_000/.test(hook), 'throttle missing');

console.log(`\nAUTH INTEGRATION CLOSURE — ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
