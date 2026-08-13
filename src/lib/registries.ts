/**
 * @file registries.ts
 * @description PHASE A — per-domain, authenticated, SERVER-CONFIRMED Supabase
 * operations. This file replaces browser localStorage as the system of record
 * for every internal module enabled at launch.
 *
 * DESIGN RULES (launch-remediation scope, agreed 2026-07):
 *  1. Every operation is EXPLICIT and DOMAIN-SPECIFIC. There is no generic
 *     "push all local state" mechanism, no debounced mirror, and no
 *     deletion-diff: a row is only ever written or deleted because a named
 *     operation was called from a user action.
 *  2. Every write carries the caller's Supabase Auth JWT. Role and store
 *     scoping is enforced by the database (RLS in migration_rls_per_role.sql)
 *     — never by anything the client sends.
 *  3. An operation resolves ONLY after PostgREST confirms it. Upserts request
 *     `return=representation` and verify the row count; deletes verify the
 *     deleted row came back. A silently-filtered write (RLS said no) is a
 *     thrown RegistryError, never a fake success.
 *  4. On failure the caller keeps its state: nothing here writes localStorage,
 *     and nothing here mutates React state — that is the caller's job AFTER
 *     the promise resolves.
 *
 * Column mapping intentionally reuses the proven toRow/fromRow camel↔snake
 * translation and the per-table `omit`/`fieldMap`/`pk` metadata from
 * cloudSync's SYNC_MAP so the wire shapes stay identical to schema.sql.
 */
import { getSupabaseConfig, isCloudConfigured, toRow, fromRow } from './supabase';
import { SYNC_MAP, type SyncMapping } from './cloudSync';
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from './requestTimeout';

/* ------------------------------------------------------------------ */
/*  Errors — safe, coded, no SQL / schema leakage                      */
/* ------------------------------------------------------------------ */
export type RegistryErrorCode =
  | 'not_configured'   // no Supabase backend configured
  | 'unauthenticated'  // no / expired session token
  | 'denied'           // RLS or grants refused the operation
  | 'conflict'         // constraint conflict (duplicate key etc.)
  | 'invalid'          // the payload was rejected as malformed
  | 'network'          // transport failure — outcome may be unconfirmed
  | 'server'           // 5xx — reload before retrying a write
  /* SMALL-BIZ CLOSURE P1-2 — KNOWN application outcomes, recognised from a
     fixed needle allow-list (the server's own refusal identifiers) so the
     user sees an actionable message instead of "invalid". The raw body is
     still discarded; only the coarse code survives. */
  | 'stale'            // the record/collection changed elsewhere — reload & review
  | 'incomplete'       // the editor's snapshot was not completely loaded
  | 'publish_blocked'  // publication requirements incomplete
  | 'store_setup'      // store setup incomplete
  | 'forms_uncommissioned' // the public form is not commissioned
  | 'mfa_required';    // this action needs step-up (MFA) authentication

/** Fixed allow-list mapping the server's refusal identifiers to coarse codes.
 *  The needles are OUR OWN raise-exception names (see the migrations) — an
 *  unknown message maps to nothing and falls through to the generic status
 *  classification, so no new backend text can ever reach the interface. */
const KNOWN_SERVER_OUTCOMES: ReadonlyArray<{ code: RegistryErrorCode; needles: readonly string[] }> = [
  { code: 'stale', needles: ['collection_snapshot_stale', 'application_status_stale', 'notice_version_changed', 'quote_config_stale'] },
  { code: 'incomplete', needles: ['collection_revision_required'] },
  { code: 'publish_blocked', needles: ['publish_blocked_incomplete', 'menu_publish_blocked', 'lifecycle_change_refused', 'published_delete_refused', 'publication_candidate'] },
  { code: 'store_setup', needles: ['store_setup_incomplete', 'store_open_blocked', 'store_vat_unconfigured'] },
  { code: 'forms_uncommissioned', needles: ['form_accept_blocked', 'form_notice_missing'] },
  { code: 'mfa_required', needles: ['owner_aal', 'aal2', 'mfa_required'] },
];

function classifyKnownOutcome(body: string): RegistryErrorCode | null {
  if (!body) return null;
  for (const entry of KNOWN_SERVER_OUTCOMES) {
    if (entry.needles.some((n) => body.includes(n))) return entry.code;
  }
  return null;
}

export class RegistryError extends Error {
  code: RegistryErrorCode;
  retryable: boolean;
  constructor(code: RegistryErrorCode, message: string) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
    this.retryable = code === 'network' || code === 'server';
  }
}

