/**
 * @file StaffPortal.tsx
 * @description Authentication-aware shell for the Milk Pop employee portal.
 *
 * Each staff domain owns its local UI state under `src/components/staff/`.
 * Staff tabs are active-route mounted: moving to another route discards any
 * unfinished local draft, matching the original portal's route-level lifetime
 * and avoiding hidden videos, forms or background effects. App.tsx also keys
 * the portal to the authenticated identity or MFA ceremony, so account changes
 * always destroy all local state. Server-authoritative clock, checklist, SIFR,
 * Academy and document operations remain behind narrow callbacks and RPCs.
 * POS source is retained for later integration but is intentionally not routed
 * or rendered in this public-web release.
 */
import React from 'react';
import { Lock, Building } from 'lucide-react';
import { EmployeeProfile, SIFRReport, StaffDocument, WorkShift, ClockStatus, ClockHistoryItem, StoreLocation, ChecklistTemplateItem, Payslip, TrainingAssessment, TrainingAssignment, TrainingCertificate, KnowledgeArticle, CreateSIFRReportInput } from '../types';
import { DripUnderline } from '../brand';
// PHASE A: the debounced localStorage mirror (schedulePush) is gone — every
// operational write below goes through server-confirmed props from App.tsx.
import { useStoreBusinessDate } from '../hooks/useStoreBusinessDate';
import type { ShiftCoverBoard } from '../lib/storeState';
import type { ChecklistAuditLog, StoreChecklistState } from '../lib/checklistState';
import { WaveDivider } from './WaveDivider';
import StaffDocumentsPanel from './staff/StaffDocumentsPanel';
import StaffKnowledgeBasePanel from './staff/StaffKnowledgeBasePanel';
import StaffSifrPanel from './staff/StaffSifrPanel';
import StaffChecklistPanel from './staff/StaffChecklistPanel';
import StaffAcademyPanel from './staff/StaffAcademyPanel';
import StaffDashboardPanel from './staff/StaffDashboardPanel';
import StaffAuthPanel from './staff/StaffAuthPanel';

// (Legacy inline academy syllabus data removed — assessments now come from the
//  synced `training_assessments` registry, editable in the Admin Panel.)


