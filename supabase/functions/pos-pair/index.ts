// ============================================================================
// MILK POP — POS pairing perimeter (T13.3.19)
//
// Deploy WITHOUT Verify JWT. The one-time code is the credential. The Edge
// Function bounds and normalises anonymous input; one SQL transaction reserves
// the rate budget, consumes the code and creates the device.
// ============================================================================
import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';
import { hmacIp } from '../_shared/ip.ts';
import { readBoundedJson, requestBodyResponse } from '../_shared/request.ts';

const RATE_IP_PER_HOUR = 10;
const MAX_REQUEST_BYTES = 32 * 1024;

function corsHeaders(origin: string | null): Record<string, string> {
  return buildCorsHeaders(origin, ['CV_ALLOWED_ORIGINS', 'FORM_ALLOWED_ORIGINS'], 'POST, OPTIONS');
}
function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
async function sha256hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
function boundedText(value: unknown, max: number): string | null {
  const text = String(value ?? '').trim();
  return text.length <= max ? text : null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, cors);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const ABUSE_SECRET = Deno.env.get('ABUSE_HMAC_SECRET') || SERVICE;
  if (!SUPABASE_URL || !SERVICE || !ABUSE_SECRET) return json({ error: 'Server is not configured.' }, 500, cors);
  const baseUrl = SUPABASE_URL.replace(/\/$/, '');

  let input: Record<string, unknown>;
  try { input = await readBoundedJson(req, MAX_REQUEST_BYTES); }
  catch (error) {
    const failure = requestBodyResponse(error);
    return json(failure.body, failure.status, cors);
  }

  const code = boundedText(input.code, 8)?.toUpperCase() ?? '';
  const installationId = boundedText(input.installationId, 128);
  const rawDevice = input.deviceInfo && typeof input.deviceInfo === 'object' && !Array.isArray(input.deviceInfo)
    ? input.deviceInfo as Record<string, unknown> : {};
  const deviceName = boundedText(rawDevice.deviceName, 120);
  const deviceCode = boundedText(rawDevice.deviceCode, 64);
  const storeCode = boundedText(rawDevice.storeCode, 64);
  const appVersion = boundedText(rawDevice.appVersion, 64);
  const schemaRaw = rawDevice.schemaVersion == null || rawDevice.schemaVersion === '' ? 0 : Number(rawDevice.schemaVersion);
  const schemaVersion = Number.isSafeInteger(schemaRaw) && schemaRaw >= 0 && schemaRaw <= 100000 ? schemaRaw : null;

  if (!/^[A-Z0-9]{8}$/.test(code) || !installationId || deviceName == null || deviceCode == null ||
      storeCode == null || appVersion == null || schemaVersion == null) {
    return json({ error: 'That pairing request was not accepted.' }, 400, cors);
  }

  const ipHash = await hmacIp(req, ABUSE_SECRET, 'pos-pair:v1');
  const codeHash = await sha256hex(code);
  let response: Response;
  try {
    response = await fetchInternal(`${baseUrl}/rest/v1/rpc/pos_pair_attempt`, {
      method: 'POST',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_ip_hash: ipHash,
        p_code_hash: codeHash,
        p_installation_id: installationId,
        p_device: { deviceName, deviceCode, storeCode, appVersion, schemaVersion },
        p_limit: RATE_IP_PER_HOUR,
      }),
    });
  } catch {
    return json({ error: 'Pairing is temporarily unavailable. Please try again.' }, 503, cors);
  }
  if (!response.ok) {
    console.error('pos_pair_attempt failed', response.status);
    return json({ error: 'Pairing is temporarily unavailable. Please try again.' }, 503, cors);
  }

  const result = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!result || typeof result !== 'object') {
    return json({ error: 'Pairing is temporarily unavailable. Please try again.' }, 503, cors);
  }
  if (result.error === 'rate_limited') {
    return json({ error: 'Too many pairing attempts. Please wait and try again.', resetAt: result.resetAt }, 429, cors);
  }
  if (result.error === 'invalid_request') {
    return json({ error: 'That pairing request was not accepted.' }, 400, cors);
  }
  if (result.error === 'code_not_accepted' || result.ok !== true) {
    return json({ error: 'That pairing code was not accepted.' }, 400, cors);
  }

  const pairing = result.pairing as Record<string, unknown> | null;
  if (!pairing || typeof pairing !== 'object' || typeof pairing.deviceToken !== 'string' ||
      !pairing.deviceToken || typeof pairing.deviceId !== 'string' || !pairing.deviceId) {
    return json({ error: 'Pairing is temporarily unavailable. Please try again.' }, 503, cors);
  }
  return json({ deviceId: pairing.deviceId, deviceToken: pairing.deviceToken, store: pairing.store }, 201, cors);
});
