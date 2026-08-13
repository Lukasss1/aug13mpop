/**
 * Shared COMPLETE draft-record fixtures for the publication suites.
 *
 * Why this file exists: publish_record now refuses to publish an incomplete
 * record (publication_completeness_errors), so every suite that drives the
 * SUCCESS path must create rows that satisfy the database-level floor. Two
 * suites need identical fixtures (the superuser mechanics matrix and the
 * real-role authorisation matrix); stating them twice is how fixtures drift.
 *
 * Each entry is a column→SQL-literal map that satisfies BOTH the table's
 * NOT NULL set and publication_completeness_errors(). Ids are provided by
 * the caller so a suite can create several distinct rows.
 */

/* INC11: the publication scope narrowed from six collections to FOUR — the
 * code-level review established that media_assets.is_public never governed
 * byte visibility (the menu-media bucket is public) and cms_pages drives no
 * public route. The supersession note lives in
 * migration_inc11_publication_scope.sql; the two retired tables stay listed
 * below so the matrices can PROVE their refusal. */
export const PUBLICATION_MATRIX = [
  { table: 'menu_items',    col: 'available', on: 'true',      off: 'false', view: 'menu_items_public' },
  { table: 'deals',         col: 'active',    on: 'true',      off: 'false', view: 'deals_public' },
  { table: 'news_posts',    col: 'status',    on: 'published', off: 'draft', view: 'news_posts_public' },
  { table: 'job_vacancies', col: 'status',    on: 'published', off: 'draft', view: 'job_vacancies_public' },
];

/** Collections REMOVED from the publication boundary in INC11 — every matrix
 *  asserts publish_record refuses them with the supersession message. */
export const RETIRED_PUBLICATION_TABLES = ['media_assets', 'cms_pages'];

/** Column → SQL literal for a COMPLETE (publishable) draft row. */
export function completeColumns(table, id) {
  switch (table) {
    case 'menu_items': return {
      id: `'${id}'`, name: `'Probe Shake'`, description: `'A complete probe product'`,
      category: `'milkshakes'`, price: '4.50', calories: '320',
      tags: `'[]'::jsonb`, allergens: `'[]'::jsonb`, image: `'/img/probe.webp'`,
    };
    case 'deals': return {
      id: `'${id}'`, name: `'Probe Bundle'`, description: `'Two for a fiver'`,
      type: `'bundle_price'`, category: `'milkshakes'`, buy_qty: '2', bundle_price: '5.00',
    };
    case 'news_posts': return {
      id: `'${id}'`, title: `'Probe Announcement'`, content: `'Something real happened.'`,
      category: `'Announcement'`, date: `'2026-07-28'`,
    };
    case 'cms_pages': return {
      id: `'${id}'`, page_name: `'probe'`, title: `'Probe Page'`,
      hero_headline: `'A real headline'`, seo_title: `'Probe — Milk Pop'`,
      seo_description: `'Probe page for the publication matrix'`,
    };
    case 'job_vacancies': return {
      id: `'${id}'`, title: `'Probe Barista'`, department: `'Front of House'`,
      location: `'Birmingham'`, salary: `'£12.50/hr'`, type: `'Part-time'`,
      role_description: `'Serve probe shakes with a smile'`,
      requirements: `'[]'::jsonb`, responsibilities: `'[]'::jsonb`,
    };
    case 'media_assets': return {
      id: `'${id}'`, name: `'probe.webp'`, folder: `'brand'`, size: `'12 KB'`,
      type: `'image/webp'`, uploaded_at: `'2026-07-28'`, url: `'https://cdn.milkpop.uk/probe.webp'`,
    };
    default: throw new Error(`no fixture for ${table}`);
  }
}

/** INSERT statement for a complete draft row (publication column left to its
 *  database default — that the default is the draft state is itself one of
 *  the properties under test). */
export function insertComplete(table, id) {
  const cols = completeColumns(table, id);
  return `insert into ${table} (${Object.keys(cols).join(', ')})
          values (${Object.values(cols).join(', ')})
          on conflict (id) do nothing`;
}
