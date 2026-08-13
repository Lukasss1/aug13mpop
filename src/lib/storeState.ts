/** Store-scoped app_state keys used by the staff portal. */
export type StoreStateBaseKey =
  | 'milkpop_checklist_tasks'
  | 'milkpop_checklist_audits'
  | 'milkpop_shift_covers';

/**
 * Build the only valid client representation of a store-scoped app_state key.
 * The database independently verifies that the suffix matches the caller's
 * server-derived store, so this helper is convenience rather than authority.
 */
export function storeStateKey(base: StoreStateBaseKey, storeId: string | null | undefined): string | null {
  const normalized = String(storeId ?? '').trim();
  return normalized ? `${base}:${normalized}` : null;
}


export interface ShiftCoverRequest {
  requestedBy: string;
  requestedById?: string;
  message: string;
  date: string;
}

export type ShiftCoverBoard = Record<string, ShiftCoverRequest>;
