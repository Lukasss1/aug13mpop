/**
 * @file tillPayments.ts — WS7 CLIENT ROUND: the browser till's payment flow.
 *
 * submit_web_order() is GONE from the database (WS7). A sale is now three
 * server-authoritative steps, each idempotent on a client-generated identity:
 *
 *   1. create_order_quote(p_quote)     — price the basket server-side; the
 *      quote is the ONLY price the cashier may quote (20-minute TTL, capped
 *      at a scheduled VAT boundary).
 *   2. begin_quote_payment(p_payment)  — reserve the payment route. Cash is a
 *      custody act: it binds an OPEN till session and requires the enrolled
 *      device's pairing secret. Card/online bind the store's terminal/account.
 *   3. finalise_order_payment(p_payment) — record the money. Cash re-presents
 *      the device secret; card/online carry the operator-observed reference
 *      and approved amount. The server writes the order from the QUOTE
 *      snapshot and replays the exact same facts idempotently.
 *
 * DURABILITY (carried over from orderOutbox, which this module supersedes for
 * new sales): the payment attempt is persisted to localStorage BEFORE any
 * network I/O. A dropped connection, an expired session or a page reload can
 * therefore never lose an in-flight payment — the attempt is replayed with
 * byte-identical facts, and the server answers `duplicate: true` for a replay
 * that already committed. Facts are kept EXACTLY as first sent (strings, not
 * re-derived numbers) so the server-side canonical hash matches on retry.
 *
 * SECURITY INVARIANTS:
 *   • The device pairing secret is NEVER stored inside a payment attempt and
 *     never leaves this browser except inside the RPC calls that need it. It
 *     lives only in the device-pairing store and is re-attached at call time.
 *     (FinaliseFacts has no secret field, so this holds by construction.)
 *   • Server refusals surface as CONTROLLED codes from the allowlist below —
 *     never raw backend text (the codebase's standing rule).
 *   • An ambiguous outcome (network drop / 5xx) is NEVER treated as failure:
 *     the attempt stays queued as 'finalising' until the server confirms its
 *     fate one way or the other.
 */

import { getSupabaseConfig } from './supabase';
import { timedFetch } from './requestTimeout';
import * as lease from './tillLease';

/* TEST SEAM: the static suite (scripts/till-payments.test.ts) runs under tsx,
 * where import.meta.env does not exist, so getSupabaseConfig() can never
 * resolve. The suite injects a fake config here. Production code never calls
 * this, and the security note in supabase.ts still holds — nothing writes
 * configuration anywhere. */
let testConfigOverride: { url: string; anonKey: string } | null = null;
export function _setTestConfig(cfg: { url: string; anonKey: string } | null): void {
  testConfigOverride = cfg;
}
const resolveConfig = () => testConfigOverride ?? getSupabaseConfig();

/* ================================================================== */
/*  Controlled refusal codes                                           */
/* ================================================================== */

/** Server refusals the till can act on. Anything else maps to 'rejected'. */
export type TillRefusal =
  /* pricing / quote lifecycle */
  | 'empty_basket' | 'unknown_menu_item' | 'unknown_extra' | 'invalid_modifiers'
  | 'invalid_quantity' | 'product_tax_unclassified' | 'store_setup_incomplete'
  | 'store_vat_unconfigured' | 'quote_expired' | 'quote_not_open'
  | 'quote_config_stale' | 'quote_id_conflict' | 'idempotency_conflict'
  | 'quote_payment_pending' | 'quote_needs_reconciliation'
  /* reservation */
  | 'payment_method_not_accepted' | 'payment_already_pending'
  | 'invalid_reservation' | 'reservation_released' | 'quote_already_consumed'
  | 'quote_not_reserved' | 'terminal_ambiguous' | 'terminal_not_active'
  | 'online_account_ambiguous' | 'online_account_not_active'
  | 'payment_state_inconsistent'
  /* cash custody */
  | 'till_session_required' | 'till_session_not_open'
  | 'till_session_store_mismatch' | 'till_session_device_mismatch'
  | 'device_not_enrolled' | 'device_credential_invalid' | 'till_device_revoked'
  | 'device_enrolment_denied' | 'invalid_device_label' | 'invalid_opening_float'
  | 'session_has_unresolved_payments' | 'unknown_session'
  /* finalisation */
  | 'insufficient_cash' | 'change_mismatch' | 'payment_reference_required'
  | 'approved_amount_mismatch' | 'payment_method_mismatch'
  | 'payment_binding_mismatch' | 'operator_scope_denied'
  | 'recovery_window_elapsed' | 'payment_time_in_future'
  | 'payment_time_implausible'
  /* manager recovery: resolution + card evidence matching */
  | 'reconciliation_denied' | 'reconciliation_not_required' | 'reconciliation_immutable'
  | 'reconciliation_evidence_required' | 'invalid_reconciliation_action'
  | 'reason_required' | 'resolution_id_required' | 'unknown_quote'
  | 'already_reconciled' | 'attempt_already_resolved' | 'attempt_not_consumed'
  | 'cash_not_provider_reconciled' | 'settlement_amount_mismatch'
  | 'settlement_evidence_required' | 'evidence_type_required'
  | 'invalid_evidence_type' | 'external_reference_required'
  | 'currency_required' | 'currency_not_supported' | 'idempotency_key_required'
  /* generic */
  | 'not_staff' | 'store_scope_denied' | 'rejected';

const KNOWN_TILL_REFUSALS: readonly Exclude<TillRefusal, 'rejected'>[] = [
  'empty_basket', 'unknown_menu_item', 'unknown_extra', 'invalid_modifiers',
  'invalid_quantity', 'product_tax_unclassified', 'store_setup_incomplete',
  'store_vat_unconfigured', 'quote_expired', 'quote_not_open',
  'quote_config_stale', 'quote_id_conflict', 'idempotency_conflict',
  'quote_payment_pending', 'quote_needs_reconciliation',
  'payment_method_not_accepted', 'payment_already_pending',
  'invalid_reservation', 'reservation_released', 'quote_already_consumed',
  'quote_not_reserved', 'terminal_ambiguous', 'terminal_not_active',
  'online_account_ambiguous', 'online_account_not_active',
  'payment_state_inconsistent',
  'till_session_required', 'till_session_not_open',
  'till_session_store_mismatch', 'till_session_device_mismatch',
  'device_not_enrolled', 'device_credential_invalid', 'till_device_revoked',
  'device_enrolment_denied', 'invalid_device_label', 'invalid_opening_float',
  'session_has_unresolved_payments', 'unknown_session',
  'insufficient_cash', 'change_mismatch', 'payment_reference_required',
  'approved_amount_mismatch', 'payment_method_mismatch',
  'payment_binding_mismatch', 'operator_scope_denied',
  'recovery_window_elapsed', 'payment_time_in_future',
  'payment_time_implausible',
  'reconciliation_denied', 'reconciliation_not_required', 'reconciliation_immutable',
  'reconciliation_evidence_required', 'invalid_reconciliation_action',
  'reason_required', 'resolution_id_required', 'unknown_quote',
  'already_reconciled', 'attempt_already_resolved', 'attempt_not_consumed',
  'cash_not_provider_reconciled', 'settlement_amount_mismatch',
  'settlement_evidence_required', 'evidence_type_required',
  'invalid_evidence_type', 'external_reference_required',
  'currency_required', 'currency_not_supported', 'idempotency_key_required',
  'not_staff', 'store_scope_denied',
];

/** Longest-match first, so 'quote_expired' never half-matches inside text. */
const REFUSALS_BY_LENGTH = [...KNOWN_TILL_REFUSALS].sort((a, b) => b.length - a.length);

function mapRefusal(message: string): TillRefusal {
  const named = REFUSALS_BY_LENGTH.find((k) => message.includes(k));
  return named ?? 'rejected';
}

/* ================================================================== */
/*  RPC transport — one wrapper per function, bare literal paths so    */
/*  scripts/rpc-parity.test.mjs sees every reference statically.       */
/* ================================================================== */

export type RpcOutcome<T> =
  | { status: 'ok'; data: T }
  | { status: 'not_configured' }
  | { status: 'unauthenticated' }
  /** 4xx — the server refused; replaying the SAME request will never succeed
   *  (idempotent replays of an already-committed request come back 2xx, not
   *  here). Safe to treat as "did not happen". */
  | { status: 'refused'; reason: TillRefusal; message: string }
  /** Network failure or 5xx — the outcome is UNKNOWN. The request may have
   *  committed. Only ever resolved by replaying the same idempotent facts. */
  | { status: 'unconfirmed' };

