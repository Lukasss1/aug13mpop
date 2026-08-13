/**
 * @file publicContentSnapshot.ts
 * @description ONE canonical, environment-independent definition of the public
 * content the website presents, shared by:
 *
 *   • the runtime (Admin "SEO sync" panel) — hashes the live hydrated content;
 *   • the build-time SEO generator (scripts/prerender-seo.ts) — turns a
 *     snapshot into static pages, sitemap and JSON-LD;
 *   • the production Supabase loader (scripts/load-public-content.ts) — builds
 *     a snapshot from the same public rows an anonymous visitor can read;
 *   • the post-deployment parity check (scripts/seo-live-parity.mjs).
 *
 * Because every one of those paths flows through the SAME filter, sort, project
 * and hash functions here, the static crawler content and the live database can
 * be proven equal by a single 32-hex-character content hash. Nothing in this
 * file touches the network, the filesystem, `window`, `Deno` or Node globals —
 * it is pure so it runs identically in the browser, in tsx and in Deno.
 *
 * SOURCE OF TRUTH: in production this snapshot is built from Supabase. Bundled
 * seed defaults are a DEVELOPMENT-ONLY fallback (see load-public-content.ts),
 * never the production source. This module deliberately imports NO seed data.
 *
 * PUBLICATION RULES: the "what may appear publicly" predicates all come from
 * src/lib/publishRules.ts — Admin, runtime and SEO never diverge on what a
 * valid store, vacancy or menu item is.
 */
import type { SiteSettings, StoreLocation, CareerVacancy, NewsPost, MenuItem } from '../types';
import type { SiteContent, PublicPageKey } from '../siteContent';
import {
  isReal,
  hasRealStoreIdentity,
  isPublishableVacancy,
  isPublishableMenuItem,
  MENU_CATEGORIES,
} from './publishRules';
import { safeExternalHref, safeMailtoHref, safeTelHref } from './safeUrl';
import { sortMenuItems, sortStores, sortVacancies, sortNews } from './publicOrdering';
export { sortMenuItems, sortStores, sortVacancies, sortNews } from './publicOrdering';

const s = (v: unknown): string => String(v ?? '');

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Optional DB timestamps carried on a record. Never part of the content hash
 *  (the canonical projection is an allow-list) — used only for JSON-LD
 *  `datePosted`/`datePublished` and the manifest `latestUpdatedAt`. */
export interface RecordTimestamps {
  updatedAt?: string;
  createdAt?: string;
}

export type SnapshotStore = StoreLocation & RecordTimestamps;
export type SnapshotVacancy = CareerVacancy & RecordTimestamps;
export type SnapshotNews = NewsPost & RecordTimestamps;

/** The exact public content consumed by BOTH runtime publication rules and the
 *  SEO generator. Collections here are already filtered, normalised and sorted. */
export interface PublicContentSnapshot {
  siteSettings: SiteSettings;
  /** ALWAYS hydrated (defaults merged) before it reaches a snapshot, so the
   *  loader and the browser project identical SEO/legal text. */
  siteContent: SiteContent;
  menuItems: MenuItem[];
  stores: SnapshotStore[];
  vacancies: SnapshotVacancy[];
  newsPosts: SnapshotNews[];
}

export type SnapshotSource = 'supabase' | 'development-defaults';

export interface PublicContentSnapshotMetadata {
  source: SnapshotSource;
  generatedAt: string;
  contentHash: string;
  latestUpdatedAt: Record<string, string | null>;
  counts: {
    menuItems: number;
    stores: number;
    vacancies: number;
    publishedNewsPosts: number;
  };
}

/** Raw-ish inputs used to assemble a snapshot (from Supabase rows or in-memory
 *  registries). `siteContent` MUST already be hydrated. */
export interface PublicContentSnapshotInput {
  siteSettings: SiteSettings;
  siteContent: SiteContent;
  menuItems: MenuItem[];
  stores: SnapshotStore[];
  vacancies: SnapshotVacancy[];
  newsPosts: SnapshotNews[];
}

