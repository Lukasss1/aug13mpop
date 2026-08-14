#!/usr/bin/env node
/**
 * AdminPanel optimisation contract.
 *
 * Runs without npm installation. It pins the low-risk decomposition rules and
 * executes the pure rota projection so future refactors cannot re-introduce
 * role-flash navigation, state-only duplicate locks, or three drifting rota
 * algorithms.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import nodeModule from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

let typescript = null;
try {
  typescript = await import('typescript');
} catch {
  // The P0 source gate intentionally runs before npm installation. Node 22's
  // built-in stripper keeps the behavioural projection executable there; on
  // Node 20 the structural contracts still run and the normal npm test run
  // supplies TypeScript from devDependencies.
}
const builtInStrip = typeof nodeModule.stripTypeScriptTypes === 'function'
  ? nodeModule.stripTypeScriptTypes.bind(nodeModule)
  : null;
let runtimeAvailable = Boolean(typescript || builtInStrip);
let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`PASS ${label}`); }
  else { failed += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

function transpile(relativePath) {
  try {
    if (typescript) {
      const ts = typescript.default || typescript;
      const result = ts.transpileModule(read(relativePath), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
        fileName: relativePath,
        reportDiagnostics: true,
      });
      const errors = (result.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error);
      check(`${relativePath} transpiles`, errors.length === 0,
        errors.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('; '));
      return result.outputText;
    }
    if (builtInStrip) {
      const stripped = builtInStrip(read(relativePath), { mode: 'transform' });
      check(`${relativePath} transpiles`, true);
      return stripped;
    }
    runtimeAvailable = false;
    console.log(`SKIP ${relativePath} runtime projection — install devDependencies to execute it on Node 20`);
    return '';
  } catch (error) {
    check(`${relativePath} transpiles`, false, error instanceof Error ? error.message : String(error));
    runtimeAvailable = false;
    return '';
  }
}

function execute(relativePath, requireMap = {}) {
  const module = { exports: {} };
  let source = transpile(relativePath);
  if (!source) return null;
  if (!typescript) {
    const exported = [];
    source = source.replace(/^import\s+\{([\s\S]*?)\}\s+from ['"]([^'"]+)['"];?$/gm, (_match, names, specifier) =>
      `const {${names}} = require(${JSON.stringify(specifier)});`);
    source = source.replace(/^export const (\w+)/gm, (_match, name) => {
      exported.push(name);
      return `const ${name}`;
    });
    source = source.replace(/^export function (\w+)\s*\(/gm, (_match, name) => {
      exported.push(name);
      return `function ${name}(`;
    });
    source += `\nmodule.exports = { ${exported.join(', ')} };\n`;
  }
  const context = vm.createContext({
    module,
    exports: module.exports,
    console,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) return requireMap[specifier];
      throw new Error(`unexpected require from ${relativePath}: ${specifier}`);
    },
  });
  new vm.Script(source, { filename: relativePath }).runInContext(context);
  return module.exports;
}


const admin = read('src/components/AdminPanel.tsx');
const app = read('src/App.tsx');
const scheduleSource = read('src/components/admin/adminSchedule.ts');
const navigationSource = read('src/components/admin/adminNavigation.ts');
const dashboardSource = read('src/components/admin/adminDashboard.ts');
const payrollSource = read('src/components/admin/adminPayroll.ts');
const analyticsSource = read('src/components/admin/adminAnalytics.ts');
const salesSource = read('src/components/admin/adminSales.ts');
const salesPanelSource = read('src/components/admin/SalesPanel.tsx');
const contactSource = read('src/components/admin/adminContact.ts');
const contactPanelSource = read('src/components/admin/ContactInboxPanel.tsx');
const dashboardPanelSource = read('src/components/admin/DashboardPanel.tsx');
const adminShellSource = read('src/components/admin/AdminShell.tsx');
const analyticsPanelSource = read('src/components/admin/AnalyticsPanel.tsx');
const checklistsSource = read('src/components/admin/adminChecklists.ts');
const checklistsPanelSource = read('src/components/admin/ChecklistsPanel.tsx');
const dealsSource = read('src/components/admin/adminDeals.ts');
const dealsPanelSource = read('src/components/admin/DealsPanel.tsx');
const sifrPanelSource = read('src/components/admin/SifrPanel.tsx');
const recognitionPanelSource = read('src/components/admin/RecognitionPanel.tsx');
const franchisePanelSource = read('src/components/admin/FranchisePanel.tsx');
const knowledgeBasePanelSource = read('src/components/admin/KnowledgeBasePanel.tsx');
const newsPanelSource = read('src/components/admin/NewsPanel.tsx');
const auditPanelSource = read('src/components/admin/AuditPanel.tsx');
const timesheetsPanelSource = read('src/components/admin/TimesheetsPanel.tsx');
const compliancePanelSource = read('src/components/admin/CompliancePanel.tsx');
const mediaLibraryPanelSource = read('src/components/admin/MediaLibraryPanel.tsx');
const careersPanelSource = read('src/components/admin/CareersPanel.tsx');
const singleFlightSource = read('src/hooks/useSingleFlight.ts');
const clientIdSource = read('src/lib/clientId.ts');
const businessDateSource = read('src/lib/businessDate.ts');
const imageUploadSource = read('src/components/ImageUploadInline.tsx');
const websiteStudioSource = read('src/components/admin/WebsiteStudio.tsx');
const inboxStatusSource = read('src/components/admin/InboxStatusBar.tsx');
const permissionsSource = read('src/components/admin/PermissionsPanel.tsx');
const publicationControlsSource = read('src/components/admin/PublicationControls.tsx');
const applicationTransitionSql = read('supabase/migration_inc11_application_transitions.sql');
const publicationScopeSql = read('supabase/migration_inc11_publication_scope.sql');
const cvSignedUrlSource = read('supabase/functions/cv-signed-url/index.ts');

const removedProps = [
  'onDeleteEmployee', 'cmsPages', 'onSaveSiteContent', 'rolePermissions', 'publishRolePermissions',
  'courses', 'publishCourses', 'onUpdateOrderStatus', 'setCloudStatus',
];
for (const prop of removedProps) {
  const interfaceSlice = admin.slice(admin.indexOf('interface AdminPanelProps'), admin.indexOf('export type InboxStatus'));
  const appInvocation = app.slice(app.indexOf('<AdminPanel'), app.indexOf('/>', app.indexOf('<AdminPanel')));
  check(`dead Admin prop removed: ${prop}`, !new RegExp(`\\b${prop}\\b`).test(interfaceSlice + appInvocation));
}

check('read-only and inbox UI are extracted from the Admin controller',
  /<PermissionsPanel \/>/.test(admin)
  && /<CareersPanel/.test(admin)
  && /<InboxStatusBar/.test(careersPanelSource)
  && /Permissions Reference/.test(permissionsSource)
  && /export type InboxStatus/.test(inboxStatusSource));
check('shared editor accepts only its four real entity types',
  /type EntityFormType = 'menu' \| 'store' \| 'staff' \| 'vacancy';/.test(admin)
  && !/setFormType\('shift'\)/.test(admin));
check('section access is resolved before panels render',
  /const effectiveActiveTab = canOpenAdminSection\(activeTab\) \? activeTab : 'dashboard';/.test(admin)
  && !/\{activeTab === ['"]/.test(admin));
check('all navigation passes through the role-validating setter',
  /const next = canOpenAdminSection\(id\) \? id : 'dashboard';/.test(admin));
check('global search cannot offer owner-only sections to managers',
  /canOpenSection\('cms'\)/.test(adminShellSource)
  && /canOpenSection\('stores'\)/.test(adminShellSource)
  && /No accessible records match this search/.test(adminShellSource)
  && /canOpenSection=\{canOpenAdminSection\}/.test(admin));
check('admin chrome owns search and disclosure state outside the workflow controller',
  /React\.memo\(function AdminShell/.test(adminShellSource)
  && /const \[query, setQuery\]/.test(adminShellSource)
  && /const \[isSidebarCollapsed, setIsSidebarCollapsed\]/.test(adminShellSource)
  && !/globalSearch|isSidebarCollapsed|advancedOpen/.test(admin));
check('general mutations use a synchronous ref lock',
  /if \(mutBusyRef\.current\) return;\s*mutBusyRef\.current = true;/.test(admin)
  && /finally \{\s*mutBusyRef\.current = false;/.test(admin));
check('CV, document and activity-log reads use synchronous locks',
  /if \(cvLoadingRef\.current\) return;/.test(admin)
  && /if \(docOpeningRef\.current\) return;/.test(admin)
  && /useSingleFlight\(\)/.test(auditPanelSource)
  && /audit:load-access-log/.test(auditPanelSource));
check('wizard, VAT, e-mail and business dialogs use synchronous locks',
  /if \(wizardBusyRef\.current\) return;/.test(admin)
  && /if \(classifyBusyRef\.current\) return;/.test(admin)
  && /if \(emailBusyRef\.current\) return;/.test(admin)
  && /if \(businessDialogBusyRef\.current\) return;/.test(admin));
check('cloud refreshes preserve unsaved company and e-mail drafts',
  /previousEmailSettingsRef/.test(admin)
  && /previousSiteSettingsRef/.test(admin)
  && /JSON\.stringify\(current\) === JSON\.stringify\(previousSource\) \?/.test(admin));
check('selected staff drawer refreshes from authoritative employee data',
  /employeesById\.get\(selectedStaffUser\.id\)/.test(admin)
  && /new Map\(employeesList\.map/.test(admin));
check('staff drawer and long lists reuse memoized projections',
  /const selectedStaffShifts = useMemo/.test(admin)
  && /const selectedStaffClockRows = useMemo/.test(admin)
  && /const enabledEmployees = useMemo/.test(admin)
  && /const sortedPayslips = useMemo/.test(admin)
  && !/shiftsList\.filter\(s => s\.employeeId === selectedStaffUser\.id\)/.test(admin)
  && !/clockHistory\.filter\(ch => ch\.employeeId === selectedStaffUser\.id\)/.test(admin)
  && !/\[\.\.\.payslips\]\.sort/.test(admin.slice(admin.indexOf('return ('), admin.length)));
check('store identity and active-store defaults use shared indexes',
  /const storesById = useMemo/.test(admin)
  && /const activeStaffStores = useMemo/.test(admin)
  && /const singleActiveStaffStore = activeStaffStores\.length === 1/.test(admin)
  && /setStaffFormState\(freshStaffForm\(\)\)/.test(admin)
  && !/stores\.find\(/.test(admin));
check('all three rota views use one projection',
  /buildRotaScheduleModel/.test(admin)
  && /getRotaCell\(rotaModel/.test(admin)
  && /rotaModel\.weekSummaries/.test(admin)
  && /rotaModel\.dates/.test(admin));
check('old repeated rota grouping algorithms are gone',
  !/const getWeekString =/.test(admin)
  && !/Array\.from\(new Set\(shiftsList\.map/.test(admin)
  && !/empShifts\.filter\(s => s\.date/.test(admin));
check('weekly matrix row identity no longer depends on a duplicateable name',
  /<tr key=\{stat\.employeeId\}/.test(admin) && !/<tr key=\{stat\.name\}/.test(admin));
check('navigation is derived outside the controller from the launch registry',
  /buildAdminNavigation\(currentRole, navigationBadges/.test(admin)
  && !/sidebarSectionsAll/.test(admin)
  && /ADMIN_FEATURES/.test(navigationSource)
  && /ADMIN_NAV_ORDER/.test(navigationSource));
check('post-launch Staff Reviews has no hidden render branch',
  !/effectiveActiveTab === ['"]performance['"]/.test(admin)
  && !/see the Staff Reviews tab/.test(admin));
check('opening facts include the server-confirmed store setup overlay',
  /buildAdminOpeningSummary\(stores, setupOverlay, menuItems, siteSettings\)/.test(admin)
  && /\.\.\.setupOverlay\[store\.id\]/.test(dashboardSource));
check('earnings generation and preview share one period projection',
  /buildAdminPayrollPeriod\(employeesList, clockHistory, payslips, payslipMonth\)/.test(admin)
  && /payrollPeriod\.rows\.forEach/.test(admin)
  && /payrollPeriod\.rows\.map/.test(admin)
  && !/approvedHoursFor/.test(admin));
check('shift deletion is one single-flight workflow across all rota views',
  /deleteShiftWithFeedback/.test(admin)
  && (admin.match(/deleteShiftWithFeedback\(/g) || []).length === 3
  && (admin.match(/onDeleteShift\(/g) || []).length === 1);
check('timesheet decisions use synchronous single-flight keys',
  /timesheet:approve:\$\{id\}/.test(admin)
  && /timesheet:reject:\$\{id\}/.test(admin)
  && /timesheet:approve-all/.test(admin));

check('Admin-created row IDs are collision-resistant rather than timestamp-only',
  /createClientId\('aud'\)/.test(admin)
  && /createClientId\('m'\)/.test(admin)
  && /createClientId\('emp'\)/.test(admin)
  && !/Date\.now\(\)/.test(admin)
  && /createClientId\('media'\)/.test(websiteStudioSource)
  && /randomUUID/.test(clientIdSource));
check('media upload state is isolated behind the shared synchronous lock',
  /<MediaLibraryPanel/.test(admin)
  && /React\.memo\(function MediaLibraryPanel/.test(mediaLibraryPanelSource)
  && /useSingleFlight\(\)/.test(mediaLibraryPanelSource)
  && /run\('media:upload'/.test(mediaLibraryPanelSource)
  && !/mediaUploading|mediaUploadingRef/.test(admin));
check('Careers presentation is extracted while guarded workflows stay in AdminPanel',
  /<CareersPanel/.test(admin)
  && /React\.memo\(function CareersPanel/.test(careersPanelSource)
  && /onTransitionApplication=\{transitionApplicationWithFeedback\}/.test(admin)
  && /onCloseVacancy=\{closeVacancyWithFeedback\}/.test(admin)
  && /onDeleteVacancy=\{deleteVacancyWithFeedback\}/.test(admin)
  && /withBusy\(`candidate:\$\{app\.id\}`/.test(admin)
  && /withBusy\(`vacancy:close:\$\{vacancy\.id\}`/.test(admin)
  && !/Careers Vacancy & Recruitment|Candidate Applications Registry/.test(admin));
check('late inline image uploads cannot write into a remounted or reused editor',
  /mountedRef\.current = false/.test(imageUploadSource)
  && /if \(!mountedRef\.current\) return;/.test(imageUploadSource)
  && /if \(!file \|\| busyRef\.current\) return;/.test(imageUploadSource)
  && /const menuFormSession = menuFormSessionRef\.current;/.test(admin)
  && /key=\{`menu-image-\$\{menuFormSession\}`\}/.test(admin)
  && /session: menuFormSession/.test(admin));
check('the shared entity editor cannot close while its save lock is held',
  /if \(busyRef\.current === 'form-save'\) return;/.test(admin)
  && /onClick=\{closeEntityForm\} disabled=\{entityFormSaving\}/.test(admin));
check('staff pay edits share one validated single-flight workflow',
  /staff:pay:\$\{target\.id\}/.test(admin)
  && /Pay rate must be a positive number/.test(admin)
  && /staffFormState\.payRate <= 0/.test(admin)
  && !/onChange=\{async \(e\) => \{\s*const updated = \{ \.\.\.selectedStaffUser, payType/.test(admin));
check('deferred Sales source remains extracted and timezone-safe without a launch render',
  !/<SalesPanel orders=\{orders\}/.test(admin)
  && /React\.memo\(function SalesPanel/.test(salesPanelSource)
  && /buildAdminSalesModel\(orders, stores, statusFilter, channelFilter\)/.test(salesPanelSource)
  && /businessDateISOAt/.test(salesSource)
  && /msUntilNextBusinessDay/.test(salesPanelSource)
  && /setBusinessDayRevision/.test(salesPanelSource)
  && !/toDateString\(\)/.test(salesPanelSource));
check('Sales presentation state no longer re-renders the Admin controller',
  !/salesFilterStatus|salesFilterChannel|expandedOrderId|salesDayRevision/.test(admin)
  && /const \[statusFilter, setStatusFilter\]/.test(salesPanelSource)
  && /const \[expandedOrderId, setExpandedOrderId\]/.test(salesPanelSource));
check('Sales panel retains read-only financial boundaries and accessible filters',
  /Refund — on the till only/.test(salesPanelSource)
  && /Void — on the till only/.test(salesPanelSource)
  && /aria-label="Filter web orders by status"/.test(salesPanelSource)
  && /aria-expanded=\{expanded\}/.test(salesPanelSource));
check('mailbox presentation state is extracted and its projection remains centralized',
  /<ContactInboxPanel/.test(admin)
  && /React\.memo\(function ContactInboxPanel/.test(contactPanelSource)
  && /buildAdminContactMailbox\(messages, filter\)/.test(contactPanelSource)
  && /mailbox\.visibleMessages/.test(contactPanelSource)
  && !/contactFilter|contactMailbox/.test(admin));
check('contact status mutations remain in the guarded Admin controller',
  /withBusy\(`contact:\$\{status\}:\$\{message\.id\}`/.test(admin)
  && /onStatusChange=\{updateContactStatusWithFeedback\}/.test(admin)
  && !/onUpdateContactStatus/.test(contactPanelSource));
check('deal and checklist editor state is extracted from the Admin controller',
  /<DealsPanel/.test(admin)
  && /<ChecklistsPanel/.test(admin)
  && !/dealForm|editingDealId|checklistForm|editingChecklistId|checklistGroups/.test(admin)
  && /React\.memo\(function DealsPanel/.test(dealsPanelSource)
  && /React\.memo\(function ChecklistsPanel/.test(checklistsPanelSource));
check('checklist repeated filters are centralized',
  /buildAdminChecklistGroups\(templates\)/.test(checklistsPanelSource)
  && /groups\[category\]\.items/.test(checklistsPanelSource));
check('extracted CRUD panels use a shared synchronous single-flight hook',
  /useSingleFlight\(\)/.test(dealsPanelSource)
  && /useSingleFlight\(\)/.test(checklistsPanelSource)
  && /activeRef\.current/.test(singleFlightSource)
  && /if \(activeRef\.current\) return/.test(singleFlightSource));
check('deal drafts are canonicalised before persistence',
  /normaliseDealDraft\(draft\)/.test(dealsPanelSource)
  && /Only fields used by the selected/.test(dealsSource)
  && !/normalisedDeal = \{ \.\.\.dealForm/.test(admin));

check('SIFR and franchise presentation are extracted without moving guarded mutations',
  /<SifrPanel/.test(admin)
  && /<FranchisePanel/.test(admin)
  && /React\.memo\(function SifrPanel/.test(sifrPanelSource)
  && /React\.memo\(function FranchisePanel/.test(franchisePanelSource)
  && /onResolve=\{resolveSifrWithFeedback\}/.test(admin)
  && /onStatusChange=\{updateFranchiseStatusWithFeedback\}/.test(admin)
  && /withBusy\(`sifr:resolve:\$\{report\.id\}`/.test(admin)
  && /withBusy\(`franchise:\$\{inquiry\.id\}`/.test(admin));
check('recognition draft and lock are isolated from the Admin controller',
  /<RecognitionPanel/.test(admin)
  && /React\.memo\(function RecognitionPanel/.test(recognitionPanelSource)
  && /useSingleFlight\(\)/.test(recognitionPanelSource)
  && /recognition:award/.test(recognitionPanelSource)
  && /employeesById/.test(recognitionPanelSource)
  && !/recognitionForm|setRecognitionForm/.test(admin));
check('recognition validation and audit semantics remain explicit',
  /whole number between 1 and 1,000/.test(recognitionPanelSource)
  && /unavailable or disabled/.test(recognitionPanelSource)
  && /Add a clear reason/.test(recognitionPanelSource)
  && /Math\.floor\(points \/ 400\) \+ 1/.test(recognitionPanelSource)
  && /logAction\('Recognition Desk'/.test(recognitionPanelSource));

check('Knowledge Base and News editors own their local drafts and locks',
  /<KnowledgeBasePanel/.test(admin)
  && /<NewsPanel/.test(admin)
  && /React\.memo\(function KnowledgeBasePanel/.test(knowledgeBasePanelSource)
  && /React\.memo\(function NewsPanel/.test(newsPanelSource)
  && /useSingleFlight\(\)/.test(knowledgeBasePanelSource)
  && /useSingleFlight\(\)/.test(newsPanelSource)
  && !/articleForm|announcementForm|articleEditorOpen|newsEditorOpen/.test(admin));
check('SOP and news persistence semantics remain server-first and publication stays RPC-owned',
  /publishArticles\(\(previous\)/.test(knowledgeBasePanelSource)
  && /createClientId\('kb'\)/.test(knowledgeBasePanelSource)
  && /businessTodayISO\(\)/.test(knowledgeBasePanelSource)
  && /publishPosts\(\(previous\)/.test(newsPanelSource)
  && /createClientId\('news'\)/.test(newsPanelSource)
  && /onTogglePublication/.test(newsPanelSource)
  && !/onPublishRecord/.test(newsPanelSource));

check('audit log loading state is isolated and owner-gated outside the Admin controller',
  /<AuditPanel/.test(admin)
  && /React\.memo\(function AuditPanel/.test(auditPanelSource)
  && /currentRole === 'owner'/.test(auditPanelSource)
  && /listActivityLog\(token, 200\)/.test(auditPanelSource)
  && /append-only/.test(auditPanelSource)
  && !/accessLog|accessLogLoading|loadAccessLog/.test(admin));

check('timesheet projection and compliance presentation are memoized outside the controller',
  /<TimesheetsPanel/.test(admin)
  && /<CompliancePanel/.test(admin)
  && /React\.memo\(function TimesheetsPanel/.test(timesheetsPanelSource)
  && /React\.memo\(function CompliancePanel/.test(compliancePanelSource)
  && /buildTimesheetSections\(clockHistory\)/.test(timesheetsPanelSource)
  && /onApproveAll=\{handleApproveAllTimesheets\}/.test(admin));
check('timesheet and vault security mutations remain guarded in AdminPanel',
  /timesheet:approve:\$\{id\}/.test(admin)
  && /timesheet:reject:\$\{id\}/.test(admin)
  && /timesheet:approve-all/.test(admin)
  && /document:approve:\$\{document\.id\}/.test(admin)
  && /docOpeningRef\.current/.test(admin)
  && /onDeleteDocument\(document\.id\)/.test(admin)
  && !/onApproveDocument|onDeleteDocument|getStaffDocumentUrl/.test(compliancePanelSource));

check('admin route callbacks are stable and routing effects declare their dependencies',
  /const handleAdminSectionChange = useCallback/.test(app)
  && /onSectionChange=\{handleAdminSectionChange\}/.test(app)
  && /onRefreshPublicContent=\{refreshPublicContent\}/.test(app)
  && /const canOpenAdminSection = useCallback/.test(admin)
  && /\[activeTab, effectiveActiveTab, onSectionChange\]/.test(admin)
  && /\[activeSection, activeTab, canOpenAdminSection, onSectionChange\]/.test(admin));
check('dashboard cards, badges and recruitment chart share one status projection',
  /buildAdminDashboardMetrics/.test(admin)
  && /metrics\.dashboardMessageCount/.test(dashboardPanelSource)
  && /recruitmentBars\.map/.test(analyticsPanelSource)
  && /<DashboardPanel/.test(admin)
  && /<AnalyticsPanel/.test(admin)
  && !admin.includes("inquiry.status === 'new'"));
check('training analytics are a pure roster model rather than certificate-row arithmetic in JSX',
  /buildAdminTrainingCompletionRows/.test(admin)
  && /trainingCompletionRows\.map/.test(analyticsPanelSource)
  && !/trainingCertificates\.filter\(tc => tc\.assessmentId/.test(admin + analyticsPanelSource)
  && /completedByAssessment/.test(analyticsSource));
check('dashboard and analytics presentation are memoized outside the controller',
  /React\.memo\(function DashboardPanel/.test(dashboardPanelSource)
  && /React\.memo\(function AnalyticsPanel/.test(analyticsPanelSource)
  && !/Milk Pop Dashboard|Business Analytics/.test(admin));
check('incident badges, alerts and action controls share the full open-status rule',
  /isSifrOpenStatus\(report\.status\)/.test(admin)
  && /isSifrOpenStatus\(report\.status\)/.test(sifrPanelSource)
  && /openIncidents = sifrReports\.filter\(\(item\) => isSifrOpenStatus\(item\.status\)\)/.test(dashboardSource)
  && !admin.includes("sifrReports.filter(s => s.status === 'submitted')")
  && !admin.includes("sifrReports.filter(sr => sr.status === 'submitted')"));
check('dashboard aggregates are projected through the same role policy as navigation',
  /canRoleOpenAdminSection\('contact'\) \? contactMessages : \[\]/.test(admin)
  && /canRoleOpenAdminSection\('franchise'\) \? franchiseInquiries : \[\]/.test(admin)
  && /canRoleOpenAdminSection\('careers'\) \? applications : \[\]/.test(admin));
check('dashboard setup and quick actions cannot navigate to sections hidden from the current role',
  /openingSetupItems = useMemo/.test(admin)
  && /\.filter\(\(item\) => canOpenAdminSection\(item\.tab\)\)/.test(admin)
  && /dashboardQuickActions = useMemo/.test(admin)
  && /\.filter\(\(action\) => canOpenAdminSection\(action\.tab\)\)/.test(admin)
  && /canViewAuditFeed = canOpenAdminSection\('audit'\)/.test(admin));
check('destructive and lifecycle actions use named single-flight workflows',
  ['store:delete:', 'store:${status}:', 'menu:delete:', 'document:approve:', 'sifr:resolve:', 'contact:${status}:', 'vacancy:delete:',
   'payslip:generate:', 'payslip:delete:']
    .every((key) => admin.includes(key))
  && ['deal:save', 'deal:delete:'].every((key) => dealsPanelSource.includes(key))
  && ['news-save', 'news-delete:'].every((key) => newsPanelSource.includes(key))
  && ['kb-save', 'kb-delete:'].every((key) => knowledgeBasePanelSource.includes(key))
  && ['checklist:delete:', 'checklist:save'].every((key) => checklistsPanelSource.includes(key))
  && /deleteStoreWithFeedback/.test(admin)
  && /deleteMenuItemWithFeedback/.test(admin)
  && /approveDocumentWithFeedback/.test(admin)
  && /resolveSifrWithFeedback/.test(admin)
  && /updateContactStatusWithFeedback/.test(admin)
  && /deleteVacancyWithFeedback/.test(admin));
const applicationTransitionSlice = admin.slice(
  admin.indexOf('const transitionApplicationWithFeedback'),
  admin.indexOf('const deleteStoreWithFeedback'),
);
check('terminal application decisions have exactly one server audit/outbox owner',
  /insert into audit_logs/.test(applicationTransitionSql)
  && /insert into notification_outbox/.test(applicationTransitionSql)
  && /p_to_status in \('offer', 'declined'\)/.test(applicationTransitionSql)
  && !/logAction\(/.test(applicationTransitionSlice)
  && !/applicationOffer/.test(applicationTransitionSlice)
  && !/applicationDeclined/.test(applicationTransitionSlice)
  && /applicationInterview/.test(applicationTransitionSlice));
const publicationSlice = admin.slice(admin.indexOf('const publishOne'), admin.indexOf('const [setupWizardStore'));
const closeVacancySlice = admin.slice(admin.indexOf('const closeVacancyWithFeedback'), admin.indexOf('const deleteVacancyWithFeedback'));
check('publication and vacancy lifecycle audit is not duplicated in the browser',
  (publicationScopeSql.match(/insert into audit_logs/g) || []).length >= 2
  && !/logAction\(/.test(publicationSlice)
  && !/logAction\(/.test(closeVacancySlice));
check('extracted read-only panels are memoized and keep static data outside render',
  /React\.memo\(function InboxStatusBar/.test(inboxStatusSource)
  && /const INBOX_STATUS_STYLES/.test(inboxStatusSource)
  && /React\.memo\(function PermissionsPanel/.test(permissionsSource)
  && /export const PERMISSION_REFERENCE/.test(permissionsSource));
const inlineAsyncHandlers = admin.match(/onClick=\{async \(\) => \{/g) || [];
check('no new unclassified inline async click workflows are introduced',
  inlineAsyncHandlers.length === 3
  && /wizardBusyRef\.current/.test(admin)
  && /classifyBusyRef\.current/.test(admin)
  && (admin.match(/await withMutationBusy/g) || []).length >= 2
  && /recognition:award/.test(recognitionPanelSource));
check('publication controls are extracted as stable stateless components',
  /import \{ PublicationBadge, PublishButton \}/.test(admin)
  && !/const PublicationBadge/.test(admin)
  && !/const PublishButton/.test(admin)
  && /React\.memo\(function PublicationBadge/.test(publicationControlsSource)
  && /React\.memo\(function PublishButton/.test(publicationControlsSource)
  && /const publishOne = useCallback/.test(admin)
  && /const withBusy = useCallback/.test(admin));
check('document and incident buttons call the guarded lifecycle helpers only',
  (admin.match(/onApproveDocument\(/g) || []).length === 1
  && (admin.match(/onResolveSIFRReport\(/g) || []).length === 1
  && /onApprove=\{approveDocumentWithFeedback\}/.test(admin)
  && /onApprove\(document\)/.test(compliancePanelSource)
  && /onResolve=\{resolveSifrWithFeedback\}/.test(admin)
  && /onResolve\(report\)/.test(sifrPanelSource));
const cvOpenSlice = admin.slice(admin.indexOf('const handleViewCv'), admin.indexOf('// Shared identity indexes'));
check('CV access has one server-derived audit owner',
  /activity_log/.test(cvSignedUrlSource)
  && /granted or refused/.test(cvSignedUrlSource)
  && !/logAction\(/.test(cvOpenSlice));
check('irreversible admin actions ask once before the guarded mutation',
  /Delete \$\{shift\.employeeName\}'s shift/.test(admin)
  && /Sign off "\$\{document\.name\}" as reviewed/.test(admin)
  && /Mark incident "\$\{report\.title\}" as resolved/.test(admin));

if (runtimeAvailable) {
  const pay = execute('src/lib/pay.ts', { '../types': {} });
  const schedule = execute('src/components/admin/adminSchedule.ts', {
    '../../types': {},
    '../../lib/pay': pay,
  });
  const launchFeatures = execute('src/lib/launchFeatures.ts');
  const iconNames = ['AlertTriangle', 'Award', 'BarChart2', 'BookOpen', 'Briefcase', 'Building', 'Calendar',
    'Clock', 'Database', 'FileSpreadsheet', 'FileText', 'Globe', 'HardDrive', 'Inbox', 'Layers', 'ListChecks',
    'Mail', 'Percent', 'Receipt', 'Settings', 'Shield', 'ShieldCheck', 'Star', 'Users', 'Volume2'];
  const navigation = execute('src/components/admin/adminNavigation.ts', {
    'lucide-react': Object.fromEntries(iconNames.map((name) => [name, name])),
    '../../types': {},
    '../../lib/launchFeatures': launchFeatures,
  });
  const dashboard = execute('src/components/admin/adminDashboard.ts', {
    '../../types': {},
    '../../lib/publishRules': {
      hasRealStoreIdentity: (store) => Boolean(store.name && store.address && store.postcode),
      isPublishableMenuItem: (item) => Boolean(item.name && item.description),
    },
    '../../lib/safeUrl': {
      safeMailtoHref: (value) => String(value || '').includes('@') ? `mailto:${value}` : null,
      safeTelHref: (value) => String(value || '').replace(/\D/g, '').length >= 7 ? `tel:${value}` : null,
    },
  });
  const payroll = execute('src/components/admin/adminPayroll.ts', {
    '../../types': {},
    '../../lib/pay': pay,
  });
  const analytics = execute('src/components/admin/adminAnalytics.ts', {
    '../../types': {},
  });
  const businessDate = execute('src/lib/businessDate.ts');
  const sales = execute('src/components/admin/adminSales.ts', {
    '../../types': {},
    '../../lib/businessDate': businessDate,
  });
  const contact = execute('src/components/admin/adminContact.ts', {
    '../../types': {},
  });
  const checklists = execute('src/components/admin/adminChecklists.ts', {
    '../../types': {},
  });
  const dealDrafts = execute('src/components/admin/adminDeals.ts', {
    '../../types': {},
  });
  const clientIds = execute('src/lib/clientId.ts');
  const employee = (id, name, payRate, payType = 'hourly') => ({
    id, name, email: `${id}@example.invalid`, role: 'team_member', storeId: 'store-1', storeName: 'Store 1',
    nextShift: '', holidayBalance: 0, points: 0, level: 1, badges: [], avatar: '', payRate, payType,
  });
  const shift = (id, employeeId, employeeName, date, startTime, endTime) => ({
    id, employeeId, employeeName, role: 'team_member', storeId: 'store-1', storeName: 'Store 1',
    date, startTime, endTime, type: 'mid', notes: '',
  });
  const employees = [employee('e1', 'Alex', 12), employee('e2', 'Alex', 31200, 'salary'), employee('e3', 'No Rate')];
  const shifts = [
    shift('s2', 'e1', 'Alex', '2026-08-04', '18:00', '02:00'),
    shift('s1', 'e1', 'Alex', '2026-08-03', '09:00', '17:00'),
    shift('s3', 'e2', 'Alex', '2026-08-03', '10:00', '18:00'),
    shift('s4', 'e3', 'No Rate', '2026-08-03', '11:00', '15:00'),
  ];
  const model = schedule.buildRotaScheduleModel(shifts, employees);
  check('overnight shift duration is preserved', schedule.shiftDurationHours('18:00', '02:00') === 8);
  check('week summaries retain separate employees with the same name',
    model.weekSummaries[0]?.employees.length === 3
    && new Set(model.weekSummaries[0]?.employees.map((item) => item.employeeId)).size === 3);
  check('rota labour totals retain hourly, salary and unpriced semantics',
    model.weekSummaries[0]?.totalHours === 28
    && model.weekSummaries[0]?.totalCost === 792
    && model.weekSummaries[0]?.unpricedStaff.join(',') === 'No Rate');
  check('monthly dates and cells are deterministic',
    model.dates.join(',') === '2026-08-03,2026-08-04'
    && schedule.getRotaCell(model, 'e1', '2026-08-03').map((item) => item.id).join(',') === 's1');
  const weekWindow = schedule.buildRotaWeekWindow(0, '2026-08-05');
  check('displayed week is Monday through Sunday',
    weekWindow.isos[0] === '2026-08-03' && weekWindow.isos[6] === '2026-08-09');
  check('schedule module keeps the shared annual salary helper', /weeklyFixedSalaryCost/.test(scheduleSource));
  check('schedule overlap projection handles adjacent and overnight shifts',
    schedule.shiftsOverlap(
      shift('a', 'e1', 'Alex', '2026-08-03', '18:00', '02:00'),
      shift('b', 'e1', 'Alex', '2026-08-04', '01:00', '03:00'),
    ) === true
    && schedule.shiftsOverlap(
      shift('c', 'e1', 'Alex', '2026-08-03', '09:00', '17:00'),
      shift('d', 'e1', 'Alex', '2026-08-03', '17:00', '18:00'),
    ) === false);

  check('business date conversion honours the store timezone at the BST boundary',
    businessDate.businessDateISOAt('2026-08-02T23:30:00Z', 'Europe/London') === '2026-08-03'
    && businessDate.businessDateISOAt('2026-08-02T23:30:00Z', 'America/New_York') === '2026-08-02'
    && businessDate.businessDateISOAt('not-a-date', 'Europe/London') === '');
  const invalidZoneDelay = businessDate.msUntilNextBusinessDay('Not/A-Timezone');
  check('invalid stale timezone data cannot crash the day-boundary scheduler',
    businessDate.businessDateISOAt('2026-08-03T10:00:00Z', 'Not/A-Timezone') === '2026-08-03'
    && Number.isFinite(invalidZoneDelay)
    && invalidZoneDelay >= 1_000
    && invalidZoneDelay <= (26 * 60 * 60 * 1_000) + 2_000);

  const order = (id, storeId, placedAt, status, total, itemId, itemName, quantity = 1) => ({
    id, orderNumber: Number(id.replace(/\D/g, '')) || 1, storeId, storeName: storeId,
    channel: 'walk_in', items: [{ id: `${id}-line`, menuItemId: itemId, name: itemName,
      category: 'milkshakes', size: 'regular', unitPrice: total, quantity, modifiers: [], lineTotal: total }],
    appliedDeals: [], subtotal: total, discountTotal: 0, taxRate: 0, taxAmount: 0, total,
    paymentMethod: 'card', status, staffId: 'e1', staffName: 'Alex', placedAt,
  });
  const salesModel = sales.buildAdminSalesModel(
    [
      order('o1', 'london', '2026-08-02T23:30:00Z', 'completed', 6, 'p1', 'Classic'),
      order('o2', 'london', '2026-08-03T08:00:00Z', 'completed', 8, 'p2', 'Classic', 2),
      order('o3', 'london', 'invalid', 'completed', 10, 'p3', 'Invalid date'),
      order('o4', 'london', '2026-08-03T09:00:00Z', 'refunded', 5, 'p4', 'Refunded'),
      order('o5', 'london', '2026-08-03T09:00:00Z', 'voided', 4, 'p5', 'Voided'),
    ],
    [{ id: 'london', timezone: 'Europe/London' }],
    'all', 'all', new Date('2026-08-03T10:00:00Z'),
  );
  check('sales projection counts completed revenue in each store business day',
    salesModel.completedTodayCount === 2
    && salesModel.completedCount === 3
    && salesModel.revenueToday === 14
    && salesModel.revenueAll === 24
    && salesModel.refundedCount === 1
    && salesModel.voidedCount === 1);
  check('top sellers retain product identity when names are duplicated',
    salesModel.topProducts.length === 3
    && salesModel.topProducts[0]?.menuItemId === 'p2'
    && new Set(salesModel.topProducts.map((item) => item.menuItemId)).size === 3);
  check('order timestamps render in the store timezone and fail safely when malformed',
    salesModel.placedAtLabels.get('o1')?.includes('03 Aug') === true
    && salesModel.placedAtLabels.get('o3') === 'Time unavailable');

  const mailbox = contact.buildAdminContactMailbox([
    { id: 'm1', status: 'new' }, { id: 'm2', status: 'replied' }, { id: 'm3', status: 'closed' },
  ], 'new');
  check('mailbox projection counts once and filters without changing source order',
    mailbox.counts.all === 3 && mailbox.counts.new === 1
    && mailbox.visibleMessages.map((item) => item.id).join(',') === 'm1');

  const checklistModel = checklists.buildAdminChecklistGroups([
    { id: 'b', label: 'B', category: 'opening', critical: false, sortOrder: 1 },
    { id: 'a', label: 'A', category: 'opening', critical: false, sortOrder: 1 },
    { id: 'c', label: 'C', category: 'closing', critical: true, sortOrder: 4 },
  ]);
  check('checklist projection is deterministic and computes the next order once',
    checklistModel.opening.items.map((item) => item.id).join(',') === 'a,b'
    && checklistModel.opening.nextSortOrder === 2
    && checklistModel.closing.nextSortOrder === 5);

  const bundleDraft = dealDrafts.normaliseDealDraft({
    name: '  Family combo  ', description: '  Two drinks  ', badge: '  1+1  ',
    type: 'bundle_price', category: 'milkshakes', buyQty: 2, bundlePrice: 9,
    percentOff: 40, amountOff: 3, minOrderValue: 10, active: true,
  });
  const fixedDraft = dealDrafts.normaliseDealDraft({
    name: 'Order reward', description: 'Save on a larger order', type: 'fixed_off_order',
    amountOff: 2.5, minOrderValue: 15, category: 'smoothies', buyQty: 4, active: false,
  });
  check('deal canonicalisation removes fields from inactive mechanics',
    bundleDraft.ok === true
    && bundleDraft.value.name === 'Family combo'
    && bundleDraft.value.badge === '1+1'
    && bundleDraft.value.buyQty === 2
    && !('percentOff' in bundleDraft.value)
    && !('amountOff' in bundleDraft.value)
    && fixedDraft.ok === true
    && fixedDraft.value.amountOff === 2.5
    && !('category' in fixedDraft.value)
    && !('buyQty' in fixedDraft.value));
  check('deal canonicalisation rejects fractional quantities and invalid discounts',
    dealDrafts.normaliseDealDraft({ name: 'Bad', description: 'Bad', type: 'buy_x_get_y_free', buyQty: 1.5, freeQty: 1 }).ok === false
    && dealDrafts.normaliseDealDraft({ name: 'Bad', description: 'Bad', type: 'percent_off_category', percentOff: 101 }).ok === false
    && dealDrafts.normaliseDealDraft({ name: 'Bad', description: 'Bad', type: 'fixed_off_order', amountOff: -1 }).ok === false);

  const generatedIds = Array.from({ length: 2000 }, () => clientIds.createClientId('test'));
  check('client ID helper preserves prefixes and avoids same-process collisions',
    generatedIds.every((id) => id.startsWith('test_'))
    && new Set(generatedIds).size === generatedIds.length);

  const visibility = { isOwner: true, mediaV2: false, legacyEnabled: false, legacyDetected: false };
  const ownerNavigation = navigation.buildAdminNavigation('owner', { dashboard: 2, contact: 1 }, visibility);
  const managerNavigation = navigation.buildAdminNavigation('store_manager', {}, { ...visibility, isOwner: false });
  const ownerIds = ownerNavigation.flatMap((section) => section.items.map((item) => item.id));
  const managerIds = managerNavigation.flatMap((section) => section.items.map((item) => item.id));
  check('navigation includes every routable feature exactly once for an eligible owner',
    ownerIds.length === new Set(ownerIds).size
    && launchFeatures.ADMIN_ROUTE_IDS.filter((id) => id !== 'legacy-import').every((id) => ownerIds.includes(id)));
  check('navigation role projection hides owner-only sections from managers',
    !managerIds.includes('settings') && !managerIds.includes('cms') && !managerIds.includes('franchise')
    && managerIds.includes('menu') && managerIds.includes('rota'));
  check('navigation role predicate is reusable for non-navigation dashboard projections',
    navigation.isAdminRoleAllowed('franchise', 'owner') === true
    && navigation.isAdminRoleAllowed('franchise', 'store_manager') === false
    && navigation.isAdminRoleAllowed('careers', 'store_manager') === true);
  check('navigation badges omit zeroes and retain live attention counts',
    ownerNavigation.flatMap((section) => section.items).find((item) => item.id === 'dashboard')?.badge === 2
    && ownerNavigation.flatMap((section) => section.items).find((item) => item.id === 'menu')?.badge === undefined);

  const opening = dashboard.buildAdminOpeningSummary(
    [{ id: 's1', name: 'Milk Pop', address: '1 High St', postcode: 'B1 1AA', setupStatus: 'DRAFT' }],
    { s1: { setupStatus: 'ACTIVE' } },
    [{ id: 'm1', name: 'Shake', description: 'Fresh', available: true }],
    { email: 'hello@milkpop.test', phone: '' },
  );
  check('opening summary reflects a just-confirmed store activation immediately',
    opening.publicStoreCount === 1 && opening.privateStoreCount === 0 && opening.hasPublicContact === true);
  const alertRows = dashboard.buildAdminDashboardAlerts(
    [
      { id: 'old', status: 'pending', appliedAt: '2026-08-01T10:00:00Z' },
      { id: 'new', status: 'pending', appliedAt: '2026-08-02T10:00:00Z' },
    ], [], [], [],
  );
  check('dashboard alert source identity matches its newest timestamp', alertRows[0]?.sourceId === 'new');
  const lifecycleAlerts = dashboard.buildAdminDashboardAlerts(
    [], [],
    [
      { id: 'closed-report', status: 'closed', submittedAt: '2026-08-02T12:00:00Z' },
      { id: 'review-report', status: 'under_review', submittedAt: '2026-08-02T11:00:00Z' },
    ],
    [
      { id: 'old-document', status: 'pending', uploadDate: '2026-08-01' },
      { id: 'new-document', status: 'pending', uploadDate: '2026-08-02' },
    ],
  );
  check('dashboard lifecycle alerts exclude closed incidents and understand document uploadDate',
    lifecycleAlerts.find((alert) => alert.id === 'incidents')?.sourceId === 'review-report'
    && lifecycleAlerts.find((alert) => alert.id === 'documents')?.sourceId === 'new-document'
    && lifecycleAlerts.find((alert) => alert.id === 'documents')?.date !== 'time not recorded');
  const dashboardMetrics = dashboard.buildAdminDashboardMetrics(
    [{ id: 'c1', status: 'new' }, { id: 'c2', status: 'closed' }],
    [
      { id: 'a1', status: 'pending' }, { id: 'a2', status: 'reviewing' },
      { id: 'a3', status: 'interview' }, { id: 'a4', status: 'offer' },
    ],
    [{ id: 'f1', status: 'pending' }, { id: 'f2', status: 'contacted' }],
    [{ id: 'e1', status: 'active' }, { id: 'e2', status: 'disabled' }],
    { showCareers: true, showFranchise: true },
  );
  check('dashboard message count uses pending franchise status and programme switches',
    dashboardMetrics.newContactMessages === 1
    && dashboardMetrics.pendingApplications === 1
    && dashboardMetrics.pendingFranchiseInquiries === 1
    && dashboardMetrics.dashboardMessageCount === 3);
  check('dashboard staff and recruitment metrics retain zero-safe proportional bars',
    dashboardMetrics.activeStaff === 1
    && dashboardMetrics.disabledStaff === 1
    && dashboardMetrics.recruitmentBars.find((bar) => bar.id === 'offer')?.count === 1
    && dashboardMetrics.recruitmentBars.find((bar) => bar.id === 'offer')?.heightPercent === 50
    && dashboardMetrics.recruitmentBars.find((bar) => bar.id === 'staff')?.heightPercent === 100);

  check('incident status helper treats every unresolved workflow state as open',
    ['submitted', 'under_review', 'escalated', 'action_required'].every((status) => dashboard.isSifrOpenStatus(status))
    && ['resolved', 'closed'].every((status) => !dashboard.isSifrOpenStatus(status)));
  const completionRows = analytics.buildAdminTrainingCompletionRows(
    [{ id: 'assessment-1', title: 'Food Safety' }],
    [
      { id: 'cert-1', employeeId: 'e1', assessmentId: 'assessment-1' },
      { id: 'cert-2', employeeId: 'e1', assessmentId: 'assessment-1' },
      { id: 'cert-3', employeeId: 'e2', assessmentId: 'assessment-1' },
    ],
    [{ id: 'e1', status: 'active' }, { id: 'e2', status: 'disabled' }, { id: 'e3', status: 'active' }],
  );
  check('training completion deduplicates certificates and excludes disabled profiles',
    completionRows[0]?.completedActiveStaff === 1
    && completionRows[0]?.activeStaff === 2
    && completionRows[0]?.percent === 50);

  const payrollModel = payroll.buildAdminPayrollPeriod(
    employees,
    [
      { id: 'c1', employeeId: 'e1', employeeName: 'Alex', date: '2026-07-01', clockIn: '2026-07-01T09:00:00Z', totalDecimalHours: 8, approved: true },
      { id: 'c2', employeeId: 'e1', employeeName: 'Alex', date: '2026-07-02', clockIn: '2026-07-02T09:00:00Z', totalDecimalHours: 4 },
      { id: 'c3', employeeId: 'e1', employeeName: 'Alex', date: '2026-07-03', clockIn: '2026-07-03T09:00:00Z', totalDecimalHours: 9, rejected: true },
    ],
    [{ id: 'p1', employeeId: 'e2', periodKey: '2026-07' }],
    '2026-07',
  );
  check('payroll projection scans approval states once without inventing rejected hours',
    payrollModel.byEmployeeId.get('e1')?.approvedHours === 8
    && payrollModel.byEmployeeId.get('e1')?.pendingHours === 4
    && payrollModel.byEmployeeId.get('e1')?.approvedEntries.length === 1);
  check('payroll projection retains salary, rate and existing-estimate semantics',
    payrollModel.byEmployeeId.get('e1')?.hourlyRate === 12
    && payrollModel.byEmployeeId.get('e2')?.isSalary === true
    && payrollModel.byEmployeeId.get('e2')?.hasExistingEstimate === true
    && payrollModel.byEmployeeId.get('e3')?.hourlyRate === null);
  check('previous-month initialiser handles the January boundary',
    payroll.previousCalendarMonthKey(new Date('2026-01-15T12:00:00Z')) === '2025-12');
} else {
  console.log('SKIP rota runtime assertions — TypeScript transpiler unavailable in this source-only environment');
}

console.log(`ADMIN PANEL OPTIMISATION — ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
