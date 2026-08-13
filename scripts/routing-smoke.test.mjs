// routing-smoke.test.mjs — URL routing + SEO regression gate.
// Drives the BUILT site (vite preview on :4173) in headless Chromium and
// verifies the routing contract added in src/lib/router.ts:
//   • every nav click writes the expected URL (pushState)
//   • deep links land on the right page (SPA fallback + parse)
//   • news-article selection has its own URL/title/canonical; stores & careers
//     show honest empty states at launch (no fabricated detail pages)
//   • back button walks the history correctly (popstate)
//   • unknown paths render a noindex not-found view and KEEP their URL
//     (unknown detail slugs still fall back to their list view)
//   • per-page <title>/canonical are applied at runtime (trailing-slash form)
//   • prerendered career/news pages carry JobPosting/NewsArticle JSON-LD
//   • every page's static head points at the 1200×630 og-card
//   • /staff and /admin deep links fail closed for guests
// Run: npm run build && npm exec --offline -- vite preview --port 4173 & npm run test:routing
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
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

const path = () => new URL(page.url()).pathname + new URL(page.url()).search;
const settle = (ms = 500) => page.waitForTimeout(ms);

/* ---- 1. Nav clicks write URLs ---- */
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
for (const key of ['menu', 'stores', 'careers', 'about', 'contact']) {
  await page.locator(`#nav-${key}`).click();
  await settle();
  ok(`navbar → /${key}/ in address bar`, path() === `/${key}/`, path());
}

/* ---- 2. Back button walks history ---- */
await page.goBack(); await settle();
ok('back → /about/', path() === '/about/', path());
await page.goBack(); await settle();
ok('back → /careers/', path() === '/careers/', path());

/* ---- 3. Deep links (served by SPA fallback or prerendered file) ---- */
const deepLinks = [
  ['/menu', 'Milk Pop Menu'],
  ['/careers', 'Join the Team'],
  ['/privacy', 'Privacy Policy'],
  ['/gdpr', 'UK GDPR Consent Policy'],
];
for (const [route, heading] of deepLinks) {
  await page.goto(BASE + route, { waitUntil: 'networkidle' });
  const h1 = (await page.locator('h1').first().textContent().catch(() => '')) || '';
  ok(`deep link ${route} renders "${heading}"`, h1.includes(heading), h1.trim().slice(0, 40));
}

/* ---- 4. Store locator: honest "coming soon" empty state (no seeded stores) ---- */
await page.goto(BASE + '/stores', { waitUntil: 'networkidle' });
await settle(700);
const storesBody = (await page.textContent('body')) || '';
ok('store locator shows the coming-soon empty state',
  /coming soon/i.test(storesBody) && !/Milk Pop Solihull|Milk Pop Leicester|Milk Pop Birmingham/.test(storesBody),
  storesBody.trim().slice(0, 60));
/* SMALL-BIZ CLOSURE P0-7 repoint. This preview build has NO backend, so every
   public collection resolves to `unavailable` — a technical outage, not an
   empty business. The list-route bounce now fires only when the collection is
   genuinely READY (bouncing a visitor off a URL that may well be valid, purely
   because we could not load the data, is the same class of dishonesty as
   showing "Coming Soon" during an outage). While NOT ready the URL is kept and
   the page is marked NOINDEX + canonicalised to the list route, so an
   arbitrary slug still cannot become an indexable self-canonical 200 — which
   is what the original bounce existed to prevent. Both halves are asserted. */
await page.goto(BASE + '/stores/milk-pop-leicester/', { waitUntil: 'networkidle' });
await settle(700);
ok('store deep link under an OUTAGE keeps the URL (no false bounce)', path() === '/stores/milk-pop-leicester/', path());
ok('…and is NOINDEX so an unresolvable slug is never indexable',
  await page.locator('head meta[name="robots"][content*="noindex"]').count() > 0,
  'robots meta missing');
ok('…and shows the outage note, never a fabricated store',
  /temporarily unavailable/i.test((await page.textContent('body')) || ''),
  ((await page.textContent('body')) || '').trim().slice(0, 80));

/* ---- 5. Careers: honest "no open roles" empty state (no seeded vacancies) ---- */
await page.goto(BASE + '/careers', { waitUntil: 'networkidle' });
await settle(700);
const careersBody = (await page.textContent('body')) || '';
/* SMALL-BIZ CLOSURE P0-7 repoint: with no backend the vacancies collection is
   UNAVAILABLE, and telling candidates "No Open Roles" would state a business
   fact the site cannot know. The marketing empty state is now reserved for a
   collection that genuinely answered with zero vacancies; an outage says so.
   Asserting the outage note AND the absence of the false claim is strictly
   stronger than the original assertion. */
