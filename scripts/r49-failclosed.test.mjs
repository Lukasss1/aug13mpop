/**
 * r49-failclosed.test.mjs — R4.9 G4 structural guards
 *
 * The public site used to substitute src/data.ts for missing database content,
 * so a failed fetch showed customers real-looking products, prices and offers.
 * The PublicCollection union makes that a type error and eslint.config.mjs makes
 * the seed import an error in the public component. This suite guards the
 * remaining STRUCTURAL properties — the ones a type cannot express.
 *
 * It is deliberately NOT the proof that the site fails closed. A source scan
 * asserts that text appears in a file; only the browser suite
 * (scripts/r49-failclosed.browser.mjs) proves the rendered page. Both run.
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✖ ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const read = (p) => readFileSync(p, 'utf8');

const app = read('src/App.tsx');
const pub = read('src/components/PublicPages.tsx');
const types = read('src/types.ts');
const sync = read('src/lib/cloudSync.ts');
const loader = read('scripts/load-public-content.ts');
const eslintCfg = read('eslint.config.mjs');
const migration = read('supabase/migration_r49_public_menu.sql');

console.log('\nR4.9 G4 — FAIL-CLOSED STRUCTURAL GUARDS\n');

/* --- 1. the idiom itself is gone from every rendering path ---------------- */
// Comments describing the removed idiom are fine; code is not. Strip line and
// block comments before scanning so the guard cannot be defeated OR spuriously
// tripped by prose.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
for (const [name, src] of [['App.tsx', app], ['PublicPages.tsx', pub]]) {
  const code = stripComments(src);
  check(`${name}: no \`|| INITIAL_\` fallback in code`, !/\|\|\s*INITIAL_/.test(code));
  check(`${name}: no \`?? INITIAL_\` fallback in code`, !/\?\?\s*INITIAL_/.test(code));
}

/* --- 2. the union has exactly three states and no escape hatch ------------ */
check('PublicCollection declares loading | ready | unavailable',
  /status:\s*'loading'/.test(types) && /status:\s*'ready';\s*items:\s*T\[\]/.test(types) && /status:\s*'unavailable'/.test(types));
check('…and no member carries a default or fallback array',
  !/status:\s*'unavailable';\s*items/.test(types) && !/status:\s*'loading';\s*items/.test(types));

/* --- 3. the public component cannot reach the seeds ----------------------- */
check('PublicPages imports no INITIAL_ seed constant',
  !/import[\s\S]{0,200}?INITIAL_[A-Z_]+[\s\S]{0,200}?from\s*'\.\.\/data'/.test(pub));
