/**
 * @file siteContent.ts
 * @description The single content model behind the public website.
 *
 * Every headline, paragraph, button label, image and SEO tag a visitor can
 * see lives in ONE typed object — `SiteContent` — edited from the Admin
 * Panel's **Website Studio** and rendered by PublicPages / Navbar / Footer.
 *
 * DESIGN RULES
 * ------------
 * 1. `DEFAULT_SITE_CONTENT` is a 1:1 extraction of the copy that used to be
 *    hard-coded in the components, so a fresh install looks identical.
 * 2. Saved content is always deep-merged OVER the defaults on load
 *    (`hydrateSiteContent`). When a future update adds new fields, existing
 *    installs pick up sensible defaults instead of rendering blanks.
 * 3. Multi-line copy uses real `\n` characters and is rendered with
 *    `whitespace-pre-line`, so owners can add paragraph breaks without HTML.
 * 4. Repeated blocks (cards, perks, pillars…) are arrays of small objects so
 *    the Studio can add / remove / edit them safely.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ContentCard {
  title: string;
  text: string;
}

export interface EmojiCard {
  emoji: string;
  title: string;
  text: string;
}

export interface StatCard {
  value: string;
  label: string;
}

export interface ContactRoute {
  label: string;
  email: string;
}

export interface PageSeo {
  title: string;
  description: string;
}

export interface SiteContent {
  /** Labels of the public navigation pills (header + footer reuse these). */
  nav: {
    home: string;
    menu: string;
    stores: string;
    careers: string;
    franchise: string;
    news: string;
    about: string;
    contact: string;
  };

  home: {
    heroHeadline: string;
    heroSubheadline: string;
    heroPrimaryCta: string;
    heroSecondaryCta: string;
    promiseKicker: string;
    promiseHeading: string;
    promiseCards: ContentCard[];
    favouritesKicker: string;
    favouritesHeading: string;
    favouritesCta: string;
    careersCard: { kicker: string; title: string; text: string; button: string };
    contactCard: { kicker: string; title: string; text: string; button: string };
  };

  menuPage: {
    kicker: string;
    heading: string;
    intro: string;
    searchPlaceholder: string;
  };

  storesPage: {
    kicker: string;
    heading: string;
    intro: string;
    searchPlaceholder: string;
  };

  careersPage: {
    kicker: string;
    heading: string;
    intro: string;
    perks: EmojiCard[];
    vacanciesHeading: string;
  };

  franchisePage: {
    kicker: string;
    heading: string;
    intro: string;
    whyHeading: string;
    whyPoints: ContentCard[];
    statsHeading: string;
    stats: StatCard[];
    formHeading: string;
  };

  aboutPage: {
    badge: string;
    heading: string;
    headingAccent: string; // rendered in caramel italics after the heading
    intro: string;
    craftHeading: string;
    craftText: string;
    craftBadgeTitle: string;
    craftBadgeText: string;
    craftImage: string;
    cultureHeading: string;
    cultureText: string;
    cultureBadgeTitle: string;
    cultureBadgeText: string;
    cultureImage: string;
    pillarsKicker: string;
    pillarsHeading: string;
    pillars: ContentCard[];
  };

  contactPage: {
    kicker: string;
    heading: string;
    intro: string;
    routesHeading: string;
    routes: ContactRoute[];
    locatorNote: string;
    locatorCta: string;
  };

  newsPage: {
    kicker: string;
    heading: string;
    intro: string;
  };

  footer: {
    exploreHeading: string;
    companyHeading: string;
    contactHeading: string;
  };

  legal: {
    privacy: { title: string; body: string };
    gdpr: { title: string; body: string };
    fdd: { title: string; body: string };
  };

  /** Browser-tab title + meta description per public page. */
  seo: {
    home: PageSeo;
    menu: PageSeo;
    stores: PageSeo;
    careers: PageSeo;
    franchise: PageSeo;
    about: PageSeo;
    contact: PageSeo;
    news: PageSeo;
  };
}

