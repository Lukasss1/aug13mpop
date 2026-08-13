/** Pure read models for the Admin dashboard. */
import type {
  ContactMessage, EmployeeProfile, FranchiseInquiry, JobApplication, MenuItem, SIFRReport, SiteSettings,
  StaffDocument, StoreLocation,
} from '../../types';
import { hasRealStoreIdentity, isPublishableMenuItem } from '../../lib/publishRules';
import { safeMailtoHref, safeTelHref } from '../../lib/safeUrl';

export interface AdminOpeningSummary {
  publicStoreCount: number;
  privateStoreCount: number;
  publicMenuCount: number;
  privateMenuCount: number;
  hasPublicContact: boolean;
}

export interface AdminDashboardAlert {
  id: string;
  msg: string;
  type: 'info' | 'warning' | 'success';
  date: string;
  sourceType: 'job_application' | 'franchise_inquiry' | 'sifr_report' | 'staff_document';
  sourceId: string;
  severity: 'info' | 'warning';
}

export interface AdminRecruitmentBar {
  id: 'pending' | 'reviewing' | 'interview' | 'offer' | 'staff';
  label: string;
  count: number;
  heightPercent: number;
}

export function isSifrOpenStatus(status: SIFRReport['status']): boolean {
  return status !== 'resolved' && status !== 'closed';
}

export interface AdminDashboardMetrics {
  newContactMessages: number;
  pendingApplications: number;
  pendingFranchiseInquiries: number;
  dashboardMessageCount: number;
  activeStaff: number;
  disabledStaff: number;
  recruitmentBars: AdminRecruitmentBar[];
}

/** One consistent count model for dashboard cards, navigation badges and the
 * recruitment chart. In particular, franchise enquiries start as `pending` —
 * never `new` — so the previous dashboard comparison could never count them. */
export function buildAdminDashboardMetrics(
  contactMessages: ContactMessage[],
  applications: JobApplication[],
  franchiseInquiries: FranchiseInquiry[],
  employees: EmployeeProfile[],
  siteSettings: SiteSettings,
): AdminDashboardMetrics {
  let newContactMessages = 0;
  for (const message of contactMessages) {
    if (message.status === 'new') newContactMessages += 1;
  }

  const applicationCounts = { pending: 0, reviewing: 0, interview: 0, offer: 0 };
  for (const application of applications) {
    if (application.status === 'pending') applicationCounts.pending += 1;
    else if (application.status === 'reviewing') applicationCounts.reviewing += 1;
    else if (application.status === 'interview') applicationCounts.interview += 1;
    else if (application.status === 'offer') applicationCounts.offer += 1;
  }

  let pendingFranchiseInquiries = 0;
  for (const inquiry of franchiseInquiries) {
    if (inquiry.status === 'pending') pendingFranchiseInquiries += 1;
  }

  let activeStaff = 0;
  let disabledStaff = 0;
  for (const employee of employees) {
    if (employee.status === 'disabled') disabledStaff += 1;
    else activeStaff += 1;
  }

  const rawBars = [
    { id: 'pending' as const, label: 'Pending', count: applicationCounts.pending },
    { id: 'reviewing' as const, label: 'Reviewing', count: applicationCounts.reviewing },
    { id: 'interview' as const, label: 'Interview', count: applicationCounts.interview },
    { id: 'offer' as const, label: 'Offer Made', count: applicationCounts.offer },
    { id: 'staff' as const, label: 'Staff Profiles', count: employees.length },
  ];
  const maxCount = Math.max(1, ...rawBars.map((bar) => bar.count));

  return {
    newContactMessages,
    pendingApplications: applicationCounts.pending,
    pendingFranchiseInquiries,
    dashboardMessageCount: newContactMessages
      + (siteSettings.showCareers ? applicationCounts.pending : 0)
      + (siteSettings.showFranchise ? pendingFranchiseInquiries : 0),
    activeStaff,
    disabledStaff,
    recruitmentBars: rawBars.map((bar) => ({
      ...bar,
      heightPercent: bar.count === 0 ? 0 : Math.round((bar.count / maxCount) * 100),
    })),
  };
}

