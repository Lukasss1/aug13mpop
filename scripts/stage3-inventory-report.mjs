/* ============================================================================
 * stage3-inventory-report.mjs — renders docs/STAGE3-SCHEMA-INVENTORY.md from
 * the canonical snapshot, INCLUDING the audit findings that drive the later
 * workstreams (temporal types, FKs, money types, RLS coverage, definer
 * hygiene). Findings here are derived from the LIVE effective state.
 * ==========================================================================*/
import { readFileSync, writeFileSync } from 'node:fs';

const [inJson, outMd] = process.argv.slice(2);
const { sections: s } = JSON.parse(readFileSync(inJson, 'utf8'));

const pubCols = s.columns.filter((c) => c.schema === 'public');
const tbl = (rows, cols) => [
  `| ${cols.join(' | ')} |`,
  `|${cols.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${cols.map((c) => String(r[c] ?? '')).join(' | ')} |`),
].join('\n');

/* WS2 — temporal values stored as text */
const temporalName = /(^|_)(date|time|day|month|year)(_|$)|_at$|_on$|timestamp/i;
const textTemporal = pubCols.filter((c) => temporalName.test(c.name)
  && (c.data_type === 'text' || c.data_type === 'character varying'));

/* WS5/6 — money-bearing columns and their representation */
const moneyName = /(pay_rate|price|total|amount|cash|change|fee|cost|revenue|(^|_)vat(_|$)|discount|subtotal|paid|refund|wage|salary|balance)/i;
// WS6d note: name-matched columns whose TYPE is temporal or boolean (e.g. the
// stores/orders VAT lifecycle dates, tax_codes.vat_charged) are definitionally
// not money representations — dates are covered by the WS2 temporal audit and
// flags by their CHECKs — so they are excluded from the money set rather than
// surfacing as false "non-exact money" blockers.
const moneyCols = pubCols.filter((c) => moneyName.test(c.name)
  && !/id$|_type$|_status$|name|note|reason|method|currency|number|avatar/i.test(c.name)
  && !/^(date|timestamp|boolean)/.test(c.data_type));
const moneyBad = moneyCols.filter((c) => !/numeric|integer|bigint|smallint/.test(c.data_type));
const moneyNumericShapes = [...new Set(moneyCols
  .filter((c) => c.data_type === 'numeric')
  .map((c) => `numeric(${c.num_precision},${c.num_scale})`))].sort();

/* WS3 — relationship columns without a foreign key */
const fkDefs = s.constraints.filter((c) => c.type === 'f');
const fkCovered = new Set(fkDefs.map((c) => {
  const m = c.definition.match(/FOREIGN KEY \(([^)]+)\)/i);
  return m ? `${c.table}.${m[1].split(',')[0].trim().replace(/"/g, '')}` : '';
}));
const relName = /(_id$|_by$)/;
const relCols = pubCols.filter((c) => relName.test(c.name) && c.name !== 'id'
  && !/^(request_id|client_id|session_id|device_id|trace_id|idempotency)/.test(c.name));
const relMissing = relCols.filter((c) => !fkCovered.has(`${c.table}.${c.name}`));

/* RLS coverage */
const noRls = s.tables.filter((t) => t.schema === 'public' && !t.rls_enabled);

/* SECURITY DEFINER hygiene */
const definerNoPath = s.functions.filter((f) => f.security_definer
  && !/search_path=/.test(f.config));

/* Unique constraints per table (WS7 input) */
const uniques = s.constraints.filter((c) => c.type === 'u' || c.type === 'p');

const md = `# STAGE 3 — SCHEMA INVENTORY (Workstream 1)

Generated from the LIVE effective state: a disposable PostgreSQL 17 database
after \`schema.FRESH-INSTALL-ONLY.sql\` + the full ${s.migration_ledger.length ? s.migration_ledger.length : 'manifest'}-migration chain
(catalog introspection, not per-file scanning). Canonical machine-readable
detail: \`artifacts/stage3-schema-inventory.json\` — the same snapshot engine
Workstream 14 will use for baseline equivalence.

## Object counts

| Section | Count |
|---|---|
${Object.entries(s).map(([k, v]) => `| ${k} | ${v.length} |`).join('\n')}

## Audit findings feeding Workstreams 2–12

### WS2 — temporal values stored as text (${textTemporal.length})

(\`kb_articles.reading_time\` and \`training_courses.estimated_time\` are
display strings — "5 min read" — not temporal values; they stay text.)

${textTemporal.length ? tbl(textTemporal, ['table', 'name', 'data_type', 'nullable']) : 'None found.'}

### WS3 — relationship-shaped columns WITHOUT a foreign key (${relMissing.length})

${relMissing.length ? tbl(relMissing.map((c) => ({ table: c.table, column: c.name, type: c.data_type })), ['table', 'column', 'type']) : 'None found.'}

Existing foreign keys: ${fkDefs.length} (full definitions + delete rules in the JSON; the
WS3 relationship matrix will classify each).

### WS5/6 — money-bearing columns (${moneyCols.length} found; ${moneyBad.length} non-exact types)

Numeric shapes in use: ${moneyNumericShapes.join(', ') || '—'}
${moneyBad.length ? `\n**Non-exact (float/text) money columns — WS6 blockers:**\n\n${tbl(moneyBad.map((c) => ({ table: c.table, column: c.name, type: c.data_type })), ['table', 'column', 'type'])}` : '\nNo float or text money columns. WS6 standardises precision/scale + bounds.'}

### RLS coverage — public tables WITHOUT row security (${noRls.length})

${noRls.length ? tbl(noRls, ['name']) : 'Every public table has RLS enabled.'}

### SECURITY DEFINER functions without a pinned search_path (${definerNoPath.length})

${definerNoPath.length ? tbl(definerNoPath, ['name', 'args']) : 'All definer functions pin search_path.'}

### WS7 input — primary/unique constraints in force: ${uniques.length}

Per-table detail in the JSON (\`constraints\` where type ∈ {p, u}); the
uniqueness/idempotency audit evaluates the brief's business-key list against
these.

## Notes

- Column-level grants are captured (\`column_grants\`) — the Stage-2.1.2
  staff_profiles surface is part of the canonical state.
- \`migration_ledger\` records dev-chain provenance and is EXCLUDED from the
  WS14 equivalence comparison by design (documented development difference).
- storage.buckets rows are system reference data and part of the baseline.
`;
writeFileSync(outMd, md);
console.log(`report written: ${outMd}`);
console.log(`findings — ws2 text-temporal: ${textTemporal.length}, ws3 missing-fk: ${relMissing.length}, money cols: ${moneyCols.length} (bad: ${moneyBad.length}), no-rls: ${noRls.length}, definer-nopath: ${definerNoPath.length}`);
