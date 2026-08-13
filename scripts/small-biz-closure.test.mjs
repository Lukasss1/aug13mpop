/**
 * SMALL-BUSINESS PRODUCTION CLOSURE — §9 REGRESSION SUITE
 * =======================================================
 * Run: npm exec --offline -- tsx scripts/small-biz-closure.test.mjs   (npm run test:smallbiz)
 *
 * One focused check block per §9 item (1–14). The evidence style is honest
 * about its level:
 *
 *   • BEHAVIOURAL where the harness genuinely supports it — the shared pay
 *     rule and the public-projection rules are imported and EXECUTED (real
 *     modules via tsx, not re-typed copies), and the P0-11 legal/contact
 *     parity runs on a REAL PostgreSQL database built from the full migration
 *     manifest when that environment is available. Set
 *     MP_REQUIRE_SMALLBIZ_DB=1 to make absence of PostgreSQL a hard failure.
 *
 *   • SOURCE-CONTRACT for behaviours that live inside React effects and
 *     event handlers (focus refresh, cleanup registry, authority grants,
 *     busy keys). There is no DOM test harness in this repository; the
 *     browser lane exercises the rendered pages on the built dist, and these
 *     pins guarantee the specific corrected mechanisms cannot be silently
 *     reverted. Each pin anchors on the MECHANISM (the guard, the call, the
 *     sequence), not on comment text.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveHourlyRate } from '../src/lib/pay';
import {
  projectPublicMenuItems, projectPublicStores, projectPublicVacancies,
  projectPublicNews, projectPublicDeals,
} from '../src/lib/publicProjection';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
/* A backtick character for building needles — tsx's module lexer cannot
 * parse backticks inside REGEX literals, so template-literal needles are
 * assembled from plain strings instead. */
const BT = String.fromCharCode(96);

const app = read('src/App.tsx');
const admin = read('src/components/AdminPanel.tsx');
const portal = read('src/components/StaffPortal.tsx');
const dashboardPanel = read('src/components/staff/StaffDashboardPanel.tsx');
const kbPanel = read('src/components/staff/StaffKnowledgeBasePanel.tsx');
const dealsPanel = read('src/components/admin/DealsPanel.tsx');
const pub = read('src/components/PublicPages.tsx');
const studio = read('src/components/admin/WebsiteStudio.tsx');
const registries = read('src/lib/registries.ts');
const cloudSync = read('src/lib/cloudSync.ts');
const loader = read('scripts/load-public-content.ts');

let passed = 0, failed = 0, skipped = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed += 1; console.log(`  \u2714 ${label}`); }
  else { failed += 1; failures.push(label); console.log(`  \u2716 ${label}${detail ? ` \u2014 ${detail}` : ''}`); }
};
const skip = (label, detail) => { skipped += 1; console.log(`  \u21b7 ${label} — NOT EXECUTED${detail ? `: ${detail}` : ''}`); };

/* Strip comments so pins anchor on CODE, not prose. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* ==================================================================== */
console.log('\n§1  Anonymous focus refresh cannot overwrite authenticated collections');
{
  const start = app.indexOf('const applyCloudData =');
  const end = app.indexOf('const runPull =');
  const body = start >= 0 && end > start ? app.slice(start, end) : '';
  const code = stripComments(body);
  check('applyCloudData reads the CURRENT identity through the ref (stale-closure proof)',
    /const authed = authedEmployeeIdRef\.current !== null;/.test(code));
  // Only the five genuinely public collection arrays apply while unauthenticated.
  // CMS pages and media assets are private and must never enter this branch.
  const gateStart = code.indexOf('if (!authed) {');
  const gateEnd = code.indexOf('if (Object.prototype.hasOwnProperty.call', gateStart);
  const gated = gateStart >= 0 && gateEnd > gateStart ? code.slice(gateStart, gateEnd) : '';
  for (const key of ['milkpop_menu_items', 'milkpop_deals', 'milkpop_stores_list',
    'milkpop_vacancies_list', 'milkpop_news_posts']) {
    check(`${key} applies only inside the unauthenticated branch`,
      gated.includes(`'${key}'`) && code.split(`'${key}'`).length === 2);
  }
  for (const key of ['milkpop_cms_pages', 'milkpop_media_library']) {
    check(`${key} never applies from the anonymous pull`, !code.includes(`'${key}'`));
  }
  // Singletons + notices refresh for BOTH audiences (outside the gate).
  for (const key of ['milkpop_site_settings', 'milkpop_site_content', 'milkpop_privacy_notices']) {
    check(`${key} refreshes outside the authenticated gate`, !gated.includes(`'${key}'`) && code.includes(`'${key}'`));
  }
  const focus = stripComments(app.slice(app.indexOf('const refreshVisibleTab ='), app.indexOf("window.addEventListener('focus'")));
  check('a signed-in tab regaining focus triggers AUTHENTICATED rehydration',
    /authedEmployeeIdRef\.current !== null\) setHydrateNonce/.test(focus));
  check('the focus handler still runs the safe-subset pull for both audiences', /void runPull\(\);/.test(focus));
}

