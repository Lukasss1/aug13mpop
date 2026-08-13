/**
 * @file router.ts
 * @description URL routing for the Milk Pop SPA — every page and every
 * navigational action has a real, shareable URL.
 *
 * DESIGN
 * ------
 * The app's navigation model is a single string (`currentTab` in App.tsx).
 * Rather than adopting a routing library (and refactoring three very large
 * components around it), this module binds that string — plus a small,
 * typed bag of route params — to the browser URL with the History API:
 *
 *   tab 'menu'                          <->  /menu/
 *   tab 'stores'  + { store: 'milk-pop-solihull' }  <->  /stores/milk-pop-solihull/
 *   tab 'careers' + { job: 'shift-supervisor-v2' }  <->  /careers/shift-supervisor-v2/
 *   tab 'news'    + { post: '<slug>' }  <->  /news/<slug>/
 *   tab 'menu'    + { category, q }                  <->  /menu/?category=…&q=…
 *   POS is intentionally deferred; no /staff/pos route is exposed.
 *   tab 'admin_panel' + { section }     <->  /admin/<section>/
 *
 * Emitted paths always carry a trailing slash (see routeToPath) so the
 * canonical URL is a direct 200 on both Netlify and Cloudflare Pages;
 * parsing accepts both forms.
 *
 * SECURITY / SAFETY RULES
 * -----------------------
 * 1. Parsing is allowlist-based. Unknown paths resolve to the `not_found`
 *    tab (R4.7) and the address bar is NOT rewritten — the typed URL stays
 *    visible so the visitor can see what went wrong. Path segments are never
 *    trusted as tab names. Staff/admin sections are validated against fixed
 *    allowlists here AND role-validated again inside AdminPanel.
 * 2. Slugs/params are length-capped and character-filtered before use; they
 *    are only ever *matched against* known records (never rendered raw and
 *    never used to fetch anything), so a crafted URL can at worst show the
 *    default view.
 * 3. Nothing sensitive goes in the URL: no tokens, no form data, no search
 *    text beyond the public menu filter. Auth stays session-based —
 *    exposing /staff/* and /admin paths changes nothing (the same gates in
 *    App.tsx render the sign-in / access-restricted screens).
 * 4. This module is import-safe in Node (no window/document access at module
 *    scope) so the build-time SEO script can reuse the same route table.
 */

import { ADMIN_ROUTE_IDS } from './launchFeatures';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface RouteParams {
  /** Store slug for /stores/:slug (matched against store name/id). */
  store?: string;
  /** Vacancy slug for /careers/:slug. */
  job?: string;
  /** News post slug for /news/:slug. */
  post?: string;
  /** Admin section id for /admin/:section. */
  section?: string;
  /** Menu filters — carried as query params on /menu only. */
  category?: string;
  q?: string;
}

export interface RouteState {
  tab: string;
  params: RouteParams;
}

export interface NavigateOptions {
  /** Use replaceState (no history entry) — for filters and canonicalising. */
  replace?: boolean | undefined;
  /** Skip the scroll-to-top that push navigation performs. */
  keepScroll?: boolean;
}

/** The navigation function App.tsx provides to every component. It is
 *  assignable to the legacy `(tab: string) => void` prop shape, so existing
 *  call sites keep working unchanged. */
export type NavigateFn = (tab: string, params?: RouteParams, opts?: NavigateOptions) => void;

/* ------------------------------------------------------------------ */
/*  Route tables (single source of truth)                              */
/* ------------------------------------------------------------------ */

/** Public + legal tabs whose path is simply /<tab> (home is `/`). */
const SIMPLE_PUBLIC_TABS = [
  'menu', 'stores', 'careers', 'franchise', 'about', 'contact', 'news',
  'privacy', 'gdpr', 'fdd',
] as const;

/** Staff portal sections: tab `staff_<x>` <-> path /staff/<x>. */
export const STAFF_SECTIONS = [
  'dashboard', 'documents', 'checklists', 'academy', 'sifr', 'kb', 'login',
] as const;

