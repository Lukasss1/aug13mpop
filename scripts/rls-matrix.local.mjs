#!/usr/bin/env node
/* ============================================================================
 * MILK POP — LOCAL RLS MATRIX (Stage 12a)
 *
 * Real PostgreSQL 17, the REAL schema + the REAL migration order from
 * launch/launch.sh, and Supabase-parity shims for auth.uid()/auth.jwt()/roles.
 * Every assertion below runs as an actual database session with `set role`
 * + the request JWT claims a Supabase session would carry — so what passes
 * here is the same RLS/trigger/RPC behaviour a staging project enforces,
 * minus the HTTP layer (scripts/staging-integration.test.mjs covers that
 * against a real project in Phase C).
 *
 * Usage:  node scripts/rls-matrix.local.mjs
 * Needs:  a local postgres cluster reachable via `su postgres -c psql`
 *         (the default apt cluster). The script creates/drops its own DB.
 *
 * STAGE 12b (OPT-01) — matrix refreshed to the POST-FIX-8/9/10/12 contract.
 * The Stage-12a assertions predated four hardening migrations and failed
 * 28/73 the first time the suite ran on the full launch manifest:
 *   • FIX-8:  is_owner()/is_manager_or_owner() now REQUIRE an aal2 JWT.
 *             The shim never emitted an `aal` claim, so jwt_aal() fail-closed
 *             to aal1 and every privileged owner/manager action was denied.
 *             The claims builder now emits `aal` for every actor (GoTrue
 *             parity: aal1 default, `<uuid>@aal2` = MFA-verified session),
 *             and every assertion that models a privileged session runs
 *             @aal2. One NEW assertion pins the aal1-denial contract itself.
 *   • FIX-9:  complete_training REQUIRES p_answers (server grading is
 *             mandatory). assess_food now seeds one real question and every
 *             completion call submits answers; scores are server-graded.
 *   • FIX-10: clock keys are RPC-only. The clock assertions now go through
 *             staff_clock_action(); direct set_app_state on a clock key is
 *             asserted to fail with clock_keys_are_rpc_only — for ANY caller,
 *             including the key owner.
 *   • FIX-12: orders_insert_staff was dropped; sales flow through
 *             submit_web_order(), which derives the store from the CALLER
 *             and reprices from the catalogue. The order assertions now
 *             prove spoofed store/total inputs are neutralised instead of
 *             asserting a direct INSERT that no longer exists by design.
 * ==========================================================================*/
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = 'milkpop_rls_matrix';
const tmp = mkdtempSync(path.join(tmpdir(), 'mp-rls-'));
execFileSync('chmod', ['755', tmp]);

let passed = 0, failed = 0;
const failures = [];
const ok = (name) => { passed++; console.log(`✔ ${name}`); };
const bad = (name, detail) => { failed++; failures.push(name); console.log(`✖ ${name}\n    ${detail}`); };

