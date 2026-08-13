#!/usr/bin/env node
/**
 * collection-contract.test.mjs — CLIENT ⇄ DATABASE COLUMN CONTRACT
 *
 * The app persists whole collections by handing a JSON object to
 * `replace_collection`, which turns EVERY key (camelCase → snake_case via
 * lib/supabase.ts:toRow) into a target column. If a frontend model carries a
 * field the table has no column for, the write is rejected by PostgreSQL at
 * runtime — a failure the source/typecheck gates cannot see.
 *
 * This test parses each Admin-written public collection's TypeScript model and
 * its target table's columns, and fails if any persisted field has no column.
 * (It would have caught the vacancy `status` field that had no
 * job_vacancies.status column.)
 *
 * Zero dependencies. Run: npm run test:collection-contract
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log(`\u2714 ${n}`); };
const bad = (n, d) => { failed++; console.error(`\u2716 ${n}${d ? `\n    ${d}` : ''}`); };

const camelToSnake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

/** Top-level field names of an `export interface Name { ... }`, brace-depth
 *  aware so nested object fields (e.g. deliveryLinks/coordinates) are ignored. */
function interfaceFields(src, name) {
  const start = src.indexOf(`export interface ${name}`);
  if (start === -1) throw new Error(`interface ${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0, i = open, body = '';
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { body = src.slice(open + 1, i); break; } }
  }
  const fields = [];
  let d = 0;
  for (let line of body.split('\n')) {
    const trimmed = line.trim();
    // capture a field only at the interface's top level (before adjusting depth)
    if (d === 0) {
      const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/);
      if (m && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) {
        fields.push(m[1]);
      }
    }
    for (const c of line) { if (c === '{') d++; else if (c === '}') d--; }
  }
  return fields;
}

/** Column names of a `create table if not exists <t> ( ... )` block. */
function tableColumns(schema, table) {
  const re = new RegExp(`create table if not exists ${table}\\s*\\(`, 'i');
  const m = re.exec(schema);
  if (!m) throw new Error(`table ${table} not found`);
  const open = schema.indexOf('(', m.index);
  let depth = 0, body = '';
  for (let i = open; i < schema.length; i++) {
    const ch = schema[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) { body = schema.slice(open + 1, i); break; } }
  }
  const cols = [];
  for (const raw of body.split('\n')) {
    const line = raw.split('--')[0].trim();
    const m2 = line.match(/^([a-z_][a-z0-9_]*)\s+/i);
    if (!m2) continue;
    const kw = m2[1].toLowerCase();
    if (['primary', 'unique', 'foreign', 'constraint', 'check'].includes(kw)) continue;
    cols.push(m2[1]);
  }
  return cols;
}

/* WS6d: the REAL schema is chain-defined — columns added by migrations
   (`alter table t add column if not exists c …`) are as much part of the
   contract as the schema.FRESH-INSTALL-ONLY.sql body. Union them in so a TS field that maps to
   a chain-added column (e.g. StoreLocation's read-only VAT lifecycle
   fields) is recognised instead of failing as "no column". */
function chainAddedColumns(dir, table) {
  const cols = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.sql')) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    /* R4.10: `if not exists` made OPTIONAL. The chain guards idempotency two
       ways — inline (`add column if not exists c`) and with an OUTER
       existence check around a plain `add column c` (how INC5a added
       job_vacancies.status / media_assets.is_public). This function's own
       header promises that chain-added columns count as contract; matching
       only one guard style silently broke that promise for the other. */
    const re = new RegExp(
      `alter\\s+table\\s+${table}\\s+add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?([a-z_][a-z0-9_]*)`, 'gi');
    for (const m of sql.matchAll(re)) cols.push(m[1]);
  }
  return cols;
}

const types = readFileSync(join(root, 'src/types.ts'), 'utf8');
const schema = readFileSync(join(root, 'supabase/schema.FRESH-INSTALL-ONLY.sql'), 'utf8');

// Admin-written public collections: model interface → table → fields the sync
// map omits (never persisted). Keep in step with SYNC_MAP in lib/cloudSync.ts.
const CONTRACTS = [
  { model: 'StoreLocation', table: 'stores', omit: [] },
  { model: 'CareerVacancy', table: 'job_vacancies', omit: [] },
];

for (const { model, table, omit } of CONTRACTS) {
  let fields, cols;
  try { fields = interfaceFields(types, model); cols = [...new Set([...tableColumns(schema, table), ...chainAddedColumns(join(root, 'supabase'), table)])]; }
  catch (e) { bad(`${model} → ${table}: parse`, e.message); continue; }
  const colSet = new Set(cols);
  const missing = fields
    .filter((f) => !omit.includes(f))
    .map((f) => ({ field: f, col: camelToSnake(f) }))
    .filter(({ col }) => !colSet.has(col));
  if (missing.length === 0) {
    ok(`${model} → ${table}: all ${fields.length} persisted fields map to columns`);
  } else {
    bad(`${model} → ${table}: fields with no column`,
      missing.map(({ field, col }) => `${field} → ${col}`).join(', ')
      + ` (columns: ${cols.join(', ')})`);
  }
}

console.log(`\n${failed ? '\u2716' : '\u2714'} collection-contract: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