async function post<T>(
  rpcPath: string,
  body: Record<string, unknown>,
  accessToken: string,
): Promise<RpcOutcome<T>> {
  const cfg = resolveConfig();
  if (!cfg) return { status: 'not_configured' };
  if (!accessToken) return { status: 'unauthenticated' };
  const base = cfg.url.replace(/\/$/, '');
  try {
    const res = await timedFetch.pos(`${base}${rpcPath}`, {
      method: 'POST',
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      try {
        return { status: 'ok', data: (await res.json()) as T };
      } catch {
        // 2xx with an unreadable body: the write stands, but we cannot show
        // the row. Callers treat this as unconfirmed and replay — the server
        // will answer with the committed row and duplicate:true.
        return { status: 'unconfirmed' };
      }
    }
    if (res.status === 401 || res.status === 403) {
      // PostgREST uses 401/403 for BOTH auth failures and permission-style
      // refusals raised with errcode 42501. Only a missing/expired session is
      // an auth problem; a named refusal is a refusal.
      let msg = '';
      try { msg = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* not json */ }
      const named = REFUSALS_BY_LENGTH.find((k) => msg.includes(k));
      if (named) return { status: 'refused', reason: named, message: msg };
      return { status: 'unauthenticated' };
    }
    if (res.status >= 500) return { status: 'unconfirmed' };
    let msg = `http_${res.status}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j?.message) msg = j.message;
    } catch { /* body not json */ }
    return { status: 'refused', reason: mapRefusal(msg), message: msg };
  } catch {
    return { status: 'unconfirmed' };
  }
}

/** Retry ONLY unconfirmed outcomes — the idempotent identities make a replay
 *  of the same facts safe; a refusal will refuse again, so it never retries. */
async function withRetry<T>(
  call: () => Promise<RpcOutcome<T>>,
  tries = 3,
): Promise<RpcOutcome<T>> {
  let last: RpcOutcome<T> = { status: 'unconfirmed' };
  for (let i = 0; i < tries; i += 1) {
    last = await call();
    if (last.status !== 'unconfirmed') return last;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1) ** 2));
  }
  return last;
}

/* ---- server row shapes (snake_cased, as PostgREST returns them) ---- */

export interface QuoteRow extends Record<string, unknown> {
  id: string;
  status: string;
  total: number | string;
  expires_at: string;
  allowed_payment_methods?: unknown;
}
interface QuoteEnvelope { quote: QuoteRow; duplicate: boolean }
interface ReserveEnvelope { state: string; reservationId?: string }
export interface OrderRow extends Record<string, unknown> { id: string }
interface FinaliseEnvelope { order: OrderRow; duplicate: boolean; paymentStatus?: string }
interface ReleaseEnvelope { state: string }
export interface SessionRow extends Record<string, unknown> { id: string; status: string }
interface SessionEnvelope { session: SessionRow; duplicate?: boolean }
/** The REAL return of enrol_till_device() (ws7b): a FLAT object — deviceId at
 *  the top level, no nested `device` row. Pinned by the contract test against
 *  the migration source. */
interface EnrolEnvelope { deviceId: string; storeId: string; label: string; pairingSecret: string }

/* ---- the eight till RPCs ---- */

function rpcCreateOrderQuote(p: Record<string, unknown>, token: string) {
  return post<QuoteEnvelope>('/rest/v1/rpc/create_order_quote', { p_quote: p }, token);
}
function rpcCancelOrderQuote(p: Record<string, unknown>, token: string) {
  return post<QuoteEnvelope>('/rest/v1/rpc/cancel_order_quote', { p_quote: p }, token);
}
function rpcBeginQuotePayment(p: Record<string, unknown>, token: string) {
  return post<ReserveEnvelope>('/rest/v1/rpc/begin_quote_payment', { p_payment: p }, token);
}
function rpcFinaliseOrderPayment(p: Record<string, unknown>, token: string) {
  return post<FinaliseEnvelope>('/rest/v1/rpc/finalise_order_payment', { p_payment: p }, token);
}
function rpcReleaseQuotePayment(p: Record<string, unknown>, token: string) {
  return post<ReleaseEnvelope>('/rest/v1/rpc/release_quote_payment', { p_release: p }, token);
}
function rpcOpenTillSession(p: Record<string, unknown>, token: string) {
  return post<SessionEnvelope>('/rest/v1/rpc/open_till_session', { p_session: p }, token);
}
function rpcCloseTillSession(p: Record<string, unknown>, token: string) {
  return post<SessionEnvelope>('/rest/v1/rpc/close_till_session', { p_session: p }, token);
}
function rpcEnrolTillDevice(p: Record<string, unknown>, token: string) {
  return post<EnrolEnvelope>('/rest/v1/rpc/enrol_till_device', { p_device: p }, token);
}
function rpcResolvePaymentReconciliation(p: Record<string, unknown>, token: string) {
  return post<Record<string, unknown>>('/rest/v1/rpc/resolve_payment_reconciliation', { p_resolution: p }, token);
}
function rpcReconcileCardPayment(p: Record<string, unknown>, token: string) {
  return post<Record<string, unknown>>('/rest/v1/rpc/reconcile_card_payment', { p_settlement: p }, token);
}

/* ================================================================== */
/*  Client-generated identities                                        */
/* ================================================================== */

function randomHex(bytes: number): string {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, bytes * 2);
  } catch {
    let s = '';
    for (let i = 0; i < bytes * 2; i += 1) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }
}
export const newQuoteId = (): string => `q_${randomHex(12)}`;
export const newReservationId = (): string => `res_${randomHex(12)}`;
export const newResolutionId = (): string => `resol_${randomHex(12)}`;
export const newIdempotencyKey = (): string => `idem_${randomHex(12)}`;

/** Format a number as a byte-stable money string ('6.00'). All amounts cross
 *  the wire as strings so a retried request is byte-identical to the first. */
export const poundsString = (n: number): string => n.toFixed(2);

/* ================================================================== */
/*  Durable stores (all localStorage; all survive reloads)             */
/* ================================================================== */

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** R4.1 STORAGE GATE. The R3 database can only keep its replay guarantees if
 *  the browser has DURABLY recorded the operation identity BEFORE any network
 *  I/O — so a persist is only a persist once it has been read back and
 *  byte-compared. `false` means this browser cannot currently make that
 *  promise (private mode, quota, corruption, serialization), and every
 *  money-bearing caller treats that as FAIL CLOSED: zero RPC calls. */
function persistVerified(key: string, value: unknown): boolean {
  try {
    const raw = JSON.stringify(value);
    localStorage.setItem(key, raw);
    return localStorage.getItem(key) === raw;
  } catch {
    return false;
  }
}
/** Verified deletion — true only when the key is provably gone. */
function removeVerified(key: string): boolean {
  try { localStorage.removeItem(key); return localStorage.getItem(key) === null; } catch { return false; }
}
function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
function removeKey(key: string): void {
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}

/* ---- single-slot request records: the durable pre-image of the request a
 *  money-bearing RPC is ABOUT to send. Written (verified) before the send,
 *  cleared once the call resolves; an ambiguous custody outcome keeps the
 *  slot so the UI can warn before any second attempt. ---- */
const QUOTE_REQ_KEY = 'milkpop_quote_request_v1';
const CUSTODY_REQ_KEY = 'milkpop_custody_request_v1';
const RECOVERY_REQ_KEY = 'milkpop_recovery_request_v1';

export interface CustodyMarker {
  kind: 'enrol' | 'open_drawer' | 'close_drawer';
  facts: Record<string, unknown>;   // NEVER contains the device secret
  at: string;
  outcome?: 'unknown' | 'unsaved' | undefined;
}
export const getCustodyMarker = (): CustodyMarker | null => readJson<CustodyMarker>(CUSTODY_REQ_KEY);
/** Verified deletion — false means the review lock may still be present. */
export const clearCustodyMarker = (): boolean => removeVerified(CUSTODY_REQ_KEY);

export interface RecoveryMarker {
  kind: 'resolve' | 'reconcile';
  payload: Record<string, unknown>;
  at: string;
}
export const getRecoveryMarker = (): RecoveryMarker | null => readJson<RecoveryMarker>(RECOVERY_REQ_KEY);
/** Verified deletion — false means the held request may still be present. */
export const clearRecoveryMarker = (): boolean => removeVerified(RECOVERY_REQ_KEY);

/* ---- device pairing (one enrolled device per browser) ---- */

const DEVICE_KEY = 'milkpop_till_device_v1';

export interface PairedDevice {
  deviceId: string;
  label: string;
  /** The pairing secret issued ONCE by enrol_till_device(). Held only here. */
  secret: string;
  pairedAt: string;
}

export const getPairedDevice = (): PairedDevice | null => {
  const d = readJson<PairedDevice>(DEVICE_KEY);
  return d && typeof d.deviceId === 'string' && typeof d.secret === 'string' ? d : null;
};
export const storePairedDevice = (d: PairedDevice): void => writeJson(DEVICE_KEY, d);
export type ForgetResult =
  | { status: 'forgotten' }
  | { status: 'blocked'; reason: 'drawer_open' | 'cash_attempt' | 'store_corrupt' }
  | { status: 'not_removed' };

/** Audit #7: forgetting the pairing secret is UNSAFE while custody is live —
 *  it strips the ordinary path to finalise cash or close the drawer, forcing
 *  a manager override for no reason. Blocked while a drawer session or any
 *  cash attempt exists (and while the store is unreadable, since a cash
 *  attempt could be hiding inside it). Deletion is VERIFIED — 'not_removed'
 *  means the secret may still be present. */
export function forgetPairedDevice(): ForgetResult {
  if (getLocalTillSession()) return { status: 'blocked', reason: 'drawer_open' };
  const cur = readAttemptsStrict();
  if (cur.status === 'corrupt') return { status: 'blocked', reason: 'store_corrupt' };
  if (cur.status === 'valid' && cur.value.some((a) => a.method === 'cash')) {
    return { status: 'blocked', reason: 'cash_attempt' };
  }
  return removeVerified(DEVICE_KEY) ? { status: 'forgotten' } : { status: 'not_removed' };
}

/* ---- local till session (the open drawer on this device) ---- */

const SESSION_KEY = 'milkpop_till_session_v1';

export interface LocalTillSession {
  sessionId: string;
  deviceId: string;
  openedAt: string;
}

export const getLocalTillSession = (): LocalTillSession | null => {
  const s = readJson<LocalTillSession>(SESSION_KEY);
  return s && typeof s.sessionId === 'string' ? s : null;
};
/** Verified — false means the local drawer record is NOT safely stored. */
export const storeLocalTillSession = (s: LocalTillSession): boolean => persistVerified(SESSION_KEY, s);
/** Verified deletion — false means the record may still be present locally. */
export const clearLocalTillSession = (): boolean => removeVerified(SESSION_KEY);

/* ---- the payment-attempt store (the durable heart of the flow) ---- */

const ATTEMPTS_KEY = 'milkpop_payment_attempts_v1';

export type TillMethod = 'cash' | 'card' | 'online';

/** The EXACT finalisation facts, persisted BEFORE the finalise call and kept
 *  byte-stable so every retry hashes identically server-side. By construction
 *  this type has no field for the device secret. */
export interface FinaliseFacts {
  quoteId: string;
  reservationId: string;
  method: TillMethod;
  cashReceived?: string | undefined;
  tillSessionId?: string | undefined;
  deviceId?: string | undefined;
  providerReference?: string | undefined;
  approvedAmount?: string | undefined;
  customerName?: string | undefined;
}

export interface StoredAttempt {
  quoteId: string;
  reservationId: string;
  method: TillMethod;
  /** 'reserving': the begin request was (or may have been) sent but the
   *  server has NOT positively confirmed it — payment must not be taken;
   *  the same reservationId is replayed until the server answers.
   *  'reserved': the server confirmed the route — money may be taken.
   *  'finalising': the finalise request was (or may have been) sent — the
   *  attempt may have committed; only a replay of `facts` resolves it. */
  stage: 'reserving' | 'reserved' | 'finalising';
  facts?: FinaliseFacts | undefined;
  /** Display context for the resume banner. */
  quoteTotal: string;
  quoteExpiresAt: string;
  tillSessionId?: string | undefined;
  deviceId?: string | undefined;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  lastError?: string | undefined;
}

/* R4.2 CORRUPTION DISCIPLINE. The store must distinguish "no payments" from
 * "the data is unreadable". Corrupt JSON, a wrong top-level type, ONE
 * malformed entry, or an unsupported record shape all mean the SAME thing: a
 * money-bearing record may be hidden inside data we cannot read. The store
 * then FAILS CLOSED — every payment RPC is blocked and NOTHING overwrites the
 * key, so the evidence survives for a human. Silently filtering bad entries
 * (the R4.1 behaviour) turned corruption into an invisible []. */
type AttemptsRead =
  | { status: 'missing' }
  | { status: 'valid'; value: StoredAttempt[] }
  | { status: 'corrupt' };

function isValidAttempt(x: unknown): x is StoredAttempt {
  if (!x || typeof x !== 'object') return false;
  const a = x as Record<string, unknown>;
  return typeof a.quoteId === 'string' && typeof a.reservationId === 'string'
    && (a.stage === 'reserving' || a.stage === 'reserved' || a.stage === 'finalising')
    && (a.method === 'cash' || a.method === 'card' || a.method === 'online')
    && typeof a.quoteTotal === 'string' && typeof a.quoteExpiresAt === 'string'
    && typeof a.createdAt === 'string' && typeof a.updatedAt === 'string'
    && typeof a.attempts === 'number';
}

function readAttemptsStrict(): AttemptsRead {
  let raw: string | null;
  try { raw = localStorage.getItem(ATTEMPTS_KEY); } catch { return { status: 'corrupt' }; }
  if (raw === null) return { status: 'missing' };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { status: 'corrupt' }; }
  if (!Array.isArray(parsed)) return { status: 'corrupt' };
  if (!parsed.every(isValidAttempt)) return { status: 'corrupt' };
  return { status: 'valid', value: parsed as StoredAttempt[] };
}

/** UI-facing health of the durable payment store. */
export function attemptsStoreHealth(): 'ok' | 'corrupt' {
  return readAttemptsStrict().status === 'corrupt' ? 'corrupt' : 'ok';
}

function validAttempts(): StoredAttempt[] {
  const r = readAttemptsStrict();
  return r.status === 'valid' ? r.value : [];
}
function writeAttempts(list: StoredAttempt[]): boolean {
  const ok = persistVerified(ATTEMPTS_KEY, list);
  notifyAttempts();
  return ok;
}

type AttemptListener = (pending: number) => void;
const attemptListeners = new Set<AttemptListener>();
function notifyAttempts(): void {
  const n = validAttempts().length;
  attemptListeners.forEach((l) => { try { l(n); } catch { /* never break the store */ } });
}
/** Subscribe to pending-attempt count changes (returns an unsubscribe fn). */
export function subscribeAttempts(listener: AttemptListener): () => void {
  attemptListeners.add(listener);
  return () => { attemptListeners.delete(listener); };
}

/* R4.2: cross-tab display freshness — a storage event from the primary
 * writer refreshes this (read-only) tab's badge and banners. No-op outside
 * a browser. */
if (typeof window !== 'undefined') {
  try {
    window.addEventListener('storage', (e) => {
      if (e.key === ATTEMPTS_KEY) notifyAttempts();
    });
  } catch { /* environments without storage events */ }
}

export const pendingAttempts = (): StoredAttempt[] => validAttempts();

type WriteOutcome = 'ok' | 'storage' | 'corrupt';

/** Verified upsert. 'corrupt' = the existing data is unreadable and MUST NOT
 *  be overwritten; 'storage' = this browser cannot durably persist. Either
 *  way the caller must not proceed to the network. */
function upsertAttempt(a: StoredAttempt): WriteOutcome {
  const cur = readAttemptsStrict();
  if (cur.status === 'corrupt') return 'corrupt';
  const rest = (cur.status === 'valid' ? cur.value : []).filter((x) => x.quoteId !== a.quoteId);
  return writeAttempts([...rest, { ...a, updatedAt: new Date().toISOString() }]) ? 'ok' : 'storage';
}
function removeAttempt(quoteId: string): void {
  const cur = readAttemptsStrict();
  if (cur.status !== 'valid') return;   // corrupt: NEVER overwrite the evidence
  writeAttempts(cur.value.filter((x) => x.quoteId !== quoteId));
}
function markAttemptError(quoteId: string, error: string): void {
  const cur = readAttemptsStrict();
  if (cur.status !== 'valid') return;
  const hit = cur.value.find((x) => x.quoteId === quoteId);
  if (hit) {
    hit.attempts += 1;
    hit.lastError = error;
    hit.updatedAt = new Date().toISOString();
    writeAttempts(cur.value);
  }
}

/* ================================================================== */
/*  The flow                                                           */
/* ================================================================== */

export interface FlowDeps {
  getAccessToken: () => Promise<string | null>;
}

async function token(deps: FlowDeps): Promise<string | null> {
  try { return await deps.getAccessToken(); } catch { return null; }
}

export interface QuoteItemInput {
  menuItemId: string;
  size?: string;
  quantity: number;
  notes?: string | null;
  modifiers?: { menuItemId: string }[];
}

export interface QuoteInput {
  items: QuoteItemInput[];
  dealIds?: string[];
  channel?: string;
}

export type PriceResult =
  | { status: 'priced'; quote: QuoteRow }
  | { status: 'refused'; reason: TillRefusal; message: string }
  | { status: 'unavailable'; reason: 'offline' | 'auth' | 'not_configured' | 'storage' | 'corrupt' | 'lease' };

/** Step 1 — price the basket. A fresh quote id per call; the SERVER total is
 *  the only price the cashier may quote. Re-pricing after a cart edit should
 *  go through repriceQuote() so the superseded quote is tidied up. */
export async function priceQuote(deps: FlowDeps, input: QuoteInput): Promise<PriceResult> {
  if (!lease.moneyAllowed()) return { status: 'unavailable', reason: 'lease' };
  if (attemptsStoreHealth() === 'corrupt') return { status: 'unavailable', reason: 'corrupt' };
  const t = await token(deps);
  if (!t) return { status: 'unavailable', reason: 'auth' };
  // R4.1/R4.2: the quote identity and payload are constructed exactly ONCE,
  // so every AUTOMATIC retry inside this call is byte-identical. The honest
  // scope of that guarantee (audit #8): it covers retries WITHIN one call. A
  // later manual Price press is a NEW pricing action with a new id — the
  // superseded OPEN quote moves no money and is expired by the server sweep.
  const payload = {
    id: newQuoteId(),
    channel: input.channel ?? 'walk_in',
    items: input.items,
    dealIds: input.dealIds ?? [],
  };
  if (!persistVerified(QUOTE_REQ_KEY, payload)) {
    return { status: 'unavailable', reason: 'storage' };
  }
  const res = await withRetry(() => rpcCreateOrderQuote(payload, t));
  removeKey(QUOTE_REQ_KEY);
  if (res.status === 'ok') return { status: 'priced', quote: res.data.quote };
  if (res.status === 'refused') return { status: 'refused', reason: res.reason, message: res.message };
  if (res.status === 'unauthenticated') return { status: 'unavailable', reason: 'auth' };
  if (res.status === 'not_configured') return { status: 'unavailable', reason: 'not_configured' };
  return { status: 'unavailable', reason: 'offline' };
}

/** Re-price after a cart edit: best-effort cancel of the superseded quote
 *  (the server sweep would expire it anyway), then a fresh quote. */
export async function repriceQuote(
  deps: FlowDeps,
  supersededQuoteId: string | null,
  input: QuoteInput,
): Promise<PriceResult> {
  if (supersededQuoteId) {
    const t = await token(deps);
    if (t) void rpcCancelOrderQuote({ id: supersededQuoteId }, t);
  }
  return priceQuote(deps, input);
}

/** Fire-and-forget cancel of a superseded OPEN quote (the server sweep would
 *  expire it anyway — this just keeps the ledger tidy). */
export function cancelQuoteBestEffort(quoteId: string, accessToken: string): void {
  void rpcCancelOrderQuote({ id: quoteId }, accessToken);
}

export interface CashCustody {
  sessionId: string;
  deviceId: string;
  /** Pulled from the device store at call time — never persisted with facts. */
  secret: string;
}

export type ReserveResult =
  | { status: 'reserved'; attempt: StoredAttempt }
  /** The reservation request went out but the server never answered — the
   *  attempt is stored at stage 'reserving'; payment MUST NOT be taken until
   *  resumeReserve() gets a positive answer. */
  | { status: 'unconfirmed'; attempt: StoredAttempt }
  /** The SERVER answered positively, but the durable promotion to 'reserved'
   *  could not be verified — payment stays locked; a resume replays and
   *  re-attempts the promotion. */
  | { status: 'confirmed_unsaved'; attempt: StoredAttempt }
  | { status: 'refused'; reason: TillRefusal; message: string }
  | { status: 'unavailable'; reason: 'offline' | 'auth' | 'not_configured' | 'storage' | 'corrupt' | 'lease' };

/** ONE deterministic construction of the begin payload, used by first send
 *  and every resume, so a replay is byte-identical (the secret comes from the
 *  device store at call time; it never rides on the stored attempt). */
function buildBeginPayload(a: Pick<StoredAttempt, 'quoteId' | 'reservationId' | 'method' | 'deviceId' | 'tillSessionId'>, secret?: string): Record<string, unknown> {
  const p: Record<string, unknown> = { quoteId: a.quoteId, reservationId: a.reservationId, method: a.method };
  if (a.method === 'cash') {
    p.deviceId = a.deviceId;
    p.deviceSecret = secret;
    p.cashSessionId = a.tillSessionId;
  }
  return p;
}

/** Step 2 — reserve the payment route. The attempt is persisted BEFORE the
 *  network call; an ambiguous outcome keeps it stored so the same reservation
 *  id can be replayed (begin is idempotent on the reservation identity). */
export async function reservePayment(
  deps: FlowDeps,
  quote: QuoteRow,
  method: TillMethod,
  custody?: CashCustody,
): Promise<ReserveResult> {
  if (!lease.moneyAllowed()) return { status: 'unavailable', reason: 'lease' };
  if (attemptsStoreHealth() === 'corrupt') return { status: 'unavailable', reason: 'corrupt' };
  if (method === 'cash' && !custody) {
    return { status: 'refused', reason: 'till_session_required', message: 'till_session_required' };
  }
  const t = await token(deps);
  if (!t) return { status: 'unavailable', reason: 'auth' };

  const attempt: StoredAttempt = {
    quoteId: quote.id,
    reservationId: newReservationId(),
    method,
    stage: 'reserving',
    quoteTotal: typeof quote.total === 'number' ? poundsString(quote.total) : String(quote.total),
    quoteExpiresAt: quote.expires_at,
    tillSessionId: custody?.sessionId,
    deviceId: custody?.deviceId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: 0,
  };
  // R4.1 STORAGE GATE: the identity must be VERIFIED on disk before any
  // network I/O. If this browser cannot store it, no RPC is made at all.
  const w0 = upsertAttempt(attempt);
  if (w0 !== 'ok') {
    return { status: 'unavailable', reason: w0 };
  }

  const payload = buildBeginPayload(attempt, custody?.secret);   // built ONCE
  const res = await withRetry(() => rpcBeginQuotePayment(payload, t));
  if (res.status === 'ok') {
    const reserved: StoredAttempt = { ...attempt, stage: 'reserved' };
    // R4.2 (audit #5): the RESERVED transition must be DURABLY VERIFIED
    // before this function reports success — otherwise the UI would expose
    // payment controls while the store still says 'reserving'.
    if (upsertAttempt(reserved) !== 'ok') {
      markAttemptError(attempt.quoteId, 'promotion_unsaved');
      return { status: 'confirmed_unsaved', attempt };
    }
    return { status: 'reserved', attempt: reserved };
  }
  if (res.status === 'refused') {
    // A 4xx means the reservation does NOT exist server-side — drop it.
    removeAttempt(attempt.quoteId);
    return { status: 'refused', reason: res.reason, message: res.message };
  }
  if (res.status === 'unauthenticated') {
    markAttemptError(attempt.quoteId, 'auth');
    return { status: 'unavailable', reason: 'auth' };
  }
  if (res.status === 'not_configured') {
    removeAttempt(attempt.quoteId);
    return { status: 'unavailable', reason: 'not_configured' };
  }
  // Ambiguous: the reservation MAY exist. The attempt stays at 'reserving' —
  // payment controls stay hidden until resumeReserve() is answered.
  markAttemptError(attempt.quoteId, 'offline');
  return { status: 'unconfirmed', attempt: { ...attempt, attempts: attempt.attempts + 1, lastError: 'offline' } };
}

/** Replay an ambiguous reservation with its EXACT stored identity. The server
 *  answers idempotently: if the original landed, `duplicate: true` confirms
 *  it; if it never arrived, the same reservationId is created fresh. Either
 *  way a positive answer promotes the attempt to 'reserved'. */
export async function resumeReserve(deps: FlowDeps, attempt: StoredAttempt): Promise<ReserveResult> {
  if (!lease.moneyAllowed()) return { status: 'unavailable', reason: 'lease' };
  if (attemptsStoreHealth() === 'corrupt') return { status: 'unavailable', reason: 'corrupt' };
  if (attempt.stage !== 'reserving') {
    return { status: 'refused', reason: 'rejected', message: 'attempt is not awaiting reservation confirmation' };
  }
  const t = await token(deps);
  if (!t) return { status: 'unavailable', reason: 'auth' };
  const secret = attempt.method === 'cash' ? getPairedDevice()?.secret : undefined;
  if (attempt.method === 'cash' && !secret) {
    return { status: 'refused', reason: 'device_credential_invalid', message: 'this browser holds no pairing secret' };
  }
  const payload = buildBeginPayload(attempt, secret);   // byte-identical to the first send
  const res = await withRetry(() => rpcBeginQuotePayment(payload, t));
  if (res.status === 'ok') {
    const reserved: StoredAttempt = { ...attempt, stage: 'reserved' };
    if (upsertAttempt(reserved) !== 'ok') {
      markAttemptError(attempt.quoteId, 'promotion_unsaved');
      return { status: 'confirmed_unsaved', attempt };
    }
    return { status: 'reserved', attempt: reserved };
  }
  if (res.status === 'refused') {
    if (res.reason === 'quote_expired' || res.reason === 'quote_not_open' || res.reason === 'invalid_reservation') {
      // The quote died (or the reservation identity is unusable) — nothing
      // can be taken against it any more; drop the local attempt.
      removeAttempt(attempt.quoteId);
    } else {
      markAttemptError(attempt.quoteId, res.reason);
    }
    return { status: 'refused', reason: res.reason, message: res.message };
  }
  if (res.status === 'unauthenticated') { markAttemptError(attempt.quoteId, 'auth'); return { status: 'unavailable', reason: 'auth' }; }
  if (res.status === 'not_configured') return { status: 'unavailable', reason: 'not_configured' };
  markAttemptError(attempt.quoteId, 'offline');
  return { status: 'unconfirmed', attempt };
}

/** What the UI may safely offer for a stored attempt. Pure and testable: the
 *  single source of the rule that AMBIGUITY NEVER SHOWS PAYMENT CONTROLS. */
export function attemptCapabilities(a: StoredAttempt): {
  canTakePayment: boolean; canResumeReserve: boolean; canRetryFinalise: boolean; canRelease: boolean;
} {
  return {
    canTakePayment: a.stage === 'reserved',
    canResumeReserve: a.stage === 'reserving',
    canRetryFinalise: a.stage === 'finalising',
    canRelease: a.stage !== 'finalising',
  };
}

export type FinaliseResult =
  | { status: 'confirmed'; order: OrderRow; paymentStatus?: string | undefined; duplicate: boolean }
  | { status: 'refused'; reason: TillRefusal; message: string }
  | { status: 'unconfirmed'; reason: 'offline' | 'auth' }
  /** This browser could not durably record the finalisation facts — NO RPC
   *  was made; the cashier must not complete the payment on this till. */
  | { status: 'storage_failed' }
  /** The durable store is unreadable — NO RPC was made; see CORRUPT_STORE_TEXT. */
  | { status: 'store_corrupt' }
  /** Another tab holds the till lease — NO RPC was made. */
  | { status: 'lease_blocked' };

async function runFinalise(
  deps: FlowDeps,
  facts: FinaliseFacts,
  deviceSecret?: string,
): Promise<FinaliseResult> {
  if (!lease.moneyAllowed()) return { status: 'lease_blocked' };
  const t = await token(deps);
  if (!t) { markAttemptError(facts.quoteId, 'auth'); return { status: 'unconfirmed', reason: 'auth' }; }
  const payload: Record<string, unknown> = { ...facts };
  if (facts.method === 'cash') {
    if (!deviceSecret) {
      return { status: 'refused', reason: 'device_credential_invalid', message: 'device secret unavailable on this browser' };
    }
    payload.deviceSecret = deviceSecret;   // attached at call time, never stored
  }
  const res = await withRetry(() => rpcFinaliseOrderPayment(payload, t));
  if (res.status === 'ok') {
    removeAttempt(facts.quoteId);
    return {
      status: 'confirmed',
      order: res.data.order,
      paymentStatus: res.data.paymentStatus,
      duplicate: !!res.data.duplicate,
    };
  }
  if (res.status === 'refused') {
    if (res.reason === 'idempotency_conflict') {
      // The quote finalised with DIFFERENT facts (another tab / another
      // operator). Keep the attempt visible: the operator must look, not
      // guess. The order itself is safe — the server holds exactly one.
      markAttemptError(facts.quoteId, res.reason);
      return { status: 'refused', reason: res.reason, message: res.message };
    }
    // Any other refusal means the sale did NOT record. Drop back to
    // 'reserved' with the facts cleared so corrected facts can be sent.
    // (Strict read: if the store is corrupt, NEVER overwrite it — the server
    // refused, so money is safe, and the evidence must survive.)
    const cur = readAttemptsStrict();
    if (cur.status === 'valid') {
      const hit = cur.value.find((x) => x.quoteId === facts.quoteId);
      if (hit) {
        hit.stage = 'reserved';
        delete hit.facts;
        hit.attempts += 1;
        hit.lastError = res.reason;
        hit.updatedAt = new Date().toISOString();
        writeAttempts(cur.value);
      }
    }
    return { status: 'refused', reason: res.reason, message: res.message };
  }
  if (res.status === 'not_configured') {
    return { status: 'refused', reason: 'rejected', message: 'no backend configured' };
  }
  markAttemptError(facts.quoteId, res.status === 'unauthenticated' ? 'auth' : 'offline');
  return { status: 'unconfirmed', reason: res.status === 'unauthenticated' ? 'auth' : 'offline' };
}

/** Step 3 (cash) — record the money. Facts are persisted (stage 'finalising')
 *  BEFORE the call; `change` is deliberately not sent — the server computes it
 *  from the quoted total, so there is nothing to mismatch. */
export async function finaliseCash(
  deps: FlowDeps,
  attempt: StoredAttempt,
  cashReceived: string,
  customerName?: string,
): Promise<FinaliseResult> {
  const device = getPairedDevice();
  const facts: FinaliseFacts = {
    quoteId: attempt.quoteId,
    reservationId: attempt.reservationId,
    method: 'cash',
    cashReceived,
    tillSessionId: attempt.tillSessionId,
    deviceId: attempt.deviceId,
    ...(customerName ? { customerName } : {}),
  };
  // R4.1 STORAGE GATE: no verified facts on disk → no finalise call at all.
  const w = upsertAttempt({ ...attempt, stage: 'finalising', facts });
  if (w !== 'ok') {
    return w === 'corrupt' ? { status: 'store_corrupt' } : { status: 'storage_failed' };
  }
  return runFinalise(deps, facts, device?.secret);
}

/** Step 3 (card / online) — record the operator-observed result. The approved
 *  amount is pinned to the quoted total as a byte-stable string. */
export async function finaliseCardOrOnline(
  deps: FlowDeps,
  attempt: StoredAttempt,
  providerReference: string,
  customerName?: string,
): Promise<FinaliseResult> {
  const facts: FinaliseFacts = {
    quoteId: attempt.quoteId,
    reservationId: attempt.reservationId,
    method: attempt.method,
    providerReference,
    approvedAmount: attempt.quoteTotal,
    ...(customerName ? { customerName } : {}),
  };
  // R4.1 STORAGE GATE: no verified facts on disk → no finalise call at all.
  const w = upsertAttempt({ ...attempt, stage: 'finalising', facts });
  if (w !== 'ok') {
    return w === 'corrupt' ? { status: 'store_corrupt' } : { status: 'storage_failed' };
  }
  return runFinalise(deps, facts, undefined);
}

/** Replay a stored 'finalising' attempt with its EXACT persisted facts. The
 *  server either confirms the committed order (duplicate: true) or, if the
 *  original never arrived, records it now. */
export async function resumeFinalise(deps: FlowDeps, attempt: StoredAttempt): Promise<FinaliseResult> {
  if (attemptsStoreHealth() === 'corrupt') return { status: 'store_corrupt' };
  if (attempt.stage !== 'finalising' || !attempt.facts) {
    return { status: 'refused', reason: 'rejected', message: 'attempt has no persisted facts to replay' };
  }
  const device = attempt.method === 'cash' ? getPairedDevice() : null;
  return runFinalise(deps, attempt.facts, device?.secret);
}

export type ReleaseResult =
  | { status: 'released' }
  /** The quote already CONSUMED — the payment actually recorded. The caller
   *  should resumeFinalise() (or refresh) instead of treating this as free. */
  | { status: 'already_finalised' }
  | { status: 'refused'; reason: TillRefusal; message: string }
  | { status: 'unavailable'; reason: 'offline' | 'auth' | 'corrupt' | 'lease' };

/** Free a reserved route the customer walked away from (or the terminal
 *  declined). Releasing reopens the quote for a fresh reservation. */
export async function releaseAttempt(
  deps: FlowDeps,
  attempt: StoredAttempt,
  outcome: 'declined' | 'abandoned',
): Promise<ReleaseResult> {
  if (!lease.moneyAllowed()) return { status: 'unavailable', reason: 'lease' };
  if (attemptsStoreHealth() === 'corrupt') return { status: 'unavailable', reason: 'corrupt' };
  const t = await token(deps);
  if (!t) return { status: 'unavailable', reason: 'auth' };
  const payload = { quoteId: attempt.quoteId, reservationId: attempt.reservationId, outcome };   // built ONCE
  const res = await withRetry(() => rpcReleaseQuotePayment(payload, t));
  if (res.status === 'ok') { removeAttempt(attempt.quoteId); return { status: 'released' }; }
  if (res.status === 'refused') {
    if (res.reason === 'reservation_released') { removeAttempt(attempt.quoteId); return { status: 'released' }; }
    if (res.reason === 'invalid_reservation' && attempt.stage === 'reserving') {
      // Cancelling an ambiguous reservation that never landed: nothing exists
      // server-side, so there is nothing to release — drop the local record.
      removeAttempt(attempt.quoteId);
      return { status: 'released' };
    }
    if (res.reason === 'quote_already_consumed') return { status: 'already_finalised' };
    return { status: 'refused', reason: res.reason, message: res.message };
  }
  if (res.status === 'unauthenticated') return { status: 'unavailable', reason: 'auth' };
  return { status: 'unavailable', reason: 'offline' };
}

/** Drop a stored attempt locally without touching the server. ONLY for
 *  attempts the server has confirmed dead (e.g. after already_finalised has
 *  been resolved by the operator, or a released reservation). */
export const discardAttemptLocally = (quoteId: string): void => removeAttempt(quoteId);

/* ================================================================== */
/*  Custody: device pairing + drawer sessions                          */
/* ================================================================== */

export type EnrolResult =
  | { status: 'paired'; device: PairedDevice }
  /** The server MAY have created the device but the outcome never arrived.
   *  Enrolment mints a credential and is NOT idempotent, so it is never
   *  auto-retried: a manager reviews the device list before trying again. */
  | { status: 'unknown' }
  /** The server DID pair the device, but this browser could not durably
   *  store the one-time secret — the device is unusable and a manager
   *  should revoke it before pairing again. */
  | { status: 'paired_unsaved'; deviceId: string }
  /** An enrolment is already in flight in this tab — zero additional RPCs. */
  | { status: 'pairing_in_progress' }
  /** A previous enrolment's outcome is UNKNOWN — a human must review the
   *  server device list (and clear the marker) before any new attempt. */
  | { status: 'pairing_review_required' }
  | { status: 'refused'; reason: TillRefusal; message: string }
  | { status: 'unavailable'; reason: 'auth' | 'not_configured' | 'storage' | 'lease' };

/** Manager/owner (MFA session) pairs THIS browser as a till device. The
 *  pairing secret is issued exactly once and stored only on this device.
 *  SINGLE ATTEMPT — see EnrolResult['unknown'] for why there is no retry. */
let enrolInFlight = false;   // audit #4: single-flight, per tab (the lease covers cross-tab)

export async function enrolThisDevice(deps: FlowDeps, label: string): Promise<EnrolResult> {
  if (!lease.moneyAllowed()) return { status: 'unavailable', reason: 'lease' };
  if (enrolInFlight) return { status: 'pairing_in_progress' };
  const prior = getCustodyMarker();
  if (prior?.kind === 'enrol' && prior.outcome === 'unknown') {
    return { status: 'pairing_review_required' };
  }
  enrolInFlight = true;
  try {
  const t = await token(deps);
  if (!t) return { status: 'unavailable', reason: 'auth' };
  const marker: CustodyMarker = { kind: 'enrol', facts: { label }, at: new Date().toISOString() };
  if (!persistVerified(CUSTODY_REQ_KEY, marker)) {
    return { status: 'unavailable', reason: 'storage' };
  }
  const res = await rpcEnrolTillDevice({ label }, t);   // ONE attempt, deliberately
  if (res.status === 'ok') {
    const device: PairedDevice = {
      deviceId: res.data.deviceId,
      label: res.data.label ?? label,
      secret: res.data.pairingSecret,
      pairedAt: new Date().toISOString(),
    };
    if (!persistVerified(DEVICE_KEY, device)) {
      // The credential exists server-side but cannot live on this browser.
      persistVerified(CUSTODY_REQ_KEY, { ...marker, outcome: 'unknown' });
      return { status: 'paired_unsaved', deviceId: device.deviceId };
    }
    removeKey(CUSTODY_REQ_KEY);
    return { status: 'paired', device };
  }
  if (res.status === 'refused') {
    removeKey(CUSTODY_REQ_KEY);
    return { status: 'refused', reason: res.reason, message: res.message };
  }
  if (res.status === 'unauthenticated') { removeKey(CUSTODY_REQ_KEY); return { status: 'unavailable', reason: 'auth' }; }
  if (res.status === 'not_configured') { removeKey(CUSTODY_REQ_KEY); return { status: 'unavailable', reason: 'not_configured' }; }
  // Ambiguous: a device MAY now exist with a secret nobody holds. Keep the
  // marker so BOTH the UI and this function refuse a blind second enrolment.
  persistVerified(CUSTODY_REQ_KEY, { ...marker, outcome: 'unknown' });
  return { status: 'unknown' };
  } finally { enrolInFlight = false; }
}

export type SessionResult =
  | { status: 'open'; session: SessionRow }
  /** The SERVER opened the drawer, but this browser could not durably save
   *  the session — cash must stay disabled; a manager must recover or close
   *  the server session. The custody marker is kept (outcome 'unsaved'). */
  | { status: 'open_unsaved'; session: SessionRow }
  | { status: 'closed'; session: SessionRow }
  /** The server closed the drawer, but the local record could not be
   *  provably removed — this browser may still SHOW an open drawer. */
  | { status: 'closed_unsaved'; session: SessionRow }
  | { status: 'refused'; reason: TillRefusal; message: string }
  | { status: 'unavailable'; reason: 'offline' | 'auth' | 'not_configured' | 'storage' | 'lease' };

/** Open the drawer on the paired device. */
export async function openDrawer(deps: FlowDeps, openingFloat?: string): Promise<SessionResult> {
  if (!lease.moneyAllowed()) return { status: 'unavailable', reason: 'lease' };
  const device = getPairedDevice();
  if (!device) return { status: 'refused', reason: 'device_not_enrolled', message: 'this browser is not paired as a till device' };
  const t = await token(deps);
  if (!t) return { status: 'unavailable', reason: 'auth' };
  const payload: Record<string, unknown> = { deviceId: device.deviceId, deviceSecret: device.secret };
  if (openingFloat) payload.openingFloat = openingFloat;
  const marker: CustodyMarker = { kind: 'open_drawer', facts: { deviceId: device.deviceId, ...(openingFloat ? { openingFloat } : {}) }, at: new Date().toISOString() };
  if (!persistVerified(CUSTODY_REQ_KEY, marker)) return { status: 'unavailable', reason: 'storage' };
  const res = await withRetry(() => rpcOpenTillSession(payload, t));
  if (res.status === 'ok') {
    const saved = storeLocalTillSession({
      sessionId: res.data.session.id,
      deviceId: device.deviceId,
      openedAt: new Date().toISOString(),
    });
    if (!saved) {
      // Audit #6: the server session is OPEN with no durable local record.
      // Keep the custody marker so the state stays visible until resolved.
      persistVerified(CUSTODY_REQ_KEY, { ...marker, outcome: 'unsaved' });
      return { status: 'open_unsaved', session: res.data.session };
    }
    removeKey(CUSTODY_REQ_KEY);
    return { status: 'open', session: res.data.session };
  }
  removeKey(CUSTODY_REQ_KEY);
  if (res.status === 'refused') return { status: 'refused', reason: res.reason, message: res.message };
  if (res.status === 'unauthenticated') return { status: 'unavailable', reason: 'auth' };
  if (res.status === 'not_configured') return { status: 'unavailable', reason: 'not_configured' };
  return { status: 'unavailable', reason: 'offline' };
}

/** Close the drawer. The device path presents the pairing secret; a
 *  manager/owner with an MFA session may instead pass a written override
 *  reason (the lost/broken/revoked-device case). */
export async function closeDrawer(
  deps: FlowDeps,
  sessionId: string,
  auth: { kind: 'device' } | { kind: 'override'; reason: string },
): Promise<SessionResult> {
  if (!lease.moneyAllowed()) return { status: 'unavailable', reason: 'lease' };
  const t = await token(deps);
  if (!t) return { status: 'unavailable', reason: 'auth' };
  const payload: Record<string, unknown> = { id: sessionId };
  if (auth.kind === 'device') {
    const device = getPairedDevice();
    if (!device) return { status: 'refused', reason: 'device_credential_invalid', message: 'this browser holds no pairing secret' };
    payload.deviceSecret = device.secret;
  } else {
    payload.overrideReason = auth.reason;
  }
  const marker: CustodyMarker = { kind: 'close_drawer', facts: { sessionId, mode: auth.kind }, at: new Date().toISOString() };
  if (!persistVerified(CUSTODY_REQ_KEY, marker)) return { status: 'unavailable', reason: 'storage' };
  const res = await withRetry(() => rpcCloseTillSession(payload, t));
  removeKey(CUSTODY_REQ_KEY);
  if (res.status === 'ok') {
    const cleared = clearLocalTillSession();
    if (!cleared) return { status: 'closed_unsaved', session: res.data.session };
    return { status: 'closed', session: res.data.session };
  }
  if (res.status === 'refused') {
    if (res.reason === 'unknown_session') clearLocalTillSession();
    return { status: 'refused', reason: res.reason, message: res.message };
  }
  if (res.status === 'unauthenticated') return { status: 'unavailable', reason: 'auth' };
  if (res.status === 'not_configured') return { status: 'unavailable', reason: 'not_configured' };
  return { status: 'unavailable', reason: 'offline' };
}

/* ================================================================== */
/*  Manager recovery — resolving stuck payments + card evidence match  */
/* ================================================================== */

export interface ReconciliationQuoteRow extends Record<string, unknown> {
  id: string;
  channel: string;
  total: number | string;
  expires_at: string;
  payment_started_at: string | null;
  reservation_id: string | null;
  created_at: string;
}

export interface UnreconciledOrderRow extends Record<string, unknown> {
  id: string;
  order_number: number | null;
  total: number | string;
  payment_method: string;
  placed_at: string;
}

export type ListResult<T> =
  | { status: 'ok'; rows: T[] }
  | { status: 'not_configured' | 'unauthenticated' | 'error' };

/** Authenticated REST select under the caller's RLS. */
async function authedSelect<T>(deps: FlowDeps, pathAndQuery: string): Promise<ListResult<T>> {
  const cfg = resolveConfig();
  if (!cfg) return { status: 'not_configured' };
  const t = await token(deps);
  if (!t) return { status: 'unauthenticated' };
  const base = cfg.url.replace(/\/$/, '');
  try {
    const res = await timedFetch.pos(`${base}${pathAndQuery}`, {
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${t}` },
    });
    if (res.status === 401 || res.status === 403) return { status: 'unauthenticated' };
    if (!res.ok) return { status: 'error' };
    return { status: 'ok', rows: (await res.json()) as T[] };
  } catch {
    return { status: 'error' };
  }
}