/* ------------------------------------------------------------------ */
/*  Deterministic ordering                                             */
/*                                                                     */
/*  Changing PostgREST response order must NOT change the content hash */
/*  or the generated route inventory — so everything is sorted before  */
/*  hashing and prerendering.                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Public-record filtering (shared publication rules ONLY)            */
/* ------------------------------------------------------------------ */

/** Stores that may appear publicly at all. A `closed` store MAY remain listed
 *  (its status stays 'closed'); only genuinely incomplete records are removed. */
export const publishableStores = (stores: SnapshotStore[]): SnapshotStore[] =>
  stores.filter(hasRealStoreIdentity);

export const publishableVacancies = (vacancies: SnapshotVacancy[]): SnapshotVacancy[] =>
  vacancies.filter((v) =>
    (v.status === undefined || v.status === 'published')
    && isPublishableVacancy(v),
  );

export const publishedNewsPosts = (posts: SnapshotNews[]): SnapshotNews[] =>
  posts.filter((p) => p.status === 'published');

export const publishableMenuItems = (items: MenuItem[]): MenuItem[] =>
  items.filter((m) =>
    (m.available === undefined || m.available === true)
    && isPublishableMenuItem(m),
  );

/* ------------------------------------------------------------------ */
/*  Snapshot assembly                                                  */
/* ------------------------------------------------------------------ */

/** Assemble a filtered, normalised, deterministically-sorted snapshot from
 *  raw inputs. Both the Supabase loader and the browser call this so their
 *  hashes are comparable. */
export function buildPublicContentSnapshot(input: PublicContentSnapshotInput): PublicContentSnapshot {
  return {
    siteSettings: input.siteSettings,
    siteContent: input.siteContent,
    menuItems: sortMenuItems(publishableMenuItems(input.menuItems || [])),
    stores: sortStores(publishableStores(input.stores || [])),
    vacancies: sortVacancies(publishableVacancies(input.vacancies || [])),
    newsPosts: sortNews(publishedNewsPosts(input.newsPosts || [])),
  };
}

/* ------------------------------------------------------------------ */
/*  Normalisation helpers (shared with the SEO generator)             */
/* ------------------------------------------------------------------ */

/** Canonical host form of a website value: protocol-less, lower-case, no
 *  trailing slash — so 'MILKPOP.UK', 'https://milkpop.uk/' and 'milkpop.uk'
 *  all hash the same. */
export const normalizeWebsite = (value?: string): string =>
  s(value).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();

/** Meta-description derived from a legal-page body — the EXACT transform the
 *  prerenderer emits, so a body edit past 155 chars can't create a phantom
 *  "out of date" state. */
export const legalDescription = (body?: string): string =>
  s(body).replace(/\s+/g, ' ').trim().slice(0, 155);

/** News/article meta-description — first 155 chars, matching the prerenderer. */
export const articleDescription = (content?: string): string => s(content).slice(0, 155);

/** Genuine geo coordinates, or null. A store row without coordinates ships an
 *  EMPTY object (`coordinates jsonb default '{}'`), so a plain truthiness check
 *  would wrongly emit `latitude: NaN`. Both the hash and the LocalBusiness geo
 *  block use this, so a store without real coordinates never produces geo
 *  JSON-LD and never desyncs the hash. */
