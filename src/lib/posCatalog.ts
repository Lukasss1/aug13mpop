/**
 * Catalogue publisher — integration plan Gate 9. Maps the website's menu
 * model onto the wire contract's CatalogSnapshot and publishes it through
 * the Owner-only publish_pos_catalog RPC.
 *
 * Mapping decisions (deliberate, documented):
 *  - Pounds → integer PENCE with Math.round; the tills only ever see
 *    integers (the contract's money rule).
 *  - Draft products remain in the snapshot as `active:false`, so a till can
 *    retain stable product identities without selling unpublished rows.
 *  - VAT is supplied by the caller from the commissioned store state and the
 *    owner-confirmed product tax classification. The safe default is 0 bp;
 *    this module never invents 20% VAT.
 *  - MODIFIERS ARE NOT PUBLISHED: the website has no modifier model, and
 *    the contract's absent-section rule means the till keeps its own
 *    modifier list untouched. Publishing an empty array would DELETE them.
 *  - Deals map field-for-field with pounds→pence on the money fields.
 */
import type { MenuItem, Deal } from '../types';
import type { CatalogSnapshot, CatalogCategory, CatalogProduct, CatalogDeal } from './posContract';
import { posRpcPublic, type PosRpcResult } from './posData';

const CATEGORY_LABELS: Record<MenuItem['category'], string> = {
  milkshakes: 'Milkshakes',
  smoothies: 'Smoothies',
  soft_serve: 'Soft Serve',
  slush: 'Slush',
  extras: 'Extras',
};

const toPence = (pounds: number | undefined): number | null =>
  typeof pounds === 'number' && Number.isFinite(pounds) ? Math.round(pounds * 100) : null;

export interface CatalogBuildOptions {
  /** Product rate in integer basis points. Safe default: 0 (NOT_REGISTERED). */
  vatRateBpForProduct?: (item: MenuItem) => number;
}

/** Pure: site menu + deals → the contract snapshot. Throws on invalid money or VAT. */
export function buildCatalogSnapshot(
  menuItems: MenuItem[],
  deals: Deal[],
  options: CatalogBuildOptions = {},
): CatalogSnapshot {
  const orderedSlugs = Object.keys(CATEGORY_LABELS) as MenuItem['category'][];
  const usedSlugs = orderedSlugs.filter((slug) => menuItems.some((m) => m.category === slug));

  const categories: CatalogCategory[] = usedSlugs.map((slug, i) => ({
    id: slug, name: CATEGORY_LABELS[slug], sortOrder: i, active: true,
  }));

  const products: CatalogProduct[] = menuItems.map((m, i) => {
    const basePricePence = toPence(m.price);
    const largePricePence = toPence(m.priceLarge ?? undefined);
    if (basePricePence === null || basePricePence < 0) {
      throw new Error(`Product "${m.name || m.id}" has an invalid base price.`);
    }
    if (largePricePence !== null && largePricePence < 0) {
      throw new Error(`Product "${m.name || m.id}" has an invalid large price.`);
    }
    const vatRateBp = options.vatRateBpForProduct?.(m) ?? 0;
    if (!Number.isInteger(vatRateBp) || vatRateBp < 0 || vatRateBp > 10_000) {
      throw new Error(`Product "${m.name || m.id}" has an invalid VAT rate.`);
    }
    return {
      id: m.id,
      categoryId: m.category,
      name: m.name,
      description: m.description ?? '',
      basePricePence,
      largePricePence,
      vatRateBp,
      allergens: m.allergens ?? [],
      active: Boolean(m.available),
      sortOrder: i,
    };
  });

  const catalogDeals: CatalogDeal[] = deals.map((d) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    active: d.active,
    ...(d.category ? { category: d.category } : {}),
    ...(d.buyQty != null ? { buyQty: d.buyQty } : {}),
    ...(toPence(d.bundlePrice) != null ? { bundlePricePence: toPence(d.bundlePrice)! } : {}),
    ...(d.freeQty != null ? { freeQty: d.freeQty } : {}),
    ...(d.percentOff != null ? { percentOff: d.percentOff } : {}),
    ...(toPence(d.amountOff) != null ? { amountOffPence: toPence(d.amountOff)! } : {}),
    ...(toPence(d.minOrderValue) != null ? { minOrderValuePence: toPence(d.minOrderValue)! } : {}),
    ...(d.badge ? { badge: d.badge } : {}),
  }));

  return { categories, products, deals: catalogDeals };
}

/** Owner: publish. Returns the new version number the tills will pull. */
export async function publishPosCatalog(
  accessToken: string,
  snapshot: CatalogSnapshot,
): Promise<PosRpcResult<number>> {
  const r = await posRpcPublic<number>('publish_pos_catalog', { p_snapshot: snapshot }, accessToken);
  if (r.status !== 'ok') return r;
  const version = Number(r.value);
  if (!Number.isFinite(version) || version < 1) {
    return { status: 'error', message: 'The database returned no version.' };
  }
  return { status: 'ok', value: version };
}
