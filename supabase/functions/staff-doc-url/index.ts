// ============================================================================
//  MILK POP — staff-doc-url Edge Function (Stage 3)
//
//  Issues a SHORT-LIVED signed URL for one staff document, only after an
//  access check identical to the table's RLS:
//    • the document's own employee;
//    • a manager whose store matches the document's employee's store;
//    • the owner.
//  The URL lives for 60 seconds and is never stored anywhere. Every request
//  (granted or denied) writes an activity_log row with the DERIVED actor.
//
//  Deploy WITH JWT verification ON.
// ============================================================================

import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';
import { encodeStoragePath } from '../_shared/storage.ts';
import { jwtHasAal2 } from '../_shared/jwt.ts';
import { readBoundedJson, requestBodyResponse } from '../_shared/request.ts';

const BUCKET = 'staff-documents';
const SIGNED_URL_TTL_SECONDS = 60;
const MAX_REQUEST_BYTES = 4 * 1024;

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

  const callerRes = await svc(`staff_profiles?auth_id=eq.${encodeURIComponent(uid)}&select=id,name,role,store_id,status,ended_at&limit=1`);
  if (!callerRes.ok) return json({ error: 'Could not verify staff profile.' }, 500, cors);
  const caller = (await callerRes.json().catch(() => []))?.[0];
  if (!caller) return json({ error: 'No staff profile is linked to this account.' }, 403, cors);
  if (String(caller.status || 'active') === 'disabled' || caller.ended_at) return json({ error: 'This account is disabled.' }, 403, cors);
  const role = String(caller.role || '');

  let input: Record<string, unknown>;
  try { input = await readBoundedJson(req, MAX_REQUEST_BYTES); } catch (error) {
    const failure = requestBodyResponse(error);
    return json(failure.body, failure.status, cors);
  }
  const documentId = String(input?.documentId || '').trim();
  if (!documentId) return json({ error: 'Missing document reference.' }, 400, cors);

  const audit = async (outcome: 'granted' | 'denied' | 'error', reason?: string): Promise<boolean> => {
    try {
      const response = await svc('activity_log', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{
          actor_auth_id: uid, actor_staff_id: String(caller.id || ''), actor_name: String(caller.name || ''), actor_role: role,
          action: 'doc_access', target_kind: 'staff_document', target_ref: documentId, outcome, detail: reason || null,
        }]),
      });
      return response.ok;
    } catch { return false; }
  };

  // --- 2. LOAD + ACCESS CHECK --------------------------------------------------
  const docRes = await svc(`staff_documents?id=eq.${encodeURIComponent(documentId)}&select=id,employee_id,store_id,storage_bucket,storage_path,name,file_state&limit=1`);
  if (!docRes.ok) { await audit('denied', 'lookup_failed'); return json({ error: 'Could not load the document.' }, 500, cors); }
  const doc = (await docRes.json().catch(() => []))?.[0];
  if (!doc) { await audit('denied', 'not_found'); return json({ error: 'No such document.' }, 404, cors); }
  if (String(doc.file_state || 'active') !== 'active' || !doc.storage_path || doc.storage_bucket !== BUCKET) {
    await audit('denied', 'no_object');
    return json({ error: 'This record has no stored file (legacy entry).' }, 404, cors);
  }

  const isSelf = String(doc.employee_id || '') === String(caller.id);
  const isOwner = role === 'owner';
  if (!isSelf && !callerAal2) {
    return json({ error: 'Two-factor authentication is required for this action.' }, 403, cors);
  }
  let isMgrSameStore = false;
  if (!isSelf && !isOwner && role === 'store_manager') {
    const empRes = await svc(`staff_profiles?id=eq.${encodeURIComponent(String(doc.employee_id || ''))}&select=store_id&limit=1`);
    const emp = empRes.ok ? (await empRes.json().catch(() => []))?.[0] : null;
    isMgrSameStore = !!emp && String(emp.store_id || '') === String(caller.store_id || '');
  }
  if (!isSelf && !isOwner && !isMgrSameStore) {
    await audit('denied', 'not_authorised');
    return json({ error: 'You are not authorised to view this document.' }, 403, cors);
  }

  // --- 3. SHORT-LIVED SIGNED URL (never stored) ---------------------------------
  const signRes = await fetchInternal(`${baseUrl}/storage/v1/object/sign/${encodeURIComponent(BUCKET)}/${encodeStoragePath(String(doc.storage_path))}`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
  });
  if (!signRes.ok) { await audit('denied', 'sign_failed'); return json({ error: 'Could not create a view link. Try again.' }, 502, cors); }
  const signed = await signRes.json().catch(() => null);
  const signedPath: string | undefined = signed?.signedURL || signed?.signedUrl;
  if (!signedPath) { await audit('denied', 'sign_failed'); return json({ error: 'Could not create a view link. Try again.' }, 502, cors); }

  const auditRecorded = await audit('granted');
  if (!auditRecorded) return json({ error: 'The document link was created, but access could not be audited. Please try again.', code: 'audit_unavailable' }, 503, cors);
  return json({ ok: true, url: `${baseUrl}/storage/v1${signedPath}`, expiresIn: SIGNED_URL_TTL_SECONDS }, 200, cors);
});
