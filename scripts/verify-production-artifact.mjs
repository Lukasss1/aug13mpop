#!/usr/bin/env node
/**
 * ============================================================================
 *  verify-production-artifact.mjs  —  P0-5 PRODUCTION ARTIFACT READINESS
 * ============================================================================
 *
 *  Everything before this checked that the SHIPPED build is the TESTED build.
 *  None of it checked whether that build is fit to be public. A development
 *  bundle can be perfectly sealed, signed and provenance-verified — and still
 *  point at a demo backend, carry placeholder copy, or have its commercial
 *  output suppressed.
 *
 *  This script inspects the BUILT ARTEFACT (not the source, not the config that
 *  was meant to be used) and answers: is this dist a real production build of
 *  the approved Milk Pop site?
 *
 *  It runs BOTH directions, because either alone is weak:
 *
 *    NEGATIVE — no demo URLs, localhost, example.com, placeholder markers,
 *               test keys, backend-less overrides or dev-server artefacts.
 *    POSITIVE — the approved Supabase project ref and site origin are ACTUALLY
 *               PRESENT in the bundle, the SEO snapshot came from Supabase
 *               rather than development defaults, commercial output is enabled,
 *               and there is real published content.
 *
 *  A pure "no bad strings" scan passes trivially on an empty or misconfigured
 *  bundle. The positive checks are what make absence meaningful.
 *
 *  Usage:
 *    node scripts/verify-production-artifact.mjs <dist-dir> --trust <policy.json>
 *    node scripts/verify-production-artifact.mjs dist --site-domain milkpop.uk \
 *         --supabase-ref abcdefghijklm
 *
 *  The approved values come from the external trust policy (or explicit flags),
 *  never from the artefact — an artefact cannot vouch for its own target.
 * ============================================================================
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const distDir = args[0] && !args[0].startsWith('--') ? args[0] : 'dist';
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};

let failed = 0;
let checked = 0;
const check = (name, ok, detail) => {
  checked += 1;
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/* ---- approved configuration (EXTERNAL) ---------------------------------- */
let approvedDomain = flag('--site-domain');
let approvedRef = flag('--supabase-ref');
const policyPath = flag('--trust') || process.env.MP_TRUST_POLICY;
if (policyPath) {
  const raw = JSON.parse(readFileSync(policyPath, 'utf8'));
  approvedDomain = approvedDomain || raw.approved_site_domain;
  approvedRef = approvedRef || raw.approved_supabase_project_ref;
}

console.log(`PRODUCTION ARTEFACT — ${path.resolve(distDir)}`);
if (!existsSync(distDir)) {
  console.error(`dist directory not found: ${distDir}`);
  process.exit(2);
}
if (!approvedDomain || !approvedRef) {
  console.error('refusing to judge a production artefact without the approved site domain and Supabase project ref');
  console.error('supply --trust <policy.json> (approved_site_domain + approved_supabase_project_ref) or --site-domain/--supabase-ref');
  process.exit(2);
}
/* A policy still carrying its template placeholders is not a configuration. */
if (/REPLACE-WITH/i.test(approvedRef) || /REPLACE-WITH/i.test(approvedDomain)) {
  console.error('the trust policy still contains REPLACE-WITH placeholders — fill it in before judging a production artefact');
  process.exit(2);
}

/* ---- gather text assets -------------------------------------------------- */
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.cjs', '.css', '.json', '.txt', '.xml', '.webmanifest', '.map']);
const files = [];
const allFiles = [];
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else {
      allFiles.push(full);
      if (TEXT_EXT.has(path.extname(e).toLowerCase())) files.push(full);
    }
  }
};
walk(distDir);
const corpus = files.map((f) => ({ rel: path.relative(distDir, f).split(path.sep).join('/'), text: readFileSync(f, 'utf8') }));
console.log(`  (${files.length} text assets scanned)\n`);

/* ---- deployability + performance envelope -------------------------------
 * These are deliberately generous small-business budgets, not vanity scores.
 * They catch accidental source maps, unhashed cacheable assets, a source entry
 * leaking into production, or a monolithic multi-megabyte initial bundle while
 * leaving normal Vite/React chunking ample headroom. Lazy staff/admin chunks
 * count toward the total-JS ceiling but not the initial-route ceiling. */
console.log('── deployability + bundle envelope ──');
const relOf = (f) => path.relative(distDir, f).split(path.sep).join('/');
const byRel = new Map(allFiles.map((f) => [relOf(f), f]));
const indexPath = path.join(distDir, 'index.html');
const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';