/* ==================================================================== */
console.log('\n§2  Signed-in public projections match anonymous projections');
{
  // BEHAVIOURAL: the REAL module, executed against fixtures shaped like the
  // full authenticated collections. Expected outputs are the anonymous view
  // predicates verbatim.
  const menu = projectPublicMenuItems([
    { id: 'm1', available: true }, { id: 'm2', available: false }, { id: 'm3' },
  ]);
  check('menu: available === true only (drafts and undefined excluded)',
    menu.length === 1 && menu[0].id === 'm1');

  const storeIdentity = { name: 'Milk Pop Solihull', address: 'Touchwood', postcode: 'B91 3GJ' };
  const stores = projectPublicStores([
    { id: 's_anon', ...storeIdentity },                       // anonymous row: setup_status omitted
    { id: 's_act', ...storeIdentity, setupStatus: 'ACTIVE' }, // commissioned authenticated row
    { id: 's_draft', ...storeIdentity, setupStatus: 'DRAFT' },// real coming-soon store, POS deferred
    { id: 's_placeholder', name: 'TBC', address: '-', postcode: 'N/A' },
  ]);
  check('stores: genuine identity is public regardless of deferred POS setup; placeholders are excluded',
    stores.map((s) => s.id).join(',') === 's_anon,s_act,s_draft');

  const vac = projectPublicVacancies([
    { id: 'v1', status: 'published' }, { id: 'v2', status: 'draft' }, { id: 'v3', status: 'closed' },
  ]);
  check('vacancies: status === published only (closed and draft excluded)',
    vac.length === 1 && vac[0].id === 'v1');

  const news = projectPublicNews([
    { id: 'n1', status: 'published' }, { id: 'n2', status: 'draft' },
  ]);
  check('news: status === published only', news.length === 1 && news[0].id === 'n1');

  /* T13-1 repoint — this fixture ENCODED THE DEFECT. `{ id: 'd3' }` with no
     `active` key is exactly the shape deals_public returns (the view filters
     on `active` and does NOT select the column), and the T12 assertion
     required it to be REMOVED — which is precisely why every anonymous deal
     vanished from the public site. A flag-less row is public by construction;
     only an explicit `false`, which exists solely on an authenticated row, is
     filtered. Full coverage of the corrected rule lives in test:t13 §1-3. */
  const deals = projectPublicDeals([
    { id: 'd1', active: true }, { id: 'd2', active: false }, { id: 'd3' },
  ]);
  check('deals: explicit false removed, anonymous flag-less row KEPT',
    deals.map((d) => d.id).join(',') === 'd1,d3', deals.map((d) => d.id).join(','));
  const vac2 = projectPublicVacancies([{ id: 'v-anon', title: 'Team Member' }]);
  check('vacancies: anonymous flag-less row KEPT', vac2.length === 1);

  // SOURCE: App applies the helper at the single PublicPages prop boundary.
  const site = app.slice(app.indexOf('<PublicPages'), app.indexOf('/>', app.indexOf('<PublicPages')));
  check('App passes MENU through the shared projection', /menuItems=\{asPublic\('menu', projectPublicMenuItems\(menuItems\)\)\}/.test(site));
  check('App passes STORES through the shared projection', /stores=\{asPublic\('stores', projectPublicStores\(stores\)\)\}/.test(site));
  check('App passes VACANCIES through the shared projection', /vacancies=\{asPublic\('vacancies', projectPublicVacancies\(vacancies\)\)\}/.test(site));
  check('App passes NEWS through the shared projection', /news=\{asPublic\('news', projectPublicNews\(newsPosts\)\)\}/.test(site));
  check('App passes DEALS through the shared projection', /deals=\{asPublic\('deals', projectPublicDeals\(deals\)\)\}/.test(site));
  check('no raw unprojected collection reaches PublicPages',
    !/stores=\{asPublic\('stores', stores\)\}/.test(site) && !/newsList=\{newsPosts\}/.test(site));
}

