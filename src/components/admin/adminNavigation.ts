/**
 * Pure Admin navigation projection.
 *
 * Section reachability is owned by launchFeatures.ts. This module adds only
 * presentation metadata (order, short labels, icons, role visibility and
 * live badges) and derives the rendered groups from that registry. Keeping
 * the projection outside AdminPanel prevents route/sidebar drift and avoids
 * rebuilding the full navigation tree for unrelated form keystrokes.
 */
import {
  AlertTriangle, Award, BarChart2, BookOpen, Briefcase, Building, Calendar,
  Clock, Database, FileSpreadsheet, FileText, Globe, HardDrive, Inbox, Layers,
  ListChecks, Mail, Percent, Receipt, Settings, Shield, ShieldCheck, Star,
  Users, Volume2,
} from 'lucide-react';
import type { EmployeeRole } from '../../types';
import {
  ADMIN_FEATURES,
  type AdminFeatureId,
  type SectionVisibilityContext,
  isAdminSectionVisible,
} from '../../lib/launchFeatures';

export type AdminNavigationGroup = 'Everyday' | 'Operations' | 'Advanced';
export type AdminNavigationIcon = typeof Layers;

export interface AdminNavigationItem {
  id: AdminFeatureId;
  label: string;
  icon: AdminNavigationIcon;
  badge?: number;
}

export interface AdminNavigationSection {
  group: AdminNavigationGroup;
  items: AdminNavigationItem[];
}

export type AdminNavigationBadges = Partial<Record<AdminFeatureId, number>>;

interface AdminNavigationMeta {
  label: string;
  icon: AdminNavigationIcon;
  allowedRoles?: readonly EmployeeRole[];
}

/**
 * Stable task-first order. Every launch/gated/migration route appears exactly
 * once; the post-launch `performance` feature is intentionally absent because
 * it has no route and no launch UI.
 */
export const ADMIN_NAV_ORDER = [
  'dashboard', 'menu', 'sales', 'rota', 'contact', 'cms',
  'stores', 'staff', 'timesheets', 'docs', 'checklists', 'training', 'kb',
  'sifr', 'payslips', 'recognition', 'deals', 'news', 'media', 'careers', 'franchise',
  'analytics', 'till', 'settings', 'permissions', 'audit', 'legacy-import',
] as const satisfies readonly AdminFeatureId[];

const NAV_META: Record<(typeof ADMIN_NAV_ORDER)[number], AdminNavigationMeta> = {
  dashboard: { label: 'Today', icon: Layers },
  menu: { label: 'Menu', icon: ListChecks, allowedRoles: ['owner', 'store_manager'] },
  sales: { label: 'Orders', icon: Receipt, allowedRoles: ['owner', 'store_manager'] },
  rota: { label: 'Team & Rota', icon: Calendar },
  contact: { label: 'Messages', icon: Mail, allowedRoles: ['owner'] },
  cms: { label: 'Website', icon: Globe, allowedRoles: ['owner'] },

  stores: { label: 'Stores', icon: Building, allowedRoles: ['owner'] },
  staff: { label: 'Staff Directory', icon: Users },
  timesheets: { label: 'Timesheets', icon: Clock, allowedRoles: ['owner', 'store_manager'] },
  docs: { label: 'Documents', icon: FileText },
  checklists: { label: 'Checklists', icon: ListChecks, allowedRoles: ['owner', 'store_manager'] },
  training: { label: 'Training', icon: Award },
  kb: { label: 'Knowledge Base', icon: BookOpen },
  sifr: { label: 'Incidents', icon: AlertTriangle },
  payslips: { label: 'Earnings', icon: FileSpreadsheet, allowedRoles: ['owner'] },
  recognition: { label: 'Recognition', icon: Star },
  deals: { label: 'Deals', icon: Percent, allowedRoles: ['owner'] },
  news: { label: 'News', icon: Volume2, allowedRoles: ['owner'] },
  media: { label: 'Media', icon: HardDrive, allowedRoles: ['owner'] },
  careers: { label: 'Applications', icon: Briefcase, allowedRoles: ['owner', 'store_manager'] },
  franchise: { label: 'Franchise Leads', icon: Inbox, allowedRoles: ['owner'] },

  analytics: { label: 'Analytics', icon: BarChart2, allowedRoles: ['owner', 'store_manager'] },
  till: { label: 'Native Till Ledger', icon: Database, allowedRoles: ['owner', 'store_manager'] },
  settings: { label: 'Company Settings', icon: Settings, allowedRoles: ['owner'] },
  permissions: { label: 'Permissions', icon: Shield, allowedRoles: ['owner'] },
  audit: { label: 'Audit Trail', icon: ShieldCheck, allowedRoles: ['owner'] },
  'legacy-import': { label: 'Legacy Import', icon: HardDrive, allowedRoles: ['owner'] },
};

export function isAdminRoleAllowed(id: AdminFeatureId, role: EmployeeRole): boolean {
  if (!(ADMIN_NAV_ORDER as readonly AdminFeatureId[]).includes(id)) return false;
  const meta = NAV_META[id as (typeof ADMIN_NAV_ORDER)[number]];
  return !meta.allowedRoles || meta.allowedRoles.includes(role);
}

const GROUP_LABELS: Record<(typeof ADMIN_FEATURES)[AdminFeatureId]['defaultVisibility'], AdminNavigationGroup> = {
  everyday: 'Everyday',
  operations: 'Operations',
  advanced: 'Advanced',
};

export function buildAdminNavigation(
  role: EmployeeRole,
  badges: AdminNavigationBadges,
  visibility: SectionVisibilityContext,
): AdminNavigationSection[] {
  const groups: Record<AdminNavigationGroup, AdminNavigationItem[]> = {
    Everyday: [],
    Operations: [],
    Advanced: [],
  };

  for (const id of ADMIN_NAV_ORDER) {
    const meta = NAV_META[id];
    if (!isAdminRoleAllowed(id, role)) continue;
    if (!isAdminSectionVisible(id, visibility)) continue;

    const badge = badges[id];
    groups[GROUP_LABELS[ADMIN_FEATURES[id].defaultVisibility]].push({
      id,
      label: meta.label,
      icon: meta.icon,
      ...(typeof badge === 'number' && badge > 0 ? { badge } : {}),
    });
  }

  return (['Everyday', 'Operations', 'Advanced'] as const)
    .map((group) => ({ group, items: groups[group] }))
    .filter((section) => section.items.length > 0);
}
