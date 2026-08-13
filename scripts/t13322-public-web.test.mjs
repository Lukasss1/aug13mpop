#!/usr/bin/env node
/** T13.3.23 — public website scope and deferred-POS contracts. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PUBLIC_FUNCTIONS } from './lib/edge-function-inventory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const manifest = JSON.parse(read('release-manifest.json'));
const env = read('.env.example');
const ledger = read('launch/migration-manifest.sh');
const migration = read('supabase/migration_t13322_public_store_scope.sql');
const projection = read('src/lib/publicProjection.ts');
const snapshot = read('src/lib/publicContentSnapshot.ts');
const dashboard = read('src/components/admin/adminDashboard.ts');
const navbar = read('src/components/Navbar.tsx');
const portal = read('src/components/StaffPortal.tsx');
const router = read('src/lib/router.ts');
const features = read('src/lib/launchFeatures.ts');
const operational = read('scripts/t133-operational.test.mjs');
const launch = read('scripts/public-launch.mjs');
const publicDoc = read('PUBLIC-LAUNCH.md');
const readme = read('README.md');
const ownerGuide = read('OWNERS-GUIDE.md');
const currentEvidence = read('CURRENT-RELEASE-EVIDENCE.md');
const checklist = read('docs/COMMISSIONING-CHECKLIST.md');
const environmentInventory = read('PRODUCTION-ENV-AND-FUNCTION-INVENTORY.md');
const admin = read('src/components/AdminPanel.tsx');
const publicDeploy = read('launch/deploy-public-functions.sh');
const posDeploy = read('launch/deploy-pos-functions.sh');
const releaseWorkflow = read('.github/workflows/release.yml');
const backendWorkflow = read('.github/workflows/commission-production-backend.yml');
const identity = 'r4.10.15-t13.3.30-final-production-closure';
let passed = 0;
const failed = [];
const check = (name, ok, detail = '') => ok ? (passed++, console.log(`  ✓ ${name}`)) : (failed.push(name), console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`));

check('package version advances', pkg.version === '4.10.15');
check('browser identity advances', new RegExp(`^VITE_RELEASE_IDENTITY=${identity}$`, 'm').test(env));
check('manifest identity advances', manifest.release_identity === identity && manifest.release_version === pkg.version);
check('append-only store-scope migration is ordered last', /migration_t13320_final_audit\.sql"\s+"supabase\/migration_t13322_public_store_scope\.sql"/.test(ledger));
const upgradeCount = execFileSync('bash', ['launch/migration-manifest.sh', 'upgrade'], { cwd: ROOT, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).length;
const freshCount = execFileSync('bash', ['launch/migration-manifest.sh', 'fresh'], { cwd: ROOT, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).length;
check('ledger counts are 107/109', upgradeCount === 107 && freshCount === 109, `${upgradeCount}/${freshCount}`);
check('store view no longer uses setup_status as publication gate', /create or replace view public\.stores_public/.test(migration) && !/where setup_status\s*=/.test(migration));
check('store view requires genuine identity and keeps setup private', /btrim\(name\)/.test(migration) && /btrim\(address\)/.test(migration) && /btrim\(postcode\)/.test(migration) && /position\('setup_status'/.test(migration));
check('browser public projection uses shared store identity', /return stores\.filter\(hasRealStoreIdentity\)/.test(projection));
check('SEO snapshot uses the same store identity rule', /publishableStores[\s\S]{0,120}stores\.filter\(hasRealStoreIdentity\)/.test(snapshot));
check('opening dashboard no longer waits for POS setup', /return hasRealStoreIdentity\(effectiveStore\)/.test(dashboard) && !/effectiveStore\.setupStatus === 'ACTIVE'/.test(dashboard));
check('staff POS navigation is absent', !/staff_pos|Till \/ POS/.test(navbar));
check('staff portal does not import or render SalesPOS', !/SalesPOS|staff_pos/.test(portal));
check('staff router exposes no POS section', !/['"]pos['"]/.test(router.slice(router.indexOf('export const STAFF_SECTIONS'), router.indexOf('export const ADMIN_SECTIONS'))));
check('admin POS sections are post-launch', /sales:\s*\{[^}]*status: 'post_launch'/.test(features) && /till:\s*\{[^}]*status: 'post_launch'/.test(features));
check('operational migration assertion follows current manifest', /migrationCount >= 105 && migrationCount === releaseManifest\.migration_count/.test(operational));
check('public seal wrapper retains the public-web closure chain', /t13322-public-web\.test\.mjs/.test(launch) && /t13323-public-route-closure\.test\.mjs/.test(launch) && /t13324-public-deployment-handoff\.test\.mjs/.test(launch) && /t13325-local-preflight-trust-split\.test\.mjs/.test(launch) && /t13326-local-preflight-config\.test\.mjs/.test(launch));

check('public deployment consumes the code-owned 14 website/staff function inventory',
  PUBLIC_FUNCTIONS.length === 14
  && /PUBLIC_FUNCTIONS/.test(publicDeploy)
  && !/^deploy\s+[a-z0-9-]+\s+(?:on|off)(?:\s|$)/m.test(publicDeploy)
  && !/functions\s+deploy\s+pos-(?:pair|ingest|catalog)/.test(publicDeploy));
check('POS activation is a separate explicit later-stage script',
  ['pos-pair', 'pos-ingest', 'pos-catalog'].every((fn) => posDeploy.includes(fn))
  && /Do not run this as part of the public-website launch/.test(posDeploy));
check('both production workflows use the public function deployment list',
  /bash launch\/deploy-public-functions\.sh/.test(releaseWorkflow)
  && /bash launch\/deploy-public-functions\.sh/.test(backendWorkflow)
  && !/supabase functions deploy --project-ref/.test(releaseWorkflow)
  && !/supabase functions deploy --project-ref/.test(backendWorkflow));
check('store controls use truthful public statuses and no Set Online wording',
  /Coming Soon/.test(admin) && />Closed</.test(admin) && />Open</.test(admin) && !/Set Online/.test(admin));
check('company settings contain no visible Till-default description',
  /website display defaults, e-mail delivery/.test(admin) && !/Legal identity, public contact facts, Till defaults/.test(admin));

check('current commissioning authority exists', fs.existsSync(path.join(ROOT, 'PRODUCTION-COMMISSIONING-T13.3.30.md')));
check('public launch explicitly defers POS', /POS\/Web Till remains preserved for later integration but is hidden and undeployed/.test(publicDoc));
check('historical T13.3.21 authority remains preserved', fs.existsSync(path.join(ROOT, 'docs/archive/commissioning/PRODUCTION-COMMISSIONING-T13.3.21.md')));
check('current README carries the exact version and does not advertise a launch Till', /Application version `4\.10\.15`/.test(readme) && /17 Edge Functions in source \/ 14 deployed for the public website/.test(readme) && !/online Web Till/.test(readme));
check('owner guide describes the public-web scope without routed order or Till screens', /POS\/Web Till source is preserved for later integration/.test(ownerGuide) && !/\*\*Orders\*\*/.test(ownerGuide) && !/read-only Native Till Ledger/.test(ownerGuide));
check('current evidence records the canonical 107/109 ledger', /Upgrade migration chain: \*\*107 ordered/.test(currentEvidence) && /Fresh-install SQL ledger: \*\*109 entries/.test(currentEvidence));
check('current checklist and environment inventory are T13.3.30', /^# Milk Pop T13\.3\.30/m.test(checklist) && /107-migration/.test(checklist) && /14 public website\/staff Edge Functions|14 website\/staff functions/.test(checklist) && /three POS functions remain undeployed|three POS functions remain deferred|three POS functions remain absent/i.test(checklist) && /^# .*T13\.3\.30/m.test(environmentInventory));

console.log(`\nPUBLIC WEB RETENTION — ${passed}/${passed + failed.length} passed`);
if (failed.length) process.exit(1);
