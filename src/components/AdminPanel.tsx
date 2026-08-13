/**
 * @file AdminPanel.tsx
 * @description Milk Pop's owner and manager workspace for a one-to-three-store business.
 *
 * The launch UI is deliberately task-grouped (Everyday / Operations / Advanced).
 * Keep extracting only bounded, well-tested workflows as they change; a broad
 * pre-launch rewrite or new global state framework would add more risk than it removes.
 */
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { isReal, hasRealStoreIdentity, isCompletePublicStore, isPublishableVacancy } from '../lib/publishRules';
import { Users, X, Mail, Globe, Trash, Calendar, Edit, Shield, ArrowRight, Database, Send, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  EmployeeProfile, JobApplication, FranchiseInquiry, SIFRReport, StaffDocument, WorkShift,
  EmployeeRole, MenuItem, StoreLocation, CareerVacancy, KnowledgeArticle, NewsPost,
  MediaItem, AuditLogItem, ContactMessage, PublishableContentTable,
  Deal, SiteSettings, ChecklistTemplateItem, CloudStatus, ClockHistoryItem, Payslip, EmailSettings,
  TrainingAssessment, TrainingAssignment, TrainingCertificate,
  SetupStatus, VatStatus, PaymentMethod, TaxCode
} from '../types';
import { SiteContent } from '../siteContent';
import { WebsiteStudio } from './admin/WebsiteStudio';
import EndEmploymentDialog from './admin/EndEmploymentDialog';
import BusinessActionDialog from './admin/BusinessActionDialog';
import { LaunchReadinessPanel, LaunchFactsPanel } from './admin/ClosurePanels';
import { SeoSyncPanel } from './admin/SeoSyncPanel';
import { buildRotaScheduleModel, buildRotaWeekWindow, getRotaCell, shiftDurationHours, shiftInterval, shiftsOverlap } from './admin/adminSchedule';
import type { InboxStatus } from './admin/InboxStatusBar';
import { PermissionsPanel } from './admin/PermissionsPanel';
import { PublicationBadge, PublishButton } from './admin/PublicationControls';
import { buildAdminNavigation, isAdminRoleAllowed } from './admin/adminNavigation';
import { buildAdminDashboardAlerts, buildAdminDashboardMetrics, buildAdminOpeningSummary, isSifrOpenStatus } from './admin/adminDashboard';
import { buildAdminPayrollPeriod, previousCalendarMonthKey } from './admin/adminPayroll';
import { buildAdminTrainingCompletionRows } from './admin/adminAnalytics';
import { DashboardPanel, DEFAULT_DASHBOARD_QUICK_ACTIONS } from './admin/DashboardPanel';
import { AnalyticsPanel } from './admin/AnalyticsPanel';
import { AdminShell } from './admin/AdminShell';
import { ContactInboxPanel } from './admin/ContactInboxPanel';
import { DealsPanel } from './admin/DealsPanel';
import { ChecklistsPanel } from './admin/ChecklistsPanel';
import { SifrPanel } from './admin/SifrPanel';
import { RecognitionPanel } from './admin/RecognitionPanel';
import { FranchisePanel } from './admin/FranchisePanel';
import { KnowledgeBasePanel } from './admin/KnowledgeBasePanel';
import { NewsPanel } from './admin/NewsPanel';
import { AuditPanel } from './admin/AuditPanel';
import { TimesheetsPanel } from './admin/TimesheetsPanel';
import { CompliancePanel } from './admin/CompliancePanel';
import { MediaLibraryPanel } from './admin/MediaLibraryPanel';
import { CareersPanel } from './admin/CareersPanel';
import { buildLiveSeoSummary } from '../lib/seoRebuild';
import type { SeoRebuildStatus } from '../lib/seoRebuild';
import { LegacyImport, hasLegacyData } from './admin/LegacyImport';
import { MEDIA_V2, LEGACY_IMPORT } from '../lib/featureFlags';
import { AcademyStudio } from './AcademyStudio';
import { ImageUploadInline } from './ImageUploadInline';
import { attachMediaReference } from '../lib/mediaUpload';
import { effectiveHourlyRate } from '../lib/pay';
import { safeExternalHref } from '../lib/safeUrl';
import { displayCurrencySymbol, normalizeCurrencySymbol } from '../lib/businessFormatting';
import { MASCOT } from '../brand';
import { resolveMenuImage, hasRealImage } from '../drinkArt';
// Block D: managers/owners fetch a candidate's CV via a short-lived signed URL
// resolved server-side by the cv-signed-url function. The client never names a
// storage path; it passes the applicationId + its own auth token.
import { fetchCvSignedUrl, configureStoreSetup, classifyProducts } from '../lib/supabase';
import { isVatCharging, businessTodayISO } from '../lib/businessDate';
import { createClientId } from '../lib/clientId';
import { getAccessToken as freshStaffToken } from '../lib/auth';
import { getStaffDocumentUrl } from '../lib/staffDocs';
import { onboardingLabel } from '../lib/staffInvite';
import { sendTemplateEmail, emailPayloads } from '../lib/notify';

// Stage-3 WS2: DB times are `time` (HH:MM:SS); rota UI shows HH:MM.
const hhmm = (t?: string) => (t || '').slice(0, 5);

const BUILD_RELEASE_IDENTITY = String(import.meta.env.VITE_RELEASE_IDENTITY || 'development-unbound').trim();
const MENU_CATEGORIES: MenuItem['category'][] = ['milkshakes', 'smoothies', 'slush', 'soft_serve', 'extras'];
/** POS/trading commissioning is intentionally deferred from the public-web launch. */
const POS_SETUP_VISIBLE = false;

interface AdminPanelProps {
  employee: EmployeeProfile | null;
  /** Fresh staff JWT for authenticated cloud reads (Till History, Gate 6). */
  getAccessToken: () => Promise<string | null>;
  /** Admin section from the URL (/admin/<section>) — role-validated below. */
  activeSection?: string | undefined;
  /** Reports section changes upward so App can write /admin/<section>. */
  onSectionChange?: (id: string, replace?: boolean) => void;
  applications: JobApplication[];
  onUpdateApplicationStatus: (id: string, status: JobApplication['status']) => Promise<boolean>;
  franchiseInquiries: FranchiseInquiry[];
  onUpdateFranchiseStatus: (id: string, status: FranchiseInquiry['status']) => Promise<boolean>;
  inboxStatus: InboxStatus;
  onRefreshInbox: () => void;
  sifrReports: SIFRReport[];
  onResolveSIFRReport: (id: string) => Promise<boolean>;
  documents: StaffDocument[];
  onApproveDocument: (id: string) => Promise<boolean>;
  /** Owner-only controlled removal (object + metadata, audited). */
  onDeleteDocument: (id: string) => Promise<boolean>;
  addToast: (msg: string, type: 'success' | 'warning' | 'error' | 'info') => void;
  employeesList: EmployeeProfile[];
  shiftsList: WorkShift[];
  onAddEmployee: (emp: EmployeeProfile) => Promise<boolean>;
  /** STAGE 9: onboarding lifecycle via the staff-invite Edge Function. */
  onStaffInvite: (action: 'invite' | 'refresh' | 'disable' | 'enable', employeeId: string) => Promise<boolean>;
  onUpdateEmployee: (emp: EmployeeProfile) => Promise<boolean>;
  onSetHolidayAllowance: (employeeId: string, currentAllowance: number, nextAllowance: number) => Promise<EmployeeProfile | null>;
  onAddShift: (shift: WorkShift) => Promise<boolean>;
  onDeleteShift: (id: string) => Promise<boolean>;
  setCurrentTab: (tab: string) => void;

  menuItems: MenuItem[];
  /** WS6h: merge a SERVER-CONFIRMED store row into global state (findings 2/3). */
  applyServerStore: (row: Record<string, unknown>) => void;
  /** WS6h: merge SERVER-CONFIRMED classifications into the global catalogue. */
  applyServerClassifications: (entries: { id: string; taxCode: TaxCode | null }[]) => void;
  publishMenuItems: (next: MenuItem[] | ((prev: MenuItem[]) => MenuItem[])) => Promise<boolean>;
  stores: StoreLocation[];
  publishStores: (next: StoreLocation[] | ((prev: StoreLocation[]) => StoreLocation[])) => Promise<boolean>;
  vacancies: CareerVacancy[];
  publishVacancies: (next: CareerVacancy[] | ((prev: CareerVacancy[]) => CareerVacancy[])) => Promise<boolean>;
  articles: KnowledgeArticle[];
  publishArticles: (next: KnowledgeArticle[] | ((prev: KnowledgeArticle[]) => KnowledgeArticle[])) => Promise<boolean>;
  newsPosts: NewsPost[];
  /** R4.10 — THE publication path. Owner: all six collections; store manager:
   *  menu only (the server enforces this; the UI mirrors it by hiding the
   *  control). Resolves with the server's verdict so every toast is truthful. */
  onPublishRecord: (table: PublishableContentTable, id: string, publish: boolean) => Promise<{ ok: boolean; message?: string }>;
  onCloseVacancy: (id: string) => Promise<{ ok: boolean; message?: string }>;
  publishNewsPosts: (next: NewsPost[] | ((prev: NewsPost[]) => NewsPost[])) => Promise<boolean>;
  /** The single content model behind the public website (Website Studio). */
  siteContent: SiteContent;
  mediaItems: MediaItem[];
  publishMediaItems: (next: MediaItem[] | ((prev: MediaItem[]) => MediaItem[])) => Promise<boolean>;
  auditLogs: AuditLogItem[];
  appendAuditLog: (entry: AuditLogItem) => void;
  contactMessages: ContactMessage[];
  onUpdateContactStatus: (id: string, status: ContactMessage['status']) => Promise<boolean>;
  assessments: TrainingAssessment[];
  publishAssessments: (next: TrainingAssessment[] | ((prev: TrainingAssessment[]) => TrainingAssessment[])) => Promise<boolean>;
  trainingAssignments: TrainingAssignment[];
  publishTrainingAssignments: (next: TrainingAssignment[] | ((prev: TrainingAssignment[]) => TrainingAssignment[])) => Promise<boolean>;
  trainingCertificates: TrainingCertificate[];
  deals: Deal[];
  publishDeals: (next: Deal[] | ((prev: Deal[]) => Deal[])) => Promise<boolean>;
  siteSettings: SiteSettings;
  saveSiteSettings: (next: SiteSettings | ((prev: SiteSettings) => SiteSettings)) => Promise<boolean>;
  /* INC11: the studio's atomic publish — content + settings, one transaction. */
  onPublishStudio: (content: SiteContent | null, settings: SiteSettings | null) => Promise<boolean>;
  checklistTemplates: ChecklistTemplateItem[];
  publishChecklistTemplates: (next: ChecklistTemplateItem[] | ((prev: ChecklistTemplateItem[]) => ChecklistTemplateItem[])) => Promise<boolean>;
  cloudStatus: CloudStatus;
  /** OPT-02-C1.2: SEO synchronisation status + manual rebuild (Website → SEO). */
  seoRebuildStatus: SeoRebuildStatus;
  seoDeploymentMode: string;
  onManualSeoRebuild: () => Promise<void>;
  clockHistory: ClockHistoryItem[];
  decideTimesheets: (ids: string[], decision: 'approve' | 'reject') => Promise<boolean>;
  payslips: Payslip[];
  publishPayslips: (next: Payslip[] | ((prev: Payslip[]) => Payslip[])) => Promise<boolean>;
  emailSettings: EmailSettings;
  saveEmailSettings: (next: EmailSettings | ((prev: EmailSettings) => EmailSettings)) => Promise<boolean>;
  /** Sign-in hydration state — 'error' shows the retry banner. */
  staffDataStatus: 'idle' | 'loading' | 'live' | 'error';
  /** Re-runs the sign-in hydration after a failure. */
  onRetryHydration: () => void;
  /** Reloads the canonical public configuration after Launch Facts change. */
  onRefreshPublicContent: () => void;
}

