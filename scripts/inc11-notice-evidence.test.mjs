#!/usr/bin/env node
/**
 * ============================================================================
 *  INC11 — NOTICE EVIDENCE: frozen notices, the display/record race, stamps
 * ============================================================================
 *
 *  §1 PUBLISH FREEZES. A published notice version cannot be UPDATEd or
 *     DELETEd by the owner — the most privileged API session there is.
 *     Drafts stay editable and deletable. The freeze stamp (sha256 +
 *     frozen_at) is set server-side at publish.
 *  §2 THE GATE VERIFIES DISPLAY. submit_public_form (7-arg) refuses when no
 *     notice is published (form_notice_missing), when the echoed id/sha do
 *     not match the CURRENT notice (notice_version_changed — including the
 *     exact race where a new version is published between page render and
 *     submit), and stamps notice_id + notice_sha256 + version label into the
 *     accepted row. The FK makes the referenced version undeletable at the
 *     structural level too.
 *  §3 ANON READS THE DISPLAY SURFACE. The privacy_notice_current view is
 *     readable as the real anon role (display is the first link of the
 *     evidence chain); the base table is not.
 *  §4 ACKNOWLEDGEMENTS ARE APPEND-ONLY, and the pre-evidence core is not
 *     executable by browser roles.
 *
 *  Run:  npm run test:inc11-notices
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.MP_INC11N_DB || 'mp_inc11_notices';
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

/* psql -tA still prints DML COMMAND TAGS ("UPDATE 1", "INSERT 0 1", "SET")
 * after any RETURNING rows — found in test: the naive "last line" of a
 * RETURNING statement is the tag, not the data. Strip tag-shaped lines and
 * take the last DATA line instead. */
const lastDataLine = (raw) => {
  const lines = raw.trim().split('\n').map((x) => x.trim()).filter(Boolean)
    .filter((x) => !/^(UPDATE|DELETE|INSERT|SET|RESET|BEGIN|COMMIT|SELECT)( \d+( \d+)?)?$/.test(x));
  return lines[lines.length - 1] ?? '';
};

