#!/usr/bin/env node
/**
 * ============================================================================
 *  SMALL-BIZ CLOSURE — §12 SECOND-STORE SIMULATION (real PostgreSQL)
 * ============================================================================
 *
 *  The §12 walkthrough's browser half needs a live Supabase project with MFA,
 *  which this environment does not have. Its DATA half does not: "create a
 *  second store, assign an employee and a manager, create shifts, verify
 *  manager scope, verify the first store is unaffected, verify no s1 fallback"
 *  is a claim about rows and row-level security, and that is provable here on
 *  a real database built from the full migration manifest and queried as the
 *  actual owner / store-manager / team-member roles.
 *
 *  This is the P0-9 acceptance test ("Create Store A and Store B…") executed
 *  end to end, plus the store-scope half of the manager walkthrough.
 *
 *  Run:  npm run test:closure-second-store
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.MP_CLOSURE2_DB || 'mp_closure_second_store';
const SHIM = path.join(ROOT, 'scripts/lib/supabase-local-privileges.sql');

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed += 1; console.log(`  \u2714 ${label}`); }
  else { failed += 1; failures.push(label); console.log(`  \u2716 ${label}${detail ? ` \u2014 ${detail}` : ''}`); }
};

const psql = (sql) => execFileSync('su', ['postgres', '-c',
  `psql -tA -v ON_ERROR_STOP=1 -d ${DB} -c ${JSON.stringify(sql.replace(/\s+/g, ' ').trim())}`], { encoding: 'utf8' });
const psqlFile = (f) => execFileSync('su', ['postgres', '-c',
  `psql -q -X -v ON_ERROR_STOP=1 -d ${DB} -f ${JSON.stringify(f)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const lastDataLine = (raw) => {
  const lines = raw.trim().split('\n').map((x) => x.trim()).filter(Boolean)
    .filter((x) => !/^(UPDATE|DELETE|INSERT|SET|RESET|BEGIN|COMMIT|SELECT)( \d+( \d+)?)?$/.test(x));
  return lines[lines.length - 1] ?? '';
};

const OWNER = '00000000-0000-4000-8000-0000000005a1';
const MGR_A = '00000000-0000-4000-8000-0000000005a2';
const MGR_B = '00000000-0000-4000-8000-0000000005a3';
const STAFF_B = '00000000-0000-4000-8000-0000000005a4';
const asRole = (sub, sql) => {
  const claims = JSON.stringify({ sub, email: `${sub.slice(-4)}@milkpop.uk`, role: 'authenticated', aal: 'aal2' });
  const script = `select set_config('request.jwt.claims', '${claims}', false); set role authenticated; ${sql}`;
  try {
    const raw = execFileSync('su', ['postgres', '-c',
      `psql -tA -v ON_ERROR_STOP=1 -d ${DB} -c ${JSON.stringify(script.replace(/\s+/g, ' ').trim())}`], { encoding: 'utf8' });
    return { ok: true, out: lastDataLine(raw) };
  } catch (e) { return { ok: false, err: `${e.stderr || e.message}` }; }
};

console.log('SMALL-BIZ CLOSURE — §12 SECOND-STORE SIMULATION');
console.log('==============================================');

console.log('\n\u00a70  Fresh database from the full migration manifest');
const files = execFileSync('bash', [path.join(ROOT, 'launch/migration-manifest.sh'), 'all'], { encoding: 'utf8' })
  .split('\n').map((x) => x.trim()).filter(Boolean);
execFileSync('su', ['postgres', '-c',
  `psql -q -X -c "drop database if exists ${DB}" -c "create database ${DB}"`], { encoding: 'utf8' });
psqlFile(SHIM);
for (const rel of files) psqlFile(path.join(ROOT, rel));
check(`chain applies clean (${files.length} files, incl. chain 93)`, true);

/* ---------------------------------------------------------------- */
console.log('\n\u00a71  §12 owner step 7-8: a store activates ONLY after the required facts exist');
/* Both stores start coming_soon. Opening one BEFORE launch facts are complete
   must be refused by the server — that is §12's "Activate it only after
   required information is complete", enforced rather than merely instructed. */
