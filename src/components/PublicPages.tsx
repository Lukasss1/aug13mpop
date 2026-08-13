/**
 * @file PublicPages.tsx
 * @description The main public-facing customer view, acting as the store-front.
 * 
 * ARCHITECTURE & CMS INTEGRATION:
 * This component handles rendering all public-facing elements: Home, Menus, Store Locator, and Forms.
 * It also includes "Live Editing Mode" via the `isEditingMode` flag. If a staff member with 
 * correct privileges logs in, they can visually edit the website content model locally. Menu products are edited only in Admin → Menu Items, so the public projection can never be used as a destructive catalogue snapshot.
 * 
 * Recommended Next Steps for Developers:
 * 1. Component Extraction: Abstract each tab (`renderHome`, `renderMenu`, `renderLocations`)
 *    into separate dedicated files (`HomeView.tsx`, `MenuView.tsx`).
 * 2. Search Engine Optimization (SEO): App.tsx now injects the per-page
 *    `seo` titles/descriptions from the SiteContent model into the HTML `<head>`.
 */
import React, { useState, useEffect, useMemo } from 'react';
import {
  RouteParams, NavigateFn, routeToPath, handleAnchorNav,
  matchBySlug, storeSlug, vacancySlug, postSlug,
} from '../lib/router';
import { motion } from 'motion/react';
import type { PrivacyNoticeCurrent, SubmissionResult } from '../types';
import { TurnstileWidget, useTurnstile } from './TurnstileWidget';
import { safeExternalHref, safeMailtoHref, safePolicyHref, safeTelHref } from '../lib/safeUrl';
import { displayCurrencySymbol } from '../lib/businessFormatting';
import { publicStoreStatusLabel } from '../lib/publishRules';
import { usePublicSubmission } from '../hooks/usePublicSubmission';
import { useStableSubmissionAttempt } from '../lib/useStableSubmissionAttempt';
import { CAREERS_CV_UPLOAD, CONFIRMED_CONTACT_EMAIL } from '../lib/featureFlags';
import { Sparkles, MapPin, Clock, Phone, Search, CheckCircle, ArrowRight, ChevronRight, ShieldAlert, ExternalLink, Award, Users, FileCheck, Calendar, Star, Leaf, Heart, Coffee } from 'lucide-react';
import { MenuItem, StoreLocation, CareerVacancy, JobApplication, FranchiseInquiry, ContactMessage, NewsPost, EmployeeProfile, Deal, SiteSettings, PublicCollection, collectionItems } from '../types';

/**
 * R4.9 G4 — what the public menu renders when the database has not answered.
 * Deliberately carries NO product names and NO prices: an outage must never be
 * filled in with anything that looks like a real catalogue, which is exactly
 * what the src/data.ts fallback used to do. The in-store route to allergen
 * information is kept, because that is the one answer that is always true.
 */
function MenuUnavailable({ status }: { status: PublicCollection<MenuItem>['status'] }) {
  const loading = status === 'loading';
  return (
    <div role="status" className="text-center py-16 bg-white rounded-3xl border border-[#EBDECE]/40 space-y-2">
      <ShieldAlert className="h-10 w-10 text-[#A46832] mx-auto" />
      <h3 className="text-sm font-bold">{loading ? 'Loading the menu\u2026' : 'Menu temporarily unavailable'}</h3>
      <p className="text-2xs mp-muted max-w-sm mx-auto">
        {loading
          ? 'One moment while we fetch today\u2019s drinks.'
          : 'We could not load the menu just now \u2014 please try again shortly, or ask our team in store. They can tell you what is available today, including allergen information.'}
      </p>
    </div>
  );
}

/** Clear customer-facing price labels. A slash-separated pair made visitors
 * guess which amount was regular and which was large. */
function MenuPriceBlock({ item, currencySymbol }: { item: MenuItem; currencySymbol: string }) {
  if (item.priceLarge == null) {
    return <span className="font-mono font-bold text-sm text-[#A46832]">{currencySymbol}{item.price.toFixed(2)}</span>;
  }
  return (
    <div className="text-right shrink-0 leading-tight space-y-0.5" aria-label={`Regular ${currencySymbol}${item.price.toFixed(2)}, Large ${currencySymbol}${item.priceLarge.toFixed(2)}`}>
      <span className="block whitespace-nowrap text-[10px] font-bold text-[#2E2A26]/70">
        Regular <span className="font-mono text-xs text-[#A46832]">{currencySymbol}{item.price.toFixed(2)}</span>
      </span>
      <span className="block whitespace-nowrap text-[10px] font-bold text-[#2E2A26]/70">
        Large <span className="font-mono text-xs text-[#A46832]">{currencySymbol}{item.priceLarge.toFixed(2)}</span>
      </span>
    </div>
  );
}
import { SiteContent } from '../siteContent';
import { uploadCv, type CvUploadResult } from '../lib/supabase';

/** SMALL-BIZ CLOSURE P0-7 — the shared honest-status panel for the public
 *  collections. Marketing empty copy ("Coming Soon", "No Open Roles", "There
 *  is no news yet") may only render when the database GENUINELY answered
 *  with zero records; loading and unavailable are their own visible states,
 *  so a technical outage is never presented as a business fact. */
function CollectionStatusNote({ status, label }: { status: 'loading' | 'unavailable'; label: string }) {
  const loading = status === 'loading';
  return (
    <div role="status" className="bg-white p-6 rounded-3xl border border-[#EBDECE] text-center py-10">
      <p className="text-xs font-bold uppercase">{loading ? `Loading ${label}\u2026` : 'Temporarily unavailable'}</p>
      <p className="text-2xs text-[#8F5322] mt-1">
        {loading
          ? 'One moment.'
          : `We could not load ${label} just now \u2014 please try again shortly, or contact us and we\u2019ll help directly.`}
      </p>
    </div>
  );
}
import { LogoVertical, DripEdge, MASCOT, STICKERS } from '../brand';
import { resolveMenuImage, hasRealImage } from '../drinkArt';
import { resolveMediaUrl } from '../lib/mediaUpload';
import { ImageUploadInline } from './ImageUploadInline';
import { PublicWebsiteEditBar } from './PublicWebsiteEditBar';

/* R4.10 Increment 2: the FALLBACK_NEWS_POSTS constant was removed.
 * It shipped a fabricated 'Welcome to Milk Pop' article that appeared on the
 * public news page of a site that had published nothing. An earlier round had
 * already cut three invented press stories down to this one; Increment 2 removes
 * the last of them. The news page now renders an honest empty state. */

interface PublicPagesProps {
  currentTab: string;
  /** URL-aware navigate — legacy `(tab) => void` calls still work; richer
   *  calls pass route params (store/job/post slugs, menu filters). */
  setCurrentTab: NavigateFn;
  /** Params parsed from the current URL (see src/lib/router.ts). */
  routeParams?: RouteParams;
  // WP-02: an optional Turnstile token rides with each submission; App.tsx
  // forwards it to the Edge Function, which enforces it when a secret is set.
  // WP01.1: the STABLE attempt key travels from the form (where the payload
  // lives and rotation is decided) — App.tsx no longer mints keys itself.
  onAddApplication: (app: JobApplication, idempotencyKey: string, captchaToken: string | undefined, notice: { id: string; sha256: string }) => Promise<SubmissionResult>;
  onAddFranchise: (fran: FranchiseInquiry, idempotencyKey: string, captchaToken: string | undefined, notice: { id: string; sha256: string }) => Promise<SubmissionResult>;
  onAddContact: (msg: ContactMessage, idempotencyKey: string, captchaToken: string | undefined, notice: { id: string; sha256: string }) => Promise<SubmissionResult>;
  /* INC11: current published notice per audience — each form RENDERS its own
   * and echoes id+sha on submit; a missing entry closes that form. */
  privacyNotices: PrivacyNoticeCurrent[];
  addToast: (msg: string, type: 'success' | 'warning' | 'error' | 'info') => void;
  /** R4.9 G4: a STATE, never a bare array. There is no member of this union that
   *  means "nothing loaded, use the built-in seeds", so the `|| INITIAL_X`
   *  fallback that shipped seed products and prices to customers on a failed
   *  fetch cannot be reintroduced here — it does not typecheck. */
  menuItems: PublicCollection<MenuItem>;
  stores: PublicCollection<StoreLocation>;
  vacancies: PublicCollection<CareerVacancy>;
  /* SMALL-BIZ CLOSURE P0-7: news was the one public collection still passed
     as a PLAIN ARRAY, so a failed fetch was indistinguishable from an empty
     archive and rendered as "no news has been published". It now carries the
     same loading | ready | unavailable state as every other collection. */
  news: PublicCollection<NewsPost>;
  employee?: EmployeeProfile | null;
  /** The single content model behind every headline/image/label on this page. */
  content: SiteContent;
  /** Publishes on-page edit-mode changes (same store the Website Studio uses). */
  onSaveContent?: (c: SiteContent) => Promise<boolean>;
  deals: PublicCollection<Deal>;
  siteSettings: SiteSettings;
  dataFreshness: 'loading' | 'ready' | 'stale' | 'unavailable';
}

