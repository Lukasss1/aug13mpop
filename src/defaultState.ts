import { NewsPost, CmsPageContent, MediaItem, AuditLogItem, RolePermissionMatrix, PrivacyNoticeCurrent } from './types';

/**
 * LAUNCH-CLEAN: the previous seed shipped three invented press stories
 * (fake guest-rating statistics, a fictional flagship). A brand-new site
 * must not publish claims that never happened, so the news archive starts
 * empty. Add real stories in Admin → Website → News.
 */
export const INITIAL_NEWS_POSTS: NewsPost[] = [];

/* INC11: development-only placeholders so the three public forms are
 * exercisable in a backendless build. With a cloud configured, the anonymous
 * pull REPLACES these with privacy_notice_current — and when no notice is
 * published there, the pull yields an EMPTY array and the forms render
 * closed. These never reach production output. */
export const INITIAL_PRIVACY_NOTICES: PrivacyNoticeCurrent[] = [
  { audience: 'contact',   id: 'dev-contact',   versionLabel: 'dev', contentSha256: 'dev', noticeText: 'Development placeholder — the published contact privacy notice appears here.',   policyUrl: null },
  { audience: 'careers',   id: 'dev-careers',   versionLabel: 'dev', contentSha256: 'dev', noticeText: 'Development placeholder — the published careers privacy notice appears here.',   policyUrl: null },
  { audience: 'franchise', id: 'dev-franchise', versionLabel: 'dev', contentSha256: 'dev', noticeText: 'Development placeholder — the published franchise privacy notice appears here.', policyUrl: null },
];

export const INITIAL_CMS_PAGES: CmsPageContent[] = [
  {
    id: 'cms_home',
    pageName: 'Home',
    title: 'Home Page CMS',
    heroHeadline: 'Sip • Smile •\nEnjoy',
    heroSubheadline: 'Creamy milkshakes, refreshing smoothies, soft serve and slush — made for quick, feel-good moments while you shop.',
    heroImage: 'home_hero_banner',
    ctaText: 'View Menu',
    sectionContent: 'Milkshakes, smoothies, soft serve and slush — publish the final opening menu when it is confirmed.',
    seoTitle: 'Milk Pop — Milkshake Bar | Shakes, Smoothies & Soft Serve',
    seoDescription: 'Milk Pop menu and opening information, published as products and locations are confirmed.',
    status: 'published',
    lastEditedBy: 'System',
    lastEditedDate: new Date().toISOString()
  }
];

/**
 * LAUNCH-CLEAN: seeded with the brand assets that genuinely ship in
 * /public/brand — no stock-photo URLs, no files that don't exist.
 * Owner uploads land alongside these via Admin → Website → Media.
 */
export const INITIAL_MEDIA_LIBRARY: MediaItem[] = [
  { id: 'med_mascot_wave', name: 'mascot_wave.webp', folder: 'brand', size: '—', type: 'image/webp', uploadedAt: 'Launch', url: '/brand/mascot_wave.webp' },
  { id: 'med_mascot_choc', name: 'mascot_hold_shake.webp', folder: 'brand', size: '—', type: 'image/webp', uploadedAt: 'Launch', url: '/brand/mascot_hold_shake.webp' },
  { id: 'med_mascot_cups', name: 'mascot_sit_shake.webp', folder: 'brand', size: '—', type: 'image/webp', uploadedAt: 'Launch', url: '/brand/mascot_sit_shake.webp' },
  { id: 'med_art_kinder', name: 'drink_kinder_bueno.svg', folder: 'products', size: '—', type: 'image/svg+xml', uploadedAt: 'Launch', url: '/brand/drinks/m1.svg' },
  { id: 'med_art_oreo', name: 'drink_oreo.svg', folder: 'products', size: '—', type: 'image/svg+xml', uploadedAt: 'Launch', url: '/brand/drinks/m3.svg' },
  { id: 'med_art_strawberry', name: 'drink_strawberry.svg', folder: 'products', size: '—', type: 'image/svg+xml', uploadedAt: 'Launch', url: '/brand/drinks/m9.svg' }
];

/**
 * SECURITY/HONESTY: starts empty. The previous seed contained fabricated
 * audit entries (including a fake "GDPR compliance" record) that made the
 * trail look like real production history. An audit log must only ever
 * contain events that actually happened.
 */
export const INITIAL_AUDIT_LOGS: AuditLogItem[] = [
];

export const INITIAL_ROLE_PERMISSIONS: RolePermissionMatrix[] = [
  { role: 'owner', view: true, create: true, edit: true, delete: true, approve: true, publish: true },
  { role: 'store_manager', view: true, create: true, edit: true, delete: false, approve: true, publish: false },
  { role: 'supervisor', view: true, create: false, edit: false, delete: false, approve: false, publish: false },
  { role: 'team_member', view: false, create: false, edit: false, delete: false, approve: false, publish: false }
];
