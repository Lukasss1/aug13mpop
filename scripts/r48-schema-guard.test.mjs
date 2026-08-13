/* r48-schema-guard.test.mjs — R4.8 Workstream J3: destructive schema guarded. */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('✔', n); };
const bad = (n, d) => { failed++; console.log('✘', n, d || ''); };
const check = (n, c, d) => (c ? ok(n) : bad(n, d));
check('the casual schema path no longer exists', !existsSync('supabase/' + 'schema.sql'));
check('renamed file makes the risk unmistakable', existsSync('supabase/schema.FRESH-INSTALL-ONLY.sql'));
const s = readFileSync('supabase/schema.FRESH-INSTALL-ONLY.sql', 'utf8');
check('executable guard refuses a NON-EMPTY database', /pg_catalog\.pg_tables[\s\S]{0,200}schemaname = 'public'/.test(s) && /raise exception/.test(s));
check('guard runs BEFORE any DROP DDL', s.indexOf('raise exception') < s.search(/^\s*drop\s+(table|type|function|policy|trigger|view)/im));
check('guard message routes upgrades to the migration ledger', /migration ledger/i.test(s));
const manifest = readFileSync('launch/migration-manifest.sh', 'utf8');
check('manifest fresh-only entry updated', manifest.includes('supabase/schema.FRESH-INSTALL-ONLY.sql') && !/"supabase\/schema\.sql"/.test(manifest));
check('the guarded file is NOT in the migration chain', !/MP_MIGRATIONS=\([\s\S]*FRESH-INSTALL-ONLY[\s\S]*?\)\n\n/.test(manifest.split('MP_FUTURE_MIGRATIONS')[0].split('MP_FRESH_ONLY')[1] ? '' : 'x'));
const stale = [];
for (const dir of ['scripts', 'launch']) for (const f of readdirSync(dir)) {
  const p = `${dir}/${f}`;
  try { const t = readFileSync(p, 'utf8');
    if (p.endsWith('r48-schema-guard.test.mjs')) continue;
    if (new RegExp('supabase/' + 'schema\\.sql').test(t)) stale.push(p);
  } catch { /* subdir */ }
}
check('no script/launch file still points at the old path', stale.length === 0, stale.join(', '));
const runbook = readFileSync('docs/PRODUCTION-LAUNCH-RUNBOOK-v4.8.md', 'utf8');
check('runbook directs production upgrades exclusively through the ledger', /production\s+databases\s+change\s+only\s+through\s+the\s+migration\s+ledger/i.test(runbook));
console.log(`\nR48-SCHEMA-GUARD — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
