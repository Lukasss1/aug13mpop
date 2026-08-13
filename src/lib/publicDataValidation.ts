/**
 * Runtime validation for anonymous/public data boundaries.
 * TypeScript types disappear at runtime, so every database/build-snapshot
 * payload is checked before it can mark a customer-facing collection ready.
 */
import { INITIAL_SETTINGS } from '../data';
import type {
  CareerVacancy, Deal, MenuItem, NewsPost, PrivacyNoticeCurrent,
  SiteSettings, StoreLocation,
} from '../types';
import { hydrateSiteContent, type SiteContent } from '../siteContent';
import { canonicalContentHash, snapshotCounts } from './publicContentSnapshot';
import type { PublicContentSnapshot, PublicContentSnapshotMetadata } from './publicContentSnapshot';
import { safePolicyHref } from './safeUrl';
import { normalizeCurrencySymbol } from './businessFormatting';
import { timedFetch } from './requestTimeout';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const nonBlank = (value: unknown): value is string => isString(value) && value.trim().length > 0;
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

function allRows<T>(value: unknown, label: string, guard: (row: unknown) => row is T): ValidationResult<T[]> {
  if (!Array.isArray(value)) return { ok: false, reason: `${label} is not an array` };
  const bad = value.findIndex((row) => !guard(row));
  return bad >= 0
    ? { ok: false, reason: `${label}[${bad}] is malformed` }
    : { ok: true, value: value as T[] };
}

export function isMenuItem(value: unknown): value is MenuItem {
  if (!isRecord(value)) return false;
  return nonBlank(value.id) && nonBlank(value.name) && nonBlank(value.category)
    && finiteNumber(value.price) && value.price >= 0
    // The anonymous projection contains available rows only. Undefined is
    // tolerated for older projected shapes; an explicit false is a leak.
    && (value.available === undefined || value.available === true);
}

export function isStoreLocation(value: unknown): value is StoreLocation {
  if (!isRecord(value)) return false;
  return nonBlank(value.id) && nonBlank(value.name) && isString(value.address)
    && isString(value.postcode) && ['open', 'closed', 'coming_soon'].includes(String(value.status))
    // setup_status is not a publication gate. Anonymous view rows omit it;
    // authenticated cached rows may carry either valid internal state.
    && (value.setupStatus === undefined || value.setupStatus === 'DRAFT' || value.setupStatus === 'ACTIVE');
}

export function isCareerVacancy(value: unknown): value is CareerVacancy {
  if (!isRecord(value)) return false;
  return nonBlank(value.id) && nonBlank(value.title) && isString(value.location)
    // job_vacancies_public omits status because every row is already
    // published. Explicit draft/closed values must never cross this boundary.
    && (value.status === undefined || value.status === 'published');
}

export function isNewsPost(value: unknown): value is NewsPost {
  if (!isRecord(value)) return false;
  return nonBlank(value.id) && nonBlank(value.title) && isString(value.content)
    && value.status === 'published';
}

export function isDeal(value: unknown): value is Deal {
  if (!isRecord(value)) return false;
  return nonBlank(value.id) && nonBlank(value.name)
    // deals_public omits active because every row is active. Explicit false is
    // a publication-boundary failure, not a harmless draft.
    && (value.active === undefined || value.active === true)
    && nonBlank(value.type);
}

export function isPrivacyNotice(value: unknown): value is PrivacyNoticeCurrent {
  if (!isRecord(value)) return false;
  return ['contact', 'careers', 'franchise'].includes(String(value.audience))
    && nonBlank(value.id) && nonBlank(value.contentSha256) && nonBlank(value.noticeText)
    && (value.policyUrl === null || value.policyUrl === undefined
      || (isString(value.policyUrl) && (!value.policyUrl.trim() || safePolicyHref(value.policyUrl) !== undefined)));
}

/** Merge newly introduced optional settings over safe defaults, then check the
 * public facts that the UI relies on. Older deployed rows therefore upgrade
 * safely without treating absent new flags as a malformed payload. */
export function validateSiteSettings(value: unknown): ValidationResult<SiteSettings> {
  if (!isRecord(value)) return { ok: false, reason: 'site settings is not an object' };
  const merged = { ...INITIAL_SETTINGS, ...value } as SiteSettings;
  const strings: (keyof SiteSettings)[] = [
    'brandName', 'legalName', 'companyNumber', 'websiteUrl', 'instagramHandle',
    'instagramUrl', 'facebookUrl', 'twitterUrl', 'phone', 'email', 'gdprEmail',
    'hqAddress', 'footerTagline', 'allergenNotice', 'announcementText',
    'currencySymbol', 'defaultOpeningHours',
  ];
  if (strings.some((key) => !isString(merged[key]))) return { ok: false, reason: 'site settings contains a non-string field' };
  if (!normalizeCurrencySymbol(merged.currencySymbol)) {
    return { ok: false, reason: 'site settings contains an invalid currency symbol' };
  }
  if (typeof merged.announcementEnabled !== 'boolean'
      || typeof merged.showCareers !== 'boolean'
      || typeof merged.showFranchise !== 'boolean'
      || typeof merged.showNews !== 'boolean') {
    return { ok: false, reason: 'site settings contains an invalid visibility flag' };
  }
  return { ok: true, value: merged };
}