export const SITE_CONTENT_STORAGE_KEY = 'milkpop_site_content';

/* ------------------------------------------------------------------ */
/*  Defaults — extracted verbatim from the launch copy                 */
/* ------------------------------------------------------------------ */

export const DEFAULT_SITE_CONTENT: SiteContent = {
  nav: {
    home: 'Home',
    menu: 'Menu',
    stores: 'Stores',
    careers: 'Careers',
    franchise: 'Franchise',
    news: 'News',
    about: 'About Us',
    contact: 'Contact',
  },

  home: {
    heroHeadline: 'Sip • Smile •\nEnjoy',
    heroSubheadline:
      'Creamy milkshakes, refreshing smoothies, soft serve and slush — made for quick, feel-good moments while you shop.',
    heroPrimaryCta: 'View Menu',
    heroSecondaryCta: 'Find a Store',
    promiseKicker: 'Everyday Treats',
    promiseHeading: 'Simple, Sweet, Fast',
    promiseCards: [
      {
        title: 'Milkshake First',
        text: 'Milkshakes are at the heart of Milk Pop, alongside smoothies, soft serve and slush. The published menu shows the flavours and sizes available at each opening stage.',
      },
      {
        title: 'Premium-Cute',
        text: 'Milk Pop is designed to feel colourful, playful and easy to enjoy — a simple treat during a shopping trip.',
      },
      {
        title: 'Fast Service',
        text: 'The service model is simple: clear choices, consistent preparation and a friendly handover at the counter.',
      },
    ],
    favouritesKicker: 'Menu Highlights',
    favouritesHeading: 'Try Our Favourites',
    favouritesCta: 'Explore All Treats',
    careersCard: {
      kicker: 'Careers',
      title: 'Join the Milk Pop Team',
      text: "As we get ready to open, we'll be building our team. If you love fast-paced environments, delivering smiles and making great treats, follow our Careers page — confirmed roles will be posted there.",
      button: 'Current Openings',
    },
    contactCard: {
      kicker: 'Contact',
      title: 'Get In Touch',
      text: "Have a question, feedback or business enquiry? Use the published contact options and we’ll reply when we can.",
      button: 'Contact Us',
    },
  },

  menuPage: {
    kicker: 'Current Selection',
    heading: 'Milk Pop Menu',
    intro: 'Browse the products currently published by Milk Pop. Prices and availability may change as the opening menu is finalised.',
    searchPlaceholder: 'Search the published menu…',
  },

  storesPage: {
    kicker: 'Store Locations',
    heading: 'Find Milk Pop',
    intro: 'Confirmed Milk Pop locations will appear below — our first location is in development.',
    searchPlaceholder: 'Search by postcode, area or store name…',
  },

  careersPage: {
    kicker: 'Build Your Future',
    heading: 'Join the Team',
    intro: 'Hospitality is at our core. Our planned team offer is built around structured training and clear development — final details are confirmed in each vacancy.',
    perks: [
      { emoji: '📈', title: 'Growth Paths', text: 'We plan clear paths from Team Member to Supervisor, Store Manager and beyond.' },
      { emoji: '🌱', title: 'Food Hygiene', text: 'We plan role-appropriate food safety training for every team member, with details confirmed in each vacancy and training plan.' },
      { emoji: '🕒', title: 'Fair Rotas', text: 'We aim to share rotas ahead of time so you can plan around studies or family.' },
      { emoji: '🥤', title: 'Team Treats', text: 'Team treats are part of the plan — details are confirmed in each vacancy.' },
    ],
    vacanciesHeading: 'Active Job Vacancies',
  },

  franchisePage: {
    kicker: 'Partnership & Brand Growth',
    heading: 'Grow With Milk Pop',
    intro: 'Milk Pop is developing its first operating model. Partnership information will be published only when the programme is ready.',
    whyHeading: 'Why Franchise With Us?',
    whyPoints: [
      { title: 'Lean by Design', text: 'The operating model is being designed around a focused menu and repeatable preparation.' },
      { title: 'Ready Architecture', text: 'Kiosk and site requirements will be confirmed for each approved location.' },
      { title: 'Staff Portal', text: 'Approved partners will receive the operating and training information applicable to their location.' },
    ],
    statsHeading: 'Typical Minimum Parameters',
    stats: [
      { value: '', label: 'Liquid Capital' },
      { value: '', label: 'Quick Service Ops' },
    ],
    formHeading: 'Franchise Investment Enquiry',
  },

  aboutPage: {
    badge: 'Our Heritage & Ethos',
    heading: 'Elevating the simple joy of',
    headingAccent: 'everyday indulgence.',
    intro:
      'Milk Pop is a developing milkshake and dessert-kiosk concept focused on a concise menu, consistent preparation and friendly service.',
    craftHeading: 'The Craft of the Pour',
    craftText:
      "As Milk Pop develops, the focus is on getting the fundamentals right: clear recipes, reliable equipment, careful preparation and products that can be served consistently.\n\nFinal recipes, suppliers and allergen information will be confirmed before each product is offered for sale.",
    craftBadgeTitle: 'Carefully Chosen',
    craftBadgeText: '',
    craftImage: '/brand/drinks/m1.svg',
    cultureHeading: 'Our People, Our Pride',
    cultureText:
      "Milk Pop is being designed around clear training, respectful teamwork and practical store routines.\n\nConfirmed employment terms, benefits and development opportunities will always be stated in the relevant vacancy and staff documents.",
    cultureBadgeTitle: 'Culture of Care',
    cultureBadgeText: 'Training and working standards confirmed in each role',
    cultureImage: '/brand/mascot_sit_shake.webp',
    pillarsKicker: 'Our Promise',
    pillarsHeading: 'The Milk Pop Pillars',
    pillars: [
      {
        title: 'Product Standards',
        text: "Products should be prepared from approved recipes, stored correctly and supported by current allergen information before they are offered for sale.",
      },
      {
        title: 'Friendly Service',
        text: "We aim for clear, friendly service that helps customers choose confidently and receive their order accurately.",
      },
      {
        title: 'Intentional Growth',
        text: 'Any future growth should follow the operating standards proven at the first Milk Pop location.',
      },
    ],
  },

  contactPage: {
    kicker: 'Guest Care',
    heading: 'Contact Store Support',
    intro: 'Send us a message using the published contact details and we’ll reply when we can.',
    routesHeading: 'Support Routes',
    routes: [
      { label: 'General & Press', email: '' },
      { label: 'Franchising Team', email: '' },
      { label: 'Recruitment Hub', email: '' },
    ],
    locatorNote: 'Looking for an address, opening hours or store contact details? Open the Store Locator instead.',
    locatorCta: 'Store Locator →',
  },

  newsPage: {
    kicker: 'Milk Pop News',
    heading: 'Updates',
    intro: 'Follow genuine store, menu and team updates published by Milk Pop.',
  },

  footer: {
    exploreHeading: 'Explore',
    companyHeading: 'Company',
    contactHeading: 'Contact Details',
  },

  legal: {
    privacy: {
      title: 'Privacy Policy',
      body:
        'This page explains how Milk Pop handles personal information submitted through this website and staff portal. The business identity and privacy contact shown in the website footer are the authoritative contact details.\n\nInformation we receive\nWe receive information that people choose to provide through contact, careers and franchise forms, and information needed to operate authenticated staff functions. We also process limited technical and security information needed to protect and run the service.\n\nHow information is used\nInformation is used to respond to enquiries, assess applications, manage staff operations, prevent abuse and maintain the service. It may be handled by service providers that support hosting, authentication, e-mail delivery and security. Milk Pop does not sell personal information.\n\nRetention and requests\nInformation is kept only for as long as it is needed for the relevant business, employment, legal or security purpose. To ask about your information or exercise a data-protection right, use the privacy contact shown on this website. This policy is reviewed when Milk Pop’s suppliers or procedures change.',
    },
    gdpr: {
      title: 'Your Data Protection Rights',
      body:
        'Our commitment\nMilk Pop is committed to handling personal data responsibly and to meeting its obligations under the UK General Data Protection Regulation (UK GDPR) and the Data Protection Act 2018. This page describes your rights and how to exercise them; it is not a certification, and our data-protection review is ongoing.\n\nYour Rights\nUnder the UK GDPR, you possess several rights regarding our use of your personal data:\n\n• The right of access: You have the right to obtain confirmation as to whether or not personal data concerning you are being processed.\n• The right to rectification: You have the right to request the rectification of inaccurate personal data concerning you.\n• The right to erasure ("right to be forgotten"): In certain circumstances, you have the right to request the erasure of your personal data.\n\nPlease contact us using the details on our Contact page to exercise any of your data rights.',
    },
    fdd: {
      title: 'Franchise Information Notice',
      body:
        'The information on this website is introductory only. Submitting an enquiry does not create a franchise, reserve a territory or amount to an offer or acceptance.\n\nCommercial information\nAny illustrative costs, sales figures or projections discussed during an enquiry are estimates unless they are confirmed in formal documentation. Actual results can vary.\n\nNext steps\nA franchise relationship exists only after due diligence, independent advice where appropriate, and signature of the required agreements. Formal documents will be supplied only after they have been prepared and legally reviewed for the relevant location.',
    },
  },

  seo: {
    home: { title: 'Milk Pop — Milkshake Bar | Shakes, Smoothies & Soft Serve', description: 'Milk Pop — milkshakes, smoothies, soft serve and slush. Explore the menu and current store information.' },
    menu: { title: 'Menu | Milk Pop', description: 'Browse the products, prices and availability currently published by Milk Pop.' },
    stores: { title: 'Find a Store | Milk Pop', description: 'Milk Pop store locations, opening hours and current availability.' },
    careers: { title: 'Careers | Milk Pop', description: 'Join the Milk Pop team — follow us for upcoming roles.' },
    franchise: { title: 'Franchise | Milk Pop', description: 'Milk Pop partnership information, available only when the programme is open.' },
    about: { title: 'About Us | Milk Pop', description: 'Our story and the Milk Pop pillars.' },
    contact: { title: 'Contact | Milk Pop', description: 'Get in touch with Milk Pop.' },
    news: { title: 'News | Milk Pop', description: 'Updates from Milk Pop as we get ready to launch.' },
  },
};

