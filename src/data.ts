import { MenuItem, StoreLocation, CareerVacancy, TrainingCourse, KnowledgeArticle, EmployeeProfile, SIFRReport, StaffDocument, WorkShift } from './types';

export const INITIAL_MENU_ITEMS: MenuItem[] = [
  // MILKSHAKES
  { id: 'm1', name: 'Kinder Bueno', description: 'A creamy milkshake with smooth Kinder Bueno flavour. (340ml / 400ml)', category: 'milkshakes', price: 5, priceLarge: 6, calories: 0, tags: ['Creamy', 'Chocolate'], allergens: ['Dairy', 'Nuts', 'Gluten', 'Soya'], image: '/brand/drinks/m1.svg' , available: true },
  { id: 'm2', name: 'Ferrero Rocher', description: 'A rich chocolate and hazelnut-inspired milkshake. (340ml / 400ml)', category: 'milkshakes', price: 5, priceLarge: 6, calories: 0, tags: ['Creamy', 'Chocolate'], allergens: ['Dairy', 'Nuts', 'Gluten', 'Soya'], image: '/brand/drinks/m2.svg' , available: true },
  { id: 'm3', name: 'Oreo', description: 'A classic cookies-and-cream milkshake with Oreo flavour. (340ml / 400ml)', category: 'milkshakes', price: 5, priceLarge: 6, calories: 0, tags: ['Creamy', 'Classic', 'Chocolate'], allergens: ['Dairy', 'Gluten', 'Soya'], image: '/brand/drinks/m3.svg' , available: true },
  { id: 'm4', name: 'Snickers', description: 'A creamy milkshake with chocolate, caramel and peanut-style flavour. (340ml / 400ml)', category: 'milkshakes', price: 5, priceLarge: 6, calories: 0, tags: ['Creamy', 'Chocolate'], allergens: ['Dairy', 'Nuts', 'Soya'], image: '/brand/drinks/m4.svg' , available: true },
  { id: 'm5', name: 'KitKat', description: 'A smooth chocolate wafer-style milkshake. (340ml / 400ml)', category: 'milkshakes', price: 5, priceLarge: 6, calories: 0, tags: ['Creamy', 'Chocolate'], allergens: ['Dairy', 'Gluten', 'Soya'], image: '/brand/drinks/m5.svg' , available: true },
  { id: 'm6', name: 'Caramel', description: 'A sweet and creamy caramel milkshake. (340ml / 400ml)', category: 'milkshakes', price: 5, priceLarge: 6, calories: 0, tags: ['Creamy', 'Classic'], allergens: ['Dairy'], image: '/brand/drinks/m6.svg' , available: true },
  { id: 'm7', name: 'Biscoff', description: 'A creamy milkshake with warm spiced Biscoff. (340ml / 400ml)', category: 'milkshakes', price: 5, priceLarge: 6, calories: 0, tags: ['Creamy', 'Classic'], allergens: ['Dairy', 'Gluten', 'Soya'], image: '/brand/drinks/m7.svg' , available: true },
  { id: 'm8', name: 'Vanilla', description: 'A smooth and simple vanilla classic. (340ml / 400ml)', category: 'milkshakes', price: 5, priceLarge: 6, calories: 0, tags: ['Creamy', 'Classic'], allergens: ['Dairy'], image: '/brand/drinks/m8.svg' , available: true },
  { id: 'm9', name: 'Strawberry', description: 'A sweet and creamy strawberry milkshake. (340ml / 400ml)', category: 'milkshakes', price: 5, priceLarge: 6, calories: 0, tags: ['Creamy', 'Classic', 'Fruity'], allergens: ['Dairy'], image: '/brand/drinks/m9.svg' , available: true },
  { id: 'm10', name: 'Banana', description: 'A smooth and creamy banana milkshake. (340ml / 400ml)', category: 'milkshakes', price: 5, priceLarge: 6, calories: 0, tags: ['Creamy', 'Classic', 'Fruity'], allergens: ['Dairy'], image: '/brand/drinks/m10.svg' , available: true },
  
  // SMOOTHIES
  { id: 'sm1', name: 'Strawberry Banana', description: 'A fruity smoothie with strawberry and banana flavour. (400ml)', category: 'smoothies', price: 5, calories: 0, tags: ['Fruity', 'Cold'], allergens: [], image: '/brand/drinks/sm1.svg' , available: true },
  { id: 'sm2', name: 'Acai', description: 'A berry-style smoothie with acai flavour. (400ml)', category: 'smoothies', price: 6, calories: 0, tags: ['Fruity', 'Signature'], allergens: [], image: '/brand/drinks/sm2.svg' , available: true },
  { id: 'sm3', name: 'Mango Passion Fruit', description: 'A tropical smoothie with mango and passion fruit flavour. (400ml)', category: 'smoothies', price: 5, calories: 0, tags: ['Fruity', 'Cold'], allergens: [], image: '/brand/drinks/sm3.svg' , available: true },
  { id: 'sm4', name: 'Berry Mix', description: 'A refreshing mixed berry smoothie. (400ml)', category: 'smoothies', price: 5, calories: 0, tags: ['Fruity', 'Cold'], allergens: [], image: '/brand/drinks/sm4.svg' , available: true },

  // SOFT SERVE
  { id: 'ss1', name: 'Classic Cup', description: 'Smooth soft serve served in a classic cup.', category: 'soft_serve', price: 3, calories: 0, tags: ['Classic', 'Sweet'], allergens: ['Dairy'], image: '/brand/drinks/ss1.svg' , available: true },
  { id: 'ss2', name: 'Premium Cup', description: 'Smooth soft serve served in a premium cup.', category: 'soft_serve', price: 4, calories: 0, tags: ['Signature', 'Sweet'], allergens: ['Dairy'], image: '/brand/drinks/ss2.svg' , available: true },
  { id: 'ss3', name: 'Cone', description: 'Classic soft serve served in a cone.', category: 'soft_serve', price: 2.50, calories: 0, tags: ['Classic', 'Sweet'], allergens: ['Dairy', 'Gluten'], image: '/brand/drinks/ss3.svg' , available: true },

  // SLUSH
  { id: 'sl1', name: 'Blue Slush', description: 'An icy, refreshing blue slush. (340ml / 400ml)', category: 'slush', price: 3, priceLarge: 4, calories: 0, tags: ['Cold', 'Fruity'], allergens: [], image: '/brand/drinks/sl1.svg' , available: true },
  { id: 'sl2', name: 'Red Slush', description: 'An icy, refreshing red slush. (340ml / 400ml)', category: 'slush', price: 3, priceLarge: 4, calories: 0, tags: ['Cold', 'Fruity'], allergens: [], image: '/brand/drinks/sl2.svg' , available: true },

  // EXTRAS
  { id: 'e1', name: 'Mix Flavours', description: 'Combine flavours for a customised drink.', category: 'extras', price: 0.80, calories: 0, tags: ['Customisable'], allergens: [], image: '/brand/drinks/e1.svg' , available: true },
  { id: 'e2', name: 'Whipped Cream', description: 'Add whipped cream for a soft, sweet finish.', category: 'extras', price: 1, calories: 0, tags: ['Sweet'], allergens: ['Dairy'], image: '/brand/drinks/e2.svg' , available: true },
  { id: 'e3', name: 'Extra Nutella', description: 'Add extra Nutella for a richer flavour.', category: 'extras', price: 1, calories: 0, tags: ['Chocolate'], allergens: ['Dairy', 'Nuts', 'Soya'], image: '/brand/drinks/e3.svg' , available: true },
  { id: 'e4', name: 'Cookie Crumbs', description: 'Add cookie crumbs for extra texture.', category: 'extras', price: 0.80, tags: ['Sweet'], calories: 0, allergens: ['Gluten', 'Dairy'], image: '/brand/drinks/e4.svg' , available: true },
  { id: 'e5', name: 'Marshmallows', description: 'Add marshmallows for a sweet finishing touch.', category: 'extras', price: 0.80, calories: 0, tags: ['Sweet'], allergens: [], image: '/brand/drinks/e5.svg' , available: true }
];

