/**
 * @file launchFeatures.ts
 * @description ONE authoritative declaration of every Admin section's launch
 * scope (C1.3, audit finding #7). The router's admin route allow-list and the
 * AdminPanel sidebar's visibility are both DERIVED from this registry, so a
 * section can never again be shown in the sidebar while its route silently
 * falls back to /admin/ (or vice-versa).
 *
 * Status meanings:
 *   • 'launch'         shipped and reachable — a normal launch feature.
 *   • 'gated'          shipped and reachable, but its active functionality is
 *                      behind a build flag (`env`); the UI must degrade to an
 *                      honest disabled state when the flag is off, not present a
 *                      dead control.
 *   • 'migration_only' a one-time utility (not a continuing business feature).
 *                      Reachable by URL, but only VISIBLE to an owner when its
 *                      flag is on AND legacy data is actually present.
 *   • 'post_launch'    deliberately deferred. NOT reachable and NOT shown in the
 *                      launch build (no route, hidden from the sidebar).
 *
 * PURITY: this module reads no `import.meta.env`, no `window`, no Node globals —
 * it is pure data + pure predicates, so it is safe to import from the router
 * (which the build-time prerenderer imports) as well as from the browser.
 * Runtime flag values (MEDIA_V2, LEGACY_IMPORT, whether legacy data exists) are
 * passed IN by the caller rather than read here.
 */

export type FeatureStatus = 'launch' | 'gated' | 'migration_only' | 'post_launch';
export type AdminFeatureVisibility = 'everyday' | 'operations' | 'advanced';

export interface AdminFeature {
  /** Human label (documentation / the schema-scope registry). The sidebar keeps
   *  its own display label + icon; this is the canonical description. */
  label: string;
  status: FeatureStatus;
  /** Small-business navigation tier. Advanced tools remain reachable but do not dominate everyday work. */
  defaultVisibility: AdminFeatureVisibility;
  /** The build flag that gates active functionality, for 'gated'/'migration_only'
   *  features. Documentation + used by the launch-scope contract test. */
  env?: string;
  note?: string;
}

/**
 * The admin sidebar id is the key; the section route is `/admin/<id>/`. Keep this
 * in the SAME order the sidebar presents the sections so the derived route
 * allow-list reads naturally.
 */
