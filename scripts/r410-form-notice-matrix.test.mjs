#!/usr/bin/env node
/**
 * ============================================================================
 *  R4.10 — THE FORM-NOTICE MATRIX, AT RUNTIME
 * ============================================================================
 *
 *  The third external audit's blocker 9. The per-form notice SCOPE was proven
 *  earlier only as a source property of assert_public_form_accept_allowed();
 *  this suite proves the RUNTIME behaviour, all six cells plus the shared
 *  blocker, by attempting the actual INSERTs the public-form Edge Function
 *  performs:
 *
 *                          contact notice   careers notice   franchise notice
 *    contact_messages          gates              —                —
 *    job_applications            —              gates              —
 *    franchise_inquiries         —                —              gates
 *
 *  and notification_recipient gates ALL THREE (it is where submissions are
 *  delivered — accepting mail nobody will receive is the failure the R4.8
 *  gate exists to prevent).
 *
 *  Phasing: publish the three notices ONE AT A TIME and reprobe all three
 *  forms after each step — that a form starts working the moment ITS notice
 *  is published, while the other two keep refusing and NAME ONLY THEIR OWN
 *  notice, is the whole point of per-form scope.
 *
 *  Run:  npm run test:r410-form-matrix
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.MP_FORMS_DB || 'mp_r410_forms';
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
const psql = (sql) => { const r = tryPsql(sql); if (!r.ok) throw new Error(r.err); return r.out; };
const rows = (sql) => psql(sql).split('\n').map((s) => s.trim()).filter(Boolean);

const FORMS = [
  { table: 'contact_messages',    kind: 'contact'   },
  { table: 'job_applications',    kind: 'careers'   },
  { table: 'franchise_inquiries', kind: 'franchise' },
];
let seq = 0;
const attempt = (table) => {
  seq += 1;
  return tryPsql(`insert into ${table} (id, full_name, email)
                  values ('fm_${table}_${seq}', 'Form Matrix', 'fm@milkpop.uk')`);
};

/** A refusal must name the form's OWN notice and NEITHER of the other two. */
function refusesNamingOwn(r, ownKind) {
  const others = FORMS.map((f) => f.kind).filter((k) => k !== ownKind);
  return !r.ok
    && r.err.includes('form_accept_blocked')
    && r.err.includes(`privacy_notice_${ownKind}`)
    && others.every((k) => !r.err.includes(`privacy_notice_${k}`));
}

const publishNotice = (kind) =>
  psql(`insert into privacy_notice_versions (audience, version_label, notice_text, published_at)
        values ('${kind}', 'v1-${kind}', 'How we handle your ${kind} data.', now())`);

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
  psql(`update launch_settings set notification_recipient = 'inbox@milkpop.uk' where id`);
}

function phase1_noNotices() {
  console.log('\n\u00a71  Recipient set, NO notices published: every form refuses, naming only its own notice');
  for (const f of FORMS) {
    const r = attempt(f.table);
    check(`${f.table} refuses naming privacy_notice_${f.kind} and neither of the others`,
      refusesNamingOwn(r, f.kind), r.err);
  }
}

function phase2_oneAtATime() {
  for (const publishing of FORMS) {
    console.log(`\n\u00a72  Publish the ${publishing.kind} notice \u2192 reprobe all three forms`);
    publishNotice(publishing.kind);
    for (const f of FORMS) {
      const unlocked = FORMS.indexOf(f) <= FORMS.indexOf(publishing);
      const r = attempt(f.table);
      if (unlocked) {
        check(`${f.table} now ACCEPTS (its notice is published)`, r.ok, r.err);
      } else {
        check(`${f.table} STILL refuses, naming only privacy_notice_${f.kind}`,
          refusesNamingOwn(r, f.kind), r.err);
      }
    }
  }
  check('every accepted submission actually landed',
    rows(`select (select count(*) from contact_messages where full_name = 'Form Matrix')
                 + (select count(*) from job_applications where full_name = 'Form Matrix')
                 + (select count(*) from franchise_inquiries where full_name = 'Form Matrix')`)[0] === '6');
}

function phase3_sharedBlocker() {
  console.log('\n\u00a73  The SHARED blocker: a blank notification_recipient closes all three forms');
  psql(`update launch_settings set notification_recipient = '' where id`);
  for (const f of FORMS) {
    const r = attempt(f.table);
    check(`${f.table} refuses naming notification_recipient`,
      !r.ok && r.err.includes('form_accept_blocked') && r.err.includes('notification_recipient'), r.err);
  }
  psql(`update launch_settings set notification_recipient = 'inbox@milkpop.uk' where id`);
  const again = attempt('contact_messages');
  check('restoring the recipient reopens acceptance immediately', again.ok, again.err);
}

function main() {
  console.log('R4.10 FORM-NOTICE MATRIX (runtime)');
  console.log('==================================');
  buildDatabase();
  phase1_noNotices();
  phase2_oneAtATime();
  phase3_sharedBlocker();

  console.log('');
  if (failed === 0) console.log(`\u2714 R4.10 FORM MATRIX — ${passed} passed, 0 failed`);
  else {
    console.log(`\u2716 R4.10 FORM MATRIX — ${passed} passed, ${failed} FAILED`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  try { execFileSync('su', ['postgres', '-c', `psql -q -X -c "drop database if exists ${DB}"`], { encoding: 'utf8' }); } catch { /* leave for inspection */ }
  process.exit(failed === 0 ? 0 : 1);
}

main();
