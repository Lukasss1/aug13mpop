/**
 * seo-rebuild.test.ts — current protected-SEO publication contract.
 *
 * Public content writes are live from Supabase immediately. This Edge Function
 * authorises the publisher and records an audit handoff, but MUST NOT call a
 * hosting build/deploy hook. Static crawler pages are refreshed only by the
 * protected signed website release pipeline.
 *
 * Run: npm run test:seo-rebuild
 */
import { handleSeoRebuild } from '../supabase/functions/request-seo-rebuild/core';
import type { SeoRebuildEnv } from '../supabase/functions/request-seo-rebuild/core';

let passed = 0, failed = 0;
const check = (name: string, cond: boolean) => {
  if (cond) { passed++; console.log(`\u2714 ${name}`); }
  else { failed++; console.error(`\u2716 ${name}`); }
};

const ANON = 'anon-public-key';
const SERVICE = 'service-role-key';
const BASE = 'https://mock.supabase.co';

const envWith = (over: Partial<SeoRebuildEnv> = {}): SeoRebuildEnv => ({
  SUPABASE_URL: BASE,
  SUPABASE_ANON_KEY: ANON,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  ...over,
});

interface FakeOpts {
  /** null = /auth/v1/user returns 401; otherwise the user id returned. */
  userId?: string | null;
  /** staff_profiles rows returned by the service-role read. */
  profileRows?: Array<Record<string, unknown>>;
}

function makeFetch(opts: FakeOpts) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const json = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

  const fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const method = String(init?.method ?? 'GET').toUpperCase();
    calls.push({ url: u, method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (u.includes('/auth/v1/user')) {
      if (opts.userId == null) return json(401, { error: 'bad jwt' });
      return json(200, { id: opts.userId });
    }
    if (u.includes('/rest/v1/staff_profiles')) return json(200, opts.profileRows ?? []);
    if (u.includes('/rest/v1/activity_log')) return json(201, null);
    throw new Error(`unexpected outbound request: ${u}`);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const owner = [{ id: 's1', name: 'Olive Owner', role: 'owner', status: 'active' }];
const manager = [{ id: 's2', name: 'Manny Manager', role: 'store_manager', status: 'active' }];
const staff = [{ id: 's3', name: 'Sam Staff', role: 'staff', status: 'active' }];
const disabledOwner = [{ id: 's4', name: 'Dis Abled', role: 'owner', status: 'disabled' }];

function hasOnlySupabaseCalls(calls: Array<{ url: string }>) {
  return calls.every((c) => c.url.startsWith(BASE));
}

async function run() {
  {
    const { fetchImpl } = makeFetch({ userId: 'u', profileRows: owner });
    const r = await handleSeoRebuild('tok', 'menu', envWith({ SUPABASE_SERVICE_ROLE_KEY: undefined }), { fetchImpl });
    check('missing service-role key → 500', r.status === 500);
  }

  {
    const { fetchImpl, calls } = makeFetch({ userId: 'u', profileRows: owner });
    const r = await handleSeoRebuild('', 'menu', envWith(), { fetchImpl });
    check('empty token → 401', r.status === 401);
    check('empty token makes no outbound request', calls.length === 0);
  }
  {
    const { fetchImpl, calls } = makeFetch({ userId: 'u', profileRows: owner });
    const r = await handleSeoRebuild(ANON, 'menu', envWith(), { fetchImpl });
    check('anon key as token → 401', r.status === 401);
    check('anon token makes no outbound request', calls.length === 0);
  }
  {
    const { fetchImpl } = makeFetch({ userId: null, profileRows: owner });
    const r = await handleSeoRebuild('expired-jwt', 'menu', envWith(), { fetchImpl });
    check('invalid/expired JWT → 401', r.status === 401);
  }

  {
    const { fetchImpl, calls } = makeFetch({ userId: 'u', profileRows: [] });
    const r = await handleSeoRebuild('tok', 'menu', envWith(), { fetchImpl });
    check('authenticated but no staff profile → 403', r.status === 403);
    check('no-profile caller reaches no external publisher', hasOnlySupabaseCalls(calls));
  }
  {
    const { fetchImpl, calls } = makeFetch({ userId: 'u', profileRows: staff });
    const r = await handleSeoRebuild('tok', 'menu', envWith(), { fetchImpl });
    check('non-publisher role → 403', r.status === 403);
    check('staff attempt reaches no external publisher', hasOnlySupabaseCalls(calls));
  }
  {
    const { fetchImpl, calls } = makeFetch({ userId: 'u', profileRows: disabledOwner });
    const r = await handleSeoRebuild('tok', 'menu', envWith(), { fetchImpl });
    check('disabled account → 403', r.status === 403);
    check('disabled caller reaches no external publisher', hasOnlySupabaseCalls(calls));
  }

  {
    const { fetchImpl } = makeFetch({ userId: 'u', profileRows: owner });
    const r = await handleSeoRebuild('tok', 'not-a-real-area', envWith(), { fetchImpl });
    check('unknown refresh area → 400', r.status === 400);
  }

  {
    const { fetchImpl, calls } = makeFetch({ userId: 'u', profileRows: owner });
    const r = await handleSeoRebuild('tok', 'menu', envWith(), { fetchImpl });
    check('owner request → protected-release handoff',
      r.status === 200 && r.body.ok === true && r.body.queued === false && r.body.deferred === true
      && r.body.code === 'SEO_REFRESH_PROTECTED_RELEASE');
    check('owner request never calls hosting/deploy API', hasOnlySupabaseCalls(calls));
    const audit = calls.find((c) => c.url.includes('/rest/v1/activity_log'));
    check('owner request records protected_release_pending audit',
      Boolean(audit?.body?.includes('protected_release_pending')));
  }

  const aal2 = `h.${btoa(JSON.stringify({ sub: 'u', aal: 'aal2' })).replace(/=+$/, '')}.s`;
  {
    const { fetchImpl, calls } = makeFetch({ userId: 'u', profileRows: manager });
    const r = await handleSeoRebuild(aal2, 'menu', envWith(), { fetchImpl });
    check('store_manager (aal2) menu handoff → 200 deferred',
      r.status === 200 && r.body.ok === true && r.body.deferred === true);
    check('manager menu request never calls hosting/deploy API', hasOnlySupabaseCalls(calls));
  }
  {
    const { fetchImpl } = makeFetch({ userId: 'u', profileRows: manager });
    const r = await handleSeoRebuild(aal2, 'stores', envWith(), { fetchImpl });
    check('store_manager cannot request non-menu refresh → 403', r.status === 403);
  }
  {
    const { fetchImpl } = makeFetch({ userId: 'u', profileRows: manager });
    const r = await handleSeoRebuild('tok', 'menu', envWith(), { fetchImpl });
    check('store_manager without MFA is denied → 403', r.status === 403);
  }

  {
    const areas = ['site-content', 'site-settings', 'menu', 'stores', 'vacancies', 'news', 'manual'];
    let allOk = true;
    for (const area of areas) {
      const { fetchImpl, calls } = makeFetch({ userId: 'u', profileRows: owner });
      const r = await handleSeoRebuild('tok', area, envWith(), { fetchImpl });
      allOk = allOk && r.status === 200 && r.body.code === 'SEO_REFRESH_PROTECTED_RELEASE' && hasOnlySupabaseCalls(calls);
    }
    check('every declared area is accepted for owner without external deployment', allOk);
  }

  console.log(`\nSEO rebuild protected-release contract: ${passed}/${passed + failed} passed`);
  if (failed) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
