/**
 * @file load-public-content.ts
 * @description Build-time loader for the public-content snapshot the SEO
 * generator turns into static pages. It is the ONE place that decides where the
 * snapshot comes from:
 *
 *   production   → Supabase is the source of truth. Fetches the public rows with
 *                  the ANON key under the same RLS boundary an anonymous visitor
 *                  sees, validates them, and FAILS THE BUILD if the database
 *                  cannot be read or the content is invalid. Seed fallback is
 *                  impossible here.
 *   preview/dev  → uses Supabase when configured; otherwise falls back to the
 *                  bundled seed defaults, clearly stamped source:
 *                  'development-defaults'. A production deploy can never enter
 *                  this branch (the mode gate + the fail-closed rules above).
 *   fixture/mock → CI simulates a PostgREST database (fixture JSON or a mock
 *                  base URL) so production behaviour is testable without ever
 *                  touching the real Milk Pop project.
 *
 * SECURITY: only the anon key is ever used. No service-role key, no private
 * tables, explicit `select=` column lists (never select=*), request timeouts,
 * and credentials are never logged or written to the manifest.
 *
 * Node/tsx module. Imports the bundled seeds ONLY for the development fallback —
 * scripts/prerender-seo.ts imports THIS loader, never the seeds directly.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SITE_CONTENT, hydrateSiteContent } from '../src/siteContent';
import { INITIAL_MENU_ITEMS, INITIAL_SETTINGS, INITIAL_STORES, INITIAL_JOBS } from '../src/data';
import { INITIAL_NEWS_POSTS } from '../src/defaultState';
import {
  buildPublicContentSnapshot,
  canonicalContentHash,
  snapshotCounts,
  validatePublicContentSnapshot,
} from '../src/lib/publicContentSnapshot';
import type {
  PublicContentSnapshot,
  PublicContentSnapshotMetadata,
  PublicContentSnapshotInput,
} from '../src/lib/publicContentSnapshot';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Reproducible builds: derive build-time timestamps from SOURCE_DATE_EPOCH
 *  (seconds since the Unix epoch) when it is set, so repeated builds of the
 *  same tree are bit-identical; otherwise use the current time. Real content
 *  timestamps are carried separately in `latestUpdatedAt`. */
export function buildTimestamp(): Date {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  return epoch && /^\d+$/.test(epoch) ? new Date(Number(epoch) * 1000) : new Date();
}

export interface LoadResult {
  snapshot: PublicContentSnapshot;
  metadata: PublicContentSnapshotMetadata;
}

export interface LoadOptions {
  /** Environment map (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Force a deployment mode instead of resolving it from env. */
  mode?: string;
  /** Supabase base URL override (tests / mock server). Falls back to env. */
  baseUrl?: string;
  /** Supabase anon key override (tests / mock server). Falls back to env. */
  anonKey?: string;
  /** Injectable fetch (tests). Falls back to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Fixture: a JSON object of raw tables (mock DB), or a path to such a file. */
  fixture?: RawTables | string;
}

/** Raw table rows exactly as PostgREST returns them (snake_case columns). */
export interface RawTables {
  site_settings?: Record<string, unknown>[];
  site_content?: Record<string, unknown>[];
  menu_items?: Record<string, unknown>[];
  stores?: Record<string, unknown>[];
  job_vacancies?: Record<string, unknown>[];
  news_posts?: Record<string, unknown>[];
}

/* ------------------------------------------------------------------ */
/*  Deployment mode resolution (mirrors validate-deployment-env.mjs)   */
/* ------------------------------------------------------------------ */

const MODES = ['development', 'preview', 'production'];

export function resolveDeploymentMode(env: Record<string, string | undefined>): string {
  const explicit = String(env.VITE_DEPLOYMENT_MODE ?? '').trim();
  const onNetlify = String(env.NETLIFY ?? '').trim() === 'true';
  const ctx = String(env.CONTEXT ?? '').trim();
  if (onNetlify && ctx === 'production' && explicit && explicit !== 'production') {
    // A production context contradicted by an explicit non-production mode must
    // evaluate as production so strictness cannot be softened by a typo.
    return 'production';
  }
  if (explicit) return explicit;
  if (onNetlify) {
    if (ctx === 'production') return 'production';
    if (ctx === 'deploy-preview' || ctx === 'branch-deploy') return 'preview';
    if (ctx === 'dev') return 'development';
    return 'preview';
  }
  return 'development';
}

