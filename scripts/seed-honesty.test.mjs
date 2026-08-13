#!/usr/bin/env node
/**
 * seed-honesty.test.mjs — PRODUCTION-SEED HONESTY (Phase 1 review)
 *
 * The production database ships from supabase/schema.FRESH-INSTALL-ONLY.sql + supabase/seed.sql.
 * App.tsx hydrates public content straight from those rows, so any fabricated
 * business fact left in the seed is published live. This test fails if the
 * known invented data — a fake company number / VAT / HQ, MILKPOP.RU +
 * placeholder socials, the Solihull / Leicester / Birmingham storefronts, the
 * demo vacancies, invented KB authors, the "Bullring" news post, the broken
 * media record, or the invented ingredient suppliers — ever returns to a
 * production path. It also proves the dev fixtures (seed.dev.sql) stay guarded
 * and out of the migration manifest.
 *
 * Source-level, zero dependencies. Run: npm run test:seed-honesty
 *
 * Scope note: fabricated tokens ARE allowed to appear (a) inside SQL comments
 * in the seed (they explain what was removed), and (b) anywhere in the guarded
 * seed.dev.sql, whose entire purpose is fictional local fixtures. This test
 * scans the seed's EXECUTABLE SQL only (comments stripped) and never treats
 * seed.dev.sql as a production surface.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log(`\u2714 ${n}`); };
const bad = (n, d) => { failed++; console.error(`\u2716 ${n}${d ? `\n    ${d}` : ''}`); };
const check = (n, cond, d) => (cond ? ok(n) : bad(n, d));

/** Remove SQL comments so documentation naming the removed data can't false-fail.
 *  Quote-aware: only strips `--` that begins outside a single-quoted string. */
