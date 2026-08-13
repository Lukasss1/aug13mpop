/**
 * @file orderOutbox.ts — LEGACY HOLD (WS7 client round).
 *
 * HISTORY: FIX-2 made till sales durable — enqueue() persisted every sale to
 * localStorage BEFORE any network I/O, and drain()/confirmOne() replayed them
 * through the idempotent submit_web_order() RPC (WS6j online-confirmed
 * selling). That RPC no longer exists: WS7 replaced the single-shot submit
 * with create_order_quote → begin_quote_payment → finalise_order_payment, and
 * the browser till now runs that flow through src/lib/tillPayments.ts, which
 * carries the same persist-before-network discipline in its own durable
 * payment-attempt store.
 *
 * WHY THIS FILE REMAINS: a browser that took sales on the PREVIOUS till
 * version may still hold undelivered entries under this storage key. They are
 * MONEY-BEARING facts. Draining them is impossible — the RPC is gone, and the
 * resulting 404 would read as a permanent refusal and DELETE the rows — so
 * this module is now read-only plus one deliberate removal: entries stay
 * visible (badge, basket banner, Till orders → Legacy held sales) until a
 * manager re-keys each one through the new flow and clears it explicitly.
 *
 * Nothing here performs network I/O any more, by design.
 */

const STORAGE_KEY = 'milkpop_order_outbox_v1';

/** A sale was considered "stuck" after this many failed sync attempts (kept
 *  so entries recorded by the previous version classify identically). */
export const STUCK_AFTER_ATTEMPTS = 5;

export interface OutboxEntry {
  /** Order id — was also the idempotency key of the removed RPC. */
  id: string;
  /** The exact snake_cased row the OLD client would have sent. Preserved
   *  verbatim: it is the manager's source sheet for re-keying the sale. */
  row: Record<string, unknown>;
  /** Camel-cased Order object, kept so the till list can re-show the sale
   *  after a reload without a round-trip to the database. */
  order?: Record<string, unknown> | undefined;
  queuedAt: string;
  attempts: number;
  lastError?: string;
}

/* ------------------------------------------------------------------ */

export type LegacyOutboxReadStatus = 'ok' | 'unavailable' | 'corrupt';

export interface LegacyOutboxSnapshot {
  status: LegacyOutboxReadStatus;
  entries: OutboxEntry[];
  /** Untouched storage value for manager-led recovery. Present only when the
   * value was readable but could not be safely interpreted. */
  raw?: string;
}

const isOutboxEntry = (value: unknown): value is OutboxEntry => {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<OutboxEntry>;
  return typeof entry.id === 'string' && !!entry.row && typeof entry.row === 'object';
};

/** Read the legacy money-bearing store without hiding corruption. An empty or
 * absent store is healthy. A malformed value is preserved verbatim and never
 * overwritten by this module until a manager has exported/recovered it. */
export function legacySnapshot(): LegacyOutboxSnapshot {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { status: 'unavailable', entries: [] };
  }
  if (!raw) return { status: 'ok', entries: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isOutboxEntry)) {
      return { status: 'corrupt', entries: [], raw };
    }
    return { status: 'ok', entries: parsed };
  } catch {
    return { status: 'corrupt', entries: [], raw };
  }
}

function readAll(): OutboxEntry[] {
  return legacySnapshot().entries;
}

function writeAll(entries: OutboxEntry[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    /* storage unavailable — the held copy in memory still renders this session */
    return false;
  }
}

type Listener = (pending: number) => void;
const listeners = new Set<Listener>();
function notify(): void {
  const n = readAll().length;
  listeners.forEach((l) => { try { l(n); } catch { /* listener errors never break the hold */ } });
}

/** Subscribe to held-count changes (returns an unsubscribe fn). */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/* ------------------------------------------------------------------ */

/** Every held legacy sale, oldest first — the Till-orders viewer's source. */
export function legacyEntries(): OutboxEntry[] {
  return [...readAll()].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

/** Number of sales still held locally. */
export function pendingCount(): number {
  return readAll().length;
}

/** Entries that had failed ≥ STUCK_AFTER_ATTEMPTS syncs under the old client. */
export function stuckEntries(): OutboxEntry[] {
  return readAll().filter((e) => e.attempts >= STUCK_AFTER_ATTEMPTS);
}

/** Held camel-cased Order objects (merged into the till list on reload so a
 *  held sale never vanishes from the day's view). */
export function pendingOrders(): Record<string, unknown>[] {
  return readAll().map((e) => e.order).filter((o): o is Record<string, unknown> => !!o);
}

/** Untouched malformed value for a manager to download before clearing or
 * repairing site data. Never returns valid held-sale JSON. */
export function legacyRecoverySnapshot(): string | null {
  const snapshot = legacySnapshot();
  return snapshot.status === 'corrupt' ? snapshot.raw ?? null : null;
}

/** DELIBERATE removal of one held sale — a manager confirms it has been
 *  re-keyed through the new flow (or ruled not to be a real sale). This is
 *  the only write this module still performs. */
export function removeEntry(id: string): boolean {
  const snapshot = legacySnapshot();
  // Never turn an unreadable money-bearing store into an apparently empty one.
  if (snapshot.status !== 'ok') return false;
  if (!writeAll(snapshot.entries.filter((e) => e.id !== id))) return false;
  notify();
  return true;
}
