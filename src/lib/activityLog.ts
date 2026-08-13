/**
 * @file activityLog.ts
 * @description Post-Stage-12 fix #4 — the owner-only reader for the
 * server-written `activity_log` stream (document access/uploads/deletions,
 * onboarding actions, CV access). Rows are written ONLY by Edge Functions
 * with a server-derived actor; RLS exposes them to owners since Stage 11.
 * Loaded on demand — this is an investigation surface, not hydrated state.
 */
import { getSupabaseConfig } from './supabase';
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from './requestTimeout';

export interface ActivityLogEntry {
  id: string;
  actorName: string;
  actorRole: string;
  actorStaffId?: string | undefined;
  action: string;
  targetKind?: string | undefined;
  targetRef?: string | undefined;
  outcome: 'ok' | 'granted' | 'denied' | 'error';
  detail?: string | undefined;
  createdAt: string;
}

export async function listActivityLog(
  token: string,
  limit = 200,
): Promise<{ ok: true; data: ActivityLogEntry[] } | { ok: false; message: string }> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { ok: false, message: 'No database is configured.' };
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${cfg.url.replace(/\/$/, '')}/rest/v1/activity_log?select=*&order=created_at.desc&limit=${Math.min(500, Math.max(1, limit))}`,
      { headers: { apikey: cfg.anonKey, Authorization: `Bearer ${token}` } },
      REQUEST_TIMEOUT_MS.read,
    );
  } catch {
    return { ok: false, message: 'Network problem — could not load the access log.' };
  }
  if (!res.ok) {
    return { ok: false, message: res.status === 403 || res.status === 401 ? 'The access log is owner-only.' : 'Could not load the access log.' };
  }
  const rows = await res.json().catch(() => []);
  const data: ActivityLogEntry[] = (Array.isArray(rows) ? rows : []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    actorName: String(r.actor_name || ''),
    actorRole: String(r.actor_role || ''),
    actorStaffId: r.actor_staff_id ? String(r.actor_staff_id) : undefined,
    action: String(r.action || ''),
    targetKind: r.target_kind ? String(r.target_kind) : undefined,
    targetRef: r.target_ref ? String(r.target_ref) : undefined,
    outcome: (r.outcome || 'ok') as ActivityLogEntry['outcome'],
    detail: r.detail ? String(r.detail) : undefined,
    createdAt: String(r.created_at || ''),
  }));
  return { ok: true, data };
}
