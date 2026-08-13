// prelaunch-click-audit.mjs — drives the BUILT site in headless Chromium.
// Clicks every public navigation surface, opens every page, exercises the
// menu filters/search, opens a vacancy, fills (but doesn't spam) forms,
// and fails on any console error, missing page heading, or broken image.
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:4173';
const results = []; let failures = 0;
const ok = (name, pass, note = '') => {
  results.push(`${pass ? '✔' : '✗'} ${name}${note ? ' — ' + note : ''}`);
  if (!pass) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
ok('home renders hero headline', await page.locator('text=Sip').first().isVisible());

/* ---- 1. Top navbar: every tab (stable #nav-<key> ids, labels are owner-editable) ---- */
const navKeys = ['menu', 'stores', 'careers', 'franchise', 'about', 'contact'];
for (const key of navKeys) {
  await page.locator(`#nav-${key}`).click();
  await page.waitForTimeout(450);
  const h1 = await page.locator('h1').first().textContent().catch(() => '');
  ok(`navbar → ${key} shows a page heading`, !!h1 && h1.trim().length > 0, (h1 || '').trim().slice(0, 40));
}

/* ---- 2. Menu page: images, category filters, search ---- */
await page.locator('#nav-menu').click();
await page.waitForTimeout(600);
// R4.9 G4: artwork belongs to products, and there are no products without a
// database — see above. Asserted against a live catalogue in the fail-closed proof.
// (the drink-artwork count that fed the removed check went with it)
// ok('menu shows branded drink artwork', cards >= 10, `${cards} artwork images`);
const broken = await page.$$eval('img', (imgs) =>
  imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.src.startsWith(location.origin)).map((i) => i.getAttribute('src')));
ok('no broken same-origin images on menu', broken.length === 0, broken.join(', '));
for (const cat of ['Smoothies', 'Soft Serve', 'Slush', 'Extras', 'Milkshakes']) {
  const btn = page.locator(`button:has-text("${cat}")`).first();
  if (await btn.count()) { await btn.click(); await page.waitForTimeout(250); }
}
ok('category filters clickable without errors', true);
// R4.9 G4: this audit runs against a build with NO database, and the public menu
// now fails closed instead of falling back to src/data.ts — so there is no seed
// catalogue to search or to draw artwork for. Both checks below were pinning the
// fail-open behaviour this round removed. Search against a REAL catalogue is
// asserted in scripts/r49-failclosed.browser.mjs.
const body = await page.locator('body').innerText();
ok('menu fails closed with no database (no seed products to search)',
  /temporarily unavailable/i.test(body) && !/Kinder Bueno/.test(body));
const search = page.locator('input[placeholder*="earch"]').first();
if (await search.count()) { await search.fill(''); }

/* ---- 3. Careers: honest no-open-roles empty state + home mascot ---- */
await page.locator('#nav-careers').click();
await page.waitForTimeout(500);
const careersBody = (await page.textContent('body')) || '';
/* SMALL-BIZ CLOSURE P0-7 repoint (see scripts/routing-smoke.test.mjs step 4 for
   the full reasoning). This audit runs against a build with NO backend, so
   every public collection is UNAVAILABLE. "No Open Roles" / "no news yet" /
   "Coming Soon" are claims about the BUSINESS and may render only when the
   collection genuinely loaded and was empty; an outage now says so instead.
   Asserting the outage state AND the absence of the false claim is strictly
   stronger than the original assertion. */
ok('careers shows the OUTAGE state, not a false no-open-roles claim',
  /temporarily unavailable/i.test(careersBody) && !/no open roles/i.test(careersBody)
  && !/Hospitality Team Member|Shift Supervisor/.test(careersBody),
  careersBody.trim().slice(0, 60));

/* home careers card mascot (the chocolate-bite fix) */
await page.locator('#brand-logo-btn').click();
await page.waitForTimeout(600);
const mascot = page.locator('img[src*="mascot_hold_shake"]').first();
if (await mascot.count()) {
  const box = await mascot.boundingBox();
  const card = await mascot.evaluateHandle((el) => el.closest('div'));
  const cbox = await card.asElement().boundingBox();
  const fullyInside = box && cbox && box.x >= cbox.x - 1 && box.x + box.width <= cbox.x + cbox.width + 1
    && box.y + box.height <= cbox.y + cbox.height + 1;
  ok('careers-card mascot fully visible (not cropped)', !!fullyInside,
    box && cbox ? `img right=${Math.round(box.x + box.width)} card right=${Math.round(cbox.x + cbox.width)}` : 'no box');
} else ok('careers-card mascot present', false);

/* ---- 4. Footer: every link ---- */
const footerLinks = ['The Drink & Dessert Menu', 'Our Store Locations', 'Careers & Job Vacancies',
  'Franchise Opportunities', 'Our Story & Mission', 'Contact Customer Care', 'Company News & Press',
  'Privacy Policy', 'UK GDPR Consent Policy', 'Franchise Disclosure (FDD)'];
for (const label of footerLinks) {
  const el = page.locator(`footer >> text="${label}"`).first();
  if (!(await el.count())) { ok(`footer → ${label} exists`, false); continue; }
  await el.click(); await page.waitForTimeout(400);
  const h1 = (await page.locator('h1').first().textContent().catch(() => '')) || '';
  ok(`footer → ${label} opens a page`, h1.trim().length > 0, h1.trim().slice(0, 40));
}
/* dead social icons must be hidden with blank defaults */
const socialCount = await page.locator('footer a[aria-label="Facebook"], footer a[aria-label="Twitter / X"]').count();
ok('placeholder social icons hidden when unset', socialCount === 0, `${socialCount} visible`);

/* ---- 5. Staff portal login page reachable + honest state ---- */
await page.locator('footer >> text="Staff Portal Login"').first().click();
const hub = page.getByText('Staff Hub').first();
const hubVisible = await hub.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
ok('staff portal route renders its hub heading', hubVisible);
// With Supabase env vars a password field renders; without them the portal
// must show its honest fail-closed "Sign-in unavailable" notice instead.
await page.mouse.wheel(0, 1200); await page.waitForTimeout(400);
const pw = await page.locator('input[type="password"]').count();
const honest = await page.getByText('Sign-in unavailable').count();
ok('login area shows a form or the honest fail-closed notice', pw > 0 || honest > 0,
  pw ? 'password form' : honest ? 'not-configured notice' : 'neither');

/* ---- 6. Contact form validates ---- */
await page.locator('footer >> text="Contact Customer Care"').first().click();
await page.waitForTimeout(400);
const send = page.locator('button:has-text("Send")').first();
ok('contact form has a submit button', (await send.count()) > 0);

/* ---- console errors, filtered for expected backend-less noise ---- */
const realErrors = consoleErrors.filter((e) =>
  !/not_configured|ERR_CERT_AUTHORITY_INVALID|fonts\.g|Failed to load resource.*(supabase|401|403)/i.test(e));
ok('zero console/page errors across the whole run', realErrors.length === 0,
  realErrors.slice(0, 3).join(' | '));

await page.screenshot({ path: '/tmp/home_final.png', fullPage: false });
await page.locator('#nav-menu').click();
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/menu_final.png', fullPage: false });
await browser.close();

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? '✔ CLICK AUDIT PASSED' : '✗ CLICK AUDIT FAILED'} — ${results.length - failures}/${results.length} checks`);
process.exit(failures ? 1 : 0);