export const validCoordinates = (coords: unknown): { lat: number; lng: number } | null => {
  if (!coords || typeof coords !== 'object') return null;
  const c = coords as { lat?: unknown; lng?: unknown };
  const lat = Number(c.lat);
  const lng = Number(c.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
};

/** The genuine social profile URLs, in a FIXED order (empty ones omitted).
 *  Both the Organization JSON-LD and the hash use this, so ordering can never
 *  desync them. */
export const socialProfiles = (settings: SiteSettings): string[] =>
  [settings.instagramUrl, settings.facebookUrl, settings.twitterUrl]
    .map((value) => safeExternalHref(value))
    .filter((value): value is string => Boolean(value));

/** A brand label is not automatically a registered legal name. Omit the
 *  legalName JSON-LD field when it merely repeats the public brand. */
export const publicLegalName = (settings: SiteSettings): string => {
  const legal = s(settings.legalName).trim();
  const brand = s(settings.brandName).trim();
  if (!isReal(legal)) return '';
  return legal.toLocaleLowerCase('en-GB') === brand.toLocaleLowerCase('en-GB') ? '' : legal;
};

/* ------------------------------------------------------------------ */
/*  Canonical projection + content hash                                */
/* ------------------------------------------------------------------ */

const PAGE_KEYS: readonly PublicPageKey[] = [
  'home', 'menu', 'stores', 'careers', 'franchise', 'about', 'contact', 'news',
];
const LEGAL_KEYS = ['privacy', 'gdpr', 'fdd'] as const;

/** The complete customer-visible slice of the snapshot. The build writes both
 *  static crawler pages and public-content.json (the runtime last-known-good
 *  fallback), so the hash must change for every value that changes either
 *  output — not only title/meta fields. Administrative fields and timestamps
 *  stay excluded so private edits never make the public build look stale. */
export function canonicalProjection(snapshot: PublicContentSnapshot): Record<string, unknown> {
  const settings = snapshot.siteSettings;
  const content = snapshot.siteContent;

  const seo: Record<string, { title: string; description: string }> = {};
  for (const key of PAGE_KEYS) {
    const page = content.seo?.[key];
    seo[key] = { title: s(page?.title), description: s(page?.description) };
  }

  const legal: Record<string, { title: string; description: string }> = {};
  for (const key of LEGAL_KEYS) {
    const block = content.legal?.[key];
    legal[key] = { title: s(block?.title), description: legalDescription(block?.body) };
  }

  return {
    settings: {
      brandName: s(settings.brandName),
      legalName: publicLegalName(settings),
      companyNumber: isReal(settings.companyNumber) ? s(settings.companyNumber) : '',
      hqAddress: isReal(settings.hqAddress) ? s(settings.hqAddress) : '',
      email: safeMailtoHref(settings.email) ? s(settings.email).trim() : '',
      gdprEmail: safeMailtoHref(settings.gdprEmail) ? s(settings.gdprEmail).trim() : '',
      phone: safeTelHref(settings.phone) ? s(settings.phone).trim() : '',
      website: normalizeWebsite(settings.websiteUrl),
      instagramHandle: isReal(settings.instagramHandle) ? s(settings.instagramHandle) : '',
      sameAs: socialProfiles(settings),
      footerTagline: s(settings.footerTagline),
      allergenNotice: s(settings.allergenNotice),
      announcementEnabled: Boolean(settings.announcementEnabled && s(settings.announcementText).trim()),
      announcementText: settings.announcementEnabled ? s(settings.announcementText).trim() : '',
      currencySymbol: s(settings.currencySymbol),
      defaultOpeningHours: s(settings.defaultOpeningHours),
      showCareers: Boolean(settings.showCareers),
      showFranchise: Boolean(settings.showFranchise),
      showNews: Boolean(settings.showNews),
    },
    // Hydrated website copy contains only customer-editable public content.
    // stableSerialize() sorts every nested key deterministically.
    siteContent: content,
    seo,
    legal,
    menuItems: snapshot.menuItems.map((m) => ({
      id: s(m.id),
      name: s(m.name),
      description: s(m.description),
      category: (MENU_CATEGORIES as readonly string[]).includes(String(m.category)) ? m.category : '',
      price: Number(m.price),
      priceLarge: typeof m.priceLarge === 'number' && Number.isFinite(m.priceLarge) ? m.priceLarge : null,
      calories: typeof m.calories === 'number' && Number.isFinite(m.calories) ? m.calories : null,
      tags: (m.tags || []).map(s),
      allergens: (m.allergens || []).map(s),
      image: s(m.image),
    })),
    stores: snapshot.stores.map((store) => ({
      id: s(store.id),
      name: s(store.name),
      address: s(store.address),
      postcode: isReal(store.postcode) ? store.postcode : '',
      openingHours: isReal(store.openingHours) ? store.openingHours : '',
      status: s(store.status),
      phone: isReal(store.phone) ? store.phone : '',
      email: isReal(store.email) ? store.email : '',
      image: s(store.image),
      deliveryLinks: store.deliveryLinks || {},
      coordinates: validCoordinates(store.coordinates),
    })),
    vacancies: snapshot.vacancies.map((v) => ({
      id: s(v.id),
      title: s(v.title),
      department: s(v.department),
      location: s(v.location),
      salary: s(v.salary),
      type: s(v.type),
      roleDescription: s(v.roleDescription),
      requirements: (v.requirements || []).map(s),
      responsibilities: (v.responsibilities || []).map(s),
    })),
    newsPosts: snapshot.newsPosts.map((p) => ({
      id: s(p.id),
      title: s(p.title),
      content: s(p.content),
      category: s(p.category),
      date: s(p.date),
      image: s(p.image),
      tagColor: s(p.tagColor),
    })),
  };
}

/** Stable, key-sorted serialization — the input to the hash. Identical output
 *  in Node and the browser for the same object. */
export function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stableSerialize(obj[k]))
      .join(',') +
    '}'
  );
}