function stripSqlComments(sql) {
  return sql.split('\n').map((line) => {
    let inStr = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "'") inStr = !inStr;
      else if (!inStr && c === '-' && line[i + 1] === '-') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

const read = (rel) => {
  const p = join(root, rel);
  if (!existsSync(p)) { bad(`missing file: ${rel}`); return ''; }
  return readFileSync(p, 'utf8');
};

const seedRaw = read('supabase/seed.sql');
const schemaRaw = read('supabase/schema.FRESH-INSTALL-ONLY.sql');
const devRaw = read('supabase/seed.dev.sql');
const manifestRaw = read('launch/migration-manifest.sh');

const seed = stripSqlComments(seedRaw).toLowerCase();
const schema = stripSqlComments(schemaRaw).toLowerCase();

// --- 1. No fabricated business facts survive in the executable production seed.
const FORBIDDEN = [
  'milkpop.ru', '@milkpop.shakes', 'milkpop.shakes', 'milkpop.co.uk',
  'solihull', 'leicester', 'birmingham', 'colmore', 'touchwood', 'bullring',
  'highcross', 'homer road', 'daniel cross', 'elena rostova',
  'dairydirect', 'creamco', 'cocoaworks', 'sweetsupplies', 'berryfarm',
  '12093847', '987 654 321', '556 9000', '704 0090', '251 4030', '345 6789',
  '\u041c\u0438\u043b\u043a\u043f\u043e\u043f', // Милкпоп
];
for (const tok of FORBIDDEN) {
  check(`seed.sql contains no "${tok}"`, !seed.includes(tok),
    `fabricated token "${tok}" is present in executable seed SQL`);
}

// --- 2. Production seed ships none of the tables that must start empty.
for (const tbl of ['stores', 'job_vacancies', 'ingredients', 'media_assets']) {
  const re = new RegExp(`insert\\s+into\\s+${tbl}\\b`, 'i');
  check(`seed.sql inserts no ${tbl} rows`, !re.test(seed),
    `production seed must not insert into ${tbl} (owner adds real rows; demo rows live in seed.dev.sql)`);
}

// --- 3. Schema column defaults are honest.
check('schema.FRESH-INSTALL-ONLY.sql: no MILKPOP.RU default', !schema.includes("default 'milkpop.ru'"),
  'website_url still defaults to the fabricated MILKPOP.RU');
check('schema.FRESH-INSTALL-ONLY.sql: no @MILKPOP.SHAKES default', !schema.includes("default '@milkpop.shakes'"),
  'instagram_handle still defaults to a fabricated handle');
check('schema.FRESH-INSTALL-ONLY.sql: website_url defaults to canonical HTTPS root',
  /website_url\s+text\s+not\s+null\s+default\s+'https:\/\/milkpop\.uk'/i.test(schemaRaw),
  'website_url should default to the real canonical HTTPS root');
check('schema.FRESH-INSTALL-ONLY.sql: legal_name defaults blank',
  /legal_name\s+text\s+not\s+null\s+default\s+''/i.test(schemaRaw),
  'the brand must not be inferred as a registered legal entity');

// --- 4. Production seed auto-publishes no news or operational guidance.
check('seed.sql inserts no news_posts rows', !/insert\s+into\s+news_posts\b/i.test(seedRaw),
  'news must be published deliberately by the owner');
for (const tbl of ['checklist_templates', 'training_courses', 'training_assessments', 'kb_articles', 'cms_pages']) {
  const re = new RegExp(`insert\\s+into\\s+${tbl}\\b`, 'i');
  check(`seed.sql inserts no ${tbl} rows`, !re.test(seedRaw),
    `production seed must not insert unreviewed ${tbl} content`);
}
check('starter menu rows are inserted unavailable pending owner review',
  /insert into menu_items \(id, name, description, category, price, price_large, calories, tags, allergens, image, available\) values/i.test(seedRaw)
  && (seedRaw.match(/,'\/brand\/drinks\/[^']+'\s*,\s*false\)/g) || []).length >= 24,
  'every starter product must be unavailable in its initial INSERT');
check('fresh schema provides menu_items.available before seed.sql runs',
  /create table if not exists menu_items\s*\([\s\S]*?\bavailable\s+boolean\s+not\s+null\s+default\s+true[\s\S]*?\);/i.test(schemaRaw),
  'fresh install order is schema -> seed -> migrations, so seed.sql must not reference a column that only a later migration creates');
check('re-running production seed never disables an owner-published catalogue',
  !/update\s+menu_items\s+set\s+available\s*=\s*false/i.test(seedRaw),
  'availability must not be changed after insert; seed replays are non-destructive');
check('starter deals are inactive pending owner review',
  /deal_two_shakes[\s\S]*?false/i.test(seedRaw) && /deal_third_free[\s\S]*?false/i.test(seedRaw));
check('fresh seed uses zero for the historical global VAT rate',
  /false, '', '£', 0,/.test(seedRaw),
  'Milk Pop launches NOT_REGISTERED; the legacy fresh-schema VAT rate must not be 20');

// --- 5. Dev fixtures stay guarded and out of every production path.
check('seed.dev.sql keeps its environment guard',
  /current_setting\('app\.environment'/.test(devRaw) && /raise exception/i.test(devRaw),
  'seed.dev.sql must abort unless app.environment = development');
// (That seed.dev.sql is absent from every production PATH is asserted robustly,
//  array-by-array, in scripts/migration-manifest.test.mjs — not re-checked here
//  by naive string match, since the manifest legitimately NAMES it in a comment
//  explaining why it is excluded.)

// --- 6. The cleanup migration exists and is registered in the future section.
check('cleanup migration exists on disk',
  existsSync(join(root, 'supabase/migration_launch_data_neutralise.sql')));
check('cleanup migration is registered in MP_FUTURE_MIGRATIONS',
  /MP_FUTURE_MIGRATIONS=\([^)]*migration_launch_data_neutralise\.sql/s.test(manifestRaw),
  'append migration_launch_data_neutralise.sql to MP_FUTURE_MIGRATIONS');

// --- 7. No unverified incorporated-entity claim in any shipped source.
//     "Milk Pop UK Limited" was never confirmed as a registered company; the
//     shipped legal name is the trading brand until real incorporation details
//     are supplied by the owner.
for (const rel of ['supabase/seed.sql', 'supabase/schema.FRESH-INSTALL-ONLY.sql', 'src/data.ts', 'src/siteContent.ts']) {
  const txt = read(rel);
  check(`${rel} makes no "Milk Pop UK Limited" legal-entity claim`,
    !/milk pop uk limited/i.test(txt),
    'ships an unverified incorporated-entity name');
}
{
  const m = seedRaw.match(/legal_name[^,]*?'([^']*)'/i) || stripSqlComments(seedRaw).match(/'MILK POP',\s*'([^']*)'/);
  const legal = m ? m[1] : '';
  check('seed.sql legal_name starts blank until the owner verifies it',
    legal === '', `legal_name = ${JSON.stringify(legal)}`);
}

// --- 8. No component writes "N/A" into a public field as a fallback.
{
  const admin = read('src/components/AdminPanel.tsx');
  check('AdminPanel never defaults a public field to "N/A"',
    !/\|\|\s*'N\/A'/.test(admin) && !/\|\|\s*"N\/A"/.test(admin),
    'found a `field || \'N/A\'` default — write \'\' and let the UI hide it');
}

// --- 9. Pre-launch copy: the shipped welcome post and key marketing/legal
//     claims describe a business that does not yet operate.
{
  const dstate = read('src/defaultState.ts');
  for (const [label, txt] of [['seed.sql', seedRaw], ['defaultState.ts', dstate]]) {
    check(`${label} welcome post makes no "already live / find your nearest kiosk" claim`,
      !/website is live/i.test(txt) && !/find your nearest kiosk/i.test(txt),
      'welcome post still implies an operating business');
  }
  const site = read('src/siteContent.ts');
  const CLAIMS = [
    ['delivering targeted advertising', /delivering targeted advertising/i],
    ['legally binding Franchise Disclosure Document on request', /legally binding Franchise Disclosure Document/i],
    ['audited dozens of dairies', /audited dozens of dairies/i],
    ['"currently offering … West Midlands"', /currently offering[^.]*west midlands/i],
    ['"we\'re hiring …"', /we're hiring for our upcoming/i],
  ];
  for (const [label, re] of CLAIMS) {
    check(`siteContent no longer claims ${label}`, !re.test(site), 'unsupported pre-launch claim present');
  }
}

console.log(`\n${failed ? '\u2716' : '\u2714'} seed-honesty: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
