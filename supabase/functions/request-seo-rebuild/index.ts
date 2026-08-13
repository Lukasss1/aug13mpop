// ============================================================================
//  MILK POP — request-seo-rebuild Edge Function (OPT-02-C1.2)
//
//  Records an authorised request to refresh the static SEO snapshot after a
//  public content change. It deliberately does NOT call a hosting build hook:
//  production publication stays inside the signed/protected release pipeline.
//  All the authorisation + handoff logic lives in core.ts (pure,
//  Node-testable); this file only adds CORS + method handling.
//
//  Deploy WITH JWT verification ON (config.toml: verify_jwt = true).
// ============================================================================
import { buildCorsHeaders } from '../_shared/cors.ts';
import { fetchInternal } from '../_shared/internalFetch.ts';
import { handleSeoRebuild } from './core.ts';
import { readBoundedJson, requestBodyResponse } from '../_shared/request.ts';

const MAX_REQUEST_BYTES = 4 * 1024;

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = buildCorsHeaders(req.headers.get('origin'), ['CV_ALLOWED_ORIGINS']);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, cors);

  const authz = req.headers.get('authorization') || '';
  const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : '';

  let input: Record<string, unknown>;
  try {
    input = await readBoundedJson(req, MAX_REQUEST_BYTES);
  } catch (error) {
    const failure = requestBodyResponse(error);
    return json(failure.body, failure.status, cors);
  }

  const result = await handleSeoRebuild(
    token,
    input?.area,
    {
      SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
      SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY'),
      SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    },
    { fetchImpl: fetchInternal },
  );

  return json(result.body, result.status, cors);
});