/**
 * cyrb128 — a fast, synchronous, dependency-free 128-bit hash. Deterministic
 * and byte-for-byte identical in Node, tsx, the browser and Deno (only
 * `Math.imul` + `charCodeAt`, no crypto/env). This is change-detection, not a
 * security primitive; a 128-bit digest makes accidental collisions between two
 * different public-content states astronomically unlikely.
 */
export function hashString(str: string): string {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h1) + hex(h2) + hex(h3) + hex(h4);
}

/** The one content hash used everywhere: hash(stableSerialize(projection)). */
export function canonicalContentHash(snapshot: PublicContentSnapshot): string {
  return hashString(stableSerialize(canonicalProjection(snapshot)));
}

/* ------------------------------------------------------------------ */
/*  Counts + validation                                                */
/* ------------------------------------------------------------------ */

export function snapshotCounts(snapshot: PublicContentSnapshot): PublicContentSnapshotMetadata['counts'] {
  return {
    menuItems: snapshot.menuItems.length,
    stores: snapshot.stores.length,
    vacancies: snapshot.vacancies.length,
    publishedNewsPosts: snapshot.newsPosts.length,
  };
}

/** Validate a snapshot's public content. Returns human-readable errors; an
 *  empty array means valid. In production the loader treats any error as a
 *  build failure (fail-closed). */
export function validatePublicContentSnapshot(snapshot: PublicContentSnapshot): string[] {
  const errors: string[] = [];

  // Required singletons.
  const settings = snapshot.siteSettings;
  if (!settings || typeof settings !== 'object') {
    errors.push('site_settings row is missing.');
  } else if (!isReal(settings.brandName) && !isReal(settings.legalName)) {
    errors.push('site_settings has neither a brand name nor a legal name.');
  }

  const content = snapshot.siteContent;
  if (!content || typeof content !== 'object') {
    errors.push('site_content row is missing.');
  } else {
    if (!content.seo) errors.push('site_content.seo is missing.');
    else {
      for (const key of PAGE_KEYS) {
        const page = content.seo[key];
        if (!page || !isReal(page.title) || !isReal(page.description)) {
          errors.push(`site_content.seo.${key} is incomplete.`);
        }
      }
    }
    if (!content.legal) errors.push('site_content.legal is missing.');
    else {
      for (const key of LEGAL_KEYS) {
        const block = content.legal[key];
        if (!block || !isReal(block.title) || !isReal(block.body)) {
          errors.push(`site_content.legal.${key} is incomplete.`);
        }
      }
    }
  }

  // Collections must already satisfy the shared publication rules.
  snapshot.stores.forEach((store, i) => {
    if (!hasRealStoreIdentity(store)) errors.push(`stores[${i}] (${s(store.name)}) has no real identity.`);
  });
  snapshot.vacancies.forEach((v, i) => {
    if (!isPublishableVacancy(v)) errors.push(`vacancies[${i}] (${s(v.title)}) is not publishable.`);
  });
  snapshot.newsPosts.forEach((p, i) => {
    if (p.status !== 'published') errors.push(`newsPosts[${i}] (${s(p.title)}) is not published.`);
  });
  snapshot.menuItems.forEach((m, i) => {
    if (!isPublishableMenuItem(m)) errors.push(`menuItems[${i}] (${s(m.name)}) is not a valid menu item.`);
  });

  return errors;
}
