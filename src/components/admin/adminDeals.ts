import type { Deal, MenuItem } from '../../types';

export interface DealDraftError {
  ok: false;
  message: string;
  tone: 'warning' | 'error';
}

export interface DealDraftSuccess {
  ok: true;
  value: Omit<Deal, 'id'>;
}

export type DealDraftResult = DealDraftError | DealDraftSuccess;

export function freshDealDraft(): Partial<Deal> {
  return {
    name: '',
    description: '',
    type: 'bundle_price',
    category: 'milkshakes',
    active: false,
    badge: '',
  };
}

const positiveInteger = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
};

const positiveNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Validate and canonicalise a deal draft. Only fields used by the selected
 * mechanic survive, so changing a deal type cannot persist hidden stale data.
 */
export function normaliseDealDraft(draft: Partial<Deal>): DealDraftResult {
  const name = String(draft.name || '').trim();
  const description = String(draft.description || '').trim();
  const badge = String(draft.badge || '').trim();
  const type = draft.type || 'bundle_price';
  const category = (draft.category || 'milkshakes') as MenuItem['category'];

  if (!name) return { ok: false, message: 'Give the deal a real name first.', tone: 'warning' };
  if (!description) return { ok: false, message: 'Add the customer-facing deal description.', tone: 'warning' };

  const base = { name, description, type, active: !!draft.active, ...(badge ? { badge } : {}) } as const;

  if (type === 'bundle_price') {
    const buyQty = positiveInteger(draft.buyQty);
    const bundlePrice = positiveNumber(draft.bundlePrice);
    if (buyQty === null || bundlePrice === null) {
      return { ok: false, message: 'A bundle deal needs a buy quantity and a positive bundle price.', tone: 'error' };
    }
    return { ok: true, value: { ...base, category, buyQty, bundlePrice } };
  }

  if (type === 'buy_x_get_y_free') {
    const buyQty = positiveInteger(draft.buyQty);
    const freeQty = positiveInteger(draft.freeQty);
    if (buyQty === null || freeQty === null) {
      return { ok: false, message: 'A buy/get deal needs valid buy and free quantities.', tone: 'error' };
    }
    return { ok: true, value: { ...base, category, buyQty, freeQty } };
  }

  if (type === 'percent_off_category') {
    const percentOff = Number(draft.percentOff);
    if (!Number.isFinite(percentOff) || percentOff < 1 || percentOff > 100) {
      return { ok: false, message: 'Percentage discount must be between 1 and 100.', tone: 'error' };
    }
    return { ok: true, value: { ...base, category, percentOff } };
  }

  const amountOff = positiveNumber(draft.amountOff);
  const minOrderValue = Number(draft.minOrderValue || 0);
  if (amountOff === null || !Number.isFinite(minOrderValue) || minOrderValue < 0) {
    return { ok: false, message: 'A fixed discount needs a positive amount and a valid minimum order.', tone: 'error' };
  }
  return {
    ok: true,
    value: { ...base, amountOff, ...(minOrderValue > 0 ? { minOrderValue } : {}) },
  };
}
