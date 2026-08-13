#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const script = readFileSync('scripts/lint-ratchet.mjs', 'utf8');
const baseline = JSON.parse(readFileSync('scripts/lint-ratchet-baseline.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const checks = [
  ['lint uses the code-owned ratchet', pkg.scripts.lint === 'node scripts/lint-ratchet.mjs'],
  ['verify checks and runs the ratchet', pkg.scripts.verify.includes('npm run test:lint-ratchet && npm run lint')],
  ['legacy warning ceiling cannot increase', Number.isInteger(baseline.maximumWarnings) && baseline.maximumWarnings <= 239],
  ['new launch modules are warning-free', ['src/components/PublicWebsiteEditBar.tsx','src/components/admin/BusinessActionDialog.tsx','src/lib/publicDataValidation.ts'].every((p) => baseline.zeroWarningPaths.includes(p))],
  ['ESLint errors always fail', /errors\.length/.test(script) && /process\.exit\(1\)/.test(script)],
  ['warning growth fails', /warnings\.length > baseline\.maximumWarnings/.test(script)],
  ['machine-readable evidence is retained', /artifacts\/eslint\.json/.test(script)],
];
let passed=0;
for (const [name, ok] of checks) {
  try { assert.equal(ok, true); passed += 1; console.log(`PASS ${name}`); }
  catch { console.error(`FAIL ${name}`); process.exitCode = 1; }
}
if (!process.exitCode) console.log(`LINT RATCHET CONTRACT — ${passed}/${checks.length} passed`);
