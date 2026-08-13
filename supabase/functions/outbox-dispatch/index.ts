// ============================================================================
//  MILK POP — outbox-dispatch Edge Function (R4.8, Workstream C3)
//
//  Scheduled worker that drains notification_outbox. Design:
//    • Invocation is authenticated: only the service role (scheduler) or an
//      owner-triggered manual run may call it; anon/apikey calls are rejected.
//    • Claiming is delegated to outbox_claim_batch() — FOR UPDATE SKIP LOCKED,
//      so two concurrent workers can NEVER take the same job. A claimed job is
//      visibly 'processing'.
//    • Recipients are resolved HERE, server-side: 'owner_notification' →
//      launch_settings.notification_recipient; 'customer_ack' → the stored
//      submission row's own e-mail. The payload never carries an address the
//      browser chose.
//    • Provider = Resend (same provider and secrets as send-email). Provider
//      missing → jobs are marked 'blocked_config' (visible, retryable after
//      configuration) — never silent success, never silent drop.
//    • Verdicts go through outbox_mark(): delivered / retry with exponential
//      backoff / dead_letter after 6 attempts / blocked_config.
//    • Every run writes a record_heartbeat('outbox-dispatch', …) so the admin
//      health panel can distinguish "healthy", "failed" and "never ran".
//    • The customer acknowledgement template states the submission was
//      RECEIVED; it never claims a human has reviewed it (C4).
// ============================================================================

import { EXTERNAL_PROVIDER_TIMEOUT_MS, ProviderTimeoutError, fetchProviderJson } from '../_shared/providerFetch.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

