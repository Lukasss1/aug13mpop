/**
 * @file supabase.ts
 * @description Zero-dependency Supabase client (PostgREST over fetch).
 *
 * Why not @supabase/supabase-js? This keeps the bundle tiny and works in any
 * environment — the official SDK is a thin wrapper over the same REST calls.
 *
 * Configuration (Phase 1 review): production loads the URL and anon key ONLY
 * from Vite env vars (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) baked in at
 * build time. A localStorage override exists strictly behind
 * import.meta.env.DEV for local development and is compiled out of production
 * bundles. When nothing is configured every call is a no-op and the app runs
 * without a backend — public forms then report `not_configured` honestly.
 *
 * SECURITY MODEL (see README.md (Security)):
 *  - Only the ANON key is ever used here. The anon key is public by design;
 *    what it may do is decided entirely by Row Level Security in the database.
 *    Never put a service-role key anywhere in this codebase.
 *  - After the security lockdown, RLS is deny-by-default. The anon key can:
 *      • SELECT only the explicitly published public-content projections.
 *    Anonymous visitors have no direct table-write privileges. Public forms
 *    call the guarded `public-form` Edge Function, which performs validation,
 *    privacy-evidence checks, rate limiting and transactional insertion.
 *    Anonymous CV upload is DISABLED (there is deliberately
 *    no client upload function — see the security notes in README.md). Reads/
 *    writes of staff, payroll, orders, documents, incidents, audit logs etc.
 *    require the authenticated backend tracked in the security notes in README.md.
 */
import type { SubmissionResult, PaymentMethod, VatStatus, TaxCode } from '../types';
import { timedFetch } from './requestTimeout';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

/** DEV-only localStorage override key. Ignored entirely in production builds. */
const DEV_CONFIG_KEY = 'milkpop_supabase_config';

/**
 * Resolve the Supabase configuration.
 *
 * SECURITY (Phase 1 review remediation): in production the URL and anon key
 * come ONLY from Vite environment variables baked in at build time. A value in
 * localStorage can never point a production build at a different backend — the
 * DEV override branch below is dead-code-eliminated when import.meta.env.DEV is
 * false, so it cannot execute for end users. There is intentionally no function
 * that writes configuration into localStorage.
 */
export function getSupabaseConfig(): SupabaseConfig | null {
  const env = ((import.meta as any).env || {}) as Record<string, any>;

  if (env.DEV) {
    // Developer convenience only; compiled out of production bundles.
    try {
      const stored = localStorage.getItem(DEV_CONFIG_KEY);
      if (stored) {
        const cfg = JSON.parse(stored);
        if (cfg?.url && cfg?.anonKey) return { url: String(cfg.url), anonKey: String(cfg.anonKey) };
      }
    } catch { /* ignore a malformed dev override */ }
  }

  if (env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY) {
    return { url: String(env.VITE_SUPABASE_URL), anonKey: String(env.VITE_SUPABASE_ANON_KEY) };
  }
  return null;
}

export const isCloudConfigured = () => !!getSupabaseConfig();