check('eslint makes that import an ERROR, not a warning',
  /files:\s*\['src\/components\/PublicPages\.tsx'\]/.test(eslintCfg) &&
  /'no-restricted-imports':\s*\['error'/.test(eslintCfg));

/* --- 4. the seed branch in App is development-only ------------------------ */
check('the only seed branch is gated on import.meta.env.DEV',
  /import\.meta\.env\.DEV\s*&&\s*import\.meta\.env\.VITE_DEV_SEED_CONTENT\s*===\s*'true'/.test(app));
/* R4.10 Increment 6: the single publicContentState flag became one state PER
   COLLECTION, so an outage is scoped to the surface that failed instead of
   condemning every public collection. Repointed, not relaxed — an unconfigured cloud must still
   report unavailable, now across every collection at once. */
check('…and an unconfigured cloud otherwise reports unavailable',
  /setPublicStates\(allPublicStates\('unavailable'\)\)/.test(app));

/* --- 5. a partial pull is NOT ready --------------------------------------- */
// pullAllFromCloud catches per-table errors and resolves, so a resolved promise
// does not mean the public collections arrived. Marking ready unconditionally
// rendered a failed menu fetch as an EMPTY menu.
/* Stronger than before: readiness is no longer all-or-nothing across a shared
   key list, it is decided per collection from that collection's own key. The
   presence test (undefined/null) is the part that must not regress — an empty
   table legitimately yields [], so presence is the correct signal. */
check('every public collection is scored from its OWN key, by presence',
  /PUBLIC_COLLECTION_KEYS\[name\][\s\S]{0,200}?undefined[\s\S]{0,60}?null/.test(app));
check('…and the key map covers all five public collections',
  ['milkpop_menu_items', 'milkpop_stores_list', 'milkpop_vacancies_list',
   'milkpop_deals', 'milkpop_news_posts']
    .every((k) => new RegExp(`PUBLIC_COLLECTION_KEYS[\\s\\S]{0,400}?'${k}'`).test(app)));

/* --- 6. deals are public price claims and share the same state ------------ */
check('deals start empty, never from INITIAL_DEALS',
  /useState<Deal\[\]>\(\[\]\)/.test(app) && !/useState<Deal\[\]>\(INITIAL_DEALS\)/.test(app));
check('PublicPages receives deals as a PublicCollection',
  /deals:\s*PublicCollection<Deal>/.test(pub));
check('…and renders none unless the collection is ready',
  /deals\.status\s*===\s*'ready'\s*\?\s*deals\.items\.filter/.test(pub));

/* --- 7. anonymous reads go through the views, at runtime AND at build ----- */
check('runtime menu pull reads menu_items_public',
  /readTable:\s*'menu_items_public'/.test(sync));
check('available is omitted from publishes (the server decides)',
  /omit:\s*\[[^\]]*'available'/.test(sync));
check('the prerender fetches menu_items_public, never the base table',
  /'menu_items_public'/.test(loader) && !/anonKey,\s*'menu_items'/.test(loader));
check('the prerender fetches stores_public, never the base table',
  /'stores_public'/.test(loader) && !/anonKey,\s*'stores'/.test(loader));

/* --- 8. the database half actually revokes the base table ----------------- */
check('the migration revokes anon SELECT on menu_items',
  /revoke\s+select\s+on\s+table\s+menu_items\s+from\s+anon/i.test(migration));
check('…and the view is filtered to available rows',
  /create\s+or\s+replace\s+view\s+menu_items_public[\s\S]{0,400}?where\s+available/i.test(migration));
check('…and never exposes tax_code',
  !/tax_code/.test(migration.split('create or replace view')[1]?.split(';')[0] || ''));

/* --- 9. R4.10 P0-2: publishing cannot destroy the hidden catalogue -------- */
const regs = read('src/lib/registries.ts');
check('the staff bundle hydrates the FULL menu, not the anonymous copy',
  /menuItemsFull/.test(regs) && /\['menuItemsFull', \(\) => menuItemsRepo\.list\(token\)\]/.test(regs));
/* R4.10 Increment 5b: the single `menuCatalogueComplete` boolean became a
   per-collection AUTHORITY record bound to identity and hydration generation,
   because every collection with a filtered public read carries the menu's
   hazard. This assertion is repointed, not relaxed — it still requires that the
   anonymous copy is replaced by the full one AND that the replacement is
   recorded, and it now additionally requires the record to be identity-scoped. */
/* SMALL-BIZ CLOSURE P0-5 repoint (repointed, not relaxed — the third time this
   assertion has followed the mechanism it protects). Authority is no longer
   granted by a bare grantAuthority('menu', …) call: it now ALSO requires the
   collection's ledger revision to have arrived in the SAME completed bundle,
   expressed through grantWithRevision(). Identity + generation scoping is
   unchanged and still asserted. */
check('App replaces the anonymous copy with it and records completeness',
  /setMenuItems\(bundle\.menuItemsFull\)/.test(app)
  && /grantWithRevision\('menu', 'menu_items'\)/.test(app)
  && /if \(revMap && revMap\[table\] !== undefined\) grantAuthority\(name, userId, generation\)/
       .test(app.replace(/grantAuthority\(name, authUserId, gen\)/, 'grantAuthority(name, userId, generation)'))
  && /a\.userId === userId && a\.generation === hydrationGeneration/.test(app));
check('the publisher REFUSES until the full catalogue has arrived',
  /if \(!menuCatalogueComplete\)/.test(app) && /return false/.test(app));
/* SMALL-BIZ CLOSURE P0-2 repoint: the inline menu filter became the shared
   public-projection helper, which applies the SAME rule (available === true)
   to the menu and the equivalent anonymous-view rule to every other public
   collection — stores, vacancies, news and deals were previously passed
   UNFILTERED. Asserting all five is strictly stronger than asserting the one
   inline filter this line used to pin. */
check('the public page filters to available even when staff hold the full set',
  /menuItems=\{asPublic\('menu', projectPublicMenuItems\(menuItems\)\)\}/.test(app)
  && /return items\.filter\(\(m\) => m\.available === true\);/.test(read('src/lib/publicProjection.ts')));
check('every other public collection is projected too (P0-2 parity)',
  /stores=\{asPublic\('stores', projectPublicStores\(stores\)\)\}/.test(app)
  && /vacancies=\{asPublic\('vacancies', projectPublicVacancies\(vacancies\)\)\}/.test(app)
  && /news=\{asPublic\('news', projectPublicNews\(newsPosts\)\)\}/.test(app)
  && /deals=\{asPublic\('deals', projectPublicDeals\(deals\)\)\}/.test(app));

/* --- 10. R4.10 P0-9: the recovery executor cannot report a false success -- */
const fn = read('supabase/functions/employee-access-revoke/index.ts');
check('every recovery step carries a typed ok, not a parsed string',
  /type Step = \{ step: string; status: number \| null; ok: boolean/.test(fn));
// The old status-matching regex is quoted in the explanatory comment, so this
// negative assertion must look at CODE only.
check('failure is ANY step not ok — the HTTP-status regex is gone from the code',
  /steps\.some\(\(\w+\) => !\w+\.ok\)/.test(fn) && !/\/:\(4\\d\\d\|5\\d\\d\)\//.test(stripComments(fn)));
check('an unreadable MFA factor list is not treated as an empty one',
  /factor_list_unreadable/.test(fn) && /factor_list_malformed/.test(fn));
check('the outcome and audit writes are checked too',
  /intent_result_record/.test(fn) && /audit_record/.test(fn));

console.log(`\n${fail === 0 ? '✔' : '✖'} R4.9 G4 STRUCTURAL GUARDS — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
