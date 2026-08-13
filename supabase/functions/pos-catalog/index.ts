// ============================================================================
//  MILK POP — pos-catalog Edge Function  (integration plan Gate 9)
//
//  Tills pull the newest published catalogue here after an ingest ack
//  advertises a version above the one they last applied. Same credential
//  model as pos-ingest: the device bearer token is hashed IN this function
//  and only the hash reaches SQL; revoked or unknown tokens get 401 with
//  nothing revealed. The response is the contract's PosCatalogResponse:
//  { catalogVersion, catalog } — sections optional, absent sections mean
//  "leave the till's untouched".
//
//  Deploy WITHOUT "Verify JWT" — the device token is the credential.
// ============================================================================

import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';

// R4.8 (Workstream E): delegate to the shared FAIL-CLOSED builder. Production
// requires an exact-origin allow-list; untrusted origins get 'null', never '*'
// and never "first allowed origin". See _shared/cors.ts.
function corsHeaders(origin: string | null): Record<string, string> {
  return buildCorsHeaders(origin, ["CV_ALLOWED_ORIGINS","FORM_ALLOWED_ORIGINS"], 'GET, OPTIONS');
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

async function sha256hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405, cors);

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

  // --- Device token → hash → device row (rotation-aware, revoked → 401) ----
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
      return json({ error: 'The catalogue is temporarily unavailable.' }, 502, cors);
    }
    device = await r.json().catch(() => null);
  } catch {
    return json({ error: 'The catalogue is temporarily unavailable.' }, 502, cors);
  }
  if (!device || typeof device.id !== 'string' || device.revoked === true) {
    return json({ error: 'Unauthorized.' }, 401, cors);
  }

  // --- Newest snapshot ------------------------------------------------------
  try {
    const r = await svc('rpc/pos_catalog_current', { method: 'POST', body: '{}' });
    if (!r.ok) {
      console.error('pos_catalog_current failed', r.status);
      return json({ error: 'The catalogue is temporarily unavailable.' }, 502, cors);
    }
    const current = await r.json().catch(() => null) as
      { catalogVersion?: unknown; catalog?: unknown } | null;
    if (!current || typeof current.catalogVersion !== 'number' || !current.catalog) {
      return json({ error: 'No catalogue has been published yet.' }, 404, cors);
    }
    return json({ catalogVersion: current.catalogVersion, catalog: current.catalog }, 200, cors);
  } catch {
    return json({ error: 'The catalogue is temporarily unavailable.' }, 502, cors);
  }
});