/* ------------------------------------------------------------------ */
/*  Hydration: saved (partial) content -> complete, up-to-date object  */
/* ------------------------------------------------------------------ */

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Deep-merge `saved` over `defaults`. Arrays are taken from `saved`
 *  wholesale (owners may add/remove cards); scalars fall back per-field.
 *  IMPORTANT: never returns a reference into DEFAULT_SITE_CONTENT — the
 *  legacy-import step below mutates the result, and "reset to original"
 *  must always compare against pristine launch copy. */
function deepMergeContent<T>(defaults: T, saved: unknown): T {
  if (saved === undefined || saved === null) {
    // Deep copy (content is plain JSON) so callers can safely mutate.
    return defaults && typeof defaults === 'object'
      ? (JSON.parse(JSON.stringify(defaults)) as T)
      : defaults;
  }
  if (Array.isArray(defaults)) {
    return (Array.isArray(saved)
      ? (JSON.parse(JSON.stringify(saved)) as unknown as T)
      : (JSON.parse(JSON.stringify(defaults)) as T));
  }
  if (isPlainObject(defaults)) {
    if (!isPlainObject(saved)) return JSON.parse(JSON.stringify(defaults)) as T;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(defaults as Record<string, unknown>)) {
      out[key] = deepMergeContent((defaults as Record<string, unknown>)[key], saved[key]);
    }
    return out as T;
  }
  // Scalar: accept the saved value only when the primitive type matches.
  return (typeof saved === typeof defaults ? (saved as T) : defaults);
}