/** Admin panel sections — DERIVED from the single launch-feature registry
 *  (src/lib/launchFeatures.ts) so the route allow-list and the sidebar can
 *  never drift again (audit finding #1/#7). Deferred (post_launch) features
 *  have no route; migration-only sections (`legacy-import`) are routable but
 *  visibility-gated in AdminPanel. Every section is still validated against the
 *  signed-in role inside AdminPanel itself. */
export const ADMIN_SECTIONS = ADMIN_ROUTE_IDS;

/** Tabs a search engine may index. Everything staff/admin is noindex. */
export function isIndexableTab(tab: string): boolean {
  return tab === 'home' || (SIMPLE_PUBLIC_TABS as readonly string[]).includes(tab);
}

/* ------------------------------------------------------------------ */
/*  Slug helpers                                                       */
/* ------------------------------------------------------------------ */

const MAX_SLUG_LENGTH = 80;

/** URL-safe slug from free text: "Milk Pop Solihull" -> "milk-pop-solihull". */
export function slugify(input: string): string {
  return (input || '')
    .normalize('NFKD')                 // é -> e + combining mark
    .replace(/[\u0300-\u036f]/g, '')   // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
}

/** Build one stable entity slug while preserving the full identifier suffix.
 *  `slugify(`${label}-${id}`)` is unsafe because the 80-character cap can cut
 *  the identifier off the end, making duplicate labels collide. Reserving the
 *  suffix first keeps every emitted slug round-trippable and unique without a
 *  hash service or routing framework. */
function entitySlug(label: string, id: string): string {
  const idPart = slugify(id);
  const labelPart = slugify(label);
  if (!idPart) return labelPart;
  if (!labelPart) return idPart;

  const maxLabelLength = Math.max(0, MAX_SLUG_LENGTH - idPart.length - 1);
  const boundedLabel = labelPart.slice(0, maxLabelLength).replace(/-+$/g, '');
  return boundedLabel ? `${boundedLabel}-${idPart}` : idPart;
}

/** Slug for a store — label for readability, full id for uniqueness. */
export function storeSlug(store: { id: string; name: string }): string {
  return entitySlug(store.name, store.id);
}

/** Slug for a vacancy — title for readability, full id for uniqueness. */
export function vacancySlug(job: { id: string; title: string }): string {
  return entitySlug(job.title, job.id);
}

/** Slug for a news post. INC11: once a post is published the server freezes
 *  its address into post.slug — that stored value is canonical everywhere
 *  (paths, matching, sitemap, prerender). Drafts have no stored slug yet and
 *  use the same bounded title-plus-id rule as other entities. */
export function postSlug(post: { id: string; title: string; slug?: string | null }): string {
  if (post.slug) return slugify(post.slug);
  return entitySlug(post.title, post.id);
}

/** Find a record whose derived slug OR raw id matches. Returns undefined for
 *  unknown slugs — callers fall back to the list view (never an error). */
export function matchBySlug<T>(
  list: readonly T[] | undefined,
  slug: string | undefined,
  getSlug: (item: T) => string,
  getId: (item: T) => string,
): T | undefined {
  if (!slug || !list) return undefined;
  const clean = slugify(slug);
  return list.find((item) => getSlug(item) === clean || slugify(getId(item)) === clean);
}

/* ------------------------------------------------------------------ */
/*  Param sanitisation                                                 */
/* ------------------------------------------------------------------ */

function cleanSegment(raw: string): string {
  let value = raw;
  try { value = decodeURIComponent(raw); } catch { /* keep raw if malformed */ }
  return slugify(value);
}

function cleanQueryValue(raw: string | null): string | undefined {
  if (!raw) return undefined;
  // Free-text query values (menu search): strip control chars, cap length.
  // eslint-disable-next-line no-control-regex
  const value = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return value || undefined;
}

/* ------------------------------------------------------------------ */
/*  URL -> route                                                       */
/* ------------------------------------------------------------------ */

/** Parse a location into a RouteState. Unknown paths become the home tab —
 *  App canonicalises the URL afterwards with `replace`. */
