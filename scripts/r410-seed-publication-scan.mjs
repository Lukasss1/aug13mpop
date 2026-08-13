#!/usr/bin/env node
/**
 * ============================================================================
 *  R4.10 INCREMENT 2 — SEED PUBLICATION SCAN
 * ============================================================================
 *
 *  THE EXIT CRITERION
 *    "Every non-authoritative build is visibly non-commercial and cannot create
 *     persistent fake price claims."
 *
 *  WHAT THIS CATCHES THAT NOTHING ELSE DID
 *  ---------------------------------------
 *  R4.9 G4 proved the running SPA cannot show seed products or prices, in real
 *  Chromium, under outage / partial / ready. It asserted RENDERED BEHAVIOUR.
 *  It never read the bytes the build writes to disk — and those bytes carried
 *
 *      {"@type":"MenuItem","name":"Kinder Bueno",
 *       "offers":{"@type":"Offer","price":"5.00","priceCurrency":"GBP"}}
 *
 *  plus a sitemap advertising a seed article. A crawler never runs the SPA; it
 *  reads exactly what this scan reads. So this suite asserts the ARTEFACT.
 *
 *  It is deliberately a scan of OUTPUT rather than of source. Source scans were
 *  the weakness that let earlier findings survive: they prove a string is
 *  present or absent in a file, not that the built site is clean.
 *
 *  Run:  npm run build && npm run test:r410-seed-scan
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

let passed = 0;
let failed = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) { passed += 1; console.log(`  \u2714 ${label}`); }
  else { failed += 1; failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  \u2716 ${label}${detail ? ` — ${detail}` : ''}`); }
}
const section = (t) => console.log(`\n${t}`);

/* ------------------------------------------------------------------ */
/*  Collect every crawlable artefact the build wrote.                   */
/* ------------------------------------------------------------------ */

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(html|xml|txt|json)$/.test(entry)) out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  What "seed content" actually is — read from the seed modules        */
/*  themselves, so renaming a seed product cannot silently defeat this. */
/* ------------------------------------------------------------------ */

function seedNames() {
  const names = new Set();
  // Read the names out of the SEED ARRAYS specifically. An earlier version of
  // this function anchored on `^\s*name:` and silently captured 7 names while
  // missing every menu product, because the catalogue entries are written on one
  // line. A scan that does not know what the seed contains passes vacuously, so
  // the array bodies are located first and the names taken from inside them.
  const ARRAYS = ['INITIAL_MENU_ITEMS', 'INITIAL_NEWS_POSTS', 'INITIAL_DEALS', 'INITIAL_STORES', 'INITIAL_JOBS'];
  for (const rel of ['src/data.ts', 'src/defaultState.ts']) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    for (const arr of ARRAYS) {
      const start = text.indexOf(`export const ${arr}`);
      if (start === -1) continue;
      // The array literal ends at the first `];` at the start of a line.
      const endRel = text.slice(start).search(/^\];/m);
      const body = endRel === -1 ? text.slice(start) : text.slice(start, start + endRel);
      for (const m of body.matchAll(/\b(?:name|title):\s*'([^']{4,60})'/g)) names.add(m[1]);
      for (const m of body.matchAll(/\b(?:name|title):\s*"([^"]{4,60})"/g)) names.add(m[1]);
    }
  }
  // The brand itself legitimately appears on every page; only the things the
  // seed invents are of interest here.
  return [...names].filter((n) => !/milk\s*pop/i.test(n));
}

