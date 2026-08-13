import React, { useState, useEffect } from 'react';
import { Menu as MenuIcon, X, LogIn, LayoutDashboard } from 'lucide-react';
import { EmployeeProfile, SiteSettings } from '../types';
import { SiteContent } from '../siteContent';
import { LogoHorizontal, LogoIcon } from '../brand';
import { routeToPath, handleAnchorNav } from '../lib/router';

interface NavbarProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  employee: EmployeeProfile | null;
  onLogout: () => void;
  isStaffMode: boolean;
  setIsStaffMode: (val: boolean) => void;
  /** Owner-editable labels for the public navigation (Website Studio). */
  content: SiteContent;
  settings: SiteSettings;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  setCurrentTab,
  employee,
  onLogout,
  isStaffMode,
  setIsStaffMode,
  content,
  settings,
}) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Translate tab keys to user friendly names
  const handleTabClick = (tabKey: string) => {
    if (!tabKey.startsWith('staff_')) {
      setIsStaffMode(false);
    }
    setCurrentTab(tabKey);
    setMobileMenuOpen(false);
  };

  // Labels are owner-editable in Website Studio -> Navigation labels.
  const customerNavItems = [
    { key: 'home', label: content.nav.home, visible: true },
    { key: 'menu', label: content.nav.menu, visible: true },
    { key: 'stores', label: content.nav.stores, visible: true },
    { key: 'careers', label: content.nav.careers, visible: settings.showCareers },
    { key: 'franchise', label: content.nav.franchise, visible: settings.showFranchise },
    { key: 'news', label: content.nav.news, visible: settings.showNews },
    { key: 'about', label: content.nav.about, visible: true },
    { key: 'contact', label: content.nav.contact, visible: true },
  ].filter((item) => item.visible);

  const staffNavItems = [
    { key: 'staff_dashboard', label: 'Dashboard' },
    { key: 'staff_documents', label: 'Documents' },
    { key: 'staff_checklists', label: 'Checklists' },
    { key: 'staff_academy', label: 'Academy' },
    { key: 'staff_sifr', label: 'SIFR' },
    { key: 'staff_kb', label: 'Library' },
  ];

  const navItems = isStaffMode && employee ? staffNavItems : customerNavItems;

  /* LAUNCH POLISH: Escape closes the mobile menu and returns focus to the
     control that opened it. Without this a keyboard or screen-reader user who
     opened the menu had no way out except tabbing through every link. */
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMobileMenuOpen(false);
      document.getElementById('mobile-menu-hamburger')?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileMenuOpen]);

  return (
    <header className="sticky top-0 z-50 w-full mp-glass border-b border-[#EBDECE]/50 shadow-[0_1px_12px_rgba(46,42,38,0.05)]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-20">
          {/* Logo Brand area */}
          {/* LAUNCH POLISH: the link's only content is an SVG lock-up, so it
              carried NO accessible name — a screen reader announced a bare
              "link". `focus:outline-none` also removed the focus ring without
              replacing it, leaving keyboard users with no visible position. */}
          <a
            id="brand-logo-btn"
            href={routeToPath('home')}
            aria-label="Milk Pop — home"
            onClick={(e) => handleAnchorNav(e, () => handleTabClick('home'))}
            className="flex items-center space-x-2 focus:outline-none focus:ring-2 focus:ring-[#A46832] focus:ring-offset-2 rounded-lg cursor-pointer group text-left shrink-0"
          >
            {/* Official horizontal logo — the brandbook's recommended lock-up for site headers */}
            <LogoIcon className="h-9 w-auto sm:hidden group-hover:scale-105 transition-transform" title="Milk Pop" />
            <LogoHorizontal className="hidden sm:block h-9 w-auto group-hover:scale-[1.03] transition-transform" title="Milk Pop — home" />
          </a>

          {/* Desktop Navigation */}
          <nav className="hidden lg:flex items-center space-x-1" aria-label="Desktop navigation">
            {navItems.map((item) => (
              <a
                id={`nav-${item.key}`}
                key={item.key}
                href={routeToPath(item.key)}
                aria-current={currentTab === item.key ? 'page' : undefined}
                onClick={(e) => handleAnchorNav(e, () => handleTabClick(item.key))}
                className={`px-3 py-2 rounded-full text-xs font-semibold tracking-wide transition-all cursor-pointer whitespace-nowrap ${
                  currentTab === item.key
                    ? 'bg-[#A46832] text-white shadow-sm'
                    : 'text-[#2E2A26] hover:bg-[#EBDECE]/50 hover:text-[#A46832]'
                }`}
              >
                {item.label}
              </a>
            ))}
          </nav>

          {/* Quick Action Controls */}
          <div className="hidden lg:flex items-center space-x-3 shrink-0">
            {employee ? (
              <div className="flex items-center space-x-2 bg-[#EBDECE]/40 p-1.5 rounded-full pl-3">
                <div className="flex flex-col text-right hidden xl:flex">
                  <span className="text-2xs font-extrabold text-[#2E2A26] whitespace-nowrap">
                    {employee.name}
                  </span>
                  <span className="text-[9px] text-[#A46832] font-black uppercase tracking-wider">
                    {employee.role.replace('_', ' ')}
                  </span>
                </div>
                {isStaffMode ? (
                  <a
                    id="return-customer-btn"
                    href={routeToPath('home')}
                    onClick={(e) => handleAnchorNav(e, () => {
                      setIsStaffMode(false);
                      handleTabClick('home');
                    })}
                    className="px-3 py-1.5 bg-white text-[#2E2A26] hover:bg-[#EBDECE] rounded-full text-[10px] uppercase font-bold transition-all cursor-pointer whitespace-nowrap"
                  >
                    Customer View
                  </a>
                ) : (
                  <a
                    id="dashboard-goto-btn"
                    href={routeToPath('staff_dashboard')}
                    onClick={(e) => handleAnchorNav(e, () => {
                      setIsStaffMode(true);
                      handleTabClick('staff_dashboard');
                    })}
                    className="p-2 rounded-full transition-all cursor-pointer bg-white hover:bg-[#A46832]/10 text-[#2E2A26] inline-flex"
                    title="Employee Hub Dashboard"
                  >
                    <LayoutDashboard className="h-4 w-4" />
                  </a>
                )}
                <button
                  id="nav-logout-btn"
                  onClick={onLogout}
                  className="px-3 py-1.5 bg-[#2E2A26] text-white rounded-full text-[10px] uppercase font-bold hover:bg-[#A46832]/90 transition-all cursor-pointer whitespace-nowrap"
                >
                  Log Out
                </button>
              </div>
            ) : (
              <a
                id="staff-login-btn"
                href={routeToPath('staff_login')}
                onClick={(e) => handleAnchorNav(e, () => {
                  setIsStaffMode(true);
                  handleTabClick('staff_login');
                })}
                className="flex items-center space-x-1.5 px-4 py-2.5 bg-[#2E2A26] hover:bg-[#A46832]/90 text-white rounded-full text-2xs uppercase tracking-wider font-extrabold shadow-sm transition-all cursor-pointer"
              >
                <LogIn className="h-3.5 w-3.5" />
                <span>Staff Portal</span>
              </a>
            )}
          </div>

          {/* Mobile Menu Action Icon */}
          <div className="flex items-center lg:hidden space-x-2">
            {employee && (
              <a
                id="mob-hub-toggle"
                href={routeToPath('staff_dashboard')}
                onClick={(e) => handleAnchorNav(e, () => {
                  setIsStaffMode(true);
                  handleTabClick('staff_dashboard');
                })}
                className={`p-2 rounded-full cursor-pointer inline-flex ${
                  isStaffMode ? 'bg-[#A46832] text-white' : 'bg-[#EBDECE]/50 text-[#2E2A26]'
                }`}
                title="Employee Hub"
              >
                <LayoutDashboard className="h-4 w-4" />
              </a>
            )}
            {/* LAUNCH POLISH: aria-expanded/aria-controls tell assistive tech
                whether the menu is open and what it controls; the focus ring
                restores the indicator `focus:outline-none` had removed. */}
            <button
              id="mobile-menu-hamburger"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="p-2.5 rounded-full text-[#2E2A26] bg-[#EBDECE]/30 hover:bg-[#EBDECE]/60 transition-all focus:outline-none focus:ring-2 focus:ring-[#A46832] cursor-pointer"
              aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-nav-panel"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <MenuIcon className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Slide-Out Side Drawer Menu */}
      {mobileMenuOpen && (
        <nav id="mobile-nav-panel" aria-label="Mobile navigation" className="lg:hidden absolute top-20 left-0 w-full bg-[#FFFFFF] border-b border-[#EBDECE] shadow-xl py-5 px-4 transition-all duration-300">
          <div className="flex flex-col space-y-2">
            <span className="text-[9px] uppercase tracking-widest text-[#A46832] font-black px-3">
              {isStaffMode ? 'Staff Actions' : 'Explore Milk Pop'}
            </span>
            {navItems.map((item) => (
              <a
                id={`mob-nav-${item.key}`}
                key={item.key}
                href={routeToPath(item.key)}
                aria-current={currentTab === item.key ? 'page' : undefined}
                onClick={(e) => handleAnchorNav(e, () => handleTabClick(item.key))}
                className={`block w-full text-left px-4 py-3 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  currentTab === item.key
                    ? 'bg-[#A46832] text-white'
                    : 'text-[#2E2A26] hover:bg-[#EBDECE]/30'
                }`}
              >
                {item.label}
              </a>
            ))}

            <div className="border-t border-[#EBDECE] pt-4 mt-2">
              {employee ? (
                <div className="flex flex-col space-y-3 px-2">
                  <div className="flex items-center space-x-2">
                    <div className="h-9 w-9 rounded-full bg-[#A46832] text-white font-bold flex items-center justify-center">
                      {employee.name[0]}
                    </div>
                    <div>
                      <h4 className="text-xs font-extrabold text-[#2E2A26]">{employee.name}</h4>
                      <p className="text-[10px] text-[#A46832] font-bold uppercase">
                        {employee.role.replace('_', ' ')}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {isStaffMode ? (
                      <a
                        id="mob-return-customer-btn"
                        href={routeToPath('home')}
                        onClick={(e) => handleAnchorNav(e, () => {
                          setIsStaffMode(false);
                          handleTabClick('home');
                        })}
                        className="py-2.5 text-center bg-white border border-[#EBDECE] text-[#2E2A26] rounded-xl text-2xs uppercase tracking-wider font-extrabold"
                      >
                        Customer View
                      </a>
                    ) : (
                      <a
                        id="mob-hub-btn"
                        href={routeToPath('staff_dashboard')}
                        onClick={(e) => handleAnchorNav(e, () => {
                          setIsStaffMode(true);
                          handleTabClick('staff_dashboard');
                        })}
                        className="py-2.5 text-center bg-[#EBDECE]/60 text-[#2E2A26] rounded-xl text-2xs uppercase tracking-wider font-extrabold"
                      >
                        Dashboard
                      </a>
                    )}
                    <button
                      id="mob-logout-btn"
                      onClick={() => {
                        onLogout();
                        setMobileMenuOpen(false);
                      }}
                      className="py-2.5 text-center bg-red-100 text-red-700 rounded-xl text-2xs uppercase tracking-wider font-extrabold"
                    >
                      Log Out
                    </button>
                  </div>
                </div>
              ) : (
                <a
                  id="mob-login-btn"
                  href={routeToPath('staff_login')}
                  onClick={(e) => handleAnchorNav(e, () => {
                    setIsStaffMode(true);
                    handleTabClick('staff_login');
                  })}
                  className="w-full flex items-center justify-center space-x-2 py-3 bg-[#2E2A26] hover:bg-[#A46832] text-white rounded-xl text-xs font-bold tracking-wider uppercase shadow-sm cursor-pointer"
                >
                  <LogIn className="h-4 w-4" />
                  <span>Employee Portal Login</span>
                </a>
              )}
            </div>
          </div>
        </nav>
      )}
    </header>
  );
};