/**
 * Build the complete SiteContent from whatever was persisted.
 * Also performs the ONE-TIME migration from the legacy `milkpop_cms_pages`
 * registry (old CMS hero copy, about images and home SEO), so an owner's
 * previous edits survive the upgrade to the Website Studio.
 */
export function hydrateSiteContent(saved: unknown): SiteContent {
  const merged = deepMergeContent(DEFAULT_SITE_CONTENT, saved);

  // Legacy import runs only when nothing was ever saved under the new key.
  if (saved === undefined || saved === null) {
    try {
      if (typeof localStorage !== 'undefined') {
        const rawLegacy = localStorage.getItem('milkpop_cms_pages');
        if (rawLegacy) {
          const pages = JSON.parse(rawLegacy);
          if (Array.isArray(pages)) {
            const homePage = pages.find((p: Record<string, unknown>) => p?.id === 'cms_home');
            const aboutPage = pages.find((p: Record<string, unknown>) => p?.id === 'cms_about');
            if (homePage) {
              if (typeof homePage.heroHeadline === 'string' && homePage.heroHeadline) merged.home.heroHeadline = homePage.heroHeadline;
              if (typeof homePage.heroSubheadline === 'string' && homePage.heroSubheadline) merged.home.heroSubheadline = homePage.heroSubheadline;
              if (typeof homePage.ctaText === 'string' && homePage.ctaText) merged.home.heroPrimaryCta = homePage.ctaText;
              if (typeof homePage.seoTitle === 'string' && homePage.seoTitle) merged.seo.home.title = homePage.seoTitle;
              if (typeof homePage.seoDescription === 'string' && homePage.seoDescription) merged.seo.home.description = homePage.seoDescription;
            }
            if (aboutPage) {
              if (typeof aboutPage.aboutImage1 === 'string' && aboutPage.aboutImage1) merged.aboutPage.craftImage = aboutPage.aboutImage1;
              if (typeof aboutPage.aboutImage2 === 'string' && aboutPage.aboutImage2) merged.aboutPage.cultureImage = aboutPage.aboutImage2;
            }
          }
        }
      }
    } catch (e) {
      console.warn('Legacy CMS import skipped', e);
    }
  }

  // LAUNCH-CLEAN: earlier builds defaulted the About images to Unsplash stock
  // photos. The security headers no longer allow that host, so any stored
  // legacy URL is swapped for the shipped brand artwork (an owner-uploaded
  // image is untouched — this only matches the old stock host).
  const legacyStock = (v: unknown) =>
    typeof v === 'string' && v.includes('images.unsplash.com');
  if (legacyStock(merged.aboutPage.craftImage)) merged.aboutPage.craftImage = '/brand/drinks/m1.svg';
  if (legacyStock(merged.aboutPage.cultureImage)) merged.aboutPage.cultureImage = '/brand/mascot_sit_shake.webp';

  /* Forward-migrate the former stock culture-image path to WebP.
   * Content saved by an older release may still carry the removed .png path,
   * so that exact legacy default is rewritten before render. Owner-uploaded
   * images are untouched. */
  if (merged.aboutPage.cultureImage === '/brand/mascot_sit_shake.png') {
    merged.aboutPage.cultureImage = '/brand/mascot_sit_shake.webp';
  }

  return merged;
}

/** Public pages that carry SEO + a Studio section, in display order. */
export const PUBLIC_PAGE_KEYS = ['home', 'menu', 'stores', 'careers', 'franchise', 'about', 'contact', 'news'] as const;
export type PublicPageKey = (typeof PUBLIC_PAGE_KEYS)[number];
