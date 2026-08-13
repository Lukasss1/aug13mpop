/**
 * @file WebsiteStudio.tsx
 * @description The owner's single tool for editing EVERYTHING a visitor sees.
 *
 * One screen, three columns of logic:
 *   1. Section rail  — Global (announcement, navigation, footer, contact &
 *      social, SEO) and one entry per public page, each with a live count of
 *      unsaved edits.
 *   2. Field editor  — every headline, paragraph, button, image and legal
 *      block, rendered from a declarative section registry below. Fields show
 *      a "reset to original" control whenever they differ from launch copy.
 *   3. Save bar      — edits build up in a local draft (no per-keystroke
 *      writes to storage — this is the panel's main performance fix) and are
 *      published in one click, with a change count and a discard option.
 *
 * DATA OWNERSHIP
 * --------------
 * - Page copy / images / SEO / nav / footer headings live in `SiteContent`
 *   (see src/siteContent.ts) and save through `onSaveContent`.
 * - A handful of website-display settings (announcement ribbon, footer
 *   tagline, allergen notice, contact + social links) live on the existing
 *   `SiteSettings` record so the Navbar/Footer/Till keep reading the same
 *   object; the Studio edits ONLY those keys and merges them back into the
 *   previous settings on save, so Company Settings edits are never clobbered.
 * - Menu items, stores, news posts, deals and media have their own managers;
 *   the rail links straight to them so nothing feels hidden.
 */
import { isUnsafeExternalUrl } from '../../lib/safeUrl';
import { processAndUploadImage, attachMediaReference, ACCEPTED_IMAGE_ACCEPT_ATTR } from '../../lib/mediaUpload';
import { MEDIA_V2 } from '../../lib/featureFlags';
import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Globe, Megaphone, Navigation, PanelsTopLeft, Link2, SearchCheck, Home, MenuSquare, Building, Briefcase, TrendingUp, BookOpen, Mail, Newspaper, Shield, Eye, RotateCcw, Search, X, Plus, Trash, Image as ImageIcon, Upload, ChevronRight, Store, Percent, HardDrive, ExternalLink, Check } from 'lucide-react';
import { SiteSettings, MediaItem } from '../../types';
import { SiteContent, DEFAULT_SITE_CONTENT } from '../../siteContent';
import { businessTodayISO } from '../../lib/businessDate';
import { createClientId } from '../../lib/clientId';

/* ------------------------------------------------------------------ */
/*  Generic path helpers (immutable get/set on the draft object)       */
/* ------------------------------------------------------------------ */

const getPath = (obj: any, path: string): any =>
  path.split('.').reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);

// OPT-02 Check 4 (Stage C): generic deep-path get/set over dynamic CMS
// section objects keyed by dotted string paths — an intentional `any`
// boundary (documented exception). Callers hold the concrete section type.
const setPath = (obj: any, path: string, value: any): any => {
  const keys = path.split('.');
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  let cursor: any = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (k === undefined) continue;
    const next = cursor[k];
    cursor[k] = Array.isArray(next) ? [...next] : { ...next };
    cursor = cursor[k];
  }
  const lastKey = keys[keys.length - 1];
  if (lastKey !== undefined) cursor[lastKey] = value;
  return clone;
};

/* ------------------------------------------------------------------ */
/*  Declarative section registry                                       */
/* ------------------------------------------------------------------ */

type FieldKind = 'text' | 'textarea' | 'image';

interface FieldDef {
  /** Dot-path into SiteContent, e.g. 'home.heroHeadline'. */
  path: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  rows?: number;
}

interface ListItemField {
  key: string;
  label: string;
  kind: 'text' | 'textarea';
  /** Narrow column (e.g. an emoji or a stat value). */
  small?: boolean;
}

interface ListDef {
  path: string;      // dot-path to the array in SiteContent
  label: string;
  itemName: string;  // "card", "perk", "pillar"…
  fields: ListItemField[];
  hint?: string;
  min?: number;
  max?: number;
}

interface SettingsFieldDef {
  key: keyof SiteSettings;
  label: string;
  /* T13-10: `managed` renders the RESOLVED value read-only and says where it
     is really edited. public_site_configuration makes Launch Facts the
     authoritative source of the legal/contact facts, so a Studio field that
     still LOOKED editable let an owner "publish" a phone number or e-mail
     that the public site would never show — a silent no-op on exactly the
     values a customer needs to be correct. */
  kind: 'text' | 'textarea' | 'toggle' | 'managed';
  hint?: string;
}

type Block =
  | { type: 'heading'; text: string }
  | { type: 'note'; text: string }
  | { type: 'fields'; fields: FieldDef[] }
  | { type: 'list'; def: ListDef }
  | { type: 'settings'; fields: SettingsFieldDef[] }
  | { type: 'preview'; kind: 'announcement' | 'nav' | 'hero' };

interface SectionDef {
  id: string;
  label: string;
  icon: any;
  group: 'Global' | 'Pages';
  description: string;
  /** Public tab to open with the "View live page" button. */
  viewTab?: string;
  blocks: Block[];
}

const f = (path: string, label: string, kind: FieldKind = 'text', extra?: Partial<FieldDef>): FieldDef =>
  ({ path, label, kind, ...extra });

