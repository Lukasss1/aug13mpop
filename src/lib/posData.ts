/**
 * POS cloud reads — integration plan Gate 6.
 *
 * Typed, authenticated readers for the pos_* tables created by
 * supabase/migration_pos_sync.sql. The signed-in staff JWT goes in the
 * Authorization header and Row Level Security does ALL the scoping: owners
 * see every store, managers only their own, everyone else nothing. The
 * anon key alone returns zero rows by design.
 *
 * MANDATORY TEST #7 (till history survives a cleared browser): this module
 * — and the TillOrders view built on it — deliberately never touches
 * localStorage or sessionStorage. Till history lives in Supabase, arrived
 * via the till's outbox, and is merely DISPLAYED here. Clearing site data
 * clears nothing but the display. A static check in
 * scripts/pos-contract.test.mjs enforces the absence of browser storage.
 *
 * Reads follow the fetchInboxAuthed pattern in lib/supabase.ts: PostgREST
 * over fetch, coarse result statuses, 401/403 → 'unauthenticated'.
 */
import { getSupabaseConfig } from './supabase';
import { timedFetch } from './requestTimeout';

export type PosReadResult<T> =
  | { status: 'ok'; rows: T[] }
  | { status: 'not_configured' | 'unauthenticated' | 'error' };

export interface PosOrderItemModifier {
  id: string; modifierId: string; name: string; pricePence: number;
}
export interface PosOrderItem {
  id: string; orderId: string; productId: string; name: string; category: string;
  size: string; quantity: number; unitPricePence: number; lineTotalPence: number;
  discountAllocationPence: number; vatRateBp: number; vatPence: number;
  modifiers?: PosOrderItemModifier[];
}
export interface PosRefundItem {
  id: string; refundId: string; orderItemId: string; name?: string; size?: string;
  quantity: number; amountPence: number;
}
export interface PosRefund {
  id: string; orderId: string; shiftId: string; kind: string; method: string;
  amountPence: number; reason: string; userName?: string; approvedByName?: string;
  cardTerminalConfirmed: boolean; occurredAt: string;
  items?: PosRefundItem[];
}
export interface PosVoid {
  id: string; orderId: string; shiftId: string; orderTotalPence: number;
  method: string; cardTerminalConfirmed: boolean; reason: string;
  userName?: string; approvedByName?: string; occurredAt: string;
}
export interface PosCorrection {
  id: string; orderId?: string; shiftId: string; kind: string;
  beforePayload: Record<string, unknown>; afterPayload: Record<string, unknown>;
  reason: string; userName?: string; approvedByName?: string; occurredAt: string;
}
export interface PosOrder {
  id: string; deviceId: string; storeId: string; clientReference: string;
  visibleOrderNumber: string; orderSequence?: number; storeCode: string;
  deviceCode: string; status: string; subtotalPence: number; discountPence: number;
  vatPence: number; totalPence: number; appliedDeals: Array<Record<string, unknown>>;
  paymentMethod: 'cash' | 'card'; cashReceivedPence?: number; changeGivenPence?: number;
  manualCardConfirmation: boolean; shiftId?: string; soldByUserId?: string;
  soldByName?: string; occurredAt: string; completedAt: string; receivedAt: string;
  items?: PosOrderItem[]; refunds?: PosRefund[];
  voids?: PosVoid[] | PosVoid | null; corrections?: PosCorrection[];
}
export interface PosShift {
  id: string; deviceId: string; storeId: string; status: 'open' | 'closed';
  openedAt?: string; openedByName?: string; openingCashPence?: number;
  closedAt?: string; closedByName?: string; countedCashPence?: number;
  reportedCardPence?: number; expectedCashPence?: number; cashVariancePence?: number;
  expectedCardPence?: number; cardVariancePence?: number; varianceReason?: string;
  closingNote?: string; closeSummary?: Record<string, unknown>; receivedAt: string;
}
export interface PosDevice {
  id: string; storeId: string; storeName: string; deviceName: string;
  deviceCode: string; storeCode: string; revoked: boolean;
  pairedAt: string; lastSyncAt?: string;
}

/* ------------------------------------------------------------------ */
/* Deep snake_case → camelCase (PostgREST embeds are nested; the        */
/* shallow fromRow in lib/supabase.ts only maps the top level).         */
/* ------------------------------------------------------------------ */
const snakeToCamel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
function deepCamel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepCamel);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[snakeToCamel(k)] = v === null ? undefined : deepCamel(v);
    }
    return out;
  }
  return value;
}

