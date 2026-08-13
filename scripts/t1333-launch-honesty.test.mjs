#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const releaseManifest = JSON.parse(read('release-manifest.json'));
const envReleaseIdentity = read('.env.example').match(/^VITE_RELEASE_IDENTITY=(.+)$/m)?.[1]?.trim();
let pass=0, fail=0;
const check=(n,c,d='')=>{if(c){pass++;console.log(`✔ ${n}`)}else{fail++;console.error(`✘ ${n}${d?`\n  ${d}`:''}`)}};
const app=read('src/App.tsx');
const pp=read('src/components/PublicPages.tsx');
const admin=read('src/components/AdminPanel.tsx');
const mediaPanel=read('src/components/admin/MediaLibraryPanel.tsx');
const recognitionPanel=read('src/components/admin/RecognitionPanel.tsx');
const franchisePanel=read('src/components/admin/FranchisePanel.tsx');
const knowledgeBasePanel=read('src/components/admin/KnowledgeBasePanel.tsx');
const newsPanel=read('src/components/admin/NewsPanel.tsx');
const auditPanel=read('src/components/admin/AuditPanel.tsx');
const tillAdmin=read('src/components/admin/TillOrders.tsx');
const salesPanel=read('src/components/admin/SalesPanel.tsx');
const dealsPanel=read('src/components/admin/DealsPanel.tsx');
const dealsModel=read('src/components/admin/adminDeals.ts');
const checklistsPanel=read('src/components/admin/ChecklistsPanel.tsx');
const data=read('src/data.ts');
const staff=read('src/components/StaffPortal.tsx');
const staffDashboardPanel=read('src/components/staff/StaffDashboardPanel.tsx');
const staffSifrPanel=read('src/components/staff/StaffSifrPanel.tsx');
const staffDocumentsPanel=read('src/components/staff/StaffDocumentsPanel.tsx');
const staffChecklistPanel=read('src/components/staff/StaffChecklistPanel.tsx');
const staffAcademyPanel=read('src/components/staff/StaffAcademyPanel.tsx');
const academy=read('src/components/AcademyStudio.tsx');
const studio=read('src/components/admin/WebsiteStudio.tsx');
const site=read('src/siteContent.ts');
const seed=read('supabase/seed.sql');
const mig=read('supabase/migration_t1333_launch_content_honesty.sql');
const shiftMig=read('supabase/migration_t1333_shift_overlap_guard.sql');
const coverReasonMig=read('supabase/migration_t1334_cover_reason_honesty.sql');
const coverLifecycleMig=read('supabase/migration_t1335_shift_cover_lifecycle.sql');
const posCatalog=read('src/lib/posCatalog.ts');
const launchFeatures=read('src/lib/launchFeatures.ts');

check('production privacy notices start empty and dev placeholders are explicitly gated',
  /useState<PrivacyNoticeCurrent\[\]>\(\(\) =>\s*DEV_PRIVATE_SEED_CONTENT \? INITIAL_PRIVACY_NOTICES : \[\]\)/s.test(app));
for (const kind of ['careers','franchise','contact']) {
  check(`${kind} submit is disabled without its privacy notice`,
    new RegExp(`disabled=\\{sub${kind[0].toUpperCase()+kind.slice(1)}\\.pending \\|\\| !noticeFor\\('${kind}'\\)\\}`).test(pp));
}
check('contact notice is checked before Turnstile submission lock',
  pp.indexOf("const contactNotice = noticeFor('contact')") < pp.indexOf('await subContact.run'));
check('franchise notice is checked before Turnstile submission lock',
  pp.indexOf("const franchiseNotice = noticeFor('franchise')") < pp.indexOf('await subFranchise.run'));

check('menu save refuses missing or invalid business facts',
  /Enter the real product name before saving/.test(admin)
  && /Enter a valid product price of \$\{cur\}0 or more/.test(admin)
  && /Calories must be zero or a positive number/.test(admin));
check('new menu items contain no invented name, price, calories or marketing tag',
  /const freshMenuForm = \(\): Partial<MenuItem> => \(\{ name: '', category: 'milkshakes', description: '', tags: \[\], allergens: \[\] \}\)/.test(admin)
  && !/Untitled Cocktail Shake/.test(admin)
  && !/price:\s*6\.5/.test(admin.slice(admin.indexOf('const freshMenuForm'), admin.indexOf('const freshStaffForm')))
  && !/calories:\s*(420|450|500)/.test(admin.slice(admin.indexOf('const freshMenuForm'), admin.indexOf('const freshStaffForm')))
  && !/tags: \['New Added'\]/.test(admin));
