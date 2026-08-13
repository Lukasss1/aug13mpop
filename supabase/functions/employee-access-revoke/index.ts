// ============================================================================
// MILK POP — claimed account-security executor (T13.3.19)
//
// Every Auth Admin action requires a fresh intent claimed and re-authorised by
// the database using the caller's JWT. Each provider/profile/audit step has an
// explicit result; partial outcomes are never described as "nothing changed".
// ============================================================================
import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';
import { readBoundedJson, requestBodyResponse } from '../_shared/request.ts';

const MAX_REQUEST_BYTES = 4 * 1024;
type Step = { step: string; status: number | null; ok: boolean; detail?: string };

function corsHeaders(origin: string | null): Record<string, string> {
  return buildCorsHeaders(origin, ['CV_ALLOWED_ORIGINS'], 'POST, OPTIONS');
}
function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

  const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, '');
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';
  if (!SUPABASE_URL || !SERVICE || !ANON) return json({ error: 'server_unconfigured' }, 500, cors);

  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt || jwt === ANON) return json({ error: 'not_permitted' }, 401, cors);
  let body: Record<string, unknown>;
  try { body = await readBoundedJson(req, MAX_REQUEST_BYTES); }
  catch (error) { const failure = requestBodyResponse(error); return json(failure.body, failure.status, cors); }
  const intentId = String(body.intent_id || '').trim();
  if (!intentId || intentId.length > 128) return json({ error: 'missing_intent' }, 400, cors);

  const svc = (path: string, init: RequestInit = {}) => fetchInternal(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> || {}) },
  });
  const admin = (path: string, init: RequestInit = {}) => fetchInternal(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> || {}) },
  });

  let who: Response;
  try { who = await fetchInternal(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${jwt}` } }); }
  catch { return json({ error: 'identity_unavailable' }, 503, cors); }
  if (!who.ok) return json({ error: 'not_permitted' }, 401, cors);

  let claimRes: Response;
  try {
    claimRes = await fetchInternal(`${SUPABASE_URL}/rest/v1/rpc/claim_recovery_intent`, {
      method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_intent_id: intentId }),
    });
  } catch { return json({ error: 'claim_unavailable' }, 503, cors); }
  if (!claimRes.ok) return json({ error: 'claim_failed' }, 500, cors);
  const claim = await claimRes.json().catch(() => null);
  if (!claim?.ok) {
    const status = claim?.error === 'intent_not_found' ? 404 : claim?.error === 'intent_already_consumed' ? 409 :
      claim?.error === 'intent_expired' ? 410 : claim?.error === 'target_has_no_auth_account' ? 422 : 403;
    return json({ error: claim?.error || 'not_permitted' }, status, cors);
  }

  const intent = { action: String(claim.action || ''), target_staff_id: String(claim.target_staff_id || ''), requested_by: String(claim.requested_by || '') };
  const uid = String(claim.target_auth_id || '');
  if (!uid && !['disable_account', 'enable_account'].includes(intent.action)) {
    return json({ error: 'target_has_no_auth_account' }, 422, cors);
  }

  const steps: Step[] = [];
  const perform = async (step: string, operation: () => Promise<Response>): Promise<boolean> => {
    try {
      const response = await operation();
      steps.push({ step, status: response.status, ok: response.ok });
      return response.ok;
    } catch (error) {
      steps.push({ step, status: null, ok: false, detail: String((error as { message?: string })?.message || error).slice(0, 120) });
      return false;
    }
  };
  const fail = (step: string, detail: string) => steps.push({ step, status: null, ok: false, detail: detail.slice(0, 120) });
  const profileStatus = async (status: 'active' | 'disabled'): Promise<boolean> => {
    try {
      const response = await svc(`/rest/v1/staff_profiles?id=eq.${encodeURIComponent(intent.target_staff_id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status }),
      });
      if (!response.ok) {
        steps.push({ step: 'profile_status', status: response.status, ok: false });
        return false;
      }
      const rows = await response.json().catch(() => null);
      const confirmed = Array.isArray(rows) && rows.length === 1 && String(rows[0]?.status || '') === status;
      steps.push({ step: 'profile_status', status: response.status, ok: confirmed, ...(confirmed ? {} : { detail: 'profile update was not confirmed' }) });
      return confirmed;
    } catch (error) {
      steps.push({ step: 'profile_status', status: null, ok: false, detail: String((error as { message?: string })?.message || error).slice(0, 120) });
      return false;
    }
  };

  if (intent.action === 'reset_mfa') {
    let factorResponse: Response | null = null;
    try { factorResponse = await admin(`/users/${encodeURIComponent(uid)}/factors`); }
    catch (error) { fail('factor_list_unreadable', String(error)); }
    if (factorResponse) {
      steps.push({ step: 'factor_list', status: factorResponse.status, ok: factorResponse.ok });
      if (factorResponse.ok) {
        const factorBody = await factorResponse.json().catch(() => null);
        const factors = Array.isArray(factorBody) ? factorBody : factorBody?.factors;
        if (!Array.isArray(factors)) fail('factor_list_malformed', 'response was not a factor array');
        else {
          for (const factor of factors) {
            const factorId = String(factor?.id || '');
            if (!factorId) { fail('factor_delete', 'factor id missing'); continue; }
            await perform(`factor_delete:${factorId}`, () => admin(`/users/${encodeURIComponent(uid)}/factors/${encodeURIComponent(factorId)}`, { method: 'DELETE' }));
          }
          await perform('logout', () => admin(`/users/${encodeURIComponent(uid)}/logout`, { method: 'POST' }));
        }
      }
    }
  } else if (intent.action === 'revoke_sessions') {
    await perform('logout', () => admin(`/users/${encodeURIComponent(uid)}/logout`, { method: 'POST' }));
  } else if (intent.action === 'ban_leaver' || intent.action === 'disable_account') {
    if (!uid && intent.action === 'disable_account') {
      steps.push({ step: 'auth_account', status: null, ok: true, detail: 'not_applicable' });
      await profileStatus('disabled');
    } else {
      const banOk = await perform('auth_ban', () => admin(`/users/${encodeURIComponent(uid)}`, {
        method: 'PUT', body: JSON.stringify({ ban_duration: intent.action === 'ban_leaver' ? '87600h' : '876000h' }),
      }));
      if (banOk) {
        await perform('logout', () => admin(`/users/${encodeURIComponent(uid)}/logout`, { method: 'POST' }));
        if (intent.action === 'disable_account') await profileStatus('disabled');
      } else if (intent.action === 'disable_account') {
        fail('profile_status_skipped', 'auth ban was not confirmed');
      }
    }
  } else if (intent.action === 'enable_account') {
    if (!uid) {
      steps.push({ step: 'auth_account', status: null, ok: true, detail: 'not_applicable' });
      await profileStatus('active');
    } else {
      const unbanOk = await perform('auth_unban', () => admin(`/users/${encodeURIComponent(uid)}`, {
        method: 'PUT', body: JSON.stringify({ ban_duration: 'none' }),
      }));
      if (unbanOk) await profileStatus('active');
      else fail('profile_status_skipped', 'auth unban was not confirmed');
    }
  } else {
    fail('unknown_action', intent.action || 'empty');
  }

  const operationSteps = [...steps];
  const operationFailed = operationSteps.some((step) => !step.ok);
  const operationSucceeded = operationSteps.some((step) => step.ok);
  const partial = operationFailed && operationSucceeded;
  const operationSummary = operationSteps.map((step) => `${step.step}:${step.ok ? 'ok' : (step.status ?? step.detail ?? 'failed')}`).join(' ').slice(0, 1000);

  await perform('intent_result_record', () => svc(`/rest/v1/admin_recovery_intents?id=eq.${encodeURIComponent(intentId)}`, {
    method: 'PATCH', body: JSON.stringify({ result: operationSummary || 'no_operation' }),
  }));
  await perform('audit_record', () => svc('/rest/v1/audit_logs', {
    method: 'POST',
    body: JSON.stringify({
      id: crypto.randomUUID(), operator_name: intent.requested_by, role: 'server',
      action: `recovery.${intent.action}.executed`, timestamp: new Date().toISOString(), module: 'Security',
      new_value: `${intent.target_staff_id} ${operationSummary}`.slice(0, 500),
    }),
  }));

  const failed = steps.some((step) => !step.ok);
  const authAccount = operationSteps.some((step) => step.step === 'auth_account' && step.ok && step.detail === 'not_applicable')
    ? 'not_applicable'
    : operationSteps.some((step) => ['auth_ban', 'auth_unban'].includes(step.step) && step.ok)
      ? 'updated'
      : undefined;
  const confirmedStatus = intent.action === 'disable_account' && operationSteps.some((step) => step.step === 'profile_status' && step.ok)
    ? 'disabled' : intent.action === 'enable_account' && operationSteps.some((step) => step.step === 'profile_status' && step.ok) ? 'active' : undefined;
  console.log(JSON.stringify({ fn: 'employee-access-revoke', action: intent.action, target: intent.target_staff_id, steps }));
  return json({
    ok: !failed,
    action: intent.action,
    steps,
    partial: partial || (operationSucceeded && failed),
    reconciliationRequired: failed,
    ...(confirmedStatus ? { confirmedStatus } : {}),
    ...(authAccount ? { authAccount } : {}),
  }, failed ? 502 : 200, cors);
});
