/**
 * Staff onboarding and account-lifecycle client.
 *
 * Invitation/refresh is handled by staff-invite. Disable/enable uses the
 * claimed recovery-intent executor so the browser receives typed partial
 * outcomes and mirrors only server-confirmed profile state.
 */
import { getSupabaseConfig } from './supabase';
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from './requestTimeout';

export type StaffInviteAction = 'invite' | 'refresh' | 'disable' | 'enable';
export type StaffInviteResult =
  | {
      ok: true;
      onboarding?: string;
      status?: string;
      invitedAt?: string | null;
      emailSent?: boolean;
      outcome?: string;
      reconciliationRequired?: boolean;
      message?: string;
      authAccount?: 'updated' | 'not_applicable';
    }
  | {
      ok: false;
      message: string;
      status?: string;
      partial?: boolean;
      reconciliationRequired?: boolean;
    };

function safeMessage(body: unknown, fallback: string): string {
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : null;
  return typeof error === 'string' && error.length > 0 && error.length < 240 ? error : fallback;
}

async function postJson(url: string, anonKey: string, token: string, body: unknown): Promise<{ response: Response; body: any }> {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, REQUEST_TIMEOUT_MS.action);
  return { response, body: await response.json().catch(() => null) };
}

export async function staffInvite(
  action: StaffInviteAction,
  employeeId: string,
  token: string,
): Promise<StaffInviteResult> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { ok: false, message: 'No database is configured.' };
  const base = cfg.url.replace(/\/$/, '');

  try {
    if (action === 'invite' || action === 'refresh') {
      const { response, body } = await postJson(
        `${base}/functions/v1/staff-invite`, cfg.anonKey, token, { action, employeeId },
      );
      if (!response.ok || body?.ok !== true) {
        return {
          ok: false,
          message: safeMessage(body, 'The onboarding operation could not be confirmed.'),
          reconciliationRequired: body?.reconciliationRequired === true,
        };
      }
      return {
        ok: true,
        onboarding: typeof body.onboarding === 'string' ? body.onboarding : undefined,
        invitedAt: typeof body.invitedAt === 'string' ? body.invitedAt : body.invitedAt === null ? null : undefined,
        emailSent: body.emailSent === true,
        outcome: typeof body.outcome === 'string' ? body.outcome : undefined,
        reconciliationRequired: body.reconciliationRequired === true,
      };
    }

    const recoveryAction = action === 'disable' ? 'disable_account' : 'enable_account';
    const intent = await postJson(`${base}/rest/v1/rpc/request_recovery_action`, cfg.anonKey, token, {
      p_action: recoveryAction,
      p_target: employeeId,
      p_reason: `Owner requested ${action} from the Admin Panel`,
    });
    if (!intent.response.ok || intent.body?.ok !== true || typeof intent.body?.intent_id !== 'string') {
      return { ok: false, message: safeMessage(intent.body, 'The protected account change could not be authorised.') };
    }

    const execution = await postJson(`${base}/functions/v1/employee-access-revoke`, cfg.anonKey, token, {
      intent_id: intent.body.intent_id,
    });
    const confirmed = typeof execution.body?.confirmedStatus === 'string' ? execution.body.confirmedStatus : undefined;
    if (!execution.response.ok || execution.body?.ok !== true) {
      return {
        ok: false,
        message: execution.body?.partial === true
          ? 'The account change was only partly completed. The confirmed profile state is shown; reconciliation is required.'
          : safeMessage(execution.body, 'The account change was not fully confirmed.'),
        status: confirmed,
        partial: execution.body?.partial === true,
        reconciliationRequired: execution.body?.reconciliationRequired !== false,
      };
    }
    const authAccount = execution.body?.authAccount === 'updated' || execution.body?.authAccount === 'not_applicable'
      ? execution.body.authAccount
      : undefined;
    if (!confirmed || !authAccount) {
      return {
        ok: false,
        message: 'The protected account change returned an incomplete confirmation. Reload the staff record before retrying.',
        status: confirmed,
        reconciliationRequired: true,
      };
    }
    return { ok: true, status: confirmed, outcome: recoveryAction, authAccount };
  } catch {
    return { ok: false, message: 'The server did not confirm the staff change. Reload the staff record before retrying.' };
  }
}

export function onboardingLabel(onboarding?: string, status?: string): string {
  if (status === 'disabled') return 'Account disabled';
  switch (onboarding) {
    case 'active': return 'Account active';
    case 'invited': return 'Invitation sent';
    default: return 'Profile created';
  }
}
