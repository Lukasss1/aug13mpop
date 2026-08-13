/* r48-truth.test.mjs — R4.8 Workstream A: no fabricated production state.
 * Static, zero-dependency. Comments are stripped before scanning so banned
 * phrases may be DOCUMENTED but never RENDERED. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('✔', n); };
const fail = (n, d) => { failed++; console.log('✘', n, d ? `— ${d}` : ''); };
const check = (n, c, d) => (c ? ok(n) : fail(n, d));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const sp = strip([
  readFileSync('src/components/StaffPortal.tsx', 'utf8'),
  ...readdirSync('src/components/staff')
    .filter((name) => name.endsWith('.tsx'))
    .sort()
    .map((name) => readFileSync(path.join('src/components/staff', name), 'utf8')),
].join('\n'));
const ap = strip(readFileSync('src/components/AdminPanel.tsx', 'utf8'));
const ad = strip(readFileSync('src/components/admin/adminDashboard.ts', 'utf8'));
const cp = readFileSync('src/components/CompliancePanel.tsx', 'utf8');
for (const [name, hay, bad] of [
  ['StaffPortal: no hardcoded "Exp. 2027"', sp, 'Exp. 2027'],
  ['StaffPortal: no hardcoded compliance summary', sp, 'All core compliance documentation is up to date'],
  ['StaffPortal: no invented Flagship Bar suffix', sp, 'Flagship Bar`'],
  ['StaffPortal: no "fully allocated" roster claim', sp, 'fully allocated'],
  ['AdminPanel: no "Just now" alert time', ap, "'Just now'"],
  ['AdminPanel: no "5 mins ago" alert time', ap, "'5 mins ago'"],
  ['AdminPanel: no "1 hour ago" alert time', ap, "'1 hour ago'"],
  ['AdminPanel: no hardcoded Offer Made count', ap, 'h: 30, count: 2'],
  ['AdminPanel: no fabricated 150-point fallback', ap, 'emp.points || 150'],
]) check(name, !hay.includes(bad), `found ${JSON.stringify(bad)}`);
check('StaffPortal renders the derived CompliancePanel', sp.includes('<CompliancePanel'));
check('CompliancePanel: absence renders "Not recorded"', cp.includes("Not recorded"));
check('CompliancePanel: failure renders an honest unavailable state', /unavailable/i.test(cp));
check('CompliancePanel: expiry derives from server-computed effective_status', cp.includes('effective_status'));
check('CompliancePanel: no hardcoded green default', !/verified.*default/i.test(cp.split('STATUS_META')[0]));
check('Admin dashboard alerts derive from record timestamps', ad.includes('newestRecord('));
check('Admin dashboard alerts carry source entity metadata', ad.includes('sourceType') && ad.includes('sourceId'));
check('Admin dashboard alerts admit missing timestamps honestly', ad.includes('time not recorded'));
check('Recruitment chart computes every bar from status counts', ad.includes("application.status === 'offer'"));
check('Recruitment chart renders zero as zero height', /bar\.count === 0 \? 0/.test(ad));
const sql = readFileSync('supabase/migration_r48_truth_and_people.sql', 'utf8');
check('DB: a record can never be verified by its subject (CHECK)', /compliance_no_self_verify/.test(sql));
check('DB: verify RPC refuses self-verification', /self_verification_forbidden/.test(sql));
check('DB: document upload alone never verifies (verify is a distinct audited act)', /compliance_record_verify/.test(sql) && /'compliance.verified'/.test(sql));
console.log(`\nR48-TRUTH — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