/**
 * LAUNCH-CLEAN: the previous seed shipped three invented storefronts
 * (Solihull / Leicester / Birmingham) with fabricated addresses, postcodes,
 * phone numbers, e-mail addresses and map coordinates. None of them existed,
 * and the SEO prerenderer was publishing them to Google as real LocalBusiness
 * listings. A site must not advertise locations that aren't real.
 *
 * This is now EMPTY — no seeded storefront. Add the real kiosk in Admin ->
 * Website / Stores; the live values are stored in the database. Until then the
 * public locator shows a "coming soon" empty state (no placeholder cards).
 */
// LAUNCH-CLEAN: no seeded storefronts. The live list comes from Supabase; until
// a real store exists the public locator shows a "coming soon" empty state
// rather than a placeholder card. Demo stores for local dev live in seed.dev.sql.
export const INITIAL_STORES: StoreLocation[] = [];

// LAUNCH-CLEAN: no seeded vacancies. The live list comes from Supabase; until
// a genuine role is posted the careers page shows a "no open roles" empty
// state. Demo vacancies for local dev live in seed.dev.sql.
export const INITIAL_JOBS: CareerVacancy[] = [];

export const INITIAL_COURSES: TrainingCourse[] = [
  {
    id: 'c1',
    title: 'Module 1: Welcome to Milk Pop',
    description: 'It introduces every new team member to the heart of Milk Pop: our purpose, our standards, our customers, our working environment, and the role each person plays in helping the brand grow.',
    category: 'induction',
    progress: 0,
    points: 150,
    estimatedTime: '35–45 mins',
    badge: 'Ambassador Badge',
    assessmentId: 'a1'
  }
];

