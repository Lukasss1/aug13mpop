// ============================================================================
//  MILK POP — staff-doc-upload Edge Function (Stage 3)
//
//  The ONLY path by which a staff document enters the private
//  `staff-documents` bucket. Mirrors the hardened cv-upload pipeline, plus
//  authentication and ownership rules (staff are signed in, candidates were
//  not):
//
//    1. AUTH        — verified staff USER token; anon key rejected.
//    2. OWNERSHIP   — staff upload for THEMSELVES; managers for employees of
//                     their own store; owners for anyone. The target employee
//                     row must exist and (for managers) match their store.
//    3. VALIDATION  — size cap, magic-byte MIME sniff (PDF/JPEG/PNG only),
//                     category allow-list, display-name length. The client's
//                     declared type, extension and any path input are ignored.
//    4. PATH        — stores/{storeId}/employees/{employeeId}/{docId}/{safe}
//                     built entirely server-side; upsert=false so a collision
//                     fails closed.
//    5. RECONCILE   — metadata is inserted only after Storage confirms the
//                     object. A failed insert requires confirmed rollback or
//                     a durable cleanup job; the response never overclaims.
//    6. AUDIT       — security-relevant outcomes use database-owned actor facts.
//
//  Deploy WITH JWT verification ON (callers are signed-in staff).
// ============================================================================

import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';
import { encodeStoragePath } from '../_shared/storage.ts';
import { jwtHasAal2 } from '../_shared/jwt.ts';
import { readBoundedFormData, requestBodyResponse } from '../_shared/request.ts';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB hard cap for HR documents
const RATE_PER_STAFF_PER_HOUR = 30;  // uploads per staff member per rolling hour
const BUCKET = 'staff-documents';
const MAX_REQUEST_BYTES = MAX_BYTES + 256 * 1024;
const CATEGORIES = ['contracts', 'compliance', 'payslips', 'performance', 'id_verification'];

const SIG_PDF = [0x25, 0x50, 0x44, 0x46];
const SIG_JPG = [0xff, 0xd8, 0xff];
const SIG_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

/** Sniff the REAL type from leading bytes. PDF / JPEG / PNG only. */
function sniffDocType(bytes: Uint8Array): { ext: string; contentType: string } | null {
  if (startsWith(bytes, SIG_PDF)) return { ext: 'pdf', contentType: 'application/pdf' };
  if (startsWith(bytes, SIG_JPG)) return { ext: 'jpg', contentType: 'image/jpeg' };
  if (startsWith(bytes, SIG_PNG)) return { ext: 'png', contentType: 'image/png' };
  return null;
}

/** Client filename → safe display stem: lowercase, [a-z0-9._-], bounded. The
 *  extension is ALWAYS replaced with the sniffed one. */
