#!/usr/bin/env node
/**
 * T13.3.30 exact-incident partial-fresh recovery contract.
 *
 * The recovery is intentionally useful for exactly one known production
 * incident. These source-level checks keep its fingerprint synchronized with
 * the fresh schema/seed and prevent it from drifting into a generic reset tool.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const schema = read('supabase/schema.FRESH-INSTALL-ONLY.sql');
const seed = read('supabase/seed.sql');
const recovery = read('ops/RECOVER-PARTIAL-FRESH-T13.3.28.sql');
const launch = read('launch/launch.sh');
const replay = read('scripts/upgrade-replay.test.sh');

let passed = 0;
let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
  ok ? passed++ : failed++;
};
const uniq = (xs) => [...new Set(xs)].sort();

const schemaTables = uniq([...schema.matchAll(/create\s+table\s+if\s+not\s+exists\s+([a-zA-Z0-9_]+)/gi)].map((m) => m[1]));
const schemaViews = uniq([...schema.matchAll(/create\s+or\s+replace\s+view\s+([a-zA-Z0-9_]+)/gi)].map((m) => m[1]));
const schemaFunctions = uniq([...schema.matchAll(/create\s+or\s+replace\s+function\s+([a-zA-Z0-9_]+)\s*\(/gi)].map((m) => m[1]));
const schemaTypes = uniq([...schema.matchAll(/create\s+type\s+([a-zA-Z0-9_]+)\s+as\s+enum/gi)].map((m) => m[1]));

check('known incident baseline remains 31 tables / 5 views / 2 helpers / 8 enums',
  schemaTables.length === 31 && schemaViews.length === 5 && schemaFunctions.length === 2 && schemaTypes.length === 8);

const expectedArray = (varName) => {
  const re = new RegExp(`${varName}\\s+constant\\s+text\\[\\]\\s*:=\\s*array\\[([\\s\\S]*?)\\]::text\\[\\]`, 'i');
  const block = (recovery.match(re) || ['',''])[1];
  return uniq([...block.matchAll(/'([a-zA-Z0-9_]+)'/g)].map((m) => m[1]));
};
check('recovery requires exact table fingerprint, not merely an allow-list',
  expectedArray('expected_tables').join(',') === schemaTables.join(',') && /table fingerprint mismatch/i.test(recovery));
check('recovery requires exact view fingerprint',
  expectedArray('expected_views').join(',') === schemaViews.join(',') && /view fingerprint mismatch/i.test(recovery));
check('recovery requires exact helper-routine fingerprint',
  expectedArray('expected_routines').join(',') === schemaFunctions.join(',') && /routine fingerprint mismatch/i.test(recovery));
check('recovery requires exact standalone-type fingerprint',
  expectedArray('expected_types').join(',') === schemaTypes.join(',') && /standalone-type fingerprint mismatch/i.test(recovery));

const droppedTables = uniq([...recovery.matchAll(/drop\s+table\s+if\s+exists\s+public\.([a-zA-Z0-9_]+)/gi)].map((m) => m[1]));
const droppedViews = uniq([...recovery.matchAll(/drop\s+view\s+if\s+exists\s+public\.([a-zA-Z0-9_]+)/gi)].map((m) => m[1]));
const droppedFunctions = uniq([...recovery.matchAll(/drop\s+function\s+if\s+exists\s+public\.([a-zA-Z0-9_]+)\s*\(/gi)].map((m) => m[1]));
const droppedTypes = uniq([...recovery.matchAll(/drop\s+type\s+if\s+exists\s+public\.([a-zA-Z0-9_]+)/gi)].map((m) => m[1]));
check('recovery drops exactly the baseline table set', droppedTables.join(',') === schemaTables.join(','));
check('recovery drops exactly the baseline view set', droppedViews.join(',') === schemaViews.join(','));
check('recovery drops exactly the baseline helper set', droppedFunctions.join(',') === schemaFunctions.join(','));
check('recovery drops exactly the baseline enum set', droppedTypes.join(',') === schemaTypes.join(','));

const rowGuardBlock = (recovery.match(/foreach\s+tbl\s+in\s+array\s+array\[([\s\S]*?)\]\s+loop/i) || ['',''])[1];
const guardedTables = uniq([...rowGuardBlock.matchAll(/'([a-zA-Z0-9_]+)'/g)].map((m) => m[1]));
check('every baseline table except site_settings must still be empty',
  guardedTables.join(',') === schemaTables.filter((t) => t !== 'site_settings').join(','));

check('recovery requires exactly one site_settings row',
  /expected exactly one site_settings row/i.test(recovery) && /count\(\*\).*public\.site_settings/is.test(recovery));
for (const literal of [
  "s.brand_name = 'MILK POP'",
  "s.website_url = 'https://milkpop.uk'",
  "s.announcement_enabled is false",
  "s.currency_symbol = '£'",
  's.vat_rate_percent = 0',
  "s.default_opening_hours = ''",
]) {
  check(`site_settings incident fingerprint includes ${literal}`, recovery.includes(literal));
}
check('site_settings recovery fingerprint is tied to the actual production seed identity',
  /values\s*\(1,\s*'MILK POP',[\s\S]*?'https:\/\/milkpop\.uk'/i.test(seed) &&
  /site_settings no longer matches the exact row committed by the known failed seed/i.test(recovery));

check('recovery refuses any Auth bootstrap state',
  /from\s+auth\.users/i.test(recovery) && /Refusing recovery:[^']*Auth user/i.test(recovery));
check('recovery refuses any Storage object',
  /from\s+storage\.objects/i.test(recovery) && /Refusing recovery:[^']*Storage object/i.test(recovery));
check('recovery requires exactly one Storage bucket',
  /expected exactly one Storage bucket/i.test(recovery));
check('recovery requires the exact private cvs bucket',
  /id\s*=\s*'cvs'\s+and\s+name\s*=\s*'cvs'\s+and\s+public\s+is\s+false/i.test(recovery));
check('fresh schema still creates that same private cvs bucket',
  /insert\s+into\s+storage\.buckets\s*\(id,\s*name,\s*public\)[\s\S]*?values\s*\('cvs',\s*'cvs',\s*false\)/i.test(schema));

check('recovery remains migration-ledger gated',
  /to_regclass\('public\.mp_migration_ledger'\)/i.test(recovery) && /Refusing recovery:[^']*mp_migration_ledger exists/i.test(recovery));
check('extension-owned provider objects are excluded from incident and postcondition fingerprints',
  (recovery.match(/pg_catalog\.pg_depend/g) || []).length >= 4 && /d\.deptype\s*=\s*'e'/i.test(recovery));
check('recovery recognizes only the exact Supabase-documented RLS auto-enable safety pair',
  /public\.rls_auto_enable\(\)\/ensure_rls/.test(recovery)
    && /p\.prorettype\s*=\s*'event_trigger'::regtype/.test(recovery)
    && /p\.prosecdef\s+is\s+true/.test(recovery)
    && /pg_get_userbyid\(p\.proowner\)\s*=\s*'postgres'/.test(recovery)
    && /search_path=pg_catalog/.test(recovery)
    && /e\.evtenabled\s*=\s*'O'/.test(recovery)
    && /CREATE TABLE AS/.test(recovery)
    && /SELECT INTO/.test(recovery));
check('recovery excludes only the already-verified RLS helper from MilkPop routine fingerprinting',
  (recovery.match(/p\.proname\s*<>\s*'rls_auto_enable'/g) || []).length >= 2
    && !/drop\s+function\s+if\s+exists\s+public\.rls_auto_enable/i.test(recovery));
check('fresh emptiness applies the same exact RLS safety-pair exception',
  /db_rls_auto_enable_safety_state/.test(launch)
    && /public RLS auto-enable safety helper mismatch/.test(launch)
    && /p\.proname <> 'rls_auto_enable'/.test(launch)
    && /f\.prorettype = 'event_trigger'::regtype/.test(launch)
    && /f\.prosecdef is true/.test(launch)
    && /f\.owner_name = 'postgres'/.test(launch));
check('recovery never drops platform Auth/Storage schemas or extensions',
  !/drop\s+schema\s+(?:if\s+exists\s+)?(?:auth|storage)\b/i.test(recovery) && !/drop\s+extension\b/i.test(recovery));
check('recovery deletes only the proven cvs bucket metadata',
  /delete\s+from\s+storage\.buckets\s+where\s+id\s*=\s*'cvs'/i.test(recovery));
check('recovery postcondition proves public relation/routine/type, Auth and Storage emptiness',
  /Recovery postcondition failed:[^']*public application relation/i.test(recovery) &&
  /Recovery postcondition failed:[^']*public (?:application )?routine/i.test(recovery) &&
  /Recovery postcondition failed:[^']*public standalone type/i.test(recovery) &&
  /Auth users remain/i.test(recovery) && /Storage state remains/i.test(recovery));
check('normal fresh emptiness uses the same provider-state dimensions',
  /pg_catalog\.pg_type/.test(launch) && /auth\.users/.test(launch) && /storage\.objects/.test(launch) && /storage\.buckets/.test(launch));
check('recovery remains one transaction and is not a migration',
  /^\s*begin\s*;/im.test(recovery) && /\bcommit\s*;\s*$/i.test(recovery.trim()) &&
  !/supabase\/migrations/.test('ops/RECOVER-PARTIAL-FRESH-T13.3.28.sql'));
check('PostgreSQL 17 replay executes the canonical recovery SQL, not a mock',
  /RECOVER-PARTIAL-FRESH-T13\.3\.28\.sql/.test(replay)
    && /PSQL < "\$SB\/ops\/RECOVER-PARTIAL-FRESH-T13\.3\.28\.sql"/.test(replay));
check('PostgreSQL replay reconstructs the historical pre-fix incident state',
  /alter table public\.menu_items drop column if exists available/.test(replay)
    && /s0c-site-settings\.sql/.test(replay)
    && /historical partial state has exactly one site_settings seed row/.test(replay));
check('PostgreSQL replay proves changed Auth state refuses recovery before deletion',
  /insert into auth\.users/.test(replay)
    && /Auth state makes recovery fail closed/.test(replay)
    && /refused recovery leaves the partial baseline untouched/.test(replay));
check('PostgreSQL replay proves the exact incident recovers to clean public and Storage state',
  /exact known incident recovery removes every public table/.test(replay)
    && /exact known incident recovery removes Storage state/.test(replay)
    && /exact known incident recovery leaves platform Auth empty/.test(replay));
check('PostgreSQL replay reproduces, validates and preserves the live RLS safety pair',
  /CREATE OR REPLACE FUNCTION public\.rls_auto_enable\(\)/.test(replay)
    && /CREATE EVENT TRIGGER ensure_rls/.test(replay)
    && /malformed RLS safety pair makes recovery fail closed/.test(replay)
    && /fresh rejects malformed RLS safety pair/.test(replay)
    && /fresh accepts and preserves the exact Supabase RLS safety pair/.test(replay));

console.log(`\nPARTIAL FRESH RECOVERY CONTRACT — ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
