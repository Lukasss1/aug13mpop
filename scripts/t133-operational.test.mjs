#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const releaseManifest = JSON.parse(read('release-manifest.json'));
const envReleaseIdentity = read('.env.example').match(/^VITE_RELEASE_IDENTITY=(.+)$/m)?.[1]?.trim();
let passed = 0;
let failed = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✔ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function loadTs(relativePath) {
  const source = read(relativePath);
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
    fileName: relativePath,
  });
  const syntaxErrors = (out.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  check(`${relativePath} transpiles without syntax errors`, syntaxErrors.length === 0,
    syntaxErrors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; '));
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: () => ({}), console });
  new vm.Script(out.outputText, { filename: relativePath }).runInContext(context);
  return module.exports;
}

console.log('T13.3.13 OPERATIONAL CLOSURE');
console.log('==========================');

const storeState = loadTs('src/lib/storeState.ts');
const checklist = loadTs('src/lib/checklistState.ts');
const pay = loadTs('src/lib/pay.ts');

console.log('\n§1 Store-scoped operational keys');
check('Store A and Store B generate different checklist keys',
  storeState.storeStateKey('milkpop_checklist_tasks', 'store-a') !== storeState.storeStateKey('milkpop_checklist_tasks', 'store-b'));
check('empty store assignment produces no operational key', storeState.storeStateKey('milkpop_shift_covers', '') === null);
check('real key is base:storeId', storeState.storeStateKey('milkpop_shift_covers', 's-2') === 'milkpop_shift_covers:s-2');

const migration = read('supabase/migration_t133_store_operational_state.sql');
const atomicMigration = read('supabase/migration_t1331_operational_atomicity.sql');
const checklistAtomicMigration = read('supabase/migration_t1332_checklist_item_atomicity.sql');
check('migration restricts operational keys to suffixed store keys',
  /milkpop_checklist_tasks\|milkpop_checklist_audits\|milkpop_shift_covers/.test(migration)
  && /wrong_store_key/.test(migration));
check('migration stamps app_state.store_id from the server-derived store',
  /v_store_id := v_store/.test(migration));
check('claim_shift uses the shift actual store cover key',
  /v_cover_key := 'milkpop_shift_covers:' \|\| v_shift\.store_id/.test(migration));
check('claim_shift rejects cross-store claims', /raise exception 'wrong_store'/.test(migration));
check('claim_shift locks both shift and cover document',
  /work_shifts where id = p_shift_id for update/.test(migration)
  && /app_state where key = v_cover_key for update/.test(migration));

console.log('\n§2 Daily checklist behaviour');
const templates = [
  { id: 'a', label: 'Open till', category: 'opening', sortOrder: 2 },
  { id: 'b', label: 'Check fridge', category: 'opening', sortOrder: 1 },
];
const today = checklist.readChecklistState({ businessDate: '2026-08-01', tasks: [
  { id: 'a', task: 'Old label', category: 'opening', completed: true, comment: 'done' },
]}, '2026-08-01', templates);
check('same-day state retains completion by template id', today.find((x) => x.id === 'a')?.completed === true);
check('latest template label wins over saved label', today.find((x) => x.id === 'a')?.task === 'Open till');
check('new template is inserted incomplete', today.find((x) => x.id === 'b')?.completed === false);
check('template sort order is applied', today.map((x) => x.id).join(',') === 'b,a');
const tomorrow = checklist.readChecklistState({ businessDate: '2026-08-01', tasks: today }, '2026-08-02', templates);
check('next business date resets completion', tomorrow.every((x) => x.completed === false));
check('no templates means no invented operational checklist', checklist.readChecklistState(undefined, '2026-08-01', []).length === 0);