check('new vacancies do not invent a department',
  /const freshVacancyForm = \(\): Partial<CareerVacancy> => \(\{ title: '', department: ''/.test(admin));


check('menu editor supports every real category plus large price and display tags',
  /const MENU_CATEGORIES: MenuItem\['category'\]\[\] = \['milkshakes', 'smoothies', 'slush', 'soft_serve', 'extras'\]/.test(admin)
  && /Large price \(£\)/.test(admin)
  && /Display tags/.test(admin)
  && /MENU_CATEGORIES\.map\(c => <option/.test(admin));
check('new deal forms do not invent quantities, money or percentages',
  /freshDealDraft/.test(dealsModel)
  && /name: ''/.test(dealsModel)
  && /description: ''/.test(dealsModel)
  && !/buyQty: 2, bundlePrice: 9/.test(dealsModel + dealsPanel)
  && /value=\{draft\.bundlePrice \?\? ''\}/.test(dealsPanel)
  && /value=\{draft\.percentOff \?\? ''\}/.test(dealsPanel));
check('recognition awards start blank and clear after a confirmed award',
  /points: number \| ''/.test(recognitionPanel)
  && /EMPTY_RECOGNITION_DRAFT/.test(recognitionPanel)
  && /setDraft\(EMPTY_RECOGNITION_DRAFT\)/.test(recognitionPanel));
check('native till catalogue never invents VAT and preserves draft state',
  /vatRateBpForProduct\?/.test(posCatalog)
  && /\?\? 0/.test(posCatalog)
  && !/vatRateBp:\s*2000/.test(posCatalog)
  && /active: Boolean\(m\.available\)/.test(posCatalog)
  && /sales:\s*\{[^}]*status: 'post_launch'/.test(launchFeatures)
  && /till:\s*\{[^}]*status: 'post_launch'/.test(launchFeatures));
check('shift-cover reason is enforced by the server and all UI mutations are locked',
  /shift_cover_reason_required/.test(coverReasonMig)
  && !/Needs cover due to a schedule clash/.test(coverReasonMig)
  && /coverFlight\.run\(`request:\$\{shiftId\}`/.test(staffDashboardPanel)
  && /coverFlight\.run\(`retract:\$\{shiftId\}`/.test(staffDashboardPanel)
  && /coverFlight\.run\(`claim:\$\{shift\.id\}`/.test(staffDashboardPanel)
  && /Withdrawing…/.test(staffDashboardPanel)
  && /Claiming…/.test(staffDashboardPanel));
check('shift creation contains no historical date fallback', !/shiftFormState\.date \|\| ['"]2026-06-01/.test(admin));
check('shift creation refuses a missing/stale employee', /That employee is no longer available/.test(admin));
check('shift creation requires date and both times', /Choose a date, start time and end time/.test(admin));

check('rota form rejects an overlapping employee shift before save',
  /shiftsList\.some\(existing => existing\.employeeId === val\.employeeId && shiftsOverlap\(existing, val\)\)/.test(admin)
  && /already has an overlapping shift/.test(admin));
check('database serialises rota writes and rejects overlap',
  /pg_advisory_xact_lock/.test(shiftMig)
  && /tstzrange\(w\.starts_at, w\.ends_at, '\[\)'\)/.test(shiftMig)
  && /shift_overlap/.test(shiftMig)
  && /trg_work_shifts_no_overlap/.test(shiftMig));

check('public allergen copy addresses every allergy/intolerance', /any food allergy or intolerance/i.test(pp) && /Cross-contact may be possible/i.test(pp));
check('default allergen copy makes no unverified ingredient-specific claim',
  /any food allergy or intolerance/i.test(data) && !/pistachios, hazelnuts/i.test(data));
check('UK-facing franchise copy contains no FDD claim', !/Franchise Disclosure \(FDD\)|formal Franchise Disclosure Document/i.test(pp+site));
check('Academy does not promise an external professional qualification', !/Acquire professional barista qualifications/i.test(staffAcademyPanel));
check('Franchise inbox does not claim to issue a licence', !/Approve License|Approved franchise license/i.test(admin));

check('Native Till Ledger states that the separate tablet app is not included',
  /native app itself is not included in this website package/i.test(tillAdmin)
  && /after that separate till application has been supplied, paired and commissioned/i.test(tillAdmin));
check('deferred Web Till remains honest and is not routed in Admin',
  !/website backup till<\/b> — searchable, refundable/i.test(salesPanel)
  && /refunds and voids are recorded through the authoritative till\/payment workflow/i.test(salesPanel)
  && !/<SalesPanel orders=\{orders\}/.test(admin)
  && /sales:\s*\{[^}]*status: 'post_launch'/.test(launchFeatures));
check('audit screen describes operational and server logs honestly',
  /Activity &amp; Access Logs/.test(auditPanel)
  && /append-only/.test(auditPanel)
  && !/Strict chronological trail ledger auditing every credential change/i.test(admin + auditPanel));

check('browser audit stream updates only after confirmed persistence',
  /appendOnly\(entry, token\)\)\.then\(\(ok\) => \{\s*if \(ok\) setAuditLogs/s.test(app));
check('production seed contains no staff procedures/training/KB publications',
  !/insert\s+into\s+(checklist_templates|training_courses|training_assessments|kb_articles)\b/i.test(seed));
check('production seed inserts catalogue unavailable and never disables it on replay',
  /insert into menu_items \(id, name, description, category, price, price_large, calories, tags, allergens, image, available\) values/i.test(seed)
  && (seed.match(/,'\/brand\/drinks\/[^']+'\s*,\s*false\)/g) || []).length >= 24
  && !/update\s+menu_items\s+set\s+available\s*=\s*false/i.test(seed)
  && /deal_two_shakes[\s\S]*?false/i.test(seed));
check('production seed uses the NOT_REGISTERED legacy VAT rate of zero and no fake announcement',
  /false, '', '£', 0,/.test(seed) && !/New strawberry milkshake has landed/i.test(seed + data));

check('production seed never overwrites existing menu business data',
  /insert into menu_items[\s\S]*?on conflict \(id\) do nothing;/i.test(seed)
  && !/on conflict \(id\) do update set name = excluded\.name/i.test(seed));
check('production seed never overwrites existing deal business data',
  /insert into deals[\s\S]*?on conflict \(id\) do nothing;/i.test(seed));
check('Company Settings cannot edit duplicate legal identity fields',
  !/onChange=\{\(e\) => setSettingsForm\(\{ \.+legalName/.test(admin)
  && /managed in <b>Launch Facts<\/b>/i.test(admin));
check('Company Settings does not claim e-mail delivery is active before commissioning',
  !/delivery is active & secured/i.test(admin)
  && /Delivery works only after the provider, verified sender and function secrets have been commissioned/i.test(admin));
check('staff onboarding has no automatic 28-day holiday default',
  !/holiday(?:Allowance|Balance):\s*28/.test(admin)
  && /pro-rated (?:contractual )?annual (?:holiday )?allowance/i.test(admin));
check('deal editor validates customer copy and each discount mechanic',
  /Add the customer-facing deal description/.test(dealsModel)
  && /A bundle deal needs a buy quantity and a positive bundle price/.test(dealsModel)
  && /Percentage discount must be between 1 and 100/.test(dealsModel)
  && /A fixed discount needs a positive amount/.test(dealsModel));
check('checklist editor trims labels and rejects duplicates within a phase',
  /const label = String\(draft\.label \|\| ''\)\.trim\(\)/.test(checklistsPanel)
  && /already exists in this shift phase/.test(checklistsPanel));
check('recognition requires a real enabled employee, points and reason',
  /employee is unavailable or disabled/i.test(recognitionPanel)
  && /between 1 and 1,000/i.test(recognitionPanel)
  && /Add a clear reason for the recognition award/i.test(recognitionPanel));

check('staff Academy has an honest empty state',
  /No training modules have been published/.test(staffAcademyPanel));
check('upgrade cleanup preserves owner-edited starter rows through full fingerprints',
  /using \(values[\s\S]*c\.label = seeded\.label[\s\S]*a\.questions = [\s\S]*::jsonb[\s\S]*k\.steps = [\s\S]*::jsonb/s.test(mig));
check('upgrade migration only neutralises publication before ACTIVE store commissioning',
  /not exists \(select 1 from stores where setup_status = 'ACTIVE'\)/.test(mig));
check('upgrade migration advances affected collection revisions',
  /update collection_revisions[\s\S]*menu_items[\s\S]*kb_articles/s.test(mig));

check('Knowledge Base has real create, edit and delete persistence paths',
  /const \[draft, setDraft\]/.test(knowledgeBasePanel)
  && /const saveArticle = async/.test(knowledgeBasePanel)
  && /publishArticles\(\(previous\)/.test(knowledgeBasePanel)
  && /openEditor\(article\)/.test(knowledgeBasePanel)
  && /deleteArticle\(article\)/.test(knowledgeBasePanel));
check('News CMS has a real draft editor instead of a dead modal button',
  /const \[draft, setDraft\]/.test(newsPanel)
  && /const savePost = async/.test(newsPanel)
  && /openEditor\(post\)/.test(newsPanel)
  && !/Submit parameters cleanly via the workflow matrix/.test(admin + newsPanel));
check('SIFR keeps entered facts on failure and never invents involved people',
  /const ok = await onAddReport\(input\)/.test(staffSifrPanel)
  && /Your form has been kept so you can retry/.test(staffSifrPanel)
  && /involvedPeople: form\.involvedPeople\.trim\(\)/.test(staffSifrPanel)
  && !/Self contribution only/.test(staffSifrPanel));
check('shift cover only accepts future scheduled shifts and preserves the allocation id',
  /shift_cover_window_closed/.test(coverLifecycleMig)
  && /starts_at <= now\(\)/.test(coverLifecycleMig)
  && /update work_shifts[\s\S]*set employee_id = v_staff/.test(coverLifecycleMig)
  && !/delete from work_shifts/.test(coverLifecycleMig));
check('shift cover claim writes an audit record using the real audit columns',
  /shift\.cover_claimed/.test(coverLifecycleMig)
  && /insert into audit_logs[\s\S]*previous_value, new_value/.test(coverLifecycleMig));
check('shift-cover requests require a real reason and are duplicate-locked',
  /at least three characters explaining why you need cover/.test(staffDashboardPanel)
  && /coverSubmittingId/.test(staffDashboardPanel)
  && !/Needs cover due to a schedule clash/.test(staffDashboardPanel));
check('staff document UI matches the server-supported formats and limit',
  /PDF, JPEG or PNG, max 10 MB/.test(staffDocumentsPanel)
  && /accept="\.pdf,image\/jpeg,image\/png"/.test(staffDocumentsPanel)
  && !/max 2\.5 MB/.test(staffDocumentsPanel));
check('Academy assignment refuses stale employees and fake operator names',
  /selected staff profile.*no longer valid/i.test(academy)
  && !/employeeName: emp\?\.name \|\| 'Team member'/.test(academy)
  && !/assignedBy: employee\?\.name \|\| 'Management'/.test(academy));
check('media uploads surface asynchronous storage/registry failures',
  /The image reached storage, but its Media Library record was not saved/.test(mediaPanel)
  && /Image upload failed/.test(mediaPanel)
  && /<MediaLibraryPanel/.test(admin)
  && /The image upload could not be added to the Media Library/.test(studio)
  && /Choose the file again before publishing this page/.test(studio));
check('franchise enquiry requires an explicit budget and makes no multi-unit promise',
  /budget: ''/.test(pp)
  && /Select a budget range/.test(pp)
  && !/Multi-Unit Area/.test(pp));
check('earnings estimate email records sent state before claiming full success',
  /const recorded = await publishPayslips/.test(admin)
  && /sent status was not recorded/.test(admin));

check('all configured Admin sections have a rendered panel', (() => {
  const navStart = admin.indexOf('const sidebarSectionsAll');
  const navEnd = admin.indexOf('const [wizardForm', navStart);
  const nav = admin.slice(navStart, navEnd > navStart ? navEnd : admin.length);
  const ids = [...nav.matchAll(/\{ id: '([^']+)'/g)].map((match) => match[1]);
  return ids.every((id) => new RegExp(`(?:effectiveActiveTab|activeTab) === ['"]${id}['"]`).test(admin));
})());
check('clock actions are duplicate-locked until the server responds',
  /const \[clockBusy, setClockBusy\]/.test(staffDashboardPanel)
  && /const clockActionsDisabled = staffDataStatus !== 'live' \|\| clockBusy/.test(staffDashboardPanel)
  && /finally \{ setClockBusy\(false\); \}/.test(staffDashboardPanel));
check('franchise workflow does not display a licence-style approval claim',
  /inquiry\.status === 'approved' \? 'SUITABLE'/.test(franchisePanel)
  && /Mark Contacted/.test(franchisePanel)
  && !/Initial screen panel scheduled/.test(admin + franchisePanel));
check('business-critical dates use the store business day rather than UTC slicing',
  /date: businessTodayISO\(\)/.test(admin)
  && /useStoreBusinessDate\(currentStore\?\.timezone(?:\s*(?:\|\||\?\?)\s*undefined)?\)/.test(staff)
  && /onUpdateTask\(businessDate/.test(staffChecklistPanel)
  && /onSubmitCategory\(businessDate/.test(staffChecklistPanel)
  && /const today = businessTodayISO\(\)/.test(read('src/components/admin/EndEmploymentDialog.tsx')));
check('Menu UI remains simple while allergen disclosure stays owner-controlled',
  /Create products, prices and images, and control what appears on the customer menu/.test(admin)
  && /in-store allergen disclosure mode/.test(studio));
check('environment template release identity matches the generated manifest',
  Boolean(envReleaseIdentity) && envReleaseIdentity === releaseManifest.release_identity,
  `${envReleaseIdentity || 'missing'} vs ${releaseManifest.release_identity}`);
console.log(`\n${fail?'✘':'✔'} T13.3.13 launch honesty — ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
