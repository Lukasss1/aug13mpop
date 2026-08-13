#!/usr/bin/env node
/**
 * ============================================================================
 *  SMALL-BIZ CLOSURE — HYDRATION BEHAVIOUR (P0-4, P0-6, P1-2)
 * ============================================================================
 *
 *  §9 says: "Do not rely only on source-text assertions where a behavioural
 *  test is practical." For the hydration and error-classification paths it IS
 *  practical, using the mechanism the client-wire suite established: bundle
 *  the REAL production TypeScript exactly as Vite bundles it, then execute it
 *  against a recording/scripted fetch stub.
 *
 *  A source pin proves hydrateStaffData LOOKS like it fails honestly. Only
 *  running it against 401 / 403 / 500 / malformed responses proves what it
 *  DOES — which is the whole of P0-4, since the defect was that non-transport
 *  errors were silently swallowed and the app then called the data live.
 *
 *  Run:  npm run test:closure-hydration
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed += 1; console.log(`  \u2714 ${label}`); }
  else { failed += 1; failures.push(label); console.log(`  \u2716 ${label}${detail ? ` \u2014 ${detail}` : ''}`); }
};

const dir = mkdtempSync(path.join(tmpdir(), 'mp-closure-'));
const outfile = path.join(dir, 'hydration.mjs');
await build({
  entryPoints: ['scripts/lib/closure-hydration-entry.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  plugins: [{
    name: 'stub-auth',
    setup(b) {
      b.onResolve({ filter: /(^|\/)auth$/ }, () => ({ path: path.resolve('scripts/lib/client-wire-auth-stub.ts') }));
    },
  }],
  define: {
    'import.meta.env': JSON.stringify({
      VITE_SUPABASE_URL: 'https://stub.milkpop.invalid',
      VITE_SUPABASE_ANON_KEY: 'stub-anon-key',
      DEV: false,
    }),
  },
  logLevel: 'silent',
});
const lib = await import(`file://${outfile}`);

/* ---- scripted fetch: per-relation responses ----------------------------- */
let plan = {};           // relation -> {status, body} | 'throw'
const seen = [];
const relationOf = (url) => {
  const m = /\/rest\/v1\/([^?]+)/.exec(String(url));
  return m ? m[1] : String(url);
};
globalThis.fetch = async (url) => {
  const rel = relationOf(url);
  seen.push(rel);
  const rule = plan[rel] ?? plan.__default ?? { status: 200, body: '[]' };
  if (rule === 'throw') throw new TypeError('Failed to fetch');       // transport failure
  if (rule === 'malformed') {
    // 200 OK whose body is not JSON at all — an unknown exception inside the
    // repo's own parsing. Before P0-4 this was swallowed as "no data".
    return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); },
             text: async () => 'not json at all' };
  }
  const ok = rule.status >= 200 && rule.status < 300;
  return {
    ok, status: rule.status,
    json: async () => JSON.parse(rule.body),
    text: async () => rule.body,
  };
};

console.log('SMALL-BIZ CLOSURE — HYDRATION BEHAVIOUR');
console.log('=======================================');

/* ==================================================================== */
console.log('\n\u00a71  P0-6: the Knowledge Base is actually fetched');
{
  plan = { __default: { status: 200, body: '[]' } };
  seen.length = 0;
  const bundle = await lib.hydrateStaffData('test-token');
  check('hydration requests kb_articles', seen.includes('kb_articles'), seen.join(', ').slice(0, 160));
  check('…and the result lands on bundle.articles', Array.isArray(bundle.articles), typeof bundle.articles);
  check('a fully successful hydration records NO failures',
    bundle.failures.length === 0, JSON.stringify(bundle.failures));
  check('…and does not flag the session as expired', !bundle.sessionExpired);
}

/* ==================================================================== */
console.log('\n\u00a72  P0-4: successful EMPTY data is a legitimate live state');
{
  plan = { __default: { status: 200, body: '[]' } };
  const bundle = await lib.hydrateStaffData('test-token');
  check('every collection empty \u21d2 zero failures (a new business is empty, not broken)',
    bundle.failures.length === 0, JSON.stringify(bundle.failures));
}

