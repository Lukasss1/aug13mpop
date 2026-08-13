/**
 * @file App.tsx
 * @description Main entry point for the Milk Pop React Application.
 * 
 * ARCHITECTURE & STATE MANAGEMENT:
 * This application is structured as a monolithic Single Page Application (SPA).
 * It uses a top-down state pattern where `App.tsx` serves as the central data store.
 * 
 * 1. PERSISTENCE (Phase A): Supabase is the single system of record. Internal
 *    registries are plain React state hydrated from the database after sign-in
 *    and mutated ONLY through the typed, per-domain, authenticated,
 *    server-confirmed operations in src/lib/registries.ts. localStorage holds
 *    nothing operational any more (only the opaque auth token and any legacy
 *    bytes kept read-only for the owner's one-time import tool).
 * 
 * 2. ROUTING: We use a simple `currentTab` text state instead of React Router to quickly 
 *    toggle components like `AdminPanel`, `StaffPortal`, and `PublicPages`.
 *    If scaling to a real production site, replacing `currentTab` with `react-router-dom` 
 *    is highly recommended.
 * 
 * 3. PROP DRILLING: Because state lives here, we pass it down extensively via props.
 *    In future iterations, consider replacing this with a Server State manager like React Query
 *    alongside a real database, or a client state manager like Zustand.
 */
import React, { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense } from 'react';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import {
  RouteParams, NavigateFn, NavigateOptions, readInitialRoute, pathToRoute, routeToPath,
  canonicalPathFor, isIndexableTab, applyHeadMeta, matchBySlug,
  storeSlug, vacancySlug, postSlug,
} from './lib/router';
import { CheckCircle, AlertCircle, Info } from 'lucide-react';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import { PublicPages } from './components/PublicPages';

/* PERFORMANCE: the Staff Portal and Admin Panel together are well over half of
   the JavaScript in this app, yet a customer browsing the menu never opens
   either. React.lazy splits them into their own chunks that only download the
   first time a signed-in staff member navigates there — the public storefront
   loads noticeably faster. */
const StaffPortal = lazy(() => import('./components/StaffPortal').then(m => ({ default: m.StaffPortal })));
const AdminPanel = lazy(() => import('./components/AdminPanel').then(m => ({ default: m.AdminPanel })));
import {
  EmployeeProfile,
  JobApplication,
  FranchiseInquiry,
  ContactMessage,
  TrainingCourse,
  TrainingAssessment,
  SIFRReport,
  StaffDocument,
  WorkShift,
  MenuItem,
  StoreLocation,
  CareerVacancy,
  KnowledgeArticle,
  NewsPost,
  AuditLogItem,
  MediaItem,
  CmsPageContent,
  RolePermissionMatrix,
  Deal,
  SiteSettings,
  ChecklistTemplateItem,
  CloudStatus,
  ClockHistoryItem,
  ClockStatus,
  Payslip,
  EmailSettings,
  TrainingAssignment,
  TrainingCertificate,
  TrainingProgressRecord,
  CreateSIFRReportInput,
  TaxCode,
} from './types';
import { useAuth } from './hooks/useAuth';
import { DEFAULT_EMAIL_SETTINGS } from './lib/notify';
import {
  INITIAL_COURSES,
  INITIAL_JOBS,
  INITIAL_MENU_ITEMS,
  INITIAL_STORES,
  INITIAL_ARTICLES,
  INITIAL_SETTINGS,
  INITIAL_CHECKLIST_TEMPLATES
} from './data';
import { isCloudConfigured, submitJobApplication, submitFranchiseInquiry, submitContactMessage, toRow, fromRow, fetchInboxAuthed, fetchApplicationsAuthed, updateInboxStatusAuthed } from './lib/supabase';
import type { PrivacyNoticeCurrent, SubmissionResult, PublicCollection, PublishableContentTable } from './types';
import { pullAllFromCloud, onCloudStatus } from './lib/cloudSync';
import { loadBuildPublicContent, validateSiteSettings } from './lib/publicDataValidation';
import { projectPublicMenuItems, projectPublicStores, projectPublicVacancies, projectPublicNews, projectPublicDeals } from './lib/publicProjection';
import type { ChecklistAuditLog, StoreChecklistState } from './lib/checklistState';
import type { ShiftCoverBoard } from './lib/storeState';
/* PHASE A — the browser is no longer the system of record. Every internal
   module writes through these typed, per-domain, authenticated, SERVER-
   CONFIRMED operations (src/lib/registries.ts). */
import {
  employeesRepo, shiftsRepo, clockRepo, documentsRepo,
  createSifrReport, appendSifrReply, setSifrStatus,
  trainingAssignmentsRepo, auditLogsRepo,
  saveWebsiteStudio, appStateKv,
  trainingProgressRepo, certificatesRepo as certsRepoDirect, callRpc, replaceCollection, applyCollectionChanges, decideTimesheets as decideTimesheetsRpc,
  hydrateStaffData, registryErrorMessage, RegistryError, collectionTable,
  transitionApplication, authedRest,
  type StaffDataStatus,
} from './lib/registries';
import { registerSessionCleanup, unregisterSessionCleanup, runSessionCleanup } from './lib/sessionCleanup';
import { getAccessToken } from './lib/auth';
import { decodeSub } from './lib/authStorage';
import { requestSeoRebuild as clientRequestSeoRebuild, afterPublishRebuild, clientDeploymentMode } from './lib/seoRebuild';
import type { SeoRebuildArea, SeoRebuildResult, SeoRebuildStatus } from './lib/seoRebuild';
import { uploadStaffDocument, deleteStaffDocument } from './lib/staffDocs';
import { staffInvite, type StaffInviteAction } from './lib/staffInvite';
import { MASCOT } from './brand';
import { INITIAL_ASSESSMENTS } from './trainingData';
import { SiteContent, hydrateSiteContent, PUBLIC_PAGE_KEYS, PublicPageKey } from './siteContent';
import {
  INITIAL_PRIVACY_NOTICES,
  INITIAL_CMS_PAGES,
  INITIAL_MEDIA_LIBRARY,
  INITIAL_ROLE_PERMISSIONS
} from './defaultState';

const DEV_PRIVATE_SEED_CONTENT =
  import.meta.env.DEV && import.meta.env.VITE_DEV_SEED_CONTENT === 'true';

// PHASE A: the one-time "Merry Hill" -> "Solihull" localStorage rename is no
// longer needed at boot — live state hydrates from the database. The legacy
// bytes are only ever read again by the owner's import tool, which normalises
// store names itself during preview.

/** Branded fallback shown for the moment a lazy portal chunk downloads. */
const PortalLoading: React.FC<{ label: string }> = ({ label }) => (
  <div className="min-h-[50vh] flex flex-col items-center justify-center gap-4 py-24">
    <img src={MASCOT.wave} alt="" aria-hidden="true" width={800} height={800} decoding="async" className="w-24 h-auto mp-bob select-none" draggable={false} />
    <p className="text-2xs font-black uppercase tracking-widest text-[#A5642B]">{label}</p>
  </div>
);

/** Optional marketing sections fail closed, but only after the verified
 * public configuration has resolved. Treating the safe boot defaults as the
 * final answer would flash a false 404 on a genuinely published direct URL. */
function optionalSectionRequested(tab: string): boolean {
  return tab === 'careers' || tab === 'franchise' || tab === 'fdd' || tab === 'news';
}

function optionalSectionPublished(tab: string, settings: SiteSettings): boolean {
  if (tab === 'careers') return settings.showCareers;
  if (tab === 'franchise' || tab === 'fdd') return settings.showFranchise;
  if (tab === 'news') return settings.showNews;
  return true;
}

interface ToastAlert {
  id: string;
  message: string;
  type: 'success' | 'warning' | 'error' | 'info';
}

/* ------------------------------------------------------------------ *
 * OPT-02 Check 4 (Stage C): typed shapes for the authenticated data
 * boundaries this component reads. Rows are still coerced field-by-field
 * below (String()/Number()/?? fallbacks); these interfaces replace the `any`
 * at the fetch/RPC seam so a downstream mapping mistake fails at compile time,
 * without asserting the server response is trusted.
 * ------------------------------------------------------------------ */
interface JobApplicationRow {
  id: string; fullName: string; email: string;
  phone?: string; appliedFor?: string; appliedStore?: string;
  availability?: string; experience?: string; cvPresent?: boolean; message?: string;
  status?: JobApplication['status']; appliedAt?: string; createdAt?: string;
}
interface ContactMessageRow {
  id: string; fullName: string; email: string;
  reason?: string; message?: string; status?: ContactMessage['status'];
  submittedAt?: string; repliedAt?: string; closedAt?: string; createdAt?: string;
}
interface FranchiseInquiryRow {
  id: string; fullName: string; email: string;
  phone?: string; country?: string; city?: string; budget?: string; experience?: string; message?: string;
  status?: FranchiseInquiry['status']; submittedAt?: string; createdAt?: string;
}
interface CompleteTrainingResult {
  passed?: boolean; score?: number; newCertificate?: boolean;
  courseId?: string | number; pointsAwarded?: number | string; badgeAwarded?: string | null;
  profilePoints?: number; profileLevel?: number; profileBadges?: unknown;
  certificate?: Record<string, unknown> | null;
}
interface ClaimShiftRow {
  id?: string | null; employee_id?: string | null; employee_name?: string | null;
  role: WorkShift['role']; store_id?: string | null; store_name?: string | null;
  date?: string | null; start_time?: string | null; end_time?: string | null;
  type: WorkShift['type']; notes?: string | null;
}
interface ClaimShiftResult {
  newShift?: ClaimShiftRow | null; removedShiftId?: string | null; covers?: unknown;
}

/* R4.10 Increment 6 — ONE STATE PER PUBLIC COLLECTION.
   This was a single flag derived from "did every public key arrive". One failing
   fetch therefore marked the WHOLE public site unavailable: a careers outage hid
   the menu, and a visitor who came to read the menu was told the site had no
   content. Each collection now carries its own state, so an outage is scoped to
   the surface that actually failed.
   Declared at MODULE scope so the effect that reads it has a stable identity. */
type PublicCollectionName = 'menu' | 'deals' | 'stores' | 'news' | 'vacancies';
type PublicStatus = 'loading' | 'ready' | 'unavailable';
const PUBLIC_COLLECTION_KEYS: Record<PublicCollectionName, string> = {
  menu: 'milkpop_menu_items',
  deals: 'milkpop_deals',
  stores: 'milkpop_stores_list',
  news: 'milkpop_news_posts',
  vacancies: 'milkpop_vacancies_list',
};
const allPublicStates = (status: PublicStatus): Record<PublicCollectionName, PublicStatus> => ({
  menu: status, deals: status, stores: status, news: status, vacancies: status,
});

