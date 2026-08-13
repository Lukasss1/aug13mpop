/**
 * POS ↔ website wire contract v1 — WEB-SIDE TYPES. Types and `as const`
 * constants only: importing this module changes no runtime behaviour.
 *
 * This file mirrors the till repo's `src/domain/sync.ts`. Edge Functions run
 * on Deno and cannot import from `src/`, so a byte-identical copy lives at
 * `supabase/functions/_shared/posContract.ts` (D-11) — a static regression
 * test keeps the two in lockstep. Any wire change bumps POS_CONTRACT_VERSION
 * and edits both repos' contract docs; additive optional fields need no bump
 * (receivers ignore unknown fields).
 */


/* ------------------------------------------------------------------------ */
/* Event catalogue (SYNC-CONTRACT.md §2)                                     */
/* ------------------------------------------------------------------------ */

/**
 * Entity-class events: land in POS entity tables server-side. `sale_completed`
 * MUST NOT appear on the wire (D-01) — the outbox carries `order_created`.
 */
export const ENTITY_EVENT_TYPES = [
  'order_created',
  'shift_opened',
  'shift_closed',
  'cash_movement_recorded',
  'refund_created',
  'void_created',
  'correction_created',
  'day_opened',
  'day_closed',
] as const;

/**
 * Audit-class events: land in pos_audit_events ONLY. The first six are
 * outboxed by the till today; the last five are reserved names the till
 * currently keeps in its local audit_events table without an outbox row
 * (their aggregate counts reach the server inside the Day File auditCounts).
 */
export const AUDIT_EVENT_TYPES = [
  'user_created',
  'user_updated',
  'user_deactivated',
  'user_reactivated',
  'pin_reset',
  'settings_changed',
  'login_succeeded',
  'login_failed',
  'logout',
  'auto_locked',
  'device_setup',
] as const;

export type EntityEventType = (typeof ENTITY_EVENT_TYPES)[number];
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export type PosEventType = EntityEventType | AuditEventType;

/* ------------------------------------------------------------------------ */
/* Shared scalar unions (till domain vocabulary)                             */
/* ------------------------------------------------------------------------ */

export type WirePaymentMethod = 'cash' | 'card';
export type WireItemSize = 'regular' | 'large' | 'one_size';
export type WireRefundKind = 'full' | 'items' | 'custom';
export type WireCorrectionKind = 'payment_method' | 'operational';
export type WireCashDirection = 'paid_in' | 'paid_out';
export type WireDealType =
  | 'bundle_price'
  | 'buy_x_get_y_free'
  | 'percent_off_category'
  | 'fixed_off_order';
export type WireApprovalActionType =
  | 'refund'
  | 'void'
  | 'correction'
  | 'variance'
  | 'cash_movement';

/* ------------------------------------------------------------------------ */
/* Ingest envelope (SYNC-CONTRACT.md §3)                                     */
/* ------------------------------------------------------------------------ */

export interface IngestDeviceInfo {
  installationId: string;
  appVersion: string;
  /** Till SQLite schema version the events were produced under. */
  schemaVersion: number;
}

export interface IngestEvent {
  /** sync_outbox.id — THE idempotency key (pos_events.event_id, unique). */
  id: string;
  eventType: PosEventType;
  entityId: string;
  /** Device clock, ISO-8601 UTC — the outbox row's created_at. */
  createdAt: string;
  /** Full entity snapshot per §4 of the contract doc. */
  payload: Record<string, unknown>;
}

export interface PosIngestRequest {
  device: IngestDeviceInfo;
  /** 1..MAX_EVENTS_PER_BATCH, oldest first; server applies in array order. */
  events: IngestEvent[];
}

/**
 * Frozen starter set of rejection reasons. The set is OPEN: receivers must
 * tolerate unknown strings (hence the `| (string & {})` widening below).
 */
export const REJECTION_REASONS = [
  'schema_version_unsupported',
  'unknown_event_type',
  'malformed_payload',
  'forbidden_field',
  'invalid_money',
  'device_scope_violation',
  'payload_too_large',
  'duplicate_conflict',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number] | (string & {});

export interface IngestRejection {
  id: string;
  reason: RejectionReason;
  detail?: string;
}

/**
 * HTTP 200 response. Partition invariant: acknowledgedIds ∪ rejectedIds =
 * exactly the request's events[].id, no overlap. Duplicates of identical
 * payloads are acknowledged; a changed payload under the same id is rejected
 * with `duplicate_conflict`.
 */
