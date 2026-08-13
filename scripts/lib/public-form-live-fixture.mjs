import { randomUUID } from 'node:crypto';

const jsonHeaders = (key) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
});

export async function getCurrentPrivacyNotice(baseUrl, anonKey, audience = 'contact') {
  const params = new URLSearchParams({
    select: 'id,content_sha256',
    audience: `eq.${audience}`,
    limit: '1',
  });
  const res = await fetch(`${baseUrl}/rest/v1/privacy_notice_current?${params.toString()}`, {
    headers: jsonHeaders(anonKey),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`privacy_notice_current lookup failed: HTTP ${res.status} ${text.slice(0, 160)}`);
  }
  let rows;
  try { rows = text ? JSON.parse(text) : []; } catch { rows = []; }
  const row = Array.isArray(rows) ? rows[0] : null;
  const id = typeof row?.id === 'string' ? row.id.trim() : '';
  const sha = typeof row?.content_sha256 === 'string' ? row.content_sha256.trim().toLowerCase() : '';
  if (!id || !/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error(`no published ${audience} privacy notice is available; publish it before live public-form verification`);
  }
  return { id, sha256: sha };
}

export function buildContactProbe(notice, label = 'production-live-probe') {
  const nonce = randomUUID();
  return {
    kind: 'contact',
    noticeId: notice.id,
    noticeSha256: notice.sha256,
    idempotencyKey: nonce,
    row: {
      full_name: 'Milk Pop deployment probe',
      email: `milkpop-probe+${nonce}@example.invalid`,
      reason: 'Other',
      message: `Synthetic ${label}; created only to verify the deployed public-form path.`,
    },
  };
}

async function serviceRoleDelete(baseUrl, serviceRoleKey, relationAndFilter, label) {
  const res = await fetch(`${baseUrl}/rest/v1/${relationAndFilter}`, {
    method: 'DELETE',
    headers: {
      ...jsonHeaders(serviceRoleKey),
      Prefer: 'return=minimal',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${label} failed: HTTP ${res.status} ${text.slice(0, 160)}`);
  }
}

export async function deleteSyntheticContact(baseUrl, serviceRoleKey, submissionId) {
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required to clean synthetic public-form probes');
  if (!submissionId) return;

  const encodedId = encodeURIComponent(submissionId);

  // submit_public_form enqueues owner/customer notification jobs in the same
  // transaction as the contact row. Remove those jobs first so a successful
  // deployment probe cannot later send synthetic e-mail via the scheduler.
  await serviceRoleDelete(
    baseUrl,
    serviceRoleKey,
    `notification_outbox?entity_type=eq.contact&entity_id=eq.${encodedId}`,
    'synthetic contact outbox cleanup',
  );

  await serviceRoleDelete(
    baseUrl,
    serviceRoleKey,
    `contact_messages?id=eq.${encodedId}`,
    'synthetic contact cleanup',
  );
}
