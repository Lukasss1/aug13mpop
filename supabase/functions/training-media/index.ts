// ============================================================================
//  MILK POP — training-media Edge Function
//
//  The ONLY path in or out of the private `training-media` bucket. There is
//  deliberately NO client→storage access anywhere in the app (same model as
//  the `cvs` bucket — see cv-upload / cv-signed-url).
//
//  Two actions, both requiring a verified staff USER JWT:
//
//   • UPLOAD (multipart POST, field `action=upload`) — managers/owners only.
//       1. Size limit          — reject over MAX_BYTES before storing.
//       2. MIME by magic bytes — accept only real MP4/MOV (ISO-BMFF `ftyp`)
//                                or WebM/MKV (EBML). Client-declared type and
//                                filename extension are ignored entirely.
//       3. Random object key   — a fresh UUID; the client cannot influence the
//                                path, so it can't overwrite or probe keys.
//       4. Overwrite guard     — x-upsert:false; a collision fails closed.
//       Returns { ref: "storage://training-media/<key>" } which the Academy
//       Studio embeds as the slide's videoUrl.
//
//   • SIGN (JSON POST { action:'sign', ref }) — ANY linked staff member.
//       The client sends the storage:// reference from a lesson slide, never
//       a raw path. The function validates the shape (uuid.ext inside this
//       bucket only — no traversal), mints a short-lived signed GET URL and
//       audits the access. Lesson videos are staff-internal training content,
//       so every authenticated staff member may watch; only authoring is
//       privileged.
//
//  Deploy WITH "Verify JWT" enabled. All checks below are authoritative
//  regardless of that toggle.
// ============================================================================

import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';
import { jwtHasAal2 } from '../_shared/jwt.ts';
import { readBoundedFormData, readBoundedJson, requestBodyResponse } from '../_shared/request.ts';

const MAX_BYTES = 60 * 1024 * 1024;   // 60 MB per lesson video
const URL_TTL_SECONDS = 2 * 60 * 60;  // 2 h — outlives any single viewing session
const BUCKET = 'training-media';
const MAX_JSON_BYTES = 8 * 1024;
const MAX_MULTIPART_BYTES = MAX_BYTES + 256 * 1024;

// --- Magic-byte sniffing (client-declared MIME is never trusted) ------------
// ISO-BMFF (mp4/m4v/mov): bytes 4..7 spell "ftyp".
// EBML (webm/mkv): 1A 45 DF A3.
function sniffVideoType(bytes: Uint8Array): { ext: string; contentType: string } | null {
  if (bytes.length > 11 &&
      bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return { ext: 'mp4', contentType: 'video/mp4' };
  }
  if (bytes.length > 4 &&
      bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { ext: 'webm', contentType: 'video/webm' };
  }
  return null;
}