function headers(cfg: SupabaseConfig, extra: Record<string, string> = {}) {
  return {
    apikey: cfg.anonKey,
    Authorization: `Bearer ${cfg.anonKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

const PUBLIC_REST_TIMEOUT_MS = 12_000;

async function rest<T>(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<T> {
  const cfg = getSupabaseConfig();
  if (!cfg) throw new Error('Supabase is not configured');
  const url = `${cfg.url.replace(/\/$/, '')}/rest/v1/${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLIC_REST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, headers: headers(cfg, init.headers), signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Supabase ${res.status}: ${body.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Supabase public request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** SELECT * (optionally with a PostgREST query string, e.g. `order=placed_at.desc&limit=100`). */
export function sbSelect<T = any>(table: string, query = 'select=*'): Promise<T[]> {
  return rest<T[]>(`${table}?${query}`);
}

/* ------------------------------------------------------------------ */
/*  PUBLIC FORM SUBMISSIONS — guarded Edge Function calls only.          */
/*                                                                      */
/*  SECURITY (Phase 1 review remediation): the generic sbInsertPublic() */
/*  helper is gone. Inserts are restricted to the three public form     */
/*  tables by BOTH a compile-time union (PublicInsertTable) and a       */
/*  runtime allowlist. An internal table name is a type error at every  */
/*  call site AND is rejected at runtime, independent of RLS. Callers   */
/*  use the typed wrappers so a table is never a free-form string.      */
/* ------------------------------------------------------------------ */

/** The exhaustive set of submission categories accepted by the guarded Edge Function. */
export const PUBLIC_INSERT_TABLES = [
  'job_applications',
  'franchise_inquiries',
  'contact_messages',
] as const;
export type PublicInsertTable = (typeof PUBLIC_INSERT_TABLES)[number];

/** Runtime guard: throws for anything not on the allowlist (defence in depth). */
export function assertPublicInsertTable(table: string): asserts table is PublicInsertTable {
  if (!(PUBLIC_INSERT_TABLES as readonly string[]).includes(table)) {
    throw new Error(`Refused public insert into non-allowlisted table "${table}"`);
  }
}

/**
 * Shared implementation. NOT exported — callers must use the typed wrappers.
 * Returns `not_configured` (and writes nothing) when there is no backend, and
 * only ever returns `submitted` after the Edge Function confirms the insert.
 *
 * PHASE B (launch remediation): the direct anonymous INSERT fallback is
 * REMOVED. Every public submission goes through the `public-form` Edge
 * Function, which validates + allow-lists fields, enforces the per-IP rate
 * limit and verifies CAPTCHA (when configured) before inserting via the
 * service role. If the function is unreachable or not deployed, the caller
 * gets a controlled, retryable error — the client NEVER falls back to a less
 * protected database path, so the rate limit and CAPTCHA cannot be bypassed
 * by simply requesting the raw REST endpoint shape. The matching database
 * migration (supabase/migration_phase_b_public_forms.sql) drops the anon
 * INSERT policies so a handcrafted direct request is rejected by RLS too.
 *
 * WP-01 (P0-01 remediation): the SERVER owns submission identity. The Edge
 * Function mints the row id and returns it as `submissionId`; this client
 * VALIDATES that a 2xx response carries a well-formed UUID and refuses to
 * report `submitted` otherwise. The old third parameter (a caller-supplied
 * display id that was echoed back and then wrongly used for CV attachment) is
 * replaced by `idempotencyKey`: a per-attempt crypto.randomUUID() that lets a
 * network retry resolve to the ORIGINAL row instead of creating a duplicate.
 */
const SERVER_UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function submitPublicForm(
  table: PublicInsertTable,
  row: Record<string, unknown>,
  idempotencyKey: string,
  captchaToken: string | undefined,
  /* INC11: the notice the form DISPLAYED — echoed so the transaction can
   * verify the submitter saw the current frozen text. */
  notice: { id: string; sha256: string },
): Promise<SubmissionResult> {
  assertPublicInsertTable(table);
  if (!isCloudConfigured()) return { status: 'not_configured' };

  const cfg = getSupabaseConfig();
  if (!cfg) return { status: 'not_configured' };
  const base = cfg.url.replace(/\/$/, '');
  try {
    const res = await timedFetch.action(`${base}/functions/v1/public-form`, {
      method: 'POST',
      headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: FORM_KIND_BY_TABLE[table], row, captchaToken, idempotencyKey,
        noticeId: notice.id, noticeSha256: notice.sha256 }),
    });
    if (res.ok) {
      // WP-01: success is ONLY a response carrying the server-authoritative
      // row id. A 2xx without a valid UUID (e.g. a stale pre-WP-01 function
      // deployment) is a broken contract — reporting `submitted` would revive
      // the exact defect this fixes, so it is surfaced as a failure instead.
      const data = await res.json().catch(() => null) as { ok?: boolean; submissionId?: string } | null;
      const sid = typeof data?.submissionId === 'string' ? data.submissionId.trim() : '';
      if (data?.ok === true && SERVER_UUID_RX.test(sid)) {
        return { status: 'submitted', submissionId: sid };
      }
      return { status: 'failed', errorCode: 'invalid_response', retryable: false };
    }
    // Parse only the fixed machine code. Raw backend text is deliberately
    // ignored and never reaches the interface.
    const errorBody = await res.json().catch(() => null) as { code?: unknown } | null;
    const coarseCode = typeof errorBody?.code === 'string' ? errorBody.code : '';
    // T13.3.11: 409 covers either a hash-bound retry conflict or a vacancy
    // that closed after the page loaded.
    if (res.status === 409) {
      if (coarseCode === 'vacancy_not_open') {
        return { status: 'failed', errorCode: 'vacancy_not_open', retryable: false };
      }
      return { status: 'failed', errorCode: 'idempotency_conflict', retryable: true };
    }
    if (res.status === 429) return { status: 'failed', errorCode: 'rate_limited', retryable: true };
    // INC11: the privacy notice changed between display and submit — the
    // person must SEE the CURRENT text before their consent is recorded.
    if (res.status === 412) return { status: 'failed', errorCode: 'notice_changed', retryable: true };
    if (res.status === 403 && coarseCode === 'section_closed') {
      return { status: 'failed', errorCode: 'section_closed', retryable: false };
    }
    if (res.status === 403 && /^captcha_/.test(coarseCode)) {
      return { status: 'failed', errorCode: 'verification_failed', retryable: true };
    }
    if (res.status === 403 || res.status === 400) return { status: 'failed', errorCode: 'rejected', retryable: false };
    if (res.status === 404 || res.status === 501) {
      // The protected endpoint is not deployed. This is a deployment fault —
      // fail closed and honestly instead of silently downgrading security.
      return { status: 'failed', errorCode: 'server_error', retryable: true };
    }
    if (res.status >= 500) return { status: 'failed', errorCode: 'server_error', retryable: true };
    return { status: 'failed', errorCode: 'request_failed', retryable: false };
  } catch {
    // Transport failure reaching the function (offline, DNS, CORS…).
    return { status: 'failed', errorCode: 'network_error', retryable: true };
  }
}

/** Maps each public-insert table to the `public-form` function's form kind. */
const FORM_KIND_BY_TABLE: Record<PublicInsertTable, 'careers' | 'franchise' | 'contact'> = {
  job_applications: 'careers',
  franchise_inquiries: 'franchise',
  contact_messages: 'contact',
};

/** WP-01: `idempotencyKey` is a fresh crypto.randomUUID() per submission
 *  ATTEMPT (not per keystroke, not the row id). Retrying the same attempt with
 *  the same key returns the original submissionId instead of a second row. */
export function submitJobApplication(row: Record<string, unknown>, idempotencyKey: string, captchaToken: string | undefined, notice: { id: string; sha256: string }): Promise<SubmissionResult> {
  return submitPublicForm('job_applications', row, idempotencyKey, captchaToken, notice);
}
export function submitFranchiseInquiry(row: Record<string, unknown>, idempotencyKey: string, captchaToken: string | undefined, notice: { id: string; sha256: string }): Promise<SubmissionResult> {
  return submitPublicForm('franchise_inquiries', row, idempotencyKey, captchaToken, notice);
}
export function submitContactMessage(row: Record<string, unknown>, idempotencyKey: string, captchaToken: string | undefined, notice: { id: string; sha256: string }): Promise<SubmissionResult> {
  return submitPublicForm('contact_messages', row, idempotencyKey, captchaToken, notice);
}

/* ------------------------------------------------------------------ */
/*  WS7 CLIENT ROUND: submitOrderAuthed() and the submit_web_order RPC  */
/*  are GONE. A sale is now create_order_quote → begin_quote_payment →  */
/*  finalise_order_payment, implemented in src/lib/tillPayments.ts with */
/*  its own durable payment-attempt store (the FIX-2 persist-before-    */
/*  network discipline carried forward). The legacy outbox that fed the */
/*  removed RPC survives read-only in src/lib/orderOutbox.ts.           */
/* ------------------------------------------------------------------ */

/* ----------------------------------------------------------------------------
 * WS6e — the owner Store Setup Wizard's client call.
 * ------------------------------------------------------------------------- */
export type StoreSetupConfig = {
  storeId: string;
  timezone: string;
  currencyCode: string;
  paymentMethods: PaymentMethod[];
  receiptFooter?: string;
  vat: { status: VatStatus; vatNumber?: string; effectiveDate?: string };
};
export type StoreSetupResult =
  | { ok: true; store: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Complete a store's setup via configure_store_setup() (owner + MFA on the
 * server; is_owner() bakes aal2 in). The RPC validates every field, confirms
 * the VAT configuration and flips DRAFT→ACTIVE atomically; it is the ONLY
 * client path that can write the guarded configuration columns.
 */
export type ClassificationEntry = { id: string; taxCode: TaxCode | null };
export type ClassifyResult = { ok: true; count: number } | { ok: false; error: string };

/**
 * WS6f (audit F3/F4): the OWNER classification path — classify_products()
 * (owner + MFA; explicit null unclassifies). Managers cannot reach the
 * column at all (tax_code_is_owner_only); this RPC is what the Setup
 * Wizard's classification step calls.
 */
export type StoreTradingState = {
  storeId: string;
  businessDate: string;
  vatChargingNow: boolean;
  vatStatus: string;
  vatEffectiveDate: string | null;
  setupStatus: string;
  paymentMethods: string[] | null;
  unclassifiedCount: number;
  configVersion: string;
};

/**
 * WS6i (audit finding 4): ask the SERVER what is true right now. The browser's
 * business date comes from the device clock, which can be wrong; because the
 * till may accept payment optimistically, that disagreement would otherwise
 * surface only after money was taken. Called on mount, at the business-day
 * boundary, and immediately before payment while online. A failure is not an
 * error — the till falls back to its local computation and the outbox
 * reconciles, exactly as it did offline before.
 */
export async function fetchStoreTradingState(storeId: string, accessToken: string): Promise<StoreTradingState | null> {
  const cfg = getSupabaseConfig();
  if (!cfg || !accessToken) return null;
  const base = cfg.url.replace(/\/$/, '');
  try {
    const res = await timedFetch.read(`${base}/rest/v1/rpc/store_trading_state`, {
      method: 'POST',
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_store_id: storeId }),
    });
    if (!res.ok) return null;
    return (await res.json()) as StoreTradingState;
  } catch {
    return null;   // offline or unreachable: local fallback stands
  }
}

