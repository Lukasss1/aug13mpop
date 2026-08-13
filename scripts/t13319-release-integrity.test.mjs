#!/usr/bin/env node
/** T13.3.19 — semantic source contract for the release-integrity closure. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed += 1; console.error(`FAIL — ${name}${detail ? ` (${detail})` : ''}`); }
}
function walk(dir) {
  const out = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    const st = statSync(path.join(ROOT, rel));
    if (st.isDirectory()) out.push(...walk(rel)); else out.push(rel);
  }
  return out;
}

const edgeFiles = walk('supabase/functions').filter((p) => p.endsWith('.ts'));
const edge = edgeFiles.map((p) => `${p}\n${read(p)}`).join('\n');
const sharedRequest = read('supabase/functions/_shared/request.ts');
const sharedJwt = read('supabase/functions/_shared/jwt.ts');
const migration = read('supabase/migration_t13319_release_integrity.sql');
const manifest = read('launch/migration-manifest.sh');
const app = read('src/App.tsx');
const admin = read('src/components/AdminPanel.tsx');
const registries = read('src/lib/registries.ts');
const invitation = read('supabase/functions/staff-invite/index.ts');
const lifecycle = read('supabase/functions/employee-access-revoke/index.ts');
const staffInviteClient = read('src/lib/staffInvite.ts');
const docUpload = read('supabase/functions/staff-doc-upload/index.ts');
const docDelete = read('supabase/functions/staff-doc-delete/index.ts');
const training = read('supabase/functions/training-media/index.ts');
const email = read('supabase/functions/send-email/index.ts');
const pos = read('supabase/functions/pos-pair/index.ts');
const publicForm = read('supabase/functions/public-form/index.ts');
const cv = read('supabase/functions/cv-upload/index.ts');
const legacy = read('src/components/admin/LegacyImport.tsx');
const pkg = JSON.parse(read('package.json'));

check('all Edge request bodies use the shared bounded parser',
  !/req\.(?:json|formData|text|arrayBuffer|blob)\s*\(/.test(edge));
check('shared bounded parser enforces declared and streamed byte caps',
  /content-length/i.test(sharedRequest) && /reader\.read\(\)/.test(sharedRequest) && /reader\.cancel/.test(sharedRequest));
const jwtDecodersOutsideShared = edgeFiles.filter((p) => p !== 'supabase/functions/_shared/jwt.ts')
  .filter((p) => /\.split\(['"]\.['"]\)|\batob\s*\(/.test(read(p)));
check('JWT payload decoding exists only in the shared helper', jwtDecodersOutsideShared.length === 0, jwtDecodersOutsideShared.join(', '));
check('shared JWT helper handles base64url and invalid claims defensively',
  /replace\(\/-\/g, '\+'\)/.test(sharedJwt) && /replace\(\/_\/g, '\/'\)/.test(sharedJwt) && /catch/.test(sharedJwt));

check('T13.3.19 remains ordered before the append-only final-audit and public-web layers',
  /migration_t13313_staff_portal_integrity\.sql"\s+"supabase\/migration_t13319_release_integrity\.sql"\s+"supabase\/migration_t13320_final_audit\.sql"\s+"supabase\/migration_t13322_public_store_scope\.sql"\s*\)/s.test(manifest));
check('generic collection publication no longer accepts clock_history',
  /v_pk:=case p_table when 'payslips' then 'id' else null end/.test(migration) && !/when 'clock_history'/.test(migration));
check('timesheet decisions are narrow, locked and server-stamped',
  /function public\.decide_timesheets\(p_ids text\[\], p_decision text\)/.test(migration)
  && /for update/.test(migration) && /clock_timestamp\(\)/.test(migration)
  && /approved_by=coalesce\(nullif\(trim\(v_actor_name\)/.test(migration));
check('timesheet decision RPC forbids self-approval',
  /ch\.employee_id is distinct from v_actor_id/.test(migration));
check('timesheet facts and terminal decisions are database-immutable',
  /protect_clock_history_facts/.test(migration) && /clock_facts_are_immutable/.test(migration)
  && /timesheet_decision_is_terminal/.test(migration));
check('browser sends only IDs and a decision for timesheets',
  /decideTimesheetsRpc\(uniqueIds, decision, token\)/.test(app)
  && /p_ids:\s*ids/.test(registries) && /p_decision:\s*decision/.test(registries)
  && !/apply_collection_changes[\s\S]{0,500}clock_history/.test(registries));
check('timesheet UI never supplies approver identity or approval timestamp',
  !/approvedBy:\s*approver|approvedAt:\s*new Date/.test(admin));
check('legacy browser importer cannot republish clock history',
  !/milkpop_clock_history/.test(legacy) && !/clockRepo/.test(legacy));

check('POS perimeter uses one atomic RPC and fails closed on RPC uncertainty',
  /rpc\/pos_pair_attempt/.test(pos) && !/pos_pair_attempts\?/.test(pos)
  && /Pairing is temporarily unavailable/.test(pos));
check('POS SQL reserves rate and pairs in the same function',
  /function public\.pos_pair_attempt/.test(migration)
  && /reserve_anonymous_rate/.test(migration) && /pos_complete_pairing/.test(migration));
check('POS pairing has bounded keyed IP and metadata inputs',
  /hmacIp/.test(pos) && /MAX_REQUEST_BYTES/.test(pos) && /boundedText/.test(pos));
check('operational pairing and upload evidence has scheduled retention',
  /delete from public\.pos_pair_attempts/.test(migration)
  && /delete from public\.cv_upload_ip_log/.test(migration)
  && /delete from public\.anonymous_rate_buckets/.test(migration));

check('public and CV rejection paths do not insert one row per rejection',
  !/svc\(['"]form_submission_log/.test(publicForm) && !/status:\s*['"]denied['"]/.test(cv));
check('CV and staff-document budgets are atomic, fail closed and precede multipart parsing',
  /rpc\/reserve_anonymous_rate/.test(cv) && /Uploads are temporarily unavailable/.test(cv)
  && cv.indexOf('rpc/reserve_anonymous_rate') < cv.indexOf('form = await readBoundedFormData')
  && /rpc\/reserve_anonymous_rate/.test(docUpload) && /Document uploads are temporarily unavailable/.test(docUpload)
  && docUpload.indexOf('rpc/reserve_anonymous_rate') < docUpload.indexOf('form = await readBoundedFormData'));

check('invitation endpoint owns only invitation and refresh',
  /invite.*refresh/.test(invitation) && !/action === ['"]disable['"]|action === ['"]enable['"]/.test(invitation));
check('invitation delivery uses generated links and a custom provider',
  /admin\/generate_link/.test(invitation) && /RESEND_API_KEY/.test(invitation) && /action_link/.test(invitation));
check('invitation state changes only after provider confirmation',
  invitation.indexOf('https://api.resend.com/emails') < invitation.indexOf("onboarding: 'invited'")
  || invitation.indexOf('https://api.resend.com/emails') < invitation.indexOf('onboarding: "invited"'));
check('Auth lookup unavailability has a distinct fail-closed path',
  /kind:\s*['"]unavailable['"]/.test(invitation) && /could not confirm (?:whether )?(?:this|the Auth) account/i.test(invitation));
check('invitation failures do not claim that Auth state was untouched',
  !/No staff state was changed/.test(invitation)
  && /profile was not marked invited/.test(invitation));
check('disable and enable use claimed recovery intents',
  /request_recovery_action/.test(staffInviteClient) && /employee-access-revoke/.test(staffInviteClient)
  && /disable_account/.test(lifecycle) && /enable_account/.test(lifecycle));
check('lifecycle executor exposes partial/reconciliation outcomes',
  /reconciliationRequired/.test(lifecycle) && /confirmedStatus/.test(lifecycle) && /steps/.test(lifecycle));
check('profile-only lifecycle changes are explicit and truthful',
  /authAccount/.test(lifecycle) && /not_applicable/.test(lifecycle)
  && /authAccount\?: 'updated' \| 'not_applicable'/.test(staffInviteClient)
  && /no sign-in account existed/.test(app) && /no sign-in account exists yet/.test(app));
check('lifecycle profile status is confirmed from returned representation',
  /Prefer: 'return=representation'/.test(lifecycle)
  && /rows\.length === 1/.test(lifecycle) && /profile update was not confirmed/.test(lifecycle));
check('ended staff cannot be re-enabled',
  /p_action='enable_account' and v_target\.ended_at is not null/.test(migration));

check('document delete treats only 2xx or 404 as object absence',
  /!deletion\.ok && deletion\.status !== 404/.test(docDelete)
  && !/status === 400/.test(docDelete));
check('document finalisation retains an atomic browser-dark tombstone',
  /finalize_staff_document_deletion/.test(docDelete)
  && /staff_document_tombstones/.test(migration)
  && /insert into public\.activity_log[\s\S]*delete from public\.staff_documents/.test(migration));
check('document upload verifies rollback and queues unconfirmed cleanup',
  /rollbackConfirmed = rollback\.ok \|\| rollback\.status === 404/.test(docUpload)
  && /storage_cleanup_jobs/.test(docUpload) && /metadata_failed_orphan_possible/.test(docUpload));
check('training-media audit uses real activity_log columns and checks response',
  /actor_auth_id/.test(training) && /actor_staff_id/.test(training)
  && !/\bactor_id\s*:/.test(training) && /response\.ok|result\.ok/.test(training));

check('email provider is unreachable until durable reservation succeeds',
  email.indexOf('rpc/reserve_email_send') >= 0
  && email.indexOf('rpc/reserve_email_send') < email.indexOf('const { response: send'));
check('email reservation is service-only and bound to verified caller identity',
  /p_actor_auth_id:\s*uid/.test(email)
  && /revoke all on function public\.reserve_email_send\(uuid,text,text,text,text,text,integer,integer\) from public,anon,authenticated/.test(migration)
  && /grant execute on function public\.reserve_email_send\(uuid,text,text,text,text,text,integer,integer\) to service_role/.test(migration));
check('staff-document upload rate key is a 64-hex SHA-256 digest',
  /crypto\.subtle\.digest\(\s*['"]SHA-256['"]/.test(docUpload)
  && /staff-doc-upload:\$\{String\(caller\.id\)\}/.test(docUpload)
  && /Array\.from\(new Uint8Array\(staffRateDigest\)/.test(docUpload)
  && /staffRateKey/.test(docUpload));
check('email delivery uses a stable idempotency key and checked audit finalisation',
  /Idempotency-Key.*milkpop-direct-\$\{logId\}/.test(email)
  && /providerAccepted:\s*true/.test(email) && /reconciliation_required/.test(email));
check('esbuild is a direct locked development dependency', pkg.devDependencies?.esbuild === '0.25.12');

console.log(`\nT13.3.19 RELEASE INTEGRITY — ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
