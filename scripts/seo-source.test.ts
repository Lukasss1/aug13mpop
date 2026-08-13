/**
 * seo-source.test.ts — OPT-02-C1.2 acceptance items (2)(3)(5)(6)(7)(8)(9)(16).
 *
 * Proves scripts/load-public-content.ts makes Supabase the single production
 * source of truth for public content and FAILS CLOSED — the bundled seeds are
 * never a production fallback.
 *
 * A real node:http server impersonates PostgREST (so the genuine fetch path,
 * AbortController timeout, HTTP-status and JSON-parse handling are all
 * exercised, not stubbed). It serves the shared fixture
 * (scripts/fixtures/seo-content.fixture.json) whose record names appear in NO
 * seed, so "the static SEO tracks the database, not the seeds" is checkable.
 *
 * Covered:
 *   • production reads every public table with the ANON key and explicit
 *     `select=` column lists — never `*`, never a private table;
 *   • the Supabase snapshot differs from the development-defaults snapshot;
 *   • incomplete stores/vacancies and non-published news are filtered out;
 *   • row order never changes the content hash (deterministic);
 *   • production FAILS CLOSED and does NOT fall back to seeds when: the URL or
 *     anon key is absent, the request fails, an HTTP error is returned, the
 *     body is invalid/timed-out, a required singleton is missing, or the
 *     content fails validation;
 *   • no credential is ever echoed in a thrown error.
 *
 * Run: npm run test:seo-source
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPublicContent, developmentDefaultsSnapshot, PUBLIC_RELATIONS} from './load-public-content';
import type { RawTables } from './load-public-content';
import { canonicalContentHash } from '../src/lib/publicContentSnapshot';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, 'fixtures', 'seo-content.fixture.json');
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as RawTables & Record<string, unknown>;

/* R4.10 Increment 5b: this used to be a hand-kept copy of the relation list, and
   it broke the moment the loader was repointed at the new projections — the same
   stand-in-without-reconciliation problem this round exists to remove. It is now
   DERIVED from the loader's own exported contract, so a relation can never be
   added, renamed or repointed without this suite following it automatically. */
const PUBLIC_TABLES = new Set(PUBLIC_RELATIONS.map((r) => r.relation));

let passed = 0, failed = 0;
const check = (name: string, cond: boolean) => {
  if (cond) { passed++; console.log(`\u2714 ${name}`); }
  else { failed++; console.error(`\u2716 ${name}`); }
};

/** Run a promise and capture success/failure without throwing out of the test. */
async function caught<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, error: e as Error }; }
}

/* ------------------------------------------------------------------ */
/*  Mock PostgREST server                                              */
/* ------------------------------------------------------------------ */

interface ServerConfig {
  tables: Record<string, unknown[]>;
  status: Record<string, number>;      // per-table HTTP status override
  delayMs: Record<string, number>;     // per-table response delay
  raw: Record<string, string>;         // per-table raw body override (bad JSON / non-array)
}

interface MockServer {
  baseUrl: string;
  anonKey: string;
  requestedTables: string[];
  sawSelect: Record<string, string>;   // table -> raw querystring
  authByTable: Record<string, { apikey?: string; authorization?: string }>;
  close: () => Promise<void>;
  reset: (cfg?: Partial<ServerConfig>) => void;
}

/* SMALL-BIZ CLOSURE P0-11: the relation carrying the settings singleton is
   whatever the LOADER declares — it became public_site_configuration (the one
   public source of legal/contact truth). Fault-injection targets are derived
   from that contract for the same reason the fixture mapping already is: a
   hardcoded relation name lets the test and the loader disagree silently, and
   a fault injected into a relation nobody requests proves nothing. */
const SETTINGS_RELATION =
  PUBLIC_RELATIONS.find((r) => r.field === 'site_settings')?.relation ?? 'site_settings';