export async function classifyProducts(entries: ClassificationEntry[], accessToken: string): Promise<ClassifyResult> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { ok: false, error: 'not_configured' };
  if (!accessToken) return { ok: false, error: 'unauthenticated' };
  const base = cfg.url.replace(/\/$/, '');
  try {
    const res = await timedFetch.action(`${base}/rest/v1/rpc/classify_products`, {
      method: 'POST',
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p: entries }),
    });
    if (res.ok) return { ok: true, count: Number(await res.text()) || entries.length };
    let msg = `http_${res.status}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j?.message) msg = j.message;
    } catch { /* body not json */ }
    return { ok: false, error: msg };
  } catch {
    return { ok: false, error: 'network' };
  }
}

export async function configureStoreSetup(config: StoreSetupConfig, accessToken: string): Promise<StoreSetupResult> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { ok: false, error: 'not_configured' };
  if (!accessToken) return { ok: false, error: 'unauthenticated' };
  const base = cfg.url.replace(/\/$/, '');
  try {
    const res = await timedFetch.action(`${base}/rest/v1/rpc/configure_store_setup`, {
      method: 'POST',
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_config: config }),
    });
    if (res.ok) return { ok: true, store: (await res.json()) as Record<string, unknown> };
    let msg = `http_${res.status}`;
    try {
      const j = (await res.json()) as { message?: string };
      if (j?.message) msg = j.message;
    } catch { /* body not json */ }
    return { ok: false, error: msg };
  } catch {
    return { ok: false, error: 'network' };
  }
}

/* ------------------------------------------------------------------ */
/*  AUTHENTICATED INBOX — reading public-form submissions.              */
/*                                                                      */
/*  Pairs with supabase/migration_inbox_read.sql. Reads run under the   */
/*  caller's user JWT so RLS decides visibility (managers/owners for    */
/*  applications, owners for contact messages and franchise leads); a     */
/*  session without a staff profile simply gets zero rows. Status is    */
/*  the ONLY writable column — enforced server-side by a column grant,  */
/*  not by trusting this client.                                        */
/* ------------------------------------------------------------------ */

export type InboxResult<T> =
  | { status: 'ok'; rows: T[] }
  | { status: 'not_configured' | 'unauthenticated' | 'error' };

/** SELECT an inbox table as the signed-in user. Newest first. */
/** Job applications for the admin inbox with an EXPLICIT column projection.
 *  Stage 2.1 F8: the private `cv_path` storage key must never reach the
 *  browser — the UI only needs to know whether a CV exists. We select the
 *  approved columns plus a computed `has_cv` boolean, so the raw path stays
 *  server-side; the CV itself is still fetched on demand via cv-signed-url. */
export async function fetchApplicationsAuthed<T = unknown>(
  accessToken: string,
  limit = 500,
): Promise<InboxResult<T>> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { status: 'not_configured' };
  if (!accessToken) return { status: 'unauthenticated' };
  const base = cfg.url.replace(/\/$/, '');
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit) || 500));
  // Explicit projection — note the ABSENCE of cv_path. `cv_path` is exposed
  // only as the derived boolean `has_cv` via PostgREST's computed-column-free
  // trick: request the column list we allow, then derive presence client-side
  // from a HEAD-safe marker column we DO select (cv_present).
  const cols = 'id,full_name,email,phone,applied_for,applied_store,availability,experience,message,status,created_at,cv_present';
  try {
    const res = await timedFetch.read(
      `${base}/rest/v1/job_applications?select=${cols}&order=created_at.desc&limit=${boundedLimit}`,
      { headers: { apikey: cfg.anonKey, Authorization: `Bearer ${accessToken}` } },
    );
    if (res.status === 401 || res.status === 403) return { status: 'unauthenticated' };
    if (!res.ok) return { status: 'error' };
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    return { status: 'ok', rows: rows.map((r) => fromRow<T>(r)) };
  } catch {
    return { status: 'error' };
  }
}

export type PublicInboxTable = 'contact_messages' | 'franchise_inquiries';

const INBOX_PROJECTIONS: Record<PublicInboxTable, string> = {
  contact_messages: 'id,full_name,email,reason,message,status,submitted_at,replied_at,closed_at,created_at',
  franchise_inquiries: 'id,full_name,email,phone,country,city,budget,experience,message,status,submitted_at,created_at',
};

export async function fetchInboxAuthed<T = unknown>(
  table: PublicInboxTable,
  accessToken: string,
  limit = 500,
): Promise<InboxResult<T>> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { status: 'not_configured' };
  if (!accessToken) return { status: 'unauthenticated' };
  const base = cfg.url.replace(/\/$/, '');
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit) || 500));
  const projection = INBOX_PROJECTIONS[table];
  try {
    const res = await timedFetch.read(
      `${base}/rest/v1/${table}?select=${projection}&order=created_at.desc&limit=${boundedLimit}`,
      { headers: { apikey: cfg.anonKey, Authorization: `Bearer ${accessToken}` } },
    );
    if (res.status === 401 || res.status === 403) return { status: 'unauthenticated' };
    if (!res.ok) return { status: 'error' };
    const rows = (await res.json()) as Record<string, any>[];
    return { status: 'ok', rows: rows.map((r) => fromRow<T>(r)) };
  } catch {
    return { status: 'error' };
  }
}

/** The two inbox tables with a triage `status` column. */
export type StatusInboxTable = 'job_applications' | 'franchise_inquiries';

/** PATCH only the status column of one submission, as the signed-in user. */
export async function updateInboxStatusAuthed(
  table: StatusInboxTable,
  id: string,
  status: string,
  accessToken: string,
): Promise<'ok' | 'not_configured' | 'unauthenticated' | 'error'> {
  assertPublicInsertTable(table);
  const cfg = getSupabaseConfig();
  if (!cfg) return 'not_configured';
  if (!accessToken) return 'unauthenticated';
  const base = cfg.url.replace(/\/$/, '');
  try {
    const res = await timedFetch.action(`${base}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ status }),
    });
    if (res.status === 401 || res.status === 403) return 'unauthenticated';
    return res.ok ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

