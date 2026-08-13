// ============================================================================
//  MILK POP — media-upload Edge Function (WP04R: two-phase, deletion-free)
//
//  CONTRACT (Patch Spec §10 / §16):
//    action=upload (multipart)  — validate, store under a UUID key, register
//      media_objects(status='pending'), return {objectId,url,storagePath}.
//      NOTHING is deleted at upload time; replacePath does not exist.
//    action=attach (JSON)       — finalise_media_reference(): records where
//      the object is used, promotes it to 'attached' (menu_item also updates
//      the parent column in the same transaction) and grace-schedules the
//      DISPLACED object only when nothing references it.
//    Cleanup lives in the separate media-cleanup function (flag-gated) —
//      this function can no longer delete anything at all.
//
//  DEFENCES (unchanged from WP-04): staff session only (never anon), owner/
//  manager role, AAL2, 500 KB cap on the RECEIVED bytes, magic-byte MIME
//  sniffing (WebP/PNG/JPEG), UUID object keys, immutable cache headers.
// ============================================================================

const MAX_BYTES = 500 * 1024;
const BUCKET = 'menu-media';
const MAX_JSON_BYTES = 16 * 1024;
const MAX_MULTIPART_BYTES = MAX_BYTES + 128 * 1024;

const SIG_PNG = [0x89, 0x50, 0x4e, 0x47];
const SIG_JPG = [0xff, 0xd8, 0xff];
// WebP: 'RIFF' .... 'WEBP'
const SIG_RIFF = [0x52, 0x49, 0x46, 0x46];
const SIG_WEBP_AT8 = [0x57, 0x45, 0x42, 0x50];

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

function sniffImageType(bytes: Uint8Array): { ext: string; contentType: string } | null {
  if (startsWith(bytes, SIG_RIFF) && startsWith(bytes, SIG_WEBP_AT8, 8)) return { ext: 'webp', contentType: 'image/webp' };
  if (startsWith(bytes, SIG_PNG)) return { ext: 'png', contentType: 'image/png' };
  if (startsWith(bytes, SIG_JPG)) return { ext: 'jpg', contentType: 'image/jpeg' };
  return null;
}

import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';
import { jwtHasAal2 } from '../_shared/jwt.ts';
import { readBoundedFormData, readBoundedJson, requestBodyResponse } from '../_shared/request.ts';