/* ------------------------------------------------------------------ */
/*  snake_case → camelCase (self-contained; no browser client import)  */
/* ------------------------------------------------------------------ */

const snakeToCamel = (s: string): string => s.replace(/_([a-z0-9])/g, (_, c) => String(c).toUpperCase());
function fromRow<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[snakeToCamel(k)] = v === null ? undefined : v;
  return out as T;
}

/* ------------------------------------------------------------------ */
/*  PostgREST fetch (anon key only, explicit columns, timeout)         */
/* ------------------------------------------------------------------ */

/**
 * The exact columns this loader requests from each public relation.
 *
 * R4.10 INCREMENT 1: exported so scripts/r410-public-contract-reconciliation.mjs
 * can reconcile it against information_schema on a freshly built database. It is
 * read, never re-typed — a test that keeps its own copy of this map is a second
 * stand-in and would drift the same way the SEO fixture did.
 */
export const SELECTS: Record<string, string> = {
  /* SMALL-BIZ CLOSURE P0-11: the settings singleton is read from
     public_site_configuration — legal/contact facts come from launch_settings
     (per-field fallback to site_settings while blank) so the STATIC footer's
     legal line matches launch readiness. Column names are identical by
     design, so this is a pure relation repoint. */
  public_site_configuration:
    'id,legal_name,company_number,hq_address,email,gdpr_email,phone,website_url,brand_name,instagram_handle,instagram_url,facebook_url,twitter_url,footer_tagline,allergen_notice,announcement_enabled,announcement_text,currency_symbol,default_opening_hours,updated_at,show_careers,show_franchise,show_news',
  site_content:
    'id,nav,home,menu_page,stores_page,careers_page,franchise_page,about_page,contact_page,news_page,footer,legal,seo,updated_at',
  // R4.9 G4: both public collections are read through their ANON-facing VIEWS,
  // never the base tables. menu_items lost anon SELECT in migration_r49_public_menu.sql;
  // stores lost it back in WS6f — and this loader was never repointed, so a
  // production build has been unable to read the store locator since that
  // migration landed. It was invisible because a production-mode build had
  // never been run (the prerender only ever emitted development-defaults).
  menu_items_public:
    'id,name,description,category,price,price_large,calories,tags,allergens,image,available,updated_at',
  stores_public:
    'id,name,address,postcode,opening_hours,status,delivery_links,phone,email,image,coordinates,updated_at',
  job_vacancies_public:
    'id,title,department,location,salary,type,role_description,requirements,responsibilities,created_at,updated_at',
  news_posts_public: 'id,title,content,category,date,status,image,tag_color,created_at,updated_at',
};

/**
 * The public relations this loader reads, the RawTables field each one lands in,
 * and whether PostgREST should be asked for a single row.
 *
 * R4.10 INCREMENT 1: this used to be a positional destructure inside
 * fetchAllTables, i.e. a mapping that existed only as an ordering coincidence.
 * It is now one exported definition, reconciled against the real schema.
 */
export const PUBLIC_RELATIONS: ReadonlyArray<{
  relation: string;
  field: keyof RawTables;
  singleton: boolean;
}> = [
  { relation: 'public_site_configuration', field: 'site_settings', singleton: true },
  { relation: 'site_content', field: 'site_content', singleton: true },
  { relation: 'menu_items_public', field: 'menu_items', singleton: false },
  { relation: 'stores_public', field: 'stores', singleton: false },
  { relation: 'job_vacancies_public', field: 'job_vacancies', singleton: false },
  { relation: 'news_posts_public', field: 'news_posts', singleton: false },
];