export const INITIAL_ARTICLES: KnowledgeArticle[] = [
  {
    id: 'k1',
    title: 'Opening Station Verification Procedures',
    category: 'opening',
    lastUpdated: '15 May 2026',
    author: '',
    readingTime: '6 mins',
    content: 'All raw storage nodes must be logged. Proper startup of high-speed shake churns ensures creamy foam profiles. Check milk delivery dates immediately upon receipt.',
    steps: [
      'Log into the temperature monitoring terminal. Confirm walk-in chillers are strictly between 1°C and 4°C.',
      'De-ice core blend nozzles using distilled hot water. Wipe stainless steel prep counters with approved sanitiser.',
      'Arrange biodegradable paper straws, customized lids, and premium takeaway collars in chronological dispenser queues.',
      'Calibrate caramel syrup pumps: verify a single squeeze dispenses exactly 15ml.'
    ]
  },
  {
    id: 'k2',
    title: 'Strict Allergen Cross-Contact Policies',
    category: 'recipes',
    lastUpdated: '12 Jan 2026',
    author: '',
    readingTime: '5 mins',
    content: 'Pistachios and dairy are dominant elements. When an allergen request triggers, dedicated orange-rimmed blender cups must be sourced and washed separately.',
    steps: [
      'Wipe the primary station down completely while donning fresh secondary disposable gloves.',
      'Retrieve the dedicated clean blender canister designated for allergy preps.',
      'Gather fresh garnishes from sealed isolation chambers to avoid main bowl exposure.',
      'Label the finished premium container clearly with allergen warnings.'
    ]
  }
];

/**
 * SECURITY: intentionally empty. The app previously shipped with a seeded
 * owner account and a hard-coded password in this file, which put a working
 * owner credential in every browser and in the production JS bundle. Staff
 * accounts must be provisioned server-side (Supabase Auth) — never here.
 * See README.md (Security) and the security notes in README.md.
 */
export const INITIAL_EMPLOYEES: EmployeeProfile[] = [];

export const INITIAL_SHIFTS: WorkShift[] = [];


export const INITIAL_SIFR_REPORTS: SIFRReport[] = [];

export const INITIAL_DOCUMENTS: StaffDocument[] = [];

/* ============================================================
   SALES, SETTINGS, DEALS & CHECKLIST SEEDS
   ============================================================ */
