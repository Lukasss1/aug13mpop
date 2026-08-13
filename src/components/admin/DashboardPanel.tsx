import React from 'react';
import { AlertTriangle, ArrowRight, Building, Calendar, FileSpreadsheet, Layers, Mail, Plus, ShieldCheck, UserPlus, Users, Volume2 } from 'lucide-react';
import type { AuditLogItem } from '../../types';
import type { AdminDashboardAlert, AdminDashboardMetrics, AdminOpeningSummary } from './adminDashboard';
import { NotificationHealthPanel, OpsHealthPanel } from './ClosurePanels';

export interface AdminOpeningSetupItem {
  done: boolean;
  label: string;
  detail: string;
  tab: string;
}

export interface AdminQuickAction {
  label: string;
  tab: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface DashboardPanelProps {
  openingSummary: AdminOpeningSummary;
  totalStores: number;
  totalMenuItems: number;
  metrics: AdminDashboardMetrics;
  totalEmployees: number;
  openingSetupItems: AdminOpeningSetupItem[];
  alerts: AdminDashboardAlert[];
  quickActions: AdminQuickAction[];
  auditLogs: AuditLogItem[];
  releaseVersion: string;
  canManageStores: boolean;
  canHireStaff: boolean;
  canCreateProduct: boolean;
  canOpenSettings: boolean;
  canViewAuditFeed: boolean;
  onNavigate: (tab: string) => void;
  onHireStaff: () => void;
  onCreateProduct: () => void;
}

export const DEFAULT_DASHBOARD_QUICK_ACTIONS: AdminQuickAction[] = [
  { label: 'Issue Announcement', icon: Volume2, tab: 'cms' },
  { label: 'Review SIFR Logs', icon: AlertTriangle, tab: 'sifr' },
  { label: 'Generate Earnings Estimates', icon: FileSpreadsheet, tab: 'payslips' },
  { label: 'Check in Rota', icon: Calendar, tab: 'rota' },
];

export const DashboardPanel = React.memo(function DashboardPanel({
  openingSummary,
  totalStores,
  totalMenuItems,
  metrics,
  totalEmployees,
  openingSetupItems,
  alerts,
  quickActions,
  auditLogs,
  releaseVersion,
  canManageStores,
  canHireStaff,
  canCreateProduct,
  canOpenSettings,
  canViewAuditFeed,
  onNavigate,
  onHireStaff,
  onCreateProduct,
}: DashboardPanelProps) {
  const cards = [
    {
      label: 'Public Stores',
      count: openingSummary.publicStoreCount,
      desc: openingSummary.publicStoreCount
        ? `${openingSummary.privateStoreCount} private or uncommissioned record(s)`
        : totalStores ? 'Finish and activate a location' : 'Add your first location',
      icon: Building,
      color: 'border-l-4 border-[#7CC0C7]',
    },
    {
      label: 'Public Menu',
      count: openingSummary.publicMenuCount,
      desc: openingSummary.publicMenuCount
        ? `${openingSummary.privateMenuCount} draft or unavailable item(s)`
        : totalMenuItems ? 'Publish at least one complete item' : 'Build your opening menu',
      icon: Layers,
      color: 'border-l-4 border-[#A46832]',
    },
    {
      label: 'New Messages',
      count: metrics.dashboardMessageCount,
      desc: 'Customer and programme enquiries',
      icon: Mail,
      color: 'border-l-4 border-[#2E2A26]',
    },
    {
      label: 'Active Staff',
      count: metrics.activeStaff,
      desc: totalEmployees ? `${metrics.disabledStaff} disabled profile(s)` : 'Add staff when ready',
      icon: Users,
      color: 'border-l-4 border-[#A5642B]',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display font-black text-2xl text-[#2E2A26]">Milk Pop Dashboard</h1>
          <p className="text-2xs text-[#2E2A26]/70">Daily overview of stores, team operations, customer messages, compliance and website content.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManageStores && (
            <button onClick={() => onNavigate('stores')} className="px-4 py-2 bg-[#7CC0C7] text-[#2E2A26] rounded-full text-2xs tracking-wider uppercase font-black flex items-center gap-1 shadow-xs cursor-pointer hover:bg-[#5FA9B1]">
              <Building className="h-3 w-3" /> Manage Stores
            </button>
          )}
          {canHireStaff && (
            <button onClick={onHireStaff} className="px-4 py-2 bg-[#A46832] text-white rounded-full text-2xs tracking-wider uppercase font-black flex items-center gap-1 shadow-xs cursor-pointer">
              <UserPlus className="h-3 w-3" /> Hire Staff
            </button>
          )}
          {canCreateProduct && (
            <button onClick={onCreateProduct} className="px-4 py-2 bg-[#2E2A26] text-white rounded-full text-2xs tracking-wider uppercase font-black flex items-center gap-1 cursor-pointer">
              <Plus className="h-3.5 w-3.5" /> New Product
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map((card, index) => (
          <div key={card.label} className={`p-5 bg-white ${index % 2 === 0 ? 'mp-blob-r' : 'mp-blob-l'} border border-[#EBDECE] flex justify-between items-start mp-shadow ${card.color}`}>
            <div className="space-y-1.5">
              <span className="text-xs text-[#A5642B]/70 uppercase font-mono">{card.label}</span>
              <p className="font-display font-black text-2xl text-[#2E2A26] leading-none">{card.count}</p>
              <p className="text-[11px] text-[#2E2A26]/60 font-medium leading-snug">{card.desc}</p>
            </div>
            <card.icon className="h-5 w-5 text-[#A46832] opacity-60" />
          </div>
        ))}
      </div>

      {openingSetupItems.some((item) => !item.done) && (
        <section aria-labelledby="opening-setup-heading" className="bg-white border border-[#EBDECE] rounded-3xl p-5 space-y-4 mp-shadow">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 id="opening-setup-heading" className="font-display font-black text-lg text-[#2E2A26]">Opening setup</h2>
              <p className="text-xs text-[#2E2A26]/65">Complete the customer-facing basics first. Everything else can be added later.</p>
            </div>
            {canOpenSettings && (
              <button onClick={() => onNavigate('settings')} className="min-h-11 px-4 rounded-full border border-[#A46832] text-[#8F5322] text-xs font-black uppercase tracking-wider inline-flex items-center justify-center gap-1 cursor-pointer hover:bg-[#F7EFE6]">
                Review launch readiness <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {openingSetupItems.map((item) => (
              <button key={item.label} onClick={() => onNavigate(item.tab)} className="min-h-24 text-left p-4 rounded-2xl border border-[#EBDECE] hover:border-[#A46832] hover:bg-[#FBF7F1] transition-colors cursor-pointer">
                <span className={`inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider ${item.done ? 'text-emerald-700' : 'text-[#A46832]'}`}>
                  {item.done ? <ShieldCheck className="h-3.5 w-3.5" /> : <ArrowRight className="h-3.5 w-3.5" />}
                  {item.done ? 'Completed' : 'Set up'}
                </span>
                <span className="block mt-2 text-xs font-black text-[#2E2A26]">{item.label}</span>
                <span className="block mt-1 text-[11px] text-[#2E2A26]/60 leading-relaxed">{item.detail}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {alerts.length > 0 && (
        <div className="p-4 bg-[#F7EFE6] border border-[#A46832]/30 mp-blob-b space-y-2">
          <div className="flex items-center gap-1.5 text-2xs font-bold text-[#A5642B]">
            <AlertTriangle className="h-4 w-4 text-[#A46832]" />
            <span>HQ System Notifications - Attention Required</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-2xs">
            {alerts.map((alert) => (
              <div key={alert.id} className="p-2.5 bg-white rounded-xl rounded-tl-sm border border-[#EBDECE] flex justify-between items-center text-[#2E2A26]">
                <span className="font-medium">{alert.msg}</span>
                <span className="text-[11px] text-[#A5642B] font-mono">{alert.date}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <section id="system-status" tabIndex={-1} aria-labelledby="system-status-heading" className="space-y-3 scroll-mt-6 outline-none focus-visible:ring-2 focus-visible:ring-[#A46832] focus-visible:ring-offset-4 rounded-2xl">
        <div>
          <h2 id="system-status-heading" className="font-display font-black text-lg text-[#2E2A26]">System status</h2>
          <p className="text-xs text-[#2E2A26]/65">Live operational and notification checks. Unknown is shown honestly when a service has not been commissioned.</p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <OpsHealthPanel releaseVersion={releaseVersion} />
          <NotificationHealthPanel />
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {canViewAuditFeed && (
          <div className="lg:col-span-7 bg-white rounded-2xl border border-[#EBDECE]/50 p-5 space-y-4">
            <div className="flex justify-between items-center pb-2 border-b">
              <h3 className="font-display font-black text-xs uppercase tracking-wider">Live System Logs</h3>
              <button onClick={() => onNavigate('audit')} className="text-xs text-[#A46832] font-black cursor-pointer uppercase hover:underline">Full Trail →</button>
            </div>
            <div className="space-y-3">
              {auditLogs.slice(0, 4).map((log) => (
                <div key={log.id} className="flex items-start gap-3 p-3 bg-stone-50 rounded-xl text-2xs leading-normal">
                  <div className="h-7 w-7 rounded-lg bg-dashed border border-zinc-300 flex items-center justify-center font-bold">💼</div>
                  <div className="flex-1">
                    <p className="text-[11px] text-zinc-500 font-mono">{new Date(log.timestamp).toLocaleTimeString()}</p>
                    <p className="text-[#2E2A26]"><b>{log.operatorName}</b> ({log.role}) {log.action} inside <b>{log.module}</b></p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={`${canViewAuditFeed ? 'lg:col-span-5' : 'lg:col-span-12'} bg-white rounded-2xl border border-[#EBDECE]/50 p-5 space-y-4`}>
          <h3 className="font-display font-black text-xs uppercase tracking-wider pb-2 border-b">Quick Admin Actions</h3>
          <div className="grid grid-cols-2 gap-3 text-2xs">
            {quickActions.map((action) => (
              <button key={action.tab} onClick={() => onNavigate(action.tab)} className="p-3.5 bg-[#EBDECE]/25 border border-[#EBDECE] rounded-xl hover:bg-[#A46832]/10 hover:border-[#A46832]/40 text-center space-y-2 cursor-pointer text-[#2E2A26]">
                <action.icon className="h-5 w-5 mx-auto text-[#A46832]" />
                <span className="block font-bold">{action.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});
