/**
 * launch-scope.test.ts — C1.3 audit findings #1/#2/#3/#4/#5/#7.
 *
 * Proves that the ONE launch-feature registry (src/lib/launchFeatures.ts) is the
 * single source of truth for BOTH the admin route allow-list (router.ts) and the
 * AdminPanel sidebar, so a section can never again be shown in the sidebar while
 * its route falls back to /admin/ (or the reverse). Also pins the specific UI
 * fixes: the deferred Staff Reviews section is unreachable + hidden, Legacy
 * Import is a gated migration utility, the media upload control is flag-gated,
 * and the deferred POS channels remain preserved but absent from launch routing.
 *
 * Static + logic checks only — no browser, no build.
 * Run: npm run test:launch-scope
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_FEATURES,
  ADMIN_ROUTE_IDS,
  isAdminSectionVisible,
  isDeferredSection,
} from '../src/lib/launchFeatures';
import { ADMIN_SECTIONS } from '../src/lib/router';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

let passed = 0, failed = 0;
const check = (name: string, cond: boolean) => {
  if (cond) { passed++; console.log(`\u2714 ${name}`); }
  else { failed++; console.error(`\u2716 ${name}`); }
};

const featureIds = Object.keys(ADMIN_FEATURES);
const admin = readFileSync(path.join(REPO, 'src/components/AdminPanel.tsx'), 'utf8');
const till = readFileSync(path.join(REPO, 'src/components/admin/TillOrders.tsx'), 'utf8');
const salesPanel = readFileSync(path.join(REPO, 'src/components/admin/SalesPanel.tsx'), 'utf8');
const mediaPanel = readFileSync(path.join(REPO, 'src/components/admin/MediaLibraryPanel.tsx'), 'utf8');
const adminNavigation = readFileSync(path.join(REPO, 'src/components/admin/adminNavigation.ts'), 'utf8');
const owner = { isOwner: true, mediaV2: true, legacyEnabled: true, legacyDetected: true };

/* 1. The router allow-list IS the registry-derived route list (no drift). */
check('router ADMIN_SECTIONS === registry ADMIN_ROUTE_IDS',
  JSON.stringify([...ADMIN_SECTIONS]) === JSON.stringify([...ADMIN_ROUTE_IDS]));

/* 2. Routability follows status: deferred → no route; launch utilities remain routable. */
check('no deferred (post_launch) feature is routable',
  ADMIN_ROUTE_IDS.every((id) => !isDeferredSection(id)));
check("deferred 'till' and 'sales' sections are not routable at public launch",
  !ADMIN_ROUTE_IDS.includes('till') && !ADMIN_ROUTE_IDS.includes('sales'));
check("'legacy-import' is routable (was missing before C1.3)",
  ADMIN_ROUTE_IDS.includes('legacy-import'));
check("'performance' (Staff Reviews) is NOT routable (finding #2)",
  !ADMIN_ROUTE_IDS.includes('performance'));

/* 3. The sidebar ids and the registry correspond EXACTLY, in both directions. */
const navOrderBody = adminNavigation.match(/ADMIN_NAV_ORDER = \[([\s\S]*?)\] as const/)?.[1] || '';
const sidebarIds = [...navOrderBody.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
const sidebarSet = new Set(sidebarIds);
check('every projected Admin sidebar id is declared in the launch registry',
  [...sidebarSet].every((id) => featureIds.includes(id)));
check('every non-deferred launch-registry feature appears in the Admin navigation projection',
  featureIds.filter((id) => !isDeferredSection(id)).every((id) => sidebarSet.has(id)));
check('deferred features are filtered from runtime navigation even when their order is preserved for later',
  featureIds.filter((id) => isDeferredSection(id)).every((id) => !isAdminSectionVisible(id, owner)));

/* 4. Visibility predicate: deferred hidden always; migration utility fully gated. */
check("'performance' is hidden for every runtime (deferred)",
  !isAdminSectionVisible('performance', owner) &&
  !isAdminSectionVisible('performance', { ...owner, isOwner: false }));
check("'legacy-import' visible ONLY when owner + flag on + legacy data detected (finding #4)",
  isAdminSectionVisible('legacy-import', owner) === true &&
  isAdminSectionVisible('legacy-import', { ...owner, legacyDetected: false }) === false &&
  isAdminSectionVisible('legacy-import', { ...owner, legacyEnabled: false }) === false &&
  isAdminSectionVisible('legacy-import', { ...owner, isOwner: false }) === false);
check("launch feature ('menu') is always visible",
  isAdminSectionVisible('menu', owner) && isAdminSectionVisible('menu', { ...owner, isOwner: false }));
check("gated feature ('media') stays visible even when its flag is off (control degrades inside)",
  isAdminSectionVisible('media', { ...owner, mediaV2: false }) === true);

/* 5. EVERY image-upload surface is behind the MEDIA_V2 flag (finding #6). The
 *    media library, the reusable inline uploader (menu item image + the
 *    public-content inline editors) and Website Studio's bespoke upload button
 *    all funnel through the same gated pipeline, so all must degrade honestly. */
check('media library upload control is gated by MEDIA_V2 with an honest disabled state',
  /\{MEDIA_V2 \?/.test(mediaPanel) && /Uploads disabled/.test(mediaPanel)
  && /<MediaLibraryPanel/.test(admin));
const inlineUploader = readFileSync(path.join(REPO, 'src/components/ImageUploadInline.tsx'), 'utf8');
check('ImageUploadInline (shared uploader) is MEDIA_V2-gated',
  /from '\.\.\/lib\/featureFlags'/.test(inlineUploader) &&
  /disabled=\{!MEDIA_V2 \|\| busy\}/.test(inlineUploader) &&
  /\{MEDIA_V2 && \(/.test(inlineUploader) &&
  /Uploads disabled/.test(inlineUploader));
const studio = readFileSync(path.join(REPO, 'src/components/admin/WebsiteStudio.tsx'), 'utf8');
check('Website Studio upload button is MEDIA_V2-gated',
  /from '\.\.\/\.\.\/lib\/featureFlags'/.test(studio) && /\{MEDIA_V2 \?/.test(studio));

/* 6. POS code is retained for later integration but is absent from the public-launch UI. */
check('web till source remains clearly scoped but is not mounted in AdminPanel',
  salesPanel.includes('Web Till Orders') && /Scope:\s*<b>Web backup till only<\/b>/.test(salesPanel) && !/<SalesPanel\b/.test(admin));
check('native till source remains labelled but is not mounted in AdminPanel',
  till.includes('Native Till Ledger') && !/<TillOrders\b/.test(admin));
check("no unqualified 'All-time revenue' KPI label remains on the web till",
  !/label:\s*'All-time revenue'/.test(salesPanel));

console.log(`\n${failed ? '\u2716' : '\u2714'} launch-scope: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
