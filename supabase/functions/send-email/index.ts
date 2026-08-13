// ============================================================================
//  MILK POP — send-email Edge Function  (Block C / requirement C1)
//
//  SECURE REBUILD of the function that was previously an open relay. It now
//  enforces, on the SERVER, every control listed in the security notes in README.md → 3:
//
//    1. Caller authentication — a verified staff JWT. The request must carry a
//       real Supabase Auth *user* access token (Authorization: Bearer …). The
//       public anon key is rejected outright, and the caller must map to a
//       linked staff_profiles row; their ROLE is read from the database, never
//       trusted from the client.
//    2. Recipient allow-listing — the client never sends an address. It names a
//       DB row (a staff member, or the specific application / contact / franchise
//       enquiry being answered) and the SERVER resolves the address from that
//       row using the service-role key. Arbitrary recipients are impossible.
//    3. Server-side templates — the client sends a template id + structured
//       params. All HTML is built here from ./templates.ts; raw client HTML is
//       never accepted.
//    4. Rate limits + audit — per-caller and per-recipient hourly limits. Every
//       provider attempt has a durable reserved email_log row before delivery.
//    5. Secrets stay in Edge Function env. RESEND_API_KEY / EMAIL_FROM are set
//       by the operator; SUPABASE_URL / SUPABASE_ANON_KEY /
//       SUPABASE_SERVICE_ROLE_KEY are injected automatically by the platform.
//
//  The service-role key is used ONLY inside this trusted server context (to
//  resolve recipients, enforce role, and write the audit log). It never leaves
//  the function and never appears in the client bundle.
//
//  Deploy WITH "Verify JWT" enabled: callers now present a real user token, so
//  the gateway can reject tokenless requests before this code even runs. The
//  in-function checks below are authoritative regardless of that toggle.
// ============================================================================

import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';
import { EXTERNAL_PROVIDER_TIMEOUT_MS, ProviderTimeoutError, fetchProviderJson } from '../_shared/providerFetch.ts';
import { jwtHasAal2 } from '../_shared/jwt.ts';
import { readBoundedJson, requestBodyResponse } from '../_shared/request.ts';
import {
  TEMPLATES,
  RECIPIENT_SOURCES,
  roleAtLeast,
  isValidEmail,
  oneLine,
} from './templates.ts';

// Hourly caps. Deliberately generous for legitimate staff use; the real spam
// defence is the auth + allow-list above. Tune here if operations need more.
const RATE_CALLER_PER_HOUR = 60;
const RATE_RECIPIENT_PER_HOUR = 10;

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const MAX_REQUEST_BYTES = 32 * 1024;

