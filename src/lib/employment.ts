/**
 * @file employment.ts
 * @description R4.8 Workstream B — the employment lifecycle client.
 *
 * There is no casual "delete employee" any more. The normal leaver path is:
 *   1. end_employment() RPC — records end date/reason/notes, disables the
 *      profile (immediately or on the scheduled date), flags future shifts,
 *      preserves ALL history, writes the audit event. The stage9 helpers make
 *      a disabled profile lose every staff power on its very next request.
 *   2. request_recovery_action('ban_leaver') + employee-access-revoke — the
 *      audited two-step that revokes the leaver's refresh tokens at the Auth
 *      API, so existing sessions die without waiting for a manual logout.
 * purgeEmployee() exists ONLY for a mistaken duplicate with no history: the
 * server re-checks role (owner+AAL2), typed-name confirmation, and refuses
 * whenever any dependent record exists.
 */
import { callRpc } from './registries';
import { getAccessToken } from './auth';
import { sbInvokeFunctionAuthed } from './supabase';

export interface EndEmploymentInput {
  employeeId: string;
  endDate: string;          // yyyy-mm-dd
  reason: string;
  notes: string;
  immediate: boolean;
}

export type LifecycleResult =
  | { ok: true; detail: string }
  | { ok: false; error: string };

export async function endEmployment(input: EndEmploymentInput): Promise<LifecycleResult> {
  const token = await getAccessToken();
  if (!token) return { ok: false, error: 'Your session has expired. Sign in again.' };
  try {
    const r = await callRpc<{ ok: boolean; future_shifts_flagged?: number; access_disabled?: boolean }>(
      'end_employment',
      { p_employee_id: input.employeeId, p_end_date: input.endDate, p_reason: input.reason, p_notes: input.notes, p_immediate: input.immediate },
      token,
    );
    if (!r?.ok) return { ok: false, error: 'The server declined the request.' };
    let sessions = 'Existing sessions will end at the scheduled date.';
    if (r.access_disabled) {
      // Best-effort immediate token revocation through the audited chain.
      try {
        const intent = await callRpc<{ ok: boolean; intent_id?: string }>(
          'request_recovery_action',
          { p_action: 'ban_leaver', p_target: input.employeeId, p_reason: `employment ended ${input.endDate}` },
          token,
        );
        if (intent?.ok && intent.intent_id) {
          const exec = await sbInvokeFunctionAuthed<{ ok?: boolean }>(
            'employee-access-revoke', { intent_id: intent.intent_id }, token,
          );
          sessions = exec?.ok
            ? 'Access disabled and existing sessions revoked.'
            : 'Access disabled; automatic session revocation did not confirm — the account is still locked out of staff data, but check Security → recovery actions.';
        } else {
          sessions = 'Access disabled; session revocation intent was not created — check Security → recovery actions.';
        }
      } catch {
        sessions = 'Access disabled; session revocation could not be confirmed — the profile is locked out of staff data regardless.';
      }
    }
    return { ok: true, detail: `${r.future_shifts_flagged ?? 0} future shift(s) flagged. ${sessions}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'End employment failed.' };
  }
}

export async function purgeEmployee(employeeId: string, typedName: string): Promise<LifecycleResult> {
  const token = await getAccessToken();
  if (!token) return { ok: false, error: 'Your session has expired. Sign in again.' };
  try {
    const r = await callRpc<{ ok: boolean; error?: string; dependencies?: string[] }>(
      'purge_employee', { p_employee_id: employeeId, p_typed_name: typedName }, token,
    );
    if (r?.ok) return { ok: true, detail: 'Duplicate profile removed.' };
    if (r?.error === 'has_dependent_history') {
      return { ok: false, error: `Refused: this profile has history (${(r.dependencies || []).join(', ')}). Use "End employment" instead.` };
    }
    return { ok: false, error: r?.error || 'The server declined the purge.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Purge failed.' };
  }
}
