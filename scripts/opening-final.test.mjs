#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0;
let failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`✔ ${name}`); }
  else { failed += 1; console.error(`✘ ${name}${detail ? `\n  ${detail}` : ''}`); }
};

const manifest = JSON.parse(read('release-manifest.json'));
const envIdentity = read('.env.example').match(/^VITE_RELEASE_IDENTITY=(.+)$/m)?.[1]?.trim();
const safeUrl = read('src/lib/safeUrl.ts');
const publicPages = read('src/components/PublicPages.tsx');
const launchSettings = read('src/lib/launchSettings.ts');
const validation = read('src/lib/publicDataValidation.ts');
const footer = read('src/components/Footer.tsx');
const admin = read('src/components/AdminPanel.tsx');
const adminDashboard = read('src/components/admin/adminDashboard.ts');
const dashboardPanel = read('src/components/admin/DashboardPanel.tsx');
const content = read('src/siteContent.ts');
const defaultState = read('src/defaultState.ts');
const index = read('index.html');
const og = read('scripts/generate-og-card.mjs');
const readme = read('README.md');
const staging = read('docs/STAGING-COMMISSIONING.md');
const publicLoader = read('scripts/load-public-content.ts');
const publicSnapshot = read('src/lib/publicContentSnapshot.ts');
const publicContract = JSON.parse(read('scripts/contracts/public-contract.json'));
const anonSurface = JSON.parse(read('scripts/contracts/anon-surface.json'));
const boundaryMigration = read('supabase/migration_t13310_public_boundary_cleanup.sql');
const cloudSync = read('src/lib/cloudSync.ts');
const publicFormFunction = read('supabase/functions/public-form/index.ts');
const app = read('src/App.tsx');
const closurePanels = read('src/components/admin/ClosurePanels.tsx');
const studio = read('src/components/admin/WebsiteStudio.tsx');
const drinkArt = read('src/drinkArt.ts');
const formatting = read('src/lib/businessFormatting.ts');

const sourceFiles = [];
const walkSource = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkSource(full);
    else if (/\.(?:ts|tsx|css)$/.test(entry)) sourceFiles.push(full);
  }
};
walkSource(path.join(ROOT, 'src'));
const missingBrandAssets = [];
for (const file of sourceFiles) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/["'](\/brand\/[^"'?#)]+)["']/g)) {
    const href = match[1];
    // Exact old persisted default: hydrateSiteContent rewrites it before render.
    if (href === '/brand/mascot_sit_shake.png') continue;
    if (!existsSync(path.join(ROOT, 'public', href.slice(1)))) {
      missingBrandAssets.push(`${path.relative(ROOT, file)} -> ${href}`);
    }
  }
}

check('environment identity exactly matches release manifest', envIdentity === manifest.release_identity, `${envIdentity} vs ${manifest.release_identity}`);
check('application version is current', JSON.parse(read('package.json')).version === manifest.release_version);
check('static shell uses UK English and opening-safe fallback copy',
  /<html lang="en-GB">/.test(read('index.html'))
  && /Menu, store information and contact details for Milk Pop\./.test(read('index.html'))
  && !/Freshly spun|Creamy milkshakes/.test(read('index.html')));
check('public fallback and SEO evidence cannot remain cached across releases',
  /\/public-content\.json[\s\S]{0,100}Cache-Control: no-store/.test(read('public/_headers'))
  && /\/seo-manifest\.json[\s\S]{0,100}Cache-Control: no-store/.test(read('public/_headers')));
check('fallback snapshot is described as hash-verified, not independently browser-signed',
  !/signed public fallback snapshot|signed last-known-good/.test(read('README.md') + read('PRODUCTION-COMMISSIONING-T13.3.30.md') + read('src/components/admin/SeoSyncPanel.tsx')));