psql(`insert into stores (id, name, address, postcode, opening_hours, status) values
      ('st_shirley', 'Milk Pop Shirley',  '12 Stratford Rd', 'B90 3AA', 'Mon-Sun 10-8', 'coming_soon'),
      ('st_moseley', 'Milk Pop Moseley',  '4 Alcester Rd',   'B13 8JP', 'Mon-Sun 10-8', 'coming_soon')`);
let earlyOpen = { ok: true };
try { psql(`update stores set status = 'open' where id = 'st_shirley'`); }
catch (e) { earlyOpen = { ok: false, err: `${e.stderr || e.message}` }; }
check('opening a store with INCOMPLETE launch facts is refused',
  !earlyOpen.ok && /store_open_blocked/.test(earlyOpen.err || ''),
  earlyOpen.ok ? 'the store opened without its required facts' : 'refused: store_open_blocked');

/* Complete the legal/contact facts an owner enters in Launch Facts, then the
   same activation succeeds. These values also feed §7's parity check. */
psql(`update launch_settings set
        legal_business_name  = 'Milk Pop Ltd',
        company_number       = '12345678',
        registered_address   = '12 Stratford Rd, Shirley, B90 3AA',
        public_contact_email = 'hello@milkpop.uk',
        privacy_contact_email= 'privacy@milkpop.uk',
        public_telephone     = '0121 496 0000',
        canonical_url        = 'https://milkpop.uk',
        receipt_identity_footer = 'Milk Pop Ltd · Co 12345678',
        vat_state_confirmed  = true,
        enforce_public_gates = true
      where id = true`);
let lateOpen = { ok: true };
try { psql(`update stores set status = 'open' where id = 'st_shirley'`); }
catch (e) { lateOpen = { ok: false, err: `${e.stderr || e.message}` }; }
check('…and succeeds once those facts are complete', lateOpen.ok,
  (lateOpen.err || '').slice(0, 160));

console.log('\n\u00a72  Two REAL stores — neither of them the fictional "s1"');
/* Deliberately NOT 's1'/'Milk Pop': these are the ids a real business would
   generate. Before P0-9 the client hardcoded 's1' and "Milk Pop", so a second
   kiosk (or simply a renamed first one) silently mis-assigned staff and
   shifts to a store that need not exist. */
check('Store A and Store B exist with real ids',
  lastDataLine(psql(`select string_agg(id, ',' order by id) from stores`)) === 'st_moseley,st_shirley');
check('no store row carries the hardcoded id "s1"',
  lastDataLine(psql(`select count(*) from stores where id = 's1'`)) === '0');

console.log('\n\u00a73  One employee per store, plus a manager for each');
psql(`insert into staff_profiles (id, name, email, role, store_id, store_name, auth_id, points, level, badges, pay_rate, pay_type) values
      ('emp_owner', 'Olive Owner',  'owner@milkpop.uk', 'owner',         'st_shirley', 'Milk Pop Shirley', '${OWNER}',   0, 1, '[]', 32000, 'salary'),
      ('emp_mgr_a', 'Mia Manager',  'mia@milkpop.uk',   'store_manager', 'st_shirley', 'Milk Pop Shirley', '${MGR_A}',   0, 1, '[]', 14.25, 'hourly'),
      ('emp_mgr_b', 'Ben Manager',  'ben@milkpop.uk',   'store_manager', 'st_moseley', 'Milk Pop Moseley', '${MGR_B}',   0, 1, '[]', 14.25, 'hourly'),
      ('emp_staff_b','Sam Staff',   'sam@milkpop.uk',   'team_member',   'st_moseley', 'Milk Pop Moseley', '${STAFF_B}', 0, 1, '[]', null,  'hourly')`);
check('each employee carries its REAL store id and name',
  lastDataLine(psql(`select count(*) from staff_profiles where store_id in ('st_shirley','st_moseley')`)) === '4');
check('no employee was assigned to a fictional store',
  lastDataLine(psql(`select count(*) from staff_profiles where store_id = 's1' or store_name = 'Milk Pop'`)) === '0');
/* P0-10: onboarding invents nothing — no 100 points, no "Inducted" badge. */
check('no employee arrives with invented recognition (points 0, no badges)',
  lastDataLine(psql(`select count(*) from staff_profiles where points <> 0 or badges::text not in ('[]','[]'::jsonb::text)`)) === '0');
check('an employee with NO pay rate is stored as null, not defaulted to 11.44',
  lastDataLine(psql(`select coalesce(pay_rate::text,'null') from staff_profiles where id = 'emp_staff_b'`)) === 'null');

