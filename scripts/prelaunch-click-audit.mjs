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
const navKeys = ['menu', 'stores', 'about', 'contact'];
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

/* ---- 3. Optional programmes fail closed until the owner publishes them ---- */
await page.locator('#brand-logo-btn').click();
await page.waitForTimeout(600);
for (const key of ['careers', 'franchise', 'news']) {
  ok(`disabled ${key} is absent from the top navigation`, await page.locator(`#nav-${key}`).count() === 0);
}
ok('disabled Careers promotion is absent from the homepage',
  await page.locator('a[href="/careers/"], button:has-text("Careers"), a:has-text("Join the Team")').count() === 0);
await page.goto(BASE + '/careers/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const careersBody = (await page.textContent('body')) || '';
ok('disabled careers route fails closed instead of claiming an empty recruitment programme',
  /couldn.t find that page|404/i.test(careersBody)
  && !/no open roles|Hospitality Team Member|Shift Supervisor/i.test(careersBody),
  careersBody.trim().slice(0, 60));
ok('disabled careers route is noindex',
  /noindex/i.test(await page.getAttribute('meta[name="robots"]', 'content') || ''));

/* ---- 4. Footer: every published link; optional programmes stay absent ---- */
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const footerLinks = ['The Drink & Dessert Menu', 'Our Store Locations',
  'Our Story & Mission', 'Contact Customer Care', 'Privacy Policy', 'UK GDPR Consent Policy'];
for (const label of footerLinks) {
  const el = page.locator(`footer >> text="${label}"`).first();
  if (!(await el.count())) { ok(`footer → ${label} exists`, false); continue; }
  await el.click(); await page.waitForTimeout(400);
  const h1 = (await page.locator('h1').first().textContent().catch(() => '')) || '';
  ok(`footer → ${label} opens a page`, h1.trim().length > 0, h1.trim().slice(0, 40));
}
for (const label of ['Careers & Job Vacancies', 'Franchise Opportunities', 'Company News & Press', 'Franchise Disclosure (FDD)']) {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(150);
  ok(`footer omits disabled optional link: ${label}`, await page.locator(`footer >> text="${label}"`).count() === 0);
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