ok('careers shows the OUTAGE state, not a false "no open roles" claim',
  /temporarily unavailable/i.test(careersBody) && !/no open roles/i.test(careersBody)
  && !/Hospitality Team Member|Shift Supervisor/.test(careersBody),
  careersBody.trim().slice(0, 60));

/* ---- 6. News: the article route still works, but the SEED ARTICLE IS GONE.
        R4.10 Increment 2 removed FALLBACK_NEWS_POSTS — the fabricated
        'Welcome to Milk Pop' post that this step used to click through. A build
        with no published news must show an honest empty archive, so that is what
        is asserted here. The article-detail path is still exercised, but only
        when an article actually exists, so this step keeps working unchanged
        once real news is published. ---- */
await page.goto(BASE + '/news', { waitUntil: 'networkidle' });
await settle(700);
const newsBody = (await page.textContent('body')) || '';
const articleLinks = await page.locator('text=Read Article').count();

if (articleLinks === 0) {
  /* SMALL-BIZ CLOSURE P0-7 repoint: same rule — "There is no news yet" is a
     claim about the business, valid only when the archive genuinely loaded
     and was empty. A backendless preview is an outage and must say so. */
  ok('news shows the OUTAGE state, not a false empty archive',
    /temporarily unavailable/i.test(newsBody) && !/no news yet/i.test(newsBody),
    newsBody.trim().slice(0, 80));
  ok('news publishes no fabricated article',
    !/welcome to milk pop/i.test(newsBody), 'a seed article is being rendered');
} else {
  await page.locator('text=Read Article').first().click();
  await settle();
  ok('read article → /news/<slug>/', /^\/news\/[a-z0-9-]+\/$/.test(path()), path());
  const backLink = await page.locator('text=All news').isVisible();
  ok('article view shows back link', backLink);
  const articleCanonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  ok('news canonical matches the article URL',
    (articleCanonical || '').includes('/news/'), articleCanonical || 'missing');
}

/* ---- 7. Menu filters as shareable query params ---- */
await page.goto(BASE + '/menu', { waitUntil: 'networkidle' });
await page.locator('#cat-filter-smoothies').click();
await settle();
ok('category filter → /menu/?category=smoothies', path() === '/menu/?category=smoothies', path());
await page.goto(BASE + '/menu?category=slush', { waitUntil: 'networkidle' });
const slushActive = await page.locator('#cat-filter-slush[aria-current="true"]').count();
ok('deep-linked filter pre-selects the pill', slushActive === 1);

/* ---- 8. Unknown path renders a not-found view (R4.7) ----
 *
 * This assertion previously required the opposite: `unknown path -> replaced
 * with /`. That behaviour was the soft 404 — every typo and stale link
 * resolved to a 200 response carrying the homepage's content, title and
 * canonical, and the visitor lost the URL that would have told them what was
 * wrong. The suite pinned it faithfully, which is why the change had to come
 * through here. */
await page.goto(BASE + '/definitely-not-a-page', { waitUntil: 'networkidle' });
await settle();
ok('unknown path KEEPS its URL (no rewrite to /)', path() === '/definitely-not-a-page', path());
const nfBody = (await page.textContent('body')) || '';
ok('unknown path renders a not-found view', /couldn.t find that page|404/i.test(nfBody));
ok('unknown path does NOT render homepage hero copy', !/Sip\s*.?\s*Smile\s*.?\s*Enjoy/i.test(nfBody));
ok('not-found view is marked noindex',
  /noindex/i.test(await page.getAttribute('meta[name="robots"]', 'content') || ''));
ok('not-found canonical points at the requested URL, not /',
  (await page.getAttribute('link[rel="canonical"]', 'href') || '').endsWith('/definitely-not-a-page'),
  await page.getAttribute('link[rel="canonical"]', 'href'));
ok('not-found title is its own, not the homepage title',
  /page not found/i.test(await page.title()), await page.title());
ok('not-found offers a route onward', /back to home/i.test(nfBody) && /contact/i.test(nfBody));

/* ---- 8b. Every real public route still loads on a COLD, DIRECT hit ----
 * The risk of an explicit not-found route is that a genuine route falls
 * through to it. Sampling is not enough: assert all twelve. */
