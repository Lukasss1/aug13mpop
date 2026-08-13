/* r48-lifecycle.test.mjs — R4.8 Workstream B: employment lifecycle, no casual deletion. */
import { readFileSync } from 'node:fs';
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('✔', n); };
const bad = (n, d) => { failed++; console.log('✘', n, d || ''); };
const check = (n, c, d) => (c ? ok(n) : bad(n, d));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const sql = readFileSync('supabase/migration_r48_truth_and_people.sql', 'utf8');
const ap = strip(readFileSync('src/components/AdminPanel.tsx', 'utf8'));
const dlg = readFileSync('src/components/admin/EndEmploymentDialog.tsx', 'utf8');
const lib = readFileSync('src/lib/employment.ts', 'utf8');
const fn = readFileSync('supabase/functions/employee-access-revoke/index.ts', 'utf8');
check('AdminPanel: destructive delete flow removed', !ap.includes('Delete the staff record for'));
check('AdminPanel: End-employment entry replaces it', ap.includes('End employment'));
check('history preserved: end_employment never deletes rows', !/delete from (work_shifts|clock_history|payslips|staff_documents)/.test(sql));
check('future shifts flagged, not deleted', /cancelled_leaver/.test(sql));
check('scheduled ends fall due server-side (sweep)', /employment_sweep_due/.test(sql));
check('immediate disable uses the stage9 disabled status (instant power loss)', /status\s+= case when p_immediate/.test(sql) && /'disabled'/.test(sql));
check('managers cannot end managers/owners', /managers cannot end managers\/owners/.test(sql));
check('nobody ends their own employment', /cannot_end_own_employment/.test(sql));
check('end_employment writes an audit event', /'employment\.ended'/.test(sql));
check('purge is owner-only (AAL2 via is_owner)', /purge_employee[\s\S]{0,400}if not is_owner\(\) then raise exception 'not_permitted'/.test(sql));
check('purge requires typed-name confirmation', /confirmation_mismatch/.test(sql));
check('purge refuses when ANY dependent history exists', /has_dependent_history/.test(sql) && ['work_shifts','clock_history','payslips','staff_documents','staff_compliance_records','training_results','sifr_reports'].every((t) => new RegExp(`from ${t}\\s+where`).test(sql)));
check('sessions revoked through the audited two-step (intent + service-role fn)', /request_recovery_action/.test(lib) && /admin_recovery_intents/.test(fn));
// R4.9 G6: these two checks asserted WHERE the rule lived — in the Edge
// Function's own read/check/act/patch sequence. That sequence was the defect:
// two concurrent callers both read an unconsumed intent before either patched
// it. The rules moved INTO the database, inside a row lock, so the assertions
// now check the delegation here and the enforcement there. The executable proof
// (including the concurrency race) is scripts/r49-recovery.test.sh.
const r49 = readFileSync('supabase/migration_r49_recovery.sql', 'utf8');
check('revoke fn performs NO Auth Admin call before an atomic claim succeeds',
  /rpc\/claim_recovery_intent/.test(fn) && /if \(!claim\?\.ok\)/.test(fn));
check('the claim is taken under a row lock, not a read-then-patch',
  /from admin_recovery_intents[\s\S]{0,80}for update/i.test(r49));
check('the database refuses stale (>10 min) or consumed intents',
  /intent_already_consumed/.test(r49) && /interval '10 minutes'/.test(r49));
check('the database binds the executor to the intent requester',
  /requested_by is distinct from v_actor/.test(r49) && /not_requester/.test(r49));
check('authorisation is RE-EVALUATED at execution time, not just at request time',
  /recovery_action_permitted\(v_intent\.target_staff_id/.test(r49));
check('a manager cannot reach across storefronts (the cross-store gap)',
  /store_id is distinct from current_staff_store\(\)/.test(r49) && /target_other_store/.test(r49));
check('managers cannot reset an owner MFA (DB rule)', /reset_mfa[\s\S]{0,200}if not is_owner\(\) then raise exception/.test(sql));
check('nobody resets their OWN factor via the flow', /self_reset_forbidden/.test(sql));
check('leaver ban revokes refresh tokens + bans at the Auth API', /ban_duration/.test(fn) && /logout/.test(fn));
check('dialog: purge path demands the typed full name', /typedName !== employee.name/.test(dlg));
check('dialog: leaver copy promises history preservation, not deletion', /Nothing is deleted/.test(dlg));
console.log(`\nR48-LIFECYCLE — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
