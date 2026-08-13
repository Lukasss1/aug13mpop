// ============================================================================
// MILK POP — media-cleanup Edge Function (the only storage cleanup worker)
//
// Owner + AAL2 + MEDIA_CLEANUP_ENABLED=true. The worker marks and claims only
// server-confirmed candidates, treats only Storage 2xx/404 as object absence,
// and reports success only when the database also records every outcome.
// ============================================================================

import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';
import { jwtHasAal2 } from '../_shared/jwt.ts';
import { encodeStoragePath } from '../_shared/storage.ts';


function corsHeaders(origin: string | null): Record<string, string> {
  return buildCorsHeaders(origin, ['CV_ALLOWED_ORIGINS'], 'POST, OPTIONS');
}
function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
function storageObjectUrl(baseUrl: string, bucket: string, objectPath: string): string {
  return `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(objectPath)}`;
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

  // Cleanup is deployed inert. Upload enablement never enables deletion.
  if (String(Deno.env.get('MEDIA_CLEANUP_ENABLED') || '').trim() !== 'true') {
    return json({ error: 'Media cleanup is not enabled on this deployment.' }, 403, cors);
  }

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || token === ANON) return json({ error: 'Authentication required.' }, 401, cors);
  if (!jwtHasAal2(token)) return json({ error: 'This action requires a fully verified (MFA) session.' }, 403, cors);

  let userRes: Response;
  try {
    userRes = await fetchInternal(`${baseUrl}/auth/v1/user`, {
      headers: { apikey: ANON, Authorization: `Bearer ${token}` },
    });
  } catch {
    return json({ error: 'Authentication could not be verified.' }, 503, cors);
  }
  if (!userRes.ok) return json({ error: 'Authentication required.' }, 401, cors);
  const user = await userRes.json().catch(() => null);
  const uid: string | undefined = user?.id;
  if (!uid) return json({ error: 'Authentication required.' }, 401, cors);

  const svc = (path: string, init: RequestInit = {}) => fetchInternal(`${baseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> || {}),
    },
  });

  let callerRes: Response;
  try {
    callerRes = await svc(`staff_profiles?auth_id=eq.${encodeURIComponent(uid)}&select=id,role,status,ended_at&limit=1`);
  } catch {
    return json({ error: 'Could not verify staff profile.' }, 503, cors);
  }
  if (!callerRes.ok) return json({ error: 'Could not verify staff profile.' }, 503, cors);
  const caller = (await callerRes.json().catch(() => []))?.[0];
  if (!caller || String(caller.status || 'active') === 'disabled' || caller.ended_at || String(caller.role || '') !== 'owner') {
    return json({ error: 'Only an active owner can run media cleanup.' }, 403, cors);
  }

  const storageDelete = async (bucket: string, objectPath: string): Promise<{ ok: boolean; detail: string }> => {
    try {
      const response = await fetchInternal(storageObjectUrl(baseUrl, bucket, objectPath), {
        method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      });
      if (response.ok || response.status === 404) return { ok: true, detail: String(response.status) };
      return { ok: false, detail: `storage ${response.status}` };
    } catch (error) {
      return { ok: false, detail: `network ${String((error as { message?: string })?.message || error).slice(0, 120)}` };
    }
  };

  const counts = { marked: 0, deleted: 0, failed: 0, jobsDone: 0, jobsFailed: 0, reconciliationRequired: 0 };

  let mark: Response;
  try {
    mark = await svc('rpc/mark_media_cleanup_candidates', {
      method: 'POST', body: JSON.stringify({ p_grace_hours: 24 }),
    });
  } catch {
    return json({ ok: false, error: 'Cleanup candidates could not be prepared.' }, 503, cors);
  }
  if (!mark.ok) return json({ ok: false, error: 'Cleanup candidates could not be prepared.' }, 503, cors);
  const marked = Number(await mark.json().catch(() => Number.NaN));
  if (!Number.isFinite(marked) || marked < 0) return json({ ok: false, error: 'Cleanup returned an invalid candidate count.' }, 502, cors);
  counts.marked = marked;

  let claim: Response;
  try {
    claim = await svc('rpc/claim_media_cleanup_batch', { method: 'POST', body: JSON.stringify({ p_limit: 25 }) });
  } catch {
    return json({ ok: false, ...counts, error: 'Media cleanup candidates could not be claimed.' }, 503, cors);
  }
  if (!claim.ok) return json({ ok: false, ...counts, error: 'Media cleanup candidates could not be claimed.' }, 503, cors);
  const objectBody = await claim.json().catch(() => null);
  if (!Array.isArray(objectBody)) return json({ ok: false, ...counts, error: 'Media cleanup returned an invalid batch.' }, 502, cors);
  const objects = objectBody as Array<{ id?: string; bucket?: string; storage_path?: string }>;

  for (const object of objects) {
    if (!object?.id || !object?.bucket || !object?.storage_path) {
      counts.reconciliationRequired++;
      continue;
    }
    const deletion = await storageDelete(object.bucket, object.storage_path);
    const recorded = await svc('rpc/record_media_cleanup_result', {
      method: 'POST',
      body: JSON.stringify({ p_id: object.id, p_ok: deletion.ok, p_error: deletion.ok ? null : deletion.detail }),
    }).catch(() => null);
    if (!recorded?.ok) {
      counts.reconciliationRequired++;
      continue;
    }
    deletion.ok ? counts.deleted++ : counts.failed++;
  }

  let jobClaim: Response;
  try {
    jobClaim = await svc('rpc/claim_storage_cleanup_batch', { method: 'POST', body: JSON.stringify({ p_limit: 25 }) });
  } catch {
    return json({ ok: false, ...counts, error: 'Storage cleanup jobs could not be claimed.', reconciliationRequired: true }, 503, cors);
  }
  if (!jobClaim.ok) return json({ ok: false, ...counts, error: 'Storage cleanup jobs could not be claimed.', reconciliationRequired: true }, 503, cors);
  const jobBody = await jobClaim.json().catch(() => null);
  if (!Array.isArray(jobBody)) return json({ ok: false, ...counts, error: 'Storage cleanup returned an invalid batch.', reconciliationRequired: true }, 502, cors);
  const jobs = jobBody as Array<{ id?: string; bucket?: string; storage_path?: string }>;

  for (const job of jobs) {
    if (!job?.id || !job?.bucket || !job?.storage_path) {
      counts.reconciliationRequired++;
      continue;
    }
    const deletion = await storageDelete(job.bucket, job.storage_path);
    const recorded = await svc('rpc/record_storage_cleanup_result', {
      method: 'POST',
      body: JSON.stringify({ p_id: job.id, p_ok: deletion.ok, p_error: deletion.ok ? null : deletion.detail }),
    }).catch(() => null);
    if (!recorded?.ok) {
      counts.reconciliationRequired++;
      continue;
    }
    deletion.ok ? counts.jobsDone++ : counts.jobsFailed++;
  }

  if (counts.reconciliationRequired > 0) {
    return json({
      ok: false,
      ...counts,
      error: 'Cleanup ran, but one or more outcomes could not be recorded. Review the cleanup queues before retrying.',
      reconciliationRequired: true,
    }, 502, cors);
  }
  return json({ ok: true, ...counts }, 200, cors);
});