/* ==================================================================== */
console.log('\n§3  Identity switching leaves no previous private state');
{
  const start = app.indexOf('const resetPrivateState');
  const body = stripComments(app.slice(start, app.indexOf('}, []);', start)));
  const required = [
    'setEmployeesList([])', 'setShiftsList([])', 'setClockHistory([])', 'setPayslips([])',
    'setDocuments([])', 'setSifrReports([])', 'setApplications([])', 'setFranchiseInquiries([])',
    'setContactMessages([])', 'setTrainingAssignments([])', 'setTrainingCertificates([])',
    'setTrainingProgress([])', 'setAppState({})', 'setAssessments(DEV_PRIVATE_SEED_CONTENT ? INITIAL_ASSESSMENTS : [])',
    // SMALL-BIZ CLOSURE P0-3 additions — each back to its BOOT value:
    'setArticles([])', 'setCourses(DEV_PRIVATE_SEED_CONTENT ? INITIAL_COURSES : [])', 'setAuditLogs([])',
    'setRolePermissions(DEV_PRIVATE_SEED_CONTENT ? INITIAL_ROLE_PERMISSIONS : [])', 'setChecklistTemplates(DEV_PRIVATE_SEED_CONTENT ? INITIAL_CHECKLIST_TEMPLATES : [])',
    'setMediaItems(DEV_PRIVATE_SEED_CONTENT ? INITIAL_MEDIA_LIBRARY : [])', 'setCmsPages(DEV_PRIVATE_SEED_CONTENT ? INITIAL_CMS_PAGES : [])',
    'setEmailSettings(DEFAULT_EMAIL_SETTINGS)', 'setCollectionRevisions({})',
  ];
  for (const r of required) check(`cleanup registry resets ${r.split('(')[0]}`, body.includes(r));

  const lg = stripComments(app.slice(app.indexOf('const handleLogout'), app.indexOf('};', app.indexOf('const handleLogout'))));
  const order = [lg.indexOf('await signOut()'), lg.indexOf('runSessionCleanup()'), lg.indexOf("window.location.replace('/')")];
  check('manual logout = signOut \u2192 registered cleanup \u2192 window.location.replace(\'/\')',
    order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2]);
  check('the cleanup registry runs the full reset and revokes authority on identity change',
    /registerSessionCleanup\('app-private-state'/.test(app) && /clearAuthority\(\);/.test(app.slice(app.indexOf("registerSessionCleanup('app-private-state'"), app.indexOf("unregisterSessionCleanup('app-private-state'"))));
}

/* ==================================================================== */
console.log('\n§4  Failed / repeated hydration revokes collection authority');
{
  const start = app.indexOf("setStaffDataStatus('loading');");
  const hydration = stripComments(app.slice(start, app.indexOf('return () => { cancelled = true; };', start)));
  check('every hydration ATTEMPT revokes all authority before loading',
    hydration.indexOf('clearAuthority();') >= 0 &&
    hydration.indexOf('clearAuthority();') < hydration.indexOf('await hydrateStaffData'));
  check('authority is granted ONLY through the revision-coupled helper',
    /const grantWithRevision = \(name: CollectionName, table: string\)/.test(hydration) &&
    !/[^h]grantAuthority\(/.test(hydration.replace(/grantWithRevision[\s\S]*?revMap\[table\] !== undefined\) grantAuthority/, 'grantWithRevision GUARD grantAuthority_INSIDE')));
  check('an unauthenticated hydration result returns the app to sign-in (P0-4)',
    /bundle\.sessionExpired/.test(hydration) && /void signOut\(\);/.test(hydration));
  const reg = stripComments(registries);
  check('registries: only role-based denied stays a silent empty; unknowns are recorded failures',
    /e\.code === 'denied'\) return;/.test(reg) &&
    /e\.code === 'unauthenticated'\) out\.sessionExpired = true;/.test(reg) &&
    /out\.failures\.push\(String\(field\)\);/.test(reg));
}