function tablesFromFixture(): Record<string, unknown[]> {
  return {
    /* R4.10 Increment 5b: the mock serves whatever RELATION NAME the loader asks
       for, mapped through the loader's own relation -> RawTables field contract.
       Hardcoding the relation names here meant the fixture and the loader could
       disagree silently; deriving them means they cannot. */

    site_settings: [...(FIXTURE.site_settings || [])],
    site_content: [...(FIXTURE.site_content || [])],
    ...Object.fromEntries(
      PUBLIC_RELATIONS.map((r) => [r.relation, [...(FIXTURE[r.field] ?? [])]]),
    ),
  };
}

async function startMockServer(anonKey: string): Promise<MockServer> {
  const cfg: ServerConfig = { tables: tablesFromFixture(), status: {}, delayMs: {}, raw: {} };
  const state = {
    requestedTables: [] as string[],
    sawSelect: {} as Record<string, string>,
    authByTable: {} as Record<string, { apikey?: string; authorization?: string }>,
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://localhost');
    // Expect /rest/v1/<table>
    const m = u.pathname.match(/^\/rest\/v1\/([^/?]+)/);
    const table = m ? m[1] : '';
    state.requestedTables.push(table);
    state.sawSelect[table] = u.searchParams.get('select') || '';
    state.authByTable[table] = {
      apikey: req.headers['apikey'] as string | undefined,
      authorization: req.headers['authorization'] as string | undefined,
    };

    const finish = () => {
      if (res.writableEnded) return; // client aborted (timeout test) — do nothing
      try {
        const status = cfg.status[table] ?? 200;
        if (cfg.raw[table] !== undefined) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(cfg.raw[table]);
          return;
        }
        if (status !== 200) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: `mock ${status}` }));
          return;
        }
        const rows = cfg.tables[table] ?? [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows));
      } catch { /* socket already closed */ }
    };

    const delay = cfg.delayMs[table] ?? 0;
    if (delay > 0) setTimeout(finish, delay);
    else finish();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    anonKey,
    get requestedTables() { return state.requestedTables; },
    get sawSelect() { return state.sawSelect; },
    get authByTable() { return state.authByTable; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    reset: (partial?: Partial<ServerConfig>) => {
      cfg.tables = partial?.tables ?? tablesFromFixture();
      cfg.status = partial?.status ?? {};
      cfg.delayMs = partial?.delayMs ?? {};
      cfg.raw = partial?.raw ?? {};
      state.requestedTables.length = 0;
      state.sawSelect = {};
      state.authByTable = {};
    },
  } as MockServer;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

const ANON = 'anon-test-key-do-not-log-1234567890';

