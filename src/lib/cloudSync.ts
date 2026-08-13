/**
 * @file cloudSync.ts
 * @description ANONYMOUS PULL ONLY — hydrates the public website's content
 * registries (menu, stores, deals, vacancies, news, CMS, media, settings)
 * from Supabase under deny-by-default RLS.
 *
 * PHASE A NOTE — WHERE THE WRITES WENT
 * ------------------------------------
 * The debounced push / deletion-diff mirror that used to live in this file is
 * REMOVED, permanently. It was the mechanism behind the historic "staff
 * vanished on refresh" incident (a stale device snapshot bulk-deleting fresh
 * rows), and the launch remediation explicitly forbids any generic
 * localStorage mirror. Internal data now flows exclusively through the typed,
 * per-domain, authenticated, server-confirmed operations in
 * src/lib/registries.ts — which reuses SYNC_MAP below strictly as COLUMN
 * MAPPING metadata (table names, omit lists, primary keys), never as a push
 * engine.
 */
import { isCloudConfigured, sbSelect, fromRow } from './supabase';
import { validatePublicStorageValue } from './publicDataValidation';
import { sortMenuItems, sortStores, sortVacancies, sortNews } from './publicOrdering';
import type { MenuItem, StoreLocation, CareerVacancy, NewsPost } from '../types';

export type SyncAccess =
  /** Anonymous SELECT allowed by RLS — safe to pull for the public site. */
  | 'public_read'
  /** No anonymous access at all. Requires the authenticated backend. */
  | 'private';

export interface SyncMapping {
  /** WS6f (audit F11): table read by the ANONYMOUS pull when it differs from
   *  the write table (stores → the stores_public view, which exposes only
   *  the locator columns; the base table is no longer anon-readable). */
  readTable?: string;
  storageKey: string;
  table: string;
  /** What the anon key is allowed to do to this table under RLS. */
  access: SyncAccess;
  /** Fields that live only on the client and must never be sent. */
  omit?: string[];
  /** Single-row tables (site_settings) upsert with a fixed id. */
  singleton?: boolean;
  /** Primary key column when it isn't `id` (e.g. role_permissions keys on `role`). */
  pk?: string;
  /** Override specific camelCase field -> db column mappings for reserved-word columns. */
  fieldMap?: Record<string, string>;
}

