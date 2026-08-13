#!/usr/bin/env node
/** T13.3.17 — browser recovery, secure-link reliability and form accessibility. */
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

const app = read('src/App.tsx');
const admin = read('src/components/AdminPanel.tsx');
const recovery = read('src/components/PasswordRecoveryCard.tsx');
const docs = read('src/components/staff/StaffDocumentsPanel.tsx');
const till = read('src/components/admin/TillOrders.tsx');
const inbox = read('src/components/admin/ContactInboxPanel.tsx');
const env = read('.env.example');
const manifest = read('launch/migration-manifest.sh');
const pkg = JSON.parse(read('package.json'));

console.log('\n— public reconnect recovery —');
check('public pulls are coalesced behind one active promise',
  /let activePull: Promise<void> \| null = null/.test(app)
  && /if \(activePull\) return activePull/.test(app)
  && /activePull = pullAllFromCloud\(\)/.test(app));
check('the active pull is always released',
  /\.finally\(\(\) => \{\s*activePull = null;\s*\}\)/.test(app));
check('browser online recovery forces a visible refresh',
  /const onOnline = \(\) => refreshVisibleTab\(true\)/.test(app));
check('online listener is registered and removed',
  /addEventListener\('online', onOnline\)/.test(app)
  && /removeEventListener\('online', onOnline\)/.test(app));
check('focus refresh remains throttled while online recovery may bypass the throttle',
  /if \(!force && Date\.now\(\) - lastPull < 30000\) return/.test(app));
check('authenticated reconnect also requests private rehydration',
  /authedEmployeeIdRef\.current !== null\) setHydrateNonce/.test(app));

console.log('\n— secure document and CV opening —');
check('owner document tab is reserved before the first await',
  /const preview = window\.open\('', '_blank'\)[\s\S]{0,300}try \{[\s\S]{0,100}await freshStaffToken/.test(admin));
check('owner document preview severs opener access',
  /preview\.opener = null[\s\S]{0,120}Opening secure document/.test(admin));
check('owner document failures close the reserved preview',
  /!token\) \{ preview\?\.close\(\)/.test(admin)
  && /result\.ok === false\) \{ preview\?\.close\(\)/.test(admin));
check('owner document navigation falls back to the current tab',
  /if \(preview\) preview\.location\.replace\(safeDocUrl\);\s*else window\.location\.assign\(safeDocUrl\)/.test(admin));
check('CV tab is reserved before the first await',
  /Opening secure CV[\s\S]{0,220}try \{[\s\S]{0,100}await getAccessToken/.test(admin));
check('CV failures close the reserved preview',
  /preview\?\.close\(\);[\s\S]{0,100}session has expired/.test(admin)
  && /preview\?\.close\(\);[\s\S]{0,140}CV could not be opened/.test(admin));
check('CV navigation falls back to the current tab',
  /if \(preview\) preview\.location\.replace\(safeCvUrl\);\s*else window\.location\.assign\(safeCvUrl\)/.test(admin));
check('staff document opening retains the same synchronous reservation pattern',
  /const preview = window\.open\('', '_blank'\)[\s\S]{0,260}await getAccessToken/.test(docs));

console.log('\n— operator feedback and accessible recovery forms —');
check('legacy sale JSON uses the guarded clipboard helper',
  /void copyText\(JSON\.stringify\(e\.row, null, 2\), addToast\)/.test(till)
  && !/Sale facts copied/.test(till));
check('mail application launch avoids a pop-up dependency',
  /window\.location\.assign\(href\)/.test(inbox)
  && !/window\.open\(href/.test(inbox));
check('password reset request is a native form submission',
  /<form onSubmit=\{\(event\) => \{ event\.preventDefault\(\); void doRequest\(\); \}\}/.test(recovery)
  && /type="email"[\s\S]{0,100}required/.test(recovery));
check('password completion is a native form with matching browser constraints',
  /void doComplete\(\)/.test(recovery)
  && (recovery.match(/minLength=\{10\}/g) || []).length === 2
  && (recovery.match(/autoComplete="new-password"/g) || []).length === 2);
check('password actions refuse same-render duplicate submissions',
  (recovery.match(/if \(busy\) return;/g) || []).length === 2);
check('password return timer is cleared on unmount',
  /useEffect\(\(\) => \(\) => \{[\s\S]{0,120}clearTimeout\(returnTimerRef\.current\)/.test(recovery));
check('password success and error messages use appropriate live roles',
  /role=\{note\.tone === 'ok' \? 'status' : 'alert'\}/.test(recovery));
check('staff document fields have programmatic labels and native required validation',
  /htmlFor="staff-doc-name"/.test(docs)
  && /id="staff-doc-name"[\s\S]{0,100}required/.test(docs)
  && /htmlFor="staff-doc-category"/.test(docs)
  && /id="staff-doc-category"/.test(docs));

console.log('\n— release continuity —');
check('application version is current', pkg.version === '4.10.15');
check('current release retains T13.3.17 operator recovery',
  /^VITE_RELEASE_IDENTITY=r4\.10\.15-t13\.3\.30-final-production-closure$/m.test(env));
check('database chain retains operator recovery in the current append-only ledger',
  /migration_t13313_staff_portal_integrity\.sql"[\s\S]*migration_t13319_release_integrity\.sql"\s+"supabase\/migration_t13320_final_audit\.sql"\s+"supabase\/migration_t13322_public_store_scope\.sql"\s*\)/s.test(manifest)
  && !/migration_t1331[4567]/.test(manifest));
check('current T13.3.30 commissioning authority exists',
  existsSync(path.join(ROOT, 'PRODUCTION-COMMISSIONING-T13.3.30.md')));
check('operator recovery is included in complete verification',
  /npm run test:operator-recovery/.test(pkg.scripts?.verify || '')
  && pkg.scripts?.['test:operator-recovery'] === 'node scripts/t13317-operator-recovery.test.mjs');

console.log(`\nT13.3.17 OPERATOR RECOVERY — ${passed}/${passed + failed} passed`);
if (passed + failed !== 27) {
  console.error(`Contract definition error: expected 27 checks, found ${passed + failed}.`);
  process.exit(1);
}
process.exit(failed ? 1 : 0);
