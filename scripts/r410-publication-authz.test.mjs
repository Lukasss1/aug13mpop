#!/usr/bin/env node
/**
 * ============================================================================
 *  R4.10 — PUBLICATION AUTHORISATION MATRIX, EXECUTED AS THE REAL DATABASE ROLE
 * ============================================================================
 *
 *  WHY THIS SUITE EXISTS
 *  ---------------------
 *  The previous publication matrix (r410-publish-record.test.mjs) ran every
 *  statement as the PostgreSQL superuser. It set fake JWT claims, but it never
 *  switched to the `authenticated` role — and superusers bypass row-level
 *  security entirely. The third external audit's verdict was exact: that
 *  result proves the function's SQL works; it does not prove a real owner or
 *  store manager can use it through production permissions.
 *
 *  So every permission assertion here runs through the real boundary:
 *
 *      select set_config('request.jwt.claims', <claims>, false);
 *      set role authenticated;      -- or: set role anon
 *      ... the calls under test ...
 *
 *  RLS applies, EXECUTE grants apply, SECURITY INVOKER means what it says.
 *  Superuser statements appear ONLY as fixtures and as out-of-band
 *  verification (view membership, audit counts) — never as the subject.
 *
 *  THE MATRIX (the audit's own list)
 *  ---------------------------------
 *    anonymous                     → denied, every collection
 *    owner  @ AAL1                 → denied
 *    owner  @ AAL2                 → allowed, all six, both directions
 *    store_manager @ AAL1          → denied
 *    store_manager @ AAL2          → menu_items allowed, both directions
 *    store_manager @ AAL2          → the other five denied, each naming the owner
 *    disabled employee @ AAL2      → denied
 *    unsupported table             → denied
 *    nonexistent record            → denied
 *    incomplete record             → publish refused; unpublish still allowed
 *    every publish                 → audit row written, public projection gains the row
 *    every unpublish               → audit row written, public projection loses the row
 *    unrelated records             → untouched throughout
 *
 *  INC11 REPOINT (recorded, not a weakening): the matrix now covers the FOUR
 *  collections that actually decide public output — media_assets and
 *  cms_pages left the publication boundary (byte visibility / no public
 *  route; supersession note in migration_inc11_publication_scope.sql). This
 *  suite gains the proof that publish_record REFUSES both retired tables
 *  with the supersession message, for every session that used to be allowed.
 *
 *  Run:  npm run test:r410-authz
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PUBLICATION_MATRIX, RETIRED_PUBLICATION_TABLES, insertComplete } from './lib/publication-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.MP_AUTHZ_DB || 'mp_r410_authz';
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

/* ------------------------------------------------------------------------- */
/*  Sessions: everything after the claims + SET ROLE runs as that API role.  */
/* ------------------------------------------------------------------------- */
const IDS = {
  owner: '00000000-0000-4000-8000-00000000000a',
  manager: '00000000-0000-4000-8000-00000000000b',
  disabled: '00000000-0000-4000-8000-00000000000c',
};
const claims = (sub, aal) =>
  JSON.stringify({ sub, email: `${aal}.${sub.slice(-1)}@milkpop.uk`, role: 'authenticated', aal });

/** Run `sql` as the given API role with the given claims, in ONE session.
 *  Returns { ok, out, err }. */