export function pathToRoute(pathname: string, search = ''): RouteState {
  const segments = pathname.split('/').map(cleanSegment).filter(Boolean);
  const searchParams = new URLSearchParams(search);

  if (segments.length === 0) return { tab: 'home', params: {} };

  const [head, second] = segments;

  // /staff and /staff/<section>
  if (head === 'staff') {
    if (!second) return { tab: 'staff_dashboard', params: {} };
    if (second === 'mfa') return { tab: 'staff_login', params: {} }; // MFA is an auth interstitial, not a page
    if ((STAFF_SECTIONS as readonly string[]).includes(second)) {
      return { tab: `staff_${second}`, params: {} };
    }
    return { tab: 'staff_dashboard', params: {} };
  }

  // /admin and /admin/<section>
  if (head === 'admin') {
    if (second && (ADMIN_SECTIONS as readonly string[]).includes(second)) {
      return { tab: 'admin_panel', params: { section: second } };
    }
    return { tab: 'admin_panel', params: {} };
  }

  // /stores/:slug — /careers/:slug — /news/:slug
  if (head === 'stores' && second) return { tab: 'stores', params: { store: second } };
  if (head === 'careers' && second) return { tab: 'careers', params: { job: second } };
  if (head === 'news' && second) return { tab: 'news', params: { post: second } };

  // /menu (+ shareable filter query params)
  if (head === 'menu') {
    const params: RouteParams = {};
    const category = cleanSegment(searchParams.get('category') || '');
    const q = cleanQueryValue(searchParams.get('q'));
    if (category && category !== 'all') params.category = category;
    if (q) params.q = q;
    return { tab: 'menu', params };
  }

  // Remaining single-segment public/legal pages
  if (head && !second && (SIMPLE_PUBLIC_TABS as readonly string[]).includes(head)) {
    return { tab: head, params: {} };
  }

  // R4.7: anything else is NOT the homepage.
  //
  // This used to return `home`, and App.tsx then rewrote the URL to '/'. The
  // effect was a soft 404: every typo, stale link and crawler-invented URL
  // resolved to a 200 response carrying the homepage's content, title and
  // canonical. Google treats that as a quality problem — junk URLs get indexed
  // as near-duplicates of the real homepage — and a person following a broken
  // link got no signal at all that the link was wrong.
  //
  // The SPA fallback in netlify.toml still has to answer 200 for every path,
  // because a cold load of a real route like /menu/ depends on it. What we can
  // control is what the app SAYS about the page: an explicit not-found route,
  // rendered as a not-found view and marked noindex. That is exactly Google's
  // documented remedy for JavaScript sites that cannot return a 404 status.
  return { tab: 'not_found', params: {} };
}

/* ------------------------------------------------------------------ */
/*  Route -> URL                                                       */
/* ------------------------------------------------------------------ */

/** Build the full path (incl. menu filter query) for a tab + params.
 *
 *  CANONICAL URL FORM: every non-home path ends with a trailing slash
 *  (`/menu/`, `/stores/milk-pop-solihull/`). The prerenderer writes pages as
 *  `dist/<route>/index.html`, and Cloudflare Pages 308-redirects the
 *  slash-less form to the directory (`/menu` → `/menu/`) while Netlify serves
 *  both as 200 — the slashed form is the one URL that is a direct 200 on
 *  every host, so canonicals never point at redirects. `pathToRoute` already
 *  tolerates both forms (`filter(Boolean)`), and the boot canonicaliser in
 *  App.tsx rewrites slash-less entry URLs automatically. */
export function routeToPath(tab: string, params: RouteParams = {}): string {
  if (tab === 'home') return '/';

  // R4.7: `not_found` deliberately has NO canonical path. Callers must not
  // rewrite the address bar for it — the URL the visitor typed or followed is
  // the one piece of information that tells them what went wrong. Returning
  // the current pathname keeps every caller honest; on a server (no window)
  // it degrades to '/' because there is no address bar to preserve.
  if (tab === 'not_found') {
    return typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search;
  }

  if (tab === 'menu') {
    const qs = new URLSearchParams();
    if (params.category && params.category !== 'all') qs.set('category', params.category);
    if (params.q) qs.set('q', params.q);
    const query = qs.toString();
    return query ? `/menu/?${query}` : '/menu/';
  }

  if (tab === 'stores') return params.store ? `/stores/${slugify(params.store)}/` : '/stores/';
  if (tab === 'careers') return params.job ? `/careers/${slugify(params.job)}/` : '/careers/';
  if (tab === 'news') return params.post ? `/news/${slugify(params.post)}/` : '/news/';

  if ((SIMPLE_PUBLIC_TABS as readonly string[]).includes(tab)) return `/${tab}/`;

  if (tab === 'admin_panel') {
    const section = params.section && (ADMIN_SECTIONS as readonly string[]).includes(params.section)
      ? params.section
      : undefined;
    return section && section !== 'dashboard' ? `/admin/${section}/` : '/admin/';
  }

  if (tab === 'staff_mfa') return '/staff/login/'; // never emit a dedicated MFA URL
  if (tab.startsWith('staff_')) {
    const section = tab.slice('staff_'.length);
    if (section === 'dashboard') return '/staff/';
    if ((STAFF_SECTIONS as readonly string[]).includes(section)) return `/staff/${section}/`;
    return '/staff/';
  }

  return '/';
}

