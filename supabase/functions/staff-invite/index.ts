// ============================================================================
// MILK POP — staff invitation and onboarding truth (T13.3.19)
//
// This function owns only invitation and read-derived onboarding refresh.
// Security lifecycle actions (disable/enable/session revocation) use the
// claimed recovery-intent executor so partial Auth/profile outcomes are visible.
// Deploy WITH JWT verification ON.
// ============================================================================
import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';
import { jwtHasAal2 } from '../_shared/jwt.ts';
import { readBoundedJson, requestBodyResponse } from '../_shared/request.ts';
import { EXTERNAL_PROVIDER_TIMEOUT_MS, ProviderTimeoutError, fetchProviderJson } from '../_shared/providerFetch.ts';

const MAX_REQUEST_BYTES = 8 * 1024;
type OnboardingStatus = 'profile_created' | 'invited' | 'active';
type AuthUser = { id: string; email?: string | null; last_sign_in_at?: string | null; banned_until?: string | null };
type Lookup = { kind: 'found'; user: AuthUser } | { kind: 'not_found' } | { kind: 'unavailable'; status?: number };

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
  const SITE_URL = (Deno.env.get('SITE_URL') || '').replace(/\/$/, '');
  const RESEND = Deno.env.get('RESEND_API_KEY') || '';
  const EMAIL_FROM = Deno.env.get('EMAIL_FROM') || 'onboarding@resend.dev';
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
  const adminAuth = (path: string, init: RequestInit = {}) => fetchInternal(`${baseUrl}/auth/v1${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> || {}) },
  });

  let callerRes: Response;
  try { callerRes = await svc(`staff_profiles?auth_id=eq.${encodeURIComponent(uid)}&select=id,name,role,store_id,status,ended_at&limit=1`); }
  catch { return json({ error: 'Could not verify staff profile.' }, 503, cors); }
  if (!callerRes.ok) return json({ error: 'Could not verify staff profile.' }, 503, cors);
  const caller = (await callerRes.json().catch(() => []))?.[0];
  if (!caller?.id || String(caller.status || 'active') === 'disabled' || caller.ended_at) {
    return json({ error: 'No active staff profile is linked to this account.' }, 403, cors);
  }
  const role = String(caller.role || '');
  if (role !== 'owner' && role !== 'store_manager') return json({ error: 'Only owners and store managers can manage onboarding.' }, 403, cors);

  let input: Record<string, unknown>;
  try { input = await readBoundedJson(req, MAX_REQUEST_BYTES); }
  catch (error) { const failure = requestBodyResponse(error); return json(failure.body, failure.status, cors); }
  const action = String(input.action || '').trim();
  const employeeId = String(input.employeeId || '').trim();
  if (!['invite', 'refresh'].includes(action)) {
    return json({ error: 'Use the protected account-lifecycle workflow for enable or disable actions.', code: 'lifecycle_action_requires_recovery_intent' }, 400, cors);
  }
  if (!employeeId || employeeId.length > 128) return json({ error: 'Missing employee reference.' }, 400, cors);

  const audit = async (auditAction: string, outcome: 'granted' | 'denied' | 'error', detail: string): Promise<boolean> => {
    try {
      const response = await svc('activity_log', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{
          actor_auth_id: uid, actor_staff_id: String(caller.id), actor_name: String(caller.name || ''), actor_role: role,
          action: auditAction, target_kind: 'staff_profile', target_ref: employeeId, outcome, detail: detail.slice(0, 300),
        }]),
      });
      return response.ok;
    } catch { return false; }
  };

  let targetRes: Response;
  try { targetRes = await svc(`staff_profiles?id=eq.${encodeURIComponent(employeeId)}&select=id,name,email,role,store_id,auth_id,status,onboarding,invited_at,ended_at&limit=1`); }
  catch { return json({ error: 'Could not load the employee.' }, 503, cors); }
  if (!targetRes.ok) return json({ error: 'Could not load the employee.' }, 503, cors);
  const target = (await targetRes.json().catch(() => []))?.[0];
  if (!target?.id) { await audit(`staff_${action}`, 'denied', 'target_not_found'); return json({ error: 'No such employee.' }, 404, cors); }
  if (String(target.status || 'active') === 'disabled' || target.ended_at) {
    await audit(`staff_${action}`, 'denied', target.ended_at ? 'target_employment_ended' : 'target_disabled');
    return json({
      error: target.ended_at
        ? 'This employee’s employment has ended, so a staff invitation cannot be sent.'
        : 'This staff account is disabled. Re-enable it through the protected account workflow before managing onboarding.',
      code: target.ended_at ? 'target_employment_ended' : 'target_disabled',
    }, 409, cors);
  }

  if (role !== 'owner') {
    if (String(target.store_id || '') !== String(caller.store_id || '')) {
      await audit(`staff_${action}`, 'denied', 'other_store');
      return json({ error: 'This employee belongs to another store.' }, 403, cors);
    }
    if (!['team_member', 'supervisor'].includes(String(target.role || ''))) {
      await audit(`staff_${action}`, 'denied', 'peer_or_higher_target');
      return json({ error: 'Only the owner can administer manager accounts.' }, 403, cors);
    }
  }

  const patchProfile = async (fields: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    const response = await svc(`staff_profiles?id=eq.${encodeURIComponent(employeeId)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(fields),
    });
    if (!response.ok) return null;
    const rows = await response.json().catch(() => []);
    return Array.isArray(rows) && rows[0] ? rows[0] as Record<string, unknown> : null;
  };

  const findByEmail = async (email: string): Promise<Lookup> => {
    try {
      const response = await adminAuth(`/admin/users?page=1&per_page=200&email=${encodeURIComponent(email)}`);
      if (!response.ok) return { kind: 'unavailable', status: response.status };
      const body = await response.json().catch(() => null);
      if (!body) return { kind: 'unavailable' };
      const users: AuthUser[] = Array.isArray(body?.users) ? body.users : Array.isArray(body) ? body : [];
      const found = users.find((item) => String(item?.email || '').toLowerCase() === email.toLowerCase());
      return found?.id ? { kind: 'found', user: found } : { kind: 'not_found' };
    } catch { return { kind: 'unavailable' }; }
  };
  const findById = async (authId: string): Promise<Lookup> => {
    try {
      const response = await adminAuth(`/admin/users/${encodeURIComponent(authId)}`);
      if (response.status === 404) return { kind: 'not_found' };
      if (!response.ok) return { kind: 'unavailable', status: response.status };
      const found = await response.json().catch(() => null) as AuthUser | null;
      return found?.id ? { kind: 'found', user: found } : { kind: 'unavailable' };
    } catch { return { kind: 'unavailable' }; }
  };

  const email = String(target.email || '').trim().toLowerCase();
  if (!email || email.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    await audit(`staff_${action}`, 'denied', 'invalid_email');
    return json({ error: 'Give this employee a valid e-mail address first.' }, 400, cors);
  }

  if (action === 'invite') {
    const lookup = await findByEmail(email);
    if (lookup.kind === 'unavailable') {
      await audit('staff_invite', 'error', 'auth_lookup_unavailable');
      return json({ error: 'The sign-in service could not confirm whether this account exists. The MilkPop staff profile was left unchanged.', code: 'auth_truth_unavailable' }, 503, cors);
    }

    if (lookup.kind === 'found' && lookup.user.last_sign_in_at) {
      const updated = await patchProfile({ auth_id: lookup.user.id, onboarding: 'active' });
      if (!updated) {
        await audit('staff_invite', 'error', 'profile_link_failed_after_auth_confirmed');
        return json({ error: 'The active sign-in account was found, but the staff profile could not be linked.', code: 'reconciliation_required', reconciliationRequired: true }, 502, cors);
      }
      const auditRecorded = await audit('staff_invite', 'granted', 'existing_active_account_linked');
      return json({ ok: true, outcome: 'existing_active', onboarding: 'active', emailSent: false, invitedAt: target.invited_at || null, auditRecorded, reconciliationRequired: !auditRecorded }, 200, cors);
    }

    // Supabase's admin generate-link contract is the truthful resend path: it
    // creates an invite user when necessary and returns an action link for a
    // custom provider. Unlike calling /invite for an existing unconfirmed user,
    // this does not turn a provider rejection into a false success.
    if (!RESEND) {
      await audit('staff_invite', 'error', 'resend_provider_unconfigured');
      return json({ error: 'Staff invitation e-mail is not configured. The MilkPop staff profile was not marked invited.', code: 'provider_unconfigured' }, 503, cors);
    }

    let generatedResponse: Response;
    try {
      generatedResponse = await adminAuth('/admin/generate_link', {
        method: 'POST',
        body: JSON.stringify({
          type: 'invite', email, data: { staff_profile_id: target.id },
          ...(SITE_URL ? { redirect_to: `${SITE_URL}/staff` } : {}),
        }),
      });
    } catch {
      await audit('staff_invite', 'error', 'invite_link_provider_unavailable');
      return json({ error: 'The sign-in service did not confirm a usable invitation link. The MilkPop staff profile was not marked invited.', code: 'invite_unconfirmed' }, 503, cors);
    }
    if (!generatedResponse.ok) {
      const detail = await generatedResponse.text().catch(() => '');
      console.error('staff invite link rejected', generatedResponse.status, detail.slice(0, 200));
      await audit('staff_invite', 'denied', `invite_link_rejected_${generatedResponse.status}`);
      return json({ error: 'The invitation link could not be created. The MilkPop staff profile was not marked invited.', code: 'invite_failed' }, 502, cors);
    }
    const generated = await generatedResponse.json().catch(() => null) as {
      action_link?: unknown; id?: unknown; user?: { id?: unknown };
      properties?: { action_link?: unknown };
    } | null;
    const actionLink = String(generated?.action_link || generated?.properties?.action_link || '');
    const authId = String(generated?.id || generated?.user?.id || (lookup.kind === 'found' ? lookup.user.id : ''));
    if (!authId || !/^https:\/\//i.test(actionLink) || actionLink.length > 4096) {
      await audit('staff_invite', 'error', 'invite_link_response_incomplete');
      return json({ error: 'The sign-in service did not return a usable invitation link. The MilkPop staff profile was not marked invited.', code: 'invite_unconfirmed' }, 502, cors);
    }

    const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char] || char));
    const employeeName = escapeHtml(String(target.name || 'team member').slice(0, 120));
    const safeLink = escapeHtml(actionLink);
    const brand = 'Milk Pop';
    const html = `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#1f2937"><h2>Welcome to ${brand}</h2><p>Hello ${employeeName},</p><p>Your staff account is ready to set up.</p><p><a href="${safeLink}" style="display:inline-block;padding:12px 18px;background:#111827;color:#fff;text-decoration:none;border-radius:8px">Set up your staff account</a></p><p>If you were not expecting this invitation, you can ignore this e-mail.</p></div>`;
    const linkDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(actionLink))))
      .map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);

    try {
      const { response: sent, data: providerBody, text: providerText } = await fetchProviderJson<{ id?: unknown }>(
        'https://api.resend.com/emails',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json',
            'Idempotency-Key': `milkpop-staff-invite-${authId}-${linkDigest}`.slice(0, 240),
          },
          body: JSON.stringify({ from: `Milk Pop <${EMAIL_FROM}>`, to: [email], subject: 'Set up your Milk Pop staff account', html }),
        },
        EXTERNAL_PROVIDER_TIMEOUT_MS.email,
      );
      if (!sent.ok) {
        console.error('staff invite e-mail rejected', sent.status, providerText.slice(0, 200));
        await audit('staff_invite', 'denied', `invite_email_rejected_${sent.status}`);
        return json({ error: 'The invitation e-mail provider rejected the message. The MilkPop staff profile was not marked invited; an unused Auth invitation link may exist.', code: 'invite_failed' }, 502, cors);
      }
      const invitedAt = new Date().toISOString();
      const updated = await patchProfile({ auth_id: authId, onboarding: 'invited', invited_at: invitedAt });
      if (!updated) {
        await audit('staff_invite', 'error', 'profile_update_failed_after_invite_sent');
        return json({
          error: 'The invitation e-mail was accepted, but the staff profile could not be updated.', code: 'reconciliation_required',
          providerAccepted: true, providerId: providerBody?.id ? String(providerBody.id) : null,
          authId, invitedAt, emailSent: true, reconciliationRequired: true,
        }, 502, cors);
      }
      const outcome = lookup.kind === 'found' ? 'invitation_resent' : 'invitation_sent';
      const auditRecorded = await audit('staff_invite', 'granted', `${outcome}${providerBody?.id ? '_provider_confirmed' : ''}`);
      return json({ ok: true, outcome, onboarding: 'invited', invitedAt, emailSent: true, auditRecorded, reconciliationRequired: !auditRecorded }, 200, cors);
    } catch (error) {
      const timedOut = error instanceof ProviderTimeoutError;
      await audit('staff_invite', 'error', timedOut ? 'invite_email_delivery_unconfirmed_timeout' : 'invite_email_delivery_unconfirmed_transport');
      return json({
        error: 'Invitation delivery was not confirmed. Check the provider activity before retrying.',
        code: 'delivery_unconfirmed', reconciliationRequired: true,
      }, timedOut ? 504 : 502, cors);
    }
  }

  const lookup = target.auth_id ? await findById(String(target.auth_id)) : await findByEmail(email);
  if (lookup.kind === 'unavailable') {
    await audit('staff_refresh', 'error', 'auth_lookup_unavailable');
    return json({ error: 'The sign-in service could not confirm this account. The MilkPop staff profile was left unchanged.', code: 'auth_truth_unavailable' }, 503, cors);
  }
  if (lookup.kind === 'not_found') {
    if (target.auth_id || target.invited_at || target.onboarding === 'invited' || target.onboarding === 'active') {
      await audit('staff_refresh', 'error', 'previously_linked_auth_user_missing');
      return json({ error: 'The linked sign-in account could not be found. The profile was left unchanged for reconciliation.', code: 'reconciliation_required', reconciliationRequired: true }, 409, cors);
    }
    const auditRecorded = await audit('staff_refresh', 'granted', 'no_auth_account');
    return json({ ok: true, outcome: 'no_auth_account', onboarding: 'profile_created', invitedAt: null, auditRecorded, reconciliationRequired: !auditRecorded }, 200, cors);
  }

  const onboarding: OnboardingStatus = lookup.user.last_sign_in_at ? 'active' : 'invited';
  const fields: Record<string, unknown> = { auth_id: lookup.user.id, onboarding };
  if (onboarding === 'invited' && !target.invited_at) fields.invited_at = new Date().toISOString();
  const updated = await patchProfile(fields);
  if (!updated) {
    await audit('staff_refresh', 'error', 'profile_update_failed_after_auth_confirmed');
    return json({ error: 'The sign-in state was confirmed, but the staff profile could not be updated.', code: 'reconciliation_required', reconciliationRequired: true }, 502, cors);
  }
  const invitedAt = updated.invited_at ?? target.invited_at ?? null;
  const auditRecorded = await audit('staff_refresh', 'granted', onboarding);
  return json({ ok: true, outcome: 'refreshed', onboarding, invitedAt, emailSent: false, auditRecorded, reconciliationRequired: !auditRecorded }, 200, cors);
});