/** The complete registry ⇄ table map. Order matters only for readability. */
export const SYNC_MAP: SyncMapping[] = [
  // Public website content — anon SELECT is allowed by RLS.
  /* SMALL-BIZ CLOSURE P0-11: the read comes from public_site_configuration —
   * the ONE public source of legal/contact truth (launch_settings facts with
   * per-field fallback, site_settings presentation; identical column names by
   * design). Writes still target site_settings via save_website_studio; the
   * Launch Facts editor owns the authoritative legal fields. */
  { storageKey: 'milkpop_site_settings', table: 'site_settings', access: 'public_read', singleton: true,
    readTable: 'public_site_configuration' },
  // The Website Studio content model (see supabase/migration_site_content.sql).
  { storageKey: 'milkpop_site_content', table: 'site_content', access: 'public_read', singleton: true },
  // WS6f (audit F4): tax classification is an OWNER decision made through
  // classify_products(); the menu PUBLISH path never carries it, so manager
  // publishes cannot touch it and the column guard's fast path always holds.
  // R4.9 G4: anonymous reads come from menu_items_public (available rows only,
  // no tax_code); the base table is no longer anon-readable. `available` is
  // server truth controlled by the R4.8 publish gate, so it is OMITTED from
  // writes — absent keys are preserved by the upsert, which is exactly "leave
  // the server's decision alone".
  { storageKey: 'milkpop_menu_items', table: 'menu_items', access: 'public_read',
    readTable: 'menu_items_public', omit: ['taxCode', 'available'] },
  // R4.10 Increment 5b: each of these now READS a filtered projection while
  // still WRITING the base table. That narrowing is only safe because the
  // authenticated *Full hydration and the per-collection publish authority
  // landed in the same increment — see requireAuthority() in App.tsx.
  { storageKey: 'milkpop_deals', table: 'deals', access: 'public_read', readTable: 'deals_public' },
  // WS6d: the VAT lifecycle columns are server-configured truth (constraints +
  // owner wizard). The browser READS them but must never publish them back —
  // replace_collection would otherwise let a stale client downgrade the store's
  // VAT configuration. Absent keys are preserved by the upsert, so omitting is
  // exactly "leave the server truth alone".
  { storageKey: 'milkpop_stores_list', table: 'stores', access: 'public_read', readTable: 'stores_public',
    omit: ['vatStatus', 'vatNumber', 'vatRegistrationEffectiveDate', 'vatConfigConfirmedAt',
           'setupStatus', 'timezone', 'currencyCode', 'paymentMethods', 'receiptFooter'] },
  { storageKey: 'milkpop_vacancies_list', table: 'job_vacancies', access: 'public_read', readTable: 'job_vacancies_public' },
  { storageKey: 'milkpop_news_posts', table: 'news_posts', access: 'public_read', readTable: 'news_posts_public' },
  /* INC11: cms_pages and media_assets left the publication scope — cms drives
   * no public route and media byte-visibility is governed by references, so
   * both anonymous projections were REVOKED server-side. The entries stay for
   * staff hydration of the base tables; guests no longer pull them. */
  { storageKey: 'milkpop_cms_pages', table: 'cms_pages', access: 'private' },
  /* INC11: the notice each public form RENDERS and must echo on submit —
   * anonymous read of the derived current view; the base table stays staff. */
  { storageKey: 'milkpop_privacy_notices', table: 'privacy_notice_versions', access: 'public_read', readTable: 'privacy_notice_current' },
  { storageKey: 'milkpop_media_library', table: 'media_assets', access: 'private' },
  // Public form submissions are not part of the sync registry. They submit through
  // guarded Edge Functions; anonymous clients hold no direct table privileges.
  // Private / staff-only data — NO anonymous access of any kind.
  { storageKey: 'milkpop_orders', table: 'orders', access: 'private' },
  { storageKey: 'milkpop_employees', table: 'staff_profiles', access: 'private', omit: ['password', 'mustChangePassword'] },
  { storageKey: 'milkpop_shifts', table: 'work_shifts', access: 'private' },
  { storageKey: 'milkpop_checklist_templates', table: 'checklist_templates', access: 'private' },
  { storageKey: 'milkpop_docs', table: 'staff_documents', access: 'private' },
  { storageKey: 'milkpop_sifr', table: 'sifr_reports', access: 'private' },
  { storageKey: 'milkpop_courses', table: 'training_courses', access: 'private' },
  { storageKey: 'milkpop_assessments', table: 'training_assessments', access: 'private' },
  { storageKey: 'milkpop_training_assignments', table: 'training_assignments', access: 'private' },
  { storageKey: 'milkpop_training_certificates', table: 'training_certificates', access: 'private' },
  { storageKey: 'milkpop_training_progress', table: 'training_progress', access: 'private' },
  { storageKey: 'milkpop_articles_list', table: 'kb_articles', access: 'private' },
  { storageKey: 'milkpop_audit_logs', table: 'audit_logs', access: 'private' },
  { storageKey: 'milkpop_permissions_config', table: 'role_permissions', access: 'private', pk: 'role' },
  { storageKey: 'milkpop_clock_history', table: 'clock_history', access: 'private' },
  { storageKey: 'milkpop_payslips', table: 'payslips', access: 'private' },
];

/** The keys the app stores in the app_state KV table (written server-first
 *  through registries.appStateKv — see src/lib/registries.ts). */
export const KV_KEYS = ['milkpop_email_settings'];
export const KV_PREFIXES = [
  'milkpop_clock_status_',
  'milkpop_checklist_tasks:',
  'milkpop_checklist_audits:',
  'milkpop_shift_covers:',
];

export type CloudListener = (status: { syncing: boolean; lastSyncAt?: string | undefined; lastError?: string | undefined }) => void;
let listener: CloudListener | null = null;
export const onCloudStatus = (fn: CloudListener) => { listener = fn; };
const emit = (s: { syncing: boolean; lastSyncAt?: string | undefined; lastError?: string | undefined }) => listener?.(s);

