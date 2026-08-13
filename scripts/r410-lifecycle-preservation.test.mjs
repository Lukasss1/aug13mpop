#!/usr/bin/env node
/**
 * ============================================================================
 *  R4.10 — replace_collection CANNOT CHANGE PUBLICATION STATE, AND A STALE
 *           SNAPSHOT CANNOT DELETE WHAT IT NEVER LOADED
 * ============================================================================
 *
 *  The third external audit's blocker 2, both halves:
 *
 *    1. LIFECYCLE FIELDS ARE IGNORED ON THE WAY IN. A payload row may say
 *       `available: false` about a published product, or `active: true` about
 *       a paused deal — the server strips the key. Existing rows keep their
 *       stored publication state; NEW rows land as drafts (column default).
 *       Only publish_record changes either.
 *
 *    2. THE SNAPSHOT TOTAL IS MANDATORY, AND A MISMATCH REFUSES THE WHOLE
 *       CALL BEFORE ANY DELETE. A browser session that hydrated before a
 *       newer record existed states the count it saw; the server holds more;
 *       nothing is deleted. A session that hydrated a FILTERED projection
 *       states the filtered count; same refusal. A caller with the CORRECT
 *       total sending fewer rows is an informed deletion, which still works —
 *       deletion by someone looking at the whole collection is an edit, not
 *       a hazard.
 *
 *  Every replace_collection and publish_record call here runs as the REAL
 *  `authenticated` role with owner @ AAL2 claims — superuser statements are
 *  fixtures and out-of-band verification only.
 *
 *  Run:  npm run test:r410-lifecycle
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { insertComplete } from './lib/publication-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.MP_LIFECYCLE_DB || 'mp_r410_lifecycle';
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
    `psql -q -X -v ON_ERROR_STOP=1 -d ${db} -f ${JSON.stringify(file)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const rows = (sql, o) => psql(sql, o).split('\n').map((s) => s.trim()).filter(Boolean);

const OWNER = '00000000-0000-4000-8000-0000000000aa';
const CLAIMS = JSON.stringify({ sub: OWNER, email: 'owner@milkpop.uk', role: 'authenticated', aal: 'aal2' });

function asOwner(sql) {
  const script = `
    select set_config('request.jwt.claims', '${CLAIMS}', false);
    set role authenticated;
    ${sql}
  `;
  try {
    const out = execFileSync('su', ['postgres', '-c',
      `psql -tA -v ON_ERROR_STOP=1 -d ${DB} -c ${JSON.stringify(script.replace(/\s+/g, ' ').trim())}`],
      { encoding: 'utf8' });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, err: `${e.stderr || e.message}` };
  }
}

function buildDatabase() {
  console.log('\n\u00a70  Fresh database from launch/migration-manifest.sh');
  const files = execFileSync('bash', [path.join(ROOT, 'launch/migration-manifest.sh'), 'all'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  execFileSync('su', ['postgres', '-c',
    `psql -q -X -c "drop database if exists ${DB}" -c "create database ${DB}"`], { encoding: 'utf8' });
  psqlFile(SHIM);
  for (const rel of files) psqlFile(path.join(ROOT, rel));
  check(`chain applies clean (${files.length} files)`, true);

  psql(`insert into stores (id, name, address, postcode, opening_hours, status)
        values ('st_lc', 'Lifecycle Store', '1 Test Way', 'B1 1AA', 'Mon-Sun 9-5', 'coming_soon')
        on conflict (id) do nothing`);
  psql(`insert into staff_profiles (id, name, email, role, store_id, auth_id, status)
        values ('sp_lc_owner', 'Olive Owner', 'owner@milkpop.uk', 'owner', 'st_lc', '${OWNER}', 'active')
        on conflict (id) do nothing`);
  // A clean, known collection per table under test: exactly two complete rows.
  for (const t of ['menu_items', 'deals', 'news_posts']) {
    psql(`delete from ${t}`);
    psql(insertComplete(t, `lc_${t}_a`));
    psql(insertComplete(t, `lc_${t}_b`));
  }
}

/** One collection's whole §1 story: publish A via the protected path, then
 *  attack it through replace_collection — the payload lies about BOTH rows'
 *  lifecycle AND smuggles a pre-published new row. */
function preservation({ table, col, on, off, view, contentCol }) {
  console.log(`\n\u00a71  ${table}: publication state survives a hostile whole-collection write`);
  const a = `lc_${table}_a`, b = `lc_${table}_b`, fresh = `lc_${table}_new`;

  const pub = asOwner(`select publish_record('${table}', '${a}', true);`);
  check(`${table}: row A published through the protected path`, pub.ok, pub.err);
  check(`${table}: row A is on ${view}`, rows(`select count(*) from ${view} where id='${a}'`)[0] === '1');

  // The hostile payload: A says UNPUBLISHED, B says PUBLISHED, the new row
  // says PUBLISHED — and it also carries a real content edit to prove the
  // content path still works. Total is CORRECT (2), so the guard passes.
  const attack = asOwner(`
    select jsonb_array_length((replace_collection('${table}',
      (select jsonb_agg(
         case id
           when '${a}' then jsonb_set(to_jsonb(t), '{${col}}', to_jsonb('${off}'::text)) || jsonb_build_object('${contentCol}', 'Edited By Replace')
           else jsonb_set(to_jsonb(t), '{${col}}', to_jsonb('${on}'::text))
         end) from ${table} t)
      || jsonb_build_array((
           select jsonb_set(to_jsonb(t), '{id}', to_jsonb('${fresh}'::text))
                  || jsonb_build_object('${col}', '${on}')
             from ${table} t where id = '${b}')),
      (select count(*)::int from ${table}),
      (select revision from collection_revisions where table_key = '${table}')))->'rows');`);
  check(`${table}: the whole-collection write itself succeeds (it is a CONTENT path)`, attack.ok, attack.err);

  check(`${table}: row A is STILL published — the payload's '${off}' was ignored`,
    rows(`select ${col}::text from ${table} where id='${a}'`)[0] === on);
  check(`${table}: row A's CONTENT edit landed (${contentCol} changed)`,
    rows(`select ${contentCol} from ${table} where id='${a}'`)[0] === 'Edited By Replace');
  check(`${table}: row B is STILL a draft — the payload's '${on}' was ignored`,
    rows(`select ${col}::text from ${table} where id='${b}'`)[0] === off);
  check(`${table}: the NEW row landed as a DRAFT despite claiming '${on}'`,
    rows(`select ${col}::text from ${table} where id='${fresh}'`)[0] === off);
  check(`${table}: the public projection still shows exactly row A`,
    rows(`select count(*) from ${view}`)[0] === '1' &&
    rows(`select id from ${view}`)[0] === a);
}

