/* ============================================================
   VAT LIFECYCLE (Stage 3 WS6d, closure brief §1)
   ============================================================ */
/** Store-level VAT registration status. Launch position: NOT_REGISTERED —
 *  tax charged 0, tax amount 0, no VAT number, no fallback rate anywhere. */
export type VatStatus = 'NOT_REGISTERED' | 'REGISTERED';
/** Controlled product tax classification (tax_codes registry). Reference
 *  values for the future REGISTERED mode; while the store is NOT_REGISTERED
 *  every sale records rate 0 / tax 0 regardless of classification. */
export type TaxCode = 'ZERO_RATED' | 'STANDARD_RATE' | 'REDUCED_RATE' | 'OUTSIDE_SCOPE';
/** Store setup lifecycle (WS6e): DRAFT = the owner Setup Wizard has not been
 *  completed and the store cannot trade; ACTIVE = fully configured. Distinct
 *  from StoreLocation.status, the public open/closed display state. */
export type SetupStatus = 'DRAFT' | 'ACTIVE';

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  category: 'milkshakes' | 'smoothies' | 'soft_serve' | 'slush' | 'extras';
  price: number;
  priceLarge?: number | null;
  calories: number;
  tags: string[];
  allergens: string[];
  image: string;
  /** R4.9 G4: server-controlled sale state. The anonymous surface
   *  (menu_items_public) contains available rows ONLY, so this is always true
   *  for anything a customer can see; staff surfaces read the base table and
   *  see both. Never published from the browser — see cloudSync's `omit`. */
  available: boolean;
  /** Controlled VAT classification; null/absent = not yet classified.
   *  Classification is an explicit owner act — never defaulted. */
  taxCode?: TaxCode | null;
}

/**
 * R4.9 G4 — public content is one of three states, never "an array or the
 * built-in seeds". There is deliberately no fourth state and no default: a
 * consumer must handle `loading` and `unavailable` explicitly, so the
 * `items || INITIAL_X` idiom that shipped seed products and prices to
 * customers on a failed fetch cannot be written at all.
 */
export type PublicCollection<T> =
  | { status: 'loading' }
  | { status: 'ready'; items: T[] }
  | { status: 'unavailable' };

/** The items when ready, otherwise none — for read-only consumers that treat
 *  "still loading" and "unavailable" the same way (e.g. counting). Callers that
 *  RENDER must switch on `status` instead. */
export function collectionItems<T>(c: PublicCollection<T>): T[] {
  return c.status === 'ready' ? c.items : [];
}

export interface StoreLocation {
  id: string;
  name: string;
  address: string;
  postcode: string;
  openingHours: string;
  status: 'open' | 'closed' | 'coming_soon';
  deliveryLinks: {
    deliveroo?: string;
    uberEats?: string;
    justEat?: string;
  };
  phone: string;
  email: string;
  image: string;
  /** Optional: omit until a real location is confirmed — the SEO prerenderer
   *  emits geo JSON-LD only when this is present, so it must never hold a
   *  placeholder/fabricated coordinate. */
  coordinates?: { lat: number; lng: number };
  /* --- VAT lifecycle (WS6d) — READ-ONLY in the browser. The client never
     pushes these (cloudSync omits them); they are configured server-side and,
     from the setup-lifecycle round, via the owner Store Setup Wizard. --- */
  vatStatus?: VatStatus;
  vatNumber?: string | null;
  vatRegistrationEffectiveDate?: string | null;
  vatConfigConfirmedAt?: string | null;
  /* --- Setup lifecycle + operational configuration (WS6e) — READ-ONLY in
     the browser; written only by configure_store_setup() (owner + MFA). --- */
  setupStatus?: SetupStatus;
  timezone?: string | null;
  currencyCode?: string | null;
  paymentMethods?: PaymentMethod[] | null;
  receiptFooter?: string | null;
}