check('privacy URLs have a dedicated safe boundary', /export function safePolicyHref/.test(safeUrl));
check('public privacy link never renders the raw database URL', /href=\{policyHref\}/.test(publicPages) && !/href=\{n\.policyUrl\}/.test(publicPages));
check('privacy notice publisher validates the URL before writing', /trimmedPolicyUrl && !safePolicyHref\(trimmedPolicyUrl\)/.test(launchSettings));
check('runtime public notice validation rejects unsafe policy URLs', /safePolicyHref\(value\.policyUrl\)/.test(validation));
check('footer telephone and email links use safe URL boundaries', /safeTelHref\(settings\.phone\)/.test(footer) && /safeMailtoHref\(settings\.email\)/.test(footer));
check('contact support routes use safe mailto links', /filter\(\(route\) => safeMailtoHref\(route\.email\)\)/.test(publicPages));
check('contact support heading disappears when no route email is configured',
  /routes\.some\(\(route\) => safeMailtoHref\(route\.email\)\) && \(/.test(publicPages));
check('contact reasons stay compatible with the guarded public-form contract',
  /value="General feedback"/.test(publicPages) && /value="Career queries"/.test(publicPages)
  && /value="Partnerships"/.test(publicPages) && /value="Other"/.test(publicPages));
check('contact form uses simple customer wording', /General question or feedback/.test(publicPages)
  && /Careers question/.test(publicPages) && /Business enquiry/.test(publicPages)
  && /placeholder="How can we help\?"/.test(publicPages));
check('owner dashboard exposes a simple opening setup path', /Opening setup/.test(dashboardPanel)
  && /Publish your first store/.test(admin) && /Publish the opening menu/.test(admin)
  && /Add public contact details/.test(admin) && /Review launch readiness/.test(dashboardPanel));
check('opening setup disappears only after every role-visible customer basic is complete',
  /openingSetupItems\.some\(\(item\) => !item\.done\)/.test(dashboardPanel)
  && /done: publicStoreCount > 0/.test(admin)
  && /done: publicMenuCount > 0/.test(admin)
  && /done: hasPublicContact/.test(admin)
  && /\.filter\(\(item\) => canOpenAdminSection\(item\.tab\)\)/.test(admin)
  && /return hasRealStoreIdentity\(effectiveStore\)/.test(adminDashboard)
  && /item\.available === true && isPublishableMenuItem\(item\)/.test(adminDashboard));
check('opening contact task goes directly to launch facts',
  /label: 'Add public contact details'[\s\S]*?tab: 'settings'/.test(admin));
check('opening setup requires a usable contact channel rather than address alone',
  /hasPublicContact: Boolean\(safeMailtoHref\(siteSettings\.email\) \|\| safeTelHref\(siteSettings\.phone\)\)/.test(adminDashboard)
  && !/hasPublicContact[\s\S]{0,180}hqAddress/.test(adminDashboard));
check('brand name alone is not emitted as a registered legal name',
  /export const publicLegalName/.test(publicSnapshot)
  && /legalName: publicLegalName\(settings\)/.test(publicSnapshot)
  && /const legalName = publicLegalName\(settings\)/.test(read('scripts/prerender-seo.ts')));
check('saving launch facts refreshes readiness and public configuration',
  /onSaved=\{\(\) => \{[\s\S]*?setLaunchFactsRefreshToken/.test(admin)
  && /onRefreshPublicContent\(\)/.test(admin)
  && /refreshToken=\{launchFactsRefreshToken\}/.test(admin));
check('optional direct routes wait for verified configuration before 404',
  /optionalPublicSectionPending/.test(app)
  && /publicConfigurationStatus === 'loading'/.test(app)
  && /Loading this website section/.test(app));
check('public configuration loading always resolves without a backend',
  /!isCloudConfigured\(\) && !DEV_PRIVATE_SEED_CONTENT/.test(app)
  && /setPublicConfigurationStatus\('unavailable'\)/.test(app)
  && /setPublicConfigurationStatus\('ready'\)/.test(app));
check('owner-editable currency is bounded at save and render boundaries',
  /normalizeCurrencySymbol/.test(formatting)
  && /validateSiteSettings\(settingsPart\)/.test(app)
  && /normalizeCurrencySymbol\(settingsDraft\.currencySymbol\)/.test(admin));
check('menu images reveal branded fallbacks on load failure',
  /resolveMediaUrl\(item\.image\)/.test(drinkArt)
  && (publicPages.match(/onError=\{\(event\) => \{ event\.currentTarget\.style\.display = 'none'; \}\}/g) || []).length >= 4);
check('canonical opening URL rejects localhost, private hosts, ports and subpaths',
  /safeCanonicalSiteHref\(draft\.canonical_url\)/.test(read('src/components/admin/ClosurePanels.tsx'))
  && /https:\/\/localhost/.test(read('supabase/migration_t13310_public_boundary_cleanup.sql'))
  && /https:\/\/milkpop\.uk\/admin\//.test(read('supabase/migration_t13310_public_boundary_cleanup.sql')));
check('launch-fact editor rejects malformed contact facts before RPC',
  /!safeMailtoHref\(draft\.public_contact_email\)/.test(closurePanels)
  && /!safeTelHref\(draft\.public_telephone\)/.test(closurePanels)
  && /!safeCanonicalSiteHref\(draft\.canonical_url\)/.test(closurePanels));
check('database launch gate treats malformed non-empty facts as incomplete',
  /trg_launch_settings_validate_shape/.test(boundaryMigration)
  && /launch_fact_email_valid\(p\.public_contact_email\)/.test(boundaryMigration)
  && /launch_fact_https_valid\(p\.canonical_url\)/.test(boundaryMigration));
check('news defaults are genuinely empty', /export const INITIAL_NEWS_POSTS: NewsPost\[\] = \[\];/.test(defaultState));
check('browser bundle has no active priced promotion defaults',
  /export const INITIAL_DEALS: Deal\[\] = \[\];/.test(read('src/data.ts')));
check('default footer copy is opening-safe and editable',
  /opening information will be published here as it is confirmed/.test(read('src/data.ts'))
  && !/small moment of happiness/.test(read('src/data.ts')));
check('Website Studio content test follows the current privacy copy',
  /handles personal information submitted through this website/.test(read('scripts/site-content.test.ts'))
  && !/privacy policy explains/.test(read('scripts/site-content.test.ts')));
check('footer metadata line disappears when both values are empty',
  /\(websiteDisplay \|\| settings\.instagramHandle\) && \(/.test(footer));
check('no-script wording does not imply public online ordering',
  /interactive menu, forms and account features/.test(index)
  && !/ordering and account features/.test(index)
  && /interactive menu, forms and account features/.test(read('scripts/prerender-seo.ts')));
check('source shell omits disabled optional navigation', !/href="\/(careers|franchise|news)\//.test(index));
check('source shell description does not advertise disabled programmes', !/careers|franchise/i.test(index.match(/<meta name="description"[^>]+>/)?.[0] || ''));
check('public and owner franchise wording uses UK enquiry spelling',
  !/Send Inquiry Form|Franchise Inquiry Leads|Franchise Investment Inquiry/.test(publicPages + admin + content));
check('launch facts editor has a visible loading state and readable controls',
  /Loading launch facts…/.test(closurePanels) && /min-h-11[\s\S]{0,100}text-base sm:text-sm/.test(closurePanels));
check('default menu and contact copy avoids unsupported quality and response promises',
  !/Grown with Care|Our Premium Menu|Uncompromising Quality|Radical Hospitality|always happy to chat|as soon as possible/.test(content));
check('Website Studio publish controls meet the primary touch target',
  /handleDiscard[\s\S]{0,180}min-h-11/.test(studio)
  && /handleSave[\s\S]{0,180}min-h-11/.test(studio));
for (const phrase of ['ethical sourcing', 'origin of our matcha', 'fair hours and genuine support', 'shopping-centre approvals', 'handcrafted specialities', 'slow-churned gelato', 'waffle dessert cups']) {
  check(`default public copy omits unverified claim: ${phrase}`, !content.toLowerCase().includes(phrase) && !defaultState.toLowerCase().includes(phrase));
}
check('OG generation has no third-party font network dependency', !/fonts\.googleapis|fonts\.gstatic/.test(og));
check('OG generation uses local WebP mascot', /mascot_wave\.webp/.test(og));
check('every source-controlled brand asset reference resolves',
  missingBrandAssets.length === 0, missingBrandAssets.join('\n'));
check('the removed culture PNG survives only as an exact legacy migration input',
  (content.match(/\/brand\/mascot_sit_shake\.png/g) || []).length === 1
  && /cultureImage === '\/brand\/mascot_sit_shake\.png'[\s\S]*?cultureImage = '\/brand\/mascot_sit_shake\.webp'/.test(content));
for (const file of ['mascot_wave.png','mascot_hold_shake.png','mascot_sit_shake.png','mascot_stand.png','sticker_bunny.png','sticker_choc.png','sticker_cup.png','sticker_logo_caramel.png','sticker_m_pink.png','sticker_swirl.png']) {
  check(`redundant public asset removed: ${file}`, !existsSync(path.join(ROOT, 'public', 'brand', file)));
}
check('build loader requests the complete canonical public settings projection',
  /public_site_configuration:\s*\n\s*'id,legal_name,company_number,hq_address,email,gdpr_email,phone,website_url,brand_name,instagram_handle,instagram_url,facebook_url,twitter_url,footer_tagline,allergen_notice,announcement_enabled,announcement_text,currency_symbol,default_opening_hours,updated_at,show_careers,show_franchise,show_news'/.test(publicLoader));
check('public contract requires exact loader/view projection parity',
  publicContract.relations.some((entry) => entry.relation === 'public_site_configuration'
    && entry.loader_columns_must_match_view === true));
check('anonymous settings surface has one canonical source',
  anonSurface.anon_select_allowed.some((entry) => entry.relation === 'public_site_configuration')
  && !anonSurface.anon_select_allowed.some((entry) => entry.relation === 'site_settings')
  && anonSurface.must_never_be_anon_selectable.includes('site_settings'));
check('T13.3.12 migration closes the obsolete site_settings grant',
  /revoke select on table public\.site_settings from anon;/.test(boundaryMigration)
  && /anon still reads site_settings/.test(boundaryMigration)
  && /canonical public configuration is dark/.test(boundaryMigration));
check('public snapshot hash includes all public settings and editable site copy',
  /legalName: publicLegalName\(settings\)/.test(publicSnapshot)
  && /companyNumber: isReal\(settings\.companyNumber\) \? s\(settings\.companyNumber\) : ''/.test(publicSnapshot)
  && /allergenNotice: s\(settings\.allergenNotice\)/.test(publicSnapshot)
  && /siteContent: content/.test(publicSnapshot));
check('public snapshot hash uses safe contact and social URLs',
  /safeMailtoHref\(settings\.email\)/.test(publicSnapshot)
  && /safeTelHref\(settings\.phone\)/.test(publicSnapshot)
  && /safeExternalHref\(value\)/.test(publicSnapshot));
check('public snapshot hash covers customer-visible catalogue details',
  /priceLarge: typeof m\.priceLarge/.test(publicSnapshot)
  && /allergens: \(m\.allergens \|\| \[]\)\.map\(s\)/.test(publicSnapshot)
  && /deliveryLinks: store\.deliveryLinks \|\| \{\}/.test(publicSnapshot)
  && /content: s\(p\.content\)/.test(publicSnapshot));
check('live source no longer describes public forms as direct anonymous inserts',
  !/anon INSERT|INSERT-only/.test(cloudSync)
  && !/anon INSERT already exists|anon INSERT remains/.test(publicFormFunction));
check('public-form function documents the enforced no-direct-table boundary',
  /Anonymous callers have NO direct table privileges/.test(publicFormFunction)
  && /neither\s*\n?\/\/ {2}INSERT nor SELECT/.test(publicFormFunction));
check('public website sync panel covers both crawler and fallback content',
  /opening fallback snapshot match the live public data/.test(read('src/components/admin/SeoSyncPanel.tsx'))
  && /Record SEO refresh/.test(read('src/components/admin/SeoSyncPanel.tsx')));
check('current release note records the final three boundary migrations',
  /migration_t13310_public_boundary_cleanup\.sql/.test(read('docs/releases/T13.3.12-DEPLOYMENT-HANDOFF-FINAL.md'))
  && /migration_t13311_public_form_integrity\.sql/.test(read('docs/releases/T13.3.12-DEPLOYMENT-HANDOFF-FINAL.md'))
  && /migration_t13312_deployment_handoff\.sql/.test(read('docs/releases/T13.3.12-DEPLOYMENT-HANDOFF-FINAL.md')));
check('historical dependency disposition is archived outside the opening root',
  !existsSync(path.join(ROOT, 'D-01-DISPOSITION.md'))
  && existsSync(path.join(ROOT, 'docs/archive/D-01-DISPOSITION-R4.3.md')));
check('README points operators to the current commissioning authority', /PRODUCTION-COMMISSIONING-T13\.3\.30\.md/.test(readme) && !/current[^\n]*GATE10-RUNBOOK/i.test(readme));
check('README deploys the complete public function inventory', /all \*\*14\*\* public website\/staff Edge Functions/.test(readme) && /three POS functions absent/.test(readme));
check('routing guide documents optional SEO publication honestly', /Careers is enabled/.test(read('ROUTING-SEO.md')) && /News is enabled/.test(read('ROUTING-SEO.md')) && /Franchise is indexed only when enabled/.test(read('ROUTING-SEO.md')));
check('staging inventory describes the 14 public Edge Functions and absent POS endpoints', /All 14 public website\/staff Edge Functions deployed/.test(staging) && /none of `pos-pair`, `pos-ingest` or `pos-catalog`/.test(staging));
check('current production environment inventory is T13.3.30', /^# .*T13\.3\.30/m.test(read('PRODUCTION-ENV-AND-FUNCTION-INVENTORY.md')));
check('current commissioning file is T13.3.30', existsSync(path.join(ROOT, 'PRODUCTION-COMMISSIONING-T13.3.30.md')));

console.log(`\n${failed ? '✘' : '✔'} T13.3.17 deep opening final — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
