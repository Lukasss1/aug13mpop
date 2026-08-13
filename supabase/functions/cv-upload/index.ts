// ============================================================================
//  MILK POP — cv-upload Edge Function  (Block D / the security notes in README.md)
//
//  The ONLY path by which a CV file may enter the private `cvs` bucket. There
//  is deliberately NO client→storage write anywhere in the app. Every control
//  runs on the SERVER, BEFORE the file touches storage:
//
//    1. Size limit          — reject anything over MAX_BYTES (before storing).
//    2. MIME by magic bytes — sniff the leading bytes; accept only real PDF /
//                             DOC / DOCX. The client-declared type/extension is
//                             ignored entirely (it is trivially spoofable).
//    3. Random object key   — a fresh UUID. The client cannot influence the
//                             path, so it cannot overwrite or probe other keys.
//    4. Overwrite guard     — upsert=false on the storage write; a key collision
//                             fails closed rather than replacing an object.
//    5. Per-IP rate limit   — one atomic bounded counter keyed by HMAC pseudonym.
//    6. CAPTCHA (optional)   — Cloudflare Turnstile, verified server-side ONLY
//                             when TURNSTILE_SECRET is set (so it can be turned
//                             on without a redeploy).
//    7. Orphan prevention    — confirm the target job_applications row exists
//                             BEFORE storing; link cv_path via the service role
//                             AFTER storing; any unwanted object is durably queued
//                             for the checked cleanup worker.
//
//  Anonymous by design: candidates are not logged in. The abuse controls above
//  (CAPTCHA + per-IP rate limit + strict validation + no client-named path) are
//  what make an unauthenticated upload endpoint safe. The service-role key is
//  used ONLY inside this trusted server context and never reaches the client.
//
//  Deploy WITHOUT "Verify JWT" (public callers have no user token). All checks
//  here are authoritative regardless of that toggle.
// ============================================================================

import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';
import { turnstileGate } from '../_shared/appEnv.ts';
import { EXTERNAL_PROVIDER_TIMEOUT_MS, ProviderTimeoutError, fetchProviderJson } from '../_shared/providerFetch.ts';
import { clientIp, hmacIp } from '../_shared/ip.ts';
import { readBoundedFormData, requestBodyResponse } from '../_shared/request.ts';

// --- Limits & accepted types ------------------------------------------------
const MAX_BYTES = 5 * 1024 * 1024;          // 5 MB hard cap
const RATE_IP_PER_HOUR = 5;                 // uploads per IP per rolling hour
const BUCKET = 'cvs';
const MAX_REQUEST_BYTES = MAX_BYTES + 256 * 1024;

// Magic-byte signatures. PDF and the ZIP container that wraps DOCX are exact;
// legacy DOC (OLE2 compound file) has a fixed 8-byte header. We do NOT trust
// the client's declared MIME or the filename extension for any of this.
const SIG_PDF  = [0x25, 0x50, 0x44, 0x46];                              // %PDF
const SIG_ZIP  = [0x50, 0x4b, 0x03, 0x04];                              // PK\x03\x04 (docx/zip)
const SIG_ZIPE = [0x50, 0x4b, 0x05, 0x06];                              // empty zip
const SIG_OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];      // legacy .doc

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

/** Sniff the real type from the leading bytes. Returns a canonical extension +
 *  content-type, or null if it is not one of the allowed document formats. */
