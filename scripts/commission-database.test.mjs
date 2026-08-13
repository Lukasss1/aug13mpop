#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const launch = readFileSync('launch/launch.sh', 'utf8');
const wrapper = readFileSync('scripts/commission-database.sh', 'utf8');
const checks = [
  ['noninteractive mode is explicit', /MP_NONINTERACTIVE:-0/.test(launch)],
  ['noninteractive gates require named exact values', /supplied.*want/.test(launch)],
  ['fresh confirmation is named', /MP_CONFIRM_FRESH_INSTALL/.test(launch)],
  ['resume confirmation is named', /MP_CONFIRM_RESUME_INSTALL/.test(launch) && /--db-resume-install/.test(launch)],
  ['backup confirmation is named', /MP_CONFIRM_BACKUP/.test(launch)],
  ['upgrade confirmation is named', /MP_CONFIRM_APPLY_MIGRATIONS/.test(launch)],
  ['adopt confirmation is named', /MP_CONFIRM_ADOPT_BASELINE/.test(launch)],
  ['database runner does not self-certify live RLS', !/MP_CONFIRM_RLS_VERIFIED/.test(wrapper) && /Live role\/store verification remains a separate production commissioning gate/.test(launch)],
  ['wrapper verifies exact project ref', /CONFIRM_REF.*==.*REF/.test(wrapper)],
  ['wrapper binds DB URL to project ref with exact parser', /validate-supabase-db-target\.mjs/.test(wrapper) && /MP_SUPABASE_PROJECT_REF=\"\$REF\"/.test(wrapper)],
  ['operator guidance supports the GitHub Session Pooler path', /Session Pooler URI/.test(launch)],
  ['fresh destructive phrase includes project ref', /ERASE AND INSTALL \$REF/.test(wrapper)],
  ['known-partial recovery phrase includes project ref', /RECOVER KNOWN PARTIAL \$REF/.test(wrapper)],
  ['known-partial recovery uses the one canonical incident SQL', /RECOVER-PARTIAL-FRESH-T13\.3\.28\.sql/.test(wrapper) && /RECOVERY_SQL_SOURCE/.test(wrapper)],
  ['known-partial recovery is fail-closed under psql ON_ERROR_STOP', /psql \"\$URL\" -X -v ON_ERROR_STOP=1 -f/.test(wrapper) && /known-partial recovery refused or failed/.test(wrapper)],
  ['resume phrase includes project ref', /RESUME INSTALL \$REF/.test(wrapper)],
  ['upgrade phrase includes project ref', /APPLY MIGRATIONS \$REF/.test(wrapper)],
  ['adopt phrase includes project ref', /ADOPT EXISTING BASELINE \$REF/.test(wrapper)],
];
let passed = 0;
for (const [name, condition] of checks) {
  try { assert.equal(condition, true); passed += 1; console.log(`PASS ${name}`); }
  catch { console.error(`FAIL ${name}`); process.exitCode = 1; }
}
if (!process.exitCode) console.log(`DATABASE COMMISSION CONTRACT — ${passed}/${checks.length} passed`);