/** Quotes stuck past the recovery window — RLS shows managers/owners their
 *  store's rows; anyone else simply sees an empty list. */
export function fetchReconciliationQuotes(deps: FlowDeps): Promise<ListResult<ReconciliationQuoteRow>> {
  return authedSelect<ReconciliationQuoteRow>(deps,
    '/rest/v1/order_quotes?status=eq.NEEDS_RECONCILIATION&select=id,channel,total,expires_at,payment_started_at,reservation_id,created_at&order=created_at.asc');
}

/** Card/online orders recorded from the operator's word, still awaiting
 *  independent settlement evidence. */
export function fetchUnreconciledCardOrders(deps: FlowDeps): Promise<ListResult<UnreconciledOrderRow>> {
  return authedSelect<UnreconciledOrderRow>(deps,
    '/rest/v1/orders?payment_status=eq.OPERATOR_RECORDED_UNRECONCILED&select=id,order_number,total,payment_method,placed_at&order=placed_at.asc');
}

/* R4.4 / F-01 — the operational bridge to recovery.
 * expire_stale_quotes() is the only writer of NEEDS_RECONCILIATION outside a
 * resolve, but R4.3 shipped no caller: after total local loss a stranded
 * PAYMENT_PENDING quote stayed invisible to the recovery list forever. The
 * sweep is server-authoritative housekeeping — store-scoped for staff and
 * managers, estate-wide for owners, idempotent — and it writes NOTHING to
 * the local attempt store, so it is deliberately NOT gated on the till
 * lease: a read-only tab may still surface stuck money for a manager. */
