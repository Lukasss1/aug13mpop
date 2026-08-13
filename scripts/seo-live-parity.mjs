/**
 * seo-live-parity.mjs — OPT-02-C1.2 acceptance item (15): live post-deploy
 * parity check. This is a DEPLOY-TIME gate; it is deliberately NOT part of
 * `npm run verify` (which must run offline with fixtures) and instead runs
 * against the real deployment with the real ANON credentials.
 *
 * What it does:
 *   1. reads the CURRENT public content straight from Supabase with the anon
 *      key (the same RLS view an anonymous visitor sees) and computes the one
 *      canonical content hash via the shared module;
 *   2. fetches the deployed /seo-manifest.json;
 *   3. asserts the deployed static SEO snapshot (hash + counts + source) matches
 *      the live database.
 *
 * Exit codes: 0 = in sync; 1 = out of sync or the check could not complete;
 * 2 = misconfigured (missing credentials / URL).
 *
 * Run under tsx (imports the shared TS loader/hash):
 *   VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… \
 *   DEPLOY_URL=https://milkpop.uk npm exec --offline -- tsx scripts/seo-live-parity.mjs
 *
 * SECURITY: credentials are never printed. Only the coarse hashes/counts and a
 * pass/fail verdict are logged.
 */
import { loadPublicContent } from './load-public-content';

const env = process.env;

function fail(code, message) {
  console.error(`seo-live-parity: ${message}`);
  process.exit(code);
}

const baseUrl = env.VITE_SUPABASE_URL || env.SEO_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY || env.SEO_SUPABASE_ANON_KEY;
if (!baseUrl || !anonKey) {
  fail(2, 'missing Supabase credentials (set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, or the SEO_* aliases).');
}

// The deployed origin whose /seo-manifest.json we verify.
const site = (env.SEO_MANIFEST_URL
  ? env.SEO_MANIFEST_URL.replace(/\/seo-manifest\.json$/, '')
  : (env.DEPLOY_URL || env.DEPLOY_PRIME_URL || env.URL || env.SITE_URL || 'https://milkpop.uk')
).replace(/\/+$/, '');
const manifestUrl = `${site}/seo-manifest.json`;

async function main() {
  // 1. Live hash from Supabase (production loader → fails closed if unreachable).
  let live;
  try {
    const { metadata } = await loadPublicContent({ mode: 'production', baseUrl, anonKey });
    live = metadata;
  } catch (e) {
    fail(1, `could not read live content from Supabase — ${(e && e.message) || e}`);
  }

  // 2. Deployed manifest.
  let manifest;
  try {
    const res = await fetch(manifestUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) fail(1, `could not fetch ${manifestUrl} (HTTP ${res.status}).`);
    manifest = await res.json();
  } catch (e) {
    fail(1, `could not fetch or parse ${manifestUrl} — ${(e && e.message) || e}`);
  }

  // 3. Compare. Hash is the primary signal; counts + source are corroborating.
  const problems = [];
  if (manifest.source !== 'supabase') {
    problems.push(`deployed manifest source is "${manifest.source}", expected "supabase".`);
  }
  if (manifest.contentHash !== live.contentHash) {
    problems.push(`content hash mismatch: deployed=${manifest.contentHash} live=${live.contentHash}.`);
  }
  const liveCounts = live.counts;
  const depCounts = manifest.counts || {};
  for (const key of ['menuItems', 'stores', 'vacancies', 'publishedNewsPosts']) {
    if (Number(depCounts[key]) !== Number(liveCounts[key])) {
      problems.push(`count mismatch for ${key}: deployed=${depCounts[key]} live=${liveCounts[key]}.`);
    }
  }

  if (problems.length) {
    console.error('seo-live-parity: OUT OF SYNC — the deployed static SEO does not match the live database:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('  Publish a new protected signed release to refresh the static SEO snapshot, then re-run.');
    process.exit(1);
  }

  console.log(
    `seo-live-parity: IN SYNC — deployed SEO matches live Supabase ` +
    `[hash=${live.contentHash}, menu=${liveCounts.menuItems}, stores=${liveCounts.stores}, ` +
    `vacancies=${liveCounts.vacancies}, news=${liveCounts.publishedNewsPosts}] at ${manifestUrl}`,
  );
  process.exit(0);
}

main().catch((e) => fail(1, `unexpected error — ${(e && e.message) || e}`));
