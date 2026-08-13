/**
 * @file publicProjection.ts
 * SMALL-BIZ CLOSURE P0-2 — PUBLIC PARITY WHILE STAFF ARE SIGNED IN.
 *
 * Anonymously, every public collection is read from a filtered database view
 * (menu_items_public, stores_public, job_vacancies_public, news_posts_public,
 * deals_public), so a customer can only ever see published/active/ACTIVE
 * records. While an employee is signed in, authenticated hydration replaces
 * those arrays with the COMPLETE administrative collections — drafts,
 * coming-soon stores, unpublished vacancies — and the public routes rendered
 * whatever they were handed. The menu was already filtered at the prop
 * boundary; stores, vacancies, news and deals were not, so a signed-in owner
 * browsing the public site saw records no customer could see.
 *
 * This module is the ONE place the anonymous filter rules exist client-side.
 * Each function applies exactly the predicate of its database view (the view
 * definitions are quoted beside each rule). App.tsx applies these at the
 * single point where authenticated state is passed into PublicPages, so the
 * signed-in public site and the anonymous public site show identical
 * published records — drafts stay visible in Admin and nowhere else.
 *
 * Frontend filtering remains DEFENCE IN DEPTH, never the confidentiality
 * boundary (standing instruction 6): anonymously the database view has
 * already filtered before the client sees anything.
 */
import type { MenuItem, StoreLocation, CareerVacancy, NewsPost, Deal } from '../types';
import { hasRealStoreIdentity } from './publishRules';

/* Menu and News differ from Vacancies and Deals on purpose: menu_items_public
   DOES return `available` and news_posts_public DOES return `status` (see the
   SELECT lists in scripts/load-public-content.ts), so for those two an absent
   flag is not an expected anonymous shape and the strict test is correct.
   The rule is per-view, verified against each view's actual column list — not
   a blanket policy. */

/** menu_items_public: `where available = true` (the view RETURNS `available`). */
export function projectPublicMenuItems(items: MenuItem[]): MenuItem[] {
  return items.filter((m) => m.available === true);
}

/** stores_public: genuine public identity only.
 *  Public listing and POS/trading commissioning are intentionally separate:
 *  a real `coming_soon` location may appear before tills, VAT or payment
 *  methods are configured. The same shared identity predicate is used for
 *  authenticated rows so signed-in staff see exactly what customers see. */
export function projectPublicStores(stores: StoreLocation[]): StoreLocation[] {
  return stores.filter(hasRealStoreIdentity);
}

/** job_vacancies_public: `where status = 'published'` — and the view does NOT
 *  return the `status` column, so an anonymous row arrives with
 *  `status === undefined`. Absent flag ⇒ the row came through the filtered
 *  view and is public by construction; an explicit value only ever exists on
 *  an authenticated administrative row, where draft/closed must be removed.
 *  (T12 filtered on `status === 'published'` alone, which stripped EVERY
 *  anonymous vacancy — the careers page told customers there were no open
 *  roles while real vacancies were published.) */
export function projectPublicVacancies(vacancies: CareerVacancy[]): CareerVacancy[] {
  return vacancies
    .filter((v) => v.status === undefined || v.status === 'published')
    // Normalise the intentionally omitted projection flag so downstream UI can
    // use the ordinary administrative type without treating a public row as a
    // draft merely because the view proved publication by row selection.
    .map((v) => v.status === undefined ? { ...v, status: 'published' as const } : v);
}

/** news_posts_public: `where status = 'published'`. */
export function projectPublicNews(posts: NewsPost[]): NewsPost[] {
  return posts.filter((p) => p.status === 'published');
}

/** deals_public: `where active = true` — and, like the vacancies view, it does
 *  NOT return the `active` column, so an anonymous row arrives with
 *  `active === undefined`. Same rule: absent flag ⇒ already filtered by the
 *  view; an explicit `false` only exists on an authenticated row. (T12's
 *  `active === true` removed every anonymous deal from the public site.) */
export function projectPublicDeals(deals: Deal[]): Deal[] {
  return deals
    .filter((d) => d.active === undefined || d.active === true)
    // deals_public omits `active`; row presence is the proof that it is active.
    // Restore the invariant expected by the customer cards and POS helpers.
    .map((d) => d.active === undefined ? { ...d, active: true } : d);
}
