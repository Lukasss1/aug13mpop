import { safeExternalHref, safeMailtoHref, safeTelHref } from '../lib/safeUrl';
import React from 'react';
import { Mail, Phone, MapPin, Instagram, Facebook, Twitter } from 'lucide-react';
import { BRAND, LogoVertical, DripEdge, WaveEdge, STICKERS } from '../brand';
import { SiteSettings } from '../types';
import { SiteContent } from '../siteContent';
import { routeToPath, handleAnchorNav } from '../lib/router';
import { normalizeWebsite } from '../lib/publicContentSnapshot';

interface FooterProps {
  setCurrentTab: (tab: string) => void;
  setIsStaffMode: (val: boolean) => void;
  settings: SiteSettings;
  /** Owner-editable footer headings + navigation labels (Website Studio). */
  content: SiteContent;
}

/**
 * Footer styled after the brandbook packaging system: a caramel field with the
 * white milk-drip edge above it, the white vertical logo (the brandbook's rule
 * for dark backgrounds) and the blue wave closing the page like the cup base.
 */
export const Footer: React.FC<FooterProps> = ({ setCurrentTab, setIsStaffMode, settings, content }) => {
  const phoneHref = safeTelHref(settings.phone);
  const emailHref = safeMailtoHref(settings.email);
  const hasContactDetails = Boolean(settings.hqAddress || phoneHref || emailHref);
  const legalDisplayName = settings.legalName || settings.brandName || 'Milk Pop';
  const websiteDisplay = normalizeWebsite(settings.websiteUrl);

  const handleNav = (tab: string, isHub = false) => {
    setIsStaffMode(isHub);
    setCurrentTab(tab);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /** Footer navigation link: a real <a href> (crawlable, open-in-new-tab
   *  friendly) that upgrades plain left clicks to instant SPA navigation. */
  const NavLink: React.FC<{ tab: string; isHub?: boolean; className?: string; children: React.ReactNode; ariaLabel?: string }> =
    ({ tab, isHub = false, className, children, ariaLabel }) => (
      <a
        href={routeToPath(tab)}
        aria-label={ariaLabel}
        onClick={(e) => handleAnchorNav(e, () => handleNav(tab, isHub))}
        className={className}
      >
        {children}
      </a>
    );

  return (
    <footer className="relative bg-[#A46832] text-white overflow-hidden">
      {/* White milk drips flowing from the page above into the caramel field */}
      <DripEdge color="#FFFFFF" className="h-14 sm:h-20" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10 pt-10 pb-14">
        <div className={`grid grid-cols-1 md:grid-cols-2 ${hasContactDetails ? 'lg:grid-cols-4' : 'lg:grid-cols-3'} gap-12 mb-12`}>
          {/* Brand block — white logo per the brandbook dark-background rule */}
          <div className="space-y-5">
            <NavLink tab="home" className="cursor-pointer inline-block" ariaLabel="Milk Pop home">
              <LogoVertical color="#FFFFFF" className="h-24 w-auto" title="Milk Pop" />
            </NavLink>
            <p className="text-xs text-white leading-relaxed font-light max-w-xs">
              {settings.footerTagline}
            </p>
            <div className="flex items-center space-x-3 pt-1">
              {/* WP-03: editable values become hrefs ONLY via safeExternalHref —
                  an unsafe scheme renders no anchor at all. */}
              {safeExternalHref(settings.instagramUrl) && (
                <a href={safeExternalHref(settings.instagramUrl)} target="_blank" rel="noopener noreferrer" aria-label="Instagram" className="p-3 min-h-11 min-w-11 inline-flex items-center justify-center bg-white/15 hover:bg-white hover:text-[#A46832] rounded-full transition-all text-white">
                  <Instagram className="h-4 w-4" />
                </a>
              )}
              {safeExternalHref(settings.facebookUrl) && (
                <a href={safeExternalHref(settings.facebookUrl)} target="_blank" rel="noopener noreferrer" aria-label="Facebook" className="p-3 min-h-11 min-w-11 inline-flex items-center justify-center bg-white/15 hover:bg-white hover:text-[#A46832] rounded-full transition-all text-white">
                  <Facebook className="h-4 w-4" />
                </a>
              )}
              {safeExternalHref(settings.twitterUrl) && (
                <a href={safeExternalHref(settings.twitterUrl)} target="_blank" rel="noopener noreferrer" aria-label="Twitter / X" className="p-3 min-h-11 min-w-11 inline-flex items-center justify-center bg-white/15 hover:bg-white hover:text-[#A46832] rounded-full transition-all text-white">
                  <Twitter className="h-4 w-4" />
                </a>
              )}
            </div>
            {/* LAUNCH POLISH: the footer sits on the caramel #A46832, so white
                at 70% measures 3.10:1 for 10px text — below the 4.5:1 AA
                minimum. Full white measures 4.56:1. Opacity only; no colour
                or layout change. */}
            {(websiteDisplay || settings.instagramHandle) && (
              <p className="text-[10px] uppercase tracking-[0.2em] text-white font-bold">
                {websiteDisplay}{websiteDisplay && settings.instagramHandle ? ` \u00A0|\u00A0 ` : ''}{settings.instagramHandle}
              </p>
            )}
          </div>

          {/* Explore links */}
          <div className="space-y-4">
            <h2 className="text-2xs uppercase tracking-widest font-black text-white">{content.footer.exploreHeading}</h2>
            <ul className="space-y-2 text-xs font-light">
              <li><NavLink tab="menu" className="mp-footer-link text-white hover:text-white hover:underline transition-colors cursor-pointer">The Drink & Dessert Menu</NavLink></li>
              <li><NavLink tab="stores" className="mp-footer-link text-white hover:text-white hover:underline transition-colors cursor-pointer">Our Store Locations</NavLink></li>
              {settings.showCareers && <li><NavLink tab="careers" className="mp-footer-link text-white hover:text-white hover:underline transition-colors cursor-pointer">Careers & Job Vacancies</NavLink></li>}
              {settings.showFranchise && <li><NavLink tab="franchise" className="mp-footer-link text-white hover:text-white hover:underline transition-colors cursor-pointer">Franchise Opportunities</NavLink></li>}
              <li><NavLink tab="staff_login" isHub className="mp-footer-link text-white hover:text-white hover:underline transition-colors cursor-pointer">Staff Portal Login</NavLink></li>
            </ul>
          </div>

          {/* Company links */}
          <div className="space-y-4">
            <h2 className="text-2xs uppercase tracking-widest font-black text-white">{content.footer.companyHeading}</h2>
            <ul className="space-y-2 text-xs font-light">
              <li><NavLink tab="about" className="mp-footer-link text-white hover:text-white hover:underline transition-colors cursor-pointer">Our Story & Mission</NavLink></li>
              <li><NavLink tab="contact" className="mp-footer-link text-white hover:text-white hover:underline transition-colors cursor-pointer">Contact Customer Care</NavLink></li>
              {settings.showNews && <li><NavLink tab="news" className="mp-footer-link text-white hover:text-white hover:underline transition-colors cursor-pointer">Company News & Press</NavLink></li>}
            </ul>
            <img src={STICKERS.bunny} alt="" aria-hidden="true" width={413} height={420} loading="lazy" decoding="async" className="w-16 opacity-90 mp-float" style={{ ['--mp-tilt' as any]: '-6deg' }} />
          </div>

          {/* Contact details are omitted cleanly until the owner enters them. */}
          {hasContactDetails && (
          <div className="space-y-4">
            <h2 className="text-2xs uppercase tracking-widest font-black text-white">{content.footer.contactHeading}</h2>
            <div className="space-y-3 text-xs text-white font-light">
              {settings.hqAddress && (
                <div className="flex items-start space-x-2">
                  <MapPin className="h-4 w-4 text-white shrink-0 mt-0.5" />
                  <span className="whitespace-pre-line">{settings.hqAddress}</span>
                </div>
              )}
              {phoneHref && (
                <div className="flex items-center space-x-2">
                  <Phone className="h-4 w-4 text-white" />
                  <a className="mp-footer-link text-white hover:underline" href={phoneHref}>{settings.phone}</a>
                </div>
              )}
              {emailHref && (
                <div className="flex items-center space-x-2">
                  <Mail className="h-4 w-4 text-white" />
                  <a className="mp-footer-link break-all text-white hover:underline" href={emailHref}>{settings.email}</a>
                </div>
              )}
            </div>
          </div>
          )}
        </div>

        {/* Legal fine-print */}
        {/* LAUNCH POLISH: 10px legal copy at white/75 measured 3.31:1. */}
        <div className="border-t border-white/25 pt-8 mt-4 text-center text-[10px] text-white space-y-4">
          {settings.allergenNotice && (
            <p className="max-w-3xl mx-auto leading-relaxed font-light">{settings.allergenNotice}</p>
          )}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-2xs pt-2">
            <span>© {new Date().getFullYear()} {legalDisplayName}. All Rights Reserved.{settings.companyNumber ? ` Co No: ${settings.companyNumber}.` : ''}</span>
            <div className="flex items-center space-x-3">
              <NavLink tab="privacy" className="hover:underline text-white cursor-pointer">Privacy Policy</NavLink>
              <span>•</span>
              <NavLink tab="gdpr" className="hover:underline text-white cursor-pointer">UK GDPR Consent Policy</NavLink>
              {settings.showFranchise && (
                <>
                  <span>•</span>
                  <NavLink tab="fdd" className="hover:underline text-white cursor-pointer">Franchise Information</NavLink>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Blue wave base — like the bottom band of the brandbook cup */}
      <WaveEdge color={BRAND.blue} className="h-10 sm:h-14" />
    </footer>
  );
};
