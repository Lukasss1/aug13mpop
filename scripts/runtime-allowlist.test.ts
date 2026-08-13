/**
 * runtime-allowlist.test.ts — RUNTIME proof (not just static grep) that the
 * public-insert helper cannot target internal tables.
 *
 * Imports the real module and calls the real guard:
 *   - every allowlisted table passes;
 *   - every internal/sensitive table name throws;
 *   - the allowlist is exactly the three public form tables.
 *
 * Run with:  npm run test:allowlist   (uses tsx; needs devtool download)
 *       or:  tsx scripts/runtime-allowlist.test.ts
 *
 * Safe to run in Node: the module only touches localStorage inside its
 * import.meta.env.DEV branch, which is inert here (env is undefined → {}).
 */
import { PUBLIC_INSERT_TABLES, assertPublicInsertTable } from '../src/lib/supabase';

let passed = 0;
let failed = 0;
const ok = (name: string) => { passed++; console.log(`✔ ${name}`); };
const fail = (name: string, detail: string) => { failed++; console.error(`✖ ${name}\n    ${detail}`); };

// 1. The allowlist is exactly the three public form tables.
const expected = ['job_applications', 'franchise_inquiries', 'contact_messages'].sort();
const actual = [...PUBLIC_INSERT_TABLES].sort();
if (JSON.stringify(actual) === JSON.stringify(expected)) ok('allowlist is exactly the three public form tables');
else fail('allowlist is exactly the three public form tables', `got ${JSON.stringify(actual)}`);

// 2. Allowlisted names pass the runtime guard.
for (const t of PUBLIC_INSERT_TABLES) {
  try {
    assertPublicInsertTable(t);
    ok(`guard accepts allowlisted table "${t}"`);
  } catch (e) {
    fail(`guard accepts allowlisted table "${t}"`, String(e));
  }
}

// 3. Internal / sensitive / hostile table names are rejected at runtime.
const forbidden = [
  'staff_profiles', 'payslips', 'clock_history', 'work_shifts', 'orders',
  'audit_logs', 'app_state', 'sifr_reports', 'staff_documents', 'customers',
  'site_settings', 'role_permissions',
  'job_applications; drop table staff_profiles;--',
  'JOB_APPLICATIONS', ' job_applications', 'job_applications ',
];
for (const t of forbidden) {
  try {
    assertPublicInsertTable(t);
    fail(`guard rejects "${t}"`, 'no error was thrown');
  } catch {
    ok(`guard rejects "${t}"`);
  }
}

console.log(`\n${failed === 0 ? '✔ RUNTIME ALLOWLIST TEST PASSED' : '✖ RUNTIME ALLOWLIST TEST FAILED'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