interface StaffPortalProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  employee: EmployeeProfile | null;
  // SECURITY: onUpdatePassword prop removed — password changes are handled by
  // Supabase Auth, not client-side. `onSignIn` delegates to Supabase Auth and
  // never performs a client-side credential check. It resolves to an error
  // message string, or null on success (the parent hook sets `employee`).
  /** SMALL-BIZ CLOSURE P0-6: the DATABASE Knowledge Base, hydrated by App —
   *  the portal renders and searches THESE rows, never the bundled seeds. */
  articles: KnowledgeArticle[];
  onSignIn?: (email: string, password: string) => Promise<string | null>;
  /** MFA challenge/enrolment state surfaced by the auth hook (Item 5). */
  mfaPending?: import('../hooks/useAuth').MfaPending | null;
  /** Submit a 6-digit TOTP code for the pending challenge. */
  onSubmitMfaCode?: (code: string) => Promise<string | null>;
  /** Finish sign-in after a privileged-role user verifies a new factor. */
  onCompleteMfaEnrolment?: (session: import('../lib/auth').AuthSession) => Promise<string | null>;
  /** Abandon a pending MFA step. */
  onCancelMfa?: () => Promise<void>;
  /** True when a Supabase Auth backend is configured for this deployment. */
  authConfigured?: boolean;
  /** True during the initial session-restore attempt. */
  authLoading?: boolean;
  /** Persists profile changes (points, badges) to the staff registry + cloud. */
  /* T13-7: removed. The portal's only use of this was the false checklist
     points reward — a write the database's field-lock trigger refuses for
     non-owners. Staff profile changes are made by the owner in Admin. */
  documents: StaffDocument[];
  /** STAGE 3: the raw File goes to the server pipeline (private Storage). */
  onUploadDocument: (args: { file: File; name: string; category: StaffDocument['category']; employeeId?: string }) => Promise<boolean>;
  sifrReports: SIFRReport[];
  onAddSIFRReport: (input: CreateSIFRReportInput) => Promise<boolean>;
  onAddSIFRReply: (reportId: string, msg: string) => Promise<boolean>;
  addToast: (msg: string, type: 'success' | 'warning' | 'error' | 'info') => void;
  shiftsList: WorkShift[];
  assessments?: TrainingAssessment[];
  stores: StoreLocation[];
  checklistTemplates: ChecklistTemplateItem[];
  /** Shared timesheet log — lives in App state so managers can approve it. */
  clockHistory: ClockHistoryItem[];
  /** FIX (audit OPS-001): the four clock transitions run server-side. */
  onClockAction: (action: 'clock_in' | 'start_break' | 'end_break' | 'clock_out', notes?: string)
    => Promise<{ status: ClockStatus; history: ClockHistoryItem | null } | null>;
  /** Atomic server-side cover-board entry mutations. */
  onRequestShiftCover: (shiftId: string, message: string) => Promise<ShiftCoverBoard | null>;
  onRetractShiftCover: (shiftId: string) => Promise<ShiftCoverBoard | null>;
  /** FIX (audit OPS-002): atomic server-side cover claim. */
  onClaimShift: (shiftId: string)
    => Promise<{ newShift: WorkShift; covers: Record<string, unknown> } | null>;
  /** Atomic one-task checklist mutation; identity, store and time are server-derived. */
  onUpdateChecklistTask: (
    businessDate: string,
    taskId: string,
    patch: { completed?: boolean; comment?: string; clearComment?: boolean },
  ) => Promise<StoreChecklistState | null>;
  /** Atomic checklist audit append + category reset. */
  onSubmitChecklistCategory: (
    businessDate: string,
    category: 'opening' | 'midday' | 'closing',
  ) => Promise<{ state: StoreChecklistState; audits: ChecklistAuditLog[] } | null>;
  /** Per-staff KV state hydrated from the app_state table (clock status,
      checklist state, shift covers). */
  appState: Record<string, unknown>;
  staffDataStatus: 'idle' | 'loading' | 'live' | 'error';
  onRetryHydration: () => void;
  /** Generated hourly earnings estimates (read-only for staff). */
  payslips: Payslip[];
  /** Training assignments set by management (due dates, status tracking). */
  trainingAssignments?: TrainingAssignment[];
  onUpdateAssignment?: (assignment: TrainingAssignment) => Promise<boolean>;
  /** Certificates issued automatically when a module is passed. */
  trainingCertificates?: TrainingCertificate[];
  /** STAGE 4: ONE server transaction — validate, record, complete assignment,
   *  issue the certificate idempotently, apply the reward, audit. */
  onCompleteTraining: (args: { assessmentId: string; score: number; submissionId: string; assignmentId?: string | undefined; answers?: (string | (string | null)[])[] | undefined }) =>
    Promise<{ ok: boolean; passed?: boolean; score?: number; newCertificate?: boolean; certificate?: TrainingCertificate | null; pointsAwarded?: number; badgeAwarded?: string | null }>;
  /** Stamps emailedAt on a certificate after the e-mail goes out. */
  onCertificateEmailed?: (certificateId: string) => Promise<boolean>;
}