async function main() {
  console.log('R4.10 SEED PUBLICATION SCAN');
  console.log('===========================');

  if (!existsSync(DIST)) {
    console.error('\u2716 dist/ not found — run `npm run build` first.');
    process.exit(1);
  }

  const manifestPath = path.join(DIST, 'seo-manifest.json');
  check('the build wrote an SEO manifest', existsSync(manifestPath));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const authoritative = manifest.source === 'supabase';

  console.log(`\n  snapshot source: ${manifest.source}  (authoritative: ${authoritative})`);

  const files = walk(DIST);
  const crawlable = files.filter((f) => !f.includes(`${path.sep}assets${path.sep}`));
  console.log(`  scanning ${crawlable.length} crawlable artefacts`);

  /* ---------------- §1 the manifest tells the truth ---------------- */
  section('\u00a71  The manifest states what was PUBLISHED, not only what was loaded');

  check('manifest records whether commercial output was suppressed',
    typeof manifest.commercialOutputSuppressed === 'boolean',
    'field absent — a manifest that cannot express suppression cannot be audited');
  check('manifest reports published counts separately from loaded counts',
    manifest.publishedCounts && typeof manifest.publishedCounts.menuItems === 'number');
  check('suppression flag agrees with the snapshot source',
    manifest.commercialOutputSuppressed === !authoritative,
    `source=${manifest.source} but suppressed=${manifest.commercialOutputSuppressed}`);

  if (!authoritative) {
    const pc = manifest.publishedCounts || {};
    check('a non-authoritative build published ZERO business records',
      pc.menuItems === 0 && pc.stores === 0 && pc.vacancies === 0 && pc.newsPosts === 0,
      JSON.stringify(pc));
  }

  /* ---------------- §2 no commercial schema ---------------- */
  section('\u00a72  No commercial structured data in the published artefacts');

  const COMMERCIAL = [
    ['"@type":"Offer"', /"@type"\s*:\s*"Offer"/],
    ['"@type":"MenuItem"', /"@type"\s*:\s*"MenuItem"/],
    ['"@type":"JobPosting"', /"@type"\s*:\s*"JobPosting"/],
    ['priceCurrency', /priceCurrency/],
    ['a price field', /"price"\s*:\s*"?\d/],
  ];

  for (const [label, re] of COMMERCIAL) {
    const hits = crawlable.filter((f) => re.test(readFileSync(f, 'utf8')));
    if (authoritative) {
      console.log(`     (authoritative build — ${label}: ${hits.length} file(s), permitted)`);
      passed += 1;
    } else {
      check(`no ${label} anywhere in dist/`, hits.length === 0,
        hits.slice(0, 3).map((f) => path.relative(DIST, f)).join(', '));
    }
  }

  /* ---------------- §3 no seed names ---------------- */
  section('\u00a73  No seed business name reaches a published artefact');

  const names = seedNames();
  console.log(`     ${names.length} candidate seed names read from src/data.ts + src/defaultState.ts`);
  const leaked = [];
  for (const f of crawlable) {
    const text = readFileSync(f, 'utf8');
    for (const n of names) if (text.includes(n)) leaked.push(`${path.relative(DIST, f)}: "${n}"`);
  }
  if (authoritative) {
    console.log('     (authoritative build — real content may legitimately match a seed name)');
    passed += 1;
  } else {
    check('no seed product or article name appears in dist/', leaked.length === 0,
      leaked.slice(0, 5).join(' | '));
  }

  /* ---------------- §4 the sitemap advertises nothing invented ---------------- */
  section('\u00a74  The sitemap contains no dynamic seed URL');

  const sitemap = readFileSync(path.join(DIST, 'sitemap.xml'), 'utf8');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const dynamic = locs.filter((u) => /\/(news|stores|careers)\/[^/]+\/?$/.test(u.replace(/^https?:\/\/[^/]+/, '')));
  console.log(`     ${locs.length} URLs, ${dynamic.length} dynamic`);

  if (!authoritative) {
    check('a non-authoritative build lists only static routes', dynamic.length === 0,
      dynamic.slice(0, 4).join(', '));
  } else {
    const pc = manifest.publishedCounts || {};
    const expected = (pc.stores || 0) + (pc.vacancies || 0) + (pc.newsPosts || 0);
    check('every dynamic URL corresponds to a published record',
      dynamic.length <= expected, `${dynamic.length} dynamic URLs but only ${expected} published records`);
  }

  check('the sitemap always includes the static routes', locs.some((u) => u.endsWith('/menu/')),
    'the menu route must exist even when the menu is empty');

  /* ---------------- §5 the empty page still exists ---------------- */
  section('\u00a75  Static routes still render (an empty surface is not a missing one)');

  for (const route of ['menu', 'stores', 'careers', 'news']) {
    check(`/${route}/ was generated`, existsSync(path.join(DIST, route, 'index.html')));
  }

  /* ---------------- summary ---------------- */
  console.log('');
  if (failed === 0) console.log(`\u2714 R4.10 SEED PUBLICATION SCAN — ${passed} passed, 0 failed`);
  else {
    console.log(`\u2716 R4.10 SEED PUBLICATION SCAN — ${passed} passed, ${failed} FAILED`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`\u2716 scan error: ${e.message}`); process.exit(1); });