export interface CareerVacancy {
  id: string;
  title: string;
  department: string;
  location: string;
  salary: string;
  type: 'Full-time' | 'Part-time';
  roleDescription: string;
  requirements: string[];
  responsibilities: string[];
  /** R4.10: server-controlled publication state. The public careers page reads
   *  job_vacancies_public (published rows only); staff surfaces read the base
   *  table and see every state. Never written through replace_collection —
   *  the server strips it — only through publish_record. Absent on rows
   *  hydrated before this release: treat undefined as 'draft'. */
  status?: 'draft' | 'published' | 'closed';
}

export interface JobApplication {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  /** T13.3.11: exact public vacancy selected at submission time. */
  vacancyId?: string | undefined;
  position: string;
  store: string;
  availability: string;
  experience: string;
  // Stage 2.1 F8: the browser only learns WHETHER a CV exists, never the
  // private storage path. The CV is fetched on demand via cv-signed-url.
  hasCv?: boolean | undefined;
  message: string;
  status: 'pending' | 'reviewing' | 'interview' | 'offer' | 'declined';
  appliedAt: string;
}

export interface FranchiseInquiry {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  country: string;
  city: string;
  budget: string;
  experience: string;
  message: string;
  status: 'pending' | 'reviewed' | 'contacted' | 'approved' | 'declined';
  submittedAt: string;
}

export interface ContactMessage {
  id: string;
  fullName: string;
  email: string;
  reason: string;
  message: string;
  status: 'new' | 'replied' | 'closed';
  submittedAt: string;
  repliedAt?: string;
  closedAt?: string;
}

export type EmployeeRole =
  | 'team_member'
  | 'supervisor'
  | 'store_manager'
  | 'owner';

export interface EmployeeProfile {
  id: string;
  name: string;
  email: string;
  // SECURITY: no `password` / `mustChangePassword` fields. Credentials must
  // never exist in client state, localStorage, or sync payloads. Staff
  // authentication is server-side only (Supabase Auth) — see README.md (Security).
  role: EmployeeRole;
  storeId: string;
  storeName: string;
  nextShift: string;
  holidayBalance: number;
  points: number;
  level: number;
  badges: string[];
  avatar: string;
  payRate?: number | undefined;
  payType?: 'hourly' | 'salary';
  /* STAGE 9 — honest onboarding lifecycle, written ONLY by the staff-invite
     Edge Function (service role). */
  status?: 'active' | 'disabled' | undefined;
  onboarding?: 'profile_created' | 'invited' | 'active' | undefined;
  invitedAt?: string;
}

export interface TrainingQuestion {
  id: string;
  text: string;
  type: 'multiple_choice' | 'true_false' | 'scenario' | 'drag_drop' | 'image_match';
  options: string[];
  /** ABSENT for trainees — FIX-9 (TRN-002) redacts the key server-side;
   *  only manager/owner sessions receive it. Grading is always server-side. */
  correctAnswer?: string;
  /** Optional index form used by the admin course builder. */
  correctAnswerIndex?: number;
  /** ABSENT for trainees (would disclose the key before submission). */
  explanation?: string;
  difficulty: 'easy' | 'medium' | 'hard';
  categoryTag: string;
  /**
   * DRAG & DROP questions only. A sentence/paragraph where every gap is
   * written inline as [[answer]] — e.g.
   *   "Chilled food must be kept at [[8]] °C or below; frozen at [[-18]] °C."
   * The word bank shown to staff = every [[answer]] + `dragDistractors`,
   * shuffled. A question is correct when every gap holds its exact word.
   */
  dragTemplate?: string | undefined;
  /** REDACTED delivery only (FIX-9): the gap words as an alphabetised bank —
   *  the template's gaps arrive blanked to [[⋯]], so the bank rides here. */
  dragWords?: string[];
  /** Extra wrong words mixed into the drag & drop word bank. */
  dragDistractors?: string[] | undefined;
}

/** One learning slide. Legacy records ({title, content}) render as text. */
export interface TrainingSlide {
  title: string;
  content: string;
  /** 'text' (default) or 'video'. */
  type?: 'text' | 'video';
  /**
   * Video source. Either a normal https URL (direct .mp4/.webm or a
   * YouTube link) or a `storage://training-media/<path>` reference to the
   * private Supabase Storage bucket (resolved to a signed URL at play time).
   */
  videoUrl?: string;
  /**
   * When true the player blocks seeking ahead and the "Next" button stays
   * locked until the video has been watched to the end. Only enforceable
   * for direct video files — YouTube embeds cannot be locked.
   */
  noSkip?: boolean;
}

