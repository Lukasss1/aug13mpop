// ============================================================================
//  MILK POP — public-form Edge Function  (Block E / the security notes in README.md)
//
//  Guarded submission path for the three anonymous public forms (careers /
//  franchise / contact). Anonymous callers have NO direct table privileges;
//  every write must pass the controls in this function:
//
//    1. CAPTCHA (optional)  — Cloudflare Turnstile, verified server-side ONLY
//                             when TURNSTILE_SECRET is set (so it can be enabled
//                             without a redeploy).
//    2. Per-IP rate limit   — accepted submissions are reserved atomically by
//                             a keyed-IP pseudonym; invalid traffic creates no row.
//    3. Field allow-listing — each form has a FIXED set of columns; anything
//                             else the client sends is dropped. The row is then
//                             inserted with the service-role key.
//
//  The service-role insert happens only after CAPTCHA/rate-limit/privacy gates.
//  PostgREST cannot bypass this function because the anon role has neither
//  INSERT nor SELECT on the three submission tables.
//
//  Deploy WITHOUT "Verify JWT" (callers are anonymous visitors).
// ============================================================================

import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';
import { turnstileGate } from '../_shared/appEnv.ts';
import { EXTERNAL_PROVIDER_TIMEOUT_MS, ProviderTimeoutError, fetchProviderJson } from '../_shared/providerFetch.ts';
import { clientIp, hmacIp } from '../_shared/ip.ts';
import { readBoundedJson, requestBodyResponse } from '../_shared/request.ts';

const RATE_IP_PER_HOUR = 8;   // submissions per IP per rolling hour (across all three forms)
const MAX_REQUEST_BYTES = 32 * 1024; // hard cap before JSON parsing

type FormKind = 'careers' | 'franchise' | 'contact';

// Fixed column allow-list + target table per form. A client can NEVER write a
// column that isn't listed here, and never choose the table.
// FIX (forensic audit PUB-001): id, status and the applied_at/submitted_at
// timestamps are WORKFLOW metadata the service owns — a public caller could
// previously submit a privileged-looking status, a falsified chronology or a
// colliding id. They are no longer accepted; the server generates all three
// below (serverFields), so a crafted value never reaches the row.
const FORMS: Record<FormKind, { table: string; columns: string[]; required: string[]; enums: Record<string, string[]> }> = {
  careers: {
    table: 'job_applications',
    columns: ['full_name', 'email', 'phone', 'vacancy_id', 'applied_for', 'applied_store', 'availability', 'experience', 'message'],
    // WP-02: required fields are enforced HERE for an honest 400 and AGAIN
    // inside submit_public_form() as the transactional last line of defence.
    // applied_store is deliberately not an enum: the store list is CMS-driven
    // and placeholder seeds are being replaced pre-launch (see phase report).
    required: ['full_name', 'email', 'phone', 'vacancy_id', 'applied_for', 'availability'],
    enums: {},
  },
  franchise: {
    table: 'franchise_inquiries',
    columns: ['full_name', 'email', 'phone', 'country', 'city', 'budget', 'experience', 'message'],
    required: ['full_name', 'email', 'country', 'city', 'budget', 'experience'],
    enums: {
      budget: ['£50,000 - £100,000', '£100,000 - £150,000', '£150,000 - £300,000', '£300,000+'],
      experience: ['Yes, multi-site retail', 'Single coffee unit', 'Corporate background'],
    },
  },
  contact: {
    table: 'contact_messages',
    columns: ['full_name', 'email', 'reason', 'message'],
    required: ['full_name', 'email', 'message'],
    enums: {
      reason: ['General feedback', 'Career queries', 'Partnerships', 'Other'],
    },
  },
};