const SECTIONS: SectionDef[] = [
  /* ---------------- GLOBAL ---------------- */
  {
    id: 'announcement',
    label: 'Announcement bar',
    icon: Megaphone,
    group: 'Global',
    description: 'The ribbon shown above the header on every public page — perfect for launches and offers.',
    viewTab: 'home',
    blocks: [
      { type: 'preview', kind: 'announcement' },
      {
        type: 'settings',
        fields: [
          { key: 'announcementEnabled', label: 'Show the announcement bar', kind: 'toggle' },
          { key: 'announcementText', label: 'Announcement text', kind: 'text', hint: 'Keep it to one short sentence — it renders on a single line.' },
        ],
      },
    ],
  },
  {
    id: 'public_sections',
    label: 'Public sections',
    icon: Eye,
    group: 'Global',
    description: 'Keep the customer website focused. Enable Careers, Franchise or News only when the business is actively using them.',
    viewTab: 'home',
    blocks: [
      {
        type: 'settings',
        fields: [
          { key: 'showCareers', label: 'Show Careers', kind: 'toggle' },
          { key: 'showFranchise', label: 'Show Franchise', kind: 'toggle' },
          { key: 'showNews', label: 'Show News', kind: 'toggle' },
        ],
      },
    ],
  },
  {
    id: 'navigation',
    label: 'Navigation labels',
    icon: Navigation,
    group: 'Global',
    description: 'Rename the header menu pills. The footer "Explore" links reuse the same labels automatically.',
    viewTab: 'home',
    blocks: [
      { type: 'preview', kind: 'nav' },
      {
        type: 'fields',
        fields: [
          f('nav.home', 'Home'), f('nav.menu', 'Menu'), f('nav.stores', 'Stores'),
          f('nav.careers', 'Careers'), f('nav.franchise', 'Franchise'), f('nav.news', 'News'),
          f('nav.about', 'About'), f('nav.contact', 'Contact'),
        ],
      },
    ],
  },
  {
    id: 'footer',
    label: 'Footer & legal strip',
    icon: PanelsTopLeft,
    group: 'Global',
    description: 'Everything in the dark footer: tagline, column headings, HQ address and the allergen notice.',
    viewTab: 'home',
    blocks: [
      {
        type: 'settings',
        fields: [
          { key: 'footerTagline', label: 'Footer tagline (the quote under the logo)', kind: 'textarea' },
          { key: 'hqAddress', label: 'Registered address', kind: 'managed' },
          { key: 'websiteUrl', label: 'Website address', kind: 'managed' },
          { key: 'instagramHandle', label: 'Instagram handle (display text)', kind: 'text' },
          { key: 'allergenNotice', label: 'Allergen notice (bottom strip)', kind: 'textarea' },
        ],
      },
      { type: 'heading', text: 'Column headings' },
      {
        type: 'fields',
        fields: [
          f('footer.exploreHeading', 'Links column'),
          f('footer.companyHeading', 'Company column'),
          f('footer.contactHeading', 'Contact column'),
        ],
      },
    ],
  },
  {
    id: 'social',
    label: 'Contact & social links',
    icon: Link2,
    group: 'Global',
    description: 'Public phone, e-mail addresses and the social profiles the footer icons open.',
    blocks: [
      {
        type: 'settings',
        fields: [
          { key: 'phone', label: 'Public phone', kind: 'managed' },
          { key: 'email', label: 'Public e-mail', kind: 'managed' },
          { key: 'gdprEmail', label: 'GDPR / privacy e-mail', kind: 'managed' },
          { key: 'legalName', label: 'Legal company name', kind: 'managed' },
          { key: 'companyNumber', label: 'Company number', kind: 'managed' },
          { key: 'instagramUrl', label: 'Instagram URL', kind: 'text' },
          { key: 'facebookUrl', label: 'Facebook URL', kind: 'text' },
          { key: 'twitterUrl', label: 'Twitter / X URL', kind: 'text' },
        ],
      },
    ],
  },
  {
    id: 'seo',
    label: 'Search & sharing (SEO)',
    icon: SearchCheck,
    group: 'Global',
    description: 'The browser-tab title and the description search engines show, for every public page.',
    blocks: [
      { type: 'note', text: 'These update the page <title> and meta description live as visitors move between pages.' },
      ...(['home', 'menu', 'stores', 'careers', 'franchise', 'about', 'contact', 'news'] as const).flatMap((p): Block[] => ([
        { type: 'heading', text: p === 'home' ? 'Home page' : p.charAt(0).toUpperCase() + p.slice(1) + ' page' },
        {
          type: 'fields',
          fields: [
            f(`seo.${p}.title`, 'Browser tab title'),
            f(`seo.${p}.description`, 'Search result description', 'textarea', { rows: 2 }),
          ],
        },
      ])),
    ],
  },

  /* ---------------- PAGES ---------------- */
  {
    id: 'page_home',
    label: 'Home page',
    icon: Home,
    group: 'Pages',
    description: 'The landing page: hero, brand promises, menu highlights and the two call-to-action cards.',
    viewTab: 'home',
    blocks: [
      { type: 'heading', text: 'Hero (caramel stage)' },
      { type: 'preview', kind: 'hero' },
      {
        type: 'fields',
        fields: [
          f('home.heroHeadline', 'Headline', 'textarea', { rows: 2, hint: 'Line breaks are kept — the launch copy uses two lines.' }),
          f('home.heroSubheadline', 'Subheadline', 'textarea', { rows: 3 }),
          f('home.heroPrimaryCta', 'Primary button (opens the Menu)'),
          f('home.heroSecondaryCta', 'Secondary button (opens Stores)'),
        ],
      },
      { type: 'heading', text: 'Brand promises' },
      {
        type: 'fields',
        fields: [f('home.promiseKicker', 'Small kicker'), f('home.promiseHeading', 'Section heading')],
      },
      {
        type: 'list',
        def: {
          path: 'home.promiseCards', label: 'Promise cards', itemName: 'card', min: 1, max: 6,
          fields: [{ key: 'title', label: 'Title', kind: 'text' }, { key: 'text', label: 'Text', kind: 'textarea' }],
        },
      },
      { type: 'heading', text: 'Menu highlights strip' },
      {
        type: 'fields',
        fields: [
          f('home.favouritesKicker', 'Small kicker'),
          f('home.favouritesHeading', 'Section heading'),
          f('home.favouritesCta', 'Link label ("Explore all…")', 'text', { hint: 'The four products shown come from Menu Items — first four in the list.' }),
        ],
      },
      { type: 'heading', text: 'Careers card' },
      {
        type: 'fields',
        fields: [
          f('home.careersCard.kicker', 'Badge'), f('home.careersCard.title', 'Title'),
          f('home.careersCard.text', 'Text', 'textarea'), f('home.careersCard.button', 'Button label'),
        ],
      },
      { type: 'heading', text: 'Contact card' },
      {
        type: 'fields',
        fields: [
          f('home.contactCard.kicker', 'Badge'), f('home.contactCard.title', 'Title'),
          f('home.contactCard.text', 'Text', 'textarea'), f('home.contactCard.button', 'Button label'),
        ],
      },
    ],
  },
  {
    id: 'page_menu',
    label: 'Menu page',
    icon: MenuSquare,
    group: 'Pages',
    description: 'The header above the product grid. The products themselves live under Menu Items.',
    viewTab: 'menu',
    blocks: [
      {
        type: 'fields',
        fields: [
          f('menuPage.kicker', 'Small kicker'), f('menuPage.heading', 'Page heading'),
          f('menuPage.intro', 'Intro line', 'textarea', { rows: 2 }),
          f('menuPage.searchPlaceholder', 'Search box placeholder'),
        ],
      },
      { type: 'note', text: 'Products, prices and photos are managed in Menu Items; active promotions come from Deals & Combos. This release uses the in-store allergen disclosure mode: keep approved allergen information available at the kiosk, and do not present the public menu as a complete online allergen declaration.' },
    ],
  },
  {
    id: 'page_stores',
    label: 'Stores page',
    icon: Building,
    group: 'Pages',
    description: 'The header above the public store locator. Locations themselves live under Store Locations.',
    viewTab: 'stores',
    blocks: [
      {
        type: 'fields',
        fields: [
          f('storesPage.kicker', 'Small kicker'), f('storesPage.heading', 'Page heading'),
          f('storesPage.intro', 'Intro line', 'textarea', { rows: 2 }),
          f('storesPage.searchPlaceholder', 'Search box placeholder'),
        ],
      },
    ],
  },
  {
    id: 'page_careers',
    label: 'Careers page',
    icon: Briefcase,
    group: 'Pages',
    description: 'Header, the four perk tiles and the vacancies column heading. Roles live under Job Vacancies.',
    viewTab: 'careers',
    blocks: [
      {
        type: 'fields',
        fields: [
          f('careersPage.kicker', 'Small kicker'), f('careersPage.heading', 'Page heading'),
          f('careersPage.intro', 'Intro line', 'textarea', { rows: 2 }),
          f('careersPage.vacanciesHeading', 'Vacancies column heading'),
        ],
      },
      {
        type: 'list',
        def: {
          path: 'careersPage.perks', label: 'Perk tiles', itemName: 'perk', min: 1, max: 8,
          fields: [
            { key: 'emoji', label: 'Emoji', kind: 'text', small: true },
            { key: 'title', label: 'Title', kind: 'text' },
            { key: 'text', label: 'Text', kind: 'textarea' },
          ],
        },
      },
    ],
  },
  {
    id: 'page_franchise',
    label: 'Franchise page',
    icon: TrendingUp,
    group: 'Pages',
    description: 'The pitch column, the minimum-parameters stats and the enquiry form heading.',
    viewTab: 'franchise',
    blocks: [
      {
        type: 'fields',
        fields: [
          f('franchisePage.kicker', 'Small kicker'), f('franchisePage.heading', 'Page heading'),
          f('franchisePage.intro', 'Intro line', 'textarea', { rows: 2 }),
          f('franchisePage.whyHeading', '"Why franchise" heading'),
        ],
      },
      {
        type: 'list',
        def: {
          path: 'franchisePage.whyPoints', label: 'Selling points', itemName: 'point', min: 1, max: 6,
          fields: [{ key: 'title', label: 'Title', kind: 'text' }, { key: 'text', label: 'Text', kind: 'textarea' }],
        },
      },
      { type: 'heading', text: 'Minimum parameters card' },
      { type: 'fields', fields: [f('franchisePage.statsHeading', 'Card heading')] },
      {
        type: 'list',
        def: {
          path: 'franchisePage.stats', label: 'Stat tiles', itemName: 'stat', min: 1, max: 4,
          fields: [
            { key: 'value', label: 'Value', kind: 'text', small: true },
            { key: 'label', label: 'Label', kind: 'text' },
          ],
        },
      },
      { type: 'fields', fields: [f('franchisePage.formHeading', 'Enquiry form heading')] },
    ],
  },
  {
    id: 'page_about',
    label: 'About page',
    icon: BookOpen,
    group: 'Pages',
    description: 'The brand story: hero, the two story blocks with photos, and the three pillars.',
    viewTab: 'about',
    blocks: [
      { type: 'heading', text: 'Header' },
      {
        type: 'fields',
        fields: [
          f('aboutPage.badge', 'Small badge'),
          f('aboutPage.heading', 'Heading (plain part)'),
          f('aboutPage.headingAccent', 'Heading accent (caramel italics)', 'text', { hint: 'Rendered right after the plain part, in caramel italics.' }),
          f('aboutPage.intro', 'Intro paragraph', 'textarea', { rows: 3 }),
        ],
      },
      { type: 'heading', text: 'Story block 1 — the craft' },
      {
        type: 'fields',
        fields: [
          f('aboutPage.craftImage', 'Photo', 'image'),
          f('aboutPage.craftHeading', 'Heading'),
          f('aboutPage.craftText', 'Text', 'textarea', { rows: 6, hint: 'Leave a blank line between paragraphs.' }),
          f('aboutPage.craftBadgeTitle', 'Badge title'),
          f('aboutPage.craftBadgeText', 'Badge subtitle'),
        ],
      },
      { type: 'heading', text: 'Story block 2 — the people' },
      {
        type: 'fields',
        fields: [
          f('aboutPage.cultureImage', 'Photo', 'image'),
          f('aboutPage.cultureHeading', 'Heading'),
          f('aboutPage.cultureText', 'Text', 'textarea', { rows: 6, hint: 'Leave a blank line between paragraphs.' }),
          f('aboutPage.cultureBadgeTitle', 'Badge title'),
          f('aboutPage.cultureBadgeText', 'Badge subtitle'),
        ],
      },
      { type: 'heading', text: 'The pillars (dark section)' },
      { type: 'fields', fields: [f('aboutPage.pillarsKicker', 'Small kicker'), f('aboutPage.pillarsHeading', 'Heading')] },
      {
        type: 'list',
        def: {
          path: 'aboutPage.pillars', label: 'Pillar cards', itemName: 'pillar', min: 1, max: 6,
          fields: [{ key: 'title', label: 'Title', kind: 'text' }, { key: 'text', label: 'Text', kind: 'textarea' }],
        },
      },
    ],
  },
  {
    id: 'page_contact',
    label: 'Contact page',
    icon: Mail,
    group: 'Pages',
    description: 'Header, the support-route e-mail list and the store-locator nudge next to the form.',
    viewTab: 'contact',
    blocks: [
      {
        type: 'fields',
        fields: [
          f('contactPage.kicker', 'Small kicker'), f('contactPage.heading', 'Page heading'),
          f('contactPage.intro', 'Intro line', 'textarea', { rows: 2 }),
          f('contactPage.routesHeading', 'Routes column heading'),
        ],
      },
      {
        type: 'list',
        def: {
          path: 'contactPage.routes', label: 'Support routes', itemName: 'route', min: 1, max: 6,
          fields: [
            { key: 'label', label: 'Label', kind: 'text' },
            { key: 'email', label: 'E-mail address', kind: 'text' },
          ],
        },
      },
      {
        type: 'fields',
        fields: [
          f('contactPage.locatorNote', 'Store-locator nudge', 'textarea', { rows: 2 }),
          f('contactPage.locatorCta', 'Nudge link label'),
        ],
      },
    ],
  },
  {
    id: 'page_news',
    label: 'News page',
    icon: Newspaper,
    group: 'Pages',
    description: 'The header above the article grid. Articles themselves live under News & Updates.',
    viewTab: 'news',
    blocks: [
      {
        type: 'fields',
        fields: [
          f('newsPage.kicker', 'Small kicker'), f('newsPage.heading', 'Page heading'),
          f('newsPage.intro', 'Intro line', 'textarea', { rows: 2 }),
        ],
      },
    ],
  },
  {
    id: 'page_legal',
    label: 'Legal pages',
    icon: Shield,
    group: 'Pages',
    description: 'Privacy Policy, UK GDPR and the Franchise Disclosure — plain text, blank line = new paragraph.',
    viewTab: 'privacy',
    blocks: [
      { type: 'heading', text: 'Privacy Policy' },
      { type: 'fields', fields: [f('legal.privacy.title', 'Title'), f('legal.privacy.body', 'Body', 'textarea', { rows: 10 })] },
      { type: 'heading', text: 'UK GDPR Policy' },
      { type: 'fields', fields: [f('legal.gdpr.title', 'Title'), f('legal.gdpr.body', 'Body', 'textarea', { rows: 10 })] },
      { type: 'heading', text: 'Franchise Information Notice' },
      { type: 'fields', fields: [f('legal.fdd.title', 'Title'), f('legal.fdd.body', 'Body', 'textarea', { rows: 10 })] },
    ],
  },
];