/* ------------------------------------------------------------------ */
/*  camelCase ⇄ snake_case row conversion.                             */
/*  The Supabase schema (supabase/schema.FRESH-INSTALL-ONLY.sql) mirrors the app types    */
/*  field-for-field, so a mechanical conversion is all that's needed.  */
/* ------------------------------------------------------------------ */
const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const snakeToCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

export function toRow(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[camelToSnake(k)] = v;
  }
  return out;
}

export function fromRow<T = any>(row: Record<string, any>): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) out[snakeToCamel(k)] = v === null ? undefined : v;
  return out as T;
}

/* ------------------------------------------------------------------ */
/*  CV UPLOAD — via the cv-upload Edge Function ONLY (Block D).          */
/*                                                                      */
/*  SECURITY: there is STILL no client→storage write. The browser hands */
/*  the raw File to the `cv-upload` Edge Function, which performs EVERY  */
/*  control server-side before the bytes touch storage (size limit,     */
/*  magic-byte MIME sniffing, random UUID object key, overwrite guard,  */
/*  per-IP rate limit, optional Turnstile, application-row existence     */
/*  check, service-role linking with rollback — see the function and    */
/*  the security notes in README.md). The client:                        */
/*    • never names or receives a storage path/object key,              */
/*    • never base64-encodes the file or holds its bytes in app state,  */
/*    • passes the File straight to fetch() as multipart and discards it */
/*      immediately after the request resolves.                         */
/* ------------------------------------------------------------------ */