for (const [route, marker] of [
  ['/', /Sip\s*.?\s*Smile\s*.?\s*Enjoy/i], ['/menu/', /menu/i], ['/stores/', /store/i],
  ['/careers/', /career|join the team/i], ['/franchise/', /franchise/i],
  ['/about/', /about|our story/i], ['/contact/', /contact/i], ['/news/', /news/i],
  ['/privacy/', /privacy/i],
  ['/gdpr/', /gdpr|your data/i], ['/fdd/', /fdd|disclosure/i],
]) {
  await page.goto(BASE + route, { waitUntil: 'networkidle' });
  await settle();
  // The homepage shows a boot splash over the content for a beat, so reading
  // body text immediately can return an empty string and fail for a reason
  // that has nothing to do with routing. Wait for real content first.
  await page.waitForFunction(() => (document.body.innerText || '').trim().length > 200, null, { timeout: 5000 })
    .catch(() => {});
  const body = (await page.textContent('body')) || '';
  ok(`cold load ${route} is NOT the not-found view`, !/couldn.t find that page/i.test(body));
  ok(`cold load ${route} renders its own content`, marker.test(body), body.slice(0, 60));
}

/* ---- 9. Guests: staff/admin deep links fail closed ---- */
await page.goto(BASE + '/staff/pos', { waitUntil: 'networkidle' });
const staffGate = (await page.textContent('body')) || '';
ok('/staff/pos (guest) shows sign-in, no POS UI',
  /sign.?in|log.?in|not configured|portal/i.test(staffGate) && !/Charge|Basket total/i.test(staffGate));
await page.goto(BASE + '/admin/payslips', { waitUntil: 'networkidle' });
const adminGate = (await page.textContent('body')) || '';
ok('/admin/payslips (guest) shows access-restricted gate', /Access restricted/i.test(adminGate));