async function posSelect<T>(pathAndQuery: string, accessToken: string): Promise<PosReadResult<T>> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { status: 'not_configured' };
  if (!accessToken) return { status: 'unauthenticated' };
  const base = cfg.url.replace(/\/$/, '');
  try {
    const res = await timedFetch.pos(`${base}/rest/v1/${pathAndQuery}`, {
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401 || res.status === 403) return { status: 'unauthenticated' };
    if (!res.ok) return { status: 'error' };
    const rows = (await res.json()) as Record<string, unknown>[];
    return { status: 'ok', rows: rows.map((r) => deepCamel(r) as T) };
  } catch {
    return { status: 'error' };
  }
}

/**
 * Orders newest-first with full detail embedded (items+modifiers, refunds
 * +lines, void, corrections) — one round trip, no per-row fetches. RLS
 * scopes rows; the applied filters only narrow further.
 */
export function fetchPosOrders(
  accessToken: string,
  opts: { limit?: number; storeId?: string } = {},
): Promise<PosReadResult<PosOrder>> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const select =
    'select=*' +
    ',items:pos_order_items(*,modifiers:pos_order_item_modifiers(*))' +
    ',refunds:pos_refunds(*,items:pos_refund_items(*))' +
    ',voids:pos_voids(*)' +
    ',corrections:pos_corrections(*)';
  const store = opts.storeId ? `&store_id=eq.${encodeURIComponent(opts.storeId)}` : '';
  return posSelect<PosOrder>(
    `pos_orders?${select}${store}&order=occurred_at.desc&limit=${limit}`,
    accessToken,
  );
}

/** Shifts newest-first, including the verbatim stored Z-report summary. */
export function fetchPosShifts(
  accessToken: string,
  opts: { limit?: number; storeId?: string } = {},
): Promise<PosReadResult<PosShift>> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const store = opts.storeId ? `&store_id=eq.${encodeURIComponent(opts.storeId)}` : '';
  return posSelect<PosShift>(
    `pos_shifts?select=*${store}&order=opened_at.desc.nullslast&limit=${limit}`,
    accessToken,
  );
}

/**
 * Device METADATA only. The columns are enumerated because the browser
 * grant is column-scoped — the token hash columns are not even grantable,
 * and `select=*` would be refused outright.
 */
export function fetchPosDevices(accessToken: string): Promise<PosReadResult<PosDevice>> {
  const cols = ['id', 'store_id', 'store_name', 'device_name', 'device_code',
    'store_code', 'revoked', 'paired_at', 'last_sync_at'].join(',');
  return posSelect<PosDevice>(
    `pos_devices?select=${cols}&order=paired_at.desc`,
    accessToken,
  );
}

/** The one-or-none void PostgREST may hand back as object or array. */
export function normalizeVoid(v: PosOrder['voids']): PosVoid | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/* ------------------------------------------------------------------ */
/* Gate 8 — device management RPCs + CSV export                         */
/* ------------------------------------------------------------------ */

export type PosRpcResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'not_configured' | 'unauthenticated' | 'forbidden' | 'error'; message?: string };

/**
 * Call one of the Owner RPCs as the signed-in user. The functions re-check
 * is_owner() themselves — a manager reaching this path gets 'forbidden',
 * decided by the DATABASE, not the UI.
 */
async function posRpc<T>(fn: string, args: Record<string, unknown>, accessToken: string): Promise<PosRpcResult<T>> {
  return posRpcPublic<T>(fn, args, accessToken);
}