/* ==================================================================== */
console.log('\n§5  Stores (and the Knowledge Base) require full-collection authority');
{
  check('publishStores is wrapped in requireAuthority(\'stores\')',
    /const publishStores = requireAuthority<StoreLocation>\('stores', 'Stores', publishStoresRaw\);/.test(app));
  check('publishArticles is wrapped in requireAuthority(\'articles\')',
    /const publishArticles = requireAuthority<KnowledgeArticle>\('articles', 'Knowledge Base',/.test(app));
  check('stores and articles are members of CollectionName',
    /type CollectionName = 'menu' \| 'deals' \| 'news' \| 'vacancies' \| 'cms' \| 'media' \| 'stores' \| 'articles';/.test(app));
  check('menu completeness validates identity and generation, not mere presence',
    /const menuCatalogueComplete = hasAuthority\('menu', employee\?\.id\);/.test(app) &&
    !/Boolean\(collectionAuthority\.menu\)/.test(stripComments(app)));
  check('stores/articles grants are revision-coupled like every other collection',
    /grantWithRevision\('stores', 'stores'\);/.test(app) && /grantWithRevision\('articles', 'kb_articles'\);/.test(app));
}

/* ==================================================================== */
console.log('\n§6  Missing revision / incomplete hydration blocks collection replacement');
{
  const start = app.indexOf('const makeCollectionPublisher');
  const body = stripComments(app.slice(start, app.indexOf('const makeExplicitChangesPublisher')));
  check('publisher refuses when staff data is not live',
    /if \(staffDataStatus !== 'live'\)/.test(body) && body.indexOf("staffDataStatus !== 'live'") < body.indexOf('await requireToken'));
  check('publisher refuses when the ledger revision never arrived',
    /collectionRevisions\[table\] === undefined/.test(body));
  check('the destructive call still states the revision (server backstop intact)',
    /collectionRevisions\[table\] \?\? null/.test(body));
}

/* ==================================================================== */
console.log('\n§7  Knowledge Base is database-backed for Admin and Staff Portal');
{
  check('hydration loads kb_articles alongside the other collections',
    /\['articles', \(\) => articlesRepo\.list\(token\)\]/.test(registries));
  check('the bundle carries articles', /articles\?: KnowledgeArticle\[\];/.test(registries));
  {
    const devStart = app.indexOf('if (DEV_PRIVATE_SEED_CONTENT)');
    const devBlock = stripComments(app.slice(devStart, app.indexOf('} else {', devStart)));
    check('App boots the Knowledge Base EMPTY (seeds only behind DEV_PRIVATE_SEED_CONTENT)',
      /const \[articles, setArticles\] = useState<KnowledgeArticle\[\]>\(\[\]\);/.test(app) &&
      devBlock.includes('setArticles(INITIAL_ARTICLES);'));
  }
  check('App applies the hydrated articles', /if \(bundle\.articles\) \{ setArticles\(bundle\.articles\);/.test(app));
  check('StaffPortal renders the database articles through the extracted Knowledge Base panel',
    /articles: KnowledgeArticle\[\];/.test(portal)
    && /<StaffKnowledgeBasePanel articles=\{articles\} \/>/.test(portal)
    && /return articles\.filter/.test(kbPanel));
  check('StaffPortal no longer imports the bundled seed articles', !/INITIAL_ARTICLES/.test(portal));
}

/* ==================================================================== */
console.log('\n§8  Public collections distinguish unavailable from genuinely empty');
{
  check('news reaches PublicPages as a PublicCollection, not a plain array',
    /news: PublicCollection<NewsPost>;/.test(pub) && !/newsList\?: NewsPost\[\]/.test(pub));
  check('the shared status panel exists', /function CollectionStatusNote\(\{ status, label \}/.test(pub));
  const code = stripComments(pub);
  check('stores: Coming Soon renders only from a READY collection',
    /if \(stores\.status !== 'ready'\) \{\s*return <CollectionStatusNote status=\{stores\.status\} label="our locations" \/>;/.test(pub));
  check('careers: No Open Roles renders only from a READY collection',
    /vacancies\.status !== 'ready' \? \(\s*<CollectionStatusNote status=\{vacancies\.status\} label="open roles" \/>/.test(pub));
  check('news: the empty archive renders only from a READY collection',
    /news\.status !== 'ready' \?/.test(code) && /publishedPosts = \(news\.status === 'ready' \? news\.items : \[\]\)/.test(code));
  check('deals: loading/unavailable render their own note on the menu page',
    /deals\.status !== 'ready' \? \(\s*<div className="mb-8"><CollectionStatusNote status=\{deals\.status\}/.test(pub));
  check('App SEO effect: unknown-slug redirects fire only when that collection is ready',
    /publicStates\.stores === 'ready'\) \{ setCurrentTab\('stores'/.test(app) &&
    /publicStates\.vacancies === 'ready'\) \{ setCurrentTab\('careers'/.test(app) &&
    /publicStates\.news === 'ready'\) \{ setCurrentTab\('news'/.test(app));
  /* Gating the bounce would otherwise hand a crawler exactly what the bounce
     existed to prevent — an arbitrary slug as an indexable self-canonical 200
     for the duration of an outage. The not-ready branch therefore keeps the
     visitor's URL but emits noindex + the LIST canonical (proven live in the
     routing/final browser audits). */
  check('a not-ready slug is noindex and canonicalised to its list route',
    (app.match(/applyHeadMeta\(\{ title, description, canonicalPath: canonicalPathFor\('(stores|careers|news)', \{\}\), noindex: true \}\)/g) || []).length === 3);
}

/* ==================================================================== */
console.log('\n§9  A cancelled menu image cannot attach to another item');
{
  const code = stripComments(admin);
  check('the pending upload is a single session-keyed ref (the \'last\' Map is gone)',
    /menuPendingUploadRef = React\.useRef<\{ objectId: string; session: number \} \| null>\(null\)/.test(admin) &&
    !/menuUploadRef/.test(admin));
  check('a fresh session discards the pending object',
    /const resetMenuUploadSession = useCallback\(\(\) => \{\s*menuFormSessionRef\.current \+= 1;\s*menuPendingUploadRef\.current = null;\s*\}, \[\]\);/.test(admin));
  const resets = (code.match(/resetMenuUploadSession\(\)/g) || []).length;
  const centralCloseUses = (admin.match(/onClick=\{closeEntityForm\}/g) || []).length;
  check(`session resets at every distinct open/switch/save/close path (found ${resets}, need \u2265 6)`,
    resets >= 6 &&
    /const closeEntityForm = \(\): void => \{[\s\S]*?resetMenuUploadSession\(\);[\s\S]*?\};/.test(admin) &&
    centralCloseUses === 2);
  check('the upload is recorded under the CAPTURED render session',
    /const menuFormSession = menuFormSessionRef\.current;/.test(admin) &&
    /menuPendingUploadRef\.current = \{ objectId, session: menuFormSession \};/.test(admin));
  check('the uploader remounts with the form session so a late URL cannot enter another item',
    /key=\{`menu-image-\$\{menuFormSession\}`\}/.test(admin));
  check('attachment only runs when the pending session matches the open form',
    (admin.match(/pending\.session === menuFormSessionRef\.current/g) || []).length === 2);
}

/* ==================================================================== */
console.log('\n§10 Attachment failure is visible and retryable');
{
  check('menu EDIT save AWAITS the attachment', /const r = await attachMediaReference\(pending\.objectId, 'menu_item', editItemId, 'image'\);/.test(admin));
  check('menu CREATE save AWAITS the attachment', /const r = await attachMediaReference\(pending\.objectId, 'menu_item', nextId, 'image'\);/.test(admin));
  check('a failed attach keeps the form open with a retry warning (edit path)',
    /could not be finalised\. Press "Confirm & Save" again/.test(admin));
  check('a failed CREATE attach flips the form to edit mode of the created draft',
    admin.includes('setEditItemId(nextId);') &&
    admin.includes('was created as a draft, but its image reference could not be finalised'));
  check('Website Studio collects and AWAITS its attachments',
    /await Promise\.all\(attachCalls\);/.test(studio));
  check('Website Studio surfaces attachment failures to the owner, retryably',
    studio.includes('Website content is live, but ' + '$' + "{attachFailures === 1 ? 'one image reference'"));
  check('Studio success toast fires only on full success',
    /if \(attachFailures > 0\) \{[\s\S]*?\} else \{\s*addToast\('Published/.test(studio));
}

/* ==================================================================== */
console.log('\n§11 One to three real stores — no fictional identity anywhere');
{
  const opAdmin = stripComments(admin);
  const opPub = stripComments(pub);
  check('AdminPanel carries no operational \'s1\' or hardcoded store identity', !/'s1'/.test(opAdmin));
  check('PublicPages store fallback is the first REAL store or empty', /activeStores\[0\]\?\.id \?\? ''/.test(pub) && !/'s1'/.test(opPub));
  check('shift creation resolves a REAL store row or refuses',
    /const shiftStore = storesById\.get\(shiftFormState\.storeId \|\| empObj\.storeId\);/.test(admin) &&
    /Choose a store for this shift/.test(admin));
  check('the shift form store options are manager-scoped',
    /currentRole === 'owner' \|\| st\.id === employee\?\.storeId/.test(admin));
  check('staff onboarding requires a selected real store',
    /const chosenStore = storesById\.get\(staffFormState\.storeId\);/.test(admin) &&
    /Choose the store this associate belongs to\./.test(admin));
  check('the one-active-store default rule exists',
    /const singleActiveStaffStore = activeStaffStores\.length === 1 \? activeStaffStores\[0\] : undefined;/.test(admin)
    && /storeId: singleActiveStaffStore\?\.id \|\| ''/.test(admin));
  check('no invented onboarding recognition (points 0, no badges)',
    /points: 0,\s*level: 1,\s*badges: \[\],/.test(admin) && !/badges: \['Inducted'\]/.test(admin));
}

/* ==================================================================== */
console.log('\n§12 Missing pay configuration produces no monetary estimate (BEHAVIOURAL)');
{
  check('no configured rate \u21d2 null', effectiveHourlyRate({}) === null);
  check('zero rate \u21d2 null', effectiveHourlyRate({ payRate: 0, payType: 'hourly' }) === null);
  check('negative rate \u21d2 null', effectiveHourlyRate({ payRate: -5, payType: 'hourly' }) === null);
  check('hourly rate passes through exactly', effectiveHourlyRate({ payRate: 12.5, payType: 'hourly' }) === 12.5);
  check('a configured rate with no payType is treated as hourly (never guessed as salary)',
    effectiveHourlyRate({ payRate: 900 }) === 900);
  check('salary is payroll-managed and not converted to a timesheet hourly rate',
    effectiveHourlyRate({ payRate: 20800, payType: 'salary' }) === null);
  check('a small annual salary is still not converted to an hourly estimate',
    effectiveHourlyRate({ payRate: 2080, payType: 'salary' }) === null);
  const comps = stripComments(admin) + stripComments(portal);
  check('no 11.44 substitute anywhere in the components', !/11\.44/.test(comps));
  check('no size-based salary inference anywhere in the components', !/>= ?500\b/.test(comps) && !/>= ?20000\b/.test(comps));
  check('the earnings generator skips unconfigured employees BY NAME',
    /const skippedNoRate: string\[\] = \[\];/.test(admin) && /skippedNoRate\.push\(emp\.name\)/.test(admin) &&
    admin.includes('SKIPPED (no pay rate configured): ' + '$' + '{skippedNoRate.join'));
  check('the staff drawer and portal show hours without cash when the rate is null',
    /shiftPay === null/.test(admin) && /hourlyRate === null \? null :/.test(dashboardPanel));
  check('the salary form label states ANNUAL', /Annual Salary \(\u00a3 \/ year\)/.test(admin));
}

/* ==================================================================== */
console.log('\n§13 Public legal/contact configuration parity (BEHAVIOURAL, real PostgreSQL)');
{
  const requireDb = process.env.MP_REQUIRE_SMALLBIZ_DB === '1';
  let dbAvailable = true;
  try {
    execFileSync('id', ['-u', 'postgres'], { stdio: 'ignore' });
    execFileSync('sh', ['-c', 'command -v psql >/dev/null'], { stdio: 'ignore' });
  } catch {
    dbAvailable = false;
  }

  if (dbAvailable) {

    const DB = process.env.MP_SMALLBIZ_DB || 'mp_smallbiz_parity';
    const SHIM = path.join(ROOT, 'scripts/lib/supabase-local-privileges.sql');
    const psql = (sql) => execFileSync('su', ['postgres', '-c',
      `psql -tA -v ON_ERROR_STOP=1 -d ${DB} -c ${JSON.stringify(sql.replace(/\s+/g, ' ').trim())}`], { encoding: 'utf8' });
    const psqlFile = (f) => execFileSync('su', ['postgres', '-c',
      `psql -q -X -v ON_ERROR_STOP=1 -d ${DB} -f ${JSON.stringify(f)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const lastDataLine = (raw) => {
      const lines = raw.trim().split('\n').map((x) => x.trim()).filter(Boolean)
        .filter((x) => !/^(UPDATE|DELETE|INSERT|SET|RESET|BEGIN|COMMIT|SELECT)( \d+( \d+)?)?$/.test(x));
      return lines[lines.length - 1] ?? '';
    };
    try {
      const files = execFileSync('bash', [path.join(ROOT, 'launch/migration-manifest.sh'), 'all'], { encoding: 'utf8' })
        .split('\n').map((x) => x.trim()).filter(Boolean);
      execFileSync('su', ['postgres', '-c',
        `psql -q -X -c "drop database if exists ${DB}" -c "create database ${DB}"`], { encoding: 'utf8' });
      psqlFile(SHIM);
      for (const rel of files) psqlFile(path.join(ROOT, rel));
      check(`fresh database from the full manifest (${files.length} files incl. chain 93)`, true);

      // Baseline: launch facts blank \u21d2 the view mirrors site_settings per field.
      psql(`update site_settings set legal_name = 'Milk Pop Ltd (site)', company_number = '00000001',
            hq_address = '1 Site Road', email = 'site@milkpop.uk', gdpr_email = 'privacy-site@milkpop.uk',
            phone = '0111', website_url = 'https://site.milkpop.uk' where id = 1`);
      const before = lastDataLine(psql(`select legal_name || '|' || company_number || '|' || hq_address || '|' || email || '|' || gdpr_email || '|' || phone || '|' || website_url from public_site_configuration`));
      check('with blank launch facts every field falls back to site_settings',
        before === 'Milk Pop Ltd (site)|00000001|1 Site Road|site@milkpop.uk|privacy-site@milkpop.uk|0111|https://site.milkpop.uk', before);

      // Enter SOME launch facts \u21d2 exactly those fields flip; the rest keep falling back.
      psql(`update launch_settings set legal_business_name = 'Milk Pop Ltd (launch)',
            public_contact_email = 'hello@milkpop.uk', canonical_url = 'https://milkpop.uk' where id = true`);
      const after = lastDataLine(psql(`select legal_name || '|' || company_number || '|' || email || '|' || gdpr_email || '|' || website_url from public_site_configuration`));
      check('entered launch facts win PER FIELD; blank ones still fall back',
        after === 'Milk Pop Ltd (launch)|00000001|hello@milkpop.uk|privacy-site@milkpop.uk|https://milkpop.uk', after);

      // The projection is the ONLY anonymous window: anon reads the view, never launch_settings.
      const anonView = lastDataLine(psql(`set role anon; select legal_name from public_site_configuration`));
      check('anon reads the projection', anonView === 'Milk Pop Ltd (launch)', anonView);
      let anonBase = { ok: true };
      try { psql(`set role anon; select legal_business_name from launch_settings`); }
      catch (e) { anonBase = { ok: false, err: `${e.stderr || e.message}` }; }
      check('anon is DENIED on launch_settings itself', !anonBase.ok && /permission denied/.test(anonBase.err));

      // Private launch controls are not projected.
      const cols = psql(`select string_agg(a.attname, ',') from pg_attribute a
        where a.attrelid = 'public.public_site_configuration'::regclass and a.attnum > 0 and not a.attisdropped
          and a.attname in ('enforce_public_gates','notification_recipient','vat_state_confirmed','customer_ack_enabled')`).trim();
      check('no private launch control is projected', cols === '' || cols === '\\N' || cols === 'null');
    } catch (e) {
      check('P0-11 database parity section completed', false, `${e.stderr || e.message}`.slice(0, 300));
    }

  } else if (requireDb) {
    check('P0-11 database parity section completed', false, 'PostgreSQL/role postgres unavailable and MP_REQUIRE_SMALLBIZ_DB=1');
  } else {
    skip('P0-11 database parity section', 'PostgreSQL/role postgres unavailable; set MP_REQUIRE_SMALLBIZ_DB=1 to make this mandatory');
  }

  // Client single-source pins: every consumer reads the one projection.
  check('the browser settings pull reads public_site_configuration',
    /readTable: 'public_site_configuration'/.test(cloudSync));
  check('the SEO loader reads public_site_configuration for the settings singleton',
    /relation: 'public_site_configuration', field: 'site_settings', singleton: true/.test(loader));
  check('no component reads launch_settings as a public source',
    !/launch_settings/.test(stripComments(pub)) && !/launchSettings/.test(read('src/components/Footer.tsx')));
}

/* ==================================================================== */
console.log('\n§14 Duplicate content actions are ignored while busy');
{
  /* T13-9 repoint: the guard moved from React STATE to a useRef, because state
     does not update until a re-render and two clicks in one tick both passed
     it. State still drives the disabled look and the progress label. */
  check('the busyAction key system exists and IGNORES repeats (no queue)',
    /const \[busyAction, setBusyAction\] = useState<string \| null>\(null\);/.test(admin) &&
    /if \(busyRef\.current\) return;\s*busyRef\.current = key;/.test(admin) &&
    /busyRef\.current = null;/.test(admin));
  check('publish/unpublish runs under a per-record busy key',
    admin.includes('withBusy(' + BT + 'publish:' + '$' + '{table}:' + '$' + '{id}' + BT));
  check('the form Confirm & Save runs under a busy key with a visible Saving state',
    admin.includes("withBusy('form-save'") && admin.includes("busyAction === 'form-save' ? 'Saving\u2026' : 'Confirm & Save'"));
  check('Close vacancy runs under a busy key',
    admin.includes('withBusy(' + BT + 'vacancy:close:' + '$' + '{vacancy.id}' + BT));
  check('destructive content actions run under synchronous single-flight keys',
    admin.includes('withBusy(' + BT + 'menu:delete:' + '$' + '{item.id}' + BT)
    && admin.includes('withBusy(' + BT + 'vacancy:delete:' + '$' + '{vacancy.id}' + BT)
    && dealsPanel.includes('mutation.run(' + BT + 'deal:delete:' + '$' + '{deal.id}' + BT));
  check('Website Studio publish is single-flight with a visible Publishing state',
    studio.includes('if (!isDirty || publishBusyRef.current) return;')
    && studio.includes('publishBusyRef.current = true;')
    && studio.includes("publishBusy ? 'Publishing\u2026'"));
}

/* ==================================================================== */
console.log(`\nSMALL-BIZ CLOSURE \u00a79 \u2014 ${passed} passed, ${failed} failed, ${skipped} not executed`);
if (failed) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