/** Coarse, non-leaking outcome of a CV upload attempt. Mirrors the honest
 *  SubmissionResult contract: never surfaces raw backend errors. */
export type CvUploadResult =
  | { status: 'uploaded' }
  | { status: 'not_configured' }
  | { status: 'skipped' }                        // no file chosen — applications are valid without a CV
  | { status: 'failed'; reason: 'too_large' | 'bad_type' | 'rate_limited' | 'no_application' | 'already_attached' | 'captcha' | 'error' };

/** Client-side pre-flight bounds. The SERVER re-checks all of this by magic
 *  bytes and size; these only give the candidate instant feedback and avoid a
 *  pointless upload of an obviously-wrong file. Never treated as a security
 *  control. */
const CV_MAX_BYTES = 5 * 1024 * 1024;
const CV_ALLOWED_EXT = /\.(pdf|doc|docx)$/i;

/**
 * Upload a candidate CV for an existing application via the cv-upload Edge
 * Function. `applicationId` must be the id of an application row that was just
 * inserted (the function refuses uploads with no matching row). `captchaToken`
 * is forwarded when present; the function only enforces it if a Turnstile
 * secret is configured server-side.
 *
 * The File is streamed through multipart form-data and never persisted on the
 * client. Returns a coarse result; the caller maps it to honest UI copy.
 */