async function run() {
  const srv = await startMockServer(ANON);
  const prod = (over: Record<string, unknown> = {}) =>
    loadPublicContent({ mode: 'production', baseUrl: srv.baseUrl, anonKey: srv.anonKey, timeoutMs: 4000, ...over });

  const defaults = developmentDefaultsSnapshot();

  try {
    /* --- happy path: Supabase is the source ------------------------------- */
    srv.reset();
    const okRes = await caught(() => prod());
    check('production load from Supabase succeeds', okRes.ok);
    if (okRes.ok) {
      const { snapshot, metadata } = okRes.value;

      check('metadata.source is "supabase"', metadata.source === 'supabase');
      check('content hash is 32 hex chars', /^[0-9a-f]{32}$/.test(metadata.contentHash));

      // (2)(16) anon key + explicit columns + only public tables
      const requested = new Set(srv.requestedTables);
      check('all requested tables are public (no private tables read)',
        [...requested].every((t) => PUBLIC_TABLES.has(t)) && requested.size === PUBLIC_TABLES.size);
      const authOk = [...PUBLIC_TABLES].every((t) => {
        const a = srv.authByTable[t];
        return a && a.apikey === ANON && a.authorization === `Bearer ${ANON}`;
      });
      check('every table fetched with the anon key (apikey + Bearer)', authOk);
      const selectsOk = [...PUBLIC_TABLES].every((t) => {
        const q = srv.sawSelect[t] || '';
        return q.length > 0 && !q.includes('*');
      });
      check('every fetch uses an explicit select= list (never select=*)', selectsOk);

      // Differs from the development-defaults snapshot
      check('supabase hash differs from development-defaults hash',
        metadata.contentHash !== defaults.metadata.contentHash);
      check('supabase stores count (1) differs from seed stores count (0)',
        metadata.counts.stores === 1 && defaults.metadata.counts.stores === 0);

      // (5) stores tracked + incomplete filtered
      const storeNames = snapshot.stores.map((s) => s.name);
      check('complete fixture store is present', storeNames.includes('Riverside Quay Kiosk'));
      check('incomplete store (no postcode) filtered out', !storeNames.includes('Incomplete Placeholder Stall'));

      // (6) vacancies tracked + incomplete filtered
      const vacTitles = snapshot.vacancies.map((v) => v.title);
      check('complete fixture vacancy is present', vacTitles.includes('Night Shift Blender Artisan'));
      check('incomplete vacancy (no salary) filtered out', !vacTitles.includes('Placeholder Trainee Without Pay Info'));

      // (7) published news included, (8) draft excluded
      const newsTitles = snapshot.newsPosts.map((p) => p.title);
      check('published news post included', newsTitles.includes('Neon Nights Launch Party'));
      check('draft news post excluded', !newsTitles.includes('Secret Winter Menu Preview'));
      check('every snapshot news post is published', snapshot.newsPosts.every((p) => p.status === 'published'));

      // menu filtered (invalid category dropped)
      const menuNames = snapshot.menuItems.map((mi) => mi.name);
      check('valid menu items present (3)', snapshot.menuItems.length === 3);
      check('invalid-category menu item filtered out', !menuNames.includes('Mystery Unfiled Concoction'));

      // unique SEO text comes from the DB, not the seed default
      check('home SEO title comes from Supabase fixture',
        snapshot.siteContent.seo.home.title === 'Riverside Fixtureton Shakes — FIXTURE Home 4821');
      check('brand name comes from Supabase fixture',
        snapshot.siteSettings.brandName === 'Milk Pop Fixtureton');

      const allPublishedHash = canonicalContentHash(snapshot);
      for (const flag of ['showCareers', 'showFranchise', 'showNews'] as const) {
        const switched = {
          ...snapshot,
          siteSettings: { ...snapshot.siteSettings, [flag]: !snapshot.siteSettings[flag] },
        };
        check(`${flag} changes the canonical content hash`, canonicalContentHash(switched) !== allPublishedHash);
      }
    }

    /* --- deterministic ordering ------------------------------------------- */
    srv.reset();
    const a = await caught(() => prod());
    const shuffled = tablesFromFixture();
    // R4.10 Increment 5b: reverse EVERY collection the loader reads, derived from
    // its contract rather than named one by one.
    for (const r of PUBLIC_RELATIONS) {
      const rows = shuffled[r.relation as keyof typeof shuffled];
      if (Array.isArray(rows)) rows.reverse();
    }
    srv.reset({ tables: shuffled });
    const b = await caught(() => prod());
    check('row order does not change the content hash',
      a.ok && b.ok && a.value.metadata.contentHash === b.value.metadata.contentHash);
    check('row order does not change counts',
      a.ok && b.ok && JSON.stringify(a.value.metadata.counts) === JSON.stringify(b.value.metadata.counts));

    /* --- empty collections ------------------------------------------------ */
    srv.reset({ tables: { ...tablesFromFixture(), stores_public: [] } });
    const noStores = await caught(() => prod());
    check('empty stores table yields zero stores (still valid)',
      noStores.ok && noStores.value.snapshot.stores.length === 0);

    srv.reset({ tables: { ...tablesFromFixture(), job_vacancies_public: [] } });
    const noVac = await caught(() => prod());
    check('empty vacancies table yields zero vacancies (still valid)',
      noVac.ok && noVac.value.snapshot.vacancies.length === 0);

    /* ===================================================================== */
    /*  FAIL-CLOSED — production must throw and must NOT use seed defaults    */
    /* ===================================================================== */

    // Helper: assert it threw, the message is a production-fail message, it does
    // not leak the anon key, and no development-defaults snapshot came back.
    const failClosed = (name: string, r: Awaited<ReturnType<typeof caught>>) => {
      if (r.ok) {
        // The most important property: a seed fallback must NEVER be returned.
        check(`${name}: FAILS CLOSED (threw, no seed fallback)`, false);
        return;
      }
      const msg = r.error.message || '';
      check(`${name}: FAILS CLOSED (threw, no seed fallback)`, true);
      check(`${name}: error names production fail-closed`, /production/i.test(msg) && /seed fallback is prohibited/i.test(msg));
      check(`${name}: error does not leak the anon key`, !msg.includes(ANON));
    };

    // URL absent
    failClosed('missing URL', await caught(() =>
      loadPublicContent({ mode: 'production', env: {}, baseUrl: undefined, anonKey: ANON })));

    // Anon key absent
    failClosed('missing anon key', await caught(() =>
      loadPublicContent({ mode: 'production', env: {}, baseUrl: srv.baseUrl, anonKey: undefined })));

    // Request fails (connection refused — dead port)
    failClosed('request refused', await caught(() =>
      loadPublicContent({ mode: 'production', baseUrl: 'http://127.0.0.1:1', anonKey: ANON, timeoutMs: 2000 })));

    // HTTP 401 on a table
    srv.reset({ status: { [SETTINGS_RELATION]: 401 } });
    failClosed('HTTP 401', await caught(() => prod()));

    // HTTP 500 on a table
    srv.reset({ status: { stores_public: 500 } });
    failClosed('HTTP 500', await caught(() => prod()));

    // Timeout: table delayed beyond the request timeout
    srv.reset({ delayMs: { news_posts_public: 400 } });
    failClosed('timeout', await caught(() => prod({ timeoutMs: 80 })));

    // Invalid JSON body
    srv.reset({ raw: { menu_items_public: '{ this is : not json' } });
    failClosed('invalid JSON', await caught(() => prod()));

    // Non-array body
    srv.reset({ raw: { stores_public: '{"not":"an array"}' } });
    failClosed('non-array body', await caught(() => prod()));

    // Missing required singleton: site_content
    srv.reset({ tables: { ...tablesFromFixture(), site_content: [] } });
    failClosed('missing site_content singleton', await caught(() => prod()));

    // Missing required singleton: site_settings
    srv.reset({ tables: { ...tablesFromFixture(), [SETTINGS_RELATION]: [] } });
    failClosed('missing site_settings singleton', await caught(() => prod()));

    // Content fails validation: settings row with neither brand nor legal name
    srv.reset({
      tables: {
        ...tablesFromFixture(),
        [SETTINGS_RELATION]: [{ id: 'x', brand_name: '', legal_name: '', website_url: 'https://milkpop.uk', updated_at: '2026-01-01T00:00:00.000Z' }],
      },
    });
    failClosed('content validation failure', await caught(() => prod()));

    /* --- sanity: a production build never *silently* returns dev defaults -- */
    // Point at the mock but 500 everything; assert the source is not development-defaults.
    srv.reset({ status: Object.fromEntries(PUBLIC_RELATIONS.map((r) => [r.relation, 500])) });
    const total = await caught(() => prod());
    check('total DB failure never yields a development-defaults snapshot',
      !total.ok || total.value.metadata.source !== 'development-defaults');
  } finally {
    await srv.close();
  }

  console.log(`\n${failed ? '\u2716' : '\u2714'} seo-source: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error('seo-source.test crashed:', e); process.exit(1); });