const OWNER = '00000000-0000-4000-8000-00000000c0de';
const claims = JSON.stringify({ sub: OWNER, email: 'own@milkpop.uk', role: 'authenticated', aal: 'aal2' });
function asOwner(sql) {
  const script = `select set_config('request.jwt.claims', '${claims}', false); set role authenticated; ${sql}`;
  try {
    const raw = execFileSync('su', ['postgres', '-c',
      `psql -tA -v ON_ERROR_STOP=1 -d ${DB} -c ${JSON.stringify(script.replace(/\s+/g, ' ').trim())}`], { encoding: 'utf8' });
    return { ok: true, out: lastDataLine(raw) };
  } catch (e) { return { ok: false, err: `${e.stderr || e.message}` }; }
}
function asAnon(sql) {
  const script = `set role anon; ${sql}`;
  try {
    const raw = execFileSync('su', ['postgres', '-c',
      `psql -tA -v ON_ERROR_STOP=1 -d ${DB} -c ${JSON.stringify(script.replace(/\s+/g, ' ').trim())}`], { encoding: 'utf8' });
    return { ok: true, out: lastDataLine(raw) };
  } catch (e) { return { ok: false, err: `${e.stderr || e.message}` }; }
}
const refused = (r, needle) => !r.ok && r.err.includes(needle);

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
        values ('st_n', 'Notice Store', '2 Test Way', 'B1 1AB', 'Mon-Sun 9-5', 'coming_soon') on conflict (id) do nothing`);
  psql(`insert into staff_profiles (id, name, email, role, store_id, auth_id, status)
        values ('sp_n_owner', 'Olive Owner', 'own@milkpop.uk', 'owner', 'st_n', '${OWNER}', 'active') on conflict (id) do nothing`);
  psql(`update launch_settings set notification_recipient = 'inbox@milkpop.uk' where id`);
}

function s1_freeze() {
  console.log('\n\u00a71  Publish freezes — the owner cannot edit or delete a published version');
  psql(`insert into privacy_notice_versions (id, audience, version_label, notice_text)
        values ('pn_c1', 'contact', 'v1', 'We reply to your message. v1.')`);
  const draftEdit = asOwner(`update privacy_notice_versions set notice_text = 'edited draft' where id = 'pn_c1' returning id;`);
  check('a DRAFT is editable by the owner', draftEdit.ok && draftEdit.out === 'pn_c1', draftEdit.err);

  psql(`update privacy_notice_versions set published_at = now() where id = 'pn_c1'`);
  check('publishing stamped sha + frozen_at server-side',
    rows(`select (content_sha256 is not null and frozen_at is not null)::text
            from privacy_notice_versions where id='pn_c1'`)[0] === 'true');
  check('…and the sha is the sha of the text',
    rows(`select (content_sha256 = encode(digest(notice_text,'sha256'),'hex'))::text
            from privacy_notice_versions where id='pn_c1'`)[0] === 'true');

  const upd = asOwner(`update privacy_notice_versions set notice_text = 'rewritten history' where id = 'pn_c1';`);
  check('UPDATE of the published version is refused (notice_frozen)', refused(upd, 'notice_frozen'), upd.err);
  const del = asOwner(`delete from privacy_notice_versions where id = 'pn_c1';`);
  check('DELETE of the published version is refused (notice_frozen)', refused(del, 'notice_frozen'), del.err);
  check('the frozen text is byte-identical after both attempts',
    rows(`select notice_text from privacy_notice_versions where id='pn_c1'`)[0] === 'edited draft');

  psql(`insert into privacy_notice_versions (id, audience, version_label, notice_text)
        values ('pn_c_draft', 'contact', 'v-draft', 'never published')`);
  const draftDel = asOwner(`delete from privacy_notice_versions where id = 'pn_c_draft' returning id;`);
  check('a DRAFT is deletable by the owner', draftDel.ok && draftDel.out === 'pn_c_draft', draftDel.err);
}

function s2_gate() {
  console.log('\n\u00a72  The gate verifies display and stamps evidence');
  const submit = (kind, name, nid, nsha) => tryPsql(`
    select submit_public_form('${kind}',
      jsonb_build_object('full_name','${name}','email','${name}@x.cc','reason','Other','message','m',
                         'phone','07 000','city','B','budget','£100,000 - £150,000','experience','Single coffee unit'),
      gen_random_uuid(), repeat('a',64), repeat('b',64),
      ${nid}, ${nsha}) ->> 'ok';`);

  const missing = submit('careers', 'M', 'null', 'null');
  check('careers with NO published notice refuses as form_notice_missing',
    refused(missing, 'form_notice_missing'), missing.err);

  psql(`insert into privacy_notice_versions (id, audience, version_label, notice_text, published_at)
        values ('pn_k1', 'careers', 'v1', 'How we handle applications. v1.', now())`);
  const cur = rows(`select id || '|' || content_sha256 from privacy_notice_current where audience='careers'`)[0].split('|');

  const wrong = submit('careers', 'W', `'pn_k1'`, `'not-the-sha'`);
  check('a WRONG sha refuses as notice_version_changed', refused(wrong, 'notice_version_changed'), wrong.err);

  const ok = submit('careers', 'Ann', `'${cur[0]}'`, `'${cur[1]}'`);
  check('the matching echo is ACCEPTED', ok.ok && ok.out.trim() === 'true', ok.err);
  check('…and the row carries notice_id + sha + label as evidence',
    rows(`select (notice_id = 'pn_k1' and notice_sha256 = '${cur[1]}' and notice_version = 'v1')::text
            from job_applications where full_name = 'Ann'`)[0] === 'true');

  // THE RACE: v2 is published between render (cur captured above) and submit.
  psql(`insert into privacy_notice_versions (id, audience, version_label, notice_text, published_at)
        values ('pn_k2', 'careers', 'v2', 'How we handle applications. v2 — changed.', now() + interval '1 second')`);
  const raced = submit('careers', 'Race', `'${cur[0]}'`, `'${cur[1]}'`);
  check('the display/record RACE refuses as notice_version_changed', refused(raced, 'notice_version_changed'), raced.err);
  check('…and no row was inserted for the raced submitter',
    rows(`select count(*) from job_applications where full_name = 'Race'`)[0] === '0');

  const cur2 = rows(`select id || '|' || content_sha256 from privacy_notice_current where audience='careers'`)[0].split('|');
  check('privacy_notice_current moved to v2', cur2[0] === 'pn_k2');
  const ok2 = submit('careers', 'Bea', `'${cur2[0]}'`, `'${cur2[1]}'`);
  check('re-rendering the CURRENT notice and echoing it is accepted', ok2.ok && ok2.out.trim() === 'true', ok2.err);

  const fkDel = tryPsql(`delete from privacy_notice_versions where id = 'pn_k1'`);
  check('a version referenced by evidence is FK-restricted even for the superuser',
    refused(fkDel, 'violates foreign key'), fkDel.err);
}

function s3_anon() {
  console.log('\n\u00a73  Anonymous visitors read the display surface, not the archive');
  const view = asAnon(`select count(*) from privacy_notice_current;`);
  check('anon reads privacy_notice_current', view.ok && Number(view.out) >= 1, view.err);
  const base = asAnon(`select count(*) from privacy_notice_versions;`);
  check('anon cannot read the base version table', refused(base, 'permission denied'), base.err);
}

function s4_ack_and_core() {
  console.log('\n\u00a74  Acknowledgements are append-only; the core is not browser-callable');
  const ins = asOwner(`insert into staff_notice_acknowledgements (staff_id, notice_id)
                       values ('sp_n_owner', 'pn_k1') returning id;`);
  check('a staff member acknowledges a frozen notice (self-insert)', ins.ok, ins.err);
  const ackId = ins.out;

  /* LAYER 1 — RLS: no update/delete policy exists, so an API role's write
   * targets ZERO rows (silently — that is how RLS filters). The row must
   * survive both attempts bit-for-bit. */
  const before = rows(`select acknowledged_at::text from staff_notice_acknowledgements where id = '${ackId}'`)[0];
  asOwner(`update staff_notice_acknowledgements set acknowledged_at = now() + interval '1 day' where id = '${ackId}';`);
  asOwner(`delete from staff_notice_acknowledgements where id = '${ackId}';`);
  check('RLS: an API role\'s edit/delete targets zero acknowledgement rows',
    rows(`select count(*) || '|' || max(acknowledged_at::text)
            from staff_notice_acknowledgements where id = '${ackId}'`)[0] === `1|${before}`);

  /* LAYER 2 — the trigger backstop: if a FUTURE policy ever grants writes,
   * the append-only trigger still refuses. Proven by temporarily granting
   * exactly such a policy and watching the trigger, not RLS, say no. */
  psql(`create policy sna_tmp_probe on staff_notice_acknowledgements for all to authenticated using (true) with check (true)`);
  const upd = asOwner(`update staff_notice_acknowledgements set acknowledged_at = now() where id = '${ackId}';`);
  check('trigger: editing an acknowledgement is refused even when a policy allows it',
    refused(upd, 'notice_ack_append_only'), upd.err);
  const del = asOwner(`delete from staff_notice_acknowledgements where id = '${ackId}';`);
  check('trigger: deleting an acknowledgement is refused even when a policy allows it',
    refused(del, 'notice_ack_append_only'), del.err);
  psql(`drop policy sna_tmp_probe on staff_notice_acknowledgements`);

  const core = asOwner(`select submit_public_form_core('contact','{}'::jsonb, gen_random_uuid(), repeat('a',64), repeat('b',64));`);
  check('the pre-evidence core is NOT executable by browser roles', refused(core, 'permission denied'), core.err);
}

function main() {
  console.log('INC11 NOTICE EVIDENCE');
  console.log('=====================');
  buildDatabase();
  s1_freeze();
  s2_gate();
  s3_anon();
  s4_ack_and_core();
  console.log('');
  if (failed === 0) console.log(`\u2714 INC11 NOTICE EVIDENCE — ${passed} passed, 0 failed`);
  else {
    console.log(`\u2716 INC11 NOTICE EVIDENCE — ${passed} passed, ${failed} FAILED`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  try { execFileSync('su', ['postgres', '-c', `psql -q -X -c "drop database if exists ${DB}"`], { encoding: 'utf8' }); } catch { /* keep */ }
  process.exit(failed === 0 ? 0 : 1);
}

main();
