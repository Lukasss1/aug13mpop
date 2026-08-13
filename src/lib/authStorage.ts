/**
 * @file authStorage.ts
 * @description The SINGLE authority for reading/writing the persisted Supabase
 * session token. Everything that touches the stored session — sign-in, MFA
 * step-up, the refresh coordinator, sign-out — goes through here so "which
 * write wins" has exactly one answer.
 *
 * OPT-02 obligations implemented here:
 *  - §5  versioned session envelope; obsolete legacy keys cleared; persistence
 *        status is observable (so the UI can warn about tab-only mode).
 *  - 02B "Session storage writes must be ordered and monotonic where practical"
 *        and "refresh-token rotation must not allow one failed concurrent
 *        caller to overwrite a newer session."
 *  - DoD #2 a concurrent failure cannot delete a NEWER valid session.
 *
 * DESIGN
 * ------
 * There are three kinds of write, and they are NOT equivalent:
 *
 *   setAuthoritativeSession(s)   A fresh session from a real credential check
 *                                (password grant / MFA verify). Authoritative:
 *                                it establishes a new identity/version and is
 *                                written unconditionally.
 *
 *   commitRefreshedSession(new,  A rotated session from a refresh. Written ONLY
 *                           basis) if the currently-stored session is still the
 *                                one we refreshed (`basis`). If a newer
 *                                authoritative login replaced it meanwhile, the
 *                                rotated write is dropped — a stale refresh can
 *                                never clobber a newer login.
 *
 *   clearSessionIfCurrent(basis) A confirmed-invalid refresh clears the session
 *                                ONLY if `basis` is still current. If a
 *                                different session is now stored (account
 *                                switch mid-flight), the clear is a no-op.
 *
 *   clearSessionUnconditional()  Explicit sign-out. Always clears.
 *
 * An in-memory mirror is kept so the guards work even when localStorage is
 * unavailable (private mode / storage disabled), in which case the session
 * lives for the tab only and `getPersistenceStatus()` reports it.
 */
import type { AuthSession, AuthSnapshot, SessionLineage, StoredSessionEnvelope } from './authState';

/**
 * OPT-02-C1 — pure lineage equality. Two lineages are the SAME lifecycle iff the
 * user AND the ceremony (authEpoch) match. Null on either side is never "same".
 * This is the single comparison every "is the session still mine?" check uses.
 */
export function sameLifecycle(a: SessionLineage | null, b: SessionLineage | null): boolean {
  return !!a && !!b && a.userId === b.userId && a.authEpoch === b.authEpoch;
}

/** Current storage key for the session envelope. */
const TOKEN_KEY = 'milkpop_auth_token';

/** Legacy keys that earlier builds used; swept on first read so they can't linger. */
const OBSOLETE_KEYS = ['milkpop_session'];
/** Re-audit C2: the ORDERING record survives sign-out. TOKEN_KEY is removed on
 *  clear (no token material persists — unchanged contract), but this separate
 *  key keeps the global revision {counter, writerId} so a fresh tab opened
 *  after a sign-out continues the sequence instead of restarting at 0. */
const REVISION_KEY = 'milkpop_auth_revision_v1';
/** Public name of the revision record key, for `storage`-event listeners: a
 *  peer's `storage` event on THIS key fires exactly when that write becomes
 *  visible in this tab — the reconcile trigger that cannot outrun storage. */
export const REVISION_STORAGE_KEY = REVISION_KEY;
/** Public name of the token-envelope key, for the same visibility listeners. */
export const TOKEN_STORAGE_KEY = TOKEN_KEY;

/** This tab's writer id — the deterministic tie-break for equal counters. */
function makeWriterId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch { /* fall through */ }
  return 'w-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
const WRITER_ID = makeWriterId();

export interface PersistedRevision { counter: number; writerId: string; mutationId: string }