export const AdminPanel: React.FC<AdminPanelProps> = ({
  employee,
  getAccessToken,
  activeSection,
  onSectionChange, applications, onUpdateApplicationStatus, franchiseInquiries, onUpdateFranchiseStatus,
  inboxStatus, onRefreshInbox,
  sifrReports, onResolveSIFRReport, documents, onApproveDocument, onDeleteDocument, addToast, employeesList, shiftsList,
  onAddEmployee, onStaffInvite, onUpdateEmployee, onSetHolidayAllowance, onAddShift, onDeleteShift, setCurrentTab,
  menuItems, publishMenuItems, stores, publishStores, applyServerStore, applyServerClassifications, vacancies, publishVacancies, articles, publishArticles,
  newsPosts, publishNewsPosts, onPublishRecord, onCloseVacancy, siteContent, mediaItems, publishMediaItems, auditLogs, appendAuditLog,
  contactMessages, onUpdateContactStatus, assessments, publishAssessments,
  trainingAssignments, publishTrainingAssignments, trainingCertificates,
  deals, publishDeals, siteSettings, saveSiteSettings, onPublishStudio,
  checklistTemplates, publishChecklistTemplates, cloudStatus,
  seoRebuildStatus, seoDeploymentMode, onManualSeoRebuild,
  clockHistory, decideTimesheets, payslips, publishPayslips, emailSettings, saveEmailSettings, staffDataStatus, onRetryHydration,
  onRefreshPublicContent
}) => {
  // Navigation & Control State
  // Active section — seeded from the URL (/admin/<section>) and published
  // back to it on every change. `setActiveTab` keeps its original name so
  // the dozens of existing call sites need no edits.
  const [activeTab, setActiveTabState] = useState<string>(activeSection || 'dashboard');
  const [launchFactsRefreshToken, setLaunchFactsRefreshToken] = useState(0);

  // General state logging helper triggers
  const logAction = useCallback((module: string, action: string, previousValue?: string, newValue?: string) => {
    const newLog: AuditLogItem = {
      id: createClientId('aud'),
      // SECURITY: no fabricated "Administrator Override" identities in the
      // audit trail — the route guard means employee is always present here.
      operatorName: employee?.name?.trim() || employee?.email?.trim() || employee?.id || 'authenticated-user-unresolved',
      role: employee?.role || 'unknown',
      action,
      timestamp: new Date().toISOString(),
      module,
      previousValue,
      newValue
    };
    appendAuditLog(newLog);
  }, [appendAuditLog, employee?.email, employee?.id, employee?.name, employee?.role]);

  // Block D: which application's CV is currently being fetched (for a spinner).
  const [cvLoadingId, setCvLoadingId] = useState<string | null>(null);
  const cvLoadingRef = useRef(false);
  // WP04R: the pending media object behind the menu form's current image URL.
  /* SMALL-BIZ CLOSURE P0-8 — the pending MENU upload is a single ref keyed
     by an upload SESSION, not a Map under 'last'. The old key survived form
     switches and cancels, so a pending object uploaded for product A could be
     attached to product B, and a failed attach after a successful content
     save was fire-and-forgotten. Every form open/switch/cancel/close starts a
     new session and discards the previous pending object; the save AWAITS the
     attachment and, on failure, keeps the form open with a visible retryable
     warning (the pending object is retained for that retry and can never
     reach another product — its session dies with this form). */
  const menuPendingUploadRef = React.useRef<{ objectId: string; session: number } | null>(null);
  const menuFormSessionRef = React.useRef(0);
  const resetMenuUploadSession = useCallback(() => {
    menuFormSessionRef.current += 1;
    menuPendingUploadRef.current = null;
  }, []);

  // PHASE A: the e-mail notification card edits a LOCAL DRAFT; the explicit
  // Save button commits it to the database (app_state) server-first.
  // STAGE 2: primary submit buttons disable while a mutation is in flight —
  // no duplicate submissions, no success before the server confirms.
  const [mutBusy, setMutBusy] = useState(false);
  const mutBusyRef = useRef(false);
  const withMutationBusy = useCallback(async (run: () => Promise<unknown>): Promise<void> => {
    if (mutBusyRef.current) return;
    mutBusyRef.current = true;
    setMutBusy(true);
    try {
      await run();
    } finally {
      mutBusyRef.current = false;
      setMutBusy(false);
    }
  }, []);
  /* SMALL-BIZ CLOSURE P1-1 — one awaited content action at a time. `busyAction`
     names the operation in flight; a repeat click (or a different content
     action) while one is awaited is IGNORED, never queued. Server revision
     and idempotency checks remain the final backup — this is the polite
     front door, not the lock. */
  const [busyAction, setBusyAction] = useState<string | null>(null);
  /* T13-9 — THE LOCK MUST BE SYNCHRONOUS.
     `if (busyAction) return` reads REACT STATE, which does not change until a
     re-render. Two clicks dispatched in the same tick therefore both saw
     `null` and both proceeded — the exact double-submit the guard was added to
     prevent. The ref updates immediately, so the second call is refused before
     it can reach its first await. State is still used for the DISABLED
     appearance and the progress label, which is what state is good at. */
  const busyRef = useRef<string | null>(null);
  const withBusy = useCallback(async (key: string, run: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = key;
    setBusyAction(key);
    try {
      await run();
    } finally {
      // Released on success, handled failure AND thrown exception.
      busyRef.current = null;
      setBusyAction(null);
    }
  }, []);
  // STAGE 3: which vault document is being opened via a signed URL.
  const [docOpeningId, setDocOpeningId] = useState<string | null>(null);
  const docOpeningRef = useRef(false);
  const openVaultDocument = useCallback(async (documentId: string) => {
    if (docOpeningRef.current) return;
    /* T13.3.17: reserve the tab synchronously while the click still carries
       browser user activation. Opening only after token/network awaits was
       routinely blocked as a pop-up on Safari and stricter Chrome settings. */
    const preview = window.open('', '_blank');
    if (preview) {
      preview.opener = null;
      preview.document.title = 'Opening secure document…';
      preview.document.body.textContent = 'Opening secure document…';
    }
    docOpeningRef.current = true;
    setDocOpeningId(documentId);
    try {
      const token = await freshStaffToken();
      if (!token) { preview?.close(); addToast('Your session has expired. Sign in again.', 'error'); return; }
      const result = await getStaffDocumentUrl(documentId, token);
      if (result.ok === false) { preview?.close(); addToast(result.message, 'error'); return; }
      // WP03.1: every dynamic navigation target passes the safe boundary —
      // the signed URL is server-issued https, so this is defence in depth.
      const safeDocUrl = safeExternalHref(result.data);
      if (!safeDocUrl) { preview?.close(); addToast('That document link was not valid.', 'error'); return; }
      if (preview) preview.location.replace(safeDocUrl);
      else window.location.assign(safeDocUrl);
    } finally {
      docOpeningRef.current = false;
      setDocOpeningId(null);
    }
  }, [addToast]);
  const [emailDraft, setEmailDraft] = useState<EmailSettings>(emailSettings);
  const previousEmailSettingsRef = useRef(emailSettings);
  useEffect(() => {
    const previousSource = previousEmailSettingsRef.current;
    previousEmailSettingsRef.current = emailSettings;
    // Refresh a clean draft when cloud state changes, but never erase local
    // edits that the owner has not explicitly saved yet.
    setEmailDraft((current) =>
      JSON.stringify(current) === JSON.stringify(previousSource) ? emailSettings : current);
  }, [emailSettings]);
  const emailDraftDirty = JSON.stringify(emailDraft) !== JSON.stringify(emailSettings);

  /**
   * Open a candidate's CV. The client sends only the applicationId + its auth
   * token to cv-signed-url, which checks the caller's role from the DB, resolves
   * the storage object key server-side, audits the access, and returns a
   * short-lived signed URL. The URL is opened and never stored.
   */
  const handleViewCv = useCallback(async (app: JobApplication): Promise<void> => {
    if (cvLoadingRef.current) return;
    /* Reserve the destination tab before the signed-URL request so browser
       pop-up protection does not turn a valid CV action into a silent no-op. */
    const preview = window.open('', '_blank');
    if (preview) {
      preview.opener = null;
      preview.document.title = 'Opening secure CV…';
      preview.document.body.textContent = 'Opening secure CV…';
    }
    cvLoadingRef.current = true;
    setCvLoadingId(app.id);
    try {
      const token = await getAccessToken();
      if (!token) {
        preview?.close();
        addToast('Your session has expired — please sign in again to view CVs.', 'error');
        return;
      }
      const url = await fetchCvSignedUrl(app.id, token);
      if (!url) {
        preview?.close();
        addToast('This CV could not be opened. It may have been removed, or you may not have access.', 'error');
        return;
      }
      // cv-signed-url writes one authoritative granted/refused activity_log
      // row using the server-derived actor. Do not add a second browser audit.
      const safeCvUrl = safeExternalHref(url);
      if (!safeCvUrl) { preview?.close(); addToast('That CV link was not valid.', 'error'); return; }
      if (preview) preview.location.replace(safeCvUrl);
      else window.location.assign(safeCvUrl);
    } finally {
      cvLoadingRef.current = false;
      setCvLoadingId(null);
    }
  }, [addToast, getAccessToken]);

  // Shared identity indexes avoid repeated linear lookups across rota,
  // timesheets, recognition and the staff drawer.
  const employeesById = useMemo(
    () => new Map(employeesList.map((employeeItem) => [employeeItem.id, employeeItem])),
    [employeesList],
  );
  const storesById = useMemo(
    () => new Map(stores.map((store) => [store.id, store])),
    [stores],
  );
  const activeStaffStores = useMemo(
    () => stores.filter((store) => !store.setupStatus || store.setupStatus === 'ACTIVE'),
    [stores],
  );
  const singleActiveStaffStore = activeStaffStores.length === 1 ? activeStaffStores[0] : undefined;

  // Form Submissions & Drawer Variables
  const [selectedStaffUser, setSelectedStaffUser] = useState<EmployeeProfile | null>(null);
  useEffect(() => {
    if (!selectedStaffUser) return;
    const current = employeesById.get(selectedStaffUser.id) || null;
    if (current !== selectedStaffUser) setSelectedStaffUser(current);
    // The selected ID is the stable identity; refresh its data whenever the
    // authoritative employee list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeesById, selectedStaffUser?.id]);
  const selectedStaffShifts = useMemo(() => {
    if (!selectedStaffUser) return [];
    return shiftsList
      .filter((shift) => shift.employeeId === selectedStaffUser.id)
      .sort((left, right) => left.date.localeCompare(right.date));
  }, [selectedStaffUser, shiftsList]);
  const selectedStaffClockRows = useMemo(
    () => selectedStaffUser
      ? clockHistory.filter((entry) => entry.employeeId === selectedStaffUser.id)
      : [],
    [clockHistory, selectedStaffUser],
  );
  const enabledEmployees = useMemo(
    () => employeesList.filter((employeeItem) => employeeItem.status !== 'disabled'),
    [employeesList],
  );
  const sortedPayslips = useMemo(
    () => [...payslips].sort((left, right) => right.periodKey.localeCompare(left.periodKey) || left.employeeName.localeCompare(right.employeeName)),
    [payslips],
  );
  const [holidayDialogTarget, setHolidayDialogTarget] = useState<EmployeeProfile | null>(null);
  const [contactReplyTarget, setContactReplyTarget] = useState<ContactMessage | null>(null);
  const [businessDialogBusy, setBusinessDialogBusy] = useState(false);
  const businessDialogBusyRef = useRef(false);
  const withBusinessDialogBusy = async (run: () => Promise<void>): Promise<void> => {
    if (businessDialogBusyRef.current) return;
    businessDialogBusyRef.current = true;
    setBusinessDialogBusy(true);
    try {
      await run();
    } finally {
      businessDialogBusyRef.current = false;
      setBusinessDialogBusy(false);
    }
  };
  const [isFormOpen, setIsFormOpen] = useState<boolean>(false);
  const entityDialogRef = useRef<HTMLDivElement | null>(null);
  const setupDialogRef = useRef<HTMLDivElement | null>(null);
  const classificationDialogRef = useRef<HTMLDivElement | null>(null);
  const [searchFilterId, setSearchFilterId] = useState<string>('all');

  // Shared form inputs model
  type EntityFormType = 'menu' | 'store' | 'staff' | 'vacancy';
  const [formType, setFormType] = useState<EntityFormType>('menu');
  const freshMenuForm = (): Partial<MenuItem> => ({ name: '', category: 'milkshakes', description: '', tags: [], allergens: [] });
  const [menuFormState, setMenuFormState] = useState<Partial<MenuItem>>(freshMenuForm);
  const [storeFormState, setStoreFormState] = useState<Partial<StoreLocation>>({ name: '', address: '', postcode: '', phone: '', email: '', status: 'coming_soon', openingHours: '' });
  /* SMALL-BIZ CLOSURE P0-9/P0-10: no fictional 's1'/"Milk Pop" store identity
     and no invented holiday figure — the store is a REQUIRED selection from
     real stores (defaulted only when exactly one active store exists), and
     the holiday allowance is an explicit field prefilled with the server
     contract value supplied by the owner. */
  const [staffFormState, setStaffFormState] = useState<Partial<EmployeeProfile>>({ name: '', email: '', role: 'team_member', storeId: '', storeName: '' });
  /** The fresh onboarding form defaults only the store when exactly one active
   *  store exists. Holiday allowance remains blank until the owner enters the
   *  employee's actual contractual pro-rated entitlement. */
  const freshStaffForm = useCallback((): Partial<EmployeeProfile> => ({
    name: '', email: '', role: 'team_member',
    storeId: singleActiveStaffStore?.id || '',
    storeName: singleActiveStaffStore?.name || '',
  }), [singleActiveStaffStore]);
  const freshVacancyForm = (): Partial<CareerVacancy> => ({ title: '', department: '', location: '', salary: '', type: 'Part-time', roleDescription: '', requirements: [], responsibilities: [] });
  const [vacancyFormState, setVacancyFormState] = useState<Partial<CareerVacancy>>(freshVacancyForm);
  const openCreateVacancy = useCallback((): void => {
    setFormType('vacancy');
    setEditItemId(null);
    setVacancyFormState({ title: '', department: '', location: '', salary: '', type: 'Part-time', roleDescription: '', requirements: [], responsibilities: [] });
    setIsFormOpen(true);
  }, []);
  const openEditVacancy = useCallback((vacancy: CareerVacancy): void => {
    setFormType('vacancy');
    setEditItemId(vacancy.id);
    setVacancyFormState({ ...vacancy });
    setIsFormOpen(true);
  }, []);
  const openStaffEditorFromDashboard = useCallback(() => {
    setFormType('staff');
    setStaffFormState(freshStaffForm());
    setIsFormOpen(true);
  }, [freshStaffForm]);
  const openMenuEditorFromDashboard = useCallback(() => {
    setFormType('menu');
    setMenuFormState(freshMenuForm());
    setEditItemId(null);
    resetMenuUploadSession();
    setIsFormOpen(true);
  }, [resetMenuUploadSession]);
  const [shiftFormState, setShiftFormState] = useState<Partial<WorkShift>>({ employeeId: '', date: businessTodayISO(), startTime: '09:00', endTime: '17:00', type: 'mid', notes: '' });

  /* ---------------- Payroll, rota grid & e-mail helpers ---------------- */
  // Week navigation for the all-staff weekly grid (0 = this week)
  const [weekOffset, setWeekOffset] = useState<number>(0);
  const rotaTodayIso = businessTodayISO();
  const rotaModel = useMemo(() => buildRotaScheduleModel(shiftsList, employeesList), [shiftsList, employeesList]);
  const rotaWeekWindow = useMemo(() => buildRotaWeekWindow(weekOffset, rotaTodayIso), [weekOffset, rotaTodayIso]);
  const rotaWeekIsoSet = useMemo(() => new Set(rotaWeekWindow.isos), [rotaWeekWindow]);
  const rotaDisplayedWeekShifts = useMemo(
    () => shiftsList.filter((shift) => rotaWeekIsoSet.has(shift.date)),
    [shiftsList, rotaWeekIsoSet],
  );
  const rotaDisplayedEmployeeHours = useMemo(() => {
    const hours = new Map<string, number>();
    for (const shift of rotaDisplayedWeekShifts) {
      hours.set(shift.employeeId, (hours.get(shift.employeeId) || 0) + shiftDurationHours(shift.startTime, shift.endTime));
    }
    return hours;
  }, [rotaDisplayedWeekShifts]);

  // Payslip period selector — lazy so an unrelated render never repeats
  // calendar work. The pure period model feeds generation and preview alike.
  const [payslipMonth, setPayslipMonth] = useState<string>(() => previousCalendarMonthKey());
  const payrollPeriod = useMemo(
    () => buildAdminPayrollPeriod(employeesList, clockHistory, payslips, payslipMonth),
    [employeesList, clockHistory, payslips, payslipMonth],
  );
  const [emailBusyId, setEmailBusyId] = useState<string | null>(null);
  const emailBusyRef = useRef<string | null>(null);
  const withEmailBusy = async (key: string, run: () => Promise<void>): Promise<void> => {
    if (emailBusyRef.current) return;
    emailBusyRef.current = key;
    setEmailBusyId(key);
    try {
      await run();
    } finally {
      emailBusyRef.current = null;
      setEmailBusyId(null);
    }
  };
  const [expandedPayslipEmp, setExpandedPayslipEmp] = useState<string | null>(null);

  /* SMALL-BIZ CLOSURE P0-10: the pay rule lives in ONE shared module
     (src/lib/pay.ts) so the Admin Panel and the Staff Portal can never
     disagree about someone's rate. See that file for the full contract. */

  const handleApproveTimesheet = useCallback(async (id: string): Promise<void> =>
    withBusy(`timesheet:approve:${id}`, async () => {
      const ok = await decideTimesheets([id], 'approve');
      if (!ok) return;
      logAction('Timesheets', `Approved timesheet entry ${id}`);
      addToast('Hours approved — the server recorded the approver and decision time.', 'success');
    }), [addToast, decideTimesheets, logAction, withBusy]);

  const handleRejectTimesheet = useCallback(async (id: string): Promise<void> =>
    withBusy(`timesheet:reject:${id}`, async () => {
      const ok = await decideTimesheets([id], 'reject');
      if (!ok) return;
      logAction('Timesheets', `Rejected timesheet entry ${id}`);
      addToast('Hours rejected — the server recorded the decision.', 'warning');
    }), [addToast, decideTimesheets, logAction, withBusy]);

  const handleApproveAllTimesheets = useCallback(async (pendingCount: number): Promise<void> =>
    withBusy('timesheet:approve-all', async () => {
      const ids = clockHistory.filter((entry) => !entry.approved && !entry.rejected).map((entry) => entry.id);
      if (!ids.length) return;
      if (!window.confirm(`Approve all ${ids.length} pending entries?`)) return;
      const ok = await decideTimesheets(ids, 'approve');
      if (!ok) return;
      logAction('Timesheets', `Bulk-approved ${ids.length} timesheet entries`);
      addToast(`${ids.length} timesheet entries approved.`, 'success');
    }), [addToast, clockHistory, decideTimesheets, logAction, withBusy]);

  /** Fire-and-forget "new shift" e-mail; honest toast if delivery isn't set up. */
  const notifyShiftByEmail = (shift: WorkShift) => {
    if (!emailSettings.enabled || !emailSettings.notifyNewShift) return;
    const emp = employeesById.get(shift.employeeId);
    if (!emp?.email) return;
    sendTemplateEmail({
      ...emailPayloads.shift(shift),
      fromName: emailSettings.fromName,
      brand: siteSettings.brandName || 'Milk Pop',
    }).then(err => {
      if (err) addToast('Shift saved, but the notification e-mail failed: ' + err, 'warning');
      else addToast(`Shift e-mail sent to ${emp.name}.`, 'info');
    });
  };


  const deleteShiftWithFeedback = async (
    shift: Pick<WorkShift, 'id' | 'employeeName' | 'date'>,
    auditAction: string,
  ): Promise<void> => withBusy(`shift:delete:${shift.id}`, async () => {
    if (!window.confirm(`Delete ${shift.employeeName}'s shift on ${shift.date}?`)) return;
    if (!(await onDeleteShift(shift.id))) return;
    logAction('Schedulers', auditAction);
    addToast(`Shift block for "${shift.employeeName}" deleted.`, 'warning');
  });

  const [editItemId, setEditItemId] = useState<string | null>(null);

  // Settings / Cloud module state. Deals and checklist drafts live in
  // their extracted panels so typing in either editor does not rerender this
  // controller and every unrelated admin workflow.
  const [settingsDraft, setSettingsDraft] = useState<SiteSettings>(siteSettings);
  const previousSiteSettingsRef = useRef(siteSettings);
  useEffect(() => {
    const previousSource = previousSiteSettingsRef.current;
    previousSiteSettingsRef.current = siteSettings;
    // Preserve unsaved local edits if Website Studio or another tab publishes
    // fresh company state in the background.
    setSettingsDraft((current) =>
      JSON.stringify(current) === JSON.stringify(previousSource) ? siteSettings : current);
  }, [siteSettings]);
  const cur = displayCurrencySymbol(siteSettings.currencySymbol);

  // R4.8 Workstream B — End-employment dialog target (replaces raw deletion).
  const [endingEmployee, setEndingEmployee] = useState<{ id: string; name: string } | null>(null);

  // Recognition draft state lives in RecognitionPanel so typing there does not
  // rerender every other administrative workflow.

  const currentRole = employee?.role || 'team_member';
  const canRoleOpenAdminSection = useCallback(
    (id: Parameters<typeof isAdminRoleAllowed>[0]): boolean => isAdminRoleAllowed(id, currentRole),
    [currentRole],
  );

  // Alerts and headline counts are role-projected before they reach the pure
  // dashboard model. RLS remains authoritative, but a stale parent collection
  // or an in-session role change must not reveal even an aggregate owner-only
  // contact/franchise signal to a store manager.
  const alertsList = useMemo(
    () => buildAdminDashboardAlerts(
      canRoleOpenAdminSection('careers') ? applications : [],
      canRoleOpenAdminSection('franchise') ? franchiseInquiries : [],
      canRoleOpenAdminSection('sifr') ? sifrReports : [],
      canRoleOpenAdminSection('docs') ? documents : [],
    ),
    [applications, franchiseInquiries, sifrReports, documents, canRoleOpenAdminSection],
  );
  const dashboardMetrics = useMemo(
    () => buildAdminDashboardMetrics(
      canRoleOpenAdminSection('contact') ? contactMessages : [],
      canRoleOpenAdminSection('careers') ? applications : [],
      canRoleOpenAdminSection('franchise') ? franchiseInquiries : [],
      employeesList,
      siteSettings,
    ),
    [contactMessages, applications, franchiseInquiries, employeesList, siteSettings, canRoleOpenAdminSection],
  );
  const trainingCompletionRows = useMemo(
    () => buildAdminTrainingCompletionRows(assessments || [], trainingCertificates, employeesList),
    [assessments, trainingCertificates, employeesList],
  );

  /* ==================== R4.10 — PUBLICATION CONTROLS ====================
     One protected path for "make public" / "withdraw": the publish_record
     RPC. These helpers mirror the SERVER's authorisation matrix (owner: all
     six collections; store manager: menu only) so controls a role cannot use
     are hidden, not shown-and-broken — and every toast states what the
     server actually did, because it fires only on the server's answer. */
  /* INC11: the publication scope is FOUR collections (menu, deals, news,
   * vacancies) — media and CMS pages left it (supersession note in
   * migration_inc11_publication_scope.sql), so no control below ever offers
   * them. Owner publishes all four; a store manager the menu only. */
  const canPublishTable = (table: PublishableContentTable): boolean =>
    currentRole === 'owner' || (currentRole === 'store_manager' && table === 'menu_items');

  const publishOne = useCallback(async (table: PublishableContentTable, id: string, publish: boolean, label: string): Promise<void> =>
    withBusy(`publish:${table}:${id}`, async () => {
      const res = await onPublishRecord(table, id, publish);
      if (res.ok) {
        // publish_record writes the authoritative audit row in the same
        // transaction as the lifecycle change. A second browser-authored row
        // here duplicated every publish/unpublish action.
        addToast(publish ? `${label} is now live on the public site.` : `${label} withdrawn — back to draft.`, 'success');
      } else {
        addToast(res.message || 'The publication was refused.', 'error');
      }
    }), [addToast, onPublishRecord, withBusy]);

  /* WS6e — owner Store Setup Wizard. setupOverlay carries the server row
     returned by configure_store_setup() so a just-activated store displays
     its true state before the next collection sync (the browser cannot write
     these columns itself; cloudSync omits them). */
  const [setupWizardStore, setSetupWizardStore] = useState<StoreLocation | null>(null);
  const [setupOverlay, setSetupOverlay] = useState<Record<string, Partial<StoreLocation>>>({});
  // Opening facts use the server-confirmed overlay immediately after Store
  // Setup succeeds, instead of showing the old draft state until hydration.
  const openingSummary = useMemo(
    () => buildAdminOpeningSummary(stores, setupOverlay, menuItems, siteSettings),
    [stores, setupOverlay, menuItems, siteSettings],
  );
  const {
    publicStoreCount, privateStoreCount, publicMenuCount, privateMenuCount, hasPublicContact,
  } = openingSummary;
  const [wizardBusy, setWizardBusy] = useState(false);
  const wizardBusyRef = useRef(false);
  /* WS6f (audit F3/F4): owner classification. taxOverlay mirrors confirmed
     server classifications on top of the (publish-omitted) local menu copies;
     classifyDraft is the wizard's editable per-product state. */
  const [taxOverlay, setTaxOverlay] = useState<Record<string, TaxCode | null>>({});
  const [classifyDraft, setClassifyDraft] = useState<Record<string, TaxCode | ''>>({});
  /* WS6f-b: the classification editor is a STANDALONE owner surface, not just
     an activation step — a menu published after activation can introduce an
     unclassified product, and the till then fails closed on that product
     alone. The owner needs a permanent way to see and fix that. */
  const [classifyOpen, setClassifyOpen] = useState(false);
  const [classifyBusy, setClassifyBusy] = useState(false);
  const classifyBusyRef = useRef(false);

  /* A store CHARGES only once its registration date has arrived (WS6f F1) —
     the same predicate the server applies. Unclassified products matter
     operationally the moment any store is charging. */
  const anyStoreCharging = useMemo(
    () => stores.some((st) => isVatCharging({ ...st, ...setupOverlay[st.id] })),
    [stores, setupOverlay]);
  const unclassifiedItems = useMemo(
    () => menuItems.filter((mi) => !((taxOverlay[mi.id] ?? mi.taxCode) ?? '')),
    [menuItems, taxOverlay]);

  /** Apply the CHANGED classifications through the owner-only RPC. */
  const applyClassifications = async (): Promise<boolean> => {
    const changed = menuItems
      .filter((mi) => (classifyDraft[mi.id] ?? '') !== (((taxOverlay[mi.id] ?? mi.taxCode) ?? '') as TaxCode | ''))
      .map((mi) => ({ id: mi.id, taxCode: (classifyDraft[mi.id] || null) as TaxCode | null }));
    if (!changed.length) return true;
    const token = (await freshStaffToken()) || '';
    const res = await classifyProducts(changed, token);
    if (!res.ok) {
      addToast(res.error === 'owner_aal2_required'
        ? 'Owner sign-in with MFA is required to classify products.'
        : `Classification failed: ${res.error}`, 'error');
      return false;
    }
    setTaxOverlay((prev) => ({ ...prev, ...Object.fromEntries(changed.map((c) => [c.id, c.taxCode])) }));
    // Findings 2/3: the overlay paints THIS panel immediately; global state is
    // what the till reads. Both, always — never the overlay alone.
    applyServerClassifications(changed);
    logAction('Menu Operations', `Set the VAT classification on ${changed.length} product(s).`);
    return true;
  };

  /** The per-product classification grid, shared by the wizard and the
   *  standalone editor so both always offer the same controlled codes. */
  const classificationGrid = () => (
    <div className="max-h-64 overflow-y-auto border border-[#EBDECE] rounded-xl divide-y divide-[#EBDECE]/60">
      {menuItems.map((mi) => (
        <div key={mi.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
          <span className="text-2xs font-bold truncate">{mi.name}</span>
          <select value={classifyDraft[mi.id] ?? ''}
            onChange={(e) => setClassifyDraft(d => ({ ...d, [mi.id]: e.target.value as TaxCode | '' }))}
            className="bg-stone-50 border border-[#EBDECE] rounded-lg px-2 py-1 text-[10px] font-mono outline-none">
            {/* WS6i: a classification is permanent once set — the blank option
                remains selectable only while the product has none. */}
            <option value="" disabled={!!((taxOverlay[mi.id] ?? mi.taxCode) ?? '')}>— unclassified —</option>
            <option value="ZERO_RATED">Zero-rated (0%)</option>
            <option value="REDUCED_RATE">Reduced (5%)</option>
            <option value="STANDARD_RATE">Standard (20%)</option>
            <option value="OUTSIDE_SCOPE">Outside scope</option>
          </select>
        </div>
      ))}
    </div>
  );
  const [wizardForm, setWizardForm] = useState<{
    timezone: string; currencyCode: string; paymentMethods: PaymentMethod[];
    receiptFooter: string; vatStatus: VatStatus; vatNumber: string; vatEffectiveDate: string;
  }>({ timezone: 'Europe/London', currencyCode: 'GBP', paymentMethods: ['cash', 'card', 'online'],
       receiptFooter: '', vatStatus: 'NOT_REGISTERED', vatNumber: '', vatEffectiveDate: '' });
  // C1.3: is legacy browser (localStorage) data actually present on THIS device?
  // Drives whether the migration-only Legacy Import section is offered at all, so
  // the utility stays hidden on a clean install (audit finding #4).
  const legacyDetected = useMemo(() => hasLegacyData(), []);
  const navigationBadges = useMemo(() => ({
    dashboard: alertsList.length,
    contact: dashboardMetrics.newContactMessages,
    timesheets: clockHistory.filter((entry) => !entry.approved && !entry.rejected).length,
    docs: documents.filter((document) => document.status === 'pending').length,
    sifr: sifrReports.filter((report) => isSifrOpenStatus(report.status)).length,
    deals: deals.filter((deal) => deal.active).length,
    news: newsPosts.filter((post) => post.status === 'draft').length,
    careers: dashboardMetrics.pendingApplications,
    franchise: dashboardMetrics.pendingFranchiseInquiries,
  }), [alertsList.length, dashboardMetrics, clockHistory, documents, sifrReports, deals, newsPosts]);
  const sidebarSections = useMemo(() => buildAdminNavigation(currentRole, navigationBadges, {
    isOwner: currentRole === 'owner',
    mediaV2: MEDIA_V2,
    legacyEnabled: LEGACY_IMPORT,
    legacyDetected,
  }), [currentRole, navigationBadges, legacyDetected]);

  // ROUTING SAFETY: the URL is untrusted input. A deep link may name a
  // section this role's sidebar does not offer — fall back to the dashboard
  // and canonicalise the URL with replace (no history pollution). Back /
  // forward navigation lands here too via the `activeSection` prop.
  const allowedSectionIds = useMemo(
    () => sidebarSections.flatMap((section) => section.items.map((item) => item.id)),
    [sidebarSections],
  );
  const allowedSectionSet = useMemo(() => new Set<string>(allowedSectionIds), [allowedSectionIds]);
  const canOpenAdminSection = useCallback(
    (id: string): boolean => allowedSectionSet.has(id),
    [allowedSectionSet],
  );
  // Fail closed during render. React effects run after paint, so relying on the
  // URL-correction effect alone could briefly mount an owner-only panel for a
  // manager following a stale or crafted deep link. The database remains the
  // authority, but the UI must never render a section this role cannot open.
  const effectiveActiveTab = canOpenAdminSection(activeTab) ? activeTab : 'dashboard';
  const setActiveTab = useCallback((id: string) => {
    const next = canOpenAdminSection(id) ? id : 'dashboard';
    setActiveTabState(next);
    onSectionChange?.(next, next !== id);
  }, [canOpenAdminSection, onSectionChange]);

  const openSystemStatus = useCallback(() => {
    setActiveTab('dashboard');
    // The health panels mount after the tab switch. Two animation frames keep
    // this direct and deterministic without adding a cross-panel state store.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const section = document.getElementById('system-status');
        section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        section?.focus({ preventScroll: true });
      });
    });
  }, [setActiveTab]);

  useEffect(() => {
    if (activeTab !== effectiveActiveTab) {
      setActiveTabState(effectiveActiveTab);
      onSectionChange?.(effectiveActiveTab, true);
    }
  }, [activeTab, effectiveActiveTab, onSectionChange]);

  useEffect(() => {
    const requested = activeSection || 'dashboard';
    const next = canOpenAdminSection(requested) ? requested : 'dashboard';
    if (next !== activeTab) setActiveTabState(next);
    if (next !== requested) onSectionChange?.(next, true);
  }, [activeSection, activeTab, canOpenAdminSection, onSectionChange]);

  // Helper arrays for allergens and popular categories live at module scope.

  const openingSetupItems = useMemo(() => [
    {
      done: publicStoreCount > 0,
      label: 'Publish your first store',
      detail: stores.length ? 'Complete the location and activate it when it is ready for customers.' : 'Add the real location; incomplete details stay private.',
      tab: 'stores',
    },
    {
      done: publicMenuCount > 0,
      label: 'Publish the opening menu',
      detail: menuItems.length ? 'Complete and publish at least one confirmed product.' : 'Add only confirmed products; unfinished items remain unavailable.',
      tab: 'menu',
    },
    {
      done: hasPublicContact,
      label: 'Add public contact details',
      detail: 'Blank or placeholder details stay hidden until you are ready to publish them.',
      tab: 'settings',
    },
  ].filter((item) => canOpenAdminSection(item.tab)), [
    publicStoreCount, stores.length, publicMenuCount, menuItems.length, hasPublicContact, canOpenAdminSection,
  ]);
  const dashboardQuickActions = useMemo(
    () => DEFAULT_DASHBOARD_QUICK_ACTIONS.filter((action) => canOpenAdminSection(action.tab)),
    [canOpenAdminSection],
  );
  const canViewAuditFeed = canOpenAdminSection('audit');

  const transitionApplicationWithFeedback = useCallback(async (
    app: JobApplication,
    status: JobApplication['status'],
  ): Promise<void> => withBusy(`candidate:${app.id}`, async () => {
    if (status === 'declined' && !window.confirm(`Decline ${app.fullName}'s application?`)) return;
    const ok = await onUpdateApplicationStatus(app.id, status);
    if (!ok) return;
    const actionLabel: Record<JobApplication['status'], string> = {
      pending: 'returned to pending', reviewing: 'moved to screening', interview: 'marked for interview', offer: 'marked as offer', declined: 'declined',
    };

    // INC11 makes the database transition the single audit vehicle. Offer and
    // decline notifications are also enqueued by that same transaction; doing
    // either again here produced duplicate audit rows and duplicate candidate
    // e-mails. Interview remains an explicit, non-terminal message and is sent
    // through the normal server-resolved template path below.
    if (status === 'offer' || status === 'declined') {
      addToast(
        status === 'offer'
          ? `${app.fullName} marked as offer. Candidate delivery is handled by the server outbox when customer acknowledgements are commissioned.`
          : `${app.fullName} declined. Candidate delivery is handled by the server outbox when customer acknowledgements are commissioned.`,
        status === 'declined' ? 'info' : 'success',
      );
      return;
    }
    if (status === 'reviewing' || status === 'pending') {
      addToast(`Candidate "${app.fullName}" ${actionLabel[status]}.`, 'info');
      return;
    }
    if (!emailSettings.enabled) {
      addToast(`${app.fullName} ${actionLabel[status]}. Candidate e-mails are disabled, so no interview message was sent.`, 'success');
      return;
    }
    const error = await sendTemplateEmail({
      ...emailPayloads.applicationInterview(app),
      fromName: emailSettings.fromName,
      brand: siteSettings.brandName || 'Milk Pop',
    });
    addToast(
      error ? `Status updated, but the interview e-mail failed: ${error}` : `Interview e-mail sent to ${app.fullName}.`,
      error ? 'warning' : 'success',
    );
  }), [addToast, emailSettings.enabled, emailSettings.fromName, onUpdateApplicationStatus, siteSettings.brandName, withBusy]);

  const deleteStoreWithFeedback = async (store: StoreLocation): Promise<void> =>
    withBusy(`store:delete:${store.id}`, async () => {
      if (!window.confirm(`Delete store "${store.name}"? This removes the location record and cannot be undone.`)) return;
      if (!(await publishStores((previous) => previous.filter((item) => item.id !== store.id)))) return;
      logAction('Stores Operations', `Purged store listing "${store.name}" from locator network.`);
      addToast(`Store "${store.name}" deleted.`, 'warning');
    });

  const setStorePublicStatus = async (store: StoreLocation, status: StoreLocation['status']): Promise<void> =>
    withBusy(`store:${status}:${store.id}`, async () => {
      if (status === 'open' && !isCompletePublicStore(store)) {
        addToast('Add a real name, address, postcode and opening hours before marking this store open.', 'error');
        return;
      }
      if (!(await publishStores((previous) => previous.map((item) => item.id === store.id ? { ...item, status } : item)))) return;
      const statusLabel = status === 'open' ? 'Open' : status === 'closed' ? 'Closed' : 'Coming Soon';
      logAction('Store Locations', `Marked store "${store.name}" as ${statusLabel}`, store.status, status);
      addToast(`Store now appears as “${statusLabel}” on the public locator.`, status === 'open' ? 'success' : 'info');
    });

  const deleteMenuItemWithFeedback = async (item: MenuItem): Promise<void> =>
    withBusy(`menu:delete:${item.id}`, async () => {
      if (item.available) {
        addToast(`"${item.name}" is live on the guest menu — unpublish it before deleting.`, 'error');
        return;
      }
      if (!window.confirm(`Delete product "${item.name}"? This cannot be undone.`)) return;
      if (!(await publishMenuItems((previous) => previous.filter((candidate) => candidate.id !== item.id)))) return;
      logAction('Menu Manager', `Purged dessert option "${item.name}" from database.`);
      addToast(`Product "${item.name}" deleted.`, 'warning');
    });

  const approveDocumentWithFeedback = useCallback(async (document: StaffDocument): Promise<void> =>
    withBusy(`document:approve:${document.id}`, async () => {
      if (!window.confirm(`Sign off "${document.name}" as reviewed?`)) return;
      if (!(await onApproveDocument(document.id))) return;
      logAction('Compliance Vault', `Authorized compliance document sign-off: "${document.name}"`);
      addToast(`Compliance document "${document.name}" signed off successfully.`, 'success');
    }), [addToast, logAction, onApproveDocument, withBusy]);

  const deleteDocumentWithFeedback = useCallback(async (document: StaffDocument): Promise<void> => {
    if (!window.confirm(`Permanently remove "${document.name}"${document.employeeName ? ` (${document.employeeName})` : ''}? The private file will be deleted and an audit tombstone retained. This cannot be undone.`)) return;
    await withMutationBusy(async () => { await onDeleteDocument(document.id); });
  }, [onDeleteDocument, withMutationBusy]);

  const resolveSifrWithFeedback = async (report: SIFRReport): Promise<void> =>
    withBusy(`sifr:resolve:${report.id}`, async () => {
      if (!window.confirm(`Mark incident "${report.title}" as resolved?`)) return;
      if (!(await onResolveSIFRReport(report.id))) return;
      logAction('SIFR Desk', `Archived and resolved staffing incident log reference: "${report.title}"`);
      addToast(`Incident report "${report.title}" resolved safely.`, 'success');
    });

  const updateFranchiseStatusWithFeedback = useCallback(async (
    inquiry: FranchiseInquiry,
    status: 'contacted' | 'approved',
  ): Promise<void> => withBusy(`franchise:${inquiry.id}`, async () => {
    if (!(await onUpdateFranchiseStatus(inquiry.id, status))) return;
    if (status === 'contacted') {
      logAction('Franchise desk', `Marked franchise enquiry from "${inquiry.fullName}" as contacted`);
      addToast('Enquiry marked as contacted. Arrange any call through your normal calendar or e-mail workflow.', 'info');
      return;
    }
    logAction('Franchise desk', `Marked franchise enquiry as suitable for the next review stage in city "${inquiry.city}" requested by candidate "${inquiry.fullName}"`);
    addToast('Franchise enquiry marked suitable for the next review stage.', 'success');
  }), [addToast, logAction, onUpdateFranchiseStatus, withBusy]);

  const updateContactStatusWithFeedback = useCallback(async (
    message: ContactMessage,
    status: ContactMessage['status'],
  ): Promise<void> => withBusy(`contact:${status}:${message.id}`, async () => {
    const saved = await onUpdateContactStatus(message.id, status);
    if (!saved) return;
    addToast(
      status === 'replied' ? 'Message marked as replied.' : status === 'closed' ? 'Message closed.' : 'Message reopened.',
      status === 'closed' ? 'info' : 'success',
    );
  }), [addToast, onUpdateContactStatus, withBusy]);

  const closeVacancyWithFeedback = useCallback(async (vacancy: CareerVacancy): Promise<void> =>
    withBusy(`vacancy:close:${vacancy.id}`, async () => {
      if (!window.confirm(`Close the "${vacancy.title}" vacancy? It leaves the careers page but keeps its application history.`)) return;
      const result = await onCloseVacancy(vacancy.id);
      if (!result.ok) return;
      // close_vacancy writes the audited transition atomically with the status change.
      addToast(`Vacancy "${vacancy.title}" closed — history retained.`, 'success');
    }), [addToast, onCloseVacancy, withBusy]);

  const deleteVacancyWithFeedback = useCallback(async (vacancy: CareerVacancy): Promise<void> =>
    withBusy(`vacancy:delete:${vacancy.id}`, async () => {
      if (vacancy.status === 'published') {
        addToast(`"${vacancy.title}" is live — close it (or unpublish) before deleting.`, 'error');
        return;
      }
      if (!window.confirm(`Delete the "${vacancy.title}" draft?`)) return;
      if (!(await publishVacancies((previous) => previous.filter((item) => item.id !== vacancy.id)))) return;
      logAction('Careers Recruiter', `Deleted vacancy draft "${vacancy.title}"`);
      addToast(`Vacancy "${vacancy.title}" deleted.`, 'warning');
    }), [addToast, logAction, publishVacancies, withBusy]);

  // Capture this render's upload session. An upload started for product A must
  // retain A's session even if the same editor component is reused for product B.
  const menuFormSession = menuFormSessionRef.current;
  const entityFormSaving = busyAction === 'form-save';
  const closeEntityForm = (): void => {
    // Read the synchronous lock, not React state: a close click in the same
    // tick as Save must not destroy the upload session while persistence is in flight.
    if (busyRef.current === 'form-save') return;
    setIsFormOpen(false);
    setEditItemId(null);
    resetMenuUploadSession();
  };

  // These three legacy overlays are real modal dialogs. Give keyboard users a
  // deterministic focus target and one Escape route, while respecting each
  // workflow's synchronous busy lock so an in-flight write cannot be abandoned.
  useEffect(() => {
    const activeDialog = isFormOpen
      ? entityDialogRef.current
      : setupWizardStore
        ? setupDialogRef.current
        : classifyOpen
          ? classificationDialogRef.current
          : null;
    if (!activeDialog) return undefined;

    const focusTimer = window.setTimeout(() => activeDialog.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isFormOpen && busyRef.current !== 'form-save') {
        setIsFormOpen(false);
        setEditItemId(null);
        resetMenuUploadSession();
      } else if (setupWizardStore && !wizardBusyRef.current) {
        setSetupWizardStore(null);
      } else if (classifyOpen && !classifyBusyRef.current) {
        setClassifyOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isFormOpen, setupWizardStore, classifyOpen]);

  const updateStaffPayWithFeedback = async (
    target: EmployeeProfile,
    patch: Pick<EmployeeProfile, 'payType'> | Pick<EmployeeProfile, 'payRate'>,
    successMessage: string,
  ): Promise<void> => withBusy(`staff:pay:${target.id}`, async () => {
    const updated: EmployeeProfile = { ...target, ...patch };
    if (!(await onUpdateEmployee(updated))) return;
    setSelectedStaffUser((current) => current?.id === updated.id ? updated : current);
    addToast(successMessage, 'success');
  });

  return (
    <>
      <AdminShell
        employee={employee}
        staffDataStatus={staffDataStatus}
        onRetryHydration={onRetryHydration}
        sections={sidebarSections}
        activeTab={effectiveActiveTab}
        onNavigate={setActiveTab}
        onSetCurrentTab={setCurrentTab}
        canOpenSection={canOpenAdminSection}
        siteContent={siteContent}
        employees={employeesList}
        menuItems={menuItems}
        stores={stores}
        documents={documents}
        incidents={sifrReports}
        currencySymbol={cur}
      >
        {/* Main interactive Tab Routing Workspace panels */}

          {/* ==================== 1. DASHBOARD OVERVIEW PANEL ==================== */}
          {effectiveActiveTab === 'dashboard' && (
            <DashboardPanel
              openingSummary={openingSummary}
              totalStores={stores.length}
              totalMenuItems={menuItems.length}
              metrics={dashboardMetrics}
              totalEmployees={employeesList.length}
              openingSetupItems={openingSetupItems}
              alerts={alertsList}
              quickActions={dashboardQuickActions}
              auditLogs={auditLogs}
              releaseVersion={BUILD_RELEASE_IDENTITY}
              canManageStores={canOpenAdminSection('stores')}
              canHireStaff={canOpenAdminSection('staff')}
              canCreateProduct={canOpenAdminSection('menu')}
              canOpenSettings={canOpenAdminSection('settings')}
              canViewAuditFeed={canViewAuditFeed}
              onNavigate={setActiveTab}
              onHireStaff={openStaffEditorFromDashboard}
              onCreateProduct={openMenuEditorFromDashboard}
            />
          )}

          {/* ==================== 2. ANALYTICS GRAPHS ==================== */}
          {effectiveActiveTab === 'analytics' && (
            <AnalyticsPanel
              trainingCompletionRows={trainingCompletionRows}
              recruitmentBars={dashboardMetrics.recruitmentBars}
            />
          )}

          {/* ==================== 3. WEBSITE STUDIO ====================
              The owner's full editor for the public site. All the logic lives
              in src/components/admin/WebsiteStudio.tsx — kept out of this file
              on purpose (it is also the pattern future panels should follow
              when this monolith is broken up further). */}
          {effectiveActiveTab === 'cms' && (
            <div className="space-y-6">
              {/* INC11: the INC10 cms_pages publication list was removed — the
                  collection drives NO public route (verified: PublicPages, the
                  router and the prerender never read it), so a publish control
                  implied a pipeline that reaches nobody. cms_pages is recorded
                  as deferred legacy data; the Website Studio below is the real
                  public-content path. */}
              <WebsiteStudio
              content={siteContent}
              onPublishStudio={onPublishStudio}
              siteSettings={siteSettings}
              mediaItems={mediaItems}
              publishMediaItems={publishMediaItems}
              addToast={addToast}
              logAction={(module, action) => logAction(module, action)}
              onViewPage={(tab) => setCurrentTab(tab)}
              goToAdminTab={(tabId) => setActiveTab(tabId)}
              cloudConfigured={cloudStatus.configured}
              draftScopeKey={employee?.id || employee?.email || 'unresolved-session'}
              seoPanel={
                <SeoSyncPanel
                  live={buildLiveSeoSummary({ siteSettings, siteContent, menuItems, stores, vacancies, newsPosts })}
                  deploymentMode={seoDeploymentMode}
                  rebuildStatus={seoRebuildStatus}
                  canRebuild={employee?.role === 'owner' || employee?.role === 'store_manager'}
                  onRebuild={onManualSeoRebuild}
                />
              }
              />
            </div>
          )}


          {/* ==================== 4. MEDIA LIBRARY ==================== */}
          {effectiveActiveTab === 'media' && (
            <MediaLibraryPanel
              mediaItems={mediaItems}
              publishMediaItems={publishMediaItems}
              addToast={addToast}
              logAction={logAction}
            />
          )}

          {/* ==================== 5. INTEGRATED GENERAL FORM DRAWER (REDUCES CODE DUPLICATION) ==================== */}
          {isFormOpen && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-zinc-900/60 backdrop-blur-sm">
              <div
                ref={entityDialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="entity-editor-title"
                tabIndex={-1}
                className="bg-[#FFFFFF] w-full max-w-lg rounded-3xl border border-[#D2C5B4] p-6 space-y-4 shadow-2xl overflow-y-auto max-h-[90vh] focus:outline-none"
              >
                <div className="flex justify-between items-center pb-2 border-b">
                  <h3 id="entity-editor-title" className="font-display font-black text-xs uppercase tracking-widest text-[#A46832]">
                    {editItemId 
                      ? `Edit ${formType === 'menu' ? 'Menu Recipe' : formType === 'store' ? 'Store Location' : formType === 'vacancy' ? 'Vacancy' : 'Employee'}` 
                      : `Add New ${formType === 'menu' ? 'Menu Recipe' : formType === 'store' ? 'Store Location' : formType === 'vacancy' ? 'Vacancy' : 'Employee'}`}
                  </h3>
                  <button onClick={closeEntityForm} disabled={entityFormSaving} className="p-1 rounded text-red-500 hover:bg-red-50 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed" aria-label="Close editor">
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {/* Shared fields wrapper */}
                <div className="space-y-4 text-2xs md:grid md:grid-cols-2 md:gap-4 md:space-y-0 text-[#2E2A26]">
                  {formType === 'menu' && (
                    <>
                      <div className="space-y-1.5 md:col-span-2">
                        <label htmlFor="entity-menu-name" className="font-bold">Item Title *</label>
                        <input id="entity-menu-name" type="text" value={menuFormState.name || ''} onChange={(e) => setMenuFormState({ ...menuFormState, name: e.target.value })} className="w-full bg-white border p-2 rounded-lg" required />
                      </div>
                      <div className="space-y-1.5 md:col-span-2">
                        <label className="font-bold">Item Image</label>
                        <div className="w-24 h-24 rounded-lg overflow-hidden border bg-white flex items-center justify-center">
                          <ImageUploadInline
                            key={`menu-image-${menuFormSession}`}
                            currentImageUrl={menuFormState.image && menuFormState.image !== 'placeholder' ? menuFormState.image : ''}
                            onImageChange={(val) => setMenuFormState({ ...menuFormState, image: val })}
                            onUploaded={(objectId) => {
                              // WP04R: remember which pending object backs the
                              // URL now sitting in the form — the SAVE attaches
                              // it (two-phase step 2). Nothing was deleted.
                              // P0-8: bound to THIS form session, so it can
                              // never be attached to a different product.
                              menuPendingUploadRef.current = { objectId, session: menuFormSession };
                            }}
                            className="w-full h-full"
                            imgClassName="w-full h-full object-cover"
                          />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="entity-menu-price" className="font-bold">Price (£) *</label>
                        <input id="entity-menu-price" type="number" step="0.01" value={menuFormState.price ?? ''} onChange={(e) => { const raw = e.target.value; setMenuFormState((previous) => { const next = { ...previous }; if (raw === '') delete next.price; else next.price = Number(raw); return next; }); }} className="w-full bg-white border p-2 rounded-lg" required />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="entity-menu-price-large" className="font-bold">Large price (£) <span className="font-normal text-stone-400">(optional)</span></label>
                        <input id="entity-menu-price-large" type="number" min="0" step="0.01" value={menuFormState.priceLarge ?? ''} onChange={(e) => { const raw = e.target.value; setMenuFormState((previous) => ({ ...previous, priceLarge: raw === '' ? null : Number(raw) })); }} className="w-full bg-white border p-2 rounded-lg" />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="entity-menu-calories" className="font-bold">Calories (kcal)</label>
                        <input id="entity-menu-calories" type="number" min="0" value={menuFormState.calories ?? ''} onChange={(e) => { const raw = e.target.value; setMenuFormState((previous) => { const next = { ...previous }; if (raw === '') delete next.calories; else next.calories = Number(raw); return next; }); }} className="w-full bg-white border p-2 rounded-lg" />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="entity-menu-category" className="font-bold">Category Selector</label>
                        <select id="entity-menu-category" value={menuFormState.category || 'milkshakes'} onChange={(e) => setMenuFormState({ ...menuFormState, category: e.target.value as any })} className="w-full bg-white border p-2 rounded-lg">
                          {MENU_CATEGORIES.map(c => <option key={c} value={c}>{c.replace('_', ' ').toUpperCase()}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1.5 md:col-span-2">
                        <label htmlFor="entity-menu-description" className="font-bold">Menu description</label>
                        <textarea id="entity-menu-description" rows={2} value={menuFormState.description || ''} onChange={(e) => setMenuFormState({ ...menuFormState, description: e.target.value })} className="w-full bg-white border p-2 rounded-lg" />
                      </div>
                      <div className="space-y-1.5 md:col-span-2">
                        <label htmlFor="entity-menu-tags" className="font-bold">Display tags <span className="font-normal text-stone-400">(comma separated, optional)</span></label>
                        <input id="entity-menu-tags" value={(menuFormState.tags || []).join(', ')} onChange={(e) => setMenuFormState((previous) => ({ ...previous, tags: Array.from(new Set<string>(e.target.value.split(',').map((tag) => tag.trim()).filter((tag): tag is string => Boolean(tag)))) }))} className="w-full bg-white border p-2 rounded-lg" placeholder="e.g. Creamy, Fruity, Signature" />
                      </div>
                    </>
                  )}

                  {formType === 'store' && (
                    <>
                      <div className="space-y-1.5 md:col-span-2">
                        <label htmlFor="entity-store-name" className="font-bold">Store Title *</label>
                        <input id="entity-store-name" type="text" value={storeFormState.name || ''} onChange={(e) => setStoreFormState({ ...storeFormState, name: e.target.value })} className="w-full bg-white border p-2 rounded-lg" required />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="entity-store-address" className="font-bold">Premises Address *</label>
                        <input id="entity-store-address" type="text" value={storeFormState.address || ''} onChange={(e) => setStoreFormState({ ...storeFormState, address: e.target.value })} className="w-full bg-white border p-2 rounded-lg" required />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="entity-store-postcode" className="font-bold">Postal Code *</label>
                        <input id="entity-store-postcode" type="text" value={storeFormState.postcode || ''} onChange={(e) => setStoreFormState({ ...storeFormState, postcode: e.target.value })} className="w-full bg-white border p-2 rounded-lg" required />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="entity-store-phone" className="font-bold">Phone Number</label>
                        <input id="entity-store-phone" type="tel" value={storeFormState.phone || ''} onChange={(e) => setStoreFormState({ ...storeFormState, phone: e.target.value })} className="w-full bg-white border p-2 rounded-lg" />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="entity-store-email" className="font-bold">Store email address</label>
                        <input id="entity-store-email" type="email" value={storeFormState.email || ''} onChange={(e) => setStoreFormState({ ...storeFormState, email: e.target.value })} className="w-full bg-white border p-2 rounded-lg" />
                      </div>
                      <div className="space-y-1.5 md:col-span-2">
                        <label htmlFor="entity-store-hours" className="font-bold">Opening Hours <span className="font-normal text-gray-400">(required before marking the store open)</span></label>
                        <input id="entity-store-hours" type="text" value={storeFormState.openingHours || ''} onChange={(e) => setStoreFormState({ ...storeFormState, openingHours: e.target.value })} className="w-full bg-white border p-2 rounded-lg" placeholder="e.g. Mon–Sat 09:00–21:00 · Sun 11:00–17:00" />
                      </div>
                    </>
                  )}

                  {formType === 'staff' && (
                    <div className="md:col-span-2 space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <label htmlFor="entity-staff-name" className="font-bold">Employee Full Name *</label>
                          <input id="entity-staff-name" type="text" value={staffFormState.name || ''} onChange={(e) => setStaffFormState({ ...staffFormState, name: e.target.value })} className="w-full bg-white border p-2 rounded-lg" required />
                        </div>
                        <div className="space-y-1.5">
                          <label htmlFor="entity-staff-email" className="font-bold">Secure Corporate Email *</label>
                          <input id="entity-staff-email" type="email" value={staffFormState.email || ''} onChange={(e) => setStaffFormState({ ...staffFormState, email: e.target.value })} className="w-full bg-white border p-2 rounded-lg" required />
                        </div>
                      </div>
                      
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <label htmlFor="entity-staff-store" className="font-bold">Store *</label>
                          {/* SMALL-BIZ CLOSURE P0-9: a REQUIRED selection from
                              the real Stores register. When exactly one active
                              store exists it is pre-selected on form open;
                              otherwise the owner must choose. Never 's1'. */}
                          <select id="entity-staff-store" value={staffFormState.storeId || ''} onChange={(e) => {
                            const st = storesById.get(e.target.value);
                            setStaffFormState({ ...staffFormState, storeId: st?.id || '', storeName: st?.name || '' });
                          }} className="w-full bg-white border p-2 rounded-lg" required>
                            <option value="">Choose a store…</option>
                            {stores.map(st => <option key={st.id} value={st.id}>{st.name}{st.setupStatus && st.setupStatus !== 'ACTIVE' ? ' (not yet active)' : ''}</option>)}
                          </select>
                        </div>
                        <div className="space-y-1.5">
                          <label htmlFor="entity-staff-holiday" className="font-bold">Contract holiday allowance (pro-rated days / year) *</label>
                          {/* The correct entitlement depends on the employee's
                              working pattern. Require the owner to enter the
                              contract's actual pro-rated annual allowance; do
                              not silently assume a full-time 28-day pattern. */}
                          <input id="entity-staff-holiday" type="number" step="0.5" min="0" max="366" required value={staffFormState.holidayBalance ?? ''} onChange={(e) => { const raw = e.target.value; setStaffFormState(prev => { const next = { ...prev }; if (raw === '') { delete next.holidayBalance; return next; } const v = Number(raw); if (Number.isFinite(v)) next.holidayBalance = v; return next; }); }} className="w-full bg-white border p-2 rounded-lg" />
                          <p className="text-[9px] text-neutral-500">Enter the entitlement stated in the employee's contract; pro-rate it for part-time patterns.</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                          <label htmlFor="entity-staff-role" className="font-bold">Role Hierarchy tier</label>
                          <select id="entity-staff-role" value={staffFormState.role || 'team_member'} onChange={(e) => setStaffFormState({ ...staffFormState, role: e.target.value as EmployeeRole })} className="w-full bg-white border p-2 rounded-lg">
                            <option value="team_member">TEAM MEMBER</option>
                            <option value="supervisor">SHIFT SUPERVISOR</option>
                            {employee?.role === 'owner' && (
                              <>
                                <option value="store_manager">STORE MANAGER</option>
                                <option value="owner">OWNER / ADMIN</option>
                              </>
                            )}
                          </select>
                        </div>
                        {employee?.role === 'owner' && (
                        <div className="space-y-1.5 border-t sm:border-t-0 sm:border-l border-[#EBDECE]/50 sm:pl-4 pt-4 sm:pt-0">
                          <label className="font-bold">Pay Type</label>
                          <div className="flex gap-4 mt-1">
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input type="radio" value="hourly" checked={staffFormState.payType === 'hourly' || !staffFormState.payType} onChange={() => setStaffFormState({...staffFormState, payType: 'hourly'})} />
                              Hourly Rate (£)
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                              {/* SMALL-BIZ CLOSURE P0-10: salary input is
                                  standardised as ANNUAL and labelled so — the
                                  system no longer guesses a period from the
                                  size of the number. */}
                              <input type="radio" value="salary" checked={staffFormState.payType === 'salary'} onChange={() => setStaffFormState({...staffFormState, payType: 'salary'})} />
                              Annual Salary (£ / year)
                            </label>
                          </div>
                        </div>
                        )}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {employee?.role === 'owner' && (
                        <div className="space-y-1.5 pt-4 sm:pt-0 border-t sm:border-t-0 border-[#EBDECE]/50">
                          <label htmlFor="entity-staff-pay-rate" className="font-bold">{staffFormState.payType === 'salary' ? 'Annual Salary (£ / year)' : 'Hourly Rate (£ / hour)'}</label>
                          <input id="entity-staff-pay-rate" type="number" step="0.01" value={staffFormState.payRate || ''} onChange={(e) => { const v = parseFloat(e.target.value); setStaffFormState({ ...staffFormState, payRate: Number.isFinite(v) ? v : undefined }); }} className="w-full bg-white border p-2 rounded-lg" />
                          <p className="text-[9px] text-neutral-400">Leave blank if not agreed yet — the system will show hours without a cash estimate rather than invent a rate.</p>
                        </div>
                        )}
                        <div className="space-y-1.5 pt-4 sm:pt-0 border-t sm:border-t-0 border-[#EBDECE]/50">
                          <label className="font-bold text-[#2E2A26]/60">Sign-in credentials</label>
                          {/* SECURITY: no PIN field. Credentials are never set,
                              stored or synced from the browser — accounts get
                              their login via the auth backend (Supabase Auth)
                              once it is configured. See README.md (Security). */}
                          <p className="text-[10px] text-neutral-500 leading-relaxed bg-stone-50 border border-[#EBDECE] rounded-lg p-2">
                            Managed by the authentication backend — not editable here.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {formType === 'vacancy' && (
                    <>
                      <div className="space-y-1.5 md:col-span-2">
                        <label htmlFor="entity-vacancy-title" className="font-bold">Role Name *</label>
                        <input id="entity-vacancy-title" type="text" value={vacancyFormState.title || ''} onChange={(e) => setVacancyFormState({ ...vacancyFormState, title: e.target.value })} className="w-full bg-white border p-2 rounded-lg" required />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="entity-vacancy-department" className="font-bold">Operational department</label>
                        <input id="entity-vacancy-department" type="text" value={vacancyFormState.department || ''} onChange={(e) => setVacancyFormState({ ...vacancyFormState, department: e.target.value })} className="w-full bg-white border p-2 rounded-lg" />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="entity-vacancy-location" className="font-bold">Store Locale</label>
                        <input id="entity-vacancy-location" type="text" value={vacancyFormState.location || ''} onChange={(e) => setVacancyFormState({ ...vacancyFormState, location: e.target.value })} className="w-full bg-white border p-2 rounded-lg" />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="entity-vacancy-salary" className="font-bold">Salary (shown on the site)</label>
                        <input id="entity-vacancy-salary" type="text" value={vacancyFormState.salary || ''} onChange={(e) => setVacancyFormState({ ...vacancyFormState, salary: e.target.value })} className="w-full bg-white border p-2 rounded-lg" placeholder="e.g. £12.50 / hr" />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="entity-vacancy-type" className="font-bold">Contract type</label>
                        <select id="entity-vacancy-type" value={vacancyFormState.type || 'Part-time'} onChange={(e) => setVacancyFormState({ ...vacancyFormState, type: e.target.value as CareerVacancy['type'] })} className="w-full bg-white border p-2 rounded-lg">
                          <option value="Part-time">Part-time</option>
                          <option value="Full-time">Full-time</option>
                        </select>
                      </div>
                      <div className="space-y-1.5 md:col-span-2">
                        <label htmlFor="entity-vacancy-description" className="font-bold">Role description (shown to applicants) *</label>
                        <textarea id="entity-vacancy-description" rows={4} value={vacancyFormState.roleDescription || ''} onChange={(e) => setVacancyFormState({ ...vacancyFormState, roleDescription: e.target.value })} className="w-full bg-white border p-2 rounded-lg" placeholder="Describe the role, the vibe, and what a typical shift looks like…" />
                      </div>
                      <div className="space-y-1.5 md:col-span-2">
                        <label htmlFor="entity-vacancy-requirements" className="font-bold">Requirements <span className="font-normal text-stone-400">(one per line)</span></label>
                        <textarea id="entity-vacancy-requirements" rows={3} value={(vacancyFormState.requirements || []).join('\n')} onChange={(e) => setVacancyFormState({ ...vacancyFormState, requirements: e.target.value.split('\n').filter(l => l.trim() !== '') })} className="w-full bg-white border p-2 rounded-lg font-mono text-[11px]" placeholder={'Right to work in the UK\nWeekend availability'} />
                      </div>
                      <div className="space-y-1.5 md:col-span-2">
                        <label htmlFor="entity-vacancy-responsibilities" className="font-bold">Responsibilities <span className="font-normal text-stone-400">(one per line)</span></label>
                        <textarea id="entity-vacancy-responsibilities" rows={3} value={(vacancyFormState.responsibilities || []).join('\n')} onChange={(e) => setVacancyFormState({ ...vacancyFormState, responsibilities: e.target.value.split('\n').filter(l => l.trim() !== '') })} className="w-full bg-white border p-2 rounded-lg font-mono text-[11px]" placeholder={'Craft signature milkshakes\nKeep counters spotless'} />
                      </div>
                    </>
                  )}

                </div>

                <div className="pt-4 border-t flex justify-end gap-2">
                  <button type="button" onClick={closeEntityForm} disabled={entityFormSaving} className="px-4 py-2 border rounded-full text-zinc-500 hover:bg-stone-100 cursor-pointer text-2xs font-bold uppercase disabled:opacity-50 disabled:cursor-not-allowed">Cancel</button>
                  <button
                    onClick={() => { void withBusy('form-save', async () => {
                      if (formType === 'menu') {
                        const menuName = String(menuFormState.name || '').trim();
                        const menuPrice = Number(menuFormState.price);
                        const menuCalories = Number(menuFormState.calories ?? 0);
                        const menuLargePrice = menuFormState.priceLarge == null ? null : Number(menuFormState.priceLarge);
                        if (!menuName) {
                          addToast('Enter the real product name before saving.', 'error');
                          return;
                        }
                        if (!Number.isFinite(menuPrice) || menuPrice < 0) {
                          addToast(`Enter a valid product price of ${cur}0 or more.`, 'error');
                          return;
                        }
                        if (menuLargePrice !== null && (!Number.isFinite(menuLargePrice) || menuLargePrice < 0)) {
                          addToast(`Large price must be blank or a valid amount of ${cur}0 or more.`, 'error');
                          return;
                        }
                        if (!Number.isFinite(menuCalories) || menuCalories < 0) {
                          addToast('Calories must be zero or a positive number.', 'error');
                          return;
                        }
                        const normalisedMenuDraft: Partial<MenuItem> = {
                          ...menuFormState,
                          name: menuName,
                          description: String(menuFormState.description || '').trim(),
                          price: menuPrice,
                          priceLarge: menuLargePrice,
                          calories: menuCalories,
                        };
                        if (editItemId) {
                          if (!(await publishMenuItems(prev => prev.map(item => item.id === editItemId ? { ...item, ...normalisedMenuDraft } as MenuItem : item)))) return;
                          {
                            // Two-phase step 2: content committed → record the
                            // reference. The RPC also re-writes the image
                            // column transactionally and grace-schedules the
                            // DISPLACED object (never deleted here).
                            /* SMALL-BIZ CLOSURE P0-8: AWAITED. A failed attach
                               is no longer hidden behind the content success —
                               the form stays open with a retryable warning and
                               the pending object is retained for that retry. */
                            const pending = menuPendingUploadRef.current;
                            if (pending && pending.session === menuFormSessionRef.current) {
                              const r = await attachMediaReference(pending.objectId, 'menu_item', editItemId, 'image');
                              if (r.status === 'attached') {
                                menuPendingUploadRef.current = null;
                              } else {
                                addToast(`Recipe "${menuName}" was saved, but its image reference could not be finalised. Press "Confirm & Save" again to retry the image finalisation.`, 'warning');
                                return; // keep the form (and the pending object) for the retry
                              }
                            }
                          }
                          logAction('Menu Manager', `Updated recipe options for "${menuName}"`);
                          addToast(`Recipe "${menuName}" has been modified.`, 'success');
                        } else {
                          const nextId = createClientId('m');
                          const newItemValue: MenuItem = {
                            // R4.9 G4: mirrors the database default. `available`
                            // is omitted from publishes, so the server's decision
                            // — and the R4.8 publish gate — always wins.
                            /* R4.10 Increment 8: was `available: true`. The database default
                               became false in Increment 7, but this line overrode it, so a new
                               product still went public the moment it was created — the default
                               was proven at the schema boundary and defeated at the path an owner
                               actually uses. Created as draft; publish deliberately. */
                            available: false,
                            id: nextId,
                            name: menuName,
                            description: String(normalisedMenuDraft.description || ''),
                            price: menuPrice,
                            priceLarge: menuLargePrice,
                            category: menuFormState.category || 'milkshakes',
                            calories: menuCalories,
                            tags: Array.isArray(menuFormState.tags) ? menuFormState.tags : [],
                            allergens: Array.isArray(menuFormState.allergens) ? menuFormState.allergens : [],
                            image: String(menuFormState.image || '')
                          };
                          if (!(await publishMenuItems(prev => [newItemValue, ...prev]))) return;
                          {
                            /* SMALL-BIZ CLOSURE P0-8: AWAITED, as in the edit
                               path. On failure the form switches to EDIT mode
                               of the just-created draft — pressing Save again
                               retries the attachment WITHOUT creating a second
                               product — and the warning says exactly that. */
                            const pending = menuPendingUploadRef.current;
                            if (pending && pending.session === menuFormSessionRef.current) {
                              const r = await attachMediaReference(pending.objectId, 'menu_item', nextId, 'image');
                              if (r.status === 'attached') {
                                menuPendingUploadRef.current = null;
                              } else {
                                setEditItemId(nextId);
                                addToast(`"${newItemValue.name}" was created as a draft, but its image reference could not be finalised. Press "Confirm & Save" again to retry the image finalisation.`, 'warning');
                                return; // keep the form (now editing the draft) and the pending object
                              }
                            }
                          }
                          logAction('Menu Manager', `Created menu item "${newItemValue.name}" (draft)`);
                          /* R4.10: creation is NOT publication. The row lands as a draft
                             (server default, and `available` is stripped from collection
                             writes anyway) — saying "published" here was blocker 1's
                             textbook case of a toast describing what did not happen. */
                          addToast(`Menu item "${newItemValue.name}" saved as a draft — press Publish on its card to put it on the guest menu.`, 'success');
                        }
                      } else if (formType === 'store') {
                        if (editItemId) {
                          const existing = storesById.get(editItemId);
                          const merged = { ...existing, ...storeFormState } as StoreLocation;
                          // Every store (any status) must keep a real identity — an edit
                          // cannot strip the name, address or postcode of a public card.
                          if (!hasRealStoreIdentity(merged)) {
                            addToast('A store must keep a real name, address and postcode.', 'error');
                            return;
                          }
                          // An open store that is no longer complete returns to "Coming Soon".
                          const downgraded = merged.status === 'open' && !isCompletePublicStore(merged);
                          if (downgraded) merged.status = 'coming_soon';
                          if (!(await publishStores(prev => prev.map(st => st.id === editItemId ? merged : st)))) return;
                          logAction('Store Locations', `Updated store "${merged.name}"`);
                          addToast(downgraded
                            ? `Store "${merged.name}" saved, but set back to “Coming Soon” — an online store needs a real address, postcode and opening hours.`
                            : `Store details for "${merged.name}" updated successfully.`, downgraded ? 'warning' : 'success');
                        } else {
                          if (!hasRealStoreIdentity(storeFormState)) {
                            addToast('A store needs a real name, address and postcode before it can be listed.', 'error');
                            return;
                          }
                          const nextId = createClientId('s');
                          const newStoreObj: StoreLocation = {
                            id: nextId,
                            name: (storeFormState.name || '').trim(),
                            address: (storeFormState.address || '').trim(),
                            postcode: (storeFormState.postcode || '').trim(),
                            phone: (storeFormState.phone || '').trim(),
                            email: (storeFormState.email || '').trim(),
                            status: 'coming_soon',
                            openingHours: (storeFormState.openingHours || '').trim(),
                            image: '',
                            // coordinates intentionally omitted — no fake geo; add real ones only when known
                            deliveryLinks: {}
                          };
                          if (!(await publishStores(prev => [newStoreObj, ...prev]))) return;
                          logAction('Store Locations', `Added store "${newStoreObj.name}" as Coming Soon`);
                          addToast(`Store "${newStoreObj.name}" is now listed publicly as “Coming Soon”. Add opening hours before marking it open.`, 'success');
                        }
                      } else if (formType === 'staff') {
                        if (!staffFormState.name?.trim() || !staffFormState.email?.trim()) {
                          addToast('A full name and e-mail are required to onboard an associate.', 'error');
                          return;
                        }
                        const emailNorm = staffFormState.email.trim().toLowerCase();
                        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailNorm)) {
                          addToast('That e-mail address doesn\'t look valid.', 'error');
                          return;
                        }
                        if (employeesList.some(e => e.email.toLowerCase() === emailNorm)) {
                          addToast('An employee with this e-mail already exists — e-mails must be unique because they\'re used to log in.', 'error');
                          return;
                        }
                        /* SMALL-BIZ CLOSURE P0-9: the store is the REAL row the
                           owner selected — creation refuses without one. */
                        const chosenStore = staffFormState.storeId ? storesById.get(staffFormState.storeId) : undefined;
                        if (!chosenStore) {
                          addToast('Choose the store this associate belongs to.', 'error');
                          return;
                        }
                        const holidayAllowance = staffFormState.holidayBalance;
                        if (!Number.isFinite(holidayAllowance) || holidayAllowance! < 0 || holidayAllowance! > 366) {
                          addToast('Enter the employee’s actual pro-rated annual holiday allowance.', 'error');
                          return;
                        }
                        if (staffFormState.payRate !== undefined && (!Number.isFinite(staffFormState.payRate) || staffFormState.payRate <= 0)) {
                          addToast('Contract pay must be a positive hourly rate or annual salary, or left blank until confirmed.', 'error');
                          return;
                        }
                        const nextId = createClientId('emp');
                        const newStaff: EmployeeProfile = {
                          id: nextId,
                          name: staffFormState.name.trim(),
                          email: emailNorm,
                          role: staffFormState.role || 'team_member',
                          storeId: chosenStore.id,
                          storeName: chosenStore.name,
                          nextShift: 'No Shifts Scheduled',
                          /* SMALL-BIZ CLOSURE P0-10: nothing is invented at
                             onboarding. Holiday is the explicit form value
                             (entered from the employee's contract); points
                             start at zero; badges start empty — "Inducted" is
                             earned by completing an induction, not by having a
                             row created. */
                          holidayBalance: holidayAllowance!,
                          points: 0,
                          level: 1,
                          badges: [],
                          avatar: '',
                          payType: staffFormState.payType || 'hourly',
                          payRate: staffFormState.payRate
                        };
                        if (!(await onAddEmployee(newStaff))) return;
                        logAction('Staff HR Directory', `Created staff profile "${newStaff.name}" as ${newStaff.role}`);
                        addToast(`Staff profile "${newStaff.name}" saved to the database. Invite them to activate their sign-in from their profile card.`, 'success');
                      } else if (formType === 'vacancy') {
                        const vTitle = vacancyFormState.title?.trim() || '';
                        const vLocation = vacancyFormState.location?.trim() || '';
                        const vSalary = vacancyFormState.salary?.trim() || '';
                        const vRole = vacancyFormState.roleDescription?.trim() || '';
                        const vType = vacancyFormState.type;
                        if (!isReal(vTitle)) {
                          addToast('Please give the vacancy a real role name.', 'error');
                          return;
                        }
                        /* R4.10: a saved vacancy is a DRAFT — it reaches the careers page
                           only through the explicit Publish action, and the server refuses
                           to publish an incomplete record anyway. The completeness bar is
                           kept at save time so the owner is not invited to stockpile
                           half-written drafts that can never publish. */
                        if (!isPublishableVacancy({ title: vTitle, location: vLocation, salary: vSalary, roleDescription: vRole, type: vType })) {
                          addToast('Add a real location, salary, employment type and role description (no “N/A”) — a vacancy must be complete before it can ever be published.', 'error');
                          return;
                        }
                        if (editItemId) {
                          if (!(await publishVacancies(prev => prev.map(v => v.id === editItemId ? { ...v, ...vacancyFormState, title: vTitle, location: vLocation, salary: vSalary, roleDescription: vRole } as CareerVacancy : v)))) return;
                          logAction('Careers Recruiter', `Updated vacancy "${vTitle}"`);
                          addToast(`Vacancy "${vTitle}" updated.`, 'success');
                        } else {
                          const nextId = createClientId('v');
                          const newVac: CareerVacancy = {
                            id: nextId,
                            title: vTitle,
                            department: String(vacancyFormState.department || '').trim(),
                            location: vLocation,
                            salary: vSalary,
                            type: vType || 'Part-time',
                            roleDescription: vRole,
                            requirements: vacancyFormState.requirements || [],
                            responsibilities: vacancyFormState.responsibilities || []
                          };
                          if (!(await publishVacancies(prev => [newVac, ...prev]))) return;
                          logAction('Careers Recruiter', `Created vacancy "${vTitle}" (draft)`);
                          addToast(`Vacancy "${vTitle}" saved as a draft — press Publish on its card to put it on the careers page.`, 'success');
                        }
                      }
                      setIsFormOpen(false);
                      setEditItemId(null);
                      resetMenuUploadSession(); // P0-8: the form closed — nothing pending may outlive it
                    }); }}
                    disabled={busyAction === 'form-save'}
                    className="px-5 py-2 bg-[#A46832] text-white rounded-full text-2xs hover:bg-[#A5642B] cursor-pointer font-black uppercase shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {busyAction === 'form-save' ? 'Saving…' : 'Confirm & Save'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ==================== 6. STORES OPERATIONS MANAGER ==================== */}
          {effectiveActiveTab === 'stores' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <div>
                  <h1 className="font-display font-black text-2xl animate-fade-in">Store Locations</h1>
                  <p className="text-2xs text-[#2E2A26]/70">Add customer-facing locations, opening hours and contact details.</p>
                </div>
                <button
                  id="add-new-store-cta"
                  onClick={() => {
                    setFormType('store');
                    setStoreFormState({ name: '', address: '', postcode: '', phone: '', email: '', status: 'coming_soon', openingHours: '' });
                    setIsFormOpen(true);
                  }}
                  className="px-4 py-2 bg-[#A46832] hover:bg-[#A5642B] text-white rounded-full text-2xs font-black uppercase tracking-wider shadow-xs cursor-pointer"
                >
                  Add Store
                </button>
              </div>

              <div id="stores-matrix-grid" className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {stores.map((s) => (
                  <div key={s.id} className="bg-white rounded-2xl border border-[#EBDECE]/50 overflow-hidden shadow-2xs flex flex-col justify-between">
                    <div className="p-5 space-y-3">
                      <div className="flex justify-between items-center text-xs">
                        <span className="font-display font-black uppercase tracking-wider">{s.name}</span>
                        <span className="flex items-center gap-1">
                          {POS_SETUP_VISIBLE && (() => { const cfg = { ...s, ...setupOverlay[s.id] };
                            return cfg.setupStatus === 'ACTIVE'
                              ? <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded-full bg-[#7CC0C7]/25 text-[#3E7C83]">TRADING SETUP ✓</span>
                              : <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded-full bg-[#A5642B]/15 text-[#A5642B]">TRADING SETUP DEFERRED</span>; })()}
                          <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full ${s.status === 'open' ? 'bg-[#5CA459]/20 text-[#5CA459]' : 'bg-[#A46832]/20 text-[#A46832]'}`}>
                            {s.status.toUpperCase()}
                          </span>
                        </span>
                      </div>
                      <p className="text-2xs text-stone-500 font-medium leading-normal">{s.address} ({s.postcode})</p>
                      <div className="h-40 bg-[#F2EFE9] rounded-xl overflow-hidden flex items-end justify-center">
                        <img src={MASCOT.sitShake} width={356} height={692} loading="lazy" decoding="async" className="h-[88%] w-auto object-contain" alt="" aria-hidden="true" />
                      </div>
                      <div className="text-[10px] space-y-1 pt-1 opacity-80 grid gap-1 grid-cols-1 font-mono">
                        {s.phone ? <span className="flex items-center gap-1">📞 {s.phone}</span> : null}
                        {s.email ? <span className="flex items-center gap-1">✉️ {s.email}</span> : null}
                        {s.openingHours ? <span className="flex items-center gap-1">🕒 Hours: {s.openingHours}</span> : <span className="text-[#A46832]">Opening hours not added yet</span>}
                      </div>
                    </div>

                    <div className="px-4 py-3 bg-[#FFFFFF]/40 border-t flex justify-between items-center gap-2">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => {
                            setFormType('store');
                            setStoreFormState({ ...s });
                            setEditItemId(s.id);
                            setIsFormOpen(true);
                          }}
                          className="text-[#A46832] hover:bg-amber-100/40 p-1.5 rounded cursor-pointer"
                          title="Edit Store"
                        >
                          <Edit className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => { void deleteStoreWithFeedback(s); }}
                          disabled={busyAction !== null}
                          className="text-red-500 hover:bg-red-50 p-1.5 rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Delete Store"
                        >
                          <Trash className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="flex gap-1.5">
                        {POS_SETUP_VISIBLE && currentRole === 'owner' && (() => { const cfg = { ...s, ...setupOverlay[s.id] };
                          return (
                          <button onClick={() => {
                            // WS6f (audit F2): the wizard REOPENS for ACTIVE stores,
                            // prefilled with the store's current configuration, so the
                            // owner can register for VAT / change methods later.
                            setWizardForm({
                              timezone: cfg.timezone ?? 'Europe/London',
                              currencyCode: cfg.currencyCode ?? 'GBP',
                              paymentMethods: (cfg.paymentMethods && cfg.paymentMethods.length > 0) ? [...cfg.paymentMethods] : ['cash', 'card', 'online'],
                              receiptFooter: cfg.receiptFooter ?? '',
                              vatStatus: cfg.vatStatus ?? 'NOT_REGISTERED',
                              vatNumber: cfg.vatNumber ?? '',
                              vatEffectiveDate: cfg.vatRegistrationEffectiveDate ?? '',
                            });
                            setClassifyDraft(Object.fromEntries(menuItems.map(mi => [mi.id, (taxOverlay[mi.id] ?? mi.taxCode ?? '') as TaxCode | ''])));
                            setSetupWizardStore(s);
                          }} className="p-1 px-2 border border-[#7CC0C7] text-[#3E7C83] rounded text-[9px] font-bold uppercase hover:bg-[#7CC0C7]/10 cursor-pointer">
                            {cfg.setupStatus === 'ACTIVE' ? 'Configure' : 'Setup'}
                          </button>); })()}
                        <button onClick={() => { void setStorePublicStatus(s, 'coming_soon'); }} disabled={busyAction !== null} className="p-1 px-2 border border-[#A46832]/40 text-[#A46832] rounded text-[9px] font-bold uppercase hover:bg-[#A46832]/5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Coming Soon</button>
                        <button onClick={() => { void setStorePublicStatus(s, 'closed'); }} disabled={busyAction !== null} className="p-1 px-2 border border-red-200 text-red-500 rounded text-[9px] font-bold uppercase hover:bg-red-50 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Closed</button>
                        <button onClick={() => { void setStorePublicStatus(s, 'open'); }} disabled={busyAction !== null} className="p-1 px-2 border border-[#5CA459] text-[#5CA459] rounded text-[9px] font-bold uppercase hover:bg-emerald-50 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Open</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* WS6e — owner Store Setup Wizard (configure_store_setup RPC). */}
              {POS_SETUP_VISIBLE && setupWizardStore && (
                <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !wizardBusy && setSetupWizardStore(null)}>
                  <div
                    ref={setupDialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="store-setup-title"
                    aria-describedby="store-setup-description"
                    tabIndex={-1}
                    className="bg-white rounded-2xl mp-shadow w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-5 focus:outline-none"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <h2 id="store-setup-title" className="font-display font-black text-lg text-[#2E2A26]">Store Setup — {setupWizardStore.name}</h2>
                        <p id="store-setup-description" className="text-2xs text-[#2E2A26]/60">A store cannot trade until this configuration is confirmed. Owner + MFA required; everything is validated and applied atomically on the server.</p>
                      </div>
                      <button type="button" onClick={() => !wizardBusy && setSetupWizardStore(null)} disabled={wizardBusy} aria-label="Close store setup" className="min-h-11 min-w-11 rounded-full grid place-items-center hover:bg-stone-100 cursor-pointer disabled:opacity-50"><X className="h-4 w-4" /></button>
                    </div>

                    <div className="grid grid-cols-2 gap-4 text-xs">
                      <div className="space-y-1"><label htmlFor="store-setup-timezone" className="font-bold block">Timezone (business day)</label>
                        <select id="store-setup-timezone" value={wizardForm.timezone} onChange={(e) => setWizardForm(f => ({ ...f, timezone: e.target.value }))}
                          className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none">
                          {['Europe/London'].map(z => <option key={z} value={z}>{z}</option>)}
                        </select></div>
                      <div className="space-y-1"><label htmlFor="store-setup-currency" className="font-bold block">Currency (ISO)</label>
                        <input id="store-setup-currency" value={wizardForm.currencyCode} disabled title="GBP only at launch — widening currency support is a deliberate future change"
                          className="w-full bg-stone-100 border border-[#EBDECE] p-2.5 rounded-xl outline-none font-mono opacity-70" /></div>
                    </div>

                    <div className="space-y-1.5 text-xs">
                      <label className="font-bold block">Accepted payment methods</label>
                      <div className="flex flex-wrap gap-2">
                        {(['cash', 'card', 'online'] as PaymentMethod[]).map((m) => (
                          <button type="button" key={m} onClick={() => setWizardForm(f => ({ ...f,
                              paymentMethods: f.paymentMethods.includes(m) ? f.paymentMethods.filter(x => x !== m) : [...f.paymentMethods, m] }))}
                            className={`px-3 py-1.5 rounded-full text-2xs font-bold uppercase cursor-pointer ${wizardForm.paymentMethods.includes(m) ? 'bg-[#7CC0C7] text-[#2E2A26]' : 'bg-[#F7EFE6] text-[#2E2A26]/60'}`}>
                            {m.replace('_', ' ')}
                          </button>
                        ))}
                      </div>
                      <p className="text-[10px] text-[#2E2A26]/50">The till only offers, and the server only accepts, methods in this set. Gift cards are unavailable at launch until balance validation and redemption exist.</p>
                    </div>

                    <div className="space-y-1 text-xs">
                      <label htmlFor="store-setup-receipt-footer" className="font-bold block">Receipt footer (optional)</label>
                      <textarea id="store-setup-receipt-footer" value={wizardForm.receiptFooter} onChange={(e) => setWizardForm(f => ({ ...f, receiptFooter: e.target.value }))}
                        rows={2} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none" />
                    </div>

                    <div className="space-y-2 text-xs border-t border-[#EBDECE] pt-4">
                      <label className="font-bold block">VAT registration</label>
                      <div className="flex gap-2">
                        {(['NOT_REGISTERED', 'REGISTERED'] as VatStatus[]).map((v) => (
                          <button type="button" key={v} onClick={() => setWizardForm(f => ({ ...f, vatStatus: v }))}
                            className={`px-3 py-1.5 rounded-full text-2xs font-bold cursor-pointer ${wizardForm.vatStatus === v ? 'bg-[#2E2A26] text-white' : 'bg-[#F7EFE6] text-[#2E2A26]/60'}`}>
                            {v === 'NOT_REGISTERED' ? 'Not VAT registered' : 'VAT registered'}
                          </button>
                        ))}
                      </div>
                      {wizardForm.vatStatus === 'REGISTERED' ? (
                        <>
                        <div className="grid grid-cols-2 gap-4 pt-1">
                          <div className="space-y-1"><label htmlFor="store-setup-vat-number" className="font-bold block">VAT number (GB…)</label>
                            <input id="store-setup-vat-number" value={wizardForm.vatNumber} onChange={(e) => setWizardForm(f => ({ ...f, vatNumber: e.target.value.toUpperCase() }))}
                              placeholder="GB123456789" className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none font-mono" /></div>
                          <div className="space-y-1"><label htmlFor="store-setup-vat-date" className="font-bold block">Registration effective date</label>
                            <input id="store-setup-vat-date" type="date" value={wizardForm.vatEffectiveDate} onChange={(e) => setWizardForm(f => ({ ...f, vatEffectiveDate: e.target.value }))}
                              className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none font-mono" />
                            <p className="text-[10px] text-[#2E2A26]/50">VAT is charged only from this date; earlier sales stay at 0 with a REGISTERED snapshot.</p></div>
                        </div>
                        {/* WS6f (audit F3): every product must carry a controlled
                            classification before a store can become REGISTERED —
                            the server refuses otherwise (products_unclassified). */}
                        <div className="space-y-1.5 pt-2">
                          <div className="flex items-center justify-between">
                            <label className="font-bold block">Product VAT classification</label>
                            <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${menuItems.some(mi => !(classifyDraft[mi.id] ?? '')) ? 'bg-[#A5642B]/15 text-[#A5642B]' : 'bg-[#5CA459]/15 text-[#5CA459]'}`}>
                              {menuItems.filter(mi => !(classifyDraft[mi.id] ?? '')).length} unclassified
                            </span>
                          </div>
                          {classificationGrid()}
                          <p className="text-[10px] text-[#2E2A26]/50">Classifications are applied (owner-only, server-verified) as part of activation.</p>
                        </div>
                        </>
                      ) : (
                        <p className="text-[10px] text-[#2E2A26]/50">No VAT is charged; every sale records rate 0 with a NOT_REGISTERED snapshot. Registering later affects future sales only.</p>
                      )}
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                      <button disabled={wizardBusy} onClick={() => setSetupWizardStore(null)}
                        className="px-4 py-2 rounded-full text-2xs font-black uppercase tracking-wider bg-[#F7EFE6] text-[#2E2A26]/70 cursor-pointer disabled:opacity-50">Cancel</button>
                      <button disabled={wizardBusy} onClick={async () => {
                        if (wizardBusyRef.current) return;
                        const st = setupWizardStore;
                        if (!st) return;
                        if (wizardForm.vatStatus === 'REGISTERED') {
                          const missing = menuItems.filter(mi => !(classifyDraft[mi.id] ?? ''));
                          if (missing.length) { addToast(`${missing.length} product(s) still need a VAT classification before this store can be REGISTERED.`, 'error'); return; }
                        }
                        wizardBusyRef.current = true;
                        setWizardBusy(true);
                        try {
                          const token = (await freshStaffToken()) || '';
                          if (wizardForm.vatStatus === 'REGISTERED') {
                            // WS6f (audit F3/F4): apply CHANGED classifications through the
                            // owner-only RPC before activation; the server re-verifies.
                            if (!(await applyClassifications())) return;
                          }
                          const res = await configureStoreSetup({
                            storeId: st.id,
                            timezone: wizardForm.timezone,
                            currencyCode: wizardForm.currencyCode,
                            paymentMethods: wizardForm.paymentMethods,
                            receiptFooter: wizardForm.receiptFooter,
                            vat: wizardForm.vatStatus === 'REGISTERED'
                              ? { status: 'REGISTERED', vatNumber: wizardForm.vatNumber.trim(), effectiveDate: wizardForm.vatEffectiveDate }
                              : { status: 'NOT_REGISTERED' },
                          }, token);
                          if (!res.ok) {
                            const friendly: Record<string, string> = {
                              owner_aal2_required: 'Owner sign-in with MFA is required to activate a store.',
                              invalid_timezone: 'That timezone is not a valid IANA zone.',
                              invalid_currency: 'Currency must be a 3-letter ISO code.',
                              invalid_payment_methods: 'Choose at least one valid payment method.',
                              invalid_vat_config: 'The VAT details are incomplete — a REGISTERED store needs a GB VAT number and an effective date.',
                              invalid_receipt_footer: 'The receipt footer is too long.',
                              unsupported_timezone: 'Only Europe/London is supported at launch.',
                              unsupported_currency: 'Only GBP is supported at launch.',
                              unsupported_payment_method: 'Gift cards are not available at launch (no balance validation or redemption yet).',
                              products_unclassified: 'Every product needs a VAT classification before the store can be REGISTERED.',
                              tax_code_withdrawal_forbidden: 'A VAT classification is permanent once set — change it to another code, or delete the product.',
                            };
                            addToast(friendly[res.error] ?? `Store setup failed: ${res.error}`, 'error');
                            return;
                          }
                          const r = res.store;
                          // Findings 2/3: push the confirmed row into GLOBAL
                          // state so the till sees ACTIVE immediately; the
                          // overlay below is just this panel's instant paint.
                          applyServerStore(r);
                          setSetupOverlay(prev => ({ ...prev, [st.id]: {
                            setupStatus: r['setup_status'] as SetupStatus,
                            timezone: r['timezone'] as string,
                            currencyCode: r['currency_code'] as string,
                            paymentMethods: r['payment_methods'] as PaymentMethod[],
                            vatStatus: r['vat_status'] as VatStatus,
                          } }));
                          logAction('Stores Operations', `Completed the Store Setup Wizard for "${st.name}" — store is ACTIVE.`);
                          addToast('Store setup complete — the store can now trade.', 'success');
                          setSetupWizardStore(null);
                        } finally {
                          wizardBusyRef.current = false;
                          setWizardBusy(false);
                        }
                      }} className="px-5 py-2 rounded-full text-2xs font-black uppercase tracking-wider bg-[#A46832] hover:bg-[#A5642B] text-white cursor-pointer disabled:opacity-50">
                        {wizardBusy ? 'Activating…' : 'Activate store'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ==================== 7. MENU ITEMS MANAGER ==================== */}
          {effectiveActiveTab === 'menu' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <div>
                  <h1 className="font-display font-black text-2xl">Menu Recipes & Pricing Hub</h1>
                  <p className="text-2xs text-[#2E2A26]/70">Create products, prices and images, and control what appears on the customer menu.</p>
                </div>
                <div className="flex items-center gap-2">
                {POS_SETUP_VISIBLE && currentRole === 'owner' && (
                  <button
                    onClick={() => {
                      setClassifyDraft(Object.fromEntries(menuItems.map(mi => [mi.id, ((taxOverlay[mi.id] ?? mi.taxCode) ?? '') as TaxCode | ''])));
                      setClassifyOpen(true);
                    }}
                    className={`px-4 py-2 rounded-full text-2xs font-black uppercase tracking-wider shadow-xs cursor-pointer ${unclassifiedItems.length && anyStoreCharging ? 'bg-[#A5642B] hover:bg-[#8F5524] text-white' : 'bg-[#7CC0C7] hover:bg-[#5FA9B1] text-[#2E2A26]'}`}
                  >
                    VAT classification{unclassifiedItems.length ? ` (${unclassifiedItems.length})` : ''}
                  </button>
                )}
                <button
                  id="add-menu-cta-main"
                  onClick={() => {
                    setFormType('menu');
                    setMenuFormState(freshMenuForm());
                    resetMenuUploadSession(); // P0-8: a fresh form is a fresh upload session
                    setIsFormOpen(true);
                  }}
                  className="px-4 py-2 bg-[#A46832] hover:bg-[#A5642B] text-white rounded-full text-2xs font-black uppercase tracking-wider shadow-xs cursor-pointer"
                >
                  Create Menu Item
                </button>
                </div>
              </div>

              {/* WS6f-b: a menu published AFTER activation can introduce an
                  unclassified product. The database fails closed (that product
                  alone refuses to sell); this makes the condition visible to
                  the owner instead of surfacing first at the till. */}
              {anyStoreCharging && unclassifiedItems.length > 0 && (
                <div className="rounded-xl border border-[#A5642B]/40 bg-[#A5642B]/10 px-4 py-3 text-2xs font-bold text-[#8F5524] flex items-center justify-between gap-3">
                  <span>
                    {unclassifiedItems.length} product(s) have no VAT classification while a VAT-registered store is charging — those products cannot be sold until an owner classifies them.
                  </span>
                  {currentRole === 'owner' && (
                    <button
                      onClick={() => {
                        setClassifyDraft(Object.fromEntries(menuItems.map(mi => [mi.id, ((taxOverlay[mi.id] ?? mi.taxCode) ?? '') as TaxCode | ''])));
                        setClassifyOpen(true);
                      }}
                      className="shrink-0 px-3 py-1.5 rounded-full bg-[#A5642B] hover:bg-[#8F5524] text-white text-[10px] font-black uppercase tracking-wider cursor-pointer">
                      Classify now
                    </button>
                  )}
                </div>
              )}

              {/* Filtering Controls */}
              <div className="flex items-center gap-2 overflow-x-auto pb-1 text-2xs font-extrabold select-none">
                <button onClick={() => setSearchFilterId('all')} className={`px-4 py-2 rounded-full cursor-pointer uppercase ${searchFilterId === 'all' ? 'bg-[#A46832] text-white shadow-xs' : 'bg-white border text-stone-500 hover:bg-stone-50'}`}>All Menu</button>
                {MENU_CATEGORIES.map(cat => (
                  <button key={cat} onClick={() => setSearchFilterId(cat)} className={`px-4 py-2 rounded-full cursor-pointer uppercase ${searchFilterId === cat ? 'bg-[#A46832] text-white shadow-xs' : 'bg-white border text-stone-500 hover:bg-stone-50'}`}>{cat.replace('_', ' ')}</button>
                ))}
              </div>

              {/* WS6f-b — the STANDALONE owner classification editor. */}
              {classifyOpen && (
                <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !classifyBusy && setClassifyOpen(false)}>
                  <div
                    ref={classificationDialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="vat-classification-title"
                    aria-describedby="vat-classification-description"
                    tabIndex={-1}
                    className="bg-white rounded-2xl mp-shadow w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 space-y-4 focus:outline-none"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <h2 id="vat-classification-title" className="font-display font-black text-lg text-[#2E2A26]">Product VAT classification</h2>
                        <p id="vat-classification-description" className="text-2xs text-[#2E2A26]/60">Owner-only, applied and re-verified on the server. A product with no classification cannot be sold once a store is charging VAT.</p>
                      </div>
                      <button type="button" onClick={() => !classifyBusy && setClassifyOpen(false)} disabled={classifyBusy} aria-label="Close VAT classification" className="min-h-11 min-w-11 rounded-full grid place-items-center hover:bg-stone-100 cursor-pointer disabled:opacity-50"><X className="h-4 w-4" /></button>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold">{menuItems.length} product(s)</span>
                      <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${menuItems.some(mi => !(classifyDraft[mi.id] ?? '')) ? 'bg-[#A5642B]/15 text-[#A5642B]' : 'bg-[#5CA459]/15 text-[#5CA459]'}`}>
                        {menuItems.filter(mi => !(classifyDraft[mi.id] ?? '')).length} unclassified
                      </span>
                    </div>
                    {classificationGrid()}
                    <div className="flex justify-end gap-2 pt-1">
                      <button disabled={classifyBusy} onClick={() => setClassifyOpen(false)}
                        className="px-4 py-2 rounded-full text-2xs font-black uppercase tracking-wider bg-[#F7EFE6] text-[#2E2A26]/70 cursor-pointer disabled:opacity-50">Cancel</button>
                      <button disabled={classifyBusy} onClick={async () => {
                        if (classifyBusyRef.current) return;
                        classifyBusyRef.current = true;
                        setClassifyBusy(true);
                        try {
                          if (await applyClassifications()) {
                            addToast('VAT classifications saved.', 'success');
                            setClassifyOpen(false);
                          }
                        } finally {
                          classifyBusyRef.current = false;
                          setClassifyBusy(false);
                        }
                      }} className="px-5 py-2 rounded-full text-2xs font-black uppercase tracking-wider bg-[#A46832] hover:bg-[#A5642B] text-white cursor-pointer disabled:opacity-50">
                        {classifyBusy ? 'Saving…' : 'Save classifications'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Menu items display map list */}
              <div id="ingredients-products-listings" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                {menuItems.filter(p => searchFilterId === 'all' || p.category === searchFilterId).map((p) => (
                  <div key={p.id} className="bg-white rounded-2xl border border-[#EBDECE]/50 overflow-hidden shadow-2xs hover:shadow-sm flex flex-col justify-between transition-all duration-200">
                    <div>
                      {/* Placeholder graphic design overlay to keep visual beauty */}
                      <div className="h-32 bg-[#F2EFE9] relative flex items-center justify-center">
                        {resolveMenuImage(p) ? (
                          <img src={resolveMenuImage(p)!} className={`h-full w-full ${hasRealImage(p.image) ? 'object-cover' : 'object-contain p-1'}`} alt={p.name} loading="lazy" />
                        ) : (
                          <span className="text-4xl">🥤</span>
                        )}
                        <span className="absolute top-2 right-2 text-[8px] bg-black/50 text-white font-mono px-2 py-0.5 rounded-full font-black">
                          {p.category.toUpperCase()}
                        </span>
                        <span title="VAT classification (owner-set via the Store Setup Wizard)"
                          className={`absolute top-2 left-2 text-[8px] font-mono px-2 py-0.5 rounded-full font-black ${((taxOverlay[p.id] ?? p.taxCode)) ? 'bg-[#7CC0C7]/80 text-[#2E2A26]' : 'bg-[#A5642B]/70 text-white'}`}>
                          VAT {({ ZERO_RATED: '0%', REDUCED_RATE: '5%', STANDARD_RATE: '20%', OUTSIDE_SCOPE: 'O/S' } as Record<string, string>)[(taxOverlay[p.id] ?? p.taxCode) ?? ''] ?? '—'}
                        </span>
                      </div>

                      <div className="p-4 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-display font-black text-2xs uppercase tracking-wide truncate">{p.name}</span>
                          <span className="font-mono text-[#A46832] font-extrabold">{cur}{p.price.toFixed(2)}</span>
                        </div>
                        <p className="text-[10px] text-stone-550 leading-relaxed line-clamp-2 h-7 font-medium">{p.description}</p>
                        <div className="flex flex-wrap gap-1 items-center pt-1">
                          <span className="text-[8px] bg-stone-100 text-stone-500 px-1.5 py-0.5 rounded uppercase font-bold">{p.calories} KCAL</span>
                          {p.tags.map((tg, i) => (
                            <span key={i} className="text-[8px] bg-[#7CC0C7]/40 text-sky-800 px-1.5 py-0.5 rounded font-bold font-display uppercase tracking-widest">{tg}</span>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="px-4 py-3 bg-stone-50 border-t flex justify-between items-center text-[10px]">
                      <div className="flex items-center gap-1">
                        <PublicationBadge live={!!p.available} />
                        <PublishButton table="menu_items" canPublish={canPublishTable('menu_items')} busyAction={busyAction} onToggle={publishOne} id={p.id} live={!!p.available} label={`"${p.name}"`} />
                        <button
                          onClick={() => {
                            setFormType('menu');
                            setMenuFormState({ ...p });
                            setEditItemId(p.id);
                            resetMenuUploadSession(); // P0-8: switching item discards any pending object
                            setIsFormOpen(true);
                          }}
                          className="text-[#A46832] hover:bg-amber-100/40 p-1.5 rounded cursor-pointer"
                          title="Edit Recipe"
                        >
                          <Edit className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => { void deleteMenuItemWithFeedback(p); }}
                          disabled={busyAction !== null}
                          className="text-red-500 hover:bg-red-50 p-1.5 rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Delete Recipe"
                        >
                          <Trash className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <button onClick={() => { setFormType('menu'); setMenuFormState({ ...p }); setEditItemId(p.id); resetMenuUploadSession(); setIsFormOpen(true); }} className="px-3 py-1.5 bg-[#2E2A26] uppercase font-black text-[9px] text-white hover:bg-[#4B4540] rounded-full cursor-pointer tracking-wider">Edit product</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ==================== 8. STAFF DIRECTORY ==================== */}
          {effectiveActiveTab === 'staff' && (
            <div className="space-y-6 animate-fade-in">
              <div className="flex justify-between items-center">
                <div>
                  <h1 className="font-display font-black text-2xl">Staff Directory Registry</h1>
                  <p className="text-2xs text-[#2E2A26]/70">Audit employee roles, contractual holiday allocations, security clearance levels, and open employee records drawers.</p>
                </div>
                <button
                  id="onboard-new-associate-cta"
                  onClick={() => {
                    setFormType('staff');
                    setStaffFormState(freshStaffForm());
                    setIsFormOpen(true);
                  }}
                  className="px-4 py-2 bg-[#A46832] text-white rounded-full text-2xs hover:bg-[#A5642B] cursor-pointer font-black uppercase tracking-wider"
                >
                  Onboard Associate
                </button>
              </div>

              {/* Roster Spreadsheet design interface */}
              <div className="bg-white rounded-2xl border border-[#EBDECE]/50 overflow-hidden shadow-2xs">
                <table className="w-full text-left text-2xs font-sans">
                  <thead className="bg-[#DFD3C3]/40 border-b text-[10px] uppercase font-mono text-[#2E2A26]">
                    <tr>
                      <th className="p-4">Rostered Associate</th>
                      <th className="p-4">Clearance Role</th>
                      <th className="p-4">Store Terminal</th>
                      <th className="p-4">Next Scheduled Duty</th>
                      <th className="p-4">Academy Level</th>
                      <th className="p-4">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y text-stone-600 leading-normal">
                    {employeesList.map((emp) => (
                      <tr key={emp.id} className="hover:bg-[#F7EFE6]/60 transition-all">
                        <td className="p-4 flex items-center gap-2">
                          <div className="h-8 w-8 bg-[#A46832] font-bold rounded-full border border-white flex items-center justify-center text-white shrink-0 text-3xs uppercase">
                            {emp.avatar ? <img referrerPolicy="no-referrer" src={emp.avatar} className="object-cover h-full w-full rounded-full" alt="" /> : emp.name.slice(0, 2)}
                          </div>
                          <div>
                            <p className="font-extrabold text-[#2E2A26] text-2xs leading-none">{emp.name}</p>
                            <p className="text-[10px] text-zinc-400 font-mono leading-none mt-1">{emp.email}</p>
                          </div>
                        </td>
                        <td className="p-4">
                          <span className="text-[9px] font-black uppercase bg-[#EBDECE] text-stone-700 px-2 py-0.5 rounded">
                            {emp.role.replace('_', ' ')}
                          </span>
                        </td>
                        <td className="p-4">{emp.storeName}</td>
                        <td className="p-4 font-mono text-[10px]">{emp.nextShift || 'No Shifts Scheduled'}</td>
                        <td className="p-4">
                          <span className="text-[9px] font-black bg-teal-50 text-teal-700 border border-teal-200 px-1.5 py-0.5 rounded font-mono">
                            LVL {emp.level || 1} ({emp.points ?? 0} pts)
                          </span>
                        </td>
                        <td className="p-4">
                          <div className="flex items-center gap-1">
                            <button onClick={() => setSelectedStaffUser(emp)} className="p-1 px-2 border hover:bg-[#EBDECE]/20 rounded text-[#A46832] font-bold uppercase transition-all duration-150 cursor-pointer">Profile</button>
                            <span className={`px-2 py-0.5 rounded-full text-[8px] font-black uppercase ${emp.status === 'disabled' ? 'bg-red-100 text-red-600' : emp.onboarding === 'active' ? 'bg-[#5CA459]/15 text-[#4E8E4B]' : emp.onboarding === 'invited' ? 'bg-amber-100 text-[#A46832]' : 'bg-stone-100 text-stone-500'}`}>
                              {onboardingLabel(emp.onboarding, emp.status)}
                            </span>
                            {emp.status !== 'disabled' && emp.onboarding !== 'active' && (
                              <button
                                disabled={mutBusy}
                                onClick={() => {
                                  void withMutationBusy(async () => { await onStaffInvite('invite', emp.id); });
                                }}
                                className="p-1 px-2 border border-[#5CA459]/50 rounded text-[#4E8E4B] font-bold uppercase text-[9px] hover:bg-[#5CA459]/10 cursor-pointer disabled:opacity-50"
                              >
                                {emp.onboarding === 'invited' ? 'Resend' : 'Invite'}
                              </button>
                            )}
                            {/* R4.8 Workstream B: no casual deletion. Leavers go
                                through the audited End-employment lifecycle; the
                                owner-only duplicate purge lives inside the dialog
                                and the SERVER refuses it when history exists. */}
                            <button
                              onClick={() => setEndingEmployee({ id: emp.id, name: emp.name })}
                              className="p-1 px-2 border border-red-200 rounded text-red-500 font-bold uppercase text-[9px] hover:bg-red-50 cursor-pointer"
                              title="End employment / deactivate access"
                            >
                              End employment
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {endingEmployee && (
                  <EndEmploymentDialog
                    employee={endingEmployee}
                    isOwner={currentRole === 'owner'}
                    onClose={() => setEndingEmployee(null)}
                    onDone={(m, tone) => addToast(m, tone === 'success' ? 'success' : tone === 'warning' ? 'warning' : 'error')}
                  />
                )}
              </div>

              {/* Live HR Expanded Drawer details */}
              {selectedStaffUser && (
                <div className="bg-white rounded-2xl border p-5 space-y-4 shadow-sm animate-fade-in text-2xs text-[#2E2A26]">
                  <div className="flex justify-between items-center pb-2 border-b">
                    <h3 className="font-display font-black text-xs uppercase tracking-widest text-[#A46832]">
                      Detailed Employee Record: {selectedStaffUser.name}
                    </h3>
                    <button type="button" aria-label="Close employee record" onClick={() => setSelectedStaffUser(null)} className="min-h-11 min-w-11 rounded-full grid place-items-center text-red-500 hover:bg-neutral-155 cursor-pointer">
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  {selectedStaffUser.role === 'owner' ? (
                     <div className="p-10 text-center space-y-2 bg-neutral-50 rounded-xl border border-dashed border-neutral-200">
                      <Shield className="h-8 w-8 text-[#A46832] mx-auto" />
                      <p className="font-black text-xs uppercase tracking-widest text-neutral-400">Restricted Profile</p>
                      <p className="text-[10px] text-neutral-400">Owner stats, salaries, and logs are strictly confidential and redacted from directory views.</p>
                     </div>
                  ) : (
                    <div className="space-y-6">
                      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div className="p-3.5 bg-[#EBDECE]/15 border border-[#EBDECE]/40 rounded-xl space-y-1">
                          <span className="text-zinc-400 font-mono text-[9px] uppercase font-black block">Holiday Balance</span>
                          <p className="font-display font-black text-lg text-[#A46832]">{selectedStaffUser.holidayBalance} Days</p>
                          <button onClick={() => setHolidayDialogTarget(selectedStaffUser)} className="min-h-11 text-[10px] hover:underline block text-stone-500 font-bold cursor-pointer">Set allowance</button>
                        </div>

                        <div className="p-3.5 bg-[#EBDECE]/15 border border-[#EBDECE]/40 rounded-xl space-y-1">
                          <span className="text-zinc-400 font-mono text-[9px] uppercase font-black block">Academy points accrued</span>
                          <p className="font-display font-black text-lg text-teal-700">{selectedStaffUser.points} Points</p>
                          <button onClick={() => { setActiveTab('recognition'); setSelectedStaffUser(null); }} className="text-[9px] hover:underline block text-teal-800 font-bold cursor-pointer">Award points</button>
                        </div>

                        <div className="p-3.5 bg-[#EBDECE]/15 border border-[#EBDECE]/40 rounded-xl space-y-1">
                          <span className="text-zinc-400 font-mono text-[9px] uppercase font-black block">Earned badges list</span>
                          <div className="flex flex-wrap gap-1 mt-1 font-mono">
                            {selectedStaffUser.badges.map((b, i) => (
                              <span key={i} className="text-[8px] bg-amber-50 text-amber-700 border border-amber-200 px-1 py-0.5 rounded">{b}</span>
                            ))}
                          </div>
                        </div>

                        <div className="p-3.5 bg-[#EBDECE]/15 border border-[#EBDECE]/40 rounded-xl space-y-2">
                          <span className="text-zinc-400 font-mono text-[9px] uppercase font-black block">Contract Pay Setup</span>
                          {employee?.role !== 'owner' ? (
                            <p className="text-[10px] text-stone-400 leading-snug">Contract pay is owner-only — the database refuses manager pay changes, so the controls aren't shown.</p>
                          ) : (<>
                          <div className="flex items-center gap-2">
                            <select
                               title="Pay Type"
                               value={selectedStaffUser.payType || 'hourly'}
                               onChange={(e) => {
                                 const payType = e.target.value as 'hourly' | 'salary';
                                 void updateStaffPayWithFeedback(selectedStaffUser, { payType }, 'Contract pay type updated.');
                               }}
                               disabled={busyAction !== null}
                               className="bg-white border rounded text-[10px] p-1 font-bold flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                               {/* T13-6: ONE pay model everywhere — salary is
                                   ANNUAL (src/lib/pay.ts). This selector still
                                   said "Salary/Month", contradicting both the
                                   onboarding form and the shared helper. */}
                               <option value="hourly">Hourly rate (£ / hour)</option>
                               <option value="salary">Annual salary (£ / year)</option>
                            </select>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                               title="Pay Rate"
                               type="number"
                               step="0.01"
                               key={selectedStaffUser.id}
                               defaultValue={selectedStaffUser.payRate || ''}
                               onBlur={(e) => {
                                 const raw = e.currentTarget.value.trim();
                                 if (!raw) {
                                   e.currentTarget.value = selectedStaffUser.payRate ? String(selectedStaffUser.payRate) : '';
                                   if (selectedStaffUser.payRate) addToast('Enter a positive rate; clearing an existing contractual rate requires the controlled HR process.', 'warning');
                                   return;
                                 }
                                 const rate = Number(raw);
                                 if (!Number.isFinite(rate) || rate <= 0) {
                                   e.currentTarget.value = selectedStaffUser.payRate ? String(selectedStaffUser.payRate) : '';
                                   addToast('Pay rate must be a positive number.', 'error');
                                   return;
                                 }
                                 if (rate === selectedStaffUser.payRate) return;
                                 void updateStaffPayWithFeedback(selectedStaffUser, { payRate: rate }, 'Pay rate saved.');
                               }}
                               disabled={busyAction !== null}
                               className="bg-white border text-[10px] rounded p-1 w-full font-mono disabled:opacity-50 disabled:cursor-not-allowed"
                               placeholder="Enter rate... (saves when you leave the field)"
                            />
                          </div>
                          </>)}
                        </div>

                        <div className="p-3.5 bg-[#EBDECE]/15 border border-[#EBDECE]/40 rounded-xl space-y-2">
                          <span className="text-zinc-400 font-mono text-[9px] uppercase font-black block">Sign-in account</span>
                          <p className="font-display font-black text-sm text-[#2E2A26]">{onboardingLabel(selectedStaffUser.onboarding, selectedStaffUser.status)}</p>
                          <div className="flex flex-wrap gap-1.5">
                            {selectedStaffUser.status !== 'disabled' && selectedStaffUser.onboarding !== 'active' && (
                              <button disabled={mutBusy} onClick={() => { void withMutationBusy(async () => { await onStaffInvite('invite', selectedStaffUser.id); }); }} className="text-[9px] px-2.5 py-1 rounded-full bg-[#5CA459] text-white font-black uppercase cursor-pointer disabled:opacity-50">
                                {selectedStaffUser.onboarding === 'invited' ? 'Resend invitation' : 'Send invitation'}
                              </button>
                            )}
                            <button disabled={mutBusy} onClick={() => { void withMutationBusy(async () => { await onStaffInvite('refresh', selectedStaffUser.id); }); }} className="text-[9px] px-2.5 py-1 rounded-full border font-black uppercase text-stone-500 cursor-pointer hover:bg-stone-50 disabled:opacity-50">
                              Refresh status
                            </button>
                            {employee?.role === 'owner' && (
                              selectedStaffUser.status === 'disabled' ? (
                                <button disabled={mutBusy} onClick={() => { void withMutationBusy(async () => { await onStaffInvite('enable', selectedStaffUser.id); }); }} className="text-[9px] px-2.5 py-1 rounded-full border border-[#5CA459] text-[#4E8E4B] font-black uppercase cursor-pointer disabled:opacity-50">
                                  Re-enable account
                                </button>
                              ) : (
                                <button disabled={mutBusy} onClick={() => { if (!window.confirm(`Disable ${selectedStaffUser.name}'s account? Sign-in and internal access stop immediately.`)) return; void withMutationBusy(async () => { await onStaffInvite('disable', selectedStaffUser.id); }); }} className="text-[9px] px-2.5 py-1 rounded-full border border-red-300 text-red-500 font-black uppercase cursor-pointer disabled:opacity-50">
                                  Disable account
                                </button>
                              )
                            )}
                          </div>
                          <p className="text-[9px] text-stone-400 leading-snug">A profile is not a login. “Account active” means the person has signed in at least once.</p>
                        </div>
                      </div>

                      {/* DETAILED LOGS GRID */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-neutral-50 p-4 rounded-xl border border-neutral-100">
                        {/* Left Col: Shifts & Pays */}
                        <div className="space-y-6">
                           <div>
                             <h4 className="font-black text-[10px] uppercase tracking-widest mb-3 border-b border-neutral-200 pb-1 text-[#2E2A26] flex justify-between">
                               <span>Allocated Shifts</span>
                               <span className="opacity-50">{selectedStaffShifts.length} Total</span>
                             </h4>
                             <div className="space-y-2 max-h-40 overflow-y-auto pr-2">
                               {selectedStaffShifts.map(sh => (
                                 <div key={sh.id} className="bg-white border border-neutral-200 p-2 rounded-lg flex justify-between items-center text-[10px]">
                                   <span className="font-bold">{new Date(sh.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                                   <span className="font-mono text-neutral-500 bg-neutral-100 px-1.5 py-0.5 rounded">{hhmm(sh.startTime)} - {hhmm(sh.endTime)}</span>
                                   <span className="uppercase text-[8px] font-black opacity-50">{sh.type}</span>
                                 </div>
                               ))}
                               {selectedStaffShifts.length === 0 && (
                                 <div className="text-center text-neutral-400 italic py-2">No upcoming shifts Scheduled.</div>
                               )}
                             </div>
                           </div>

                           <div>
                             <h4 className="font-black text-[10px] uppercase tracking-widest mb-3 border-b border-neutral-200 pb-1 text-[#2E2A26] flex justify-between">
                               <span>Clock Logs & Pays</span>
                               <span className="opacity-50">Synced Timesheets</span>
                             </h4>
                             <div className="space-y-2 max-h-40 overflow-y-auto pr-2">
                               {(() => {
                                  if (selectedStaffClockRows.length === 0) return <div className="text-center text-neutral-400 italic py-2">No timesheet records yet.</div>;

                                  const isSalary = selectedStaffUser.payType === 'salary';
                                  const hourlyRate = effectiveHourlyRate(selectedStaffUser);

                                  return selectedStaffClockRows.map(log => {
                                    const shiftPay = hourlyRate === null ? null : (log.totalDecimalHours || 0) * hourlyRate;
                                    return (
                                        <div key={log.id} className="bg-white border border-[#5FA777]/30 p-2 rounded-lg flex flex-col gap-1 text-[10px]">
                                          <div className="flex justify-between font-bold">
                                            <span>{new Date(log.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                                            {isSalary
                                              ? <span className="text-neutral-400 font-normal italic">Salaried — payroll handled separately</span>
                                              : shiftPay === null
                                                ? <span className="text-neutral-400 font-normal italic">Pay rate not configured</span>
                                                : <span className="text-[#5FA777]" title="Estimated gross earnings — no PAYE, NI or pension deductions">£{shiftPay.toFixed(2)} est. gross</span>}
                                          </div>
                                          <div className="flex justify-between text-[9px] text-neutral-500 font-mono">
                                            <span>{new Date(log.clockIn).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} - {log.clockOut ? new Date(log.clockOut).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'Pending'}</span>
                                            <span>{log.totalDecimalHours} hrs{hourlyRate === null ? '' : ` @ £${hourlyRate.toFixed(2)}/hr`}</span>
                                          </div>
                                        </div>
                                    );
                                  });
                               })()}
                             </div>
                           </div>
                        </div>

                        {/* Right Col: SIFR & Reviews */}
                        <div className="space-y-6">
                           <div>
                             <h4 className="font-black text-[10px] uppercase tracking-widest mb-3 border-b border-neutral-200 pb-1 text-[#2E2A26] flex justify-between">
                               <span>Logged SIFR Reports</span>
                               <span className="opacity-50">Non-Anonymous</span>
                             </h4>
                             <div className="space-y-2 max-h-40 overflow-y-auto pr-2">
                               {(() => {
                                  const userReports = sifrReports.filter(r => r.reporterId === selectedStaffUser.id && r.confidentiality !== 'confidential');
                                  if (userReports.length === 0) return <div className="text-center text-neutral-400 italic py-2">No public SIFR logs generated.</div>;
                                  
                                  return userReports.map(rep => (
                                     <div key={rep.id} className="bg-white border border-neutral-200 p-2.5 rounded-lg space-y-1">
                                        <div className="flex justify-between items-start">
                                           <span className="text-[10px] font-bold text-red-700">{(rep.category || 'other').replace('_', ' ')}</span>
                                           <span className="text-[8px] font-mono text-neutral-400">{new Date(rep.date).toLocaleDateString()}</span>
                                        </div>
                                        <p className="text-[9px] text-neutral-600 line-clamp-2 leading-relaxed">{rep.description}</p>
                                     </div>
                                  ));
                               })()}
                             </div>
                           </div>
                           
                           <div>
                             <h4 className="font-black text-[10px] uppercase tracking-widest mb-3 border-b border-neutral-200 pb-1 text-[#2E2A26] flex justify-between">
                               <span>Performance & Reviews</span>
                               <span className="opacity-50">Management Eyes Only</span>
                             </h4>
                             <div className="space-y-3">
                               {/* PHASE A: the old reader showed reviews from THIS
                                   browser's localStorage only ("on this terminal").
                                   Central, access-controlled review records are a
                                   post-launch feature — until then this is honest. */}
                               <div className="text-center text-neutral-400 italic py-2 text-[10px]">
                                 Central performance reviews are not part of this launch. Review logging stays disabled until an access-controlled central module is commissioned.
                               </div>
                             </div>
                           </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ==================== 9. SHIFT SCHEDULE ROTA BUILDER ==================== */}
          {effectiveActiveTab === 'rota' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <div>
                  <h1 className="font-display font-black text-2xl">Team Scheduling Matrix</h1>
                  <p className="text-2xs text-[#2E2A26]/70">Dispatch weekly schedules, verify staff availability, and analyse labour expenditure costs.</p>
                </div>
                <button
                  onClick={() => {
                    setShiftFormState({ employeeId: employeesList[0]?.id || '', date: businessTodayISO(), startTime: '09:00', endTime: '17:00', type: 'mid', notes: '' });
                    document.getElementById('shift-form-registry')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                  className="px-4 py-2 bg-[#A46832] text-white rounded-full text-2xs hover:bg-[#A5642B] cursor-pointer font-black uppercase tracking-wider"
                >
                  Create Shift Block
                </button>
              </div>

              {/* Shift Rota builder Form inline */}
              <div id="shift-form-registry" className="bg-white p-5 rounded-2xl border p-5 space-y-4 text-2xs text-[#2E2A26]">
                <h3 className="font-display font-black uppercase tracking-wider pb-1 border-b">Add Shift Form Registry</h3>
                <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                  <div className="space-y-1">
                    <label htmlFor="shift-employee" className="font-bold">Associate Roster Name *</label>
                    <select id="shift-employee" value={shiftFormState.employeeId} onChange={(e) => {
                      /* SMALL-BIZ CLOSURE P0-9: choosing the employee derives
                         the shift's DEFAULT store from that employee's real
                         assignment — never a hardcoded identity. */
                      const emp = employeesById.get(e.target.value);
                      setShiftFormState({ ...shiftFormState, employeeId: e.target.value, storeId: emp?.storeId || shiftFormState.storeId || '' });
                    }} className="w-full bg-stone-50 border p-2 rounded-lg">
                      <option value="">Choose Employee</option>
                      {enabledEmployees.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="shift-store" className="font-bold">Store *</label>
                    {/* SMALL-BIZ CLOSURE P0-9: real stores only. The owner may
                        move the shift to any store; a store manager sees only
                        their permitted store (RLS enforces the same boundary
                        server-side regardless of what this list shows). */}
                    <select id="shift-store" value={shiftFormState.storeId || ''} onChange={(e) => setShiftFormState({ ...shiftFormState, storeId: e.target.value })} className="w-full bg-stone-50 border p-2 rounded-lg">
                      <option value="">Choose Store</option>
                      {stores
                        .filter(st => currentRole === 'owner' || st.id === employee?.storeId)
                        .map(st => <option key={st.id} value={st.id}>{st.name}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="shift-date" className="font-bold">Shift Date *</label>
                    <input id="shift-date" type="date" value={shiftFormState.date} onChange={(e) => setShiftFormState({ ...shiftFormState, date: e.target.value })} className="w-full bg-stone-50 border p-2 rounded-lg" />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="shift-start" className="font-bold">Start Time *</label>
                    <input id="shift-start" type="time" placeholder="HH:MM" value={hhmm(shiftFormState.startTime)} onChange={(e) => setShiftFormState({ ...shiftFormState, startTime: e.target.value })} className="w-full bg-stone-50 border p-2 rounded-lg" />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor="shift-end" className="font-bold">End Time *</label>
                    <input id="shift-end" type="time" placeholder="HH:MM" value={hhmm(shiftFormState.endTime)} onChange={(e) => setShiftFormState({ ...shiftFormState, endTime: e.target.value })} className="w-full bg-stone-50 border p-2 rounded-lg" />
                  </div>
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    onClick={async () => {
                      if (!shiftFormState.employeeId) {
                        addToast('Please choose an employee first.', 'error');
                        return;
                      }
                      const empObj = employeesById.get(String(shiftFormState.employeeId || ''));
                      if (!empObj) {
                        addToast('That employee is no longer available. Refresh the staff list and choose again.', 'error');
                        return;
                      }
                      if (!shiftFormState.date || !shiftFormState.startTime || !shiftFormState.endTime) {
                        addToast('Choose a date, start time and end time for the shift.', 'error');
                        return;
                      }
                      /* SMALL-BIZ CLOSURE P0-9: the shift's store is a REAL
                         store row — the form's selection, falling back to the
                         employee's own assignment. There is no fictional
                         default: an unresolvable store refuses the save. */
                      const shiftStore = storesById.get(shiftFormState.storeId || empObj.storeId);
                      if (!shiftStore) {
                        addToast('Choose a store for this shift — the selected employee has no store assigned.', 'error');
                        return;
                      }
                      const val: WorkShift = {
                        id: createClientId('sh'),
                        employeeId: empObj.id,
                        employeeName: empObj.name,
                        role: empObj.role,
                        storeId: shiftStore.id,
                        storeName: shiftStore.name,
                        date: shiftFormState.date,
                        startTime: shiftFormState.startTime,
                        endTime: shiftFormState.endTime,
                        type: 'mid',
                        notes: shiftFormState.notes || ''
                      };
                      if (!shiftInterval(val)) {
                        addToast('Start and end time must be different and use a valid 24-hour time.', 'error');
                        return;
                      }
                      if (shiftsList.some(existing => existing.employeeId === val.employeeId && shiftsOverlap(existing, val))) {
                        addToast('This employee already has an overlapping shift. Review the rota before saving.', 'error');
                        return;
                      }
                      await withMutationBusy(async () => {
                        if (!(await onAddShift(val))) return;
                        notifyShiftByEmail(val);
                        logAction('Schedulers', `Dispatched shift block for "${val.employeeName}" on ${val.date}`);
                        addToast(`Shift dispatched for "${val.employeeName}" and saved to the database.`, 'success');
                      });
                    }}
                    disabled={mutBusy}
                    className="px-5 py-2.5 bg-[#A46832] text-white rounded-full font-black uppercase text-2xs cursor-pointer shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {mutBusy ? 'Saving…' : 'Confirm Shift Allocation'}
                  </button>
                </div>
              </div>

              {/* ALL-STAFF WEEKLY GRID — every team member side by side, one week at a time */}
              {(() => {
                const weekDays = rotaWeekWindow.days;
                const rangeLabel = `${weekDays[0]!.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${weekDays[6]!.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;

                return (
                  <div className="bg-white mp-blob-l mp-shadow border border-[#EBDECE] p-5 space-y-4">
                    <div className="flex items-center justify-between flex-wrap gap-3 border-b border-[#EBDECE] pb-3">
                      <h3 className="font-display font-black uppercase tracking-wider text-xs flex items-center gap-2">
                        <Users className="h-4 w-4 text-[#A46832]" />
                        Whole-Team Week View
                      </h3>
                      <div className="flex items-center gap-2">
                        <button onClick={() => setWeekOffset(w => w - 1)} className="p-1.5 border border-[#EBDECE] rounded-xl rounded-bl-sm hover:bg-[#F7EFE6] cursor-pointer" aria-label="Previous week">
                          <ChevronLeft className="h-4 w-4" />
                        </button>
                        <span className="text-2xs font-black min-w-[170px] text-center">
                          {rangeLabel}
                          {weekOffset === 0 && <span className="ml-1.5 text-[8px] bg-[#7CC0C7] text-[#2E2A26] px-1.5 py-0.5 rounded-full uppercase inline-block mp-tilt-l">This week</span>}
                        </span>
                        <button onClick={() => setWeekOffset(w => w + 1)} className="p-1.5 border border-[#EBDECE] rounded-xl rounded-br-sm hover:bg-[#F7EFE6] cursor-pointer" aria-label="Next week">
                          <ChevronRight className="h-4 w-4" />
                        </button>
                        {weekOffset !== 0 && (
                          <button onClick={() => setWeekOffset(0)} className="px-2.5 py-1.5 border border-[#EBDECE] rounded-xl text-[9px] font-black uppercase hover:bg-[#F7EFE6] cursor-pointer">Today</button>
                        )}
                      </div>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse min-w-[860px] text-2xs">
                        <thead>
                          <tr className="text-[9px] uppercase font-black text-[#A5642B]">
                            <th className="p-2 text-left w-44 bg-[#F7EFE6] border border-[#EBDECE] sticky left-0">Associate</th>
                            {weekDays.map((day) => (
                              <th key={day.iso} className={`p-2 border border-[#EBDECE] text-center ${day.iso === rotaWeekWindow.todayIso ? 'bg-[#7CC0C7]/25' : 'bg-[#F7EFE6]'}`}>
                                {day.date.toLocaleDateString('en-GB', { weekday: 'short' })}
                                <span className="block font-mono text-[8px] text-[#2E2A26]/40 font-normal">{day.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
                              </th>
                            ))}
                            <th className="p-2 border border-[#EBDECE] bg-[#F7EFE6] text-right w-16">Hours</th>
                          </tr>
                        </thead>
                        <tbody>
                          {employeesList.map(emp => {
                            const totalHrs = rotaDisplayedEmployeeHours.get(emp.id) || 0;
                            return (
                              <tr key={emp.id} className="hover:bg-[#F7EFE6]/60">
                                <td className="p-2 border border-[#EBDECE] bg-white sticky left-0">
                                  <p className="font-extrabold text-[#2E2A26] uppercase text-[10px] leading-tight">{emp.name}</p>
                                  <p className="font-mono text-[8px] text-[#2E2A26]/40">{emp.role.replace('_', ' ')}</p>
                                </td>
                                {rotaWeekWindow.isos.map(dayIso => {
                                  const cell = getRotaCell(rotaModel, emp.id, dayIso);
                                  return (
                                    <td key={dayIso} className={`p-1.5 border border-[#EBDECE] align-top text-center ${dayIso === rotaWeekWindow.todayIso ? 'bg-[#7CC0C7]/10' : ''}`}>
                                      {cell.length === 0 ? (
                                        <span className="text-[#EBDECE] select-none">—</span>
                                      ) : cell.map(s => (
                                        <div key={s.id} className={`group relative mb-1 last:mb-0 rounded-xl rounded-tl-sm px-1.5 py-1 text-[9px] font-mono font-bold border ${
                                          s.type === 'opening' ? 'bg-[#F7EFE6] border-[#A46832]/40 text-[#A5642B]'
                                          : s.type === 'closing' ? 'bg-[#2E2A26] border-[#2E2A26] text-[#F7EFE6]'
                                          : s.type === 'training' ? 'bg-[#7CC0C7]/20 border-[#7CC0C7] text-[#2E2A26]'
                                          : 'bg-white border-[#EBDECE] text-[#2E2A26]'
                                        }`}>
                                          {hhmm(s.startTime)}–{hhmm(s.endTime)}
                                          <span className="block text-[7px] uppercase font-black opacity-60">{s.type}</span>
                                          <button
                                            type="button"
                                            onClick={() => { void deleteShiftWithFeedback(s, `Deleted shift via week grid (${emp.name} ${s.date})`); }}
                                            className="absolute -top-2 -right-2 h-6 w-6 bg-red-500 text-white rounded-full opacity-70 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer z-10 grid place-items-center hover:bg-red-600"
                                            aria-label={`Delete ${emp.name}'s shift on ${s.date}`}
                                          >
                                            <X className="h-2.5 w-2.5" />
                                          </button>
                                        </div>
                                      ))}
                                    </td>
                                  );
                                })}
                                <td className="p-2 border border-[#EBDECE] text-right font-mono font-bold text-[10px] text-[#A5642B]">
                                  {totalHrs > 0 ? `${totalHrs.toFixed(1)}h` : <span className="text-[#EBDECE]">0</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {rotaDisplayedWeekShifts.length === 0 && (
                      <p className="text-center text-[10px] font-mono text-stone-400 pt-1">No shifts scheduled this week — add one with the form above.</p>
                    )}
                  </div>
                );
              })()}

              {/* Advanced Weekly Scheduling Matrix Planner */}
              <div className="bg-white rounded-2xl border shadow-sm p-5 space-y-6">
                <div className="flex items-center justify-between border-b pb-2">
                  <h3 className="font-display font-black uppercase tracking-wider text-xs">Advanced Weekly Matrix Planner</h3>
                  <span className="text-[10px] bg-[#EBDECE]/50 px-2.5 py-1 rounded-md text-[#2E2A26] font-mono">Week-by-Week Setup</span>
                </div>
                
                <div className="space-y-6">
                  {rotaModel.weekSummaries.length === 0 ? (
                    <div className="text-center py-8 text-stone-400 font-mono text-[10px]">No shifts scheduled yet.</div>
                  ) : rotaModel.weekSummaries.map((weekSummary) => {
                    const weekKey = weekSummary.key;
                    const employeeStats = weekSummary.employees;
                    const totalWeekHours = weekSummary.totalHours;
                    const totalWeekCost = weekSummary.totalCost;
                    const unpricedStaff = weekSummary.unpricedStaff;

                    /* T13-6 — ESTIMATED LABOUR COST, one pay model. The pure
                       rota projection uses annual / 52 for salaried staff and
                       leaves missing pay rates explicitly unpriced. */
                    return (

                          <div key={weekKey} className="border border-[#D2C5B4] rounded-xl overflow-hidden shadow-xs">
                              {/* Week Header */}
                              <div className="bg-[#DFD3C3]/40 px-4 py-3 border-b border-[#D2C5B4] flex justify-between items-center flex-wrap gap-2">
                                <h4 className="font-black text-sm uppercase tracking-wide text-[#2E2A26] flex items-center gap-2">
                                  <Calendar className="h-4 w-4 text-[#A46832]" />
                                  Week {weekKey.split('-W')[1]} ({weekKey.split('-')[0]})
                                </h4>
                                <div className="flex items-center gap-4 text-[10px] font-mono">
                                    <span className="bg-white px-2 py-1 rounded shadow-xs border text-stone-600">Total Hours: <b className="text-[#2E2A26]">{totalWeekHours.toFixed(1)}h</b></span>
                                    <span className="bg-white px-2 py-1 rounded shadow-xs border text-stone-600">Estimated labour cost: <b className="text-red-600">£{totalWeekCost.toFixed(2)}</b></span>
                                    {unpricedStaff.length > 0 && (
                                      <span className="bg-white px-2 py-1 rounded shadow-xs border text-stone-500" title={unpricedStaff.join(', ')}>
                                        Pay rate not configured: <b>{unpricedStaff.join(', ')}</b>
                                      </span>
                                    )}
                                </div>
                              </div>

                              {/* Matrix View */}
                              <div className="overflow-x-auto">
                                <table className="w-full text-left border-collapse min-w-[600px]">
                                    <thead>
                                        <tr className="bg-stone-50 border-b border-[#D2C5B4] text-[9px] uppercase font-black text-stone-500">
                                            <th className="p-3 w-1/4">Associate</th>
                                            <th className="p-3">Shifts Breakdown</th>
                                            <th className="p-3 text-right">Hours</th>
                                            <th className="p-3 text-right">Cost</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[#EBDECE]/60">
                                        {employeeStats.map((stat) => (
                                            <tr key={stat.employeeId} className="hover:bg-stone-50 transition-colors">
                                                <td className="p-3">
                                                    <p className="font-extrabold text-[#2E2A26] text-xs uppercase">{stat.name}</p>
                                                    <p className="font-mono text-[9px] text-stone-400">
                                                        {stat.payRate > 0 ? (stat.payType === 'hourly' ? `£${stat.payRate}/hr` : `£${stat.payRate.toLocaleString('en-GB')}/year`) : 'Rate missing'}
                                                    </p>
                                                </td>
                                                <td className="p-3">
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {stat.shifts.map(sh => (
                                                            <div key={sh.id} className="bg-white border rounded px-1.5 py-0.5 relative group cursor-pointer hover:border-[#A46832] transition-colors">
                                                                <span className="block font-bold text-[9px] text-[#A46832] uppercase">{new Date(sh.date).toLocaleDateString('en-GB', {weekday: 'short'})}</span>
                                                                <span className="block font-mono text-[8px] text-stone-500">{hhmm(sh.startTime)}-{hhmm(sh.endTime)}</span>
                                                                <button type="button" aria-label={`Delete ${sh.employeeName}'s shift on ${sh.date}`} onClick={(e) => { e.stopPropagation(); void deleteShiftWithFeedback(sh, 'Deleted shift block via Matrix'); }} className="absolute -top-2 -right-2 h-6 w-6 bg-red-500 text-white rounded-full opacity-70 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity drop-shadow-md z-10 cursor-pointer grid place-items-center hover:bg-red-600">
                                                                    <Trash className="h-3 w-3" />
                                                                </button>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </td>
                                                <td className="p-3 text-right font-mono text-[10px] font-bold text-[#2E2A26]">
                                                    {stat.hours.toFixed(1)}h
                                                </td>
                                                <td className="p-3 text-right font-mono text-[10px]">
                                                    {/* T13-6: "N/A" did not say WHY. An unconfigured
                                                        pay rate is a missing setting the owner can fix,
                                                        not an unknowable value. */}
                                                    {stat.cost !== null
                                                      ? <span className="text-red-500">£{stat.cost.toFixed(2)}</span>
                                                      : <span className="text-amber-500 text-[9px]">Pay rate not configured</span>}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                              </div>
                          </div>
                    );
                  })}
                </div>
              </div>

              {/* Monthly Planner Timeline Organizer */}
              <div className="bg-white rounded-2xl border shadow-sm p-5 space-y-6">
                <div className="flex items-center justify-between border-b pb-2">
                  <h3 className="font-display font-black uppercase tracking-wider text-xs">Monthly Dispatch Schedule</h3>
                  <span className="text-[10px] bg-[#EBDECE]/50 px-2.5 py-1 rounded-md text-[#2E2A26] font-mono">Month-In-Front Setup</span>
                </div>
                
                <div className="space-y-4">
                  {rotaModel.dates.map(dateStr => {
                    const dailyShifts = rotaModel.shiftsByDate.get(dateStr) || [];
                    const dateObj = new Date(dateStr as string);
                    const formattedDate = dateObj.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long' });
                    
                    return (
                      <div key={dateStr} className="border border-[#D2C5B4] rounded-xl overflow-hidden shadow-xs">
                        {/* Day Header */}
                        <div className="bg-[#DFD3C3]/40 px-4 py-2 border-b border-[#D2C5B4]">
                          <h4 className="font-black text-sm uppercase tracking-wide text-[#2E2A26] flex items-center gap-2">
                            <Calendar className="h-4 w-4 text-[#A46832]" />
                            {formattedDate}
                          </h4>
                        </div>
                        {/* Day Shifts Map */}
                        <div className="divide-y divide-[#EBDECE]/60">
                          {dailyShifts.map(sh => (
                            <div key={sh.id} className="p-3 md:px-5 flex flex-col md:flex-row md:items-center justify-between gap-3 text-2xs bg-white hover:bg-stone-50 transition-colors">
                              <div className="flex items-center gap-4">
                                <div className="text-center shrink-0 w-16">
                                  <span className="block font-black text-xs text-[#A46832]">{sh.startTime}</span>
                                  <span className="block font-mono text-[9px] text-zinc-400">TO {sh.endTime}</span>
                                </div>
                                
                                <div className="h-8 w-px bg-stone-200 hidden md:block"></div>
                                
                                <div className="flex items-center gap-3">
                                  <div className="h-8 w-8 rounded-full bg-[#A46832]/20 text-[#A46832] flex items-center justify-center font-bold text-xs uppercase shrink-0">
                                    {sh.employeeName.charAt(0)}
                                  </div>
                                  <div>
                                    <p className="font-extrabold text-[#2E2A26] uppercase text-xs">{sh.employeeName}</p>
                                    <p className="font-mono text-[9px] text-stone-500">{sh.storeName}</p>
                                  </div>
                                </div>
                              </div>
                              
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void deleteShiftWithFeedback(sh, `Deleted shift block allocated to "${sh.employeeName}"`);
                                }}
                                className="p-2 self-end md:self-auto border rounded-lg text-red-500 hover:bg-red-50 hover:border-red-300 transition-all cursor-pointer flex items-center gap-1 uppercase tracking-wider font-extrabold text-[9px] relative z-10"
                              >
                                <Trash className="h-3 w-3" />
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {shiftsList.length === 0 && (
                    <div className="text-center py-8 text-stone-400 font-mono text-[10px]">No shifts scheduled for the active viewport.</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ==================== TIMESHEET APPROVALS ==================== */}
          {effectiveActiveTab === 'timesheets' && (
            <TimesheetsPanel
              clockHistory={clockHistory}
              employees={employeesList}
              busy={busyAction !== null}
              onApprove={handleApproveTimesheet}
              onReject={handleRejectTimesheet}
              onApproveAll={handleApproveAllTimesheets}
            />
          )}

          {/* ==================== 10. COMPLIANCE VAULT ==================== */}
          {effectiveActiveTab === 'docs' && (
            <CompliancePanel
              documents={documents}
              currentRole={currentRole}
              openingDocumentId={docOpeningId}
              lifecycleBusy={busyAction !== null}
              deleteBusy={mutBusy}
              onOpen={openVaultDocument}
              onApprove={approveDocumentWithFeedback}
              onDelete={deleteDocumentWithFeedback}
            />
          )}

          {/* ==================== 11. PAYSLIPS LEDGER ==================== */}
          {effectiveActiveTab === 'payslips' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center flex-wrap gap-3">
                <div>
                  <h1 className="font-display font-black text-2xl">Earnings Estimates Desk</h1>
                  <p className="text-2xs text-[#2E2A26]/70">Hourly estimates are built from <b>approved</b> timesheet hours only. Salaried staff remain payroll-managed. Generate a month, review it, then e-mail each statement. <b>These are estimates only — not official payroll documents; PAYE, NI and pension are not calculated.</b></p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    aria-label="Earnings estimate month"
                    type="month"
                    value={payslipMonth}
                    onChange={(e) => setPayslipMonth(e.target.value)}
                    className="bg-white border border-[#EBDECE] rounded-full px-4 py-2 text-2xs font-mono outline-none focus:border-[#A46832]"
                  />
                  <button
                    onClick={() => { void withBusy(`payslip:generate:${payslipMonth}`, async () => {
                      const generator = String(employee?.name || '').trim();
                      if (!generator) { addToast('Your staff profile needs a real name before generating estimates.', 'error'); return; }
                      const label = payrollPeriod.label;
                      const created: Payslip[] = [];
                      let skippedExisting = 0, skippedNoHours = 0;
                      const skippedSalary: string[] = [];
                      /* SMALL-BIZ CLOSURE P0-10: employees WITHOUT a configured
                         pay rate are skipped — no estimate is invented for
                         them — and the owner is told exactly who, by name. */
                      const skippedNoRate: string[] = [];
                      payrollPeriod.rows.forEach((row) => {
                        const emp = row.employee;
                        if (row.isSalary) { skippedSalary.push(emp.name); return; }
                        if (row.hasExistingEstimate) { skippedExisting++; return; }
                        const hrs = row.approvedHours;
                        if (hrs <= 0) { skippedNoHours++; return; }
                        const rate = row.hourlyRate;
                        if (rate === null) { skippedNoRate.push(emp.name); return; }
                        const gross = parseFloat((hrs * rate).toFixed(2));
                        created.push({
                          id: 'pay_' + emp.id + '_' + payslipMonth,
                          employeeId: emp.id,
                          employeeName: emp.name,
                          email: emp.email,
                          periodKey: payslipMonth,
                          periodLabel: label,
                          hoursTotal: parseFloat(hrs.toFixed(2)),
                          hourlyRate: parseFloat(rate.toFixed(2)),
                          gross,
                          deductions: 0,
                          net: gross,
                          status: 'draft',
                          generatedAt: new Date().toISOString(),
                          generatedBy: generator
                        });
                      });
                      if (created.length === 0) {
                        addToast(
                          skippedNoRate.length
                            ? `No estimates generated — pay rate not configured for: ${skippedNoRate.join(', ')}. Set their pay in the Staff Directory first.`
                            : skippedSalary.length
                              ? `No hourly earnings estimates generated. Salaried staff (${skippedSalary.join(', ')}) are handled through payroll and are not calculated from timesheet hours.`
                            : skippedExisting && !skippedNoHours
                              ? `Earnings estimates for ${label} already exist for everyone with hours.`
                              : `No approved hours found in ${label}. Approve timesheets first (Timesheet Approvals tab).`,
                          'warning'
                        );
                        return;
                      }
                      const ok = await publishPayslips(prev => [...created, ...prev]);
                      if (!ok) return;
                      logAction('Earnings Estimates', `Generated ${created.length} earnings estimates for ${label}`);
                      addToast(`${created.length} earnings estimate${created.length > 1 ? 's' : ''} generated for ${label}${skippedNoHours ? ` (${skippedNoHours} staff had no approved hours)` : ''}${skippedNoRate.length ? `. SKIPPED (no pay rate configured): ${skippedNoRate.join(', ')}` : ''}${skippedSalary.length ? `. Salaried staff handled through payroll: ${skippedSalary.join(', ')}` : ''}. Now review and send.`, skippedNoRate.length ? 'warning' : 'success');
                    }); }}
                    disabled={busyAction !== null}
                    className="px-4 py-2 bg-[#A46832] text-white rounded-full text-2xs tracking-wider uppercase font-black cursor-pointer hover:bg-[#A5642B] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Generate {payrollPeriod.label}
                  </button>
                </div>
              </div>

              {!emailSettings.enabled && (
                <div className="p-3.5 bg-[#F7EFE6] border border-[#A46832]/40 mp-blob-b text-2xs text-[#A5642B]">
                  Earnings-estimate e-mails are turned off. Switch on <b>Enable e-mail sending</b> in <b>Company Settings → E-mail notifications</b> to send them. Issued estimates remain viewable in the staff dashboard either way.
                </div>
              )}

              {/* Preview: approved hours in the selected month */}
              <div className="bg-white mp-blob-r border border-[#EBDECE] overflow-hidden mp-shadow">
                <div className="px-4 py-3 bg-[#F7EFE6] border-b border-[#EBDECE]">
                  <h3 className="font-display font-black text-xs uppercase tracking-wide">Approved hours — {payrollPeriod.label}</h3>
                </div>
                <table className="w-full text-left text-2xs">
                  <thead className="border-b border-[#EBDECE] text-[10px] uppercase font-mono text-[#A5642B]">
                    <tr>
                      <th className="p-4">Employee</th>
                      <th className="p-4">Pay setup</th>
                      <th className="p-4">Approved hours</th>
                      <th className="p-4">Pending hours</th>
                      <th className="p-4">Estimated gross</th>
                      <th className="p-4">Breakdown</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#EBDECE]/70 text-[#2E2A26]/80 font-medium">
                    {payrollPeriod.rows.map((row) => {
                      const emp = row.employee;
                      const rate = row.hourlyRate;
                      const approvedHrs = row.approvedHours;
                      const pendingHrs = row.pendingHours;
                      const entries = row.approvedEntries;
                      const isOpen = expandedPayslipEmp === emp.id;
                      return (
                        <React.Fragment key={emp.id}>
                          <tr className="hover:bg-[#F7EFE6]/60">
                            <td className="p-4 font-bold text-[#2E2A26]">{emp.name}</td>
                            {/* SMALL-BIZ CLOSURE P0-10: the salary-equivalent
                                note keys on the EXPLICIT payType — never on
                                the size of the number — and an unconfigured
                                rate is stated, not substituted. */}
                            <td className="p-4 font-mono">{emp.payType === 'salary'
                              ? (typeof emp.payRate === 'number' && emp.payRate > 0
                                  ? <><span>£{emp.payRate.toLocaleString('en-GB')}/year</span><span className="block text-[9px] text-[#2E2A26]/45 font-normal">Handled through payroll</span></>
                                  : <span className="text-neutral-400 italic font-sans">Pay rate not configured</span>)
                              : rate === null
                                ? <span className="text-neutral-400 italic font-sans">Pay rate not configured</span>
                                : <>£{rate.toFixed(2)}/hour</>}</td>
                            <td className="p-4 font-mono font-bold">{approvedHrs.toFixed(1)} hrs</td>
                            <td className="p-4 font-mono">{pendingHrs > 0 ? <span className="text-amber-600">{pendingHrs.toFixed(1)} hrs awaiting approval</span> : '—'}</td>
                            <td className="p-4 font-mono font-bold text-[#5CA459]">{emp.payType === 'salary' ? <span className="text-neutral-400 italic font-normal font-sans">Payroll handled separately</span> : rate === null ? <span className="text-neutral-400 italic font-normal font-sans">—</span> : `£${(approvedHrs * rate).toFixed(2)}`}</td>
                            <td className="p-4">
                              <button
                                onClick={() => setExpandedPayslipEmp(isOpen ? null : emp.id)}
                                disabled={entries.length === 0}
                                className="text-[#A46832] hover:underline cursor-pointer disabled:text-[#EBDECE] disabled:no-underline disabled:cursor-default"
                              >
                                {isOpen ? 'Hide' : `View ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`}
                              </button>
                            </td>
                          </tr>
                          {isOpen && entries.length > 0 && (
                            <tr>
                              <td colSpan={6} className="bg-[#F7EFE6]/70 p-4">
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                  {entries.map(ch => (
                                    <div key={ch.id} className="bg-white border border-[#EBDECE] rounded-xl rounded-tl-sm p-2.5 text-[10px] font-mono flex justify-between">
                                      <span>{new Date(ch.date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                                      <span className="text-[#2E2A26]/45">{new Date(ch.clockIn).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}–{ch.clockOut ? new Date(ch.clockOut).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                                      <b>{(ch.totalDecimalHours || 0).toFixed(2)}h</b>
                                    </div>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Generated earnings-estimates ledger */}
              <div className="bg-white mp-blob-l border border-[#EBDECE] overflow-hidden mp-shadow">
                <div className="px-4 py-3 bg-[#F7EFE6] border-b border-[#EBDECE] flex items-center justify-between">
                  <h3 className="font-display font-black text-xs uppercase tracking-wide">Issued earnings estimates</h3>
                  <span className="text-[9px] font-mono bg-white border border-[#EBDECE] px-2 py-0.5 rounded-full text-[#2E2A26]/60">{payslips.length} total</span>
                </div>
                {payslips.length === 0 ? (
                  <p className="text-center py-8 text-[#2E2A26]/40 font-mono text-[10px]">No earnings estimates generated yet — pick a month above and press Generate.</p>
                ) : (
                  <table className="w-full text-left text-2xs">
                    <thead className="border-b border-[#EBDECE] text-[10px] uppercase font-mono text-[#A5642B]">
                      <tr>
                        <th className="p-4">Employee</th>
                        <th className="p-4">Period</th>
                        <th className="p-4">Hours</th>
                        <th className="p-4">Estimated gross</th>
                        <th className="p-4">Status</th>
                        <th className="p-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#EBDECE]/70 text-[#2E2A26]/80 font-medium">
                      {sortedPayslips.map(p => (
                        <tr key={p.id} className="hover:bg-[#F7EFE6]/60">
                          <td className="p-4 font-bold text-[#2E2A26]">{p.employeeName}<span className="block text-[9px] font-mono font-normal text-[#2E2A26]/45">{p.email}</span></td>
                          <td className="p-4">{p.periodLabel}</td>
                          <td className="p-4 font-mono">{p.hoursTotal.toFixed(1)} hrs @ £{p.hourlyRate.toFixed(2)}</td>
                          <td className="p-4 font-mono font-bold text-[#5CA459]">£{p.gross.toFixed(2)}</td>
                          <td className="p-4">
                            {p.status === 'sent'
                              ? <span className="text-[9px] font-black uppercase bg-[#5CA459]/15 text-[#4E8E4B] px-2 py-0.5 rounded-full inline-block mp-tilt-l2">Sent {p.sentAt ? new Date(p.sentAt).toLocaleDateString('en-GB') : ''}</span>
                              : <span className="text-[9px] font-black uppercase bg-[#A46832]/15 text-[#A5642B] px-2 py-0.5 rounded-full inline-block mp-tilt-r">Draft</span>}
                          </td>
                          <td className="p-4 text-right space-x-2 whitespace-nowrap">
                            <button
                              disabled={emailBusyId === p.id}
                              onClick={() => {
                                if (!emailSettings.enabled) { addToast('E-mail sending is turned off — enable it in Company Settings → E-mail notifications.', 'warning'); return; }
                                void withEmailBusy(p.id, async () => {
                                  const err = await sendTemplateEmail({
                                    ...emailPayloads.payslip(p, siteSettings.currencySymbol || '£'),
                                    fromName: emailSettings.fromName,
                                    brand: siteSettings.brandName || 'Milk Pop',
                                  });
                                  if (err) {
                                    addToast('Earnings-estimate e-mail failed: ' + err, 'error');
                                    return;
                                  }
                                  const recorded = await publishPayslips(prev => prev.map(x => x.id === p.id ? { ...x, status: 'sent', sentAt: new Date().toISOString() } : x));
                                  if (!recorded) {
                                    addToast('The e-mail was sent, but its sent status was not recorded. Verify with the employee before sending it again.', 'warning');
                                    return;
                                  }
                                  logAction('Earnings Estimates', `Emailed ${p.periodLabel} earnings estimate to ${p.employeeName} (${p.email})`);
                                  addToast(`Earnings estimate e-mailed to ${p.employeeName}.`, 'success');
                                });
                              }}
                              className="text-[#A46832] hover:underline cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
                            >
                              <Send className="h-3 w-3" />{emailBusyId === p.id ? 'Sending…' : p.status === 'sent' ? 'Re-send' : 'Send e-mail'}
                            </button>
                            <span className="text-[#EBDECE]">|</span>
                            <button
                              onClick={() => { void withBusy(`payslip:delete:${p.id}`, async () => {
                                if (!window.confirm(`Delete the ${p.periodLabel} earnings estimate for ${p.employeeName}? Official payroll documents from your provider are unaffected.`)) return;
                                const ok = await publishPayslips(prev => prev.filter(x => x.id !== p.id));
                                if (!ok) return;
                                logAction('Earnings Estimates', `Deleted ${p.periodLabel} earnings estimate for ${p.employeeName}`);
                                addToast('Earnings estimate deleted.', 'warning');
                              }); }}
                              disabled={busyAction !== null}
                              className="text-red-500 hover:underline cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {/* ==================== LEGACY DATA IMPORT (owner, temporary) ==================== */}
          {effectiveActiveTab === 'legacy-import' && employee?.role === 'owner' && (
            <LegacyImport stores={stores} addToast={addToast} logAction={(m, a) => logAction(m, a)} />
          )}

          {/* ==================== 12. ACADEMY STUDIO ==================== */}
          {effectiveActiveTab === 'training' && (
            <AcademyStudio
              employee={employee}
              assessments={assessments}
              publishAssessments={publishAssessments}
              employeesList={employeesList}
              assignments={trainingAssignments}
              publishAssignments={publishTrainingAssignments}
              certificates={trainingCertificates}
              addToast={addToast}
              logAction={logAction}
            />
          )}

          {/* ==================== 13. SIFR INCIDENT REVIEW DESK ==================== */}
          {effectiveActiveTab === 'sifr' && (
            <SifrPanel
              reports={sifrReports}
              busy={busyAction !== null}
              onResolve={resolveSifrWithFeedback}
            />
          )}

          {/* ==================== 14. RECOGNITION BOARD ==================== */}
          {effectiveActiveTab === 'recognition' && (
            <RecognitionPanel
              employees={employeesList}
              onUpdateEmployee={onUpdateEmployee}
              addToast={addToast}
              logAction={logAction}
            />
          )}

          {/* Staff Reviews are post-launch: no route and no hidden launch panel. */}

          {/* ==================== 16. CAREERS PIPELINE ==================== */}
          {effectiveActiveTab === 'careers' && (
            <CareersPanel
              isOwner={currentRole === 'owner'}
              canPublishVacancies={canPublishTable('job_vacancies')}
              inboxStatus={inboxStatus}
              onRefreshInbox={onRefreshInbox}
              vacancies={vacancies}
              applications={applications}
              busyAction={busyAction}
              cvLoadingId={cvLoadingId}
              onCreateVacancy={openCreateVacancy}
              onEditVacancy={openEditVacancy}
              onTogglePublication={publishOne}
              onCloseVacancy={closeVacancyWithFeedback}
              onDeleteVacancy={deleteVacancyWithFeedback}
              onViewCv={handleViewCv}
              onTransitionApplication={transitionApplicationWithFeedback}
            />
          )}

          {/* ==================== 17. FRANCHISE LEADS CRM ==================== */}
          {effectiveActiveTab === 'franchise' && (
            <FranchisePanel
              inquiries={franchiseInquiries}
              inboxStatus={inboxStatus}
              busy={busyAction !== null}
              onRefreshInbox={onRefreshInbox}
              onStatusChange={updateFranchiseStatusWithFeedback}
            />
          )}

          {/* ==================== 18. CUSTOMER MAILBOX ==================== */}
          {effectiveActiveTab === 'contact' && (
            <ContactInboxPanel
              messages={contactMessages}
              inboxStatus={inboxStatus}
              emailEnabled={emailSettings.enabled}
              busy={busyAction !== null}
              onRefreshInbox={onRefreshInbox}
              onComposeReply={setContactReplyTarget}
              onStatusChange={updateContactStatusWithFeedback}
              addToast={addToast}
            />
          )}

          {/* ==================== 19. KNOWLEDGE BASE / SOPs ==================== */}
          {effectiveActiveTab === 'kb' && (
            <KnowledgeBasePanel
              articles={articles}
              operatorName={employee?.name || ''}
              staffDataStatus={staffDataStatus}
              publishArticles={publishArticles}
              addToast={addToast}
              logAction={logAction}
            />
          )}

          {/* ==================== 20. NEWS ANNOUNCEMENTS PRESSROOM ==================== */}
          {effectiveActiveTab === 'news' && (
            <NewsPanel
              posts={newsPosts}
              staffDataStatus={staffDataStatus}
              canPublish={canPublishTable('news_posts')}
              publicationBusyAction={busyAction}
              publishPosts={publishNewsPosts}
              onTogglePublication={publishOne}
              addToast={addToast}
              logAction={logAction}
            />
          )}

          {/* ==================== 21. PERMISSIONS MATRIX ==================== */}
          {effectiveActiveTab === 'permissions' && <PermissionsPanel />}

          {/* ==================== 22. COMPANY SYSTEM SETTINGS ==================== */}
          {/* ==================== SALES & ORDERS LEDGER ==================== */}


          {/* ==================== DEALS & COMBOS EDITOR ==================== */}
          {effectiveActiveTab === 'deals' && (
            <DealsPanel
              deals={deals}
              currencySymbol={cur}
              canPublish={canPublishTable('deals')}
              publicationBusyAction={busyAction}
              onTogglePublication={publishOne}
              publishDeals={publishDeals}
              addToast={addToast}
              logAction={logAction}
            />
          )}

          {/* ==================== STAFF CHECKLIST TEMPLATES EDITOR ==================== */}
          {effectiveActiveTab === 'checklists' && (
            <ChecklistsPanel
              templates={checklistTemplates}
              publishTemplates={publishChecklistTemplates}
              addToast={addToast}
              logAction={logAction}
            />
          )}

          {effectiveActiveTab === 'settings' && (
            <div className="space-y-6">
              <div>
                <h1 className="font-display font-black text-2xl">Company Settings</h1>
                <p className="text-2xs text-[#2E2A26]/70">Legal identity, public contact facts, website display defaults, e-mail delivery and cloud settings. Website wording, imagery, the announcement bar and social links live in Website Studio.</p>
              </div>

              {/* R4.8 (Workstream F2): owner launch-readiness derived from
                  launch_readiness() — every failed item links to its fix. */}
              <LaunchReadinessPanel refreshToken={launchFactsRefreshToken} />
              <LaunchFactsPanel
                operatorName={employee?.name || ''}
                onSaved={() => {
                  setLaunchFactsRefreshToken((value) => value + 1);
                  onRefreshPublicContent();
                }}
              />

              {/* Signpost: visitor-facing settings moved to the Studio */}
              <button
                onClick={() => setActiveTab('cms')}
                className="w-full text-left p-4 rounded-2xl border-2 border-dashed border-[#7CC0C7] bg-[#7CC0C7]/10 hover:bg-[#7CC0C7]/20 transition-colors cursor-pointer flex items-center gap-3"
              >
                <Globe className="h-5 w-5 text-[#2E7A82] shrink-0" />
                <span className="text-2xs text-[#2E2A26]">
                  <b className="font-black uppercase tracking-wider text-[10px] block text-[#2E7A82]">Editing the website?</b>
                  The announcement ribbon, footer tagline, allergen notice, images and social links are managed in <b>Website Studio</b>. Legal name, company number, address, phone and public e-mails are managed in <b>Launch Facts</b> above.
                </span>
                <ArrowRight className="h-4 w-4 text-[#2E7A82] ml-auto shrink-0" />
              </button>

              {/* ---------- Brand & store defaults ---------- */}
              <div className="bg-white rounded-2xl border border-[#EBDECE] p-6 space-y-4 shadow-2xs font-sans text-2xs text-[#2E2A26]">
                <h3 className="font-display font-black text-xs uppercase tracking-wide border-b border-[#EBDECE] pb-2">Brand & store defaults</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1"><label htmlFor="settings-brand-name" className="font-bold block">Brand name</label>
                    <input id="settings-brand-name" value={settingsDraft.brandName} onChange={e => setSettingsDraft(s => ({ ...s, brandName: e.target.value }))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none focus:border-[#A46832]" /></div>
                  <div className="md:col-span-1 rounded-xl border border-[#EBDECE] bg-[#FBF7F1] p-3 text-[10px] text-[#2E2A26]/70">
                    <span className="font-black uppercase tracking-wider text-[#A46832]">Legal and contact facts</span>
                    <p className="mt-1">Managed in Launch Facts above so the footer, Contact page, privacy pages and receipts always use the same verified values.</p>
                  </div>
                  <div className="space-y-1"><label htmlFor="settings-default-hours" className="font-bold block">Default opening hours (new stores)</label>
                    <input id="settings-default-hours" value={settingsDraft.defaultOpeningHours} onChange={e => setSettingsDraft(s => ({ ...s, defaultOpeningHours: e.target.value }))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none" /></div>
                </div>
              </div>

              {/* ---------- Website display defaults ---------- */}
              <div className="bg-white rounded-2xl border border-[#EBDECE] p-6 space-y-4 shadow-2xs font-sans text-2xs text-[#2E2A26]">
                <h3 className="font-display font-black text-xs uppercase tracking-wide border-b border-[#EBDECE] pb-2 flex items-center gap-2"><Globe className="h-3.5 w-3.5 text-[#A46832]" /> Website display defaults</h3>
                <div className="max-w-sm space-y-1">
                  <label htmlFor="settings-currency-symbol" className="font-bold block">Currency symbol shown on the website</label>
                  <input id="settings-currency-symbol" value={settingsDraft.currencySymbol} onChange={e => setSettingsDraft(s => ({ ...s, currencySymbol: e.target.value }))} className="w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl outline-none font-mono" placeholder="£" />
                  <p className="text-[10px] text-[#2E2A26]/60">Used for menu prices and other customer-facing amounts.</p>
                </div>
                <div className="pt-4 border-t border-[#EBDECE] flex justify-end">
                  {/* NOTE: only the company-owned keys are merged back, so an
                      edit published from the Website Studio (announcement,
                      footer, contacts…) in the same session is never
                      overwritten by this stale draft. */}
                  <button disabled={mutBusy} onClick={() => {
                    void withMutationBusy(async () => {
                    const currencySymbol = normalizeCurrencySymbol(settingsDraft.currencySymbol);
                    if (!currencySymbol) {
                      addToast('Enter a currency symbol or short code of up to 4 characters, for example £, € or GBP.', 'error');
                      return;
                    }
                    const ok = await saveSiteSettings(prev => ({
                      ...prev,
                      brandName: settingsDraft.brandName,
                      defaultOpeningHours: settingsDraft.defaultOpeningHours,
                      currencySymbol,
                    }));
                    if (!ok) return;
                    logAction('Company Settings', 'Updated website display defaults');
                    addToast('Website display defaults saved.', 'success');
                    });
                  }} className="px-5 py-2.5 bg-[#A46832] hover:bg-[#A5642B] disabled:opacity-50 disabled:cursor-not-allowed uppercase font-black tracking-wider text-2xs text-white rounded-full cursor-pointer">Save website defaults</button>
                </div>
              </div>

              {/* ---------- E-mail notifications ---------- */}
              <div className="bg-white mp-blob-r border border-[#EBDECE] p-6 space-y-4 mp-shadow font-sans text-2xs text-[#2E2A26]">
                <h3 className="font-display font-black text-xs uppercase tracking-wide border-b border-[#EBDECE] pb-2 flex items-center gap-2"><Mail className="h-3.5 w-3.5 text-[#A46832]" /> E-mail notifications (earnings estimates, new shifts, candidates)</h3>
                <div className="p-3 bg-[#7CC0C7]/10 border border-[#7CC0C7]/40 rounded-xl space-y-1">
                  <p className="font-extrabold text-[#2E7A82] uppercase tracking-wider text-[10px]">E-mail delivery configuration</p>
                  <p className="text-[#2E2A26]/70 leading-relaxed">
                    Messages are sent through the server-side <span className="font-mono">send-email</span> function and fixed templates. Delivery works only after the provider, verified sender and function secrets have been commissioned. Confirm the live status in Today → System status → Operational Health and complete a real delivery test before launch.
                  </p>
                </div>
                <p className="text-[#2E2A26]/70 leading-relaxed">
                  The toggle controls whether the app requests notification e-mails. It does not prove that the external provider is configured or delivering.
                </p>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={emailDraft.enabled} onChange={e => setEmailDraft(s => ({ ...s, enabled: e.target.checked }))} className="h-4 w-4 rounded border-neutral-300" />
                  <span className="font-bold">Enable e-mail sending</span>
                </label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-1"><label htmlFor="email-sender-name" className="font-bold block">Sender name</label>
                    <input id="email-sender-name" value={emailDraft.fromName} onChange={e => setEmailDraft(s => ({ ...s, fromName: e.target.value }))} className="w-full bg-[#F7EFE6]/70 border border-[#EBDECE] p-2.5 rounded-xl rounded-tl-sm outline-none focus:border-[#A46832] focus:bg-white" placeholder="Milk Pop" /></div>
                  <label className="flex items-end gap-2 cursor-pointer select-none pb-2.5">
                    <input type="checkbox" checked={emailDraft.notifyNewShift} onChange={e => setEmailDraft(s => ({ ...s, notifyNewShift: e.target.checked }))} className="h-4 w-4 rounded border-neutral-300" />
                    <span className="font-bold">"New shift scheduled" e-mails</span>
                  </label>
                  <label className="flex items-end gap-2 cursor-pointer select-none pb-2.5">
                    <input type="checkbox" checked={emailDraft.notifyPayslip} onChange={e => setEmailDraft(s => ({ ...s, notifyPayslip: e.target.checked }))} className="h-4 w-4 rounded border-neutral-300" />
                    <span className="font-bold">Earnings-estimate e-mails</span>
                  </label>
                </div>
                <div className="pt-2 flex justify-end">
                  <button
                    disabled={!emailDraftDirty || mutBusy}
                    onClick={() => {
                      void withMutationBusy(async () => {
                        const ok = await saveEmailSettings(emailDraft);
                        if (!ok) return;
                        logAction('Company Settings', 'Updated e-mail notification preferences');
                        addToast('E-mail preferences saved.', 'success');
                      });
                    }}
                    className="px-5 py-2.5 bg-[#A46832] hover:bg-[#A5642B] disabled:opacity-40 disabled:cursor-not-allowed uppercase font-black tracking-wider text-2xs text-white rounded-full cursor-pointer"
                  >
                    Save e-mail preferences
                  </button>
                </div>
                <div className="pt-2 border-t border-[#EBDECE] flex items-center gap-3 flex-wrap">
                  <button
                    disabled={emailBusyId === '__test__' || emailDraftDirty}
                    onClick={() => {
                      void withEmailBusy('__test__', async () => {
                        const err = await sendTemplateEmail({
                          ...emailPayloads.test(),
                          fromName: emailSettings.fromName,
                          brand: siteSettings.brandName || 'Milk Pop',
                        });
                        if (err) addToast('Test e-mail failed: ' + err, 'error');
                        else { logAction('Company Settings', `Sent test e-mail to own address (${employee?.email || 'signed-in staff'})`); addToast('Test e-mail sent to your own address — check the inbox (and spam folder).', 'success'); }
                      });
                    }}
                    className="px-4 py-2.5 bg-[#2E2A26] hover:bg-[#A46832] text-white rounded-full uppercase font-black tracking-wider cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
                  >
                    <Send className="h-3.5 w-3.5" /> {emailBusyId === '__test__' ? 'Sending…' : 'Send test e-mail'}
                  </button>
                  <span className="text-xs text-[#2E2A26]/65" role="status" aria-live="polite">
                    {emailDraftDirty
                      ? 'Unsaved changes — save your preferences before sending a test.'
                      : 'Saved preferences are active. A test uses the currently saved sender settings.'}
                  </span>
                </div>
              </div>

              {/* ---------- Cloud database (Supabase) — read-only status ---------- */}
              {/* SECURITY (Phase 1 review): production database configuration is
                  loaded ONLY from build-time environment variables. The old
                  browser form that let anyone type a Project URL + key into
                  localStorage is removed — a localStorage value can no longer
                  point the app at a backend in production. */}
              <div className="bg-white rounded-2xl border border-[#7CC0C7] p-6 space-y-3 shadow-2xs font-sans text-2xs text-[#2E2A26]">
                <h3 className="font-display font-black text-xs uppercase tracking-wide border-b border-[#EBDECE] pb-2 flex items-center gap-2"><Database className="h-3.5 w-3.5 text-[#7CC0C7]" /> Cloud database (Supabase)</h3>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${cloudStatus.health === 'healthy' ? 'bg-emerald-500' : cloudStatus.health === 'degraded' ? 'bg-amber-500' : 'bg-red-400'}`} />
                  <span className="text-[11px] font-bold">
                    {!cloudStatus.configured
                      ? 'Not configured — customer content is unavailable unless a verified build snapshot exists'
                      : cloudStatus.health === 'healthy'
                        ? 'Healthy — all public collections refreshed'
                        : cloudStatus.health === 'degraded'
                          ? `Degraded — ${cloudStatus.failedCollections?.length || 1} collection(s) failed; last verified content is retained`
                          : 'Offline — live public data could not be refreshed'}
                  </span>
                </div>
                {cloudStatus.health !== 'healthy' && cloudStatus.configured && (
                  <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <p>Technical details are kept in protected operational logs. Retry the data refresh, or review the existing system-status panels on the dashboard.</p>
                    <button type="button" onClick={openSystemStatus} className="min-h-11 px-4 rounded-full bg-amber-900 text-white text-xs font-black uppercase tracking-wider cursor-pointer whitespace-nowrap">
                      Open system status
                    </button>
                  </div>
                )}
                <p className="text-[#2E2A26]/70 leading-relaxed">
                  Set <span className="font-mono">VITE_SUPABASE_URL</span> and <span className="font-mono">VITE_SUPABASE_ANON_KEY</span> (anon key only — never a service-role key) in the deployment environment, then rebuild. As an anonymous client the app reads public website content and accepts public form submissions; staff, payroll, orders and other private data require a signed-in staff session (see <span className="font-mono">OWNERS-GUIDE.md</span> for setup).
                </p>
              </div>
            </div>
          )}

          {/* ==================== 23. LIVE AUDIT REGISTRATION TIMELINE ==================== */}
          {effectiveActiveTab === 'audit' && (
            <AuditPanel auditLogs={auditLogs} currentRole={currentRole} addToast={addToast} />
          )}

      </AdminShell>

      <BusinessActionDialog
        open={!!holidayDialogTarget}
        title="Set holiday allowance"
        description={holidayDialogTarget ? `Enter the pro-rated contractual annual allowance for ${holidayDialogTarget.name}.` : undefined}
        submitLabel="Save allowance"
        busy={businessDialogBusy}
        onClose={() => { if (!businessDialogBusy) setHolidayDialogTarget(null); }}
        fields={[{
          name: 'allowance', label: 'Annual holiday allowance (days)', type: 'number', required: true,
          value: String(holidayDialogTarget?.holidayBalance ?? ''), min: 0, max: 366, step: 0.5,
          help: 'Use the employee’s actual pro-rated contractual entitlement.',
        }]}
        onSubmit={async (values) => {
          if (!holidayDialogTarget) return;
          const allowance = Number(values.allowance);
          if (!Number.isFinite(allowance) || allowance < 0 || allowance > 366) {
            addToast('Enter a valid annual holiday allowance between 0 and 366 days.', 'error');
            return;
          }
          await withBusinessDialogBusy(async () => {
            const updated = await onSetHolidayAllowance(holidayDialogTarget.id, holidayDialogTarget.holidayBalance ?? 0, allowance);
            if (!updated) return;
            setSelectedStaffUser(updated);
            setHolidayDialogTarget(null);
            addToast('Holiday allowance updated and audited.', 'success');
          });
        }}
      />

      <BusinessActionDialog
        open={!!contactReplyTarget}
        title={contactReplyTarget ? `Reply to ${contactReplyTarget.fullName}` : 'Reply to customer'}
        description={contactReplyTarget ? `${contactReplyTarget.email} · ${contactReplyTarget.reason}` : undefined}
        submitLabel="Send reply"
        busy={businessDialogBusy}
        onClose={() => { if (!businessDialogBusy) setContactReplyTarget(null); }}
        fields={[{
          name: 'body', label: 'Message', type: 'textarea', required: true, rows: 9,
          value: contactReplyTarget ? `Hi ${contactReplyTarget.fullName.split(' ')[0]},

Thanks for getting in touch about “${contactReplyTarget.reason}”.

` : '',
          help: `The ${siteSettings.brandName || 'Milk Pop'} signature is added by the e-mail service.`,
        }]}
        onSubmit={async (values) => {
          const body = values.body?.trim() ?? '';
          if (!contactReplyTarget || !body) return;
          await withBusinessDialogBusy(async () => {
            const err = await sendTemplateEmail({
              ...emailPayloads.contactReply(contactReplyTarget, body),
              fromName: emailSettings.fromName,
              brand: siteSettings.brandName || 'Milk Pop',
            });
            if (err) {
              addToast('Reply failed to send: ' + err, 'error');
              return;
            }
            const statusSaved = await onUpdateContactStatus(contactReplyTarget.id, 'replied');
            logAction('Contact Inbox', `Replied to ${contactReplyTarget.fullName} (${contactReplyTarget.email})`);
            addToast(statusSaved ? `Reply e-mailed to ${contactReplyTarget.fullName}.` : 'Reply was sent, but its inbox status could not be saved.', statusSaved ? 'success' : 'warning');
            setContactReplyTarget(null);
          });
        }}
      />
    </>
  );
};
