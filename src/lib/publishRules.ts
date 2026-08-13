/**
 * publishRules.ts — pure, dependency-free publication rules.
 *
 * Shared by Admin (write-time validation) and the public site (rendering) so the
 * two can never drift apart. Every rule is a plain function of its input and is
 * unit-tested in scripts/publish-rules.test.ts.
 *
 * Guiding principle: nothing incomplete, unconfirmed or placeholder ("N/A")
 * reaches the public website.
 */

/** A genuine, owner-confirmed string: non-empty and not a common drafting
 * placeholder. Incomplete facts remain editable privately, but cannot become a
 * public address, vacancy, product name or legal claim by accident. */
const PLACEHOLDER_VALUES = new Set([
  'N/A', 'NA', 'NONE', 'NULL', 'TBC', 'TBD', 'TO BE CONFIRMED',
  'TO BE ANNOUNCED', 'COMING SOON', 'PLACEHOLDER', 'TEST', 'UNKNOWN', '-', '—',
]);
export const isReal = (value?: string): boolean => {
  const normalised = String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  return Boolean(normalised && !PLACEHOLDER_VALUES.has(normalised));
};

type StoreShape = {
  name?: string;
  address?: string;
  postcode?: string;
  openingHours?: string;
  status?: 'open' | 'closed' | 'coming_soon' | string;
};

/** Minimum genuine identity required for a store to appear publicly at all. */
export const hasRealStoreIdentity = (s: StoreShape): boolean =>
  isReal(s.name) && isReal(s.address) && isReal(s.postcode);

/** Everything required before a store may be shown as OPEN / set online. */
export const isCompletePublicStore = (s: StoreShape): boolean =>
  hasRealStoreIdentity(s) && isReal(s.openingHours);

type VacancyShape = {
  title?: string;
  location?: string;
  salary?: string;
  roleDescription?: string | undefined;
  type?: string | undefined;
};

/** A vacancy is public the moment it saves, so it must be complete and honest. */
export const isPublishableVacancy = (v: VacancyShape): boolean =>
  isReal(v.title) &&
  isReal(v.location) &&
  isReal(v.salary) &&
  isReal(v.roleDescription) &&
  (v.type === 'Full-time' || v.type === 'Part-time');

/** Accurate public status label — never mislabels a closed store as "Coming Soon". */
export const publicStoreStatusLabel = (status?: string): string =>
  status === 'open' ? 'Open' : status === 'closed' ? 'Closed' : 'Coming Soon';

/** The five public menu categories. A row with any other category value is not
 *  a publishable menu item (it would land in no MenuSection). */
export const MENU_CATEGORIES = ['milkshakes', 'smoothies', 'soft_serve', 'slush', 'extras'] as const;

type MenuShape = {
  id?: string;
  name?: string;
  category?: string;
  price?: number;
};

/** A menu item is public the moment it saves, so — exactly like a vacancy — it
 *  must carry genuine identity, a real category and a valid, non-negative price
 *  before it may appear on the site or in Menu structured data. This is the ONE
 *  definition Admin write-time validation, runtime rendering and the SEO
 *  generator all share (OPT-02-C1.2). */
export const isPublishableMenuItem = (m: MenuShape): boolean =>
  isReal(m.id) &&
  isReal(m.name) &&
  (MENU_CATEGORIES as readonly string[]).includes(String(m.category)) &&
  typeof m.price === 'number' &&
  Number.isFinite(m.price) &&
  m.price >= 0;
