// ============================================================================
//  MILK POP — shared CORS builder, R4.8 FAIL-CLOSED revision (Workstream E)
//
//  One implementation for every Edge Function. R4.8 behaviour:
//
//    development (APP_ENV != 'production'):
//      • no allow-list configured → '*' (unchanged dev ergonomics)
//      • allow-list configured    → exact-match echo, else 'null' (denied)
//    production (APP_ENV === 'production'):
//      • an allow-list is REQUIRED. Missing/empty configuration is a
//        deployment fault: every response carries Access-Control-Allow-Origin
//        'null' and X-MP-Cors: 'misconfigured' so the browser is blocked AND
//        the fault is observable. scripts/validate-deployment-env.mjs refuses
//        the deploy before it gets this far.
//      • trusted origin → echoed exactly. Untrusted/missing Origin → 'null'.
//      • never '*', never "pin to the first allowed origin" for strangers.
//
//  Documented non-browser clients (native POS) send no Origin header and are
//  authenticated by their own device credentials — CORS is a browser control
//  and does not gate them; see docs/NATIVE-TILL-BOUNDARY.md.
//
//  The decision core is a PURE function of (origin, env-snapshot) so the Node
//  contract suite (scripts/r48-cors.test.mjs) exercises the exact shipped
//  logic without a Deno runtime. The Deno wrapper only supplies env access.
// ============================================================================

export interface CorsDecision {
  allowOrigin: string;              // exact origin, '*', or 'null'
  misconfigured: boolean;           // production with no allow-list
  trusted: boolean;                 // origin matched the allow-list exactly
}

/** Pure core — no Deno/global access. `env` is a plain name→value snapshot. */
export function decideCors(
  origin: string | null,
  envVars: string[],
  env: Record<string, string | undefined>,
): CorsDecision {
  const isProd = (env['APP_ENV'] || '').trim() === 'production';
  let allowed: string[] = [];
  for (const name of envVars) {
    allowed = (env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed.length) break;
  }
  const trusted = !!origin && allowed.includes(origin);
  if (isProd) {
    if (!allowed.length) return { allowOrigin: 'null', misconfigured: true, trusted: false };
    return { allowOrigin: trusted ? (origin as string) : 'null', misconfigured: false, trusted };
  }
  if (!allowed.length) return { allowOrigin: '*', misconfigured: false, trusted: false };
  return { allowOrigin: trusted ? (origin as string) : 'null', misconfigured: false, trusted };
}

export function corsHeadersFromDecision(
  d: CorsDecision,
  methods = 'POST, OPTIONS',
): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Origin': d.allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
    'Access-Control-Allow-Methods': methods,
    'Vary': 'Origin',
  };
  if (d.misconfigured) h['X-MP-Cors'] = 'misconfigured';
  return h;
}

/** Deno-facing entry point — same signature every function already calls. */
export function buildCorsHeaders(
  origin: string | null,
  envVars: string[],
  methods = 'POST, OPTIONS',
): Record<string, string> {
  const names = ['APP_ENV', ...envVars];
  const env: Record<string, string | undefined> = {};
  for (const n of names) env[n] = Deno.env.get(n) ?? undefined;
  return corsHeadersFromDecision(decideCors(origin, envVars, env), methods);
}