export interface PosIngestResponse {
  acknowledgedIds: string[];
  rejectedIds: string[];
  rejections?: IngestRejection[];
  /** Current catalog version — lets the till notice updates without polling. */
  catalogVersion?: number;
}

/* ------------------------------------------------------------------------ */
/* Payload snapshots (SYNC-CONTRACT.md §4)                                   */
/* ------------------------------------------------------------------------ */

/**
 * Every entity payload is the FULL snapshot at commit time: integer pence,
 * till camelCase names, actor display names carried ALONGSIDE till-local user
 * ids (the website shows names until identities are mapped). Approvals ride
 * EMBEDDED inside their parent event — there is no standalone approval event
 * (D-05). `eventVersion` stamps the payload format (currently 1) so future
 * shapes can coexist in one outbox.
 */
export const EVENT_PAYLOAD_VERSION = 1 as const;

export interface ApprovalSnapshot {
  id: string;
  actionType: WireApprovalActionType;
  entityType: string;
  entityId: string;
  approverUserId: string;
  approverName: string;
  requestedByUserId: string | null;
  requestedByName: string | null;
  reason: string | null;
  createdAt: string;
}

export interface WireAppliedDeal {
  dealId: string;
  dealName: string;
  discountPence: number;
  eligibleCategory?: string;
}

export interface WireOrderItemModifier {
  id: string;
  modifierId: string;
  name: string;
  pricePence: number;
}

export interface WireOrderItem {
  id: string;
  productId: string;
  name: string;
  category: string;
  size: WireItemSize;
  quantity: number;
  unitPricePence: number;
  lineTotalPence: number;
  discountAllocationPence: number;
  vatRateBp: number;
  vatPence: number;
  modifiers: WireOrderItemModifier[];
}

export interface OrderCreatedPayload {
  eventVersion: number;
  order: {
    id: string;
    clientReference: string;
    /** e.g. "BHM01-IP01-1001" */
    visibleOrderNumber: string;
    /**
     * 1001 — integer, emitted by the TILL (owner of the format), never
     * parsed server-side.
     */
    orderSequence: number;
    storeCode: string;
    deviceCode: string;
    status: 'completed';
    subtotalPence: number;
    discountPence: number;
    vatPence: number;
    totalPence: number;
    appliedDeals: WireAppliedDeal[];
    paymentMethod: WirePaymentMethod;
    cashReceivedPence: number | null;
    changeGivenPence: number | null;
    manualCardConfirmation: boolean;
    createdAt: string;
    completedAt: string;
    shiftId: string | null;
    soldByUserId: string | null;
    soldByName: string | null;
  };
  items: WireOrderItem[];
}

export interface ShiftOpenedPayload {
  eventVersion: number;
  shift: {
    id: string;
    openedAt: string;
    openedByUserId: string;
    openedByName: string;
    openingCashPence: number;
    openingNote: string | null;
  };
}

export interface ShiftClosedPayload {
  eventVersion: number;
  shift: {
    id: string;
    openedAt: string;
    openedByUserId: string;
    openedByName: string;
    closedAt: string;
    closedByUserId: string;
    closedByName: string;
    openingCashPence: number;
    countedCashPence: number;
    reportedCardPence: number;
    expectedCashPence: number;
    cashVariancePence: number;
    expectedCardPence: number;
    cardVariancePence: number;
    varianceReason: string | null;
    closingNote: string | null;
  };
  /** The STORED Z-report snapshot (Gate 2) — verbatim, never recomputed. */
  summary: Record<string, unknown>;
  /** Present when a meaningful variance required a Manager/Owner approval. */
  approval: ApprovalSnapshot | null;
}

export interface CashMovementRecordedPayload {
  eventVersion: number;
  movement: {
    id: string;
    shiftId: string;
    direction: WireCashDirection;
    amountPence: number;
    reason: string;
    userId: string;
    userName: string;
    approvedByUserId: string | null;
    approvedByName: string | null;
    createdAt: string;
  };
  approval: ApprovalSnapshot | null;
}

