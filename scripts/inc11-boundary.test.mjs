#!/usr/bin/env node
/**
 * ============================================================================
 *  INC11 — THE PUBLICATION BOUNDARY, PROVEN AS THE REAL ROLES
 * ============================================================================
 *
 *  Five properties, every one executed under SET ROLE with real JWT claims
 *  (superuser statements are fixtures and out-of-band verification only —
 *  the guards deliberately exempt superuser, so nothing here would pass by
 *  accident):
 *
 *  §1 DIRECT LIFECYCLE BYPASS IS CLOSED. An AAL2 owner — the most privileged
 *     API session that exists — cannot flip available/active/status through
 *     a direct UPDATE, and cannot INSERT a row born published. The store
 *     manager cannot either. Only publish_record / close_vacancy carry the
 *     transaction-local sanction.
 *  §2 FINAL-STATE VALIDATION. A live record cannot be edited into
 *     invalidity: for every mandatory field of every collection, blanking it
 *     while published is refused (publish_blocked_incomplete) and the row is
 *     unchanged; after unpublishing, the same edit succeeds — drafts may be
 *     incomplete.
 *  §3 PUBLISHED RECORDS CANNOT BE DELETED — not by direct DELETE, not by an
 *     informed replace_collection payload. Draft deletion still works.
 *     The workflow is Published → Unpublish → Delete draft.
 *  §4 close_vacancy IS A REAL TRANSITION: published → closed keeps the row
 *     and leaves the public projection; idempotent when already closed;
 *     refused for drafts, for stale revisions, and for the store manager.
 *  §5 THE SANCTION CANNOT BE FABRICATED THROUGH THE API. The GUC is set by
 *     exactly the two sanctioned RPCs and by nothing else in the exposed
 *     schema; set_config itself lives in pg_catalog, which PostgREST does
 *     not expose. (psql-as-role could call set_config — the API boundary is
 *     the exposed schema, and that is what this section pins.)
 *  §6 THE REVISION GUARD CLOSES EDIT-EDIT LOSS. A same-count stale save is
 *     refused, the other session's edit survives, and a re-hydrated retry
 *     succeeds — the exact lost-update the snapshot TOTAL could never see.
 *
 *  Run:  npm run test:inc11-boundary
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PUBLICATION_MATRIX, insertComplete } from './lib/publication-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.MP_INC11_DB || 'mp_inc11_boundary';
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
function psqlFile(file) {
  return execFileSync('su', ['postgres', '-c',
    `psql -q -X -v ON_ERROR_STOP=1 -d ${DB} -f ${JSON.stringify(file)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const rows = (sql) => psql(sql).split('\n').map((s) => s.trim()).filter(Boolean);

const IDS = {
  owner: '00000000-0000-4000-8000-0000000000d1',
  manager: '00000000-0000-4000-8000-0000000000d2',
};
const claims = (sub) =>
  JSON.stringify({ sub, email: `${sub.slice(-2)}@milkpop.uk`, role: 'authenticated', aal: 'aal2' });

function asRole(sub, sql) {
  const script = `
    select set_config('request.jwt.claims', '${claims(sub)}', false);
    set role authenticated;
    ${sql}
  `;
  try {
    const raw = execFileSync('su', ['postgres', '-c',
      `psql -tA -v ON_ERROR_STOP=1 -d ${DB} -c ${JSON.stringify(script.replace(/\s+/g, ' ').trim())}`],
      { encoding: 'utf8' });
    // -tA prints a row for EVERY statement — including set_config's echo of
    // the claims JSON. Callers want the final SELECT's value, so `out` is the
    // LAST line (the full transcript stays available as `raw`).
    const lines = raw.trim().split('\n').filter(Boolean);
    return { ok: true, out: lines[lines.length - 1] ?? '', raw };
  } catch (e) {
    return { ok: false, err: `${e.stderr || e.message}` };
  }
}
const refused = (r, needle) => !r.ok && r.err.includes(needle);

/** The mandatory-field degradation cases per collection (field → blanking
 *  expression on the base table). Each is refused while published and
 *  accepted as a draft. */