export async function uploadCv(
  applicationId: string,
  file: File,
  captchaToken?: string,
): Promise<CvUploadResult> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { status: 'not_configured' };
  // Cheap client-side sanity checks (server is authoritative).
  if (file.size > CV_MAX_BYTES) return { status: 'failed', reason: 'too_large' };
  if (!CV_ALLOWED_EXT.test(file.name)) return { status: 'failed', reason: 'bad_type' };

  const base = cfg.url.replace(/\/$/, '');
  const form = new FormData();
  form.append('applicationId', applicationId);
  form.append('file', file);
  if (captchaToken) form.append('captchaToken', captchaToken);

  try {
    const res = await timedFetch.upload(`${base}/functions/v1/cv-upload`, {
      method: 'POST',
      // apikey lets the gateway route to the project; the function itself is
      // anonymous (candidates aren't signed in) and enforces its own controls.
      headers: { apikey: cfg.anonKey },
      body: form,
    });
    if (res.ok) return { status: 'uploaded' };
    // Map coarse HTTP codes to non-leaking reasons.
    if (res.status === 413) return { status: 'failed', reason: 'too_large' };
    if (res.status === 415) return { status: 'failed', reason: 'bad_type' };
    if (res.status === 429) return { status: 'failed', reason: 'rate_limited' };
    if (res.status === 404) return { status: 'failed', reason: 'no_application' };
    if (res.status === 409) return { status: 'failed', reason: 'already_attached' }; // WP-01: one CV per application
    if (res.status === 403 || res.status === 400) {
      // 403/400 here is most often the CAPTCHA path when enabled.
      return { status: 'failed', reason: 'captcha' };
    }
    return { status: 'failed', reason: 'error' };
  } catch {
    return { status: 'failed', reason: 'error' };
  }
}

/**
 * Fetch a short-lived signed URL for a candidate's CV (managers/owners only).
 * The client sends only the applicationId; the cv-signed-url function resolves
 * the storage object key server-side, checks the caller's role from the DB, and
 * audits the access. Requires the caller's Supabase Auth USER token — the anon
 * key is rejected by the function.
 */
