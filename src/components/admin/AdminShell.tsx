import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { EmployeeProfile, MenuItem, StoreLocation, StaffDocument, SIFRReport } from '../../types';
import type { SiteContent } from '../../siteContent';
import type { AdminNavigationSection } from './adminNavigation';
import { routeToPath, handleAnchorNav } from '../../lib/router';
import { LogoIcon, DripEdge, BRAND } from '../../brand';

const ADVANCED_ADMIN_SECTIONS = new Set(['analytics', 'till', 'settings', 'permissions', 'audit', 'legacy-import']);

interface AdminShellProps {
  employee: EmployeeProfile | null;
  staffDataStatus: 'idle' | 'loading' | 'live' | 'error';
  onRetryHydration: () => void;
  sections: AdminNavigationSection[];
  activeTab: string;
  onNavigate: (id: string) => void;
  onSetCurrentTab: (tab: string) => void;
  canOpenSection: (id: string) => boolean;
  siteContent: SiteContent;
  employees: EmployeeProfile[];
  menuItems: MenuItem[];
  stores: StoreLocation[];
  documents: StaffDocument[];
  incidents: SIFRReport[];
  currencySymbol: string;
  children: React.ReactNode;
}

/**
 * Admin chrome owns presentation-only state (sidebar disclosure and secure
 * search). Typing into search or collapsing navigation therefore cannot
 * rerender the 4k-line workflow controller or any unrelated editor state.
 */