export interface TrainingAssessment {
  id: string;
  title: string;
  description: string;
  learningObjectives: string[];
  passingScore: number;
  slides?: TrainingSlide[];
  questions: TrainingQuestion[];
  category: 'brand' | 'menu' | 'operations' | 'safety' | 'service';
  points: number;
  badge: string;
  /** Default deadline (days after assignment) used when assigning this module. */
  dueDays?: number;
  /** Mandatory modules are flagged prominently to staff. */
  mandatory?: boolean;
}

/* ============================================================
   TRAINING ASSIGNMENTS — an owner/manager assigns a module to a
   staff member with a due date. Mirrors `training_assignments`.
   ============================================================ */
export interface TrainingAssignment {
  id: string;
  assessmentId: string;
  assessmentTitle: string;
  employeeId: string;
  employeeName: string;
  assignedBy: string;
  assignedAt: string;          // ISO
  dueDate: string;             // YYYY-MM-DD
  status: 'assigned' | 'in_progress' | 'completed';
  completedAt?: string;        // ISO
  score?: number;              // final % on completion
}

/* ============================================================
   TRAINING CERTIFICATES — issued automatically when a staff
   member passes a module. Mirrors `training_certificates`.
   The certificate e-mail is sent server-side (send-email fn,
   template `training_certificate`, recipient = self).
   ============================================================ */
export interface TrainingProgressRecord {
  /** "<employeeId>:<courseId>" — pinned by RLS so a row is always the caller's own. */
  id: string;
  employeeId: string;
  courseId: string;
  progress: number;
}

export interface TrainingCertificate {
  id: string;                  // human-readable cert no, e.g. MP-FS1-1719...
  employeeId: string;
  employeeName: string;
  assessmentId: string;
  assessmentTitle: string;
  category: string;
  score: number;               // %
  issuedAt: string;            // ISO
  emailedAt?: string | undefined;          // ISO — set once the cert e-mail was sent
}

export interface TrainingCourse {
  id: string;
  title: string;
  description: string;
  category: 'induction' | 'customer_service' | 'products' | 'food_safety' | 'health_safety' | 'operations' | 'leadership';
  progress: number;
  points: number;
  estimatedTime: string;
  badge: string;
  assessmentId?: string;
}

export interface SIFRReport {
  id: string;
  title: string;
  category: 'attendance' | 'communication' | 'behaviour' | 'training' | 'customer_service' | 'health_safety' | 'operations' | 'teamwork' | 'other';
  date: string;
  involvedPeople: string;
  storeId: string;
  storeName: string;
  description: string;
  impact: string;
  suggestedAction: string;
  confidentiality: 'confidential' | 'standard';
  status: 'submitted' | 'under_review' | 'escalated' | 'action_required' | 'resolved' | 'closed';
  reporterName: string;
  reporterId: string;
  submittedAt: string;
  replies?: SIFRComment[];
}

export type CreateSIFRReportInput = Pick<SIFRReport,
  'title' | 'category' | 'involvedPeople' | 'description' | 'impact' | 'suggestedAction' | 'confidentiality'
>;

export interface SIFRComment {
  id: string;
  user: string;
  role: string;
  message: string;
  timestamp: string;
}