function mintMutationId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch { /* fall through */ }
  return 'm-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function readRevision(store: KeyValueStore): PersistedRevision | null {
  try {
    const raw = store.getItem(REVISION_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { counter?: unknown; writerId?: unknown; mutationId?: unknown };
    if (typeof p.counter !== 'number' || typeof p.writerId !== 'string') return null;
    return { counter: p.counter, writerId: p.writerId, mutationId: typeof p.mutationId === 'string' ? p.mutationId : '' };
  } catch { return null; }
}

function persistRevision(s: StorageState): void {
  try {
    s.store.setItem(REVISION_KEY, JSON.stringify({ counter: s.version, writerId: WRITER_ID, mutationId: mintMutationId(), updatedAt: new Date().toISOString() }));
  } catch { /* best effort — ordering degrades to per-tab, never breaks auth */ }
}

/** Minimal storage surface we depend on — injectable for tests / tab-only mode. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** An in-memory KeyValueStore used when a real one is unavailable or rejects writes. */
function createMemoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

/** Resolve the real localStorage if usable; otherwise null. */
function resolveLocalStorage(): KeyValueStore | null {
  try {
    const ls = (globalThis as any)?.localStorage as KeyValueStore | undefined;
    if (!ls) return null;
    // Probe: some environments expose localStorage but throw on write.
    const probe = '__mp_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

/** Module-scoped storage state. */
interface StorageState {
  store: KeyValueStore;
  /** True when we fell back to memory (session will not survive a reload). */
  persistent: boolean;
  /** In-memory mirror of the current session (source of truth for the guards). */
  current: AuthSession | null;
  /** Monotonic counter; increments on every authoritative/rotated/cleared write. */
  version: number;
  /**
   * OPT-02-C1 — the current ceremony id (spec §1 rule 3). Minted afresh on an
   * authoritative login; PRESERVED across MFA step-up (replaceSessionIfLineage)
   * and refresh rotation; null when signed out. Restored from the v3 envelope so
   * a reload continues the same ceremony.
   */
  authEpoch: string | null;
  /** Whose session this is (auth user id), if known. */
  userId: string | null;
  loaded: boolean;
}

let state: StorageState | null = null;

/**
 * Per-process salt + counter → a value that is unique WITHIN this process and,
 * because of the random salt, will not collide with an epoch minted before a
 * reload. Ceremonies are compared by equality only, so no ordering is implied.
 */
let epochSalt = '';
let epochCounter = 0;
function freshEpochSalt(): string {
  try {
    const c = (globalThis as any)?.crypto;
    if (c?.randomUUID) return (c.randomUUID() as string).slice(0, 8);
  } catch { /* fall through */ }
  return Math.random().toString(36).slice(2, 10);
}
/** Mint a brand-new ceremony id. The ONLY source of a new authEpoch. */
export function mintEpoch(): string {
  if (!epochSalt) epochSalt = freshEpochSalt();
  epochCounter += 1;
  return `e${epochCounter}.${epochSalt}`;
}

/** (Re)initialise from the given store. Exposed for tests via `__resetAuthStorageForTests`. */
function init(store?: KeyValueStore): StorageState {
  const real = store ?? resolveLocalStorage();
  const s: StorageState = {
    store: real ?? createMemoryStore(),
    persistent: !!real,
    current: null,
    version: 0,
    authEpoch: null,
    userId: null,
    loaded: false,
  };
  // Sweep obsolete keys so old forgeable material can never be read again.
  for (const k of OBSOLETE_KEYS) {
    try { s.store.removeItem(k); } catch { /* ignore */ }
  }
  // Load a persisted envelope once. v8 §3: "v3 envelope migration" — a pre-C1.1
  // v2 envelope or a legacy bare session found here is MIGRATED in place: the
  // session is adopted, a fresh authEpoch is minted for it (its ceremony was
  // never recorded, so this restore IS the ceremony record), and the blob is
  // immediately re-persisted as v3 so the old shape never lingers. The contract's
  // "one forced re-login, deliberate" applies to the DOWNGRADE direction only
  // (rolling back to the pre-opt02-c1 tag, whose build cannot read v3) — the
  // upgrade keeps the user signed in. Malformed blobs are removed.
  try {
    const raw = s.store.getItem(TOKEN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const env = normaliseStoredBlob(parsed);
      if (env) {
        s.current = env.session;
        s.version = env.sessionVersion;
        s.authEpoch = env.authEpoch;
        s.userId = env.userId || null;
        // Rewrite older shapes as v3 NOW, so the minted ceremony survives the
        // next reload instead of being re-minted (which would silently change
        // the lineage identity across reloads).
        if (env.migrated) persist(s);
      } else {
        try { s.store.removeItem(TOKEN_KEY); } catch { /* ignore */ }
      }
    }
  } catch {
    // Malformed — treated as no session; clear the bad blob.
    try { s.store.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  }
  // C2: even with no session envelope (post sign-out / fresh tab), continue
  // the GLOBAL revision sequence so this tab's first write outranks peers.
  const rev = readRevision(s.store);
  if (rev && rev.counter > s.version) s.version = rev.counter;
  s.loaded = true;
  return s;
}

function ensure(): StorageState {
  if (!state) state = init();
  return state;
}

/** What the loader hands back: the adopted state + whether it needs re-persisting. */
interface LoadedBlob {
  session: AuthSession;
  authEpoch: string;
  sessionVersion: number;
  userId: string;
  /** True when the source was an older shape now upgraded to v3 (persist it). */
  migrated: boolean;
}

/** True iff `sess` is a structurally valid bare AuthSession. */
function isValidBareSession(sess: any): sess is AuthSession {
  return !!sess && typeof sess.accessToken === 'string' && sess.accessToken.length > 0
    && typeof sess.refreshToken === 'string' && sess.refreshToken.length > 0
    && typeof sess.expiresAt === 'number';
}

/**
 * OPT-02-C1 — the v8 §3 loading rule: trust v3; MIGRATE older shapes.
 *  - schemaVersion 3 with a valid session + non-empty authEpoch → adopted as-is.
 *  - schemaVersion 2 (pre-C1.1) with a valid session → adopted; a fresh authEpoch
 *    is MINTED for it (its ceremony was never recorded — this restore is the
 *    ceremony record) and it is flagged for immediate re-persist as v3.
 *  - a legacy bare session { accessToken, refreshToken, expiresAt } → same, with
 *    sessionVersion starting at 1.
 *  - anything else → null (removed by the caller).
 * The deliberate one-forced-re-login in the contract is the DOWNGRADE direction
 * (pre-opt02-c1 rollback), not this upgrade path.
 */
function normaliseStoredBlob(parsed: any): LoadedBlob | null {
  if (!parsed || typeof parsed !== 'object') return null;
  // v3 — trusted verbatim.
  if (parsed.schemaVersion === 3) {
    if (!isValidBareSession(parsed.session)) return null;
    if (typeof parsed.authEpoch !== 'string' || parsed.authEpoch.length === 0) return null;
    return {
      session: { accessToken: parsed.session.accessToken, refreshToken: parsed.session.refreshToken, expiresAt: parsed.session.expiresAt },
      authEpoch: parsed.authEpoch,
      sessionVersion: typeof parsed.sessionVersion === 'number' ? parsed.sessionVersion : 1,
      userId: typeof parsed.userId === 'string' ? parsed.userId : '',
      migrated: false,
    };
  }
  // v2 (pre-C1.1 envelope) — migrate: keep the session + counter, mint the ceremony.
  if (parsed.schemaVersion === 2) {
    if (!isValidBareSession(parsed.session)) return null;
    const session: AuthSession = { accessToken: parsed.session.accessToken, refreshToken: parsed.session.refreshToken, expiresAt: parsed.session.expiresAt };
    return {
      session,
      authEpoch: mintEpoch(),
      sessionVersion: typeof parsed.sessionVersion === 'number' ? parsed.sessionVersion : 1,
      userId: typeof parsed.userId === 'string' && parsed.userId
        ? parsed.userId
        : (decodeSub(session.accessToken) ?? ''),
      migrated: true,
    };
  }
  // Legacy bare session (pre-envelope) — migrate the same way.
  if (isValidBareSession(parsed)) {
    const session: AuthSession = { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresAt: parsed.expiresAt };
    return {
      session,
      authEpoch: mintEpoch(),
      sessionVersion: 1,
      userId: decodeSub(session.accessToken) ?? '',
      migrated: true,
    };
  }
  return null;
}

/** Best-effort `sub` (auth user id) from a JWT payload — no dependency. */
export function decodeSub(jwt?: string): string | null {
  if (!jwt) return null;
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return payload?.sub ?? null;
  } catch { return null; }
}

/** Persist the current mirror to storage as a versioned envelope. */
function persist(s: StorageState): void {
  if (!s.current) {
    try { s.store.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    persistRevision(s);
    return;
  }
  const envelope: StoredSessionEnvelope = {
    schemaVersion: 3,
    session: s.current,
    authEpoch: s.authEpoch ?? mintEpoch(),
    sessionVersion: s.version,
    userId: s.userId ?? '',
    updatedAt: new Date().toISOString(),
  };
  try {
    s.store.setItem(TOKEN_KEY, JSON.stringify(envelope));
    persistRevision(s);
  } catch {
    // Storage rejected the write (quota / disabled mid-session). Downgrade to
    // memory so the session still works for this tab; the caller can surface
    // SESSION_STORAGE_UNAVAILABLE via getPersistenceStatus().
    s.persistent = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/** The current session, or null. Never triggers a network call. */
/* ------------------------------------------------------------------ */
/*  OPT-02E-B1 — the PERSISTED envelope is the cross-tab authority     */
/* ------------------------------------------------------------------ */

export type PersistedSyncStatus = 'adopted' | 'unchanged' | 'signed_out' | 'stale_ignored' | 'unavailable';
export interface PersistedSyncResult {
  status: PersistedSyncStatus;
  session: AuthSession | null;
  userId: string | null;
  version: number;
}

function adoptEnvelope(s: StorageState, env: LoadedBlob): void {
  s.current = env.session;
  s.version = env.sessionVersion;
  s.authEpoch = env.authEpoch;
  s.userId = env.userId || decodeSub(env.session.accessToken) || null;
}

/**
 * Re-read the SHARED persisted envelope and adopt it into this tab's mirror
 * when it is at least as new. The behavioural audit (C1/C3) proved each tab's
 * in-memory mirror goes stale the moment another tab writes: the persisted
 * envelope — never any tab's memory — is the authoritative session record.
 * An absent/unreadable blob is an EXPLICIT signed-out state (persist() removes
 * the key on clear); the local monotonic counter keeps moving so this tab's
 * later writes still order after the adoption.
 */
/** Shared adoption core — WRITE-FREE (re-audit C1: a receiving tab must never
 *  rewrite a transition another tab already completed). Ordering is the
 *  persisted revision {counter, writerId}: strictly-newer counters adopt;
 *  EQUAL counters from a FOREIGN writer also adopt (the persisted last write
 *  is the shared truth — re-audit residual finding); older are ignored. */
function adoptFromStore(s: StorageState): PersistedSyncStatus {
  let raw: string | null = null;
  try { raw = s.store.getItem(TOKEN_KEY); } catch { return 'unavailable'; }
  const rev = readRevision(s.store);
  let env: LoadedBlob | null = null;
  if (raw !== null) {
    try { env = normaliseStoredBlob(JSON.parse(raw)); } catch { env = null; }
    if (!env) { try { s.store.removeItem(TOKEN_KEY); } catch { /* ignore */ } }
  }
  // REAL-BROWSER finding: cross-process visibility is per-key — the revision
  // record can become visible BEFORE the token envelope it describes. Adopting
  // then would install a stale token and consume the mutation. Report
  // 'unavailable' instead: nothing is consumed, and the envelope's own
  // visibility (storage event on TOKEN_STORAGE_KEY) re-triggers the reconcile.
  if (env && rev && rev.counter > env.sessionVersion) return 'unavailable';
  const persistedCounter = rev ? rev.counter : (env ? env.sessionVersion : 0);
  const foreignEqual = !!rev && rev.counter === s.version && rev.writerId !== WRITER_ID;
  if (persistedCounter < s.version) return 'stale_ignored';
  if (persistedCounter === s.version && !foreignEqual) {
    // Our own latest write (or pre-revision legacy) — nothing newer to adopt.
    if (env === null && s.current !== null) {
      // Legacy edge: absent blob without a revision record. Adopt the sign-out
      // WITHOUT bumping (sync never writes).
      s.current = null; s.authEpoch = null; s.userId = null;
      return 'signed_out';
    }
    return 'unchanged';
  }
  // persistedCounter > s.version, or an equal-counter foreign write: adopt it.
  if (env === null) {
    const had = s.current !== null;
    s.current = null; s.authEpoch = null; s.userId = null; s.version = persistedCounter;
    return had ? 'signed_out' : 'unchanged';
  }
  const identical = !!s.current
    && s.current.refreshToken === env.session.refreshToken
    && s.current.accessToken === env.session.accessToken
    && s.version === env.sessionVersion
    && (s.userId ?? '') === env.userId;
  adoptEnvelope(s, env);
  s.version = Math.max(env.sessionVersion, persistedCounter);
  return identical ? 'unchanged' : 'adopted';
}

export function syncFromPersistedSession(): PersistedSyncResult {
  const s = ensure();
  const out = (status: PersistedSyncStatus): PersistedSyncResult =>
    ({ status, session: s.current, userId: s.userId, version: s.version });
  if (!s.persistent) return out('unavailable');
  return out(adoptFromStore(s));
}

/**
 * Writers call this FIRST so their lineage/basis guards and the monotonic
 * bump run against the authoritative persisted state — never a stale tab
 * mirror (audit C2/C3). The bump itself (s.version + 1) therefore always
 * starts from the GLOBAL counter, which is what keeps revisions ordered
 * across sign-out → fresh tab → new sign-in.
 */
function resyncMirrorFromStore(s: StorageState): void {
  if (!s.persistent) return;
  adoptFromStore(s);
}

/** Fresh read of the persisted revision record — the reconcile gate. */
export function persistedRevision(): PersistedRevision | null {
  const s = ensure();
  if (!s.persistent) return null;
  return readRevision(s.store);
}

/**
 * Re-audit C2 — CONDITIONAL termination primitive. Clears the shared session
 * only if, against the freshly-synchronised persisted truth, it still belongs
 * to `expectedUserId`. A stale User-A denial can therefore never erase the
 * User-B session another tab just wrote (even before that tab's broadcast has
 * arrived). Returns true iff this call performed the clear.
 */
export function clearSessionIfUser(expectedUserId: string): boolean {
  const s = ensure();
  resyncMirrorFromStore(s);
  if (!s.current || (s.userId ?? '') !== expectedUserId) return false;
  s.current = null;
  s.authEpoch = null;
  s.userId = null;
  s.version += 1;
  persist(s);
  return true;
}

export function readSession(): AuthSession | null {
  return ensure().current;
}

/** True when a persisted session exists (does not prove it is still valid). */
export function hasSession(): boolean {
  return ensure().current !== null;
}

/** The monotonic version of the current session (0 when signed out). */
export function currentSessionVersion(): number {
  return ensure().version;
}

/** The auth user id of the current session, if known. */
export function currentUserId(): string | null {
  return ensure().userId;
}

/** Persistence status for the UI (§5 tab-only-mode warning). */
export function getPersistenceStatus(): { persistent: boolean } {
  return { persistent: ensure().persistent };
}

/** Internal: derive the lineage from a StorageState (null when signed out). */
function currentLineageOf(s: StorageState): SessionLineage | null {
  if (!s.current || !s.authEpoch) return null;
  return { userId: s.userId ?? '', authEpoch: s.authEpoch };
}

/** OPT-02-C1 — the lineage of the current session, or null when signed out. */
export function currentLineage(): SessionLineage | null {
  return currentLineageOf(ensure());
}

/**
 * OPT-02-C1 — a single, coherent read of session + lineage. Callers capture this
 * ONCE at entry so every subsequent "still current?" check compares a consistent
 * basis (rather than re-reading the session and lineage at two different times).
 */
export function readAuthSnapshot(): AuthSnapshot {
  const s = ensure();
  return { session: s.current, lineage: currentLineageOf(s) };
}

/**
 * OPT-02-C1 — the current session IFF its lineage still matches `expected`. If a
 * newer login/account-switch replaced it (different ceremony), returns null. Used
 * by the request wrapper (F2) to distinguish a same-lineage survivor from a
 * supersession after an await.
 */
export function getSessionIfLineage(expected: SessionLineage): AuthSession | null {
  const s = ensure();
  return sameLifecycle(currentLineageOf(s), expected) ? s.current : null;
}

/**
 * OPT-02-C1 — atomically REMOVE and return the current session IFF its lineage is
 * still `expected`. This is the primitive behind `revokeSessionIfLineage` (F3):
 * it hands the caller exactly the chain it holds so it can be revoked at the
 * server, and guarantees the same session is not left installed. If the lineage
 * moved on, nothing is taken (null) and the newer session survives untouched.
 *
 * Note: like the storage mirror generally, this is tab-local — it removes the
 * session THIS tab holds; other tabs finalise off their own state.
 */
export function takeSessionIfLineage(expected: SessionLineage): { session: AuthSession; lineage: SessionLineage } | null {
  const s = ensure();
  resyncMirrorFromStore(s);
  const lineage = currentLineageOf(s);
  if (!s.current || !sameLifecycle(lineage, expected)) return null;
  const taken = s.current;
  s.current = null;
  s.authEpoch = null;
  s.userId = null;
  s.version += 1;
  persist(s);
  return { session: taken, lineage: lineage as SessionLineage };
}

/**
 * OPT-02-C1 — atomically REMOVE and return the current session iff it belongs to
 * `expectedUserId`, REGARDLESS of ceremony. This is the ACCESS-REVOCATION take
 * (v8 §1 rule 2, granularity doctrine): "Access revocation: userId alone,
 * intentional." A confirmed profile-level withdrawal (profile disabled / deleted)
 * discovered by an older operation must be able to revoke a NEWER session of the
 * same identity — the identity's access is gone, whichever login ceremony the
 * current session came from. F3's `revokeSessionIfLineage` (C1.2) performs its
 * atomic take through THIS guard, then best-effort revokes the taken chain.
 *
 * Ceremony-scoped operations keep using `takeSessionIfLineage`; a different
 * user's session is never touched by either.
 */
export function takeSessionIfUser(expectedUserId: string): { session: AuthSession; lineage: SessionLineage } | null {
  const s = ensure();
  resyncMirrorFromStore(s);
  const lineage = currentLineageOf(s);
  if (!s.current || !lineage || !expectedUserId || lineage.userId !== expectedUserId) return null;
  const taken = s.current;
  s.current = null;
  s.authEpoch = null;
  s.userId = null;
  s.version += 1;
  persist(s);
  return { session: taken, lineage };
}

/**
 * Write a fresh, authoritative session (a real credential check: password grant
 * or a first MFA verify that STARTS a ceremony). Always applied. MINTS a new
 * `authEpoch` — this is the one and only place a ceremony begins — bumps the
 * monotonic version, and returns the resulting lineage so the caller can gate
 * later installs against exactly this ceremony (spec §1 rule 3).
 */
export function setAuthoritativeSession(session: AuthSession): SessionLineage {
  const s = ensure();
  resyncMirrorFromStore(s);
  s.current = session;
  s.version += 1;
  s.authEpoch = mintEpoch();
  s.userId = decodeSub(session.accessToken) ?? s.userId ?? '';
  persist(s);
  return { userId: s.userId ?? '', authEpoch: s.authEpoch };
}

/**
 * OPT-02-C1 — install `next` over the current session IFF the stored lineage is
 * still `expected`, PRESERVING the ceremony (same `authEpoch`). This is the ONLY
 * way an MFA step-up installs its aal2 session: the aal1 login minted the epoch,
 * the step-up replaces the token within that same ceremony. If a newer login
 * took over meanwhile the lineage will not match and the call is a no-op that
 * returns null — the stepped session is discarded, never installed. Bumps the
 * monotonic version on success.
 */
export function replaceSessionIfLineage(expected: SessionLineage, next: AuthSession): SessionLineage | null {
  const s = ensure();
  resyncMirrorFromStore(s);
  const current = currentLineageOf(s);
  if (!sameLifecycle(current, expected)) return null;
  // Identity-integrity guard (audit F6 / v8 lineage rule): the incoming session
  // must PROVE it belongs to the expected user. A step-up result carrying a
  // different (or undecodable) `sub` is never installed under this ceremony —
  // otherwise a foreign session could be stored under another user's authEpoch.
  const sub = decodeSub(next.accessToken);
  if (!sub || sub !== expected.userId) return null;
  s.current = next;
  s.version += 1;
  // authEpoch is intentionally PRESERVED (same ceremony). userId is the proven sub.
  s.userId = sub;
  persist(s);
  return { userId: sub, authEpoch: s.authEpoch as string };
}

/**
 * Commit a ROTATED session from a refresh — but only if `basis` is still the
 * session we hold. Returns true if applied, false if dropped as stale. This is
 * what stops a losing/late refresh from clobbering a newer login (OPT-02B).
 */
export function commitRefreshedSession(next: AuthSession, basis: AuthSession): boolean {
  const s = ensure();
  resyncMirrorFromStore(s);
  // Still refreshing the same session?
  if (!s.current || s.current.refreshToken !== basis.refreshToken) return false;
  // Monotonic guard: never move backwards in expiry for the same lineage.
  if (next.expiresAt < s.current.expiresAt) return false;
  s.current = next;
  s.version += 1;
  // A refresh rotation PRESERVES the ceremony (spec §1 rule 3): authEpoch is left
  // untouched, so the rotated session keeps the same lineage.
  s.userId = decodeSub(next.accessToken) ?? s.userId;
  persist(s);
  return true;
}

/**
 * Clear the session because a refresh was CONFIRMED invalid — but only if the
 * `basis` we refreshed is still current. If an account switch happened
 * mid-flight, the newer session is preserved (DoD #2 / #8).
 */
export function clearSessionIfCurrent(basis: AuthSession): boolean {
  const s = ensure();
  resyncMirrorFromStore(s);
  if (!s.current || s.current.refreshToken !== basis.refreshToken) return false;
  s.current = null;
  s.authEpoch = null;
  s.userId = null;
  s.version += 1;
  persist(s);
  return true;
}

/** Explicit sign-out — always clears. */
export function clearSessionUnconditional(): void {
  const s = ensure();
  resyncMirrorFromStore(s);
  s.current = null;
  s.authEpoch = null;
  s.userId = null;
  s.version += 1;
  persist(s);
}

/* ------------------------------------------------------------------ */
/*  Test seam (guarded)                                                */
/* ------------------------------------------------------------------ */

/**
 * Reset the storage authority against a fresh (optionally in-memory) store.
 * TEST-ONLY: no production code path calls this. It swaps only the storage
 * backing + mirror; it makes no authorisation decision.
 */
export function __resetAuthStorageForTests(store?: KeyValueStore): void {
  state = init(store ?? createMemoryStore());
}

/** TEST-ONLY: create an isolated in-memory store instance. */
export function __createMemoryStoreForTests(): KeyValueStore {
  return createMemoryStore();
}
