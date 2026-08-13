#!/usr/bin/env node
/**
 * ============================================================================
 *  R4.10 — LAUNCH SETTINGS ARE JUDGED AS THE STATE THEY PROPOSE,
 *           AND AN OPEN STORE IS PROTECTED ON EVERY WRITE
 * ============================================================================
 *
 *  The third external audit's blockers 5 and 6, as a behavioural matrix.
 *
 *  BLOCKER 5 — the arming trigger used to read the launch_settings TABLE from
 *  inside BEFORE UPDATE, i.e. the row as it stood BEFORE the statement. Both
 *  failure directions follow from that one cause, and both are asserted here:
 *    • a VALID atomic change was refused  (fill the missing fact AND arm);
 *    • an INVALID atomic change was let through in principle (arm while
 *      blanking a fact — old row valid, new row not).
 *  The candidate-state validator judges NEW, so the first now SUCCEEDS and
 *  the second now FAILS, and the same single definition also decides
 *  degradation while armed — including the telephone → explicit-alternative
 *  swap the Increment 8 field-list guard wrongly refused.
 *
 *  BLOCKER 6 — the open-store gate used to fire only ON UPDATE OF status, so
 *  an update that never mentioned `status` could blank an open store's
 *  address. The invariant now holds on EVERY write whose final state is open.
 *
 *  These are trigger behaviours — identical for every role — so this suite
 *  drives them as the superuser (triggers are not bypassed by superuser; only
 *  RLS is, and RLS is not the subject here). The role-boundary evidence for
 *  this round lives in r410-publication-authz.test.mjs.
 *
 *  Run:  npm run test:r410-launch-candidate
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.MP_LAUNCH_DB || 'mp_r410_launch';
const SHIM = path.join(ROOT, 'scripts/lib/supabase-local-privileges.sql');

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed += 1; console.log(`  \u2714 ${label}`); }
  else { failed += 1; failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  \u2716 ${label}${detail ? ` — ${detail}` : ''}`); }
};

function tryPsql(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  try {
    const out = execFileSync('su', ['postgres', '-c',
      `psql -tA -v ON_ERROR_STOP=1 -d ${DB} -c ${JSON.stringify(oneLine)}`], { encoding: 'utf8' });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, err: `${e.stderr || e.message}` };
  }
}
const psql = (sql) => {
  const r = tryPsql(sql);
  if (!r.ok) throw new Error(r.err);
  return r.out;
};
const rows = (sql) => psql(sql).split('\n').map((s) => s.trim()).filter(Boolean);
const refused = (r, needle) => !r.ok && r.err.includes(needle);

function buildDatabase() {
  console.log('\n\u00a70  Fresh database from launch/migration-manifest.sh');
  const files = execFileSync('bash', [path.join(ROOT, 'launch/migration-manifest.sh'), 'all'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  execFileSync('su', ['postgres', '-c',
    `psql -q -X -c "drop database if exists ${DB}" -c "create database ${DB}"`], { encoding: 'utf8' });
  execFileSync('su', ['postgres', '-c',
    `psql -q -X -v ON_ERROR_STOP=1 -d ${DB} -f ${JSON.stringify(SHIM)}`], { encoding: 'utf8' });
  for (const rel of files) {
    execFileSync('su', ['postgres', '-c',
      `psql -q -X -v ON_ERROR_STOP=1 -d ${DB} -f ${JSON.stringify(path.join(ROOT, rel))}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  check(`chain applies clean (${files.length} files)`, true);
}

const IDENTITY = `legal_business_name = 'Milk Pop Ltd',
  registered_address = '1 Kiosk Way, Birmingham',
  public_contact_email = 'hello@milkpop.uk',
  privacy_contact_email = 'privacy@milkpop.uk',
  public_telephone = '0121 000 0000',
  canonical_url = 'https://milkpop.uk',
  vat_state_confirmed = true,
  receipt_identity_footer = 'Milk Pop Ltd — milkpop.uk'`;

function armingMatrix() {
  console.log('\n\u00a71  Arming judges the PROPOSED state, both directions');

  const blind = tryPsql(`update launch_settings set enforce_public_gates = true where id`);
  check('arming a blank configuration is refused (launch_arm_blocked)',
    refused(blind, 'launch_arm_blocked'), blind.err);

  psql(`update launch_settings set ${IDENTITY} where id`);
  check('filling the identity WITHOUT arming is unrestricted',
    rows(`select legal_business_name from launch_settings`)[0] === 'Milk Pop Ltd');

  // OLD row is now VALID — the trap the audit named: arming must still refuse
  // if the SAME statement degrades a fact, because NEW is what launches.
  const trap = tryPsql(`update launch_settings set canonical_url = '', enforce_public_gates = true where id`);
  check('arming while blanking a fact IN THE SAME STATEMENT is refused — NEW is judged, not OLD',
    refused(trap, 'launch_arm_blocked') && trap.err.includes('canonical_url'), trap.err);
  check('…and the refused statement changed nothing',
    rows(`select canonical_url || '|' || enforce_public_gates::text from launch_settings`)[0] === 'https://milkpop.uk|false');

  // The VALID atomic case that used to fail: blank a fact while disarmed
  // (legal), then fill it and arm in ONE statement.
  psql(`update launch_settings set canonical_url = '' where id`);
  const atomic = tryPsql(`update launch_settings set canonical_url = 'https://milkpop.uk', enforce_public_gates = true where id`);
  check('the ATOMIC fill-and-arm SUCCEEDS — the exact update the old trigger refused',
    atomic.ok, atomic.err);
  check('…gates are armed', rows(`select enforce_public_gates::text from launch_settings`)[0] === 'true');
}

function degradationMatrix() {
  console.log('\n\u00a72  Degradation while armed: one definition, including the telephone swap');

  const blank = tryPsql(`update launch_settings set canonical_url = '' where id`);
  check('blanking a mandatory fact while armed is refused (launch_degrade_blocked)',
    refused(blank, 'launch_degrade_blocked') && blank.err.includes('canonical_url'), blank.err);

  const swap = tryPsql(`update launch_settings set public_telephone = '', telephone_alternative_ok = true where id`);
  check('telephone \u2192 explicit-alternative swap SUCCEEDS while armed — a valid state by THE definition',
    swap.ok, swap.err);
  check('…the swap landed',
    rows(`select public_telephone || '|' || telephone_alternative_ok::text from launch_settings`)[0] === '|true');

  const strip = tryPsql(`update launch_settings set telephone_alternative_ok = false where id`);
  check('withdrawing the alternative while the number is blank is refused',
    refused(strip, 'launch_degrade_blocked') && strip.err.includes('public_telephone'), strip.err);

  const back = tryPsql(`update launch_settings set public_telephone = '0121 000 0000', telephone_alternative_ok = false where id`);
  check('swapping BACK to a real number in one statement succeeds', back.ok, back.err);
}

function storeMatrix() {
  console.log('\n\u00a73  The open-store invariant holds on every write');

  const noHours = tryPsql(`insert into stores (id, name, address, postcode, opening_hours, status)
    values ('st_lc1', 'Kiosk One', '1 Mall Walk', 'B1 1AA', '', 'open')`);
  check('opening without opening hours is refused, naming the row fact',
    refused(noHours, 'store_open_blocked') && noHours.err.includes('opening_hours'), noHours.err);

  psql(`insert into stores (id, name, address, postcode, opening_hours, status)
        values ('st_lc1', 'Kiosk One', '1 Mall Walk', 'B1 1AA', 'Mon-Sun 9-5', 'coming_soon')`);
  const open = tryPsql(`update stores set status = 'open' where id = 'st_lc1'`);
  check('a complete store opens while the gates are armed', open.ok, open.err);

  const blankAddr = tryPsql(`update stores set address = '' where id = 'st_lc1'`);
  check("blanking an OPEN store's address WITHOUT touching status is refused — the audit's exact hole",
    refused(blankAddr, 'store_open_blocked') && blankAddr.err.includes('store_address'), blankAddr.err);

  const blankHours = tryPsql(`update stores set opening_hours = '' where id = 'st_lc1'`);
  check("blanking an OPEN store's hours the same way is refused",
    refused(blankHours, 'store_open_blocked') && blankHours.err.includes('opening_hours'), blankHours.err);

  const benign = tryPsql(`update stores set phone = '0121 111 1111' where id = 'st_lc1'`);
  check('a benign edit to an open store still succeeds (the invariant does not over-block)',
    benign.ok, benign.err);

  const disarm = tryPsql(`update launch_settings set enforce_public_gates = false where id`);
  check('disarming while a storefront is open is refused',
    refused(disarm, 'launch_disarm_blocked'), disarm.err);

  psql(`update stores set status = 'coming_soon' where id = 'st_lc1'`);
  const afterClose = tryPsql(`update stores set address = '' where id = 'st_lc1'`);
  check('once CLOSED, the same store may be incomplete again (drafts stay editable)',
    afterClose.ok, afterClose.err);

  const disarm2 = tryPsql(`update launch_settings set enforce_public_gates = false where id`);
  check('with every storefront closed, disarming succeeds', disarm2.ok, disarm2.err);
}

function disarmedStoreCase() {
  console.log('\n\u00a74  A store cannot open while the gates are disarmed');
  psql(`insert into stores (id, name, address, postcode, opening_hours, status)
        values ('st_lc2', 'Kiosk Two', '2 Mall Walk', 'B2 2BB', 'Mon-Sun 9-5', 'coming_soon')`);
  const open = tryPsql(`update stores set status = 'open' where id = 'st_lc2'`);
  check('opening is refused naming public_form_gates_armed',
    refused(open, 'store_open_blocked') && open.err.includes('public_form_gates_armed'), open.err);
}

function main() {
  console.log('R4.10 LAUNCH CANDIDATE-STATE & OPEN-STORE INVARIANT');
  console.log('===================================================');
  buildDatabase();
  armingMatrix();
  degradationMatrix();
  storeMatrix();
  disarmedStoreCase();

  console.log('');
  if (failed === 0) console.log(`\u2714 R4.10 LAUNCH CANDIDATE — ${passed} passed, 0 failed`);
  else {
    console.log(`\u2716 R4.10 LAUNCH CANDIDATE — ${passed} passed, ${failed} FAILED`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  try { execFileSync('su', ['postgres', '-c', `psql -q -X -c "drop database if exists ${DB}"`], { encoding: 'utf8' }); } catch { /* leave for inspection */ }
  process.exit(failed === 0 ? 0 : 1);
}

main();
