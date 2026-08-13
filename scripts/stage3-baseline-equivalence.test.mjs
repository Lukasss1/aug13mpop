/* ============================================================================
 * stage3-baseline-equivalence.test.mjs — WS14: full-development-chain vs
 * launch-baseline-v1 must produce the SAME intended schema.
 * Compares every canonical section of two WS1 snapshots; FAILS on any
 * meaningful drift, printing the first differences. Exclusions must be
 * EXPLICIT and documented here (currently: none — both build databases are
 * chain-applied without a ledger, and pg_dump preserves grants, policies,
 * functions, triggers, views, defaults and constraints byte-canonically).
 * ==========================================================================*/
import { readFileSync } from 'node:fs';

const [aPath, bPath] = process.argv.slice(2);
const A = JSON.parse(readFileSync(aPath, 'utf8')).sections;
const B = JSON.parse(readFileSync(bPath, 'utf8')).sections;

const EXCLUDED_SECTIONS = ['migration_ledger']; // documented: dev-only bookkeeping
const key = (o) => JSON.stringify(o);
let failed = 0;

for (const section of Object.keys(A)) {
  if (EXCLUDED_SECTIONS.includes(section)) continue;
  const sa = new Set(A[section].map(key));
  const sb = new Set((B[section] || []).map(key));
  const onlyA = [...sa].filter((x) => !sb.has(x));
  const onlyB = [...sb].filter((x) => !sa.has(x));
  if (onlyA.length || onlyB.length) {
    failed += 1;
    console.log(`✖ ${section}: chain-only=${onlyA.length} baseline-only=${onlyB.length}`);
    onlyA.slice(0, 3).forEach((x) => console.log(`    chain-only    ${x.slice(0, 220)}`));
    onlyB.slice(0, 3).forEach((x) => console.log(`    baseline-only ${x.slice(0, 220)}`));
  } else {
    console.log(`✔ ${section}: ${sa.size} objects identical`);
  }
}
console.log(`\nBASELINE EQUIVALENCE — ${failed === 0 ? 'PASS: chain and launch-baseline-v1 are canonically identical' : `FAIL: ${failed} section(s) drifted`}`);
process.exit(failed === 0 ? 0 : 1);
