#!/usr/bin/env node
/**
 * ============================================================================
 *  R4.10 — PUBLISH_RECORD RUNTIME MATRIX
 * ============================================================================
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  `publish_record` shipped with three independent defects, any one of them
 *  fatal: a `uuid` id parameter for tables with TEXT primary keys, a role check
 *  for 'manager' in a database whose role is 'store_manager', and an audit
 *  insert that omitted `audit_logs.id` (text, NOT NULL, no default). None was
 *  caught, because the only evidence ever offered was that an UNLISTED table is
 *  refused — a branch that returns before any of the three is reached.
 *
 *  A guard that refuses correctly is not a feature that works. This suite drives
 *  the SUCCESS path: for every collection on the allow-list, in both directions,
 *  with a real text id and a real store-manager session.
 *
 *  It also asserts the two things the RPC exists to guarantee and that a column
 *  check alone would miss: the row actually appears on (and disappears from) its
 *  PUBLIC PROJECTION, and an audit event is written every single time.
 *
 *  WHAT THIS SUITE IS — AND IS NOT (third audit, R4.10)
 *  ----------------------------------------------------
 *  Every statement here executes as the PostgreSQL SUPERUSER, which bypasses
 *  row-level security. So this file proves the RPC's MECHANICS — parameter
 *  types, projection membership, audit writes — as an install-time sanity
 *  check. It does NOT prove authorisation. The permission matrix (anonymous,
 *  AAL1, disabled, store-manager scope, owner scope) is proven as the REAL
 *  `authenticated` role in scripts/r410-publication-authz.test.mjs, and that
 *  suite — not this one — is the authorisation evidence for this release.
 *  The session below is the OWNER at AAL2 because R4.10 publish_record
 *  enforces the explicit matrix even before RLS: a store manager may publish
 *  menu items only, and completeness is enforced on publish, so the probe
 *  rows come from the SHARED complete fixtures both matrices use.
 *
 *  Run:  npm run test:r410-publish-record
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { insertComplete } from './lib/publication-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.MP_PUBLISH_DB || 'mp_r410_publish';
const SHIM = path.join(ROOT, 'scripts/lib/supabase-local-privileges.sql');

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed += 1; console.log(`  \u2714 ${label}`); }
  else { failed += 1; failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  \u2716 ${label}${detail ? ` — ${detail}` : ''}`); }
};

function psql(sql, { db = DB } = {}) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return execFileSync('su', ['postgres', '-c',
    `psql -tA -v ON_ERROR_STOP=1 -d ${db} -c ${JSON.stringify(oneLine)}`], { encoding: 'utf8' });
}
function psqlFile(file, { db = DB } = {}) {
  return execFileSync('su', ['postgres', '-c',
    `psql -q -X -v ON_ERROR_STOP=1 -d ${db} -f ${JSON.stringify(file)}`], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
}
const rows = (sql, o) => psql(sql, o).split('\n').map((s) => s.trim()).filter(Boolean);

/** collection → publication column, published value, draft value, public projection */
/* INC11: the mechanics matrix follows the narrowed FOUR-collection scope —
 * media and cms left the boundary (supersession note in
 * migration_inc11_publication_scope.sql); their refusal is asserted below. */
const MATRIX = [
  { table: 'menu_items',    col: 'available', on: 'true',      off: 'false', view: 'menu_items_public' },
  { table: 'deals',         col: 'active',    on: 'true',      off: 'false', view: 'deals_public' },
  { table: 'news_posts',    col: 'status',    on: 'published', off: 'draft', view: 'news_posts_public' },
  { table: 'job_vacancies', col: 'status',    on: 'published', off: 'draft', view: 'job_vacancies_public' },
];
const RETIRED = ['media_assets', 'cms_pages'];

const OWNER = '11111111-1111-1111-1111-111111111111';
const CLAIMS = `{"sub":"${OWNER}","email":"probe.owner@milkpop.uk","role":"authenticated","aal":"aal2"}`;