/** Shared authed RPC caller (posCatalog.ts publishes through it too). */
export async function posRpcPublic<T>(fn: string, args: Record<string, unknown>, accessToken: string): Promise<PosRpcResult<T>> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { status: 'not_configured' };
  if (!accessToken) return { status: 'unauthenticated' };
  const base = cfg.url.replace(/\/$/, '');
  try {
    const res = await timedFetch.pos(`${base}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: cfg.anonKey, Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (res.status === 401 || res.status === 403) return { status: 'unauthenticated' };
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as Record<string, unknown>));
      const message = String((body as Record<string, unknown>).message ?? '');
      if (/only the owner/i.test(message)) return { status: 'forbidden', message };
      return { status: 'error', message: message || `HTTP ${res.status}` };
    }
    return { status: 'ok', value: (await res.json()) as T };
  } catch {
    return { status: 'error' };
  }
}

export interface FreshPairingCode { code: string; expiresAt: string }

/** Owner: mint a one-time pairing code. The PLAINTEXT exists only in this
 *  response — the database keeps a hash. Show it once, then it is gone. */
export async function createPairingCode(
  accessToken: string,
  input: { storeId: string; storeName: string; deviceLabel: string },
): Promise<PosRpcResult<FreshPairingCode>> {
  const r = await posRpc<Array<{ code: string; expires_at: string }>>(
    'create_pos_pairing_code',
    { p_store_id: input.storeId, p_store_name: input.storeName, p_device_label: input.deviceLabel },
    accessToken,
  );
  if (r.status !== 'ok') return r;
  const row = Array.isArray(r.value) ? r.value[0] : undefined;
  if (!row?.code) return { status: 'error', message: 'The database returned no code.' };
  return { status: 'ok', value: { code: row.code, expiresAt: row.expires_at } };
}

/** Owner: revoke a till immediately. Its queued sales stay ON the till and
 *  upload after a fresh pairing — nothing is lost, only access. */
export function revokeDevice(accessToken: string, deviceId: string): Promise<PosRpcResult<null>> {
  return posRpc<null>('revoke_pos_device', { p_device_id: deviceId }, accessToken);
}

/** Owner: rotate a till's token. Returns the new PLAINTEXT exactly once;
 *  the OLD token keeps working until the till first uses the new one
 *  (the overlap window), so a half-finished rotation never bricks a till. */
export function rotateDeviceToken(accessToken: string, deviceId: string): Promise<PosRpcResult<string>> {
  return posRpc<string>('rotate_pos_device_token', { p_device_id: deviceId }, accessToken);
}

/* ------------------------------------------------------------------ */

/** RFC-4180-ish CSV: quote everything, double internal quotes. Pure. */
export function toCsv(headers: string[], rows: Array<Array<string | number | undefined | null>>): string {
  const cell = (v: string | number | undefined | null) =>
    `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [headers.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n') + '\r\n';
}

const pounds = (pence: number | undefined | null) =>
  typeof pence === 'number' ? (pence / 100).toFixed(2) : '';

/** Orders → spreadsheet rows for the CURRENTLY VISIBLE scope. */
export function ordersToCsv(orders: PosOrder[]): string {
  return toCsv(
    ['Time', 'Order №', 'Store', 'Till', 'Staff', 'Items', 'Method',
      'Subtotal £', 'Discount £', 'VAT £', 'Total £', 'Refunded £', 'Voided', 'Corrected'],
    orders.map((o) => {
      const refunded = (o.refunds || []).reduce((s, r) => s + r.amountPence, 0);
      const voided = Array.isArray(o.voids) ? o.voids.length > 0 : !!o.voids;
      return [
        o.occurredAt, o.visibleOrderNumber, o.storeCode, o.deviceCode,
        o.soldByName ?? '', (o.items || []).reduce((s, i) => s + i.quantity, 0),
        o.paymentMethod, pounds(o.subtotalPence), pounds(o.discountPence),
        pounds(o.vatPence), pounds(o.totalPence),
        refunded ? pounds(refunded) : '', voided ? 'yes' : '',
        (o.corrections || []).length ? 'yes' : '',
      ];
    }),
  );
}

/** Shifts → spreadsheet rows (Z-report figures). */
export function shiftsToCsv(shifts: PosShift[]): string {
  return toCsv(
    ['Opened', 'Closed', 'Status', 'Opened by', 'Closed by', 'Float £',
      'Counted cash £', 'Expected cash £', 'Cash variance £',
      'Reported card £', 'Expected card £', 'Card variance £', 'Variance reason'],
    shifts.map((s) => [
      s.openedAt ?? '', s.closedAt ?? '', s.status, s.openedByName ?? '',
      s.closedByName ?? '', pounds(s.openingCashPence), pounds(s.countedCashPence),
      pounds(s.expectedCashPence), pounds(s.cashVariancePence),
      pounds(s.reportedCardPence), pounds(s.expectedCardPence),
      pounds(s.cardVariancePence), s.varianceReason ?? '',
    ]),
  );
}