export interface StaffDocument {
  id: string;
  name: string;
  /** Owner of the document — legacy records without one are manager-visible only. */
  employeeId?: string | undefined;
  employeeName?: string | undefined;
  type: string;
  category: 'contracts' | 'compliance' | 'payslips' | 'performance' | 'id_verification';
  uploadDate: string;
  status: 'approved' | 'pending' | 'action_required';
  /** Storage reconciliation is separate from HR approval. Non-active rows are owner-visible only. */
  fileState?: 'active' | 'deletion_pending' | 'missing' | undefined;
  deletionError?: string | undefined;
  approvedBy?: string | undefined;
  expiryDate?: string | undefined;
  /* STAGE 3 — the file lives in the PRIVATE `staff-documents` Storage bucket.
     There is deliberately NO url field: viewing goes through the
     `staff-doc-url` Edge Function, which issues a 60-second signed URL after
     an access check. Base64 payloads never enter app state or the database. */
  storeId?: string | undefined;
  storeName?: string | undefined;
  storagePath?: string | undefined;
  originalFilename?: string | undefined;
  mimeType?: string | undefined;
  sizeBytes?: number | undefined;
  checksum?: string | undefined;
  uploadedBy?: string | undefined;
  verifiedBy?: string | undefined;
  verifiedAt?: string | undefined;
}

export interface KnowledgeArticle {
  id: string;
  title: string;
  category: 'recipes' | 'opening' | 'closing' | 'cleaning' | 'service' | 'equipment' | 'safety' | 'policies';
  lastUpdated: string;
  author: string;
  readingTime: string;
  content: string;
  steps?: string[];
}

export interface WorkShift {
  id: string;
  employeeId: string;
  employeeName: string;
  role: EmployeeRole;
  storeId: string;
  storeName: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string; // HH:MM
  type: 'opening' | 'mid' | 'closing' | 'delivery' | 'training';
  notes?: string | undefined;
}

export interface ClockStatus {
  employeeId: string;
  status: 'clocked_out' | 'clocked_in' | 'on_break';
  lastActivity: string; // ISO string
  clockInTime?: string; // ISO String
  breakStartTime?: string; // ISO String
  accumulatedBreakMs?: number; // Break duration in milliseconds
}

export interface ClockHistoryItem {
  id: string;
  employeeId: string;
  employeeName: string;
  date: string; // YYYY-MM-DD
  clockIn: string; // ISO String
  clockOut?: string; // ISO String
  breakDurationMinutes?: number;
  totalDecimalHours?: number;
  /** false/undefined = Pending, true = Approved by a store manager / owner. */
  approved?: boolean;
  /** true = a manager rejected these hours; excluded from pay. */
  rejected?: boolean;
  approvedBy?: string;
  approvedAt?: string; // ISO String
  notes?: string;
}

/* ============================================================
   PAYSLIPS — generated per employee per calendar month from
   APPROVED timesheet hours, then emailed to the employee.
   Mirrors the Supabase `payslips` table.
   ============================================================ */
export interface Payslip {
  id: string;
  employeeId: string;
  employeeName: string;
  email: string;
  /** Calendar month key, e.g. "2026-06". */
  periodKey: string;
  /** Human label, e.g. "June 2026". */
  periodLabel: string;
  hoursTotal: number;
  hourlyRate: number;
  gross: number;
  deductions: number;
  net: number;
  status: 'draft' | 'sent';
  generatedAt: string; // ISO
  generatedBy: string;
  sentAt?: string; // ISO
}

/* ============================================================
   EMAIL NOTIFICATIONS — owner-configured; delivery happens via
   the Supabase Edge Function `send-email` (see supabase/functions).
   Stored in the app_state KV table so no schema change is needed.
   ============================================================ */
export interface EmailSettings {
  enabled: boolean;
  fromName: string;
  notifyNewShift: boolean;
  notifyPayslip: boolean;
}

// Enterprise Admin Panel Types
export interface NewsPost {
  id: string;
  title: string;
  content: string;
  category: 'Store Opening' | 'New Product' | 'Team Story' | 'Announcement' | 'Promotion';
  date: string;
  status: 'draft' | 'published';
  image?: string;
  tagColor?: string;
  /** INC11: frozen at first publication server-side; absent on drafts. */
  slug?: string;
}

export interface AuditLogItem {
  id: string;
  operatorName: string;
  role: string;
  action: string;
  timestamp: string;
  module: string;
  previousValue?: string | undefined;
  newValue?: string | undefined;
}

export interface MediaItem {
  id: string;
  name: string;
  folder: 'products' | 'stores' | 'banners' | 'documents' | 'brand';
  size: string;
  type: string;
  uploadedAt: string;
  url: string;
  /** R4.10: server-controlled publication state (media_assets.is_public).
   *  Only publish_record changes it; replace_collection strips it. Treat
   *  undefined (pre-release hydrations) as false. */
  isPublic?: boolean;
}

