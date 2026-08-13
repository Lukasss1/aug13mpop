// ============================================================================
//  MILK POP — pos-ingest Edge Function  (integration plan Gate 5; contract §3)
//
//  The ONLY write path for till events. The device authenticates with its
//  bearer token, which exists server-side purely as a SHA-256 hash: the raw
//  token is hashed HERE and only the hash reaches SQL (never statement logs,
//  never a table). pos_authenticate_device also completes token rotation —
//  presenting the pending hash promotes it — and returns revoked devices so
//  they can be refused with 401 (mandatory test #5).
//
//  The batch itself is applied by pos_ingest_batch: one RPC call = one
//  Postgres transaction, one savepoint per event, so a rejected event never
//  drags its batch-mates down (test #4) and replays converge (tests #2/#12).
//  This function re-verifies the ack ∪ reject partition before answering —
//  the same invariant the till checks — so a broken response can never look
//  like success.
//
//  HTTP mapping (frozen in the contract): 200 ack · 401 bad/revoked token ·
//  400 malformed envelope · 413 batch over 50 · 5xx server trouble.
//
//  Deploy WITHOUT "Verify JWT" — the till has no Supabase JWT; the device
//  token is the credential, validated by hash inside this function.
// ============================================================================

import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';
import { MAX_EVENTS_PER_BATCH } from '../_shared/posContract.ts';
import { readBoundedJson, requestBodyResponse } from '../_shared/request.ts';

// R4.8 (Workstream E): delegate to the shared FAIL-CLOSED builder. Production
// requires an exact-origin allow-list; untrusted origins get 'null', never '*'
// and never "first allowed origin". See _shared/cors.ts.
function corsHeaders(origin: string | null): Record<string, string> {
  return buildCorsHeaders(origin, ["CV_ALLOWED_ORIGINS","FORM_ALLOWED_ORIGINS"], 'POST, OPTIONS');
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

async function sha256hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

interface WireEvent { id: string; eventType: string; entityId: string; createdAt: string; payload: Record<string, unknown> }

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, cors);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!SUPABASE_URL || !SERVICE) return json({ error: 'Server is not configured.' }, 500, cors);
  const baseUrl = SUPABASE_URL.replace(/\/$/, '');

  const svc = (path: string, init: RequestInit = {}) =>
    fetchInternal(`${baseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> || {}),
      },
    });

  // --- 1. Device token → hash → device row ---------------------------------
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || token.length < 16) return json({ error: 'Unauthorized.' }, 401, cors);

  let device: { id?: string; revoked?: boolean } | null = null;
  try {
    const r = await svc('rpc/pos_authenticate_device', {
      method: 'POST',
      body: JSON.stringify({ p_token_hash: await sha256hex(token) }),
    });
    if (!r.ok) {
      console.error('pos_authenticate_device failed', r.status);
      return json({ error: 'Sync is temporarily unavailable.' }, 502, cors);
    }
    device = await r.json().catch(() => null);
  } catch {
    return json({ error: 'Sync is temporarily unavailable.' }, 502, cors);
  }
  if (!device || typeof device.id !== 'string' || device.revoked === true) {
    // Unknown OR revoked token: nothing applied server-side; the till pauses
    // and asks for a re-pair. Deliberately indistinguishable.
    return json({ error: 'Unauthorized.' }, 401, cors);
  }

  // --- 2. Envelope guard (contract §3.1) ------------------------------------
  let input: { device?: unknown; events?: unknown };
  try { input = await readBoundedJson(req, MAX_REQUEST_BYTES) as typeof input; } catch (error) {
    const failure = requestBodyResponse(error);
    return json(failure.body, failure.status, cors);
  }
  const events = Array.isArray(input?.events) ? input.events as WireEvent[] : null;
  if (!events || events.length === 0) return json({ error: 'events must be a non-empty array.' }, 400, cors);
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return json({ error: `Batches are limited to ${MAX_EVENTS_PER_BATCH} events.` }, 413, cors);
  }
  const ids = new Set<string>();
  for (const e of events) {
    if (!e || typeof e !== 'object'
      || typeof e.id !== 'string' || !e.id
      || typeof e.eventType !== 'string' || !e.eventType
      || typeof e.entityId !== 'string' || !e.entityId
      || typeof e.createdAt !== 'string' || Number.isNaN(Date.parse(e.createdAt))
      || !e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) {
      return json({ error: 'Malformed event envelope.' }, 400, cors);
    }
    if (ids.has(e.id)) return json({ error: 'Duplicate event id inside one batch.' }, 400, cors);
    ids.add(e.id);
  }

  // --- 3. Transactional apply (one RPC = one transaction) ------------------
  let ack: { acknowledgedIds?: unknown; rejectedIds?: unknown; rejections?: unknown } | null = null;
  try {
    const r = await svc('rpc/pos_ingest_batch', {
      method: 'POST',
      body: JSON.stringify({ p_device_id: device.id, p_events: events }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('pos_ingest_batch failed', r.status, detail.slice(0, 200));
      return json({ error: 'Sync is temporarily unavailable.' }, 502, cors);
    }
    ack = await r.json().catch(() => null);
  } catch {
    return json({ error: 'Sync is temporarily unavailable.' }, 502, cors);
  }

  // --- 4. Partition invariant, verified server-side too --------------------
  const acked = Array.isArray(ack?.acknowledgedIds) ? ack!.acknowledgedIds as string[] : null;
  const rejectedIds = Array.isArray(ack?.rejectedIds) ? ack!.rejectedIds as string[] : null;
  if (!acked || !rejectedIds) {
    console.error('pos_ingest_batch returned a malformed ack');
    return json({ error: 'Sync is temporarily unavailable.' }, 502, cors);
  }
  const seen = new Set<string>();
  for (const id of [...acked, ...rejectedIds]) {
    if (!ids.has(id) || seen.has(id)) {
      console.error('pos_ingest_batch broke the partition invariant');
      return json({ error: 'Sync is temporarily unavailable.' }, 502, cors);
    }
    seen.add(id);
  }
  if (seen.size !== ids.size) {
    console.error('pos_ingest_batch did not account for every event');
    return json({ error: 'Sync is temporarily unavailable.' }, 502, cors);
  }

  const catalogVersion = (ack as { catalogVersion?: unknown }).catalogVersion;
  return json({
    acknowledgedIds: acked,
    rejectedIds,
    rejections: Array.isArray(ack?.rejections) ? ack!.rejections : [],
    ...(typeof catalogVersion === 'number' ? { catalogVersion } : {}),
  }, 200, cors);
});
