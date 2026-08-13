#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`); ok ? passed++ : failed++; };

const staff = read('src/components/StaffPortal.tsx');
const authPanel = read('src/components/staff/StaffAuthPanel.tsx');
const app = read('src/App.tsx');
const regs = read('src/lib/registries.ts');
const migration = read('supabase/migration_t13313_staff_portal_integrity.sql');
const manifest = read('launch/migration-manifest.sh');
const clock = read('src/components/staff/StaffClockTicker.tsx');
const dashboard = read('src/components/staff/StaffDashboardPanel.tsx');
const documentsPanel = read('src/components/staff/StaffDocumentsPanel.tsx');
const checklistPanel = read('src/components/staff/StaffChecklistPanel.tsx');
const sifrPanel = read('src/components/staff/StaffSifrPanel.tsx');
const knowledgePanel = read('src/components/staff/StaffKnowledgeBasePanel.tsx');
const academyPanel = read('src/components/staff/StaffAcademyPanel.tsx');
const businessDate = read('src/hooks/useStoreBusinessDate.ts');
const rlsMatrix = read('scripts/rls-matrix.local.mjs');
const staging = read('scripts/staging-integration.test.mjs');
const optimizationDoc = read('STAFF-PORTAL-OPTIMIZATION.md');

check('StaffPortal is keyed to the authenticated identity or MFA ceremony',
  /key=\{staffPortalScopeKey\}/.test(app) && /employee:\$\{employeeScopeKey\}/.test(app) && /mfa:\$\{mfaPending\.kind\}/.test(app));
check('MFA secret and code state reset when the pending session changes',
  /\[mfaPending\?\.kind, mfaPending\?\.session\.accessToken\]/.test(authPanel) && /setEnrolData\(null\)/.test(authPanel));
