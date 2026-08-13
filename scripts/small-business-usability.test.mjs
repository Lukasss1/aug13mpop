#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const checks = [];
const check = (name, condition, detail = '') => checks.push({ name, ok: Boolean(condition), detail });

const app = read('src/App.tsx');
const publicPages = read('src/components/PublicPages.tsx');
const navbar = read('src/components/Navbar.tsx');
const staffPortal = read('src/components/StaffPortal.tsx');
const staffDashboard = read('src/components/staff/StaffDashboardPanel.tsx');
const router = read('src/lib/router.ts');
const admin = read('src/components/AdminPanel.tsx');
const adminNavigation = read('src/components/admin/adminNavigation.ts');
const adminDashboard = read('src/components/admin/adminDashboard.ts');
const dashboardPanel = read('src/components/admin/DashboardPanel.tsx');
const adminShell = read('src/components/admin/AdminShell.tsx');
const css = read('src/index.css');
const types = read('src/types.ts');
const migration = read('supabase/migration_t1337_small_business_usability.sql');
const manifest = read('launch/migration-manifest.sh');
const outbox = read('supabase/functions/outbox-dispatch/index.ts');
const publicForm = read('supabase/functions/public-form/index.ts');
const scheduler = read('scripts/commission-production-schedulers.mjs');
const cloud = read('src/lib/cloudSync.ts');
const validator = read('src/lib/publicDataValidation.ts');
const prerender = read('scripts/prerender-seo.ts');

// P0: the public projection is display-only and cannot become a whole-catalogue replacement.
check('PublicPages has no catalogue publisher prop', !/publishMenuItems/.test(publicPages));
check('PublicPages has no menu replacement draft', !/draftMenuItems|handleEditDraftMenuItemImage/.test(publicPages));
check('App does not pass catalogue publisher to public pages', !/<PublicPages[\s\S]{0,2500}publishMenuItems/.test(app));
check('authenticated Admin menu retains its catalogue publisher', /<AdminPanel[\s\S]{0,2500}publishMenuItems=\{publishMenuItems\}/.test(app));
check('public editor routes catalogue work to Admin menu', /PublicWebsiteEditBar[\s\S]*section: 'menu'/.test(publicPages));

