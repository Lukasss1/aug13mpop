#!/usr/bin/env node
/**
 * ============================================================================
 *  CLIENT WIRE CONTRACT — what the browser actually puts on the wire
 * ============================================================================
 *
 *  The original Website Studio defect was NOT a database defect. The RPC was
 *  fine; the CLIENT sent `id: "singleton"` in a direct upsert against tables
 *  whose primary keys are INTEGER 1 and BOOLEAN true. A database test that
 *  calls `select save_website_studio(...)` proves the function works and says
 *  nothing at all about that. A source scan proves the code LOOKS right and
 *  cannot prove what it SENDS.
 *
 *  So this executes the real production TypeScript — bundled exactly as Vite
 *  bundles it, with `import.meta.env` supplied — against a recording stub for
 *  `fetch`, and asserts the bytes:
 *
 *    1. the studio save issues ONE request, POST, to /rest/v1/rpc/save_website_studio
 *    2. its body keys are EXACTLY the RPC's parameter names, parsed from the
 *       migration SQL — so renaming either side breaks this test, which is the
 *       PostgREST failure mode (PGRST202) that started all of it
 *    3. nothing in the payload carries a fixed 'singleton' id, at any depth
 *    4. the launch-facts save does the same against rpc/save_launch_settings
 *    5. NO request anywhere targets site_settings / site_content /
 *       launch_settings as a table with a write method — no fallback path
 *    6. the returned revisions are actually read back from the response
 *
 *  Run:  npm run test:client-wire
 */

import { build } from 'esbuild';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed += 1; console.log(`  \u2714 ${label}`); }
  else { failed += 1; failures.push(label); console.log(`  \u2716 ${label}${detail ? ` \u2014 ${detail}` : ''}`); }
};

/* ---- the RPC signatures, read from the migrations themselves ------------- */
function sqlArgNames(file, fn) {
  const sql = readFileSync(file, 'utf8');
  const m = new RegExp(`create or replace function ${fn}\\(([^)]*)\\)`, 'i').exec(sql);
  if (!m) throw new Error(`signature for ${fn} not found in ${file}`);
  return m[1].split(',').map((a) => a.trim().split(/\s+/)[0]).filter(Boolean);
}
const STUDIO_ARGS = sqlArgNames('supabase/migration_inc11_studio_atomicity.sql', 'save_website_studio');
const LAUNCH_ARGS = sqlArgNames('supabase/migration_inc11_studio_atomicity.sql', 'save_launch_settings');

/* ---- bundle the REAL client, the way Vite would ------------------------- */
const dir = mkdtempSync(path.join(tmpdir(), 'wire-'));
const outfile = path.join(dir, 'client.mjs');
await build({
  entryPoints: ['scripts/lib/client-wire-entry.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  /* launchSettings.ts obtains its bearer token from ./auth, which needs a
     browser session. Redirect just that module to a stub so the REAL request
     logic still runs — everything else is the production code. */
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
const client = await import(`file://${outfile}`);

/* ---- recording fetch ---------------------------------------------------- */
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
  /* PostgREST returns a JSON body read via text(); registries.ts parses it
     itself, so the stub must respond the way the real endpoint does. */
  const payload = JSON.stringify({ settings_revision: 8, content_revision: 9, revision: 4 });
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(payload),
    text: async () => payload,
  };
};

const deepHasSingleton = (v) => {
  if (v === 'singleton') return true;
  if (Array.isArray(v)) return v.some(deepHasSingleton);
  if (v && typeof v === 'object') return Object.values(v).some(deepHasSingleton);
  return false;
};

console.log('CLIENT WIRE CONTRACT');
console.log('====================');

/* ---- 1-3, 6: the studio publish ----------------------------------------- */
console.log('\n\u00a71  Website Studio publish');
calls.length = 0;
const result = await client.saveWebsiteStudio(
  { brandName: 'Milk Pop' }, { footer: { line: 'x' } }, 3, 5, 'test-token',
);
check('issues exactly ONE request', calls.length === 1, `${calls.length} requests`);
const req = calls[0] || {};
check('…as POST to /rest/v1/rpc/save_website_studio',
  req.method === 'POST' && /\/rest\/v1\/rpc\/save_website_studio$/.test(req.url), `${req.method} ${req.url}`);
const bodyKeys = Object.keys(req.body || {}).sort();
check(`…whose body keys are EXACTLY the RPC's parameters (${STUDIO_ARGS.join(', ')})`,
  JSON.stringify(bodyKeys) === JSON.stringify([...STUDIO_ARGS].sort()),
  `sent ${JSON.stringify(bodyKeys)}`);
check('…carrying no fixed \u2018singleton\u2019 id at any depth', !deepHasSingleton(req.body), JSON.stringify(req.body || {}).slice(0, 120));
check('…and the expected revisions are the ones passed in',
  req.body?.p_expected_settings_revision === 3 && req.body?.p_expected_content_revision === 5,
  JSON.stringify({ s: req.body?.p_expected_settings_revision, c: req.body?.p_expected_content_revision }));
check('the response revisions are read back, not assumed',
  result?.settingsRevision === 8 && result?.contentRevision === 9, JSON.stringify(result));

/* ---- 4: launch facts ---------------------------------------------------- */
console.log('\n\u00a72  Launch-facts save');
calls.length = 0;
await client.saveLaunchSettings({ public_telephone: '0121' }, 7);
const lreq = calls.find((c) => /rpc\//.test(c.url)) || {};
check('issues a POST to /rest/v1/rpc/save_launch_settings',
  lreq.method === 'POST' && /\/rest\/v1\/rpc\/save_launch_settings$/.test(lreq.url || ''), `${lreq.method} ${lreq.url}`);
check(`…whose body keys are EXACTLY the RPC's parameters (${LAUNCH_ARGS.join(', ')})`,
  JSON.stringify(Object.keys(lreq.body || {}).sort()) === JSON.stringify([...LAUNCH_ARGS].sort()),
  `sent ${JSON.stringify(Object.keys(lreq.body || {}))}`);
check('…and updated_by is NOT client-supplied (the server derives it)',
  !('updated_by' in (lreq.body?.p_patch || {})), JSON.stringify(lreq.body?.p_patch || {}));

/* ---- 5: no fallback direct-table write anywhere -------------------------- */
console.log('\n\u00a73  No direct-table fallback');
const WRITE = /^(POST|PATCH|PUT|DELETE)$/;
const SINGLETON_TABLE = /\/rest\/v1\/(site_settings|site_content|launch_settings)(\?|$)/;
const offenders = calls.filter((c) => WRITE.test(c.method) && SINGLETON_TABLE.test(c.url));
check('no request writes a configuration singleton table directly',
  offenders.length === 0, offenders.map((o) => `${o.method} ${o.url}`).join(' | '));

rmSync(dir, { recursive: true, force: true });
console.log('');
if (failed === 0) console.log(`\u2714 CLIENT WIRE CONTRACT — ${passed} passed, 0 failed`);
else {
  console.log(`\u2716 CLIENT WIRE CONTRACT — ${passed} passed, ${failed} FAILED`);
  for (const f of failures) console.log(`    - ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
