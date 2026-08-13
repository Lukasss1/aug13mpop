// ============================================================================
//  MILK POP — cv-signed-url Edge Function  (Block D / the security notes in README.md)
//
//  Lets an authorised staff member retrieve a candidate's CV WITHOUT the client
//  ever naming or seeing a storage path. Controls (all server-side):
//
//    1. Caller authentication — a verified staff USER JWT (Authorization:
//       Bearer …). The public anon key is rejected outright; the caller must
//       map to a linked staff_profiles row whose ROLE is read from the DB.
//    2. Authorisation — managers/owners ONLY. Team members and supervisors are
//       refused (CVs are HR data).
//    3. Server-side path resolution — the client sends an applicationId, NOT a
//       path. The function reads cv_path from that row with the service-role
//       key. A client can never request an arbitrary object key.
//    4. Short-lived signed URL — a signed GET URL that expires quickly
//       (URL_TTL_SECONDS). No public bucket, no long-lived link.
//    5. Audit — every access (granted or refused) is written to activity_log
//       via the service role: who, which application, granted/denied.
//
//  Deploy WITH "Verify JWT" enabled — callers present a real user token, so the
//  gateway rejects tokenless requests before this code runs. The in-function
//  checks below are authoritative regardless of that toggle.
// ============================================================================

import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';
import { jwtHasAal2 } from '../_shared/jwt.ts';
import { readBoundedJson, requestBodyResponse } from '../_shared/request.ts';

const URL_TTL_SECONDS = 120;   // signed URL lifetime — deliberately short
const BUCKET = 'cvs';
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

  // --- 1. AUTHENTICATION: verified staff USER token, never the anon key -----
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

  // Service-role helper — trusted server context ONLY. Never exposed to clients.
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

  // Caller must be a LINKED staff member; role/name come from the DB.
  const callerRes = await svc(
    `staff_profiles?auth_id=eq.${encodeURIComponent(uid)}&select=id,name,role,store_id,store_name,status,ended_at&limit=1`,
  );
  if (!callerRes.ok) return json({ error: 'Could not verify staff profile.' }, 500, cors);
  const callerRows = await callerRes.json().catch(() => []);
  const caller = Array.isArray(callerRows) ? callerRows[0] : null;
  if (!caller) return json({ error: 'No staff profile is linked to this account.' }, 403, cors);

  let input: Record<string, unknown>;
  try { input = await readBoundedJson(req, MAX_REQUEST_BYTES); } catch (error) { const failure = requestBodyResponse(error); return json(failure.body, failure.status, cors); }
  const applicationId = String(input?.applicationId || '').trim();

  // Audit helper — one activity_log row per access (granted or denied).
  const audit = async (action: string, outcome: 'granted' | 'denied' | 'error', reason?: string): Promise<boolean> => {
    try {
      const response = await svc('activity_log', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{
          actor_auth_id: uid,
          actor_staff_id: String(caller.id || ''),
          actor_name: String(caller.name || ''),
          actor_role: String(caller.role || ''),
          action,
          target_kind: 'job_application',
          target_ref: applicationId || null,
          outcome,
          detail: reason || null,
        }]),
      });
      return response.ok;
    } catch { return false; }
  };

  // Stage 2.1 F3: a disabled account has no CV access.
  if (String(caller.status || 'active') === 'disabled' || caller.ended_at) {
    await audit('cv_access', 'denied', 'account_disabled');
    return json({ error: 'This account is disabled.' }, 403, cors);
  }

  // --- 2. AUTHORISATION: managers/owners only -------------------------------
  const role = String(caller.role || '');
  if (role !== 'store_manager' && role !== 'owner') {
    await audit('cv_access', 'denied', 'insufficient_role');
    return json({ error: 'You are not authorised to view CVs.' }, 403, cors);
  }
  if (!callerAal2) {
    await audit('cv_access', 'denied', 'mfa_step_up_required');
    return json({ error: 'Two-factor authentication is required for this action.' }, 403, cors);
  }

  if (!applicationId) {
    await audit('cv_access', 'denied', 'missing_application');
    return json({ error: 'Missing application reference.' }, 400, cors);
  }

  // --- 3. Resolve the object key SERVER-SIDE from the application row --------
  const rowRes = await svc(
    `job_applications?id=eq.${encodeURIComponent(applicationId)}&select=id,cv_path,applied_store&limit=1`,
  );
  if (!rowRes.ok) {
    await audit('cv_access', 'denied', 'lookup_failed');
    return json({ error: 'Could not look up the application.' }, 500, cors);
  }
  const rows = await rowRes.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) {
    await audit('cv_access', 'denied', 'no_application');
    return json({ error: 'Application not found.' }, 404, cors);
  }
  // Stage 2.1 F3: the service role bypasses RLS, so re-enforce the store scope
  // the caller's own session would have. Owner: any application. Manager: only
  // applications for their own store (name snapshot on the application row).
  if (role !== 'owner') {
    const appStore = String(row.applied_store || '');
    if (!appStore || appStore !== String(caller.store_name || '')) {
      await audit('cv_access', 'denied', 'out_of_store');
      return json({ error: 'You are not authorised to view CVs for this application.' }, 403, cors);
    }
  }
  const objectKey = String(row.cv_path || '');
  if (!objectKey) {
    await audit('cv_access', 'denied', 'no_cv');
    return json({ error: 'This application has no CV on file.' }, 404, cors);
  }

  // --- 4. Mint a short-lived signed URL via the service role ----------------
  const signRes = await fetchInternal(`${baseUrl}/storage/v1/object/sign/${BUCKET}/${objectKey}`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: URL_TTL_SECONDS }),
  });
  if (!signRes.ok) {
    const detail = await signRes.text().catch(() => '');
    console.error('CV sign failed', signRes.status, detail.slice(0, 300));
    await audit('cv_access', 'denied', 'sign_failed');
    return json({ error: 'Could not prepare the file for viewing.' }, 502, cors);
  }
  const signed = await signRes.json().catch(() => ({} as Record<string, unknown>));
  // Storage returns a relative signedURL like "/object/sign/cvs/<key>?token=…"
  const rel = String(signed?.signedURL || signed?.signedUrl || '');
  if (!rel) {
    await audit('cv_access', 'denied', 'sign_empty');
    return json({ error: 'Could not prepare the file for viewing.' }, 502, cors);
  }
  const fullUrl = rel.startsWith('http') ? rel : `${baseUrl}/storage/v1${rel}`;

  // --- 5. Audit the successful access ---------------------------------------
  const auditRecorded = await audit('cv_access', 'granted');
  if (!auditRecorded) {
    return json({ error: 'The CV link was created, but access could not be audited. Please try again.', code: 'audit_unavailable' }, 503, cors);
  }
  return json({ url: fullUrl, expiresIn: URL_TTL_SECONDS }, 200, cors);
});