// OPT-01: CORS logic centralised in _shared/cors.ts — behaviour unchanged.
// R4.8 (Workstream E): delegate to the shared FAIL-CLOSED builder. Production
// requires an exact-origin allow-list; untrusted origins get 'null', never '*'
// and never "first allowed origin". See _shared/cors.ts.
function corsHeaders(origin: string | null): Record<string, string> {
  return buildCorsHeaders(origin, ['CV_ALLOWED_ORIGINS'], 'POST, OPTIONS');
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
  const ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';
  if (!SUPABASE_URL || !SERVICE) return json({ error: 'Server is not configured.' }, 500, cors);
  const baseUrl = SUPABASE_URL.replace(/\/$/, '');

  // --- 1. AUTH: a real signed-in user, never the anon key -------------------
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || token === ANON) return json({ error: 'Authentication required.' }, 401, cors);
  const userRes = await fetchInternal(`${baseUrl}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) return json({ error: 'Authentication required.' }, 401, cors);
  const user = await userRes.json().catch(() => null);
  const uid: string | undefined = user?.id;
  if (!uid) return json({ error: 'Authentication required.' }, 401, cors);

  // --- 2. ROLE + AAL2 (SEC-001 pattern from staff-doc-upload) ----------------
  const callerAal2 = jwtHasAal2(token);

  const svc = (path: string, init: RequestInit = {}) =>
    fetchInternal(`${baseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> || {}),
      },
    });

  const callerRes = await svc(`staff_profiles?auth_id=eq.${encodeURIComponent(uid)}&select=id,role,status,ended_at&limit=1`);
  if (!callerRes.ok) return json({ error: 'Could not verify staff profile.' }, 500, cors);
  const caller = (await callerRes.json().catch(() => []))?.[0];
  if (!caller) return json({ error: 'No staff profile is linked to this account.' }, 403, cors);
  if (String(caller.status || 'active') === 'disabled' || caller.ended_at) return json({ error: 'This account is not active.' }, 403, cors);
  const role = String(caller.role || '');
  if (role !== 'owner' && role !== 'store_manager') return json({ error: 'Only managers and owners can upload media.' }, 403, cors);
  if (!callerAal2) return json({ error: 'This action requires a fully verified (MFA) session.' }, 403, cors);
  // Stage 2.1 F13: a store manager's media rights are limited to the MENU. The
  // owner may attach anywhere; a manager may only attach to menu_item entities
  // (never news/CMS/library/site settings — those are owner-only content).
  const managerMayAttachTo = (entityType: string): boolean => role === 'owner' || entityType === 'menu_item';

  // --- Parse: multipart (upload) or JSON (attach) -----------------------------
  const contentType = req.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    // --- ATTACH (two-phase step 2, spec §10.2) --------------------------------
    // The parent save flow calls this AFTER content is committed. The RPC is
    // transactional: reference row, status promotion and (for menu items) the
    // parent column move together or not at all. This function has NO delete
    // capability — the displaced object merely becomes a grace-period
    // cleanup CANDIDATE, and the worker re-verifies against a whole-content
    // scan before anything is ever removed.
    let body: { action?: string; objectId?: string; entityType?: string; entityId?: string; fieldPath?: string } | null = null;
    try { body = await readBoundedJson(req, MAX_JSON_BYTES) as { action?: string; objectId?: string; entityType?: string; entityId?: string; fieldPath?: string }; }
    catch (error) { const failure = requestBodyResponse(error); return json(failure.body, failure.status, cors); }
    if (body?.action !== 'attach') return json({ error: 'Invalid request body.' }, 400, cors);
    const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const objectId = String(body.objectId || '').trim().toLowerCase();
    const entityType = String(body.entityType || '').trim();
    const entityId = String(body.entityId || '').trim().slice(0, 200);
    const fieldPath = String(body.fieldPath || '').trim().slice(0, 200);
    if (!UUID_RX.test(objectId) || !entityType || !entityId || !fieldPath) {
      return json({ error: 'Invalid request body.' }, 400, cors);
    }
    if (!managerMayAttachTo(entityType)) {
      return json({ error: 'Managers may only attach media to menu items.' }, 403, cors);
    }
    const rpc = await svc('rpc/finalise_media_reference', {
      method: 'POST',
      body: JSON.stringify({
        p_object_id: objectId, p_entity_type: entityType,
        p_entity_id: entityId, p_field_path: fieldPath, p_actor: String(caller.id || ''),
      }),
    });
    if (!rpc.ok) {
      const detail = await rpc.text().catch(() => '');
      if (/unknown_entity_type/.test(detail)) return json({ error: 'Invalid request body.' }, 400, cors);
      console.error('finalise_media_reference failed', rpc.status, detail.slice(0, 200));
      return json({ status: 'failed', errorCode: 'attach_failed', retryable: true }, 502, cors);
    }
    const out = await rpc.json().catch(() => null) as
      { status?: string; object_id?: string; url?: string; previous_object_cleanup?: string; error?: string } | null;
    if (out?.status === 'attached') {
      return json({
        status: 'attached', objectId: out.object_id, url: out.url || null,
        previousObjectCleanup: out.previous_object_cleanup === 'scheduled' ? 'scheduled' : 'not_needed',
      }, 200, cors);
    }
    return json({ status: 'failed', errorCode: String(out?.error || 'attach_failed'), retryable: false }, 409, cors);
  }

  let form: FormData;
  try { form = await readBoundedFormData(req, MAX_MULTIPART_BYTES); } catch (error) { const failure = requestBodyResponse(error, 'Invalid upload.'); return json(failure.body, failure.status, cors); }
  const file = form.get('file');
  const altText = String(form.get('altText') || '').slice(0, 300);
  if (!(file instanceof File)) return json({ error: 'No file was provided.' }, 400, cors);

  // --- 3. Size (before buffering AND after — Content-Length is advisory) -----
  if (file.size > MAX_BYTES) return json({ error: 'That image is too large (500 KB maximum after processing).' }, 413, cors);
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.byteLength === 0) return json({ error: 'That file appears to be empty.' }, 400, cors);
  if (buf.byteLength > MAX_BYTES) return json({ error: 'That image is too large (500 KB maximum after processing).' }, 413, cors);

  // --- 4. Magic bytes (declared type ignored) --------------------------------
  const sniffed = sniffImageType(buf);
  if (!sniffed) return json({ error: 'Only WebP, PNG or JPEG images are accepted.' }, 415, cors);

  // --- 5+6. Random key, no overwrite -----------------------------------------
  const objectKey = `${crypto.randomUUID()}.${sniffed.ext}`;
  const uploadRes = await fetchInternal(`${baseUrl}/storage/v1/object/${BUCKET}/${objectKey}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
      'Content-Type': sniffed.contentType,
      'x-upsert': 'false',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    body: buf,
  });
  if (!uploadRes.ok) {
    const detail = await uploadRes.text().catch(() => '');
    console.error('media storage write failed', uploadRes.status, detail.slice(0, 300));
    return json({ error: 'Could not store the image. Please try again.' }, 502, cors);
  }

  // --- 7. Register media_objects(status='pending') ----------------------------
  // WP04R: the registry is the NEW media_objects table — never the legacy
  // media_assets Library (P0-R1). If the registration insert fails, the
  // stored object is parked in storage_cleanup_jobs and the error says the
  // truth ("will be cleaned up") instead of claiming a guaranteed delete —
  // the worker deletes it with a CONFIRMED status (spec §10.1).
  const width = Number(form.get('width')) || null;
  const height = Number(form.get('height')) || null;
  const publicUrl = `${baseUrl}/storage/v1/object/public/${BUCKET}/${objectKey}`;
  const enqueueCleanup = async (reason: string): Promise<boolean> => {
    const cleanup = await svc('storage_cleanup_jobs?on_conflict=bucket,storage_path', {
      method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify([{ bucket: BUCKET, storage_path: objectKey, reason }]),
    }).catch(() => null);
    return !!cleanup?.ok;
  };
  const registrationFailure = (cleanupQueued: boolean) => json({
    status: 'failed',
    errorCode: cleanupQueued ? 'registration_failed_cleanup_queued' : 'registration_failed_cleanup_unconfirmed',
    retryable: cleanupQueued,
    cleanupQueued,
    reconciliationRequired: !cleanupQueued,
    message: cleanupQueued
      ? 'The image was stored but could not be recorded. Cleanup has been queued; wait for it to complete before retrying.'
      : 'The image was stored but could not be recorded, and cleanup could not be queued. Reconciliation is required.',
  }, 502, cors);

  const findRegistration = async (): Promise<{ available: boolean; objectId: string | null }> => {
    try {
      const lookup = await svc(
        `media_objects?bucket=eq.${encodeURIComponent(BUCKET)}&storage_path=eq.${encodeURIComponent(objectKey)}&select=id&limit=1`,
      );
      if (!lookup.ok) return { available: false, objectId: null };
      const rows = await lookup.json().catch(() => null) as Array<{ id?: string }> | null;
      if (!Array.isArray(rows)) return { available: false, objectId: null };
      return { available: true, objectId: String(rows[0]?.id || '').trim() || null };
    } catch {
      return { available: false, objectId: null };
    }
  };
  const registrationUnconfirmed = () => json({
    status: 'failed',
    errorCode: 'registration_unconfirmed',
    retryable: false,
    cleanupQueued: false,
    reconciliationRequired: true,
    message: 'The image was stored, but its database registration could not be confirmed. Do not retry until it has been reconciled.',
  }, 502, cors);

  let reg: Response | null = null;
  try {
    reg = await svc('media_objects?select=id', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{
        bucket: BUCKET, storage_path: objectKey, public_url: publicUrl,
        mime_type: sniffed.contentType, size_bytes: buf.byteLength,
        width, height, alt_text: altText, status: 'pending',
        uploaded_by: String(caller.id || ''),
      }]),
    });
  } catch (error) {
    console.error('media_objects registration transport failed', error);
  }

  let objectId = '';
  if (reg?.ok) {
    const regRows = await reg.json().catch(() => null) as Array<{ id?: string }> | null;
    objectId = Array.isArray(regRows) ? String(regRows[0]?.id || '').trim() : '';
  } else if (reg) {
    const detail = await reg.text().catch(() => '');
    console.error('media_objects registration failed', reg.status, detail.slice(0, 300));
  }

  // A lost/malformed response is ambiguous: the insert may have committed.
  // Read the server-owned key back before deciding whether cleanup is safe.
  if (!objectId) {
    const verified = await findRegistration();
    if (verified.objectId) {
      objectId = verified.objectId;
    } else if (!verified.available) {
      return registrationUnconfirmed();
    } else {
      const reason = reg?.ok ? 'upload_registration_missing_id' : 'upload_registration_failed';
      return registrationFailure(await enqueueCleanup(reason));
    }
  }

  // Two-phase step 1 complete: the object exists, is registered and PENDING.
  // No previous object was touched — attachment (and any displacement) is the
  // parent save's job via action=attach.
  return json({ status: 'uploaded', objectId, url: publicUrl, storagePath: objectKey }, 200, cors);
});