/** R4.10 — the six collections whose publication state moves ONLY through the
 *  publish_record RPC. Mirrors the server allow-list exactly. */
export type PublishableContentTable =
  /* INC11: the scope narrowed to the FOUR collections that decide public
   * output — media_assets and cms_pages left it (supersession note in
   * migration_inc11_publication_scope.sql). */
  | 'menu_items'
  | 'deals'
  | 'news_posts'
  | 'job_vacancies';

export interface CmsPageContent {
  id: string;
  pageName: string;
  title: string;
  heroHeadline: string;
  heroSubheadline: string;
  heroImage: string;
  aboutImage1?: string;
  aboutImage2?: string;
  ctaText: string;
  sectionContent: string;
  seoTitle: string;
  seoDescription: string;
  status: 'draft' | 'published';
  lastEditedBy: string;
  lastEditedDate: string;
}

export interface RolePermissionMatrix {
  role: EmployeeRole;
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  approve: boolean;
  publish: boolean;
}




/* ============================================================
   SALES / POS SYSTEM
   Mirrors the Supabase tables: orders, order_items,
   order_item_modifiers, deals (see supabase/schema.FRESH-INSTALL-ONLY.sql).
   ============================================================ */

export type OrderChannel = 'walk_in' | 'phone' | 'website' | 'deliveroo' | 'uber_eats' | 'just_eat';
export type OrderStatus = 'open' | 'completed' | 'refunded' | 'voided';
export type PaymentMethod = 'cash' | 'card' | 'online' | 'gift_card';
export type ItemSize = 'regular' | 'large' | 'one_size';

export interface OrderItemModifier {
  id: string;
  menuItemId: string;   // references an 'extras' menu item
  name: string;
  price: number;
  /* --- WS6f per-modifier VAT snapshot — SERVER-DERIVED, read-only in the
     browser. An extra is taxed by ITS OWN classification, never the base
     product's, so these are the authority for a mixed-rate line (whose line
     taxRate is null). Absent on legacy rows written before WS6f. --- */
  taxCode?: TaxCode | null;
  taxRate?: number | null;
  taxableAmount?: number | null;
  taxAmount?: number | null;
}

export interface OrderItem {
  id: string;
  menuItemId: string;
  name: string;
  category: MenuItem['category'];
  size: ItemSize;
  unitPrice: number;        // price of the chosen size at time of sale
  quantity: number;
  modifiers: OrderItemModifier[];
  lineTotal: number;        // (unitPrice + modifiers) * quantity, before deals
  notes?: string;
  /* --- immutable per-line VAT snapshot (WS6d), server-derived. Absent on
     lines that predate the VAT lifecycle and on client-side optimistic rows
     before the server echo. --- */
  taxCode?: TaxCode | null;      // product classification at time of sale
  taxRate?: number;              // applied rate (0 while NOT_REGISTERED)
  taxableAmount?: number;        // line total minus its share of the discount
  taxAmount?: number;            // contained VAT for this line
}

export interface AppliedDeal {
  dealId: string;
  dealName: string;
  discount: number;         // positive number subtracted from the order
}

export interface Order {
  id: string;
  orderNumber: number;       // human-friendly sequential number per device
  storeId: string;
  storeName: string;
  channel: OrderChannel;
  items: OrderItem[];
  appliedDeals: AppliedDeal[];
  subtotal: number;          // sum of line totals
  discountTotal: number;     // sum of applied deals
  /** Headline applied-rate SNAPSHOT: 0 while NOT_REGISTERED; the uniform
   *  per-line rate when a REGISTERED sale has one rate; null for a
   *  mixed-rate sale (the per-line snapshots are the authority). */
  taxRate: number | null;
  taxAmount: number;         // contained VAT (VAT-inclusive pricing; 0 at launch)
  total: number;             // subtotal - discounts (gross, VAT inclusive)
  /** Immutable snapshot of the store's VAT status at the moment of sale. */
  storeVatStatus?: VatStatus | null;
  /** VAT registration effective date snapshot (REGISTERED sales only). */
  vatEffectiveDate?: string | null;
  paymentMethod: PaymentMethod;
  cashReceived?: number | undefined;
  changeGiven?: number | undefined;
  status: OrderStatus;
  customerName?: string | undefined;
  staffId: string;
  staffName: string;
  placedAt: string;          // ISO
  completedAt?: string | undefined;
  refundReason?: string | undefined;
}