function sniffDocType(bytes: Uint8Array): { ext: string; contentType: string } | null {
  if (startsWith(bytes, SIG_PDF)) return { ext: 'pdf', contentType: 'application/pdf' };
  if (startsWith(bytes, SIG_OLE2)) return { ext: 'doc', contentType: 'application/msword' };
  if (startsWith(bytes, SIG_ZIP) || startsWith(bytes, SIG_ZIPE)) {
    // A DOCX is a ZIP; a bare ZIP also matches here. That is acceptable: the
    // container is a real Office/zip document, stored privately and only ever
    // retrieved by a manager via a signed URL — never executed or served
    // inline. We label it docx.
    return { ext: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  return null;
}

// R4.8 (Workstream E): delegate to the shared FAIL-CLOSED builder. Production
// requires an exact-origin allow-list; untrusted origins get 'null', never '*'
// and never "first allowed origin". See _shared/cors.ts.
function corsHeaders(origin: string | null): Record<string, string> {
  return buildCorsHeaders(origin, ["CV_ALLOWED_ORIGINS"], 'POST, OPTIONS');
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, cors);

  // --- Environment ----------------------------------------------------------
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

  // Service-role REST + Storage helper — trusted server context ONLY. Never
  // exposed to clients. Bypasses RLS so it can confirm the application row,
  // write the object, set cv_path, and record the rate-limit/audit row.
  const svc = (path: string, init: RequestInit = {}) =>
    fetchInternal(`${baseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> || {}),
      },
    });

  const abuseSecret = Deno.env.get('ABUSE_HMAC_SECRET') || SERVICE;
  const ipHash = await hmacIp(req, abuseSecret, 'cv-upload:v1');

  // Reserve the anonymous budget before multipart parsing or external work.
  // The reservation is atomic and fail-closed; invalid requests never create
  // one durable rejection row each.
  try {
    const rateRes = await svc('rpc/reserve_anonymous_rate', {
      method: 'POST',
      body: JSON.stringify({ p_scope: 'cv_upload', p_ip_hash: ipHash, p_limit: RATE_IP_PER_HOUR, p_window_seconds: 3600 }),
    });
    if (!rateRes.ok) return json({ error: 'Uploads are temporarily unavailable. Please try again later.' }, 503, cors);
    const rate = await rateRes.json().catch(() => null) as { ok?: boolean } | null;
    if (rate?.ok !== true) return json({ error: 'Too many uploads from your connection. Please try again later.' }, 429, cors);
  } catch {
    return json({ error: 'Uploads are temporarily unavailable. Please try again later.' }, 503, cors);
  }

  const reject = (_reason: string, message: string, code: number) => json({ error: message }, code, cors);

  // --- Parse the multipart form (file + applicationId + optional captcha) ----
  let form: FormData;
  try { form = await readBoundedFormData(req, MAX_REQUEST_BYTES); } catch (error) {
    const failure = requestBodyResponse(error, 'Invalid upload.');
    return json(failure.body, failure.status, cors);
  }

  const applicationId = String(form.get('applicationId') || '').trim();
  const captchaToken = String(form.get('captchaToken') || '').trim();
  const file = form.get('file');
  if (!applicationId) return reject('missing_application', 'Missing application reference.', 400);
  if (applicationId.length > 128) return reject('invalid_application', 'Invalid application reference.', 400);
  if (captchaToken.length > 4096) return reject('invalid_captcha', 'Invalid verification response.', 400);
  if (!(file instanceof File)) return reject('missing_file', 'No file was provided.', 400);

  // --- 6. CAPTCHA (only enforced when a secret is configured) ---------------
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

  // --- 1. Size limit --------------------------------------------------------
  if (file.size > MAX_BYTES) {
    return reject('too_large', 'That file is too large (5 MB maximum).', 413);
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.byteLength === 0) return reject('empty_file', 'That file appears to be empty.', 400);
  if (buf.byteLength > MAX_BYTES) {
    return reject('too_large', 'That file is too large (5 MB maximum).', 413);
  }

  // --- 2. MIME by magic bytes (client-declared type/extension IGNORED) ------
  const sniffed = sniffDocType(buf);
  if (!sniffed) {
    return reject('bad_mime', 'Only PDF, DOC or DOCX files are accepted.', 415);
  }

  // --- 7a. Confirm the target application row EXISTS (no orphan uploads) -----
  // WP-01: also enforce the ONE-CV-PER-APPLICATION policy here, BEFORE any
  // bytes are stored. A second upload is rejected as already_attached rather
  // than replacing the first — the previous unconditional re-link left the
  // earlier object stranded in the bucket with nothing referencing it.
  try {
    const rowRes = await svc(`job_applications?id=eq.${encodeURIComponent(applicationId)}&select=id,cv_path&limit=1`);
    if (!rowRes.ok) return reject('lookup_failed', 'Could not verify the application.', 500);
    const rows = await rowRes.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) {
      return reject('no_application', 'No matching application was found. Submit your details first.', 404);
    }
    if (rows[0]?.cv_path) {
      return reject('already_attached', 'A CV is already attached to this application.', 409);
    }
  } catch {
    return reject('lookup_failed', 'Could not verify the application.', 500);
  }

  // --- 3. Random object key (client cannot influence the path) --------------
  const objectKey = `${crypto.randomUUID()}.${sniffed.ext}`;

  // --- 4. Store with upsert=false (overwrite guard) -------------------------
  // x-upsert:false → a key collision returns an error instead of replacing an
  // object. Content-Type is the SNIFFED type, never the client's declared one.
  const uploadRes = await fetchInternal(`${baseUrl}/storage/v1/object/${BUCKET}/${objectKey}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': sniffed.contentType,
      'x-upsert': 'false',
      'Cache-Control': 'no-store',
    },
    body: buf,
  });
  if (!uploadRes.ok) {
    const detail = await uploadRes.text().catch(() => '');
    console.error('CV storage write failed', uploadRes.status, detail.slice(0, 300));
    return reject('storage_failed', 'Could not store the file. Please try again.', 502);
  }

  // --- 7b. Link cv_path via the service role ---------------------------------
  // WP-01: the PATCH is CONDITIONAL on cv_path still being NULL — the row is
  // the arbiter of a concurrent double-upload.
  // WP01.1 (§6.4): an object is NEVER deleted on suspicion. A failed or lost
  // PATCH response is AMBIGUOUS — the update may have committed — so the row
  // is RE-READ first: if cv_path equals OUR key, the link actually succeeded
  // and we report success; every other unwanted object is parked in
  // storage_cleanup_jobs for the worker to delete with a CONFIRMED status,
  // never fire-and-forget.
  const enqueueCleanup = async (reason: string): Promise<boolean> => {
    try {
      const response = await svc('storage_cleanup_jobs?on_conflict=bucket,storage_path', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify([{ bucket: BUCKET, storage_path: objectKey, reason }]),
      });
      if (!response.ok) console.error('cleanup enqueue rejected', response.status, reason, objectKey);
      return response.ok;
    } catch {
      console.error('cleanup enqueue failed', reason, objectKey);
      return false;
    }
  };
  const readCvPath = async (): Promise<{ ok: boolean; cvPath: string | null }> => {
    try {
      const r = await svc(`job_applications?id=eq.${encodeURIComponent(applicationId)}&select=cv_path&limit=1`);
      if (!r.ok) return { ok: false, cvPath: null };
      const rows = await r.json().catch(() => []);
      if (!Array.isArray(rows) || rows.length === 0) return { ok: true, cvPath: null };
      return { ok: true, cvPath: rows[0]?.cv_path ? String(rows[0].cv_path) : null };
    } catch {
      return { ok: false, cvPath: null };
    }
  };

  let linked = false;
  let ambiguous = false;
  try {
    const patch = await svc(
      `job_applications?id=eq.${encodeURIComponent(applicationId)}&cv_path=is.null`,
      {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ cv_path: objectKey }),
      },
    );
    if (!patch.ok) {
      ambiguous = true; // non-2xx AFTER the request reached the API — may have committed
    } else {
      const updated = await patch.json().catch(() => []);
      linked = Array.isArray(updated) && updated.length === 1;
    }
  } catch {
    ambiguous = true;   // network-level loss — the classic committed-but-lost case
  }

  if (ambiguous) {
    const check = await readCvPath();
    if (!check.ok) {
      // Verification unavailable: do NOT delete; reconcile later (spec §6.4).
      const cleanupQueued = await enqueueCleanup('cv_link_ambiguous_unverified');
      return json({ error: 'Could not confirm whether the file was attached. Refresh before retrying.', code: 'link_unconfirmed', cleanupQueued, reconciliationRequired: !cleanupQueued }, 502, cors);
    }
    if (check.cvPath === objectKey) {
      linked = true;    // the PATCH committed and only the response was lost
    } else if (check.cvPath) {
      const cleanupQueued = await enqueueCleanup('cv_link_lost_race');
      return json({ error: 'A CV is already attached to this application.', code: 'already_attached', cleanupQueued, reconciliationRequired: !cleanupQueued }, 409, cors);
    } else {
      const cleanupQueued = await enqueueCleanup('cv_link_failed_unlinked');
      return json({ error: 'Could not attach the file to your application. Please try again.', code: 'link_failed', cleanupQueued, reconciliationRequired: !cleanupQueued }, 502, cors);
    }
  }

  if (!linked) {
    // Unambiguous zero-row match: a concurrent upload won. Queue OUR object —
    // the worker deletes it with a confirmed status (Gate B: loser queued).
    const cleanupQueued = await enqueueCleanup('cv_link_lost_race');
    return json({ error: 'A CV is already attached to this application.', code: 'already_attached', cleanupQueued, reconciliationRequired: !cleanupQueued }, 409, cors);
  }

  const auditRes = await svc('cv_upload_ip_log', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{ ip_hash: ipHash, status: 'accepted', application_id: applicationId, object_key: objectKey }]),
  }).catch(() => null);
  if (!auditRes?.ok) console.error('CV accepted audit row could not be recorded');
  // The client gets a bare confirmation — never the object key or any path.
  return json({ ok: true }, 200, cors);
});