export const PublicPages: React.FC<PublicPagesProps> = ({
  currentTab,
  setCurrentTab,
  routeParams,
  onAddApplication,
  onAddFranchise,
  onAddContact,
  privacyNotices,
  addToast,
  menuItems,
  stores,
  vacancies,
  news,
  employee,
  content,
  onSaveContent,
  deals,
  siteSettings,
  dataFreshness,
}) => {
  const [isEditingMode, setIsEditingMode] = useState(false);
  const currencySymbol = displayCurrencySymbol(siteSettings.currencySymbol);

  // ---- Motion system (Apple-style springs) ----
  const springRise = {
    hidden: { opacity: 0, y: 36 },
    show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 90, damping: 16 } }
  };
  const heroStagger = {
    hidden: {},
    show: { transition: { staggerChildren: 0.1, delayChildren: 0.05 } }
  };
  const Reveal: React.FC<{ children: React.ReactNode; delay?: number; className?: string }> = ({ children, delay = 0, className }) => (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 34 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ type: 'spring', stiffness: 80, damping: 18, delay }}
    >
      {children}
    </motion.div>
  );
  const [draftContent, setDraftContent] = useState<SiteContent>(content);

  // Keep the draft following the published content until editing mode starts
  useEffect(() => {
    if (!isEditingMode) {
      setDraftContent(content);
    }
  }, [content, isEditingMode]);

  const activeMenuItems = collectionItems(menuItems);
  const activeStores = collectionItems(stores);
  const [serverClosedVacancyIds, setServerClosedVacancyIds] = useState<string[]>([]);
  const activeVacancies = useMemo(
    () => collectionItems(vacancies).filter((vacancy) => !serverClosedVacancyIds.includes(vacancy.id)),
    [vacancies, serverClosedVacancyIds],
  );
  /** Menu cards always render from the public, read-only projection. Editing the
   *  website must never turn that projection into a catalogue write snapshot. */
  const menuReady = menuItems.status === 'ready';

  /** Offers are public price claims: show none rather than a seeded one. */
  const activeDeals = deals.status === 'ready' ? deals.items.filter((d) => d.active) : [];


  // Menu tab state filters — initialised from the URL (/menu?category=&q=)
  // and written back with replaceState so a filtered view is shareable without
  // flooding the history stack.
  const [menuSearch, setMenuSearch] = useState(() => routeParams?.q ?? '');
  const [selectedCategory, setSelectedCategory] = useState<string>(() => routeParams?.category ?? 'all');

  const syncMenuUrl = (next: { category?: string; q?: string }) => {
    const category = next.category ?? selectedCategory;
    const q = next.q ?? menuSearch;
    setCurrentTab('menu', {
      ...(category !== 'all' ? { category } : {}),
      ...(q ? { q } : {}),
    }, { replace: true, keepScroll: true });
  };

  // Back/forward while staying on /menu: adopt the filters from the URL.
  useEffect(() => {
    if (currentTab !== 'menu') return;
    setSelectedCategory(routeParams?.category ?? 'all');
    setMenuSearch(routeParams?.q ?? '');
  }, [routeParams?.category, routeParams?.q, currentTab]);

  // Store locator state
  const [storeSearch, setStoreSearch] = useState('');
  const [activeStoreId, setActiveStoreId] = useState<string>(() => {
    const fromUrl = matchBySlug(activeStores, routeParams?.store, (st: StoreLocation) => storeSlug(st), (st: StoreLocation) => st.id);
    /* SMALL-BIZ CLOSURE P0-9: the fallback is the first REAL public store, or
       an empty selection when none exists yet — never the hardcoded 's1',
       which stopped being guaranteed to exist the day a second store (or a
       renamed first store) became possible. */
    return fromUrl?.id ?? activeStores[0]?.id ?? '';
  });

  /* T13-5 — THE SELECTION MUST SURVIVE ASYNCHRONOUS ARRIVAL.
     The initial value is computed during the FIRST render, when the store
     collection is still loading and `activeStores` is empty — so it resolved
     to '' and the correcting effect only re-ran on a URL change, never when
     the stores actually arrived. A visitor landing on /stores therefore saw
     no store selected until they clicked something.
     This effect depends on the LIST as well as the slug, and applies the
     required precedence:
       1. a valid route slug wins;
       2. otherwise keep the current store while it still exists;
       3. otherwise the first real public store;
       4. no public store ⇒ empty selection (never a fictional fallback). */
  useEffect(() => {
    const fromUrl = matchBySlug(activeStores, routeParams?.store, (st: StoreLocation) => storeSlug(st), (st: StoreLocation) => st.id);
    if (fromUrl) {
      if (fromUrl.id !== activeStoreId) setActiveStoreId(fromUrl.id);
      return;
    }
    if (activeStoreId && activeStores.some((st) => st.id === activeStoreId)) return;
    setActiveStoreId(activeStores[0]?.id ?? '');
  }, [routeParams?.store, activeStores, activeStoreId]);

  // Form states - Careers — selection is URL-driven (/careers/:slug); with no
  // slug the first vacancy is shown WITHOUT rewriting the URL, so /careers
  // stays the canonical listing address.
  const [selectedJob, setSelectedJob] = useState<CareerVacancy | null>(() =>
    matchBySlug(activeVacancies, routeParams?.job, (v: CareerVacancy) => vacancySlug(v), (v: CareerVacancy) => v.id) ?? null
  );

  useEffect(() => {
    const fromUrl = matchBySlug(activeVacancies, routeParams?.job, (v: CareerVacancy) => vacancySlug(v), (v: CareerVacancy) => v.id);
    if (fromUrl && fromUrl.id !== selectedJob?.id) setSelectedJob(fromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeParams?.job, activeVacancies]);

  /* T13-4 — THE SELECTED VACANCY MUST FOLLOW THE COLLECTION.
     Previously the selection was only ever ADDED to: once a vacancy was
     chosen it survived being closed, moved to draft, deleted, or the whole
     collection going unavailable, so its details and application form kept
     rendering. Combined with the `|| 'Team Member'` fallback below, a
     candidate could submit an application against a role that no longer
     exists — recorded under a generic position nobody advertised.
     One effect owns the lifecycle, in the required order:
       1. collection not ready  → no selection (nothing stale on screen);
       2. selection still live  → keep it;
       3. otherwise             → first active vacancy;
       4. none left             → null. */
  useEffect(() => {
    if (vacancies.status !== 'ready') {
      if (selectedJob !== null) setSelectedJob(null);
      return;
    }
    if (selectedJob && activeVacancies.some((v) => v.id === selectedJob.id)) return;
    const fromUrl = matchBySlug(activeVacancies, routeParams?.job, (v: CareerVacancy) => vacancySlug(v), (v: CareerVacancy) => v.id);
    setSelectedJob(fromUrl ?? activeVacancies[0] ?? null);
  }, [vacancies.status, activeVacancies, selectedJob, routeParams?.job]);
  const [careerForm, setCareerForm] = useState({
    fullName: '',
    email: '',
    phone: '',
    experience: '',
    preferredStore: '',
    availability: '',
    message: ''
  });
  // SECURITY: the chosen CV is held ONLY as a transient in-memory File reference
  // for the duration of one submission. It is never base64-encoded, never put in
  // app state that persists, and never written to localStorage — it is handed
  // straight to the cv-upload Edge Function and then cleared. (No cvData/cvUrl.)
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [cvError, setCvError] = useState<string>('');
  // WP-02: one Turnstile handle + one pending-locked submitter per form.
  // The lock replaces the old ad-hoc submittingApp flag and extends the same
  // double-submit protection to Franchise and Contact (which had none).
  const tsCareers = useTurnstile();
  const tsFranchise = useTurnstile();
  const tsContact = useTurnstile();
  const subCareers = usePublicSubmission(tsCareers);
  const subFranchise = usePublicSubmission(tsFranchise);
  const subContact = usePublicSubmission(tsContact);
  // WP01.1: one stable attempt (idempotency key bound to the payload) per
  // form. Same payload → same key → a retry resolves to the ORIGINAL row;
  // edited payload or confirmed success → fresh key.
  const attCareers = useStableSubmissionAttempt();
  const attFranchise = useStableSubmissionAttempt();
  const attContact = useStableSubmissionAttempt();
  // §6.4: the CV survives a failed attach — submission id + file are retained
  // until the upload succeeds or the person explicitly continues without it.
  const [cvRetry, setCvRetry] = useState<{ submissionId: string } | null>(null);

  // Form states - Franchise
  const [franchiseForm, setFranchiseForm] = useState({
    fullName: '',
    email: '',
    phone: '',
    country: 'United Kingdom',
    city: '',
    budget: '',
    experience: '',
    message: ''
  });

  // Form states - Contact
  const [contactForm, setContactForm] = useState({
    fullName: '',
    email: '',
    reason: 'General feedback',
    message: ''
  });

  // Handlers

  /**
   * A confirmed, monitored business inbox offered as a fallback ONLY after a
   * genuine submission failure. Sourced from the validated deployment config
   * (VITE_CONFIRMED_CONTACT_EMAIL, via featureFlags → CONFIRMED_CONTACT_EMAIL);
   * blank by default so the site never invents an inbox, and the production
   * validator requires a syntactically valid address when it is set (C1.3,
   * finding #6). The owner-editable `siteSettings.email` is deliberately NOT
   * used here — it is configuration, not a verified monitored contact.
   */

  /* INC11: the notice a given form must render and echo. */
  const noticeFor = (audience: PrivacyNoticeCurrent['audience']): PrivacyNoticeCurrent | null =>
    privacyNotices.find((n) => n.audience === audience) ?? null;

  /* INC11: rendered inside each public form, above its submit button. What is
   * DISPLAYED here is exactly what the submission records (id + sha echoed to
   * the transactional gate), so this block is part of the evidence chain, not
   * decoration. When no notice is published the form is CLOSED — collecting
   * personal data without stating the terms is the thing we refuse to do. */
  const NoticeBlock = ({ audience }: { audience: PrivacyNoticeCurrent['audience'] }) => {
    const n = noticeFor(audience);
    const policyHref = n ? safePolicyHref(n.policyUrl) : undefined;
    if (!n) {
      return (
        <div className="rounded-2xl border-2 border-dashed border-[#EBDECE] bg-[#FBF7F1] p-4 text-sm text-[#7A6A55]">
          This form is temporarily closed while its privacy notice is being updated. Nothing you type here can be submitted right now.
        </div>
      );
    }
    return (
      <div className="rounded-2xl border border-[#EBDECE] bg-[#FBF7F1] p-4 text-xs text-[#7A6A55] space-y-1">
        <p>{n.noticeText}</p>
        <p className="font-mono text-[10px] uppercase tracking-wide">
          Notice {n.versionLabel}
          {policyHref ? <> · <a className="underline" href={policyHref} target={policyHref.startsWith('https://') ? '_blank' : undefined} rel={policyHref.startsWith('https://') ? 'noreferrer' : undefined}>full privacy policy</a></> : null}
        </p>
      </div>
    );
  };

  /**
   * Honest submission feedback driven by the SubmissionResult discriminated
   * union. `submitted` is shown ONLY after the database write succeeded. Raw
   * backend errors are never surfaced — only the coarse errorCode drives copy.
   */
  const reportSubmission = (result: SubmissionResult, successMsg: string) => {
    const fallback = CONFIRMED_CONTACT_EMAIL
      ? ` If it's urgent, email ${CONFIRMED_CONTACT_EMAIL}.`
      : '';
    if (result.status === 'submitted') {
      addToast(successMsg, 'success');
    } else if (result.status === 'not_configured') {
      addToast(
        `This site isn't connected to its submission system yet, so nothing was submitted or stored.${fallback}`,
        'warning'
      );
    } else if (result.errorCode === 'notice_changed') {
      // INC11: the privacy notice was republished between page load and
      // submit — the person must see the CURRENT text before their consent
      // is recorded. Reloading re-renders the new notice.
      addToast('Our privacy notice was just updated — please reload this page, review the new notice, and send again.', 'warning');
    } else if (result.errorCode === 'idempotency_conflict') {
      // WP01.1: the stale attempt key was rotated by the caller — one more
      // press of the button sends cleanly.
      addToast('That attempt was out of date — please press send once more.', 'warning');
    } else if (result.errorCode === 'vacancy_not_open') {
      addToast('That vacancy is no longer open. Please choose a current role.', 'warning');
    } else if (result.errorCode === 'section_closed') {
      addToast('This form has just closed, so nothing was submitted or stored.', 'warning');
    } else if (result.errorCode === 'rate_limited') {
      addToast('Too many submissions were sent from this connection. Please try again later.', 'warning');
    } else if (result.errorCode === 'verification_failed') {
      addToast('The verification check did not complete. Please try sending the form again.', 'warning');
    } else {
      const retry = result.retryable ? ' Please try again in a moment.' : ' Please try again later.';
      addToast(`Sorry, your submission couldn't be sent, so nothing was stored.${retry}${fallback}`, 'error');
    }
  };

  /** Map a coarse CvUploadResult to honest, non-leaking UI copy. */
  const cvFailureCopy = (r: Extract<CvUploadResult, { status: 'failed' }>): string => {
    switch (r.reason) {
      case 'too_large':     return 'your CV was over the 5 MB limit';
      case 'bad_type':      return 'your CV must be a PDF, DOC or DOCX file';
      case 'rate_limited':  return 'too many uploads from your connection — try the CV again later';
      case 'no_application':return 'we could not attach your CV to the application';
      case 'already_attached': return 'a CV is already attached to this application'; // WP-01: one CV per application
      case 'captcha':       return 'the verification check did not pass';
      default:              return 'your CV could not be uploaded';
    }
  };

  const handleCareerSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!careerForm.fullName.trim() || !careerForm.email.trim() || !careerForm.phone.trim() || !careerForm.availability.trim()) {
      addToast('Please complete all required fields.', 'error');
      return;
    }
    const careersNotice = noticeFor('careers');
    if (!careersNotice) {
      addToast('The careers form is temporarily closed while its privacy notice is being updated.', 'error');
      return;
    }
    // WP-02: the pending lock lives in usePublicSubmission (double click →
    // one call → one row) and the Turnstile token is acquired per attempt.
    /* T13-4: refuse a stale application. The selected vacancy must still be
       present in the CURRENT active list — not merely non-null — so a role
       closed while the form was open cannot receive an application. */
    if (!selectedJob || !activeVacancies.some((v) => v.id === selectedJob.id)) {
      addToast('That role is no longer open, so this application was not sent. Please choose a current vacancy.', 'error');
      return;
    }
    const appliedVacancy = selectedJob;
    await subCareers.run(async (captchaToken) => {

    // WP01.1: the attempt key is derived from the USER-CONTROLLED fields only
    // (never ids or timestamps, which change per render and would defeat
    // stability). Identical payload on a retry ⇒ identical key ⇒ the server
    // resolves to the original submission instead of inserting a duplicate.
    const attempt = await attCareers.getAttempt({
      kind: 'careers',
      fullName: careerForm.fullName, email: careerForm.email, phone: careerForm.phone,
      vacancyId: appliedVacancy.id, position: appliedVacancy.title, store: careerForm.preferredStore,
      availability: careerForm.availability, experience: careerForm.experience,
      message: careerForm.message,
    });

    // The CV (if any) is uploaded AFTER the application row is confirmed
    // written, through the cv-upload Edge Function which performs all
    // server-side validation. No CV path or file bytes are attached to the
    // application object or stored on the client (see the security notes in README.md).
    // WP-01: this id is a DISPLAY-ONLY placeholder for the optimistic local
    // object. It is never sent as identity and never used for CV attachment —
    // the server mints the real row id and returns it as result.submissionId.
    const appId = 'app_' + Date.now();
    const newApp: JobApplication = {
      id: appId,
      fullName: careerForm.fullName,
      email: careerForm.email,
      phone: careerForm.phone,
      vacancyId: appliedVacancy.id,
      position: appliedVacancy.title,
      store: careerForm.preferredStore,
      availability: careerForm.availability,
      experience: careerForm.experience,
      message: careerForm.message,
      status: 'pending',
      appliedAt: new Date().toISOString()
    };

    {
      const result = await onAddApplication(newApp, attempt.key, captchaToken, { id: careersNotice.id, sha256: careersNotice.contentSha256 });
      if (result.status === 'submitted') attCareers.rotate();
      if (result.status === 'failed' && result.errorCode === 'idempotency_conflict') attCareers.rotate();
      if (result.status === 'failed' && result.errorCode === 'vacancy_not_open') {
        setServerClosedVacancyIds((current) => current.includes(appliedVacancy.id) ? current : [...current, appliedVacancy.id]);
        setSelectedJob(null);
      }

      // Only attempt the CV upload once the application row actually exists —
      // the function refuses uploads with no matching application, and there is
      // nothing to attach a CV to if the insert did not succeed.
      // WP-01: `submitted` now GUARANTEES result.submissionId is the server-
      // minted row UUID (validated client-side). The old `|| appId` fallback —
      // which attached the CV to a row id that never existed — is deleted, not
      // just unused: it must never be reintroduced.
      let cvRetryPending = false;
      if (result.status === 'submitted' && cvFile && CAREERS_CV_UPLOAD) {
        // WP-02: Turnstile tokens are SINGLE-USE (consumed by siteverify), so
        // the CV step needs its own fresh token — the form's is already spent.
        const cvToken = await tsCareers.getToken();
        const cv = await uploadCv(result.submissionId, cvFile, cvToken);
        if (cv.status === 'uploaded') {
          setCvRetry(null);
          addToast(
            `Thank you ${careerForm.fullName}! Your application and CV have been received.`,
            'success',
          );
        } else if (cv.status === 'failed' && cv.reason === 'already_attached') {
          // Reconciled success: an earlier attempt actually linked (§6.4).
          setCvRetry(null);
          addToast('Your application and CV have been received.', 'success');
        } else if (cv.status === 'failed') {
          // The application is safely stored; only the CV failed. Keep the
          // submission id + chosen file and offer an explicit retry (§6.4).
          cvRetryPending = true;
          setCvRetry({ submissionId: result.submissionId });
          addToast(
            `Your application was received, but ${cvFailureCopy(cv)}. Use "Retry CV upload" below, or continue without it.`,
            'warning',
          );
        } else {
          // not_configured / skipped — application stored, CV simply not sent.
          addToast(
            `Thank you ${careerForm.fullName}! Your application has been received.`,
            'success',
          );
        }
      } else {
        // No CV, or the application itself didn't store — use the shared honest
        // reporter (handles not_configured / failed without leaking details).
        reportSubmission(
          result,
          `Thank you ${careerForm.fullName}! Your application has been received.`,
        );
      }

      // WP-02 (P0-03 rule): fields are cleared ONLY after server-confirmed
      // success — every failure path leaves the person's input intact.
      if (result.status === 'submitted') {
        setCareerForm({
          fullName: '', email: '', phone: '', experience: '',
          preferredStore: '', availability: '', message: '',
        });
        // §6.4: the FILE is retained while a CV retry is pending — clearing it
        // here would make "Retry CV upload" impossible.
        if (!cvRetryPending) setCvFile(null);
        setCvError('');
      }
    }
    });
  };

  // §6.4 retry actions: same submission id, same (or re-picked) file, always a
  // FRESH single-use token. `already_attached` counts as reconciled success.
  const handleCvRetry = async () => {
    if (!cvRetry || !cvFile) return;
    await subCareers.run(async (cvToken) => {
      const cv = await uploadCv(cvRetry.submissionId, cvFile, cvToken);
      if (cv.status === 'uploaded' || (cv.status === 'failed' && cv.reason === 'already_attached')) {
        setCvRetry(null); setCvFile(null); setCvError('');
        addToast('Your CV has been attached to your application.', 'success');
      } else if (cv.status === 'failed') {
        addToast(`Still no luck — ${cvFailureCopy(cv)}. You can try again or continue without it.`, 'warning');
      } else {
        setCvRetry(null);
        addToast('CV uploads are not available right now — your application itself is safely received.', 'warning');
      }
    });
  };
  const handleCvSkip = () => {
    setCvRetry(null); setCvFile(null); setCvError('');
    addToast('No problem — your application stands without a CV.', 'success');
  };

  /** Validate a chosen CV client-side for instant feedback (server re-checks). */
  const handleCvChange = (file: File | null) => {
    setCvError('');
    if (!file) { setCvFile(null); return; }
    if (file.size > 5 * 1024 * 1024) {
      setCvError('That file is over the 5 MB limit.');
      setCvFile(null);
      return;
    }
    if (!/\.(pdf|doc|docx)$/i.test(file.name)) {
      setCvError('Please choose a PDF, DOC or DOCX file.');
      setCvFile(null);
      return;
    }
    setCvFile(file);
  };

  const handleFranchiseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!franchiseForm.fullName.trim() || !franchiseForm.email.trim() || !franchiseForm.city.trim() || !franchiseForm.country.trim() || !franchiseForm.budget || !franchiseForm.experience) {
      addToast('Please complete your name, email, target country and city, budget range, and experience.', 'error');
      return;
    }
    const franchiseNotice = noticeFor('franchise');
    if (!franchiseNotice) {
      addToast('The franchise form is temporarily closed while its privacy notice is being updated.', 'error');
      return;
    }
    const newFran: FranchiseInquiry = {
      id: 'fran_' + Date.now(),
      fullName: franchiseForm.fullName,
      email: franchiseForm.email,
      phone: franchiseForm.phone,
      country: franchiseForm.country,
      city: franchiseForm.city,
      budget: franchiseForm.budget,
      experience: franchiseForm.experience,
      message: franchiseForm.message,
      status: 'pending',
      submittedAt: new Date().toISOString()
    };
    await subFranchise.run(async (captchaToken) => {
      const attempt = await attFranchise.getAttempt({
        kind: 'franchise',
        fullName: franchiseForm.fullName, email: franchiseForm.email, phone: franchiseForm.phone,
        country: franchiseForm.country, city: franchiseForm.city,
        budget: franchiseForm.budget, experience: franchiseForm.experience, message: franchiseForm.message,
      });
      const result = await onAddFranchise(newFran, attempt.key, captchaToken, { id: franchiseNotice.id, sha256: franchiseNotice.contentSha256 });
      if (result.status === 'submitted') attFranchise.rotate();
      if (result.status === 'failed' && result.errorCode === 'idempotency_conflict') attFranchise.rotate();
      reportSubmission(result, 'Your franchise enquiry has been received.');
      // WP-02 (P0-03): the unconditional reset erased the person's answers on
      // EVERY outcome, including failures. Clear only on confirmed success.
      if (result.status === 'submitted') {
        setFranchiseForm({
          fullName: '',
          email: '',
          phone: '',
          country: 'United Kingdom',
          city: '',
          budget: '',
          experience: '',
          message: ''
        });
      }
    });
  };

  const handleContactSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const contactPayload = {
      fullName: contactForm.fullName.trim(),
      email: contactForm.email.trim(),
      reason: contactForm.reason.trim(),
      message: contactForm.message.trim(),
    };
    if (!contactPayload.fullName || !contactPayload.email || !contactPayload.message) {
      addToast('Please complete all contact enquiry boxes.', 'error');
      return;
    }
    const contactNotice = noticeFor('contact');
    if (!contactNotice) {
      addToast('The contact form is temporarily closed while its privacy notice is being updated.', 'error');
      return;
    }
    const newMsg: ContactMessage = {
      id: 'msg_' + Date.now(),
      fullName: contactPayload.fullName,
      email: contactPayload.email,
      reason: contactPayload.reason,
      message: contactPayload.message,
      status: 'new',
      submittedAt: new Date().toISOString()
    };
    await subContact.run(async (captchaToken) => {
      const attempt = await attContact.getAttempt({
        kind: 'contact',
        ...contactPayload,
      });
      const result = await onAddContact(newMsg, attempt.key, captchaToken, { id: contactNotice.id, sha256: contactNotice.contentSha256 });
      if (result.status === 'submitted') attContact.rotate();
      if (result.status === 'failed' && result.errorCode === 'idempotency_conflict') attContact.rotate();
      reportSubmission(result, 'Thanks — your message has been received.');
      // WP-02 (P0-03): clear only on confirmed success; failures retain input.
      if (result.status === 'submitted') {
        setContactForm({
          fullName: '',
          email: '',
          reason: 'General feedback',
          message: ''
        });
      }
    });
  };

  // Rendering Helpers
  const renderProductGraphic = (item: MenuItem) => {
    let color = 'bg-[#A46832]';
    if (item.category === 'smoothies') color = 'bg-[#7CC0C7]';
    if (item.category === 'soft_serve') color = 'bg-stone-200';
    if (item.category === 'slush') color = 'bg-sky-200';
    if (item.category === 'extras') color = 'bg-amber-300';
    
    let emoji = '🥤';
    if (item.category === 'smoothies') emoji = '🍹';
    if (item.category === 'soft_serve') emoji = '🍦';
    if (item.category === 'slush') emoji = '🍧';
    if (item.category === 'extras') emoji = '🍬';

    // A real upload wins; otherwise the branded illustration; emoji as last resort.
    const uploaded = hasRealImage(item.image);
    const artwork = resolveMenuImage(item);

    return (
      <div className={`w-full h-48 ${artwork ? 'bg-[#F2EFE9]' : color} rounded-t-2xl relative overflow-hidden flex items-center justify-center p-6 group`}>
        {/* The branded/emoji layer always remains underneath the real image.
            If an uploaded URL expires, violates CSP or fails to decode, the
            image hides itself and this honest fallback is revealed. */}
        {(
          <>
            <div className={`absolute inset-0 ${color}`} />
            {/* Soft Organic Packaging Background Wave graphics */}
            <div className="absolute inset-0 bg-[#EBDECE]/40 transform -skew-y-12 translate-y-10 group-hover:translate-y-5 transition-transform duration-500" />
            <div className="absolute inset-0 bg-white/20 rounded-full w-24 h-24 -top-8 -left-8" />
            
            <span className="text-6xl relative z-10 drop-shadow-md transition-transform group-hover:scale-110 duration-300">
              {emoji}
            </span>
          </>
        )}

        {artwork && !isEditingMode && (
          <img
            src={artwork}
            className={`absolute inset-0 w-full h-full ${uploaded ? 'object-cover' : 'object-contain p-2'} transition-transform group-hover:scale-105 duration-500`}
            alt={item.name}
            loading="lazy"
            decoding="async"
            onError={(event) => { event.currentTarget.style.display = 'none'; }}
          />
        )}
      </div>
    );
  };

  /** On-page edit mode: patch a home-hero field on the draft. */
  const editHomeField = (field: 'heroHeadline' | 'heroSubheadline', value: string) => {
    setDraftContent(prev => ({ ...prev, home: { ...prev.home, [field]: value } }));
  };

  /** On-page edit mode: patch an About-page story photo on the draft. */
  const editAboutImage = (field: 'craftImage' | 'cultureImage', value: string) => {
    setDraftContent(prev => ({ ...prev, aboutPage: { ...prev.aboutPage, [field]: value } }));
  };

  const handlePublish = async () => {
    // Website edit mode publishes one atomic content model only. Catalogue
    // products and images are intentionally managed in Admin → Menu Items.
    if (onSaveContent && !(await onSaveContent(draftContent))) return;
    addToast('Changes published successfully.', 'success');
    setIsEditingMode(false);
  };

  /** The content the page renders: the live draft while editing, else published. */
  const c = isEditingMode ? draftContent : content;
  const craftImageUrl = resolveMediaUrl(c.aboutPage.craftImage);
  const cultureImageUrl = resolveMediaUrl(c.aboutPage.cultureImage);

  const headlineValue = c.home.heroHeadline;
  const subheadlineValue = c.home.heroSubheadline;

  const isOwner = employee?.role === 'owner';

  return (
    <div className="bg-[#FFFFFF] min-h-screen text-[#2E2A26] relative">
      {dataFreshness === 'stale' && (
        <div role="status" className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-center text-xs font-semibold text-amber-900">
          Showing the latest verified website copy while we reconnect. Prices and availability may have changed.
        </div>
      )}
      <PublicWebsiteEditBar
        isOwner={isOwner}
        isEditing={isEditingMode}
        onStart={() => setIsEditingMode(true)}
        onCancel={() => { setDraftContent(content); setIsEditingMode(false); }}
        onPublish={handlePublish}
        onEditMenu={() => { setIsEditingMode(false); setCurrentTab('admin_panel', { section: 'menu' }); }}
      />

      <div className={isEditingMode ? 'mt-14' : ''}>

      {/* ==================== HOME PAGE ==================== */}
      {currentTab === 'home' && (
        <div>
          {/* Hero — full-height caramel stage, staggered spring entrance, waving mascot */}
          <section className="relative overflow-hidden bg-[#A46832]">
            {/* Depth: soft radial light behind the mascot, Apple-style */}
            <div className="pointer-events-none absolute inset-0"
              style={{ background: 'radial-gradient(ellipse 62% 55% at 72% 42%, rgba(255,255,255,0.16), transparent 70%)' }} />
            <div className="pointer-events-none absolute -top-24 -left-24 w-96 h-96 rounded-full bg-[#7CC0C7]/15 blur-3xl" />

            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center min-h-[82vh] pt-12 pb-16 sm:pb-20">
              <motion.div
                variants={heroStagger}
                initial="hidden"
                animate="show"
                className="lg:col-span-6 space-y-7 text-center lg:text-left"
              >
                <motion.div variants={springRise}>
                  <LogoVertical color="#FFFFFF" className="h-28 sm:h-40 w-auto mx-auto lg:mx-0 drop-shadow-lg" title="Milk Pop" />
                </motion.div>

                {isEditingMode ? (
                  <motion.div variants={springRise} className="mp-public-form space-y-4">
                    <textarea
                      aria-label="Homepage hero headline"
                      value={headlineValue}
                      onChange={e => editHomeField('heroHeadline', e.target.value)}
                      className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.02] text-white w-full bg-white/10 border-2 border-white/60 rounded-2xl p-3 outline-none focus:border-white resize-none overflow-hidden"
                      rows={2}
                    />
                    <textarea
                      aria-label="Homepage hero subheadline"
                      value={subheadlineValue}
                      onChange={e => editHomeField('heroSubheadline', e.target.value)}
                      className="text-base text-white w-full bg-white/10 border-2 border-white/60 rounded-2xl p-3 font-light leading-relaxed outline-none focus:border-white resize-none"
                      rows={3}
                    />
                  </motion.div>
                ) : (
                  <>
                    <motion.h1
                      variants={springRise}
                      className="font-display text-4xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.02] text-white whitespace-pre-wrap"
                    >
                      {headlineValue}
                    </motion.h1>
                    <motion.p
                      variants={springRise}
                      className="text-base sm:text-lg text-white max-w-xl mx-auto lg:mx-0 font-light leading-relaxed whitespace-pre-wrap"
                    >
                      {subheadlineValue}
                    </motion.p>
                  </>
                )}

                <motion.div variants={springRise} className="flex flex-col sm:flex-row justify-center lg:justify-start items-center gap-3 pt-1">
                  <a
                    href={routeToPath('menu')}
                    onClick={(e) => handleAnchorNav(e, () => setCurrentTab('menu'))}
                    className="w-full sm:w-auto text-center px-9 py-4 bg-white text-[#2E2A26] font-bold rounded-full text-sm tracking-wide transition-all duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] shadow-lg hover:shadow-2xl hover:-translate-y-1 hover:scale-[1.03] cursor-pointer"
                  >
                    {c.home.heroPrimaryCta}
                  </a>
                  <a
                    href={routeToPath('stores')}
                    onClick={(e) => handleAnchorNav(e, () => setCurrentTab('stores'))}
                    /* LAUNCH POLISH: the hero sits on the caramel #A46832, where white text
                       measures 4.56:1 — but this button's own bg-white/10 wash LIGHTENED
                       the backdrop and pulled its label down to 3.81:1, below AA. The
                       hover state made it worse still (white/20). A dark glass tint
                       keeps the frosted ghost-button look and measures 5.42:1. */
                    className="w-full sm:w-auto text-center px-9 py-4 bg-black/10 backdrop-blur-md border border-white/50 hover:bg-black/20 hover:border-white text-white font-bold rounded-full text-sm tracking-wide transition-all duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-1 cursor-pointer"
                  >
                    {c.home.heroSecondaryCta}
                  </a>
                </motion.div>

                {activeDeals.length > 0 && (
                  <motion.div variants={springRise} className="flex flex-wrap justify-center lg:justify-start gap-2 pt-1">
                    {activeDeals.map(d => (
                      <span key={d.id} className="px-4 py-2 bg-white/12 backdrop-blur-md border border-white/35 rounded-full text-[11px] font-bold text-white tracking-wide">
                        <span className="text-[#AFE3E8] mr-1.5 font-black">{d.badge || '%'}</span>{d.name}
                      </span>
                    ))}
                  </motion.div>
                )}
              </motion.div>

              {/* Mascot stage — he IS the hero, always animated, always waving */}
              <div className="lg:col-span-6 relative flex justify-center items-end lg:items-center">
                <motion.div
                  initial={{ opacity: 0, scale: 0.6, y: 90 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{ type: 'spring', stiffness: 60, damping: 12, delay: 0.3 }}
                  className="relative"
                >
                  {/* soft contact shadow under the mascot */}
                  <div className="absolute left-1/2 -translate-x-1/2 bottom-2 w-2/3 h-8 bg-black/20 blur-2xl rounded-full" />
                  <div className="mp-bob">
                    {/* LCP candidate: intrinsic size + eager/high priority so the
                        browser fetches it before layout and reserves the box. */}
                    <img
                      src={MASCOT.wave}
                      alt="The Milk Pop mascot waving hello"
                      width={800}
                      height={800}
                      loading="eager"
                      fetchPriority="high"
                      className="mp-wave w-80 sm:w-[26rem] lg:w-[34rem] h-auto relative z-10 drop-shadow-2xl select-none"
                      draggable={false}
                    />
                  </div>
                  <img src={STICKERS.swirl} alt="" aria-hidden="true" width={311} height={288} decoding="async"
                    className="mp-drift absolute -right-4 top-2 w-16 sm:w-24 opacity-90"
                    style={{ ['--mp-tilt' as any]: '8deg', animationDelay: '0.8s' }} />
                  <img src={STICKERS.cup} alt="" aria-hidden="true" width={213} height={393} decoding="async"
                    className="mp-drift absolute -left-10 bottom-16 w-14 sm:w-20 opacity-90"
                    style={{ ['--mp-tilt' as any]: '-10deg', animationDelay: '2s' }} />
                  <img src={STICKERS.mPink} alt="" aria-hidden="true" width={336} height={279} decoding="async"
                    className="mp-drift absolute -left-4 top-6 w-12 sm:w-16 opacity-80 blur-[1px]"
                    style={{ ['--mp-tilt' as any]: '-6deg', animationDelay: '3.4s' }} />
                </motion.div>
              </div>
            </div>

            {/* Scroll cue */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1.4, duration: 0.8 }}
              className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10 hidden sm:block"
              aria-hidden="true"
            >
              <motion.div
                animate={{ y: [0, 8, 0] }}
                transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
                className="h-9 w-6 rounded-full border-2 border-white/50 flex items-start justify-center p-1.5"
              >
                <div className="h-2 w-1 rounded-full bg-white/70" />
              </motion.div>
            </motion.div>

          </section>

          {/* Caramel drips flowing out of the hero into the white page — the brandbook cover motif */}
          <div className="leading-[0] -mt-px" aria-hidden="true">
            <DripEdge color="#A46832" className="h-24 sm:h-40" />
          </div>

          {/* Core Brand promises bento block */}
          <section className="py-20 sm:py-24 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <Reveal className="text-center space-y-3 mb-12">
            <div className="text-center space-y-3">
              <span className="text-[10px] bg-[#EBDECE] px-3 py-1 rounded-full text-[#8F5322] font-black uppercase tracking-widest">
                {c.home.promiseKicker}
              </span>
              <h2 className="font-display text-3xl sm:text-4xl font-black text-[#2E2A26] tracking-tight">
                {c.home.promiseHeading}
              </h2>
            </div>
            </Reveal>

            <Reveal delay={0.1}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              {/* Cards come from Website Studio (home.promiseCards); the three
                  launch icon/colour treatments cycle for any card count. */}
              {c.home.promiseCards.map((card, i) => {
                const look = [
                  { bg: 'bg-[#7CC0C7]/50', fg: 'text-[#2E2A26]', Icon: Sparkles },
                  { bg: 'bg-[#A46832]/30', fg: 'text-[#A46832]', Icon: CheckCircle },
                  { bg: 'bg-[#EBDECE]', fg: 'text-[#2E2A26]', Icon: Search },
                ][i % 3]!;
                const IconComp = look.Icon;
                return (
                  <div key={i} className="mp-lift bg-white p-8 rounded-3xl border border-[#EBDECE]/40 shadow-xs space-y-4 text-center">
                    <div className={`w-12 h-12 rounded-2xl ${look.bg} flex items-center justify-center mx-auto ${look.fg}`}>
                      <IconComp className="h-6 w-6" />
                    </div>
                    <h3 className="font-display font-black text-sm uppercase tracking-wider text-[#2E2A26]">
                      {card.title}
                    </h3>
                    <p className="text-xs text-[#2E2A26]/80 leading-relaxed">
                      {card.text}
                    </p>
                  </div>
                );
              })}
            </div>
            </Reveal>
          </section>

          {/* Featured Menu items slider */}
          <section className="py-20 bg-[#EBDECE]/20">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <Reveal>
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-10">
                <div>
                  <span className="text-[10px] uppercase tracking-widest text-[#A46832] font-black">
                    {c.home.favouritesKicker}
                  </span>
                  <h2 className="font-display text-3xl font-black text-[#2E2A26] mt-1">
                    {c.home.favouritesHeading}
                  </h2>
                </div>
                <a
                  href={routeToPath('menu')}
                  onClick={(e) => handleAnchorNav(e, () => setCurrentTab('menu'))}
                  /* LAUNCH POLISH: #A46832 on the cream section is 4.01:1 —
                     below the 4.5:1 AA minimum for text this size. #8F5322 is
                     the darker token already used elsewhere on these pages
                     and measures 5.38:1. */
                  className="flex items-center space-x-1 text-xs font-black uppercase text-[#8F5322] hover:text-[#2E2A26] group cursor-pointer"
                >
                  <span>{c.home.favouritesCta}</span>
                  <ChevronRight className="h-4 w-4 transform group-hover:translate-x-1 transition-transform" />
                </a>
              </div>
              </Reveal>

              <Reveal delay={0.12}>
              {/* R4.9 G4: a stable anchor so the fail-closed proof can assert on
                  the PRODUCT strip specifically. Editorial copy elsewhere on the
                  page may legitimately name flavours; a product card may not
                  appear unless the database answered. */}
              <div id="home-favourites">
              {!menuReady ? <MenuUnavailable status={menuItems.status} /> : activeMenuItems.length === 0 ? (
                <div className="rounded-3xl border border-[#EBDECE] bg-white px-6 py-10 text-center shadow-xs">
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#EBDECE]/60 text-2xl" aria-hidden="true">🥤</div>
                  <h3 className="font-display text-lg font-black text-[#2E2A26]">Our opening menu is being prepared</h3>
                  <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-[#2E2A26]/70">
                    Products and prices will appear here as soon as they are published. You can still contact us with any opening questions.
                  </p>
                  <a
                    href={routeToPath('contact')}
                    onClick={(event) => handleAnchorNav(event, () => setCurrentTab('contact'))}
                    className="mt-5 inline-flex min-h-11 items-center justify-center rounded-full bg-[#A46832] px-5 text-xs font-black uppercase tracking-wider text-white transition-colors hover:bg-[#2E2A26]"
                  >
                    Contact Milk Pop
                  </a>
                </div>
              ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                {activeMenuItems.slice(0, 4).map((item) => {
                  let bgColor = 'bg-[#A46832]';
                  if (item.category === 'smoothies') bgColor = 'bg-[#7CC0C7]';
                  if (item.category === 'soft_serve') bgColor = 'bg-stone-200';
                  if (item.category === 'slush') bgColor = 'bg-sky-200';
                  if (item.category === 'extras') bgColor = 'bg-amber-300';
                  
                  const artwork = resolveMenuImage(item);
                  return (
                  <div key={item.id} className="mp-lift bg-white rounded-3xl overflow-hidden border border-[#EBDECE]/40 shadow-xs flex flex-col justify-between">
                    <div className={`w-full h-40 ${artwork ? 'bg-[#F2EFE9]' : bgColor} relative overflow-hidden flex items-center justify-center`}>
                      {(
                        <>
                          <div className={`absolute inset-0 ${bgColor}`} />
                          <div className="absolute inset-0 bg-[#EBDECE]/20 transform -skew-y-12 translate-y-10" />
                          <span className="text-4xl relative z-10 drop-shadow-md">
                            {item.category === 'milkshakes' ? '🥤' : item.category === 'smoothies' ? '🍹' : item.category === 'soft_serve' ? '🍦' : item.category === 'slush' ? '🍧' : '🍬'}
                          </span>
                        </>
                      )}
                      
                      {artwork && !isEditingMode && (
                        <img
                          src={artwork}
                          className={`absolute inset-0 w-full h-full ${hasRealImage(item.image) ? 'object-cover' : 'object-contain p-2'}`}
                          alt={item.name}
                          loading="lazy"
                          decoding="async"
                          onError={(event) => { event.currentTarget.style.display = 'none'; }}
                        />
                      )}
                    </div>
                    
                    <div className="p-6 space-y-2 flex flex-col justify-between h-full">
                      <div>
                        {item.tags && item.tags.length > 0 && (
                          <div className="flex items-center gap-1.5 flex-wrap mb-2">
                            {item.tags.map((tag) => (
                              <span key={tag} className="bg-[#EBDECE]/50 text-[#2E2A26] px-2 py-0.5 rounded-full text-[9px] font-bold">
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                        <h3 className="font-display font-black text-sm text-[#2E2A26]">
                            {item.name}
                          </h3>
                          <MenuPriceBlock item={item} currencySymbol={currencySymbol} />
                        {item.description && (
                          <p className="text-[11px] text-[#2E2A26]/75 line-clamp-2 leading-relaxed mt-1">
                            {item.description}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center justify-between pt-3 mt-3 border-t border-[#EBDECE]/30">
                        <span className="text-[10px] font-black tracking-wider text-[#A46832]">
                          FROM {currencySymbol}{item.price.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>
                )})}
              </div>
              )}
              </div>
              </Reveal>
            </div>
          </section>

          {/* Opening CTAs: optional Careers plus the always-available contact route. */}
          <section className={`py-16 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 gap-8 ${siteSettings.showCareers ? 'md:grid-cols-2' : 'max-w-4xl'}`}>
            {/* Careers is hidden cleanly until the owner publishes that programme. */}
            {siteSettings.showCareers && (
            <Reveal className="h-full"><div className="mp-lift relative overflow-hidden h-full bg-[#7CC0C7]/20 p-8 rounded-3xl border border-[#7CC0C7]/40 space-y-4 flex flex-col justify-between">
              {/* Mascot mid-bite: kept fully inside the card so the chocolate bar reads clearly. */}
              <img
                src={MASCOT.holdShake}
                alt="The Milk Pop mascot taking a bite of a chocolate bar"
                width={340}
                height={699}
                loading="lazy"
                decoding="async"
                className="pointer-events-none absolute right-4 -bottom-1 w-32 sm:w-40 mp-float drop-shadow-lg select-none"
                style={{ ['--mp-tilt' as any]: '3deg' }}
                draggable={false}
              />
              <div className="space-y-3 relative z-10 pr-32 sm:pr-40">
                <span className="text-[9px] bg-[#7CC0C7] text-[#2E2A26] px-3 py-1 rounded-full font-black uppercase tracking-wider">
                  {c.home.careersCard.kicker}
                </span>
                <h3 className="font-display text-2xl font-black text-[#2E2A26]">
                  {c.home.careersCard.title}
                </h3>
                <p className="text-xs text-[#2E2A26]/80 leading-relaxed">
                  {c.home.careersCard.text}
                </p>
              </div>
              <a
                href={routeToPath('careers')}
                onClick={(e) => handleAnchorNav(e, () => setCurrentTab('careers'))}
                className="mt-4 flex items-center justify-center space-x-1.5 bg-[#2E2A26] text-white px-5 py-3 rounded-full text-xs font-black uppercase tracking-wider hover:bg-[#A46832] transition-colors self-start cursor-pointer"
              >
                <span>{c.home.careersCard.button}</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </div></Reveal>
            )}

            {/* Contact Block */}
            <Reveal delay={siteSettings.showCareers ? 0.12 : 0} className="h-full"><div className="mp-lift h-full bg-[#EBDECE] p-8 rounded-3xl border border-[#A46832]/30 space-y-4 flex flex-col justify-between">
              <div className="space-y-3">
                <span className="text-[9px] bg-[#A46832] text-white px-3 py-1 rounded-full font-black uppercase tracking-wider">
                  {c.home.contactCard.kicker}
                </span>
                <h3 className="font-display text-2xl font-black text-[#2E2A26]">
                  {c.home.contactCard.title}
                </h3>
                <p className="text-xs text-[#2E2A26]/80 leading-relaxed">
                  {c.home.contactCard.text}
                </p>
              </div>
              <a
                href={routeToPath('contact')}
                onClick={(e) => handleAnchorNav(e, () => setCurrentTab('contact'))}
                className="mt-4 flex items-center justify-center space-x-1.5 bg-[#A46832] text-white px-5 py-3 rounded-full text-xs font-black uppercase tracking-wider hover:bg-[#2E2A26] transition-colors self-start cursor-pointer"
              >
                <span>{c.home.contactCard.button}</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </div></Reveal>
          </section>
        </div>
      )}

      {/* ==================== MENU PAGE ==================== */}
      {currentTab === 'menu' && (
        <div className="py-12 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center space-y-3 mb-10">
            <span className="text-[10px] bg-[#EBDECE] px-3 py-1 rounded-full text-[#8F5322] font-black uppercase tracking-widest">
              {c.menuPage.kicker}
            </span>
            <h1 className="font-display text-4xl font-black text-[#2E2A26]">
              {c.menuPage.heading}
            </h1>
            <p className="text-xs text-[#2E2A26]/75 max-w-md mx-auto">
              {c.menuPage.intro}
            </p>
          </div>

          {/* Live combos — straight from the owner-managed Deals registry */}
          {/* SMALL-BIZ CLOSURE P0-7: the offers surface distinguishes a
              technical failure from genuinely having no offers. Loading and
              unavailable render their own visible note; ready-with-zero-deals
              renders NO section at all — deliberately, because there is no
              marketing copy here whose absence could misstate the business
              (the home hero's badge strip is the same: pure decoration,
              rendered only from a ready collection). */}
          {deals.status !== 'ready' ? (
            <div className="mb-8"><CollectionStatusNote status={deals.status} label="today\u2019s offers" /></div>
          ) : activeDeals.length > 0 && (
            <div className="mb-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {activeDeals.map(d => (
                <div key={d.id} className="relative overflow-hidden bg-[#7CC0C7]/15 border border-[#7CC0C7]/60 rounded-3xl p-5 flex items-center gap-4">
                  <span className="shrink-0 h-12 w-12 rounded-full bg-[#A46832] text-white flex items-center justify-center text-xs font-black">
                    {d.badge || '%'}
                  </span>
                  <div>
                    <h3 className="text-sm font-bold text-[#2E2A26]">{d.name}</h3>
                    <p className="text-2xs text-[#2E2A26]/70 font-light">{d.description}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Search and Filters Layout */}
          <div className="bg-white p-6 rounded-3xl border border-[#EBDECE]/40 shadow-xs mb-8 space-y-4">
            <div className="flex flex-col md:flex-row items-center gap-4">
              {/* Search */}
              <div className="relative w-full md:flex-1">
                <Search className="absolute left-4 top-3.5 h-4 w-4 text-[#A46832]" />
                <input
                  id="menu-search-input"
                  type="text"
                  /* LAUNCH POLISH: a placeholder is not an accessible name —
                     it vanishes on typing and is not reliably announced. */
                  aria-label="Search the menu"
                  placeholder={c.menuPage.searchPlaceholder}
                  value={menuSearch}
                  onChange={(e) => { setMenuSearch(e.target.value); syncMenuUrl({ q: e.target.value }); }}
                  className="w-full pl-12 pr-4 py-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-full text-base sm:text-xs text-[#2E2A26] placeholder-[#2E2A26]/40 focus:ring-2 focus:ring-[#A46832] focus:outline-none"
                />
              </div>

            </div>

            {/* Category selection bar */}
            <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
              {[
                { key: 'all', label: 'All Items' },
                { key: 'milkshakes', label: 'Milkshakes' },
                { key: 'smoothies', label: 'Smoothies' },
                { key: 'soft_serve', label: 'Soft Serve' },
                { key: 'slush', label: 'Slush' },
                { key: 'extras', label: 'Extras' }
              ].map((cat) => (
                <a
                  id={`cat-filter-${cat.key}`}
                  key={cat.key}
                  href={routeToPath('menu', cat.key === 'all' ? {} : { category: cat.key })}
                  aria-current={selectedCategory === cat.key ? 'true' : undefined}
                  onClick={(e) => handleAnchorNav(e, () => { setSelectedCategory(cat.key); syncMenuUrl({ category: cat.key }); })}
                  className={`px-4 py-2 rounded-full text-[10px] uppercase tracking-wider font-extrabold whitespace-nowrap transition-all cursor-pointer ${
                    selectedCategory === cat.key
                      ? 'bg-[#A46832] text-white shadow-xs'
                      : 'bg-[#FFFFFF] text-[#2E2A26] hover:bg-[#EBDECE]'
                  }`}
                >
                  {cat.label}
                </a>
              ))}
            </div>
          </div>

          {/* Menu items grid */}
          {!menuReady ? <MenuUnavailable status={menuItems.status} /> : (() => {
            const itemsToFilter = activeMenuItems;
            const filteredItems = itemsToFilter.filter((item) => {
              const matchesSearch = item.name.toLowerCase().includes(menuSearch.toLowerCase()) ||
                item.description.toLowerCase().includes(menuSearch.toLowerCase());
              
              const matchesCategory = selectedCategory === 'all' || item.category === selectedCategory;
              
              // R4.9 G4: the dietary filter is GONE. It built a shortlist a
              // dairy-allergic customer could act on out of free-text admin
              // tags and the unverified legacy allergens[] — a stronger claim
              // than the "not yet verified, ask in store" wording rendered a
              // few lines below on the very same card.
              return matchesSearch && matchesCategory;
            });

            if (filteredItems.length === 0) {
              /* R4.10 Increment 6: an EMPTY CATALOGUE and a filter that matched
                 nothing are different facts and must read differently. Telling a
                 visitor "no drinks match your filters" when the menu has not been
                 built yet is simply untrue, and it invites them to fiddle with a
                 search box that cannot help. */
              const catalogueEmpty = activeMenuItems.length === 0;
              return (
                <div className="text-center py-16 bg-white rounded-3xl border border-[#EBDECE]/40 space-y-2">
                  <ShieldAlert className="h-10 w-10 text-[#A46832] mx-auto" />
                  <h3 className="text-sm font-bold">
                    {catalogueEmpty ? 'Our menu is being prepared' : 'No drinks match your current filters'}
                  </h3>
                  <p className="text-2xs text-[#2E2A26]/60 max-w-sm mx-auto">
                    {catalogueEmpty
                      ? 'Please check back soon — we are getting our drinks ready.'
                      : 'Try a different search term or category.'}
                  </p>
                </div>
              );
            }

            return (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {filteredItems.map((item) => (
                  <div key={item.id} className="bg-white rounded-3xl overflow-hidden border border-[#EBDECE]/40 shadow-2xs hover:shadow-md transition-all">
                    {renderProductGraphic(item)}

                    <div className="p-5 space-y-3">
                      <div className="flex flex-wrap gap-1">
                        {item.tags.map((tag) => (
                          <span key={tag} className="bg-[#7CC0C7]/40 text-[#2E2A26] text-[9px] font-black px-2 py-0.5 rounded-full">
                            {tag}
                          </span>
                        ))}
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-start justify-between gap-1">
                          <h3 className="font-display font-black text-sm text-[#2E2A26]">
                            {item.name}
                          </h3>
                          <MenuPriceBlock item={item} currencySymbol={currencySymbol} />
                        </div>
                        {item.description && (
                          <p className="text-2xs text-[#2E2A26]/80 leading-relaxed min-h-[36px] line-clamp-3">
                            {item.description}
                          </p>
                        )}
                      </div>

                      {/* Allergens block — R4.8 (Workstream G5): honest display.
                          The legacy allergens[] list is UNVERIFIED reference data
                          until the item's declaration is approved in the allergen
                          register, so an empty array is NEVER presented as
                          "no allergens", and the listed items are labelled as
                          not-yet-verified guidance rather than a legal statement. */}
                      <div className="bg-[#FFFFFF] p-2 rounded-xl text-[11px] text-[#2E2A26]/90">
                        {item.allergens.length > 0 ? (
                          <>
                            <span className="font-bold text-[#8F5322]">Allergen guidance: </span>
                            {item.allergens.join(', ')}.{' '}
                            <span className="text-[#2E2A26]/70">Full verified allergen information is available in store — please ask before ordering.</span>
                          </>
                        ) : (
                          <span className="text-[#2E2A26]/80">
                            <span className="font-bold text-[#8F5322]">Allergens: </span>
                            information not yet verified for this item — please ask in store before ordering.
                          </span>
                        )}
                      </div>

                      <div className="flex items-center justify-between pt-3 border-t border-[#EBDECE]/20 mt-auto">
                        <span className="text-[10px] font-black uppercase tracking-wider text-[#8F5322] bg-[#A46832]/10 px-2.5 py-1 rounded-full">
                          {item.category.replace('_', ' ')}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Legal Allergy Disclaimer Box */}
          <div className="mt-12 bg-amber-50 border border-[#A46832]/30 p-6 rounded-3xl flex items-start space-x-3 max-w-3xl mx-auto">
            <ShieldAlert className="h-5 w-5 text-[#A46832] shrink-0 mt-0.5" />
            <div className="text-2xs text-[#2E2A26]/80 leading-relaxed space-y-1.5">
              <h4 className="font-bold">Important Allergen Disclaimer</h4>
              <p>
                Ingredients and allergen information may vary by product, supplier, store and preparation method. If you have any food allergy or intolerance, please speak to a trained team member before ordering. Cross-contact may be possible.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ==================== STORE LOCATOR PAGE ==================== */}
      {currentTab === 'stores' && (
        <div className="py-12 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center space-y-3 mb-10">
            <span className="text-[10px] bg-[#EBDECE] px-3 py-1 rounded-full text-[#8F5322] font-black uppercase tracking-widest">
              {c.storesPage.kicker}
            </span>
            <h1 className="font-display text-4xl font-black text-[#2E2A26]">
              {c.storesPage.heading}
            </h1>
            <p className="text-xs text-[#2E2A26]/75 max-w-md mx-auto">
              {c.storesPage.intro}
            </p>
          </div>

          <div className="max-w-5xl mx-auto space-y-5">
            <div className="relative max-w-xl mx-auto">
              <Search className="absolute left-4 top-3.5 h-4 w-4 text-[#A46832]" />
              <input
                id="store-search-box"
                type="text"
                aria-label="Search stores by postcode, area or store name"
                placeholder={c.storesPage.searchPlaceholder}
                value={storeSearch}
                onChange={(e) => setStoreSearch(e.target.value)}
                className="w-full pl-12 pr-4 py-3.5 bg-white border border-[#EBDECE] rounded-full text-base sm:text-xs text-[#2E2A26] placeholder-[#2E2A26]/40 focus:outline-none focus:ring-2 focus:ring-[#A46832]"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(() => {
                /* “Coming Soon” is a business claim. It renders only when the
                   database genuinely answered with zero active stores. */
                if (stores.status !== 'ready') {
                  return <div className="md:col-span-2"><CollectionStatusNote status={stores.status} label="our locations" /></div>;
                }
                const query = storeSearch.trim().toLowerCase();
                const filteredStores = activeStores.filter((store) =>
                  [store.name, store.address, store.postcode]
                    .some((value) => value.toLowerCase().includes(query))
                );

                if (filteredStores.length === 0) {
                  const noStoresYet = activeStores.length === 0;
                  return (
                    <div className="md:col-span-2 bg-white p-6 rounded-3xl border border-[#EBDECE] text-center py-10">
                      <p className="text-xs font-bold uppercase">{noStoresYet ? 'Coming Soon' : 'No Locations Match'}</p>
                      <p className="text-2xs text-[#8F5322] mt-1">
                        {noStoresYet
                          ? 'Our first location is coming soon — watch this space.'
                          : 'No stores match your search yet.'}
                      </p>
                      <div className="mt-4 flex flex-wrap justify-center gap-3">
                        <button type="button" onClick={() => setCurrentTab('contact')} className="inline-flex items-center min-h-11 px-5 rounded-full bg-[#A46832] text-white text-xs font-extrabold uppercase tracking-wider cursor-pointer">Get in touch</button>
                        {siteSettings.showNews && (
                          <button type="button" onClick={() => setCurrentTab('news')} className="inline-flex items-center min-h-11 px-5 rounded-full border border-[#A46832] text-[#8F5322] text-xs font-extrabold uppercase tracking-wider cursor-pointer">Follow our news</button>
                        )}
                      </div>
                    </div>
                  );
                }

                return filteredStores.map((store) => {
                  const isActive = activeStoreId === store.id;
                  const deliverooHref = safeExternalHref(store.deliveryLinks?.deliveroo);
                  const uberEatsHref = safeExternalHref(store.deliveryLinks?.uberEats);
                  const hasDeliveryLink = Boolean(deliverooHref || uberEatsHref);
                  const directionsHref = safeExternalHref(
                    `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([store.address, store.postcode].filter(Boolean).join(', '))}`,
                  );
                  return (
                    <div
                      key={store.id}
                      className={`p-6 rounded-3xl border transition-all text-left ${
                        isActive
                          ? 'border-[#A46832] bg-[#FFFFFF] ring-2 ring-[#A46832]/30 shadow-md'
                          : 'border-[#EBDECE]/50 bg-white hover:bg-[#FFFFFF]/50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <h3 className="font-display font-black text-sm text-[#2E2A26]">
                          <a
                            href={routeToPath('stores', { store: storeSlug(store) })}
                            onClick={(e) => handleAnchorNav(e, () => { setActiveStoreId(store.id); setCurrentTab('stores', { store: storeSlug(store) }, { keepScroll: true }); })}
                            className="inline-flex min-h-11 items-center hover:underline"
                          >
                            {store.name}
                          </a>
                        </h3>
                        <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full shrink-0 ${
                          store.status === 'open'
                            ? 'bg-[#5FA777]/20 text-[#5FA777]'
                            : store.status === 'closed'
                              ? 'bg-gray-200 text-gray-600'
                              : 'bg-amber-100 text-[#A46832]'
                        }`}>
                          {publicStoreStatusLabel(store.status)}
                        </span>
                      </div>

                      <div className="space-y-2 text-xs text-[#2E2A26]/85">
                        {store.address && (
                          <div className="flex items-start space-x-2">
                            <MapPin className="h-4 w-4 text-[#A46832] shrink-0 mt-0.5" />
                            <span>{store.address}{store.postcode ? `, ${store.postcode}` : ''}</span>
                          </div>
                        )}
                        {store.openingHours && (
                          <div className="flex items-start space-x-2">
                            <Clock className="h-4 w-4 text-[#A46832] shrink-0 mt-0.5" />
                            <span>{store.openingHours}</span>
                          </div>
                        )}
                        {safeTelHref(store.phone) && (
                          <div className="flex items-center space-x-2">
                            <Phone className="h-4 w-4 text-[#A46832]" />
                            <a href={safeTelHref(store.phone)} className="min-h-11 inline-flex items-center hover:underline">{store.phone}</a>
                          </div>
                        )}
                      </div>

                      {store.status === 'open' && hasDeliveryLink && (
                        <div className="pt-4 border-t border-[#EBDECE]/20 mt-4 flex flex-wrap items-center gap-2">
                          <span className="text-[9px] uppercase tracking-wider font-extrabold text-[#A5642B]">Delivery:</span>
                          {deliverooHref && (
                            <a href={deliverooHref} target="_blank" rel="noopener noreferrer" className="px-2.5 py-1.5 bg-[#7CC0C7]/50 hover:bg-[#7CC0C7] text-[#2E2A26] rounded-full text-[10px] font-black uppercase tracking-wider flex items-center space-x-1 transition-colors">
                              <span>Deliveroo</span><ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          )}
                          {uberEatsHref && (
                            <a href={uberEatsHref} target="_blank" rel="noopener noreferrer" className="px-2.5 py-1.5 bg-stone-200 hover:bg-stone-300 text-stone-800 rounded-full text-[10px] font-black uppercase tracking-wider flex items-center space-x-1 transition-colors">
                              <span>UberEats</span><ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          )}
                        </div>
                      )}

                      <div className="pt-4 border-t border-[#EBDECE]/20 mt-4 flex flex-wrap items-center justify-between gap-3">
                        {directionsHref && (
                          <a href={directionsHref} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-[#8F5322] hover:underline">
                            <MapPin className="h-3.5 w-3.5" /> Get directions
                          </a>
                        )}
                        <a
                          href={routeToPath('stores', { store: storeSlug(store) })}
                          onClick={(e) => handleAnchorNav(e, () => { setActiveStoreId(store.id); setCurrentTab('stores', { store: storeSlug(store) }, { keepScroll: true }); })}
                          className="inline-flex min-h-11 items-center gap-1 text-[10px] font-black uppercase tracking-wider text-[#8F5322] hover:underline"
                        >
                          View details <ChevronRight className="h-3.5 w-3.5" />
                        </a>
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ==================== CAREERS PAGE ==================== */}
      {currentTab === 'careers' && (
        <div className="py-12 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center space-y-3 mb-12">
            <span className="text-[10px] bg-[#7CC0C7] text-[#2E2A26] px-3.5 py-1.5 rounded-full font-black uppercase tracking-widest">
              {c.careersPage.kicker}
            </span>
            <h1 className="font-display text-4xl font-black text-[#2E2A26]">
              {c.careersPage.heading}
            </h1>
            <p className="text-xs text-[#2E2A26]/75 max-w-md mx-auto">
              {c.careersPage.intro}
            </p>
          </div>

          {/* Benefits Grid */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-12">
            {c.careersPage.perks.map((perk, i) => (
              <div key={i} className="bg-white p-6 rounded-3xl border border-[#EBDECE]/40 text-center space-y-2">
                <span className="text-2xl">{perk.emoji}</span>
                <h3 className="font-bold text-xs uppercase tracking-wider">{perk.title}</h3>
                <p className="text-[11px] text-[#2E2A26]/70">{perk.text}</p>
              </div>
            ))}
          </div>

          {/* Core Roles & Applications interface */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Vacancies list (5 cols) */}
            <div className="lg:col-span-5 space-y-4">
              <h2 className="font-display text-sm uppercase tracking-widest font-black text-[#A46832] px-1">
                {c.careersPage.vacanciesHeading}
              </h2>
              {/* SMALL-BIZ CLOSURE P0-7: "No Open Roles" is a business claim —
                  a failed vacancies fetch must not tell candidates the
                  business is not hiring. */}
              {vacancies.status !== 'ready' ? (
                <CollectionStatusNote status={vacancies.status} label="open roles" />
              ) : activeVacancies.length === 0 ? (
                <div className="p-6 bg-white rounded-3xl border border-[#EBDECE]/40 text-center py-10">
                  <p className="text-xs font-bold uppercase">No Open Roles</p>
                  <p className="text-2xs text-[#8F5322] mt-1">We're not hiring right now — check back soon.</p>
                  {/* R4.8 (Workstream K): meaningful action inside <main> */}
                  <div className="mt-4 flex flex-wrap justify-center gap-3">
                    <button type="button" onClick={() => setCurrentTab('contact')} className="inline-flex items-center min-h-11 px-5 rounded-full bg-[#A46832] text-white text-xs font-extrabold uppercase tracking-wider cursor-pointer">Ask about future roles</button>
                    {siteSettings.showNews && (
                      <button type="button" onClick={() => setCurrentTab('news')} className="inline-flex items-center min-h-11 px-5 rounded-full border border-[#A46832] text-[#8F5322] text-xs font-extrabold uppercase tracking-wider cursor-pointer">Follow our news</button>
                    )}
                  </div>
                </div>
              ) : activeVacancies.map((job) => (
                <a
                  key={job.id}
                  href={routeToPath('careers', { job: vacancySlug(job) })}
                  onClick={(event) => handleAnchorNav(event, () => { setSelectedJob(job); setCurrentTab('careers', { job: vacancySlug(job) }, { keepScroll: true }); })}
                  className={`block p-6 bg-white rounded-3xl border cursor-pointer transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A46832] focus-visible:ring-offset-2 ${
                    selectedJob?.id === job.id
                      ? 'border-[#A46832] ring-2 ring-[#A46832]/20 shadow-xs'
                      : 'border-[#EBDECE]/40 hover:border-[#A46832]/50'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-display font-black text-xs text-[#2E2A26] uppercase tracking-wide hover:underline">{job.title}</h3>
                    <span className="text-[9px] uppercase font-bold text-[#8F5322] bg-[#EBDECE] px-2 py-0.5 rounded-full">
                      {job.type}
                    </span>
                  </div>
                  <p className="text-[11px] font-bold text-gray-500 mb-1">{job.department}{job.location ? ` (${job.location})` : ''}</p>
                  {job.salary && <p className="text-[11px] font-mono text-[#A46832] font-black">{job.salary}</p>}
                </a>
              ))}
            </div>

            {/* Selected Job details and Application form (7 cols) */}
            <div className="lg:col-span-7 bg-white p-8 rounded-3xl border border-[#EBDECE]/40 shadow-xs space-y-6">
              {selectedJob ? (
                <div className="space-y-6">
                  {/* Job Details Card */}
                  <div className="border-b border-[#EBDECE]/30 pb-6 space-y-3">
                    <h2 className="font-display text-lg font-black text-[#2E2A26] uppercase tracking-wide">
                      {selectedJob.title}
                    </h2>
                    <p className="text-[11px] text-[#2E2A26]/80 leading-relaxed font-light">
                      {selectedJob.roleDescription}
                    </p>

                    <div className="space-y-2">
                      <h4 className="text-2xs font-black uppercase text-[#A46832] tracking-widest flex items-center gap-1">
                        <CheckCircle className="h-3 w-3 text-[#5FA777]" /> Core Responsibilities
                      </h4>
                      <ul className="list-disc list-inside text-2xs text-[#2E2A26]/85 space-y-1 pl-1 font-light">
                        {(selectedJob.responsibilities || []).map((resp, i) => (
                          <li key={i}>{resp}</li>
                        ))}
                      </ul>
                    </div>

                    <div className="space-y-2 pt-2">
                      <h4 className="text-2xs font-black uppercase text-[#A46832] tracking-widest flex items-center gap-1">
                        <Users className="h-3.5 w-3.5" /> Core Candidate Requirements
                      </h4>
                      <ul className="list-disc list-inside text-2xs text-[#2E2A26]/85 space-y-1 pl-1 font-light">
                        {(selectedJob.requirements || []).map((req, i) => (
                          <li key={i}>{req}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  {/* Application Form */}
                  <form onSubmit={handleCareerSubmit} className="space-y-4">
                    <h3 className="font-display text-sm font-black uppercase text-[#2E2A26]">
                      Submit Your Application
                    </h3>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="app-name" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">
                          Full Name *
                        </label>
                        <input
                          id="app-name"
                          type="text"
                          required
                          autoComplete="name"
                          maxLength={200}
                          value={careerForm.fullName}
                          onChange={(e) => setCareerForm({ ...careerForm, fullName: e.target.value })}
                          className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832]"
                          placeholder="e.g. Sarah Jenkins"
                        />
                      </div>
                      <div>
                        <label htmlFor="app-email" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">
                          Email Address *
                        </label>
                        <input
                          id="app-email"
                          type="email"
                          required
                          autoComplete="email"
                          maxLength={320}
                          value={careerForm.email}
                          onChange={(e) => setCareerForm({ ...careerForm, email: e.target.value })}
                          className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832]"
                          placeholder="sarah@example.com"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="app-phone" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">
                          Contact Phone *
                        </label>
                        <input
                          id="app-phone"
                          type="tel"
                          required
                          autoComplete="tel"
                          minLength={7}
                          maxLength={50}
                          pattern="[+0-9(][0-9 ()-]{6,49}"
                          title="Enter a telephone number using digits, spaces, brackets, + or -"
                          value={careerForm.phone}
                          onChange={(e) => setCareerForm({ ...careerForm, phone: e.target.value })}
                          className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832]"
                          placeholder="+44 7700 900077"
                        />
                      </div>
                      <div>
                        <label htmlFor="app-store" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">
                          Preferred store
                        </label>
                        <select
                          id="app-store"
                          value={careerForm.preferredStore}
                          onChange={(e) => setCareerForm({ ...careerForm, preferredStore: e.target.value })}
                          className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832]"
                        >
                          <option value="">Select a store…</option>
                          {activeStores.map((s) => (
                            <option key={s.id} value={s.name}>
                              {s.name}{s.status === 'coming_soon' ? ' (Coming Soon)' : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div>
                      <label htmlFor="app-availability" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">
                        Weekly Availability & Hours (e.g. Weekends, 16 hours) *
                      </label>
                      <input
                        id="app-availability"
                        type="text"
                        required
                        maxLength={500}
                        value={careerForm.availability}
                        onChange={(e) => setCareerForm({ ...careerForm, availability: e.target.value })}
                        className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832]"
                        placeholder="e.g. Saturdays & Sundays, up to 16 hours total"
                      />
                    </div>

                    <div>
                      <label htmlFor="app-experience" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">
                        Previous hospitality or customer-service experience
                      </label>
                      <textarea
                        id="app-experience"
                        maxLength={5000}
                        value={careerForm.experience}
                        onChange={(e) => setCareerForm({ ...careerForm, experience: e.target.value })}
                        className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832] h-20"
                        placeholder="Outline any cashier, kitchen prep, or customer service jobs held previously..."
                      />
                    </div>

                    {/* CV upload (Block D). The file is validated and stored
                        entirely server-side by the cv-upload Edge Function
                        (size/magic-byte MIME checks, random object key,
                        overwrite guard, per-IP rate limit, optional CAPTCHA,
                        application-row check, rollback). The browser only holds
                        a transient File reference and never encodes or stores
                        the bytes. Optional: an application is valid without a CV. */}
                    {CAREERS_CV_UPLOAD && (
                    <div>
                      <label htmlFor="app-cv" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">
                        CV / Résumé <span className="mp-muted normal-case font-medium">(optional — PDF, DOC or DOCX, max 5 MB)</span>
                      </label>
                      <input
                        id="app-cv"
                        type="file"
                        accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        onChange={(e) => handleCvChange(e.target.files?.[0] ?? null)}
                        className="w-full text-xs p-2.5 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl file:mr-3 file:py-1.5 file:px-3 file:rounded-full file:border-0 file:text-[10px] file:font-black file:uppercase file:bg-[#F7EFE6] file:text-[#2E2A26] hover:file:bg-[#EBDECE] file:cursor-pointer"
                      />
                      {cvFile && !cvError && (
                        <p className="text-[10px] text-[#5FA777] font-bold mt-1 flex items-center gap-1">
                          <FileCheck className="h-3 w-3" /> {cvFile.name} ready to upload
                        </p>
                      )}
                      {cvError && (
                        <p className="text-[10px] text-red-500 font-bold mt-1">{cvError}</p>
                      )}
                      <p className="text-[10px] text-[#2E2A26]/50 leading-relaxed mt-1">
                        Please don't paste CV contents into the message box.
                      </p>
                    </div>
                    )}

                    {/* §6.4: explicit CV recovery — the application is stored;
                        the person retries the attach (fresh token each time)
                        or knowingly continues without a CV. */}
                    {cvRetry && (
                      <div className="p-3 rounded-2xl border border-amber-300 bg-amber-50 space-y-2">
                        <p className="text-[11px] font-bold text-amber-900">
                          Your application is safely received — only the CV attachment is outstanding.
                          {cvFile ? ` "${cvFile.name}" is still selected.` : ' Pick a file above to attach one.'}
                        </p>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={handleCvRetry}
                            disabled={subCareers.pending || !cvFile}
                            className="px-3 py-1.5 bg-[#A46832] hover:bg-[#2E2A26] disabled:opacity-60 text-white rounded-full text-[10px] font-black uppercase tracking-wider cursor-pointer"
                          >
                            {subCareers.pending ? 'Uploading…' : 'Retry CV upload'}
                          </button>
                          <button
                            type="button"
                            onClick={handleCvSkip}
                            disabled={subCareers.pending}
                            className="px-3 py-1.5 bg-white border border-amber-300 hover:bg-amber-100 text-amber-900 rounded-full text-[10px] font-black uppercase tracking-wider cursor-pointer"
                          >
                            Continue without CV
                          </button>
                        </div>
                      </div>
                    )}

                    <TurnstileWidget bind={tsCareers} />
                    <NoticeBlock audience="careers" />
                    <button
                      id="app-submit-btn"
                      type="submit"
                      disabled={subCareers.pending || !noticeFor('careers')}
                      className="w-full py-3.5 bg-[#A46832] hover:bg-[#2E2A26] text-white rounded-full text-xs font-black uppercase tracking-wider transition-colors cursor-pointer disabled:opacity-60"
                    >
                      {subCareers.pending ? 'Submitting…' : 'Submit Career Application'}
                    </button>
                  </form>
                </div>
              ) : (
                <div className="text-center py-10 text-gray-500">
                  <p className="text-xs font-bold font-display uppercase">Select a role in the left list</p>
                  <p className="text-2xs mp-muted">Select a role to view its details and apply.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ==================== FRANCHISE PAGE ==================== */}
      {currentTab === 'franchise' && (
        <div className="py-12 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center space-y-3 mb-10">
            <span className="text-[10px] bg-[#A46832] text-white px-3 py-1 rounded-full font-black uppercase tracking-widest">
              {c.franchisePage.kicker}
            </span>
            <h1 className="font-display text-4xl font-black text-[#2E2A26]">
              {c.franchisePage.heading}
            </h1>
            <p className="text-xs text-[#2E2A26]/75 max-w-md mx-auto">
              {c.franchisePage.intro}
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
            {/* Business values checklist (5 cols) */}
            <div className="lg:col-span-5 space-y-6">
              <div className="bg-[#EBDECE]/30 p-8 rounded-3xl border border-[#A46832]/30 space-y-4">
                {/* LAUNCH-POLISH (R4.6, round 3): h3 -> h2. This is the first
                    heading of its section and sits directly under the page h1,
                    so h3 skipped a level. Styling is class-based, so the
                    rendered page is pixel-identical — only the outline changes. */}
                <h2 className="font-display text-xs uppercase font-extrabold tracking-wider text-[#A46832]">
                  {c.franchisePage.whyHeading}
                </h2>
                
                <div className="space-y-3">
                  {c.franchisePage.whyPoints.map((point, i) => (
                    <div key={i} className="flex items-start space-x-2">
                      <CheckCircle className="h-5 w-5 text-[#A46832] shrink-0 mt-0.5" />
                      <div>
                        <h4 className="text-2xs font-extrabold uppercase">{point.title}</h4>
                        <p className="text-[10px] text-[#2E2A26]/80">{point.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Requirements threshold card — shown only once real figures exist */}
              {c.franchisePage.stats.some((s) => s.value && s.value !== 'N/A') && (
              <div className="bg-white p-6 rounded-3xl border border-[#EBDECE] space-y-3 text-left">
                <h4 className="text-2xs font-bold text-gray-500 uppercase tracking-widest">{c.franchisePage.statsHeading}</h4>
                <div className="grid grid-cols-2 gap-4 text-center">
                  {c.franchisePage.stats.filter((s) => s.value && s.value !== 'N/A').map((stat, i) => (
                    <div key={i} className="bg-[#FFFFFF] p-3 rounded-2xl">
                      <span className="block text-sm font-mono font-black text-[#A46832]">{stat.value}</span>
                      <span className="text-[9px] uppercase tracking-wide mp-muted font-bold">{stat.label}</span>
                    </div>
                  ))}
                </div>
              </div>
              )}
            </div>

            {/* Inquiry Form Column (7 cols) */}
            <div className="lg:col-span-7 bg-white p-8 rounded-3xl border border-[#EBDECE]/40 shadow-xs space-y-6 text-left">
              <h3 className="font-display text-sm font-black uppercase text-[#2E2A26]">
                {c.franchisePage.formHeading}
              </h3>

              <form onSubmit={handleFranchiseSubmit} className="mp-public-form space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="fran-name" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">Full Name</label>
                    <input
                      id="fran-name"
                      type="text"
                      required
                      autoComplete="name"
                      maxLength={200}
                      value={franchiseForm.fullName}
                      onChange={(e) => setFranchiseForm({ ...franchiseForm, fullName: e.target.value })}
                      className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832]"
                      placeholder="e.g. Johnathan Cross"
                    />
                  </div>
                  <div>
                    <label htmlFor="fran-email" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">Email Address</label>
                    <input
                      id="fran-email"
                      type="email"
                      required
                      autoComplete="email"
                      maxLength={320}
                      value={franchiseForm.email}
                      onChange={(e) => setFranchiseForm({ ...franchiseForm, email: e.target.value })}
                      className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832]"
                      placeholder="john@retailgroup.com"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="fran-phone" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">Phone number <span className="normal-case font-medium">(optional)</span></label>
                  <input
                    id="fran-phone"
                    type="tel"
                    autoComplete="tel"
                    minLength={7}
                    maxLength={50}
                    pattern="[+0-9(][0-9 ()-]{6,49}"
                    title="Enter a telephone number using digits, spaces, brackets, + or -"
                    value={franchiseForm.phone}
                    onChange={(e) => setFranchiseForm({ ...franchiseForm, phone: e.target.value })}
                    className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832]"
                    placeholder="e.g. +44 7700 900077"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="fran-city" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">Target city</label>
                    <input
                      id="fran-city"
                      type="text"
                      required
                      autoComplete="address-level2"
                      maxLength={100}
                      value={franchiseForm.city}
                      onChange={(e) => setFranchiseForm({ ...franchiseForm, city: e.target.value })}
                      className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832]"
                      placeholder="e.g. Nottingham, Bristol, Leeds"
                    />
                  </div>
                  <div>
                    <label htmlFor="fran-country" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">Country</label>
                    <input
                      id="fran-country"
                      type="text"
                      required
                      autoComplete="country-name"
                      maxLength={100}
                      value={franchiseForm.country}
                      onChange={(e) => setFranchiseForm({ ...franchiseForm, country: e.target.value })}
                      className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="fran-budget" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">Investment Budget</label>
                    <select
                      id="fran-budget"
                      value={franchiseForm.budget}
                      required
                      onChange={(e) => setFranchiseForm({ ...franchiseForm, budget: e.target.value })}
                      className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832]"
                    >
                      <option value="" disabled>Select a budget range…</option>
                      <option value="£50,000 - £100,000">£50,000 - £100,000</option>
                      <option value="£100,000 - £150,000">£100,000 - £150,000</option>
                      <option value="£150,000 - £300,000">£150,000 - £300,000</option>
                      <option value="£300,000+">£300,000+</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="fran-experience" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">Previous business or hospitality experience</label>
                    <select
                      id="fran-experience"
                      value={franchiseForm.experience}
                      required
                      onChange={(e) => setFranchiseForm({ ...franchiseForm, experience: e.target.value })}
                      className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832]"
                    >
                      <option value="">Select experience…</option>
                      <option value="Yes, multi-site retail">Multi-site retail or hospitality experience</option>
                      <option value="Single coffee unit">Single-site owner or operator experience</option>
                      <option value="Corporate background">Business or investment background</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label htmlFor="fran-msg" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">Anything else</label>
                  <textarea
                    id="fran-msg"
                    maxLength={5000}
                    value={franchiseForm.message}
                    onChange={(e) => setFranchiseForm({ ...franchiseForm, message: e.target.value })}
                    className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832] h-24"
                    placeholder="Tell us anything useful about your plans, timing or experience…"
                  />
                </div>

                <div className="bg-amber-50 p-4 border border-[#A46832]/30 rounded-xl">
                  <p className="text-[10px] text-gray-700 leading-relaxed font-light">
                    Submitting an enquiry does not guarantee approval or reserve a territory. Any opportunity is subject to suitability checks, due diligence and a signed franchise agreement.
                  </p>
                </div>

                <TurnstileWidget bind={tsFranchise} />
                <NoticeBlock audience="franchise" />
                <button
                  id="fran-submit-btn"
                  type="submit"
                  disabled={subFranchise.pending || !noticeFor('franchise')}
                  className="w-full py-4 bg-[#A46832] hover:bg-[#2E2A26] disabled:opacity-60 disabled:cursor-wait text-white rounded-full text-xs tracking-wider uppercase font-extrabold transition-colors cursor-pointer"
                >
                  {subFranchise.pending ? 'Sending…' : 'Send enquiry'}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ==================== ABOUT PAGE ==================== */}
      {currentTab === 'about' && (
        <div className="py-12 max-w-5xl mx-auto px-4 sm:px-6">
          {/* Hero Header */}
          <div className="text-center space-y-6 mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-[#EBDECE]/50 rounded-full">
              <Star className="h-3 w-3 text-[#A46832]" />
              <span className="text-[10px] text-[#2E2A26] font-black uppercase tracking-widest">{c.aboutPage.badge}</span>
            </div>
            <h1 className="font-display text-5xl md:text-6xl font-black text-[#2E2A26] leading-tight max-w-3xl mx-auto tracking-tight">
              {c.aboutPage.heading} <span className="text-[#A46832] italic">{c.aboutPage.headingAccent}</span>
            </h1>
            <p className="text-sm md:text-base text-gray-500 max-w-xl mx-auto font-light leading-relaxed">
              {c.aboutPage.intro}
            </p>
          </div>

          {/* Main Story & Values */}
          <div className="space-y-24 text-left">
            
            {/* The Craft (Image Left, Text Right) */}
            <div className="grid md:grid-cols-2 gap-12 items-center">
              <div className="aspect-square bg-[#FFFFFF] rounded-[40px] overflow-hidden relative group shadow-sm border border-[#EBDECE]">
                  {isEditingMode ? (
                    <ImageUploadInline
                      currentImageUrl={c.aboutPage.craftImage}
                      onImageChange={(val) => editAboutImage('craftImage', val)}
                      className="w-full h-full"
                      imgClassName="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
                    />
                  ) : (
                    <>
                      <div className="flex h-full w-full items-center justify-center bg-[#F7EFE6] p-10">
                        <img src={MASCOT.holdShake} alt="" aria-hidden="true" width={340} height={699} loading="lazy" decoding="async" className="h-full w-full object-contain" />
                      </div>
                      {craftImageUrl && (
                        <img src={craftImageUrl} loading="lazy" decoding="async" className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" alt="Milk Pop preparation and cafe atmosphere" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
                      )}
                    </>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-[#2E2A26]/30 to-transparent pointer-events-none"></div>
              </div>
              <div className="space-y-6 md:pl-8">
                  <h2 className="font-display text-3xl font-black text-[#2E2A26]">{c.aboutPage.craftHeading}</h2>
                  <p className="text-sm text-[#2E2A26]/85 leading-relaxed font-light whitespace-pre-line">
                      {c.aboutPage.craftText}
                  </p>
                  {(c.aboutPage.craftBadgeText && c.aboutPage.craftBadgeText !== 'N/A') && (
                  <div className="flex items-center gap-4 pt-4">
                      <div className="w-12 h-12 bg-[#EBDECE]/50 rounded-full flex items-center justify-center">
                          <Leaf className="h-5 w-5 text-[#A46832]" />
                      </div>
                      <div>
                          <h4 className="font-bold text-xs text-[#2E2A26] uppercase tracking-wider">{c.aboutPage.craftBadgeTitle}</h4>
                          <span className="text-xs text-gray-500">{c.aboutPage.craftBadgeText}</span>
                      </div>
                  </div>
                  )}
              </div>
            </div>

            {/* The Culture (Text Left, Image Right) */}
            <div className="grid md:grid-cols-2 gap-12 items-center">
              <div className="order-2 md:order-1 space-y-6 md:pr-8">
                  <h2 className="font-display text-3xl font-black text-[#2E2A26]">{c.aboutPage.cultureHeading}</h2>
                  <p className="text-sm text-[#2E2A26]/85 leading-relaxed font-light whitespace-pre-line">
                      {c.aboutPage.cultureText}
                  </p>
                  <div className="flex items-center gap-4 pt-4">
                      <div className="w-12 h-12 bg-[#7CC0C7]/30 rounded-full flex items-center justify-center">
                          <Heart className="h-5 w-5 text-[#3b8c8d]" />
                      </div>
                      <div>
                          <h4 className="font-bold text-xs text-[#2E2A26] uppercase tracking-wider">{c.aboutPage.cultureBadgeTitle}</h4>
                          <span className="text-xs text-gray-500">{c.aboutPage.cultureBadgeText}</span>
                      </div>
                  </div>
              </div>
              <div className="order-1 md:order-2 aspect-square bg-[#FFFFFF] rounded-[40px] overflow-hidden relative group shadow-sm border border-[#EBDECE]">
                  {isEditingMode ? (
                    <ImageUploadInline
                      currentImageUrl={c.aboutPage.cultureImage}
                      onImageChange={(val) => editAboutImage('cultureImage', val)}
                      className="w-full h-full"
                      imgClassName="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
                    />
                  ) : (
                    <>
                      <div className="flex h-full w-full items-center justify-center bg-[#F7EFE6] p-10">
                        <img src={MASCOT.sitShake} alt="" aria-hidden="true" width={356} height={692} loading="lazy" decoding="async" className="h-full w-full object-contain" />
                      </div>
                      {cultureImageUrl && (
                        <img src={cultureImageUrl} loading="lazy" decoding="async" className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" alt="Milk Pop team and culture" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
                      )}
                    </>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-[#2E2A26]/30 to-transparent pointer-events-none"></div>
              </div>
            </div>

            {/* The Pillars (3 column grid) */}
            <div className="text-center space-y-12 bg-[#2E2A26] py-16 px-8 sm:px-12 rounded-[40px] text-white shadow-xl">
              <div className="max-w-2xl mx-auto space-y-4">
                <span className="text-[10px] text-[#A46832] font-black uppercase tracking-widest">{c.aboutPage.pillarsKicker}</span>
                <h2 className="font-display text-4xl font-black text-[#FFFFFF]">{c.aboutPage.pillarsHeading}</h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-left">
                  {/* Pillars come from Website Studio; the launch icon/colour
                      treatments cycle for any card count. */}
                  {c.aboutPage.pillars.map((pillar, i) => {
                    const look = [
                      { Icon: Sparkles, tone: 'text-[#A46832]' },
                      { Icon: Coffee, tone: 'text-[#7CC0C7]' },
                      { Icon: Award, tone: 'text-[#EBDECE]' },
                    ][i % 3]!;
                    const IconComp = look.Icon;
                    return (
                      <div key={i} className="space-y-4 p-8 bg-white/5 rounded-3xl border border-white/10 hover:bg-white/10 transition-colors">
                          <IconComp className={`h-8 w-8 ${look.tone}`} />
                          <h3 className="font-bold text-base text-[#FFFFFF] uppercase tracking-wide">{pillar.title}</h3>
                          <p className="text-xs text-white/70 font-light leading-relaxed">
                              {pillar.text}
                          </p>
                      </div>
                    );
                  })}
              </div>
            </div>

          </div>
        </div>
      )}

      {/* ==================== CONTACT PAGE ==================== */}
      {currentTab === 'contact' && (
        <div className="py-12 max-w-4xl mx-auto px-4 sm:px-6">
          <div className="text-center space-y-3 mb-10">
            <span className="text-[10px] bg-[#EBDECE] px-3 py-1 rounded-full text-[#8F5322] font-black uppercase tracking-widest">
              {c.contactPage.kicker}
            </span>
            <h1 className="font-display text-4xl font-black text-[#2E2A26]">
              {c.contactPage.heading}
            </h1>
            <p className="text-xs mp-muted max-w-sm mx-auto">
              {c.contactPage.intro}
            </p>
          </div>

          <div className="bg-white p-8 rounded-3xl border border-[#EBDECE]/40 shadow-xs text-left grid grid-cols-1 md:grid-cols-12 gap-8">
            <div className="md:col-span-5 space-y-6 border-b md:border-b-0 md:border-r border-[#EBDECE]/40 pb-6 md:pb-0 md:pr-8">
              {c.contactPage.routes.some((route) => safeMailtoHref(route.email)) && (
                <div className="space-y-4">
                  <h2 className="font-display text-[#A46832] text-xs font-black uppercase tracking-wider">
                    {c.contactPage.routesHeading}
                  </h2>
                  <div className="space-y-4 text-xs">
                    {c.contactPage.routes.filter((route) => safeMailtoHref(route.email)).map((route, i) => (
                      <div key={i}>
                        <h3 className="font-bold">{route.label}</h3>
                        <a className="text-gray-500 text-2xs hover:underline break-all" href={safeMailtoHref(route.email)}>{route.email}</a>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="bg-[#7CC0C7]/20 p-4 rounded-2xl">
                <p className="text-[10px] text-gray-700 leading-relaxed font-light">
                  {c.contactPage.locatorNote}
                </p>
                <a
                  id="contact-stores-btn-redirect"
                  href={routeToPath('stores')}
                  onClick={(e) => handleAnchorNav(e, () => setCurrentTab('stores'))}
                  className="mt-2 inline-block text-[10px] font-black text-[#8F5322] uppercase hover:underline cursor-pointer"
                >
                  {c.contactPage.locatorCta}
                </a>
              </div>
            </div>

            <form onSubmit={handleContactSubmit} className="mp-public-form md:col-span-7 space-y-4">
              <div>
                <label htmlFor="contact-name" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">
                  Full Name
                </label>
                <input
                  id="contact-name"
                  type="text"
                  required
                  autoComplete="name"
                  maxLength={200}
                  value={contactForm.fullName}
                  onChange={(e) => setContactForm({ ...contactForm, fullName: e.target.value })}
                  className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832]"
                  placeholder="e.g. Liam Foster"
                />
              </div>

              <div>
                <label htmlFor="contact-email" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">
                  Email Address
                </label>
                <input
                  id="contact-email"
                  type="email"
                  required
                  autoComplete="email"
                  maxLength={320}
                  value={contactForm.email}
                  onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })}
                  className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832]"
                  placeholder="liam@gmail.com"
                />
              </div>

              <div>
                <label htmlFor="contact-reason" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">
                  Reason for Contact
                </label>
                <select
                  id="contact-reason"
                  value={contactForm.reason}
                  onChange={(e) => setContactForm({ ...contactForm, reason: e.target.value })}
                  className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832]"
                >
                  <option value="General feedback">General question or feedback</option>
                  <option value="Career queries">Careers question</option>
                  <option value="Partnerships">Business enquiry</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              <div>
                <label htmlFor="contact-msg" className="block text-[10px] uppercase font-black tracking-wider text-gray-500 mb-1">
                  Message Details
                </label>
                <textarea
                  id="contact-msg"
                  required
                  maxLength={5000}
                  value={contactForm.message}
                  onChange={(e) => setContactForm({ ...contactForm, message: e.target.value })}
                  className="w-full text-xs p-3 bg-[#FFFFFF] border border-[#EBDECE] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#A46832] h-28"
                  placeholder="How can we help?"
                />
              </div>

              <TurnstileWidget bind={tsContact} />
              <NoticeBlock audience="contact" />
              <button
                id="contact-submit-btn"
                type="submit"
                disabled={subContact.pending || !noticeFor('contact')}
                className="w-full py-4 bg-[#A46832] hover:bg-[#2E2A26] disabled:opacity-60 disabled:cursor-wait text-white rounded-full text-xs font-black uppercase tracking-wider transition-colors cursor-pointer"
              >
                {subContact.pending ? 'Sending…' : 'Send Message'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ==================== NEWS PAGE ==================== */}
      {currentTab === 'news' && (() => {
        // Published posts (owner-managed with seed fallback). Each article has
        // its own URL — /news/<slug> — so posts can be shared and indexed.
        // R4.10 Increment 2: NO SEED FALLBACK. A site with no published news must
        // say so rather than invent an article. An empty archive is a real, honest
        // state — it is what a brand-new business looks like — and fabricating a
        // welcome post to fill the space is exactly the fake business content the
        // empty-launch definition forbids.
        /* SMALL-BIZ CLOSURE P0-7: `news` is now a PublicCollection — an outage
           renders as unavailable, never as "no news has been published". */
        const publishedPosts = (news.status === 'ready' ? news.items : []).filter((x) => x.status !== 'draft');
        const activePost = matchBySlug(publishedPosts, routeParams?.post, (pst: NewsPost) => postSlug(pst), (pst: NewsPost) => pst.id);

        if (activePost) {
          return (
            <article className="py-12 max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
              <a
                href={routeToPath('news')}
                onClick={(e) => handleAnchorNav(e, () => setCurrentTab('news'))}
                className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-[#A46832] hover:underline"
              >
                <ChevronRight className="h-3.5 w-3.5 rotate-180" />
                <span>All news</span>
              </a>

              <div className="flex items-center gap-3">
                <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full ${activePost.tagColor || 'bg-stone-100 text-stone-700'}`}>
                  {activePost.category}
                </span>
                <span className="text-[10px] mp-muted font-mono flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> {activePost.date}
                </span>
              </div>

              <h1 className="font-display text-3xl sm:text-4xl font-black text-[#2E2A26] leading-tight">
                {activePost.title}
              </h1>

              <div className="bg-white p-8 rounded-3xl border border-[#EBDECE]/40 shadow-2xs">
                <p className="text-sm text-[#2E2A26]/90 leading-relaxed font-light whitespace-pre-line">
                  {activePost.content}
                </p>
              </div>
            </article>
          );
        }

        return (
        <div className="py-12 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center space-y-3 mb-12">
            <span className="text-[10px] bg-[#EBDECE] text-gray-700 px-3 py-1 rounded-full font-black uppercase tracking-widest">
              {c.newsPage.kicker}
            </span>
            <h1 className="font-display text-4xl font-black text-[#2E2A26]">
              {c.newsPage.heading}
            </h1>
            <p className="text-xs text-gray-500 max-w-sm mx-auto">
              {c.newsPage.intro}
            </p>
          </div>

          {news.status !== 'ready' ? (
            /* SMALL-BIZ CLOSURE P0-7: a loading or failed news fetch shows its
               own state — the "no news yet" copy below is reserved for a
               database that genuinely answered with zero published posts. */
            <CollectionStatusNote status={news.status} label="our news" />
          ) : publishedPosts.length === 0 && (
            /* R4.10 Increment 2: the honest empty archive. A brand-new business
               has no news, and saying so is the truthful state — not a reason to
               publish an invented article. */
            <div className="text-center py-12">
              <p className="text-sm mp-muted">There is no news yet — updates will be posted here.</p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
            {publishedPosts.map((art: any, idx: number) => (
              <div key={art.id || idx} className="bg-white rounded-3xl overflow-hidden border border-[#EBDECE]/40 shadow-2xs hover:shadow-md transition-all flex flex-col justify-between">
                <div className="p-6 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full ${art.tagColor || 'bg-stone-100 text-stone-700'}`}>
                      {art.category}
                    </span>
                    <span className="text-[10px] mp-muted font-mono flex items-center gap-1">
                      <Calendar className="h-3 w-3" /> {art.date}
                    </span>
                  </div>

                  <h3 className="font-display text-[#2E2A26] font-black text-sm uppercase tracking-wide leading-snug">
                    <a
                      href={routeToPath('news', { post: postSlug(art) })}
                      onClick={(e) => handleAnchorNav(e, () => setCurrentTab('news', { post: postSlug(art) }))}
                      className="hover:underline"
                    >
                      {art.title}
                    </a>
                  </h3>

                  <p className="text-xs text-[#2E2A26]/85 leading-relaxed font-light lines-3">
                    {art.content}
                  </p>
                </div>

                <div className="px-6 pb-6 pt-3 border-t border-[#EBDECE]/20">
                  <a
                    href={routeToPath('news', { post: postSlug(art) })}
                    onClick={(e) => handleAnchorNav(e, () => setCurrentTab('news', { post: postSlug(art) }))}
                    className="text-[10px] font-black uppercase text-[#A46832] hover:underline flex items-center space-x-1 cursor-pointer"
                  >
                    <span>Read Article</span>
                    <ChevronRight className="h-4 w-4" />
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
        );
      })()}

      {/* ----------- LEGAL & COMPLIANCE ----------- */}

      {/* ==================== LEGAL PAGES ====================
          Fully editable from Website Studio -> Legal pages. Bodies are plain
          text: a blank line starts a new paragraph; a short first line of a
          paragraph renders as a sub-heading. */}
      {(['privacy', 'gdpr', 'fdd'] as const).map(legalKey => (
        currentTab === legalKey && (
          <div key={legalKey} className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-24 space-y-8 animate-fade-in relative z-20">
            <h1 className="text-3xl font-display font-black tracking-tight uppercase text-[#2E2A26]">{c.legal[legalKey].title}</h1>
            <div className="prose prose-sm text-[#2E2A26]/80 space-y-4">
              {c.legal[legalKey].body.split('\n\n').map((para, i) => {
                const lines = para.split('\n');
                const firstLine = lines[0] ?? '';
                const isHeadingLead = lines.length > 1 && firstLine.trim().length < 80 && !firstLine.trim().startsWith('•');
                if (isHeadingLead) {
                  return (
                    <div key={i} className="space-y-2">
                      <h2 className="text-lg font-bold text-[#2E2A26] mt-6">{lines[0]}</h2>
                      <p className="whitespace-pre-line">{lines.slice(1).join('\n')}</p>
                    </div>
                  );
                }
                const isShortLead = lines.length === 1 && para.trim().length < 60;
                return (
                  <p key={i} className={isShortLead ? 'font-bold whitespace-pre-line' : 'whitespace-pre-line'}>{para}</p>
                );
              })}
            </div>
          </div>
        )
      ))}
      </div>
    </div>
  );
};