async function fetchTable(
  fetchImpl: typeof fetch,
  baseUrl: string,
  anonKey: string,
  table: string,
  timeoutMs: number,
  singleton: boolean,
): Promise<Record<string, unknown>[]> {
  const select = SELECTS[table];
  const query = `select=${encodeURIComponent(select)}${singleton ? '&limit=1' : ''}`;
  const url = `${baseUrl.replace(/\/$/, '')}/rest/v1/${table}?${query}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (e) {
    const msg = (e as Error)?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : 'request failed';
    // NB: never echo the URL/key — just the table and the coarse reason.
    throw new Error(`Supabase fetch of "${table}" ${msg}.`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Supabase fetch of "${table}" returned HTTP ${res.status}.`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Supabase fetch of "${table}" returned invalid JSON.`);
  }
  if (!Array.isArray(body)) throw new Error(`Supabase fetch of "${table}" did not return a row array.`);
  return body as Record<string, unknown>[];
}

/* ------------------------------------------------------------------ */
/*  Snapshot assembly from raw rows                                    */
/* ------------------------------------------------------------------ */

function maxUpdatedAt(rows: Record<string, unknown>[]): string | null {
  let max: string | null = null;
  for (const r of rows) {
    const u = r.updated_at ?? r.created_at;
    if (typeof u === 'string' && (max === null || u > max)) max = u;
  }
  return max;
}

/** Build a supabase-sourced snapshot + metadata from raw PostgREST tables. */
function snapshotFromRaw(raw: RawTables, siteUrlUnused?: string): LoadResult {
  void siteUrlUnused;
  const settingsRow = (raw.site_settings || [])[0];
  const contentRow = (raw.site_content || [])[0];

  const errors: string[] = [];
  if (!settingsRow) errors.push('site_settings singleton row is absent.');
  if (!contentRow) errors.push('site_content singleton row is absent.');

  const siteSettings = settingsRow ? (fromRow(settingsRow) as PublicContentSnapshotInput['siteSettings']) : ({} as PublicContentSnapshotInput['siteSettings']);
  const siteContent = hydrateSiteContent(contentRow ? fromRow(contentRow) : null);

  const input: PublicContentSnapshotInput = {
    siteSettings,
    siteContent,
    menuItems: (raw.menu_items || []).map((r) => fromRow(r) as PublicContentSnapshotInput['menuItems'][number]),
    stores: (raw.stores || []).map((r) => fromRow(r) as PublicContentSnapshotInput['stores'][number]),
    vacancies: (raw.job_vacancies || []).map((r) => fromRow(r) as PublicContentSnapshotInput['vacancies'][number]),
    newsPosts: (raw.news_posts || []).map((r) => fromRow(r) as PublicContentSnapshotInput['newsPosts'][number]),
  };

  const snapshot = buildPublicContentSnapshot(input);
  errors.push(...validatePublicContentSnapshot(snapshot));
  if (errors.length) {
    const err = new Error(`Public content failed validation:\n  - ${errors.join('\n  - ')}`);
    (err as Error & { validationErrors?: string[] }).validationErrors = errors;
    throw err;
  }

  const metadata: PublicContentSnapshotMetadata = {
    source: 'supabase',
    generatedAt: buildTimestamp().toISOString(),
    contentHash: canonicalContentHash(snapshot),
    counts: snapshotCounts(snapshot),
    latestUpdatedAt: {
      siteSettings: settingsRow ? maxUpdatedAt([settingsRow]) : null,
      siteContent: contentRow ? maxUpdatedAt([contentRow]) : null,
      menuItems: maxUpdatedAt(raw.menu_items || []),
      stores: maxUpdatedAt(raw.stores || []),
      vacancies: maxUpdatedAt(raw.job_vacancies || []),
      newsPosts: maxUpdatedAt(raw.news_posts || []),
    },
  };
  return { snapshot, metadata };
}

/* ------------------------------------------------------------------ */
/*  Development-defaults snapshot (dev fallback ONLY)                   */
/* ------------------------------------------------------------------ */

export function developmentDefaultsSnapshot(): LoadResult {
  const input: PublicContentSnapshotInput = {
    siteSettings: INITIAL_SETTINGS,
    siteContent: hydrateSiteContent(null), // === DEFAULT_SITE_CONTENT
    menuItems: INITIAL_MENU_ITEMS,
    stores: INITIAL_STORES,
    vacancies: INITIAL_JOBS,
    newsPosts: INITIAL_NEWS_POSTS,
  };
  const snapshot = buildPublicContentSnapshot(input);
  const metadata: PublicContentSnapshotMetadata = {
    source: 'development-defaults',
    generatedAt: buildTimestamp().toISOString(),
    contentHash: canonicalContentHash(snapshot),
    counts: snapshotCounts(snapshot),
    latestUpdatedAt: {
      siteSettings: null, siteContent: null, menuItems: null,
      stores: null, vacancies: null, newsPosts: null,
    },
  };
  // Reference DEFAULT_SITE_CONTENT so tree-shakers keep the honest link between
  // this fallback and the seed it uses.
  void DEFAULT_SITE_CONTENT;
  return { snapshot, metadata };
}

/* ------------------------------------------------------------------ */
/*  Public entrypoint                                                  */
/* ------------------------------------------------------------------ */

const PRODUCTION_FAIL_MESSAGE =
  'SEO build failed: production public content could not be loaded from Supabase.\n' +
  'Static seed fallback is prohibited in production.';

async function loadFixture(fixture: RawTables | string): Promise<RawTables> {
  if (typeof fixture !== 'string') return fixture;
  const abs = path.isAbsolute(fixture) ? fixture : path.join(ROOT, fixture);
  const text = await readFile(abs, 'utf8');
  return JSON.parse(text) as RawTables;
}

/**
 * Load the public content snapshot for a build. Throws (fail-closed) in
 * production when Supabase is unreachable or the content is invalid.
 */
export async function loadPublicContent(opts: LoadOptions = {}): Promise<LoadResult> {
  const env = opts.env ?? process.env;
  const mode = opts.mode ?? resolveDeploymentMode(env);
  const isProduction = mode === 'production';
  if (!MODES.includes(mode)) {
    throw new Error(`SEO build failed: unknown deployment mode "${mode}".`);
  }
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const timeoutMs = opts.timeoutMs ?? 15000;

  // Fixture / mock DB — simulate Supabase for CI (production behaviour, no real project).
  const fixture = opts.fixture ?? (env.SEO_CONTENT_FIXTURE ? env.SEO_CONTENT_FIXTURE : undefined);
  if (fixture) {
    let raw: RawTables;
    try {
      raw = await loadFixture(fixture);
    } catch (e) {
      throw new Error(`SEO build failed: could not read content fixture — ${(e as Error).message}`);
    }
    return snapshotFromRaw(raw);
  }

  // Credentials: explicit override → Vite public pair → documented build-only aliases.
  const baseUrl = opts.baseUrl ?? env.VITE_SUPABASE_URL ?? env.SEO_SUPABASE_URL;
  const anonKey = opts.anonKey ?? env.VITE_SUPABASE_ANON_KEY ?? env.SEO_SUPABASE_ANON_KEY;
  const configured = Boolean(baseUrl && anonKey);

  if (isProduction) {
    if (!configured) {
      throw new Error(
        `${PRODUCTION_FAIL_MESSAGE}\nVITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required.`,
      );
    }
    let raw: RawTables;
    try {
      raw = await fetchAllTables(fetchImpl, baseUrl as string, anonKey as string, timeoutMs);
    } catch (e) {
      throw new Error(`${PRODUCTION_FAIL_MESSAGE}\n${(e as Error).message}`);
    }
    // snapshotFromRaw throws on absent singletons / validation failure — that
    // propagates as a production build failure, exactly as required.
    try {
      return snapshotFromRaw(raw);
    } catch (e) {
      throw new Error(`${PRODUCTION_FAIL_MESSAGE}\n${(e as Error).message}`);
    }
  }

  // preview / development.
  if (configured) {
    try {
      const raw = await fetchAllTables(fetchImpl, baseUrl as string, anonKey as string, timeoutMs);
      return snapshotFromRaw(raw);
    } catch (e) {
      console.warn(`[load-public-content] Supabase read failed in "${mode}" mode; using development defaults.\n  ${(e as Error).message}`);
      return developmentDefaultsSnapshot();
    }
  }
  return developmentDefaultsSnapshot();
}

async function fetchAllTables(
  fetchImpl: typeof fetch,
  baseUrl: string,
  anonKey: string,
  timeoutMs: number,
): Promise<RawTables> {
  // R4.10 INCREMENT 1: driven from PUBLIC_RELATIONS rather than a positional
  // destructure. Behaviour-identical (same six relations, same singleton flags,
  // same destination fields) but the relation → field mapping now has ONE
  // definition that the reconciliation test can read.
  const rows = await Promise.all(
    PUBLIC_RELATIONS.map((r) => fetchTable(fetchImpl, baseUrl, anonKey, r.relation, timeoutMs, r.singleton)),
  );
  const out: RawTables = {};
  PUBLIC_RELATIONS.forEach((r, i) => { out[r.field] = rows[i]; });
  return out;
}

/* ------------------------------------------------------------------ */
/*  CLI (debugging): prints SAFE metadata only — never content/creds   */
/* ------------------------------------------------------------------ */

const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  loadPublicContent()
    .then(({ metadata }) => {
      console.log(JSON.stringify(metadata, null, 2));
    })
    .catch((err) => {
      console.error(String((err as Error).message || err));
      process.exit(1);
    });
}
