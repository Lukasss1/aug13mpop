#!/usr/bin/env node
/**
 * wp03-contract.test.mjs — STATIC checks for WP-03 (External URL safety and
 * production host contract). Offline; the deployed-header proof is
 * scripts/headers-smoke.live.mjs.
 */
import { readFileSync, existsSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log(`\u2714 ${n}`); };
const fail = (n, d) => { failed++; console.error(`\u2716 ${n}\n    ${d}`); };
const check = (n, cond, d = '') => (cond ? ok(n) : fail(n, d));
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

const SU = 'src/lib/safeUrl.ts';
const FT = 'src/components/Footer.tsx';
const PP = 'src/components/PublicPages.tsx';
const WS = 'src/components/admin/WebsiteStudio.tsx';

for (const f of [SU, FT, PP, WS, 'netlify.toml', 'docs/HOSTING.md', 'scripts/headers-smoke.live.mjs']) {
  check(`${f} exists`, existsSync(f), 'file missing');
}
const su = read(SU), ft = read(FT), pp = read(PP), ws = read(WS), nt = read('netlify.toml'), hd = read('public/_headers');

/* ---- 1. The boundary module ---------------------------------------------- */
check('safeExternalHref: https-only default via real URL parsing',
  /new URL\(value\.trim\(\)\)/.test(su) && /\['https:'\]/.test(su),
  'parser-based https allowlist missing');
check('safeExternalHref: failure returns undefined (render NOTHING)',
  /return undefined/.test(su) && !/return ''/.test(su),
  'unsafe values must render no anchor, not an empty href');
check('tel/mailto helpers exist with strict shapes',
  /safeTelHref/.test(su) && /safeMailtoHref/.test(su) && /\^\\\+\?\[0-9/.test(su),
  'context-specific helpers missing');

/* ---- 2. Render boundaries ------------------------------------------------ */
check('Footer: all three socials pass safeExternalHref (gate + href)',
  (ft.match(/safeExternalHref\(settings\.(instagram|facebook|twitter)Url\)/g) || []).length >= 6,
  'a social anchor bypasses the boundary');
check('Footer: raw settings URLs never reach href',
  !/href=\{settings\.(instagram|facebook|twitter)Url\}/.test(ft),
  'raw editable value in href');
check('Footer: noopener noreferrer on the external anchors',
  (ft.match(/rel="noopener noreferrer"/g) || []).length >= 3,
  'reverse-tabnabbing guard missing');
check('PublicPages: delivery links pass the boundary with noopener',
  (pp.match(/safeExternalHref\(store\.deliveryLinks\?\.(deliveroo|uberEats)\)/g) || []).length >= 2 &&
  /href=\{deliverooHref\}/.test(pp) && /href=\{uberEatsHref\}/.test(pp) &&
  (pp.match(/rel="noopener noreferrer"/g) || []).length >= 2 &&
  !/href=\{store\.deliveryLinks\.(deliveroo|uberEats)\}/.test(pp),
  'a delivery anchor bypasses the boundary');

/* ---- 3. Save boundary (Studio) ------------------------------------------- */
check('Studio: URL fields show an inline validation error when unsafe',
  /isUnsafeExternalUrl\(value\)/.test(ws) && /must start with https/.test(ws),
  'save-time validation message missing');
check('Studio: websiteUrl (a text label, not a link) is exempt',
  /\(\?!websiteUrl\$\)/.test(ws),
  'label field wrongly treated as a URL');

/* ---- 4. Host contract ----------------------------------------------------- */
check('netlify.toml: build, publish dist, SPA fallback, no header values',
  /command = "npm run build"/.test(nt) && /publish = "dist"/.test(nt) &&
  /from = "\/\*"[\s\S]*to = "\/index\.html"[\s\S]*status = 200/.test(nt) &&
  !/Content-Security-Policy/i.test(nt),
  'netlify.toml wrong shape or forks the header source of truth');
check('_headers: no references to files that do not exist',
  !/SECURITY_HEADERS\.md|SECURITY_BLOCKERS\.md/.test(hd) && /docs\/HOSTING\.md/.test(hd),
  'phantom doc references remain');
check('_headers: Turnstile hosts admitted (script-src + frame-src)',
  /script-src[^\n]*challenges\.cloudflare\.com/.test(hd) && /frame-src[^\n]*challenges\.cloudflare\.com/.test(hd),
  'CSP would break the WP-02 widget');
check('_headers: staff and admin remain noindex',
  /\/staff\n\s*X-Robots-Tag: noindex/.test(hd) && /\/admin\n\s*X-Robots-Tag: noindex/.test(hd),
  'noindex path rules missing');
check('headers smoke asserts the full contract incl. robots + Turnstile',
  (() => { const sm = read('scripts/headers-smoke.live.mjs');
    return /x-robots-tag/.test(sm) && /challenges\.cloudflare\.com/.test(sm) && /strict-transport-security/.test(sm); })(),
  'smoke script incomplete');

console.log(`\nWP-03 CONTRACT CHECKS — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