export type SweepOutcome =
  | { status: 'ok'; expired: number; movedToReconciliation: number }
  | { status: 'not_configured' | 'unauthenticated' | 'error' };

export async function runRecoverySweep(deps: FlowDeps): Promise<SweepOutcome> {
  const t = await token(deps);
  if (!t) return { status: 'unauthenticated' };
  const r = await post<{ expired: number; movedToReconciliation: number }>(
    '/rest/v1/rpc/expire_stale_quotes', {}, t);
  if (r.status === 'ok') {
    const d = r.data ?? { expired: 0, movedToReconciliation: 0 };
    return {
      status: 'ok',
      expired: Number(d.expired ?? 0),
      movedToReconciliation: Number(d.movedToReconciliation ?? 0),
    };
  }
  if (r.status === 'not_configured' || r.status === 'unauthenticated') return { status: r.status };
  return { status: 'error' };
}

export interface PaymentPendingQuoteRow extends Record<string, unknown> {
  id: string;
  channel: string;
  total: number | string;
  payment_started_at: string | null;
  reservation_id: string | null;
  created_at: string;
}

/** R4.4 / F-01 — in-window VISIBILITY without authority: quotes still inside
 *  the 24-hour payment window, listed read-only so a stranded payment is
 *  visible the moment it happens. Resolving before the window closes stays
 *  refused server-side (reconciliation_not_required) — this list carries no
 *  actions by design. */
