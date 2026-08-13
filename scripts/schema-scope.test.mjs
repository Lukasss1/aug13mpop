/**
 * schema-scope.test.mjs — C1.3 audit finding #8.
 *
 * The database schema carries domains beyond the demonstrated launch product
 * (CRM/loyalty, inventory, deep POS, backend logs). This test makes the ONE
 * authoritative classification (supabase/schema-scope.json) enforceable:
 *
 *   • every table declared in schema.FRESH-INSTALL-ONLY.sql or any migration IS classified (so the
 *     registry cannot silently drift as the schema grows);
 *   • the registry has no phantom entries (every classified table exists);
 *   • every scope value is from the allowed set;
 *   • no 'reserved' (future) table is exposed to the anonymous browser role via
 *     the schema.FRESH-INSTALL-ONLY.sql public_read allow-list.
 *
 * Run: npm run test:schema-scope
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SUPA = path.join(REPO, 'supabase');

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`\u2714 ${name}`); }
  else { failed++; console.error(`\u2716 ${name}${detail ? `\n    ${detail}` : ''}`); }
};

/* ---- tables actually declared in SQL ------------------------------------- */
const sqlFiles = readdirSync(SUPA).filter((f) => f.endsWith('.sql')).map((f) => path.join(SUPA, f));
const declared = new Set();
const RE = /create table (?:if not exists )?(?:public\.)?([a-z_][a-z0-9_]*)/gi;
for (const f of sqlFiles) {
  const sql = readFileSync(f, 'utf8');
  let m;
  while ((m = RE.exec(sql))) declared.add(m[1]);
}

/* ---- the registry -------------------------------------------------------- */
const registry = JSON.parse(readFileSync(path.join(SUPA, 'schema-scope.json'), 'utf8'));
const classified = registry.tables || {};
const SCOPES = new Set(Object.keys(registry.scopes || {}));
const classifiedNames = new Set(Object.keys(classified));

/* 1. completeness — every declared table is classified. */
const unclassified = [...declared].filter((t) => !classifiedNames.has(t)).sort();
check('every table declared in SQL is classified in schema-scope.json',
  unclassified.length === 0, unclassified.length ? `missing: ${unclassified.join(', ')}` : '');

/* 2. no phantom entries — every classified table is really declared. */
const phantom = [...classifiedNames].filter((t) => !declared.has(t)).sort();
check('schema-scope.json has no phantom (non-existent) tables',
  phantom.length === 0, phantom.length ? `phantom: ${phantom.join(', ')}` : '');

/* 3. valid scope values. */
const badScope = Object.entries(classified).filter(([, v]) => !SCOPES.has(v.scope)).map(([k]) => k);
check('every table has a scope from the declared set',
  badScope.length === 0, badScope.length ? `bad scope: ${badScope.join(', ')}` : '');

/* 4. no reserved (future) table is anon-readable via schema.FRESH-INSTALL-ONLY.sql public_read. */
const schema = readFileSync(path.join(SUPA, 'schema.FRESH-INSTALL-ONLY.sql'), 'utf8');
// The anon read allow-list is the array in the "Public website content" block.
const anonBlock = schema.match(/Public website content[\s\S]*?foreach t in array array\[([\s\S]*?)\]/);
const anonReadable = anonBlock
  ? [...anonBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  : [];
const reserved = new Set(Object.entries(classified).filter(([, v]) => v.scope === 'reserved').map(([k]) => k));
const leaked = anonReadable.filter((t) => reserved.has(t));
check('no reserved (future) table is exposed to the anon browser role',
  leaked.length === 0, leaked.length ? `anon-readable reserved tables: ${leaked.join(', ')}` : '');
check('the anon public_read allow-list was located in schema.FRESH-INSTALL-ONLY.sql', anonReadable.length > 0);

console.log(`\n${failed ? '\u2716' : '\u2714'} schema-scope: ${passed} passed, ${failed} failed (${declared.size} tables declared, ${classifiedNames.size} classified)`);
if (failed) process.exit(1);