// R4.8 (Workstream E): delegate to the shared FAIL-CLOSED builder. Production
// requires an exact-origin allow-list; untrusted origins get 'null', never '*'
// and never "first allowed origin". See _shared/cors.ts.
function corsHeaders(origin: string | null): Record<string, string> {
  return buildCorsHeaders(origin, ["EMAIL_ALLOWED_ORIGINS"], 'POST, OPTIONS');
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

  // --- Environment (platform-injected + operator secrets) -------------------
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const ANON = Deno.env.get('SUPABASE_ANON_KEY');
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const RESEND = Deno.env.get('RESEND_API_KEY');
  const EMAIL_FROM = Deno.env.get('EMAIL_FROM') || 'onboarding@resend.dev';
  if (!SUPABASE_URL || !ANON || !SERVICE) return json({ error: 'Server is not configured.' }, 500, cors);
  if (!RESEND) return json({ error: 'E-mail provider is not configured.' }, 500, cors);
  const base = SUPABASE_URL.replace(/\/$/, '');

  // --- 1. AUTHENTICATION: verified staff USER token, never the anon key -----
  const authz = req.headers.get('authorization') || '';
  const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : '';
  // Reject a missing token or the public anon key posing as identity.
  if (!token || token === ANON) return json({ error: 'Authentication required.' }, 401, cors);
  // Privileged e-mail actions require an MFA session. Claims are decoded in
  // one shared helper after the token is verified through Supabase Auth.
  const callerAal2 = jwtHasAal2(token);

  let userRes: Response;
  try {
    userRes = await fetchInternal(`${base}/auth/v1/user`, {
      headers: { apikey: ANON, Authorization: `Bearer ${token}` },
    });
  } catch {
    return json({ error: 'Authentication could not be verified.' }, 503, cors);
  }
  if (!userRes.ok) return json({ error: 'Authentication required.' }, 401, cors);
  const user = await userRes.json().catch(() => null);
  const uid: string | undefined = user?.id;
  if (!uid) return json({ error: 'Authentication required.' }, 401, cors);

  // Service-role REST helper — trusted server context ONLY. Bypasses RLS so we
  // can resolve any recipient and write the audit log. Never exposed to clients.
  const svc = (path: string, init: RequestInit = {}) =>
    fetchInternal(`${base}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> || {}),
      },
    });

  // The caller must be a LINKED staff member; role/name/email come from the DB.
  const callerRes = await svc(
    `staff_profiles?auth_id=eq.${encodeURIComponent(uid)}&select=id,name,email,role,store_name,status,ended_at&limit=1`,
  );
  if (!callerRes.ok) return json({ error: 'Could not verify staff profile.' }, 500, cors);
  const callerRows = await callerRes.json().catch(() => []);
  const caller = Array.isArray(callerRows) ? callerRows[0] : null;
  if (!caller) return json({ error: 'No staff profile is linked to this account.' }, 403, cors);
  // Stage 2.1 F3: a disabled account has no send rights at all.
  if (String(caller.status || 'active') === 'disabled' || caller.ended_at) {
    return json({ error: 'This account is not active.' }, 403, cors);
  }

  // --- 2. Parse + validate the request against the template catalogue -------
  let input: Record<string, unknown>;
  try { input = await readBoundedJson(req, MAX_REQUEST_BYTES); } catch (error) {
    const failure = requestBodyResponse(error);
    return json(failure.body, failure.status, cors);
  }

  const templateId = String(input?.templateId || '');
  const tpl = TEMPLATES[templateId];
  if (!tpl) return json({ error: 'Unknown template.' }, 400, cors);

  // Least-privilege: this caller's role must meet the template's minimum.
  if (!roleAtLeast(String(caller.role), tpl.minRole)) {
    return json({ error: 'You are not authorised to send this e-mail.' }, 403, cors);
  }
  // Stage 2.1 F3: every template that targets someone OTHER than the caller is a
  // privileged action and requires an MFA (aal2) session. 'self' notifications
  // (a staff member e-mailing their own address) stay available at aal1.
  if (tpl.recipientKind !== 'self' && !callerAal2) {
    return json({ error: 'This action requires a fully verified (MFA) session.' }, 403, cors);
  }

  const recipientReq = (input?.recipient || {}) as { kind?: string; id?: string };
  if (String(recipientReq.kind || '') !== tpl.recipientKind) {
    return json({ error: 'Recipient does not match the template.' }, 400, cors);
  }

  // --- 3. RECIPIENT ALLOW-LISTING: resolve the address from a DB row --------
  let recipientEmail = '';
  let recipientName = '';
  let recipientRef: string | null = null;

  if (tpl.recipientKind === 'self') {
    recipientEmail = String(caller.email || '');
    recipientName = String(caller.name || '');
    recipientRef = String(caller.id || '');
  } else {
    const src = RECIPIENT_SOURCES[tpl.recipientKind];
    const id = String(recipientReq.id || '');
    if (!id) return json({ error: 'Recipient id is missing.' }, 400, cors);
    // Stage 2.1 F3: application recipients carry a store; a manager may only
    // e-mail candidates for their own store. (contact/franchise are owner-only
    // by minRole above; staff recipients are governed by roleAtLeast.)
    // Stage 2.1 CF4: 'staff' recipients are resolved with the service role, so a
    // manager targeting staff must be re-scoped (same store, lower role, active).
    const extraCol = tpl.recipientKind === 'application' ? ',applied_store'
      : tpl.recipientKind === 'staff' ? ',role,store_name,status,ended_at' : '';
    const rowRes = await svc(
      `${src.table}?id=eq.${encodeURIComponent(id)}&select=id,email,${src.nameCol}${extraCol}&limit=1`,
    );
    if (!rowRes.ok) return json({ error: 'Recipient lookup failed.' }, 500, cors);
    const rows = await rowRes.json().catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return json({ error: 'Recipient not found.' }, 404, cors);
    if (tpl.recipientKind === 'application' && String(caller.role) !== 'owner') {
      const appStore = String(row.applied_store || '');
      if (!appStore || appStore !== String(caller.store_name || '')) {
        return json({ error: 'You are not authorised to e-mail this applicant.' }, 403, cors);
      }
    }
    // Staff notifications are only delivered to a currently active employment
    // record. Managers are additionally limited to lower-role staff in their
    // own store; owners may target any active staff member.
    if (tpl.recipientKind === 'staff') {
      const tStore = String(row.store_name || '');
      const tRole = String(row.role || '');
      const tStatus = String(row.status || 'active');
      if (tStatus === 'disabled' || row.ended_at) {
        return json({ error: 'This staff profile is not active.' }, 409, cors);
      }
      if (String(caller.role) !== 'owner'
          && (tStore !== String(caller.store_name || '')
              || !['team_member', 'supervisor'].includes(tRole))) {
        return json({ error: 'You are not authorised to e-mail this staff member.' }, 403, cors);
      }
    }
    recipientEmail = String(row.email || '');
    recipientName = String(row[src.nameCol] || '');
    recipientRef = id;
  }
  if (!isValidEmail(recipientEmail)) return json({ error: 'Recipient address is invalid.' }, 422, cors);

  // --- 4. RENDER the server-side template (client HTML is never used) -------
  const brand = String(input?.brand || 'Milk Pop').slice(0, 60);
  const params = (input?.params || {}) as Record<string, unknown>;
  const rendered = tpl.render({ brand, recipientName, params });
  const subject = rendered.subject;
  const html = rendered.html;

  // Atomically reserve the caller/recipient rate budget and the durable audit
  // row before contacting the provider. If reservation cannot be confirmed, no
  // e-mail is sent.
  let logId = '';
  try {
    // The reservation RPC is service-role only. This Edge Function has already
    // verified the user, staff state, MFA, template role and recipient scope;
    // exposing the reservation primitive directly to browsers would allow
    // forged audit rows and deliberate rate-budget exhaustion.
    const reserve = await svc('rpc/reserve_email_send', {
      method: 'POST',
      body: JSON.stringify({
        p_actor_auth_id: uid,
        p_template_id: templateId,
        p_recipient_kind: tpl.recipientKind,
        p_recipient_ref: recipientRef,
        p_recipient_email: recipientEmail,
        p_subject: subject,
        p_caller_limit: RATE_CALLER_PER_HOUR,
        p_recipient_limit: RATE_RECIPIENT_PER_HOUR,
      }),
    });
    if (!reserve.ok) return json({ error: 'E-mail sending is temporarily unavailable.' }, 503, cors);
    const result = await reserve.json().catch(() => null) as { ok?: boolean; error?: string; logId?: string } | null;
    if (result?.ok !== true) {
      if (result?.error === 'rate_limited_caller') return json({ error: 'E-mail rate limit reached for your account. Please try again later.' }, 429, cors);
      if (result?.error === 'rate_limited_recipient') return json({ error: 'This recipient has received too many e-mails recently. Please try again later.' }, 429, cors);
      return json({ error: 'E-mail sending is temporarily unavailable.' }, 503, cors);
    }
    logId = String(result.logId || '');
    if (!logId) return json({ error: 'E-mail sending is temporarily unavailable.' }, 503, cors);
  } catch {
    return json({ error: 'E-mail sending is temporarily unavailable.' }, 503, cors);
  }

  const patchLog = async (patch: Record<string, unknown>): Promise<boolean> => {
    try {
      const response = await svc(`email_log?id=eq.${encodeURIComponent(logId)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      return response.ok;
    } catch { return false; }
  };

  // Sanitise the display name in "Name <address>" to block header injection.
  const fromName = oneLine(String(input?.fromName || brand)).replace(/[<>"]/g, '').slice(0, 60) || brand;

  try {
    const { response: send, data: okBody, text: detail } = await fetchProviderJson<{ id?: unknown }>(
      RESEND_ENDPOINT,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json', 'Idempotency-Key': `milkpop-direct-${logId}` },
        body: JSON.stringify({ from: `${fromName} <${EMAIL_FROM}>`, to: [recipientEmail], subject, html }),
      },
      EXTERNAL_PROVIDER_TIMEOUT_MS.email,
    );
    if (!send.ok) {
      console.error('Resend rejected', send.status, detail.slice(0, 300));  // detail stays server-side
      const recorded = await patchLog({ status: 'provider_error', reject_reason: `provider_${send.status}` });
      return json({ error: 'The e-mail provider rejected the message.', reconciliationRequired: !recorded }, 502, cors);
    }
    const recorded = await patchLog({ status: 'sent', provider_id: okBody?.id ? String(okBody.id) : null });
    if (!recorded) {
      return json({ error: 'The e-mail was accepted by the provider, but its audit record could not be finalised.', code: 'reconciliation_required', providerAccepted: true, reconciliationRequired: true }, 502, cors);
    }
    return json({ ok: true, logId }, 200, cors);
  } catch (e) {
    const timedOut = e instanceof ProviderTimeoutError;
    console.error(timedOut ? 'Resend delivery unconfirmed after timeout' : 'Resend delivery unconfirmed after transport failure', String((e as { message?: string })?.message || e));
    const recorded = await patchLog({
      status: 'provider_error',
      reject_reason: timedOut ? 'delivery_unconfirmed_timeout' : 'delivery_unconfirmed_network',
    });
    return json({
      error: 'E-mail delivery was not confirmed. Check the e-mail log before retrying.',
      code: 'delivery_unconfirmed',
      logId,
      reconciliationRequired: !recorded,
    }, timedOut ? 504 : 502, cors);
  }
});