console.log('\n§3 Honest pay behaviour');
check('hourly rate is usable for an estimate', pay.effectiveHourlyRate({ payRate: 12.5, payType: 'hourly' }) === 12.5);
check('salary is never converted into a timesheet cash rate', pay.effectiveHourlyRate({ payRate: 31200, payType: 'salary' }) === null);
check('missing pay is not fabricated', pay.effectiveHourlyRate({}) === null);
check('annual salary produces weekly planning cost only', pay.weeklyFixedSalaryCost({ payRate: 31200, payType: 'salary' }) === 600);

console.log('\n§4 Production honesty and hydration');
const app = read('src/App.tsx');
const portal = read('src/components/StaffPortal.tsx');
const checklistPanel = read('src/components/staff/StaffChecklistPanel.tsx');
const dashboardPanel = read('src/components/staff/StaffDashboardPanel.tsx');
const staffUi = [portal, ...readdirSync(path.join(ROOT, 'src/components/staff'))
  .filter((name) => name.endsWith('.tsx'))
  .sort()
  .map((name) => read(`src/components/staff/${name}`))].join('\n');
const admin = read('src/components/AdminPanel.tsx');
const adminSchedule = read('src/components/admin/adminSchedule.ts');
const notify = read('src/lib/notify.ts');
const email = read('supabase/functions/send-email/templates.ts');
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const portalCode = noComments(staffUi);
const adminCode = noComments(admin);

check('private seeds require explicit development-only flag',
  /import\.meta\.env\.DEV && import\.meta\.env\.VITE_DEV_SEED_CONTENT === 'true'/.test(app));
check('inbox refresh keys on id|role|store scope',
  /refreshInbox = React\.useCallback/.test(app) && /\}, \[employeeScopeKey\]\);/.test(app));
check('owner inbox requires all three sources',
  /\[apps\.status, contacts\.status, franchise\.status\]/.test(app));
check('manager inbox requires only its allowed Careers source', /: \[apps\.status\];/.test(app) && /employee\.role === 'owner'[\s\S]*contact_messages/.test(app));
check('partial inbox failure cannot be marked live',
  /required\.every\(\(status\) => status === 'ok'\) \? 'live' : 'error'/.test(app));
check('stale inbox responses are discarded after a scope change',
  /inboxGenerationRef/.test(app)
  && /generation !== inboxGenerationRef\.current/.test(app));

check('checklist audit type is exported and imported',
  /export interface ChecklistAuditLog/.test(read('src/lib/checklistState.ts'))
  && /type ChecklistAuditLog/.test(checklistPanel));
