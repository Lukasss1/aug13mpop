#!/usr/bin/env node
/** T13.3.16 — provider resilience, production continuity and modal accessibility. */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
const check = (label, condition) => {
  if (condition) { passed += 1; console.log(`PASS — ${label}`); }
  else { failed += 1; console.log(`FAIL — ${label}`); }
};

const provider = read('supabase/functions/_shared/providerFetch.ts');
const publicForm = read('supabase/functions/public-form/index.ts');
const cvUpload = read('supabase/functions/cv-upload/index.ts');
const sendEmail = read('supabase/functions/send-email/index.ts');
const outbox = read('supabase/functions/outbox-dispatch/index.ts');
const notify = read('src/lib/notify.ts');
const admin = read('src/components/AdminPanel.tsx');
const env = read('.env.example');
const inventory = read('PRODUCTION-ENV-AND-FUNCTION-INVENTORY.md');
const manifest = read('launch/migration-manifest.sh');
const config = read('supabase/config.toml');
const pkg = JSON.parse(read('package.json'));

console.log('\n— external-provider resilience —');
check('provider deadlines are conservative and operation-specific', /turnstile:\s*8_000/.test(provider) && /email:\s*15_000/.test(provider));
check('provider transport owns an AbortController deadline', /const controller = new AbortController\(\)/.test(provider) && /setTimeout\(\(\) =>/.test(provider));
check('provider transport composes caller cancellation', /const parentSignal = init\.signal/.test(provider) && /addEventListener\('abort', forwardParentAbort/.test(provider));
check('provider deadline stays active through body consumption', /const response = await fetch/.test(provider) && /const text = await response\.text\(\)/.test(provider) && /finally[\s\S]{0,180}clearTimeout\(timer\)/.test(provider));
check('only the internal deadline becomes ProviderTimeoutError', /let timedOut = false/.test(provider) && /if \(timedOut\) throw new ProviderTimeoutError/.test(provider));
check('provider JSON parsing is bounded and non-throwing', /JSON\.parse\(text\)/.test(provider) && /catch \{ data = null; \}/.test(provider));
check('public form imports the bounded provider transport', /providerFetch\.ts/.test(publicForm));
check('public form bounds Turnstile verification', /fetchProviderJson<\{ success\?: boolean \}>/.test(publicForm) && /EXTERNAL_PROVIDER_TIMEOUT_MS\.turnstile/.test(publicForm));
check('public form treats Turnstile HTTP failure as unavailable', /if \(!vr\.ok\) return reject\('captcha_error'/.test(publicForm));
check('public form has a distinct timeout refusal', /instanceof ProviderTimeoutError/.test(publicForm) && /'captcha_timeout'/.test(publicForm) && /503/.test(publicForm));
check('CV upload imports the bounded provider transport', /providerFetch\.ts/.test(cvUpload));
check('CV upload bounds Turnstile verification', /fetchProviderJson<\{ success\?: boolean \}>/.test(cvUpload) && /EXTERNAL_PROVIDER_TIMEOUT_MS\.turnstile/.test(cvUpload));
check('CV upload treats Turnstile HTTP failure as unavailable', /if \(!vr\.ok\) return reject\('captcha_error'/.test(cvUpload));
check('CV upload has a distinct timeout refusal', /instanceof ProviderTimeoutError/.test(cvUpload) && /'captcha_timeout'/.test(cvUpload) && /503/.test(cvUpload));
check('direct e-mail send imports the bounded provider transport', /providerFetch\.ts/.test(sendEmail));
check('direct e-mail provider call is end-to-end bounded', /fetchProviderJson<\{ id\?: unknown \}>/.test(sendEmail) && /EXTERNAL_PROVIDER_TIMEOUT_MS\.email/.test(sendEmail));
check('direct e-mail no longer calls Resend with raw fetch', !/fetch\(RESEND_ENDPOINT/.test(sendEmail));
check('direct send timeout is recorded as unconfirmed', /delivery_unconfirmed_timeout/.test(sendEmail));
check('direct send transport failure is recorded as unconfirmed', /delivery_unconfirmed_network/.test(sendEmail));
check('direct send response warns against blind retry', /Check the e-mail log before retrying/.test(sendEmail) && /code: 'delivery_unconfirmed'/.test(sendEmail));
check('scheduled outbox imports the bounded provider transport', /providerFetch\.ts/.test(outbox));
check('scheduled e-mail provider call is end-to-end bounded', /fetchProviderJson<\{ id\?: unknown \}>/.test(outbox) && /EXTERNAL_PROVIDER_TIMEOUT_MS\.email/.test(outbox));
check('scheduled retries use one stable provider idempotency key', /'Idempotency-Key': `milkpop-outbox-\$\{job\.id\}`/.test(outbox));
check('outbox timeout remains retryable rather than falsely delivered',
  /instanceof ProviderTimeoutError \? 'provider_timeout' : 'provider_transport'/.test(outbox) &&
  /mark\('transient',[\s\S]{0,180}results\[job\.id\] = resultAfterMark\(recorded, 'retry'\)/.test(outbox) &&
  /resultAfterMark[\s\S]{0,100}'reconciliation_required'/.test(outbox));
check('scheduled e-mail no longer calls Resend with raw fetch', !/fetch\(RESEND_ENDPOINT/.test(outbox));
check('client copy preserves the unconfirmed-delivery warning', /delivery was not confirmed/.test(notify) && /Check the e-mail log before retrying/.test(notify));

console.log('\n— production-environment continuity —');
const deployableFunctions = readdirSync(path.join(ROOT, 'supabase/functions'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== '_shared' && existsSync(path.join(ROOT, 'supabase/functions', entry.name, 'index.ts')))
  .map((entry) => entry.name);
check('deployable Edge Function count remains 17', deployableFunctions.length === 17);
check('source-controlled Verify-JWT inventory still covers all functions', deployableFunctions.every((name) => new RegExp(`\\[functions\\.${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\]`).test(config)));
check('Turnstile and Resend remain protected server secrets', /TURNSTILE_SECRET/.test(inventory) && /RESEND_API_KEY/.test(inventory) && /EMAIL_FROM/.test(inventory));
check('provider timeouts require no new production secret', !/PROVIDER_TIMEOUT/.test(inventory));
check('automatic media cleanup remains off at launch', /MEDIA_CLEANUP_ENABLED[^\n]*remain absent at launch/i.test(inventory) && /MEDIA_CLEANUP_ENABLED/.test(read('.env.example')) && /LEAVE UNSET/.test(read('.env.example')));
check('database chain retains the provider-resilience layer in the current append-only ledger', /migration_t13313_staff_portal_integrity\.sql"[\s\S]*migration_t13319_release_integrity\.sql"\s+"supabase\/migration_t13320_final_audit\.sql"\s+"supabase\/migration_t13322_public_store_scope\.sql"\s*\)/s.test(manifest) && !/migration_t13316/.test(manifest));
check('application version advances to 4.10.15', pkg.version === '4.10.15');
check('current release retains T13.3.16 provider resilience', /^VITE_RELEASE_IDENTITY=r4\.10\.15-t13\.3\.30-final-production-closure$/m.test(env));
check('current T13.3.30 commissioning authority exists', existsSync(path.join(ROOT, 'PRODUCTION-COMMISSIONING-T13.3.30.md')));

console.log('\n— admin modal accessibility —');
check('three bounded legacy dialogs have dedicated focus refs', /entityDialogRef/.test(admin) && /setupDialogRef/.test(admin) && /classificationDialogRef/.test(admin));
check('entity editor is a labelled modal dialog', /ref=\{entityDialogRef\}[\s\S]{0,160}role="dialog"[\s\S]{0,120}aria-labelledby="entity-editor-title"/.test(admin));
check('entity editor heading owns the accessible name', /id="entity-editor-title"/.test(admin));
check('store setup is a labelled and described modal dialog', /ref=\{setupDialogRef\}[\s\S]{0,220}aria-labelledby="store-setup-title"[\s\S]{0,100}aria-describedby="store-setup-description"/.test(admin));
check('store setup close control is labelled and busy-safe', /aria-label="Close store setup"/.test(admin) && /disabled=\{wizardBusy\}/.test(admin));
check('VAT classification is a labelled and described modal dialog', /ref=\{classificationDialogRef\}[\s\S]{0,240}aria-labelledby="vat-classification-title"[\s\S]{0,100}aria-describedby="vat-classification-description"/.test(admin));
check('VAT classification close control is labelled and busy-safe', /aria-label="Close VAT classification"/.test(admin) && /disabled=\{classifyBusy\}/.test(admin));
check('active modal receives a deterministic programmatic focus target', /const activeDialog = isFormOpen[\s\S]{0,260}window\.setTimeout\(\(\) => activeDialog\.focus\(\), 0\)/.test(admin));
check('Escape closes dialogs without bypassing synchronous write locks', /event\.key !== 'Escape'/.test(admin) && /busyRef\.current !== 'form-save'/.test(admin) && /!wizardBusyRef\.current/.test(admin) && /!classifyBusyRef\.current/.test(admin));

check('T13.3.16 contract is included in complete verification', /npm run test:provider-resilience/.test(pkg.scripts?.verify || '') && pkg.scripts?.['test:provider-resilience'] === 'node scripts/t13316-provider-resilience.test.mjs');

console.log(`\nT13.3.16 PROVIDER RESILIENCE RETAINED — ${passed}/${passed + failed} passed`);
if (passed + failed !== 45) {
  console.error(`Contract definition error: expected 45 checks, found ${passed + failed}.`);
  process.exit(1);
}
process.exit(failed ? 1 : 0);