function staleness() {
  console.log(`\n\u00a72  A stale snapshot cannot delete a newer record`);
  const total = rows(`select count(*) from menu_items`)[0];
  const rev = rows(`select revision from collection_revisions where table_key='menu_items'`)[0];

  // Another session (here: the superuser as a stand-in for any writer)
  // creates a record AFTER our snapshot was taken — bumping the revision.
  psql(insertComplete('menu_items', 'lc_menu_items_concurrent'));

  // INC11: the replay states BOTH facts it hydrated (total AND revision);
  // the revision mismatch now refuses first — same pinned error name.
  const replay = asOwner(`
    select replace_collection('menu_items',
      (select jsonb_agg(to_jsonb(t)) from menu_items t where id <> 'lc_menu_items_concurrent'),
      ${total}, ${rev});`);
  check('replaying the stale snapshot is REFUSED as collection_snapshot_stale',
    !replay.ok && replay.err.includes('collection_snapshot_stale'), replay.err);
  check('the newer record SURVIVES',
    rows(`select count(*) from menu_items where id='lc_menu_items_concurrent'`)[0] === '1');
  check('nothing was deleted by the refused call',
    rows(`select count(*) from menu_items`)[0] === String(Number(total) + 1));

  console.log(`\n\u00a73  A missing total is refused; the two-argument signature is gone`);
  const noTotal = asOwner(`
    select replace_collection('menu_items',
      (select jsonb_agg(to_jsonb(t)) from menu_items t), null,
      (select revision from collection_revisions where table_key='menu_items'));`);
  check('a NULL total is refused as collection_snapshot_total_required',
    !noTotal.ok && noTotal.err.includes('collection_snapshot_total_required'), noTotal.err);
  const noRev = asOwner(`
    select replace_collection('menu_items',
      (select jsonb_agg(to_jsonb(t)) from menu_items t),
      (select count(*)::int from menu_items), null);`);
  check('INC11: a NULL revision is refused as collection_revision_required',
    !noRev.ok && noRev.err.includes('collection_revision_required'), noRev.err);
  check('the legacy replace_collection(text, jsonb) no longer exists',
    rows(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'replace_collection'
             and pg_get_function_identity_arguments(p.oid) = 'p_table text, p_rows jsonb'`)[0] === '0');
  check('INC11: the three-argument form no longer exists',
    rows(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'replace_collection'
             and pg_get_function_identity_arguments(p.oid) = 'p_table text, p_rows jsonb, p_expected_total integer'`)[0] === '0');

  console.log(`\n\u00a74  An INFORMED deletion still works (correct total, smaller payload)`);
  const now = rows(`select count(*) from menu_items`)[0];
  const del = asOwner(`
    select jsonb_array_length((replace_collection('menu_items',
      (select jsonb_agg(to_jsonb(t)) from menu_items t where id <> 'lc_menu_items_concurrent'),
      ${now},
      (select revision from collection_revisions where table_key='menu_items')))->'rows');`);
  check('a caller who saw the whole collection may delete a row', del.ok, del.err);
  check('exactly that row is gone',
    rows(`select count(*) from menu_items where id='lc_menu_items_concurrent'`)[0] === '0');
}

function main() {
  console.log('R4.10 LIFECYCLE PRESERVATION & STALE SNAPSHOTS');
  console.log('==============================================');
  buildDatabase();
  preservation({ table: 'menu_items', col: 'available', on: 'true', off: 'false', view: 'menu_items_public', contentCol: 'name' });
  preservation({ table: 'deals', col: 'active', on: 'true', off: 'false', view: 'deals_public', contentCol: 'name' });
  preservation({ table: 'news_posts', col: 'status', on: 'published', off: 'draft', view: 'news_posts_public', contentCol: 'title' });
  staleness();

  console.log('');
  if (failed === 0) console.log(`\u2714 R4.10 LIFECYCLE PRESERVATION — ${passed} passed, 0 failed`);
  else {
    console.log(`\u2716 R4.10 LIFECYCLE PRESERVATION — ${passed} passed, ${failed} FAILED`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  try { execFileSync('su', ['postgres', '-c', `psql -q -X -c "drop database if exists ${DB}"`], { encoding: 'utf8' }); } catch { /* leave for inspection */ }
  process.exit(failed === 0 ? 0 : 1);
}

main();