function safeStem(name: string): string {
  const stem = (name || 'document').replace(/\.[^.]*$/, '');
  const safe = stem.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return safe || 'document';
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

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const ANON = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !ANON || !SERVICE) return json({ error: 'Server is not configured.' }, 500, cors);
  const baseUrl = SUPABASE_URL.replace(/\/$/, '');

  // --- 1. AUTHENTICATION -----------------------------------------------------
  const authz = req.headers.get('authorization') || '';
  const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : '';

  const callerAal2 = jwtHasAal2(token);

  if (!token || token === ANON) return json({ error: 'Authentication required.' }, 401, cors);
  const userRes = await fetchInternal(`${baseUrl}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) return json({ error: 'Authentication required.' }, 401, cors);
  const user = await userRes.json().catch(() => null);
  const uid: string | undefined = user?.id;
  if (!uid) return json({ error: 'Authentication required.' }, 401, cors);

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

  const callerRes = await svc(`staff_profiles?auth_id=eq.${encodeURIComponent(uid)}&select=id,name,role,store_id,store_name,status,ended_at&limit=1`);
  if (!callerRes.ok) return json({ error: 'Could not verify staff profile.' }, 500, cors);
  const caller = (await callerRes.json().catch(() => []))?.[0];
  if (!caller) return json({ error: 'No staff profile is linked to this account.' }, 403, cors);
  if (String(caller.status || 'active') === 'disabled' || caller.ended_at) return json({ error: 'This account is disabled.' }, 403, cors);
  const role = String(caller.role || '');

  const audit = async (action: string, outcome: 'granted' | 'denied', targetRef: string, reason?: string): Promise<boolean> => {
    try {
      const response = await svc('activity_log', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{
        actor_auth_id: uid,
        actor_staff_id: String(caller.id || ''),
        actor_name: String(caller.name || ''),
        actor_role: role,
        action,
        target_kind: 'staff_document',
        target_ref: targetRef || null,
        outcome,
        detail: reason || null,
      }]),
      });
      return response.ok;
    } catch { return false; }
  };

  // --- 2. PER-STAFF RATE LIMIT (rolling hour) -------------------------------
  // Reserve the bounded server-side budget before buffering or parsing the
  // multipart body. The fixed-width digest is an opaque pseudonym, not a raw
  // staff identifier in the shared rate table.
  const staffRateDigest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`staff-doc-upload:${String(caller.id)}`),
  );
  const staffRateKey = Array.from(new Uint8Array(staffRateDigest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  try {
    const rate = await svc('rpc/reserve_anonymous_rate', {
      method: 'POST',
      body: JSON.stringify({
        p_scope: 'staff_doc_upload',
        p_ip_hash: staffRateKey,
        p_limit: RATE_PER_STAFF_PER_HOUR,
        p_window_seconds: 3600,
      }),
    });
    if (!rate.ok) return json({ error: 'Document uploads are temporarily unavailable.' }, 503, cors);
    const result = await rate.json().catch(() => null) as { ok?: boolean } | null;
    if (result?.ok !== true) {
      await audit('doc_upload', 'denied', String(caller.id), 'rate_limited');
      return json({ error: 'Too many uploads this hour — please try again later.' }, 429, cors);
    }
  } catch {
    return json({ error: 'Document uploads are temporarily unavailable.' }, 503, cors);
  }

  // --- 3. Parse multipart form ------------------------------------------------
  let form: FormData;
  try { form = await readBoundedFormData(req, MAX_REQUEST_BYTES); } catch (error) {
    const failure = requestBodyResponse(error, 'Invalid upload.');
    return json(failure.body, failure.status, cors);
  }
  const file = form.get('file');
  const displayName = String(form.get('name') || '').trim().slice(0, 120);
  const category = String(form.get('category') || '').trim();
  const targetEmployeeId = String(form.get('employeeId') || '').trim() || String(caller.id);
  if (!(file instanceof File)) return json({ error: 'No file was provided.' }, 400, cors);
  if (!displayName) return json({ error: 'Give the document a name.' }, 400, cors);
  if (!CATEGORIES.includes(category)) return json({ error: 'Unknown document category.' }, 400, cors);

  // --- 4. OWNERSHIP / STORE SCOPE ---------------------------------------------
  const targetRes = await svc(`staff_profiles?id=eq.${encodeURIComponent(targetEmployeeId)}&select=id,name,store_id,store_name&limit=1`);
  if (!targetRes.ok) { await audit('doc_upload', 'denied', targetEmployeeId, 'target_lookup_failed'); return json({ error: 'Could not verify the employee.' }, 500, cors); }
  const target = (await targetRes.json().catch(() => []))?.[0];
  if (!target) { await audit('doc_upload', 'denied', targetEmployeeId, 'no_target'); return json({ error: 'No such employee.' }, 404, cors); }

  const isSelf = String(target.id) === String(caller.id);
  const isOwner = role === 'owner';
  const isMgrSameStore = role === 'store_manager' && String(target.store_id || '') === String(caller.store_id || '');
  if (!isSelf && !callerAal2) {
    return json({ error: 'Two-factor authentication is required for this action.' }, 403, cors);
  }
  if (!isSelf && !isOwner && !isMgrSameStore) {
    await audit('doc_upload', 'denied', targetEmployeeId, 'not_authorised_for_target');
    return json({ error: 'You are not authorised to upload documents for this employee.' }, 403, cors);
  }

  // --- 5. VALIDATION -------------------------------------------------------------
  if (file.size > MAX_BYTES) { await audit('doc_upload', 'denied', targetEmployeeId, 'too_large'); return json({ error: 'That file is too large (10 MB maximum).' }, 413, cors); }
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.byteLength === 0) return json({ error: 'That file appears to be empty.' }, 400, cors);
  if (buf.byteLength > MAX_BYTES) { await audit('doc_upload', 'denied', targetEmployeeId, 'too_large'); return json({ error: 'That file is too large (10 MB maximum).' }, 413, cors); }
  const sniffed = sniffDocType(buf);
  if (!sniffed) { await audit('doc_upload', 'denied', targetEmployeeId, 'bad_mime'); return json({ error: 'Only PDF, JPEG or PNG files are accepted.' }, 415, cors); }

  const digest = await crypto.subtle.digest('SHA-256', buf);
  const checksum = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');

  // --- 6. CONTROLLED PATH (never client input) ----------------------------------
  const docId = `doc_${crypto.randomUUID()}`;
  const safeFilename = `${safeStem(file.name)}.${sniffed.ext}`;
  const storagePath = `stores/${target.store_id || 'unassigned'}/employees/${target.id}/${docId}/${safeFilename}`;

  const uploadRes = await fetchInternal(`${baseUrl}/storage/v1/object/${encodeURIComponent(BUCKET)}/${encodeStoragePath(storagePath)}`, {
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
    console.error('staff-doc storage write failed', uploadRes.status, detail.slice(0, 300));
    await audit('doc_upload', 'denied', targetEmployeeId, 'storage_failed');
    return json({ error: 'Could not store the file. Please try again.' }, 502, cors);
  }

  // --- 7. METADATA + CHECKED COMPENSATION --------------------------------------
  const nowISO = new Date().toISOString();
  const row = {
    id: docId,
    name: displayName,
    type: sniffed.contentType,
    category,
    upload_date: nowISO,
    status: 'pending',
    employee_id: String(target.id),
    employee_name: String(target.name || ''),
    store_id: target.store_id || null,
    store_name: String(target.store_name || ''),
    storage_bucket: BUCKET,
    storage_path: storagePath,
    original_filename: String(file.name || '').slice(0, 200),
    mime_type: sniffed.contentType,
    size_bytes: buf.byteLength,
    checksum,
    uploaded_by: String(caller.id),
    file_state: 'active',
  };
  const ins = await svc('staff_documents', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify([row]),
  });
  if (!ins.ok) {
    console.error('staff-doc metadata insert failed', ins.status);
    let rollbackConfirmed = false;
    let rollbackStatus: number | null = null;
    try {
      const rollback = await fetchInternal(`${baseUrl}/storage/v1/object/${encodeURIComponent(BUCKET)}/${encodeStoragePath(storagePath)}`, {
        method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      });
      rollbackStatus = rollback.status;
      rollbackConfirmed = rollback.ok || rollback.status === 404;
    } catch { rollbackConfirmed = false; }

    let cleanupQueued = false;
    if (!rollbackConfirmed) {
      try {
        const queued = await svc('storage_cleanup_jobs?on_conflict=bucket,storage_path', {
          method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify([{ bucket: BUCKET, storage_path: storagePath, reason: `staff_doc_metadata_failed_rollback_${rollbackStatus ?? 'transport'}` }]),
        });
        cleanupQueued = queued.ok;
      } catch { cleanupQueued = false; }
    }
    await audit('doc_upload', 'denied', targetEmployeeId, rollbackConfirmed ? 'metadata_failed_rollback_confirmed' : cleanupQueued ? 'metadata_failed_cleanup_queued' : 'metadata_failed_orphan_possible');
    if (rollbackConfirmed) {
      return json({ error: 'Could not record the document. The stored file was removed.', code: 'metadata_failed_rollback_confirmed' }, 502, cors);
    }
    return json({
      error: cleanupQueued
        ? 'Could not record the document. Cleanup has been queued and must complete before retrying.'
        : 'Could not record the document, and cleanup could not be confirmed. Reconciliation is required.',
      code: cleanupQueued ? 'metadata_failed_cleanup_queued' : 'metadata_failed_orphan_possible',
      cleanupQueued,
      reconciliationRequired: true,
    }, 502, cors);
  }

  const auditRecorded = await audit('doc_upload', 'granted', docId);
  const saved = (await ins.json().catch(() => []))?.[0] ?? row;
  return json({ ok: true, document: saved, auditRecorded, reconciliationRequired: !auditRecorded }, 200, cors);
});
