#!/usr/bin/env node
/**
 * ============================================================================
 *  INC11 — COLLECTION REVISION BOOTSTRAP GUARD                          [P0-3]
 * ============================================================================
 *
 *  The defect: chain 78's revision guard refuses a null expected revision,
 *  and the checkpoint's lazy ledger insert lives inside the SAME transaction
 *  the refusal rolls back — so a collection with no ledger row could never
 *  perform its first save (hydrate nothing → send null → refused → the lazy
 *  row vanishes → repeat forever). Chain 81 seeded the three singletons;
 *  chain 89 (migration_inc11_collection_revision_bootstrap.sql) seeds the
 *  twelve general collections. This suite is the behaviour proof chain 78's
 *  acceptance block promised.
 *
 *  §1 FRESH INSTALLATION — every authoritative key exists immediately on
 *     BOTH install paths (schema+seed+chain AND launch-baseline-v1.sql);
 *     untouched collections sit at revision 0; an EMPTY collection and a
 *     POPULATED collection each perform their first save at revision 0.
 *  §2 HISTORICAL UPGRADE — a genuinely constructed pre-guard database
 *     (business rows inserted BEFORE chain 78 exists, so no ledger rows)
 *     upgraded through chain 88, with one collection advanced to a non-zero
 *     revision by real writes. The PREMISE is asserted, not assumed.
 *  §3 POSITIVE CONTROL — before chain 89 the exact reported loop reproduces
 *     (null → collection_revision_required → no ledger row persists →
 *     repeat); after chain 89 the same legitimate save, stating hydrated
 *     revision 0, succeeds and returns a revision greater than 0.
 *  §4 CONCURRENCY — two sessions save the same collection at revision 0:
 *     exactly one succeeds, exactly one refuses collection_snapshot_stale,
 *     one state is committed, and the ledger equals the winner's returned,
 *     correctly incremented revision.
 *  §5 PRESERVATION — re-applying the bootstrap resets nothing: a revision
 *     at 7 before is at 7 after, and the whole ledger map is unchanged.
 *
 *  NOT fixed here, by design (each would let a client GUESS authoritative
 *  state): the browser does not convert a missing revision to 0; the RPC
 *  does not treat null as 0; no first save is admitted without a stated
 *  revision. The server installs the rows; the client still states what it
 *  hydrated.
 *
 *  Run:  npm run test:inc11-revisions
 */

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.MP_INC11R_DB || 'mp_inc11_revisions';        /* fresh, chain path */
const DBB = `${DB}_base`;                                            /* fresh, baseline path */
const DBU = `${DB}_upgrade`;                                         /* historical upgrade */
const SHIM = path.join(ROOT, 'scripts/lib/supabase-local-privileges.sql');
const BOOTSTRAP = 'migration_inc11_collection_revision_bootstrap.sql';
const GUARD_CHAIN = 'migration_inc11_collection_revisions.sql';

const TWELVE = [
  'menu_items', 'stores', 'job_vacancies', 'kb_articles', 'news_posts',
  'media_assets', 'deals', 'checklist_templates', 'training_courses',
  'training_assessments', 'training_assignments', 'role_permissions',
];
const SINGLETONS = ['site_settings', 'site_content', 'launch_settings'];

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed += 1; console.log(`  \u2714 ${label}`); }
  else { failed += 1; failures.push(label); console.log(`  \u2716 ${label}${detail ? ` \u2014 ${detail}` : ''}`); }
};