check('cover request/retract are atomic RPCs, not whole-board client rewrites',
  /create or replace function request_shift_cover/.test(atomicMigration)
  && /create or replace function retract_shift_cover/.test(atomicMigration)
  && !/saveAppState\(shiftCoversKey/.test(staffUi));
check('checklist audit append and reset are one RPC transaction',
  /create or replace function submit_checklist_category/.test(checklistAtomicMigration)
  && /onSubmitCategory\(businessDate, activeCategory\)/.test(checklistPanel)
  && !/saveAppState\(checklistAuditsKey/.test(staffUi));
check('all operational documents are RPC-owned',
  /operational_key_is_rpc_only/.test(checklistAtomicMigration));
check('one checklist task is mutated atomically under a row lock',
  /create or replace function update_checklist_task/.test(checklistAtomicMigration)
  && /where key = v_key for update/.test(checklistAtomicMigration)
  && /onUpdateTask\(businessDate, taskId/.test(checklistPanel)
  && !/saveAppState\(checklistTasksKey/.test(staffUi));
check('checklist writes use server date, identity and current templates',
  /business_date_changed/.test(checklistAtomicMigration)
  && /reconcile_checklist_tasks/.test(checklistAtomicMigration)
  && /completedBy/.test(checklistAtomicMigration));
check('checklist writes use all three store-specific keys',
  /storeStateKey\('milkpop_checklist_tasks', storeId\)/.test(checklistPanel)
  && /storeStateKey\('milkpop_checklist_audits', storeId\)/.test(checklistPanel)
  && /storeStateKey\('milkpop_shift_covers', employee\?\.storeId\)/.test(dashboardPanel));
check('checklist toggles, notes and submission are hydration-gated',
  ['toggleTask', 'saveComment', 'clearComment', 'submitCategory']
    .every((fn) => { const i = checklistPanel.indexOf(`const ${fn}`); return i >= 0 && checklistPanel.slice(i, i + 1200).includes('refuseIfNotLive()'); }));
check('no built-in fake checklist procedure remains in Staff Portal',
  !/espresso grinder|chlorine|£150 float|group heads/i.test(portalCode));
check('no hardcoded dated operational announcement remains',
  !/Walk-In Temperature Logs Required|Summer Slush Product Trial/.test(portalCode));
check('operational guidance is backed by hydrated Knowledge Base articles',
  /Latest operational guidance/.test(dashboardPanel) && /articles\.length === 0/.test(dashboardPanel));
check('badges use actual employee profile only',
  /employee\.badges\.length === 0/.test(dashboardPanel) && !/2 locked/i.test(portalCode));

console.log('\n§5 Earnings language, dashboard facts and release identity');
check('active UI contains no monthly salary label', !/Salary\/Month|\/mo\b|per month/i.test(adminCode + portalCode));
check('active UI does not claim Net Pay or deductions', !/Net pay|Net Pay|Deductions/.test(adminCode + portalCode + email));
check('email sends estimated gross only',
  /Estimated gross earnings/.test(email) && !/params\.net|params\.deductions/.test(email));
check('email payload no longer sends net or deductions', !/deductions: p\.deductions|net: p\.net/.test(notify));
check('salaried staff are skipped by the timesheet estimate generator', /skippedSalary\.push\(emp\.name\)/.test(admin));
check('weekly salaried planning uses shared annual helper', /weeklyFixedSalaryCost/.test(adminSchedule) && /buildRotaScheduleModel/.test(admin));
check('store dashboard count is computed, not hardcoded',
  /publicStoreCount/.test(admin) && /hasRealStoreIdentity/.test(admin) && !/1 opening/.test(adminCode));
check('Operational Health release identity comes from build environment',
  /VITE_RELEASE_IDENTITY/.test(admin) && /releaseVersion=\{BUILD_RELEASE_IDENTITY\}/.test(admin));

console.log('\n§6 Migration chain and feature position');
const manifest = read('launch/migration-manifest.sh');
check('T13.3 operational migrations are in the ordered ledger',
  manifest.includes('supabase/migration_t133_store_operational_state.sql')
  && manifest.includes('supabase/migration_t1331_operational_atomicity.sql')
  && manifest.includes('supabase/migration_t1332_checklist_item_atomicity.sql')
  && manifest.includes('supabase/migration_t1333_launch_content_honesty.sql')
  && manifest.includes('supabase/migration_t1333_shift_overlap_guard.sql')
  && manifest.includes('supabase/migration_t1334_cover_reason_honesty.sql')
  && manifest.includes('supabase/migration_t1335_shift_cover_lifecycle.sql'));
const migrationCount = execFileSync('bash', [path.join(ROOT, 'launch/migration-manifest.sh'), 'upgrade'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean).length;
check('ordered migration chain retains the original T13.3 floor and matches the current release manifest',
  migrationCount >= 105 && migrationCount === releaseManifest.migration_count,
  `${migrationCount} vs manifest ${releaseManifest.migration_count}`);
const envExample = read('.env.example');
check('release identity has an explicit build variable matching the manifest',
  Boolean(envReleaseIdentity) && envReleaseIdentity === releaseManifest.release_identity,
  `${envReleaseIdentity || 'missing'} vs ${releaseManifest.release_identity}`);
check('CV upload remains disabled by default', /VITE_CAREERS_CV_UPLOAD=false/.test(envExample));

console.log(`\nT13.3.13 OPERATIONAL — ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