export function fetchPaymentPendingQuotes(deps: FlowDeps): Promise<ListResult<PaymentPendingQuoteRow>> {
  return authedSelect<PaymentPendingQuoteRow>(deps,
    '/rest/v1/order_quotes?status=eq.PAYMENT_PENDING&select=id,channel,total,payment_started_at,reservation_id,created_at&order=payment_started_at.asc');
}

export interface ResolutionInput {
  quoteId: string;
  reservationId: string | null;
  action: 'void' | 'record_order';
  reason: string;
  resolutionId: string;
}

export type RecoveryOutcome =
  | RpcOutcome<Record<string, unknown>>
  | { status: 'storage_failed' }
  /** Another tab holds the till lease — zero RPCs. */
  | { status: 'lease_blocked' }
  /** A DIFFERENT recovery request is already held on this browser (or the
   *  held record is unreadable). It may have ALREADY COMMITTED server-side,
   *  so it must be replayed or explicitly discarded first — never silently
   *  overwritten. Zero RPCs. */
  | { status: 'held_recovery_exists' };

export type RecoveryMarkerRead =
  | { status: 'missing' }
  | { status: 'held'; marker: RecoveryMarker }
  | { status: 'corrupt' };
function readRecoveryMarkerStrict(): RecoveryMarkerRead {
  let raw: string | null;
  try { raw = localStorage.getItem(RECOVERY_REQ_KEY); } catch { return { status: 'corrupt' }; }
  if (raw === null) return { status: 'missing' };
  try {
    const p = JSON.parse(raw) as RecoveryMarker;
    if (p && (p.kind === 'resolve' || p.kind === 'reconcile') && p.payload && typeof p.at === 'string') {
      return { status: 'held', marker: p };
    }
    return { status: 'corrupt' };
  } catch { return { status: 'corrupt' }; }
}

