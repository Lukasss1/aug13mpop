// ============================================================================
//  MILK POP — R4.8 environment guards (Workstream D)
//
//  Explicit production state; no implicit "secret missing → CAPTCHA off".
//  Pure core + Deno wrapper, mirroring _shared/cors.ts, so the Node contract
//  suite (scripts/r48-turnstile-config.test.mjs) runs the shipped logic.
// ============================================================================

export type TurnstileGate =
  | { mode: 'enforce'; secret: string }        // enabled + secret present
  | { mode: 'off' }                             // explicitly disabled (dev)
  | { mode: 'refuse'; reason: string };         // fail closed

/** Pure decision from an env snapshot. */
export function decideTurnstile(env: Record<string, string | undefined>): TurnstileGate {
  const isProd = (env['APP_ENV'] || '').trim() === 'production';
  const enabled = (env['TURNSTILE_SERVER_ENABLED'] || '').trim() === 'true';
  const secret = (env['TURNSTILE_SECRET'] || '').trim();
  if (enabled) {
    if (!secret) return { mode: 'refuse', reason: 'turnstile_enabled_without_secret' };
    return { mode: 'enforce', secret };
  }
  // Not enabled. In production a silent off is only acceptable when it is
  // EXPLICIT: TURNSTILE_SERVER_ENABLED must be present and 'false'.
  if (isProd && (env['TURNSTILE_SERVER_ENABLED'] || '').trim() !== 'false') {
    return { mode: 'refuse', reason: 'turnstile_state_undeclared_in_production' };
  }
  return { mode: 'off' };
}

export function turnstileGate(): TurnstileGate {
  const env: Record<string, string | undefined> = {
    APP_ENV: Deno.env.get('APP_ENV') ?? undefined,
    TURNSTILE_SERVER_ENABLED: Deno.env.get('TURNSTILE_SERVER_ENABLED') ?? undefined,
    TURNSTILE_SECRET: Deno.env.get('TURNSTILE_SECRET') ?? undefined,
  };
  return decideTurnstile(env);
}
