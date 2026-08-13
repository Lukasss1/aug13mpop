#!/usr/bin/env node
/** T13.3.23 — public deep-link and operator-handoff closure. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0;
const failed = [];
const check = (name, ok) => ok ? (passed++, console.log(`  ✓ ${name}`)) : (failed.push(name), console.log(`  ✗ ${name}`));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'milkpop-router-'));
let router;
try {
  execFileSync('tsc', [
    '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node',
    '--lib', 'ES2022,DOM', '--skipLibCheck', '--outDir', tmp,
    path.join(ROOT, 'src/lib/router.ts'), path.join(ROOT, 'src/lib/launchFeatures.ts'),
  ], { cwd: ROOT, stdio: 'pipe' });
  const require = createRequire(import.meta.url);
  router = require(path.join(tmp, 'router.js'));
} finally {
  // Keep the compiled module loaded, then remove the throwaway files.
  fs.rmSync(tmp, { recursive: true, force: true });
}

const storeA = { id: '11111111-1111-4111-8111-111111111111', name: 'Milk Pop City Centre' };
const storeB = { id: '22222222-2222-4222-8222-222222222222', name: 'Milk Pop City Centre' };
const longJob = { id: '33333333-3333-4333-8333-333333333333', title: 'Senior Customer Experience and Operations Team Member '.repeat(8) };
const draftPost = { id: '44444444-4444-4444-8444-444444444444', title: 'Opening Celebration '.repeat(8) };

const storeSlugA = router.storeSlug(storeA);
const storeSlugB = router.storeSlug(storeB);
const jobSlug = router.vacancySlug(longJob);
const draftSlug = router.postSlug(draftPost);

check('duplicate store names receive distinct stable slugs', storeSlugA !== storeSlugB);
check('store slug stays within the route cap and preserves its full id', storeSlugA.length <= 80 && storeSlugA.endsWith(storeA.id));
check('long vacancy slug stays within the route cap and preserves its full id', jobSlug.length <= 80 && jobSlug.endsWith(longJob.id));
check('draft news slug stays within the route cap and preserves its full id', draftSlug.length <= 80 && draftSlug.endsWith(draftPost.id));
check('store route round-trips through parser and matcher',
  router.pathToRoute(router.routeToPath('stores', { store: storeSlugA })).params.store === storeSlugA
  && router.matchBySlug([storeA, storeB], storeSlugA, router.storeSlug, (x) => x.id)?.id === storeA.id);
check('long vacancy route round-trips through parser and matcher',
  router.pathToRoute(router.routeToPath('careers', { job: jobSlug })).params.job === jobSlug
  && router.matchBySlug([longJob], jobSlug, router.vacancySlug, (x) => x.id)?.id === longJob.id);
check('public app does not hydrate or subscribe to deferred order state',
  !/orderOutbox|INITIAL_ORDERS|bundle\.orders|handleOrderConfirmed|handleUpdateOrderStatus/.test(read('src/App.tsx'))
  && !/\['orders', \(\) => ordersRepo\.list/.test(read('src/lib/registries.ts')));
const releaseRunbook = read('docs/RELEASE-RUNBOOK.md');
const publicFunctionSection = releaseRunbook.split('## 2. Edge Functions')[1]?.split('## 3. Schedulers')[0] || '';
check('current runbook deploys only the 14-function public set',
  /14 public website\/staff functions/.test(publicFunctionSection)
  && /bash launch\/deploy-public-functions\.sh/.test(publicFunctionSection)
  && ['pos-pair', 'pos-ingest', 'pos-catalog'].every((fn) => publicFunctionSection.includes(fn))
  && /Do not deploy/.test(publicFunctionSection)
  && !/supabase functions deploy/.test(publicFunctionSection));
check('staging checklist has no 17-versus-14 contradiction', !/All 17 Edge Functions deployed/.test(read('docs/STAGING-COMMISSIONING.md')) && /All 14 public website\/staff Edge Functions deployed/.test(read('docs/STAGING-COMMISSIONING.md')));
check('root README requires 14 deployed functions for public GO', /exact live migration and all \*\*14\*\* public website\/staff Edge Functions/.test(read('README.md')));
check('restore runbook treats POS reconciliation as later-stage only', /If POS is commissioned later/.test(read('docs/OPERATIONS-RUNBOOK.md')));

console.log(`\nT13.3.23 PUBLIC ROUTE CLOSURE — ${passed}/${passed + failed.length} passed`);
if (failed.length) process.exit(1);
