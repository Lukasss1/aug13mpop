/**
 * r49-failclosed.browser.mjs — R4.9 G4 BEHAVIOURAL PROOF
 *
 * The structural suite (scripts/r49-failclosed.test.mjs) asserts that the wiring
 * is right. This asserts what a customer actually sees, in real Chromium against
 * a real production build, when the database does not answer.
 *
 * It exists because both defects found during the G4 review — a partial pull
 * reported as `ready`, and seeded deals rendering a £9 offer — passed all 1,572
 * static assertions. A source scan cannot see a rendered price.
 *
 * The build is done HERE, with a stub Supabase origin, so the suite can never
 * pass against a stale or differently-configured dist.
 *
 *   Run: npm run test:r49-browser
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const STUB = 'https://stub.milkpop.test';

/* Seed content that must NEVER reach a customer when the database is silent.
   Distinctive product names plus the seeded offer — a price alone is too
   generic to attribute, a seeded product name is not. */
const SEED_PRODUCTS = ['Kinder Bueno', 'Ferrero Rocher', 'Biscoff', 'Snickers'];
const SEED_OFFER = 'Two Milkshakes Combo';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✖ ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* ---- 1. build against a stub origin so the app really attempts a pull ---- */
console.log('\nR4.9 G4 — FAIL-CLOSED BEHAVIOURAL PROOF\n');
console.log('  building with a stub Supabase origin…');
execFileSync('npm', ['run', 'build'], {
  cwd: ROOT,
  stdio: 'pipe',
  env: {
    ...process.env,
    VITE_SUPABASE_URL: STUB,
    VITE_SUPABASE_ANON_KEY: 'stub-anon-key-for-the-failclosed-proof',
  },
});
if (!existsSync(path.join(DIST, 'index.html'))) {
  console.log('  ✖ build produced no dist/index.html');
  process.exit(1);
}

/* ---- 2. serve it (SPA fallback, matching netlify.toml) ------------------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!existsSync(file) || file.endsWith(path.sep)) file = path.join(file, 'index.html');
  if (!existsSync(file)) file = path.join(DIST, 'index.html');
  try {
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch { res.writeHead(500); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();

/**
 * Open a page with the stub database behaving as `mode` dictates.
 *   'outage'  — every table request aborts
 *   'partial' — every table answers [] EXCEPT the menu view, which aborts
 *   'ready'   — every table answers []; the menu view answers two products
 */
async function visit(route, mode) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (r) => {
    const u = r.request().url();
    if (!u.startsWith(STUB)) return r.continue();
    const isMenu = /menu_items_public/.test(u);
    if (mode === 'outage' || (mode === 'partial' && isMenu)) return r.abort();
    const body = mode === 'ready' && isMenu
      ? JSON.stringify([
          { id: 'live_1', name: 'Live Product One', description: '', category: 'milkshakes',
            price: 4.25, price_large: null, calories: 0, tags: [], allergens: [], image: '',
            available: true, created_at: null, updated_at: null },
          { id: 'live_2', name: 'Live Product Two', description: '', category: 'slush',
            price: 3.5, price_large: null, calories: 0, tags: [], allergens: [], image: '',
            available: true, created_at: null, updated_at: null },
        ])
      : '[]';
    return r.fulfill({ status: 200, contentType: 'application/json', body });
  });
  // 'networkidle' is the wrong signal here: an aborted pull leaves the app
  // retrying, so the network never goes quiet on the failure paths — which is
  // the very state under test. Wait for the document and then settle.
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const text = await page.evaluate(() => document.body.innerText);
  return { page, text, errors };
}

const leaked = (text) => SEED_PRODUCTS.filter((n) => text.includes(n));

try {
  /* ---- 3. total outage ---------------------------------------------------- */
  for (const route of ['/menu/', '/']) {
    const { page, text, errors } = await visit(route, 'outage');
    // Scope the product assertion to the PRODUCT surface. Editorial copy may
    // legitimately name flavours the business sells ("premium treats like
    // Kinder Bueno and Biscoff" is a brand statement, not an availability or
    // price claim); a product CARD may not appear unless the database answered.
    const productScope = route === '/'
      ? await page.locator('#home-favourites').innerText().catch(() => '')
      : text;
    const found = SEED_PRODUCTS.filter((n) => productScope.includes(n));
    check(`outage · ${route} · no seed product is rendered as a product`, found.length === 0, found.join(', '));
    check(`outage · ${route} · the seeded offer is not rendered`, !text.includes(SEED_OFFER));
    check(`outage · ${route} · no £ price from the seed catalogue`, !/£5\b|£6\b|£9\b/.test(text));
    check(`outage · ${route} · no uncaught page error`, errors.length === 0, errors[0] || '');
    if (route === '/') {
      check('outage · / · the favourites strip shows the unavailable panel',
        /temporarily unavailable/i.test(productScope), productScope.slice(0, 100));
    }
    if (route === '/menu/') {
      check('outage · /menu/ · the unavailable panel is shown',
        /temporarily unavailable/i.test(text));
      const announced = await page.locator('[role="status"]').count();
      check('outage · /menu/ · the panel is announced to assistive tech', announced > 0);
    }
    await page.close();
  }

  /* ---- 4. PARTIAL failure — the defect the review caught ------------------- */
  const { page: p2, text: t2 } = await visit('/menu/', 'partial');
  const found2 = leaked(t2);
  check('partial · a failed MENU fetch alone still fails closed',
    /temporarily unavailable/i.test(t2), t2.slice(0, 120));
  check('partial · it is NOT rendered as an empty menu',
    !/no items|no products|nothing here/i.test(t2));
  check('partial · no seed product leaks through the partial path', found2.length === 0, found2.join(', '));
  await p2.close();

  /* ---- 5. the happy path still works, and the view filter reaches the page - */
  const { page: p3, text: t3 } = await visit('/menu/', 'ready');
  check('ready · the database products render', t3.includes('Live Product One') && t3.includes('Live Product Two'));
  check('ready · the unavailable panel is gone', !/temporarily unavailable/i.test(t3));
  check('ready · and no seed product appears alongside them', leaked(t3).length === 0);
  // Search-narrowing moved here from the final deployment audit, which now runs
  // against a fail-closed menu with no database and therefore has nothing to
  // search. Here there IS a live catalogue, so the behaviour is really tested.
  const search = p3.locator('input[placeholder*="earch"]').first();
  if (await search.count()) {
    await search.fill('Live Product One');
    await p3.waitForTimeout(400);
    const narrowed = await p3.locator('body').innerText();
    check('ready · search narrows the live catalogue',
      narrowed.includes('Live Product One') && !narrowed.includes('Live Product Two'));
  } else {
    check('ready · search narrows the live catalogue', false, 'no search input found');
  }
  await p3.close();
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${fail === 0 ? '✔' : '✖'} R4.9 G4 FAIL-CLOSED PROOF — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