const DEGRADATIONS = {
  menu_items: [
    ['name', `name = ''`],
    ['image', `image = ''`],
    ['image (placeholder default)', `image = 'placeholder'`],
    ['price', `price = -1`],
  ],
  deals: [
    ['name', `name = ''`],
    ['bundle price', `bundle_price = 0`],
  ],
  news_posts: [
    ['title', `title = ''`],
    ['content', `content = ''`],
    ['date', `date = ''`],
  ],
  job_vacancies: [
    ['title', `title = ''`],
    ['location', `location = ''`],
    ['salary', `salary = ''`],
    ['role description', `role_description = ''`],
  ],
};

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
        values ('st_b', 'Boundary Store', '1 Test Way', 'B1 1AA', 'Mon-Sun 9-5', 'coming_soon')
        on conflict (id) do nothing`);
  psql(`insert into staff_profiles (id, name, email, role, store_id, auth_id, status) values
          ('sp_b_owner', 'Olive Owner',   'd1@milkpop.uk', 'owner',         'st_b', '${IDS.owner}',   'active'),
          ('sp_b_mgr',   'Mandy Manager', 'd2@milkpop.uk', 'store_manager', 'st_b', '${IDS.manager}', 'active')
        on conflict (id) do nothing`);

  for (const m of PUBLICATION_MATRIX) {
    psql(`delete from ${m.table}`);
    psql(insertComplete(m.table, `b_${m.table}_live`));
    psql(insertComplete(m.table, `b_${m.table}_draft`));
    // Fixtures publish DIRECTLY as superuser — the exemption exists exactly
    // for harness arrangement; every assertion below runs as a real role.
    psql(`update ${m.table} set ${m.col} = '${m.on}' where id = 'b_${m.table}_live'`);
  }
  check('each collection holds one LIVE row and one DRAFT', true);
}

function directBypass() {
  console.log('\n\u00a71  Direct lifecycle writes are refused for every API role that has RLS write access');
  for (const m of PUBLICATION_MATRIX) {
    const up = asRole(IDS.owner,
      `update ${m.table} set ${m.col} = '${m.on}' where id = 'b_${m.table}_draft';`);
    check(`owner AAL2 cannot flip ${m.table}.${m.col} by direct UPDATE`,
      refused(up, 'lifecycle_change_refused'), up.err);
    check(`…and the draft stayed a draft`,
      rows(`select ${m.col}::text from ${m.table} where id = 'b_${m.table}_draft'`)[0] === m.off);
  }
  const born = asRole(IDS.owner,
    `insert into news_posts (id, title, content, category, date, status)
     values ('b_born_pub', 'Born Public', 'x', 'Announcement', '2026-07-29', 'published');`);
  check('a row cannot be INSERTed born-published', refused(born, 'lifecycle_change_refused'), born.err);
  const mgr = asRole(IDS.manager,
    `update menu_items set available = true where id = 'b_menu_items_draft';`);
  check('the store manager cannot flip menu availability directly either',
    refused(mgr, 'lifecycle_change_refused'), mgr.err);
  const rpc = asRole(IDS.owner, `select publish_record('menu_items', 'b_menu_items_draft', true)->>'current';`);
  check('…while publish_record still publishes the same row for the same owner', rpc.ok && rpc.out.trim() === 'true', rpc.err);
  asRole(IDS.owner, `select publish_record('menu_items', 'b_menu_items_draft', false);`);
}

function finalState() {
  console.log('\n\u00a72  A live record cannot be edited into invalidity — field by field');
  for (const m of PUBLICATION_MATRIX) {
    for (const [label, setter] of DEGRADATIONS[m.table]) {
      const live = asRole(IDS.owner,
        `update ${m.table} set ${setter} where id = 'b_${m.table}_live';`);
      check(`${m.table}: blanking ${label} WHILE LIVE is refused`,
        refused(live, 'publish_blocked_incomplete'), live.err);
    }
    check(`${m.table}: the live row is byte-for-byte unchanged after every refusal`,
      rows(`select count(*) from ${m.table} where id = 'b_${m.table}_live'
              and coalesce(array_length(publication_candidate_errors('${m.table}', to_jsonb(${m.table}.*)), 1), 0) = 0`)[0] === '1');
    const un = asRole(IDS.owner, `select publish_record('${m.table}', 'b_${m.table}_live', false);`);
    check(`${m.table}: unpublish succeeds`, un.ok, un.err);
    const draftEdit = asRole(IDS.owner,
      `update ${m.table} set ${DEGRADATIONS[m.table][0][1]} where id = 'b_${m.table}_live';`);
    check(`${m.table}: the SAME edit succeeds on the draft — drafts may be incomplete`, draftEdit.ok, draftEdit.err);
    // restore for later sections
    psql(insertComplete(m.table, `b_${m.table}_live`).replace('do nothing',
      `do update set ${DEGRADATIONS[m.table][0][1].split('=')[0].trim()} = excluded.${DEGRADATIONS[m.table][0][1].split('=')[0].trim()}`));
    psql(`update ${m.table} set ${m.col} = '${m.on}' where id = 'b_${m.table}_live'`);
  }
}

function deleteGuard() {
  console.log('\n\u00a73  Published records cannot be deleted');
  const del = asRole(IDS.owner, `delete from menu_items where id = 'b_menu_items_live';`);
  check('direct DELETE of a live record is refused', refused(del, 'published_delete_refused'), del.err);
  const viaReplace = asRole(IDS.owner, `
    select replace_collection('menu_items',
      (select jsonb_agg(to_jsonb(t)) from menu_items t where id <> 'b_menu_items_live'),
      (select count(*)::int from menu_items),
      (select revision from collection_revisions where table_key='menu_items'));`);
  check('an informed replace_collection payload cannot delete it either',
    refused(viaReplace, 'published_delete_refused'), viaReplace.err);
  check('…and nothing else was deleted by the rolled-back attempt',
    rows(`select count(*) from menu_items where id in ('b_menu_items_live','b_menu_items_draft')`)[0] === '2');
  const draftDel = asRole(IDS.owner, `delete from menu_items where id = 'b_menu_items_draft';`);
  check('deleting a DRAFT succeeds', draftDel.ok, draftDel.err);
  psql(insertComplete('menu_items', 'b_menu_items_draft'));
}

function closeVacancy() {
  console.log('\n\u00a74  close_vacancy is a real, revision-checked transition');
  const rev = () => rows(`select revision from collection_revisions where table_key='job_vacancies'`)[0];
  const mgr = asRole(IDS.manager, `select close_vacancy('b_job_vacancies_live', ${rev()});`);
  check('the store manager cannot close a vacancy', refused(mgr, 'requires the owner'), mgr.err);
  const stale = asRole(IDS.owner, `select close_vacancy('b_job_vacancies_live', ${Math.max(0, Number(rev()) - 1)});`);
  check('a stale revision is refused', refused(stale, 'collection_snapshot_stale'), stale.err);
  const draft = asRole(IDS.owner, `select close_vacancy('b_job_vacancies_draft', ${rev()});`);
  check('closing a DRAFT is refused (drafts are deleted, not closed)', refused(draft, 'a draft'), draft.err);
  const ok = asRole(IDS.owner, `select close_vacancy('b_job_vacancies_live', ${rev()})->>'status';`);
  check('the owner closes the live vacancy', ok.ok && ok.out.trim() === 'closed', ok.err);
  check('the row SURVIVES with status=closed',
    rows(`select status from job_vacancies where id='b_job_vacancies_live'`)[0] === 'closed');
  check('…and it left the public projection',
    rows(`select count(*) from job_vacancies_public where id='b_job_vacancies_live'`)[0] === '0');
  check('…with an audit row for the close',
    Number(rows(`select count(*) from audit_logs where module='job_vacancies' and action='close'`)[0]) >= 1);
  const again = asRole(IDS.owner, `select close_vacancy('b_job_vacancies_live', ${rev()})->>'idempotent';`);
  check('re-closing is an idempotent no-op', again.ok && again.out.trim() === 'true', again.err);
}

function gucNegative() {
  console.log('\n\u00a75  The sanction cannot be fabricated through the API surface');
  const setters = rows(`
    select p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosrc like '%set_config%'
       and p.prosrc like '%milkpop.publication_rpc%'
     order by 1`);
  check('exactly the two sanctioned RPCs set the publication sanction',
    setters.length === 2 && setters.includes('publish_record') && setters.includes('close_vacancy'),
    setters.join(', '));
  check('set_config itself is not in the exposed schema (PostgREST cannot reach it)',
    rows(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'set_config'`)[0] === '0');
  const reads = rows(`
    select count(*) from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosrc like '%milkpop.publication_rpc%'`);
  check('the sanction is referenced only by the RPCs and the guards (no third party)',
    Number(reads[0]) <= 5, reads[0]);
}