/** Strict, UI-facing marker state — 'corrupt' must block new recovery writes. */
export const getRecoveryMarkerState = (): RecoveryMarkerRead => readRecoveryMarkerStrict();

/** Audit #3: a held recovery request is only ever REPLAYED (same payload) or
 *  explicitly discarded — a different request must not overwrite it. */
function recoveryWriteAllowed(kind: RecoveryMarker['kind'], payload: Record<string, unknown>): boolean {
  const cur = readRecoveryMarkerStrict();
  if (cur.status === 'missing') return true;
  if (cur.status === 'corrupt') return false;
  return cur.marker.kind === kind && JSON.stringify(cur.marker.payload) === JSON.stringify(payload);
}

/** Manager/owner (MFA) writes the human decision for a payment whose fate the
 *  ordinary window could not resolve. Idempotent on resolutionId; the exact
 *  request is durably recorded before the send so a retry reuses the SAME
 *  resolution identity. */
export async function resolveReconciliation(
  deps: FlowDeps,
  input: ResolutionInput,
): Promise<RecoveryOutcome> {
  if (!lease.moneyAllowed()) return { status: 'lease_blocked' };
  const t = await token(deps);
  if (!t) return { status: 'unauthenticated' };
  const payload = {                                    // built ONCE
    quoteId: input.quoteId,
    reservationId: input.reservationId,
    action: input.action,
    reason: input.reason,
    resolutionId: input.resolutionId,
  };
  if (!recoveryWriteAllowed('resolve', payload)) return { status: 'held_recovery_exists' };
  const marker: RecoveryMarker = { kind: 'resolve', payload, at: new Date().toISOString() };
  if (!persistVerified(RECOVERY_REQ_KEY, marker)) return { status: 'storage_failed' };
  const res = await withRetry(() => rpcResolvePaymentReconciliation(payload, t));
  if (res.status === 'ok' || res.status === 'refused') removeKey(RECOVERY_REQ_KEY);
  return res;
}