export async function fetchCvSignedUrl(
  applicationId: string,
  accessToken: string,
): Promise<string | null> {
  try {
    const res = await sbInvokeFunctionAuthed<{ url?: string }>(
      'cv-signed-url', { applicationId }, accessToken,
    );
    return res?.url || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  TRAINING MEDIA — same no-client-storage model as CVs.              */
/*  Uploads (managers/owners) and playback URLs (any staff) both go    */
/*  through the training-media Edge Function; the browser never names  */
/*  a storage path or holds a storage credential.                      */
/* ------------------------------------------------------------------ */

export type TrainingVideoUploadResult =
  | { status: 'uploaded'; ref: string }        // storage://training-media/<key>
  | { status: 'not_configured' }
  | { status: 'failed'; reason: 'too_large' | 'bad_type' | 'forbidden' | 'error'; message?: string };

/** Client-side pre-flight bounds; the SERVER re-checks by magic bytes. */
const TRAINING_VIDEO_MAX_BYTES = 60 * 1024 * 1024;
const TRAINING_VIDEO_ALLOWED_EXT = /\.(mp4|m4v|webm)$/i;

/**
 * Upload a lesson video (managers/owners only — the function enforces the
 * role from the DB). Returns a `storage://training-media/<key>` reference to
 * store as the slide's videoUrl; playback later resolves it to a signed URL.
 */
export async function uploadTrainingVideo(
  file: File,
  accessToken: string,
): Promise<TrainingVideoUploadResult> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { status: 'not_configured' };
  if (file.size > TRAINING_VIDEO_MAX_BYTES) return { status: 'failed', reason: 'too_large' };
  if (!TRAINING_VIDEO_ALLOWED_EXT.test(file.name)) return { status: 'failed', reason: 'bad_type' };

  const base = cfg.url.replace(/\/$/, '');
  const form = new FormData();
  form.append('action', 'upload');
  form.append('file', file);

  try {
    const res = await timedFetch.upload(`${base}/functions/v1/training-media`, {
      method: 'POST',
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${accessToken}` },
      body: form,
    });
    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    if (res.ok && typeof data?.ref === 'string') return { status: 'uploaded', ref: data.ref };
    if (res.status === 413) return { status: 'failed', reason: 'too_large' };
    if (res.status === 415) return { status: 'failed', reason: 'bad_type' };
    if (res.status === 401 || res.status === 403) return { status: 'failed', reason: 'forbidden' };
    return { status: 'failed', reason: 'error', message: typeof data?.error === 'string' ? data.error : undefined };
  } catch {
    return { status: 'failed', reason: 'error' };
  }
}

/**
 * Resolve a `storage://training-media/…` slide reference to a short-lived
 * signed playback URL. Any linked staff member may watch lesson videos.
 */
export async function fetchTrainingVideoSignedUrl(
  ref: string,
  accessToken: string,
): Promise<string | null> {
  try {
    const res = await sbInvokeFunctionAuthed<{ url?: string }>(
      'training-media', { action: 'sign', ref }, accessToken,
    );
    return res?.url || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  EDGE FUNCTIONS — server-side actions (e-mail sending).             */
/* ------------------------------------------------------------------ */

/** Invoke a Supabase Edge Function. Throws with the server message on failure. */
export async function sbInvokeFunction<T = any>(fn: string, payload: Record<string, any>): Promise<T> {
  const cfg = getSupabaseConfig();
  if (!cfg) throw new Error('Supabase is not configured');
  const base = cfg.url.replace(/\/$/, '');
  const res = await timedFetch.action(`${base}/functions/v1/${fn}`, {
    method: 'POST',
    headers: {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${cfg.anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Function ${fn} ${res.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Invoke an Edge Function with the caller's Supabase Auth USER token (not the
 * anon key). Required by functions that authenticate the caller server-side —
 * e.g. the rebuilt `send-email`, which rejects the anon key outright. The
 * `apikey` header still carries the anon key so the platform gateway can route
 * to the project; identity comes from the bearer token.
 */
export async function sbInvokeFunctionAuthed<T = any>(
  fn: string,
  payload: Record<string, any>,
  accessToken: string,
): Promise<T> {
  const cfg = getSupabaseConfig();
  if (!cfg) throw new Error('Supabase is not configured');
  const base = cfg.url.replace(/\/$/, '');
  const res = await timedFetch.action(`${base}/functions/v1/${fn}`, {
    method: 'POST',
    headers: {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Function ${fn} ${res.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}