function buildDatabase() {
  console.log('\n\u00a70  Fresh database from launch/migration-manifest.sh');
  const files = execFileSync('bash', [path.join(ROOT, 'launch/migration-manifest.sh'), 'all'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  execFileSync('su', ['postgres', '-c',
    `psql -q -X -c "drop database if exists ${DB}" -c "create database ${DB}"`], { encoding: 'utf8' });
  psqlFile(SHIM);
  for (const rel of files) psqlFile(path.join(ROOT, rel));
  check(`chain applies clean (${files.length} files)`, true);
}

/**
 * Build the staff row from information_schema rather than guessing. An earlier
 * attempt hardcoded (id, name, role) and failed on a NOT NULL `email` — the RPC
 * was never even reached, and the run looked like an RPC failure.
 */
/** Ensure at least one store exists and return its id. */
function ensureStore() {
  const existing = rows(`select id from stores limit 1`)[0];
  if (existing) return existing;
  const required = rows(`
    select column_name || '|' || data_type
      from information_schema.columns
     where table_schema='public' and table_name='stores'
       and is_nullable='NO' and column_default is null`).map((r) => r.split('|'));
  const id = 'st_probe';
  const cols = [], vals = [];
  for (const [name, type] of required) {
    cols.push(name);
    if (name === 'id') vals.push(`'${id}'`);
    else if (name === 'name') vals.push(`'Probe Store'`);
    else if (type === 'uuid') vals.push('gen_random_uuid()');
    else if (type === 'boolean') vals.push('false');
    else if (/timestamp|date/.test(type)) vals.push('now()');
    else if (/int|numeric|double|real/.test(type)) vals.push('0');
    else if (/json/.test(type)) vals.push(`'{}'::jsonb`);
    else vals.push(`'probe'`);
  }
  if (!cols.includes('id')) { cols.push('id'); vals.push(`'${id}'`); }
  if (!cols.includes('name')) { cols.push('name'); vals.push(`'Probe Store'`); }
  psql(`insert into stores (${cols.join(',')}) values (${vals.join(',')}) on conflict (id) do nothing`);
  return rows(`select id from stores limit 1`)[0];
}

function createOwnerSession() {
  console.log('\n\u00a71  An owner session, built from the real column list');
  const required = rows(`
    select column_name || '|' || data_type
      from information_schema.columns
     where table_schema='public' and table_name='staff_profiles'
       and is_nullable='NO' and column_default is null`).map((r) => r.split('|'));

  // A staff row is not free-standing: `staff_active_requires_store` means an
  // ACTIVE member must belong to a store. Discovering NOT NULL columns is not
  // enough — CHECK constraints impose their own fixture requirements, and this
  // one is invisible to information_schema's nullability view. So ensure a store
  // exists first, using the same discover-don't-guess approach.
  const storeId = ensureStore();
  const overrides = { id: `'${OWNER}'`, role: `'owner'`,
    email: `'probe.owner@milkpop.uk'`, name: `'Probe Owner'`,
    store_id: `'${storeId}'`,
    // current_staff_role() joins on auth_id = auth.uid(), NOT on the primary key.
    // The first version of this fixture set only `id` and left auth_id null, so
    // the lookup found nothing and the RPC refused — correctly. The session
    // identity must match the column the function actually reads.
    auth_id: `'${OWNER}'` };
  const cols = [], vals = [];
  for (const [name, type] of required) {
    cols.push(name);
    if (overrides[name]) { vals.push(overrides[name]); continue; }
    if (type === 'uuid') vals.push('gen_random_uuid()');
    else if (type === 'boolean') vals.push('false');
    else if (/timestamp|date/.test(type)) vals.push('now()');
    else if (/int|numeric|double|real/.test(type)) vals.push('0');
    else vals.push(`'probe'`);
  }
  for (const k of ['role', 'email', 'name', 'store_id', 'auth_id']) {
    if (!cols.includes(k) && overrides[k]) { cols.push(k); vals.push(overrides[k]); }
  }
  psql(`insert into staff_profiles (${cols.join(',')}) values (${vals.join(',')})
        on conflict (id) do update set role = 'owner', auth_id = excluded.auth_id`);
  check('owner row created and reachable via auth_id',
    rows(`select role from staff_profiles where auth_id = '${OWNER}'`)[0] === 'owner');
}

/** A stable COMPLETE row to operate on. R4.10 publish_record refuses to
 *  publish an incomplete record, so probe rows come from the shared fixture
 *  library both publication matrices use — fixtures stated once cannot drift
 *  apart. (The earlier generic column-guesser satisfied NOT NULL, not the
 *  completeness floor: a cms_pages row with a null hero and no SEO title
 *  inserts fine and then correctly refuses to publish.) */
function ensureRow(table) {
  const id = `probe_${table}`;
  try { psql(insertComplete(table, id)); } catch { return null; }
  return rows(`select id from ${table} where id = '${id}'`)[0] || null;
}

function main() {
  console.log('R4.10 PUBLISH_RECORD RUNTIME MATRIX');
  console.log('===================================');
  buildDatabase();
  createOwnerSession();

  console.log('\n\u00a72  Publish and unpublish, every collection, both directions');
  for (const m of MATRIX) {
    // Everything for one collection runs in ONE psql session so the JWT claims
    // set by set_config survive across the statements.
    const target = ensureRow(m.table);
    if (!target) {
      check(`${m.table}: has a row to publish`, false, 'could not create a probe row — the matrix proves nothing here');
      continue;
    }
    const script = `
      select set_config('request.jwt.claims', '${CLAIMS}', false);
      select publish_record('${m.table}', '${target}', true);
      select 'AFTER_PUBLISH=' || (select ${m.col}::text from ${m.table} where id = '${target}');
      select 'ON_VIEW=' || (select count(*) from ${m.view} where id = '${target}');
      select publish_record('${m.table}', '${target}', false);
      select 'AFTER_UNPUBLISH=' || (select ${m.col}::text from ${m.table} where id = '${target}');
      select 'OFF_VIEW=' || (select count(*) from ${m.view} where id = '${target}');
      select 'AUDIT=' || (select count(*) from audit_logs where module = '${m.table}');
    `;
    let out;
    try {
      out = execFileSync('su', ['postgres', '-c',
        `psql -tA -v ON_ERROR_STOP=1 -d ${DB} -c ${JSON.stringify(script.replace(/\s+/g, ' '))}`],
        { encoding: 'utf8' });
    } catch (e) {
      check(`${m.table}: publish/unpublish round trip`, false,
        `${e.stderr || e.message}`.split('\n').filter((l) => /ERROR/.test(l))[0] || 'failed');
      continue;
    }
    const get = (k) => (out.match(new RegExp(`${k}=([^\\s]*)`)) || [])[1];
    check(`${m.table}: publishing sets ${m.col} = ${m.on}`, get('AFTER_PUBLISH') === m.on, get('AFTER_PUBLISH'));
    check(`${m.table}: the row APPEARS on ${m.view}`, get('ON_VIEW') === '1', get('ON_VIEW'));
    check(`${m.table}: unpublishing sets ${m.col} = ${m.off}`, get('AFTER_UNPUBLISH') === m.off, get('AFTER_UNPUBLISH'));
    check(`${m.table}: the row LEAVES ${m.view}`, get('OFF_VIEW') === '0', get('OFF_VIEW'));
    check(`${m.table}: both operations wrote an audit event`, Number(get('AUDIT')) >= 2, `${get('AUDIT')} audit rows`);
  }

  console.log('\n\u00a73  The refusals still refuse');
  const refused = (sql) => { try { psql(sql); return false; } catch { return true; } };
  check('an unlisted collection is refused',
    refused(`select publish_record('payslips', 'x', true)`));
  check('the broken uuid overload no longer exists',
    rows(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='publish_record'
             and pg_get_function_identity_arguments(p.oid) like '%uuid%'`)[0] === '0');
  const refusedWith = (sql, needle) => {
    try { psql(sql); return `succeeded (wanted refusal naming "${needle}")`; }
    catch (e) { return String(e.stderr || e.message).includes(needle) ? 'ok' : String(e.stderr || e.message); }
  };
  for (const t of RETIRED) {
    const verdict = refusedWith(`select publish_record('${t}', 'probe_${t}', true)`, 'left the publication scope');
    check(`INC11: ${t} is refused — it left the publication scope`, verdict === 'ok', verdict);
  }


  console.log('');
  if (failed === 0) console.log(`\u2714 R4.10 PUBLISH_RECORD MATRIX — ${passed} passed, 0 failed`);
  else {
    console.log(`\u2716 R4.10 PUBLISH_RECORD MATRIX — ${passed} passed, ${failed} FAILED`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  try { execFileSync('su', ['postgres', '-c', `psql -q -X -c "drop database if exists ${DB}"`], { encoding: 'utf8' }); } catch { /* leave for inspection */ }
  process.exit(failed === 0 ? 0 : 1);
}

main();