check('authentication ceremony is bounded and the root owns no auth secrets',
  /<StaffAuthPanel/.test(staff) && /export default memo\(StaffAuthPanel\)/.test(authPanel)
  && !/const \[loginPassword/.test(staff) && !/const \[mfaCode/.test(staff)
  && !/const \[enrolData/.test(staff) && !/readRecoveryFromHash/.test(staff));
check('root StaffPortal no longer owns a one-second currentTime ticker',
  !/const \[currentTime, setCurrentTime\]/.test(staff) && !/setInterval\([^)]*setCurrentTime/s.test(staff));
check('clock readout is isolated and explicitly displays store time',
  /StaffClockReadout/.test(dashboard) && /Store time/.test(clock) && /timeZone: zone/.test(clock));
check('store business date updates independently at store-local midnight',
  /useStoreBusinessDate\(currentStore\?\.timezone(?:\s*(?:\|\||\?\?)\s*undefined)?\)/.test(staff)
  && /msUntilNextBusinessDay/.test(businessDate) && /setTimeout/.test(businessDate));
check('portal mutations use ref-backed single-flight guards in their owning domains',
  /useSingleFlight/.test(dashboard) && /const clockFlight/.test(dashboard)
  && /const checklistFlight/.test(checklistPanel)
  && /const documentFlight/.test(documentsPanel) && /const sifrFlight/.test(sifrPanel));
check('checklist UI refuses incomplete category submission',
  /activeTasks\.some\(\(task\) => !task\.completed\)/.test(checklistPanel) && /Complete every configured check/.test(checklistPanel));
check('checklist database refuses incomplete and rapid duplicate submissions',
  /if v_completed <> v_total then raise exception 'checklist_category_incomplete'/.test(migration));
check('first-ever clock action is serialized before a row exists',
  /pg_advisory_xact_lock\(76131, hashtext\(v_key\)\)/.test(migration));
check('SIFR stamp unconditionally owns reporter and store identity',
  /new\.reporter_id := v_id/.test(migration) && /new\.store_id := v_store/.test(migration)
  && !/new\.store_id\s*:=\s*coalesce\(nullif\(new\.store_id/.test(migration));
check('SIFR stamp owns date, timestamp, status and initial replies',
  /new\.submitted_at :=/.test(migration) && /new\.date :=/.test(migration)
  && /new\.status := 'submitted'/.test(migration) && /new\.replies := '\[\]'::jsonb/.test(migration));
check('legacy safety category is canonicalised without weakening validation',
  /if new\.category = 'safety'[\s\S]*new\.category := 'health_safety'/.test(migration));
check('SIFR creation is a narrow server RPC',
  /create_sifr_report/.test(migration) && /gen_random_uuid/.test(migration) && /createSifrReport/.test(regs));
check('SIFR reply is row-locked and server-attributed',
  /append_sifr_reply/.test(migration) && /for update/.test(migration)
  && /v_actor_name/.test(migration) && /jsonb_build_array\(v_reply\)/.test(migration));
check('SIFR status changes use a narrow operation',
  /set_sifr_status/.test(migration) && /set status = p_status/.test(migration) && /setSifrStatus/.test(regs));
check('store managers cannot use generic whole-row SIFR updates',
  /sifr_update_requires_rpc/.test(migration)
  && /create policy sifr_update_owner_only[\s\S]*using \(is_owner\(\)\)[\s\S]*with check \(is_owner\(\)\)/.test(migration)
  && /current_setting\('app\.sifr_rpc'/.test(migration));
check('SIFR trigger helpers are not directly executable by browser roles',
  /revoke all on function public\.sifr_reports_stamp\(\) from public, anon, authenticated/.test(migration)
  && /revoke all on function public\.sifr_reports_update_guard\(\) from public, anon, authenticated/.test(migration));
check('App no longer whole-row upserts SIFR replies or status',
  !/sifrRepo\.upsert/.test(app) && /appendSifrReply/.test(app) && /setSifrStatus/.test(app));
check('normal team members are not offered a non-working SIFR reply control',
  /const canManage/.test(sifrPanel) && /\{canManage && \(/.test(sifrPanel));
check('sensitive-report wording truthfully states identity visibility',
  /authorised managers can see my identity/.test(sifrPanel) && /verified identity is retained/.test(sifrPanel));
check('secure-document tab is opened from the click gesture before the URL request',
  /const preview = window\.open\('', '_blank'\)/.test(documentsPanel) && /getStaffDocumentUrl/.test(documentsPanel)
  && documentsPanel.indexOf("const preview = window.open('', '_blank')") < documentsPanel.indexOf('getStaffDocumentUrl(documentId, token)'));

check('staff panels use the original active-route state lifetime',
  /key=\{currentTab\}/.test(app)
  && /currentTab === 'staff_academy'/.test(staff)
  && /currentTab === 'staff_sifr'/.test(staff)
  && /currentTab === 'staff_documents'/.test(staff)
  && !/PRESERVED_STAFF_TABS|shouldMountStaffTab|hidden=\{currentTab !== 'staff_/.test(staff));
check('dashboard timers are scoped to the active dashboard route',
  /currentTab === 'staff_dashboard'/.test(staff)
  && /isActive/.test(staff)
  && /if \(!isActive\) return undefined/.test(dashboard)
  && /active=\{isActive\}/.test(dashboard)
  && /if \(!active\) return undefined/.test(clock));
check('StaffPortal documentation reports honest module size and state lifetime',
  /Complete StaffPortal module/.test(optimizationDoc)
  && /3,205 lines/.test(optimizationDoc) && /3,690 lines/.test(optimizationDoc)
  && /discarded when the employee changes staff routes/.test(optimizationDoc)
  && /not lazy bundle splitting/.test(optimizationDoc)
  && /Web Till remains active-route mounted/.test(optimizationDoc));
check('StaffPortal source header describes the implemented architecture',
  /Authentication-aware shell/.test(staff)
  && /active-route mounted/.test(staff)
  && /discards any[\s\S]*unfinished local draft/.test(staff)
  && !/Recommended Next Steps for Developers|React Query|renderAcademy|keeps visited staff panels mounted/.test(staff));

check('bounded StaffPortal panels own only their local UI state',
  /<StaffDashboardPanel/.test(staff) && /export default memo\(StaffDashboardPanel\)/.test(dashboard)
  && /<StaffDocumentsPanel/.test(staff) && /<StaffSifrPanel/.test(staff) && /<StaffKnowledgeBasePanel/.test(staff)
  && !/const \[docForm/.test(staff) && !/const \[sifrForm/.test(staff) && !/const \[kbSearch/.test(staff)
  && /export default React\.memo\(StaffDocumentsPanel\)/.test(documentsPanel)
  && /export default React\.memo\(StaffSifrPanel\)/.test(sifrPanel)
  && /export default React\.memo\(StaffKnowledgeBasePanel\)/.test(knowledgePanel)
  && /<StaffChecklistPanel/.test(staff) && !/const \[checklistTasks/.test(staff)
  && /export default React\.memo\(StaffChecklistPanel\)/.test(checklistPanel));

check('employee-facing language stays simple for a small store',
  /Staff portal/.test(staff) && /My rota/.test(dashboard) && /Quick links/.test(dashboard)
  && /Training progress/.test(academyPanel) && /Start training/.test(academyPanel)
  && /Submit checklist/.test(checklistPanel) && /Suggested action/.test(sifrPanel)
  && !/Corporate Operations|Terminal Duty|Global Rank|Daily Audit Registry|Remediative Action|Interactive Syllabus/.test(
    [staff, dashboard, academyPanel, checklistPanel, sifrPanel].join('\n')
  ));
check('seven dead StaffPortal inputs are removed without stripping AdminPanel inputs',
  !/onLogout:/.test(staff) && !/<StaffPortal[\s\S]*?onLogout=/.test(app)
  && !/\bcourses:\s*TrainingCourse\[\]/.test(staff) && !/onUpdateCourse:/.test(staff)
  && !/employeesList:/.test(staff) && !/onAddShift\?:/.test(staff)
  && !/onDeleteShift\?:/.test(staff) && !/onAppendClockHistory:/.test(staff)
  && !/<StaffPortal[\s\S]*?employeesList=/.test(app)
  && !/<StaffPortal[\s\S]*?onAddShift=/.test(app)
  && !/<StaffPortal[\s\S]*?onDeleteShift=/.test(app)
  && /<AdminPanel[\s\S]*?employeesList=/.test(app)
  && /<AdminPanel[\s\S]*?onAddShift=/.test(app)
  && /<AdminPanel[\s\S]*?onDeleteShift=/.test(app));
check('local PostgreSQL matrix exercises the narrow SIFR RPC contract',
  /create_sifr_report/.test(rlsMatrix) && /append_sifr_reply/.test(rlsMatrix)
  && /cannot bypass the atomic RPC/.test(rlsMatrix));
check('live staging probe exercises SIFR RPC and whole-row rejection',
  /rpc\/create_sifr_report/.test(staging) && /rpc\/append_sifr_reply/.test(staging)
  && /manager whole-row incident updates are rejected/.test(staging));
check('T13.3.13 remains appended after deployment handoff and before later releases',
  /migration_t13312_deployment_handoff\.sql"\s+"supabase\/migration_t13313_staff_portal_integrity\.sql"[\s\S]*migration_t13319_release_integrity\.sql"\s+"supabase\/migration_t13320_final_audit\.sql"\s+"supabase\/migration_t13322_public_store_scope\.sql"\s*\)/s.test(manifest));

console.log(`\nSTAFF PORTAL INTEGRITY — ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
