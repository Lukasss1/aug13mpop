// ============================================================================
//  MILK POP — request-seo-rebuild CORE (OPT-02-C1.2)
//
//  Pure, runtime-agnostic authorisation + dispatch logic for the SEO rebuild
//  function. It takes an injected `fetch` and an env bag and returns a plain
//  { status, body } result, so it can be unit-tested in Node (scripts/
//  seo-rebuild.test.ts) without a Deno runtime. index.ts is a thin Deno
//  wrapper that adds CORS + method handling around this.
//
//  Contract:
//    • requires a genuine authenticated Supabase JWT (the anon key is NOT
//      accepted as authentication);
//    • verifies the caller's CURRENT staff profile + role via the service role
//      (never trusts a role supplied by the client);
//    • allows only `owner` and `store_manager` — the roles already permitted to
//      write public content (migration_rls_per_role.sql content_write_mgr);
//    • rejects disabled/inactive staff;
//    • NEVER publishes production directly. Public content is live immediately,
//      while the static crawler snapshot is refreshed only by the protected,
//      signed website release pipeline. This endpoint records that refresh need.
//
//  This file references NO Deno/Node globals — only injected `fetch` and the
//  Web-standard AbortController/timers.
// ============================================================================

import { jwtHasAal2 } from '../_shared/jwt.ts';

export interface SeoRebuildEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export interface SeoRebuildDeps {
  fetchImpl: typeof fetch;
}

export interface SeoRebuildResult {
  status: number;
  body: Record<string, unknown>;
}

/** The minimal reasons a rebuild may be requested for. */
export const SEO_REBUILD_AREAS = [
  'site-content',
  'site-settings',
  'menu',
  'stores',
  'vacancies',
  'news',
  'manual',
] as const;
export type SeoRebuildArea = (typeof SEO_REBUILD_AREAS)[number];

/** Roles permitted to publish public content — the ONLY callers allowed to
 *  request an SEO rebuild. Kept in lockstep with the DB content-write policy. */
export const SEO_PUBLISHER_ROLES = ['owner', 'store_manager'] as const;

function isAllowedArea(area: unknown): area is SeoRebuildArea {
  return typeof area === 'string' && (SEO_REBUILD_AREAS as readonly string[]).includes(area);
}

/**
 * Authorise the caller and (if permitted + configured) trigger a rebuild.
 * @param token  bearer token already extracted from the Authorization header
 * @param area   the raw `area` value from the request body
 */
export async function handleSeoRebuild(
  token: string,
  area: unknown,
  env: SeoRebuildEnv,
  deps: SeoRebuildDeps,
): Promise<SeoRebuildResult> {
  const SUPABASE_URL = env.SUPABASE_URL;
  const ANON = env.SUPABASE_ANON_KEY;
  const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
  const fetchImpl = deps.fetchImpl;

  if (!SUPABASE_URL || !ANON || !SERVICE) {
    return { status: 500, body: { error: 'Server is not configured.' } };
  }
  const baseUrl = SUPABASE_URL.replace(/\/$/, '');

  // --- 1. AUTHENTICATION ------------------------------------------------------
  // The anon key is public and must NEVER count as authentication.
  if (!token || token === ANON) {
    return { status: 401, body: { error: 'Authentication required.' } };
  }
  const userRes = await fetchImpl(`${baseUrl}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) return { status: 401, body: { error: 'Authentication required.' } };
  const user = (await userRes.json().catch(() => null)) as { id?: string } | null;
  const uid = user?.id;
  if (!uid) return { status: 401, body: { error: 'Authentication required.' } };

  // --- 2. STAFF PROFILE + ROLE (server-derived, never client-supplied) --------
  const svc = (p: string, init: RequestInit = {}) =>
    fetchImpl(`${baseUrl}/rest/v1/${p}`, {
      ...init,
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        'Content-Type': 'application/json',
        ...((init.headers as Record<string, string>) || {}),
      },
    });

  const callerRes = await svc(
    `staff_profiles?auth_id=eq.${encodeURIComponent(uid)}&select=id,name,role,status,ended_at&limit=1`,
  );
  if (!callerRes.ok) return { status: 500, body: { error: 'Could not verify staff profile.' } };
  const caller = ((await callerRes.json().catch(() => [])) as Array<Record<string, unknown>>)?.[0];
  if (!caller) return { status: 403, body: { error: 'No staff profile is linked to this account.' } };
  if (String(caller.status ?? 'active') === 'disabled' || caller.ended_at) {
    return { status: 403, body: { error: 'This account is disabled.' } };
  }
  const role = String(caller.role ?? '');
  if (!(SEO_PUBLISHER_ROLES as readonly string[]).includes(role)) {
    return { status: 403, body: { error: 'Only owners and store managers can request an SEO rebuild.' } };
  }

  // --- 3. INPUT ---------------------------------------------------------------
  if (!isAllowedArea(area)) {
    return { status: 400, body: { error: 'Unknown rebuild area.' } };
  }
  // Stage 2.1 F14: after the Stage-2 content lockdown a manager may publish only
  // the MENU, so a manager may trigger only a 'menu' rebuild — and, like every
  // privileged action, only from an MFA (aal2) session. Owners are unrestricted.
  const callerAal2 = jwtHasAal2(token);
  if (role !== 'owner') {
    if (!callerAal2) {
      return { status: 403, body: { error: 'This action requires a fully verified (MFA) session.' } };
    }
    if (area !== 'menu') {
      return { status: 403, body: { error: 'Managers may only rebuild the menu.' } };
    }
  }

  const audit = (outcome: 'granted' | 'denied', code?: string) =>
    svc('activity_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([
        {
          actor_auth_id: uid,
          actor_staff_id: String(caller.id ?? ''),
          actor_name: String(caller.name ?? ''),
          actor_role: role,
          action: 'seo_rebuild_request',
          target_kind: 'seo',
          target_ref: area,
          outcome,
          detail: code ?? null,
        },
      ]),
    }).catch(() => undefined);

  // --- 4. PROTECTED RELEASE HANDOFF ------------------------------------------
  // Publishing public content must never create an unsigned side-channel into
  // production hosting. The live application already reads the database, so
  // the write is immediately visible to users. The static crawler snapshot is
  // intentionally refreshed only by the signed/protected release workflow.
  await audit('granted', 'protected_release_pending');
  return {
    status: 200,
    body: {
      ok: true,
      queued: false,
      deferred: true,
      code: 'SEO_REFRESH_PROTECTED_RELEASE',
    },
  };

}