check('the production entry page exists', !!indexHtml);
check('the production entry does not reference /src or the Vite dev client',
  !!indexHtml && !/(?:src=["']\/src\/|@vite\/client|@react-refresh)/.test(indexHtml));
check('host security/cache headers ship in the artefact', byRel.has('_headers'));
check('SPA routing rules ship in the artefact', byRel.has('_redirects'));

const sourceMaps = allFiles.map(relOf).filter((rel) => rel.endsWith('.map'));
check('no JavaScript or CSS source maps ship publicly', sourceMaps.length === 0,
  sourceMaps.slice(0, 3).join(', ') || undefined);

const cacheable = allFiles.map(relOf).filter((rel) => /^assets\/.+\.(?:js|css)$/.test(rel));
const unhashed = cacheable.filter((rel) => !/^assets\/.+-[A-Za-z0-9_-]{6,}\.(?:js|css)$/.test(rel));
check('every cacheable JS/CSS asset has a content hash', cacheable.length > 0 && unhashed.length === 0,
  unhashed.slice(0, 3).join(', ') || `${cacheable.length} hashed asset(s)`);

const localRefs = new Set();
for (const m of indexHtml.matchAll(/<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+)["'][^>]*>/gi)) {
  const raw = m[1];
  if (!raw.startsWith('/') || raw.startsWith('//')) continue;
  localRefs.add(raw.slice(1).split(/[?#]/, 1)[0]);
}
const missingRefs = [...localRefs].filter((rel) => rel && !byRel.has(rel));
check('every local entry-page asset reference resolves inside dist', missingRefs.length === 0,
  missingRefs.slice(0, 3).join(', ') || `${localRefs.size} reference(s)`);

const sizeOf = (rel) => statSync(byRel.get(rel)).size;
const jsAssets = cacheable.filter((rel) => rel.endsWith('.js'));
const cssAssets = cacheable.filter((rel) => rel.endsWith('.css'));
const initialJs = [...localRefs].filter((rel) => rel.endsWith('.js') && byRel.has(rel));
const sum = (rels) => rels.reduce((n, rel) => n + sizeOf(rel), 0);
const max = (rels) => rels.reduce((n, rel) => Math.max(n, sizeOf(rel)), 0);
const MIB = 1024 * 1024;
const KIB = 1024;
const BUDGET = Object.freeze({
  initialJs: 1.75 * MIB,
  totalJs: 4 * MIB,
  largestJs: 1.5 * MIB,
  totalCss: 1 * MIB,
  largestCss: 512 * KIB,
});
const fmt = (bytes) => `${(bytes / KIB).toFixed(1)} KiB`;
check('initial JavaScript stays within the 1.75 MiB safety budget', initialJs.length > 0 && sum(initialJs) <= BUDGET.initialJs,
  `${initialJs.length} file(s), ${fmt(sum(initialJs))}`);
check('total JavaScript stays within the 4 MiB safety budget', jsAssets.length > 0 && sum(jsAssets) <= BUDGET.totalJs,
  `${jsAssets.length} file(s), ${fmt(sum(jsAssets))}`);
check('no single JavaScript chunk exceeds 1.5 MiB', jsAssets.length > 0 && max(jsAssets) <= BUDGET.largestJs,
  `largest ${fmt(max(jsAssets))}`);
check('total CSS stays within the 1 MiB safety budget', cssAssets.length > 0 && sum(cssAssets) <= BUDGET.totalCss,
  `${cssAssets.length} file(s), ${fmt(sum(cssAssets))}`);
check('no single CSS file exceeds 512 KiB', cssAssets.length > 0 && max(cssAssets) <= BUDGET.largestCss,
  `largest ${fmt(max(cssAssets))}`);

const headersText = byRel.has('_headers') ? readFileSync(byRel.get('_headers'), 'utf8') : '';
const headerRule = (route) => {
  const lines = headersText.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === route);
  if (start < 0) return '';
  const values = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s+\S/.test(line)) values.push(line.trim());
    else if (line.trim().startsWith('/')) break;
  }
  return values.join('\n');
};
check('the catch-all security rule does not shadow hashed-asset caching',
  !/Cache-Control:/i.test(headerRule('/*')));
check('hashed assets carry the explicit immutable cache policy',
  /Cache-Control:\s*public,\s*max-age=31536000,\s*immutable/i.test(headerRule('/assets/*')));
check('the live release marker is explicitly no-store',
  /Cache-Control:\s*no-store,\s*max-age=0/i.test(headerRule('/.well-known/milkpop-release.json')));

const hits = (re, { skip = () => false } = {}) => corpus
  .filter((c) => !skip(c.rel))
  .filter((c) => re.test(c.text))
  .map((c) => c.rel);

/* The release marker legitimately records identity values; it is generated
   after the build and is excluded from the build hash. */
const isMarker = (rel) => rel === '.well-known/milkpop-release.json';

console.log('── negative: nothing non-production may ship ──');

/* PRECISION MATTERS MORE THAN BREADTH HERE. A first cut of this list fired on
   `::placeholder` in CSS, on i18n keys like `searchPlaceholder`, and on
   `sarah@example.com` inside an email field's placeholder attribute — all
   legitimate. A gate that blocks every real build gets switched off, so each
   pattern below is narrowed to the shape a genuine misconfiguration takes:
   a URL or a SCREAMING_CASE config token, not an English word that happens to
   appear in UI copy. Config placeholders are upper-case tokens, so PLACEHOLDER
   is matched case-SENSITIVELY; user-facing `placeholder` attributes are not. */
const FORBIDDEN = [
  ['local development hosts', /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?/i],
  ['example/demo domains in URLs', /https?:\/\/[^"'\s]*(?:example\.(?:com|org|net)|test\.local)/i],
  ['unfilled config placeholders', /REPLACE[-_ ]WITH|LOREM IPSUM|YOUR[-_](?:API|KEY|TOKEN|DOMAIN)|\bPLACEHOLDER[-_A-Z]*\b/],
  ['test or dummy credentials', /(?:test[-_]?(?:key|token|secret)|dummy[-_]?(?:key|token|secret)|sk_test_|pk_test_|1x00000000000000000000AA)/i],
  ['backend-less / dev overrides', /VITE_ALLOW_BACKENDLESS|MP_SEAL_ALLOW_NONPRODUCTION|allowBackendless/i],
  ['development snapshot source', /development-defaults/i],
  ['vite dev-server artefacts', /@vite\/client|\/@react-refresh|__vite_plugin/i],
];
for (const [label, re] of FORBIDDEN) {
  const found = hits(re, { skip: isMarker });
  check(`no ${label}`, found.length === 0, found.slice(0, 3).join(', ') || undefined);
}

/* A service-role key or any private credential in a public bundle is fatal.
   verify-no-secrets.mjs covers this too; duplicated here so the production
   gate is self-contained and cannot pass because another stage was skipped. */
const secretHits = hits(/service_role|SUPABASE_SERVICE_ROLE|RESEND_API_KEY|TURNSTILE_SECRET|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/i);
check('no server-only secrets in the public bundle', secretHits.length === 0, secretHits.slice(0, 3).join(', ') || undefined);

/* A foreign Supabase project shipping in a "production" bundle means the build
   was configured against the wrong backend. */
const refRe = /https:\/\/([a-z0-9]{16,})\.supabase\.co/gi;
const refs = new Set();
for (const c of corpus) {
  if (isMarker(c.rel)) continue;
  for (const m of c.text.matchAll(refRe)) refs.add(m[1]);
}
const foreign = [...refs].filter((r) => r !== approvedRef);
check('no Supabase project other than the approved one appears in the bundle',
  foreign.length === 0, foreign.slice(0, 3).join(', ') || `${refs.size} distinct ref(s)`);

console.log('\n── positive: the approved production configuration is actually present ──');

check(`the approved Supabase project (${approvedRef}) is configured in the bundle`,
  refs.has(approvedRef),
  refs.has(approvedRef) ? undefined : `not found in any asset — the build was not given the production backend`);

const originHits = hits(new RegExp(`https?://(?:www\\.)?${approvedDomain.replace(/\./g, '\\.')}`, 'i'));
check(`the approved site origin (${approvedDomain}) appears in the bundle`,
  originHits.length > 0, originHits.length ? `${originHits.length} asset(s)` : 'no absolute production URLs found');

/* ---- SEO / commercial output -------------------------------------------- */
console.log('\n── commercial + SEO output ──');
const seoPath = path.join(distDir, 'seo-manifest.json');
if (!existsSync(seoPath)) {
  check('dist/seo-manifest.json is present', false, 'absent — cannot confirm commercial output');
} else {
  const seo = JSON.parse(readFileSync(seoPath, 'utf8'));
  check('SEO snapshot came from Supabase, not development defaults',
    seo.source === 'supabase', `source=${seo.source}`);
  check('commercial output is enabled',
    seo.commercialOutputSuppressed !== true,
    seo.commercialOutputSuppressed === true ? 'commercialOutputSuppressed=true' : undefined);
  check('the SEO manifest targets the approved site',
    typeof seo.siteUrl === 'string' && seo.siteUrl.includes(approvedDomain),
    `siteUrl=${seo.siteUrl}`);
  const published = seo.publishedCounts && typeof seo.publishedCounts === 'object'
    ? Object.values(seo.publishedCounts).reduce((a, b) => a + (Number(b) || 0), 0) : 0;
  check('the production snapshot contains published content',
    published > 0, `${published} published item(s)`);
}

/* ---- prerendered pages --------------------------------------------------- */
const htmlFiles = corpus.filter((c) => c.rel.endsWith('.html'));
check('the build produced HTML pages', htmlFiles.length > 0, `${htmlFiles.length} page(s)`);
const noIndex = htmlFiles.filter((c) => /<meta[^>]+name=["']robots["'][^>]+noindex/i.test(c.text));
check('no page ships with a noindex robots directive',
  noIndex.length === 0, noIndex.slice(0, 3).map((c) => c.rel).join(', ') || undefined);

console.log('');
if (failed === 0) {
  console.log(`✔ PRODUCTION ARTEFACT READY — ${checked} checks passed`);
  process.exit(0);
}
console.log(`✖ PRODUCTION ARTEFACT NOT READY — ${failed} of ${checked} checks failed`);
console.log('  This dist must not be deployed as a Milk Pop production release.');
process.exit(1);
