/* r48-till-boundary.test.mjs — R4.8 Workstream I: honest native-till boundary. */
import { readFileSync, existsSync } from 'node:fs';
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('✔', n); };
const bad = (n, d) => { failed++; console.log('✘', n, d || ''); };
const check = (n, c, d) => (c ? ok(n) : bad(n, d));
const readme = readFileSync('README.md', 'utf8');
check('README no longer claims an offline-first iOS till ships/syncs', !/A separate offline-first iOS till app syncs/.test(readme));
check('README states POS/Web Till is retained for later integration', /POS\/Web Till source is retained for later integration/.test(readme));
check('README states no Till route is exposed in the public-web release', /no Till route appears in Staff or Admin navigation/.test(readme));
check('boundary document exists', existsSync('docs/NATIVE-TILL-BOUNDARY.md'));
const b = readFileSync('docs/NATIVE-TILL-BOUNDARY.md', 'utf8');
for (const s of ['Not supplied', 'Not commissioned', 'Connected', 'Compatibility mismatch', 'Healthy'])
  check(`status vocabulary defines "${s}"`, b.includes(s));
check('no fake offline capability via browser caching', /none is faked via browser[\s\S]{1,6}caching/.test(b));
check('compat contract: release/migration/pos-schema/min-native fields', /release_version/.test(b) && /migration_fingerprint/.test(b) && /pos_schema_version/.test(b) && /min_native_app_version/.test(b));
check('unset native version means the native path is refused', /unset = native path refused/.test(b));
const mig = readFileSync('supabase/migration_r48_ops_and_payroll.sql', 'utf8');
check('ops_health derives device signal from pos_devices, unknown when none', /pos_devices/.test(mig) && /not_commissioned/.test(mig));
const runbook = readFileSync('docs/PRODUCTION-LAUNCH-RUNBOOK-v4.8.md', 'utf8');
check('runbook carries the web-till outage procedure', /paper fallback sheet/.test(runbook));
const manifest = JSON.parse(readFileSync('release-manifest.json', 'utf8'));
check('release manifest carries the compat-contract fields (null, not faked)', 'pos_schema_version' in manifest && 'min_native_app_version' in manifest && manifest.min_native_app_version === null);
console.log(`\nR48-TILL-BOUNDARY — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