/* ==================================================================== */
console.log('\n\u00a73  P0-4: expected role-based DENIAL stays silent');
{
  // A manager legitimately cannot read the owner-only audit log.
  plan = { __default: { status: 200, body: '[]' }, audit_logs: { status: 403, body: '{"message":"permission denied"}' } };
  const bundle = await lib.hydrateStaffData('test-token');
  check('a 403 on one collection produces NO failure (legitimate empty for that role)',
    bundle.failures.length === 0, JSON.stringify(bundle.failures));
  check('…and does not expire the session', !bundle.sessionExpired);
}

/* ==================================================================== */
console.log('\n\u00a74  P0-4: an EXPIRED TOKEN is a failure AND ends the session');
{
  plan = { __default: { status: 200, body: '[]' }, work_shifts: { status: 401, body: '{"message":"JWT expired"}' } };
  const bundle = await lib.hydrateStaffData('test-token');
  check('a 401 is RECORDED as a failure (never a silent empty)',
    bundle.failures.length === 1, JSON.stringify(bundle.failures));
  check('…and raises sessionExpired so the app returns to sign-in',
    bundle.sessionExpired === true, String(bundle.sessionExpired));
}

/* ==================================================================== */
console.log('\n\u00a75  P0-4: server and transport failures are recorded');
{
  /* NB: the relation names here are the ones hydration REALLY requests —
     verified by recording them, not assumed. Employees arrive through
     rpc/get_staff_directory, so poking "staff_profiles" would have injected a
     fault into a request that is never made and passed vacuously. */
  plan = { __default: { status: 200, body: '[]' }, payslips: { status: 500, body: '{"message":"boom"}' } };
  let bundle = await lib.hydrateStaffData('test-token');
  check('a 500 is recorded as a failure', bundle.failures.length === 1, JSON.stringify(bundle.failures));

  plan = { __default: { status: 200, body: '[]' }, 'rpc/get_staff_directory': { status: 500, body: '{}' } };
  bundle = await lib.hydrateStaffData('test-token');
  check('a 500 on the staff-directory RPC is recorded too', bundle.failures.length === 1, JSON.stringify(bundle.failures));

  plan = { __default: { status: 200, body: '[]' }, clock_history: 'throw' };
  bundle = await lib.hydrateStaffData('test-token');
  check('a transport failure is recorded as a failure', bundle.failures.length === 1, JSON.stringify(bundle.failures));
}

/* ==================================================================== */
console.log('\n\u00a76  P0-4: THE DEFECT ITSELF \u2014 an unknown error is never "successful empty"');
{
  // This is the exact case the old classifier dropped: not network, not
  // server, not not_configured — so it recorded nothing and the app marked
  // staff data live over a collection that never loaded.
  plan = { __default: { status: 200, body: '[]' }, kb_articles: { status: 422, body: '{"message":"unprocessable"}' } };
  let bundle = await lib.hydrateStaffData('test-token');
  check('a 422 (invalid) is a recorded failure', bundle.failures.length === 1, JSON.stringify(bundle.failures));
  check('…and the collection is NOT presented as empty data',
    bundle.articles === undefined, JSON.stringify(bundle.articles));

  plan = { __default: { status: 200, body: '[]' }, media_assets: { status: 409, body: '{"message":"conflict"}' } };
  bundle = await lib.hydrateStaffData('test-token');
  check('an unexpected 409 (conflict) is a recorded failure', bundle.failures.length === 1, JSON.stringify(bundle.failures));

  plan = { __default: { status: 200, body: '[]' }, menu_items: 'malformed' };
  bundle = await lib.hydrateStaffData('test-token');
  check('a 200 with an UNPARSEABLE body is a recorded failure, not empty data',
    bundle.failures.length === 1, JSON.stringify(bundle.failures));

  /* THE FINDING THIS SUITE EXISTS FOR: an unrecognised non-2xx used to fall
     through to `denied` — the ONE code hydration treats as a legitimate empty
     — so a 404 on a missing relation or any proxy error page was silently
     presented as "this collection is empty". Only an explicit 403 is a denial. */
  plan = { __default: { status: 200, body: '[]' }, deals: { status: 418, body: 'teapot' } };
  bundle = await lib.hydrateStaffData('test-token');
  check('an entirely unknown status is a recorded failure (not a silent denial)',
    bundle.failures.length === 1, JSON.stringify(bundle.failures));
  check('…and that collection is NOT presented as empty data', bundle.dealsFull === undefined);

  plan = { __default: { status: 200, body: '[]' }, news_posts: { status: 404, body: 'relation does not exist' } };
  bundle = await lib.hydrateStaffData('test-token');
  check('a 404 on a missing relation is a recorded failure', bundle.failures.length === 1, JSON.stringify(bundle.failures));

  plan = { __default: { status: 200, body: '[]' }, orders: { status: 403, body: '{"message":"permission denied"}' } };
  bundle = await lib.hydrateStaffData('test-token');
  check('…while an explicit 403 REMAINS the legitimate silent empty', bundle.failures.length === 0, JSON.stringify(bundle.failures));
}

