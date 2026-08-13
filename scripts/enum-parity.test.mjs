/**
 * Phase 1 · Stage 7 (7.6) — frontend ↔ database enum parity.
 *
 * The exit criteria require automated detection of drift between the frontend's
 * status/type unions and the database's CHECK constraints. `collection-contract`
 * checks that a column EXISTS; `schema-scope` checks table-level RLS scope; but
 * nothing guarded the *value sets* of each enum. This does.
 *
 * Method: for each domain enum we declare its canonical value set, then assert
 * that an identical set appears BOTH as a `check (col in (...))` in the SQL and
 * as a `'a' | 'b' | ...` union in the TypeScript. Matching is by EXACT set
 * equality, so enums that legitimately share values (e.g. shift `type` uses
 * opening/mid/closing/delivery/training while checklist `category` uses
 * opening/midday/closing) never collide. Changing either side without updating
 * the other — or this canonical list — fails the check.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = (arr) => [...new Set(arr)].sort().join('|');

/* ---- collect every CHECK (col IN (...)) value set from the SQL ------------ */
function sqlFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? sqlFiles(p) : p.endsWith('.sql') ? [p] : [];
  });
}
const dbSets = new Set();
for (const f of sqlFiles(path.join(ROOT, 'supabase'))) {
  const sql = readFileSync(f, 'utf8');
  for (const m of sql.matchAll(/check\s*\(\s*[a-z_]+\s+in\s*\(([^)]*)\)/gi)) {
    const vals = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    if (vals.length) dbSets.add(key(vals));
  }
}

/* ---- collect every string-literal union set from the frontend ------------- */
function tsFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    if (n === 'node_modules') return [];
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}
const feSets = new Set();
for (const f of tsFiles(path.join(ROOT, 'src'))) {
  const ts = readFileSync(f, 'utf8');
  for (const m of ts.matchAll(/'[^']*'(?:\s*\|\s*'[^']*')+/g)) {
    const vals = [...m[0].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    if (vals.length >= 2) feSets.add(key(vals));
  }
}

/* ---- the canonical enums that MUST agree on both sides -------------------- */
const ENUMS = [
  ['job application status',      ['pending', 'reviewing', 'interview', 'offer', 'declined']],
  ['contact / franchise status',  ['pending', 'reviewed', 'contacted', 'approved', 'declined']],
  ['SIFR report status',          ['submitted', 'under_review', 'escalated', 'action_required', 'resolved', 'closed']],
  ['timesheet approval status',   ['approved', 'pending', 'action_required']],
  ['work shift type',             ['opening', 'mid', 'closing', 'delivery', 'training']],
  ['checklist category',          ['opening', 'midday', 'closing']],
  ['vacancy type',                ['Full-time', 'Part-time']],
  ['mailing draft/sent status',   ['draft', 'sent']],
  ['collection publish status',   ['draft', 'published']],
  ['employee status',             ['active', 'disabled']],
  ['training assignment status',  ['assigned', 'in_progress', 'completed']],
  ['store VAT status (WS6d)',     ['NOT_REGISTERED', 'REGISTERED']],
  ['product tax code (WS6d)',     ['ZERO_RATED', 'STANDARD_RATE', 'REDUCED_RATE', 'OUTSIDE_SCOPE']],
  ['store setup status (WS6e)',   ['DRAFT', 'ACTIVE']],
];

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `  — ${detail}`}`);
  if (!ok) failed++;
};

for (const [label, values] of ENUMS) {
  const k = key(values);
  check(`DB has a CHECK constraint for ${label}`, dbSets.has(k), `no SQL "check (col in (...))" with exactly {${k}}`);
  check(`frontend union matches DB for ${label}`, feSets.has(k), `no TS union with exactly {${k}} — frontend/DB drift`);
}

console.log(`\n${failed ? `✖ ${failed} enum-parity problem(s)` : `✔ all ${ENUMS.length} enums in frontend↔DB parity`}`);
if (failed) process.exit(1);