/** Configurable promotions, e.g. the brandbook combos "1+1" and "1+1=3". */
export interface Deal {
  id: string;
  name: string;
  description: string;
  type: 'bundle_price' | 'buy_x_get_y_free' | 'percent_off_category' | 'fixed_off_order';
  active: boolean;
  /* bundle_price: buy `buyQty` of category for `bundlePrice` */
  category?: MenuItem['category'];
  buyQty?: number;
  bundlePrice?: number;
  /* buy_x_get_y_free */
  freeQty?: number;
  /* percent_off_category */
  percentOff?: number;
  /* fixed_off_order */
  amountOff?: number;
  minOrderValue?: number;
  badge?: string;            // short label shown on menu/POS, e.g. "1+1=3"
}

/* ============================================================
   SITE SETTINGS — one editable record driving Navbar, Footer,
   contact info, VAT, currency and the announcement bar.
   ============================================================ */
export interface SiteSettings {
  brandName: string;
  legalName: string;
  companyNumber: string;
  websiteUrl: string;
  instagramHandle: string;
  instagramUrl: string;
  facebookUrl: string;
  twitterUrl: string;
  phone: string;
  email: string;
  gdprEmail: string;
  hqAddress: string;
  footerTagline: string;
  allergenNotice: string;
  announcementEnabled: boolean;
  announcementText: string;
  currencySymbol: string;    // e.g. '£'
  defaultOpeningHours: string;
  /** Optional public sections. Keep the everyday customer journey small until the owner enables them. */
  showCareers: boolean;
  showFranchise: boolean;
  showNews: boolean;
}

/* ============================================================
   STAFF CHECKLIST TEMPLATES — owner-editable in the Admin Panel,
   consumed by the Staff Portal "Shift Checklists" screen.
   ============================================================ */
export interface ChecklistTemplateItem {
  id: string;
  label: string;
  category: 'opening' | 'midday' | 'closing';
  critical: boolean;         // must be done before shift sign-off
  sortOrder: number;
}

/** Cloud connection status for the Supabase sync layer. */
export interface CloudStatus {
  configured: boolean;
  connected: boolean;
  health: 'healthy' | 'degraded' | 'offline';
  lastSyncAt?: string | undefined;
  lastError?: string | undefined;
  failedCollections?: string[] | undefined;
}

/**
 * Result of attempting a public-form submission (careers / franchise / contact).
 *
 * SECURITY / HONESTY (Phase 1 review remediation): a submission may only report
 * `submitted` after the required database INSERT has actually succeeded. When no
 * backend is configured the app returns `not_configured` and stores NOTHING —
 * no localStorage, no sessionStorage, no IndexedDB, no base64. On a backend
 * error the app returns `failed` with a coarse, non-sensitive `errorCode`
 * (never a raw Supabase / SQL / storage / network message) and whether a retry
 * might help.
 */
export type SubmissionResult =
  // WP-01: `submissionId` is the SERVER-minted row UUID returned by the
  // public-form Edge Function and validated client-side — never a client
  // placeholder. It is the only id a CV upload may be attached to.
  | { status: 'submitted'; submissionId: string }
  | { status: 'not_configured' }
  | { status: 'failed'; errorCode: string; retryable: boolean };

/** INC11: the current published privacy notice for one public-form audience —
 *  the row privacy_notice_current serves and every submission must echo. */
export interface PrivacyNoticeCurrent {
  audience: 'contact' | 'careers' | 'franchise';
  id: string;
  versionLabel: string;
  contentSha256: string;
  noticeText: string;
  policyUrl: string | null;
}