export const StaffPortal: React.FC<StaffPortalProps> = ({
  currentTab,
  setCurrentTab,
  employee,
  articles,
  onSignIn,
  mfaPending = null,
  onSubmitMfaCode,
  onCompleteMfaEnrolment,
  onCancelMfa,
  authConfigured = false,
  authLoading = false,
  documents,
  onUploadDocument,
  sifrReports,
  onAddSIFRReport,
  onAddSIFRReply,
  addToast,
  shiftsList,
  assessments = [],
  stores,
  checklistTemplates,
  clockHistory,
  onClockAction,
  onRequestShiftCover,
  onRetractShiftCover,
  onClaimShift,
  onUpdateChecklistTask,
  onSubmitChecklistCategory,
  appState,
  staffDataStatus,
  onRetryHydration,
  payslips,
  trainingAssignments = [],
  onUpdateAssignment,
  trainingCertificates = [],
  onCompleteTraining,
  onCertificateEmailed
}) => {
  const currentStore = employee ? stores.find((store) => store.id === employee.storeId) : undefined;
  const checklistBusinessDate = useStoreBusinessDate(currentStore?.timezone || undefined);

  return (
    <div className="mp-staff-shell bg-[#F7EFE6] min-h-screen">
      {/* PHASE A: sign-in hydration state — a failed load is VISIBLE, never a
          silently empty portal. Records are safe on the server either way. */}
      {employee && staffDataStatus === 'error' && (
        <div className="bg-amber-50 border-b border-[#A46832] px-4 py-2 flex items-center justify-center gap-3 text-2xs font-bold text-[#A5642B]">
          <span>Some of your records could not be loaded from the database — what you see may be incomplete.</span>
          <button onClick={onRetryHydration} className="px-3 py-1.5 bg-[#A46832] text-white rounded-full uppercase font-black tracking-wider cursor-pointer hover:bg-[#A5642B]">Retry</button>
        </div>
      )}
      {employee && staffDataStatus === 'loading' && (
        <div className="bg-[#7CC0C7]/10 border-b border-[#7CC0C7]/50 px-4 py-1.5 text-center text-2xs font-bold text-[#2E2A26]/70">
          Loading your records from the database…
        </div>
      )}
      {/* BACKGROUND DECORATIVE ACCENTS */}
      <div className="bg-[#2E2A26] text-white py-12 px-4 shadow-xs text-center relative overflow-hidden">
        <div className="absolute top-0 right-0 w-44 h-44 bg-[#A46832]/10 rounded-full filter blur-xl" />
        <div className="absolute bottom-[-20px] left-0 w-full">
          <WaveDivider color="#FFFFFF" bgColor="#2E2A26" type="double" />
        </div>

        <div className="max-w-7xl mx-auto space-y-2 relative z-10">
          <div className="inline-flex items-center space-x-1 bg-white/10 px-3 py-1 rounded-full text-xs text-[#EBDECE]">
            <Lock className="h-3 w-3 text-[#A46832]" />
            <span className="font-bold tracking-wider uppercase text-[9px]">Staff portal</span>
          </div>
          <h1 className="font-display text-3xl font-black text-[#FFFFFF]">
            {employee ? `Welcome back, ${employee.name}` : 'Milk Pop staff portal'}
          </h1>
          <p className="text-xs text-[#F3E9DA] max-w-sm mx-auto">
            {employee ? `Store: ${employee.storeName}` : 'Sign in to view your rota, training and store tasks.'}
          </p>
        </div>
      </div>

      {!employee && (
        <StaffAuthPanel
          currentTab={currentTab}
          setCurrentTab={setCurrentTab}
          onSignIn={onSignIn}
          mfaPending={mfaPending}
          onSubmitMfaCode={onSubmitMfaCode}
          onCompleteMfaEnrolment={onCompleteMfaEnrolment}
          onCancelMfa={onCancelMfa}
          authConfigured={authConfigured}
          authLoading={authLoading}
        />
      )}

      {employee && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          {/* HUB COMPONENT MENU BAR */}
          <div className="mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-xl md:text-2xl font-black text-[#2E2A26] tracking-tight">
                {currentTab === 'staff_dashboard' && 'My Dashboard'}
                {currentTab === 'staff_documents' && 'My documents'}
                {currentTab === 'staff_checklists' && 'Checklists'}
                {currentTab === 'staff_academy' && 'Training'}
                {currentTab === 'staff_sifr' && 'Safety & incident reports'}
                {currentTab === 'staff_kb' && 'Staff guides'}
              </h2>
              {/* the careful drip — one per screen, never centred */}
              <DripUnderline className="w-28 h-3 mt-1.5 ml-1" />
            </div>

            {/* Quick jump to Admin Panel if authorized */}
            {(employee.role === 'store_manager' || employee.role === 'owner') && (
              <div className="shrink-0 flex justify-start sm:justify-end">
                <button
                  id="hub-tab-admin-dash"
                  onClick={() => setCurrentTab('admin_panel')}
                  className="px-5 py-2.5 bg-neutral-900 hover:bg-[#A46832] text-white rounded-full text-2xs font-extrabold uppercase tracking-wider transition-all cursor-pointer flex items-center justify-center space-x-2 shadow-md hover:-translate-y-0.5"
                >
                  <Building className="h-3 w-3" />
                  <span>Manager tools</span>
                </button>
              </div>
            )}
          </div>

          {/* ===================== STAFF PORTAL SUBVIEWS ===================== */}

          {/* SUBVIEW 1: STAFF DASHBOARD */}
          {employee && currentTab === 'staff_dashboard' && (
            <StaffDashboardPanel
              isActive
              employee={employee}
              currentStore={currentStore}
              shiftsList={shiftsList}
              clockHistory={clockHistory}
              payslips={payslips}
              articles={articles}
              appState={appState}
              staffDataStatus={staffDataStatus}
              setCurrentTab={setCurrentTab}
              addToast={addToast}
              onClockAction={onClockAction}
              onRequestShiftCover={onRequestShiftCover}
              onRetractShiftCover={onRetractShiftCover}
              onClaimShift={onClaimShift}
            />
          )}

          {/* SUBVIEW 2: DOCUMENT CENTRE */}
          {employee && currentTab === 'staff_documents' && (
            <StaffDocumentsPanel
              employeeId={employee.id}
              documents={documents}
              onUploadDocument={onUploadDocument}
              addToast={addToast}
            />
          )}

          {/* SUBVIEW CHECKLIST: SHIFT CHECKLISTS BOARD (Daily audit checks) */}
          {employee && currentTab === 'staff_checklists' && (
            <StaffChecklistPanel
              storeId={employee?.storeId}
              businessDate={checklistBusinessDate}
              templates={checklistTemplates}
              appState={appState}
              staffDataStatus={staffDataStatus}
              onUpdateTask={onUpdateChecklistTask}
              onSubmitCategory={onSubmitChecklistCategory}
              addToast={addToast}
            />
          )}

          {/* SUBVIEW 3: TRAINING ACADEMY */}
          {employee && currentTab === 'staff_academy' && (
            <StaffAcademyPanel
              employee={employee}
              assessments={assessments}
              trainingAssignments={trainingAssignments}
              trainingCertificates={trainingCertificates}
              businessDate={checklistBusinessDate}
              staffDataStatus={staffDataStatus}
              {...(onUpdateAssignment ? { onUpdateAssignment } : {})}
              onCompleteTraining={onCompleteTraining}
              {...(onCertificateEmailed ? { onCertificateEmailed } : {})}
              addToast={addToast}
            />
          )}
          {/* SUBVIEW 4: SIFR SYSTEM */}
          {employee && currentTab === 'staff_sifr' && (
            <StaffSifrPanel
              employee={employee}
              reports={sifrReports}
              onAddReport={onAddSIFRReport}
              onAddReply={onAddSIFRReply}
              addToast={addToast}
            />
          )}

          {/* SUBVIEW 5: KNOWLEDGE BASE */}
          {employee && currentTab === 'staff_kb' && (
            <StaffKnowledgeBasePanel articles={articles} />
          )}
        </div>
      )}
    </div>
  );
};
