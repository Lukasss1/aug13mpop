#!/usr/bin/env node
/**
 * ============================================================================
 *  INC11 — CONTENT & CANDIDACY LIFECYCLE: frozen news addresses, sanctioned
 *  application transitions
 * ============================================================================
 *
 *  §1 NEWS SLUGS. A post's address is stamped server-side at FIRST
 *     publication through the real vehicle (publish_record): derived from the
 *     title with the client's normalisation, collision-suffixed with the id
 *     tail, exposed on the anonymous projection, and IMMUTABLE afterwards —
 *     retitling a published post changes the headline, never the address.
 *  §2 APPLICATION TRANSITIONS. transition_application is the only API-role
 *     vehicle for status changes: row lock + compare-and-swap on the expected
 *     current status, the RLS-equivalent store-scoped authority check, the
 *     audit row, and the candidate mail for offer/declined enqueued in the
 *     SAME transaction — gated by the same customer_ack posture as every
 *     candidate-facing mail. The old direct PATCH is closed.
 *
 *  Run:  npm run test:inc11-lifecycle
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.MP_INC11L_DB || 'mp_inc11_lifecycle';
const SHIM = path.join(ROOT, 'scripts/lib/supabase-local-privileges.sql');

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed += 1; console.log(`  \u2714 ${label}`); }
  else { failed += 1; failures.push(label); console.log(`  \u2716 ${label}${detail ? ` \u2014 ${detail}` : ''}`); }
};

function psql(sql) {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return execFileSync('su', ['postgres', '-c',
    `psql -tA -v ON_ERROR_STOP=1 -d ${DB} -c ${JSON.stringify(oneLine)}`], { encoding: 'utf8' });
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
const OWNER = '00000000-0000-4000-8000-00000000cc1e';
const MGR_RIGHT = '00000000-0000-4000-8000-00000000cc2e';
const MGR_WRONG = '00000000-0000-4000-8000-00000000cc3e';
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

  psql(`insert into stores (id, name, address, postcode, opening_hours, status) values
        ('st_l1', 'Lifecycle Store', '5 Test Way', 'B3 3AC', 'Mon-Sun 9-5', 'coming_soon'),
        ('st_l2', 'Other Store',     '6 Test Way', 'B3 3AD', 'Mon-Sun 9-5', 'coming_soon')
        on conflict (id) do nothing`);
  psql(`insert into staff_profiles (id, name, email, role, store_id, auth_id, status) values
        ('sp_l_owner', 'Olive Owner',  'cc1e@milkpop.uk', 'owner', 'st_l1', '${OWNER}', 'active'),
        ('sp_l_mgr1',  'Rita Right',   'cc2e@milkpop.uk', 'store_manager', 'st_l1', '${MGR_RIGHT}', 'active'),
        ('sp_l_mgr2',  'Wes Wrong',    'cc3e@milkpop.uk', 'store_manager', 'st_l2', '${MGR_WRONG}', 'active')
        on conflict (id) do nothing`);
  // Public-form accept gates + candidate-mail posture (fixture inserts route
  // through the same launch gates as real submissions).
  psql(`update launch_settings set notification_recipient = 'harness@example.invalid',
        customer_ack_enabled = true where id`);
  psql(`insert into privacy_notice_versions (id, audience, version_label, notice_text, policy_url, published_at)
        values ('pn_l_careers', 'careers', 'v-l1', 'We process application data.', 'https://example.invalid/privacy', now())
        on conflict (id) do nothing`);
  psql(`insert into job_applications (id, full_name, email, phone, applied_for, applied_store, availability, experience, message, status, applied_at) values
        ('app_l1', 'Cass Candidate', 'cass@example.invalid', '0', 'Team Member', 'Lifecycle Store', 'full', 'none', 'hi', 'pending', '2026-07-30'),
        ('app_l2', 'Bea Blankstore', 'bea@example.invalid',  '0', 'Team Member', '',                'full', 'none', 'hi', 'pending', '2026-07-30'),
        ('app_l3', 'Neal Nomail',    '',                     '0', 'Team Member', '',                'full', 'none', 'hi', 'pending', '2026-07-30')
        on conflict (id) do nothing`);
}

function s1_news_slugs() {
  console.log('\n\u00a71  Frozen news addresses');
  psql(`insert into news_posts (id, title, content, category, date, status) values
        ('np_l1', 'Grand Opening in Birmingham!', 'x', 'News', '2026-07-30', 'draft'),
        ('np_l2', 'Grand Opening in Birmingham!', 'x', 'News', '2026-07-30', 'draft')
        on conflict (id) do nothing`);
  check('a draft has NO slug and its title stays editable',
    rows(`select coalesce(slug,'<null>') from news_posts where id='np_l1'`)[0] === '<null>'
      && tryPsql(`update news_posts set title='Grand Opening in Birmingham!!' where id='np_l1'`).ok);

  const pub1 = asOwner(`select publish_record('news_posts','np_l1',true);`);
  check('first publication stamps the derived address (real publish_record vehicle)',
    pub1.ok && rows(`select slug from news_posts where id='np_l1'`)[0] === 'grand-opening-in-birmingham', pub1.ok ? rows(`select slug from news_posts where id='np_l1'`)[0] : pub1.err);

  const pub2 = asOwner(`select publish_record('news_posts','np_l2',true);`);
  check('a colliding title gets the id-tail suffix',
    pub2.ok && rows(`select slug from news_posts where id='np_l2'`)[0] === 'grand-opening-in-birmingham-p_l2', pub2.ok ? rows(`select slug from news_posts where id='np_l2'`)[0] : pub2.err);

  check('retitling a PUBLISHED post keeps the frozen address',
    tryPsql(`update news_posts set title='A Completely New Headline' where id='np_l1'`).ok
      && rows(`select slug from news_posts where id='np_l1'`)[0] === 'grand-opening-in-birmingham');

  const imm = tryPsql(`update news_posts set slug='hand-picked' where id='np_l1'`);
  check('changing the slug itself refuses (news_slug_immutable)',
    refused(imm, 'news_slug_immutable'), imm.err);

  check('the anonymous projection exposes the frozen address',
    rows(`select slug from news_posts_public where id='np_l1'`)[0] === 'grand-opening-in-birmingham');
}

function s2_transitions() {
  console.log('\n\u00a72  Sanctioned candidacy transitions');
  const direct = asOwner(`update job_applications set status='reviewing' where id='app_l1';`);
  check('the old direct status PATCH is closed (application_transition_refused)',
    refused(direct, 'application_transition_refused'), direct.err);

  const r1 = asOwner(`select transition_application('app_l1','pending','reviewing');`);
  check('owner: pending \u2192 reviewing succeeds', r1.ok && r1.out.includes('"reviewing"'), r1.err);

  const stale = asOwner(`select transition_application('app_l1','pending','reviewing');`);
  check('a stale expectation refuses (application_status_stale)',
    refused(stale, 'application_status_stale'), stale.err);

  const noop = asOwner(`select transition_application('app_l1','reviewing','reviewing');`);
  check('a no-op transition refuses', refused(noop, 'application_transition_noop'), noop.err);

  const bad = asOwner(`select transition_application('app_l1','reviewing','hired');`);
  check('an unknown status refuses', refused(bad, 'application_bad_status'), bad.err);

  const wrong = asRole(MGR_WRONG, `select transition_application('app_l1','reviewing','interview');`);
  check('a manager of ANOTHER store is refused (application_forbidden)',
    refused(wrong, 'application_forbidden'), wrong.err);

  const blank = asRole(MGR_RIGHT, `select transition_application('app_l2','pending','reviewing');`);
  check('a store manager is refused on a store-less application (owner territory)',
    refused(blank, 'application_forbidden'), blank.err);

  const right = asRole(MGR_RIGHT, `select transition_application('app_l1','reviewing','interview');`);
  check('the NAMED store\u2019s manager (two-step verified) transitions it', right.ok, right.err);

  const offer = asOwner(`select transition_application('app_l1','interview','offer');`);
  check('owner: interview \u2192 offer succeeds', offer.ok, offer.err);
  check('\u2026the offer mail is enqueued in the SAME transaction (customer_ack, application-offer)',
    rows(`select recipient_kind || '|' || template_id || '|' || event_type
            from notification_outbox where entity_id='app_l1'`)[0]
      === 'customer_ack|application-offer|application.offer');
  check('\u2026and the transitions are audited with the acting staff member',
    rows(`select count(*) from audit_logs where module='Careers Desk' and action like '%app_l1%'`)[0] === '3'
      && rows(`select operator_name from audit_logs where module='Careers Desk' and action like '%to offer%'`)[0] === 'Olive Owner');

  psql(`update launch_settings set customer_ack_enabled = false where id`);
  const dec = asOwner(`select transition_application('app_l2','pending','declined');`);
  check('with the ack posture OFF, declined still transitions but enqueues NO mail',
    dec.ok && rows(`select count(*) from notification_outbox where entity_id='app_l2'`)[0] === '0', dec.err);

  psql(`update launch_settings set customer_ack_enabled = true where id`);
  const nomail = asOwner(`select transition_application('app_l3','pending','declined');`);
  check('a candidate with NO e-mail transitions cleanly with no outbox row',
    nomail.ok && rows(`select count(*) from notification_outbox where entity_id='app_l3'`)[0] === '0', nomail.err);

  const missing = asOwner(`select transition_application('app_none','pending','reviewing');`);
  check('an unknown application refuses (application_not_found)',
    refused(missing, 'application_not_found'), missing.err);

  const su = tryPsql(`update job_applications set status='pending' where id='app_l3'`);
  check('superuser (seed/harness) remains exempt from the guard', su.ok, su.err);
}

function main() {
  console.log('INC11 CONTENT & CANDIDACY LIFECYCLE');
  console.log('===================================');
  buildDatabase();
  s1_news_slugs();
  s2_transitions();
  console.log('');
  if (failed === 0) console.log(`\u2714 INC11 LIFECYCLE \u2014 ${passed} passed, 0 failed`);
  else {
    console.log(`\u2716 INC11 LIFECYCLE \u2014 ${passed} passed, ${failed} FAILED`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  try { execFileSync('su', ['postgres', '-c', `psql -q -X -c "drop database if exists ${DB}"`], { encoding: 'utf8' }); } catch { /* keep */ }
  process.exit(failed === 0 ? 0 : 1);
}

main();
