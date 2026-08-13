// ============================================================================
// MILK POP — staff document deletion with atomic metadata tombstone (T13.3.19)
//
// Owner-only. Storage absence is accepted only on 2xx/404. Only after that
// fact is confirmed does one database RPC atomically write the tombstone,
// audit the action and remove the live metadata row. Ambiguous RPC responses
// are resolved by reading the tombstone before any retry advice is shown.
// ============================================================================
import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';
import { encodeStoragePath } from '../_shared/storage.ts';
import { jwtHasAal2 } from '../_shared/jwt.ts';
import { readBoundedJson, requestBodyResponse } from '../_shared/request.ts';

const BUCKET = 'staff-documents';
const MAX_REQUEST_BYTES = 4 * 1024;
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
  const ANON = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !ANON || !SERVICE) return json({ error: 'Server is not configured.' }, 500, cors);
  const baseUrl = SUPABASE_URL.replace(/\/$/, '');
  const authz = req.headers.get('authorization') || '';
  const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : '';
  if (!token || token === ANON) return json({ error: 'Authentication required.' }, 401, cors);
  if (!jwtHasAal2(token)) return json({ error: 'Two-factor authentication is required for this action.' }, 403, cors);

  let userRes: Response;
  try { userRes = await fetchInternal(`${baseUrl}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } }); }
  catch { return json({ error: 'Authentication could not be verified.' }, 503, cors); }
  if (!userRes.ok) return json({ error: 'Authentication required.' }, 401, cors);
  const user = await userRes.json().catch(() => null);
  const uid = typeof user?.id === 'string' ? user.id : '';
  if (!uid) return json({ error: 'Authentication required.' }, 401, cors);

  const svc = (path: string, init: RequestInit = {}) => fetchInternal(`${baseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> || {}) },
  });
  let callerRes: Response;
  try { callerRes = await svc(`staff_profiles?auth_id=eq.${encodeURIComponent(uid)}&select=id,name,role,status,ended_at&limit=1`); }
  catch { return json({ error: 'Could not verify staff profile.' }, 503, cors); }
  if (!callerRes.ok) return json({ error: 'Could not verify staff profile.' }, 503, cors);
  const caller = (await callerRes.json().catch(() => []))?.[0];
  if (!caller?.id || String(caller.status || 'active') === 'disabled' || caller.ended_at) return json({ error: 'No active staff profile is linked to this account.' }, 403, cors);
  if (String(caller.role) !== 'owner') return json({ error: 'Deleting documents is owner-only. Use the status controls instead.' }, 403, cors);

  let input: Record<string, unknown>;
  try { input = await readBoundedJson(req, MAX_REQUEST_BYTES); }
  catch (error) { const failure = requestBodyResponse(error); return json(failure.body, failure.status, cors); }
  const documentId = String(input.documentId || '').trim();
  if (!documentId || documentId.length > 160) return json({ error: 'Missing document reference.' }, 400, cors);

  const auditFailure = async (outcome: 'denied' | 'error', detail: string): Promise<boolean> => {
    try {
      const response = await svc('activity_log', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{
          actor_auth_id: uid, actor_staff_id: String(caller.id), actor_name: String(caller.name || ''), actor_role: 'owner',
          action: 'doc_delete', target_kind: 'staff_document', target_ref: documentId, outcome, detail: detail.slice(0, 300),
        }]),
      });
      return response.ok;
    } catch { return false; }
  };
  type TombstoneLookup =
    | { status: 'found'; deletedAt?: string }
    | { status: 'absent' }
    | { status: 'unavailable' };
  const lookupTombstone = async (): Promise<TombstoneLookup> => {
    try {
      const response = await svc(`staff_document_tombstones?document_id=eq.${encodeURIComponent(documentId)}&select=document_id,deleted_at&limit=1`);
      if (!response.ok) return { status: 'unavailable' };
      const rows = await response.json().catch(() => null);
      if (!Array.isArray(rows)) return { status: 'unavailable' };
      const row = rows[0];
      return row?.document_id
        ? { status: 'found', deletedAt: String(row.deleted_at || '') || undefined }
        : { status: 'absent' };
    } catch { return { status: 'unavailable' }; }
  };
  const patchDocumentState = async (query: string, body: Record<string, unknown>): Promise<boolean> => {
    try {
      const response = await svc(`staff_documents?${query}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body),
      });
      if (!response.ok) return false;
      const rows = await response.json().catch(() => null);
      return Array.isArray(rows) && rows.length === 1;
    } catch { return false; }
  };

  let docRes: Response;
  try { docRes = await svc(`staff_documents?id=eq.${encodeURIComponent(documentId)}&select=*&limit=1`); }
  catch { await auditFailure('error', 'lookup_unavailable'); return json({ error: 'Could not load the document.' }, 503, cors); }
  if (!docRes.ok) { await auditFailure('error', `lookup_failed_${docRes.status}`); return json({ error: 'Could not load the document.' }, 503, cors); }
  let document = (await docRes.json().catch(() => []))?.[0];
  if (!document) {
    const tombstone = await lookupTombstone();
    if (tombstone.status === 'found') return json({ ok: true, outcome: 'already_deleted', deletedAt: tombstone.deletedAt, tombstoneRetained: true }, 200, cors);
    if (tombstone.status === 'unavailable') {
      await auditFailure('error', 'tombstone_lookup_unavailable');
      return json({ error: 'Could not confirm whether this document was already deleted. Please try again.' }, 503, cors);
    }
    await auditFailure('denied', 'not_found');
    return json({ error: 'No such document.' }, 404, cors);
  }

  const initialState = String(document.file_state || 'active');
  if (!['active', 'deletion_pending', 'missing'].includes(initialState)) {
    await auditFailure('denied', `invalid_state_${initialState}`);
    return json({ error: 'This document cannot be deleted in its current state.' }, 409, cors);
  }

  // Claim a live/missing row. A pre-existing deletion_pending row is an
  // explicit retry after a prior ambiguous finalisation and may continue.
  if (initialState !== 'deletion_pending') {
    let claim: Response;
    try {
      claim = await svc(`staff_documents?id=eq.${encodeURIComponent(documentId)}&file_state=eq.${encodeURIComponent(initialState)}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ file_state: 'deletion_pending', deletion_error: null }),
      });
    } catch { await auditFailure('error', 'claim_unavailable'); return json({ error: 'Could not begin document deletion.' }, 503, cors); }
    if (!claim.ok) { await auditFailure('error', `claim_failed_${claim.status}`); return json({ error: 'Could not begin document deletion.' }, 502, cors); }
    document = (await claim.json().catch(() => []))?.[0];
    if (!document) return json({ error: 'The document changed before deletion. Reload and try again.' }, 409, cors);
  }

  const storagePath = String(document.storage_path || '');
  const storageBucket = String(document.storage_bucket || '');
  if (storagePath && storageBucket !== BUCKET) {
    const restored = await patchDocumentState(
      `id=eq.${encodeURIComponent(documentId)}&file_state=eq.deletion_pending`,
      { file_state: initialState === 'missing' ? 'missing' : 'active', deletion_error: 'unexpected_storage_bucket' },
    );
    await auditFailure('error', 'unexpected_storage_bucket');
    return json({
      error: restored
        ? 'The document storage reference is invalid. Nothing was deleted.'
        : 'The document storage reference is invalid and its state could not be restored automatically.',
      code: 'unexpected_storage_bucket', reconciliationRequired: !restored,
    }, 409, cors);
  }

  if (storagePath) {
    let deletion: Response;
    try {
      deletion = await fetchInternal(`${baseUrl}/storage/v1/object/${encodeURIComponent(BUCKET)}/${encodeStoragePath(storagePath)}`, {
        method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      });
    } catch {
      const restored = await patchDocumentState(
        `id=eq.${encodeURIComponent(documentId)}&file_state=eq.deletion_pending`,
        { file_state: initialState === 'missing' ? 'missing' : 'active', deletion_error: 'object_delete_transport_failure' },
      );
      await auditFailure('error', 'object_delete_transport_failure');
      return json({
        error: restored ? 'Could not confirm removal of the stored file. The document record remains.' : 'The file deletion could not be confirmed and the record requires reconciliation.',
        reconciliationRequired: !restored,
      }, 502, cors);
    }
    if (!deletion.ok && deletion.status !== 404) {
      const reason = `object_delete_${deletion.status}`;
      const restored = await patchDocumentState(
        `id=eq.${encodeURIComponent(documentId)}&file_state=eq.deletion_pending`,
        { file_state: initialState === 'missing' ? 'missing' : 'active', deletion_error: reason },
      );
      await auditFailure('denied', reason);
      return json({
        error: restored ? 'Could not remove the stored file. The document record remains.' : 'The stored file may remain and the record requires reconciliation.',
        code: reason, reconciliationRequired: !restored,
      }, 502, cors);
    }
  }

  // The object is now confirmed absent. Finalise metadata and success audit in
  // one database transaction. A lost response is resolved via the tombstone.
  let finalise: Response | null = null;
  try {
    finalise = await svc('rpc/finalize_staff_document_deletion', {
      method: 'POST',
      body: JSON.stringify({
        p_document_id: documentId, p_actor_auth_id: uid,
        p_actor_staff_id: String(caller.id), p_actor_name: String(caller.name || ''),
      }),
    });
    if (finalise.ok) {
      const body = await finalise.json().catch(() => null);
      return json({ ok: true, outcome: body?.alreadyFinalized ? 'already_deleted' : 'deleted', deletedAt: body?.deletedAt, tombstoneRetained: true }, 200, cors);
    }
  } catch { finalise = null; }

  const confirmed = await lookupTombstone();
  if (confirmed.status === 'found') {
    return json({ ok: true, outcome: 'deleted', deletedAt: confirmed.deletedAt, tombstoneRetained: true, responseRecovered: true }, 200, cors);
  }

  // The file is absent but metadata finalisation was not confirmed. Preserve a
  // visible owner-only recovery row; never claim that nothing changed.
  const marked = await patchDocumentState(
    `id=eq.${encodeURIComponent(documentId)}&file_state=eq.deletion_pending`,
    { file_state: 'missing', deletion_error: `tombstone_unconfirmed_${finalise?.status ?? 'transport'}` },
  );
  await auditFailure('error', `tombstone_unconfirmed_${finalise?.status ?? 'transport'}`);
  return json({
    error: marked
      ? 'The private file is gone, but the deletion record still needs reconciliation. Retry deletion from the owner document list.'
      : 'The private file is gone, but the deletion record could not be reconciled automatically.',
    code: 'reconciliation_required', objectDeleted: true, reconciliationRequired: true,
  }, 502, cors);
});