export function validateSiteContent(value: unknown): ValidationResult<SiteContent> {
  if (!isRecord(value)) return { ok: false, reason: 'site content is not an object' };
  const hydrated = hydrateSiteContent(value);
  if (!nonBlank(hydrated.home.heroHeadline) || !nonBlank(hydrated.menuPage.heading)
      || !nonBlank(hydrated.contactPage.heading)) {
    return { ok: false, reason: 'site content is missing required page headings' };
  }
  return { ok: true, value: hydrated };
}

export function validatePublicStorageValue(key: string, value: unknown): ValidationResult<unknown> {
  switch (key) {
    case 'milkpop_site_settings': return validateSiteSettings(value);
    case 'milkpop_site_content': return validateSiteContent(value);
    case 'milkpop_menu_items': return allRows(value, 'menu items', isMenuItem);
    case 'milkpop_stores_list': return allRows(value, 'stores', isStoreLocation);
    case 'milkpop_vacancies_list': return allRows(value, 'vacancies', isCareerVacancy);
    case 'milkpop_news_posts': return allRows(value, 'news posts', isNewsPost);
    case 'milkpop_deals': return allRows(value, 'deals', isDeal);
    case 'milkpop_privacy_notices': return allRows(value, 'privacy notices', isPrivacyNotice);
    default: return { ok: true, value };
  }
}

export interface BuildPublicContentFile {
  snapshot: PublicContentSnapshot;
  metadata: PublicContentSnapshotMetadata;
}

export function validateBuildPublicContent(value: unknown): ValidationResult<BuildPublicContentFile> {
  if (!isRecord(value) || !isRecord(value.snapshot) || !isRecord(value.metadata)) {
    return { ok: false, reason: 'build public-content file has the wrong shape' };
  }
  const settings = validateSiteSettings(value.snapshot.siteSettings);
  const content = validateSiteContent(value.snapshot.siteContent);
  const menu = allRows(value.snapshot.menuItems, 'snapshot menu items', isMenuItem);
  const stores = allRows(value.snapshot.stores, 'snapshot stores', isStoreLocation);
  const vacancies = allRows(value.snapshot.vacancies, 'snapshot vacancies', isCareerVacancy);
  const news = allRows(value.snapshot.newsPosts, 'snapshot news', isNewsPost);
  const failed = [settings, content, menu, stores, vacancies, news].find((part) => !part.ok);
  if (failed && !failed.ok) return failed;
  const source = value.metadata.source;
  if (source !== 'supabase') return { ok: false, reason: 'build public-content file is not Supabase-sourced' };

  const normalisedSnapshot: PublicContentSnapshot = {
    siteSettings: settings.ok ? settings.value : INITIAL_SETTINGS,
    siteContent: content.ok ? content.value : hydrateSiteContent(null),
    menuItems: menu.ok ? menu.value : [],
    stores: stores.ok ? stores.value : [],
    vacancies: vacancies.ok ? vacancies.value : [],
    newsPosts: news.ok ? news.value : [],
  };
  const recordedHash = value.metadata.contentHash;
  if (!isString(recordedHash) || !/^[a-f0-9]{32}$/i.test(recordedHash)) {
    return { ok: false, reason: 'build public-content file has no valid content hash' };
  }
  const computedHash = canonicalContentHash(normalisedSnapshot);
  if (computedHash !== recordedHash.toLowerCase()) {
    return { ok: false, reason: 'build public-content file failed its content-hash check' };
  }

  const recordedCounts = value.metadata.counts;
  if (!isRecord(recordedCounts)) {
    return { ok: false, reason: 'build public-content file has no valid counts' };
  }
  const computedCounts = snapshotCounts(normalisedSnapshot);
  for (const [key, expected] of Object.entries(computedCounts)) {
    if (recordedCounts[key] !== expected) {
      return { ok: false, reason: `build public-content file count mismatch for ${key}` };
    }
  }

  return {
    ok: true,
    value: {
      snapshot: normalisedSnapshot,
      metadata: value.metadata as unknown as PublicContentSnapshotMetadata,
    },
  };
}

export async function loadBuildPublicContent(path = '/public-content.json'): Promise<ValidationResult<BuildPublicContentFile>> {
  try {
    const response = await timedFetch.read(path, { cache: 'no-store' });
    if (!response.ok) return { ok: false, reason: `snapshot request returned ${response.status}` };
    return validateBuildPublicContent(await response.json());
  } catch {
    return { ok: false, reason: 'snapshot request failed' };
  }
}
