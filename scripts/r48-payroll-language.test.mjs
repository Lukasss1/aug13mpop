/* r48-payroll-language.test.mjs — R4.8 Workstream O: estimates ≠ statutory payroll. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('✔', n); };
const bad = (n, d) => { failed++; console.log('✘', n, d || ''); };
const check = (n, c, d) => (c ? ok(n) : bad(n, d));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const ap = strip(readFileSync('src/components/AdminPanel.tsx', 'utf8'));
const sp = strip([
  readFileSync('src/components/StaffPortal.tsx', 'utf8'),
  ...readdirSync('src/components/staff')
    .filter((name) => name.endsWith('.tsx'))
    .sort()
    .map((name) => readFileSync(path.join('src/components/staff', name), 'utf8')),
].join('\n'));
// USER-FACING strings must not present internal figures as payslips.
// Identifiers/table names (payslips, Payslip type) legitimately remain.
// Labels contain spaces / read as prose; bare identifiers ('payslips' tab id,
// Payslip type refs) are wire/type names and legitimately remain.
const quoted = /(['"`][^'"`\n]*\bpayslips?\b[^'"`\n]*['"`])/gi;
const jsxText = />[^<>{}\n]*\bPayslips?\b[^<>{}\n]*</g;
const offenders = (src, file) => [
  ...[...src.matchAll(quoted)].map((m) => m[1]).filter((s) => /[ &]/.test(s.slice(1, -1))),
  ...[...src.matchAll(jsxText)].map((m) => m[0]),
].map((t) => `${file}: ${t.trim().slice(0, 60)}`);
const hits = [...offenders(ap, 'AdminPanel'), ...offenders(sp, 'StaffPortal')]
  .filter((h) => !/official payroll documents/.test(h));
check('no user-facing string presents figures as a "payslip"', hits.length === 0, hits.slice(0, 4).join(' | '));
check('the estimates disclaimer remains in the staff view', /not official payroll documents/.test(sp));
check('admin actions speak of earnings estimates', /earnings estimate/i.test(ap));
const sql = readFileSync('supabase/migration_r48_ops_and_payroll.sql', 'utf8');
check('every internal figure row is typed (kind: estimate default)', /kind text not null default 'estimate'/.test(sql));
check('official provider results are a separate typed kind', /'official_reference'/.test(sql));
check('approved-hours export boundary exists (payroll_export_batches)', /create table if not exists payroll_export_batches/.test(sql));
check('export status lifecycle is explicit', /'draft','exported','provider_confirmed','superseded'/.test(sql));
check('daily close: one per store-date unless correcting', /idx_daily_close_once[\s\S]{0,120}where corrects_close_id is null/.test(sql));
check('daily close: cash variance is COMPUTED, never typed in', /cash_variance[\s\S]{0,60}generated always as \(cash_counted - cash_expected\) stored/.test(sql));
check('daily close is append-only (no update/delete policy exists)', !/create policy [^;]*on daily_closes[^;]*for (update|delete)/i.test(sql));
check('corrections reference the original with a reason', /corrects_close_id/.test(sql) && /correction_reason/.test(sql));
console.log(`\nR48-PAYROLL — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
