/**
 * Deterministic ordering for every public collection.
 *
 * PostgREST does not guarantee row order without an explicit order clause.
 * Runtime hydration and build-time SEO both use these pure helpers so the
 * customer site, prerendered pages and canonical content hash stay aligned.
 */

type MenuOrderRow = { id?: unknown; category?: unknown; name?: unknown };
type StoreOrderRow = { id?: unknown; name?: unknown };
type VacancyOrderRow = { id?: unknown; title?: unknown; createdAt?: unknown };
type NewsOrderRow = { id?: unknown; title?: unknown; date?: unknown };

const MENU_CATEGORY_ORDER = new Map<string, number>([
  ['milkshakes', 0],
  ['smoothies', 1],
  ['soft_serve', 2],
  ['slush', 3],
  ['extras', 4],
]);

const text = (value: unknown): string => String(value ?? '').trim().toLowerCase();
const compareText = (a: unknown, b: unknown): number => {
  const left = text(a);
  const right = text(b);
  return left < right ? -1 : left > right ? 1 : 0;
};
const compareTextDescending = (a: unknown, b: unknown): number => compareText(b, a);
const categoryRank = (value: unknown): number => MENU_CATEGORY_ORDER.get(text(value)) ?? Number.MAX_SAFE_INTEGER;

/** Menu → business category order, then product name, then id. */
export const sortMenuItems = <T extends MenuOrderRow>(items: readonly T[]): T[] =>
  [...items].sort((a, b) =>
    categoryRank(a.category) - categoryRank(b.category)
    || compareText(a.name, b.name)
    || compareText(a.id, b.id),
  );

/** Stores → name, then id. */
export const sortStores = <T extends StoreOrderRow>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));

/** Vacancies → newest creation first, then title, then id. */
export const sortVacancies = <T extends VacancyOrderRow>(items: readonly T[]): T[] =>
  [...items].sort((a, b) =>
    compareTextDescending(a.createdAt, b.createdAt)
    || compareText(a.title, b.title)
    || compareText(a.id, b.id),
  );

/** News → newest published date first, then title, then id. */
export const sortNews = <T extends NewsOrderRow>(items: readonly T[]): T[] =>
  [...items].sort((a, b) =>
    compareTextDescending(a.date, b.date)
    || compareText(a.title, b.title)
    || compareText(a.id, b.id),
  );