type OutboxRow = {
  id: string; event_type: string; entity_type: string; entity_id: string;
  recipient_kind: 'owner_notification' | 'customer_ack';
  template_id: string; payload: Record<string, unknown>; attempt_count: number;
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!SUPABASE_URL || !SERVICE) return json({ error: 'server_unconfigured' }, 500);

  // ---- authentication: service role only (the scheduler / trusted trigger).
  const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (auth !== SERVICE) return json({ error: 'not_permitted' }, 401);

  const base = SUPABASE_URL.replace(/\/$/, '');
  const svc = (path: string, init: RequestInit = {}) =>
    fetchInternal(`${base}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> || {}),
      },
    });
  const rpc = (name: string, body: unknown) =>
    svc(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });

  const RESEND = (Deno.env.get('RESEND_API_KEY') || '').trim();
  const EMAIL_FROM = (Deno.env.get('EMAIL_FROM') || '').trim();

  let claimed: OutboxRow[] = [];
  try {
    const r = await rpc('outbox_claim_batch', { p_limit: 10 });
    if (!r.ok) throw new Error(`claim_failed_${r.status}`);
    claimed = await r.json();
  } catch (e) {
    await rpc('record_heartbeat', { p_job: 'outbox-dispatch', p_status: 'failed', p_detail: String(e) }).catch(() => {});
    return json({ error: 'claim_failed' }, 500);
  }

  // Resolve the owner recipient once per run — server truth, never payload.
  let ownerRecipient = '';
  let ownerRecipientLookupOk = false;
  try {
    const response = await svc('launch_settings?select=notification_recipient,customer_ack_enabled&id=eq.true');
    if (response.ok) {
      const rows = await response.json().catch(() => []);
      ownerRecipient = (rows?.[0]?.notification_recipient || '').trim();
      ownerRecipientLookupOk = true;
    }
  } catch { /* handled per-job below */ }

  const results: Record<string, string> = {};
  for (const job of claimed) {
    const mark = async (outcome: string, providerId = '', code = '', message = ''): Promise<boolean> => {
      try {
        const response = await rpc('outbox_mark', {
          p_id: job.id, p_outcome: outcome, p_provider_id: providerId, p_code: code, p_message: message,
        });
        return response.ok;
      } catch { return false; }
    };
    const resultAfterMark = (recorded: boolean, confirmed: string): string => recorded ? confirmed : 'reconciliation_required';

    try {
      if (!RESEND || !EMAIL_FROM) {
        const recorded = await mark('blocked_config', '', 'provider_unconfigured', 'RESEND_API_KEY / EMAIL_FROM missing');
        results[job.id] = resultAfterMark(recorded, 'blocked_config');
        continue;
      }

      // ---- server-side recipient resolution ------------------------------
      let to = '';
      if (job.recipient_kind === 'owner_notification') {
        if (!ownerRecipientLookupOk) {
          const recorded = await mark('transient', '', 'recipient_lookup_unavailable', 'launch_settings could not be read');
          results[job.id] = resultAfterMark(recorded, 'retry');
          continue;
        }
        to = ownerRecipient;
        if (!to) {
          const recorded = await mark('blocked_config', '', 'recipient_unconfigured', 'launch_settings.notification_recipient empty');
          results[job.id] = resultAfterMark(recorded, 'blocked_config');
          continue;
        }
      } else {
        const table = job.entity_type === 'careers' ? 'job_applications'
                    : job.entity_type === 'franchise' ? 'franchise_inquiries' : 'contact_messages';
        const recipientResponse = await svc(`${table}?select=email&id=eq.${encodeURIComponent(job.entity_id)}`);
        if (!recipientResponse.ok) {
          const recorded = await mark('transient', '', `recipient_lookup_${recipientResponse.status}`, 'submission row could not be read');
          results[job.id] = resultAfterMark(recorded, 'retry');
          continue;
        }
        const rows = await recipientResponse.json().catch(() => []);
        to = (rows?.[0]?.email || '').trim();
        if (!to) {
          const recorded = await mark('permanent', '', 'recipient_missing', 'submission row has no e-mail');
          results[job.id] = resultAfterMark(recorded, 'dead_letter');
          continue;
        }
      }

      // ---- honest, minimal templates --------------------------------------
      // INC11: candidacy-transition templates (enqueued by
      // transition_application in the SAME transaction as the status change).
      // Same honesty rules as the receipt mail: state what happened, promise
      // nothing the system does not do.
      const kind = String(job.payload?.kind || job.entity_type);
      const role = String(job.payload?.applied_for || 'the role');
      let subject: string;
      let text: string;
      if (job.template_id === 'ops-health-failed') {
        const monitoredJob = String(job.payload?.job || job.entity_id);
        const detail = String(job.payload?.detail || 'No additional detail was recorded.');
        const status = String(job.payload?.status || 'failed');
        subject = `Milk Pop — operational check ${status}: ${monitoredJob}`;
        text = `Milk Pop detected an operational problem with ${monitoredJob}. Status: ${status}. Detail: ${detail}. Open Admin → Advanced → Technical health to review it. This alert is deduplicated until the state changes.`;
      } else if (job.template_id === 'ops-health-recovered') {
        const monitoredJob = String(job.payload?.job || job.entity_id);
        subject = `Milk Pop — operational check recovered: ${monitoredJob}`;
        text = `${monitoredJob} is reporting healthy again. Open Admin → Advanced → Technical health if you need the full history.`;
      } else if (job.template_id === 'application-offer') {
        subject = 'Milk Pop — an offer on your application';
        text = `Good news — we would like to make you an offer for ${role} (application reference ${job.entity_id}). A member of the team will contact you to arrange the details. If anything here looks wrong, just reply to this e-mail.`;
      } else if (job.template_id === 'application-declined') {
        subject = 'Milk Pop — an update on your application';
        text = `Thank you for applying for ${role} (application reference ${job.entity_id}). We will not be taking your application further on this occasion. We appreciate the time you took, and you are welcome to apply for future openings.`;
      } else if (job.recipient_kind === 'owner_notification') {
        subject = `Milk Pop — new ${kind} submission`;
        text = `A new ${kind} submission was recorded (reference ${job.entity_id}). Review it in the admin portal.`;
      } else {
        subject = `Milk Pop — we received your ${kind} submission`;
        text = `Thank you — your ${kind} submission was received and recorded (reference ${job.entity_id}). This is an automatic confirmation of receipt; it does not mean a person has reviewed your submission yet.`;
      }

      const { response: send, data: sj, text: providerText } = await fetchProviderJson<{ id?: unknown }>(
        RESEND_ENDPOINT,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${RESEND}`,
            'Content-Type': 'application/json',
            // Stable across retries of the same claimed outbox row. If the
            // provider accepted a request but our response was lost, the next
            // attempt cannot create a duplicate message.
            'Idempotency-Key': `milkpop-outbox-${job.id}`,
          },
          body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, text }),
        },
        EXTERNAL_PROVIDER_TIMEOUT_MS.email,
      );
      if (send.ok && sj?.id) {
        const recorded = await mark('delivered', String(sj.id));
        results[job.id] = resultAfterMark(recorded, 'delivered');
      } else if (send.status >= 400 && send.status < 500 && send.status !== 429) {
        const recorded = await mark('permanent', '', `provider_${send.status}`, providerText.slice(0, 300));
        results[job.id] = resultAfterMark(recorded, 'dead_letter');
      } else {
        const recorded = await mark('transient', '', `provider_${send.status}`, providerText.slice(0, 300));
        results[job.id] = resultAfterMark(recorded, 'retry');
      }
    } catch (e) {
      const code = e instanceof ProviderTimeoutError ? 'provider_timeout' : 'provider_transport';
      const recorded = await mark('transient', '', code, String(e).slice(0, 300));
      results[job.id] = resultAfterMark(recorded, 'retry');
    }
  }

  const nonDelivered = Object.values(results).filter((outcome) => outcome !== 'delivered');
  const heartbeatStatus = nonDelivered.length > 0 ? 'failed' : 'ok';
  const heartbeatDetail = nonDelivered.length > 0
    ? `claimed=${claimed.length}; non_delivered=${nonDelivered.length}; outcomes=${[...new Set(nonDelivered)].join(',')}`
    : `claimed=${claimed.length}; delivered=${Object.keys(results).length}`;
  const heartbeat = await rpc('record_heartbeat', {
    p_job: 'outbox-dispatch', p_status: heartbeatStatus, p_detail: heartbeatDetail,
  }).catch(() => null);
  const reconciliationRequired = Object.values(results).includes('reconciliation_required') || !heartbeat?.ok;
  console.log(JSON.stringify({ fn: 'outbox-dispatch', claimed: claimed.length, results, heartbeatStatus, heartbeatRecorded: !!heartbeat?.ok }));
  return json({
    ok: !reconciliationRequired,
    claimed: claimed.length,
    results,
    heartbeatRecorded: !!heartbeat?.ok,
    reconciliationRequired,
  }, reconciliationRequired ? 502 : 200);
});