/* ---- 10. robots + sitemap served ---- */
const robots = await page.request.get(BASE + '/robots.txt');
const robotsText = await robots.text();
ok('robots.txt has NO Disallow (noindex via headers+meta instead)', !robotsText.includes('Disallow: /staff') && !robotsText.includes('Disallow: /admin'));
ok('robots.txt advertises the sitemap', robotsText.includes('Sitemap:'));
const sitemap = await page.request.get(BASE + '/sitemap.xml');
const sitemapText = await sitemap.text();
ok('sitemap.xml carries NO fabricated store/vacancy URLs',
  !/\/stores\/[a-z0-9-]+\/</.test(sitemapText) && !/\/careers\/[a-z0-9-]+\/</.test(sitemapText),
  (sitemapText.match(/\/(stores|careers)\/[a-z0-9-]+\//) || ['clean'])[0]);

/* ---- 11. Prerendered news detail: JSON-LD + slashed canonical; no fabricated
        store/career detail pages exist at launch ---- */
/* R4.10 Increment 2: these assertions used to depend on the fabricated
   'Welcome to Milk Pop' article and on seed menu products. A build whose
   snapshot is not database-sourced now publishes neither, so the suite reads
   what the build ACTUALLY published and asserts the matching contract:
   commercial structured data when there is content, and its ABSENCE plus an
   honest empty state when there is not. Nothing is skipped — both branches
   assert. */
const seoManifest = JSON.parse(
  await (await page.request.get(BASE + '/seo-manifest.json')).text());
const published = seoManifest.publishedCounts || {};
const HAS_NEWS = (published.newsPosts || 0) > 0;
const HAS_MENU = (published.menuItems || 0) > 0;

if (HAS_NEWS) {
  const newsHtml = await (await page.request.get(BASE + '/news/welcome-to-milk-pop/')).text();
  ok('news page carries NewsArticle JSON-LD', newsHtml.includes('"@type":"NewsArticle"'));
  const newsCanonical = (newsHtml.match(/rel="canonical" href="([^"]+)"/) || [])[1] || '';
  ok('news page canonical is the slashed path', newsCanonical.endsWith('/news/welcome-to-milk-pop/'), newsCanonical);
  ok('sitemap lists the news detail page', sitemapText.includes('/news/welcome-to-milk-pop/</loc>'));
} else {
  ok('no news detail page is published when nothing is published',
    (await page.request.get(BASE + '/news/welcome-to-milk-pop/')).status() === 404
      || !(await (await page.request.get(BASE + '/news/welcome-to-milk-pop/')).text()).includes('"@type":"NewsArticle"'));
  ok('the sitemap advertises no news detail URL',
    !/\/news\/[a-z0-9-]+\/<\/loc>/.test(sitemapText), 'a seed news URL is listed');
}
const locs = [...sitemapText.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
ok('every sitemap <loc> ends with /', locs.length > 0 && locs.every((l) => l.endsWith('/')), locs.find((l) => !l.endsWith('/')) || `${locs.length} URLs`);

/* ---- 12. Unknown detail slug: bounce when READY, noindex when not ----
   SMALL-BIZ CLOSURE P0-7 repoint — see the note at step 4. In this backendless
   build the collection is unavailable, so the crawler-facing half of the
   guarantee (noindex, canonical on the list route) is what is verifiable
   here; the bounce-when-ready half is pinned in scripts/small-biz-closure.test.mjs
   §8 and exercised for real once a backend is configured. */
await page.goto(BASE + '/stores/definitely-not-a-store', { waitUntil: 'networkidle' });
await settle(700);
ok('unknown store slug under an outage is NOINDEX',
  await page.locator('head meta[name="robots"][content*="noindex"]').count() > 0, path());
ok('…and canonicalises to the list route, never to itself',
  (await page.locator('head link[rel="canonical"]').getAttribute('href') || '').endsWith('/stores/'),
  await page.locator('head link[rel="canonical"]').getAttribute('href') || 'no canonical');

/* ---- 13. Share card wired into every static head ---- */
const menuHtml = await (await page.request.get(BASE + '/menu/')).text();
ok('static og:image is the 1200×630 og-card', /property="og:image" content="[^"]*\/brand\/og-card\.png"/.test(menuHtml));
ok('static og:image:width is 1200', menuHtml.includes('og:image:width" content="1200'));

/* ---- 14. LCP preload (home only) + Menu JSON-LD + icon fallbacks ---- */
const homeHtml = await (await page.request.get(BASE + '/')).text();
/* LAUNCH-POLISH (R4.6): the hero is now WebP (137,841 -> 28,854 bytes for the
 * element the homepage preloads as its LCP). The assertion still pins the exact
 * path, so a silent revert to the PNG — or a typo'd preload that downloads a
 * file nothing renders — still fails here. */
ok('home preloads the hero mascot (webp)', /rel="preload" as="image" href="\/brand\/mascot_wave\.webp"/.test(homeHtml));
ok('hero preload carries fetchpriority=high', /rel="preload" as="image"[^>]*fetchpriority="high"/.test(homeHtml));

/* ---- 14b. LAUNCH-POLISH: above-the-fold font preloads ---- */
ok('home preloads Poppins 400 as a CORS font',
  /rel="preload" as="font" type="font\/woff2" href="\/fonts\/Poppins-400\.woff2" crossorigin/.test(homeHtml));
ok('home preloads Poppins 600 as a CORS font',
  /rel="preload" as="font" type="font\/woff2" href="\/fonts\/Poppins-600\.woff2" crossorigin/.test(homeHtml));
ok('font preloads are limited to the two above-the-fold weights',
  (homeHtml.match(/rel="preload" as="font"/g) || []).length === 2);

/* ---- 14c. LAUNCH-POLISH: <noscript> fallback body ----
 * These pages carry a full head but an empty <div id="root"> body. Without a
 * noscript block a visitor with scripting disabled saw a blank page. */
ok('home carries a noscript fallback', /<noscript>[\s\S]*<\/noscript>/.test(homeHtml));
ok('noscript fallback names the page', /<noscript>[\s\S]*<h1[^>]*>Milk Pop[\s\S]*<\/noscript>/.test(homeHtml));
ok('noscript fallback links every public route',
  ['/menu/', '/stores/', '/about/', '/careers/', '/franchise/', '/news/', '/contact/', '/privacy/', '/gdpr/']
    .every((href) => new RegExp(`<noscript>[\\s\\S]*href="${href}"[\\s\\S]*</noscript>`).test(homeHtml)));
ok('noscript body is page-specific, not the generic shell copy',
  /<noscript>[\s\S]*<h1[^>]*>Menu \| Milk Pop<\/h1>[\s\S]*<\/noscript>/.test(menuHtml));
ok('noscript text is escaped exactly once (no &amp;amp;)', !homeHtml.includes('&amp;amp;'));
ok('non-home pages do NOT carry the hero preload', !menuHtml.includes('rel="preload" as="image"'));
if (HAS_MENU) {
  ok('menu page carries Menu JSON-LD', menuHtml.includes('"@type":"Menu"') && menuHtml.includes('"@type":"MenuItem"'));
} else {
  ok('menu page emits NO MenuItem/Offer markup when nothing is published',
    !menuHtml.includes('"@type":"MenuItem"') && !menuHtml.includes('"@type":"Offer"'));
  ok('menu page emits no price when nothing is published', !/priceCurrency/.test(menuHtml));
}
ok('icon fallbacks linked (apple-touch + png)', homeHtml.includes('apple-touch-icon') && homeHtml.includes('favicon-192.png'));

ok('zero page errors across the run', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

await browser.close();
console.log(results.join('\n'));
console.log(failures === 0
  ? `\n✔ ROUTING SMOKE PASSED — ${results.length}/${results.length} checks`
  : `\n✗ ROUTING SMOKE FAILED — ${failures} of ${results.length} checks failed`);
process.exit(failures === 0 ? 0 : 1);