function psqlOn(db, sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return execFileSync('su', ['postgres', '-c',
    `psql -tA -v ON_ERROR_STOP=1 -d ${db} -c ${JSON.stringify(oneLine)}`], { encoding: 'utf8' });
}
const rowsOn = (db, sql) => psqlOn(db, sql).split('\n').map((x) => x.trim()).filter(Boolean);
const fileOn = (db, file) => execFileSync('su', ['postgres', '-c',
  `psql -q -X -v ON_ERROR_STOP=1 -d ${db} -f ${JSON.stringify(file)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const lastDataLine = (raw) => {
  const lines = raw.trim().split('\n').map((x) => x.trim()).filter(Boolean)
    .filter((x) => !/^(UPDATE|DELETE|INSERT|SET|RESET|BEGIN|COMMIT|SELECT)( \d+( \d+)?)?$/.test(x));
  return lines[lines.length - 1] ?? '';
};

const OWNER = '00000000-0000-4000-8000-0000000c0ffe';
const asOwnerOn = (db, sql) => {
  const claims = JSON.stringify({ sub: OWNER, email: 'rg@milkpop.uk', role: 'authenticated', aal: 'aal2' });
  const script = `select set_config('request.jwt.claims', '${claims}', false); set role authenticated; ${sql}`;
  try {
    const raw = execFileSync('su', ['postgres', '-c',
      `psql -tA -v ON_ERROR_STOP=1 -d ${db} -c ${JSON.stringify(script.replace(/\s+/g, ' ').trim())}`], { encoding: 'utf8' });
    return { ok: true, out: lastDataLine(raw) };
  } catch (e) { return { ok: false, err: `${e.stderr || e.message}` }; }
};
const refused = (r, needle) => !r.ok && r.err.includes(needle);
const revOn = (db, key) => {
  const r = rowsOn(db, `select revision from collection_revisions where table_key='${key}'`);
  return r.length ? Number(r[0]) : null;
};
const ledgerRowCount = (db, key) =>
  Number(rowsOn(db, `select count(*) from collection_revisions where table_key='${key}'`)[0]);

function manifestAll() {
  return execFileSync('bash', [path.join(ROOT, 'launch/migration-manifest.sh'), 'all'], { encoding: 'utf8' })
    .split('\n').map((x) => x.trim()).filter(Boolean);
}
function createDb(db) {
  execFileSync('su', ['postgres', '-c',
    `psql -q -X -c "drop database if exists ${db}" -c "create database ${db}"`], { encoding: 'utf8' });
  fileOn(db, SHIM);
}
const applyFiles = (db, files) => { for (const rel of files) fileOn(db, path.join(ROOT, rel)); };

function seedOwner(db) {
  /* store_id NULL is legal for an active owner (staff_active_requires_store),
     so the fixture touches NONE of the twelve collections — the revision-0
     assertions above stay honest. */
  psqlOn(db, `insert into staff_profiles (id, name, email, role, store_id, auth_id, status)
              values ('sp_rg_owner', 'Robin Guard', 'rg@milkpop.uk', 'owner', null, '${OWNER}', 'active')
              on conflict (id) do nothing`);
}

/* One-row payload for the EMPTY collection's first save. is_public (the
   lifecycle column) is deliberately absent — replace_collection strips it
   anyway and new rows land unpublished. */
const MEDIA_ROW = `jsonb_build_array(jsonb_build_object(
  'id','ma_rg1','name','Guard Asset','folder','brand','size','1 KB',
  'type','image/png','uploaded_at','2026-07-31',
  'url','https://images.example.invalid/rg.png'))`;

/* ------------------------------------------------------------------------ */
function s1_fresh() {
  console.log('\n\u00a71  FRESH INSTALLATION \u2014 every authoritative key, both install paths');

  const files = manifestAll();
  createDb(DB);
  applyFiles(DB, files);
  check(`chain install applies clean (${files.length} files incl. seed + bootstrap)`, true);

  /* The complete key set, DISCOVERED: every table carrying the bump trigger
     must have a ledger row. A future collection that gains the trigger
     without a seed fails here, not in a browser. */
  const unseeded = rowsOn(DB, `
    select c.relname from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where t.tgname = 'trg_zz_collection_revision' and n.nspname = 'public'
       and not exists (select 1 from collection_revisions cr where cr.table_key = c.relname)
     order by 1`);
  check('every trigger-bearing collection has a ledger row (discovered, not listed)',
    unseeded.length === 0, unseeded.join(', '));

  const missing12 = TWELVE.filter((k) => ledgerRowCount(DB, k) === 0);
  check('all twelve general collection keys exist immediately', missing12.length === 0, missing12.join(', '));
  const missing3 = SINGLETONS.filter((k) => ledgerRowCount(DB, k) === 0);
  check('\u2026and the three singleton keys beside them (the full fifteen)', missing3.length === 0, missing3.join(', '));

  /* news_posts is the one collection the CHAIN ITSELF writes on a seeded
     install: chain 82's slug backfill routes every published null-slug row
     through the stamping trigger, and each touch bumps once. Untouched means
     untouched — the other eleven must be exactly 0, and news_posts must equal
     exactly the backfilled row count (proving nothing ELSE moved it). */
  const backfilled = Number(rowsOn(DB, `select count(*) from news_posts where status = 'published'`)[0]);
  const nonZero = TWELVE.filter((k) => k !== 'news_posts' && revOn(DB, k) !== 0);
  check('each untouched general collection begins at revision 0 (eleven of twelve)', nonZero.length === 0,
    nonZero.map((k) => `${k}=${revOn(DB, k)}`).join(', '));
  check(`news_posts equals the chain-82 slug-backfill touch count exactly (${backfilled})`,
    revOn(DB, 'news_posts') === backfilled, `news_posts=${revOn(DB, 'news_posts')}`);

  /* The second production install path: the canonical baseline snapshot. */
  createDb(DBB);
  fileOn(DBB, path.join(ROOT, 'supabase/launch-baseline-v1.sql'));
  const missingB = [...TWELVE, ...SINGLETONS].filter((k) => ledgerRowCount(DBB, k) === 0);
  check('launch-baseline-v1.sql install carries the same fifteen keys', missingB.length === 0, missingB.join(', '));
  /* On the baseline path VALUES are deterministic (no business data by
     covenant, so nothing bumps): all fifteen must be exactly 0. This is the
     value pin the schema snapshot deliberately does not carry. */
  const nonZeroB = [...TWELVE, ...SINGLETONS].filter((k) => revOn(DBB, k) !== 0);
  check('\u2026every one of the fifteen at revision 0 there (values are deterministic on this path)',
    nonZeroB.length === 0, nonZeroB.map((k) => `${k}=${revOn(DBB, k)}`).join(', '));

  seedOwner(DB);

  /* EMPTY collection, first save: hydrate revision 0 over zero rows. */
  const mediaRev = revOn(DB, 'media_assets');
  const mediaCount = Number(rowsOn(DB, `select count(*) from media_assets`)[0]);
  check('media_assets is empty with hydratable revision 0 (the empty first-save case)',
    mediaRev === 0 && mediaCount === 0, `rev=${mediaRev} rows=${mediaCount}`);
  const eSave = asOwnerOn(DB, `select 'REV=' || ((replace_collection('media_assets',
      ${MEDIA_ROW}, ${mediaCount}, ${mediaRev}))->>'revision');`);
  check('an EMPTY collection performs its first save at expected revision 0', eSave.ok, eSave.err);
  const eRev = eSave.ok ? Number((eSave.out.match(/REV=(\d+)/) || [])[1]) : NaN;
  check('\u2026the returned revision is greater than 0', Number.isFinite(eRev) && eRev > 0, eSave.out);
  check('\u2026and the row landed', rowsOn(DB, `select name from media_assets where id='ma_rg1'`)[0] === 'Guard Asset');

  /* POPULATED collection, first save: the seed loaded kb_articles BEFORE the
     chain armed the trigger, so it holds rows AND sits at revision 0. */
  const kbRev = revOn(DB, 'kb_articles');
  const kbCount = Number(rowsOn(DB, `select count(*) from kb_articles`)[0]);
  check('kb_articles is populated with hydratable revision 0 (the populated first-save case)',
    kbRev === 0 && kbCount > 0, `rev=${kbRev} rows=${kbCount}`);
  const pSave = asOwnerOn(DB, `select 'REV=' || ((replace_collection('kb_articles',
      (select jsonb_agg(to_jsonb(t) || case when t.id = (select min(id) from kb_articles)
         then jsonb_build_object('author', 'First Save Author') else '{}'::jsonb end) from kb_articles t),
      ${kbCount}, ${kbRev}))->>'revision');`);
  check('a POPULATED collection performs its first save at revision 0', pSave.ok, pSave.err);
  const pRev = pSave.ok ? Number((pSave.out.match(/REV=(\d+)/) || [])[1]) : NaN;
  check('\u2026the returned revision is greater than 0', Number.isFinite(pRev) && pRev > 0, pSave.out);
  check('\u2026and the edit landed',
    rowsOn(DB, `select author from kb_articles where id = (select min(id) from kb_articles)`)[0] === 'First Save Author');
}

/* ------------------------------------------------------------------------ */
let dealsRevBefore = null;   /* §2 captures; §5 re-checks after re-application */

function s2_premise_and_s3_before() {
  console.log('\n\u00a72  HISTORICAL UPGRADE \u2014 the pre-guard database, premise asserted');

  const files = manifestAll();
  const idxGuard = files.findIndex((f) => f.endsWith(GUARD_CHAIN));
  const idxBoot = files.findIndex((f) => f.endsWith(BOOTSTRAP));
  check('manifest carries the guard chain and the bootstrap, in that order',
    idxGuard > 0 && idxBoot > idxGuard, `guard@${idxGuard} boot@${idxBoot}`);
  /* SMALL-BIZ CLOSURE repoint (instruction 4: repointed, not weakened).
     `idxBoot === files.length - 1` pinned the bootstrap as the FINAL manifest
     entry — a position in time, broken by ANY legitimate append-only growth
     (chain 90 is the first). The PROTECTIVE intent was that no collection can
     arrive revision-tracked but unseeded; that is asserted DIRECTLY below —
     stronger than "last", true for every future chain — and the bootstrap's
     own discovery acceptance re-enforces it at apply time on every install. */
  for (const f of files.slice(idxBoot + 1)) {
    const sql = readFileSync(path.join(ROOT, f), 'utf8');
    const addsTrigger = /create trigger[^;]{0,200}trg_zz_collection_revision/i.test(sql);
    check(`post-bootstrap ${path.basename(f)} adds no unseeded revision-tracked collection`,
      !addsTrigger || /insert into collection_revisions/i.test(sql));
  }

  /* Positional truncation (the §4 lesson from the view-authority suite): the
     pre-guard database is the chain AS IT STOOD, nothing later applied. */
  createDb(DBU);
  applyFiles(DBU, files.slice(0, idxGuard));

  /* Business rows inserted BEFORE chain 78 exists — no trigger, no ledger.
     This is how every real pre-INC11 row got there. */
  psqlOn(DBU, `insert into kb_articles (id, title, category, content)
               values ('kb_up1', 'Upgrade Article One', 'recipes', 'body one'),
                      ('kb_up2', 'Upgrade Article Two', 'recipes', 'body two')`);
  psqlOn(DBU, `insert into menu_items (id, name, category, price)
               values ('mi_up1', 'Upgrade Shake', 'milkshakes', 4)`);

  /* Upgrade through chain 88 — everything EXCEPT the bootstrap. */
  applyFiles(DBU, files.slice(idxGuard, idxBoot));
  check('upgraded to the state immediately before the new migration (chain 88)', true);

  /* One collection advanced to a NON-ZERO revision by real writes. */
  psqlOn(DBU, `insert into deals (id, name, description, type, active)
               values ('dl_up1', 'Upgrade Deal', 'seed for non-zero revision', 'percent_off_category', false)`);
  psqlOn(DBU, `update deals set description = 'advanced by a second real write' where id = 'dl_up1'`);
  dealsRevBefore = revOn(DBU, 'deals');

  /* THE PREMISE — assert it, never assume it. The pre-guard slice includes
     seed.sql, so counts are seed + fixtures; what matters is rows EXIST and
     the ledger does NOT. */
  check('PREMISE: kb_articles holds business rows (seed + 2 fixtures) yet has NO ledger row',
    Number(rowsOn(DBU, `select count(*) from kb_articles where id like 'kb_up%'`)[0]) === 2
      && Number(rowsOn(DBU, `select count(*) from kb_articles`)[0]) >= 2
      && ledgerRowCount(DBU, 'kb_articles') === 0);
  check('PREMISE: menu_items holds business rows yet has NO ledger row',
    Number(rowsOn(DBU, `select count(*) from menu_items where id = 'mi_up1'`)[0]) === 1
      && ledgerRowCount(DBU, 'menu_items') === 0);
  check('PREMISE: media_assets is empty with NO ledger row',
    Number(rowsOn(DBU, `select count(*) from media_assets`)[0]) === 0 && ledgerRowCount(DBU, 'media_assets') === 0);
  check('PREMISE: deals already holds a NON-ZERO revision from real writes',
    dealsRevBefore !== null && dealsRevBefore > 0, `deals=${dealsRevBefore}`);

  console.log('\n\u00a73a POSITIVE CONTROL, BEFORE \u2014 the reported loop reproduces exactly');
  seedOwner(DBU);

  /* Hydrate the way the browser does: read the ledger as the signed-in role. */
  const hyd = asOwnerOn(DBU, `select coalesce((select revision::text from collection_revisions
                              where table_key='kb_articles'), 'NULL');`);
  check('the browser hydrates NO revision for kb_articles (sends null)', hyd.ok && hyd.out === 'NULL', hyd.out);

  const kbPayload = `(select jsonb_agg(to_jsonb(t)) from kb_articles t)`;
  const first = asOwnerOn(DBU, `select replace_collection('kb_articles', ${kbPayload},
      (select count(*)::int from kb_articles), null::bigint);`);
  check('the save with null is refused (collection_revision_required)',
    refused(first, 'collection_revision_required'), first.err);
  check('\u2026and NO ledger row remains afterwards (the lazy insert rolled back)',
    ledgerRowCount(DBU, 'kb_articles') === 0);
  const again = asOwnerOn(DBU, `select replace_collection('kb_articles', ${kbPayload},
      (select count(*)::int from kb_articles), null::bigint);`);
  check('repeating produces the SAME refusal \u2014 the deadlock, proven',
    refused(again, 'collection_revision_required') && ledgerRowCount(DBU, 'kb_articles') === 0, again.err);
}

function s2_apply_and_s3_after() {
  console.log('\n\u00a72b THE MIGRATION \u2014 missing keys land at 0; nothing else moves');

  const kbHash = rowsOn(DBU, `select md5(string_agg(id || '|' || title || '|' || content, ';' order by id)) from kb_articles`)[0];
  const applied = (() => { try { fileOn(DBU, path.join(ROOT, 'supabase', BOOTSTRAP)); return { ok: true }; } catch (e) { return { ok: false, err: `${e.stderr || e.message}` }; } })();
  check('chain 89 applies clean on the historical database', applied.ok, applied.err);

  const missing = TWELVE.filter((k) => ledgerRowCount(DBU, k) === 0);
  check('all twelve keys now exist', missing.length === 0, missing.join(', '));
  check('missing keys became 0 (kb_articles, menu_items, media_assets)',
    revOn(DBU, 'kb_articles') === 0 && revOn(DBU, 'menu_items') === 0 && revOn(DBU, 'media_assets') === 0);
  check('the NON-ZERO revision is preserved exactly',
    revOn(DBU, 'deals') === dealsRevBefore, `deals=${revOn(DBU, 'deals')} expected=${dealsRevBefore}`);
  check('business rows are unchanged (count + content hash)',
    rowsOn(DBU, `select md5(string_agg(id || '|' || title || '|' || content, ';' order by id)) from kb_articles`)[0] === kbHash);

  console.log('\n\u00a73b POSITIVE CONTROL, AFTER \u2014 the same legitimate save now succeeds');
  const hyd = asOwnerOn(DBU, `select coalesce((select revision::text from collection_revisions
                              where table_key='kb_articles'), 'NULL');`);
  check('the browser now hydrates revision 0', hyd.ok && hyd.out === '0', hyd.out);
  const save = asOwnerOn(DBU, `select 'REV=' || ((replace_collection('kb_articles',
      (select jsonb_agg(to_jsonb(t)) from kb_articles t),
      (select count(*)::int from kb_articles), 0))->>'revision');`);
  check('the SAME first save, stating hydrated revision 0, succeeds', save.ok, save.err);
  const sRev = save.ok ? Number((save.out.match(/REV=(\d+)/) || [])[1]) : NaN;
  check('\u2026the returned revision is greater than 0', Number.isFinite(sRev) && sRev > 0, save.out);

  const eSave = asOwnerOn(DBU, `select 'REV=' || ((replace_collection('media_assets',
      ${MEDIA_ROW}, 0, 0))->>'revision');`);
  check('an EMPTY collection on the UPGRADED database is saveable at 0 too', eSave.ok, eSave.err);
}

/* ------------------------------------------------------------------------ */
async function s4_concurrency() {
  console.log('\n\u00a74  CONCURRENCY \u2014 two sessions, one revision, exactly one winner');

  /* Both sessions hydrate the SAME revision of checklist_templates on the
     fresh database (untouched: still 0) and race. Session A holds its
     transaction open (pg_sleep) after replacing; session B blocks on the
     checkpoint's FOR UPDATE and, when A commits, must see the moved-on
     revision and refuse. */
  const KEY = 'checklist_templates';
  const startRev = revOn(DB, KEY);
  const count = Number(rowsOn(DB, `select count(*) from ${KEY}`)[0]);
  check(`both sessions hydrate ${KEY} at revision ${startRev} over ${count} row(s)`, startRev === 0 && count > 0);

  const claims = JSON.stringify({ sub: OWNER, email: 'rg@milkpop.uk', role: 'authenticated', aal: 'aal2' });
  const marked = (mark) => `(select jsonb_agg(to_jsonb(t) ||
      jsonb_build_object('label', ${mark})) from ${KEY} t)`;
  const sessionSql = (mark, hold) => `
    select set_config('request.jwt.claims', '${claims}', false);
    set role authenticated;
    select 'REV=' || ((replace_collection('${KEY}', ${marked(mark)},
      ${count}, ${startRev}))->>'revision');
    ${hold ? "select pg_sleep(2);" : ''}`.replace(/\s+/g, ' ').trim();

  /* psql -c runs the whole script as ONE transaction — exactly the hold we
     need: A's replace stays uncommitted through the sleep. */
  const a = spawn('su', ['postgres', '-c',
    `psql -tA -v ON_ERROR_STOP=1 -d ${DB} -c ${JSON.stringify(sessionSql("'A committed'", true))}`]);
  let aOut = '', aErr = '';
  a.stdout.on('data', (d) => { aOut += d; });
  a.stderr.on('data', (d) => { aErr += d; });
  const aDone = new Promise((resolve) => a.on('close', (code) => resolve(code)));

  await new Promise((r) => setTimeout(r, 600));  /* A is inside its hold */
  const b = (() => {
    try {
      return { ok: true, out: execFileSync('su', ['postgres', '-c',
        `psql -tA -v ON_ERROR_STOP=1 -d ${DB} -c ${JSON.stringify(sessionSql("'B lost'", false))}`], { encoding: 'utf8' }) };
    } catch (e) { return { ok: false, err: `${e.stderr || e.message}` }; }
  })();
  const aCode = await aDone;

  const aRev = Number((aOut.match(/REV=(\d+)/) || [])[1]);
  check('exactly one success: session A commits its replace', aCode === 0 && Number.isFinite(aRev), aErr);
  check('exactly one collection_snapshot_stale: session B is refused',
    refused(b, 'collection_snapshot_stale'), b.ok ? b.out : b.err);
  check("one committed collection state \u2014 A's, with no trace of B",
    rowsOn(DB, `select count(*) from ${KEY} where label = 'A committed'`)[0] === String(count)
      && rowsOn(DB, `select count(*) from ${KEY} where label = 'B lost'`)[0] === '0');
  check('a correctly incremented revision: ledger equals the winner\u2019s returned value',
    revOn(DB, KEY) === aRev && aRev === startRev + count,
    `ledger=${revOn(DB, KEY)} A=${aRev} expected=${startRev + count} (one bump per replaced row)`);
}

/* ------------------------------------------------------------------------ */
function s5_preservation() {
  console.log('\n\u00a75  PRESERVATION \u2014 re-applying the bootstrap resets nothing');

  psqlOn(DBU, `update collection_revisions set revision = 7 where table_key = 'news_posts'`);
  const before = rowsOn(DBU, `select table_key || '=' || revision from collection_revisions order by table_key`).join(',');
  const reapply = (() => { try { fileOn(DBU, path.join(ROOT, 'supabase', BOOTSTRAP)); return { ok: true }; } catch (e) { return { ok: false, err: `${e.stderr || e.message}` }; } })();
  check('the bootstrap migration re-applies clean (idempotent)', reapply.ok, reapply.err);
  const after = rowsOn(DBU, `select table_key || '=' || revision from collection_revisions order by table_key`).join(',');
  check('revision 7 before \u2192 revision 7 after', revOn(DBU, 'news_posts') === 7, `news_posts=${revOn(DBU, 'news_posts')}`);
  check('the ENTIRE ledger map is byte-identical across the re-application', before === after,
    `before:${before} after:${after}`);
  check('the advanced deals revision from \u00a72 also survived untouched',
    revOn(DBU, 'deals') === dealsRevBefore);
}

/* ------------------------------------------------------------------------ */
async function main() {
  console.log('INC11 COLLECTION REVISION BOOTSTRAP GUARD (P0-3)');
  console.log('================================================');
  s1_fresh();
  s2_premise_and_s3_before();
  s2_apply_and_s3_after();
  await s4_concurrency();
  s5_preservation();
  console.log('');
  if (failed === 0) console.log(`\u2714 INC11 REVISION BOOTSTRAP \u2014 ${passed} passed, 0 failed`);
  else {
    console.log(`\u2716 INC11 REVISION BOOTSTRAP \u2014 ${passed} passed, ${failed} FAILED`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  for (const db of [DB, DBB, DBU]) {
    try { execFileSync('su', ['postgres', '-c', `psql -q -X -c "drop database if exists ${db}"`], { encoding: 'utf8' }); } catch { /* keep */ }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