export interface SettlementInput {
  orderId: string;
  evidenceType: string;
  externalReference: string;
  currency: string;
  matchedAmount: string;
  paymentEventAt: string;
  reason: string;
  idempotencyKey: string;
}

/** Match independent settlement evidence against an operator-recorded card
 *  payment. Idempotent on idempotencyKey; the exact request is durably
 *  recorded before the send so a retry reuses the SAME key. */
export async function reconcileCardPayment(
  deps: FlowDeps,
  input: SettlementInput,
): Promise<RecoveryOutcome> {
  if (!lease.moneyAllowed()) return { status: 'lease_blocked' };
  const t = await token(deps);
  if (!t) return { status: 'unauthenticated' };
  const payload = { ...input };                        // built ONCE
  if (!recoveryWriteAllowed('reconcile', payload)) return { status: 'held_recovery_exists' };
  const marker: RecoveryMarker = { kind: 'reconcile', payload, at: new Date().toISOString() };
  if (!persistVerified(RECOVERY_REQ_KEY, marker)) return { status: 'storage_failed' };
  const res = await withRetry(() => rpcReconcileCardPayment(payload, t));
  if (res.status === 'ok' || res.status === 'refused') removeKey(RECOVERY_REQ_KEY);
  return res;
}

/* ================================================================== */
/*  Cashier-facing wording for controlled refusal codes                */
/* ================================================================== */

