#!/usr/bin/env node
/** T13.3.15 — bounded runtime-resilience and recovery-UX source contract. */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
const check = (label, condition) => {
  if (condition) { passed += 1; console.log(`PASS — ${label}`); }
  else { failed += 1; console.log(`FAIL — ${label}`); }
};

const timeout = read('src/lib/requestTimeout.ts');
const app = read('src/App.tsx');
const boundary = read('src/components/AppErrorBoundary.tsx');
const image = read('src/components/ImageUploadInline.tsx');
const media = read('src/lib/mediaUpload.ts');
const authClient = read('src/lib/authClient.ts');
const pkg = JSON.parse(read('package.json'));
const env = read('.env.example');
const manifest = read('launch/migration-manifest.sh');

check('bounded fetch helper has conservative operation classes',
  /auth:\s*15_000/.test(timeout) && /read:\s*20_000/.test(timeout)
  && /action:\s*30_000/.test(timeout) && /pos:\s*30_000/.test(timeout)
  && /upload:\s*90_000/.test(timeout));
check('bounded fetch composes caller cancellation with its own deadline',
  /const parentSignal = init\.signal/.test(timeout)
  && /addEventListener\('abort', forwardParentAbort/.test(timeout)
  && /removeEventListener\('abort', forwardParentAbort/.test(timeout));
check('only an internally triggered deadline becomes RequestTimeoutError',
  /let timedOut = false/.test(timeout) && /if \(timedOut\) throw new RequestTimeoutError/.test(timeout));
check('the same deadline remains active while the response body is consumed',
  /fetch\(\).*resolves when headers arrive/.test(timeout)
  && /bodyReaders = new Set/.test(timeout)
  && /return new Proxy\(response/.test(timeout)
  && /finally\s*\{[\s\S]{0,80}cleanup\(\)/.test(timeout));
check('named timed fetchers avoid scattered timeout literals',
  /export const timedFetch/.test(timeout) && /auth: \(input/.test(timeout)
  && /upload: \(input/.test(timeout));

const boundedModules = [
  'src/lib/registries.ts', 'src/lib/launchSettings.ts', 'src/lib/staffInvite.ts',
  'src/lib/seoRebuild.ts', 'src/lib/staffDocs.ts', 'src/lib/mediaUpload.ts',
  'src/lib/passwordRecovery.ts', 'src/lib/activityLog.ts', 'src/lib/posData.ts',
  'src/lib/tillPayments.ts', 'src/lib/auth.ts', 'src/lib/authClient.ts',
  'src/lib/publicDataValidation.ts', 'src/components/admin/SeoSyncPanel.tsx',
];
check('critical runtime modules use the bounded transport',
  boundedModules.every((file) => /requestTimeout/.test(read(file))));
check('public forms, uploads and direct Supabase actions are bounded',
  /timedFetch\.action\(`\$\{base\}\/functions\/v1\/public-form/.test(read('src/lib/supabase.ts'))
  && /timedFetch\.upload\(`\$\{base\}\/functions\/v1\/cv-upload/.test(read('src/lib/supabase.ts'))
  && /timedFetch\.upload\(`\$\{base\}\/functions\/v1\/training-media/.test(read('src/lib/supabase.ts')));
check('remaining raw transports own deadlines through the work they await',
  /timeoutMs:\s*12000/.test(read('src/lib/authRefresh.ts'))
  && /data = await res\.json\(\)[\s\S]{0,300}finally \{[\s\S]{0,80}cancel\(\)/.test(read('src/lib/authRefresh.ts'))
  && /createTimeoutSignal\(4000\)/.test(read('src/lib/authRaw.ts'))
  && /const text = await res\.text\(\)[\s\S]{0,420}finally\s*\{[\s\S]{0,80}clearTimeout\(timer\)/.test(read('src/lib/supabase.ts')));
check('media transport failures become typed retryable results',
  /catch \{[\s\S]{0,220}errorCode: 'network'[\s\S]{0,180}Check the connection/.test(media));
check('ambiguous write failures tell operators to reload before retrying',
  /server did not confirm the change[\s\S]{0,100}Reload/.test(read('src/lib/registries.ts'))
  && /did not confirm the staff change/.test(read('src/lib/staffInvite.ts'))
  && /did not confirm whether the SEO refresh handoff was recorded/.test(read('src/lib/seoRebuild.ts'))
  && /did not confirm the upload/.test(read('src/lib/staffDocs.ts')));
check('inline image control is a real keyboard-operable button',
  /<button[\s\S]{0,120}type="button"[\s\S]{0,220}aria-label=/.test(image)
  && /focus-visible:opacity-100/.test(image) && /disabled=\{!MEDIA_V2 \|\| busy\}/.test(image));
check('unexpected image processing failures are surfaced and busy state clears',
  /catch \{[\s\S]{0,220}could not be processed/.test(image)
  && /finally \{[\s\S]{0,160}setBusy\(false\)/.test(image));
check('crash recovery copy does not promise unsaved data survived',
  /Any unsaved information on this page may need to be entered again/.test(boundary)
  && !/nothing you entered on other pages is affected/.test(boundary));
check('admin access guidance reflects actual auth configuration',
  /\{authConfigured[\s\S]{0,260}Sign in through the Staff Portal/.test(app)
  && /not connected to its authentication service/.test(app));
check('toast stack is mobile-safe, bounded and duplicate-resistant',
  /bottom-4 left-4 right-4/.test(app) && /sm:max-w-sm sm:w-full/.test(app)
  && /filter\(\(toast\) => toast\.message !== message \|\| toast\.type !== type\)\.slice\(-3\)/.test(app));
check('authenticated request documentation no longer claims unused universal routing',
  /lineage-safe authenticated/.test(authClient) && !/the ONE shared authenticated request/.test(authClient));
check('runtime timeout behaviour has an executable unit test',
  existsSync(path.join(ROOT, 'scripts/request-timeout.test.ts'))
  && pkg.scripts?.['test:request-timeout'] === 'tsx scripts/request-timeout.test.ts');
check('runtime resilience is part of complete verification',
  /npm run test:runtime-resilience/.test(pkg.scripts?.verify || '')
  && pkg.scripts?.['test:runtime-resilience'] === 'node scripts/runtime-resilience.test.mjs');
check('current release retains T13.3.15 runtime resilience',
  /^VITE_RELEASE_IDENTITY=r4\.10\.15-t13\.3\.30-final-production-closure$/m.test(env));
check('current append-only ledger retains the source-only T13.3.15 layer',
  /migration_t13313_staff_portal_integrity\.sql"[\s\S]*migration_t13319_release_integrity\.sql"\s+"supabase\/migration_t13320_final_audit\.sql"\s+"supabase\/migration_t13322_public_store_scope\.sql"\s*\)/s.test(manifest)
  && !/migration_t13315/.test(manifest));
check('current T13.3.30 commissioning authority exists',
  existsSync(path.join(ROOT, 'PRODUCTION-COMMISSIONING-T13.3.30.md')));

console.log(`\nRUNTIME RESILIENCE RETAINED THROUGH T13.3.17 — ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