export default function App() {
  /* ------------------------------------------------------------------
   * NAVIGATION — URL-bound router state (src/lib/router.ts)
   *
   * `currentTab` still drives every render decision exactly as before,
   * but it is now initialised FROM the URL and every navigation writes
   * BACK to the URL via the History API. `setCurrentTab` below is the
   * navigate function — it keeps the legacy `(tab) => void` signature,
   * so Navbar / Footer / StaffPortal / AdminPanel call sites are
   * unchanged, while richer callers can pass route params (store, job,
   * post, admin section, menu filters) and options ({ replace }).
   * ------------------------------------------------------------------ */
  const initialRoute = useRef(readInitialRoute());
  const [currentTab, setCurrentTabState] = useState<string>(initialRoute.current.tab);
  const [routeParams, setRouteParams] = useState<RouteParams>(initialRoute.current.params);
  const [isStaffMode, setIsStaffMode] = useState<boolean>(false);

  const setCurrentTab = useCallback<NavigateFn>((tab: string, params: RouteParams = {}, opts: NavigateOptions = {}) => {
    if (typeof window !== 'undefined') {
      const nextPath = routeToPath(tab, params);
      const currentPath = window.location.pathname + window.location.search;
      if (currentPath !== nextPath) {
        if (opts.replace) window.history.replaceState({ tab, params }, '', nextPath);
        else window.history.pushState({ tab, params }, '', nextPath);
      }
      if (!opts.replace && !opts.keepScroll) window.scrollTo(0, 0);
    }
    setCurrentTabState(tab);
    setRouteParams(params);
  }, []);

  // Back / forward buttons: re-parse the URL into tab + params.
  useEffect(() => {
    const onPopState = () => {
      const route = pathToRoute(window.location.pathname, window.location.search);
      setCurrentTabState(route.tab);
      setRouteParams(route.params);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Canonicalise the entry URL once on boot (unknown paths -> '/', trailing
  // slashes and legacy aliases -> their canonical form). replaceState only —
  // the visitor's history is untouched.
  useEffect(() => {
    // R4.7: never canonicalise a not-found entry. Rewriting the address bar to
    // '/' was half of the old soft-404 behaviour — the visitor lost the only
    // evidence of which link was broken, and the page then claimed to be the
    // homepage. The wrong URL stays visible so it can be read and corrected.
    if (initialRoute.current.tab === 'not_found') return;
    const canonical = routeToPath(initialRoute.current.tab, initialRoute.current.params);
    const actual = window.location.pathname + window.location.search;
    if (actual !== canonical) window.history.replaceState(window.history.state, '', canonical);
  }, []);

  // Authenticated staff state — owned by the Supabase Auth lifecycle hook.
  // SECURITY: `employee` is derived from a verified session + a DB profile
  // read, never from localStorage. `setEmployee` only mutates the in-memory
  // copy (e.g. training-points updates); it cannot grant a session.
  const { employee, loading: authLoading, configured: authConfigured, mfaPending, signIn, submitMfaCode, completeMfaEnrolment, cancelMfa, signOut, setEmployee } = useAuth();
  const employeeScopeKey = employee
    ? `${employee.id}|${employee.role}|${employee.storeId ?? ''}`
    : null;
  // StaffPortal owns sensitive per-identity drafts (MFA enrolment, document
  // selection, Academy answers, incident forms). Remount it whenever the
  // authenticated identity or MFA ceremony changes so User A's local state
  // cannot survive into User B's session after a cross-tab account switch.
  const staffPortalScopeKey = employeeScopeKey
    ? `employee:${employeeScopeKey}`
    : mfaPending
      ? `mfa:${mfaPending.kind}:${decodeSub(mfaPending.session.accessToken) ?? 'unknown'}:${mfaPending.session.expiresAt}`
      : 'staff-guest';

  // PHASE A — shared internal registries are IN-MEMORY React state hydrated
  // from Supabase after sign-in (see the hydration effect below). localStorage
  // is no longer read or written for any of these: a cleared cache cannot
  // delete operational records, and another authorised device sees the same
  // rows because Supabase is the single system of record.
  const [courses, setCourses] = useState<TrainingCourse[]>(() => DEV_PRIVATE_SEED_CONTENT ? INITIAL_COURSES : []);
  const [assessments, setAssessments] = useState<TrainingAssessment[]>(() => DEV_PRIVATE_SEED_CONTENT ? INITIAL_ASSESSMENTS : []);
  const [trainingAssignments, setTrainingAssignments] = useState<TrainingAssignment[]>([]);
  const [trainingCertificates, setTrainingCertificates] = useState<TrainingCertificate[]>([]);
  // STAGE 4: per-employee course progress — the global column on the course
  // definition is dead. The signed-in viewer's courses are DERIVED below.
  const [trainingProgress, setTrainingProgress] = useState<TrainingProgressRecord[]>([]);

  const [documents, setDocuments] = useState<StaffDocument[]>([]);
  const [sifrReports, setSifrReports] = useState<SIFRReport[]>([]);
  // SECURITY (Phase 1 review): applications, franchise enquiries and contact
  // messages are sensitive public-form data and must NOT be persisted to
  // localStorage/sessionStorage/IndexedDB. They live in React memory for the
  // current page session only; the authoritative copy is the database row the
  // submission wrote (readable later only via the authenticated backend).
  const [applications, setApplications] = useState<JobApplication[]>([]);
  const [franchiseInquiries, setFranchiseInquiries] = useState<FranchiseInquiry[]>([]);
  const [contactMessages, setContactMessages] = useState<ContactMessage[]>([]);

  /**
   * LIVE INBOX (pairs with supabase/migration_inbox_read.sql).
   * When a manager/owner is signed in, the three states above are hydrated
   * from the database under their JWT, so the admin panel shows every real
   * submission — not just ones made in this browser session. Rows stay in
   * React memory only (never persisted locally: they contain applicant PII).
   */
  const [inboxStatus, setInboxStatus] = useState<'idle' | 'loading' | 'live' | 'error' | 'unavailable'>('idle');
  const inboxGenerationRef = useRef(0);
  const refreshInbox = React.useCallback(async () => {
    const generation = ++inboxGenerationRef.current;
    if (!employee || !['owner', 'store_manager'].includes(employee.role)) {
      setApplications([]);
      setContactMessages([]);
      setFranchiseInquiries([]);
      setInboxStatus('idle');
      return;
    }
    // Inbox PII follows the same id|role|store scope as the rest of hydration.
    // Clear first so a role change or store transfer cannot retain old rows.
    setApplications([]);
    setContactMessages([]);
    setFranchiseInquiries([]);
    setInboxStatus('loading');
    if (!isCloudConfigured()) {
      if (generation === inboxGenerationRef.current) setInboxStatus('unavailable');
      return;
    }

    const token = await getAccessToken();
    if (generation !== inboxGenerationRef.current) return;
    if (!token) { setInboxStatus('error'); return; }

    const [apps, contacts, franchise] = await Promise.all([
      fetchApplicationsAuthed<JobApplicationRow>(token),
      // Final Stage-2 RLS makes Contact Inbox owner-only. A manager must not
      // call an endpoint that is designed to deny them, otherwise an otherwise
      // healthy Careers inbox is incorrectly marked as failed.
      employee.role === 'owner'
        ? fetchInboxAuthed<ContactMessageRow>('contact_messages', token)
        : Promise.resolve({ status: 'ok' as const, rows: [] as ContactMessageRow[] }),
      employee.role === 'owner'
        ? fetchInboxAuthed<FranchiseInquiryRow>('franchise_inquiries', token)
        : Promise.resolve({ status: 'ok' as const, rows: [] as FranchiseInquiryRow[] }),
    ]);
    if (generation !== inboxGenerationRef.current) return;

    if (apps.status === 'ok') {
      setApplications(apps.rows.map((r): JobApplication => ({
        id: r.id, fullName: r.fullName, email: r.email, phone: r.phone ?? '',
        position: r.appliedFor ?? '', store: r.appliedStore ?? '',
        availability: r.availability ?? '', experience: r.experience ?? '',
        hasCv: r.cvPresent === true, message: r.message ?? '',
        status: r.status ?? 'pending', appliedAt: r.appliedAt || r.createdAt || '',
      })));
    }
    if (employee.role === 'owner' && contacts.status === 'ok') {
      setContactMessages(contacts.rows.map((r): ContactMessage => ({
        id: r.id, fullName: r.fullName, email: r.email,
        reason: r.reason ?? '', message: r.message ?? '',
        status: r.status ?? 'new',
        submittedAt: r.submittedAt || r.createdAt || '',
        ...(r.repliedAt ? { repliedAt: r.repliedAt } : {}),
        ...(r.closedAt ? { closedAt: r.closedAt } : {}),
      })));
    }
    if (employee.role === 'owner' && franchise.status === 'ok') {
      setFranchiseInquiries(franchise.rows.map((r): FranchiseInquiry => ({
        id: r.id, fullName: r.fullName, email: r.email, phone: r.phone ?? '',
        country: r.country ?? '', city: r.city ?? '', budget: r.budget ?? '',
        experience: r.experience ?? '', message: r.message ?? '',
        status: r.status ?? 'pending', submittedAt: r.submittedAt || r.createdAt || '',
      })));
    }

    const required = employee.role === 'owner'
      ? [apps.status, contacts.status, franchise.status]
      : [apps.status];
    setInboxStatus(required.every((status) => status === 'ok') ? 'live' : 'error');
  }, [employeeScopeKey]);

  // Rehydrate on role/store changes even when the Auth user id is unchanged.
  useEffect(() => {
    if (employeeScopeKey) void refreshInbox();
    else {
      inboxGenerationRef.current += 1;
      setApplications([]);
      setContactMessages([]);
      setFranchiseInquiries([]);
      setInboxStatus('idle');
    }
  }, [employeeScopeKey, refreshInbox]);
  const [employeesList, setEmployeesList] = useState<EmployeeProfile[]>([]);
  const [shiftsList, setShiftsList] = useState<WorkShift[]>([]);

  // Public-site content: the brand seeds render the FIRST paint before the
  // boot pull returns; the database copy then replaces them. Edits go through
  // the server-confirmed publishers below — never back into localStorage.
  // R4.9 G4 — THE PUBLIC SITE FAILS CLOSED.
  // These three registries used to be seeded with src/data.ts, so a failed or
  // absent cloud pull left real-looking products and prices on the public menu
  // indefinitely. They now start EMPTY, and `publicContentState` records whether
  // the customer-facing surface may be rendered at all. Seeds are reachable only
  // through an explicit development opt-in (see DEV_SEED_CONTENT below); a
  // production build cannot enter that branch.
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [stores, setStores] = useState<StoreLocation[]>([]);
  const [vacancies, setVacancies] = useState<CareerVacancy[]>([]);
  /** R4.10 P0-2: true once the AUTHENTICATED full menu has replaced the
   *  anonymous available-only copy. The publisher sends a whole-collection
   *  snapshot, so publishing before this is set would delete hidden products. */
  /* R4.10 Increment 5b — COLLECTION AUTHORITY.
     `menuCatalogueComplete` was a single boolean covering one collection. Every
     collection whose public read is a filtered projection has the same hazard:
     publish from the narrow copy and the rows you could not see are deleted.
     Authority is therefore per collection AND bound to the identity it was
     hydrated for, so a stale snapshot cannot survive a user change. */
  /* SMALL-BIZ CLOSURE P0-5: `stores` joins the authority model (it was the one
     projection-backed collection publishing without it), and `articles` joins
     because the Knowledge Base is now database-backed (P0-6) and its publisher
     carries the same replace-collection hazard. */
  type CollectionName = 'menu' | 'deals' | 'news' | 'vacancies' | 'cms' | 'media' | 'stores' | 'articles';
  const [collectionAuthority, setCollectionAuthority] =
    useState<Partial<Record<CollectionName, { userId: string; generation: number }>>>({});
  const [hydrationGeneration, setHydrationGeneration] = useState(0);
  const grantAuthority = (name: CollectionName, userId: string, generation: number) =>
    setCollectionAuthority((prev) => ({ ...prev, [name]: { userId, generation } }));
  /** Authority is valid only for the CURRENT identity and the LATEST hydration. */
  const hasAuthority = (name: CollectionName, userId: string | undefined) => {
    const a = collectionAuthority[name];
    return Boolean(a && userId && a.userId === userId && a.generation === hydrationGeneration);
  };
  const clearAuthority = () => setCollectionAuthority({});
  /* SMALL-BIZ CLOSURE P0-5: `Boolean(collectionAuthority.menu)` validated only
     that SOME authority entry existed — not that it belonged to the current
     user and the latest hydration. The alias now asks the same identity-bound,
     generation-bound question every other collection asks. */
  const menuCatalogueComplete = hasAuthority('menu', employee?.id);
  /* R4.10 Increment 6 — ONE STATE PER PUBLIC COLLECTION.
     This was a single flag derived from "did every public key arrive". One
     failing fetch therefore marked the WHOLE public site unavailable: a careers
     outage hid the menu, and a visitor who came to read the menu was told the
     site had no content. Each collection now carries its own state, so an outage
     is scoped to the surface that actually failed. */
  const [publicStates, setPublicStates] = useState<Record<PublicCollectionName, PublicStatus>>({
    menu: 'loading', deals: 'loading', stores: 'loading',
    news: 'loading', vacancies: 'loading',
  });
  /* No aggregate is kept. Splitting the state was the point: reintroducing a
     single "is the public site up" value would invite exactly the coupling this
     increment removed — one collection's outage speaking for all six. Every
     consumer asks about the collection it actually renders. */
  /* SMALL-BIZ CLOSURE P0-6: starts EMPTY. INITIAL_ARTICLES made the bundled
     seed articles the operational Knowledge Base — owner edits saved to the
     database vanished from the interface on reload, and a whole-collection
     publish could overwrite the database with the seeds. Production state
     hydrates from Supabase only; the seeds remain available solely to the
     explicit DEV_SEED_CONTENT development branch below. */
  const [articles, setArticles] = useState<KnowledgeArticle[]>([]);
  /* R4.10 Increment 2: starts EMPTY, not seeded. INITIAL_NEWS_POSTS put a
     fabricated article into the public news surface before any load had
     happened; the database is the only source of published news. */
  const [newsPosts, setNewsPosts] = useState<NewsPost[]>([]);
  /* R4.10: the value is no longer discarded — the Admin Panel's CMS tab now
   * lists these pages with their publication state and publish controls. */
  const [cmsPages, setCmsPages] = useState<CmsPageContent[]>(() => DEV_PRIVATE_SEED_CONTENT ? INITIAL_CMS_PAGES : []);
  const [publicPrivacyNotices, setPublicPrivacyNotices] = useState<PrivacyNoticeCurrent[]>(() =>
    DEV_PRIVATE_SEED_CONTENT ? INITIAL_PRIVACY_NOTICES : []);
  /* INC11: the collection revision each editor snapshot was hydrated at,
   * keyed by BASE TABLE (the ledger's key). Stated on every collection save;
   * unknown → null → the server refuses rather than guesses. */
  const [collectionRevisions, setCollectionRevisions] = useState<Record<string, number>>({});
  const [mediaItems, setMediaItems] = useState<MediaItem[]>(() => DEV_PRIVATE_SEED_CONTENT ? INITIAL_MEDIA_LIBRARY : []);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [rolePermissions, setRolePermissions] = useState<RolePermissionMatrix[]>(() => DEV_PRIVATE_SEED_CONTENT ? INITIAL_ROLE_PERMISSIONS : []);

  // WEBSITE STUDIO CONTENT MODEL
  // The raw (possibly partial / null) value is what persists + syncs; the
  // complete object the app renders is always defaults deep-merged with the
  // saved value, so future updates that add fields never render blanks. On a
  // fresh device hydrateSiteContent also imports any edits made in the old
  // cms_pages registry (one-time upgrade path).
  const [rawSiteContent, setRawSiteContent] = useState<Partial<SiteContent> | null>(null);
  // OPT-02-C1.2: shared SEO rebuild status — updated by both auto rebuilds
  // (after a public-content publish) and the manual "Rebuild SEO" button.
  const [seoRebuildStatus, setSeoRebuildStatus] = useState<SeoRebuildStatus>({ state: 'idle' });
  const siteContent = useMemo(() => hydrateSiteContent(rawSiteContent), [rawSiteContent]);

  // Promotions, site settings & staff checklist templates
  // R4.9 G4 REVIEW FIX: deals are PUBLIC content rendered on the home and menu
  // pages with their own prices, and they were still seeded from src/data.ts —
  // the identical fail-open defect this gate closed for the menu, one table
  // over. A failed deals fetch was showing customers a priced bundle offer
  // that may not exist. Empty start + the same PublicCollection state.
  const [deals, setDeals] = useState<Deal[]>([]);
  const [siteSettings, setSiteSettings] = useState<SiteSettings>(INITIAL_SETTINGS);
  const [checklistTemplates, setChecklistTemplates] = useState<ChecklistTemplateItem[]>(() => DEV_PRIVATE_SEED_CONTENT ? INITIAL_CHECKLIST_TEMPLATES : []);

  // Payroll: clocked hours (shared so managers approve what staff record) + generated payslips
  const [clockHistory, setClockHistory] = useState<ClockHistoryItem[]>([]);
  const [payslips, setPayslips] = useState<Payslip[]>([]);

  // E-mail notification preferences (delivery via the Supabase Edge Function)
  const [emailSettings, setEmailSettings] = useState<EmailSettings>(DEFAULT_EMAIL_SETTINGS);
  // Per-staff KV app state (clock status, checklist ticks, shift covers) —
  // hydrated from the app_state table after sign-in.
  const [appState, setAppState] = useState<Record<string, unknown>>({});

  // Cloud database (Supabase) connection status
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>({
    configured: isCloudConfigured(),
    connected: false,
    health: 'offline',
  });
  const [publicConfigurationStatus, setPublicConfigurationStatus] = useState<'loading' | 'ready' | 'stale' | 'unavailable'>('loading');
  const livePublicKeysRef = useRef<Set<string>>(new Set());
  const buildSnapshotAppliedRef = useRef(false);

  /* Declared before the boot effect so its focus handler can trigger an
     AUTHENTICATED rehydration (P0-1) instead of an anonymous overwrite. */
  const [staffDataStatus, setStaffDataStatus] = useState<StaffDataStatus>('idle');
  const [hydrateNonce, setHydrateNonce] = useState(0);
  const retryHydration = () => setHydrateNonce((n) => n + 1);

  /* SMALL-BIZ CLOSURE P0-1 — the boot/focus refresh runs from an effect with
     an EMPTY dependency array, so it can never see the current `employee`
     through its closure: it would capture the value from first render (always
     null) and treat every pull as anonymous forever. The ref is the standing
     answer to that stale closure: it always holds the CURRENT authenticated
     employee id (or null), and the pull logic reads it at call time. */
  const authedEmployeeIdRef = useRef<string | null>(null);
  useEffect(() => { authedEmployeeIdRef.current = employee?.id ?? null; }, [employee?.id]);

  /* T13-3: identity-boundary cleanup now clears the public collections too, so
     a tab that ends up SIGNED OUT without reloading (cross-tab logout, session
     expiry) must re-pull the anonymous public content — otherwise the customer
     site would sit empty. Manual logout replaces the location, so it reloads
     anyway; this ref covers the paths that do not. */
  const runPublicPullRef = useRef<(() => void) | null>(null);
  const handleAdminSectionChange = useCallback((section: string, replace?: boolean) => {
    setCurrentTab('admin_panel', section === 'dashboard' ? {} : { section }, { replace, keepScroll: true });
  }, [setCurrentTab]);
  const refreshPublicContent = useCallback(() => {
    runPublicPullRef.current?.();
  }, []);

  // Last-known-good public bootstrap. Production builds contain a Supabase-derived, hash-verified snapshot
  // bound into the frozen release generated alongside the static SEO pages. It is
  // rendered as explicitly STALE until the live anonymous pull succeeds; live
  // data always wins and a late snapshot can never overwrite it.
  useEffect(() => {
    let cancelled = false;
    void loadBuildPublicContent().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        // With no live backend there is no second source that can resolve the
        // configuration. End the loading state honestly instead of leaving a
        // direct optional route on an endless spinner.
        if (!isCloudConfigured() && !DEV_PRIVATE_SEED_CONTENT) {
          setPublicConfigurationStatus('unavailable');
        }
        return;
      }
      const { snapshot } = result.value;
      const liveKeys = livePublicKeysRef.current;
      buildSnapshotAppliedRef.current = true;
      if (!liveKeys.has('milkpop_site_settings')) setSiteSettings(snapshot.siteSettings);
      if (!liveKeys.has('milkpop_site_content')) setRawSiteContent(snapshot.siteContent);
      if (authedEmployeeIdRef.current === null) {
        if (!liveKeys.has('milkpop_menu_items')) setMenuItems(snapshot.menuItems);
        if (!liveKeys.has('milkpop_stores_list')) setStores(snapshot.stores);
        if (!liveKeys.has('milkpop_vacancies_list')) setVacancies(snapshot.vacancies);
        if (!liveKeys.has('milkpop_news_posts')) setNewsPosts(snapshot.newsPosts);
      }
      setPublicStates((prev) => ({
        ...prev,
        menu: liveKeys.has('milkpop_menu_items') ? prev.menu : 'ready',
        stores: liveKeys.has('milkpop_stores_list') ? prev.stores : 'ready',
        vacancies: liveKeys.has('milkpop_vacancies_list') ? prev.vacancies : 'ready',
        news: liveKeys.has('milkpop_news_posts') ? prev.news : 'ready',
      }));
      if (!(liveKeys.has('milkpop_site_settings') && liveKeys.has('milkpop_site_content'))) {
        setPublicConfigurationStatus('stale');
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Hydrate every registry from Supabase once on boot (if the owner connected a database)
  useEffect(() => {
    onCloudStatus((s) => {
      setCloudStatus((prev) => ({
        ...prev,
        configured: isCloudConfigured(),
        connected: s.lastError ? prev.connected : (prev.connected || !!s.lastSyncAt),
        health: s.lastError ? (prev.connected ? 'degraded' : 'offline') : prev.health,
        lastSyncAt: s.lastSyncAt || prev.lastSyncAt,
        lastError: s.lastError
      }));
    });
    if (!isCloudConfigured()) {
      // No database. In a production build that is NOT a reason to show seed
      // products — it is exactly the case that used to fail open. Development
      // may opt in explicitly; `import.meta.env.DEV` is statically false in a
      // production build, so the seeds are tree-shaken out of it entirely.
      if (DEV_PRIVATE_SEED_CONTENT) {
        setMenuItems(INITIAL_MENU_ITEMS);
        setStores(INITIAL_STORES);
        setVacancies(INITIAL_JOBS);
        // SMALL-BIZ CLOSURE P0-6: the KB seeds live behind the same explicit
        // development opt-in as every other seed — never in production state.
        setArticles(INITIAL_ARTICLES);
        setPublicStates(allPublicStates('ready'));
        setPublicConfigurationStatus('ready');
      } else {
        setPublicStates(allPublicStates('unavailable'));
      }
      return;
    }

    const applyCloudData = (data: Record<string, any>) => {
      // STAGE 8: pullAllFromCloud sets a key ONLY when the table fetch
      // succeeded — an EMPTY array means "the table really is empty" and MUST
      // replace the built-in seeds; a failed fetch leaves the key absent and
      // the seeds stand until the next successful pull.
      // OPT-02 Check 4 (Stage C): `data` is the dynamic key→value cloud-pull
      // bag and `setter` dispatches each value to its own typed useState — a
      // deliberate `any` boundary (documented exception, not an oversight).
      const apply = (key: string, setter: (v: any) => void) => {
        if (data[key] !== undefined && data[key] !== null) setter(data[key]);
      };
      /* SMALL-BIZ CLOSURE P0-1 — the pull result is an ANONYMOUS PROJECTION
         (available menu items, ACTIVE stores, published vacancies/news, active
         deals). While an employee is signed in, those same arrays hold the
         COMPLETE authenticated collections — drafts, coming-soon stores,
         unpublished vacancies — and this refresh used to overwrite them the
         moment the tab regained focus, hiding the editor's own records and
         leaving collection authority describing rows that were no longer
         there. The rule now: public singleton/configuration data, privacy
         notices and public content STATUS always refresh; the anonymous
         COLLECTION ARRAYS apply only when no employee is authenticated. A
         signed-in tab is refreshed by authenticated rehydration instead (see
         the focus handler below). The ref, not `employee`, carries identity
         because this effect's empty dependency array would otherwise pin a
         stale closure. */
      const authed = authedEmployeeIdRef.current !== null;
      // SECURITY: anonymous clients can only read the public-content tables
      // (see SYNC_MAP access levels in src/lib/cloudSync.ts). Staff, payroll,
      // documents, incidents, audit logs and the app_state KV store
      // are private under deny-by-default RLS and are never pulled here.
      apply('milkpop_site_settings', setSiteSettings);
      if (!authed) {
        apply('milkpop_menu_items', setMenuItems);
        apply('milkpop_deals', setDeals);
        apply('milkpop_stores_list', setStores);
        apply('milkpop_vacancies_list', setVacancies);
        apply('milkpop_news_posts', setNewsPosts);
      }
      // INC11: the notice each public form renders + echoes. An empty cloud
      // result (no published notice) must CLOSE the forms, so the pull result
      // replaces the dev defaults even when it is [].
      if (Object.prototype.hasOwnProperty.call(data, 'milkpop_privacy_notices')) {
        setPublicPrivacyNotices(Array.isArray(data['milkpop_privacy_notices']) ? data['milkpop_privacy_notices'] : []);
      }
      apply('milkpop_site_content', setRawSiteContent);
    };

    // R4.9 G4 REVIEW FIX: pullAllFromCloud catches per-table errors and RESOLVES,
    // so a resolved promise does not mean the public collections arrived. Marking
    // 'ready' unconditionally rendered a failed menu fetch as an EMPTY menu —
    // "we have no products" presented to a customer as fact. A key is present
    // only when its fetch succeeded (an empty table legitimately yields []), so
    // presence is the correct test.
    /* T13.3.17: public refreshes are coalesced. Boot, focus, identity changes
       and the browser's online event can arrive together; allowing parallel
       pulls lets an older response finish last and overwrite fresher public
       configuration. One in-flight pull is enough for every caller, and every
       caller observes the same completion. */
    let activePull: Promise<void> | null = null;
    const runPull = (): Promise<void> => {
      if (activePull) return activePull;
      activePull = pullAllFromCloud().then((result) => {
      applyCloudData(result.data);
      result.succeeded.forEach((key) => livePublicKeysRef.current.add(key));
      /* R4.10 Increment 6: scored PER COLLECTION. A key is present only when its
         fetch succeeded — an empty table legitimately yields [] — so presence is
         the correct test, and one collection failing no longer condemns the rest. */
      setPublicStates((prev) => {
        const next = { ...prev };
        (Object.keys(PUBLIC_COLLECTION_KEYS) as PublicCollectionName[]).forEach((name) => {
          const key = PUBLIC_COLLECTION_KEYS[name];
          next[name] = result.data[key] !== undefined && result.data[key] !== null
            ? 'ready'
            : (prev[name] === 'ready' ? 'ready' : 'unavailable');
        });
        return next;
      });
      const health: CloudStatus['health'] = result.failed.length === 0
        ? 'healthy'
        : (result.succeeded.length > 0 ? 'degraded' : 'offline');
      const configurationReady = result.succeeded.includes('milkpop_site_settings')
        && result.succeeded.includes('milkpop_site_content');
      setPublicConfigurationStatus(configurationReady
        ? 'ready'
        : (buildSnapshotAppliedRef.current ? 'stale' : 'unavailable'));
      setCloudStatus((prev) => ({
        ...prev,
        configured: isCloudConfigured(),
        connected: health !== 'offline',
        health,
        failedCollections: result.failed.map((failure) => failure.key),
        lastSyncAt: result.completedAt,
        lastError: result.failed.length
          ? result.failed.map((failure) => `${failure.relation}: ${failure.reason}`).join(' | ')
          : undefined,
      }));
    }).catch((e) => {
      // A failed BOOT pull leaves the public site unavailable — never seeded.
      // A failed RE-pull keeps the last known good content on screen rather than
      // blanking a page the visitor is already reading. Applied per collection.
      setPublicStates((prev) => {
        const next = { ...prev };
        (Object.keys(prev) as PublicCollectionName[]).forEach((name) => {
          next[name] = prev[name] === 'ready' ? 'ready' : 'unavailable';
        });
        return next;
      });
      setPublicConfigurationStatus(buildSnapshotAppliedRef.current ? 'stale' : 'unavailable');
      setCloudStatus((prev) => ({
        ...prev,
        connected: false,
        health: 'offline',
        lastError: String(e?.message || e),
      }));
    }).finally(() => {
      activePull = null;
    });
      return activePull;
    };

    // Boot: hydrate everything from the cloud.
    runPublicPullRef.current = runPull; // T13-3: reachable from the identity-boundary effect
    void runPull();

    // Live: whenever this tab regains focus, quietly re-pull (throttled) so a
    // change made on one device appears on every other device on next glance.
    let lastPull = Date.now();
    const refreshVisibleTab = (force = false) => {
      if (document.visibilityState !== 'visible') return;
      if (!force && Date.now() - lastPull < 30000) return;
      lastPull = Date.now();
      /* SMALL-BIZ CLOSURE P0-1: the pull still runs for BOTH audiences — it
         refreshes singletons, notices and the public availability status —
         but while signed in it no longer touches the collection arrays (see
         applyCloudData), so the administrative copies are refreshed by a full
         AUTHENTICATED rehydration instead. */
      void runPull();
      if (authedEmployeeIdRef.current !== null) setHydrateNonce((n) => n + 1);
    };
    const onFocus = () => refreshVisibleTab(false);
    /* T13.3.17: if the first pull failed because the device was offline, the
       page now recovers as soon as connectivity returns instead of waiting for
       the person to change tabs or refocus the browser. The pull remains
       single-flight, so an online+focus pair cannot duplicate the work. */
    const onOnline = () => refreshVisibleTab(true);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  const [toasts, setToasts] = useState<ToastAlert[]>([]);

  // SEO: keep the document head in sync with the page the visitor is on —
  // title + description (owner-editable in Website Studio -> SEO), canonical
  // URL, og:/twitter mirrors, and a robots noindex on staff/admin tabs.
  // Detail routes (/stores/:slug, /careers/:slug, /news/:slug) get specific
  // titles derived from the record itself. Build-time generated pages carry
  // the same values statically for crawlers; this effect keeps the live DOM
  // correct during SPA navigation.
  useEffect(() => {
    const pageKey = (PUBLIC_PAGE_KEYS as readonly string[]).includes(currentTab)
      ? (currentTab as PublicPageKey)
      : null;

    let title = pageKey ? siteContent.seo[pageKey]?.title : undefined;
    let description = pageKey ? siteContent.seo[pageKey]?.description : undefined;

    // Legal pages: derive the tab title from the owner-editable heading.
    if (currentTab === 'privacy' || currentTab === 'gdpr' || currentTab === 'fdd') {
      title = `${siteContent.legal[currentTab].title} | Milk Pop`;
    }

    // Detail routes override the section defaults with record-specific meta.
    // Unknown slugs replace-navigate to the list route — this prevents
    // arbitrary slugs from becoming self-canonical indexable 200s. No loop:
    // after the replace the param is gone, so the guard can't re-fire.
    /* SMALL-BIZ CLOSURE P0-2/P0-7: the match runs over the PROJECTED public
       records (signed-in = anonymous parity, so a draft's direct URL behaves
       identically for staff and customers), and the replace-navigate fires
       only when the collection is genuinely READY — a loading or failed
       collection must not bounce a visitor off a URL that may be valid; the
       effect re-runs when that collection resolves, so a truly unknown slug
       still lands on the list route once we actually know.
       While NOT ready the visitor keeps their URL, but the page is marked
       NOINDEX and canonicalised to the list route. Without that, gating the
       redirect would have handed crawlers exactly what the original guard
       existed to prevent: an arbitrary slug as an indexable, self-canonical
       200 for the whole duration of an outage. Honest to the visitor,
       closed to the crawler. */
    if (currentTab === 'stores' && routeParams.store) {
      const store = matchBySlug(projectPublicStores(stores), routeParams.store, (s: StoreLocation) => storeSlug(s), (s: StoreLocation) => s.id);
      if (!store) {
        if (publicStates.stores === 'ready') { setCurrentTab('stores', {}, { replace: true, keepScroll: true }); return; }
        applyHeadMeta({ title, description, canonicalPath: canonicalPathFor('stores', {}), noindex: true });
        return;
      }
      title = `${store.name} — Opening Hours & Location | Milk Pop`;
      description = `${store.address}, ${store.postcode}. ${store.openingHours}.`;
    } else if (currentTab === 'careers' && routeParams.job) {
      const job = matchBySlug(projectPublicVacancies(vacancies), routeParams.job, (j: CareerVacancy) => vacancySlug(j), (j: CareerVacancy) => j.id);
      if (!job) {
        if (publicStates.vacancies === 'ready') { setCurrentTab('careers', {}, { replace: true, keepScroll: true }); return; }
        applyHeadMeta({ title, description, canonicalPath: canonicalPathFor('careers', {}), noindex: true });
        return;
      }
      title = `${job.title} (${job.location}) | Milk Pop Careers`;
      description = `${job.type} · ${job.department} · ${job.salary}. Apply online at Milk Pop.`;
    } else if (currentTab === 'news' && routeParams.post) {
      const post = matchBySlug(projectPublicNews(newsPosts), routeParams.post, (p: NewsPost) => postSlug(p), (p: NewsPost) => p.id);
      if (!post) {
        if (publicStates.news === 'ready') { setCurrentTab('news', {}, { replace: true, keepScroll: true }); return; }
        applyHeadMeta({ title, description, canonicalPath: canonicalPathFor('news', {}), noindex: true });
        return;
      }
      title = `${post.title} | Milk Pop News`;
      description = post.content.slice(0, 155);
    }

    // R4.7: the not-found view gets its own title and description, and its
    // canonical stays on the URL that was actually requested. Pointing the
    // canonical at '/' would tell a crawler this page IS the homepage, which
    // is the soft-404 signal we are removing. `isIndexableTab` already returns
    // false for an unknown tab, so noindex needs no special case.
    if (currentTab === 'not_found') {
      applyHeadMeta({
        title: 'Page not found | Milk Pop',
        description: 'That page does not exist. Browse the Milk Pop menu, find a store, or get in touch.',
        canonicalPath: window.location.pathname + window.location.search,
        noindex: true,
      });
      return;
    }

    const optionalSectionPending = optionalSectionRequested(currentTab)
      && publicConfigurationStatus === 'loading';
    const optionalSectionDisabled = optionalSectionRequested(currentTab)
      && !optionalSectionPending
      && !optionalSectionPublished(currentTab, siteSettings);
    applyHeadMeta({
      title: optionalSectionPending
        ? 'Loading | Milk Pop'
        : optionalSectionDisabled ? 'Page not available | Milk Pop' : title,
      description: optionalSectionPending
        ? 'Loading the verified Milk Pop website configuration.'
        : optionalSectionDisabled ? 'This section is not currently published.' : description,
      canonicalPath: canonicalPathFor(currentTab, routeParams),
      noindex: !isIndexableTab(currentTab) || optionalSectionPending || optionalSectionDisabled,
    });
  }, [currentTab, routeParams, siteContent, siteSettings, stores, vacancies, newsPosts, setCurrentTab, publicConfigurationStatus,
      /* SMALL-BIZ CLOSURE P0-7: the effect defers its unknown-slug redirect
         until the collection is READY, so it must re-run when a collection's
         state resolves — otherwise a visitor who arrived during loading would
         wait forever on a slug that genuinely doesn't exist. */
      publicStates.stores, publicStates.vacancies, publicStates.news]);

  // Automatically manage isStaffMode based on currentTab
  useEffect(() => {
    if (currentTab === 'admin_panel' || currentTab.startsWith('staff_')) {
      setIsStaffMode(true);
    } else {
      setIsStaffMode(false);
    }
  }, [currentTab]);

  // SECURITY: one-off scrub of legacy credential material on boot.
  //
  // Earlier builds (a) restored a full session — including the role — straight
  // out of the `milkpop_session` localStorage key, which let anyone forge an
  // owner session from DevTools, and (b) stored plaintext passwords on every
  // employee record in `milkpop_employees`. Sessions are NEVER restored from
  // localStorage any more, and any password fields left behind by old builds
  // are stripped so they can't linger on disk or sync to the cloud.
  useEffect(() => {
    try {
      localStorage.removeItem('milkpop_session');
      // SECURITY (Phase 1 review): sensitive public-form submissions and CVs
      // must never live in browser storage. Earlier builds persisted them here
      // (including base64 CV bytes inside milkpop_apps). Purge any such data on
      // boot; these registries are now in-memory only.
      localStorage.removeItem('milkpop_apps');
      localStorage.removeItem('milkpop_fran');
      localStorage.removeItem('milkpop_contacts');
      const rawEmployees = localStorage.getItem('milkpop_employees');
      if (rawEmployees && (rawEmployees.includes('"password"') || rawEmployees.includes('"mustChangePassword"'))) {
        const parsed = JSON.parse(rawEmployees);
        if (Array.isArray(parsed)) {
          const scrubbed = parsed.map((e: Record<string, unknown>) => {
            const { password, mustChangePassword, ...rest } = e || {};
            return rest;
          });
          // PHASE A: the scrubbed bytes stay ONLY for the owner's one-time
          // import tool — live state now hydrates from Supabase, never from
          // localStorage.
          localStorage.setItem('milkpop_employees', JSON.stringify(scrubbed));
        }
      }
    } catch (e) {
      console.warn('Legacy credential scrub failed', e);
    }
  }, []);

  const addToast = (message: string, type: 'success' | 'warning' | 'error' | 'info') => {
    const id = 'toast_' + Date.now() + Math.random().toString(36).substring(2, 6);
    setToasts((prev) => [
      ...prev.filter((toast) => toast.message !== message || toast.type !== type).slice(-3),
      { id, message, type },
    ]);

    // Auto cleanup after 4 seconds
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  };

  /* ================================================================== */
  /*  PHASE A — SIGN-IN HYDRATION + SERVER-CONFIRMED MUTATIONS           */
  /*  Supabase is the system of record. Every operation below:           */
  /*   1. sends the change with the caller's Auth JWT (RLS enforces      */
  /*      role + store scope server-side),                               */
  /*   2. waits for PostgREST to CONFIRM the write,                      */
  /*   3. only then updates React state,                                 */
  /*   4. on failure toasts a clear error and leaves state untouched —   */
  /*      there is no localStorage fallback of any kind.                 */
  /* ================================================================== */
  /** Fresh JWT or a visible failure — never a silent no-op. */
  const requireToken = async (): Promise<string | null> => {
    if (!isCloudConfigured()) {
      addToast('No database is configured — internal changes cannot be saved.', 'error');
      return null;
    }
    const token = await getAccessToken();
    if (!token) addToast('Your session has expired. Sign in again to save changes.', 'error');
    return token;
  };

  /** Runs one server-first operation; on failure toasts and returns false. */
  const runOp = async (op: (token: string) => Promise<void>): Promise<boolean> => {
    const token = await requireToken();
    if (!token) return false;
    try {
      await op(token);
      return true;
    } catch (e) {
      console.warn('[registries] operation failed:', e instanceof RegistryError ? e.code : e);
      addToast(registryErrorMessage(e), 'error');
      return false;
    }
  };

  /**
   * Collection PUBLISHER for content-style registries (menu, stores, news…).
   * The editor's explicit action supplies the intended full collection; the
   * publisher derives the per-row upserts/deletes FROM THAT ACTION against the
   * in-memory server-hydrated copy, executes them server-first, and commits
   * state only after every row is confirmed. This is not the old background
   * localStorage mirror: it never reads browser storage, never runs on a
   * timer, and cannot fire before hydration (a stale snapshot can't mass-
   * delete fresh rows).
   */
  /** STAGE 7 — publishing a collection is ONE database transaction
   *  (replace_collection, SECURITY INVOKER): every delete and upsert commits
   *  together or not at all, and the state below is set from the collection
   *  the SERVER returned — never from the optimistic payload. */
  const makeCollectionPublisher = <T extends Record<string, any>>(
    storageKey: string,
    getCurrent: () => T[],
    commit: (next: T[]) => void,
  ) => async (next: T[] | ((prev: T[]) => T[])): Promise<boolean> => {
    /* SMALL-BIZ CLOSURE P0-5 (7): a whole-collection save is destructive by
       design (rows absent from the snapshot are deleted), so it refuses
       up-front when the snapshot cannot be trusted:
         · staff data is not `live` — hydration failed or is still running,
           so the in-memory copy may be partial;
         · the collection's ledger revision never arrived — the server would
           refuse `null` anyway, but the user deserves the honest reason
           BEFORE a destructive call is attempted.
       The server's row-count and revision checks remain the final defence. */
    if (staffDataStatus !== 'live') {
      addToast('Internal data is not fully loaded — use Retry in the admin panel before saving, so no records are lost.', 'error');
      return false;
    }
    const table = collectionTable(storageKey);
    if (collectionRevisions[table] === undefined) {
      addToast('This collection\u2019s version has not loaded yet — reload before saving, so no records are lost.', 'error');
      return false;
    }
    const current = getCurrent();
    const resolved = typeof next === 'function' ? (next as (prev: T[]) => T[])(current) : next;
    const token = await requireToken();
    if (!token) return false;
    try {
      /* R4.10: state the snapshot total. `current` is the server-hydrated
       * in-memory copy this edit was made against, so its length is exactly
       * the count the publisher believes in — if the collection changed
       * underneath (another session, another device), the server refuses the
       * call as stale instead of deleting the rows this session never saw. */
      const saved = await replaceCollection<T>(storageKey, resolved, token, current.length,
        collectionRevisions[table] ?? null);
      commit(saved.rows);
      setCollectionRevisions((prev) => ({ ...prev, [table]: saved.revision }));
      return true;
    } catch (e) {
      addToast(registryErrorMessage(e), 'error');
      return false;
    }
  };

  /** FIX-7/T13.3.19 — explicit publisher for payslips only. Timesheet
   *  decisions use the narrow decide_timesheets RPC; clock facts are never
   *  republished from a browser snapshot.
   *
   *  Payslips remain a manager-owned collection where replace-all would be a
   *  data-loss hazard. This publisher diffs the editor's intended collection
   *  against the in-memory server-hydrated copy and sends only changed rows
   *  and explicit removals through apply_collection_changes. Rows added by
   *  another manager in between are neither overwritten nor deleted. */
  const stableStringify = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v as Record<string, unknown>).sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k]))
      .join(',') + '}';
  };
  const makeExplicitChangesPublisher = <T extends Record<string, any>>(
    storageKey: string,
    getCurrent: () => T[],
    commit: (next: T[]) => void,
  ) => async (next: T[] | ((prev: T[]) => T[])): Promise<boolean> => {
    const current = getCurrent();
    const resolved = typeof next === 'function' ? (next as (prev: T[]) => T[])(current) : next;
    const token = await requireToken();
    if (!token) return false;
    const currentById = new Map(current.map((r) => [String(r.id), r]));
    const resolvedIds = new Set(resolved.map((r) => String(r.id)));
    const upserts = resolved.filter((r) => {
      const prev = currentById.get(String(r.id));
      return !prev || stableStringify(prev) !== stableStringify(r);
    });
    const deleteIds = current.filter((r) => !resolvedIds.has(String(r.id))).map((r) => String(r.id));
    if (!upserts.length && !deleteIds.length) { commit(resolved); return true; }
    try {
      const serverCollection = await applyCollectionChanges<T>(storageKey, upserts, deleteIds, token);
      commit(serverCollection);
      return true;
    } catch (e) {
      addToast(registryErrorMessage(e), 'error');
      return false;
    }
  };

  /* ---- OPT-02-C1.2: SEO rebuild after public-content publishes ---- */
  /** Ask the request-seo-rebuild Edge Function to record that the static SEO
   *  snapshot needs the next protected signed release. Requires a live session. */
  const requestSeoRebuild = useCallback(async (area: SeoRebuildArea): Promise<SeoRebuildResult> => {
    const token = await getAccessToken();
    if (!token) return { ok: false, code: 'unauthorized', message: 'Sign in again to rebuild SEO.' };
    return clientRequestSeoRebuild(area, token);
  }, []);

  /** The database write and the SEO refresh handoff are SEPARATE: a failed
   *  handoff never rolls back the valid write, but it surfaces a retryable status. */
  const runSeoRebuildAfterPublish = useCallback(
    async (area: SeoRebuildArea, wrote: boolean, changed?: boolean): Promise<void> => {
      const outcome = await afterPublishRebuild(
        area, wrote, requestSeoRebuild, changed === undefined ? undefined : { changed },
      );
      if (!outcome.requested) return;
      const r = outcome.result;
      if (r.ok) {
        setSeoRebuildStatus({ state: r.queued ? 'queued' : 'deferred', area, at: new Date().toISOString() });
        return;
      }
      const code = (r as { code?: string }).code;
      setSeoRebuildStatus({
        state: code === 'not_configured' ? 'not_configured' : 'failed',
        area,
        at: new Date().toISOString(),
      });
      if (code !== 'unauthorized') {
        addToast(
          'Content is live, but the static SEO refresh handoff was not recorded. Retry the SEO status action.',
          'warning',
        );
      }
    },
    [requestSeoRebuild],
  );

  /** Manual "Rebuild SEO" action for the Admin SEO panel. */
  const handleManualSeoRebuild = useCallback(async (): Promise<void> => {
    await runSeoRebuildAfterPublish('manual', true);
  }, [runSeoRebuildAfterPublish]);

  /** R4.10 — THE publication path. Every make-public / withdraw decision for
   *  the six public collections goes through the publish_record RPC: explicit
   *  role matrix (owner: all six; store manager: menu only), AAL2 required,
   *  completeness enforced on publish, an audit row every time. Local state is
   *  set from the value the SERVER confirmed — never optimistically — and the
   *  SEO areas that have static pages request a rebuild on success. */
  /* Deliberately NOT useCallback: requireToken is unmemoized (as every
   * publisher in this file relies on), so memoising here only trades one
   * exhaustive-deps warning for another. AdminPanel is not memo-wrapped;
   * referential stability buys nothing. */
  const publishRecord =
    async (table: PublishableContentTable, id: string, publish: boolean): Promise<{ ok: boolean; message?: string }> => {
      const token = await requireToken();
      if (!token) return { ok: false, message: 'Sign in again to change publication state.' };
      try {
        const res = await callRpc<{ current: string; revision?: number }>('publish_record',
          { p_table: table, p_id: id, p_publish: publish }, token);
        const cur = String(res?.current ?? '');
        if (typeof res?.revision === 'number') {
          setCollectionRevisions((prev) => ({ ...prev, [table]: res.revision as number }));
        }
        switch (table) {
          case 'menu_items':
            setMenuItems((prev) => prev.map((i) => (i.id === id ? { ...i, available: cur === 'true' } : i)));
            void runSeoRebuildAfterPublish('menu', true);
            break;
          case 'deals':
            setDeals((prev) => prev.map((d) => (d.id === id ? { ...d, active: cur === 'true' } : d)));
            break;
          case 'news_posts':
            setNewsPosts((prev) => prev.map((n) => (n.id === id ? { ...n, status: cur === 'published' ? 'published' : 'draft' } : n)));
            // INC11: first publication FREEZES the post's address server-side
            // (collision-suffixed if two titles derive the same slug). Absorb
            // it now so every link the admin copies is the canonical one —
            // waiting for the next full hydration would leave the rare
            // suffixed case pointing at a derived address the server refused.
            if (cur === 'published') {
              void (async () => {
                try {
                  const rows = await authedRest<Array<{ slug: string | null }>>(
                    `news_posts?id=eq.${encodeURIComponent(id)}&select=slug`, token, { method: 'GET' });
                  const slug = rows?.[0]?.slug || undefined;
                  if (slug) setNewsPosts((prev) => prev.map((n) => (n.id === id ? { ...n, slug } : n)));
                } catch { /* the next hydration carries it */ }
              })();
            }
            void runSeoRebuildAfterPublish('news', true);
            break;

          case 'job_vacancies':
            setVacancies((prev) => prev.map((v) => (v.id === id
              ? { ...v, status: (cur === 'published' ? 'published' : cur === 'closed' ? 'closed' : 'draft') }
              : v)));
            void runSeoRebuildAfterPublish('vacancies', true);
            break;

        }
        return { ok: true };
      } catch (e) {
        return { ok: false, message: registryErrorMessage(e) };
      }
    };

  /** Wrap a collection publisher so a SERVER-CONFIRMED write triggers a rebuild
   *  for that public-content area. A failed write requests nothing. */
  const withSeoRebuild = <T,>(
    area: SeoRebuildArea,
    publisher: (next: T[] | ((prev: T[]) => T[])) => Promise<boolean>,
  ) => async (next: T[] | ((prev: T[]) => T[])): Promise<boolean> => {
    const ok = await publisher(next);
    if (ok) void runSeoRebuildAfterPublish(area, ok);
    return ok;
  };

  /* ---- Content publication (Website Studio & admin content tabs) ---- */
  // SEO-affecting publishers request a static rebuild on success; deals, KB
  // articles and all private/internal registries deliberately do NOT.
  /** R4.9 G4: the public surface receives a STATE, not an array, so no consumer
   *  can substitute seeds for missing data — the union has no such member. */
  const asPublic = useCallback(<T,>(name: PublicCollectionName, items: T[]): PublicCollection<T> => {
    const status = publicStates[name];
    return status === 'ready' ? { status: 'ready', items } : { status };
  }, [publicStates]);

  /* INC11: closing a vacancy is a real transition (close_vacancy RPC) — the
   * row and its application history survive with status 'closed'; the public
   * projection drops it, so the SEO output rebuilds like an unpublish. */
  const closeVacancy = async (id: string): Promise<{ ok: boolean; message?: string }> => {
    const token = await requireToken();
    if (!token) return { ok: false, message: 'Sign in again to close a vacancy.' };
    try {
      const res = await callRpc<{ status: string; revision?: number }>('close_vacancy',
        { p_id: id, p_expected_revision: collectionRevisions['job_vacancies'] ?? null }, token);
      if (typeof res?.revision === 'number') {
        setCollectionRevisions((prev) => ({ ...prev, job_vacancies: res.revision as number }));
      }
      setVacancies((prev) => prev.map((v) => (v.id === id ? { ...v, status: 'closed' } : v)));
      void runSeoRebuildAfterPublish('vacancies', true);
      return { ok: true };
    } catch (e) {
      const message = registryErrorMessage(e);
      addToast(message, 'error');
      return { ok: false, message };
    }
  };

  const publishMenuItemsRaw = withSeoRebuild('menu', makeCollectionPublisher('milkpop_menu_items', () => menuItems, setMenuItems));
  /** R4.10 P0-2. replace_collection deletes every row absent from the snapshot,
   *  so publishing the anonymous available-only copy would silently destroy the
   *  hidden catalogue. Refusing is the only safe answer when the full rows have
   *  not arrived — a failed bundle fetch must not become data loss. */
  const publishMenuItems = useCallback(
    async (next: MenuItem[] | ((prev: MenuItem[]) => MenuItem[])): Promise<boolean> => {
      if (!menuCatalogueComplete) {
        addToast('Menu not fully loaded yet — reload before publishing so hidden products are not removed.', 'error');
        return false;
      }
      return publishMenuItemsRaw(next);
    },
    [menuCatalogueComplete, publishMenuItemsRaw],
  );
  /* SMALL-BIZ CLOSURE P0-5 (6): publishStores was the one projection-backed
     publisher running WITHOUT collection authority — a snapshot hydrated from
     the anonymous stores_public view (setup-ACTIVE rows only) could have
     replaced the whole table and deleted every coming-soon or draft store.
     requireAuthority is declared below, so the wrapper is applied at the
     declaration point of the publisher group (see publishStoresGuarded). */
  const publishStoresRaw = withSeoRebuild('stores', makeCollectionPublisher('milkpop_stores_list', () => stores, setStores));

  /* R4.10 Increment 5b — the same refusal, generalised.
     Every collection below is published by whole-collection replacement AND has
     a filtered public projection, so each carries the menu's hazard exactly:
     publish from the narrow anonymous copy and the rows you could not see are
     deleted. `hasAuthority` requires the authenticated copy to have arrived FOR
     THE CURRENT IDENTITY and from the LATEST hydration, so a stale snapshot, a
     failed refresh or a user change all revoke the right to publish rather than
     silently permitting a destructive write. */
  const requireAuthority = <T,>(
    name: CollectionName,
    label: string,
    raw: (next: T[] | ((prev: T[]) => T[])) => Promise<boolean>,
  ) => async (next: T[] | ((prev: T[]) => T[])): Promise<boolean> => {
    if (!hasAuthority(name, employee?.id)) {
      addToast(`${label} not fully loaded yet — reload before publishing so hidden records are not removed.`, 'error');
      return false;
    }
    return raw(next);
  };

  /* WS6h (Round-9e audit findings 2/3): configuration and classification are
     written by the SERVER (configure_store_setup / classify_products) on
     columns the browser may not publish. Confirmed results must therefore be
     merged into GLOBAL state — an AdminPanel-local overlay dies with the
     panel and never reaches the till, which would leave a just-activated
     store still showing DRAFT (trading blocked) in the same session. */
  const applyServerStore = useCallback((row: Record<string, unknown>) => {
    const camel = fromRow(row) as unknown as StoreLocation;
    setStores((prev) => {
      const idx = prev.findIndex((st) => st.id === camel.id);
      if (idx === -1) return [...prev, camel];
      const next = [...prev];
      next[idx] = { ...next[idx], ...camel };
      return next;
    });
  }, []);

  const applyServerClassifications = useCallback((entries: { id: string; taxCode: TaxCode | null }[]) => {
    if (!entries.length) return;
    const map = new Map(entries.map((e) => [e.id, e.taxCode]));
    setMenuItems((prev) => prev.map((mi) => (map.has(mi.id)
      ? { ...mi, taxCode: map.get(mi.id) ?? null }
      : mi)));
  }, []);
  const publishVacancies = requireAuthority<CareerVacancy>('vacancies', 'Vacancies',
    withSeoRebuild('vacancies', makeCollectionPublisher('milkpop_vacancies_list', () => vacancies, setVacancies)));
  const publishStores = requireAuthority<StoreLocation>('stores', 'Stores', publishStoresRaw);
  /* SMALL-BIZ CLOSURE P0-6: the Knowledge Base is database-backed, so its
     whole-collection save carries the same hazard as every other publisher —
     saving before the DB articles arrived would overwrite them with whatever
     is in memory. Authority-guarded like the rest. */
  const publishArticles = requireAuthority<KnowledgeArticle>('articles', 'Knowledge Base',
    makeCollectionPublisher('milkpop_articles_list', () => articles, setArticles));
  const publishNewsPosts = requireAuthority<NewsPost>('news', 'News',
    withSeoRebuild('news', makeCollectionPublisher('milkpop_news_posts', () => newsPosts, setNewsPosts)));
  const publishMediaItems = requireAuthority<MediaItem>('media', 'Media library',
    makeCollectionPublisher('milkpop_media_library', () => mediaItems, setMediaItems));
  const publishDeals = requireAuthority<Deal>('deals', 'Deals',
    makeCollectionPublisher('milkpop_deals', () => deals, setDeals));
  const publishChecklistTemplates = makeCollectionPublisher('milkpop_checklist_templates', () => checklistTemplates, setChecklistTemplates);
  const publishCourses = makeCollectionPublisher('milkpop_courses', () => courses, setCourses);
  const publishAssessments = makeCollectionPublisher('milkpop_assessments', () => assessments, setAssessments);
  const publishTrainingAssignments = makeCollectionPublisher('milkpop_training_assignments', () => trainingAssignments, setTrainingAssignments);
  const publishRolePermissions = makeCollectionPublisher('milkpop_permissions_config', () => rolePermissions, setRolePermissions);
  const decideClockHistory = async (ids: string[], decision: 'approve' | 'reject'): Promise<boolean> => {
    const uniqueIds = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
    if (!uniqueIds.length) return true;
    const token = await requireToken();
    if (!token) return false;
    try {
      const confirmed = await decideTimesheetsRpc(uniqueIds, decision, token);
      const confirmedById = new Map(confirmed.map((row) => [row.id, row]));
      setClockHistory((previous) => previous.map((row) => confirmedById.get(row.id) ?? row));
      return true;
    } catch (error) {
      addToast(registryErrorMessage(error), 'error');
      return false;
    }
  };
  const publishPayslips = makeExplicitChangesPublisher('milkpop_payslips', () => payslips, setPayslips);

  /** STAGE 9 — onboarding actions go through the staff-invite Edge Function
   *  (server credentials, honest lifecycle). Local state mirrors ONLY what
   *  the server confirmed. */
  const handleStaffInvite = async (action: StaffInviteAction, employeeId: string): Promise<boolean> => {
    const token = await requireToken();
    if (!token) return false;
    const result = await staffInvite(action, employeeId, token);
    // Even a partial lifecycle response may contain one server-confirmed profile
    // state. Mirror that fact, but never invent invitation time or claim full success.
    if (result.status) {
      setEmployeesList((prev) => prev.map((e) => e.id === employeeId
        ? { ...e, status: result.status as EmployeeProfile['status'] }
        : e));
    }
    if (result.ok === false) {
      addToast(result.message, result.reconciliationRequired ? 'warning' : 'error');
      return false;
    }
    setEmployeesList((prev) => prev.map((employee) => {
      if (employee.id !== employeeId) return employee;
      const updated: EmployeeProfile = {
        ...employee,
        ...(result.onboarding ? { onboarding: result.onboarding as EmployeeProfile['onboarding'] } : {}),
        ...(result.status ? { status: result.status as EmployeeProfile['status'] } : {}),
      };
      if (result.invitedAt === null) delete updated.invitedAt;
      else if (result.invitedAt !== undefined) updated.invitedAt = result.invitedAt;
      return updated;
    }));
    if (action === 'invite') {
      addToast(result.emailSent
        ? (result.outcome === 'invitation_resent' ? 'Invitation e-mail sent again.' : 'Invitation e-mail sent.')
        : 'Existing active sign-in account linked.', result.reconciliationRequired ? 'warning' : 'success');
    }
    if (action === 'refresh') addToast('Account lifecycle refreshed from confirmed sign-in data.', result.reconciliationRequired ? 'warning' : 'success');
    if (action === 'disable') addToast(result.authAccount === 'not_applicable'
      ? 'Staff profile disabled; no sign-in account existed.'
      : 'Account disabled — the Auth ban and staff profile were confirmed.', 'warning');
    if (action === 'enable') addToast(result.authAccount === 'not_applicable'
      ? 'Staff profile re-enabled; no sign-in account exists yet.'
      : 'Account re-enabled — the Auth account and staff profile were confirmed.', 'success');
    return true;
  };

  /** STAGE 7: a staff clock-out APPENDS one history row (single confirmed
   *  insert) — it is not a collection replacement. */
  /* INC11: ONE transaction for every configuration-singleton publish. The
   * server verifies the expected revision of each part, writes both parts and
   * the audit row together, and returns the new revisions. The old per-part
   * saves below are thin wrappers so existing call sites keep their shape. */
  const publishStudioParts = async (contentPart: SiteContent | null, settingsPart: SiteSettings | null): Promise<boolean> => {
    if (!contentPart && !settingsPart) return true;
    if (settingsPart) {
      const checked = validateSiteSettings(settingsPart);
      if (!checked.ok) {
        addToast(`Website settings were not saved: ${checked.reason}.`, 'error');
        return false;
      }
      settingsPart = checked.value;
    }
    const contentChanged = !!contentPart && JSON.stringify(contentPart) !== JSON.stringify(siteContent);
    const settingsChanged = !!settingsPart && JSON.stringify(settingsPart) !== JSON.stringify(siteSettings);
    const ok = await runOp(async (token) => {
      const saved = await saveWebsiteStudio(
        settingsPart,
        contentPart,
        settingsPart ? (collectionRevisions['site_settings'] ?? null) : null,
        contentPart ? (collectionRevisions['site_content'] ?? null) : null,
        token,
      );
      setCollectionRevisions((prev) => ({
        ...prev,
        site_settings: saved.settingsRevision,
        site_content: saved.contentRevision,
      }));
    });
    if (ok && contentPart) setRawSiteContent(contentPart);
    if (ok && settingsPart) setSiteSettings(settingsPart);
    if (ok && contentPart) void runSeoRebuildAfterPublish('site-content', ok, contentChanged);
    if (ok && settingsPart) void runSeoRebuildAfterPublish('site-settings', ok, settingsChanged);
    return ok;
  };
  const handleSaveSiteContent = async (c: SiteContent): Promise<boolean> => publishStudioParts(c, null);
  const saveSiteSettings = async (next: SiteSettings | ((prev: SiteSettings) => SiteSettings)): Promise<boolean> => {
    const resolved = typeof next === 'function' ? (next as (p: SiteSettings) => SiteSettings)(siteSettings) : next;
    return publishStudioParts(null, resolved);
  };
  /** WebsiteStudio's Publish: content + settings drafts in ONE transaction. */
  const handlePublishStudio = async (contentDraft: SiteContent | null, settingsDraft: SiteSettings | null): Promise<boolean> =>
    publishStudioParts(contentDraft, settingsDraft);
  const saveEmailSettings = async (next: EmailSettings | ((prev: EmailSettings) => EmailSettings)): Promise<boolean> => {
    const resolved = typeof next === 'function' ? (next as (p: EmailSettings) => EmailSettings)(emailSettings) : next;
    const ok = await runOp((token) => appStateKv.set('milkpop_email_settings', resolved, token));
    if (ok) setEmailSettings(resolved);
    return ok;
  };
  /** Append-only audit trail. The visible stream is updated only after the
   * server confirms persistence; a failed write must never appear as audit
   * evidence merely because the browser rendered it optimistically. */
  const appendAuditLog = (entry: AuditLogItem) => {
    void runOp((token) => auditLogsRepo.appendOnly(entry, token)).then((ok) => {
      if (ok) setAuditLogs((prev) => [entry, ...prev]);
    });
  };

  /* ---- Sign-in hydration: one authenticated read per domain; RLS trims
         rows per role. Failures are VISIBLE, never silently empty. ---- */
  /** FIX (audit AUTH-001): every private collection is dropped whenever the
   *  signed-in identity CHANGES (sign-out, or a different account on a shared
   *  till). Hydration previously overwrote-but-never-cleared, so rosters,
   *  timesheets, payslips and the inbox survived logout in memory and could
   *  flash to the next user before their own (narrower) data loaded. */
  const resetPrivateState = useCallback(() => {
    setEmployeesList([]); setShiftsList([]); setClockHistory([]); setPayslips([]);
    setDocuments([]); setSifrReports([]); setApplications([]); setFranchiseInquiries([]);
    setContactMessages([]); setTrainingAssignments([]); setTrainingCertificates([]);
    setTrainingProgress([]); setAppState({});
    setAssessments(DEV_PRIVATE_SEED_CONTENT ? INITIAL_ASSESSMENTS : []);
    /* SMALL-BIZ CLOSURE P0-3: the registry previously cleared only PART of the
       identity-scoped state. On a shared kiosk or office device the next
       account could momentarily see the previous account's Knowledge Base,
       Audit Log, role-permission matrix, checklist templates, Media Library
       and CMS administrative rows, e-mail settings and collection revisions —
       every one of those is hydrated per identity and dies with it. Each
       resets to the value the app BOOTS with, so signed-out state is
       indistinguishable from a fresh anonymous load. */
    setArticles([]);
    setCourses(DEV_PRIVATE_SEED_CONTENT ? INITIAL_COURSES : []);
    setAuditLogs([]);
    setRolePermissions(DEV_PRIVATE_SEED_CONTENT ? INITIAL_ROLE_PERMISSIONS : []);
    setChecklistTemplates(DEV_PRIVATE_SEED_CONTENT ? INITIAL_CHECKLIST_TEMPLATES : []);
    setMediaItems(DEV_PRIVATE_SEED_CONTENT ? INITIAL_MEDIA_LIBRARY : []);
    setCmsPages(DEV_PRIVATE_SEED_CONTENT ? INITIAL_CMS_PAGES : []);
    setEmailSettings(DEFAULT_EMAIL_SETTINGS);
    setCollectionRevisions({});
    /* T13-3 — the five PUBLIC-FACING collections are cleared too, because
       while signed in they hold the COMPLETE authenticated rows (drafts,
       coming-soon stores, closed vacancies, inactive deals). Leaving them
       behind at an identity boundary meant a demoted manager, a transferred
       manager or the next person on a shared kiosk kept rendering the
       previous scope's out-of-scope rows until a pull happened to replace
       them. Their PublicCollection states return to `loading` so nothing
       renders as authoritative while the new scope is being established —
       a signed-out app then does a fresh anonymous pull, a signed-in one
       hydrates authenticated. */
    setMenuItems([]);
    setStores([]);
    setVacancies([]);
    setNewsPosts([]);
    setDeals([]);
    setPublicStates(allPublicStates('loading'));
  }, []);
  const lastHydratedFor = useRef<string | null>(null);

  // OPT-02E: the app's private-state reset is a REGISTERED session cleanup, so
  // logout / cross-tab identity changes purge it through one authoritative
  // mechanism (sessionCleanup registry) instead of ad-hoc call sites.
  useEffect(() => {
    registerSessionCleanup('app-private-state', () => {
      resetPrivateState();
      lastHydratedFor.current = null;
      // R4.10 Increment 5b: authority is identity-bound, so it dies with the
      // identity. Without this a snapshot hydrated as the owner would still
      // look publishable after a switch to a manager who cannot see those rows.
      clearAuthority();
    });
    return () => { unregisterSessionCleanup('app-private-state'); };
  }, [resetPrivateState]);

  useEffect(() => {
    let cancelled = false;
    // Identity boundary: wipe first, THEN (maybe) load. hydrateNonce re-runs
    // for the SAME identity keep their loaded state during the refresh.
    /* T13-2: the boundary is the SCOPE signature (id|role|storeId), so a
       demotion or a store transfer purges and rehydrates exactly like a
       different user would. */
    if (lastHydratedFor.current !== employeeScopeKey) {
      runSessionCleanup(); // purge old scope (registered cleanups) BEFORE hydrating the new one
      lastHydratedFor.current = employeeScopeKey;
    }
    if (!employee) {
      setStaffDataStatus('idle');
      /* T13-3: the cleanup above emptied the public arrays and set their
         states back to `loading`; with no identity to hydrate, the anonymous
         pull is what refills them. */
      if (isCloudConfigured()) runPublicPullRef.current?.();
      return;
    }
    if (!isCloudConfigured()) { setStaffDataStatus('error'); return; }
    setStaffDataStatus('loading');
    /* SMALL-BIZ CLOSURE P0-5 (1): every hydration ATTEMPT revokes all
       collection authority up front. Authority previously survived from the
       PREVIOUS successful hydration while a re-hydration was still in
       flight — a same-user retry that failed would leave the old grant
       standing over a snapshot the retry was meant to replace. It is
       re-granted below only for collections whose full authenticated rows
       AND ledger revision both arrived in this same completed bundle. */
    clearAuthority();
    (async () => {
      const token = await getAccessToken();
      if (!token || cancelled) { if (!cancelled) setStaffDataStatus('error'); return; }
      const bundle = await hydrateStaffData(token);
      if (cancelled) return;
      /* SMALL-BIZ CLOSURE P0-4: an unauthenticated result during hydration
         means the session is dead — return the application to sign-in
         instead of marking partial data live. signOut() clears the identity,
         which re-runs this effect and purges private state on the way. */
      if (bundle.sessionExpired) {
        addToast('Your session has expired. Sign in again.', 'error');
        setStaffDataStatus('error');
        void signOut();
        return;
      }
      if (bundle.employees) setEmployeesList(bundle.employees);
      if (bundle.shifts) setShiftsList(bundle.shifts);
      if (bundle.clockHistory) setClockHistory(bundle.clockHistory);
      if (bundle.payslips) setPayslips(bundle.payslips);
      if (bundle.documents) setDocuments(bundle.documents);
      if (bundle.sifrReports) setSifrReports(bundle.sifrReports);
      // STAGE 8: an EMPTY server collection is a valid authoritative result —
      // it replaces any in-memory defaults. (A FAILED fetch leaves the key
      // undefined and lands in bundle.failures instead.)
      if (bundle.courses) setCourses(bundle.courses);
      if (bundle.assessments) setAssessments(bundle.assessments);
      if (bundle.trainingAssignments) setTrainingAssignments(bundle.trainingAssignments);
      if (bundle.certificates) setTrainingCertificates(bundle.certificates);
      if (bundle.trainingProgress) setTrainingProgress(bundle.trainingProgress);
      // role_permissions can never be legitimately empty on a deployed DB —
      // migration_stage8_permission_seed.sql guarantees the default rows —
      // so applying an empty result is safe AND honest.
      if (bundle.rolePermissions) setRolePermissions(bundle.rolePermissions);
      if (bundle.checklistTemplates) setChecklistTemplates(bundle.checklistTemplates);
      if (bundle.auditLogs) setAuditLogs(bundle.auditLogs);
      /* R4.10 Increment 5b: every collection with a filtered public read gets
         the same treatment the menu got — the anonymous copy is replaced by the
         authenticated one, and ONLY THEN may its publisher run. Authority is
         recorded against the identity and hydration generation it came from. */
      const authUserId = String(employee?.id || '');
      const gen = hydrationGeneration + 1;
      setHydrationGeneration(gen);
      /* SMALL-BIZ CLOSURE P0-5 (4/5): authority additionally requires the
         collection's LEDGER REVISION to have arrived in this same completed
         bundle. A publisher holding rows without their revision would send
         `null` and be refused server-side anyway — but the client must not
         claim authority over a snapshot it cannot state the version of, and
         the refusal should happen BEFORE a destructive call is attempted. */
      const revMap = bundle.collectionRevisions
        ? Object.fromEntries(bundle.collectionRevisions.map((r) => [r.table_key, r.revision]))
        : null;
      const grantWithRevision = (name: CollectionName, table: string) => {
        if (revMap && revMap[table] !== undefined) grantAuthority(name, authUserId, gen);
      };
      if (bundle.menuItemsFull) {
        // R4.10 P0-2: replace the anonymous, AVAILABLE-ONLY copy with the full
        // catalogue. Until this lands, publishing would delete every hidden
        // product; the publisher below refuses to run without it.
        setMenuItems(bundle.menuItemsFull);
        grantWithRevision('menu', 'menu_items');
      }
      if (bundle.dealsFull) { setDeals(bundle.dealsFull); grantWithRevision('deals', 'deals'); }
      if (bundle.newsPostsFull) { setNewsPosts(bundle.newsPostsFull); grantWithRevision('news', 'news_posts'); }
      if (bundle.vacanciesFull) { setVacancies(bundle.vacanciesFull); grantWithRevision('vacancies', 'job_vacancies'); }
      if (bundle.cmsPagesFull) { setCmsPages(bundle.cmsPagesFull); grantWithRevision('cms', 'cms_pages'); }
      if (bundle.mediaAssetsFull) { setMediaItems(bundle.mediaAssetsFull); grantWithRevision('media', 'media_assets'); }
      /* SMALL-BIZ CLOSURE P0-6: the DATABASE Knowledge Base replaces the
         bundled seeds for the whole session; its publisher is authority-
         guarded like every other whole-collection save. */
      if (bundle.articles) { setArticles(bundle.articles); grantWithRevision('articles', 'kb_articles'); }
      if (revMap) setCollectionRevisions(revMap);
      if (bundle.storesFull) {
        // WS6f (audit F11): the authed rows carry the setup + VAT config the
        // public view hides — they replace the anonymous locator copies so
        // the till's fail-closed gate has real data to rule on.
        /* SMALL-BIZ CLOSURE P0-5 (3/4): stores JOINS the authority model —
           it was the one projection-backed collection whose publisher ran
           without proof the full authenticated rows had arrived. */
        setStores(bundle.storesFull);
        grantWithRevision('stores', 'stores');
      }
      if (bundle.appState) {
        setAppState(bundle.appState);
        const es = bundle.appState['milkpop_email_settings'];
        if (es && typeof es === 'object') setEmailSettings({ ...DEFAULT_EMAIL_SETTINGS, ...(es as Partial<EmailSettings>) });
      }
      if (bundle.failures.length) {
        setStaffDataStatus('error');
        addToast(`Some internal data could not be loaded (${bundle.failures.join(', ')}). Showing what loaded — retry from the admin panel.`, 'error');
      } else {
        setStaffDataStatus('live');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeScopeKey, hydrateNonce]);

  // Auth Operations
  //
  // SECURITY: client-side authentication is DISABLED — permanently, not just
  // "for now behind a flag". The previous implementation compared a plaintext
  // password against an employee list that lived in the browser (and in the
  // production bundle, and in localStorage, and in a world-readable database
  // table). It also skipped the password check entirely whenever the record
  // had no password set, and wrote the full profile — including the role —
  // into localStorage, where anyone could edit it into an owner session.
  //
  // Staff sign-in stays fail-closed until real server-side authentication
  // (Supabase Auth) is wired in. See README.md (Security) → "Staff authentication".
  const handleLogout = async () => {
    /* SMALL-BIZ CLOSURE P0-3 — manual logout on a shared device ends with a
       COMPLETE page reload: 1) revoke the Supabase session server-side,
       2) run every registered cleanup so no identity-scoped state survives in
       memory, 3) replace the location with the public home page. The reload
       guarantees the next person starts from a fresh anonymous boot — for a
       small-business portal that certainty is worth more than an SPA
       transition. */
    await signOut(); // hook: local-scope revoke + registry purge + cross-tab broadcast
    runSessionCleanup(); // idempotent — guarantees the full P0-3 reset even if the hook's purge already ran
    try {
      localStorage.removeItem('milkpop_session');
    } catch (e) {
      console.warn(e);
    }
    window.location.replace('/');
  };

  /**
   * Staff sign-in handler passed to the portal. Delegates entirely to the
   * Supabase Auth hook — no credential ever touches app state. Returns a
   * user-facing message; the hook has already set `employee` on success.
   */
  const handleStaffSignIn = async (email: string, password: string): Promise<string | null> => {
    const result = await signIn(email, password);
    switch (result.status) {
      case 'ok':
        setCurrentTab('staff_dashboard');
        addToast('Signed in.', 'success');
        return null;
      case 'not_configured':
        return 'Sign-in is unavailable: no authentication backend is configured for this deployment.';
      case 'invalid_credentials':
        return 'Email or password not recognised.';
      case 'mfa_required':
        // Not an error: the hook has parked the challenge in `mfaPending` and
        // the portal now renders the 6-digit code screen. Returning null keeps
        // the sign-in form from showing a red error.
        return null;
      default:
        return result.message || 'Sign-in failed. Please try again.';
    }
  };

  /**
   * Public form submissions (careers / franchise / contact).
   *
   * SECURITY / HONESTY (Phase 1 review remediation):
   *  - Nothing is written to browser storage. The completed submission is only
   *    added to in-memory React state for the current page session.
   *  - A `submitted` result is returned ONLY after the database INSERT
   *    succeeds. With no backend configured the result is `not_configured` and
   *    nothing is stored or sent. On a backend error the result is `failed`
   *    with a coarse errorCode (no raw Supabase/SQL/network text).
   *  - Inserts go through the typed, allowlisted wrappers in lib/supabase.ts.
   */
  const handleAddApplication = async (app: JobApplication, idempotencyKey: string, captchaToken: string | undefined, notice: { id: string; sha256: string }): Promise<SubmissionResult> => {
    const row = toRow(app as any);
    // Column names differ from the app fields for two reserved-ish words.
    row.applied_for = row.position; delete row.position;
    row.applied_store = row.store; delete row.store;
    // WP01.1: the key comes from the FORM's stable attempt (payload-bound) —
    // identical payload on retry reuses it; the server resolves to the
    // original row. The local `app.id` placeholder remains display-only.
    const result = await submitJobApplication(row, idempotencyKey, captchaToken, notice);
    // Reflect it in-session for admin views only when it truly reached the DB —
    // and under the SERVER's id, so a status change from the inbox targets the
    // row that actually exists (the old client id matched nothing).
    if (result.status === 'submitted') {
      setApplications((prev) => [{ ...app, id: result.submissionId }, ...prev]);
    }
    return result;
  };

  const handleUpdateApplicationStatus = async (id: string, status: JobApplication['status']): Promise<boolean> => {
    // INC11: candidacy transitions go through transition_application — the
    // row is locked, the CURRENT status we display is the expected value the
    // server compare-and-swaps against (two screens deciding the same
    // candidate: the second is told the state moved instead of silently
    // overwriting the first), and the audit row + candidate notification for
    // offer/declined are written in the SAME transaction as the change.
    const token = await requireToken();
    if (!token) return false;
    const current = applications.find((app) => app.id === id);
    if (!current) { addToast('That application is no longer loaded — refresh and retry.', 'error'); return false; }
    if (current.status === status) return true;
    try {
      await transitionApplication(id, current.status, status, token);
    } catch (e) {
      addToast(registryErrorMessage(e), 'error');
      return false;
    }
    setApplications((prev) => prev.map((app) => (app.id === id ? { ...app, status } : app)));
    return true;
  };

  const handleAddFranchise = async (fran: FranchiseInquiry, idempotencyKey: string, captchaToken: string | undefined, notice: { id: string; sha256: string }): Promise<SubmissionResult> => {
    // WP01.1: stable payload-bound key from the form; server id adopted below.
    const result = await submitFranchiseInquiry(toRow(fran as any), idempotencyKey, captchaToken, notice);
    if (result.status === 'submitted') {
      setFranchiseInquiries((prev) => [{ ...fran, id: result.submissionId }, ...prev]);
    }
    return result;
  };

  const handleUpdateFranchiseStatus = async (id: string, status: FranchiseInquiry['status']): Promise<boolean> => {
    const token = await requireToken();
    if (!token) return false;
    const result = await updateInboxStatusAuthed('franchise_inquiries', id, status, token);
    if (result !== 'ok') {
      addToast('Could not save the status change to the database.', 'error');
      return false;
    }
    setFranchiseInquiries((prev) => prev.map((f) => (f.id === id ? { ...f, status } : f)));
    return true;
  };

  const handleUpdateContactStatus = async (id: string, status: ContactMessage['status']): Promise<boolean> => {
    const current = contactMessages.find((message) => message.id === id);
    if (!current || current.status === status) return true;
    const token = await requireToken();
    if (!token) return false;
    try {
      const result = await callRpc<{ status: ContactMessage['status']; repliedAt?: string; closedAt?: string }>(
        'transition_contact_message',
        { p_id: id, p_from_status: current.status, p_to_status: status },
        token,
      );
      setContactMessages((prev) => prev.map((message) => message.id === id
        ? {
            ...message,
            status: result.status,
            ...(result.repliedAt ? { repliedAt: result.repliedAt } : {}),
            ...(result.closedAt ? { closedAt: result.closedAt } : {}),
          }
        : message));
      return true;
    } catch (error) {
      addToast('Could not update the customer message.', 'error');
      return false;
    }
  };

  const handleAddContact = async (msg: ContactMessage, idempotencyKey: string, captchaToken: string | undefined, notice: { id: string; sha256: string }): Promise<SubmissionResult> => {
    // WP01.1: stable payload-bound key from the form; server id adopted below.
    const result = await submitContactMessage(toRow(msg as any), idempotencyKey, captchaToken, notice);
    if (result.status === 'submitted') {
      setContactMessages((prev) => [{ ...msg, id: result.submissionId }, ...prev]);
    }
    return result;
  };

  /** STAGE 3 — the file goes to the `staff-doc-upload` Edge Function, which
   *  validates it, stores it in the PRIVATE bucket and confirms metadata or
   *  durable cleanup. State only reflects the row the SERVER returned. */
  const handleUploadDocument = async (
    args: { file: File; name: string; category: StaffDocument['category']; employeeId?: string },
  ): Promise<boolean> => {
    const token = await requireToken();
    if (!token) return false;
    const result = await uploadStaffDocument(args, token);
    if (result.ok === false) {
      addToast(result.message, 'error');
      return false;
    }
    setDocuments((prev) => [result.data, ...prev]);
    return true;
  };

  /** Owner-only controlled removal via the staff-doc-delete function. */
  const handleDeleteDocument = async (id: string): Promise<boolean> => {
    const token = await requireToken();
    if (!token) return false;
    const result = await deleteStaffDocument(id, token);
    if (result.ok === false) {
      addToast(result.message, 'error');
      return false;
    }
    setDocuments((prev) => prev.filter((d) => d.id !== id));
    addToast('Document removed — the private file is gone and an audit tombstone was retained.', 'success');
    return true;
  };

  const handleApproveDocument = async (id: string): Promise<boolean> => {
    const current = documents.find((d) => d.id === id);
    if (!current || !employee) return false;
    // Column-level grants let the browser change ONLY the verification fields —
    // a PATCH of exactly those fields, confirmed by the server.
    const fields = {
      status: 'approved',
      approvedBy: employee.name,
      verifiedBy: employee.id,
      verifiedAt: new Date().toISOString(),
    };
    const ok = await runOp((token) => documentsRepo.patch(id, fields, token));
    if (ok) setDocuments((prev) => prev.map((doc) => (doc.id === id ? { ...doc, status: 'approved', approvedBy: employee.name, verifiedBy: employee.id, verifiedAt: fields.verifiedAt } : doc)));
    return ok;
  };

  const handleAddSIFRReport = async (input: CreateSIFRReportInput): Promise<boolean> => {
    let created: SIFRReport | null = null;
    const ok = await runOp(async (token) => { created = await createSifrReport(input, token); });
    if (ok && created) setSifrReports((prev) => [created as SIFRReport, ...prev.filter((rep) => rep.id !== (created as SIFRReport).id)]);
    return ok;
  };

  const handleResolveSIFRReport = async (id: string): Promise<boolean> => {
    let resolved: SIFRReport | null = null;
    const ok = await runOp(async (token) => { resolved = await setSifrStatus(id, 'resolved', token); });
    if (ok && resolved) setSifrReports((prev) => prev.map((rep) => (rep.id === id ? resolved as SIFRReport : rep)));
    return ok;
  };

  const handleAddSIFRReply = async (reportId: string, msg: string): Promise<boolean> => {
    let updated: SIFRReport | null = null;
    const ok = await runOp(async (token) => { updated = await appendSifrReply(reportId, msg, token); });
    if (ok && updated) setSifrReports((prev) => prev.map((rep) => (rep.id === reportId ? updated as SIFRReport : rep)));
    return ok;
  };

  /** Replace an assignment in place (status transitions, completion stamps). */
  const handleUpdateAssignment = async (assignment: TrainingAssignment): Promise<boolean> => {
    const ok = await runOp((token) => trainingAssignmentsRepo.upsert(assignment, token));
    if (ok) setTrainingAssignments((prev) => prev.map((a) => (a.id === assignment.id ? assignment : a)));
    return ok;
  };

  /** STAGE 4: quiz completion is ONE server transaction (complete_training):
   *  ownership check, attempt record, assignment completion, idempotent
   *  certificate + reward, audit — the UI reflects only what came back. */
  const handleCompleteTraining = async (args: {
    assessmentId: string; score: number; submissionId: string; assignmentId?: string | undefined; answers?: (string | (string | null)[])[] | undefined;
  }): Promise<{ ok: boolean; passed?: boolean; score?: number; newCertificate?: boolean; certificate?: TrainingCertificate | null; pointsAwarded?: number; badgeAwarded?: string | null }> => {
    const token = await requireToken();
    if (!token) return { ok: false };
    try {
      const res = await callRpc<CompleteTrainingResult>('complete_training', {
        p_assessment_id: args.assessmentId,
        p_score: args.score,
        p_submission_id: args.submissionId,
        p_assignment_id: args.assignmentId ?? null,
        // The server grades these against the stored questions and IGNORES
        // p_score whenever they are present (migration_server_grading.sql).
        p_answers: args.answers ?? null,
      }, token);
      const passed = !!res?.passed;
      let certificate: TrainingCertificate | null = null;
      if (res?.certificate) {
        const c = res.certificate;
        certificate = {
          id: String(c.id), employeeId: String(c.employee_id), employeeName: String(c.employee_name || ''),
          assessmentId: String(c.assessment_id), assessmentTitle: String(c.assessment_title || ''),
          category: String(c.category || ''), score: Number(c.score) || 0,
          issuedAt: String(c.issued_at || new Date().toISOString()),
          emailedAt: c.emailed_at ? String(c.emailed_at) : undefined,
        };
        setTrainingCertificates((prev) => (prev.some((x) => x.id === certificate!.id) ? prev : [certificate!, ...prev]));
      }
      if (passed) {
        const nowISO = new Date().toISOString();
        setTrainingAssignments((prev) => prev.map((a) =>
          employee && a.employeeId === employee.id && a.assessmentId === args.assessmentId && a.status !== 'completed'
            ? { ...a, status: 'completed' as const, completedAt: nowISO, score: Math.max(a.score ?? 0, typeof res?.score === 'number' ? res.score : args.score) }
            : a));
        if (res?.courseId && employee) {
          const record: TrainingProgressRecord = { id: `${employee.id}:${res.courseId}`, employeeId: employee.id, courseId: String(res.courseId), progress: 100 };
          setTrainingProgress((prev) => [record, ...prev.filter((r) => r.id !== record.id)]);
        }
      }
      if (employee && typeof res?.profilePoints === 'number') {
        const updated: EmployeeProfile = {
          ...employee,
          points: res.profilePoints,
          level: typeof res.profileLevel === 'number' ? res.profileLevel : employee.level,
          badges: Array.isArray(res.profileBadges) ? res.profileBadges : employee.badges,
        };
        setEmployee(updated);
        setEmployeesList((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
      }
      return {
        ok: true,
        passed,
        ...(typeof res?.score === 'number' ? { score: res.score } : {}),
        newCertificate: !!res?.newCertificate,
        certificate,
        pointsAwarded: Number(res?.pointsAwarded) || 0,
        badgeAwarded: res?.badgeAwarded ?? null,
      };
    } catch (e) {
      addToast(registryErrorMessage(e), 'error');
      return { ok: false };
    }
  };

  /** E-mail stamp on the caller's own certificate — column-limited PATCH. */
  const handleCertificateEmailedPatch = async (certificateId: string): Promise<boolean> => {
    const stampedAt = new Date().toISOString();
    const ok = await runOp((token) => certsRepoDirect.patch(certificateId, { emailedAt: stampedAt }, token));
    if (ok) setTrainingCertificates((prev) => prev.map((c) => (c.id === certificateId ? { ...c, emailedAt: stampedAt } : c)));
    return ok;
  };

  const handleAddEmployee = async (emp: EmployeeProfile): Promise<boolean> => {
    const ok = await runOp((token) => employeesRepo.upsert(emp, token));
    if (ok) setEmployeesList((prev) => [emp, ...prev]);
    return ok;
  };

  const handleUpdateEmployee = async (emp: EmployeeProfile): Promise<boolean> => {
    const ok = await runOp((token) => employeesRepo.upsert(emp, token));
    if (ok) {
      setEmployeesList((prev) => prev.map((e) => (e.id === emp.id ? emp : e)));
      if (employee && employee.id === emp.id) setEmployee(emp);
    }
    return ok;
  };

  const handleSetHolidayAllowance = async (
    employeeId: string,
    currentAllowance: number,
    nextAllowance: number,
  ): Promise<EmployeeProfile | null> => {
    const token = await requireToken();
    if (!token) return null;
    try {
      const updated = await callRpc<EmployeeProfile>('set_staff_holiday_allowance', {
        p_employee_id: employeeId,
        p_expected_allowance: currentAllowance,
        p_allowance: nextAllowance,
      }, token);
      setEmployeesList((prev) => prev.map((profile) => profile.id === employeeId ? updated : profile));
      if (employee?.id === employeeId) setEmployee(updated);
      return updated;
    } catch (error) {
      addToast('Could not save the holiday allowance.', 'error');
      return null;
    }
  };

  const handleDeleteEmployee = async (id: string): Promise<boolean> => {
    const ok = await runOp((token) => employeesRepo.remove(id, token));
    if (ok) setEmployeesList((prev) => prev.filter((e) => e.id !== id));
    return ok;
  };

  const handleAddShift = async (shift: WorkShift): Promise<boolean> => {
    const ok = await runOp((token) => shiftsRepo.upsert(shift, token));
    if (ok) setShiftsList((prev) => [shift, ...prev]);
    return ok;
  };

  const handleDeleteShift = async (id: string): Promise<boolean> => {
    const ok = await runOp((token) => shiftsRepo.remove(id, token));
    if (ok) setShiftsList((prev) => prev.filter((s) => s.id !== id));
    return ok;
  };

  // SECURITY: the client-side "update PIN" flow was removed together with the
  // password field itself — credential changes belong to the auth backend.

  /** FIX (audit OPS-001): the clock is a SERVER state machine now. Every
   *  transition timestamp, the break total and the payroll hours come from
   *  staff_clock_action() (database now(), Europe/London business date) — the
   *  browser only says WHICH transition it wants. */
  const handleClockAction = async (
    action: 'clock_in' | 'start_break' | 'end_break' | 'clock_out',
    notes?: string,
  ): Promise<{ status: ClockStatus; history: ClockHistoryItem | null } | null> => {
    const token = await requireToken();
    if (!token) return null;
    try {
      const res = await callRpc<{ status: ClockStatus; history: ClockHistoryItem | null }>(
        'staff_clock_action', { p_action: action, p_notes: notes ?? null }, token);
      if (!res?.status) return null;
      if (res.history) {
        const item = res.history;
        setClockHistory((prev) => (prev.some((h) => h.id === item.id) ? prev : [item, ...prev]));
      }
      return { status: res.status, history: res.history ?? null };
    } catch {
      return null;
    }
  };

  /** T13.3.1 audit closure: mutate one cover-board entry under a server
   *  row lock so two colleagues cannot overwrite each other's requests. */
  const handleRequestShiftCover = async (shiftId: string, message: string): Promise<ShiftCoverBoard | null> => {
    const token = await requireToken();
    if (!token) return null;
    try {
      const res = await callRpc<{ covers?: ShiftCoverBoard }>('request_shift_cover', {
        p_shift_id: shiftId,
        p_message: message,
      }, token);
      return res?.covers && typeof res.covers === 'object' ? res.covers : {};
    } catch {
      return null;
    }
  };

  const handleRetractShiftCover = async (shiftId: string): Promise<ShiftCoverBoard | null> => {
    const token = await requireToken();
    if (!token) return null;
    try {
      const res = await callRpc<{ covers?: ShiftCoverBoard }>('retract_shift_cover', {
        p_shift_id: shiftId,
      }, token);
      return res?.covers && typeof res.covers === 'object' ? res.covers : {};
    } catch {
      return null;
    }
  };

  /** T13.3.2 audit closure: mutate one checklist task under a server row
   *  lock so simultaneous staff actions cannot replace the whole daily state. */
  const handleUpdateChecklistTask = async (
    businessDate: string,
    taskId: string,
    patch: { completed?: boolean; comment?: string; clearComment?: boolean },
  ): Promise<StoreChecklistState | null> => {
    const token = await requireToken();
    if (!token) return null;
    try {
      const res = await callRpc<{ state?: StoreChecklistState }>(
        'update_checklist_task',
        {
          p_business_date: businessDate,
          p_task_id: taskId,
          p_completed: patch.completed ?? null,
          p_comment: patch.comment ?? null,
          p_clear_comment: patch.clearComment === true,
        },
        token,
      );
      if (!res?.state || !Array.isArray(res.state.tasks)) return null;
      return res.state;
    } catch {
      return null;
    }
  };

  /** Audit append and checklist-category reset are one database transaction. */
  const handleSubmitChecklistCategory = async (
    businessDate: string,
    category: 'opening' | 'midday' | 'closing',
  ): Promise<{ state: StoreChecklistState; audits: ChecklistAuditLog[] } | null> => {
    const token = await requireToken();
    if (!token) return null;
    try {
      const res = await callRpc<{ state?: StoreChecklistState; audits?: ChecklistAuditLog[] }>(
        'submit_checklist_category',
        { p_business_date: businessDate, p_category: category },
        token,
      );
      if (!res?.state || !Array.isArray(res.state.tasks) || !Array.isArray(res.audits)) return null;
      return { state: res.state, audits: res.audits };
    } catch {
      return null;
    }
  };

  /** FIX (audit OPS-002): claiming a cover shift is ONE server transaction
   *  (claim_shift): eligibility checks, reassignment and advert close are
   *  atomic — no more three-step client sequence that ordinary team members'
   *  policies could never complete anyway. */
  const handleClaimShift = async (
    shiftId: string,
  ): Promise<{ newShift: WorkShift; covers: Record<string, unknown> } | null> => {
    const token = await requireToken();
    if (!token) return null;
    try {
      const res = await callRpc<ClaimShiftResult>('claim_shift', { p_shift_id: shiftId }, token);
      const row = res?.newShift;
      if (!row?.id) return null;
      const newShift: WorkShift = {
        id: String(row.id),
        employeeId: String(row.employee_id || ''),
        employeeName: String(row.employee_name || ''),
        role: row.role,
        storeId: String(row.store_id || ''),
        storeName: String(row.store_name || ''),
        date: String(row.date || ''),
        startTime: String(row.start_time || ''),
        endTime: String(row.end_time || ''),
        type: row.type,
        notes: row.notes ? String(row.notes) : undefined,
      };
      setShiftsList((prev) => [newShift, ...prev.filter((sh) => sh.id !== String(res.removedShiftId))]);
      return { newShift, covers: (res.covers && typeof res.covers === 'object' ? res.covers : {}) as Record<string, unknown> };
    } catch {
      return null;
    }
  };

  /* T13.3.23: deferred POS source remains in its own modules, but the public
     application no longer hydrates orders, reads the legacy outbox or mounts
     any order controller while POS routes are absent. */

  const optionalPublicSectionPending = optionalSectionRequested(currentTab)
    && publicConfigurationStatus === 'loading';
  const optionalPublicSectionDisabled = optionalSectionRequested(currentTab)
    && !optionalPublicSectionPending
    && !optionalSectionPublished(currentTab, siteSettings);

  return (
    /* LAUNCH POLISH — respect the visitor's reduced-motion setting.
       src/index.css already disables the CSS keyframe animations (.mp-float,
       .mp-bob, .mp-wave, .mp-drift, smooth scrolling) under
       `prefers-reduced-motion: reduce`, but a media query cannot reach the
       JS-driven motion/react animations, and the public pages alone use 22 of
       them. `reducedMotion="user"` makes every one of them follow the same OS
       setting — one wrapper instead of touching each animation, and nothing
       changes for visitors who have not asked for reduced motion. */
    <MotionConfig reducedMotion="user">
    <div className="bg-[#FFFFFF] min-h-screen text-[#2E2A26] font-sans antialiased flex flex-col justify-between">
      {/* Owner-editable announcement ribbon (Admin Panel → Company Settings) */}
      {siteSettings.announcementEnabled && siteSettings.announcementText.trim() && currentTab !== 'admin_panel' && !isStaffMode && (
        <div className="bg-[#7CC0C7] text-[#2E2A26] text-center text-xs font-bold tracking-wide py-2 px-4">
          {siteSettings.announcementText.trim()}
        </div>
      )}

      {/* Dynamic sticky/blur Navigation header */}
      {/* LAUNCH-POLISH (R4.6): skip link. Keyboard and screen-reader users had
          to traverse the whole navigation on every route change before they
          reached the content. It is visually hidden until focused, so it costs
          pointer users nothing. WCAG 2.1 SC 2.4.1 (Bypass Blocks). */}
      <a
        href="#main-content"
        className="mp-skip-link"
      >
        Skip to main content
      </a>

      {currentTab !== 'admin_panel' && (
        <Navbar
          currentTab={currentTab}
          setCurrentTab={setCurrentTab}
          employee={employee}
          onLogout={handleLogout}
          isStaffMode={isStaffMode}
          setIsStaffMode={setIsStaffMode}
          content={siteContent}
          settings={siteSettings}
        />
      )}

      {/* Main Container Workspace */}
      <main id="main-content" tabIndex={-1} className="flex-grow">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentTab}
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -15 }}
            transition={{ duration: 0.25 }}
          >
            {/* Router check - admin panel versus staff versus public guest space */}
            {/* SECURITY: the Admin Panel previously rendered for ANYONE who set
                currentTab to 'admin_panel', falling back to fake
                "Administrator Override" / "HQ OWNER" identities. It is now
                hard-gated on an authenticated manager/owner session. */}
            {currentTab === 'admin_panel' && (!employee || !['owner', 'store_manager'].includes(employee.role)) ? (
              <div className="max-w-md mx-auto py-24 px-4 text-center space-y-4">
                <div className="bg-white p-10 rounded-3xl border border-[#EBDECE] shadow-sm space-y-3">
                  <h2 className="text-xl font-bold tracking-tight text-[#2E2A26]">Access restricted</h2>
                  <p className="text-xs text-neutral-500 leading-relaxed">
                    The management panel requires an authenticated owner or store-manager session.{' '}
                    {authConfigured
                      ? 'Sign in through the Staff Portal with an owner or store-manager account, then return here.'
                      : 'Staff sign-in is unavailable because this deployment is not connected to its authentication service.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => setCurrentTab('home')}
                    className="px-5 py-2.5 bg-[#2E2A26] hover:bg-[#A46832] text-white rounded-full text-2xs font-extrabold uppercase tracking-wider transition-all cursor-pointer"
                  >
                    Back to the website
                  </button>
                </div>
              </div>
            ) : currentTab === 'admin_panel' ? (
              <Suspense fallback={<PortalLoading label="Opening the management panel…" />}>
              <AdminPanel
                employee={employee}
                getAccessToken={getAccessToken}
                activeSection={routeParams.section}
                onSectionChange={handleAdminSectionChange}
                applications={applications}
                onUpdateApplicationStatus={handleUpdateApplicationStatus}
                franchiseInquiries={franchiseInquiries}
                onUpdateFranchiseStatus={handleUpdateFranchiseStatus}
                inboxStatus={inboxStatus}
                onRefreshInbox={refreshInbox}
                sifrReports={sifrReports}
                onResolveSIFRReport={handleResolveSIFRReport}
                documents={documents}
                onApproveDocument={handleApproveDocument}
                onDeleteDocument={handleDeleteDocument}
                addToast={addToast}
                employeesList={employeesList}
                shiftsList={shiftsList}
                onAddEmployee={handleAddEmployee}
                onStaffInvite={handleStaffInvite}
                onUpdateEmployee={handleUpdateEmployee}
                onSetHolidayAllowance={handleSetHolidayAllowance}
                onAddShift={handleAddShift}
                onDeleteShift={handleDeleteShift}
                setCurrentTab={setCurrentTab}
                menuItems={menuItems}
                publishMenuItems={publishMenuItems}
                stores={stores}
                publishStores={publishStores}
                applyServerStore={applyServerStore}
                applyServerClassifications={applyServerClassifications}
                vacancies={vacancies}
                publishVacancies={publishVacancies}
                articles={articles}
                publishArticles={publishArticles}
                newsPosts={newsPosts}
                publishNewsPosts={publishNewsPosts}
                onPublishRecord={publishRecord}
              onCloseVacancy={closeVacancy}
                siteContent={siteContent}
                onPublishStudio={handlePublishStudio}
                mediaItems={mediaItems}
                publishMediaItems={publishMediaItems}
                auditLogs={auditLogs}
                appendAuditLog={appendAuditLog}
                contactMessages={contactMessages}
                onUpdateContactStatus={handleUpdateContactStatus}
                assessments={assessments}
                publishAssessments={publishAssessments}
                trainingAssignments={trainingAssignments}
                publishTrainingAssignments={publishTrainingAssignments}
                trainingCertificates={trainingCertificates}
                deals={deals}
                publishDeals={publishDeals}
                siteSettings={siteSettings}
                saveSiteSettings={saveSiteSettings}
                checklistTemplates={checklistTemplates}
                publishChecklistTemplates={publishChecklistTemplates}
                cloudStatus={cloudStatus}
                seoRebuildStatus={seoRebuildStatus}
                seoDeploymentMode={clientDeploymentMode()}
                onManualSeoRebuild={handleManualSeoRebuild}
                clockHistory={clockHistory}
                decideTimesheets={decideClockHistory}
                payslips={payslips}
                publishPayslips={publishPayslips}
                emailSettings={emailSettings}
                saveEmailSettings={saveEmailSettings}
                staffDataStatus={staffDataStatus}
                onRetryHydration={retryHydration}
                onRefreshPublicContent={refreshPublicContent}
              />
              </Suspense>
            ) : (currentTab.startsWith('staff_') || currentTab === 'staff_login') ? (
              <Suspense fallback={<PortalLoading label="Opening the staff portal…" />}>
              <StaffPortal
                key={staffPortalScopeKey}
                /* SECURITY: without a session every staff_* tab collapses to
                   the sign-in notice — no partial staff UI leaks to guests. */
                currentTab={employee ? currentTab : (mfaPending ? 'staff_mfa' : 'staff_login')}
                setCurrentTab={setCurrentTab}
                employee={employee}
                /* SMALL-BIZ CLOSURE P0-6: the database Knowledge Base. */
                articles={articles}
                onSignIn={handleStaffSignIn}
                mfaPending={mfaPending}
                onSubmitMfaCode={submitMfaCode}
                onCompleteMfaEnrolment={completeMfaEnrolment}
                onCancelMfa={cancelMfa}
                authConfigured={authConfigured}
                authLoading={authLoading}
                onCompleteTraining={handleCompleteTraining}
                assessments={assessments}
                trainingAssignments={trainingAssignments}
                onUpdateAssignment={handleUpdateAssignment}
                trainingCertificates={trainingCertificates}
                onCertificateEmailed={handleCertificateEmailedPatch}
                documents={documents}
                onUploadDocument={handleUploadDocument}
                sifrReports={sifrReports}
                onAddSIFRReport={handleAddSIFRReport}
                onAddSIFRReply={handleAddSIFRReply}
                addToast={addToast}
                shiftsList={shiftsList}
                stores={stores}
                checklistTemplates={checklistTemplates}
                clockHistory={clockHistory}
                onClockAction={handleClockAction}
                onRequestShiftCover={handleRequestShiftCover}
                onRetractShiftCover={handleRetractShiftCover}
                onClaimShift={handleClaimShift}
                onUpdateChecklistTask={handleUpdateChecklistTask}
                onSubmitChecklistCategory={handleSubmitChecklistCategory}
                payslips={payslips}
                appState={appState}
                staffDataStatus={staffDataStatus}
                onRetryHydration={retryHydration}
              />
              </Suspense>
            ) : optionalPublicSectionPending ? (
              <PortalLoading label="Loading this website section…" />
            ) : (currentTab === 'not_found' || optionalPublicSectionDisabled) ? (
              /* R4.7: a real not-found view. Rendered here rather than routed
                 through PublicPages, so an unknown tab can never fall through
                 that component's own switch and silently render the homepage
                 again — which is the failure mode this whole change exists to
                 remove. */
              <div className="min-h-[60vh] flex items-center justify-center px-6 py-20">
                <div className="max-w-lg text-center space-y-6">
                  <p className="font-display text-xs uppercase font-black tracking-[0.2em] text-[#A46832]">
                    404
                  </p>
                  <h1 className="font-display text-3xl font-black text-[#2E2A26]">
                    We couldn&apos;t find that page
                  </h1>
                  <p className="text-sm text-[#2E2A26]/80 leading-relaxed">
                    The link may be out of date, or the address may have a typo in it.
                    Nothing has gone wrong on your side.
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                    <button
                      onClick={() => setCurrentTab('home')}
                      className="mp-notfound-action bg-[#A46832] text-white rounded-full px-6 text-xs font-black uppercase tracking-wider hover:bg-[#A46832] transition-colors"
                    >
                      Back to home
                    </button>
                    <button
                      onClick={() => setCurrentTab('menu')}
                      className="mp-notfound-action bg-white border border-[#EBDECE] text-[#2E2A26] rounded-full px-6 text-xs font-black uppercase tracking-wider hover:bg-[#F5EFE7] transition-colors"
                    >
                      See the menu
                    </button>
                    <button
                      onClick={() => setCurrentTab('contact')}
                      className="mp-notfound-action bg-white border border-[#EBDECE] text-[#2E2A26] rounded-full px-6 text-xs font-black uppercase tracking-wider hover:bg-[#F5EFE7] transition-colors"
                    >
                      Contact us
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <PublicPages
                currentTab={currentTab}
                setCurrentTab={setCurrentTab}
                routeParams={routeParams}
                onAddApplication={handleAddApplication}
                privacyNotices={publicPrivacyNotices}
                onAddFranchise={handleAddFranchise}
                onAddContact={handleAddContact}
                addToast={addToast}
                // SMALL-BIZ CLOSURE P0-2: EVERY public collection passes
                // through the shared projection helper, which applies exactly
                // the anonymous database views' rules — signed-in and
                // anonymous visitors see identical published records. Drafts
                // remain visible in Admin and nowhere else. (Defence in
                // depth — anonymously the view has already filtered.)
                menuItems={asPublic('menu', projectPublicMenuItems(menuItems))}
                stores={asPublic('stores', projectPublicStores(stores))}
                vacancies={asPublic('vacancies', projectPublicVacancies(vacancies))}
                news={asPublic('news', projectPublicNews(newsPosts))}
                employee={employee}
                content={siteContent}
                onSaveContent={handleSaveSiteContent}
                deals={asPublic('deals', projectPublicDeals(deals))}
                siteSettings={siteSettings}
                dataFreshness={publicConfigurationStatus}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Brand bottom footer layout */}
      {((isIndexableTab(currentTab) && !optionalPublicSectionDisabled) || currentTab === 'not_found') && (
        <Footer setCurrentTab={setCurrentTab} setIsStaffMode={setIsStaffMode} settings={siteSettings} content={siteContent} />
      )}

      {/* Toast Notification Stack Overlay
          LAUNCH-POLISH (R4.6): every public form result — contact sent,
          application received, submission failed — is delivered ONLY through
          this stack. Without a live region a screen-reader user submitted a
          form and heard nothing at all, with no way to tell success from
          failure. The container is the live region (not the individual toast)
          because a region must exist in the DOM BEFORE its content changes for
          the change to be announced. `polite` rather than `assertive`: these
          confirm an action the user just took, so they should not interrupt.
          role="status" carries the same meaning for older assistive tech. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="fixed bottom-4 left-4 right-4 z-[100] w-auto space-y-3 pointer-events-none sm:bottom-6 sm:left-auto sm:right-6 sm:max-w-sm sm:w-full"
      >
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 50, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 50, scale: 0.9 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              className={`p-4 rounded-2xl shadow-xl flex items-start space-x-3 pointer-events-auto border ${
                toast.type === 'success'
                  ? 'bg-emerald-50 border-[#5FA777]/30 text-[#2E2A26]'
                  : toast.type === 'warning'
                  ? 'bg-amber-50 border-[#F4B740]/30 text-[#2E2A26]'
                  : toast.type === 'info'
                  ? 'bg-sky-50 border-sky-200 text-[#2E2A26]'
                  : 'bg-red-50 border-red-200 text-[#2E2A26]'
              }`}
            >
              <div className="shrink-0 mt-0.5">
                {toast.type === 'success' ? (
                  <CheckCircle className="h-5 w-5 text-[#5FA777]" />
                ) : toast.type === 'warning' ? (
                  <AlertCircle className="h-5 w-5 text-[#F4B740]" />
                ) : toast.type === 'info' ? (
                  <Info className="h-5 w-5 text-sky-500" />
                ) : (
                  <AlertCircle className="h-5 w-5 text-red-500" />
                )}
              </div>
              <div className="flex-1 text-[11px] leading-relaxed">
                {toast.message}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
    </MotionConfig>
  );
}