import { Order, Deal, SiteSettings, ChecklistTemplateItem } from './types';

export const INITIAL_ORDERS: Order[] = [];

/** Opening-safe default: promotions are created and published by the owner.
 * Development fixtures live in supabase/seed.dev.sql, not in the browser bundle. */
export const INITIAL_DEALS: Deal[] = [];

export const INITIAL_SETTINGS: SiteSettings = {
  brandName: 'MILK POP',
  legalName: '',       // enter the registered legal entity later; footer safely falls back to the brand
  companyNumber: '',  // enter only if the business is incorporated and has a Companies House number
  websiteUrl: 'https://milkpop.uk',   // canonical public root URL (matches SITE_URL / prerender-seo)
  instagramHandle: '',  // set the real handle in Website Studio; empty hides the icon
  instagramUrl: '',     // set the real profile URL in Website Studio; empty hides the icon
  facebookUrl: '',   // set the real page in Website Studio; empty hides the icon
  twitterUrl: '',    // set the real profile in Website Studio; empty hides the icon
  phone: '',         // set the real contact number in Settings → Launch Facts; empty hides the row
  email: '',         // set the real contact e-mail in Settings → Launch Facts; empty hides the row
  gdprEmail: '',     // set the real data-protection contact in Settings → Launch Facts
  hqAddress: '',     // set the real registered/HQ address in Settings → Launch Facts; empty hides the row
  footerTagline: 'Milkshakes, smoothies, soft serve and slush — opening information will be published here as it is confirmed.',
  allergenNotice: 'Allergen notice: Ingredients and allergen information vary by product and supplier. If you have any food allergy or intolerance, please ask a trained team member before ordering. Cross-contact may be possible.',
  announcementEnabled: false,
  announcementText: '',
  currencySymbol: '£',
  defaultOpeningHours: '',     // set real hours per store in Admin → Website / Stores
  showCareers: false,
  showFranchise: false,
  showNews: false
};

/** Seeded from the previous hard-coded staff checklist so nothing is lost. */
export const INITIAL_CHECKLIST_TEMPLATES: ChecklistTemplateItem[] = [
  { id: 'ck_o1', label: 'Confirm walk-in chillers are between 1°C and 4°C and log the reading', category: 'opening', critical: true, sortOrder: 1 },
  { id: 'ck_o2', label: 'De-ice blend nozzles and sanitise stainless prep counters', category: 'opening', critical: true, sortOrder: 2 },
  { id: 'ck_o3', label: 'Stock paper straws, lids and takeaway collars at the pass', category: 'opening', critical: false, sortOrder: 3 },
  { id: 'ck_o4', label: 'Calibrate caramel syrup pumps (one squeeze = 15ml)', category: 'opening', critical: false, sortOrder: 4 },
  { id: 'ck_o5', label: 'Count the float and sign the till on', category: 'opening', critical: true, sortOrder: 5 },
  { id: 'ck_m1', label: 'Mid-day temperature check on all display fridges', category: 'midday', critical: true, sortOrder: 1 },
  { id: 'ck_m2', label: 'Wipe seating zones and restock napkin stations', category: 'midday', critical: false, sortOrder: 2 },
  { id: 'ck_m3', label: 'Rotate milk stock — check dates, FIFO order', category: 'midday', critical: true, sortOrder: 3 },
  { id: 'ck_m4', label: 'Empty and re-line front-of-house bins', category: 'midday', critical: false, sortOrder: 4 },
  { id: 'ck_c1', label: 'Strip, wash and sanitise shake churns and blender canisters', category: 'closing', critical: true, sortOrder: 1 },
  { id: 'ck_c2', label: 'Cash up the till and reconcile card terminal totals', category: 'closing', critical: true, sortOrder: 2 },
  { id: 'ck_c3', label: 'Record closing fridge temperatures in the log', category: 'closing', critical: true, sortOrder: 3 },
  { id: 'ck_c4', label: 'Mop floors, switch off signage and set the alarm', category: 'closing', critical: false, sortOrder: 4 }
];