/** storage://training-media/<uuid>.<ext> — the only reference shape we sign. */
const REF_RE = /^storage:\/\/training-media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm))$/i;

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
    `staff_profiles?auth_id=eq.${encodeURIComponent(uid)}&select=id,name,role,status,ended_at&limit=1`,
  );
  if (!callerRes.ok) return json({ error: 'Could not verify staff profile.' }, 500, cors);
  const callerRows = await callerRes.json().catch(() => []);
  const caller = Array.isArray(callerRows) ? callerRows[0] : null;
  if (!caller?.id) return json({ error: 'No linked staff profile.' }, 403, cors);
  // Stage 2.1 CF5: a disabled account (token not yet expired) gets no training
  // media access — neither signed viewing URLs nor uploads.
  if (String(caller.status || 'active') === 'disabled' || caller.ended_at) {
    return json({ error: 'This account is disabled.' }, 403, cors);
  }
  const role = String(caller.role || '');

  // Signed access and upload grants are security evidence. Use the real
  // activity_log schema and inspect the write result.
  const audit = async (action: string, outcome: 'granted' | 'denied' | 'error', detail: string, targetRef?: string): Promise<boolean> => {
    try {
      const response = await svc('activity_log', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{
          actor_auth_id: uid, actor_staff_id: String(caller.id), actor_name: String(caller.name || ''), actor_role: role,
          action, target_kind: 'training_media', target_ref: targetRef || null, outcome, detail: detail.slice(0, 300),
        }]),
      });
      return response.ok;
    } catch { return false; }
  };

  const contentType = req.headers.get('content-type') || '';

  // ==========================================================================
  //  ACTION: UPLOAD (multipart) — managers/owners only
  // ==========================================================================
  if (contentType.includes('multipart/form-data')) {
    if (!callerAal2) {
      return json({ error: 'Two-factor authentication is required for this action.' }, 403, cors);
    }
    if (role !== 'store_manager' && role !== 'owner') {
      await audit('training_media_upload', 'denied', 'insufficient_role');
      return json({ error: 'Only managers or owners can upload training videos.' }, 403, cors);
    }

    let form: FormData;
    try { form = await readBoundedFormData(req, MAX_MULTIPART_BYTES); } catch (error) {
      const failure = requestBodyResponse(error, 'Invalid upload.');
      return json(failure.body, failure.status, cors);
    }
    const file = form.get('file');
    if (!(file instanceof File)) return json({ error: 'No file was provided.' }, 400, cors);

    if (file.size > MAX_BYTES) {
      await audit('training_media_upload', 'denied', 'too_large');
      return json({ error: 'That video is too large (60 MB maximum). Compress it or host it as a URL.' }, 413, cors);
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.byteLength === 0) return json({ error: 'That file appears to be empty.' }, 400, cors);
    if (buf.byteLength > MAX_BYTES) {
      await audit('training_media_upload', 'denied', 'too_large');
      return json({ error: 'That video is too large (60 MB maximum).' }, 413, cors);
    }

    const sniffed = sniffVideoType(buf);
    if (!sniffed) {
      await audit('training_media_upload', 'denied', 'bad_mime');
      return json({ error: 'Only MP4 or WebM video files are accepted.' }, 415, cors);
    }

    const objectKey = `${crypto.randomUUID()}.${sniffed.ext}`;
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
      console.error('Training media write failed', uploadRes.status, detail.slice(0, 300));
      await audit('training_media_upload', 'denied', 'storage_failed');
      return json({ error: 'Could not store the video. Please try again.' }, 502, cors);
    }

    const auditRecorded = await audit('training_media_upload', 'granted', 'upload_confirmed', objectKey);
    if (!auditRecorded) {
      const queued = await svc('storage_cleanup_jobs?on_conflict=bucket,storage_path', {
        method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify([{ bucket: BUCKET, storage_path: objectKey, reason: 'training_media_upload_audit_failed' }]),
      }).catch(() => null);
      const cleanupQueued = !!queued?.ok;
      return json({
        error: cleanupQueued
          ? 'The video was stored but could not be audited. Cleanup has been queued.'
          : 'The video was stored but could not be audited, and cleanup could not be queued. Reconciliation is required.',
        code: cleanupQueued ? 'audit_failed_cleanup_queued' : 'audit_failed_cleanup_unconfirmed',
        cleanupQueued, reconciliationRequired: true,
      }, 502, cors);
    }
    return json({ ok: true, ref: `storage://${BUCKET}/${objectKey}` }, 200, cors);
  }

  // ==========================================================================
  //  ACTION: SIGN (JSON) — any linked staff member
  // ==========================================================================
  let payload: { action?: string; ref?: string } = {};
  try { payload = await readBoundedJson(req, MAX_JSON_BYTES) as { action?: string; ref?: string }; } catch (error) {
    const failure = requestBodyResponse(error, 'Invalid request.');
    return json(failure.body, failure.status, cors);
  }
  if (payload.action !== 'sign') return json({ error: 'Unknown action.' }, 400, cors);

  const m = REF_RE.exec(String(payload.ref || '').trim());
  if (!m) {
    await audit('training_media_sign', 'denied', 'bad_ref');
    return json({ error: 'That is not a valid training video reference.' }, 400, cors);
  }
  const objectKey = m[1];

  const signRes = await fetchInternal(`${baseUrl}/storage/v1/object/sign/${BUCKET}/${objectKey}`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: URL_TTL_SECONDS }),
  });
  if (!signRes.ok) {
    const detail = await signRes.text().catch(() => '');
    console.error('Training media sign failed', signRes.status, detail.slice(0, 300));
    await audit('training_media_sign', 'denied', 'sign_failed');
    return json({ error: 'Could not open that video right now.' }, 502, cors);
  }
  const signed = await signRes.json().catch(() => ({} as Record<string, unknown>));
  const signedPath = String((signed as { signedURL?: string }).signedURL || '');
  if (!signedPath) {
    await audit('training_media_sign', 'denied', 'sign_empty');
    return json({ error: 'Could not open that video right now.' }, 502, cors);
  }

  const auditRecorded = await audit('training_media_sign', 'granted', 'signed_url_granted', objectKey);
  if (!auditRecorded) return json({ error: 'Video access could not be audited. Please try again.', code: 'audit_unavailable' }, 503, cors);
  return json({ ok: true, url: `${baseUrl}/storage/v1${signedPath}` }, 200, cors);
});