/** Canonical path for SEO: like routeToPath but WITHOUT filter query params
 *  (a filtered /menu still canonicalises to /menu; detail slugs are kept
 *  because each store/job/post detail IS its own canonical page). */
export function canonicalPathFor(tab: string, params: RouteParams = {}): string {
  const { category: _c, q: _q, ...rest } = params;
  return routeToPath(tab, rest);
}

/* ------------------------------------------------------------------ */
/*  Browser helpers (safe: only touch window/document when called)     */
/* ------------------------------------------------------------------ */

/** Read the initial route from the current location (home on non-browser). */
export function readInitialRoute(): RouteState {
  if (typeof window === 'undefined') return { tab: 'home', params: {} };
  return pathToRoute(window.location.pathname, window.location.search);
}

/**
 * Click handler for internal `<a href>` links: lets the browser handle
 * modified clicks (new tab / window / download) and takes over plain left
 * clicks for instant SPA navigation.
 */
export function handleAnchorNav(
  e: { defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void },
  navigate: () => void,
): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate();
}

interface HeadMeta {
  title?: string | undefined;
  description?: string | undefined;
  canonicalPath: string;
  noindex: boolean;
}

function upsertMeta(selector: string, create: () => HTMLElement, content: string): void {
  let el = document.head.querySelector(selector) as HTMLElement | null;
  if (!el) { el = create(); document.head.appendChild(el); }
  el.setAttribute('content', content);
}

/**
 * Keep the document head in sync during SPA navigation: title, description,
 * canonical link, robots directive and the og:/twitter mirrors. Build-time
 * generated pages carry the same values in static HTML for crawlers; this
 * keeps the live DOM correct as the visitor moves around.
 */
export function applyHeadMeta({ title, description, canonicalPath, noindex }: HeadMeta): void {
  if (typeof document === 'undefined') return;

  if (title) {
    document.title = title;
    upsertMeta('meta[property="og:title"]', () => { const m = document.createElement('meta'); m.setAttribute('property', 'og:title'); return m; }, title);
    upsertMeta('meta[name="twitter:title"]', () => { const m = document.createElement('meta'); m.setAttribute('name', 'twitter:title'); return m; }, title);
  }

  if (description) {
    upsertMeta('meta[name="description"]', () => { const m = document.createElement('meta'); m.setAttribute('name', 'description'); return m; }, description);
    upsertMeta('meta[property="og:description"]', () => { const m = document.createElement('meta'); m.setAttribute('property', 'og:description'); return m; }, description);
    upsertMeta('meta[name="twitter:description"]', () => { const m = document.createElement('meta'); m.setAttribute('name', 'twitter:description'); return m; }, description);
  }

  const url = window.location.origin + canonicalPath;
  let canonical = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.setAttribute('rel', 'canonical');
    document.head.appendChild(canonical);
  }
  canonical.setAttribute('href', url);
  upsertMeta('meta[property="og:url"]', () => { const m = document.createElement('meta'); m.setAttribute('property', 'og:url'); return m; }, url);

  let robots = document.head.querySelector('meta[name="robots"]') as HTMLMetaElement | null;
  if (noindex) {
    if (!robots) {
      robots = document.createElement('meta');
      robots.setAttribute('name', 'robots');
      document.head.appendChild(robots);
    }
    robots.setAttribute('content', 'noindex, nofollow');
  } else if (robots) {
    robots.remove();
  }
}