/* ------------------------------------------------------------------ */
/*  PULL: hydrate local registries from the database                   */
/* ------------------------------------------------------------------ */
/** Reverse a fieldMap when reading rows back from the database. */
function applyFieldMapReverse(obj: any, fieldMap?: Record<string, string>): any {
  if (!fieldMap || !obj) return obj;
  const reversed = Object.fromEntries(Object.entries(fieldMap).map(([app, db]) => [db, app]));
  const result = { ...obj };
  for (const [dbCol, appField] of Object.entries(reversed)) {
    if (dbCol in result) {
      result[appField] = result[dbCol];
      delete result[dbCol];
    }
  }
  return result;
}

export interface CloudPullFailure { key: string; relation: string; reason: string }
export interface CloudPullResult {
  data: Record<string, unknown>;
  succeeded: string[];
  failed: CloudPullFailure[];
  completedAt: string;
}

/** Keep live anonymous collections in the same deterministic order as the
 * build-time public snapshot. This prevents PostgREST row order from changing
 * card order, featured products or SEO/runtime parity between requests. */
function orderPublicStorageValue(storageKey: string, value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  switch (storageKey) {
    case 'milkpop_menu_items': return sortMenuItems(value as MenuItem[]);
    case 'milkpop_stores_list': return sortStores(value as StoreLocation[]);
    case 'milkpop_vacancies_list': return sortVacancies(value as CareerVacancy[]);
    case 'milkpop_news_posts': return sortNews(value as NewsPost[]);
    default: return value;
  }
}

export async function pullAllFromCloud(): Promise<CloudPullResult> {
  const completedAt = new Date().toISOString();
  if (!isCloudConfigured()) return { data: {}, succeeded: [], failed: [], completedAt };
  emit({ syncing: true });
  const result: Record<string, unknown> = {};
  const succeeded: string[] = [];
  const failures: CloudPullFailure[] = [];
  // SECURITY: the app_state KV table is private (it can hold staff clock
  // status and internal preferences) — it is not pulled anonymously.
  const publicMappings = SYNC_MAP.filter((m) => m.access === 'public_read');
  // Public relations are independent. Fetch them concurrently so one slow or
  // unavailable relation cannot multiply opening latency by the number of
  // collections. Outcomes are applied afterward in registry order, keeping
  // deterministic state and error reporting.
  const pulls = await Promise.all(publicMappings.map(async (m) => {
    try {
      return { m, rows: await sbSelect(m.readTable ?? m.table), error: null as string | null };
    } catch (error: any) {
      return { m, rows: null, error: String(error?.message || error) };
    }
  }));

  for (const { m, rows, error } of pulls) {
    if (error || !rows) {
      failures.push({ key: m.storageKey, relation: m.readTable ?? m.table, reason: error || 'no response' });
      continue;
    }
    const rawValue = m.singleton
      ? (rows.length ? stripDbFields(applyFieldMapReverse(fromRow(rows[0]), m.fieldMap)) : undefined)
      : rows.map((r) => stripDbFields(applyFieldMapReverse(fromRow(r), m.fieldMap)));
    if (rawValue === undefined) {
      failures.push({ key: m.storageKey, relation: m.readTable ?? m.table, reason: 'required singleton row is absent' });
      continue;
    }
    const checked = validatePublicStorageValue(m.storageKey, rawValue);
    if (!checked.ok) {
      failures.push({ key: m.storageKey, relation: m.readTable ?? m.table, reason: checked.reason });
      continue;
    }
    result[m.storageKey] = orderPublicStorageValue(m.storageKey, checked.value);
    succeeded.push(m.storageKey);
  }
  const finishedAt = new Date().toISOString();
  const errorSummary = failures.length ? failures.map((f) => `${f.relation}: ${f.reason}`).join(' | ') : undefined;
  emit({ syncing: false, lastSyncAt: finishedAt, lastError: errorSummary });
  if (failures.length) console.warn('[cloudSync] pull finished with failures:', failures);
  return { data: result, succeeded, failed: failures, completedAt: finishedAt };
}

/** Database housekeeping columns the client never stores locally. */
function stripDbFields(obj: any) {
  if (obj && typeof obj === 'object') {
    delete obj.createdAt;
    delete obj.updatedAt;
    delete obj.rowId;
  }
  return obj;
}

/*
 * Bulk "Push everything" was REMOVED together with its Admin-UI caller
 * (Phase 1 review), and in Phase A the entire debounced push / deletion-diff
 * mirror followed it out of the codebase. Writes are per-domain, explicit,
 * authenticated and server-confirmed — see src/lib/registries.ts.
 */