// Route target registry parity: every literal staff destination must be a real route.
const sectionMatch = router.match(/export const STAFF_SECTIONS = \[([\s\S]*?)\] as const/);
const sections = new Set((sectionMatch?.[1].match(/'([^']+)'/g) || []).map((value) => value.slice(1, -1)));
const literalTargets = [...staffPortal.matchAll(/setCurrentTab\('staff_([^']+)'\)/g)].map((match) => match[1]);
const invalidTargets = literalTargets.filter((target) => !['login', 'mfa'].includes(target) && !sections.has(target));
check('all literal StaffPortal destinations exist in router registry', invalidTargets.length === 0, invalidTargets.join(', '));
check('legacy staff_knowledge target removed', !/staff_knowledge/.test(staffPortal));
check('knowledge base uses staff_kb', /setCurrentTab\('staff_kb'\)/.test(staffPortal + staffDashboard));

// Honest customer content and health state.
check('fixed 1.6 second splash removed', !/showSplash|setTimeout\([^)]*1600/.test(app));
check('public footer is route-scoped', /isIndexableTab\(currentTab\)[\s\S]{0,180}<Footer/.test(app));
check('footer target is really 44px', /\.mp-footer-link\s*\{[^}]*min-height:\s*44px/s.test(css));
check('footer target is not overridden to 24px', !/\.mp-footer-link\s*\{[^}]*min-height:\s*24px/s.test(css));
check('runtime public payload validators exist', /validatePublicStorageValue/.test(cloud) && /validateSiteSettings/.test(validator));
check('cloud pull returns structured failures', /CloudPullResult/.test(cloud) && /failed:\s*failures/.test(cloud));
check('build emits verified public-content snapshot', /public-content\.json/.test(prerender));
check('browser loads build public-content snapshot as last-known-good', /loadBuildPublicContent/.test(app) && /publicConfigurationStatus/.test(app));
check('late build snapshot cannot overwrite successful live keys', /livePublicKeysRef/.test(app) && /liveKeys\.has\('milkpop_menu_items'\)/.test(app));
check('failed partial live pull still permits snapshot fallback', !/livePublicPullCompletedRef/.test(app));

// Small-business visibility and navigation.
check('public section switches are typed', /showCareers:\s*boolean/.test(types) && /showFranchise:\s*boolean/.test(types) && /showNews:\s*boolean/.test(types));
check('enabled News is represented in customer navigation', /key: 'news'[\s\S]{0,100}?settings\.showNews/.test(navbar));
check('disabled optional public routes are blocked', /optionalPublicSectionDisabled/.test(app));
check('franchise disclosure closes with the franchise programme', /tab === 'franchise' \|\| tab === 'fdd'[\s\S]{0,100}settings\.showFranchise/.test(app));
check('home careers promotion follows the careers switch', /siteSettings\.showCareers && \([\s\S]{0,220}<Reveal className="h-full"/.test(publicPages));
check('empty home menu has an honest opening state', /Our opening menu is being prepared/.test(publicPages));
check('disabled News is not offered from empty-state actions', (publicPages.match(/siteSettings\.showNews && \(/g) || []).length >= 2);
check('footer omits an empty contact column', /hasContactDetails[\s\S]{0,160}lg:grid-cols-4[\s\S]{0,80}lg:grid-cols-3/.test(read('src/components/Footer.tsx')));
check('footer franchise disclosure follows publication switch', /settings\.showFranchise && \([\s\S]{0,180}tab="fdd"/.test(read('src/components/Footer.tsx')));
check('SEO generator omits disabled optional routes', /if \(settings\.showCareers\) pages\.push/.test(prerender) && /if \(settings\.showFranchise\) pages\.push/.test(prerender) && /if \(settings\.showNews\) pages\.push/.test(prerender));
check('SEO dynamic detail pages follow their programme switches', /settings\.showCareers \? snapshot\.vacancies : \[\]/.test(prerender) && /settings\.showNews \? snapshot\.newsPosts : \[\]/.test(prerender));
check('SEO content hash includes publication switches', /showCareers: Boolean\(settings\.showCareers\)/.test(read('src/lib/publicContentSnapshot.ts')) && /showFranchise: Boolean\(settings\.showFranchise\)/.test(read('src/lib/publicContentSnapshot.ts')) && /showNews: Boolean\(settings\.showNews\)/.test(read('src/lib/publicContentSnapshot.ts')));
check('opening dashboard focuses on stores menu messages and staff', /label: 'Public Stores'/.test(dashboardPanel) && /label: 'Public Menu'/.test(dashboardPanel) && /label: 'New Messages'/.test(dashboardPanel) && /label: 'Active Staff'/.test(dashboardPanel));
check('disabled Careers and Franchise are also refused server-side', /section_closed/.test(publicForm) && /show_careers/.test(publicForm) && /show_franchise/.test(publicForm));
check('owner navigation has Everyday Operations Advanced tiers', /Everyday: \[\]/.test(adminNavigation) && /Operations: \[\]/.test(adminNavigation) && /Advanced: \[\]/.test(adminNavigation));
check('advanced owner tools default behind disclosure', /advancedOpen/.test(adminShell) && /aria-expanded=\{advancedOpen\}/.test(adminShell));

// Inbox lifecycle + prompt removal + atomic HR path.
check('contact lifecycle type exists', /status:\s*'new' \| 'replied' \| 'closed'/.test(types));
check('contact badge counts new only', /message\.status === 'new'/.test(adminDashboard) && /contact: dashboardMetrics\.newContactMessages/.test(admin));
check('browser prompt is removed from admin workflows', !/window\.prompt\(/.test(admin));
check('reusable business action dialog is used', /BusinessActionDialog/.test(admin));
check('contact lifecycle RPC and guard exist', /transition_contact_message/.test(migration) && /guard_contact_message_lifecycle/.test(migration));
check('holiday allowance RPC and guard exist', /set_staff_holiday_allowance/.test(migration) && /guard_holiday_allowance_update/.test(migration));
const orderedSqlEntries = [...manifest.matchAll(/^\s*"([^"]+\.sql)"\s*$/gm)]
  .map((match) => match[1]);
const smallBusinessTail = [
  'supabase/migration_t1336_scheduler_failure_heartbeats.sql',
  'supabase/migration_t1337_small_business_usability.sql',
  'supabase/migration_t13310_public_boundary_cleanup.sql',
  'supabase/migration_t13311_public_form_integrity.sql',
  'supabase/migration_t13312_deployment_handoff.sql',
  'supabase/migration_t13313_staff_portal_integrity.sql',
  'supabase/migration_t13319_release_integrity.sql',
  'supabase/migration_t13320_final_audit.sql',
  'supabase/migration_t13322_public_store_scope.sql',
];
check('small-business migrations are append-only and public-store scope is last',
  orderedSqlEntries.slice(-smallBusinessTail.length).join('\n') === smallBusinessTail.join('\n'),
  orderedSqlEntries.slice(-smallBusinessTail.length).join(', '));

// Operational owner alerts are durable, deduplicated and commissioned.
check('health alert state and stale watchdog exist', /ops_alert_state/.test(migration) && /check_ops_heartbeat_staleness/.test(migration));
check('health transitions are concurrency-deduplicated', /pg_advisory_xact_lock\(hashtext\(p_job\)\)/.test(migration));
check('watchdog uses job-specific freshness and excludes itself', /outbox-dispatch'[\s\S]*20 minutes/.test(migration) && /job_name <> 'ops-health-watch'/.test(migration));
check('outbox contains failed and recovery templates', /ops-health-failed/.test(outbox) && /ops-health-recovered/.test(outbox));
check('outbox heartbeat reports non-delivery as failed', /heartbeatStatus = nonDelivered\.length > 0 \? 'failed' : 'ok'/.test(outbox));
check('hourly health watcher is commissioned', /'ops-health-watch'[\s\S]*'23 \* \* \* \*'/.test(scheduler));

// Mobile and tablet ergonomics.
check('public forms opt into touch ergonomics', (publicPages.match(/mp-public-form/g) || []).length === 3);
check('mobile public controls use 16px and 44px minimums', /\.mp-public-form input[\s\S]*font-size:\s*16px[\s\S]*min-height:\s*44px/.test(css));
check('admin and staff shells opt into coarse-pointer targets', /mp-admin-shell/.test(adminShell) && /mp-staff-shell/.test(staffPortal) && /@media \(pointer: coarse\)/.test(css));

const failed = checks.filter((item) => !item.ok);
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} — ${item.name}${item.detail ? ` (${item.detail})` : ''}`);
console.log(`\nSMALL-BUSINESS USABILITY: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) process.exit(1);