export const AdminShell = React.memo(function AdminShell({
  employee,
  staffDataStatus,
  onRetryHydration,
  sections,
  activeTab,
  onNavigate,
  onSetCurrentTab,
  canOpenSection,
  siteContent,
  employees,
  menuItems,
  stores,
  documents,
  incidents,
  currencySymbol,
  children,
}: AdminShellProps) {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(() => ADVANCED_ADMIN_SECTIONS.has(activeTab));
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (ADVANCED_ADMIN_SECTIONS.has(activeTab)) setAdvancedOpen(true);
  }, [activeTab]);

  const siteContentSearchText = useMemo(() => JSON.stringify(siteContent).toLowerCase(), [siteContent]);
  const results = useMemo(() => {
    const normalised = query.trim().toLowerCase();
    if (!normalised) return {
      website: false,
      employees: [] as EmployeeProfile[],
      menu: [] as MenuItem[],
      stores: [] as StoreLocation[],
      documents: [] as StaffDocument[],
      incidents: [] as SIFRReport[],
      count: 0,
    };

    const website = canOpenSection('cms') && siteContentSearchText.includes(normalised);
    const employeeMatches = canOpenSection('staff')
      ? employees.filter((item) => item.name.toLowerCase().includes(normalised) || item.role.toLowerCase().includes(normalised))
      : [];
    const menuMatches = canOpenSection('menu')
      ? menuItems.filter((item) => item.name.toLowerCase().includes(normalised) || item.category.toLowerCase().includes(normalised))
      : [];
    const storeMatches = canOpenSection('stores')
      ? stores.filter((item) => item.name.toLowerCase().includes(normalised) || item.address.toLowerCase().includes(normalised) || item.postcode.toLowerCase().includes(normalised))
      : [];
    const documentMatches = canOpenSection('docs')
      ? documents.filter((item) => item.name.toLowerCase().includes(normalised))
      : [];
    const incidentMatches = canOpenSection('sifr')
      ? incidents.filter((item) => item.title.toLowerCase().includes(normalised) || item.involvedPeople.toLowerCase().includes(normalised))
      : [];

    return {
      website,
      employees: employeeMatches,
      menu: menuMatches,
      stores: storeMatches,
      documents: documentMatches,
      incidents: incidentMatches,
      count: Number(website) + employeeMatches.length + menuMatches.length + storeMatches.length + documentMatches.length + incidentMatches.length,
    };
  }, [query, canOpenSection, siteContentSearchText, employees, menuItems, stores, documents, incidents]);

  const openResult = (tab: string) => {
    onNavigate(tab);
    setQuery('');
  };

  return (
    <div id="admin-root-container" className="mp-admin-shell flex flex-col h-screen overflow-hidden bg-[#F7EFE6] text-[#2E2A26]">
      {staffDataStatus === 'error' && (
        <div className="bg-amber-50 border-b border-[#A46832] px-6 py-2 flex items-center justify-between gap-3 text-2xs font-bold text-[#A5642B] shrink-0">
          <span>Some internal data could not be loaded from the database — records shown may be incomplete. Nothing was lost on the server.</span>
          <button onClick={onRetryHydration} className="px-3 py-1.5 bg-[#A46832] text-white rounded-full uppercase font-black tracking-wider cursor-pointer hover:bg-[#A5642B]">Retry</button>
        </div>
      )}
      {staffDataStatus === 'loading' && (
        <div className="bg-[#7CC0C7]/10 border-b border-[#7CC0C7]/50 px-6 py-1.5 text-2xs font-bold text-[#2E2A26]/70 shrink-0">
          Loading internal records from the database…
        </div>
      )}

      <header className="bg-white px-6 pt-4 pb-2 flex flex-col gap-4 shrink-0 relative z-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <LogoIcon className="h-10 w-auto shrink-0" title="Milk Pop admin" />
            <div>
              <h1 className="font-display font-black text-lg text-[#2E2A26] uppercase tracking-wider leading-tight">Admin Control Panel</h1>
              <p className="text-xs text-[#A5642B]/80 font-black">Milk Pop Operations — owner and team portal</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="relative max-w-sm hidden md:block">
              <input
                id="global-admin-search"
                type="search"
                placeholder="Secure search..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="w-64 bg-stone-50 border border-[#EBDECE] text-2xs px-4 py-2 rounded-full focus:outline-none focus:ring-1 focus:ring-[#A46832]"
              />
            </div>

            <div className="flex items-center space-x-3 bg-[#EBDECE]/40 p-1.5 rounded-full pl-3">
              <div className="flex-col text-right hidden xl:flex">
                <span className="text-2xs font-extrabold text-[#2E2A26] whitespace-nowrap">{employee?.name || 'Administrator'}</span>
                <span className="text-[11px] text-[#A46832] font-black uppercase tracking-wider">{employee?.role ? employee.role.replace('_', ' ').toUpperCase() : '—'}</span>
              </div>
              <button onClick={() => onSetCurrentTab('staff_dashboard')} className="px-4 py-1.5 bg-[#7CC0C7] text-[#2E2A26] hover:bg-[#5FA9B1] rounded-full text-xs uppercase font-bold transition-all cursor-pointer whitespace-nowrap">
                Staff dashboard
              </button>
              <button onClick={() => onSetCurrentTab('home')} className="px-4 py-1.5 bg-[#2E2A26] text-white hover:bg-[#A46832]/90 rounded-full text-xs uppercase font-bold transition-all cursor-pointer whitespace-nowrap">
                Return to the customer view
              </button>
            </div>
          </div>
        </div>

        <div className="flex lg:hidden overflow-x-auto custom-scrollbar pb-2 gap-2 mt-2">
          {sections.flatMap((section) => section.items.map((item) => {
            const Icon = item.icon;
            const selected = activeTab === item.id;
            return (
              <a
                key={item.id}
                href={routeToPath('admin_panel', { section: item.id })}
                aria-current={selected ? 'page' : undefined}
                onClick={(event) => handleAnchorNav(event, () => onNavigate(item.id))}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs font-semibold tracking-wide transition-all cursor-pointer whitespace-nowrap shrink-0 ${selected ? 'bg-[#A46832] text-white shadow-xs font-black mp-blob-l' : 'text-[#2E2A26] rounded-full hover:bg-[#F7EFE6] hover:text-[#A46832]'}`}
              >
                <Icon className={`h-3.5 w-3.5 ${selected ? 'text-white' : 'text-[#A5642B]'}`} />
                {item.label}
                {item.badge ? <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-black ml-1 mp-tilt-r inline-block ${selected ? 'bg-white text-[#A5642B]' : 'bg-[#A46832]/15 text-[#A5642B]'}`}>{item.badge}</span> : null}
              </a>
            );
          }))}
        </div>
      </header>

      <div className="shrink-0 relative z-10 -mb-3 pointer-events-none">
        <DripEdge color="#FFFFFF" className="h-4" />
      </div>

      <div className="flex-1 flex min-h-0 relative">
        <aside className={`hidden lg:flex flex-col shrink-0 bg-white/70 border-r border-[#EBDECE] transition-all duration-300 ${isSidebarCollapsed ? 'w-[72px]' : 'w-60'}`}>
          <div className="flex-1 overflow-y-auto custom-scrollbar py-4 px-3 space-y-5">
            {sections.map((section) => (
              <div key={section.group}>
                {!isSidebarCollapsed && section.group === 'Advanced' ? (
                  <button type="button" onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen} className="w-full min-h-11 px-2.5 flex items-center justify-between text-[9px] font-black uppercase tracking-widest text-[#A5642B]/70">
                    <span>Advanced</span><ChevronRight className={`h-3.5 w-3.5 transition-transform ${advancedOpen ? 'rotate-90' : ''}`} />
                  </button>
                ) : !isSidebarCollapsed ? (
                  <p className="px-2.5 pb-1.5 text-[9px] font-black uppercase tracking-widest text-[#A5642B]/60">{section.group}</p>
                ) : null}
                <div className={`space-y-0.5 ${section.group === 'Advanced' && !isSidebarCollapsed && !advancedOpen ? 'hidden' : ''}`}>
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    const selected = activeTab === item.id;
                    return (
                      <a
                        key={item.id}
                        href={routeToPath('admin_panel', { section: item.id })}
                        aria-current={selected ? 'page' : undefined}
                        onClick={(event) => handleAnchorNav(event, () => onNavigate(item.id))}
                        title={isSidebarCollapsed ? item.label : undefined}
                        className={`w-full flex items-center gap-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer ${isSidebarCollapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2 text-left'} ${selected ? 'bg-[#A46832] text-white shadow-xs font-black' : 'text-[#2E2A26] hover:bg-[#F7EFE6] hover:text-[#A46832]'}`}
                      >
                        <span className="relative shrink-0">
                          <Icon className={`h-4 w-4 ${selected ? 'text-white' : 'text-[#A5642B]'}`} />
                          {isSidebarCollapsed && item.badge ? <span className="absolute -top-1.5 -right-2 h-3.5 min-w-3.5 px-0.5 rounded-full bg-[#A46832] text-white text-[8px] font-black flex items-center justify-center border border-white">{item.badge}</span> : null}
                        </span>
                        {!isSidebarCollapsed && (
                          <>
                            <span className="flex-1 truncate">{item.label}</span>
                            {item.badge ? <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-black ${selected ? 'bg-white text-[#A5642B]' : 'bg-[#A46832]/15 text-[#A5642B]'}`}>{item.badge}</span> : null}
                          </>
                        )}
                      </a>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <button onClick={() => setIsSidebarCollapsed((collapsed) => !collapsed)} title={isSidebarCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} className="shrink-0 m-3 py-2 rounded-xl bg-[#F7EFE6] hover:bg-[#EBDECE] text-[#A5642B] flex items-center justify-center gap-1.5 text-xs font-black uppercase tracking-wider cursor-pointer">
            {isSidebarCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <><ChevronLeft className="h-3.5 w-3.5" /> Collapse</>}
          </button>
        </aside>

        <main id="admin-workspace-right" className="flex-1 flex flex-col min-w-0 h-full overflow-hidden relative">
          <div className="pointer-events-none select-none absolute -bottom-16 -right-10 opacity-[0.05] rotate-[-8deg] z-0" aria-hidden="true">
            <LogoIcon className="w-[26rem] h-auto" color={BRAND.caramel} />
          </div>

          {query ? (
            <div className="bg-white border-b border-[#EBDECE] p-4 flex flex-col overflow-y-auto max-h-48 shadow-lg shrink-0">
              <div className="flex items-center justify-between border-b pb-2 mb-2 text-xs font-mono text-zinc-500 uppercase">
                <span>Matching index metrics ({results.count} items)</span>
                <button onClick={() => setQuery('')} className="p-1 text-red-500 hover:bg-red-50 rounded">Clear</button>
              </div>
              <div className="space-y-1 text-2xs">
                {results.website && <button type="button" onClick={() => openResult('cms')} className="w-full p-1 px-3 hover:bg-amber-50 rounded cursor-pointer flex justify-between text-left"><span>🌐 Website copy contains “<b>{query}</b>” — edit it in the Studio</span><span className="text-[#A46832]">Open Website Studio →</span></button>}
                {results.employees.map((item) => <button type="button" key={item.id} onClick={() => openResult('staff')} className="w-full p-1 px-3 hover:bg-amber-50 rounded cursor-pointer flex justify-between text-left"><span>👤 Employee: <b>{item.name}</b> ({item.role})</span><span className="text-[#A46832]">Open Directory →</span></button>)}
                {results.menu.map((item) => <button type="button" key={item.id} onClick={() => openResult('menu')} className="w-full p-1 px-3 hover:bg-amber-50 rounded cursor-pointer flex justify-between text-left"><span>🥤 Menu: <b>{item.name}</b> ({item.category} - {currencySymbol}{item.price})</span><span className="text-[#A46832]">Open Menu →</span></button>)}
                {results.stores.map((item) => <button type="button" key={item.id} onClick={() => openResult('stores')} className="w-full p-1 px-3 hover:bg-amber-50 rounded cursor-pointer flex justify-between text-left"><span>🏪 Store: <b>{item.name}</b> ({item.postcode})</span><span className="text-[#A46832]">Open Stores →</span></button>)}
                {results.documents.map((item) => <button type="button" key={item.id} onClick={() => openResult('docs')} className="w-full p-1 px-3 hover:bg-amber-50 rounded cursor-pointer flex justify-between text-left"><span>📄 Document: <b>{item.name}</b></span><span className="text-[#A46832]">Open Documents →</span></button>)}
                {results.incidents.map((item) => <button type="button" key={item.id} onClick={() => openResult('sifr')} className="w-full p-1 px-3 hover:bg-amber-50 rounded cursor-pointer flex justify-between text-left"><span>⚠️ Incident: <b>{item.title}</b></span><span className="text-[#A46832]">Open Incidents →</span></button>)}
                {results.count === 0 && <div className="p-2 px-3 text-stone-400 font-mono">No accessible records match this search.</div>}
              </div>
            </div>
          ) : null}

          <div className="flex-1 overflow-y-auto p-6 pt-8 space-y-6 relative z-[1]">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
});