// Task 6: conservative per-field length caps, enforced just before the
// service-role insert. The target columns are unbounded text; the per-IP rate
// limit tempers volume but not per-row size, so this is cheap insurance
// against megabyte rows. Caps are generous for legitimate input.
const FIELD_MAX: Record<string, number> = {
  id: 64,             // uuid (36) + slack
  idempotency_key: 64, // uuid (36) + slack — server-validated format before insert
  full_name: 200,
  email: 320,         // RFC 5321 theoretical max is 320 (64 local + @ + 255 domain)
  phone: 50,
  vacancy_id: 100,
  applied_for: 200,
  applied_store: 100,
  availability: 500,
  experience: 5000,
  message: 5000,
  status: 50,
  applied_at: 64,     // ISO timestamp
  submitted_at: 64,   // ISO timestamp
  country: 100,
  city: 100,
  budget: 100,
  reason: 200,
};
// Fail-closed default for any allow-listed column ever added without a cap.
const FIELD_MAX_DEFAULT = 1000;

// R4.8 (Workstream E): delegate to the shared FAIL-CLOSED builder. Production
// requires an exact-origin allow-list; untrusted origins get 'null', never '*'
// and never "first allowed origin". See _shared/cors.ts.
function corsHeaders(origin: string | null): Record<string, string> {
  return buildCorsHeaders(origin, ["CV_ALLOWED_ORIGINS","FORM_ALLOWED_ORIGINS"], 'POST, OPTIONS');
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, cors);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  // R4.8 (Workstream D): explicit fail-closed Turnstile state. 'refuse' means a
  // production misconfiguration (enabled without a secret, or state undeclared
  // in production) — the function declines NEW submissions with a typed error
  // instead of silently running without CAPTCHA.
  const TS_GATE = turnstileGate();
  const TURNSTILE_SECRET = TS_GATE.mode === 'enforce' ? TS_GATE.secret : '';
  if (!SUPABASE_URL || !SERVICE) return json({ error: 'Server is not configured.' }, 500, cors);
  const baseUrl = SUPABASE_URL.replace(/\/$/, '');

  const svc = (path: string, init: RequestInit = {}) =>
    fetchInternal(`${baseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> || {}),
      },
    });

  const abuseSecret = Deno.env.get('ABUSE_HMAC_SECRET') || SERVICE;
  const ipHash = await hmacIp(req, abuseSecret, 'public-form:v1');

  let input: Record<string, unknown>;
  try {
    input = await readBoundedJson(req, MAX_REQUEST_BYTES);
  } catch (error) {
    const failure = requestBodyResponse(error);
    return json(failure.body, failure.status, cors);
  }

  const kind = String(input?.kind || '') as FormKind;
  const spec = FORMS[kind];
  if (!spec) return json({ error: 'Unknown form.' }, 400, cors);

  // Rejections are response-only. Anonymous invalid requests must not amplify
  // into an unbounded database row stream; the atomic SQL path records only
  // accepted submissions and enforces their budget.
  const reject = (reason: string, message: string, code: number) =>
    json({ error: message, code: reason }, code, cors);

  // --- 1. Field allow-listing + honest validation ---------------------------
  // WP02.1 ORDER (spec §6.3): validate → canonical hash → resolve known
  // idempotency keys → ONLY THEN spend a CAPTCHA verification → atomic insert.
  // Turnstile tokens are single-use, so a lost-response retry cannot replay
  // its token; resolving first means a retry needs no token at all, and a
  // fresh token is required exactly for genuinely NEW inserts.
  // WP-02: the separate HEAD-count rate check is GONE. Rate reservation,
  // idempotency resolution, the insert and the accepted audit row now happen
  // in ONE transaction inside submit_public_form() (advisory-locked per IP),
  // so concurrent submissions can no longer exceed the nominal limit.
  const rawRow = input?.row;
  if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
    return reject('invalid_body', 'Invalid request body.', 400);
  }
  const rowIn = rawRow as Record<string, unknown>;
  const row: Record<string, string> = {};
  for (const col of spec.columns) {
    if (!(col in rowIn) || rowIn[col] === undefined) continue;
    if (typeof rowIn[col] !== 'string') {
      return reject('invalid_body', 'Invalid request body.', 400);
    }
    row[col] = rowIn[col];
  }
  // Minimal integrity: a plausibly-formatted email is required for every form.
  const email = String(row['email'] || '').trim();
  if (!email) return reject('missing_email', 'An email address is required.', 400);
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return reject('invalid_email', 'Please provide a valid email address.', 400);
  }
  // WP-02: per-form required fields — an honest 400 here, and enforced again
  // transactionally inside the RPC in case a crafted client skips this layer.
  for (const req of spec.required) {
    if (!String(row[req] ?? '').trim()) {
      return reject('missing_required', 'Please complete all required fields.', 400);
    }
  }
  // WP-02: enumerated dropdowns accept ONLY the published options.
  for (const [col, options] of Object.entries(spec.enums)) {
    if (!options.includes(String(row[col] ?? ''))) {
      return reject('invalid_option', 'Please choose one of the listed options.', 400);
    }
  }
  // Normalise whitespace/e-mail casing server-side (the RPC trims again).
  for (const [col, v] of Object.entries(row)) {
    if (typeof v === 'string') row[col] = v.trim();
  }
  row['email'] = email.toLowerCase();
  const phone = String(row['phone'] || '').trim();
  if (phone) {
    const phoneDigits = phone.replace(/\D/g, '');
    if (!/^[+0-9(][0-9 ()-]{6,49}$/.test(phone) || phoneDigits.length < 7 || phoneDigits.length > 15) {
      return reject('invalid_phone', 'Please provide a valid telephone number.', 400);
    }
    row['phone'] = phone;
  }

  // WP-01: optional client idempotency key. When the browser retries a
  // submission after a lost response, it re-sends the SAME key; the unique
  // index (migration_wp01_public_form_identity.sql) makes the database the
  // atomic arbiter and the RPC answers the retry with the ORIGINAL row's id
  // instead of creating a second row. Absent key = no dedupe (legacy client).
  // Format is validated strictly; a malformed key is a client bug and is
  // rejected with the same coarse response as any invalid body.
  const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // INC11: the notice the form DISPLAYED, echoed for the transactional
  // verification. Coerced to plain strings; the database is the authority on
  // whether they match the CURRENT frozen notice.
  const noticeId = typeof input?.noticeId === 'string' ? input.noticeId.trim() : '';
  const noticeSha256 = typeof input?.noticeSha256 === 'string' ? input.noticeSha256.trim().toLowerCase() : '';
  if (!noticeId || noticeId.length > 200 || !/^[0-9a-f]{64}$/.test(noticeSha256)) {
    return reject('invalid_body', 'Invalid request body.', 400);
  }

  const idemRaw = input?.idempotencyKey;
  let idempotencyKey: string | null = null;
  if (idemRaw !== undefined && idemRaw !== null && idemRaw !== '') {
    if (typeof idemRaw !== 'string' || !UUID_RX.test(idemRaw.trim())) {
      return reject('invalid_body', 'Invalid request body.', 400);
    }
    idempotencyKey = idemRaw.trim().toLowerCase();
  }

  // Task 6: per-field length caps (see FIELD_MAX above). Over-limit input is
  // rejected with the SAME coarse response as malformed JSON — no new error
  // code and no per-field detail, so the response leaks nothing about which
  // field or limit was hit. String values are measured directly; non-string
  // values are measured via String() so an oversized array can't slip past.
  for (const [col, v] of Object.entries(row)) {
    const len = typeof v === 'string' ? v.length : String(v).length;
    if (len > (FIELD_MAX[col] ?? FIELD_MAX_DEFAULT)) {
      return reject('invalid_body', 'Invalid request body.', 400);
    }
  }

  // --- 2. Canonical request hash (WP01.1 / P1-R2) ----------------------------
  // SHA-256 over a canonical JSON of the ALLOW-LISTED, NORMALISED row —
  // computed here, server-side, never trusted from the client. Stable field
  // order (sorted keys) makes the hash deterministic; binding it to the
  // idempotency key means "same key, different data" can never silently
  // resolve to the wrong submission.
  const canonical = JSON.stringify({ kind, row: Object.fromEntries(Object.keys(row).sort().map((k) => [k, row[k]])) });
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const requestHash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');

  // --- 3. Resolve a known idempotency key BEFORE CAPTCHA (WP02.1 / P1-R3) ----
  let idempotencyLookupConclusive = !idempotencyKey;
  if (idempotencyKey) {
    try {
      const rs = await svc('rpc/resolve_public_submission', {
        method: 'POST',
        body: JSON.stringify({ p_kind: kind, p_idempotency_key: idempotencyKey, p_request_hash: requestHash }),
      });
      if (rs.ok) {
        const r = await rs.json().catch(() => null) as { found?: boolean; submission_id?: string; conflict?: boolean } | null;
        if (r?.conflict === true) {
          // Same key, different payload: an explicit, honest refusal. The
          // browser rotates its attempt key on payload edits, so only a
          // crafted or broken client lands here.
          return reject('idempotency_conflict', 'This submission reference was already used with different details. Please try again.', 409);
        }
        if (r?.found === true && typeof r.submission_id === 'string' && r.submission_id) {
          // Retry of a committed submission: answer with the ORIGINAL id.
          // No CAPTCHA consumed, no rate budget used, nothing inserted.
          return json({ ok: true, submissionId: r.submission_id, duplicate: true }, 200, cors);
        }
        if (r?.found === false && r?.conflict === false) {
          idempotencyLookupConclusive = true;
        }
      }
      // Lookup unavailable → fall through without the pre-CAPTCHA dynamic vacancy
      // check. The database wrapper first preserves existing idempotent rows,
      // then validates genuinely new submissions transactionally.
    } catch { /* fall through to the atomic path */ }
  }

  // SMALL-BUSINESS T13.3.11: hiding Careers or Franchise is a server
  // boundary, but a committed idempotent retry must be resolved first. If the
  // owner closes the programme after a row committed but before the browser
  // received the response, returning section_closed would falsely report that
  // successful submission as a failure. Only a conclusively NEW request spends
  // this visibility read; an inconclusive resolver falls through to the
  // transactional database wrapper, which distinguishes retry from new insert.
  if ((kind === 'careers' || kind === 'franchise') && idempotencyLookupConclusive) {
    const flag = kind === 'careers' ? 'show_careers' : 'show_franchise';
    try {
      const stateRes = await svc(`public_site_configuration?select=${flag}&id=eq.1&limit=1`);
      if (!stateRes.ok) {
        return reject('section_state_unavailable', 'This form is temporarily unavailable.', 503);
      }
      const stateRows = await stateRes.json().catch(() => []) as Array<Record<string, unknown>>;
      if (stateRows[0]?.[flag] !== true) {
        return reject('section_closed', 'This form is currently closed.', 403);
      }
    } catch {
      return reject('section_state_unavailable', 'This form is temporarily unavailable.', 503);
    }
  }

  // T13.3.11: a careers application must target a vacancy that is still
  // published at submit time. The browser checks this for a friendly message,
  // this service check avoids spending a single-use CAPTCHA on a stale role,
  // and the database wrapper checks again transactionally to close the race.
  if (kind === 'careers' && idempotencyLookupConclusive) {
    const vacancyId = String(row['vacancy_id'] || '').trim();
    const appliedFor = String(row['applied_for'] || '').trim();
    try {
      const params = new URLSearchParams({ select: 'id', id: `eq.${vacancyId}`, title: `eq.${appliedFor}`, limit: '1' });
      const vacancyRes = await svc(`job_vacancies_public?${params.toString()}`);
      if (!vacancyRes.ok) {
        return reject('vacancy_state_unavailable', 'Applications are temporarily unavailable. Please try again later.', 503);
      }
      const vacancies = await vacancyRes.json().catch(() => []) as Array<{ id?: unknown }>;
      if (!vacancies.some((vacancy) => typeof vacancy?.id === 'string' && vacancy.id)) {
        return reject('vacancy_not_open', 'That vacancy is no longer open. Please choose a current role.', 409);
      }
    } catch {
      return reject('vacancy_state_unavailable', 'Applications are temporarily unavailable. Please try again later.', 503);
    }
  }

  // --- 4. CAPTCHA — only a genuinely NEW insert spends a verification --------
  const captchaToken = String(input?.captchaToken || '').trim();
  if (TS_GATE.mode === 'refuse') {
    return reject('service_unavailable', 'Submissions are temporarily unavailable. Please try again later.', 503);
  }
  if (TS_GATE.mode === 'enforce') {
    if (!captchaToken) return reject('captcha_missing', 'Please complete the verification.', 400);
    try {
      const body = new URLSearchParams();
      body.set('secret', TURNSTILE_SECRET);
      body.set('response', captchaToken);
      const rawIp = clientIp(req);
      if (rawIp) body.set('remoteip', rawIp);
      const { response: vr, data: vj } = await fetchProviderJson<{ success?: boolean }>(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
        EXTERNAL_PROVIDER_TIMEOUT_MS.turnstile,
      );
      if (!vr.ok) return reject('captcha_error', 'Could not verify the challenge. Please try again.', 502);
      if (!vj?.success) return reject('captcha_failed', 'Verification failed. Please try again.', 403);
    } catch (error) {
      if (error instanceof ProviderTimeoutError) {
        return reject('captcha_timeout', 'Verification is temporarily unavailable. Please try again.', 503);
      }
      return reject('captcha_error', 'Could not verify the challenge. Please try again.', 502);
    }
  }

  // --- 5. ONE atomic call: idempotency + rate reservation + insert + audit --
  // WP-02: submit_public_form() (SECURITY DEFINER; browser roles revoked)
  // owns id minting, database-clock chronology, workflow status and the
  // rate-limit decision inside a single transaction. WP02.1: the call now
  // carries the canonical request hash (hash-bound idempotency).
  try {
    const rpc = await svc('rpc/submit_public_form', {
      method: 'POST',
      body: JSON.stringify({
        p_kind: kind,
        p_row: row,
        p_idempotency_key: idempotencyKey,
        p_request_hash: idempotencyKey ? requestHash : null,
        p_ip_hash: ipHash,
        p_notice_id: noticeId,
        p_notice_sha256: noticeSha256,
      }),
    });
    if (!rpc.ok) {
      const detail = await rpc.text().catch(() => '');
      // Transactional re-validation tripped: only a crafted client reaches
      // these (the honest checks above answer normal browsers first).
      if (/missing_required_field|invalid_option|invalid_phone/.test(detail)) {
        return reject('rejected', 'Please complete all required fields with the listed options.', 400);
      }
      if (/vacancy_not_open/.test(detail)) {
        return reject('vacancy_not_open', 'That vacancy is no longer open. Please choose a current role.', 409);
      }
      // INC11: the notice changed between display and submit - 412 tells the
      // client to re-render the CURRENT notice before consent is recorded.
      if (/notice_version_changed/.test(detail)) {
        return reject('notice_changed', 'The privacy notice was updated while this page was open. Reload to review the current notice, then send again.', 412);
      }
      if (/form_notice_missing|section_closed/.test(detail)) {
        return reject('section_closed', 'This form is currently closed.', 403);
      }
      console.error('submit_public_form failed', rpc.status, detail.slice(0, 200));
      return reject('insert_failed', 'Your submission could not be saved. Please try again.', 502);
    }
    const out = await rpc.json().catch(() => null) as
      { ok?: boolean; submission_id?: string; duplicate?: boolean; error?: string } | null;
    if (out?.ok === true && typeof out.submission_id === 'string' && out.submission_id) {
      // The RPC records the accepted row in the same transaction.
      return json({ ok: true, submissionId: out.submission_id, duplicate: out.duplicate === true }, 200, cors);
    }
    if (out?.ok === false && out.error === 'rate_limited') {
      return json({ error: 'Too many submissions from your connection. Please try again later.' }, 429, cors);
    }
    if (out?.ok === false && out.error === 'idempotency_conflict') {
      return json({ error: 'This submission reference was already used with different details. Please try again.', code: 'idempotency_conflict' }, 409, cors);
    }
    console.error('submit_public_form returned an unexpected shape', JSON.stringify(out).slice(0, 200));
    return reject('insert_failed', 'Your submission could not be saved. Please try again.', 502);
  } catch {
    return reject('insert_failed', 'Your submission could not be saved. Please try again.', 502);
  }
});