export const ADMIN_FEATURES = {
  // Overview
  dashboard: { label: 'Dashboard', status: 'launch', defaultVisibility: 'everyday' },
  analytics: { label: 'Business Analytics', status: 'launch', defaultVisibility: 'advanced' },
  // Website
  cms: { label: 'Website Studio', status: 'launch', defaultVisibility: 'everyday' },
  news: { label: 'News & Updates', status: 'launch', defaultVisibility: 'operations' },
  media: { label: 'Media Library', status: 'gated', defaultVisibility: 'operations', env: 'VITE_MEDIA_V2',
    note: 'Image UPLOAD is behind VITE_MEDIA_V2; when off the library still lists/renders existing assets but the upload control is hidden.' },
  // Shop
  menu: { label: 'Menu Items', status: 'launch', defaultVisibility: 'everyday' },
  deals: { label: 'Deals & Combos', status: 'launch', defaultVisibility: 'operations' },
  sales: { label: 'Web Till Orders', status: 'post_launch', defaultVisibility: 'everyday',
    note: 'Deferred with POS integration. Source is retained, but no launch route or sidebar item is exposed.' },
  till: { label: 'Native Till Ledger', status: 'post_launch', defaultVisibility: 'advanced',
    note: 'Deferred until the native POS is commissioned. The ledger remains source-controlled for later integration.' },
  stores: { label: 'Store Locations', status: 'launch', defaultVisibility: 'operations' },
  // Team
  staff: { label: 'Staff Directory', status: 'launch', defaultVisibility: 'operations' },
  rota: { label: 'Rota & Shifts', status: 'launch', defaultVisibility: 'everyday' },
  timesheets: { label: 'Timesheet Approvals', status: 'launch', defaultVisibility: 'operations' },
  payslips: { label: 'Earnings Estimates', status: 'launch', defaultVisibility: 'operations' },
  docs: { label: 'Staff Documents', status: 'launch', defaultVisibility: 'operations' },
  checklists: { label: 'Shift Checklists', status: 'launch', defaultVisibility: 'operations' },
  training: { label: 'Academy Studio', status: 'launch', defaultVisibility: 'operations' },
  kb: { label: 'Knowledge Base', status: 'launch', defaultVisibility: 'operations' },
  sifr: { label: 'SIFR Incidents', status: 'launch', defaultVisibility: 'operations' },
  performance: { label: 'Staff Reviews', status: 'post_launch', defaultVisibility: 'operations',
    note: 'Written performance reviews are deferred. No route, hidden from the launch sidebar (audit finding #2).' },
  recognition: { label: 'Recognition Points', status: 'launch', defaultVisibility: 'operations' },
  // Inbox
  careers: { label: 'Job Applications', status: 'launch', defaultVisibility: 'operations' },
  franchise: { label: 'Franchise Leads', status: 'launch', defaultVisibility: 'operations' },
  contact: { label: 'Customer Messages', status: 'launch', defaultVisibility: 'everyday' },
  // System
  settings: { label: 'Company Settings', status: 'launch', defaultVisibility: 'advanced' },
  permissions: { label: 'Permissions Matrix', status: 'launch', defaultVisibility: 'advanced' },
  audit: { label: 'Audit Trail', status: 'launch', defaultVisibility: 'advanced' },
  'legacy-import': { label: 'Legacy Data Import', status: 'migration_only', defaultVisibility: 'advanced', env: 'VITE_LEGACY_IMPORT',
    note: 'One-time owner-only browser→cloud migration. Hidden unless VITE_LEGACY_IMPORT is on AND legacy localStorage data is detected (audit finding #4).' },
} as const satisfies Record<string, AdminFeature>;

export type AdminFeatureId = keyof typeof ADMIN_FEATURES;

const ALL_IDS = Object.keys(ADMIN_FEATURES) as AdminFeatureId[];

/**
 * The admin route allow-list — every section reachable by URL. Derived from the
 * registry: everything EXCEPT deferred ('post_launch') features, which have no
 * route. The router uses this so its allow-list can never drift from the
 * registry. `migration_only` sections ARE routable (so a gated owner's deep
 * links / refresh work); their VISIBILITY is gated separately below.
 */
export const ADMIN_ROUTE_IDS: readonly string[] =
  ALL_IDS.filter((id) => ADMIN_FEATURES[id].status !== 'post_launch');

export interface SectionVisibilityContext {
  isOwner: boolean;
  /** VITE_MEDIA_V2 */
  mediaV2: boolean;
  /** VITE_LEGACY_IMPORT */
  legacyEnabled: boolean;
  /** whether legacy localStorage data is actually present on this device */
  legacyDetected: boolean;
}

/**
 * Whether an admin section should appear in the sidebar for the current runtime.
 * Deferred features are never shown; a migration utility is shown only to an
 * owner when its flag is on AND legacy data exists; launch/gated features are
 * shown (a gated feature stays visible but degrades its control internally).
 */
export function isAdminSectionVisible(id: string, ctx: SectionVisibilityContext): boolean {
  const feature = ADMIN_FEATURES[id as AdminFeatureId];
  if (!feature) return false; // unknown id ⇒ not a real section ⇒ don't show
  switch (feature.status) {
    case 'post_launch':
      return false;
    case 'migration_only':
      return ctx.isOwner && ctx.legacyEnabled && ctx.legacyDetected;
    case 'gated':
    case 'launch':
    default:
      return true;
  }
}

/** True when the section is a deferred (not-in-launch) feature. */
export function isDeferredSection(id: string): boolean {
  const feature = ADMIN_FEATURES[id as AdminFeatureId];
  return !!feature && feature.status === 'post_launch';
}