/* ==================================================================== */
console.log('\n\u00a77  P0-4: several failures are all recorded, and the rest still load');
{
  plan = {
    __default: { status: 200, body: '[]' },
    payslips: { status: 500, body: '{}' },
    work_shifts: 'throw',
    kb_articles: { status: 401, body: '{}' },
  };
  const bundle = await lib.hydrateStaffData('test-token');
  check('all three failures are recorded', bundle.failures.length === 3, JSON.stringify(bundle.failures));
  check('…the 401 among them still expires the session', bundle.sessionExpired === true);
  check('…and unaffected collections still hydrated',
    Array.isArray(bundle.mediaAssetsFull), typeof bundle.mediaAssetsFull);
}

/* ==================================================================== */
console.log('\n\u00a78  P1-2: safe, actionable messages \u2014 never raw server text');
{
  const RAW = 'ERROR:  collection_snapshot_stale: menu_items is at revision 9 but the publisher hydrated 7 — reload and review';
  let msg = '';
  try {
    plan = { __default: { status: 409, body: JSON.stringify({ message: RAW }) } };
    await lib.authedRest('menu_items', { method: 'POST', token: 'test-token', body: [] });
  } catch (e) {
    msg = lib.registryErrorMessage(e);
    check('a revision conflict is classified as STALE, not "conflict"', e.code === 'stale', String(e.code));
  }
  check('…and the message tells the user to reload and review',
    /reload/i.test(msg) && /review/i.test(msg), msg);
  check('…and NOT saved', /NOT saved/i.test(msg), msg);
  check('…leaking no raw server text (no SQL, no table names, no revision numbers)',
    !/collection_snapshot_stale|menu_items|ERROR:|revision 9/.test(msg), msg);

  const cases = [
    ['collection_revision_required: none stated', 'incomplete', /completely loaded/i],
    ['publish_blocked_incomplete: missing allergens', 'publish_blocked', /requirements are incomplete/i],
    ['store_setup_incomplete: vat unconfigured', 'store_setup', /Store setup is incomplete/i],
    ['form_accept_blocked: no notice', 'forms_uncommissioned', /not commissioned/i],
    ['owner_aal: aal2 required', 'mfa_required', /step-up authentication/i],
  ];
  for (const [raw, code, expect] of cases) {
    try {
      plan = { __default: { status: 400, body: JSON.stringify({ message: raw }) } };
      await lib.authedRest('menu_items', { method: 'POST', token: 'test-token', body: [] });
      check(`${code}: refusal surfaced`, false, 'no error thrown');
    } catch (e) {
      const m = lib.registryErrorMessage(e);
      check(`"${raw.split(':')[0]}" \u2192 ${code}`, e.code === code, String(e.code));
      check(`…with an actionable message`, expect.test(m), m);
      check(`…and no raw server text`, !m.includes(raw.split(':')[1]?.trim() || '\u0000'), m);
    }
  }

  // An UNKNOWN server message must fall through to the generic path.
  try {
    plan = { __default: { status: 400, body: JSON.stringify({ message: 'pg_catalog.some_internal_thing failed at line 42' }) } };
    await lib.authedRest('menu_items', { method: 'POST', token: 'test-token', body: [] });
  } catch (e) {
    const m = lib.registryErrorMessage(e);
    check('an UNKNOWN server message stays generic (allow-list, not pass-through)',
      e.code === 'invalid' && !/pg_catalog|line 42/.test(m), `${e.code}: ${m}`);
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(`\nCLOSURE HYDRATION BEHAVIOUR \u2014 ${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
