/**
 * seo-prerender.test.ts — OPT-02-C1.2 acceptance items (1)(4)(5)(6)(7)(8)(9)
 * (13)(17), end to end.
 *
 * Runs the REAL generator (scripts/prerender-seo.ts) as a subprocess in
 * production mode against the shared fixture (SEO_CONTENT_FIXTURE), over a
 * throwaway dist/ shell, and asserts the emitted crawler HTML, sitemap and
 * JSON-LD are ALL derived from the one validated Supabase snapshot:
 *
 *   • unique fixture store / vacancy / published-news pages are generated;
 *   • the DRAFT news post and the incomplete store/vacancy produce NO page and
 *     NO sitemap entry;
 *   • page <head>s and JSON-LD carry the fixture's unique values (so the output
 *     tracks the database, not the bundled seeds — the seed "Welcome to Milk
 *     Pop" post and the seed home SEO title appear nowhere);
 *   • seo-manifest.json records source:'supabase', the SAME canonical content
 *     hash the shared module computes, and the correct counts;
 *   • a server-only RESEND_API_KEY secret set at build time never lands in
 *     any generated artefact.
 *
 * Run: npm run test:seo-prerender
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPublicContent } from './load-public-content';
import { storeSlug, vacancySlug, postSlug } from '../src/lib/router';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PRERENDER = path.join(REPO, 'scripts', 'prerender-seo.ts');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const FIXTURE = path.join(HERE, 'fixtures', 'seo-content.fixture.json');
const SITE = 'https://milkpop.uk';
const SERVER_SECRET_SENTINEL = 're_test_SENTINEL-DO-NOT-LEAK-9931';

let passed = 0, failed = 0;
const check = (name: string, cond: boolean) => {
  if (cond) { passed++; console.log(`\u2714 ${name}`); }
  else { failed++; console.error(`\u2716 ${name}`); }
};

/** Use the committed app shell so this regression test sees the exact
 * attribute order and marker shipped to Vite. A hand-written approximation
 * previously missed the duplicate-preload defect. */
const SHELL = readFileSync(path.join(REPO, 'index.html'), 'utf8');

function imagePreloads(html: string): string[] {
  return [...html.matchAll(/<link\b(?=[^>]*\brel="preload")(?=[^>]*\bas="image")[^>]*>/g)]
    .map((match) => match[0]);
}

/** Recursively collect every file path under a dir. */
function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

