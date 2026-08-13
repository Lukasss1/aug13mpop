#!/usr/bin/env node
/** Milk Pop T13.3.11 — opening public-form integrity contract. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0, failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) { passed++; console.log(`✔ ${name}`); }
  else { failed++; console.log(`✖ ${name}${detail ? `\n    ${detail}` : ''}`); }
};

const ui = read('src/components/PublicPages.tsx');
const edge = read('supabase/functions/public-form/index.ts');
const migration = read('supabase/migration_t13311_public_form_integrity.sql');
const types = read('src/types.ts');
const client = read('src/lib/supabase.ts');
const manifest = read('launch/migration-manifest.sh');
const sharedIp = read('supabase/functions/_shared/ip.ts');

check('careers UI requires weekly availability', /id="app-availability"[\s\S]{0,180}\brequired\b/.test(ui));
check('franchise UI requires experience', /id="fran-experience"[\s\S]{0,140}\brequired\b/.test(ui));
check('franchise handler requires country and experience', /franchiseForm\.country\.trim\(\)[\s\S]{0,100}!franchiseForm\.experience/.test(ui));
check('public inputs carry server-aligned length bounds',
  /id="app-name"[\s\S]{0,180}maxLength=\{200\}/.test(ui)
  && /id="app-email"[\s\S]{0,180}maxLength=\{320\}/.test(ui)
  && /id="app-availability"[\s\S]{0,180}maxLength=\{500\}/.test(ui)
  && /id="contact-msg"[\s\S]{0,160}maxLength=\{5000\}/.test(ui));
check('public identity fields provide autocomplete hints',
  /id="app-name"[\s\S]{0,160}autoComplete="name"/.test(ui)
  && /id="app-email"[\s\S]{0,160}autoComplete="email"/.test(ui)
  && /id="app-phone"[\s\S]{0,160}autoComplete="tel"/.test(ui));
check('franchise phone is available without becoming mandatory',
  /id="fran-phone"[\s\S]{0,180}autoComplete="tel"/.test(ui)
  && !/id="fran-phone"[\s\S]{0,100}\brequired\b/.test(ui));
check('public phone controls enforce the shared permissive format',
  /id="app-phone"[\s\S]{0,320}minLength=\{7\}[\s\S]{0,180}pattern="\[\+0-9\(\]\[0-9 \(\)-\]\{6,49\}"/.test(ui)
  && /id="fran-phone"[\s\S]{0,320}minLength=\{7\}[\s\S]{0,180}pattern="\[\+0-9\(\]\[0-9 \(\)-\]\{6,49\}"/.test(ui));
check('careers application carries exact vacancy id',
  /vacancyId: appliedVacancy\.id/.test(ui) && /vacancyId\?: string/.test(types));
check('careers success copy makes no contact-time promise',
  !/recruitment team will be in touch|we will contact you/i.test(ui));
check('franchise success copy makes no contact-time promise',
  /Your franchise enquiry has been received\./.test(ui)
  && !/franchise team will contact you/i.test(ui));
check('empty delivery controls are not rendered',
  /const hasDeliveryLink = Boolean\(deliverooHref \|\| uberEatsHref\)/.test(ui)
  && /store\.status === 'open' && hasDeliveryLink/.test(ui));
check('delivery URLs are normalised once per store card',
  /const deliverooHref = safeExternalHref/.test(ui)
  && /href=\{deliverooHref\}/.test(ui)
  && /href=\{uberEatsHref\}/.test(ui));

check('rate-limit IP identifiers use a keyed server-side HMAC',
  /hmacIp\(req, abuseSecret, 'public-form:v1'\)/.test(edge)
  && /importKey\([\s\S]{0,180}'HMAC'/.test(sharedIp)
  && /crypto\.subtle\.sign\('HMAC'/.test(sharedIp)
  && /ABUSE_HMAC_SECRET/.test(edge)
  && !/subtle\.digest\('SHA-256'[\s\S]{0,100}`form:\$\{ip\}`/.test(edge));

check('Edge careers required list includes vacancy id, role and availability',
  /required: \['full_name', 'email', 'phone', 'vacancy_id', 'applied_for', 'availability'\]/.test(edge));
check('Edge franchise required list matches the public form',
  /required: \['full_name', 'email', 'country', 'city', 'budget', 'experience'\]/.test(edge));
check('Edge validates supplied phone numbers without requiring franchise phone',
  /phoneDigits\.length < 7 \|\| phoneDigits\.length > 15/.test(edge)
  && /reject\('invalid_phone'/.test(edge));
check('Edge rejects non-object rows and non-string field values',
  /typeof rawRow !== 'object' \|\| Array\.isArray\(rawRow\)/.test(edge)
  && /typeof rowIn\[col\] !== 'string'/.test(edge)
  && /reject\('invalid_body'/.test(edge));
check('Edge allow-list accepts vacancy_id but no workflow metadata',
  /columns: \['full_name', 'email', 'phone', 'vacancy_id'/.test(edge)
  && !/columns: \[[^\]]*status/.test(edge));
check('Edge checks exact vacancy id and title before CAPTCHA',
  edge.indexOf("id: `eq.${vacancyId}`") > 0
  && edge.indexOf("title: `eq.${appliedFor}`") > 0
  && edge.indexOf('job_vacancies_public?') < edge.indexOf('// --- 4. CAPTCHA'));
check('Edge vacancy lookup fails closed on service errors',
  /vacancy_state_unavailable[\s\S]{0,160}503/.test(edge));
check('inconclusive idempotency lookup defers dynamic vacancy authority to the database',
  /let idempotencyLookupConclusive = !idempotencyKey/.test(edge)
  && /kind === 'careers' && idempotencyLookupConclusive/.test(edge));
check('committed retries resolve before optional programme visibility',
  edge.indexOf('rpc/resolve_public_submission') < edge.indexOf("const flag = kind === 'careers' ? 'show_careers' : 'show_franchise'")
  && /\(kind === 'careers' \|\| kind === 'franchise'\) && idempotencyLookupConclusive/.test(edge));
check('optional programme visibility remains before CAPTCHA for new submissions',
  edge.indexOf("const flag = kind === 'careers' ? 'show_careers' : 'show_franchise'") < edge.indexOf('// --- 4. CAPTCHA'));
check('Edge returns a machine-readable vacancy_not_open code',
  /code: reason/.test(edge) && /reject\('vacancy_not_open'/.test(edge));
check('client distinguishes closed vacancy from idempotency conflict',
  /coarseCode === 'vacancy_not_open'/.test(client)
  && /errorCode: 'vacancy_not_open', retryable: false/.test(client));
check('client maps closed sections, rate limits and verification to actionable coarse states',
  /errorCode: 'section_closed'/.test(client)
  && /errorCode: 'rate_limited'/.test(client)
  && /errorCode: 'verification_failed'/.test(client)
  && /result\.errorCode === 'section_closed'/.test(ui)
  && /result\.errorCode === 'verification_failed'/.test(ui));
check('a server-closed vacancy is removed from the current browser session',
  /serverClosedVacancyIds/.test(ui)
  && /setServerClosedVacancyIds/.test(ui)
  && /setSelectedJob\(null\)/.test(ui));

check('T13.3.11 adds a vacancy reference to applications',
  /add column if not exists vacancy_id text/.test(migration)
  && /job_applications_vacancy_id_fk/.test(migration));
check('database validator skips only already-committed idempotent keys',
  /if p_idempotency_key is not null/.test(migration)
  && /if v_existing then\s+return;/.test(migration));
check('database validates exact published vacancy id/title',
  /where id = v_vacancy_id[\s\S]{0,120}title = v_title[\s\S]{0,120}status = 'published'[\s\S]{0,80}for share/.test(migration));
check('database locks optional programme visibility through commit',
  /show_careers is true for share/.test(migration)
  && /show_franchise is true for share/.test(migration)
  && /raise exception 'section_closed'/.test(migration));
check('database requires careers availability',
  /nullif\(trim\(p_row->>'availability'\), ''\) is null/.test(migration));
check('database validates required careers and optional franchise phone values',
  /regexp_replace\(p_row->>'phone', '\[\^0-9\]', '', 'g'\)/.test(migration)
  && /raise exception 'invalid_phone'/.test(migration));
check('database requires franchise operating facts',
  /p_row->>'country'/.test(migration) && /p_row->>'budget'/.test(migration) && /p_row->>'experience'/.test(migration));
check('seven-argument gate calls the current-state validator before core insert',
  migration.indexOf('perform public.assert_current_public_form_payload')
    < migration.indexOf('v_result := submit_public_form_core'));
check('new careers rows retain the selected vacancy reference',
  /vacancy_id = nullif\(trim\(p_row->>'vacancy_id'\), ''\)/.test(migration));
check('browser roles cannot execute the validator or form gate',
  /revoke all on function public\.assert_current_public_form_payload/.test(migration)
  && /revoke all on function public\.submit_public_form/.test(migration));
check('current payload validator is not a direct service-role API',
  /revoke all on function public\.assert_current_public_form_payload[\s\S]{0,240}from service_role/i.test(migration));
check('guarded submission RPC is explicitly service-role executable',
  /grant execute on function public\.submit_public_form\(text, jsonb, uuid, text, text, text, text\)[\s\S]{0,80}to service_role/i.test(migration));
check('idempotency resolver is explicitly service-role executable',
  /grant execute on function public\.resolve_public_submission\(text, uuid, text\)[\s\S]{0,80}to service_role/i.test(migration));
check('migration acceptance proves the server-only grants',
  /not has_function_privilege\('service_role', 'public\.submit_public_form/.test(migration)
  && /not has_function_privilege\('service_role', 'public\.resolve_public_submission/.test(migration));
check('rate-limit evidence receives bounded 30-day retention',
  /retention_purge_form_submission_log/.test(migration)
  && /interval '30 days'/.test(migration)
  && /formSubmissionLogDeleted/.test(migration));
check('rate-limit retention helper is not an API surface',
  /revoke all on function public\.retention_purge_form_submission_log\(interval\)[\s\S]{0,100}service_role/.test(migration)
  && /has_function_privilege\('service_role', 'public\.retention_purge_form_submission_log/.test(migration));
check('retention sweep records form log cleanup in the shared audit table',
  /'form_submission_log'/.test(migration)
  && /insert into public\.retention_runs\(entity, cutoff, rows_deleted\)/.test(migration));
check('T13.3.11 migration precedes deployment-handoff polish in the forward chain',
  manifest.indexOf('migration_t13311_public_form_integrity.sql') > manifest.indexOf('migration_t13310_public_boundary_cleanup.sql')
  && manifest.indexOf('migration_t13312_deployment_handoff.sql') > manifest.indexOf('migration_t13311_public_form_integrity.sql'));

console.log(`\nPUBLIC FORM INTEGRITY — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