function asRole(role, jwtClaims, sql) {
  const script = `
    ${jwtClaims ? `select set_config('request.jwt.claims', '${jwtClaims}', false);` : ''}
    set role ${role};
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
const deniedWith = (r, needle) => !r.ok && (needle ? r.err.includes(needle) : true);

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

function fixtures() {
  console.log('\n\u00a71  Fixtures (superuser): three staff identities and complete draft rows');
  psql(`insert into stores (id, name, address, postcode, opening_hours, status)
        values ('st_authz', 'Authz Store', '1 Test Way', 'B1 1AA', 'Mon-Sun 9-5', 'coming_soon')
        on conflict (id) do nothing`);
  psql(`insert into staff_profiles (id, name, email, role, store_id, auth_id, status) values
          ('sp_owner',   'Olive Owner',    'olive@milkpop.uk',  'owner',         'st_authz', '${IDS.owner}',    'active'),
          ('sp_mgr',     'Mandy Manager',  'mandy@milkpop.uk',  'store_manager', 'st_authz', '${IDS.manager}',  'active'),
          ('sp_gone',    'Dana Disabled',  'dana@milkpop.uk',   'store_manager', 'st_authz', '${IDS.disabled}', 'disabled')
        on conflict (id) do nothing`);
  check('owner / store-manager / disabled staff rows exist',
    rows(`select count(*) from staff_profiles where id in ('sp_owner','sp_mgr','sp_gone')`)[0] === '3');

  for (const m of PUBLICATION_MATRIX) {
    psql(insertComplete(m.table, `az_${m.table}`));      // the row each session operates on
    psql(insertComplete(m.table, `bys_${m.table}`));     // the bystander that must stay untouched
  }
  // The deliberately INCOMPLETE draft: a menu item with no image.
  psql(`insert into menu_items (id, name, category, price, image)
        values ('az_incomplete', 'No Image Yet', 'milkshakes', 3.00, '')
        on conflict (id) do nothing`);
  check('every collection holds a complete probe row and a bystander',
    rows(`select count(*) from menu_items where id in ('az_menu_items','bys_menu_items','az_incomplete')`)[0] === '3');
}

function denyMatrix() {
  console.log('\n\u00a72  Refusals, as the real roles');

  const anon = asRole('anon', null, `select publish_record('menu_items', 'az_menu_items', true);`);
  check('anonymous is denied (no EXECUTE for anon)', deniedWith(anon), anon.err);

  const o1 = asRole('authenticated', claims(IDS.owner, 'aal1'),
    `select publish_record('menu_items', 'az_menu_items', true);`);
  check('owner @ AAL1 is denied, naming the second factor', deniedWith(o1, 'AAL2'), o1.err);

  const m1 = asRole('authenticated', claims(IDS.manager, 'aal1'),
    `select publish_record('menu_items', 'az_menu_items', true);`);
  check('store_manager @ AAL1 is denied, naming the second factor', deniedWith(m1, 'AAL2'), m1.err);

  const dis = asRole('authenticated', claims(IDS.disabled, 'aal2'),
    `select publish_record('menu_items', 'az_menu_items', true);`);
  check('a DISABLED employee @ AAL2 is denied (session resolves to no staff)',
    deniedWith(dis, 'active staff account'), dis.err);

  for (const m of PUBLICATION_MATRIX.filter((x) => x.table !== 'menu_items')) {
    const r = asRole('authenticated', claims(IDS.manager, 'aal2'),
      `select publish_record('${m.table}', 'az_${m.table}', true);`);
    check(`store_manager @ AAL2 is denied for ${m.table}, naming the owner`,
      deniedWith(r, 'requires the owner'), r.err);
  }

  const unl = asRole('authenticated', claims(IDS.owner, 'aal2'),
    `select publish_record('payslips', 'x', true);`);
  check('an unsupported table is refused', deniedWith(unl, 'not a publishable collection'), unl.err);

  for (const t of RETIRED_PUBLICATION_TABLES) {
    const r = asRole('authenticated', claims(IDS.owner, 'aal2'),
      `select publish_record('${t}', 'az_${t}', true);`);
    check(`INC11: ${t} is refused with the supersession message (it left the publication scope)`,
      deniedWith(r, 'left the publication scope'), r.err);
  }

  const ghost = asRole('authenticated', claims(IDS.owner, 'aal2'),
    `select publish_record('menu_items', 'no_such_row', true);`);
  check('a nonexistent record is refused', deniedWith(ghost, 'found 0'), ghost.err);

  const inc = asRole('authenticated', claims(IDS.owner, 'aal2'),
    `select publish_record('menu_items', 'az_incomplete', true);`);
  check('an INCOMPLETE record refuses to publish, naming what is missing',
    deniedWith(inc, 'publish_blocked_incomplete') && deniedWith(inc, 'image'), inc.err);

  const incOff = asRole('authenticated', claims(IDS.owner, 'aal2'),
    `select publish_record('menu_items', 'az_incomplete', false);`);
  check('…but UNPUBLISHING the same incomplete record is allowed (retraction never blocked)',
    incOff.ok, incOff.err);
}

function allowMatrix(who, sub, tables, label) {
  console.log(`\n\u00a73  ${label}: publish \u2192 projection \u2192 unpublish \u2192 gone, with audit rows`);
  for (const m of PUBLICATION_MATRIX.filter((x) => tables.includes(x.table))) {
    const id = `az_${m.table}`;
    const before = rows(`select count(*) from audit_logs where module = '${m.table}'`)[0];
    const bystanderBefore = rows(`select ${m.col}::text from ${m.table} where id = 'bys_${m.table}'`)[0];

    const on = asRole('authenticated', claims(sub, 'aal2'),
      `select publish_record('${m.table}', '${id}', true);`);
    check(`${who}: ${m.table} publish succeeds as the real authenticated role`, on.ok, on.err);
    check(`${who}: ${m.table} row APPEARS on ${m.view}`,
      rows(`select count(*) from ${m.view} where id = '${id}'`)[0] === '1');

    const off = asRole('authenticated', claims(sub, 'aal2'),
      `select publish_record('${m.table}', '${id}', false);`);
    check(`${who}: ${m.table} unpublish succeeds`, off.ok, off.err);
    check(`${who}: ${m.table} row LEAVES ${m.view}`,
      rows(`select count(*) from ${m.view} where id = '${id}'`)[0] === '0');

    const after = rows(`select count(*) from audit_logs where module = '${m.table}'`)[0];
    check(`${who}: both operations wrote audit events`, Number(after) - Number(before) >= 2,
      `${before} \u2192 ${after}`);
    const bystanderAfter = rows(`select ${m.col}::text from ${m.table} where id = 'bys_${m.table}'`)[0];
    check(`${who}: the unrelated ${m.table} row is untouched`,
      bystanderBefore === bystanderAfter, `${bystanderBefore} \u2192 ${bystanderAfter}`);
  }
}

function main() {
  console.log('R4.10 PUBLICATION AUTHORISATION MATRIX (real roles)');
  console.log('===================================================');
  buildDatabase();
  fixtures();
  denyMatrix();
  allowMatrix('owner', IDS.owner, PUBLICATION_MATRIX.map((m) => m.table), 'owner @ AAL2, all six collections');
  allowMatrix('store_manager', IDS.manager, ['menu_items'], 'store_manager @ AAL2, menu only');

  console.log('');
  if (failed === 0) console.log(`\u2714 R4.10 PUBLICATION AUTHZ — ${passed} passed, 0 failed`);
  else {
    console.log(`\u2716 R4.10 PUBLICATION AUTHZ — ${passed} passed, ${failed} FAILED`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  try { execFileSync('su', ['postgres', '-c', `psql -q -X -c "drop database if exists ${DB}"`], { encoding: 'utf8' }); } catch { /* leave for inspection */ }
  process.exit(failed === 0 ? 0 : 1);
}

main();