/** SiteSettings keys the Studio owns (merged back into prev settings on save). */
/* T13-10: the authoritative legal/contact keys are NOT in this list, so the
   Studio cannot write them even if a field were re-added by mistake — the
   save merges only what the Studio owns. Launch Facts remains the single
   editor for legal identity and contact details; the Studio keeps branding,
   copy, social links, announcements and presentation. */
const STUDIO_SETTINGS_KEYS: (keyof SiteSettings)[] = [
  'announcementEnabled', 'announcementText', 'footerTagline', 'allergenNotice',
  'instagramHandle', 'instagramUrl', 'facebookUrl', 'twitterUrl',
  'showCareers', 'showFranchise', 'showNews',
];
/** Public business facts owned by Launch Facts (read-only in the Studio). */
export const LAUNCH_FACT_KEYS: (keyof SiteSettings)[] = [
  'legalName', 'companyNumber', 'hqAddress', 'phone', 'email', 'gdprEmail', 'websiteUrl',
];

/** Registries that render on the site but are edited in their own managers. */
const RELATED_MANAGERS: { id: string; label: string; icon: any; blurb: string }[] = [
  { id: 'menu', label: 'Menu Items', icon: MenuSquare, blurb: 'Products, prices, photos, VAT classification' },
  { id: 'stores', label: 'Store Locations', icon: Store, blurb: 'Addresses, hours, delivery links' },
  { id: 'news', label: 'News & Updates', icon: Newspaper, blurb: 'Articles on the News page' },
  { id: 'deals', label: 'Deals & Combos', icon: Percent, blurb: 'Badges on the hero + menu' },
  { id: 'media', label: 'Media Library', icon: HardDrive, blurb: 'Uploaded images' },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface WebsiteStudioProps {
  content: SiteContent;
  /* INC11: content + settings drafts publish in ONE transaction. */
  onPublishStudio: (content: SiteContent | null, settings: SiteSettings | null) => Promise<boolean>;
  siteSettings: SiteSettings;
  mediaItems: MediaItem[];
  publishMediaItems: (next: MediaItem[] | ((prev: MediaItem[]) => MediaItem[])) => Promise<boolean>;
  addToast: (msg: string, type: 'success' | 'warning' | 'error' | 'info') => void;
  logAction: (module: string, action: string) => void;
  /** Leave the admin panel and open a public tab (to see the live page). */
  onViewPage: (tab: string) => void;
  /** Jump to another admin tab (Menu Items, Stores, …). */
  goToAdminTab: (tabId: string) => void;
  cloudConfigured: boolean;
  /** Keeps an in-memory draft scoped to the signed-in operator on shared devices. */
  draftScopeKey: string;
  /** OPT-02-C1.2: rendered at the top of the SEO section (SEO sync status). */
  seoPanel?: React.ReactNode;
}

/** Unsaved Studio work survives admin-tab switches: switching tabs unmounts
 *  this component, and without a stash a half-finished rewrite would silently
 *  vanish. The stash is a MODULE-SCOPED variable on purpose — this repo's
 *  security posture bans sessionStorage/IndexedDB in src/ outright (see the
 *  security regression suite), and plain memory is stricter anyway. A page
 *  refresh still clears the memory-only draft, but the browser now warns first. */
interface StudioStash {
  scopeKey: string;
  draft: SiteContent;
  settingsDraft: Partial<SiteSettings>;
  uploadedObjectIds: Map<string, string>;
  pendingAttachmentFailures: number;
}

let studioStash: StudioStash | null = null;

const pickStudioSettings = (settings: SiteSettings): Partial<SiteSettings> =>
  Object.fromEntries(STUDIO_SETTINGS_KEYS.map((key) => [key, settings[key]])) as Partial<SiteSettings>;

export const WebsiteStudio: React.FC<WebsiteStudioProps> = ({
  content, onPublishStudio, siteSettings, mediaItems, publishMediaItems,
  addToast, logAction, onViewPage, goToAdminTab, cloudConfigured, draftScopeKey, seoPanel,
}) => {
  const restorableStash = studioStash?.scopeKey === draftScopeKey ? studioStash : null;
  const [draft, setDraft] = useState<SiteContent>(() => restorableStash?.draft ?? content);
  const [settingsDraft, setSettingsDraft] = useState<Partial<SiteSettings>>(() => {
    if (restorableStash?.settingsDraft) return restorableStash.settingsDraft;
    return pickStudioSettings(siteSettings);
  });
  const [activeSection, setActiveSection] = useState<string>('page_home');
  const [query, setQuery] = useState('');
  const [imagePickerPath, setImagePickerPath] = useState<string | null>(null);
  // Keep upload→object references with the in-memory draft. Without this, an
  // ordinary Admin tab switch preserved the image URL but lost the object id,
  // so the later Publish could not finalise the storage reference.
  const uploadedObjectIds = useRef<Map<string, string>>(
    new Map(restorableStash?.uploadedObjectIds ?? []),
  );
  const [pendingAttachmentFailures, setPendingAttachmentFailures] = useState(
    Math.max(
      restorableStash?.pendingAttachmentFailures ?? 0,
      restorableStash?.uploadedObjectIds.size ?? 0,
    ),
  );

  /* ----- dirtiness ----- */
  const contentDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(content), [draft, content]);
  const settingsDirty = useMemo(
    () => STUDIO_SETTINGS_KEYS.some(k => (settingsDraft as any)[k] !== (siteSettings as any)[k]),
    [settingsDraft, siteSettings]
  );
  const isDirty = contentDirty || settingsDirty;
  const hasPendingImageFinalisation = pendingAttachmentFailures > 0;
  const requiresOwnerAction = isDirty || hasPendingImageFinalisation;

  // Stash unsaved work and retryable image-reference work in memory; clear it
  // only when both the visible draft and publication bookkeeping are clean.
  useEffect(() => {
    studioStash = requiresOwnerAction
      ? {
          scopeKey: draftScopeKey,
          draft,
          settingsDraft,
          uploadedObjectIds: new Map(uploadedObjectIds.current),
          pendingAttachmentFailures,
        }
      : null;
  }, [requiresOwnerAction, draftScopeKey, draft, settingsDraft, pendingAttachmentFailures]);

  // The Studio deliberately keeps drafts out of persistent browser storage,
  // so a full refresh would otherwise be the one remaining silent-loss path.
  // Browsers display their own standard confirmation text for security.
  useEffect(() => {
    if (!requiresOwnerAction) return undefined;
    const protectDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protectDraft);
    return () => window.removeEventListener('beforeunload', protectDraft);
  }, [requiresOwnerAction]);

  // While the Studio is clean, follow external updates (cloud pull, edits
  // published from the on-page edit mode). Never overwrite unsaved work.
  useEffect(() => {
    if (!contentDirty) setDraft(content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);
  useEffect(() => {
    if (!settingsDirty) {
      setSettingsDraft(pickStudioSettings(siteSettings));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteSettings]);

  /* ----- change counting (per section, for the rail badges) ----- */
  const sectionChangeCount = (section: SectionDef): number => {
    let n = 0;
    for (const block of section.blocks) {
      if (block.type === 'fields') {
        for (const fd of block.fields) if (getPath(draft, fd.path) !== getPath(content, fd.path)) n++;
      } else if (block.type === 'list') {
        if (JSON.stringify(getPath(draft, block.def.path)) !== JSON.stringify(getPath(content, block.def.path))) n++;
      } else if (block.type === 'settings') {
        for (const sf of block.fields) {
          if (sf.kind === 'managed') continue; // T13-10: read-only, never a pending change
          if ((settingsDraft as any)[sf.key] !== (siteSettings as any)[sf.key]) n++;
        }
      }
    }
    return n;
  };
  const totalChanges = useMemo(
    () => SECTIONS.reduce((sum, s) => sum + sectionChangeCount(s), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, content, settingsDraft, siteSettings]
  );

  /* ----- actions ----- */
  /* SMALL-BIZ CLOSURE P1-1: one Publish in flight at a time — a double-click
     must not fire two save_website_studio calls (the second would only be
     refused as stale server-side; refusing it client-side is the polite
     version and covers the image-finalisation phase too). */
  const [publishBusy, setPublishBusy] = useState(false);
  /* T13-9: the ref is the real lock (state lags a render behind, so two
     synchronous clicks both passed the state check); the state drives the
     button's disabled look and its "Publishing…" label. */
  const publishBusyRef = useRef(false);

  const collectImageReferences = (source: SiteContent) => {
    const references = new Map<string, string[]>();
    for (const section of SECTIONS) {
      for (const block of section.blocks) {
        if (block.type !== 'fields') continue;
        for (const field of block.fields) {
          if (field.kind !== 'image') continue;
          const value = getPath(source, field.path);
          if (typeof value !== 'string' || !value) continue;
          const paths = references.get(value);
          if (paths) paths.push(field.path);
          else references.set(value, [field.path]);
        }
      }
    }
    return references;
  };

  /** Finalise any uploaded image objects referenced by the current draft.
   *  Publication remains authoritative even if this bookkeeping step fails;
   *  failed references stay in the map and can be retried without republishing
   *  content or making a cosmetic edit solely to reveal the Publish button. */
  const finaliseImageReferences = async (): Promise<number> => {
    const imageReferences = collectImageReferences(draft);
    const referencesByUrl = new Map<string, { objectId: string; fields: string[] }>();
    for (const [url, objectId] of uploadedObjectIds.current) {
      const fields = imageReferences.get(url);
      // An upload removed from the draft was never published and needs no
      // attachment retry. The storage cleanup worker handles the pending
      // object; removing this client bookkeeping prevents a phantom action.
      if (!fields?.length) {
        uploadedObjectIds.current.delete(url);
        continue;
      }
      referencesByUrl.set(url, { objectId, fields });
    }

    let failures = 0;
    await Promise.all([...referencesByUrl.entries()].map(async ([url, reference]) => {
      const outcomes = await Promise.all(reference.fields.map(async (fieldPath) => {
        try {
          const result = await attachMediaReference(reference.objectId, 'site_content', '1', fieldPath);
          return result.status === 'attached';
        } catch {
          return false;
        }
      }));
      const failedForUrl = outcomes.filter((attached) => !attached).length;
      failures += failedForUrl;
      // One uploaded object can be used in several fields. Retain its tracking
      // entry until every field reference succeeds, otherwise a partial success
      // would make the remaining failed field impossible to retry.
      if (failedForUrl === 0) uploadedObjectIds.current.delete(url);
    }));
    setPendingAttachmentFailures(failures);
    return failures;
  };

  const handleSave = async () => {
    if (!requiresOwnerAction || publishBusyRef.current) return;
    publishBusyRef.current = true;
    setPublishBusy(true);
    try {
      if (isDirty) {
        await doPublish();
      } else {
        const failures = await finaliseImageReferences();
        addToast(
          failures > 0
            ? `${failures === 1 ? 'One image reference still needs' : `${failures} image references still need`} finalising. Check the connection and retry.`
            : 'Image references finalised successfully.',
          failures > 0 ? 'warning' : 'success',
        );
      }
    } finally {
      publishBusyRef.current = false;
      setPublishBusy(false);
    }
  };
  const doPublish = async () => {
    // INC11: ONE transaction — a failure anywhere rolls the whole publish
    // back; the server verifies each part's expected revision and writes the
    // audit row alongside the changes.
    const settingsNext = settingsDirty ? { ...siteSettings, ...settingsDraft } : null;
    if (settingsNext?.announcementEnabled && !settingsNext.announcementText.trim()) {
      addToast('Add announcement text or switch the announcement bar off before publishing.', 'error');
      return;
    }
    if (settingsNext) settingsNext.announcementText = settingsNext.announcementText.trim();
    if (!(await onPublishStudio(contentDirty ? draft : null, settingsNext))) return;
    // Keep the local settings draft aligned with the exact normalised value the
    // server accepted. Otherwise whitespace trimming left the Studio falsely
    // dirty immediately after a successful publish.
    if (settingsNext) setSettingsDraft(pickStudioSettings(settingsNext));
    // WP04R two-phase step 2: content is COMMITTED — now record which image
    // fields use which uploaded objects (site_content is entity id '1').
    /* SMALL-BIZ CLOSURE P0-8: the attach calls are COLLECTED AND AWAITED.
       Content publication remains successful even if attachment metadata
       fails — a valid publish is never rolled back for bookkeeping — but the
       owner now SEES the failure instead of it dying in the console. Failed
       entries stay in uploadedObjectIds (only 'attached' removes them), so
       publishing again retries exactly the finalisations that failed. */
    const attachFailures = await finaliseImageReferences();
    // INC11: the audit row is written SERVER-SIDE inside the save transaction.
    if (attachFailures > 0) {
      addToast(`Website content is live, but ${attachFailures === 1 ? 'one image reference' : `${attachFailures} image references`} could not be finalised. Use “Retry image references” when the connection is stable.`, 'warning');
    } else {
      addToast('Published — the change is saved to the database and live for every visitor.', 'success');
    }
  };

  const handleDiscard = () => {
    if (!isDirty) return;
    if (!window.confirm('Discard all unsaved website edits?')) return;
    setDraft(content);
    setSettingsDraft(pickStudioSettings(siteSettings));
    const liveReferences = collectImageReferences(content);
    for (const url of uploadedObjectIds.current.keys()) {
      if (!liveReferences.has(url)) uploadedObjectIds.current.delete(url);
    }
    const remainingReferenceCount = [...uploadedObjectIds.current.keys()]
      .reduce((sum, url) => sum + (liveReferences.get(url)?.length ?? 0), 0);
    setPendingAttachmentFailures(remainingReferenceCount);
    if (remainingReferenceCount === 0) {
      studioStash = null;
    }
    addToast('Edits discarded.', 'info');
  };

  const resetSection = (section: SectionDef) => {
    if (!window.confirm(`Reset "${section.label}" to the original launch copy? This replaces your edits in this section (you still need to press Publish).`)) return;
    let next = draft;
    let nextSettings = { ...settingsDraft };
    for (const block of section.blocks) {
      if (block.type === 'fields') for (const fd of block.fields) next = setPath(next, fd.path, getPath(DEFAULT_SITE_CONTENT, fd.path));
      if (block.type === 'list') next = setPath(next, block.def.path, JSON.parse(JSON.stringify(getPath(DEFAULT_SITE_CONTENT, block.def.path))));
      if (block.type === 'settings') { /* settings have no "launch copy" — leave them */ }
    }
    setDraft(next);
    setSettingsDraft(nextSettings);
  };

  // WP04R: images go browser → media-upload → Storage as PENDING objects.
  // The DRAFT field gets the new URL; the previous image is not touched — the
  // published site keeps rendering it until Publish, and a discarded draft
  // changes nothing (P0-R2). Publish records attachments; displaced objects
  // are grace-scheduled server-side and re-verified by content scan before
  // any deletion. The Media Library dual-write (legacy media_assets row) is
  // kept per spec §9.2.
  const uploadImage = (file: File, onDone: (url: string) => void) => {
    void (async () => {
      try {
        const res = await processAndUploadImage(file, { altText: file.name });
        if (res.status !== 'uploaded') { addToast(res.message, 'error'); return; }
        uploadedObjectIds.current.set(res.url, res.objectId);
        const asset: MediaItem = {
          id: createClientId('media'),
          name: file.name,
          folder: 'banners',
          size: `${Math.max(1, Math.round(file.size / 1024))} KB`,
          type: 'image/webp',
          uploadedAt: businessTodayISO(),
          url: res.url,
        };
        const ok = await publishMediaItems((previous) => [asset, ...previous]);
        if (!ok) {
          uploadedObjectIds.current.delete(res.url);
          addToast('The image upload could not be added to the Media Library. Choose the file again before publishing this page.', 'warning');
          return;
        }
        onDone(res.url);
        addToast(`"${file.name}" uploaded to the Media Library and applied.`, 'success');
      } catch (error) {
        addToast(error instanceof Error ? `Image upload failed: ${error.message}` : 'Image upload failed. Check your connection and retry.', 'error');
      }
    })();
  };

  /* ----- search: flatten every field for the quick-find panel ----- */
  interface FlatField { section: SectionDef; field: FieldDef }
  const searchResults: FlatField[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: FlatField[] = [];
    for (const section of SECTIONS) {
      for (const block of section.blocks) {
        if (block.type !== 'fields') continue;
        for (const field of block.fields) {
          // Match against the SAVED value (not the draft) so a row doesn't
          // vanish from under the cursor while its text is being rewritten.
          const val = String(getPath(content, field.path) ?? '');
          if (field.label.toLowerCase().includes(q) || val.toLowerCase().includes(q) || section.label.toLowerCase().includes(q)) {
            out.push({ section, field });
          }
        }
      }
    }
    return out.slice(0, 24);
  }, [query, content]);

  /* ------------------------------------------------------------------ */
  /*  Small render helpers                                               */
  /* ------------------------------------------------------------------ */

  const inputCls = 'w-full bg-stone-50 border border-[#EBDECE] p-2.5 rounded-xl text-2xs outline-none focus:border-[#A46832] focus:bg-white transition-colors';
  const controlId = (prefix: string, value: string) =>
    `${prefix}-${value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()}`;

  /* Render FUNCTIONS, not nested components: a component defined inside the
     render would get a new identity every keystroke, forcing React to remount
     the subtree and drop input focus. Plain functions keep the tree stable. */
  const renderFieldRow = (field: FieldDef, showSection?: string) => {
    const fieldId = controlId('studio-field', field.path);
    const value = getPath(draft, field.path) ?? '';
    const original = getPath(DEFAULT_SITE_CONTENT, field.path);
    const savedValue = getPath(content, field.path);
    const isEdited = value !== savedValue;
    const differsFromLaunch = value !== original;
    const set = (v: string) => setDraft(d => setPath(d, field.path, v));

    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={fieldId} className="font-black text-[10px] uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
            {field.label}
            {showSection && <span className="normal-case tracking-normal font-bold text-[#7CC0C7] bg-[#7CC0C7]/10 px-1.5 py-0.5 rounded-full">{showSection}</span>}
            {isEdited && <span className="h-1.5 w-1.5 rounded-full bg-[#A46832] inline-block" title="Unsaved edit" />}
          </label>
          {differsFromLaunch && (
            <button
              type="button"
              onClick={() => set(String(original ?? ''))}
              title="Reset this field to the original launch copy"
              className="text-[9px] font-black uppercase tracking-wider text-[#A46832]/70 hover:text-[#A46832] flex items-center gap-1 cursor-pointer"
            >
              <RotateCcw className="h-2.5 w-2.5" /> Reset
            </button>
          )}
        </div>

        {field.kind === 'textarea' ? (
          <textarea id={fieldId} rows={field.rows || 3} value={value} onChange={e => set(e.target.value)} className={inputCls + ' resize-y'} />
        ) : field.kind === 'image' ? (
          <div className="space-y-2">
            <div className="flex items-start gap-3">
              <div className="h-16 w-16 shrink-0 rounded-xl border border-[#EBDECE] bg-stone-100 overflow-hidden flex items-center justify-center">
                {value
                  ? <img src={value} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                  : <ImageIcon className="h-5 w-5 text-stone-300" />}
              </div>
              <div className="flex-1 space-y-2">
                <input id={fieldId} value={value} onChange={e => set(e.target.value)} placeholder="https://… or pick below" className={inputCls} />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setImagePickerPath(imagePickerPath === field.path ? null : field.path)}
                    className="px-3 py-1.5 bg-[#7CC0C7]/20 hover:bg-[#7CC0C7]/40 text-[#2E2A26] rounded-full text-[10px] font-black uppercase tracking-wider cursor-pointer flex items-center gap-1"
                  >
                    <HardDrive className="h-3 w-3" /> Media library
                  </button>
                  {MEDIA_V2 ? (
                  <label className="px-3 py-1.5 bg-[#2E2A26] hover:bg-[#A46832] text-white rounded-full text-[10px] font-black uppercase tracking-wider cursor-pointer flex items-center gap-1">
                    <Upload className="h-3 w-3" /> Upload
                    <input type="file" accept={ACCEPTED_IMAGE_ACCEPT_ATTR} className="hidden" onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) uploadImage(file, set);
                      e.target.value = '';
                    }} />
                  </label>
                  ) : (
                  <span
                    className="px-3 py-1.5 bg-[#2E2A26]/10 text-[#2E2A26]/50 rounded-full text-[10px] font-black uppercase tracking-wider flex items-center gap-1 cursor-not-allowed"
                    title="Image uploads are turned off until the media pipeline gate passes (VITE_MEDIA_V2). Paste an image URL, or pick an existing library image."
                  >
                    <Upload className="h-3 w-3" /> Upload off
                  </span>
                  )}
                </div>
              </div>
            </div>
            {imagePickerPath === field.path && (
              <div className="p-3 bg-white border border-[#EBDECE] rounded-2xl grid grid-cols-4 sm:grid-cols-6 gap-2 max-h-44 overflow-y-auto">
                {mediaItems.filter(m => m.url && (m.type || '').startsWith('image')).length === 0 && (
                  <p className="col-span-full text-[10px] text-stone-400">No images in the library yet — use Upload.</p>
                )}
                {mediaItems.filter(m => m.url && (m.type || '').startsWith('image')).map(m => (
                  <button
                    type="button"
                    key={m.id}
                    onClick={() => { set(m.url); setImagePickerPath(null); }}
                    title={m.name}
                    className="relative h-14 rounded-lg overflow-hidden border border-[#EBDECE] hover:border-[#A46832] cursor-pointer group"
                  >
                    <img src={m.url} alt={m.name} referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                    {value === m.url && (
                      <span className="absolute inset-0 bg-[#A46832]/60 flex items-center justify-center"><Check className="h-4 w-4 text-white" /></span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <input id={fieldId} value={value} onChange={e => set(e.target.value)} className={inputCls} />
        )}

        {field.hint && <p className="text-[10px] text-stone-400 leading-relaxed">{field.hint}</p>}
      </div>
    );
  };

  const renderSettingsRow = (field: SettingsFieldDef) => {
    const fieldId = controlId('studio-setting', String(field.key));
    const value = (settingsDraft as any)[field.key];
    const isEdited = value !== (siteSettings as any)[field.key];
    const set = (v: string | boolean) => setSettingsDraft(s => ({ ...s, [field.key]: v }));

    if (field.kind === 'managed') {
      /* T13-10 (corrected): read the RESOLVED value from `siteSettings`, NOT
         from `settingsDraft`. The draft is built by picking only
         STUDIO_SETTINGS_KEYS — and these keys were deliberately removed from
         that list so the Studio cannot persist them — so reading the draft
         would render every managed field as "Not set" even when the value is
         present. `siteSettings` is hydrated from public_site_configuration,
         which is exactly the value the public site displays. */
      const resolved = siteSettings[field.key]; // typed: field.key is keyof SiteSettings
      const isLaunchFact = LAUNCH_FACT_KEYS.includes(field.key);
      return (
        <div className="space-y-1.5">
          <span className="font-black text-[10px] uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
            {field.label}
            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-[#EBDECE]/60 text-[#8F5322] normal-case tracking-normal">
              {isLaunchFact ? 'Managed in Settings → Launch Facts' : 'Read-only'}
            </span>
          </span>
          <p className="w-full bg-[#F7EFE6]/60 border border-[#EBDECE] rounded-lg px-3 py-2 text-2xs text-[#2E2A26] whitespace-pre-line min-h-[2.25rem]">
            {String(resolved ?? '').trim() || <span className="text-stone-400 italic">Not set — enter it in Settings → Launch Facts</span>}
          </p>
        </div>
      );
    }

    if (field.kind === 'toggle') {
      return (
        <label className="flex items-center gap-2.5 cursor-pointer select-none py-1">
          <input type="checkbox" checked={!!value} onChange={e => set(e.target.checked)} className="h-4 w-4 rounded border-neutral-300 accent-[#A46832]" />
          <span className="font-bold text-2xs">{field.label}</span>
          {isEdited && <span className="h-1.5 w-1.5 rounded-full bg-[#A46832] inline-block" title="Unsaved edit" />}
        </label>
      );
    }
    return (
      <div className="space-y-1.5">
        <label htmlFor={fieldId} className="font-black text-[10px] uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
          {field.label}
          {isEdited && <span className="h-1.5 w-1.5 rounded-full bg-[#A46832] inline-block" title="Unsaved edit" />}
        </label>
        {field.kind === 'textarea'
          ? <textarea id={fieldId} rows={2} value={String(value ?? '')} onChange={e => set(e.target.value)} className={inputCls + ' resize-y'} />
          : <input id={fieldId} value={String(value ?? '')} onChange={e => set(e.target.value)} className={inputCls} />}
        {/* WP-03: link fields are validated at SAVE time too. The render
            boundary (safeExternalHref) already guarantees an unsafe value can
            never ship; this message tells the admin WHY their link is absent. */}
        {/^(?!websiteUrl$)\w*Url$/.test(String(field.key)) && isUnsafeExternalUrl(value) && (
          <p className="text-[10px] font-bold text-red-600">
            Invalid or unsafe link — it must start with https:// . It will NOT be shown on the site until fixed.
          </p>
        )}
        {field.hint && <p className="text-[10px] text-stone-400 leading-relaxed">{field.hint}</p>}
      </div>
    );
  };

  const renderListEditor = (def: ListDef) => {
    const items: any[] = getPath(draft, def.path) || [];
    const original: any[] = getPath(DEFAULT_SITE_CONTENT, def.path) || [];
    const setItems = (next: any[]) => setDraft(d => setPath(d, def.path, next));
    const changed = JSON.stringify(items) !== JSON.stringify(getPath(content, def.path));

    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-black text-[10px] uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
            {def.label} <span className="text-stone-300">({items.length})</span>
            {changed && <span className="h-1.5 w-1.5 rounded-full bg-[#A46832] inline-block" title="Unsaved edits" />}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setItems(JSON.parse(JSON.stringify(original)))}
              title="Reset this list to the original launch copy"
              className="text-[9px] font-black uppercase tracking-wider text-[#A46832]/70 hover:text-[#A46832] flex items-center gap-1 cursor-pointer"
            >
              <RotateCcw className="h-2.5 w-2.5" /> Reset list
            </button>
            {(!def.max || items.length < def.max) && (
              <button
                type="button"
                onClick={() => {
                  const blank: any = {};
                  def.fields.forEach(fld => { blank[fld.key] = ''; });
                  setItems([...items, blank]);
                }}
                className="px-2.5 py-1 bg-[#A46832] text-white rounded-full text-[9px] font-black uppercase tracking-wider cursor-pointer flex items-center gap-1"
              >
                <Plus className="h-2.5 w-2.5" /> Add {def.itemName}
              </button>
            )}
          </div>
        </div>

        <div className="space-y-3">
          {items.map((item, idx) => (
            <div key={idx} className="p-4 bg-stone-50/70 border border-[#EBDECE] rounded-2xl space-y-3 relative">
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-black uppercase tracking-widest text-[#A46832]">{def.itemName} {idx + 1}</span>
                {items.length > (def.min ?? 1) && (
                  <button
                    type="button"
                    onClick={() => setItems(items.filter((_, i) => i !== idx))}
                    title={`Remove this ${def.itemName}`}
                    className="p-1 text-stone-400 hover:text-red-500 cursor-pointer"
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
                {def.fields.map(fld => {
                  const fieldId = controlId('studio-list', `${def.path}-${idx}-${fld.key}`);
                  return (
                  <div key={fld.key} className={fld.small ? 'sm:col-span-1' : fld.kind === 'textarea' ? 'sm:col-span-6' : 'sm:col-span-5'}>
                    <label htmlFor={fieldId} className="font-bold text-[9px] uppercase tracking-wider text-zinc-400 block mb-1">{fld.label}</label>
                    {fld.kind === 'textarea' ? (
                      <textarea
                        id={fieldId}
                        rows={2}
                        value={item[fld.key] ?? ''}
                        onChange={e => setItems(items.map((it, i) => i === idx ? { ...it, [fld.key]: e.target.value } : it))}
                        className={inputCls + ' resize-y'}
                      />
                    ) : (
                      <input
                        id={fieldId}
                        value={item[fld.key] ?? ''}
                        onChange={e => setItems(items.map((it, i) => i === idx ? { ...it, [fld.key]: e.target.value } : it))}
                        className={inputCls}
                      />
                    )}
                  </div>
                );})}
              </div>
            </div>
          ))}
        </div>
        {def.hint && <p className="text-[10px] text-stone-400 leading-relaxed">{def.hint}</p>}
      </div>
    );
  };

  const renderPreview = (kind: 'announcement' | 'nav' | 'hero') => {
    if (kind === 'announcement') {
      return (
        <div className="rounded-2xl overflow-hidden border border-[#EBDECE]">
          <div className="text-[9px] font-black uppercase tracking-widest text-stone-400 bg-stone-50 px-3 py-1.5">Live preview</div>
          {settingsDraft.announcementEnabled ? (
            <div className="bg-[#2E2A26] text-white text-center text-2xs font-bold py-2 px-4">{settingsDraft.announcementText || '…'}</div>
          ) : (
            <div className="text-center text-[10px] text-stone-400 py-2.5 bg-white">Bar is switched off — visitors won't see it.</div>
          )}
        </div>
      );
    }
    if (kind === 'nav') {
      const labels = [draft.nav.home, draft.nav.menu, draft.nav.stores, draft.nav.careers, draft.nav.franchise, draft.nav.news, draft.nav.about, draft.nav.contact];
      return (
        <div className="rounded-2xl overflow-hidden border border-[#EBDECE]">
          <div className="text-[9px] font-black uppercase tracking-widest text-stone-400 bg-stone-50 px-3 py-1.5">Live preview</div>
          <div className="bg-white p-3 flex flex-wrap gap-1.5">
            {labels.map((l, i) => (
              <span key={i} className={`px-3 py-1.5 rounded-full text-[10px] font-semibold ${i === 0 ? 'bg-[#A46832] text-white' : 'text-[#2E2A26] bg-[#EBDECE]/40'}`}>{l || '…'}</span>
            ))}
          </div>
        </div>
      );
    }
    // hero
    return (
      <div className="rounded-2xl overflow-hidden border border-[#EBDECE]">
        <div className="text-[9px] font-black uppercase tracking-widest text-stone-400 bg-stone-50 px-3 py-1.5">Live preview</div>
        <div className="bg-[#A46832] p-6 space-y-3">
          <h3 className="font-display text-xl font-bold text-white whitespace-pre-wrap leading-tight">{draft.home.heroHeadline || '…'}</h3>
          <p className="text-[11px] text-white whitespace-pre-wrap leading-relaxed max-w-md">{draft.home.heroSubheadline || '…'}</p>
          <div className="flex gap-2 pt-1">
            <span className="px-4 py-2 bg-white text-[#2E2A26] font-bold rounded-full text-[10px]">{draft.home.heroPrimaryCta || '…'}</span>
            <span className="px-4 py-2 border border-white/60 text-white font-bold rounded-full text-[10px]">{draft.home.heroSecondaryCta || '…'}</span>
          </div>
        </div>
      </div>
    );
  };

  const renderBlock = (block: Block, idx: number) => {
    switch (block.type) {
      case 'heading':
        return <h3 key={idx} className="font-display font-black text-xs uppercase tracking-wide text-[#2E2A26] border-b border-[#EBDECE] pb-2 pt-2">{block.text}</h3>;
      case 'note':
        return <p key={idx} className="text-[10px] text-[#2E2A26]/60 bg-[#7CC0C7]/10 border border-[#7CC0C7]/30 rounded-xl px-3 py-2 leading-relaxed">{block.text}</p>;
      case 'preview':
        return <div key={idx}>{renderPreview(block.kind)}</div>;
      case 'fields':
        return (
          <div key={idx} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {block.fields.map(fd => (
              <div key={fd.path} className={fd.kind === 'textarea' || fd.kind === 'image' ? 'md:col-span-2' : ''}>
                {renderFieldRow(fd)}
              </div>
            ))}
          </div>
        );
      case 'list':
        return <div key={idx}>{renderListEditor(block.def)}</div>;
      case 'settings':
        return (
          <div key={idx} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {block.fields.map(sf => (
              <div key={String(sf.key)} className={sf.kind === 'textarea' || sf.kind === 'toggle' ? 'md:col-span-2' : ''}>
                {renderSettingsRow(sf)}
              </div>
            ))}
          </div>
        );
    }
  };

  const section = SECTIONS.find(s => s.id === activeSection) || SECTIONS[0]!;
  const groups: ('Global' | 'Pages')[] = ['Pages', 'Global'];

  /* ------------------------------------------------------------------ */
  /*  Layout                                                             */
  /* ------------------------------------------------------------------ */
  return (
    <div className="space-y-5 pb-24">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="font-display font-black text-2xl flex items-center gap-2">
            <Globe className="h-5 w-5 text-[#A46832]" /> Website Studio
          </h1>
          <p className="text-2xs text-[#2E2A26]/70">
            Every headline, image, button and legal page on the public site — edited here, published in one click.
          </p>
        </div>
        <div className="relative w-full lg:w-72">
          <Search className="absolute left-3.5 top-2.5 h-3.5 w-3.5 text-[#A46832]" />
          <input
            aria-label="Search website fields"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Find any text on the website…"
            className="w-full pl-9 pr-10 py-2 bg-white border border-[#EBDECE] rounded-full text-2xs outline-none focus:border-[#A46832]"
          />
          {query && (
            <button type="button" aria-label="Clear website search" onClick={() => setQuery('')} className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full grid place-items-center text-stone-400 hover:text-[#2E2A26] hover:bg-stone-100 cursor-pointer"><X className="h-3.5 w-3.5" /></button>
          )}
        </div>
      </div>

      {/* Quick-find results replace the editor while a query is typed */}
      {query.trim() ? (
        <div className="bg-white rounded-2xl border border-[#EBDECE] p-6 space-y-5 shadow-2xs">
          <p className="text-[10px] font-black uppercase tracking-widest text-stone-400">
            {searchResults.length ? `${searchResults.length} matching field${searchResults.length === 1 ? '' : 's'}` : 'No fields match — try another word'}
          </p>
          {searchResults.map(({ section: sec, field }) => (
            <div key={field.path} className="pb-4 border-b border-[#EBDECE]/60 last:border-b-0 last:pb-0">
              {renderFieldRow(field, sec.label)}
              <button
                onClick={() => { setActiveSection(sec.id); setQuery(''); }}
                className="mt-2 text-[9px] font-black uppercase tracking-wider text-[#7CC0C7] hover:text-[#2E2A26] flex items-center gap-1 cursor-pointer"
              >
                Open {sec.label} <ChevronRight className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* -------- Section rail -------- */}
          <div className="lg:col-span-3 space-y-4 lg:sticky lg:top-2">
            {groups.map(group => (
              <div key={group} className="bg-white rounded-2xl border border-[#EBDECE] p-3 shadow-2xs">
                <p className="text-[9px] font-black uppercase tracking-widest text-stone-400 px-2 pb-1.5">{group === 'Pages' ? 'Pages' : 'Site-wide'}</p>
                <div className="space-y-0.5">
                  {SECTIONS.filter(s => s.group === group).map(s => {
                    const IconComp = s.icon;
                    const changes = sectionChangeCount(s);
                    const active = s.id === activeSection;
                    return (
                      <button
                        key={s.id}
                        onClick={() => setActiveSection(s.id)}
                        className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-2xs font-bold transition-all cursor-pointer text-left ${
                          active ? 'bg-[#A46832] text-white shadow-xs' : 'text-[#2E2A26] hover:bg-[#F7EFE6]'
                        }`}
                      >
                        <IconComp className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-white' : 'text-[#A5642B]'}`} />
                        <span className="flex-1 truncate">{s.label}</span>
                        {changes > 0 && (
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-black ${active ? 'bg-white text-[#A5642B]' : 'bg-[#A46832]/15 text-[#A5642B]'}`}>{changes}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Related managers */}
            <div className="bg-white rounded-2xl border border-[#EBDECE] p-3 shadow-2xs">
              <p className="text-[9px] font-black uppercase tracking-widest text-stone-400 px-2 pb-1.5">Shown on the site, managed in…</p>
              <div className="space-y-0.5">
                {RELATED_MANAGERS.map(m => {
                  const IconComp = m.icon;
                  return (
                    <button
                      key={m.id}
                      onClick={() => goToAdminTab(m.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-2xs font-bold text-[#2E2A26] hover:bg-[#F7EFE6] transition-all cursor-pointer text-left"
                      title={m.blurb}
                    >
                      <IconComp className="h-3.5 w-3.5 shrink-0 text-[#7CC0C7]" />
                      <span className="flex-1 truncate">{m.label}</span>
                      <ChevronRight className="h-3 w-3 text-stone-300" />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* -------- Field editor -------- */}
          <div className="lg:col-span-9 bg-white rounded-2xl border border-[#EBDECE] p-6 space-y-5 shadow-2xs">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 border-b border-[#EBDECE] pb-4">
              <div>
                <h2 className="font-display font-black text-lg text-[#2E2A26]">{section.label}</h2>
                <p className="text-[11px] text-[#2E2A26]/60 leading-relaxed max-w-xl">{section.description}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {section.viewTab && (
                  <button
                    onClick={() => onViewPage(section.viewTab!)}
                    title={isDirty ? 'Opens the live page — your unsaved edits are kept when you return. The browser warns before a refresh that would discard them.' : 'Open the live page'}
                    className="px-3.5 py-2 bg-[#7CC0C7]/20 hover:bg-[#7CC0C7]/40 text-[#2E2A26] rounded-full text-xs font-black uppercase tracking-wider cursor-pointer flex items-center gap-1.5"
                  >
                    <Eye className="h-3 w-3" /> View live page
                  </button>
                )}
                <button
                  onClick={() => resetSection(section)}
                  className="px-3.5 py-2 bg-stone-100 hover:bg-stone-200 text-[#2E2A26] rounded-full text-xs font-black uppercase tracking-wider cursor-pointer flex items-center gap-1.5"
                >
                  <RotateCcw className="h-3 w-3" /> Reset section
                </button>
              </div>
            </div>

            {section.id === 'seo' && seoPanel}
            {section.blocks.map(renderBlock)}
          </div>
        </div>
      )}

      {/* -------- Sticky publish bar -------- */}
      {requiresOwnerAction && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40">
          <div className="flex items-center gap-3 bg-[#2E2A26] text-white pl-5 pr-2 py-2 rounded-full shadow-2xl border border-white/10">
            <span className="text-2xs font-bold whitespace-nowrap" role="status" aria-live="polite">
              {isDirty
                ? `${totalChanges} unsaved edit${totalChanges === 1 ? '' : 's'}`
                : `${pendingAttachmentFailures} image reference${pendingAttachmentFailures === 1 ? '' : 's'} to retry`}
            </span>
            {isDirty && (
              <button type="button" onClick={handleDiscard} className="min-h-11 px-3.5 py-2 rounded-full text-xs font-black uppercase tracking-wider hover:bg-white/10 cursor-pointer">
                Discard
              </button>
            )}
            <button type="button" onClick={handleSave} disabled={publishBusy} className="min-h-11 px-5 py-2 bg-[#A46832] hover:bg-[#A5642B] rounded-full text-xs font-black uppercase tracking-wider cursor-pointer flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed">
              <ExternalLink className="h-3 w-3" />
              {publishBusy
                ? (isDirty ? 'Publishing…' : 'Retrying…')
                : (isDirty ? 'Publish to the live site' : 'Retry image references')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