/** Human-safe message for a toast. Never includes server internals. */
export function registryErrorMessage(e: unknown): string {
  if (e instanceof RegistryError) {
    switch (e.code) {
      case 'not_configured': return 'No database is configured — this change was NOT saved.';
      case 'unauthenticated': return 'Your session has expired. Sign in again — this change was NOT saved.';
      case 'denied': return 'You do not have permission to make this change. It was NOT saved.';
      case 'conflict': return 'This record was changed elsewhere. Reload and try again — your change was NOT saved.';
      case 'invalid': return 'The server rejected this data as invalid. It was NOT saved.';
      case 'network': return 'The server did not confirm the change. Reload to check the current state before retrying.';
      case 'server': return 'The server did not confirm the change. Reload to check the current state before retrying.';
      case 'stale': return 'This was changed elsewhere in the meantime. Reload to review the latest version, then apply your change again — it was NOT saved.';
      case 'incomplete': return 'This collection has not completely loaded, so saving could lose records. Reload (or press Retry) and try again — nothing was saved.';
      case 'publish_blocked': return 'Publication requirements are incomplete for this record — review the missing details before publishing. Nothing was changed.';
      case 'store_setup': return 'Store setup is incomplete — finish the store\u2019s required configuration first. Nothing was changed.';
      case 'forms_uncommissioned': return 'This form is not commissioned yet — its notice and recipient must be configured first.';
      case 'mfa_required': return 'This action requires step-up authentication. Complete MFA and try again — nothing was changed.';
    }
  }
  return 'The change could not be saved.';
}

