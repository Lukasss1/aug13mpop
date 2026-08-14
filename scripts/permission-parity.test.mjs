/* ============================================================================
 * permission-parity.test.mjs — the UI ↔ DATABASE permission matrix (audit M5)
 *
 * The Stage-2 audit's root process failure: the admin UI declared areas
 * owner-only while the database granted them to every manager. The database
 * is the boundary; the UI is the promise. This suite pins BOTH sides of one
 * declared matrix so any future drift — either direction — fails verify.
 *
 * UI side:  allowedRoles parsed from the pure adminNavigation registry.
 * DB side:  the FINAL policy definition per (table, policy) in manifest
 *           order (supersede-in-place chain), matched against a predicate.
 * ==========================================================================*/
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let passed = 0, failed = 0;
const check = (n, cond, d = '') => {
  console.log(`${cond ? '✔' : '✖'} ${n}${cond ? '' : `\n    ${d}`}`);
  if (cond) passed++; else failed++;
};

/* ---- final policy definitions (manifest order; drops tracked) ------------ */
const files = execFileSync('bash', ['launch/migration-manifest.sh', 'fresh'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
const finals = new Map();
for (const f of files) {
  if (!existsSync(f)) continue;
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/create policy\s+(\w+)\s+on\s+(\w+)[\s\S]*?;/g)) finals.set(`${m[2]}.${m[1]}`, m[0]);
  // Expand DO-block loops (policies created via execute format(...%I...)).
  for (const blk of src.matchAll(/foreach t in array array\[([\s\S]*?)\][\s\S]*?end loop;/g)) {
    const tables = [...blk[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
    for (const fmt of blk[0].matchAll(/format\(\s*((?:'[^']*'\s*)+)/g)) {
      const sql = [...fmt[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).join('');
    for (const tbl of tables) {
      const inst = sql.replace(/%I/g, tbl);
      const c = inst.match(/create policy\s+(\w+)\s+on\s+(\w+)/);
      if (c) finals.set(`${c[2]}.${c[1]}`, inst);
      const dnp = inst.match(/drop policy if exists\s+(\w+)\s+on\s+(\w+)/);
      if (dnp && !inst.includes('create policy')) finals.delete(`${dnp[2]}.${dnp[1]}`);
      }
    }
    }
  for (const d of src.matchAll(/drop policy if exists\s+(\w+)\s+on\s+(\w+)/g)) {
    if (!src.slice(d.index).match(new RegExp(`create policy\\s+${d[1]}\\s+on\\s+${d[2]}`))) finals.delete(`${d[2]}.${d[1]}`);
  }
}
const fin = (k) => finals.get(k) || '';
const noPolicies = (tbl) => ![...finals.keys()].some((k) => k.startsWith(`${tbl}.`));

/* ---- UI side: allowedRoles per section id -------------------------------- */
const adm = readFileSync('src/components/AdminPanel.tsx', 'utf8');
const admNav = readFileSync('src/components/admin/adminNavigation.ts', 'utf8');
const uiRoles = (id) => {
  const at = admNav.indexOf(`${id}: {`);
  if (at < 0) return '(section missing)';
  const obj = admNav.slice(at, admNav.indexOf('}', at));
  const own = obj.match(/allowedRoles: \[([^\]]*)\]/);
  return own ? [...own[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort().join(',') : '(no roles found)';
};

/* ---- THE MATRIX ----------------------------------------------------------- */
const OWNER = 'owner';
const BOTH = 'owner,store_manager';
const rows = [
  ['Earnings Estimates (payroll admin)', 'payslips', OWNER,
    () => /is_owner\(\)/.test(fin('payslips.payslips_write_owner'))
       && finals.has('payslips.payslips_select_self')
       && ![...finals.entries()].some(([k, b]) => k.startsWith('payslips.') && /is_manager_or_owner|is_store_manager/.test(b)),
    'payslips must be owner-all + self-only; no manager-wide read may exist'],
  ['Customer Messages (contact inbox)', 'contact', OWNER,
    () => /is_owner\(\)/.test(fin('contact_messages.contact_select_owner')) && !finals.has('contact_messages.contact_select_mgr'),
    'contact_messages reads must be owner-only'],
  ['Franchise Leads', 'franchise', OWNER,
    () => /is_owner\(\)/.test(fin('franchise_inquiries.franchise_select_owner')),
    'franchise reads must be owner-only'],
  ['Deals & Combos', 'deals', OWNER,
    () => /is_owner\(\)/.test(fin('deals.content_write_owner')) && !finals.has('deals.content_write_mgr'),
    'deals writes must be owner-only'],
  ['Job Applications (store-scoped for managers)', 'careers', BOTH,
    () => /is_store_manager\(\)/.test(fin('job_applications.applications_select_mgr'))
       && /applied_store <> ''/.test(fin('job_applications.applications_select_mgr')),
    'application reads must be owner-or-own-store'],
  ['Menu publication (shipped manager feature, MFA-gated)', 'menu', BOTH,
    () => /is_manager_or_owner\(\)/.test(fin('menu_items.menu_write_mgr'))
       && !finals.has('menu_items.content_write_owner') && !finals.has('menu_items.content_write_mgr'),
    'menu writes must be manager+owner via the AAL2 helper'],
];
for (const [label, id, expectedUi, dbOk, why] of rows) {
  check(`UI: '${label}' is declared for [${expectedUi}]`, uiRoles(id) === expectedUi,
    `Admin navigation declares [${uiRoles(id)}]`);
  check(`DB: '${label}' final policies match the declaration`, dbOk(), why);
}

/* Owner-only content the UI never exposes to managers at all (group-gated). */
for (const tbl of ['site_settings', 'news_posts', 'media_assets', 'cms_pages', 'job_vacancies', 'stores']) {
  check(`DB: '${tbl}' writes are owner-only in the final chain`,
    /is_owner\(\)/.test(fin(`${tbl}.content_write_owner`)) && !finals.has(`${tbl}.content_write_mgr`),
    'a manager-writable public-content final survives');
}

/* Reserved domains: no UI section may exist AND no browser policy may exist. */
for (const tbl of ['customers', 'loyalty_transactions', 'ingredients', 'stock_movements']) {
  check(`RESERVED: '${tbl}' has no browser policies and no admin section`,
    noPolicies(tbl) && !new RegExp(`(?:id: |^\\s*)'?'${tbl}'?`).test(admNav) && !new RegExp(`id: '${tbl}'`).test(adm),
    'reserved domain resurfaced');
}

console.log(`\nPERMISSION PARITY MATRIX — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