export interface RefundCreatedPayload {
  eventVersion: number;
  refund: {
    id: string;
    orderId: string;
    visibleOrderNumber: string;
    shiftId: string;
    kind: WireRefundKind;
    method: WirePaymentMethod;
    amountPence: number;
    reason: string;
    userId: string;
    userName: string;
    approvedByUserId: string;
    approvedByName: string;
    cardTerminalConfirmed: boolean;
    createdAt: string;
  };
  items: Array<{
    id: string;
    orderItemId: string;
    name: string;
    size: WireItemSize;
    quantity: number;
    amountPence: number;
  }>;
  approval: ApprovalSnapshot | null;
}

export interface VoidCreatedPayload {
  eventVersion: number;
  void: {
    id: string;
    orderId: string;
    visibleOrderNumber: string;
    orderTotalPence: number;
    method: WirePaymentMethod;
    cardTerminalConfirmed: boolean;
    shiftId: string;
    reason: string;
    userId: string;
    userName: string;
    approvedByUserId: string;
    approvedByName: string;
    createdAt: string;
  };
  approval: ApprovalSnapshot | null;
}

export interface CorrectionCreatedPayload {
  eventVersion: number;
  correction: {
    id: string;
    orderId: string | null;
    visibleOrderNumber: string | null;
    shiftId: string;
    kind: WireCorrectionKind;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    reason: string;
    userId: string;
    userName: string;
    approvedByUserId: string;
    approvedByName: string;
    createdAt: string;
  };
  approval: ApprovalSnapshot | null;
}

/* ------------------------------------------------------------------------ */
/* Frozen constants (SYNC-CONTRACT.md §9)                                    */
/* ------------------------------------------------------------------------ */

export const POS_CONTRACT_VERSION = 1 as const;
export const MAX_EVENTS_PER_BATCH = 50 as const;
export const DAY_FILE_VERSION = 1 as const;
export const PAIRING_CODE_LENGTH = 8 as const;
export const PAIRING_CODE_TTL_MINUTES = 15 as const;
/** 256-bit random, base64url on the wire, SHA-256 hex at rest. */
export const DEVICE_TOKEN_BYTES = 32 as const;
export const DAY_FILES_BUCKET = 'day-files' as const;

export const POS_ENDPOINTS = {
  pair: '/functions/v1/pos-pair',
  ingest: '/functions/v1/pos-ingest',
  catalog: '/functions/v1/pos-catalog',
  dayFileUrl: '/functions/v1/day-file-url',
} as const;

/* ------------------------------------------------------------------------ */
/* Catalog push (website → till) — ADDITIVE, contract version unchanged      */
/* ------------------------------------------------------------------------ */

/*
 * GET POS_ENDPOINTS.catalog with the device bearer token returns the newest
 * published catalogue. Sections are each OPTIONAL: a section that is absent
 * from the snapshot is left untouched on the till; a section that is
 * present is replaced WHOLESALE and atomically. Products may only appear
 * together with categories (foreign keys). Historical receipts, orders and
 * shifts are never touched by a catalogue apply — they carry their own
 * denormalized names and prices by design.
 */

export interface CatalogCategory {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface CatalogProduct {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  basePricePence: number;
  largePricePence: number | null;
  /** Integer basis points, e.g. 2000 = 20%. */
  vatRateBp: number;
  allergens: string[];
  active: boolean;
  sortOrder: number;
}

export interface CatalogModifier {
  id: string;
  name: string;
  pricePence: number;
  allergens: string[];
  active: boolean;
  sortOrder: number;
}

export interface CatalogDeal {
  id: string;
  name: string;
  type: 'bundle_price' | 'buy_x_get_y_free' | 'percent_off_category' | 'fixed_off_order';
  active: boolean;
  category?: string;
  buyQty?: number;
  bundlePricePence?: number;
  freeQty?: number;
  percentOff?: number;
  amountOffPence?: number;
  minOrderValuePence?: number;
  badge?: string;
}

export interface CatalogSnapshot {
  categories?: CatalogCategory[];
  products?: CatalogProduct[];
  modifiers?: CatalogModifier[];
  deals?: CatalogDeal[];
}

export interface PosCatalogResponse {
  catalogVersion: number;
  catalog: CatalogSnapshot;
}

/* ------------------------------------------------------------------------ */
/* Web-side note                                                              */
/* ------------------------------------------------------------------------ */

/*
 * The till repo carries a compile-time assertion that PosIngestResponse is
 * assignable to its shipped transport's SyncAcknowledgement. The server's
 * matching obligation — the response partition invariant — is enforced at
 * runtime inside pos_ingest_batch and asserted by the static POS suite.
 */