export function buildAdminOpeningSummary(
  stores: StoreLocation[],
  setupOverlay: Record<string, Partial<StoreLocation>>,
  menuItems: MenuItem[],
  siteSettings: SiteSettings,
): AdminOpeningSummary {
  const publicStoreCount = stores.filter((store) => {
    const effectiveStore = { ...store, ...setupOverlay[store.id] };
    return hasRealStoreIdentity(effectiveStore);
  }).length;
  const publicMenuCount = menuItems.filter((item) =>
    item.available === true && isPublishableMenuItem(item),
  ).length;

  return {
    publicStoreCount,
    privateStoreCount: Math.max(0, stores.length - publicStoreCount),
    publicMenuCount,
    privateMenuCount: Math.max(0, menuItems.length - publicMenuCount),
    hasPublicContact: Boolean(safeMailtoHref(siteSettings.email) || safeTelHref(siteSettings.phone)),
  };
}

type TimestampedRecord = Record<string, unknown> & { id?: string };

function newestRecord<T extends TimestampedRecord>(items: T[], fields: readonly string[]): { item: T | null; date: string } {
  let newest: T | null = null;
  let newestMs: number | null = null;
  for (const item of items) {
    for (const field of fields) {
      const value = item[field];
      const parsed = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
      if (!Number.isFinite(parsed)) continue;
      if (newestMs === null || parsed > newestMs) {
        newest = item;
        newestMs = parsed;
      }
      break;
    }
  }
  if (newestMs === null) return { item: items[0] || null, date: 'time not recorded' };
  return {
    item: newest,
    date: new Date(newestMs).toLocaleString('en-GB', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }),
  };
}

export function buildAdminDashboardAlerts(
  applications: JobApplication[],
  franchiseInquiries: FranchiseInquiry[],
  sifrReports: SIFRReport[],
  documents: StaffDocument[],
): AdminDashboardAlert[] {
  const alerts: AdminDashboardAlert[] = [];

  const pendingApplications = applications.filter((item) => item.status === 'pending');
  if (pendingApplications.length) {
    const newest = newestRecord(pendingApplications as unknown as TimestampedRecord[], ['appliedAt', 'applied_at', 'createdAt']);
    alerts.push({
      id: 'applications',
      msg: `There are ${pendingApplications.length} unreviewed job applications.`,
      type: 'info', severity: 'info', sourceType: 'job_application',
      sourceId: String(newest.item?.id || ''), date: newest.date,
    });
  }

  const pendingFranchise = franchiseInquiries.filter((item) => item.status === 'pending');
  if (pendingFranchise.length) {
    const newest = newestRecord(pendingFranchise as unknown as TimestampedRecord[], ['submittedAt', 'submitted_at', 'createdAt']);
    alerts.push({
      id: 'franchise',
      msg: `${pendingFranchise.length} franchise ${pendingFranchise.length === 1 ? 'lead is' : 'leads are'} waiting for screening.`,
      type: 'warning', severity: 'warning', sourceType: 'franchise_inquiry',
      sourceId: String(newest.item?.id || ''), date: newest.date,
    });
  }

  const openIncidents = sifrReports.filter((item) => isSifrOpenStatus(item.status));
  if (openIncidents.length) {
    const newest = newestRecord(openIncidents as unknown as TimestampedRecord[], ['submittedAt', 'submitted_at', 'createdAt']);
    alerts.push({
      id: 'incidents',
      msg: `${openIncidents.length} open SIFR ${openIncidents.length === 1 ? 'report needs' : 'reports need'} attention.`,
      type: 'warning', severity: 'warning', sourceType: 'sifr_report',
      sourceId: String(newest.item?.id || ''), date: newest.date,
    });
  }

  const pendingDocuments = documents.filter((item) => item.status === 'pending');
  if (pendingDocuments.length) {
    const newest = newestRecord(pendingDocuments as unknown as TimestampedRecord[], ['uploadDate', 'uploadedAt', 'uploaded_at', 'createdAt']);
    alerts.push({
      id: 'documents',
      msg: `${pendingDocuments.length} staff ${pendingDocuments.length === 1 ? 'document is' : 'documents are'} awaiting review.`,
      type: 'info', severity: 'info', sourceType: 'staff_document',
      sourceId: String(newest.item?.id || ''), date: newest.date,
    });
  }

  return alerts;
}