const REFUSAL_TEXT: Partial<Record<TillRefusal, string>> = {
  quote_expired: 'This price quote has expired — re-price the basket and try again.',
  quote_config_stale: 'Store prices changed since this quote — re-price the basket.',
  product_tax_unclassified: 'An item in this cart has no VAT classification — remove it or ask an owner to classify it.',
  payment_method_not_accepted: 'That payment method is not enabled for this store.',
  payment_already_pending: 'A payment is already in progress for this quote — resume or release it first.',
  insufficient_cash: 'Cash received is less than the order total.',
  payment_reference_required: 'Enter the reference shown on the terminal receipt.',
  approved_amount_mismatch: 'The approved amount must equal the quoted total.',
  till_session_required: 'Open the till drawer before taking cash.',
  till_session_not_open: 'The till drawer is not open — open a drawer session first.',
  device_not_enrolled: 'This browser is not paired as a till device — a manager can pair it in Till setup.',
  device_credential_invalid: 'This browser could not prove it is the paired till device — re-pair it in Till setup.',
  till_device_revoked: 'This till device has been revoked — a manager must re-pair the browser or close the drawer with an override.',
  session_has_unresolved_payments: 'Resolve the outstanding cash payment before closing this drawer.',
  operator_scope_denied: 'Another operator took this payment — a manager override with a reason is required.',
  recovery_window_elapsed: 'This payment is more than 24 hours old — a manager or owner must resolve it from Till orders.',
  idempotency_conflict: 'This sale was already recorded with different details — check the order list before retrying.',
  reservation_released: 'This payment attempt was already released.',
  quote_already_consumed: 'This sale was already recorded.',
  not_staff: 'Sign in with a staff account to use the till.',
  device_enrolment_denied: 'Pairing a till device needs a manager or owner with an MFA-verified session.',
  reconciliation_denied: 'Resolving payments needs a manager or owner with an MFA-verified session.',
  reconciliation_not_required: 'This payment is not awaiting reconciliation any more — refresh the list.',
  reason_required: 'Write a real reason (at least a sentence) — it goes in the permanent record.',
  resolution_id_required: 'A resolution reference is required.',
  already_reconciled: 'This payment was already reconciled.',
  settlement_amount_mismatch: 'The evidence amount does not match what was recorded for this order.',
  settlement_evidence_required: 'Enter the settlement evidence (type, reference, amount and time).',
  invalid_evidence_type: 'Pick a valid evidence type.',
  external_reference_required: 'Enter the provider or terminal reference from the evidence.',
  reconciliation_immutable: 'This reconciliation is already written and cannot be changed.',
};

/** One cashier-readable sentence for any refusal code. */
export function refusalText(reason: TillRefusal): string {
  return REFUSAL_TEXT[reason] ?? 'The server refused this request — nothing was recorded.';
}

/** The FAIL-CLOSED storage message: shown whenever this browser cannot
 *  durably record a payment identity, in place of any payment action. */
/** R4.2: another tab holds the till lease — this tab must not move money. */
export const LEASE_BLOCKED_TEXT =
  'Another till tab is active in this browser, so this tab is read-only for payments. '
  + 'Take the payment on the active tab — or close it and press "Make this tab the till".';

/** R4.2: the durable payment store cannot be trusted. FAIL CLOSED and never
 *  overwrite — a held money-bearing record may be inside the unreadable data. */
export const CORRUPT_STORE_TEXT =
  'The held-payment records on this browser are unreadable or invalid. Do NOT sell on this till: '
  + 'a payment in progress may be hidden inside the damaged data, and selling would overwrite it. '
  + 'A manager should check Till orders → Recovery and the server order list before this browser is used again.';

/** R4.2: the server confirmed, but the safe state could not be durably saved. */
export const CONFIRMED_UNSAVED_TEXT =
  'The server CONFIRMED the reservation, but this browser could not save that fact. Do NOT take payment. '
  + 'Retry — if this keeps happening, release the payment and use another till: this browser\'s storage is failing.';

export const STORAGE_FAILED_TEXT =
  'This till cannot safely record payments right now — browser storage is unavailable or failing. '
  + 'Do NOT take payment on this device; use another till or fix the browser (leave private mode, free space).';