function psql(args, input) {
  return execFileSync('su', ['postgres', '-c', `psql -X -v ON_ERROR_STOP=1 ${args}`], {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
}
function psqlFile(db, file) {
  // Files are read by the postgres user; copy into a world-readable tmp path.
  const dest = path.join(tmp, path.basename(file));
  writeFileSync(dest, readFileSync(file, 'utf8'));
  execFileSync('chmod', ['644', dest]);
  return psql(`-d ${db} -q -f ${dest}`);
}

/** Run SQL as an identity (or 'anon' / 'service'). Returns stdout; throws on error. */
function runAs(identity, sql) {
  let preamble;
  if (identity === 'anon') {
    preamble = `do $mp$ begin perform set_config('request.jwt.claims', '', false); end $mp$;\nset role anon;`;
  } else if (identity === 'service') {
    preamble = `do $mp$ begin perform set_config('request.jwt.claims', '{"role":"service_role"}', false); end $mp$;\nset role service_role;`;
  } else {
    // `<uuid>` runs as an aal1 session (password grant); `<uuid>@aal2` runs as
    // an MFA-verified session. GoTrue stamps `aal` on every token, so the shim
    // must too — FIX-8's jwt_aal() reads it and fail-closes to aal1 if absent.
    const [sub, aal] = identity.split('@');
    const claims = JSON.stringify({ sub, role: 'authenticated', email: `${sub}@test.local`, aal: aal === 'aal2' ? 'aal2' : 'aal1' });
    preamble = `do $mp$ begin perform set_config('request.jwt.claims', '${claims.replace(/'/g, "''")}', false); end $mp$;\nset role authenticated;`;
  }
  const script = `${preamble}\n${sql}`;
  const dest = path.join(tmp, `run_${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(dest, script);
  execFileSync('chmod', ['644', dest]);
  try {
    return psql(`-d ${DB} -qtA -f ${dest}`);
  } catch (e) {
    const err = new Error(String(e.stderr || e.message));
    err.stderr = String(e.stderr || '');
    throw err;
  }
}

function expectOk(name, identity, sql, verify) {
  try {
    const out = runAs(identity, sql);
    if (verify && !verify(out)) return bad(name, `unexpected output: ${out.trim().slice(0, 200)}`);
    ok(name);
    return out;
  } catch (e) {
    bad(name, (e.stderr || e.message).trim().split('\n')[0]);
  }
}
function expectDeny(name, identity, sql, needle) {
  try {
    runAs(identity, sql);
    bad(name, 'operation SUCCEEDED but should have been denied');
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (!needle || msg.includes(needle) || /permission denied|42501|violates row-level security/.test(msg)) ok(name);
    else bad(name, `denied for the WRONG reason: ${msg.trim().split('\n').slice(-1)[0]}`);
  }
}

/* ---------------------------------------------------------------- */
/* 1. Fresh database + Supabase-parity shims                        */
/* ---------------------------------------------------------------- */
console.log('\n— provisioning —');
try { execFileSync('pg_ctlcluster', ['16', 'main', 'start'], { stdio: 'ignore' }); } catch { /* already running */ }
try { psql(`-c "drop database if exists ${DB}"`); } catch {}
psql(`-c "create database ${DB}"`);

/* R4.10 Increment 4: this suite used to carry its own inline bootstrap. Every
   database harness now executes the ONE shared file, so a privilege regression
   is visible to all of them rather than to the four that happened to mirror
   production. Consolidating also surfaced two real disagreements: the harnesses
   were injecting identity through DIFFERENT session variables, and only this one
   defined auth.role(). Both are reconciled inside the shared file. */
const SHARED_SHIM = path.join(root, 'scripts/lib/supabase-local-privileges.sql');
const shimCopy = path.join(tmp, 'bootstrap.sql');
writeFileSync(shimCopy, readFileSync(SHARED_SHIM, 'utf8'));
execFileSync('chmod', ['644', shimCopy]);
psql(`-d ${DB} -q -f ${shimCopy}`);
console.log('✔ roles + auth/storage shims (shared: scripts/lib/supabase-local-privileges.sql)');

/* ---------------------------------------------------------------- */
/* 2. THE deployment order — from the AUTHORITATIVE manifest         */
/*    (launch/migration-manifest.sh). OPT-01.1: no independent parse */
/*    of launch.sh; this applies the exact FRESH order every other   */
/*    consumer uses, including the two legacy conditionals (they are */
/*    idempotent and fresh-safe — proven by the baseline test).      */
/* ---------------------------------------------------------------- */
const manifest = execFileSync('bash', [path.join(root, 'launch/migration-manifest.sh'), 'fresh'], { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean);
if (manifest.length < 10) { console.error('could not read the migration manifest'); process.exit(1); }
for (const rel of manifest) {
  try {
    psqlFile(DB, path.join(root, rel));
    console.log(`✔ applied ${rel}`);
  } catch (e) {
    console.error(`✖ FAILED applying ${rel}\n${String(e.stderr || e.message).slice(0, 1200)}`);
    process.exit(1);
  }
}

/* ---------------------------------------------------------------- */
/* 3. Test identities (uuid-linked staff across two stores)         */
/* ---------------------------------------------------------------- */
const U = {
  owner: '00000000-0000-4000-8000-000000000001',
  mgrA:  '00000000-0000-4000-8000-00000000000a',
  mgrB:  '00000000-0000-4000-8000-00000000000b',
  staffA: '00000000-0000-4000-8000-0000000000a1',
  staffA2: '00000000-0000-4000-8000-0000000000a2',
  staffB: '00000000-0000-4000-8000-0000000000b1',
  mgrA2:  '00000000-0000-4000-8000-00000000000c',
  staffA3: '00000000-0000-4000-8000-0000000000a3',
};
const seedIdentities = `
-- R4.9 G2: the R4.8 store-open gate (assert_store_open_allowed) fires on the
-- INSERT below, because stores.status DEFAULTS to 'open' — so a plain insert is
-- a nothing→open transition and the gate demands the launch identity first.
-- The gate is correct; this fixture predates it. Completing the harness's
-- launch identity is the realistic order of events (an owner records who the
-- business is before a storefront opens) and keeps every open-store RLS probe
-- below exercising the same rows it always did. Harness values only — this file
-- is a test fixture, never a seed.
update launch_settings set
  legal_business_name  = 'Harness Ltd',
  registered_address   = '1 Harness Way, B90 0AA',
  public_contact_email = 'harness@example.invalid',
  privacy_contact_email= 'harness@example.invalid',
  public_telephone     = '+44 0000 000000',
  vat_state_confirmed  = true
where id;

-- R4.9 G2: the same gate additionally requires per-store address + opening
-- hours at every INSERT (stores.status DEFAULTS to 'open', so a bare insert is
-- a nothing→open transition). This suite has ten store inserts across ten
-- sections and tests ROW-LEVEL SECURITY, not launch gating — the gate gets its
-- own executable coverage separately. One harness-only column default keeps
-- every assertion below meaning exactly what it meant before, instead of
-- rewriting ten SQL literals. The PRODUCTION schema is untouched: this runs
-- only inside the throwaway matrix database built by this file.
-- NOTE FOR THE GATE ROUND: that a bare INSERT INTO STORES is refused in
-- production is a real behavioural consequence of R4.8 and is recorded as a
-- design question, not silently absorbed here.
alter table stores alter column opening_hours set default 'Mon-Sun 09:00-21:00';

-- R4.9 G5: a public form submission is no longer accepted unless a published
-- privacy notice exists to stamp and a recipient exists to deliver to. This
-- suite tests ROW-LEVEL SECURITY on those tables, not commissioning, so the
-- harness surface is commissioned here. The gate itself is asserted in
-- scripts/migration-baseline.assert.sql (refused before, accepted after).
update launch_settings set notification_recipient = 'harness@example.invalid' where id;
insert into privacy_notice_versions (audience, version_label, notice_text, published_at)
values ('careers', 'v1-harness', 'harness notice', now()),
       ('franchise', 'v1-harness', 'harness notice', now()),
       ('contact', 'v1-harness', 'harness notice', now())
on conflict (audience, version_label) do nothing;

-- The harness's two storefronts. migration_launch_data_neutralise legitimately
-- deletes the PRISTINE seed stores at the end of the chain, which silently
-- removed the rows every fixture below (and orders' store FK) depends on — a
-- latent defect invisible until a postgres-equipped environment ran this file.
insert into stores (id, name, address, postcode, opening_hours)
values ('s1', 'Solihull', '1 Harness Way', 'B90 0AA', 'Mon-Sun 09:00-21:00'),
       ('s2', 'Birmingham', '2 Harness Way', 'B1 1AA', 'Mon-Sun 09:00-21:00')
on conflict (id) do nothing;

-- WS6d/WS6e: both harness storefronts model the operator's COMPLETED closure-§1
-- configuration act — NOT_REGISTERED confirmed AND the Setup Wizard done
-- (ACTIVE with the live till's config). A store without this cannot trade at
-- all — §16 probes the unconfirmed case, §17 the DRAFT case.
update stores set vat_config_confirmed_at = now(),
                  setup_status    = 'ACTIVE',
                  timezone        = 'Europe/London',
                  currency_code   = 'GBP',
                  payment_methods = '["cash","card","online"]'::jsonb
 where id in ('s1','s2');

insert into staff_profiles (id, name, email, role, store_id, store_name, auth_id, points, level, badges, pay_rate, pay_type)
values
 ('emp_owner',  'Olive Owner',  'owner@test.local',  'owner',         's1', 'Solihull', '${U.owner}',  0, 1, '[]'::jsonb, 0,     'salary'),
 ('emp_mgr_a',  'Mia Manager',  'mgra@test.local',   'store_manager', 's1', 'Solihull', '${U.mgrA}',   0, 1, '[]'::jsonb, 14.25, 'hourly'),
 ('emp_mgr_b',  'Max Manager',  'mgrb@test.local',   'store_manager', 's2', 'Birmingham','${U.mgrB}',  0, 1, '[]'::jsonb, 14.25, 'hourly'),
 ('emp_a1',     'Anna Staff',   'a1@test.local',     'team_member',   's1', 'Solihull', '${U.staffA}', 0, 1, '[]'::jsonb, 12.50, 'hourly'),
 ('emp_a2',     'Alfie Staff',  'a2@test.local',     'team_member',   's1', 'Solihull', '${U.staffA2}',0, 1, '[]'::jsonb, 12.00, 'hourly'),
 ('emp_b1',     'Bea Staff',    'b1@test.local',     'team_member',   's2', 'Birmingham','${U.staffB}',0, 1, '[]'::jsonb, 11.00, 'hourly'),
 ('emp_mgr_a2', 'Peer Manager', 'mgra2@test.local',  'store_manager', 's1', 'Solihull', '${U.mgrA2}',  0, 1, '[]'::jsonb, 14.25, 'hourly'),
 ('emp_a3',     'Clean Staff',  'a3@test.local',     'team_member',   's1', 'Solihull', '${U.staffA3}',0, 1, '[]'::jsonb, 12.00, 'hourly')
on conflict (id) do nothing;

insert into training_assessments (id, title, passing_score, points, badge, category, questions)
values ('assess_food', 'Food Safety L2', 80, 150, 'Food Safe', 'compliance',
  '[{"id":"fq1","text":"Safe reheat core temp?","type":"multiple_choice","options":["55C","75C"],"correctAnswer":"75C","explanation":"","difficulty":"easy","categoryTag":""}]'::jsonb)
on conflict (id) do nothing;
insert into training_assessments (id, title, passing_score, points, badge, category, questions)
values ('assess_graded', 'Server-Graded Module', 80, 50, 'Graded', 'brand',
  '[{"id":"q1","text":"Pick B","type":"multiple_choice","options":["A","B"],"correctAnswer":"B","explanation":"","difficulty":"easy","categoryTag":""},
    {"id":"q2","text":"Gaps","type":"drag_drop","options":[],"correctAnswer":"","explanation":"","difficulty":"easy","categoryTag":"","dragTemplate":"Chill at [[8]] then freeze at [[-18]]"}]'::jsonb)
on conflict (id) do nothing;
insert into training_courses (id, title, category, points, badge, assessment_id)
values ('course_food', 'Food Safety', 'compliance', 150, 'Food Safe', 'assess_food')
on conflict (id) do nothing;
insert into training_assignments (id, assessment_id, assessment_title, employee_id, employee_name, assigned_by, due_date, status)
values
 ('asn_a1', 'assess_food', 'Food Safety L2', 'emp_a1', 'Anna Staff', 'emp_owner', current_date + 30, 'assigned'),
 ('asn_b1', 'assess_food', 'Food Safety L2', 'emp_b1', 'Bea Staff',  'emp_owner', current_date + 30, 'assigned')
on conflict (id) do nothing;

insert into work_shifts (id, employee_id, employee_name, store_id, store_name, date, start_time, end_time, type)
values ('shift_a1', 'emp_a1', 'Anna Staff', 's1', 'Solihull', '2026-07-10', '09:00', '17:00', 'mid')
on conflict (id) do nothing;

insert into staff_documents (id, name, type, category, status, employee_id, employee_name, store_id, store_name, storage_bucket, storage_path)
values
 ('doc_a1', 'Passport', 'application/pdf', 'id_verification', 'pending', 'emp_a1', 'Anna Staff', 's1', 'Solihull', 'staff-documents', 'stores/s1/employees/emp_a1/doc_a1/passport.pdf'),
 ('doc_b1', 'Passport', 'application/pdf', 'id_verification', 'pending', 'emp_b1', 'Bea Staff',  's2', 'Birmingham', 'staff-documents', 'stores/s2/employees/emp_b1/doc_b1/passport.pdf')
on conflict (id) do nothing;
`;
writeFileSync(path.join(tmp, 'identities.sql'), seedIdentities);
execFileSync('chmod', ['644', path.join(tmp, 'identities.sql')]);
psql(`-d ${DB} -q -f ${path.join(tmp, 'identities.sql')}`);
console.log('✔ identities + fixtures\n\n— matrix —');

/* ---------------------------------------------------------------- */
/* 4. THE MATRIX                                                    */
/* ---------------------------------------------------------------- */

/* Public forms (Stage 1 / Phase B) */

/* WS7: a completed sale is quote → reserve → finalise. Probes asserting a
   COMPLETED SALE (orders, order_items, timestamps, revenue, custody) run all
   three and still assert the stored ORDER; probes asserting a trading GATE or
   PRICING correctly stop at the quote. The order reuses the quote id, so the
   sibling assertions that follow are unchanged. */
const saleSql = (id, payload) => `do $mp$ begin
    perform create_order_quote('${payload}'::jsonb);
    perform begin_quote_payment('{"quoteId":"${id}","reservationId":"res_${id}","method":"card"}'::jsonb);
    perform finalise_order_payment(jsonb_build_object('quoteId','${id}','method','card',
      'reservationId','res_${id}','providerReference','T-${id}','approvedAmount',(select total::text from order_quotes where id='${id}')));
  end $mp$;
  `;

/* The provider namespace is SERVER-KNOWN: every store gets one registered
   terminal so card finalisation resolves it without the client naming
   provider, merchant or terminal identifiers. */
expectOk('WS7 fixture: one registered card terminal per store',
  'service', `insert into payment_terminals (id, store_id, provider, merchant_id, terminal_id)
                select 'term_' || id, id, 'stripe_terminal', 'acct_mp', 'T_' || id from stores
                on conflict (id) do nothing;
              select (count(*) > 0)::text from payment_terminals;`,
  (o) => o.trim() === 'true');

expectDeny('anon cannot INSERT into contact_messages',
  'anon', `insert into contact_messages (id, full_name, email, subject, message) values ('cm_x','X','x@x.com','s','m');`);
expectDeny('authenticated staff cannot INSERT into contact_messages either',
  U.staffA, `insert into contact_messages (id, full_name, email, subject, message) values ('cm_y','Y','y@y.com','s','m');`);
// R4.9 G4: the anonymous menu surface moved to menu_items_public (the base
// table is no longer anon-readable), so these four probes read the VIEW. What
// they assert is unchanged: an anonymous visitor sees the published collection.
expectOk('anon CAN read public menu content (through menu_items_public)',
  'anon', `select count(*) from menu_items_public;`, (o) => Number(o.trim()) >= 0);

/* Profile visibility + reward locks (Stages 4/10) */
expectOk('staff see their OWN profile',
  U.staffA, `select id from staff_profiles where id = 'emp_a1';`, (o) => o.includes('emp_a1'));
expectOk('staff cannot see another store member\u2019s profile (0 rows)',
  U.staffA, `select count(*) from staff_profiles where id = 'emp_b1';`, (o) => o.trim() === '0');

/* Unlinked authenticated identity (§8): a valid JWT whose subject has NO
 * staff_profiles row is not "staff" — it reads no private rows and every
 * staff RPC refuses it. */
const UNLINKED = '00000000-0000-4000-8000-0000000000ff';
expectOk('an UNLINKED authenticated user sees no staff profiles (0 rows)',
  UNLINKED, `select count(*) from staff_profiles;`, (o) => o.trim() === '0');
expectDeny('an UNLINKED authenticated user cannot clock in (not_staff)',
  UNLINKED, `select staff_clock_action('clock_in');`, 'not_staff');
expectDeny('staff cannot self-award points (trigger lock)',
  U.staffA, `update staff_profiles set points = points + 500 where id = 'emp_a1';`, 'protected_reward_columns');
expectDeny('staff cannot self-promote to owner',
  U.staffA, `update staff_profiles set role = 'owner' where id = 'emp_a1';`);
expectDeny('staff cannot change their own pay rate',
  U.staffA, `update staff_profiles set pay_rate = 99 where id = 'emp_a1';`, 'protected_profile_columns');
expectDeny('an aal1 owner token cannot perform privileged writes (FIX-8)',
  U.owner, `do $$ begin
     update staff_profiles set holiday_balance = 20 where id = 'emp_a1';
     if not found then raise exception 'permission denied: aal1 owner sees no admin rows'; end if;
   end $$;`);
expectOk('owner CAN adjust holiday balance (aal2)',
  `${U.owner}@aal2`, `update staff_profiles set holiday_balance = 20 where id = 'emp_a1' returning id;`, (o) => o.includes('emp_a1'));

/* Manager staff writes (post-Stage-12 fix #1) */
expectOk('a manager (aal2) awards recognition points to THEIR store’s staff',
  // The client PATCHes a computed LITERAL (it read points via the directory
  // RPC); a self-referencing `points + 100` would need SELECT(points), which
  // 2.1.2 deliberately withholds from browser roles.
  `${U.mgrA}@aal2`, `update staff_profiles set points = 100 where id = 'emp_a2' returning id;`, (o) => o.trim() === 'emp_a2');
expectOk('…the award landed (service verification — points is no longer browser-readable)',
  'service', `select points from staff_profiles where id = 'emp_a2';`, (o) => Number(o.trim()) >= 100);
expectOk('a manager (aal2) adjusts holiday for THEIR store’s staff',
  `${U.mgrA}@aal2`, `update staff_profiles set holiday_balance = 21.5 where id = 'emp_a2' returning id;`, (o) => o.trim() === 'emp_a2');
expectOk('…the adjustment landed (service verification)',
  'service', `select holiday_balance from staff_profiles where id = 'emp_a2';`, (o) => o.trim() === '21.5');

/* AAL BOUNDARY (§8): the SAME same-store manager update — a holiday
 * adjustment the manager is genuinely permitted to make — is DENIED at AAL1
 * and SUCCEEDS at AAL2. The only variable is the assurance level: at AAL1
 * is_manager_or_owner() is false, so the manager write policy grants no rows
 * (0 rows → the guard raises); at AAL2 the identical statement commits. */
expectDeny('AAL boundary — manager AAL1: same-store holiday update DENIED',
  U.mgrA, `do $$ begin
     update staff_profiles set holiday_balance = 9 where id = 'emp_a2';
     if not found then raise exception 'permission denied: aal1 manager sees no admin rows'; end if;
   end $$;`);
expectOk('AAL boundary — manager AAL2: the SAME update SUCCEEDS',
  `${U.mgrA}@aal2`, `update staff_profiles set holiday_balance = 9 where id = 'emp_a2' returning id;`, (o) => o.trim() === 'emp_a2');
expectDeny('a manager cannot award points to THEMSELVES',
  U.mgrA, `update staff_profiles set points = points + 100 where id = 'emp_mgr_a';`, 'protected');
expectDeny('a manager cannot change pay (owner-only, always — even at aal2)',
  `${U.mgrA}@aal2`, `update staff_profiles set pay_rate = 50 where id = 'emp_a1';`, 'protected');
expectDeny('a manager (aal2) cannot touch ANOTHER store’s staff (0 rows)',
  `${U.mgrA}@aal2`, `do $$ begin
     update staff_profiles set points = points + 100 where id = 'emp_b1';
     if not found then raise exception 'permission denied: not visible for update'; end if;
   end $$;`);
expectDeny('a manager (aal2) cannot edit the OWNER’s row (0 rows)',
  `${U.mgrA}@aal2`, `do $$ begin
     update staff_profiles set points = points + 100 where id = 'emp_owner';
     if not found then raise exception 'permission denied: not visible for update'; end if;
   end $$;`);

/* Training assignment field locks (Stage 4 / 10.3) */
expectDeny('staff cannot re-date their assignment',
  U.staffA, `update training_assignments set due_date = current_date + 300 where id = 'asn_a1';`, 'protected_assignment_columns');
expectDeny('staff cannot force-complete their assignment',
  U.staffA, `update training_assignments set status = 'completed' where id = 'asn_a1';`, 'assignment_status_locked');
expectOk('staff CAN start their assignment (assigned → in_progress)',
  U.staffA, `update training_assignments set status = 'in_progress' where id = 'asn_a1' returning status;`, (o) => o.includes('in_progress'));
expectDeny('staff cannot touch ANOTHER employee\u2019s assignment (0 rows → policy)',
  U.staffA, `do $$ begin
     update training_assignments set status = 'in_progress' where id = 'asn_b1';
     if not found then raise exception 'permission denied: not visible'; end if;
   end $$;`);

/* Server-side completion: rewards, idempotency, impersonation (Stage 4) */
const firstRun = expectOk('complete_training records a pass, certificate and reward (server-graded)',
  U.staffA, `select complete_training('assess_food', 0, 'sub_matrix_1', 'asn_a1', '["75C"]'::jsonb);`,
  (o) => o.includes('"passed": true') && o.includes('"newCertificate": true'));
expectOk('the reward landed on the profile (points 150, via the own-profile RPC)',
  U.staffA, `select points from get_my_staff_profile();`, (o) => o.trim() === '150');
expectOk('retrying the SAME submission replays the SAME result (idempotent)',
  U.staffA, `select complete_training('assess_food', 0, 'sub_matrix_1', 'asn_a1', '["75C"]'::jsonb);`,
  (o) => o.includes('"newCertificate": true'));
expectOk('…and points did NOT double',
  U.staffA, `select points from get_my_staff_profile();`, (o) => o.trim() === '150');
expectOk('a NEW submission after certification awards nothing extra',
  U.staffA, `select (complete_training('assess_food', 0, 'sub_matrix_2', null, '["75C"]'::jsonb)) ->> 'pointsAwarded';`, (o) => o.trim() === '0');
expectDeny('an employee cannot complete with someone ELSE\u2019s assignment',
  U.staffB, `select complete_training('assess_food', 0, 'sub_matrix_3', 'asn_a1', '["75C"]'::jsonb);`, 'not_your_assignment');
expectDeny('certificates cannot be inserted from the browser',
  U.staffA, `insert into training_certificates (id, employee_id, assessment_id) values ('MP-FAKE-1', 'emp_a1', 'assess_food');`, 'permission denied');
expectOk('one certificate exists for (emp_a1, assess_food)',
  `${U.owner}@aal2`, `select count(*) from training_certificates where employee_id = 'emp_a1' and assessment_id = 'assess_food';`, (o) => o.trim() === '1');

/* Server-side grading (post-Stage-12 fix #2) */
expectOk('WRONG answers with a spoofed 100% score are graded 0% and FAIL',
  U.staffB, `select (complete_training('assess_graded', 100, 'sub_grade_spoof', null,
              '["A", ["-18","8"]]'::jsonb)) - 'certificate';`,
  (o) => o.includes('"passed": false') && o.includes('"score": 0') && o.includes('"serverGraded": true'));
expectOk('CORRECT answers (choice + drag) grade 100% and pass',
  U.staffB, `select (complete_training('assess_graded', 0, 'sub_grade_good', null,
              '["B", ["8","-18"]]'::jsonb)) - 'certificate';`,
  (o) => o.includes('"passed": true') && o.includes('"score": 100') && o.includes('"serverGraded": true'));
expectOk('drag grading is case/whitespace-insensitive',
  U.staffB, `select (complete_training('assess_graded', 0, 'sub_grade_case', null,
              '["B", [" 8 ","-18"]]'::jsonb)) ->> 'score';`,
  (o) => o.trim() === '100');

/* Incident identity + store scope (T13.3.13 narrow RPC contract) */
expectOk('an incident is created with the VERIFIED reporter and store',
  U.staffA, `select (create_sifr_report(
               'Matrix spill', 'health_safety', '', 'A spill was found',
               'Slip risk', 'Clean and place a warning sign', 'standard'
             )) ->> 'reporter_id';`, (o) => o.trim() === 'emp_a1');
expectOk('the Store A manager (aal2) sees the Store A incident',
  `${U.mgrA}@aal2`, `select count(*) from sifr_reports where title = 'Matrix spill';`, (o) => o.trim() === '1');
expectOk('the Store B manager (aal2) does NOT see it (0 rows)',
  `${U.mgrB}@aal2`, `select count(*) from sifr_reports where title = 'Matrix spill';`, (o) => o.trim() === '0');
expectDeny('the Store A manager cannot bypass the atomic RPC with a whole-row update',
  `${U.mgrA}@aal2`, `update sifr_reports set status = 'resolved' where title = 'Matrix spill';`);
expectOk('the Store A manager appends an attributed reply through the RPC',
  `${U.mgrA}@aal2`, `select jsonb_array_length((append_sifr_reply(
      (select id from sifr_reports where title = 'Matrix spill'), 'Floor secured'
    )) -> 'replies');`, (o) => o.trim() === '1');
expectDeny('the Store B manager cannot change another store report through the RPC',
  `${U.mgrB}@aal2`, `select set_sifr_status(
      (select id from sifr_reports where title = 'Matrix spill'), 'resolved'
    );`, 'wrong_store');

/* app_state scoping (Stage 5) */
expectOk('a staff member clocks in via staff_clock_action (FIX-10)',
  U.staffA, `select (staff_clock_action('clock_in')) -> 'status' ->> 'status';`, (o) => o.trim() === 'clocked_in');
expectDeny('…and clock keys are RPC-only even for their OWN key (FIX-10)',
  U.staffA, `select set_app_state('milkpop_clock_status_emp_a1', '{"in": true}'::jsonb);`, 'clock_keys_are_rpc_only');
expectDeny('…and for someone ELSE\u2019s clock key',
  U.staffA, `select set_app_state('milkpop_clock_status_emp_b1', '{"in": true}'::jsonb);`, 'clock_keys_are_rpc_only');
expectDeny('…and not the global e-mail settings',
  U.staffA, `select set_app_state('milkpop_email_settings', '{"sender": "x"}'::jsonb);`, 'owner_only_key');
expectDeny('…and no unlisted keys at all',
  U.staffA, `select set_app_state('milkpop_backdoor', '{}'::jsonb);`, 'key_not_allowed');
expectOk('the owner (aal2) CAN write the global e-mail settings',
  `${U.owner}@aal2`, `select set_app_state('milkpop_email_settings', '{"sender": "hello@milkpop.uk"}'::jsonb) ->> 'scope';`, (o) => o.trim() === 'global');
expectOk('another store\u2019s staff cannot READ that clock row (0 rows)',
  U.staffB, `select count(*) from app_state where key = 'milkpop_clock_status_emp_a1';`, (o) => o.trim() === '0');
expectOk('the same-store manager (aal2) CAN read it',
  `${U.mgrA}@aal2`, `select count(*) from app_state where key = 'milkpop_clock_status_emp_a1';`, (o) => o.trim() === '1');
expectDeny('direct INSERT into app_state is revoked',
  U.staffA, `insert into app_state (key, value) values ('milkpop_clock_status_emp_a1', '{}'::jsonb);`, 'permission denied');
expectOk('staff cannot read the e-mail settings row (0 rows)',
  U.staffA, `select count(*) from app_state where key = 'milkpop_email_settings';`, (o) => o.trim() === '0');

/* T13.3.2: operational app_state is store-scoped and RPC-owned. */
expectOk('Store A staff can atomically update one configured checklist task',
  U.staffA, `select update_checklist_task(
      to_char(now() at time zone coalesce((select timezone from stores where id = current_staff_store()), 'Europe/London'), 'YYYY-MM-DD'),
      (select id from checklist_templates order by id limit 1), true, null, false
    ) ->> 'storeId';`,
  (o) => o.trim() === 's1');
expectDeny('staff cannot replace a checklist task envelope through generic app_state',
  U.staffA, `select set_app_state('milkpop_checklist_tasks:s1', '{}'::jsonb);`, 'operational_key_is_rpc_only');
expectDeny('Store A staff cannot forge a Store B operational key',
  U.staffA, `select set_app_state('milkpop_checklist_tasks:s2', '{}'::jsonb);`, 'operational_key_is_rpc_only');
expectOk('Store B staff cannot read Store A checklist state',
  U.staffB, `select count(*) from app_state where key = 'milkpop_checklist_tasks:s1';`, (o) => o.trim() === '0');
expectOk('Store A manager can read Store A checklist state',
  `${U.mgrA}@aal2`, `select count(*) from app_state where key = 'milkpop_checklist_tasks:s1';`, (o) => o.trim() === '1');
expectOk('Store B staff can maintain an independent checklist document',
  U.staffB, `select update_checklist_task(
      to_char(now() at time zone coalesce((select timezone from stores where id = current_staff_store()), 'Europe/London'), 'YYYY-MM-DD'),
      (select id from checklist_templates order by id limit 1), true, 'Store B note', false
    ) ->> 'storeId';`,
  (o) => o.trim() === 's2');
expectOk('Store A checklist is not overwritten by Store B',
  U.staffA, `select count(*) from app_state where key = 'milkpop_checklist_tasks:s1' and store_id = 's1';`,
  (o) => o.trim() === '1');
expectDeny('checklist audit history is RPC-owned, not replaceable by staff',
  U.staffA, `select set_app_state('milkpop_checklist_audits:s1', '[]'::jsonb);`, 'operational_key_is_rpc_only');
expectOk('checklist category submission commits audit and reset in one RPC',
  U.staffA, `select (submit_checklist_category(
      to_char(now() at time zone coalesce((select timezone from stores where id = current_staff_store()), 'Europe/London'), 'YYYY-MM-DD'), 'opening'
    ) ->> 'storeId');`,
  (o) => o.trim() === 's1');

/* T13.3: cover claims lock and mutate the shift's own store document. */
expectOk('fixture: create a Store A cover shift', 'service', `
  insert into work_shifts (id, employee_id, employee_name, role, store_id, store_name, date, start_time, end_time, type)
  values ('cover_a1', 'emp_a1', 'Anna Staff', 'team_member', 's1', 'Solihull', '2099-07-10', '09:00', '13:00', 'mid');
  select count(*) from work_shifts where id = 'cover_a1';`, (o) => o.trim() === '1');
expectDeny('Store A staff cannot replace the whole cover board through generic app_state',
  U.staffA, `select set_app_state('milkpop_shift_covers:s1', '{"cover_a1":{"requestedBy":"Anna Staff"}}'::jsonb);`,
  'operational_key_is_rpc_only');
expectOk('Store A shift owner can atomically publish one cover request',
  U.staffA, `select request_shift_cover('cover_a1', 'Please cover') ->> 'storeId';`,
  (o) => o.trim() === 's1');
expectDeny('Store B staff cannot claim a Store A shift',
  U.staffB, `select claim_shift('cover_a1');`, 'wrong_store');
expectOk('eligible same-store colleague can atomically claim the shift',
  U.staffA2, `select (claim_shift('cover_a1') ->> 'storeId') || '/' ||
    (select count(*)::text from work_shifts where employee_id = 'emp_a2' and date = '2099-07-10') || '/' ||
    (select count(*)::text from app_state where key = 'milkpop_shift_covers:s1' and not (value ? 'cover_a1'));`,
  (o) => o.trim() === 's1/1/1');

/* Documents (Stage 3) */
expectOk('staff see their OWN document metadata',
  U.staffA, `select count(*) from staff_documents where id = 'doc_a1';`, (o) => o.trim() === '1');
expectOk('staff cannot see another employee\u2019s document (0 rows)',
  U.staffA, `select count(*) from staff_documents where id = 'doc_b1';`, (o) => o.trim() === '0');
expectDeny('staff cannot verify their own document (mgr-only update)',
  U.staffA, `do $$ begin
     update staff_documents set status = 'approved' where id = 'doc_a1';
     if not found then raise exception 'permission denied: policy filtered'; end if;
   end $$;`);
expectOk('the same-store manager (aal2) CAN sign a document off',
  `${U.mgrA}@aal2`, `update staff_documents set status = 'approved', verified_by = 'emp_mgr_a', verified_at = now()::text where id = 'doc_a1' returning status;`, (o) => o.includes('approved'));
expectDeny('a manager (aal2) cannot touch another store\u2019s document',
  `${U.mgrB}@aal2`, `do $$ begin
     update staff_documents set status = 'approved' where id = 'doc_a1';
     if not found then raise exception 'permission denied: not visible'; end if;
   end $$;`);
expectDeny('the browser cannot INSERT document metadata (function-only)',
  U.staffA, `insert into staff_documents (id, name, type, category, employee_id) values ('doc_fake', 'X', 'application/pdf', 'compliance', 'emp_a1');`, 'permission denied');

/* Orders & financial records (Stage 6 / 10.6) */
expectDeny('direct staff INSERT into orders is forbidden (FIX-12: RPC-only)',
  U.staffA, `insert into orders (id, order_number, store_id, store_name, status, total, placed_at)
             values ('ord_direct', 1001, 's1', 'Solihull', 'completed', 4.5, now());`);
expectOk('WS7 fixture: registered card terminals cover every store so far',
  'service', `insert into payment_terminals (id, store_id, provider, merchant_id, terminal_id)
                select 'term_' || id, id, 'stripe_terminal', 'acct_mp', 'T_' || id from stores
                on conflict (id) do nothing;
              select (count(*) > 0)::text from payment_terminals;`,
  (o) => o.trim() === 'true');

expectOk('staff submit a sale via submit_web_order; a spoofed store is replaced with THEIRS',
  U.staffA, `${saleSql('q_spoof_a1', '{"id":"q_spoof_a1","storeId":"s2","items":[{"menuItemId":"m1","quantity":1}]}')} select store_id from orders where quote_id = 'q_spoof_a1';`,
  (o) => o.trim() === 's1');
expectOk('…and the spoofed client total (9999) was repriced from the catalogue (m1 = 5)',
  `${U.owner}@aal2`, `select total from orders where coalesce(quote_id, id) = 'q_spoof_a1';`, (o) => Number(o.trim()) === 5);
expectDeny('plain staff cannot rewrite a completed sale',
  U.staffA, `do $$ begin
     update orders set status = 'refunded' where id = 'ord_a1';
     if not found then raise exception 'permission denied: policy filtered'; end if;
   end $$;`);

/* Audit stream (Stage 11) */
expectOk('staff can APPEND an audit row (no representation echo)',
  U.staffA, `insert into audit_logs (id, operator_name, role, action, timestamp, module)
             values ('aud_spoof', 'Olive Owner', 'owner', 'test', '1999-01-01T00:00:00Z', 'Matrix');`);
expectDeny('…but INSERT ... RETURNING is blocked (audit reads are owner-only)',
  U.staffA, `insert into audit_logs (id, operator_name, role, action, timestamp, module)
             values ('aud_spoof2', 'Olive Owner', 'owner', 'test', '1999-01-01T00:00:00Z', 'Matrix')
             returning id;`);
expectOk('the spoofed actor was REPLACED with the verified identity',
  `${U.owner}@aal2`, `select operator_name || '/' || role from audit_logs where id = 'aud_spoof';`,
  (o) => o.includes('Anna Staff/team_member'));
expectDeny('audit rows cannot be UPDATED by a browser client',
  U.staffA, `update audit_logs set action = 'tampered' where id = 'aud_spoof';`, 'permission denied');
expectDeny('audit rows cannot be DELETED by a browser client',
  U.owner, `delete from audit_logs where id = 'aud_spoof';`, 'permission denied');
expectOk('audit reads are owner-only (staff see 0 rows)',
  U.staffA, `select count(*) from audit_logs;`, (o) => o.trim() === '0');

/* Atomic publication (Stage 7) */
/* INC11 arrangement: published records can no longer be deleted, and this
   vignette deliberately REPLACES the whole menu with one row. Withdraw
   whatever earlier sections left live so the wipe removes only drafts —
   the section then proves publication from a clean slate, and the
   anon-count assertions keep their exact meaning. */
psql(`-d ${DB} -tA`, `update menu_items set available = false where available;`);
expectOk('a manager (aal2) publishes the menu atomically and gets the final state',
  `${U.mgrA}@aal2`, `select jsonb_array_length((replace_collection('menu_items', '[{"id":"m_matrix","name":"Matrix Shake","price":4.2,"category":"milkshakes","image":"/m.webp"}]'::jsonb,
      (select count(*)::int from menu_items),
      (select revision from collection_revisions where table_key='menu_items')))->'rows');`,
  (o) => o.trim() === '1');
/* R4.10: replace_collection is CONTENT-only now — the lifecycle column is
   stripped server-side, so the new row lands as a draft and availability is
   granted through the ONE protected path. The manager may do this for menu. */
expectOk('R4.10: the manager then makes it available through publish_record (the only path)',
  `${U.mgrA}@aal2`, `select publish_record('menu_items', 'm_matrix', true)->>'current';`,
  (o) => o.trim() === 'true');
expectOk('…and the public surface really holds exactly that collection',
  'anon', `select count(*) from menu_items_public;`, (o) => o.trim() === '1');
expectDeny('plain staff cannot publish collections (rollback, nothing changed)',
  U.staffA, `select replace_collection('menu_items', '[]'::jsonb, (select count(*)::int from menu_items),
      (select revision from collection_revisions where table_key='menu_items'));`);
expectOk('…and the manager\u2019s published row survived the denied attempt',
  'anon', `select count(*) from menu_items_public;`, (o) => o.trim() === '1');
expectDeny('unlisted tables are rejected outright',
  `${U.owner}@aal2`, `select replace_collection('staff_profiles', '[]'::jsonb, 0, 0);`, 'table_not_allowed');
expectDeny('a broken payload aborts the WHOLE publication',
  `${U.mgrA}@aal2`, `select replace_collection('menu_items', '[{"id":"m_ok","name":"Fine","price":1,"category":"milkshakes"},{"id":"m_bad","name":"Broken","price":"not-a-number","category":"milkshakes"}]'::jsonb,
      (select count(*)::int from menu_items),
      (select revision from collection_revisions where table_key='menu_items'));`);
expectOk('…and the previous collection is untouched after the failed publish',
  'anon', `select id from menu_items_public;`, (o) => o.trim() === 'm_matrix');

/* Disabled employees (Stage 9) */
expectOk('the owner (aal2) disables an employee',
  `${U.owner}@aal2`, `update staff_profiles set status = 'disabled' where id = 'emp_a2' returning id;`, (o) => o.trim() === 'emp_a2');
expectOk('…and reads the new status through the staff-directory RPC',
  `${U.owner}@aal2`, `select status from get_staff_directory() where id = 'emp_a2';`, (o) => o.trim() === 'disabled');
expectOk('a disabled employee loses internal reads (0 shifts visible)',
  U.staffA2, `select count(*) from work_shifts;`, (o) => o.trim() === '0');
expectDeny('a disabled employee cannot file incidents',
  U.staffA2, `select create_sifr_report(
    'Disabled attempt', 'operations', '', 'Attempted report', 'None', 'None', 'standard'
  );`, 'not_staff');
expectDeny('a disabled employee cannot write app_state',
  U.staffA2, `select set_app_state('milkpop_clock_status_emp_a2', '{}'::jsonb);`, 'not_staff');

/* Per-employee progress isolation (Stage 4/8) */
expectOk('one employee\u2019s completion did NOT complete the other\u2019s assignment',
  `${U.owner}@aal2`, `select status from training_assignments where id = 'asn_b1';`, (o) => o.trim() === 'assigned');
expectOk('progress rows are per-employee',
  `${U.owner}@aal2`, `select count(*) from training_progress where employee_id = 'emp_a1' and course_id = 'course_food' and progress = 100;`, (o) => o.trim() === '1');
expectOk('staff write ONLY their own progress row shape',
  U.staffB, `insert into training_progress (id, employee_id, course_id, progress) values ('emp_b1:course_food', 'emp_b1', 'course_food', 25) returning progress;`, (o) => o.trim() === '25');
expectDeny('…and cannot write a row claiming to be someone else',
  U.staffB, `insert into training_progress (id, employee_id, course_id, progress) values ('emp_a1:course_food2', 'emp_a1', 'course_food2', 25);`);


/* ---------------------------------------------------------------- */
/* 9. STAGE-2 PERMISSION HARDENING (audit Findings 1–4)             */
/* ---------------------------------------------------------------- */
console.log('\n— stage-2 role hardening —');

/* F1 — manager staff writes REQUIRE MFA; store isolation intact. */
expectOk('F1: a manager at AAL1 has ZERO staff-write power (0 rows — policy demands MFA)',
  U.mgrA, `update staff_profiles set name = name where id = 'emp_a1' returning id;`, (o) => o.trim() === '');
expectOk('F1: the SAME manager at AAL2 performs the same update',
  `${U.mgrA}@aal2`, `update staff_profiles set name = name where id = 'emp_a1' returning id;`, (o) => o.trim() === 'emp_a1');
expectOk('F1: an AAL2 manager still cannot reach ANOTHER store\u2019s staff (0 rows)',
  `${U.mgrA}@aal2`, `update staff_profiles set name = name where id = 'emp_b1' returning id;`, (o) => o.trim() === '');

/* F2 — public content is owner-only (menu excepted by design, still MFA). */
expectOk('F2: the OWNER (aal2) writes public content (stores)',
  `${U.owner}@aal2`, `insert into stores (id, name, address, postcode) values ('s_tmp', 'Temp Store', 'x', 'X1 1XX') returning id;`, (o) => o.trim() === 's_tmp');
expectDeny('F2: an AAL2 manager cannot INSERT public content (owner-only with-check)',
  `${U.mgrA}@aal2`, `insert into stores (id, name, address, postcode) values ('s_hack', 'Nope', 'x', 'X1 1XX');`);
expectOk('F2: an AAL2 manager cannot UPDATE public content (0 rows)',
  `${U.mgrA}@aal2`, `update stores set name = 'Hacked' where id = 's_tmp' returning id;`, (o) => o.trim() === '');
expectOk('F2: owner cleanup of the temp store',
  `${U.owner}@aal2`, `delete from stores where id = 's_tmp' returning id;`, (o) => o.trim() === 's_tmp');
expectDeny('F2-exception guard: even the manager MENU path demands MFA (aal1 publish denied)',
  U.mgrA, `select replace_collection('menu_items', '[]'::jsonb, (select count(*)::int from menu_items),
      (select revision from collection_revisions where table_key='menu_items'));`);

/* F3 — reserved domains: browser privilege revoked outright (all roles). */
expectDeny('F3: staff cannot even COUNT customers (privilege revoked, 42501)',
  `${U.staffA}@aal2`, `select count(*) from customers;`, 'permission denied');
expectDeny('F3: the OWNER\u2019s browser session is closed out of loyalty too',
  `${U.owner}@aal2`, `select count(*) from loyalty_transactions;`, 'permission denied');
expectDeny('F3: ingredients are closed', `${U.staffA}@aal2`, `select count(*) from ingredients;`, 'permission denied');
expectDeny('F3: stock movements are closed', `${U.mgrA}@aal2`, `select count(*) from stock_movements;`, 'permission denied');
expectOk('F3: service-role paths (Edge/POS server) are unaffected',
  'service', `select count(*) from customers;`, (o) => /^\d+$/.test(o.trim()));

/* F4 — inbox scoping: applications by store name; contact inbox owner-only. */
runAs('service', `
  insert into job_applications (id, full_name, email, applied_for, applied_store)
  values ('app_sol',  'Sol Applicant',  'sol@x.test',  'crew', 'Solihull'),
         ('app_bham', 'Bham Applicant', 'bham@x.test', 'crew', 'Birmingham'),
         ('app_none', 'Anywhere',       'any@x.test',  'crew', '')
  on conflict (id) do nothing;
  insert into contact_messages (id, full_name, email, message)
  values ('cm_s2', 'Customer', 'c@x.test', 'hello')
  on conflict (id) do nothing;`);
expectOk('F4: a manager sees ONLY their store\u2019s applications',
  `${U.mgrA}@aal2`, `select string_agg(id, ',' order by id) from job_applications;`, (o) => o.trim() === 'app_sol');
expectOk('F4: the other store\u2019s manager sees only THEIRS',
  `${U.mgrB}@aal2`, `select string_agg(id, ',' order by id) from job_applications;`, (o) => o.trim() === 'app_bham');
expectOk('F4: the OWNER sees all applications, including unassigned',
  `${U.owner}@aal2`, `select count(*) from job_applications;`, (o) => o.trim() === '3');
expectOk('F4: an AAL1 manager sees NO applications (scoping helper demands MFA)',
  U.mgrA, `select count(*) from job_applications;`, (o) => o.trim() === '0');
expectOk('F4: a manager cannot UPDATE an out-of-store application (0 rows)',
  `${U.mgrA}@aal2`, `update job_applications set status = 'reviewed' where id = 'app_bham' returning id;`, (o) => o.trim() === '');
expectOk('F4: managers see ZERO customer messages (owner-only inbox)',
  `${U.mgrA}@aal2`, `select count(*) from contact_messages;`, (o) => o.trim() === '0');
expectOk('F4: the owner reads the contact inbox',
  `${U.owner}@aal2`, `select count(*) >= 1 from contact_messages;`, (o) => o.trim() === 't');



/* ---------------------------------------------------------------- */
/* 10. STAGE-2.1 PERMISSION CLOSURE (deep full-flow audit)          */
/* ---------------------------------------------------------------- */
console.log('\n— stage-2.1 permission closure —');

/* Fixtures: two orders (one served by staffA, one by staffA2) + training rows. */
runAs('service', `
  insert into orders (id, order_number, store_id, store_name, subtotal, total, completed_at, staff_id, staff_name)
  values ('ord_a1', 9001, 's1', 'Solihull', 5.00, 5.00, now(), 'emp_a1', 'Anna Staff'),
         ('ord_a3', 9002, 's1', 'Solihull', 6.00, 6.00, now(), 'emp_a3', 'Clean Staff'),
         ('ord_b1', 9003, 's2', 'Birmingham', 7.00, 7.00, now(), 'emp_b1', 'Bea Staff')
  on conflict (id) do nothing;
`);

/* F1 — an ordinary employee sees ONLY their own orders. */
expectOk('F1: a team member reads ONLY their own orders (not the whole store)',
  U.staffA, `select string_agg(coalesce(quote_id, id), ',' order by coalesce(quote_id, id)) from orders;`, (o) => o.trim() === 'ord_a1,q_spoof_a1');
expectOk('F1: a DIFFERENT team member sees only theirs',
  U.staffA3, `select string_agg(coalesce(quote_id, id), ',' order by coalesce(quote_id, id)) from orders;`, (o) => o.trim() === 'ord_a3');
expectOk('F1: an AAL2 manager sees the whole STORE\u2019s orders',
  `${U.mgrA}@aal2`, `select string_agg(coalesce(quote_id, id), ',' order by coalesce(quote_id, id)) from orders;`, (o) => o.trim() === 'ord_a1,ord_a3,q_spoof_a1');
expectOk('F1: the manager still cannot see the OTHER store\u2019s orders',
  `${U.mgrA}@aal2`, `select count(*) from orders where coalesce(quote_id, id) = 'ord_b1';`, (o) => o.trim() === '0');
expectOk('F1: the owner sees every order',
  `${U.owner}@aal2`, `select count(*) from orders;`, (o) => o.trim() === '4');

/* F2 — pay columns never reach a non-owner; since 2.1.2 the DATABASE says so. */
// F2 (superseded by Stage 2.1.2): the base table no longer grants general
// SELECT — every profile read goes through get_my_staff_profile() /
// get_staff_directory() / owner_staff_pay(). Login is RPC-based, so select=*
// being 42501 breaks nothing and closes the direct-query hole the re-audit
// demonstrated.
expectDeny('F2→2.1.2: select=* on staff_profiles is DENIED even for a manager (base table closed)',
  `${U.mgrA}@aal2`, `select count(*) from (select * from staff_profiles) q;`, 'permission denied');
expectOk('F2: the owner reads pay through the owner-only RPC',
  `${U.owner}@aal2`, `select count(*) from owner_staff_pay();`, (o) => Number(o.trim()) >= 1);
expectOk('F2: a manager calling the owner pay RPC gets ZERO rows (is_owner gate)',
  `${U.mgrA}@aal2`, `select count(*) from owner_staff_pay();`, (o) => o.trim() === '0');
expectDeny('F2: a manager still cannot WRITE pay (field-lock trigger, owner-only)',
  `${U.mgrA}@aal2`, `update staff_profiles set pay_rate = 50 where id = 'emp_a1';`, 'protected_profile_columns');
expectDeny('F2: a staff member cannot self-raise pay (field-lock trigger)',
  U.staffA, `update staff_profiles set pay_rate = 99 where id = 'emp_a1';`, 'protected_profile_columns');

/* F6 — lifecycle/identity fields are system-controlled; manager target roles. */
expectDeny('F6: a manager cannot change an employee\u2019s EMAIL',
  `${U.mgrA}@aal2`, `update staff_profiles set email = 'evil@x.test' where id = 'emp_a1';`, 'system-controlled');
expectDeny('F6: an employee cannot self-edit their onboarding status',
  U.staffA, `update staff_profiles set onboarding = 'active' where id = 'emp_a1';`, 'system-controlled');
expectDeny('F6: a manager cannot manage a PEER MANAGER\u2019s row',
  `${U.mgrA}@aal2`, `update staff_profiles set name = 'x' where id = 'emp_mgr_a2';`, 'team members and supervisors');

/* F4 — training reads are store-scoped for managers. */
expectOk('F4: a manager sees only their store\u2019s training assignments',
  `${U.mgrA}@aal2`, `select bool_and(exists (select 1 from staff_profiles sp where sp.id = ta.employee_id and sp.store_id = 's1')) from training_assignments ta;`, (o) => o.trim() === 't');
expectOk('F4: the other store\u2019s manager sees only theirs',
  `${U.mgrB}@aal2`, `select bool_and(exists (select 1 from staff_profiles sp where sp.id = ta.employee_id and sp.store_id = 's2')) from training_assignments ta;`, (o) => o.trim() === 't');
expectOk('F4: an employee sees only their OWN assignment',
  U.staffA, `select bool_and(employee_id = 'emp_a1') from training_assignments;`, (o) => o.trim() === 't');

/* F11 — media metadata: owner all; manager only menu references. */
runAs('service', `
  insert into media_objects (id, bucket, storage_path, status, mime_type, size_bytes, uploaded_by)
  values ('00000000-0000-4000-9000-0000000000f1', 'media', 'k/menu.webp', 'attached', 'image/webp', 10, 'emp_owner'),
         ('00000000-0000-4000-9000-0000000000f2', 'media', 'k/news.webp', 'attached', 'image/webp', 10, 'emp_owner')
  on conflict (id) do nothing;
  insert into media_references (media_object_id, entity_type, entity_id, field_path)
  values ('00000000-0000-4000-9000-0000000000f1', 'menu_item', 'm1', 'image'),
         ('00000000-0000-4000-9000-0000000000f2', 'news_post', 'n1', 'image')
  on conflict do nothing;`);
expectOk('F11: a manager sees ONLY menu-linked media objects',
  `${U.mgrA}@aal2`, `select count(*) from media_objects;`, (o) => o.trim() === '1');
expectOk('F11: the owner sees all media objects',
  `${U.owner}@aal2`, `select count(*) from media_objects;`, (o) => o.trim() === '2');
expectOk('F11: a manager sees only menu_item references',
  `${U.mgrA}@aal2`, `select string_agg(entity_type, ',') from media_references;`, (o) => o.trim() === 'menu_item');



/* ---------------------------------------------------------------- */
/* 11. STAGE-2.1 RE-AUDIT CLOSURE (CF1–CF5)                         */
/* ---------------------------------------------------------------- */
console.log('\n— stage-2.1 re-audit closure —');

/* CF1 (inverted by Stage 2.1.2): the full-grant restoration was itself
 * superseded — the base table is now CLOSED to every browser role, owner
 * included. The login path this once protected reads via RPC instead. */
expectDeny('CF1→2.1.2: an OWNER select=* on staff_profiles is DENIED (RPCs are the read path)',
  `${U.owner}@aal2`, `select count(*) from (select * from staff_profiles) q;`, 'permission denied');
expectDeny('CF1→2.1.2: a TEAM MEMBER select=* is DENIED even on their own row',
  U.staffA, `select count(*) from (select * from staff_profiles) q;`, 'permission denied');

/* CF2: analytics views run with the caller's RLS (security_invoker). */
expectOk('CF2: daily_sales is a security_invoker view',
  'service', `select c.reloptions::text from pg_class c where c.relname = 'daily_sales';`,
  (o) => /security_invoker=(true|on)/.test(o));
expectOk('CF2: an employee sees ONLY their own orders reflected in daily_sales',
  U.staffA, `select coalesce(sum(orders_count),0) from daily_sales;`, (o) => o.trim() === '2');
expectOk('CF2: the owner sees all orders in daily_sales',
  `${U.owner}@aal2`, `select coalesce(sum(orders_count),0) from daily_sales;`, (o) => Number(o.trim()) >= 3);
expectDeny('CF2: stock_levels (reserved inventory) is revoked from the browser',
  `${U.owner}@aal2`, `select count(*) from stock_levels;`, 'permission denied');

/* CF3: manager training WRITES are store-scoped. */
expectOk('CF3: a manager can update an in-store assignment',
  `${U.mgrA}@aal2`, `update training_assignments set status = 'in_progress' where id = 'asn_a1' returning id;`, (o) => o.trim() === 'asn_a1');
expectOk('CF3: a manager CANNOT update an out-of-store assignment (0 rows)',
  `${U.mgrA}@aal2`, `update training_assignments set status = 'in_progress' where id = 'asn_b1' returning id;`, (o) => o.trim() === '');
expectDeny('CF3: a manager CANNOT insert an assignment for another store',
  `${U.mgrA}@aal2`, `insert into training_assignments (id, employee_id, assessment_id, status, due_date) values ('asn_x', 'emp_b1', 'assess_food', 'assigned', '2030-01-01');`);
expectOk('CF3: a manager cannot DELETE an out-of-store assignment (0 rows)',
  `${U.mgrA}@aal2`, `delete from training_assignments where id = 'asn_b1' returning id;`, (o) => o.trim() === '');

/* ---------------------------------------------------------------- */
/* 12. STAGE-2.1.2 SALARY CONFIDENTIALITY (server-enforced)         */
/* ---------------------------------------------------------------- */
console.log('\n— stage-2.1.2 salary confidentiality —');

/* The re-audit's demonstrated attack, verbatim: an AAL2 store manager
 * hand-writes the PostgREST query the client never issues. The database —
 * not the client — must refuse. (This fresh chain has ALSO replayed the
 * original-2.1 partial column grants and the 2.1.1 full-grant restore, so
 * these denials prove the 2.1.2 dynamic revoke cleared every historic
 * grant an upgraded production database would carry.) */
expectDeny('2.1.2: the auditor\u2019s manager pay query (id,name,pay_rate,pay_type) is DENIED',
  `${U.mgrA}@aal2`, `select id, name, pay_rate, pay_type from staff_profiles;`, 'permission denied');
expectDeny('2.1.2: a manager cannot read pay_rate at all',
  `${U.mgrA}@aal2`, `select pay_rate from staff_profiles;`, 'permission denied');
expectDeny('2.1.2: a manager cannot read the owner\u2019s auth_id (identity column)',
  `${U.mgrA}@aal2`, `select auth_id from staff_profiles where id = 'emp_owner';`, 'permission denied');
expectDeny('2.1.2: a manager cannot read staff emails from the base table',
  `${U.mgrA}@aal2`, `select email from staff_profiles;`, 'permission denied');
expectDeny('2.1.2: even an employee\u2019s OWN-row select=* is denied at the base table',
  U.staffA, `select * from staff_profiles where id = 'emp_a1';`, 'permission denied');
expectDeny('2.1.2: the OWNER cannot read pay from the base table either (RPC is the only path)',
  `${U.owner}@aal2`, `select pay_rate from staff_profiles;`, 'permission denied');

/* The deliberate read paths, scoped exactly as the old SELECT policies. */
expectOk('2.1.2: get_staff_directory — the owner sees the whole company (8 rows)',
  `${U.owner}@aal2`, `select count(*) from get_staff_directory();`, (o) => o.trim() === '8');
expectOk('2.1.2: get_staff_directory — an AAL2 manager sees their store only (6 of 8)',
  `${U.mgrA}@aal2`, `select count(*) from get_staff_directory();`, (o) => o.trim() === '6');
expectOk('2.1.2: get_staff_directory — the SAME manager at AAL1 gets only their own row',
  U.mgrA, `select count(*) from get_staff_directory();`, (o) => o.trim() === '1');
expectOk('2.1.2: get_staff_directory — an employee gets exactly their own row',
  U.staffA, `select id from get_staff_directory();`, (o) => o.trim() === 'emp_a1');
expectDeny('2.1.2: the directory RPC has NO pay column to select',
  `${U.owner}@aal2`, `select pay_rate from get_staff_directory();`, 'does not exist');
expectDeny('2.1.2: the directory RPC has NO auth_id column to select',
  `${U.owner}@aal2`, `select auth_id from get_staff_directory();`, 'does not exist');
expectOk('2.1.2: get_my_staff_profile returns the caller\u2019s own row with their OWN pay',
  U.staffA, `select id || '/' || pay_rate::text from get_my_staff_profile();`, (o) => o.trim() === 'emp_a1/12.50');
expectOk('2.1.2: get_my_staff_profile is single-row even for a manager',
  `${U.mgrA}@aal2`, `select count(*) from get_my_staff_profile();`, (o) => o.trim() === '1');
expectOk('2.1.2: the owner reads a REAL pay value through owner_staff_pay()',
  `${U.owner}@aal2`, `select pay_rate from owner_staff_pay() where id = 'emp_a1';`, (o) => o.trim() === '12.50');

/* The minimal retained grant: exactly what policy joins, PK-confirmed writes
 * and the audit-stamp trigger need — and nothing more. */
expectOk('2.1.2: the sanctioned (id,store_id) read for write-path confirmation still works',
  U.staffA, `select store_id from staff_profiles where id = 'emp_a1';`, (o) => o.trim() === 's1');
expectOk('2.1.2: the sanctioned (name,role) read behind the audit-stamp trigger still works',
  U.staffA, `select name || '/' || role from staff_profiles where id = 'emp_a1';`, (o) => o.trim() === 'Anna Staff/team_member');
expectOk('2.1.2: the sanctioned store_name read behind the sifr-stamp trigger still works',
  U.staffA, `select store_name from staff_profiles where id = 'emp_a1';`, (o) => o.trim() === 'Solihull');
expectDeny('2.1.2: …but the NEXT column over (email) stays denied — the grant is exact',
  U.staffA, `select store_name, email from staff_profiles where id = 'emp_a1';`, 'permission denied');

/* A signed-in auth user with NO staff row: the login probe must come back
 * EMPTY (not an error) so revalidateOwnProfileTyped reports not_found. */
expectOk('2.1.2: an unlinked auth user gets 0 rows (login not_found path intact)',
  UNLINKED, `select count(*) from get_my_staff_profile();`, (o) => o.trim() === '0');
expectOk('2.1.2: an unlinked auth user sees an EMPTY directory',
  UNLINKED, `select count(*) from get_staff_directory();`, (o) => o.trim() === '0');

/* ---------------------------------------------------------------- */
/* 13. STAGE-3 WS5/WS7 — FINANCIAL INVARIANTS & UNIQUENESS          */
/* ---------------------------------------------------------------- */
console.log('\n— stage-3 financial invariants & uniqueness —');

/* Pure invariants run as service: RLS is bypassed, so a denial here proves
 * the CONSTRAINT (the database's last line of defence) — not a policy. */
expectDeny('WS5: negative order total is rejected by the database',
  'service', `insert into orders (id, order_number, subtotal, total, completed_at) values ('s3_neg', 9101, -1, -1, now());`, 'violates check');
expectDeny('WS5: discount exceeding subtotal is rejected',
  'service', `insert into orders (id, order_number, subtotal, discount_total, total, completed_at) values ('s3_disc', 9102, 5, 6, -1, now());`, 'violates check');
expectDeny('WS5: total ≠ subtotal − discount is rejected (repricing equation)',
  'service', `insert into orders (id, order_number, subtotal, total, completed_at) values ('s3_eq', 9103, 10, 99, now());`, 'violates check');
expectDeny('WS5: a COMPLETED order without a completion timestamp is rejected',
  'service', `insert into orders (id, order_number, subtotal, total) values ('s3_nots', 9104, 5, 5);`, 'violates check');
expectDeny('WS5: a REFUNDED order without a reason is rejected',
  'service', `insert into orders (id, order_number, subtotal, total, status, completed_at) values ('s3_noreason', 9105, 5, 5, 'refunded', now());`, 'violates check');
expectDeny('WS5: cash order with wrong change arithmetic is rejected',
  'service', `insert into orders (id, order_number, subtotal, total, completed_at, payment_method, cash_received, change_given) values ('s3_change', 9106, 5, 5, now(), 'cash', 10, 3);`, 'violates check');
expectDeny('WS5: a CARD order carrying cash values is rejected',
  'service', `insert into orders (id, order_number, subtotal, total, completed_at, payment_method, cash_received, change_given) values ('s3_cardcash', 9107, 5, 5, now(), 'card', 5, 0);`, 'violates check');
expectOk('WS5: a correct cash order (received 10, change 5) inserts cleanly',
  'service', `insert into orders (id, order_number, subtotal, total, completed_at, payment_method, cash_received, change_given) values ('s3_cashok', 9108, 5, 5, now(), 'cash', 10, 5) returning id;`, (o) => o.trim() === 's3_cashok');
expectDeny('WS5: negative unit price on an order line is rejected',
  'service', `insert into order_items (row_id, id, order_id, name, category, size, quantity, unit_price, line_total) values (gen_random_uuid(), 'li_s3', 'ord_a1', 'Shake', 'milkshakes', 'regular', 1, -2, -2);`, 'violates check');

expectDeny('WS7: duplicate order number WITHIN a store is rejected',
  // ord_a3 holds (s1, 9002); ord_a1's number was RPC-assigned earlier.
  'service', `insert into orders (id, order_number, store_id, store_name, subtotal, total, completed_at) values ('s3_dupno', 9002, 's1', 'Solihull', 1, 1, now());`, 'duplicate key');
expectOk('WS7: the SAME order number in a DIFFERENT store is fine',
  'service', `insert into orders (id, order_number, store_id, store_name, subtotal, total, completed_at) values ('s3_othersto', 9002, 's2', 'Birmingham', 1, 1, now()) returning id;`, (o) => o.trim() === 's3_othersto');
expectDeny('WS7: store-less (hq) orders share ONE number scope too',
  'service', `insert into orders (id, order_number, subtotal, total, completed_at) values ('s3_hq1', 9109, 1, 1, now()), ('s3_hq2', 9109, 1, 1, now());`, 'duplicate key');

expectDeny('WS5: payslip where net ≠ gross − deductions is rejected',
  'service', `insert into payslips (id, employee_id, employee_name, email, period_key, period_label, hourly_rate, hours_total, gross, deductions, net, generated_at, generated_by) values ('ps_s3a', 'emp_a1', 'Anna Staff', 'a1@test.local', '2026-07', 'July 2026', 12.50, 10, 125, 0, 999, now()::text, 'test');`, 'violates check');
expectOk('WS7: a valid payslip for (employee, period) inserts',
  'service', `insert into payslips (id, employee_id, employee_name, email, period_key, period_label, hourly_rate, hours_total, gross, deductions, net, generated_at, generated_by) values ('ps_s3b', 'emp_a1', 'Anna Staff', 'a1@test.local', '2026-07', 'July 2026', 12.50, 10, 125, 0, 125, now()::text, 'test') returning id;`, (o) => o.trim() === 'ps_s3b');
expectDeny('WS7: a SECOND payslip for the same employee+period is rejected',
  'service', `insert into payslips (id, employee_id, employee_name, email, period_key, period_label, hourly_rate, hours_total, gross, deductions, net, generated_at, generated_by) values ('ps_s3c', 'emp_a1', 'Anna Staff', 'a1@test.local', '2026-07', 'July 2026', 12.50, 10, 125, 0, 125, now()::text, 'test');`, 'duplicate key');
expectOk('WS7: REGENERATING the period updates the SAME row (upsert-by-id model)',
  'service', `update payslips set hours_total = 12, gross = 150, net = 150 where id = 'ps_s3b' returning net;`, (o) => o.trim() === '150.00');

expectOk('WS7: an employee clocks in (open entry)',
  'service', `insert into clock_history (id, employee_id, employee_name, date, clock_in) values ('ch_s3a', 'emp_a1', 'Anna Staff', '2026-07-17', '2026-07-17T09:00:00Z') returning id;`, (o) => o.trim() === 'ch_s3a');
expectDeny('WS7: a SECOND active clock-in for the same employee is rejected',
  'service', `insert into clock_history (id, employee_id, employee_name, date, clock_in) values ('ch_s3b', 'emp_a1', 'Anna Staff', '2026-07-17', '2026-07-17T13:00:00Z');`, 'duplicate key');
expectOk('WS7: after clocking OUT, a new clock-in is accepted',
  'service', `update clock_history set clock_out = '2026-07-17T12:00:00Z' where id = 'ch_s3a'; insert into clock_history (id, employee_id, employee_name, date, clock_in) values ('ch_s3c', 'emp_a1', 'Anna Staff', '2026-07-17', '2026-07-17T13:00:00Z') returning id;`, (o) => o.trim() === 'ch_s3c');

runAs('service', `
  insert into pos_devices (id, device_code, device_name, installation_id, store_code, store_id, store_name, token_hash)
  values ('00000000-0000-4000-8000-0000000000e1', 'T1', 'Till One', 'inst-1', 'SOL', 's1', 'Solihull', 'x'),
         ('00000000-0000-4000-8000-0000000000e2', 'T2', 'Till Two', 'inst-2', 'SOL', 's1', 'Solihull', 'y')
  on conflict (id) do nothing;
`);
expectOk('WS7: a till device opens a trading shift',
  'service', `insert into pos_shifts (id, store_id, device_id, status, opened_at, opened_by_user_id, opened_by_name, opening_cash_pence) values ('shift_s3a', 's1', '00000000-0000-4000-8000-0000000000e1', 'open', now(), 'emp_mgr_a', 'Mia', 5000) returning id;`, (o) => o.trim() === 'shift_s3a');
expectDeny('WS7: a SECOND open shift on the SAME device is rejected',
  'service', `insert into pos_shifts (id, store_id, device_id, status, opened_at, opened_by_user_id, opened_by_name, opening_cash_pence) values ('shift_s3b', 's1', '00000000-0000-4000-8000-0000000000e1', 'open', now(), 'emp_mgr_a', 'Mia', 5000);`, 'duplicate key');
expectOk('WS7: a DIFFERENT device opens its own shift fine',
  'service', `insert into pos_shifts (id, store_id, device_id, status, opened_at, opened_by_user_id, opened_by_name, opening_cash_pence) values ('shift_s3c', 's1', '00000000-0000-4000-8000-0000000000e2', 'open', now(), 'emp_mgr_a', 'Mia', 5000) returning id;`, (o) => o.trim() === 'shift_s3c');

/* ---------------------------------------------------------------- */
/* 14. STAGE-3 WS2 — TEMPORAL INTEGRITY (Europe/London, DST-proof)  */
/* ---------------------------------------------------------------- */
console.log('\n— stage-3 temporal integrity —');

expectDeny('WS2: garbage text can no longer enter clock_in (strict timestamptz)',
  'service', `insert into clock_history (id, employee_id, employee_name, date, clock_in) values ('ch_bad', 'emp_a2', 'Alfie Staff', '2026-07-18', 'nine-ish');`, 'invalid input');
expectDeny('WS2: clock-out cannot precede clock-in',
  'service', `insert into clock_history (id, employee_id, employee_name, date, clock_in, clock_out) values ('ch_rev', 'emp_a2', 'Alfie Staff', '2026-07-18', '2026-07-18T14:00:00Z', '2026-07-18T09:00:00Z');`, 'violates check');
expectDeny('WS2: garbage text can no longer enter a shift date',
  'service', `insert into work_shifts (id, employee_id, employee_name, date, start_time, end_time, role, store_id, store_name, type) values ('ws_bad', 'emp_a1', 'Anna Staff', 'someday', '09:00', '17:00', 'team_member', 's1', 'Solihull', 'mid');`, 'invalid input');
expectDeny('WS2: a zero-length shift (equal times) is rejected',
  'service', `insert into work_shifts (id, employee_id, employee_name, date, start_time, end_time, role, store_id, store_name, type) values ('ws_eq', 'emp_a1', 'Anna Staff', '2026-07-20', '09:00', '09:00', 'team_member', 's1', 'Solihull', 'mid');`, 'violates check');
expectOk('WS2: a normal day shift computes an 8-hour span',
  'service', `insert into work_shifts (id, employee_id, employee_name, date, start_time, end_time, role, store_id, store_name, type) values ('ws_day', 'emp_a1', 'Anna Staff', '2026-07-20', '09:00', '17:00', 'team_member', 's1', 'Solihull', 'mid'); select round(extract(epoch from (ends_at - starts_at))/3600, 1) from work_shifts where id = 'ws_day';`, (o) => o.trim() === '8.0');
expectOk('WS2: an OVERNIGHT shift (22:00–06:00) rolls to the next day — 8 hours',
  'service', `insert into work_shifts (id, employee_id, employee_name, date, start_time, end_time, role, store_id, store_name, type) values ('ws_night', 'emp_a1', 'Anna Staff', '2026-07-20', '22:00', '06:00', 'team_member', 's1', 'Solihull', 'mid'); select (ends_at::date > starts_at::date)::text || '/' || round(extract(epoch from (ends_at - starts_at))/3600, 1)::text from work_shifts where id = 'ws_night';`, (o) => o.trim() === 'true/8.0');
expectOk('WS2: SPRING-FORWARD night (2026-03-29, 00:30–05:00) is 3.5 REAL hours',
  'service', `insert into work_shifts (id, employee_id, employee_name, date, start_time, end_time, role, store_id, store_name, type) values ('ws_spring', 'emp_a1', 'Anna Staff', '2026-03-29', '00:30', '05:00', 'team_member', 's1', 'Solihull', 'mid'); select round(extract(epoch from (ends_at - starts_at))/3600, 1) from work_shifts where id = 'ws_spring';`, (o) => o.trim() === '3.5');
expectOk('WS2: FALL-BACK night (2026-10-25, 00:30–05:00) is 5.5 REAL hours',
  'service', `insert into work_shifts (id, employee_id, employee_name, date, start_time, end_time, role, store_id, store_name, type) values ('ws_autumn', 'emp_a1', 'Anna Staff', '2026-10-25', '00:30', '05:00', 'team_member', 's1', 'Solihull', 'mid'); select round(extract(epoch from (ends_at - starts_at))/3600, 1) from work_shifts where id = 'ws_autumn';`, (o) => o.trim() === '5.5');
expectOk('WS2: shift bounds are UTC instants (summer start 09:00 London = 08:00Z)',
  'service', `select to_char(starts_at at time zone 'UTC', 'HH24:MI') from work_shifts where id = 'ws_day';`, (o) => o.trim() === '08:00');
expectOk('WS2: the London business-date contract staff_clock_action() derives (23:30Z summer → NEXT London day)',
  'service', `select to_char(timestamptz '2026-06-01T23:30:00Z' at time zone 'Europe/London', 'YYYY-MM-DD');`, (o) => o.trim() === '2026-06-02');
expectOk('WS2: a MISSING clock-out stays open and readable (own-profile flow intact)',
  'service', `select count(*) from clock_history where id = 'ch_s3c' and clock_out is null;`, (o) => o.trim() === '1');
expectOk('WS2: the audit stamp OVERWRITES a spoofed instant with now() (timestamptz)',
  'service', `select (abs(extract(epoch from (now() - "timestamp"))) < 60)::text from audit_logs where id = 'aud_spoof';`, (o) => o.trim() === 'true');
expectDeny('WS2: a non-instant audit timestamp is now a TYPE error, not merely overwritten',
  U.staffA, `insert into audit_logs (id, operator_name, role, action, timestamp, module) values ('aud_ws2bad', 'x', 'x', 'test', 'faketime', 'Matrix');`, 'invalid input');

/* ---------------------------------------------------------------- */
/* 15. STAGE-3 WS3 — RELATIONSHIPS & IMPOSSIBLE STATES              */
/* ---------------------------------------------------------------- */
console.log('\n— stage-3 relationships & impossible states —');

expectDeny('WS3: a clock entry for a NONEXISTENT employee is rejected',
  'service', `insert into clock_history (id, employee_id, employee_name, date, clock_in) values ('ch_ghost', 'emp_ghost', 'Ghost', '2026-07-21', '2026-07-21T09:00:00Z');`, 'foreign key');
expectDeny('WS3: a shift in a NONEXISTENT store is rejected',
  'service', `insert into work_shifts (id, employee_id, employee_name, date, start_time, end_time, role, store_id, store_name, type) values ('ws_ghost', 'emp_a1', 'Anna Staff', '2026-07-21', '09:00', '17:00', 'team_member', 's_ghost', 'Ghost', 'mid');`, 'foreign key');
expectDeny('WS3: an employee WITH history cannot be physically deleted (RESTRICT)',
  'service', `delete from staff_profiles where id = 'emp_a1';`, 'foreign key');
// Since WS7b closed the order ledger, deleting a store with completed orders
// is refused one layer deeper than the FK: the orders.store_id SET-NULL
// cascade is itself an UPDATE of an immutable ledger row, so the ledger
// trigger backstops the delete. The invariant ("a store with transactions
// cannot be deleted") is unchanged; only the enforcing layer moved.
expectDeny('WS3: a store WITH transactions cannot be deleted (its order ledger is immutable)',
  'service', `delete from stores where id = 's1';`, 'order_ledger_immutable');
expectOk('WS3: an UNUSED store still deletes normally (rule is history, not dogma)',
  'service', `insert into stores (id, name, address, postcode) values ('s_zero', 'Popup', 'x', 'B1'); delete from stores where id = 's_zero' returning id;`, (o) => o.trim() === 's_zero');
expectOk('WS3: deleting a menu item SET-NULLs order lines while the SNAPSHOT survives',
  'service', `delete from menu_items where id = 'm1'; select (menu_item_id is null)::text || '/' || (name <> '')::text from order_items where order_id = (select id from orders where coalesce(quote_id, id) = 'q_spoof_a1') limit 1;`, (o) => o.trim() === 'true/true');
expectDeny('WS3: a training certificate WITHOUT a passing result cannot exist',
  'service', `insert into training_certificates (id, employee_id, employee_name, assessment_id, assessment_title, category, issued_at, score) values ('cert_ghost', 'emp_b1', 'Bea Staff', 'assess_food', 'Food Safety', 'hygiene', now()::text, 100);`, 'certificate_without_passing_result');
expectDeny('WS3: an ACTIVE non-owner employee with NO home store cannot exist',
  'service', `insert into staff_profiles (id, name, email, role, store_name, status) values ('emp_nostore', 'No Store', 'ns@test.local', 'team_member', 'Nowhere', 'active');`, 'violates check');
expectOk('WS3: a DISABLED store-less row may exist (deactivation is the exit, not deletion)',
  'service', `insert into staff_profiles (id, name, email, role, store_name, status) values ('emp_off', 'Off Boarded', 'off@test.local', 'team_member', 'None', 'disabled'); delete from staff_profiles where id = 'emp_off' returning id;`, (o) => o.trim() === 'emp_off');
expectDeny('WS6c→WS6d: an out-of-bounds registry rate is rejected at the database (F5)',
  'service', `update tax_codes set rate_percent = -100 where code = 'STANDARD_RATE';`, 'violates check');
expectDeny('WS6c: an order cannot snapshot an out-of-bounds tax rate',
  'service', `insert into orders (id, order_number, subtotal, total, completed_at, tax_rate) values ('s3_vat', 9200, 1, 1, now(), 150);`, 'violates check');
expectDeny('WS3b: RE-POINTING a valid certificate to a pass-less pair is rejected (update bypass closed)',
  'service', `update training_certificates set employee_id = 'emp_b1' where employee_id = 'emp_a1' and assessment_id = 'assess_food';`, 'certificate_without_passing_result');
expectDeny('WS3: closing a till shift WITHOUT its closing facts is rejected',
  'service', `update pos_shifts set status = 'closed' where id = 'shift_s3c';`, 'violates check');
expectOk('WS3: a proper close (facts included) seals the shift',
  'service', `update pos_shifts set status = 'closed', closed_at = now(), closed_by_user_id = 'emp_mgr_a', closed_by_name = 'Mia' where id = 'shift_s3a' returning status;`, (o) => o.trim() === 'closed');
expectDeny('WS3: a DUPLICATE close (or any edit to a sealed shift) is rejected',
  'service', `update pos_shifts set closing_note = 'again' where id = 'shift_s3a';`, 'shift_already_closed');

/* ---------------------------------------------------------------- */
/* 16. WS6d — VAT LIFECYCLE (closure brief §1)                      */
/*     Registry integrity · store coherence · the trading gate ·    */
/*     NOT_REGISTERED zero-truth · forward-only registration ·      */
/*     REGISTERED per-line derivation with exact allocation.        */
/* ---------------------------------------------------------------- */
const U16 = {
  staffU: '00000000-0000-4000-8000-0000000000d1', // team member at the unconfirmed store
  owner2: '00000000-0000-4000-8000-0000000000d2', // store-less second owner (WS3 permits)
};

/* Registry: exactly the four controlled codes with statutory reference rates. */
expectOk('WS6d: the tax-code registry holds exactly the four controlled codes + reference rates',
  U.staffA, `select count(*) || '/' || string_agg(code || ':' || rate_percent, ',' order by code) from tax_codes;`,
  (o) => o.trim() === '4/OUTSIDE_SCOPE:0.00,REDUCED_RATE:5.00,STANDARD_RATE:20.00,ZERO_RATED:0.00');
expectDeny('WS6d: a fifth invented tax code cannot exist (controlled vocabulary)',
  'service', `insert into tax_codes (code, rate_percent, vat_charged) values ('MADE_UP', 10, true);`, 'violates check');
expectDeny('WS6d: even the OWNER (aal2) cannot write the registry — reference data is service-owned',
  `${U.owner}@aal2`, `update tax_codes set rate_percent = 21 where code = 'STANDARD_RATE';`, 'permission denied');
expectDeny('WS6d: anon cannot even read tax reference data (verb-revoked)',
  'anon', `select count(*) from tax_codes;`, 'permission denied');

/* Store coherence: no half-configured VAT state can exist. */
expectDeny('WS6d: REGISTERED without a VAT number is impossible',
  'service', `update stores set vat_status = 'REGISTERED' where id = 's2';`, 'violates check');
expectDeny('WS6d: a malformed GB VAT number is rejected',
  'service', `update stores set vat_status = 'REGISTERED', vat_number = 'GB12', vat_registration_effective_date = '2026-01-01' where id = 's2';`, 'violates check');
expectDeny('WS6d: NOT_REGISTERED with a lingering VAT number is incoherent',
  'service', `update stores set vat_number = 'GB123456789' where id = 's2';`, 'violates check');

/* The trading gate: unconfirmed store (or no store) cannot trade at all. */
/* INC11: this fixture block INSERTs rows born-published (available/active
   true) — the lifecycle guard now refuses that for every API role,
   service_role included, by design. Fixture arrangement belongs to the
   harness, so the block moves to the superuser path verbatim; the
   ASSERTIONS that consume these fixtures are untouched. */
psql(`-d ${DB} -tA`, `
    insert into stores (id, name, address, postcode) values ('s_unconf', 'Popup', '3 Harness Way', 'B2 2BB') on conflict (id) do nothing;
    insert into staff_profiles (id, name, email, role, store_id, store_name, auth_id)
      values ('emp_unconf', 'Uma Unconfigured', 'uu@test.local', 'team_member', 's_unconf', 'Popup', '${U16.staffU}')
      on conflict (id) do nothing;
    insert into staff_profiles (id, name, email, role, auth_id)
      values ('emp_owner2', 'Otto Owner', 'owner2@test.local', 'owner', '${U16.owner2}')
      on conflict (id) do nothing;
    -- R4.10 Increment 7: menu_items.available now defaults to FALSE, so a fixture
    -- that intends a PUBLISHED product states it. This says explicitly what it
    -- previously inherited from the default; an UPDATE would be the wrong fix
    -- here because RLS can refuse it silently and leave the row hidden.
    insert into menu_items (id, name, category, price, image, tax_code, available) values
      ('mp_std',  'Std Shake',  'milkshakes', 4,    '/fx.webp', 'STANDARD_RATE', true),
      ('mp_zero', 'Zero Snack', 'extras',     1.50, '/fx.webp', 'ZERO_RATED',    true)
      on conflict (id) do nothing;
    insert into deals (id, name, type, amount_off, active) values ('deal_vat', 'VAT Alloc Probe', 'fixed_off_order', 0.55, true)
      on conflict (id) do nothing;
    select count(*) from stores where id = 's_unconf' and vat_config_confirmed_at is null;`);
expectOk('WS6d fixtures: an UNCONFIRMED store + its staff, a store-less second owner, classified + zero-rated products, and the allocation-probe deal (superuser arrangement applied)',
  'service', `select 1;`, (o) => o.trim() === '1');
expectDeny('WS6d: a store that never completed VAT setup CANNOT trade (gate, not a default)',
  U16.staffU, `select create_order_quote('{"id":"ord_vu","total":1,"items":[{"menuItemId":"mp_std","quantity":1}]}'::jsonb);`, 'store_vat_unconfigured');
expectDeny('WS6d: a staff profile with NO home store cannot sell either',
  U16.owner2, `select create_order_quote('{"id":"ord_vo","total":1,"items":[{"menuItemId":"mp_std","quantity":1}]}'::jsonb);`, 'store_vat_unconfigured');

/* NOT_REGISTERED zero-truth: even a STANDARD-classified product sells at 0. */
expectOk('WS7 fixture: registered card terminals cover every store so far',
  'service', `insert into payment_terminals (id, store_id, provider, merchant_id, terminal_id)
                select 'term_' || id, id, 'stripe_terminal', 'acct_mp', 'T_' || id from stores
                on conflict (id) do nothing;
              select (count(*) > 0)::text from payment_terminals;`,
  (o) => o.trim() === 'true');

expectOk('WS6d: a NOT_REGISTERED sale of a STANDARD-classified product records 0/0 + the status snapshot',
  U.staffB, `${saleSql('ord_v1', '{"id":"ord_v1","total":9,"items":[{"menuItemId":"mp_std","quantity":2}]}')} select (o ->> 'tax_rate') || '/' || (o ->> 'tax_amount') || '/' || (o ->> 'store_vat_status') || '/' || coalesce(o ->> 'vat_effective_date', '∅')
             from (select to_jsonb(o2) as o from orders o2 where o2.quote_id = 'ord_v1') t;`,
  (o) => o.trim() === '0.00/0.00/NOT_REGISTERED/∅');
expectOk('WS6d: …and its LINE snapshot carries the classification with rate 0 (regime evidence)',
  'service', `select string_agg(tax_code || '@' || tax_rate || '=' || tax_amount || ' of ' || taxable_amount, ' + ' order by tax_code)
              from order_items where order_id = (select id from orders where coalesce(quote_id, id) = 'ord_v1');`,
  (o) => o.trim() === 'STANDARD_RATE@0.00=0.00 of 8.00');
expectDeny('WS6d: no writer can fake charged VAT onto a NOT_REGISTERED snapshot',
  'service', `insert into orders (id, order_number, subtotal, total, completed_at, store_vat_status, tax_rate, tax_amount)
              values ('s3_vat2', 9201, 1, 1, now(), 'NOT_REGISTERED', 20, 0.17);`, 'violates check');

/* Registration is a forward-only act. */
expectOk('WS6d: the store registers for VAT (valid GB number + effective date)',
  'service', `update stores set vat_status = 'REGISTERED', vat_number = 'GB123456789', vat_registration_effective_date = '2026-01-01' where id = 's2' returning vat_status;`,
  (o) => o.trim() === 'REGISTERED');
expectOk('WS6d: registering is FORWARD-ONLY — the pre-registration order is byte-identical',
  'service', `select tax_rate || '/' || tax_amount || '/' || store_vat_status from orders where coalesce(quote_id, id) = 'ord_v1';`,
  (o) => o.trim() === '0.00/0.00/NOT_REGISTERED');
expectDeny('WS6d: a REGISTERED store cannot sell an UNCLASSIFIED product (no defaulting)',
  U.staffB, `select create_order_quote('{"id":"ord_v2","total":9,"items":[{"menuItemId":"m_matrix","quantity":1}]}'::jsonb);`, 'product_tax_unclassified');

/* REGISTERED derivation: uniform rate, then mixed rates with exact allocation. */
expectOk('WS7 fixture: registered card terminals cover every store so far',
  'service', `insert into payment_terminals (id, store_id, provider, merchant_id, terminal_id)
                select 'term_' || id, id, 'stripe_terminal', 'acct_mp', 'T_' || id from stores
                on conflict (id) do nothing;
              select (count(*) > 0)::text from payment_terminals;`,
  (o) => o.trim() === 'true');

expectOk('WS6d: a uniform REGISTERED sale derives the single-rounding contained VAT (£4.00 @20% → £0.67)',
  U.staffB, `${saleSql('ord_v3', '{"id":"ord_v3","total":9,"items":[{"menuItemId":"mp_std","quantity":1}]}')} select (o ->> 'tax_rate') || '/' || (o ->> 'tax_amount') || '/' || (o ->> 'vat_effective_date')
             from (select to_jsonb(o2) as o from orders o2 where o2.quote_id = 'ord_v3') t;`,
  (o) => o.trim() === '20.00/0.67/2026-01-01');
expectOk('WS7 fixture: registered card terminals cover every store so far',
  'service', `insert into payment_terminals (id, store_id, provider, merchant_id, terminal_id)
                select 'term_' || id, id, 'stripe_terminal', 'acct_mp', 'T_' || id from stores
                on conflict (id) do nothing;
              select (count(*) > 0)::text from payment_terminals;`,
  (o) => o.trim() === 'true');

expectOk('WS6d: a MIXED-rate discounted sale — deterministic allocation, order tax = Σ line taxes, headline rate NULL',
  U.staffB, `${saleSql('ord_v4', '{"id":"ord_v4","total":9,"dealIds":["deal_vat"],"items":[{"menuItemId":"mp_std","quantity":1},{"menuItemId":"mp_zero","quantity":1}]}')} select coalesce(o ->> 'tax_rate', '∅') || '/' || (o ->> 'tax_amount') || '/' || (o ->> 'total') || '/' || (o ->> 'discount_total')
             from (select to_jsonb(o2) as o from orders o2 where o2.quote_id = 'ord_v4') t;`,
  (o) => o.trim() === '∅/0.60/4.95/0.55');
expectOk('WS6d: …with exact per-line shares (std: 3.60 taxable → 0.60 tax; zero: 1.35 → 0.00)',
  'service', `select string_agg(tax_code || '@' || tax_rate || '=' || tax_amount || ' of ' || taxable_amount, ' + ' order by tax_code)
              from order_items where order_id = (select id from orders where coalesce(quote_id, id) = 'ord_v4');`,
  (o) => o.trim() === 'STANDARD_RATE@20.00=0.60 of 3.60 + ZERO_RATED@0.00=0.00 of 1.35');
expectOk('WS6d: re-classifying a product later leaves every prior line snapshot intact',
  'service', `update menu_items set tax_code = 'ZERO_RATED' where id = 'mp_std';
              select tax_code || '/' || tax_rate || '/' || tax_amount from order_items where order_id = (select id from orders where coalesce(quote_id, id) = 'ord_v3');`,
  (o) => o.trim() === 'STANDARD_RATE/20.00/0.67');

/* The fallback SOURCES are gone from the effective schema. */
expectOk('WS6d: no site_settings VAT columns; orders.tax_rate has NO default and is nullable',
  'service', `select (select count(*) from information_schema.columns where table_name = 'site_settings' and column_name in ('vat_rate_percent','vat_number'))::text
              || '/' || coalesce((select column_default from information_schema.columns where table_name = 'orders' and column_name = 'tax_rate'), '∅')
              || '/' || (select is_nullable from information_schema.columns where table_name = 'orders' and column_name = 'tax_rate');`,
  (o) => o.trim() === '0/∅/YES');


/* ---------------------------------------------------------------- */
/* 17. WS6e — STORE SETUP LIFECYCLE (closure brief §1 completion)   */
/*     DRAFT default · activation coherence · the setup gate ·      */
/*     wizard RPC auth + validation · accepted payment set ·        */
/*     RPC-only config/VAT guard · store-ID immutability.           */
/* ---------------------------------------------------------------- */
const U17 = {
  staffD: '00000000-0000-4000-8000-0000000000d3', // team member at the DRAFT store
};

expectOk('WS6e fixtures: a fresh store (s_setup), a vat-confirmed DRAFT store (s_draft) + its staff',
  'service', `
    insert into stores (id, name, address, postcode) values
      ('s_setup', 'Setup Probe', '4 Harness Way', 'B3 3CC'),
      ('s_draft', 'Draft Trading', '5 Harness Way', 'B4 4DD')
      on conflict (id) do nothing;
    update stores set vat_config_confirmed_at = now() where id = 's_draft';
    insert into staff_profiles (id, name, email, role, store_id, store_name, auth_id)
      values ('emp_draft', 'Dana Draft', 'dd@test.local', 'team_member', 's_draft', 'Draft Trading', '${U17.staffD}')
      on conflict (id) do nothing;
    select setup_status from stores where id = 's_setup';`,
  (o) => o.trim() === 'DRAFT');
expectDeny('WS6e: ACTIVE without the full configuration is impossible',
  'service', `update stores set setup_status = 'ACTIVE' where id = 's_setup';`, 'violates check');
expectDeny('WS6e: an unknown payment method cannot be part of an ACTIVE config',
  'service', `update stores set setup_status = 'ACTIVE', timezone = 'Europe/London', currency_code = 'GBP', payment_methods = '["cash","bitcoin"]'::jsonb where id = 's_setup';`, 'violates check');
expectDeny('WS6e: a DUPLICATED payment method cannot be part of an ACTIVE config',
  'service', `update stores set setup_status = 'ACTIVE', timezone = 'Europe/London', currency_code = 'GBP', payment_methods = '["cash","cash"]'::jsonb where id = 's_setup';`, 'violates check');
expectDeny('WS6e: a malformed currency code cannot be part of an ACTIVE config',
  'service', `update stores set setup_status = 'ACTIVE', timezone = 'Europe/London', currency_code = 'gbp', payment_methods = '["cash"]'::jsonb where id = 's_setup';`, 'violates check');

/* The gate ordering contract: unconfirmed VAT reports first; DRAFT next. */
expectDeny('WS6e: the §16 contract holds — an UNCONFIRMED store still reports store_vat_unconfigured',
  U16.staffU, `select create_order_quote('{"id":"ord_su1","total":1,"items":[{"menuItemId":"mp_zero","quantity":1}]}'::jsonb);`, 'store_vat_unconfigured');
expectDeny('WS6e: a vat-confirmed store still in DRAFT cannot trade (store_setup_incomplete)',
  U17.staffD, `select create_order_quote('{"id":"ord_sd1","total":1,"items":[{"menuItemId":"mp_zero","quantity":1}]}'::jsonb);`, 'store_setup_incomplete');

/* The wizard RPC: owner + MFA, field validation, atomic activation. */
expectDeny('WS6e: a MANAGER (even aal2) cannot run the Store Setup Wizard',
  `${U.mgrA}@aal2`, `select configure_store_setup('{"storeId":"s_draft","timezone":"Europe/London","currencyCode":"GBP","paymentMethods":["card"],"vat":{"status":"NOT_REGISTERED"}}'::jsonb);`, 'owner_aal2_required');
expectDeny('WS6e: the OWNER at aal1 (no MFA) cannot run it either',
  U.owner, `select configure_store_setup('{"storeId":"s_draft","timezone":"Europe/London","currencyCode":"GBP","paymentMethods":["card"],"vat":{"status":"NOT_REGISTERED"}}'::jsonb);`, 'owner_aal2_required');
expectDeny('WS6e→WS6f: a non-launch timezone is refused by the wizard (vocabulary before the IANA proof)',
  `${U.owner}@aal2`, `select configure_store_setup('{"storeId":"s_draft","timezone":"Mars/OlympusMons","currencyCode":"GBP","paymentMethods":["card"],"vat":{"status":"NOT_REGISTERED"}}'::jsonb);`, 'unsupported_timezone');
expectDeny('WS6e: REGISTERED without a VAT number is refused by the wizard (named error before the constraint)',
  `${U.owner}@aal2`, `select configure_store_setup('{"storeId":"s_draft","timezone":"Europe/London","currencyCode":"GBP","paymentMethods":["card"],"vat":{"status":"REGISTERED"}}'::jsonb);`, 'invalid_vat_config');
expectOk('WS6e: the owner (aal2) activates the DRAFT store atomically — config + VAT confirm + ACTIVE',
  `${U.owner}@aal2`, `select (r ->> 'setup_status') || '/' || (r ->> 'timezone') || '/' || (r ->> 'currency_code') || '/' || (r ->> 'vat_status')
             from (select configure_store_setup('{"storeId":"s_draft","timezone":"Europe/London","currencyCode":"GBP","paymentMethods":["card"],"receiptFooter":"Thanks!","vat":{"status":"NOT_REGISTERED"}}'::jsonb) as r) t;`,
  (o) => o.trim() === 'ACTIVE/Europe/London/GBP/NOT_REGISTERED');
expectOk('WS7 fixture: registered card terminals cover every store so far',
  'service', `insert into payment_terminals (id, store_id, provider, merchant_id, terminal_id)
                select 'term_' || id, id, 'stripe_terminal', 'acct_mp', 'T_' || id from stores
                on conflict (id) do nothing;
              select (count(*) > 0)::text from payment_terminals;`,
  (o) => o.trim() === 'true');

expectOk('WS6e: …and the store can now trade with a CONFIGURED payment method',
  U17.staffD, `${saleSql('ord_sd2', '{"id":"ord_sd2","items":[{"menuItemId":"mp_zero","quantity":1}]}')} select store_vat_status from orders where quote_id = 'ord_sd2';`,
  (o) => o.trim() === 'NOT_REGISTERED');
expectDeny("WS6e: a valid method OUTSIDE the store's configured set is refused (cash not accepted here)",
  U17.staffD, `select create_order_quote('{"id":"ord_sd3","items":[{"menuItemId":"mp_zero","quantity":1}]}'::jsonb);
               select begin_quote_payment('{"quoteId":"ord_sd3","reservationId":"res_ord_sd3","method":"cash","deviceId":"dev_matrix","cashSessionId":"x"}'::jsonb);
               select finalise_order_payment('{"quoteId":"ord_sd3","reservationId":"res_ord_sd3","method":"cash","cashReceived":"9.00","tillSessionId":"x","deviceId":"y"}'::jsonb);`, 'payment_method_not_accepted');
expectOk('WS6e→WS6f: the owner classifies the last unclassified product (the WS6f gate now precedes REGISTERED)',
  `${U.owner}@aal2`, `select classify_products('[{"id":"m_matrix","taxCode":"ZERO_RATED"}]'::jsonb);`,
  (o) => o.trim() === '1');
expectOk('WS6e: the wizard also carries the REGISTERED path (valid GB number + effective date)',
  `${U.owner}@aal2`, `select (r ->> 'setup_status') || '/' || (r ->> 'vat_status') || '/' || (r ->> 'vat_number')
             from (select configure_store_setup('{"storeId":"s_setup","timezone":"Europe/London","currencyCode":"GBP","paymentMethods":["card","cash"],"vat":{"status":"REGISTERED","vatNumber":"GB987654321","effectiveDate":"2026-02-01"}}'::jsonb) as r) t;`,
  (o) => o.trim() === 'ACTIVE/REGISTERED/GB987654321');

/* The guard: config + VAT columns are RPC/service-only for API sessions. */
expectDeny('WS6e: even the OWNER cannot DIRECTLY edit a config column (RPC-only guard)',
  `${U.owner}@aal2`, `update stores set timezone = 'UTC' where id = 's_draft';`, 'store_config_is_rpc_only');
expectDeny('WS6e: …nor a VAT column — the WS6d follow-up guard is live',
  `${U.owner}@aal2`, `update stores set vat_config_confirmed_at = null where id = 's_draft';`, 'store_config_is_rpc_only');
expectOk('WS6e: a replace_collection publish that OMITS the guarded keys succeeds untouched',
  `${U.owner}@aal2`, `select jsonb_array_length((replace_collection('stores',
      (select jsonb_agg(jsonb_build_object('id', id,
                'name', case when id = 's_draft' then 'Draft Renamed' else name end,
                'address', address, 'postcode', postcode)) from stores),
      (select count(*)::int from stores),
      (select revision from collection_revisions where table_key='stores')))->'rows');`,
  (o) => Number(o.trim()) >= 5);
expectOk('WS6e: …and the renamed store kept its FULL configuration (absent keys touch nothing)',
  'service', `select name || '/' || setup_status || '/' || timezone || '/' || currency_code from stores where id = 's_draft';`,
  (o) => o.trim() === 'Draft Renamed/ACTIVE/Europe/London/GBP');
expectDeny("WS6e: a store's ID can never be rewritten (closure brief §1 immutability)",
  'service', `update stores set id = 's_draft2' where id = 's_draft';`, 'store_id_immutable');

/* ---------------------------------------------------------------- */
/* 18. WS6f — VAT & SETUP CORRECTIONS (Round-9 audit items)         */
/*     F1 effective-date charging · F3/F4 owner classification ·    */
/*     F5 modifier components · F6 store-scoped idempotency ·       */
/*     F8 gift-card server parity · F10 vocabulary · F11 exposure.  */
/* ---------------------------------------------------------------- */
const U18 = {
  staffF: '00000000-0000-4000-8000-0000000000d4', // team member at the effective-date store
};

/* INC11: this fixture block INSERTs rows born-published (available/active
   true) — the lifecycle guard now refuses that for every API role,
   service_role included, by design. Fixture arrangement belongs to the
   harness, so the block moves to the superuser path verbatim; the
   ASSERTIONS that consume these fixtures are untouched. */
psql(`-d ${DB} -tA`, `
    insert into stores (id, name, address, postcode, vat_status, vat_number, vat_registration_effective_date,
                        vat_config_confirmed_at, setup_status, timezone, currency_code, payment_methods)
      values ('s_fx', 'Effective Probe', '6 Harness Way', 'B5 5EE', 'REGISTERED', 'GB555666777',
              (now() at time zone 'Europe/London')::date + 1, now(), 'ACTIVE', 'Europe/London', 'GBP',
              '["card"]'::jsonb)
      on conflict (id) do nothing;
    insert into staff_profiles (id, name, email, role, store_id, store_name, auth_id)
      values ('emp_fx', 'Fern Future', 'ff@test.local', 'team_member', 's_fx', 'Effective Probe', '${U18.staffF}')
      on conflict (id) do nothing;
    -- R4.10 Increment 7: see above — a published fixture says so explicitly.
    insert into menu_items (id, name, category, price, image, tax_code, available) values
      ('mp_fx_std', 'Std Fx Shake', 'milkshakes', 4,    '/fx.webp', 'STANDARD_RATE', true),
      ('mp_zbase',  'Zero Base',    'milkshakes', 3,    '/fx.webp', 'ZERO_RATED',    true),
      ('mp_ex',     'Std Extra',    'extras',     1,    '/fx.webp', 'STANDARD_RATE', true)
      on conflict (id) do nothing;
    select vat_status || '/' || (vat_registration_effective_date > (now() at time zone timezone)::date)::text
      from stores where id = 's_fx';`);
expectOk('WS6f fixtures: a FUTURE-dated REGISTERED store (s_fx) + staff, classified products incl. a STANDARD extra (superuser arrangement applied)',
  'service', `select 1;`, (o) => o.trim() === '1');

/* F1 — the effective date gates CHARGING, not just the status. */
expectOk('WS7 fixture: registered card terminals cover every store so far',
  'service', `insert into payment_terminals (id, store_id, provider, merchant_id, terminal_id)
                select 'term_' || id, id, 'stripe_terminal', 'acct_mp', 'T_' || id from stores
                on conflict (id) do nothing;
              select (count(*) > 0)::text from payment_terminals;`,
  (o) => o.trim() === 'true');

expectOk('WS6f: a FUTURE-dated REGISTERED sale of a STANDARD product charges 0/0 yet snapshots REGISTERED + the date',
  U18.staffF, `${saleSql('ord_f1', '{"id":"ord_f1","total":9,"items":[{"menuItemId":"mp_fx_std","quantity":1}]}')} select (o ->> 'tax_rate') || '/' || (o ->> 'tax_amount') || '/' || (o ->> 'store_vat_status') || '/'
                    || ((o ->> 'vat_effective_date') = (select vat_registration_effective_date::text from stores where id = 's_fx'))::text
               from (select to_jsonb(o2) as o from orders o2 where o2.quote_id = 'ord_f1') t;`,
  (o) => o.trim() === '0.00/0.00/REGISTERED/true');
expectOk('WS6f: the registration date ARRIVES (service backdates) — the same product now charges 20% (£4.00 → £0.67)',
  'service', `update stores set vat_registration_effective_date = (now() at time zone 'Europe/London')::date - 1 where id = 's_fx' returning 'ok';`,
  (o) => o.trim() === 'ok');
expectOk('WS7 fixture: registered card terminals cover every store so far',
  'service', `insert into payment_terminals (id, store_id, provider, merchant_id, terminal_id)
                select 'term_' || id, id, 'stripe_terminal', 'acct_mp', 'T_' || id from stores
                on conflict (id) do nothing;
              select (count(*) > 0)::text from payment_terminals;`,
  (o) => o.trim() === 'true');

expectOk('WS6f: …proven by the next sale',
  U18.staffF, `${saleSql('ord_f2', '{"id":"ord_f2","total":9,"items":[{"menuItemId":"mp_fx_std","quantity":1}]}')} select (o ->> 'tax_rate') || '/' || (o ->> 'tax_amount')
               from (select to_jsonb(o2) as o from orders o2 where o2.quote_id = 'ord_f2') t;`,
  (o) => o.trim() === '20.00/0.67');
expectOk('WS6f: the PRE-effective order is byte-identical after the date arrives (forward-only)',
  'service', `select tax_rate || '/' || tax_amount || '/' || store_vat_status from orders where coalesce(quote_id, id) = 'ord_f1';`,
  (o) => o.trim() === '0.00/0.00/REGISTERED');

/* F5 — an extra is taxed by ITS OWN classification. */
expectOk('WS7 fixture: registered card terminals cover every store so far',
  'service', `insert into payment_terminals (id, store_id, provider, merchant_id, terminal_id)
                select 'term_' || id, id, 'stripe_terminal', 'acct_mp', 'T_' || id from stores
                on conflict (id) do nothing;
              select (count(*) > 0)::text from payment_terminals;`,
  (o) => o.trim() === 'true');

expectOk("WS6f: a STANDARD extra on a ZERO base is taxed at the EXTRA's rate (line NULL rate, order tax 0.17)",
  U18.staffF, `${saleSql('ord_f3', '{"id":"ord_f3","total":9,"items":[{"menuItemId":"mp_zbase","quantity":1,"modifiers":[{"menuItemId":"mp_ex"}]}]}')} select coalesce(o ->> 'tax_rate', '∅') || '/' || (o ->> 'tax_amount') || '/' || (o ->> 'total')
               from (select to_jsonb(o2) as o from orders o2 where o2.quote_id = 'ord_f3') t;`,
  (o) => o.trim() === '∅/0.17/4.00');
expectOk('WS6f: …the LINE snapshots the base code with a NULL mixed rate; the MODIFIER row snapshots its own',
  'service', `select (select tax_code || '/' || coalesce(tax_rate::text, '∅') || '/' || tax_amount || ' of ' || taxable_amount
                        from order_items where order_id = (select id from orders where coalesce(quote_id, id) = 'ord_f3'))
              || ' | ' ||
              (select tax_code || '@' || tax_rate || '=' || tax_amount || ' of ' || taxable_amount
                 from order_item_modifiers where order_id = (select id from orders where coalesce(quote_id, id) = 'ord_f3'));`,
  (o) => o.trim() === 'ZERO_RATED/∅/0.17 of 4.00 | STANDARD_RATE@20.00=0.17 of 1.00');
expectOk('WS7 fixture: registered card terminals cover every store so far',
  'service', `insert into payment_terminals (id, store_id, provider, merchant_id, terminal_id)
                select 'term_' || id, id, 'stripe_terminal', 'acct_mp', 'T_' || id from stores
                on conflict (id) do nothing;
              select (count(*) > 0)::text from payment_terminals;`,
  (o) => o.trim() === 'true');

expectOk('WS6f: a DISCOUNTED mixed-component line allocates base-then-extra with exact pence (55p → 41/14; tax 0.14)',
  U18.staffF, `${saleSql('ord_f4', '{"id":"ord_f4","total":9,"dealIds":["deal_vat"],"items":[{"menuItemId":"mp_zbase","quantity":1,"modifiers":[{"menuItemId":"mp_ex"}]}]}')} select coalesce(o ->> 'tax_rate', '∅') || '/' || (o ->> 'tax_amount') || '/' || (o ->> 'total') || '/' || (o ->> 'discount_total')
               from (select to_jsonb(o2) as o from orders o2 where o2.quote_id = 'ord_f4') t;`,
  (o) => o.trim() === '∅/0.14/3.45/0.55');
expectOk("WS6f: …with the modifier's exact discounted share (taxable 0.86 → tax 0.14)",
  'service', `select tax_amount || ' of ' || taxable_amount from order_item_modifiers where order_id = (select id from orders where coalesce(quote_id, id) = 'ord_f4');`,
  (o) => o.trim() === '0.14 of 0.86');

/* WS6g (Round-9e item 2): gift_card is OUT of the launch vocabulary — it is
   refused at the till because no store can configure it. */
expectDeny('WS6g: a gift_card sale is refused (the method is not in any configured set)',
  U18.staffF, `select create_order_quote('{"id":"ord_f5","items":[{"menuItemId":"mp_zbase","quantity":1}]}'::jsonb);
               select begin_quote_payment('{"quoteId":"ord_f5","reservationId":"res_ord_f5","method":"gift_card","deviceId":"dev_matrix"}'::jsonb);
               select finalise_order_payment('{"quoteId":"ord_f5","reservationId":"res_ord_f5","method":"gift_card","providerReference":"G-1","approvedAmount":"3.00"}'::jsonb);`, 'payment_method_not_accepted');

/* F6 — idempotency is caller-store-scoped. */
expectDeny("WS6f: replaying ANOTHER store's order id is refused (order_id_conflict), not served",
  U.staffB, `select create_order_quote('{"id":"ord_f1","items":[{"menuItemId":"mp_zero","quantity":1}]}'::jsonb);`, 'quote_id_conflict');
expectOk('WS6f→WS7: a SAME-store QUOTE replay returns the stored quote (finalisation idempotence is proven separately in §21)',
  U18.staffF, `select (create_order_quote('{"id":"ord_f1","items":[{"menuItemId":"mp_fx_std","quantity":1}]}'::jsonb)) ->> 'duplicate';`,
  (o) => o.trim() === 'true');

/* F3/F4 — classification is an owner decision with a hard server gate. */
expectDeny("WS6f: a MANAGER (aal2) cannot change a product's tax classification",
  `${U.mgrA}@aal2`, `update menu_items set tax_code = 'STANDARD_RATE' where id = 'm_matrix';`, 'tax_code_is_owner_only');
expectDeny('WS6f: …nor INSERT a pre-classified product',
  `${U.mgrA}@aal2`, `insert into menu_items (id, name, category, price, image, tax_code) values ('m_sneak', 'Sneak', 'milkshakes', 1, '', 'ZERO_RATED');`, 'tax_code_is_owner_only');
expectOk('WS6f fixtures: a fresh DRAFT store for the REGISTERED-activation gate',
  'service', `insert into stores (id, name, address, postcode) values ('s_fx2', 'Classify Gate', '7 Harness Way', 'B6 6FF') on conflict (id) do nothing; select setup_status from stores where id = 's_fx2';`,
  (o) => o.trim() === 'DRAFT');
/* WS6h (Round 9f): withdrawing a classification while a store is CHARGING is
   now refused — §20 proves both directions of that guard. A store IS charging
   at this point in §18, so the unclassified PRE-STATE the activation gate
   needs below is established through the service path; the gate itself is
   what this probe pair is about. */
/* WS6i (Round 9g): a classification is permanent, so the unclassified
   pre-state the activation gate needs is created by INSERTING a new
   unclassified product — never by withdrawing an existing one. */
expectOk('WS6f: an unclassified product exists for the activation gate',
  'service', `insert into menu_items (id, name, category, price, image)
                values ('m_gate', 'Gate Probe', 'milkshakes', 3, '/fx.webp') on conflict (id) do nothing;
              select coalesce(tax_code, '∅') from menu_items where id = 'm_gate';`,
  (o) => o.trim() === '∅');
expectDeny('WS6f: the wizard REFUSES to make a store REGISTERED while ANY product is unclassified',
  `${U.owner}@aal2`, `select configure_store_setup('{"storeId":"s_fx2","timezone":"Europe/London","currencyCode":"GBP","paymentMethods":["card"],"vat":{"status":"REGISTERED","vatNumber":"GB111222333","effectiveDate":"2026-01-01"}}'::jsonb);`, 'products_unclassified');
expectOk('WS6f: the OWNER classifies the last product through the RPC',
  `${U.owner}@aal2`, `select classify_products('[{"id":"m_gate","taxCode":"STANDARD_RATE"}]'::jsonb);`,
  (o) => o.trim() === '1');
expectOk('WS6f: …and the SAME activation now succeeds',
  `${U.owner}@aal2`, `select (r ->> 'setup_status') || '/' || (r ->> 'vat_status')
             from (select configure_store_setup('{"storeId":"s_fx2","timezone":"Europe/London","currencyCode":"GBP","paymentMethods":["card"],"vat":{"status":"REGISTERED","vatNumber":"GB111222333","effectiveDate":"2026-01-01"}}'::jsonb) as r) t;`,
  (o) => o.trim() === 'ACTIVE/REGISTERED');

/* F10 — the launch vocabulary at the RPC AND the database. */
expectDeny('WS6f: a non-launch currency is refused by the wizard',
  `${U.owner}@aal2`, `select configure_store_setup('{"storeId":"s_fx2","timezone":"Europe/London","currencyCode":"EUR","paymentMethods":["card"],"vat":{"status":"NOT_REGISTERED"}}'::jsonb);`, 'unsupported_currency');
expectDeny('WS6f: even a privileged direct write cannot set a non-launch timezone (CHECK)',
  'service', `update stores set timezone = 'UTC' where id = 's_fx';`, 'violates check');

/* F11 — the anonymous surface is the locator view, nothing more. */
expectDeny('WS6f: anon cannot read the stores TABLE at all (grant revoked)',
  'anon', `select count(*) from stores;`, 'permission denied');
expectOk('WS6f: anon reads the LOCATOR through stores_public',
  'anon', `select (count(*) >= 6)::text from stores_public;`,
  (o) => o.trim() === 'true');
/* --- R4.9 G4: the anonymous MENU surface, same pattern as the locator ------ */
/* INC11: lifecycle columns are sanctioned-context only — service_role is an
   API role, so the old service-run withdrawal is now refused by design
   (lifecycle_change_refused). The withdrawal is harness ARRANGEMENT, so it
   moves to the superuser fixture path; the G4 ASSERTIONS below are untouched
   and still run as anon/owner. */
psql(`-d ${DB} -tA`, `update menu_items set available = false where id = (select id from menu_items order by id limit 1);`);
expectDeny('G4: anon cannot read the menu_items TABLE at all (grant revoked)',
  'anon', `select count(*) from menu_items;`, 'permission denied');
expectOk('G4: anon reads the menu through menu_items_public',
  'anon', `select (count(*) > 0)::text from menu_items_public;`,
  (o) => o.trim() === 'true');
expectOk('G4: the withdrawn product is ABSENT from the anonymous view',
  'anon', `select count(*)::text from menu_items_public where not available;`,
  (o) => o.trim() === '0');
expectOk('G4: …and the view holds exactly the available population',
  'service', `select (
     (select count(*) from menu_items_public) = (select count(*) from menu_items where available)
   )::text;`, (o) => o.trim() === 'true');
expectDeny('G4: the view has no tax_code column to leak',
  'anon', `select tax_code from menu_items_public limit 1;`, 'does not exist');
expectOk('G4: staff still see the FULL catalogue including withdrawn products',
  `${U.owner}@aal2`, `select (count(*) > (select count(*) from menu_items where available))::text from menu_items;`,
  (o) => o.trim() === 'true');
/* INC11: same conversion as the fixture above — cleanup is arrangement. */
psql(`-d ${DB} -tA`, `update menu_items set available = true where not available;`);

expectDeny('WS6f: the view simply has no VAT/config columns to leak',
  'anon', `select vat_status from stores_public limit 1;`, 'does not exist');
expectOk("WS6f: signed-in staff keep the FULL row (the till's configuration path)",
  U.staffA, `select vat_status || '/' || setup_status from stores where id = 's1';`,
  (o) => o.trim() === 'NOT_REGISTERED/ACTIVE');

/* --- WS6f-b: classification SURVIVAL and the post-activation hole ---
   The classification gate fires at ACTIVATION. A menu published afterwards
   is the operational path that can still introduce an unclassified product,
   so these probe what actually happens: publishes must never WIPE a
   classification, and a newly published product must fail closed on its own
   without taking the rest of the menu down. */
expectOk('WS6f-b: a MANAGER publish (replace_collection, taxCode omitted) PRESERVES every classification',
  `${U.mgrA}@aal2`, `select jsonb_array_length((replace_collection('menu_items',
      (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'category', category,
                                           'price', price, 'image', image)) from menu_items),
      (select count(*)::int from menu_items),
      (select revision from collection_revisions where table_key='menu_items')))->'rows')::text;`,
  (o) => Number(o.trim()) >= 3);
expectOk('WS6f-b: …proven on the classified fixtures (nothing reverted to unclassified)',
  'service', `select string_agg(id || '=' || coalesce(tax_code, '∅'), ',' order by id)
                from menu_items where id in ('mp_fx_std','mp_zbase','mp_ex');`,
  (o) => o.trim() === 'mp_ex=STANDARD_RATE,mp_fx_std=STANDARD_RATE,mp_zbase=ZERO_RATED');
expectOk('WS6f-b: a MANAGER publish may ADD a product, but it lands UNCLASSIFIED (the column stays owner-only)',
  `${U.mgrA}@aal2`, `select jsonb_array_length((replace_collection('menu_items',
      (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'category', category,
                                           'price', price, 'image', image)) from menu_items)
      || jsonb_build_array(jsonb_build_object('id', 'mp_new', 'name', 'Late Addition',
                                              'category', 'milkshakes', 'price', 5, 'image', '')),
      (select count(*)::int from menu_items),
      (select revision from collection_revisions where table_key='menu_items')))->'rows')::text;`,
  (o) => Number(o.trim()) >= 4);
expectOk('WS6f-b: …the new product is unclassified',
  'service', `select coalesce(tax_code, '∅') from menu_items where id = 'mp_new';`,
  (o) => o.trim() === '∅');
expectDeny('WS6f-b: a CHARGING store refuses to sell that product (fails closed, per product)',
  U18.staffF, `select create_order_quote('{"id":"ord_f6","total":9,"items":[{"menuItemId":"mp_new","quantity":1}]}'::jsonb);`, 'product_tax_unclassified');
expectOk('WS7 fixture: registered card terminals cover every store so far',
  'service', `insert into payment_terminals (id, store_id, provider, merchant_id, terminal_id)
                select 'term_' || id, id, 'stripe_terminal', 'acct_mp', 'T_' || id from stores
                on conflict (id) do nothing;
              select (count(*) > 0)::text from payment_terminals;`,
  (o) => o.trim() === 'true');

expectOk('WS6f-b: …while the REST of the menu keeps selling normally (no menu-wide outage)',
  U18.staffF, `${saleSql('ord_f7', '{"id":"ord_f7","total":9,"items":[{"menuItemId":"mp_fx_std","quantity":1}]}')} select (o ->> 'tax_rate') || '/' || (o ->> 'tax_amount')
               from (select to_jsonb(o2) as o from orders o2 where o2.quote_id = 'ord_f7') t;`,
  (o) => o.trim() === '20.00/0.67');
expectOk('WS6f-b: the OWNER classifies the late addition (the standalone editor path)',
  `${U.owner}@aal2`, `select classify_products('[{"id":"mp_new","taxCode":"REDUCED_RATE"}]'::jsonb);`,
  (o) => o.trim() === '1');
expectOk('WS7 fixture: registered card terminals cover every store so far',
  'service', `insert into payment_terminals (id, store_id, provider, merchant_id, terminal_id)
                select 'term_' || id, id, 'stripe_terminal', 'acct_mp', 'T_' || id from stores
                on conflict (id) do nothing;
              select (count(*) > 0)::text from payment_terminals;`,
  (o) => o.trim() === 'true');

expectOk('WS6f-b: …and it sells immediately at its own rate (£5.00 @5% → 0.24)',
  U18.staffF, `${saleSql('ord_f8', '{"id":"ord_f8","total":9,"items":[{"menuItemId":"mp_new","quantity":1}]}')} select (o ->> 'tax_rate') || '/' || (o ->> 'tax_amount')
               from (select to_jsonb(o2) as o from orders o2 where o2.quote_id = 'ord_f8') t;`,
  (o) => o.trim() === '5.00/0.24');

/* ---------------------------------------------------------------- */
/* 19. WS6g — STORE SETUP OPERATIONAL CLOSURE (Round 9e)            */
/*     item 2 gift-card vocabulary · item 5 public view scope.      */
/* ---------------------------------------------------------------- */
expectDeny('WS6g: the wizard REFUSES a gift_card configuration (unsupported_payment_method)',
  `${U.owner}@aal2`, `select configure_store_setup('{"storeId":"s_fx2","timezone":"Europe/London","currencyCode":"GBP","paymentMethods":["card","gift_card"],"vat":{"status":"NOT_REGISTERED"}}'::jsonb);`, 'unsupported_payment_method');
expectDeny('WS6g: …and a privileged DIRECT write cannot smuggle it in either (CHECK)',
  'service', `update stores set payment_methods = '["card","gift_card"]'::jsonb where id = 's_fx2';`, 'violates check');
expectOk('WS6g: no store anywhere carries gift_card after the reconciliation',
  'service', `select count(*)::text from stores where payment_methods ? 'gift_card';`,
  (o) => o.trim() === '0');
expectOk('WS6g: a supported set still configures normally',
  `${U.owner}@aal2`, `select (r ->> 'setup_status') || '/' || (r -> 'payment_methods')::text
             from (select configure_store_setup('{"storeId":"s_fx2","timezone":"Europe/London","currencyCode":"GBP","paymentMethods":["cash","card"],"vat":{"status":"NOT_REGISTERED"}}'::jsonb) as r) t;`,
  (o) => o.trim() === 'ACTIVE/["cash", "card"]');

expectOk('WS6g fixtures: a DRAFT store that must NOT be advertised publicly',
  'service', `insert into stores (id, name, address, postcode) values ('s_hidden', 'Not Yet Open', '9 Harness Way', 'B9 9ZZ') on conflict (id) do nothing;
              select setup_status from stores where id = 's_hidden';`,
  (o) => o.trim() === 'DRAFT');
expectOk('WS6g: stores_public EXCLUDES setup-DRAFT stores (item 5)',
  'anon', `select count(*)::text from stores_public where id = 's_hidden';`,
  (o) => o.trim() === '0');
expectOk('WS6g: …while ACTIVE stores are still published',
  'anon', `select (count(*) > 0)::text from stores_public where id = 's1';`,
  (o) => o.trim() === 'true');
/* R4.10 — REPOINTED, NOT DELETED.
   WS6g deliberately removed created_at/updated_at from this view. The production
   SEO loader requires updated_at for the snapshot/manifest contract, and without
   it PostgREST answers 400 and a production build cannot complete at all, so
   migration_r410_stores_public_contract.sql reinstates both and states the
   reversal openly in its header.
   What WS6g was really protecting is that INTERNAL/ADMINISTRATIVE columns never
   reach the anonymous locator — that is asserted below, unchanged in force. The
   row timestamps are now part of the DECLARED public contract, so they are
   asserted PRESENT here: a future migration that silently drops them again fails
   in this matrix as well as in scripts/r410-public-contract-reconciliation.mjs. */
expectOk('R4.10: stores_public publishes the row timestamps the production contract requires',
  'anon', `select (created_at is not null and updated_at is not null)::text
             from stores_public where id = 's1';`,
  (o) => o.trim() === 'true');
expectDeny('WS6g/R4.10: the view STILL hides the internal setup_status column',
  'anon', `select setup_status from stores_public limit 1;`, 'does not exist');
expectDeny('WS6g: anon STILL cannot read the base table',
  'anon', `select count(*) from stores;`, 'permission denied');

/* ---------------------------------------------------------------- */
/* 20. WS6i — CLASSIFICATION PERMANENCE (Round 9g)                  */
/*     A classification, once set, is permanent metadata: the       */
/*     invariant lives in the TRIGGER and binds every API writer.   */
/* ---------------------------------------------------------------- */
expectOk('WS6i precondition: a store IS charging right now',
  'service', `select (count(*) > 0)::text from stores s
               where s.vat_status = 'REGISTERED'
                 and s.vat_registration_effective_date
                     <= (now() at time zone coalesce(s.timezone, 'Europe/London'))::date;`,
  (o) => o.trim() === 'true');
expectDeny('WS6i: the owner CANNOT withdraw a classification through the RPC',
  `${U.owner}@aal2`, `select classify_products('[{"id":"mp_fx_std","taxCode":null}]'::jsonb);`, 'tax_code_withdrawal_forbidden');
expectDeny("WS6i (finding 2): …nor through a DIRECT PostgREST update — the invariant is in the TRIGGER",
  `${U.owner}@aal2`, `update menu_items set tax_code = null where id = 'mp_fx_std';`, 'tax_code_withdrawal_forbidden');
expectOk('WS6i: …the product kept its classification either way',
  'service', `select tax_code from menu_items where id = 'mp_fx_std';`,
  (o) => o.trim() === 'STANDARD_RATE');
expectOk('WS6i: RE-classifying to another controlled code is still allowed',
  `${U.owner}@aal2`, `select classify_products('[{"id":"mp_fx_std","taxCode":"REDUCED_RATE"}]'::jsonb);`,
  (o) => o.trim() === '1');
expectOk('WS6i fixtures: an UNCLASSIFIED product exists',
  'service', `insert into menu_items (id, name, category, price, image) values ('mp_uncls', 'Unclassified One', 'milkshakes', 2, '') on conflict (id) do nothing;
              select coalesce(tax_code, '∅') from menu_items where id = 'mp_uncls';`,
  (o) => o.trim() === '∅');
expectOk('WS6i: CLASSIFYING an unclassified product is still allowed',
  `${U.owner}@aal2`, `select classify_products('[{"id":"mp_uncls","taxCode":"ZERO_RATED"}]'::jsonb);`,
  (o) => o.trim() === '1');

/* --- finding 1: TIME must not be able to invalidate the database. --- */
expectOk('WS6i (finding 1): every registration pushed into the FUTURE — nothing is charging',
  'service', `update stores set vat_registration_effective_date = (now() at time zone 'Europe/London')::date + 7
               where vat_status = 'REGISTERED';
              select (count(*) = 0)::text from stores s
               where s.vat_status = 'REGISTERED'
                 and s.vat_registration_effective_date
                     <= (now() at time zone coalesce(s.timezone, 'Europe/London'))::date;`,
  (o) => o.trim() === 'true');
expectDeny('WS6i (finding 1): withdrawal is STILL refused under a future-dated registration',
  `${U.owner}@aal2`, `select classify_products('[{"id":"mp_uncls","taxCode":null}]'::jsonb);`, 'tax_code_withdrawal_forbidden');
expectDeny('WS6i (finding 1): …and the direct path is refused there too',
  `${U.owner}@aal2`, `update menu_items set tax_code = null where id = 'mp_uncls';`, 'tax_code_withdrawal_forbidden');
expectOk('WS6i (finding 1): the effective date ARRIVING finds every product still classified',
  'service', `update stores set vat_registration_effective_date = (now() at time zone 'Europe/London')::date - 1
               where id = 's_fx';
              select count(*)::text from menu_items where tax_code is null;`,
  (o) => o.trim() === '0');
expectOk('WS7 fixture: registered card terminals cover every store so far',
  'service', `insert into payment_terminals (id, store_id, provider, merchant_id, terminal_id)
                select 'term_' || id, id, 'stripe_terminal', 'acct_mp', 'T_' || id from stores
                on conflict (id) do nothing;
              select (count(*) > 0)::text from payment_terminals;`,
  (o) => o.trim() === 'true');

expectOk('WS6i (finding 1): …so a sale at the newly-arrived rate simply works (£4.00 @5% → 0.19)',
  U18.staffF, `${saleSql('ord_g1', '{"id":"ord_g1","total":9,"items":[{"menuItemId":"mp_fx_std","quantity":1}]}')} select (o ->> 'tax_rate') || '/' || (o ->> 'tax_amount')
               from (select to_jsonb(o2) as o from orders o2 where o2.quote_id = 'ord_g1') t;`,
  (o) => o.trim() === '5.00/0.19');

/* --- the documented repair path still exists for a real DB session. --- */
expectDeny('WS6i: even the BYPASS-RLS service role cannot withdraw through an API session',
  'service', `update menu_items set tax_code = null where id = 'mp_uncls';`, 'tax_code_withdrawal_forbidden');
expectOk('WS6i: a NON-API session (migration/DBA — jwt claims unset) is the ONE repair path',
  'service', `select set_config('request.jwt.claims', '', false);
              update menu_items set tax_code = null where id = 'mp_uncls';
              select coalesce(tax_code, '∅') from menu_items where id = 'mp_uncls';`,
  (o) => o.split('\n').map(x => x.trim()).filter(Boolean).pop() === '∅');

/* --- finding 4: the server answers what is true right now. --- */
expectOk('WS6i (finding 4): store_trading_state returns the SERVER business date and charging flag',
  U18.staffF, `select (((t ->> 'businessDate') = (now() at time zone 'Europe/London')::date::text))::text
                 || '/' || (t ->> 'vatChargingNow')
               from (select store_trading_state('s_fx') as t) x;`,
  (o) => o.trim() === 'true/true');
expectDeny('WS6i: …and it is store-scoped',
  U.staffA, `select store_trading_state('s_fx');`, 'store_scope_denied');
expectOk('WS6i: configVersion moves when a classification changes',
  `${U.owner}@aal2`, `select store_trading_state('s_fx') ->> 'configVersion';
              select classify_products('[{"id":"m_gate","taxCode":"REDUCED_RATE"}]'::jsonb);
              select store_trading_state('s_fx') ->> 'configVersion';`,
  (o) => { const L = o.split('\n').map(x => x.trim()).filter(Boolean); return L.length === 3 && L[0] !== L[2]; });


/* ---------------------------------------------------------------- */
/* 21. WS7 — QUOTE → PAYMENT → FINALISATION                         */
/*     Self-contained fixtures: a charging store, its till, its      */
/*     operator. Proves that no sale exists before money moves, that */
/*     one basket can never become two sales, and that cash is only  */
/*     recorded against an accountable drawer.                       */
/* ---------------------------------------------------------------- */
const U21 = {
  staffQ: '00000000-0000-4000-8000-0000000000e1',   // operator at the quote store
  staffR: '00000000-0000-4000-8000-0000000000e2',   // operator at ANOTHER store
  staffD: '00000000-0000-4000-8000-0000000000e3',   // operator created DISABLED
};

expectOk('WS7 fixtures: a charging store, its operator, a £6.00 standard-rated product',
  'service', `
    insert into stores (id, name, address, postcode, vat_status, vat_number,
                        vat_registration_effective_date, vat_config_confirmed_at,
                        setup_status, timezone, currency_code, payment_methods)
      values ('s_q', 'Quote Probe', '10 Harness Way', 'Q1 1AA', 'REGISTERED', 'GB123123123',
              (now() at time zone 'Europe/London')::date - 1, now(), 'ACTIVE',
              'Europe/London', 'GBP', '["cash","card"]'::jsonb)
      on conflict (id) do nothing;
    insert into staff_profiles (id, name, email, role, store_id, store_name, auth_id)
      values ('emp_q', 'Quinn Quote', 'qq@test.local', 'team_member', 's_q', 'Quote Probe', '${U21.staffQ}'),
             ('emp_r', 'Rory Remote', 'rr@test.local', 'team_member', 's2',  'Second',      '${U21.staffR}')
      on conflict (id) do nothing;
    -- Created disabled: staff_profiles.status is protected by a lifecycle
    -- trigger and direct table writes are revoked, so the fixture must not
    -- weaken that guard to make itself convenient.
    insert into staff_profiles (id, name, email, role, store_id, store_name, auth_id, status)
      values ('emp_d', 'Dana Disabled', 'dd7@test.local', 'team_member', 's_q', 'Quote Probe', '${U21.staffD}', 'disabled')
      on conflict (id) do nothing;
    insert into menu_items (id, name, category, price, image, tax_code)
      values ('mp_q', 'Quote Shake', 'milkshakes', 6, '', 'STANDARD_RATE')
      on conflict (id) do nothing;
    -- The card namespace is server-known: this store's terminal is registered.
    insert into payment_terminals (id, store_id, provider, merchant_id, terminal_id)
      values ('term_q_01', 's_q', 'stripe_terminal', 'acct_mp', 'T_q_01')
      on conflict (id) do nothing;
    -- The till device is a server-enrolled CUSTODY IDENTITY (correction 10):
    -- a manager/owner would call enrol_till_device(); the fixture seeds the
    -- same shape directly, with credential_hash = sha256 of a known pairing
    -- secret, so the cash-custody probes can open it.
    insert into web_till_devices (id, store_id, label, registered_by, credential_hash)
      values ('dev_q_01', 's_q', 'Till A', 'emp_q',
              encode(sha256(convert_to('probe-secret-q01','utf8')), 'hex'))
      on conflict (id) do nothing;
    select vat_status from stores where id = 's_q';`,
  (o) => o.trim() === 'REGISTERED');

/* --- quoting prices the basket and creates NO sale --- */
expectOk('WS7: a quote prices £6.00 standard-rated as total 6.00 / VAT 1.00',
  U21.staffQ, `select (q ->> 'total') || '/' || (q ->> 'tax_amount') || '/' || (q ->> 'status')
               from (select (create_order_quote('{"id":"q_ok_0001","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) -> 'quote' as q) t;`,
  (o) => o.trim() === '6.00/1.00/OPEN');
expectOk('WS7: …and NO order exists yet',
  'service', `select count(*)::text from orders where quote_id = 'q_ok_0001';`,
  (o) => o.trim() === '0');
expectOk('WS7: re-quoting the same id returns the SAME quote (quoting is idempotent)',
  U21.staffQ, `select (create_order_quote('{"id":"q_ok_0001","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';`,
  (o) => o.trim() === 'true');

/* --- the trading gates still fire at QUOTE time --- */
expectDeny('WS7: a quote from ANOTHER store cannot be reserved (cross-store)',
  U21.staffR, `select begin_quote_payment('{"quoteId":"q_ok_0001","reservationId":"res_q_ok_0001","method":"card"}'::jsonb);`, 'store_scope_denied');
expectDeny('WS7: an empty basket cannot be quoted',
  U21.staffQ, `select create_order_quote('{"id":"q_empty_01","items":[]}'::jsonb);`, 'empty_basket');
/* A disabled employee has no staff identity at all — the auth helpers already
   exclude them, so every financial RPC refuses at the identity gate before its
   own staff_disabled branch is reachable. That branch remains as defence in
   depth for a row disabled mid-session. */
expectDeny('WS7: a DISABLED operator cannot create a quote',
  U21.staffD, `select create_order_quote('{"id":"q_dis_0001","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb);`, 'not_staff');
expectDeny('WS7: …nor reserve a payment',
  U21.staffD, `select begin_quote_payment('{"quoteId":"q_ok_0001","reservationId":"res_q_ok_0001","method":"card"}'::jsonb);`, 'not_staff');
expectDeny('WS7: …nor finalise one',
  U21.staffD, `select finalise_order_payment('{"quoteId":"q_ok_0001","reservationId":"res_q_ok_0001","method":"card","providerReference":"T-X","approvedAmount":"6.00"}'::jsonb);`, 'not_staff');
expectDeny('WS7: …nor open a cash custody session (all four operations agree)',
  U21.staffD, `select open_till_session('{"id":"sess_dis","deviceId":"dev_dis","openingFloat":"0"}'::jsonb);`, 'not_staff');

/* --- finalisation demands a reservation, then real payment evidence --- */
// Finalisation now names and consumes ONE exact attempt first, so a quote
// with no reservation fails at attempt lookup, before any status check.
expectDeny('WS7: a quote with no reservation cannot be finalised',
  U21.staffQ, `select finalise_order_payment('{"quoteId":"q_ok_0001","reservationId":"res_q_ok_0001","method":"card","providerReference":"T-1","approvedAmount":"6.00"}'::jsonb);`, 'invalid_reservation');
expectOk('WS7: reserving the quote moves it to PAYMENT_PENDING',
  U21.staffQ, `select (q ->> 'status') from (select (begin_quote_payment('{"quoteId":"q_ok_0001","reservationId":"res_q_ok_0001","method":"card"}'::jsonb)) -> 'quote' as q) t;`,
  (o) => o.trim() === 'PAYMENT_PENDING');
expectDeny('WS7: a CARD payment with no provider reference is refused',
  U21.staffQ, `select finalise_order_payment('{"quoteId":"q_ok_0001","reservationId":"res_q_ok_0001","method":"card","approvedAmount":"6.00"}'::jsonb);`, 'payment_reference_required');
expectDeny('WS7: …and an approved amount that differs from the quote is refused',
  U21.staffQ, `select finalise_order_payment('{"quoteId":"q_ok_0001","reservationId":"res_q_ok_0001","method":"card","providerReference":"T-1","approvedAmount":"5.00"}'::jsonb);`, 'approved_amount_mismatch');
// The route was BOUND at reservation; finalisation may repeat but never
// substitute it. (Method acceptance itself is enforced at reservation — see
// the §24 begin-time online-not-accepted probe.)
expectDeny("WS7: finalising with a method other than the one reserved is refused",
  U21.staffQ, `select finalise_order_payment('{"quoteId":"q_ok_0001","reservationId":"res_q_ok_0001","method":"online","providerReference":"T-1","approvedAmount":"6.00"}'::jsonb);`, 'payment_method_mismatch');
expectOk('WS7: a CARD payment with evidence records the sale from the SNAPSHOT',
  U21.staffQ, `select (o ->> 'total') || '/' || (o ->> 'tax_amount') || '/' || (o ->> 'payment_status') || '/' || (o ->> 'payment_reference')
               from (select (finalise_order_payment('{"quoteId":"q_ok_0001","reservationId":"res_q_ok_0001","method":"card","providerReference":"T-1","approvedAmount":"6.00"}'::jsonb)) -> 'order' as o) t;`,
  (o) => o.trim() === '6.00/1.00/OPERATOR_RECORDED_UNRECONCILED/T-1');
expectOk("WS7: placed_at is the QUOTE's time and completed_at the PAYMENT's",
  'service', `select (o.placed_at = q.created_at)::text || '/' || (o.completed_at >= q.created_at)::text
                from orders o join order_quotes q on q.id = o.quote_id where o.quote_id = 'q_ok_0001';`,
  (o) => o.trim() === 'true/true');
expectOk('WS7: the quote is CONSUMED and points at the order it became — which has its OWN id',
  'service', `select q.status || '/' || (q.order_id = o.id)::text || '/' || (q.order_id <> q.id)::text
                from order_quotes q join orders o on o.quote_id = q.id where q.id = 'q_ok_0001';`,
  (o) => o.trim() === 'CONSUMED/true/true');

/* --- response loss: the same money, replayed, is ONE sale --- */
expectOk('WS7 (response loss): replaying the SAME finalisation returns the SAME order',
  U21.staffQ, `select (finalise_order_payment('{"quoteId":"q_ok_0001","reservationId":"res_q_ok_0001","method":"card","providerReference":"T-1","approvedAmount":"6.00"}'::jsonb)) ->> 'duplicate';`,
  (o) => o.trim() === 'true');
expectDeny('WS7 (idempotency): the same quote with DIFFERENT payment facts conflicts',
  U21.staffQ, `select finalise_order_payment('{"quoteId":"q_ok_0001","reservationId":"res_q_ok_0001","method":"card","providerReference":"T-999","approvedAmount":"6.00"}'::jsonb);`, 'idempotency_conflict');
expectOk('WS7: one quote produced exactly ONE order',
  'service', `select count(*)::text from orders where quote_id = 'q_ok_0001';`,
  (o) => o.trim() === '1');

/* --- the reservation is an identity, not a loose state flip --- */
expectOk('WS7 fixture: a quote for the reservation contract',
  U21.staffQ, `select (create_order_quote('{"id":"q_res_0001","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';`,
  (o) => o.trim() === 'false');
expectOk('WS7 (reservation): the first valid request reserves the quote',
  U21.staffQ, `select (begin_quote_payment('{"quoteId":"q_res_0001","reservationId":"res_attempt_a","method":"card"}'::jsonb)) ->> 'state';`,
  (o) => o.trim() === 'reserved');
expectOk('WS7 (reservation): replaying the SAME identity and facts returns the original',
  U21.staffQ, `select (begin_quote_payment('{"quoteId":"q_res_0001","reservationId":"res_attempt_a","method":"card"}'::jsonb)) ->> 'duplicate';`,
  (o) => o.trim() === 'true');
expectDeny('WS7 (reservation): the same identity with DIFFERENT payment facts conflicts',
  U21.staffQ, `select begin_quote_payment('{"quoteId":"q_res_0001","reservationId":"res_attempt_a","method":"cash","deviceId":"dev_q_01","cashSessionId":"sess_q_01"}'::jsonb);`, 'idempotency_conflict');
expectDeny('WS7 (reservation): a SECOND device cannot take over an active reservation',
  U21.staffQ, `select begin_quote_payment('{"quoteId":"q_res_0001","reservationId":"res_attempt_b","method":"card"}'::jsonb);`, 'payment_already_pending');
expectDeny('WS7 (release): a reservation may only be released by the attempt that made it',
  U21.staffQ, `select release_quote_payment('{"quoteId":"q_res_0001","reservationId":"res_attempt_b","outcome":"declined"}'::jsonb);`, 'idempotency_conflict');
expectDeny('WS7 (release): an ambiguous outcome is NOT a release reason',
  U21.staffQ, `select release_quote_payment('{"quoteId":"q_res_0001","reservationId":"res_attempt_a","outcome":"unknown"}'::jsonb);`, 'invalid_release_outcome');
expectOk('WS7 (release): a DEFINITE decline returns the basket to OPEN',
  U21.staffQ, `select (release_quote_payment('{"quoteId":"q_res_0001","reservationId":"res_attempt_a","outcome":"declined"}'::jsonb)) ->> 'state';`,
  (o) => o.trim() === 'OPEN');
expectOk('WS7 (release): the quote can then be reserved again by a NEW identity',
  U21.staffQ, `select (begin_quote_payment('{"quoteId":"q_res_0001","reservationId":"res_attempt_c","method":"card"}'::jsonb)) ->> 'state';`,
  (o) => o.trim() === 'reserved');
expectOk('WS7 (release): the released attempt is recorded, not erased',
  'service', `select release_reason from order_quotes where id = 'q_res_0001';`,
  (o) => o.trim() === 'declined');
expectOk('WS7: finalise that quote so the consumed-release rule can be proven',
  U21.staffQ, `select (finalise_order_payment('{"quoteId":"q_res_0001","reservationId":"res_attempt_c","method":"card","providerReference":"T-RES","approvedAmount":"6.00"}'::jsonb)) -> 'order' ->> 'payment_status';`,
  (o) => o.trim() === 'OPERATOR_RECORDED_UNRECONCILED');
expectDeny('WS7 (release): a COMPLETED payment can never be released',
  U21.staffQ, `select release_quote_payment('{"quoteId":"q_res_0001","reservationId":"res_attempt_c","outcome":"declined"}'::jsonb);`, 'quote_already_consumed');
expectOk('WS7 (reservation): reserving a CONSUMED quote reports the completed order instead',
  U21.staffQ, `select (begin_quote_payment('{"quoteId":"q_res_0001","reservationId":"res_attempt_c","method":"card"}'::jsonb)) ->> 'state';`,
  (o) => o.trim() === 'already_consumed');

/* --- every attempt is a permanent record, and identities never recycle --- */
expectOk('WS7 (attempts): the declined attempt is preserved as its own record',
  'service', `select state || '/' || release_outcome from quote_payment_attempts where reservation_id = 'res_attempt_a';`,
  (o) => o.trim() === 'DECLINED/declined');
expectOk('WS7 (attempts): the later successful attempt is a SEPARATE record naming its order',
  'service', `select a.state || '/' || (a.completed_order_id = o.id)::text
                from quote_payment_attempts a join orders o on o.id = a.completed_order_id
               where a.reservation_id = 'res_attempt_c';`,
  (o) => o.trim() === 'CONSUMED/true');
expectOk('WS7 (attempts): the quote therefore carries a HISTORY, not just a current state',
  'service', `select string_agg(state, ',' order by started_at) from quote_payment_attempts where quote_id = 'q_res_0001';`,
  (o) => o.trim() === 'DECLINED,CONSUMED');
expectDeny('WS7 (attempts): a released reservation identity can NEVER be reused',
  U21.staffQ, `select begin_quote_payment('{"quoteId":"q_res_0001","reservationId":"res_attempt_a","method":"card"}'::jsonb);`, 'reservation_released');
expectDeny('WS7 (attempts): …nor finalised after release',
  U21.staffQ, `select finalise_order_payment('{"quoteId":"q_res_0001","reservationId":"res_attempt_a","method":"card","providerReference":"T-LATE","approvedAmount":"6.00"}'::jsonb);`, 'reservation_released');
expectDeny("WS7 (attempts): a resolved attempt's identity cannot be rewritten",
  'service', `update quote_payment_attempts set request_hash = 'tampered' where reservation_id = 'res_attempt_a';`, 'attempt_already_resolved');
expectDeny('WS7 (attempts): a resolved attempt is final',
  'service', `update quote_payment_attempts set state = 'PENDING' where reservation_id = 'res_attempt_a';`, 'attempt_already_resolved');
expectDeny('WS7 (attempts): a reservation identity cannot be borrowed by another quote',
  U21.staffQ, `select create_order_quote('{"id":"q_borrow_01","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb);
               select begin_quote_payment('{"quoteId":"q_borrow_01","reservationId":"res_attempt_c","method":"card"}'::jsonb);`, 'idempotency_conflict');
expectDeny('WS7 (attempts): browser roles cannot write the attempt ledger directly',
  U21.staffQ, `insert into quote_payment_attempts (reservation_id, quote_id, store_id, operator_staff_id, request_hash) values ('res_hack','q_res_0001','s_q','emp_q','x');`, 'permission denied');

/* --- a delayed finalisation for a superseded attempt must not win --- */
expectOk('WS7 fixture: a quote whose first attempt is declined and replaced',
  U21.staffQ, `select (create_order_quote('{"id":"q_seq_0001","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';
               select (begin_quote_payment('{"quoteId":"q_seq_0001","reservationId":"res_seq_a1","method":"card"}'::jsonb)) ->> 'state';`,
  (o) => o.split('\n').map(x => x.trim()).filter(Boolean).pop() === 'reserved');
expectOk('WS7: …the first attempt is declined',
  U21.staffQ, `select (release_quote_payment('{"quoteId":"q_seq_0001","reservationId":"res_seq_a1","outcome":"declined"}'::jsonb)) ->> 'state';`,
  (o) => o.trim() === 'OPEN');
expectOk('WS7: …a NEW attempt begins under a new identity',
  U21.staffQ, `select (begin_quote_payment('{"quoteId":"q_seq_0001","reservationId":"res_seq_b1","method":"card"}'::jsonb)) ->> 'state';`,
  (o) => o.trim() === 'reserved');
expectDeny('WS7 (race): a DELAYED finalisation for the superseded attempt cannot consume the quote',
  U21.staffQ, `select finalise_order_payment('{"quoteId":"q_seq_0001","reservationId":"res_seq_a1","method":"card","providerReference":"T-STALE","approvedAmount":"6.00"}'::jsonb);`, 'reservation_released');
expectOk('WS7 (race): …and the active attempt still completes normally',
  U21.staffQ, `select (finalise_order_payment('{"quoteId":"q_seq_0001","reservationId":"res_seq_b1","method":"card","providerReference":"T-FRESH","approvedAmount":"6.00"}'::jsonb)) -> 'order' ->> 'payment_status';`,
  (o) => o.trim() === 'OPERATOR_RECORDED_UNRECONCILED');
expectDeny('WS7 (race): release can no longer win once finalisation has',
  U21.staffQ, `select release_quote_payment('{"quoteId":"q_seq_0001","reservationId":"res_seq_b1","outcome":"declined"}'::jsonb);`, 'quote_already_consumed');
expectOk('WS7 (race): exactly ONE order exists for that quote',
  'service', `select count(*)::text from orders where quote_id = 'q_seq_0001';`,
  (o) => o.trim() === '1');
/* The device-scoped uniqueness probe is superseded: the namespace is now
   resolved from the terminal registry, and uniqueness is proven against it in
   the WS7 (namespace) probes below. */
expectOk('WS7: …but a DIFFERENT terminal may legitimately mint the same string',
  'service', `insert into quote_payment_attempts
                (reservation_id, quote_id, store_id, payment_method, device_id,
                 operator_staff_id, request_hash, state, payment_provider,
                 provider_merchant_id, provider_terminal_id, provider_reference,
                 completed_order_id,
                 resolved_by_staff_id, resolved_via, resolved_at)
              values ('res_other_term', 'q_res_0001', 's_q', 'card', 'dev_q_01',
                      'emp_q', 'h', 'CONSUMED', 'stripe_terminal', 'acct_mp', 'term_02', 'T-FRESH',
                      (select id from orders where quote_id = 'q_res_0001'),
                      'emp_q', 'finalise', now());
              select provider_terminal_id from quote_payment_attempts where reservation_id = 'res_other_term';`,
  (o) => o.split('\n').map(x => x.trim()).filter(Boolean).pop() === 'term_02');
/* Superseded: a client can no longer supply provider, merchant or terminal
   identifiers at all, so "namespace required" is unreachable by construction.
   The registry probes prove the stronger property. */

/* --- cash requires an accountable drawer on an ENROLLED device --- */
/* The device is a custody identity opened with its server-issued pairing
   secret; the session id is server-generated, so the flow captures it and
   threads it forward. Cash can no longer even be RESERVED without an open
   drawer (the session is bound at reservation and locked). */
expectOk('WS7 fixture: a second quote for the cash path',
  U21.staffQ, `select (q ->> 'total') from (select (create_order_quote('{"id":"q_cash_001","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) -> 'quote' as q) t;`,
  (o) => o.trim() === '6.00');
expectDeny('WS7 (custody): CASH cannot be reserved without an OPEN till session',
  U21.staffQ, `select begin_quote_payment('{"quoteId":"q_cash_001","reservationId":"res_q_cash_001","method":"cash","deviceId":"dev_q_01","deviceSecret":"probe-secret-q01","cashSessionId":"wts_no_such_session"}'::jsonb);`, 'till_session_not_open');
const sessQ = (expectOk('WS7: the operator opens a till session on the enrolled device (custody anchor)',
  U21.staffQ, `select (open_till_session('{"deviceId":"dev_q_01","deviceSecret":"probe-secret-q01"}'::jsonb)) -> 'session' ->> 'id';`,
  (o) => /^wts_[0-9a-f]{32}$/.test(o.trim())) || '').trim();
expectOk('WS7: reserving cash against the open drawer moves the quote to PAYMENT_PENDING',
  U21.staffQ, `select (q ->> 'status') from (select (begin_quote_payment('{"quoteId":"q_cash_001","reservationId":"res_q_cash_001","method":"cash","deviceId":"dev_q_01","deviceSecret":"probe-secret-q01","cashSessionId":"${sessQ}"}'::jsonb)) -> 'quote' as q) t;`,
  (o) => o.trim() === 'PAYMENT_PENDING');
expectDeny('WS7 (custody): finalising against a device other than the BOUND one is refused',
  U21.staffQ, `select finalise_order_payment('{"quoteId":"q_cash_001","reservationId":"res_q_cash_001","method":"cash","cashReceived":"10.00","tillSessionId":"${sessQ}","deviceId":"dev_other"}'::jsonb);`, 'payment_binding_mismatch');
expectDeny('WS7: short cash is refused',
  U21.staffQ, `select finalise_order_payment('{"quoteId":"q_cash_001","reservationId":"res_q_cash_001","method":"cash","cashReceived":"5.00","tillSessionId":"${sessQ}","deviceId":"dev_q_01","deviceSecret":"probe-secret-q01"}'::jsonb);`, 'insufficient_cash');
expectDeny('WS7: client-claimed change that disagrees with the server is refused',
  U21.staffQ, `select finalise_order_payment('{"quoteId":"q_cash_001","reservationId":"res_q_cash_001","method":"cash","cashReceived":"10.00","change":"9.00","tillSessionId":"${sessQ}","deviceId":"dev_q_01","deviceSecret":"probe-secret-q01"}'::jsonb);`, 'change_mismatch');
expectOk('WS7: a CASH sale against the open session records exact change and the drawer',
  U21.staffQ, `select (o ->> 'cash_received') || '/' || (o ->> 'change_given') || '/' || (o ->> 'till_session_id')
               from (select (finalise_order_payment('{"quoteId":"q_cash_001","reservationId":"res_q_cash_001","method":"cash","cashReceived":"10.00","change":"4.00","tillSessionId":"${sessQ}","deviceId":"dev_q_01","deviceSecret":"probe-secret-q01"}'::jsonb)) -> 'order' as o) t;`,
  (o) => o.trim() === `10.00/4.00/${sessQ}`);

expectOk('WS7 fixture: a cash attempt left unresolved on the open drawer',
  U21.staffQ, `select (create_order_quote('{"id":"q_open_cash","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';
               select (begin_quote_payment('{"quoteId":"q_open_cash","reservationId":"res_q_open_cash","method":"cash","deviceId":"dev_q_01","deviceSecret":"probe-secret-q01","cashSessionId":"${sessQ}"}'::jsonb)) ->> 'state';`,
  (o) => o.split('\n').map(x => x.trim()).filter(Boolean).pop() === 'reserved');
expectDeny('WS7 (custody): the drawer cannot CLOSE while a cash payment is unresolved',
  U21.staffQ, `select close_till_session('{"id":"${sessQ}","deviceSecret":"probe-secret-q01"}'::jsonb);`, 'session_has_unresolved_payments');
/* --- R3.3 guards (findings 1, 3, 4) on the still-PENDING cash attempt --- */
expectDeny('WS7 (R3, finding 1): a cash FINALISE without the device secret is refused',
  U21.staffQ, `select finalise_order_payment('{"quoteId":"q_open_cash","reservationId":"res_q_open_cash","method":"cash","cashReceived":"10.00","tillSessionId":"${sessQ}","deviceId":"dev_q_01"}'::jsonb);`, 'device_credential_invalid');
expectDeny('WS7 (R3, finding 1): a cash FINALISE with the WRONG device secret is refused',
  U21.staffQ, `select finalise_order_payment('{"quoteId":"q_open_cash","reservationId":"res_q_open_cash","method":"cash","cashReceived":"10.00","tillSessionId":"${sessQ}","deviceId":"dev_q_01","deviceSecret":"wrong-secret"}'::jsonb);`, 'device_credential_invalid');
expectDeny('WS7 (R3, finding 3): a FUTURE claimed payment time is refused',
  U21.staffQ, `select finalise_order_payment('{"quoteId":"q_open_cash","reservationId":"res_q_open_cash","method":"cash","cashReceived":"10.00","tillSessionId":"${sessQ}","deviceId":"dev_q_01","deviceSecret":"probe-secret-q01","paidAt":"2099-01-01T00:00:00Z"}'::jsonb);`, 'payment_time_in_future');
expectDeny('WS7 (R3, finding 3): a claimed payment time before the basket is refused',
  U21.staffQ, `select finalise_order_payment('{"quoteId":"q_open_cash","reservationId":"res_q_open_cash","method":"cash","cashReceived":"10.00","tillSessionId":"${sessQ}","deviceId":"dev_q_01","deviceSecret":"probe-secret-q01","paidAt":"2020-01-01T00:00:00Z"}'::jsonb);`, 'payment_time_implausible');
expectOk('WS7 (R3, finding 3/4): the completed sale attributes operator, finaliser and SERVER record time',
  'service', `select (payment_operator_staff_id = 'emp_q')::text || '/' || (finalised_by_staff_id = 'emp_q')::text
              || '/' || (payment_claimed_at is null)::text || '/' || (payment_recorded_at is not null)::text
              from orders where quote_id = 'q_cash_001';`,
  (o) => o.trim() === 'true/true/true/true');
expectDeny('WS7 (R3, finding 1): a drawer CLOSE without the device secret is refused',
  U21.staffQ, `select release_quote_payment('{"quoteId":"q_open_cash","reservationId":"res_q_open_cash","outcome":"abandoned"}'::jsonb);
               select close_till_session('{"id":"${sessQ}"}'::jsonb);`, 'device_credential_invalid');
expectOk('WS7 (custody): resolving the attempt frees the drawer',
  U21.staffQ, `select (release_quote_payment('{"quoteId":"q_open_cash","reservationId":"res_q_open_cash","outcome":"abandoned"}'::jsonb)) ->> 'state';
               select (close_till_session('{"id":"${sessQ}","deviceSecret":"probe-secret-q01"}'::jsonb)) -> 'session' ->> 'status';`,
  (o) => o.split('\n').map(x => x.trim()).filter(Boolean).pop() === 'CLOSED');

/* --- expiry, cancellation and the recovery window --- */
expectOk('WS7 fixture: a quote forced past its expiry',
  U21.staffQ, `select (create_order_quote('{"id":"q_exp_0001","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';`,
  (o) => o.trim() === 'false');
expectOk('WS7: …aged by the service path',
  'service', `update order_quotes set expires_at = now() - interval '1 minute' where id = 'q_exp_0001'; select 'ok';`,
  (o) => o.trim() === 'ok');
expectDeny('WS7: an EXPIRED quote cannot be reserved',
  U21.staffQ, `select begin_quote_payment('{"quoteId":"q_exp_0001","reservationId":"res_q_exp_0001","method":"card"}'::jsonb);`, 'quote_expired');
expectOk('WS7 (recovery): a RESERVED quote survives ordinary expiry — the money may already have moved',
  U21.staffQ, `select (create_order_quote('{"id":"q_rec_0001","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';`,
  (o) => o.trim() === 'false');
expectOk('WS7: reserve, then age the ORIGINAL expiry past now',
  U21.staffQ, `select (begin_quote_payment('{"quoteId":"q_rec_0001","reservationId":"res_q_rec_0001","method":"card"}'::jsonb)) -> 'quote' ->> 'status';`,
  (o) => o.trim() === 'PAYMENT_PENDING');
expectOk('WS7: …expiry aged',
  'service', `update order_quotes set expires_at = now() - interval '1 hour' where id = 'q_rec_0001'; select 'ok';`,
  (o) => o.trim() === 'ok');
expectOk('WS7: …and finalisation still succeeds inside the recovery window',
  U21.staffQ, `select (o ->> 'payment_status')
               from (select (finalise_order_payment('{"quoteId":"q_rec_0001","reservationId":"res_q_rec_0001","method":"card","providerReference":"T-REC","approvedAmount":"6.00"}'::jsonb)) -> 'order' as o) t;`,
  (o) => o.trim() === 'OPERATOR_RECORDED_UNRECONCILED');
expectOk('WS7: an abandoned basket can be CANCELLED and is not a sale',
  U21.staffQ, `select (create_order_quote('{"id":"q_can_0001","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';
               select (cancel_order_quote('{"quoteId":"q_can_0001"}'::jsonb)) -> 'quote' ->> 'status';`,
  (o) => o.split('\n').map(x => x.trim()).filter(Boolean).pop() === 'CANCELLED');
expectDeny('WS7: a cancelled quote cannot be reserved',
  U21.staffQ, `select begin_quote_payment('{"quoteId":"q_can_0001","reservationId":"res_q_can_0001","method":"card"}'::jsonb);`, 'quote_not_open');

/* --- the snapshot is frozen, and the tables are RPC-written --- */
expectDeny('WS7: the priced snapshot cannot be rewritten (finalisation therefore cannot reprice)',
  'service', `update order_quotes set total = 1.00 where id = 'q_cash_001';`, 'quote_snapshot_immutable');
expectDeny('WS7: a consumed quote is final',
  'service', `update order_quotes set status = 'OPEN' where id = 'q_cash_001';`, 'quote_snapshot_immutable');
/* --- R3.2 guards (findings 1 & 2): the new cash-reserve credential + exact-attempt replay --- */
expectOk('WS7 (R3): a fresh open quote for the cash-secret probes',
  U21.staffQ, `select (create_order_quote('{"id":"q_cash_sec","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';`,
  (o) => o.trim() === 'false');
expectDeny('WS7 (R3, finding 1): a cash reserve WITHOUT the device secret is refused',
  U21.staffQ, `select begin_quote_payment('{"quoteId":"q_cash_sec","reservationId":"res_cash_sec","method":"cash","deviceId":"dev_q_01","cashSessionId":"${sessQ}"}'::jsonb);`, 'device_credential_invalid');
expectDeny('WS7 (R3, finding 1): a cash reserve with the WRONG device secret is refused',
  U21.staffQ, `select begin_quote_payment('{"quoteId":"q_cash_sec","reservationId":"res_cash_sec","method":"cash","deviceId":"dev_q_01","deviceSecret":"wrong-secret","cashSessionId":"${sessQ}"}'::jsonb);`, 'device_credential_invalid');
expectDeny('WS7 (R3, finding 2): a consumed quote hands back its order ONLY for the exact reservation',
  U21.staffQ, `select begin_quote_payment('{"quoteId":"q_cash_001","reservationId":"res_not_the_one","method":"cash","deviceId":"dev_q_01","deviceSecret":"probe-secret-q01","cashSessionId":"${sessQ}"}'::jsonb);`, 'invalid_reservation');
expectOk('WS7 (R3, finding 2): …and the exact reservation still returns the completed order',
  U21.staffQ, `select (begin_quote_payment('{"quoteId":"q_cash_001","reservationId":"res_q_cash_001","method":"cash","deviceId":"dev_q_01","deviceSecret":"probe-secret-q01","cashSessionId":"${sessQ}"}'::jsonb)) ->> 'state';`,
  (o) => o.trim() === 'already_consumed');
expectDeny('WS7: authenticated cannot write quotes directly',
  U21.staffQ, `insert into order_quotes (id, store_id, channel, items, subtotal, discount_total, tax_amount, total, store_vat_status, allowed_payment_methods, config_version, expires_at) values ('q_hack', 's_q', 'walk_in', '[]'::jsonb, 0, 0, 0, 0, 'NOT_REGISTERED', '[]'::jsonb, 'x', now());`, 'permission denied');
expectDeny('WS7: authenticated cannot write till sessions directly',
  U21.staffQ, `insert into web_till_sessions (id, store_id, device_id, opened_by_staff_id) values ('sess_hack', 's_q', 'dev_q_01', 'emp_q');`, 'permission denied');
expectDeny('WS7: the one-step completed-sale writer no longer EXISTS at all',
  U21.staffQ, `select submit_web_order('{"id":"ord_bypass","total":9,"items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb);`, 'does not exist');
expectOk('WS7: …in any schema',
  'service', `select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'submit_web_order';`,
  (o) => o.trim() === '0');
expectOk("WS7: the till operator can still READ its own store's quotes",
  U21.staffQ, `select (count(*) > 0)::text from order_quotes where store_id = 's_q';`,
  (o) => o.trim() === 'true');
expectOk("WS7: …and cannot see another store's",
  U21.staffR, `select count(*)::text from order_quotes where store_id = 's_q';`,
  (o) => o.trim() === '0');

/* ---------------------------------------------------------------- */
/* 22. WS7 — INDEPENDENT PRICING PARITY                             */
/*     The UNTOUCHED Round-9h implementation is stood up beside the  */
/*     extracted helper and given the same frozen baskets. Slicing   */
/*     removes transcription risk; only this proves the wrapper,     */
/*     aliases, defaults, return shape and unpacking did not change  */
/*     a single figure.                                              */
/* ---------------------------------------------------------------- */
expectOk('WS7 parity: stand up the untouched Round-9h pricing implementation (test-only)',
  'service', `reset role;
    create or replace function mp_parity_legacy(p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff     text := current_staff_id();
  v_me        staff_profiles%rowtype;
  v_store_id  text;
  v_store_nm  text := '';
  v_store     stores%rowtype;
  v_id        text := p_order ->> 'id';
  v_channel   text := coalesce(p_order ->> 'channel', 'walk_in');
  v_payment   text := coalesce(p_order ->> 'paymentMethod', 'card');
  v_customer  text := nullif(trim(coalesce(p_order ->> 'customerName', '')), '');
  v_items_in  jsonb := p_order -> 'items';
  v_deal_ids  jsonb := coalesce(p_order -> 'dealIds', '[]'::jsonb);
  v_cash_p    bigint;
  it          jsonb;
  md          jsonb;
  m           menu_items%rowtype;
  x           menu_items%rowtype;
  v_size      text;
  v_qty       int;
  v_unit_p    bigint;
  v_mods_p    bigint;
  v_mods      jsonb;
  v_line_p    bigint;
  v_items     jsonb := '[]'::jsonb;
  v_sub_p     bigint := 0;
  -- per-line tax state
  v_line_ps   bigint[]  := '{}';
  v_codes     text[]    := '{}';
  v_rates     numeric[] := '{}';
  v_rate      numeric;
  v_alloc_p   bigint;
  v_taxable_p bigint;
  v_ltax_p    bigint;
  v_cum_prev  bigint;
  v_cum_here  bigint;
  v_tax_sum_p bigint := 0;
  v_uniform   boolean := true;
  v_head_rate numeric := null;
  -- WS6f: effective-date charging + per-line COMPONENT tax model
  v_status_reg boolean;
  v_charging  boolean;
  v_today     date;
  v_mod_rate  numeric;
  v_comps     jsonb := '[]'::jsonb;
  v_lcomp     jsonb;
  v_lc        jsonb;
  v_mods2     jsonb;
  v_line_rate numeric;
  v_line_uniform boolean;
  v_ccum_prev bigint;
  v_ccum_here bigint;
  v_cp        bigint;
  v_crate     numeric;
  v_calloc    bigint;
  v_ctaxable  bigint;
  v_ctax      bigint;
  v_mi        int;
  v_uncls_mod text;
  k           int;
  v_items_tx  jsonb := '[]'::jsonb;
  elem        jsonb;
  -- deal engine state
  d           deals%rowtype;
  v_units     bigint[];
  v_group_sum bigint;
  v_disc_p    bigint;
  v_best_p    bigint := 0;
  v_best_deal deals%rowtype;
  v_deals     jsonb := '[]'::jsonb;
  v_disc_tot  bigint := 0;
  v_total_p   bigint;
  v_change_p  bigint;
  v_order_no  bigint;
  v_row       orders%rowtype;
  g           int;
  i           int;
  j           int;
begin
  -- 1. Caller: a linked staff member; store is THEIRS, never the payload's.
  if v_staff is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  select * into v_me from staff_profiles where id = v_staff;
  v_store_id := v_me.store_id;
  if v_store_id is not null then
    select name into v_store_nm from stores where id = v_store_id;
  end if;

  -- 2. Validate the envelope.
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'invalid_order_id';
  end if;
  if v_items_in is null or jsonb_typeof(v_items_in) <> 'array'
     or jsonb_array_length(v_items_in) = 0
     or jsonb_array_length(v_items_in) > 100 then
    raise exception 'invalid_items';
  end if;
  if v_customer is not null and length(v_customer) > 120 then
    raise exception 'invalid_customer';
  end if;

  -- 3. Idempotency FIRST: a replayed id returns the stored truth.
  select * into v_row from orders where id = v_id;
  if found then
    -- WS6f (auditor F6): idempotency is CALLER-STORE-SCOPED. This is a
    -- SECURITY DEFINER function; without this check a guessed foreign order
    -- id would exfiltrate another store's order around RLS. A replay is only
    -- a replay when the stored row belongs to the caller's own store.
    if v_row.store_id is distinct from v_store_id then
      raise exception 'order_id_conflict' using errcode = '42501';
    end if;
    return jsonb_build_object('order', to_jsonb(v_row), 'duplicate', true);
  end if;

  -- 4. TRADING GATE (closure brief §1): the sale must belong to a store whose
  --    VAT configuration has been explicitly confirmed. No store, or an
  --    unconfirmed store, blocks trading — nothing is ever defaulted.
  if v_store_id is null then
    raise exception 'store_vat_unconfigured'
      using detail = 'The caller has no home store; sales must belong to a VAT-configured store.';
  end if;
  select * into v_store from stores where id = v_store_id;
  if v_store.id is null or v_store.vat_config_confirmed_at is null then
    raise exception 'store_vat_unconfigured'
      using detail = 'The store''s VAT configuration has not been confirmed; trading is blocked.';
  end if;
  -- 4b. SETUP GATE (WS6e): a store still in DRAFT has not completed the
  --     owner Setup Wizard and cannot trade, even when its VAT facts exist.
  if v_store.setup_status is distinct from 'ACTIVE' then
    raise exception 'store_setup_incomplete'
      using detail = 'The store''s Setup Wizard has not been completed; trading is blocked.';
  end if;
  -- WS6f (auditor F1): REGISTERED alone does NOT charge — the registration's
  -- EFFECTIVE DATE must have arrived in the store's OWN business day (the
  -- local date in its configured timezone). A future-dated registration
  -- snapshots REGISTERED + its date, but every amount derives exactly like
  -- NOT_REGISTERED until the date arrives. Registering is forward-only.
  v_status_reg := (v_store.vat_status = 'REGISTERED');
  v_today      := (now() at time zone v_store.timezone)::date;
  v_charging   := v_status_reg
                  and v_store.vat_registration_effective_date <= v_today;

  -- 5. Price every line from the catalogue (integer pence) and capture its
  --    tax classification. REGISTERED trading refuses unclassified products.
  for i in 0 .. jsonb_array_length(v_items_in) - 1 loop
    it := v_items_in -> i;
    select * into m from menu_items where id = it ->> 'menuItemId';
    if m.id is null then
      raise exception 'unknown_menu_item';
    end if;
    if v_charging and m.tax_code is null then
      raise exception 'product_tax_unclassified'
        using detail = 'Product "' || m.id || '" has no VAT classification; a VAT-charging store cannot sell it.';
    end if;
    if v_charging then
      select rate_percent into v_rate from tax_codes where code = m.tax_code;
    else
      v_rate := 0;
    end if;
    v_qty := coalesce(nullif(it ->> 'quantity', '')::int, 0);
    if v_qty < 1 or v_qty > 99 then
      raise exception 'invalid_quantity';
    end if;
    v_size := case when it ->> 'size' = 'large' then 'large' else 'regular' end;
    v_unit_p := round((case when v_size = 'large' and m.price_large is not null
                            then m.price_large else m.price end) * 100)::bigint;

    v_mods_p := 0;
    v_mods := '[]'::jsonb;
    -- Base component (the product portion of the line) — modifiers append
    -- their own components in payload order inside the loop below.
    v_lcomp := jsonb_build_array(jsonb_build_object(
      'p', v_unit_p * v_qty, 'rate', v_rate, 'code', m.tax_code, 'mi', -1));
    if jsonb_typeof(it -> 'modifiers') = 'array' then
      if jsonb_array_length(it -> 'modifiers') > 20 then
        raise exception 'invalid_modifiers';
      end if;
      for j in 0 .. jsonb_array_length(it -> 'modifiers') - 1 loop
        md := it -> 'modifiers' -> j;
        select * into x from menu_items
          where id = md ->> 'menuItemId' and category = 'extras';
        if x.id is null then
          raise exception 'unknown_extra';
        end if;
        -- WS6f (auditor F5): an extra is taxed by ITS OWN classification,
        -- never by the base product's. A charging store refuses an
        -- unclassified extra exactly as it refuses an unclassified product.
        if v_charging and x.tax_code is null then
          raise exception 'product_tax_unclassified'
            using detail = 'Extra "' || x.id || '" has no VAT classification; a VAT-charging store cannot sell it.';
        end if;
        if v_charging then
          select rate_percent into v_mod_rate from tax_codes where code = x.tax_code;
        else
          v_mod_rate := 0;
        end if;
        v_mods_p := v_mods_p + round(x.price * 100)::bigint;
        v_lcomp := v_lcomp || jsonb_build_array(jsonb_build_object(
          'p', round(x.price * 100)::bigint * v_qty,
          'rate', v_mod_rate, 'code', x.tax_code, 'mi', j));
        v_mods := v_mods || jsonb_build_array(jsonb_build_object(
          'id', 'mod_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10),
          'menuItemId', x.id, 'name', x.name, 'price', round(x.price * 100) / 100.0));
      end loop;
    end if;

    v_line_p := (v_unit_p + v_mods_p) * v_qty;
    v_sub_p  := v_sub_p + v_line_p;
    v_line_ps := v_line_ps || v_line_p;
    v_comps   := v_comps || jsonb_build_array(v_lcomp);
    v_codes   := v_codes   || m.tax_code;
    v_rates   := v_rates   || v_rate;
    v_items  := v_items || jsonb_build_array(jsonb_build_object(
      'id', 'li_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
      'menuItemId', m.id, 'name', m.name, 'category', m.category,
      'size', v_size, 'unitPrice', v_unit_p / 100.0, 'quantity', v_qty,
      'modifiers', v_mods, 'lineTotal', v_line_p / 100.0,
      'notes', nullif(trim(coalesce(it ->> 'notes', '')), '')));
  end loop;

  -- 6. Deals — recomputed HERE with the client engine's semantics: units are
  --    the BASE prices (extras stay charged), sorted dearest-first; only the
  --    single best-scoring claimed deal applies; a claim that computes to
  --    zero is dropped.
  if jsonb_typeof(v_deal_ids) = 'array' and jsonb_array_length(v_deal_ids) > 0 then
    for i in 0 .. least(jsonb_array_length(v_deal_ids), 10) - 1 loop
      select * into d from deals
        where id = v_deal_ids ->> i and active = true;
      if d.id is null then continue; end if;
      v_disc_p := 0;

      if d.type in ('bundle_price', 'buy_x_get_y_free', 'percent_off_category')
         and d.category is not null then
        select coalesce(array_agg(u order by u desc), '{}')
          into v_units
          from (select round((q ->> 'unitPrice')::numeric * 100)::bigint as u
                  from jsonb_array_elements(v_items) q,
                       generate_series(1, (q ->> 'quantity')::int)
                 where q ->> 'category' = d.category::text) s;
      end if;

      if d.type = 'bundle_price'
         and d.buy_qty is not null and d.buy_qty > 0 and d.bundle_price is not null then
        for g in 0 .. (coalesce(array_length(v_units, 1), 0) / d.buy_qty) - 1 loop
          v_group_sum := 0;
          for j in 1 .. d.buy_qty loop
            v_group_sum := v_group_sum + v_units[g * d.buy_qty + j];
          end loop;
          if v_group_sum > round(d.bundle_price * 100)::bigint then
            v_disc_p := v_disc_p + v_group_sum - round(d.bundle_price * 100)::bigint;
          end if;
        end loop;

      elsif d.type = 'buy_x_get_y_free'
         and d.buy_qty is not null and d.buy_qty > 0
         and d.free_qty is not null and d.free_qty > 0 then
        for g in 0 .. (coalesce(array_length(v_units, 1), 0) / (d.buy_qty + d.free_qty)) - 1 loop
          -- within each dearest-first group, the trailing free_qty units are
          -- the cheapest — those go free.
          for j in d.buy_qty + 1 .. d.buy_qty + d.free_qty loop
            v_disc_p := v_disc_p + v_units[g * (d.buy_qty + d.free_qty) + j];
          end loop;
        end loop;

      elsif d.type = 'percent_off_category' and d.percent_off is not null then
        select coalesce(sum(u), 0) into v_group_sum from unnest(v_units) u;
        v_disc_p := round(v_group_sum * d.percent_off / 100);

      elsif d.type = 'fixed_off_order' and d.amount_off is not null then
        if d.min_order_value is null
           or v_sub_p >= round(d.min_order_value * 100)::bigint then
          v_disc_p := least(round(d.amount_off * 100)::bigint, v_sub_p);
        end if;
      end if;

      if v_disc_p > v_best_p then
        v_best_p := v_disc_p;
        v_best_deal := d;
      end if;
    end loop;

    if v_best_p > 0 then
      v_best_p := least(v_best_p, v_sub_p);
      v_disc_tot := v_best_p;
      v_deals := jsonb_build_array(jsonb_build_object(
        'dealId', v_best_deal.id, 'dealName', v_best_deal.name,
        'discount', v_best_p / 100.0));
    end if;
  end if;

  -- 7. Totals — VAT-inclusive UK pricing; payment facts validated.
  v_total_p := greatest(v_sub_p - v_disc_tot, 0);

  -- 7a. Per-line tax snapshots (WS6f component model). The order discount is
  --     allocated over the LINES by cumulative largest-exact shares, then the
  --     SAME method splits each line's share across its COMPONENTS (base
  --     portion first, then each modifier in payload order). Every component
  --     is taxed at ITS OWN rate with the single rounding step
  --     round(taxable_pence × rate / (100 + rate)); the line's tax is the sum
  --     of its component taxes, the order's tax is the sum of the line taxes
  --     — no re-rounding anywhere. A line whose components carry mixed rates
  --     snapshots a NULL line rate (the modifier rows are the authority),
  --     exactly as a mixed-rate ORDER snapshots a NULL headline rate.
  v_cum_prev := 0;
  for i in 1 .. coalesce(array_length(v_line_ps, 1), 0) loop
    v_cum_here := v_cum_prev + v_line_ps[i];
    if v_sub_p > 0 then
      v_alloc_p := (v_disc_tot * v_cum_here / v_sub_p)
                 - (v_disc_tot * v_cum_prev / v_sub_p);
    else
      v_alloc_p := 0;
    end if;
    v_cum_prev  := v_cum_here;
    v_taxable_p := v_line_ps[i] - v_alloc_p;

    v_lc := v_comps -> (i - 1);
    v_ltax_p := 0;
    v_line_rate := null;
    v_line_uniform := true;
    v_ccum_prev := 0;
    v_mods2 := (v_items -> (i - 1)) -> 'modifiers';
    for k in 0 .. jsonb_array_length(v_lc) - 1 loop
      v_cp    := ((v_lc -> k) ->> 'p')::bigint;
      v_crate := ((v_lc -> k) ->> 'rate')::numeric;
      v_ccum_here := v_ccum_prev + v_cp;
      if v_line_ps[i] > 0 then
        v_calloc := (v_alloc_p * v_ccum_here / v_line_ps[i])
                  - (v_alloc_p * v_ccum_prev / v_line_ps[i]);
      else
        v_calloc := 0;
      end if;
      v_ccum_prev := v_ccum_here;
      v_ctaxable := v_cp - v_calloc;
      v_ctax     := round(v_ctaxable * v_crate / (100 + v_crate));
      v_ltax_p   := v_ltax_p + v_ctax;
      if v_line_rate is null then v_line_rate := v_crate;
      elsif v_line_rate <> v_crate then v_line_uniform := false;
      end if;
      if v_head_rate is null then v_head_rate := v_crate;
      elsif v_head_rate <> v_crate then v_uniform := false;
      end if;
      v_mi := ((v_lc -> k) ->> 'mi')::int;
      if v_mi >= 0 then
        v_mods2 := jsonb_set(v_mods2, array[v_mi::text], (v_mods2 -> v_mi) || jsonb_build_object(
          'taxCode', (v_lc -> k) -> 'code',
          'taxRate', v_crate,
          'taxableAmount', v_ctaxable / 100.0,
          'taxAmount', v_ctax / 100.0));
      end if;
    end loop;
    v_tax_sum_p := v_tax_sum_p + v_ltax_p;
    elem := (v_items -> (i - 1)) || jsonb_build_object(
      'modifiers', v_mods2,
      'taxCode', v_codes[i],
      'taxRate', case when v_line_uniform then v_line_rate else null end,
      'taxableAmount', v_taxable_p / 100.0,
      'taxAmount', v_ltax_p / 100.0);
    v_items_tx := v_items_tx || jsonb_build_array(elem);
  end loop;
  v_items := v_items_tx;

  if v_payment not in ('cash', 'card', 'online', 'gift_card') then
    raise exception 'invalid_payment_method';
  end if;
  if v_channel not in ('walk_in','phone','website','deliveroo','uber_eats','just_eat') then
    raise exception 'invalid_channel';
  end if;
  -- WS6e: the store's ACCEPTED payment methods are configuration, not a
  -- constant. A syntactically valid method outside the configured set is
  -- refused (jsonb ? = string membership in the configured array).
  if not (v_store.payment_methods ? v_payment) then
    raise exception 'payment_method_not_accepted'
      using detail = 'Payment method "' || v_payment || '" is not enabled for this store.';
  end if;
  v_change_p := null;
  v_cash_p := null;
  if v_payment = 'cash' then
    v_cash_p := round(coalesce(nullif(p_order ->> 'cashReceived', '')::numeric, 0) * 100)::bigint;
    if v_cash_p < v_total_p then
      raise exception 'insufficient_cash';
    end if;
    v_change_p := v_cash_p - v_total_p;
  end if;

  -- 8. Order number: per-store, race-safe via an advisory lock scoped to this
  --    transaction.
  perform pg_advisory_xact_lock(hashtext('milkpop_order_no_' || coalesce(v_store_id, 'hq')));
  select coalesce(max(order_number), 0) + 1 into v_order_no
    from orders where coalesce(store_id, 'hq') = coalesce(v_store_id, 'hq');

  insert into orders
    (id, order_number, store_id, store_name, channel, items, applied_deals,
     subtotal, discount_total, tax_rate, tax_amount, total,
     store_vat_status, vat_effective_date,
     payment_method, cash_received, change_given, status,
     customer_name, staff_id, staff_name, placed_at, completed_at)
  values
    (v_id, v_order_no, v_store_id, coalesce(v_store_nm, ''),
     v_channel::order_channel, v_items, v_deals,
     v_sub_p / 100.0, v_disc_tot / 100.0,
     case when v_uniform then v_head_rate else null end,
     v_tax_sum_p / 100.0, v_total_p / 100.0,
     v_store.vat_status,
     case when v_status_reg then v_store.vat_registration_effective_date else null end,
     v_payment::payment_method,
     case when v_cash_p is null then null else v_cash_p / 100.0 end,
     case when v_change_p is null then null else v_change_p / 100.0 end,
     'completed', v_customer, v_staff, coalesce(v_me.name, ''), now(), now())
  on conflict (id) do nothing
  returning * into v_row;

  if v_row.id is null then
    -- Lost an id race after the step-3 check: return the stored truth —
    -- under the SAME caller-store scope rule as step 3 (auditor F6).
    select * into v_row from orders where id = v_id;
    if v_row.store_id is distinct from v_store_id then
      raise exception 'order_id_conflict' using errcode = '42501';
    end if;
    return jsonb_build_object('order', to_jsonb(v_row), 'duplicate', true);
  end if;

  return jsonb_build_object('order', to_jsonb(v_row), 'duplicate', false);
end $$;
    select 'ok';`,
  (o) => o.split('\n').map(x => x.trim()).filter(Boolean).pop() === 'ok');

/* Modifier ids are generated per call, so they are stripped before comparing;
   every FINANCIAL field is compared verbatim. */
expectOk('WS7 parity: normaliser for volatile ids',
  'service', `reset role;
    create or replace function mp_parity_norm(p jsonb) returns jsonb
    language sql immutable as $mp$
      select coalesce(jsonb_agg(
        (it - 'id') || jsonb_build_object('modifiers', coalesce((
          select jsonb_agg(m - 'id' order by m ->> 'menuItemId')
            from jsonb_array_elements(coalesce(it -> 'modifiers', '[]'::jsonb)) m), '[]'::jsonb))
        order by it ->> 'menuItemId'), '[]'::jsonb)
      from jsonb_array_elements(coalesce(p, '[]'::jsonb)) it
    $mp$;
    select 'ok';`,
  (o) => o.split('\n').map(x => x.trim()).filter(Boolean).pop() === 'ok');

/* Each case: price the SAME basket both ways, then compare every financial
   field. `parity(id, payload)` runs legacy → order and helper → quote. */
const parity = (n, payload) => `do $mp$ begin
    perform mp_parity_legacy('{"id":"par_l_${n}","paymentMethod":"card",${payload}}'::jsonb);
    perform create_order_quote('{"id":"par_q_${n}",${payload}}'::jsonb);
  end $mp$;
  select (o.subtotal = q.subtotal)::text || '/' || (o.discount_total = q.discount_total)::text
      || '/' || (o.tax_amount = q.tax_amount)::text || '/' || (o.total = q.total)::text
      || '/' || (o.tax_rate is not distinct from q.tax_rate)::text
      || '/' || (mp_parity_norm(o.items) = mp_parity_norm(q.items))::text
      || '/' || (o.applied_deals = q.applied_deals)::text
      || '/' || (o.store_vat_status = q.store_vat_status)::text
      || '/' || (o.vat_effective_date is not distinct from q.vat_effective_date)::text
    from orders o, order_quotes q
   where o.id = 'par_l_${n}' and q.id = 'par_q_${n}';`;
const ALL_EQUAL = 'true/true/true/true/true/true/true/true/true';

expectOk('WS7 parity: a single standard-rated item',
  U18.staffF, parity('a', '"items":[{"menuItemId":"mp_fx_std","quantity":1}]'),
  (o) => o.trim() === ALL_EQUAL);
expectOk('WS7 parity: multiple quantities (rounding across units)',
  U18.staffF, parity('b', '"items":[{"menuItemId":"mp_fx_std","quantity":3}]'),
  (o) => o.trim() === ALL_EQUAL);
expectOk('WS7 parity: a zero-rated base with a standard-rated modifier (mixed line)',
  U18.staffF, parity('c', '"items":[{"menuItemId":"mp_zbase","quantity":1,"modifiers":[{"menuItemId":"mp_ex"}]}]'),
  (o) => o.trim() === ALL_EQUAL);
expectOk('WS7 parity: multiple modifiers on multiple units',
  U18.staffF, parity('d', '"items":[{"menuItemId":"mp_zbase","quantity":2,"modifiers":[{"menuItemId":"mp_ex"}]}]'),
  (o) => o.trim() === ALL_EQUAL);
expectOk('WS7 parity: a DISCOUNTED mixed basket (deal attribution + allocation)',
  U18.staffF, parity('e', '"dealIds":["deal_vat"],"items":[{"menuItemId":"mp_zbase","quantity":1,"modifiers":[{"menuItemId":"mp_ex"}]}]'),
  (o) => o.trim() === ALL_EQUAL);
expectOk('WS7 parity: a mixed-rate multi-line basket (headline rate NULL)',
  U18.staffF, parity('f', '"items":[{"menuItemId":"mp_fx_std","quantity":1},{"menuItemId":"mp_zbase","quantity":1}]'),
  (o) => o.trim() === ALL_EQUAL);
expectOk('WS7 parity: a reduced-rate classification',
  U18.staffF, parity('g', '"items":[{"menuItemId":"mp_new","quantity":1}]'),
  (o) => o.trim() === ALL_EQUAL);
expectOk('WS7 parity: an odd-pence rounding boundary (£3 zero + £1 standard, discounted)',
  U18.staffF, parity('h', '"dealIds":["deal_vat"],"items":[{"menuItemId":"mp_zbase","quantity":1,"modifiers":[{"menuItemId":"mp_ex"}]},{"menuItemId":"mp_fx_std","quantity":1}]'),
  (o) => o.trim() === ALL_EQUAL);

/* A NOT_REGISTERED store must derive identically in both implementations. */
expectOk('WS7 parity fixture: a product for the NOT_REGISTERED store',
  'service', `insert into menu_items (id, name, category, price, image, tax_code)
                values ('mp_par_nr', 'Parity NR', 'milkshakes', 4, '', 'STANDARD_RATE')
                on conflict (id) do nothing;
              select tax_code from menu_items where id = 'mp_par_nr';`,
  (o) => o.trim() === 'STANDARD_RATE');
expectOk('WS7 parity: a NOT_REGISTERED store derives zero tax in both',
  U.staffA, `do $mp$ begin
      perform mp_parity_legacy('{"id":"par_l_nr","paymentMethod":"card","items":[{"menuItemId":"mp_par_nr","quantity":2}]}'::jsonb);
      perform create_order_quote('{"id":"par_q_nr","items":[{"menuItemId":"mp_par_nr","quantity":2}]}'::jsonb);
    end $mp$;
    select (o.total = q.total)::text || '/' || (o.tax_amount = q.tax_amount)::text
        || '/' || (o.store_vat_status = q.store_vat_status)::text
        || '/' || (mp_parity_norm(o.items) = mp_parity_norm(q.items))::text
      from orders o, order_quotes q where o.id = 'par_l_nr' and q.id = 'par_q_nr';`,
  (o) => o.trim() === 'true/true/true/true');

/* Exception paths must agree too: both refuse the same baskets. */
expectDeny('WS7 parity: legacy refuses an unknown product',
  U18.staffF, `select mp_parity_legacy('{"id":"par_l_x1","paymentMethod":"card","items":[{"menuItemId":"nope","quantity":1}]}'::jsonb);`, 'unknown_menu_item');
expectDeny('WS7 parity: …and so does the quote path',
  U18.staffF, `select create_order_quote('{"id":"par_q_x1","items":[{"menuItemId":"nope","quantity":1}]}'::jsonb);`, 'unknown_menu_item');
expectOk('WS7 parity fixture: an unclassified product while charging',
  'service', `insert into menu_items (id, name, category, price, image)
                values ('mp_unc_par', 'Unclassified Parity', 'milkshakes', 2, '')
                on conflict (id) do nothing;
              select coalesce(tax_code, '∅') from menu_items where id = 'mp_unc_par';`,
  (o) => o.trim() === '∅');
expectDeny('WS7 parity: legacy refuses an unclassified product',
  U18.staffF, `select mp_parity_legacy('{"id":"par_l_x2","paymentMethod":"card","items":[{"menuItemId":"mp_unc_par","quantity":1}]}'::jsonb);`, 'product_tax_unclassified');
expectDeny('WS7 parity: …and so does the quote path',
  U18.staffF, `select create_order_quote('{"id":"par_q_x2","items":[{"menuItemId":"mp_unc_par","quantity":1}]}'::jsonb);`, 'product_tax_unclassified');

expectOk('WS7 parity: the test-only legacy implementation is removed again',
  'service', `reset role;
              drop function if exists mp_parity_legacy(jsonb);
              select (count(*) = 0)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'mp_parity_legacy';`,
  (o) => o.split('\n').map(x => x.trim()).filter(Boolean).pop() === 'true');

/* ---------------------------------------------------------------- */
/* 23. WS7 — WRITER-AUTHORITY EVIDENCE + RPC HARDENING              */
/*     Two complementary layers, honestly labelled:                  */
/*       (a) ENFORCEMENT (catalog-grounded): financial tables carry  */
/*           RLS with no browser write grants, and every RPC is      */
/*           SECURITY DEFINER with a pinned search_path — asserted   */
/*           below from pg_catalog, which is what actually closes    */
/*           write access.                                           */
/*       (b) a SOURCE-PATTERN REGRESSION GUARD: this first check     */
/*           scans pg_proc source for static insert/update/delete    */
/*           on each financial table and fails on any writer nobody  */
/*           registered. It is a tripwire for drift, NOT a           */
/*           completeness proof — dynamic SQL would not match the    */
/*           pattern; layer (a) is the guarantee.                    */
/* ---------------------------------------------------------------- */
expectOk('WS7 inventory (source scan): no unregistered STATIC write to a financial table',
  'service', `with tables(tbl) as (values
      ('orders'),('order_items'),('order_item_modifiers'),
      ('order_quotes'),('quote_payment_attempts'),
      ('web_till_sessions'),('web_till_devices'),('audit_logs'),
      -- R3: the manual-evidence record and provider-account configuration are
      -- financial tables too; the sole registered writer of evidence is the
      -- reconciliation RPC, and NO function may write provider accounts.
      ('payment_reconciliations'),('online_payment_accounts')),
    registered(fn, tbl) as (values
      -- the WS7 financial path
      ('create_order_quote','order_quotes'),
      ('begin_quote_payment','order_quotes'),
      ('finalise_order_payment','order_quotes'),
      ('finalise_order_payment','orders'),
      ('release_quote_payment','order_quotes'),
      ('begin_quote_payment','quote_payment_attempts'),
      ('release_quote_payment','quote_payment_attempts'),
      ('finalise_order_payment','quote_payment_attempts'),
      ('cancel_order_quote','order_quotes'),
      ('open_till_session','web_till_sessions'),
      ('open_till_session','web_till_devices'),
      ('close_till_session','web_till_sessions'),
      -- WS7b payment-authority writers
      ('finalise_order_payment_core','orders'),
      ('finalise_order_payment_core','order_quotes'),
      ('finalise_order_payment_core','quote_payment_attempts'),
      ('resolve_payment_reconciliation','order_quotes'),
      ('resolve_payment_reconciliation','quote_payment_attempts'),
      ('reconcile_card_payment','orders'),
      ('reconcile_card_payment','payment_reconciliations'),
      ('expire_stale_quotes','order_quotes'),
      ('enrol_till_device','web_till_devices'),
      ('log_payment_authority_event','audit_logs'),
      -- line explosion trigger: derives order lines from the order snapshot
      ('explode_order_items','order_items'),
      ('explode_order_items','order_item_modifiers'),
      -- audit trail writers
      ('apply_collection_changes','audit_logs'),
      ('complete_training','audit_logs'),
      ('replace_collection','audit_logs'),
      -- R4.10 Increment 7: publish_record is the ONLY sanctioned way to change a
      -- record's publication state, and a publication decision that leaves no
      -- trace is not one anyone can review later. Registered deliberately.
      ('publish_record','audit_logs'),
      ('close_vacancy','audit_logs'),   -- INC11: the sanctioned vacancy-close transition audits itself
      ('save_website_studio','audit_logs'),   -- INC11: the atomic studio publish writes its own audit row
      ('save_launch_settings','audit_logs'),  -- INC11: launch-facts saves audit themselves in-transaction
      ('transition_application','audit_logs'),        -- INC11: candidacy transitions audit in the same transaction
      ('transition_application','notification_outbox'), -- INC11: offer/declined mail enqueued in the same transaction
      -- R4.9 G2: seven R4.8 functions write audit_logs and were never registered
      -- here, so the drift tripwire fired the first time this suite was run
      -- against the R4.8 chain. Each is a deliberate, reviewed audit writer:
      -- three record a compliance verdict, two an employment lifecycle event,
      -- one an allergen approval, one a recovery-intent request. Registering them is the acknowledgement the
      -- tripwire exists to force — layer (a) below is what actually closes
      -- write access, and none of these grants any browser write.
      ('allergen_declaration_approve','audit_logs'),
      ('compliance_record_upsert','audit_logs'),
      ('compliance_record_verify','audit_logs'),
      ('compliance_record_revoke','audit_logs'),
      ('end_employment','audit_logs'),
      ('purge_employee','audit_logs'),
      ('request_recovery_action','audit_logs')),
    writers(fn, tbl) as (
      select p.proname, t.tbl
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join tables t
       where n.nspname = 'public'
         and p.prosrc ~* ('(insert into|update|delete from)[[:space:]]+' || t.tbl || '[^a-z_]'))
    select coalesce(string_agg(w.fn || ':' || w.tbl, ' ' order by w.fn), 'NONE')
      from writers w
     where not exists (select 1 from registered r where r.fn = w.fn and r.tbl = w.tbl);`,
  (o) => o.trim() === 'NONE');

expectOk('WS7 inventory: every registered writer still EXISTS (the list cannot rot the other way)',
  'service', `with registered(fn) as (values
      ('create_order_quote'),('begin_quote_payment'),('finalise_order_payment'),
      ('finalise_order_payment_core'),('cancel_order_quote'),('release_quote_payment'),
      ('open_till_session'),('close_till_session'),('explode_order_items'),
      ('enrol_till_device'),('expire_stale_quotes'),
      ('resolve_payment_reconciliation'),('reconcile_card_payment'),
      ('log_payment_authority_event'))
    select coalesce(string_agg(r.fn, ' ' order by r.fn), 'NONE') from registered r
     where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                        where n.nspname = 'public' and p.proname = r.fn);`,
  (o) => o.trim() === 'NONE');

expectOk('WS7 hardening: every browser-facing financial RPC is DEFINER, search_path-pinned, and correctly granted',
  'service', `with rpcs(fn) as (values
      ('create_order_quote'),('begin_quote_payment'),('finalise_order_payment'),
      ('cancel_order_quote'),('open_till_session'),('close_till_session'),
      ('release_quote_payment'),('enrol_till_device'),('expire_stale_quotes'),
      ('resolve_payment_reconciliation'),('reconcile_card_payment'))
    select coalesce(string_agg(x.fn || '=' || x.problem, ' ' order by x.fn), 'NONE') from (
      select r.fn,
             case when not p.prosecdef                                    then 'not-definer'
                  when coalesce(p.proconfig::text, '') not like '%search_path%' then 'no-search-path'
                  when has_function_privilege('public', p.oid, 'EXECUTE') then 'public-execute'
                  when has_function_privilege('anon',   p.oid, 'EXECUTE') then 'anon-execute'
                  when not has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'no-auth-execute'
             end as problem
        from rpcs r
        join pg_proc p on p.proname = r.fn
        join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public') x
     where x.problem is not null;`,
  (o) => o.trim() === 'NONE');

expectOk('WS7 hardening: the quote and custody tables carry RLS with no browser write grants',
  'service', `select coalesce(string_agg(c.relname || '=' || problem, ' ' order by c.relname), 'NONE') from (
      select c.relname, c.oid,
             case when not c.relrowsecurity then 'no-rls'
                  when has_table_privilege('authenticated', c.oid, 'INSERT')
                    or has_table_privilege('authenticated', c.oid, 'UPDATE')
                    or has_table_privilege('authenticated', c.oid, 'DELETE') then 'browser-write'
                  when has_table_privilege('anon', c.oid, 'SELECT') then 'anon-read'
             end as problem
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('order_quotes','quote_payment_attempts',
                           'web_till_sessions','web_till_devices',
                           'payment_terminals','online_payment_accounts',
                           'payment_reconciliations')) c
     where problem is not null;`,
  (o) => o.trim() === 'NONE');

/* ---------------------------------------------------------------- */
/* 24. WS7b — PAYMENT AUTHORITY CORRECTIONS (round-9h → ws7b)        */
/*     New coverage for the twelve corrections: device enrolment,    */
/*     operator scope + audited override, config/VAT revalidation,   */
/*     the recovery→reconciliation path, provider settlement, the    */
/*     ONLINE authority, and the closed order ledger. §21 already     */
/*     proves the quote→pay→finalise spine; this proves the parts     */
/*     the corrections added.                                         */
/* ---------------------------------------------------------------- */
const U24 = {
  mgrQ: '00000000-0000-4000-8000-0000000000e4',   // store_manager at s_q
  opQ2: '00000000-0000-4000-8000-0000000000e5',    // a SECOND operator at s_q
};

expectOk('WS7b fixtures: a manager + a second operator at s_q, an online account, online in the method set',
  'service', `
    insert into staff_profiles (id, name, email, role, store_id, store_name, auth_id) values
      ('emp_qm', 'Morgan Manager', 'mm7@test.local', 'store_manager', 's_q', 'Quote Probe', '${U24.mgrQ}'),
      ('emp_q2', 'Quill Second',   'q27@test.local', 'team_member',   's_q', 'Quote Probe', '${U24.opQ2}')
      on conflict (id) do nothing;
    -- service is the RLS-bypass role, so the RPC-only config guard admits it
    -- structurally: it may seed the accepted-method set directly.
    update stores set payment_methods = '["cash","card","online"]'::jsonb where id = 's_q';
    insert into online_payment_accounts (id, store_id, provider, account_id)
      values ('opa_q', 's_q', 'stripe_online', 'acct_online_q') on conflict (id) do nothing;
    select payment_methods::text from stores where id = 's_q';`,
  (o) => o.includes('online'));

/* --- correction 10: a till device is a server-enrolled custody identity --- */
expectDeny('WS7b (enrol): a team member cannot enrol a till device',
  `${U21.staffQ}@aal2`, `select enrol_till_device('{"label":"Till B"}'::jsonb);`, 'device_enrolment_denied');
expectDeny('WS7b (enrol): a manager WITHOUT an MFA session cannot enrol a device',
  U24.mgrQ, `select enrol_till_device('{"label":"Till B"}'::jsonb);`, 'device_enrolment_denied');
expectDeny('WS7b (enrol): a device needs a real label',
  `${U24.mgrQ}@aal2`, `select enrol_till_device('{"label":"   "}'::jsonb);`, 'invalid_device_label');
const dev2 = JSON.parse(expectOk('WS7b (enrol): a manager with MFA enrols a device and receives a one-time secret',
  `${U24.mgrQ}@aal2`, `select enrol_till_device('{"label":"Till B"}'::jsonb);`,
  (o) => { try { const j = JSON.parse(o); return /^wtd_/.test(j.deviceId) && typeof j.pairingSecret === 'string' && j.pairingSecret.length >= 32; } catch { return false; } }) || '{}');
expectDeny('WS7b (enrol): the WRONG secret cannot open the enrolled device',
  U24.mgrQ, `select open_till_session('{"deviceId":"${dev2.deviceId}","deviceSecret":"not-the-real-secret"}'::jsonb);`, 'device_credential_invalid');
expectOk('WS7b (enrol): the issued secret opens a custody session on the new device',
  U24.mgrQ, `select (open_till_session('{"deviceId":"${dev2.deviceId}","deviceSecret":"${dev2.pairingSecret}"}'::jsonb)) -> 'session' ->> 'status';`,
  (o) => o.trim() === 'OPEN');
expectOk('WS7b (enrol): a device can be revoked (service maintenance)',
  'service', `update web_till_devices set revoked = true where id = '${dev2.deviceId}'; select 'ok';`, (o) => o.trim() === 'ok');
expectDeny('WS7b (enrol): a REVOKED device can no longer open a session, secret or not',
  U24.mgrQ, `select open_till_session('{"deviceId":"${dev2.deviceId}","deviceSecret":"${dev2.pairingSecret}"}'::jsonb);`, 'till_device_revoked');
expectDeny("WS7b (R3.1): a REVOKED device's old secret cannot CLOSE its drawer",
  U24.mgrQ, `select close_till_session(jsonb_build_object('id',(select id from web_till_sessions where device_id='${dev2.deviceId}' and status='OPEN'),'deviceSecret','${dev2.pairingSecret}'));`, 'till_device_revoked');
expectOk("WS7b (R3.1): a manager with MFA + a written reason closes the revoked device's drawer",
  `${U24.mgrQ}@aal2`, `select (close_till_session(jsonb_build_object('id',(select id from web_till_sessions where device_id='${dev2.deviceId}'),'overrideReason','till device revoked; drawer counted by hand'))) -> 'session' ->> 'status';`,
  (o) => o.trim() === 'CLOSED');
/* --- R3.1 (audit correction): authentication precedes the idempotent replay --- */
expectDeny('WS7 (R3.1): a CLOSED session is NOT disclosed to an unauthenticated same-store caller',
  U24.opQ2, `select close_till_session('{"id":"${sessQ}"}'::jsonb);`, 'device_credential_invalid');
expectOk('WS7 (R3.1): the enrolled secret replays the CLOSED session idempotently',
  U21.staffQ, `select (close_till_session('{"id":"${sessQ}","deviceSecret":"probe-secret-q01"}'::jsonb)) ->> 'duplicate';`,
  (o) => o.trim() === 'true');

/* --- corrections 3/8: only the operator who took the payment finalises it,
       and any override is a manager/owner + MFA + written reason + audit --- */
expectOk('WS7b (operator): operator A prices and reserves a card sale',
  U21.staffQ, `select (create_order_quote('{"id":"q_op_01","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';
               select (begin_quote_payment('{"quoteId":"q_op_01","reservationId":"res_op_01","method":"card"}'::jsonb)) ->> 'state';`,
  (o) => o.split('\n').map(x => x.trim()).filter(Boolean).pop() === 'reserved');
expectDeny("WS7b (operator): a DIFFERENT operator cannot finalise A's payment",
  U24.opQ2, `select finalise_order_payment('{"quoteId":"q_op_01","reservationId":"res_op_01","method":"card","providerReference":"T-OP","approvedAmount":"6.00"}'::jsonb);`, 'operator_scope_denied');
expectDeny('WS7b (operator): a manager override still needs a written reason',
  `${U24.mgrQ}@aal2`, `select finalise_order_payment('{"quoteId":"q_op_01","reservationId":"res_op_01","method":"card","providerReference":"T-OP","approvedAmount":"6.00"}'::jsonb);`, 'operator_scope_denied');
expectOk('WS7b (operator): a manager with MFA + a reason overrides and records the sale',
  `${U24.mgrQ}@aal2`, `select (o ->> 'payment_status') from (select (finalise_order_payment('{"quoteId":"q_op_01","reservationId":"res_op_01","method":"card","providerReference":"T-OP","approvedAmount":"6.00","overrideReason":"customer waited; operator A on break"}'::jsonb)) -> 'order' as o) t;`,
  (o) => o.trim() === 'OPERATOR_RECORDED_UNRECONCILED');
expectOk('WS7b (operator): the override wrote an audit row naming who overrode whom',
  'service', `select count(*)::text from audit_logs where module = 'ws7_payments' and action = 'payment_override:finalise';`,
  (o) => Number(o.trim()) >= 1);

/* --- correction 6 (R3): OPERATOR_RECORDED_UNRECONCILED → MANUAL_EVIDENCE_MATCHED,
       only via a full manager-attested evidence record; no direct status flip --- */
const reconEvt = new Date().toISOString();  // payment-event time ~ now (finding 4 bounds)
expectDeny('WS7b (reconcile): a team member cannot match manual evidence',
  U21.staffQ, `select reconcile_card_payment('{"reservationId":"res_op_01","evidenceType":"terminal_receipt","externalReference":"TRX-9981","currency":"GBP","matchedAmount":"6.00","paymentEventAt":"${reconEvt}","reason":"matched to terminal receipt","idempotencyKey":"idem_op_01_a"}'::jsonb);`, 'reconciliation_denied');
expectDeny('WS7b (reconcile): the matched amount must equal the recorded total',
  `${U24.mgrQ}@aal2`, `select reconcile_card_payment('{"reservationId":"res_op_01","evidenceType":"terminal_receipt","externalReference":"TRX-9981","currency":"GBP","matchedAmount":"5.00","paymentEventAt":"${reconEvt}","reason":"matched to terminal receipt","idempotencyKey":"idem_op_01_x"}'::jsonb);`, 'settlement_amount_mismatch');
expectDeny('WS7b (reconcile, R3 finding 4): a non-GBP currency is refused',
  `${U24.mgrQ}@aal2`, `select reconcile_card_payment('{"reservationId":"res_op_01","evidenceType":"terminal_receipt","externalReference":"TRX-9981","currency":"USD","matchedAmount":"6.00","paymentEventAt":"${reconEvt}","reason":"matched to terminal receipt","idempotencyKey":"idem_op_01_ccy"}'::jsonb);`, 'currency_not_supported');
expectDeny('WS7b (reconcile, R3 finding 4): a FUTURE payment-event time is refused',
  `${U24.mgrQ}@aal2`, `select reconcile_card_payment('{"reservationId":"res_op_01","evidenceType":"terminal_receipt","externalReference":"TRX-9981","currency":"GBP","matchedAmount":"6.00","paymentEventAt":"2099-01-01T00:00:00Z","reason":"matched to terminal receipt","idempotencyKey":"idem_op_01_fut"}'::jsonb);`, 'payment_time_in_future');
expectDeny('WS7b (reconcile, R3 finding 4): a payment-event time long BEFORE the sale is refused',
  `${U24.mgrQ}@aal2`, `select reconcile_card_payment('{"reservationId":"res_op_01","evidenceType":"terminal_receipt","externalReference":"TRX-9981","currency":"GBP","matchedAmount":"6.00","paymentEventAt":"2020-01-01T00:00:00Z","reason":"matched to terminal receipt","idempotencyKey":"idem_op_01_past"}'::jsonb);`, 'payment_time_implausible');
expectDeny('WS7b (reconcile, R3 finding 5): reservation and orderId must identify the same payment',
  `${U24.mgrQ}@aal2`, `select reconcile_card_payment('{"reservationId":"res_op_01","orderId":"ord_not_this_one","evidenceType":"terminal_receipt","externalReference":"TRX-9981","currency":"GBP","matchedAmount":"6.00","paymentEventAt":"${reconEvt}","reason":"matched to terminal receipt","idempotencyKey":"idem_op_01_mix"}'::jsonb);`, 'payment_identity_mismatch');
expectOk('WS7b (reconcile): a manager matches evidence; the order becomes MANUAL_EVIDENCE_MATCHED',
  `${U24.mgrQ}@aal2`, `select (reconcile_card_payment('{"reservationId":"res_op_01","evidenceType":"terminal_receipt","externalReference":"TRX-9981","currency":"GBP","matchedAmount":"6.00","paymentEventAt":"${reconEvt}","reason":"matched to terminal receipt","idempotencyKey":"idem_op_01_a"}'::jsonb)) ->> 'orderPaymentStatus';`,
  (o) => o.trim() === 'MANUAL_EVIDENCE_MATCHED');
expectOk('WS7b (reconcile): the same idempotency key + evidence again is a no-op',
  `${U24.mgrQ}@aal2`, `select (reconcile_card_payment('{"reservationId":"res_op_01","evidenceType":"terminal_receipt","externalReference":"TRX-9981","currency":"GBP","matchedAmount":"6.00","paymentEventAt":"${reconEvt}","reason":"matched to terminal receipt","idempotencyKey":"idem_op_01_a"}'::jsonb)) ->> 'duplicate';`,
  (o) => o.trim() === 'true');
expectDeny('WS7b (reconcile): the SAME idempotency key with DIFFERENT evidence conflicts',
  `${U24.mgrQ}@aal2`, `select reconcile_card_payment('{"reservationId":"res_op_01","evidenceType":"merchant_portal","externalReference":"PORTAL-777","currency":"GBP","matchedAmount":"6.00","paymentEventAt":"${reconEvt}","reason":"matched to merchant portal","idempotencyKey":"idem_op_01_a"}'::jsonb);`, 'idempotency_conflict');
expectOk('WS7b (reconcile, R3): the EQUIVALENT retry sent by orderId replays, not conflicts',
  `${U24.mgrQ}@aal2`, `select (reconcile_card_payment(jsonb_build_object(
      'orderId', (select completed_order_id from quote_payment_attempts where reservation_id = 'res_op_01'),
      'evidenceType','terminal_receipt','externalReference','TRX-9981','currency','GBP',
      'matchedAmount','6.00','paymentEventAt','${reconEvt}',
      'reason','matched to terminal receipt','idempotencyKey','idem_op_01_a'))) ->> 'duplicate';`,
  (o) => o.trim() === 'true');
expectDeny('WS7b (reconcile, R3): the same key with a CHANGED REASON is a different claim',
  `${U24.mgrQ}@aal2`, `select reconcile_card_payment('{"reservationId":"res_op_01","evidenceType":"terminal_receipt","externalReference":"TRX-9981","currency":"GBP","matchedAmount":"6.00","paymentEventAt":"${reconEvt}","reason":"a completely different written reason","idempotencyKey":"idem_op_01_a"}'::jsonb);`, 'idempotency_conflict');
/* --- R3.5 (finding 7): financial evidence is a manager/owner read --- */
expectOk('WS7b (R3, finding 7): a team member cannot READ reconciliation evidence',
  U21.staffQ, `select count(*)::text from payment_reconciliations;`, (o) => o.trim() === '0');
expectOk('WS7b (R3, finding 7): …but a manager can',
  `${U24.mgrQ}@aal2`, `select (count(*) >= 1)::text from payment_reconciliations;`, (o) => o.trim() === 'true');
expectOk('WS7b (R3, finding 7): a team member cannot READ provider account configuration',
  U21.staffQ, `select count(*)::text from online_payment_accounts;`, (o) => o.trim() === '0');
expectDeny('WS7b (reconcile): CASH is reconciled by drawer counts, never external evidence',
  `${U24.mgrQ}@aal2`, `select reconcile_card_payment('{"reservationId":"res_q_cash_001","evidenceType":"z_report","externalReference":"Z-1","currency":"GBP","matchedAmount":"6.00","paymentEventAt":"${reconEvt}","reason":"cash drawer reconciliation attempt","idempotencyKey":"idem_cash_01"}'::jsonb);`, 'cash_not_provider_reconciled');

/* --- correction 11: ONLINE is its own payment authority (provider account) --- */
expectDeny('WS7b (online): an online reservation cannot also name a terminal',
  U21.staffQ, `select (create_order_quote('{"id":"q_on_01","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';
               select begin_quote_payment('{"quoteId":"q_on_01","reservationId":"res_on_01","method":"online","terminalConfigId":"term_q_01"}'::jsonb);`, 'payment_route_invalid');
expectOk("WS7b (online): an online reservation binds the store's registered account",
  U21.staffQ, `select (begin_quote_payment('{"quoteId":"q_on_01","reservationId":"res_on_01","method":"online"}'::jsonb)) -> 'binding' ->> 'onlineAccountId';`,
  (o) => o.trim() === 'opa_q');
expectOk('WS7b (online): finalising online records OPERATOR_RECORDED_UNRECONCILED',
  U21.staffQ, `select (o ->> 'payment_status') from (select (finalise_order_payment('{"quoteId":"q_on_01","reservationId":"res_on_01","method":"online","providerReference":"pi_123","approvedAmount":"6.00"}'::jsonb)) -> 'order' as o) t;`,
  (o) => o.trim() === 'OPERATOR_RECORDED_UNRECONCILED');
expectOk('WS7b (online): the attempt records the ONLINE namespace (provider / account / ONLINE)',
  'service', `select payment_provider || '/' || provider_merchant_id || '/' || provider_terminal_id from quote_payment_attempts where reservation_id = 'res_on_01';`,
  (o) => o.trim() === 'stripe_online/acct_online_q/ONLINE');

/* --- correction 12: a completed order is a closed ledger --- */
expectDeny("WS7b (ledger): a completed order's total cannot be rewritten, by any role",
  'service', `update orders set total = 1.00 where quote_id = 'q_on_01';`, 'order_ledger_immutable');
expectDeny('WS7b (ledger): an illegal payment_status move is refused (only UNRECONCILED → RECONCILED is allowed)',
  'service', `update orders set payment_status = 'CASH_RECORDED' where quote_id = 'q_op_01';`, 'order_ledger_immutable');
expectDeny('WS7b (ledger): a completed order cannot be deleted',
  'service', `delete from orders where quote_id = 'q_on_01';`, 'order_ledger_immutable');
expectDeny('WS7b (ledger): a browser role has no write grant on the order ledger at all',
  U21.staffQ, `update orders set customer_name = 'x' where quote_id = 'q_on_01';`, 'permission denied');

/* --- correction 7: a PENDING attempt's bound identity is already frozen --- */
expectOk('WS7b (attempt freeze): a fresh reservation is PENDING',
  U21.staffQ, `select (create_order_quote('{"id":"q_pend_01","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';
               select (begin_quote_payment('{"quoteId":"q_pend_01","reservationId":"res_pend_01","method":"card"}'::jsonb)) ->> 'state';`,
  (o) => o.split('\n').map(x => x.trim()).filter(Boolean).pop() === 'reserved');
expectDeny("WS7b (attempt freeze): even a PENDING attempt's identity cannot be rewritten",
  'service', `update quote_payment_attempts set request_hash = 'tampered' where reservation_id = 'res_pend_01';`, 'attempt_is_immutable');
expectOk('WS7b (attempt freeze): releasing the PENDING attempt returns the basket to OPEN',
  U21.staffQ, `select (release_quote_payment('{"quoteId":"q_pend_01","reservationId":"res_pend_01","outcome":"abandoned"}'::jsonb)) ->> 'state';`,
  (o) => o.trim() === 'OPEN');
expectOk('WS7b (attempt freeze): the released attempt persists permanently as its own ABANDONED record',
  'service', `select state from quote_payment_attempts where reservation_id = 'res_pend_01';`,
  (o) => o.trim() === 'ABANDONED');

/* --- correction 5: past the 24h window a payment is PRIVILEGED, not lost --- */
expectOk('WS7b (recovery) fixture: a reservation aged past the 24-hour recovery window',
  U21.staffQ, `select (create_order_quote('{"id":"q_win_01","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';
               select (begin_quote_payment('{"quoteId":"q_win_01","reservationId":"res_win_01","method":"card"}'::jsonb)) ->> 'state';`,
  (o) => o.split('\n').map(x => x.trim()).filter(Boolean).pop() === 'reserved');
expectOk('WS7b (recovery): age the payment start past 24h (service clock)',
  'service', `update order_quotes set payment_started_at = now() - interval '25 hours' where id = 'q_win_01'; select 'ok';`, (o) => o.trim() === 'ok');
expectDeny('WS7b (recovery): ordinary finalisation past the window is refused, pointing to reconciliation',
  U21.staffQ, `select finalise_order_payment('{"quoteId":"q_win_01","reservationId":"res_win_01","method":"card","providerReference":"T-W","approvedAmount":"6.00"}'::jsonb);`, 'recovery_window_elapsed');
expectOk('WS7b (recovery): expire_stale_quotes is the ONLY writer that moves it to NEEDS_RECONCILIATION',
  U21.staffQ, `select ((expire_stale_quotes() ->> 'movedToReconciliation')::int >= 1)::text;`,
  (o) => o.trim() === 'true');
expectOk('WS7b (recovery): the quote now sits in NEEDS_RECONCILIATION',
  'service', `select status from order_quotes where id = 'q_win_01';`, (o) => o.trim() === 'NEEDS_RECONCILIATION');
expectDeny('WS7b (recovery): begin refuses a quote awaiting reconciliation',
  U21.staffQ, `select begin_quote_payment('{"quoteId":"q_win_01","reservationId":"res_win_02","method":"card"}'::jsonb);`, 'quote_needs_reconciliation');
expectDeny('WS7b (recovery): a team member cannot resolve reconciliation',
  U21.staffQ, `select resolve_payment_reconciliation('{"quoteId":"q_win_01","reservationId":"res_win_01","action":"void","reason":"no funds ever arrived"}'::jsonb);`, 'reconciliation_denied');
expectDeny('WS7b (recovery): resolution demands a written reason of substance',
  `${U24.mgrQ}@aal2`, `select resolve_payment_reconciliation('{"quoteId":"q_win_01","reservationId":"res_win_01","action":"void","reason":"short","resolutionId":"res_sol_01"}'::jsonb);`, 'reason_required');
expectOk('WS7b (recovery): a manager VOIDs the unrecoverable payment; the quote is CANCELLED',
  `${U24.mgrQ}@aal2`, `select (resolve_payment_reconciliation('{"quoteId":"q_win_01","reservationId":"res_win_01","action":"void","reason":"provider confirmed no settlement ever arrived","resolutionId":"res_sol_01"}'::jsonb)) ->> 'resolution';`,
  (o) => o.trim() === 'void');
expectOk('WS7b (recovery): the voided quote is CANCELLED and its attempt ABANDONED',
  'service', `select q.status || '/' || a.state from order_quotes q join quote_payment_attempts a on a.reservation_id = 'res_win_01' where q.id = 'q_win_01';`,
  (o) => o.trim() === 'CANCELLED/ABANDONED');

expectOk('WS7b (recovery) fixture: a SECOND aged reservation, to be RECORDED not voided',
  U21.staffQ, `select (create_order_quote('{"id":"q_win_02","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';
               select (begin_quote_payment('{"quoteId":"q_win_02","reservationId":"res_win_03","method":"card"}'::jsonb)) ->> 'state';`,
  (o) => o.split('\n').map(x => x.trim()).filter(Boolean).pop() === 'reserved');
expectOk('WS7b (recovery): age the second reservation past the window (service clock)',
  'service', `update order_quotes set payment_started_at = now() - interval '25 hours' where id = 'q_win_02'; select 'ok';`, (o) => o.trim() === 'ok');
expectOk('WS7b (recovery): expire_stale_quotes moves the second aged quote into reconciliation',
  U21.staffQ, `select ((expire_stale_quotes() ->> 'movedToReconciliation')::int >= 1)::text;`, (o) => o.trim() === 'true');
expectOk('WS7b (recovery): a manager RECORDS the delayed-but-real payment through the SAME finalisation core',
  `${U24.mgrQ}@aal2`, `select (r -> 'order' ->> 'payment_status') || '/' || (r ->> 'resolution')
               from (select resolve_payment_reconciliation('{"quoteId":"q_win_02","reservationId":"res_win_03","action":"record_order","reason":"bank statement shows the funds landed","resolutionId":"res_sol_02","payment":{"method":"card","providerReference":"T-LATE-OK","approvedAmount":"6.00"}}'::jsonb) as r) t;`,
  (o) => o.trim() === 'OPERATOR_RECORDED_UNRECONCILED/record_order');
expectOk('WS7b (recovery): the recorded quote is CONSUMED with a real order from the snapshot',
  'service', `select q.status || '/' || (o.id is not null)::text from order_quotes q join orders o on o.quote_id = q.id where q.id = 'q_win_02';`,
  (o) => o.trim() === 'CONSUMED/true');
/* --- R3.4 (finding 5): recovery is IDEMPOTENT, and a changed claim is not a replay --- */
expectDeny('WS7b (recovery, R3): a recovery without a resolution id is refused',
  `${U24.mgrQ}@aal2`, `select resolve_payment_reconciliation('{"quoteId":"q_win_02","reservationId":"res_win_03","action":"record_order","reason":"bank statement shows the funds landed","payment":{"method":"card","providerReference":"T-LATE-OK","approvedAmount":"6.00"}}'::jsonb);`, 'resolution_id_required');
expectOk('WS7b (recovery, R3): replaying the VOID with the same id and claim returns the original outcome',
  `${U24.mgrQ}@aal2`, `select (r ->> 'resolution') || '/' || (r ->> 'duplicate')
               from (select resolve_payment_reconciliation('{"quoteId":"q_win_01","reservationId":"res_win_01","action":"void","reason":"provider confirmed no settlement ever arrived","resolutionId":"res_sol_01"}'::jsonb) as r) t;`,
  (o) => o.trim() === 'void/true');
expectDeny('WS7b (recovery, R3): the same resolution id with a CHANGED REASON conflicts',
  `${U24.mgrQ}@aal2`, `select resolve_payment_reconciliation('{"quoteId":"q_win_01","reservationId":"res_win_01","action":"void","reason":"an entirely different written reason","resolutionId":"res_sol_01"}'::jsonb);`, 'idempotency_conflict');
expectOk('WS7b (recovery, R3): replaying the RECORD with the same id and claim returns the original order',
  `${U24.mgrQ}@aal2`, `select (r ->> 'resolution') || '/' || (r ->> 'duplicate') || '/' || ((r -> 'order' ->> 'quote_id') = 'q_win_02')::text
               from (select resolve_payment_reconciliation('{"quoteId":"q_win_02","reservationId":"res_win_03","action":"record_order","reason":"bank statement shows the funds landed","resolutionId":"res_sol_02","payment":{"method":"card","providerReference":"T-LATE-OK","approvedAmount":"6.00"}}'::jsonb) as r) t;`,
  (o) => o.trim() === 'record_order/true/true');
expectDeny('WS7b (recovery, R3): the same id with a CHANGED CLAIMED PAYMENT TIME conflicts',
  `${U24.mgrQ}@aal2`, `select resolve_payment_reconciliation('{"quoteId":"q_win_02","reservationId":"res_win_03","action":"record_order","reason":"bank statement shows the funds landed","resolutionId":"res_sol_02","payment":{"method":"card","providerReference":"T-LATE-OK","approvedAmount":"6.00","paidAt":"2026-07-01T09:00:00Z"}}'::jsonb);`, 'idempotency_conflict');

/* --- R3: canonical hashing is jsonb-canonical — key order cannot matter --- */
expectOk('WS7b (R3): reordered JSON spellings of the same claim hash identically',
  'service', `select (canonical_request_hash('{"b":2,"a":{"y":1,"x":[1,2]}}'::jsonb)
                    = canonical_request_hash('{"a":{"x":[1,2],"y":1},"b":2}'::jsonb))::text;`,
  (o) => o.trim() === 'true');
expectOk('WS7b (R3): …while ARRAY order remains significant (a different sequence is a different claim)',
  'service', `select (canonical_request_hash('{"a":[1,2]}'::jsonb)
                    is distinct from canonical_request_hash('{"a":[2,1]}'::jsonb))::text;`,
  (o) => o.trim() === 'true');

/* --- R3.5b (finding 13): expiry is store-scoped; the OWNER sweeps the estate --- */
expectOk('WS7b (R3, finding 13) fixture: a stale OPEN quote in EACH of two stores',
  U18.staffF, `select (create_order_quote('{"id":"q_iso_f","items":[{"menuItemId":"mp_fx_std","quantity":1}]}'::jsonb)) ->> 'duplicate';`,
  (o) => o.trim() === 'false');
expectOk('WS7b (R3, finding 13) fixture: …and one in store Q, both aged past expiry',
  U21.staffQ, `select (create_order_quote('{"id":"q_iso_q","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';`,
  (o) => o.trim() === 'false');
expectOk('WS7b (R3, finding 13) fixture: both forced past expiry',
  'service', `update order_quotes set expires_at = now() - interval '1 minute' where id in ('q_iso_f','q_iso_q'); select 'ok';`,
  (o) => o.trim() === 'ok');
expectOk('WS7b (R3, finding 13): a store-Q member expires ONLY store Q',
  U21.staffQ, `select ((expire_stale_quotes() ->> 'expired')::int >= 1)::text;`,
  (o) => o.trim() === 'true');
expectOk('WS7b (R3, finding 13): …store Q stale quote is EXPIRED, store F untouched',
  'service', `select (select status from order_quotes where id = 'q_iso_q') || '/' || (select status from order_quotes where id = 'q_iso_f');`,
  (o) => o.trim() === 'EXPIRED/OPEN');
expectOk('WS7b (R3, finding 13): an owner WITHOUT MFA gets no estate sweep (is_owner is AAL2-gated)',
  U.owner, `select ((expire_stale_quotes() ->> 'expired')::int = 0)::text;`,
  (o) => o.trim() === 'true');
expectOk('WS7b (R3, finding 13): …and store F is untouched by the MFA-less owner',
  'service', `select status from order_quotes where id = 'q_iso_f';`,
  (o) => o.trim() === 'OPEN');
expectOk('WS7b (R3, finding 13): the OWNER (with MFA) performs the estate-wide sweep',
  `${U.owner}@aal2`, `select ((expire_stale_quotes() ->> 'expired')::int >= 1)::text;`,
  (o) => o.trim() === 'true');
expectOk('WS7b (R3, finding 13): …and store F is now EXPIRED too',
  'service', `select status from order_quotes where id = 'q_iso_f';`,
  (o) => o.trim() === 'EXPIRED');

/* --- R3 (recovery timestamps): an OLDER legitimate payment time is recordable;
       a time predating the attempt, or in the future, is not --- */
expectOk('WS7b (R3, recovery-time) fixture: a genuinely 25-hour-old reservation awaiting reconciliation',
  'service', `insert into order_quotes
      (id, store_id, staff_id, channel, status, items, applied_deals,
       subtotal, discount_total, tax_rate, tax_amount, total,
       store_vat_status, vat_effective_date, allowed_payment_methods,
       config_version, quote_request_hash, expires_at,
       payment_started_at, reservation_id, created_at)
    select 'q_ts_01', store_id, staff_id, channel, 'PAYMENT_PENDING', items, applied_deals,
       subtotal, discount_total, tax_rate, tax_amount, total,
       store_vat_status, vat_effective_date, allowed_payment_methods,
       config_version, 'hash_q_ts_01', now() + interval '1 day',
       now() - interval '25 hours', 'res_ts_01', now() - interval '25 hours'
      from order_quotes where id = 'q_win_02';
    insert into quote_payment_attempts
      (reservation_id, quote_id, store_id, payment_method, operator_staff_id,
       request_hash, state, terminal_config_id, started_at, created_at)
    values ('res_ts_01', 'q_ts_01', 's_q', 'card', 'emp_q',
       'hash_res_ts_01', 'PENDING', 'term_q_01',
       now() - interval '25 hours', now() - interval '25 hours');
    select 'ok';`,
  (o) => o.trim() === 'ok');
expectDeny('WS7b (R3, recovery-time): a claimed time BEFORE the attempt existed is refused',
  `${U24.mgrQ}@aal2`, `select resolve_payment_reconciliation(jsonb_build_object(
      'quoteId','q_ts_01','reservationId','res_ts_01','action','record_order',
      'reason','delayed card payment recovered from terminal journal',
      'resolutionId','res_sol_ts_bad1',
      'payment', jsonb_build_object('method','card','providerReference','T-TS',
        'approvedAmount','6.00', 'paidAt', to_char(now() - interval '26 hours', 'YYYY-MM-DD"T"HH24:MI:SSOF'))));`,
  'payment_time_implausible');
expectDeny('WS7b (R3, recovery-time): a FUTURE claimed time is refused in recovery too',
  `${U24.mgrQ}@aal2`, `select resolve_payment_reconciliation('{"quoteId":"q_ts_01","reservationId":"res_ts_01","action":"record_order","reason":"delayed card payment recovered from terminal journal","resolutionId":"res_sol_ts_bad2","payment":{"method":"card","providerReference":"T-TS","approvedAmount":"6.00","paidAt":"2099-01-01T00:00:00Z"}}'::jsonb);`,
  'payment_time_in_future');
expectOk('WS7b (R3, recovery-time): a 24.5-hour-old LEGITIMATE payment time is accepted',
  `${U24.mgrQ}@aal2`, `select (r -> 'order' ->> 'payment_status') || '/' || (r ->> 'resolution')
      from (select resolve_payment_reconciliation(jsonb_build_object(
        'quoteId','q_ts_01','reservationId','res_ts_01','action','record_order',
        'reason','delayed card payment recovered from terminal journal',
        'resolutionId','res_sol_ts_ok',
        'payment', jsonb_build_object('method','card','providerReference','T-TS',
          'approvedAmount','6.00', 'paidAt', to_char(now() - interval '24 hours 30 minutes', 'YYYY-MM-DD"T"HH24:MI:SSOF')))) as r) t;`,
  (o) => o.trim() === 'OPERATOR_RECORDED_UNRECONCILED/record_order');
expectOk('WS7b (R3, recovery-time): the ledger shows the OLD claimed time and the FRESH server record time',
  'service', `select (payment_claimed_at < now() - interval '24 hours')::text || '/' ||
                     (payment_recorded_at > now() - interval '5 minutes')::text || '/' ||
                     (payment_captured_at = payment_claimed_at)::text
              from orders where quote_id = 'q_ts_01';`,
  (o) => o.trim() === 'true/true/true');

/* --- correction: expire_stale_quotes is also the only writer of EXPIRED --- */
expectOk('WS7b (expiry) fixture: an OPEN quote forced past its expiry',
  U21.staffQ, `select (create_order_quote('{"id":"q_exp_ws7b","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';`,
  (o) => o.trim() === 'false');
expectOk('WS7b (expiry): age it, then expire_stale_quotes reports and persists EXPIRED',
  'service', `update order_quotes set expires_at = now() - interval '1 minute' where id = 'q_exp_ws7b'; select 'ok';`, (o) => o.trim() === 'ok');
expectOk('WS7b (expiry): expire_stale_quotes marks the aged OPEN quote EXPIRED',
  U21.staffQ, `select ((expire_stale_quotes() ->> 'expired')::int >= 1)::text;`, (o) => o.trim() === 'true');
expectOk('WS7b (expiry): the quote is now EXPIRED bookkeeping',
  'service', `select status from order_quotes where id = 'q_exp_ws7b';`, (o) => o.trim() === 'EXPIRED');

/* --- correction 2: config/VAT revalidation refuses a stale quote (kept LAST,
       because it shifts the shared catalogue digest) --- */
expectOk('WS7b (revalidation) fixture: a fresh quote priced under the current config',
  U21.staffQ, `select (create_order_quote('{"id":"q_cfg_01","items":[{"menuItemId":"mp_q","quantity":1}]}'::jsonb)) ->> 'duplicate';`,
  (o) => o.trim() === 'false');
expectOk('WS7b (revalidation): the CATALOGUE changes after quoting (a new item shifts the config digest)',
  'service', `insert into menu_items (id, name, category, price, image, tax_code)
              values ('mp_cfg_new', 'Config Shifter', 'milkshakes', 4, '', 'STANDARD_RATE') on conflict (id) do nothing;
              select 'ok';`, (o) => o.trim() === 'ok');
expectDeny('WS7b (revalidation): reserving the now-STALE quote is refused — re-price the basket',
  U21.staffQ, `select begin_quote_payment('{"quoteId":"q_cfg_01","reservationId":"res_cfg_01","method":"card"}'::jsonb);`, 'quote_config_stale');

/* ---------------------------------------------------------------- */
/* INC11 (external audit finding): PROJECTION VIEWS ARE READ-ONLY.   */
/*   Seven auto-updatable public projections carried INSERT/UPDATE/  */
/*   DELETE for `authenticated`, inherited from Supabase's default   */
/*   privileges. The views are owned by the table owner and the base */
/*   tables are not FORCE RLS, so PostgreSQL checked the underlying  */
/*   write as the VIEW OWNER — every row-level policy SKIPPED. It    */
/*   was reproduced end-to-end before the fix: the direct write was  */
/*   refused, the identical write through the view landed.           */
/*   The grants are enumerated LIVE here, so a future migration that */
/*   adds a view and re-inherits the defaults fails on the next run  */
/*   rather than shipping the hole again.                            */
/* ---------------------------------------------------------------- */
const VIEW_INTRUDER = '00000000-0000-4000-8000-0000deadbeef@aal2';

/* Generalised on the auditor's point: the seven named views are a snapshot,
   not the invariant. This discovers EVERY view and materialised view in every
   schema a browser role can reach (schemas are discovered too — USAGE is what
   makes a schema reachable), and asks the EFFECTIVE privilege question, so a
   grant inherited through PUBLIC or role membership is caught where a scan of
   direct ACL rows would miss it. All six write privileges, not three. */
expectOk('INC11 views: NO view in a reachable schema grants any write privilege to a browser role (effective)',
  'service', `select coalesce(string_agg(distinct x.s, ', '), 'none') from (
                select n.nspname || '.' || c.relname || ' -> ' || r || '/' || p as s
                  from pg_class c
                  join pg_namespace n on n.oid = c.relnamespace
                  cross join unnest(array['anon', 'authenticated']) r
                  cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                 where c.relkind in ('v', 'm')
                   and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
                   and (has_schema_privilege('anon', n.nspname, 'USAGE')
                     or has_schema_privilege('authenticated', n.nspname, 'USAGE'))
                   and has_table_privilege(r, c.oid, p)) x;`,
  (o) => o.trim() === 'none');
expectOk('INC11 views: …and PUBLIC holds none of them either (a grant to PUBLIC arms every future role)',
  'service', `select coalesce(string_agg(distinct n.nspname || '.' || c.relname || '/' || a.privilege_type, ', '), 'none')
                from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
                cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
               where c.relkind in ('v', 'm')
                 and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
                 and (has_schema_privilege('anon', n.nspname, 'USAGE')
                   or has_schema_privilege('authenticated', n.nspname, 'USAGE'))
                 and a.grantee = 0
                 and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER');`,
  (o) => o.trim() === 'none');

/* ROOT CAUSE, checked every run. The revokes above fix the relations that
   EXIST; pg_default_acl decides what the next one starts with. Default
   privileges are creator-specific — one row per grantor role — so this is
   deliberately grantor-agnostic: NO relation default-ACL, for any grantor, in
   any schema, may arm anon, authenticated or PUBLIC. The refusing trigger is
   defence in depth, not the thing making this safe. */
expectOk('INC11 defaults: no relation default-ACL arms a browser role (any grantor, any schema)',
  'service', `select coalesce(string_agg(coalesce(n.nspname, 'all-schemas') || '/' ||
                                         d.defaclrole::regrole::text || '/' ||
                                         array_to_string(d.defaclacl, ' '), ', '), 'none')
                from pg_default_acl d
                left join pg_namespace n on n.oid = d.defaclnamespace
               where d.defaclobjtype = 'r'
                 and exists (select 1 from aclexplode(d.defaclacl) a
                              where a.grantee = 0
                                 or a.grantee = 'anon'::regrole
                                 or a.grantee = 'authenticated'::regrole);`,
  (o) => o.trim() === 'none');
/* The BEHAVIOURAL half of this proof (create a relation, ask what the browser
   actually receives) runs where it is most meaningful: inside the migration's
   own acceptance block, executed by the real creating role at apply time, and
   again in scripts/inc11-view-authority.test.mjs. It is not repeated here
   because this suite's service identity has no CREATE on the schema. */

/* P0-3 recurrence control. Chain 89 seeds the authoritative revision keys;
   a FUTURE collection that gains the bump trigger without a seeded ledger
   row would resurrect the first-save deadlock (hydrate nothing → send null →
   refused → the checkpoint's lazy insert rolls back → repeat). Discovered,
   not listed: the trigger set IS the collection set. Behaviour proof:
   scripts/inc11-revision-guard.test.mjs. */
expectOk('INC11 revisions: every trigger-bearing collection has a seeded ledger row (bootstrap invariant)',
  'service', `select coalesce(string_agg(c.relname, ', ' order by c.relname), 'none')
                from pg_trigger t
                join pg_class c on c.oid = t.tgrelid
                join pg_namespace n on n.oid = c.relnamespace
               where t.tgname = 'trg_zz_collection_revision'
                 and n.nspname = 'public'
                 and not exists (select 1 from collection_revisions cr
                                  where cr.table_key = c.relname);`,
  (o) => o.trim() === 'none');

expectOk('INC11 views: every WRITABLE view carries the read-only trigger; the rest are structurally unwritable',
  'service', `select coalesce(string_agg(v.table_schema || '.' || v.table_name, ', '), 'none')
                from information_schema.views v
                join pg_class c on c.relname = v.table_name
                join pg_namespace n on n.oid = c.relnamespace and n.nspname = v.table_schema
               where c.relkind = 'v'
                 and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
                 and (has_schema_privilege('anon', n.nspname, 'USAGE')
                   or has_schema_privilege('authenticated', n.nspname, 'USAGE'))
                 and (v.is_updatable = 'YES' or v.is_insertable_into = 'YES'
                   or v.is_trigger_updatable = 'YES' or v.is_trigger_insertable_into = 'YES'
                   or v.is_trigger_deletable = 'YES')
                 and not exists (select 1 from pg_trigger t
                                  where t.tgname = 'trg_view_read_only'
                                    and t.tgenabled in ('O', 'A')   -- D and R do not fire on origin
                                    and t.tgrelid = c.oid);`,
  (o) => o.trim() === 'none');
/* tgenabled is O (origin), A (always), D (disabled) or R (replica-only). An R
   trigger exists and is not "disabled", yet never fires for ordinary sessions. */
expectOk('INC11 views: no refusal trigger is disabled (D) or replica-only (R)',
  'service', `select coalesce(string_agg(c.relname || '=' || t.tgenabled::text, ', '), 'none')
                from pg_trigger t join pg_class c on c.oid = t.tgrelid
               where t.tgname = 'trg_view_read_only' and t.tgenabled not in ('O', 'A');`,
  (o) => o.trim() === 'none');

/* The exploit itself, pinned as a permanent negative: a signed-in identity
   with NO staff row — the weakest possible authenticated caller. */
expectDeny('INC11 views: a signed-in NON-STAFF identity cannot rewrite the menu through its projection',
  VIEW_INTRUDER, `update menu_items_public set name = 'bypass' where id in (select id from menu_items_public limit 1);`);
expectDeny('INC11 views: …nor delete published news through its projection',
  VIEW_INTRUDER, `delete from news_posts_public;`);
expectDeny('INC11 views: …nor insert a store into the public projection',
  VIEW_INTRUDER, `insert into stores_public (id, name) values ('st_bypass', 'Bypass');`);
/* The READ twin of the same class. A view without security_invoker reads as
   its OWNER, so RLS on the base table does not apply to the caller. That is
   deliberate for the seven publication-gated projections (anon has no
   base-table read at all — Increment 3), and it must be deliberate NOWHERE
   else: an operational or financial view added without the flag would leak
   store-scoped data to every signed-in account. Today the reporting views
   carry security_invoker=true; this pins that as a rule rather than a habit. */
expectOk('INC11 views: every view is security_invoker, or a DECLARED publication-gated projection',
  'service', `select coalesce(string_agg(c.relname, ', '), 'none')
                from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relkind = 'v'
                 and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=true%'
                 and c.relname not in ('menu_items_public', 'stores_public', 'news_posts_public',
                                       'job_vacancies_public', 'deals_public', 'cms_pages_public',
                                       'media_assets_public', 'privacy_notice_current',
                                       'public_site_configuration');`,
  (o) => o.trim() === 'none');

/* ---------------------------------------------------------------- */
/* INC11 (same class, larger surface): THE ANONYMOUS FUNCTION        */
/* SURFACE IS EMPTY. PostgreSQL grants EXECUTE to PUBLIC on every    */
/* new function and the project inherited a default grant to anon,   */
/* so seventeen SECURITY DEFINER functions were anonymously          */
/* reachable. Sixteen failed closed on their own internal gate;      */
/* launch_blocking_reasons() returned the whole launch-readiness     */
/* checklist — unarmed gates and admin routes — to the open          */
/* internet. Enumerated live: a new function that arrives            */
/* anonymously executable fails HERE, not in production.             */
/* ---------------------------------------------------------------- */
/* Extension members (pgcrypto's digest/crypt/armor…) are excluded: they are
   not ours to re-privilege, their ACLs are not reproduced by pg_dump, and
   they are pure computation with no DEFINER rights and no data reach. */
expectOk('INC11 functions: NO project function in the schema is executable by anon',
  'service', `select coalesce(string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', '), 'none')
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.prokind = 'f'
                 and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
                 and has_function_privilege('anon', p.oid, 'EXECUTE');`,
  (o) => o.trim() === 'none');
/* Future functions too: no default ACL for functions may grant anon, and
   none may leave PostgreSQL's built-in PUBLIC EXECUTE in place (anon is a
   member of PUBLIC — revoking only the anon default hands the same access
   straight back, and the SCHEMA-SCOPED form of that revoke silently does
   nothing). A PUBLIC entry is an ACL item with an empty grantee. */
expectOk('INC11 functions: no function default-privilege grants anon or PUBLIC',
  'service', `select count(*)::text from pg_default_acl d
               where d.defaclobjtype = 'f'
                 and (array_to_string(d.defaclacl, ' ') like '%anon=%'
                      or exists (select 1 from unnest(d.defaclacl) a where a::text like '=%'));`,
  (o) => o.trim() === '0');
expectDeny('INC11 functions: the launch-readiness checklist is no longer readable by the open internet',
  'anon', `select launch_blocking_reasons();`);
/* A GATED WRAPPER IS ONLY AS STRONG AS THE THING BEHIND IT. launch_readiness()
   checks is_owner() and refuses politely — while the enumerator it wraps,
   launch_blocking_reasons(), was itself a PostgREST endpoint that any signed-in
   account could call directly. Both are closed now; this ratchet is the general
   form of that lesson: a SECURITY DEFINER function the browser can reach must
   contain an authority gate, or be DECLARED here with the reason it needs none.
     • assert_launch_ready      — raises with the blocked KEYS for one named
                                  context; must stay reachable because the
                                  trigger functions that call it run as the
                                  invoking user.
     • finalise_order_payment   — a thin wrapper; the gate (current_staff_id)
                                  lives in finalise_order_payment_core.
     • pos_catalog_version      — returns one integer, the catalogue version.
     • sifr_report_store        — a helper used INSIDE RLS policy expressions,
                                  which are evaluated as the calling role.
     • collection_revision_checkpoint — called by replace_collection() and
                                  close_vacancy(), which are SECURITY INVOKER,
                                  so every ordinary publish calls it as the
                                  staff member. Residual: an authenticated
                                  caller can create an unused ledger row for a
                                  string that names no table. */
expectOk('INC11 functions: every browser-reachable DEFINER function is gated, or declared ungated',
  'service', `select coalesce(string_agg(p.proname, ', '), 'none')
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.prosecdef
                 and has_function_privilege('authenticated', p.oid, 'EXECUTE')
                 and p.prosrc !~ 'is_owner|is_manager_or_owner|is_store_manager|current_staff_id|current_staff_store|current_staff_role|auth[.]uid|not_staff'
                 and p.proname not in ('assert_launch_ready', 'finalise_order_payment',
                                       'pos_catalog_version', 'sifr_report_store',
                                       'collection_revision_checkpoint');`,
  (o) => o.trim() === 'none');
expectDeny('INC11 functions: the readiness enumerator behind the owner gate is not a browser endpoint',
  U21.staffQ, `select count(*) from launch_blocking_reasons();`);

/* ---------------------------------------------------------------- */
/* INC11: THE STORAGE POSTURE. CVs and staff documents are the only  */
/* personal data here, and they are protected by an unusual choice:  */
/* storage.objects has RLS on and NO POLICY AT ALL, so the Edge      */
/* Functions' service role is the only way in. That was recorded in  */
/* a comment and enforced by nothing. The harness now grants the     */
/* browser roles the same storage privileges production grants them, */
/* so these checks prove the bytes are unreachable for the reason    */
/* production actually relies on.                                    */
/* ---------------------------------------------------------------- */
expectOk('INC11 storage: RLS is enabled on storage.objects',
  'service', `select c.relrowsecurity::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'storage' and c.relname = 'objects';`,
  (o) => o.trim() === 'true');
expectOk('INC11 storage: storage.objects has NO policy — a cvs_* policy would re-open the direct browser path',
  'service', `select coalesce(string_agg(policyname, ', '), 'none') from pg_policies
               where schemaname = 'storage' and tablename = 'objects';`,
  (o) => o.trim() === 'none');
expectOk('INC11 storage: only the published-imagery bucket is public',
  'service', `select coalesce(string_agg(id, ', ' order by id), 'none') from storage.buckets where public;`,
  (o) => o.trim() === 'menu-media');
/* A read under RLS-with-no-policy returns ZERO ROWS rather than an error, so
   these assert emptiness against objects that demonstrably exist. */
expectOk('INC11 storage fixture: real CV and staff-document objects exist to be hidden',
  'service', `insert into storage.objects (bucket_id, name) values
                ('cvs', 'matrix/real-cv.pdf'), ('staff-documents', 'matrix/real-contract.pdf')
              on conflict do nothing;
              select count(*)::text from storage.objects where name like 'matrix/%';`,
  (o) => o.trim() === '2');
expectOk('INC11 storage: anon sees NONE of them',
  'anon', `select count(*)::text from storage.objects;`, (o) => o.trim() === '0');
expectOk('INC11 storage: a signed-in NON-STAFF account sees none of them either',
  VIEW_INTRUDER, `select count(*)::text from storage.objects;`, (o) => o.trim() === '0');
expectDeny('INC11 storage: …nor upload an object row of its own',
  VIEW_INTRUDER, `insert into storage.objects (bucket_id, name) values ('cvs', 'intruder.pdf');`);

expectOk('INC11 functions: …while the authorised callers keep every RPC they had',
  'service', `select (has_function_privilege('authenticated', 'public.save_website_studio(jsonb, jsonb, bigint, bigint)', 'EXECUTE')
                  and has_function_privilege('authenticated', 'public.transition_application(text, text, text)', 'EXECUTE')
                  and has_function_privilege('service_role', 'public.submit_public_form(text, jsonb, uuid, text, text, text, text)', 'EXECUTE'))::text;`,
  (o) => o.trim() === 'true');

expectOk('INC11 views: …while the ANONYMOUS read the projections exist for is untouched',
  'anon', `select (count(*) >= 0)::text from menu_items_public;`, (o) => o.trim() === 'true');

/* ---------------------------------------------------------------- */
console.log(`\n${failed === 0 ? '✔' : '✖'} LOCAL RLS MATRIX — ${passed} passed, ${failed} failed`);
if (failed) { console.log('failed: ' + failures.join(' | ')); process.exit(1); }