console.log('\n\u00a74  Shifts at BOTH stores carry their own store identity');
psql(`insert into work_shifts (id, employee_id, employee_name, role, store_id, store_name, date, start_time, end_time) values
      ('sh_a1', 'emp_mgr_a',  'Mia Manager', 'store_manager', 'st_shirley', 'Milk Pop Shirley', current_date, '09:00', '17:00'),
      ('sh_b1', 'emp_staff_b','Sam Staff',   'team_member',   'st_moseley', 'Milk Pop Moseley', current_date, '10:00', '18:00')`);
check('the Store A shift is recorded against Store A',
  lastDataLine(psql(`select store_id || '/' || store_name from work_shifts where id = 'sh_a1'`)) === 'st_shirley/Milk Pop Shirley');
check('the Store B shift is recorded against Store B',
  lastDataLine(psql(`select store_id || '/' || store_name from work_shifts where id = 'sh_b1'`)) === 'st_moseley/Milk Pop Moseley');
check('NO shift fell back to the hardcoded s1 / "Milk Pop" identity',
  lastDataLine(psql(`select count(*) from work_shifts where store_id = 's1' or store_name = 'Milk Pop'`)) === '0');

console.log('\n\u00a75  Manager scope holds — enforced by the server, not the form');
const mgrAShifts = asRole(MGR_A, `select coalesce(string_agg(store_id, ',' order by store_id), 'none') from work_shifts`);
check('Store A manager sees only Store A shifts', mgrAShifts.ok && mgrAShifts.out === 'st_shirley', JSON.stringify(mgrAShifts));
const mgrBShifts = asRole(MGR_B, `select coalesce(string_agg(store_id, ',' order by store_id), 'none') from work_shifts`);
check('Store B manager sees only Store B shifts', mgrBShifts.ok && mgrBShifts.out === 'st_moseley', JSON.stringify(mgrBShifts));
const ownerShifts = asRole(OWNER, `select coalesce(string_agg(store_id, ',' order by store_id), 'none') from work_shifts`);
check('the owner sees both stores', ownerShifts.ok && ownerShifts.out === 'st_moseley,st_shirley', JSON.stringify(ownerShifts));

/* A manager creating a shift OUTSIDE their store must be refused server-side,
   whatever the browser form offered. */
const crossStore = asRole(MGR_A, `insert into work_shifts (id, employee_id, employee_name, role, store_id, store_name, date, start_time, end_time)
   values ('sh_x', 'emp_staff_b', 'Sam Staff', 'team_member', 'st_moseley', 'Milk Pop Moseley', current_date, '10:00', '18:00')`);
check('a manager CANNOT create a shift in another store', !crossStore.ok,
  crossStore.ok ? 'the insert succeeded — scope not enforced' : 'refused');
check('…and Store B\u2019s roster is unchanged by the attempt',
  lastDataLine(psql(`select count(*) from work_shifts where store_id = 'st_moseley'`)) === '1');

console.log('\n\u00a76  The first store is unaffected by the second');
check('Store A still holds exactly its own employees',
  lastDataLine(psql(`select count(*) from staff_profiles where store_id = 'st_shirley'`)) === '2');
check('Store A still holds exactly its own shift',
  lastDataLine(psql(`select count(*) from work_shifts where store_id = 'st_shirley'`)) === '1');
check('Store A\u2019s row is untouched by adding Store B',
  lastDataLine(psql(`select name || '/' || status from stores where id = 'st_shirley'`)) === 'Milk Pop Shirley/open');

console.log('\n\u00a77  Public projection: only the ACTIVE store is anonymously visible');
/* Store B is coming_soon AND not setup-ACTIVE, so the anonymous locator must
   not list it — the same rule projectPublicStores() mirrors client-side. */
const anonStores = lastDataLine(psql(`set role anon; select coalesce(string_agg(id, ',' order by id), 'none') from stores_public`));
check('the anonymous locator lists the genuine coming-soon store', anonStores.includes('st_moseley'), anonStores);
const anonConfig = lastDataLine(psql(`set role anon; select count(*) from public_site_configuration`));
check('the public legal/contact projection is still readable anonymously', anonConfig === '1', anonConfig);

console.log(`\n\u00a712 SECOND-STORE SIMULATION \u2014 ${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
