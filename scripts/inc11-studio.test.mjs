#!/usr/bin/env node
/**
 * ============================================================================
 *  INC11 — STUDIO ATOMICITY: singleton guard, one-transaction publish, audit
 * ============================================================================
 *
 *  §1 THE GUARD. Direct API-role writes to the three configuration
 *     singletons refuse (singleton_write_refused); deletes refuse for every
 *     API role unconditionally; the superuser (seed/harness) is exempt.
 *  §2 ATOMIC PUBLISH. save_website_studio saves settings + content in ONE
 *     call: both applied, revisions bumped and returned, and a server-side
 *     audit row with the DERIVED actor written in the same transaction.
 *  §3 ATOMICITY UNDER FAILURE. A stale settings revision fails the WHOLE
 *     call — the content part is untouched even though its own revision was
 *     current. The torn two-transaction publish is gone.
 *  §4 REVISION DISCIPLINE. Null expected → collection_revision_required;
 *     non-owner (manager, AAL2) → refused; the seeded ledger rows mean a
 *     first save has a number to echo.
 *  §5 LAUNCH FACTS. save_launch_settings keeps partial-patch semantics
 *     (untouched columns survive), DERIVES updated_by from the caller's
 *     staff row, ignores client attempts to set server-owned columns, and
 *     refuses stale saves. The old direct PATCH path is closed.
 *
 *  Run:  npm run test:inc11-studio
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.MP_INC11S_DB || 'mp_inc11_studio';
const SHIM = path.join(ROOT, 'scripts/lib/supabase-local-privileges.sql');

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed += 1; console.log(`  \u2714 ${label}`); }
  else { failed += 1; failures.push(label); console.log(`  \u2716 ${label}${detail ? ` — ${detail}` : ''}`); }
};

function psql(sql, opts = {}) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return execFileSync('su', ['postgres', '-c',
    `psql -tA -v ON_ERROR_STOP=1 -d ${opts.db || DB} -c ${JSON.stringify(oneLine)}`], { encoding: 'utf8' });
}
const tryPsql = (sql) => { try { return { ok: true, out: psql(sql) }; } catch (e) { return { ok: false, err: `${e.stderr || e.message}` }; } };
const rows = (sql) => psql(sql).split('\n').map((x) => x.trim()).filter(Boolean);
const psqlFile = (file) => execFileSync('su', ['postgres', '-c',
  `psql -q -X -v ON_ERROR_STOP=1 -d ${DB} -f ${JSON.stringify(file)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const lastDataLine = (raw) => {
  const lines = raw.trim().split('\n').map((x) => x.trim()).filter(Boolean)
    .filter((x) => !/^(UPDATE|DELETE|INSERT|SET|RESET|BEGIN|COMMIT|SELECT)( \d+( \d+)?)?$/.test(x));
  return lines[lines.length - 1] ?? '';
};
const OWNER = '00000000-0000-4000-8000-00000000ab1e';
const MGR = '00000000-0000-4000-8000-00000000ab2e';
const asRole = (sub, sql) => {
  const claims = JSON.stringify({ sub, email: `${sub.slice(-4)}@milkpop.uk`, role: 'authenticated', aal: 'aal2' });
  const script = `select set_config('request.jwt.claims', '${claims}', false); set role authenticated; ${sql}`;
  try {
    const raw = execFileSync('su', ['postgres', '-c',
      `psql -tA -v ON_ERROR_STOP=1 -d ${DB} -c ${JSON.stringify(script.replace(/\s+/g, ' ').trim())}`], { encoding: 'utf8' });
    return { ok: true, out: lastDataLine(raw) };
  } catch (e) { return { ok: false, err: `${e.stderr || e.message}` }; }
};
const asOwner = (sql) => asRole(OWNER, sql);
const asMgr = (sql) => asRole(MGR, sql);
const refused = (r, needle) => !r.ok && r.err.includes(needle);
const rev = (key) => Number(rows(`select revision from collection_revisions where table_key='${key}'`)[0]);

function buildDatabase() {
  console.log('\n\u00a70  Fresh database from launch/migration-manifest.sh');
  const files = execFileSync('bash', [path.join(ROOT, 'launch/migration-manifest.sh'), 'all'], { encoding: 'utf8' })
    .split('\n').map((x) => x.trim()).filter(Boolean);
  execFileSync('su', ['postgres', '-c',
    `psql -q -X -c "drop database if exists ${DB}" -c "create database ${DB}"`], { encoding: 'utf8' });
  psqlFile(SHIM);
  for (const rel of files) psqlFile(path.join(ROOT, rel));
  check(`chain applies clean (${files.length} files)`, true);
  psql(`insert into stores (id, name, address, postcode, opening_hours, status)
        values ('st_s', 'Studio Store', '3 Test Way', 'B2 2AB', 'Mon-Sun 9-5', 'coming_soon') on conflict (id) do nothing`);
  psql(`insert into staff_profiles (id, name, email, role, store_id, auth_id, status) values
        ('sp_s_owner', 'Stella Owner', 'ab1e@milkpop.uk', 'owner', 'st_s', '${OWNER}', 'active'),
        ('sp_s_mgr',   'Mia Manager',  'ab2e@milkpop.uk', 'store_manager', 'st_s', '${MGR}', 'active')
        on conflict (id) do nothing`);
}

function s1_guard() {
  console.log('\n\u00a71  Direct API writes are closed; deletes refuse; superuser exempt');
  const upd = asOwner(`update site_settings set brand_name = 'sidestep' where id = 1;`);
  check('owner direct UPDATE of site_settings refuses (singleton_write_refused)',
    refused(upd, 'singleton_write_refused'), upd.err);
  const ins = asOwner(`insert into site_content (id) values (2);`);
  check('owner direct INSERT into site_content refuses',
    refused(ins, 'singleton_write_refused'), ins.err);
  const patch = asOwner(`update launch_settings set notification_recipient = 'sidestep@x.cc' where id = true;`);
  check('the old direct launch_settings PATCH path is closed',
    refused(patch, 'singleton_write_refused'), patch.err);
  const del = asOwner(`delete from site_settings where id = 1;`);
  check('owner DELETE of a configuration singleton refuses (singleton_delete_refused)',
    refused(del, 'singleton_delete_refused'), del.err);
  const su = tryPsql(`update launch_settings set notification_recipient = 'harness@example.invalid' where id`);
  check('superuser (seed/harness) writes remain exempt', su.ok, su.err);
}

function s2_atomic_publish() {
  console.log('\n\u00a72  One call saves both parts, bumps revisions, audits with the derived actor');
  const sRev = rev('site_settings'); const cRev = rev('site_content');
  const r = asOwner(`select save_website_studio(
      '{"brand_name":"Milk Pop Studio"}'::jsonb,
      '{"footer": {"line": "studio footer"}}'::jsonb,
      ${sRev}, ${cRev});`);
  check('the combined publish succeeds', r.ok, r.err);
  check('…both revisions bumped and returned',
    r.ok && r.out.includes(`"settings_revision": ${sRev + 1}`) && r.out.includes(`"content_revision": ${cRev + 1}`), r.out);
  check('…settings applied', rows(`select brand_name from site_settings where id=1`)[0] === 'Milk Pop Studio');
  check('…content applied', rows(`select footer->>'line' from site_content where id=1`)[0] === 'studio footer');
  check('…ONE audit row, actor DERIVED from the caller\u2019s staff row',
    rows(`select count(*) || '|' || max(operator_name) from audit_logs
           where module = 'Website Studio' and action like 'Published Website Studio changes%'`)[0]
      === '1|Stella Owner');
}

function s3_atomicity_under_failure() {
  console.log('\n\u00a73  A stale part fails the WHOLE call — no torn publish');
  const cRev = rev('site_content');
  const before = rows(`select footer->>'line' from site_content where id=1`)[0];
  const r = asOwner(`select save_website_studio(
      '{"brand_name":"Torn"}'::jsonb,
      '{"footer": {"line": "must not land"}}'::jsonb,
      ${rev('site_settings') - 1}, ${cRev});`);
  check('stale settings revision refuses (collection_snapshot_stale)',
    refused(r, 'collection_snapshot_stale'), r.err);
  check('…and the CONTENT part did not land either (atomic rollback)',
    rows(`select footer->>'line' from site_content where id=1`)[0] === before
      && rows(`select brand_name from site_settings where id=1`)[0] === 'Milk Pop Studio');
  check('…revisions unchanged', rev('site_content') === cRev);
}

function s4_revision_discipline() {
  console.log('\n\u00a74  Null expected refuses; non-owner refuses');
  const r = asOwner(`select save_website_studio('{"brand_name":"NoRev"}'::jsonb, null, null, null);`);
  check('null expected revision refuses (collection_revision_required)',
    refused(r, 'collection_revision_required'), r.err);
  const m = asMgr(`select save_website_studio('{"brand_name":"Mgr"}'::jsonb, null, ${rev('site_settings')}, null);`);
  check('a manager (even AAL2) is refused (studio_owner_only)', refused(m, 'studio_owner_only'), m.err);
  const e = asOwner(`select save_website_studio(null, null, null, null);`);
  check('an empty save refuses (studio_empty_save)', refused(e, 'studio_empty_save'), e.err);
}

function s5_launch_facts() {
  console.log('\n\u00a75  Launch facts: patch semantics, derived updated_by, server-owned columns');
  psql(`update launch_settings set legal_business_name = 'Milk Pop Ltd',
        public_contact_email = 'hello@milkpop.uk' where id = true`);
  const lRev = rev('launch_settings');
  const r = asOwner(`select save_launch_settings(
      '{"public_telephone":"0121 000 0000","updated_by":"client-forged"}'::jsonb, ${lRev});`);
  check('the patch save succeeds and returns the new revision',
    r.ok && r.out.includes(`"revision": ${lRev + 1}`), r.ok ? r.out : r.err);
  check('…patched column applied',
    rows(`select public_telephone from launch_settings where id=true`)[0] === '0121 000 0000');
  check('…UNTOUCHED columns survive (partial-patch semantics)',
    rows(`select legal_business_name || '|' || public_contact_email from launch_settings where id=true`)[0]
      === 'Milk Pop Ltd|hello@milkpop.uk');
  check('…updated_by DERIVED from the staff row, client forgery ignored',
    rows(`select updated_by from launch_settings where id=true`)[0] === 'Stella Owner');
  const stale = asOwner(`select save_launch_settings('{"public_telephone":"0"}'::jsonb, ${lRev});`);
  check('a stale launch-facts save refuses', refused(stale, 'collection_snapshot_stale'), stale.err);
  const mgr = asMgr(`select save_launch_settings('{"public_telephone":"1"}'::jsonb, ${rev('launch_settings')});`);
  check('a manager is refused (launch_settings_owner_only)',
    refused(mgr, 'launch_settings_owner_only'), mgr.err);
  const junk = asOwner(`select save_launch_settings('{"no_such_column":"x"}'::jsonb, ${rev('launch_settings')});`);
  check('a patch with no known columns refuses (singleton_empty_payload)',
    refused(junk, 'singleton_empty_payload'), junk.err);
}

function main() {
  console.log('INC11 STUDIO ATOMICITY');
  console.log('======================');
  buildDatabase();
  s1_guard();
  s2_atomic_publish();
  s3_atomicity_under_failure();
  s4_revision_discipline();
  s5_launch_facts();
  console.log('');
  if (failed === 0) console.log(`\u2714 INC11 STUDIO ATOMICITY — ${passed} passed, 0 failed`);
  else {
    console.log(`\u2716 INC11 STUDIO ATOMICITY — ${passed} passed, ${failed} FAILED`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  try { execFileSync('su', ['postgres', '-c', `psql -q -X -c "drop database if exists ${DB}"`], { encoding: 'utf8' }); } catch { /* keep */ }
  process.exit(failed === 0 ? 0 : 1);
}

main();