async function run() {
  // Expected values, computed from the SAME fixture via the shared modules.
  const { snapshot, metadata } = await loadPublicContent({ mode: 'production', fixture: FIXTURE });
  const store = snapshot.stores[0];
  const vac = snapshot.vacancies[0];
  const news = snapshot.newsPosts[0];
  const storeRoute = `/stores/${storeSlug(store)}/`;
  const vacRoute = `/careers/${vacancySlug(vac)}/`;
  const newsRoute = `/news/${postSlug(news)}/`;
  const draftRoute = `/news/secret-winter-menu-preview/`;
  const incompleteStoreRoute = `/stores/incomplete-placeholder-stall/`;

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'milkpop-seo-prerender-'));
  try {
    const dist = path.join(tmp, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(path.join(dist, 'index.html'), SHELL, 'utf8');

    const res = spawnSync(TSX, [PRERENDER], {
      cwd: tmp,
      env: {
        ...process.env,
        VITE_DEPLOYMENT_MODE: 'production',
        SEO_CONTENT_FIXTURE: FIXTURE,
        SITE_URL: SITE,
        RESEND_API_KEY: SERVER_SECRET_SENTINEL, // must never leak into dist
      },
      encoding: 'utf8',
    });

    const stdout = res.stdout || '';
    const stderr = res.stderr || '';
    check('prerender subprocess exits 0', res.status === 0);
    if (res.status !== 0) console.error(stdout + '\n' + stderr);
    check('prerender reports source=supabase', /source=supabase/.test(stdout));

    const read = (rel: string) => readFileSync(path.join(dist, rel.replace(/^\//, '').replace(/\/$/, ''), 'index.html'), 'utf8');
    const pageExists = (route: string) => existsSync(path.join(dist, route.replace(/^\//, '').replace(/\/$/, ''), 'index.html'));

    /* --- pages that MUST exist ------------------------------------------- */
    check('home page generated', existsSync(path.join(dist, 'index.html')));
    check('store page generated', pageExists(storeRoute));
    check('vacancy page generated', pageExists(vacRoute));
    check('published news page generated', pageExists(newsRoute));

    /* --- pages that MUST NOT exist (draft + incomplete) ------------------ */
    check('draft news page NOT generated', !pageExists(draftRoute));
    check('incomplete store page NOT generated', !pageExists(incompleteStoreRoute));

    /* --- <head> tracks the database ------------------------------------- */
    const home = readFileSync(path.join(dist, 'index.html'), 'utf8');
    check('home <title> is the fixture SEO title',
      home.includes('<title>Riverside Fixtureton Shakes — FIXTURE Home 4821</title>'));
    check('home Organization JSON-LD carries the fixture brand name',
      home.includes('"name":"Milk Pop Fixtureton"'));
    check('home Organization JSON-LD carries the fixture legal name',
      home.includes('"legalName":"Fixture Dairy Company Limited"'));
    check('home Organization sameAs includes the fixture Instagram',
      home.includes('instagram.com/milkpop_fixture_ig'));
    check('empty twitter URL is omitted from sameAs',
      !home.includes('twitter.com') || !home.includes('milkpop_fixture'));
    const homePreloads = imagePreloads(home);
    check('home has exactly one route image preload', homePreloads.length === 1);
    check('home preload is the mascot and keeps the stable marker',
      homePreloads[0]?.includes('id="mp-route-image-preload"') === true
      && homePreloads[0]?.includes('href="/brand/mascot_wave.webp"') === true);

    const storeHtml = read(storeRoute);
    check('non-home generated pages have no route image preload', imagePreloads(storeHtml).length === 0);
    check('store JSON-LD is an IceCreamShop with the fixture name',
      storeHtml.includes('"@type":"IceCreamShop"') && storeHtml.includes('"name":"Riverside Quay Kiosk"'));
    check('store JSON-LD carries real geo coordinates',
      storeHtml.includes('"latitude":51.5079') && storeHtml.includes('"longitude":-0.0877'));

    const vacHtml = read(vacRoute);
    check('vacancy JSON-LD is a JobPosting with the fixture title',
      vacHtml.includes('"@type":"JobPosting"') && vacHtml.includes('"title":"Night Shift Blender Artisan"'));
    check('vacancy datePosted uses the DB timestamp (2026-04-20), not the build date',
      vacHtml.includes('"datePosted":"2026-04-20"'));

    const newsHtml = read(newsRoute);
    check('news JSON-LD is a NewsArticle with the fixture headline',
      newsHtml.includes('"@type":"NewsArticle"') && newsHtml.includes('"headline":"Neon Nights Launch Party"'));

    /* --- sitemap tracks exactly the published set ----------------------- */
    const sitemap = readFileSync(path.join(dist, 'sitemap.xml'), 'utf8');
    const loc = (route: string) => `<loc>${SITE}${route}</loc>`;
    const baseRoutes = ['/', '/menu/', '/stores/', '/careers/', '/franchise/', '/about/', '/contact/', '/news/',
      '/privacy/', '/gdpr/', '/fdd/'];
    check('sitemap contains all base + legal routes', baseRoutes.every((r) => sitemap.includes(loc(r))));
    check('sitemap contains the store route', sitemap.includes(loc(storeRoute)));
    check('sitemap contains the vacancy route', sitemap.includes(loc(vacRoute)));
    check('sitemap contains the published news route', sitemap.includes(loc(newsRoute)));
    check('sitemap OMITS the draft news route', !sitemap.includes(loc(draftRoute)));
    check('sitemap OMITS the incomplete store route', !sitemap.includes(loc(incompleteStoreRoute)));

    /* --- seeds appear NOWHERE ------------------------------------------- */
    const allFiles = walk(dist);
    const allText = allFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    check('seed news post "Welcome to Milk Pop" appears in no artefact',
      !allText.includes('Welcome to Milk Pop'));
    check('seed default home SEO title appears in no artefact',
      !allText.includes('Milkshake Bar | Shakes, Smoothies'));

    /* --- manifest is correct + safe ------------------------------------- */
    const manifestRaw = readFileSync(path.join(dist, 'seo-manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw) as Record<string, any>;
    check('manifest source is supabase', manifest.source === 'supabase');
    check('manifest contentHash equals the shared-module hash', manifest.contentHash === metadata.contentHash);
    check('manifest counts.menuItems = 3', manifest.counts.menuItems === 3);
    check('manifest counts.stores = 1', manifest.counts.stores === 1);
    check('manifest counts.vacancies = 1', manifest.counts.vacancies === 1);
    check('manifest counts.publishedNewsPosts = 1', manifest.counts.publishedNewsPosts === 1);
    check('manifest counts.generatedPages = 14', manifest.counts.generatedPages === 14);
    check('manifest carries no deploy-hook / secret keys',
      !/hook|secret|service_role|serviceRole/i.test(manifestRaw));

    /* --- (17) a server-only secret never leaks into dist ---------------- */
    check('RESEND_API_KEY sentinel appears in NO generated artefact',
      !allText.includes(SERVER_SECRET_SENTINEL) && !allText.includes('SENTINEL-DO-NOT-LEAK'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  /* --- (escaping) owner content containing `$` must not corrupt output --- */
  // Regression for the replacement-string `$` hazard: the emitted <head> is
  // built by String.replace with replacement TEXT derived from owner-editable
  // content. A naive string replacer interprets `$&`, `$'`, `` $` `` and `$$`
  // as patterns — worst case `$'` injects the whole document tail into a meta
  // tag or the JSON-LD block. Prices make `$` realistic. Push those sequences
  // through the SEO title/description and the brand name; assert nothing breaks.
  {
    const MARK = '$' + '&' + '$' + "'" + '$' + '`' + '$' + '$'; // $&$'$`$$
    const SENT = 'PRERENDER-BODY-SENTINEL-ZZ';
    const base = JSON.parse(readFileSync(FIXTURE, 'utf8')) as any;
    const brandMark = `Dollar ${MARK} Brand`;
    base.site_settings[0].brand_name = brandMark;
    base.site_content[0].seo.home.title = `Dollartown ${MARK} Shakes`;
    base.site_content[0].seo.home.description = `Deals ${MARK} at the shop today`;

    const tmp2 = mkdtempSync(path.join(os.tmpdir(), 'milkpop-seo-dollars-'));
    try {
      const dist2 = path.join(tmp2, 'dist');
      mkdirSync(dist2, { recursive: true });
      writeFileSync(
        path.join(dist2, 'index.html'),
        SHELL.replace('<div id="root"></div>', `<div id="root"></div>${SENT}`),
        'utf8',
      );
      const fx2 = path.join(tmp2, 'dollars.fixture.json');
      writeFileSync(fx2, JSON.stringify(base), 'utf8');

      const res2 = spawnSync(TSX, [PRERENDER], {
        cwd: tmp2,
        env: { ...process.env, VITE_DEPLOYMENT_MODE: 'production', SEO_CONTENT_FIXTURE: fx2, SITE_URL: SITE },
        encoding: 'utf8',
      });
      check('$-escaping: prerender still exits 0', res2.status === 0);
      if (res2.status !== 0) console.error((res2.stdout || '') + '\n' + (res2.stderr || ''));

      const home2 = existsSync(path.join(dist2, 'index.html')) ? readFileSync(path.join(dist2, 'index.html'), 'utf8') : '';
      // `$'` would inject the document tail (carrying the body sentinel) into <head>.
      check("$-escaping: no document-tail duplication (the $' hazard)", (home2.split(SENT).length - 1) === 1);
      // The <title> keeps its distinctive words and is neither truncated nor tail-filled.
      const titleM = home2.match(/<title>([\s\S]*?)<\/title>/);
      check('$-escaping: <title> intact (words present, no body injected)',
        !!titleM && titleM[1].includes('Dollartown') && titleM[1].includes('Shakes') && !titleM[1].includes(SENT));
      // Every ld+json block is still valid JSON after decoding the `<` escape.
      const blocks = [...home2.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      let allValid = blocks.length > 0;
      const names: string[] = [];
      for (const b of blocks) {
        try {
          const o = JSON.parse(b[1].replace(/\\u003c/g, '<')) as { name?: unknown };
          if (typeof o.name === 'string') names.push(o.name);
        } catch { allValid = false; }
      }
      check('$-escaping: home JSON-LD blocks all parse as valid JSON', allValid);
      // The Organization name survives the `$` sequences byte-for-byte in JSON-LD.
      check('$-escaping: Organization JSON-LD name keeps the literal $ sequences', names.includes(brandMark));
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  }

  console.log(`\n${failed ? '\u2716' : '\u2714'} seo-prerender: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error('seo-prerender.test crashed:', e); process.exit(1); });