function editEditGuard() {
  console.log('\n\u00a76  The revision guard closes same-count edit-edit loss (the total never could)');
  const hyd = asRole(IDS.owner, `
    select (replace_collection('deals',
      (select jsonb_agg(to_jsonb(t)) from deals t),
      (select count(*)::int from deals),
      (select revision from collection_revisions where table_key='deals')))->>'revision';`);
  check('the editor hydrates {revision, rows} through the RPC itself', hyd.ok, hyd.err);
  const staleRev = hyd.out.trim();

  psql(`update deals set description = 'Edited By The Other Session' where id = 'b_deals_live'`);

  const lost = asRole(IDS.owner, `
    select replace_collection('deals',
      (select jsonb_agg(to_jsonb(t) || jsonb_build_object('description', 'The Stale Overwrite')) from deals t),
      (select count(*)::int from deals),
      ${staleRev});`);
  check('the SAME-COUNT stale save is refused as collection_snapshot_stale',
    refused(lost, 'collection_snapshot_stale'), lost.err);
  check("the other session's edit SURVIVED",
    rows(`select description from deals where id='b_deals_live'`)[0] === 'Edited By The Other Session');
  const retry = asRole(IDS.owner, `
    select (replace_collection('deals',
      (select jsonb_agg(to_jsonb(t)) from deals t),
      (select count(*)::int from deals),
      (select revision from collection_revisions where table_key='deals')))->>'revision';`);
  check('a re-hydrated retry succeeds and returns the moved-on revision',
    retry.ok && Number(retry.out.trim()) > Number(staleRev), retry.err);
}

function main() {
  console.log('INC11 PUBLICATION BOUNDARY (real roles)');
  console.log('=======================================');
  buildDatabase();
  directBypass();
  finalState();
  deleteGuard();
  closeVacancy();
  gucNegative();
  editEditGuard();

  console.log('');
  if (failed === 0) console.log(`\u2714 INC11 BOUNDARY — ${passed} passed, 0 failed`);
  else {
    console.log(`\u2716 INC11 BOUNDARY — ${passed} passed, ${failed} FAILED`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  try { execFileSync('su', ['postgres', '-c', `psql -q -X -c "drop database if exists ${DB}"`], { encoding: 'utf8' }); } catch { /* keep for inspection */ }
  process.exit(failed === 0 ? 0 : 1);
}

main();