/* ------------------------------------------------------------------ */
/*  Authenticated PostgREST transport                                  */
/* ------------------------------------------------------------------ */
export async function authedRest<T>(
  path: string,
  token: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<T> {
  const cfg = getSupabaseConfig();
  if (!cfg) throw new RegistryError('not_configured', 'Supabase is not configured');
  if (!token) throw new RegistryError('unauthenticated', 'No session token');
  const url = `${cfg.url.replace(/\/$/, '')}/rest/v1/${path}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      ...init,
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    }, REQUEST_TIMEOUT_MS.action);
  } catch {
    throw new RegistryError('network', 'Network failure');
  }
  if (!res.ok) {
    // Read (and discard) the body so we can classify without leaking it.
    const body = await res.text().catch(() => '');
    // SMALL-BIZ CLOSURE P1-2: recognise OUR OWN refusal identifiers first, so
    // e.g. a revision conflict tells the user to reload rather than "invalid".
    // The needle list is fixed; the body itself is never surfaced.
    const known = res.status !== 401 && res.status < 500 ? classifyKnownOutcome(body) : null;
    if (known) throw new RegistryError(known, `Known outcome (${res.status})`);
    if (res.status === 401) throw new RegistryError('unauthenticated', 'Session rejected');
    if (res.status === 403) throw new RegistryError('denied', 'Permission denied');
    if (res.status === 409) throw new RegistryError('conflict', 'Constraint conflict');
    if (res.status === 400 || res.status === 422) throw new RegistryError('invalid', 'Payload rejected');
    if (res.status >= 500) throw new RegistryError('server', `Server error ${res.status}`);
    /* SMALL-BIZ CLOSURE P0-4 — the fallback is NOT `denied`.
       `denied` is the one code hydration treats as a legitimate empty (the
       role genuinely sees nothing here), so using it as the catch-all meant
       ANY unrecognised non-2xx — 404 on a missing relation, 418, a proxy's
       own error page — was silently presented as "this collection is empty"
       and the app called the data live. Found by executing the real code
       against an unknown status (scripts/closure-hydration.test.mjs §6), not
       by reading it. Only an explicit 403 is a denial; everything else is a
       recorded failure. */
    throw new RegistryError('server', `Unexpected response (${res.status})`);
  }
  if (res.status === 204) return undefined as unknown as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/* ------------------------------------------------------------------ */
/*  Row mapping (shared with the pull path so shapes never drift)      */
/*  OPT-02 Check 4 (Stage C): these helpers serialize/deserialize      */
/*  ARBITRARY registry records generically, so `Record<string, any>`   */
/*  is intentional here (a documented `any` exception, not an          */
/*  oversight). The DB→domain narrowing lives in each registry's typed  */
/*  DomainOps<T> boundary above; callers never see the raw `any`.       */
/* ------------------------------------------------------------------ */
function applyFieldMap(obj: Record<string, any>, fieldMap?: Record<string, string>) {
  if (!fieldMap) return obj;
  const out = { ...obj };
  for (const [appField, dbCol] of Object.entries(fieldMap)) {
    if (appField in out) { out[dbCol] = out[appField]; delete out[appField]; }
  }
  return out;
}
function applyFieldMapReverse(obj: Record<string, any>, fieldMap?: Record<string, string>) {
  if (!fieldMap || !obj) return obj;
  const out = { ...obj };
  for (const [appField, dbCol] of Object.entries(fieldMap)) {
    if (dbCol in out) { out[appField] = out[dbCol]; delete out[dbCol]; }
  }
  return out;
}
function stripDbFields<T extends Record<string, any>>(obj: T): T {
  if (obj && typeof obj === 'object') {
    delete (obj as any).createdAt;
    delete (obj as any).updatedAt;
    delete (obj as any).rowId;
  }
  return obj;
}
function toDbRow(record: Record<string, any>, m: SyncMapping): Record<string, any> {
  const clean: Record<string, any> = { ...record };
  for (const f of m.omit ?? []) delete clean[f];
  return applyFieldMap(toRow(clean), m.fieldMap);
}
function fromDbRow<T>(row: Record<string, any>, m: SyncMapping): T {
  return stripDbFields(applyFieldMapReverse(fromRow(row), m.fieldMap)) as T;
}

const mappingByKey = new Map<string, SyncMapping>(SYNC_MAP.map((m) => [m.storageKey, m]));
function mapping(storageKey: string): SyncMapping {
  const m = mappingByKey.get(storageKey);
  if (!m) throw new Error(`registries: no SYNC_MAP mapping for ${storageKey}`);
  return m;
}

/* ------------------------------------------------------------------ */
/*  Domain operations factory                                          */
/* ------------------------------------------------------------------ */
const UPSERT_CHUNK = 100;

export interface DomainOps<T extends Record<string, any>> {
  /** Authenticated SELECT — RLS trims rows to what this caller may see. */
  list(token: string): Promise<T[]>;
  /** Server-confirmed insert-or-replace of ONE record (by primary key). */
  upsert(record: T, token: string): Promise<void>;
  /** Server-confirmed insert-or-replace of MANY records (chunked). */
  upsertMany(records: T[], token: string): Promise<void>;
  /** Server-confirmed delete by primary key. Throws `denied` if RLS filtered it. */
  remove(id: string, token: string): Promise<void>;
  /** Append-only insert (Prefer: return=minimal). For streams whose SELECT
   *  policy is stricter than INSERT (e.g. audit_logs is owner-read): a
   *  representation echo would be RLS-blocked for the writer, so the 201
   *  status itself is the confirmation here. */
  appendOnly(record: T, token: string): Promise<void>;
  /** Server-confirmed PATCH of a FIXED field set on one row — for tables where
   *  column-level grants deliberately restrict what the browser may change
   *  (e.g. staff_documents verification fields). */
  patch(id: string, fields: Record<string, unknown>, token: string): Promise<void>;
  /** The underlying table name (for messages / the import tool). */
  table: string;
}

function defineRegistry<T extends Record<string, any>>(storageKey: string): DomainOps<T> {
  const m = mapping(storageKey);
  const pk = m.pk ?? 'id';

  async function upsertRows(rows: Record<string, any>[], token: string): Promise<void> {
    if (!rows.length) return;
    // PostgREST bulk insert requires identical key sets per row.
    const allKeys = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
    const normalized = rows.map((r) => {
      const n: Record<string, any> = {};
      for (const k of allKeys) n[k] = k in r ? r[k] : null;
      return n;
    });
    const returned = await authedRest<unknown[]>(`${m.table}?on_conflict=${pk}&select=${pk}`, token, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(normalized),
    });
    // CONFIRMATION: if RLS silently filtered a row on the update path the
    // representation comes back short — that is a failure, not a success.
    if (!Array.isArray(returned) || returned.length !== normalized.length) {
      throw new RegistryError('denied', 'The database did not confirm every row');
    }
  }

  return {
    table: m.table,
    async list(token: string): Promise<T[]> {
      const rows = await authedRest<Record<string, unknown>[]>(`${m.table}?select=*`, token, { method: 'GET' });
      return (rows ?? []).map((r) => fromDbRow<T>(r, m));
    },
    async upsert(record: T, token: string): Promise<void> {
      await upsertRows([toDbRow(record, m)], token);
    },
    async upsertMany(records: T[], token: string): Promise<void> {
      const rows = records.map((r) => toDbRow(r, m));
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        await upsertRows(rows.slice(i, i + UPSERT_CHUNK), token);
      }
    },
    async remove(id: string, token: string): Promise<void> {
      const returned = await authedRest<unknown[]>(
        `${m.table}?${pk}=eq.${encodeURIComponent(id)}&select=${pk}`,
        token,
        { method: 'DELETE', headers: { Prefer: 'return=representation' } },
      );
      if (!Array.isArray(returned) || returned.length === 0) {
        throw new RegistryError('denied', 'The database did not confirm the deletion');
      }
    },
    async appendOnly(record: T, token: string): Promise<void> {
      await authedRest<void>(`${m.table}`, token, {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([toDbRow(record, m)]),
      });
    },
    async patch(id: string, fields: Record<string, unknown>, token: string): Promise<void> {
      const row = applyFieldMap(toRow(fields), m.fieldMap);
      const returned = await authedRest<unknown[]>(
        `${m.table}?${pk}=eq.${encodeURIComponent(id)}&select=${pk}`,
        token,
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) },
      );
      if (!Array.isArray(returned) || returned.length !== 1) {
        throw new RegistryError('denied', 'The database did not confirm the update');
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Singleton registries (site_settings / site_content)                */
/* ------------------------------------------------------------------ */
export interface SingletonOps<T> {
  get(token: string): Promise<T | null>;
  /** Server-confirmed replace of the single row. */
  table: string;
}

/* INC11: no id argument. It used to carry the literal 'singleton', which was
 * written into an upsert against INTEGER primary keys — broken on every real
 * save. The parameter is gone rather than merely unused, so a reader (or a
 * grep) cannot mistake a dead literal for a live one. */
function defineSingleton<T extends Record<string, any>>(storageKey: string): SingletonOps<T> {
  const m = mapping(storageKey);
  return {
    table: m.table,
    async get(token: string): Promise<T | null> {
      const rows = await authedRest<Record<string, unknown>[]>(`${m.table}?select=*&limit=1`, token, { method: 'GET' });
      if (!rows || !rows.length) return null;
      const first = rows[0];
      if (!first) return null;
      return fromDbRow<T>(first, m);
    },
    /* INC11: the direct-upsert save is GONE. It was verified broken (it sent
     * id:'singleton' against INTEGER primary keys — a type error on every
     * real save) and the singleton guard now closes direct API writes anyway.
     * Singletons are written through save_website_studio /
     * save_launch_settings, which verify the expected revision and write the
     * audit row in the same transaction. */
  };
}

/* ------------------------------------------------------------------ */
/*  Key-value app_state (clock status, checklist ticks, shift covers,  */
/*  e-mail settings). Explicit per-key ops — still no bulk mirror.     */
/* ------------------------------------------------------------------ */
export const appStateKv = {
  async get<T = unknown>(key: string, token: string): Promise<T | null> {
    const rows = await authedRest<Record<string, unknown>[]>(`app_state?key=eq.${encodeURIComponent(key)}&select=value`, token, { method: 'GET' });
    if (!rows || !rows.length) return null;
    return (rows[0]?.value ?? null) as T | null;
  },
  /** Every row this caller may read, keyed. Used once at sign-in hydration. */
  async getAll(token: string): Promise<Record<string, unknown>> {
    const rows = await authedRest<Record<string, unknown>[]>('app_state?select=key,value', token, { method: 'GET' });
    const out: Record<string, unknown> = {};
    for (const r of rows ?? []) out[String(r.key)] = r.value;
    return out;
  },
  async set(key: string, value: unknown, token: string): Promise<void> {
    // STAGE 5: the ONLY write path is the server-side set_app_state()
    // transaction — it allow-lists the key and derives scope/ownership from
    // the caller's verified staff row (clock keys must be the caller's own;
    // checklist/cover keys stamp the caller's store; e-mail settings are
    // owner-only). Direct table writes are revoked in the database.
    const res = await authedRest<{ ok?: boolean }>('rpc/set_app_state', token, {
      method: 'POST',
      body: JSON.stringify({ p_key: key, p_value: value }),
    });
    if (!res || res.ok !== true) {
      throw new RegistryError('denied', 'The database did not confirm the save');
    }
  },
};

/* ------------------------------------------------------------------ */
/*  NAMED DOMAIN REGISTRIES — one per launch module                    */
/* ------------------------------------------------------------------ */
import type {
  EmployeeProfile, WorkShift, ClockHistoryItem, Payslip, StaffDocument, SIFRReport, CreateSIFRReportInput,
  TrainingCourse, TrainingAssessment, TrainingAssignment, TrainingCertificate, TrainingProgressRecord,
  RolePermissionMatrix, ChecklistTemplateItem, AuditLogItem, KnowledgeArticle,
  MenuItem, StoreLocation, CareerVacancy, NewsPost, CmsPageContent, MediaItem,
  Deal, SiteSettings, Order,
} from '../types';

/* Staff / HR / operations */
export const employeesRepo = defineRegistry<EmployeeProfile>('milkpop_employees');
export const shiftsRepo = defineRegistry<WorkShift>('milkpop_shifts');
export const clockRepo = defineRegistry<ClockHistoryItem>('milkpop_clock_history');

/** T13.3.19 — narrow, server-owned timesheet decision. The caller supplies
 * row ids and a decision only; factual hours, actor identity and timestamp are
 * derived and protected in PostgreSQL. */
export async function decideTimesheets(
  ids: string[],
  decision: 'approve' | 'reject',
  token: string,
): Promise<ClockHistoryItem[]> {
  const result = await callRpc<{ ok: boolean; rows: Record<string, unknown>[] }>('decide_timesheets', {
    p_ids: ids,
    p_decision: decision,
  }, token);
  if (!result?.ok || !Array.isArray(result.rows)) {
    throw new RegistryError('denied', 'The database did not confirm the timesheet decision');
  }
  const m = mapping('milkpop_clock_history');
  return result.rows.map((row) => fromDbRow<ClockHistoryItem>(row, m));
}
export const payslipsRepo = defineRegistry<Payslip>('milkpop_payslips');
export const documentsRepo = defineRegistry<StaffDocument>('milkpop_docs');
export const sifrRepo = defineRegistry<SIFRReport>('milkpop_sifr');

/** T13.3.13: SIFR writes are narrow server transactions. The browser never
 * chooses reporter/store/timestamps and managers never replace a whole row. */
export async function createSifrReport(input: CreateSIFRReportInput, token: string): Promise<SIFRReport> {
  const row = await callRpc<Record<string, unknown>>('create_sifr_report', {
    p_title: input.title,
    p_category: input.category,
    p_involved_people: input.involvedPeople,
    p_description: input.description,
    p_impact: input.impact,
    p_suggested_action: input.suggestedAction,
    p_confidentiality: input.confidentiality,
  }, token);
  return fromDbRow<SIFRReport>(row, mapping('milkpop_sifr'));
}

export async function appendSifrReply(reportId: string, message: string, token: string): Promise<SIFRReport> {
  const row = await callRpc<Record<string, unknown>>('append_sifr_reply', {
    p_report_id: reportId, p_message: message,
  }, token);
  return fromDbRow<SIFRReport>(row, mapping('milkpop_sifr'));
}

export async function setSifrStatus(
  reportId: string,
  status: SIFRReport['status'],
  token: string,
): Promise<SIFRReport> {
  const row = await callRpc<Record<string, unknown>>('set_sifr_status', {
    p_report_id: reportId, p_status: status,
  }, token);
  return fromDbRow<SIFRReport>(row, mapping('milkpop_sifr'));
}
export const coursesRepo = defineRegistry<TrainingCourse>('milkpop_courses');
export const assessmentsRepo = defineRegistry<TrainingAssessment>('milkpop_assessments');

/** FIX-9 (audit TRN-002): trainees receive REDACTED assessments — no
 *  correctAnswer, no explanation, drag gaps blanked, word bank supplied —
 *  via get_staff_assessments(); managers/owners receive full rows from the
 *  SAME call. The raw table SELECT is manager-only now, so a plain list()
 *  would return zero rows for a team member. Row keys match the table, so
 *  the standard mapper applies. */
export async function listStaffAssessments(token: string): Promise<TrainingAssessment[]> {
  const rows = await callRpc<Record<string, unknown>[]>('get_staff_assessments', {}, token);
  const m = mapping('milkpop_assessments');
  return (Array.isArray(rows) ? rows : []).map((r) => fromDbRow<TrainingAssessment>(r, m));
}
export const trainingAssignmentsRepo = defineRegistry<TrainingAssignment>('milkpop_training_assignments');
export const certificatesRepo = defineRegistry<TrainingCertificate>('milkpop_training_certificates');
export const trainingProgressRepo = defineRegistry<TrainingProgressRecord>('milkpop_training_progress');
export const rolePermissionsRepo = defineRegistry<RolePermissionMatrix>('milkpop_permissions_config');
export const checklistTemplatesRepo = defineRegistry<ChecklistTemplateItem>('milkpop_checklist_templates');
export const auditLogsRepo = defineRegistry<AuditLogItem>('milkpop_audit_logs');
export const ordersRepo = defineRegistry<Order>('milkpop_orders');

/* Website content publication */
export const menuItemsRepo = defineRegistry<MenuItem>('milkpop_menu_items');
export const storesRepo = defineRegistry<StoreLocation>('milkpop_stores_list');
export const vacanciesRepo = defineRegistry<CareerVacancy>('milkpop_vacancies_list');
export const articlesRepo = defineRegistry<KnowledgeArticle>('milkpop_articles_list');
export const newsRepo = defineRegistry<NewsPost>('milkpop_news_posts');
export const cmsPagesRepo = defineRegistry<CmsPageContent>('milkpop_cms_pages');
export const mediaRepo = defineRegistry<MediaItem>('milkpop_media_library');
export const dealsRepo = defineRegistry<Deal>('milkpop_deals');
export const siteSettingsRepo = defineSingleton<SiteSettings>('milkpop_site_settings');
export const siteContentRepo = defineSingleton<Record<string, any>>('milkpop_site_content');

/* ------------------------------------------------------------------ */
/*  SIGN-IN HYDRATION — one explicit authenticated read per domain.    */
/*  RLS decides what each role sees; an empty result is a valid state. */
/* ------------------------------------------------------------------ */
export type StaffDataStatus = 'idle' | 'loading' | 'live' | 'error';

export interface StaffDataBundle {
  collectionRevisions?: Array<{ table_key: string; revision: number }>;
  /** SMALL-BIZ CLOSURE P0-6: the DATABASE Knowledge Base. Admin already saved
   *  articles through articlesRepo, but hydration never loaded them back —
   *  the interface rendered bundled seed articles instead, so owner edits
   *  vanished on reload and a later whole-collection publish could overwrite
   *  the database with the seeds. Production state starts EMPTY and this is
   *  the only source. */
  articles?: KnowledgeArticle[];
  /** SMALL-BIZ CLOSURE P0-4: an `unauthenticated` result during hydration is
   *  not "this collection is empty" — the session is dead. The app must
   *  return to sign-in rather than mark partial data live. */
  sessionExpired?: boolean;
  employees?: EmployeeProfile[];
  shifts?: WorkShift[];
  clockHistory?: ClockHistoryItem[];
  payslips?: Payslip[];
  documents?: StaffDocument[];
  sifrReports?: SIFRReport[];
  courses?: TrainingCourse[];
  assessments?: TrainingAssessment[];
  trainingAssignments?: TrainingAssignment[];
  certificates?: TrainingCertificate[];
  trainingProgress?: TrainingProgressRecord[];
  rolePermissions?: RolePermissionMatrix[];
  checklistTemplates?: ChecklistTemplateItem[];
  auditLogs?: AuditLogItem[];
  /** WS6f (audit F11): the FULL store rows (config + VAT columns) via the
   *  AUTHENTICATED grant. The anonymous pull now reads the stores_public
   *  view, which deliberately lacks these columns — signed-in surfaces (the
   *  till's setup gate, the admin wizard) need this authed copy. */
  storesFull?: StoreLocation[];
  /** R4.10 P0-2: the FULL menu rows via the AUTHENTICATED grant. The anonymous
   *  pull reads menu_items_public, which contains only AVAILABLE products — so
   *  a signed-in surface that published the anonymous copy would send a
   *  snapshot with every hidden product missing, and replace_collection treats
   *  "missing" as "deleted". Admin surfaces and the publisher must use this. */
  menuItemsFull?: MenuItem[];
  /* R4.10 Increment 5b — the AUTHENTICATED copy of every collection whose
     public read is a filtered projection. Narrowing a public read without
     widening the admin read is exactly how P0-2 happened: the client hydrated
     the visible rows, published the whole collection, and deleted the rest. */
  dealsFull?: Deal[];
  newsPostsFull?: NewsPost[];
  vacanciesFull?: CareerVacancy[];
  cmsPagesFull?: CmsPageContent[];
  mediaAssetsFull?: MediaItem[];
  appState?: Record<string, unknown>;
  /** Table names that failed to load (network/server) — shown to the user. */
  failures: string[];
}

/**
 * Stage 2.1.2 — the pay-free staff directory, SERVER-enforced. The base table
 * no longer grants general SELECT (only id/name/role/store_id remain readable
 * for write-path confirmations and policy joins), so the directory reads
 * through the `get_staff_directory()` RPC: the safe column set below with NO
 * pay and NO auth_id, row-scoped exactly like the old SELECT policies (owner →
 * all, AAL2 manager → their store, everyone else → self). Then — ONLY for the
 * owner — real pay is merged from the owner-only `owner_staff_pay()` RPC. A
 * manager receives the same shape with pay left undefined, and any hand-written
 * column read against the base table now fails with 42501 in the database.
 */
export const STAFF_DIRECTORY_COLS = [
  'id', 'name', 'email', 'role', 'store_id', 'store_name', 'next_shift',
  'holiday_balance', 'points', 'level', 'badges', 'avatar', 'status',
  'onboarding', 'invited_at', 'created_at', 'updated_at',
].join(',');

export async function fetchStaffDirectory(token: string): Promise<EmployeeProfile[]> {
  const m = mapping('milkpop_employees');
  const rows = await authedRest<Record<string, unknown>[]>(
    'rpc/get_staff_directory', token, { method: 'POST', body: JSON.stringify({}) });
  const people = (rows ?? []).map((r) => fromDbRow<EmployeeProfile>(r, m));
  // Owner-only pay enrichment. Non-owners get 0 rows from the RPC (is_owner
  // gate), so their directory simply carries no pay — exactly the intent.
  try {
    const pay = await authedRest<Array<{ id: string; pay_rate: number | null; pay_type: string | null }>>(
      'rpc/owner_staff_pay', token, { method: 'POST', body: JSON.stringify({}) });
    if (Array.isArray(pay) && pay.length) {
      const byId = new Map(pay.map((p) => [p.id, p]));
      for (const person of people) {
        const p = byId.get(person.id);
        if (p) {
          person.payRate = p.pay_rate ?? undefined;
          if (p.pay_type === 'hourly' || p.pay_type === 'salary') person.payType = p.pay_type;
        }
      }
    }
  } catch (e) {
    // A denied/failed pay RPC must not break the directory: a manager legitimately
    // gets nothing here. Only surface genuine transport failures upstream.
    if (e instanceof RegistryError && (e.code === 'network' || e.code === 'server')) throw e;
  }
  return people;
}

export async function hydrateStaffData(token: string): Promise<StaffDataBundle> {
  const out: StaffDataBundle = { failures: [] };
  const jobs: Array<[keyof StaffDataBundle, () => Promise<any>]> = [
    ['employees', () => fetchStaffDirectory(token)],
    ['shifts', () => shiftsRepo.list(token)],
    ['clockHistory', () => clockRepo.list(token)],
    ['payslips', () => payslipsRepo.list(token)],
    ['documents', () => documentsRepo.list(token)],
    ['sifrReports', () => sifrRepo.list(token)],
    ['courses', () => coursesRepo.list(token)],
    ['assessments', () => listStaffAssessments(token)],
    ['trainingAssignments', () => trainingAssignmentsRepo.list(token)],
    ['certificates', () => certificatesRepo.list(token)],
    ['trainingProgress', () => trainingProgressRepo.list(token)],
    ['rolePermissions', () => rolePermissionsRepo.list(token)],
    ['checklistTemplates', () => checklistTemplatesRepo.list(token)],
    ['auditLogs', () => auditLogsRepo.list(token)],
    ['storesFull', () => storesRepo.list(token)],
    ['menuItemsFull', () => menuItemsRepo.list(token)],
    ['dealsFull', () => dealsRepo.list(token)],
    ['newsPostsFull', () => newsRepo.list(token)],
    ['vacanciesFull', () => vacanciesRepo.list(token)],
    ['cmsPagesFull', () => cmsPagesRepo.list(token)],
    ['mediaAssetsFull', () => mediaRepo.list(token)],
    // SMALL-BIZ CLOSURE P0-6: the Knowledge Base is database-backed for BOTH
    // Admin and the Staff Portal, so it hydrates like every other collection.
    ['articles', () => articlesRepo.list(token)],
    // INC11: the revision every collection editor must state when saving.
    ['collectionRevisions', () => authedRest<Array<{ table_key: string; revision: number }>>(
      'collection_revisions?select=table_key,revision', token, { method: 'GET' })],
    ['appState', () => appStateKv.getAll(token)],
  ];
  await Promise.all(jobs.map(async ([field, run]) => {
    try {
      (out as any)[field] = await run();
    } catch (e) {
      /* SMALL-BIZ CLOSURE P0-4 — hydration fails HONESTLY.
         The previous rule recorded only network/server/not_configured and
         silently swallowed everything else, so an expired token, a malformed
         response or an unknown exception left the field undefined and the
         caller marked staff data `live` over a collection that never loaded.
         The corrected rule:
           · `denied` (RLS said this role sees nothing here) is the ONLY
             legitimate silent empty — preserved exactly as before;
           · `unauthenticated` expires the whole session — the caller must
             return to sign-in, so it is BOTH a failure and a session flag;
           · every other RegistryError AND every unknown exception is a
             recorded failure. Unknown is never classified as success. */
      if (e instanceof RegistryError && e.code === 'denied') return;
      if (e instanceof RegistryError && e.code === 'unauthenticated') out.sessionExpired = true;
      out.failures.push(String(field));
    }
  }));
  return out;
}

/** STAGE 7 — atomically replace a whole publishable collection in ONE
 *  database transaction (replace_collection RPC, SECURITY INVOKER so the
 *  caller's own RLS authorises every delete/upsert). Returns the final
 *  collection exactly as the SERVER sees it.
 *
 *  R4.10: the caller STATES the row count its snapshot was taken over
 *  (`expectedTotal`). If the server-side collection has changed since the
 *  hydration — or the snapshot came from a filtered projection — the server
 *  refuses the whole call as `collection_snapshot_stale` before deleting
 *  anything. Publication columns in `items` are stripped server-side; this
 *  function moves CONTENT only, publishRecord moves publication state. */
export async function replaceCollection<T extends Record<string, any>>(
  storageKey: string,
  items: T[],
  token: string,
  expectedTotal: number,
  expectedRevision: number | null,
): Promise<{ revision: number; rows: T[] }> {
  const m = mapping(storageKey);
  const rows = items.map((r) => toDbRow(r, m));
  /* INC11: the caller states the collection REVISION it hydrated alongside
   * the total. The revision closes the same-count edit-edit hole the total
   * cannot see; an unknown revision is sent as null and the server refuses
   * with collection_revision_required — fail closed, never guess. The RPC
   * now returns { revision, rows }. */
  const res = await authedRest<{ revision: number; rows: Record<string, unknown>[] }>(
    'rpc/replace_collection', token, {
      method: 'POST',
      body: JSON.stringify({
        p_table: m.table, p_rows: rows,
        p_expected_total: expectedTotal, p_expected_revision: expectedRevision,
      }),
    });
  if (!res || !Array.isArray(res.rows) || typeof res.revision !== 'number') {
    throw new RegistryError('denied', 'The database did not confirm the publication');
  }
  return { revision: res.revision, rows: res.rows.map((r) => fromDbRow<T>(r, m)) };
}

/** INC11: the base table a collection storageKey maps to — the key the
 *  collection_revisions ledger uses. */
export function collectionTable(storageKey: string): string {
  return mapping(storageKey).table;
}

/** FIX-7 — apply EXPLICIT changes to payslips in ONE database transaction: upsert exactly the rows the caller
 *  changed and delete exactly the ids the caller named. Unlike replaceCollection
 *  there is no implicit "delete everything not in the snapshot", so a row a
 *  concurrent writer (e.g. a staff member clocking out) added meanwhile is
 *  never touched. Returns the final collection exactly as the SERVER sees it. */
export async function applyCollectionChanges<T extends Record<string, any>>(
  storageKey: string,
  upserts: T[],
  deleteIds: string[],
  token: string,
): Promise<T[]> {
  const m = mapping(storageKey);
  const rows = upserts.map((r) => toDbRow(r, m));
  const finalRows = await authedRest<Record<string, unknown>[]>('rpc/apply_collection_changes', token, {
    method: 'POST',
    body: JSON.stringify({ p_table: m.table, p_upserts: rows, p_delete_ids: deleteIds }),
  });
  if (!Array.isArray(finalRows)) {
    throw new RegistryError('denied', 'The database did not confirm the changes');
  }
  return finalRows.map((r) => fromDbRow<T>(r, m));
}

/** Authenticated Postgres RPC call. A successful response confirms the
 *  transaction; a transport failure is an UNKNOWN outcome, so callers must
 *  reload before retrying rather than claim that nothing committed. */
/** INC11: ONE transaction for the Website Studio publish. Each part is
 *  optional; every part provided is revision-guarded server-side, both writes
 *  and the audit row commit or roll back together. */
/** INC11: the ONLY vehicle for candidacy status changes. Locks the row,
 *  compare-and-swaps the status (fromStatus is the optimistic version),
 *  audits, and enqueues the candidate mail in the same transaction. */
export async function transitionApplication(
  id: string,
  fromStatus: string,
  toStatus: string,
  token: string,
): Promise<void> {
  await callRpc('transition_application', {
    p_id: id, p_from_status: fromStatus, p_to_status: toStatus,
  }, token);
}

/** Read one collection's current revision (null when the ledger has no row). */
export async function currentCollectionRevision(table: string, token: string): Promise<number | null> {
  const rows = await authedRest<Array<{ revision: number }>>(
    `collection_revisions?table_key=eq.${table}&select=revision`, token, { method: 'GET' });
  return rows?.[0]?.revision ?? null;
}

export interface StudioSaveResult { settingsRevision: number; contentRevision: number }
export async function saveWebsiteStudio(
  settings: SiteSettings | null,
  content: import('../siteContent').SiteContent | null,
  expectedSettingsRevision: number | null,
  expectedContentRevision: number | null,
  token: string,
): Promise<StudioSaveResult> {
  const ms = mapping('milkpop_site_settings');
  const mc = mapping('milkpop_site_content');
  const res = await callRpc<{ settings_revision: number; content_revision: number }>('save_website_studio', {
    p_site_settings: settings ? toDbRow(settings, ms) : null,
    p_site_content: content ? toDbRow(content, mc) : null,
    p_expected_settings_revision: expectedSettingsRevision,
    p_expected_content_revision: expectedContentRevision,
  }, token);
  return { settingsRevision: res.settings_revision, contentRevision: res.content_revision };
}

export async function callRpc<T>(name: string, args: Record<string, unknown>, token: string): Promise<T> {
  return authedRest<T>(`rpc/${name}`, token, { method: 'POST', body: JSON.stringify(args) });
}

export { isCloudConfigured };
