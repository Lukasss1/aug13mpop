#!/usr/bin/env node
/**
 * ESLint debt ratchet.
 *
 * The legacy codebase starts with a finite warning budget. This wrapper keeps
 * that budget from increasing and additionally requires newly extracted,
 * launch-critical modules to remain warning-free. ESLint errors always fail.
 * The JSON result is retained in artifacts/ so CI evidence is inspectable.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const baselinePath = new URL('./lint-ratchet-baseline.json', import.meta.url);
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const result = spawnSync(process.platform === 'win32' ? 'eslint.cmd' : 'eslint', ['.', '--format', 'json'], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});
if (result.error) {
  console.error(`LINT RATCHET FAIL — could not execute ESLint: ${result.error.message}`);
  process.exit(2);
}

let reports;
try {
  reports = JSON.parse(result.stdout || '[]');
} catch {
  console.error('LINT RATCHET FAIL — ESLint did not return valid JSON.');
  console.error(String(result.stderr || result.stdout || '').slice(0, 2000));
  process.exit(2);
}

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/eslint.json', `${JSON.stringify(reports, null, 2)}\n`);

const normalise = (file) => path.relative(process.cwd(), file).split(path.sep).join('/');
const errors = reports.flatMap((report) => report.messages
  .filter((message) => message.severity === 2)
  .map((message) => ({ file: normalise(report.filePath), ...message })));
const warnings = reports.flatMap((report) => report.messages
  .filter((message) => message.severity === 1)
  .map((message) => ({ file: normalise(report.filePath), ...message })));
const protectedWarnings = warnings.filter((warning) => baseline.zeroWarningPaths.some((entry) => (
  entry.endsWith('/**') ? warning.file.startsWith(entry.slice(0, -3)) : warning.file === entry
)));

const print = (items, heading) => {
  if (!items.length) return;
  console.error(`\n${heading}`);
  for (const item of items.slice(0, 50)) {
    console.error(`  ${item.file}:${item.line ?? 0}:${item.column ?? 0} ${item.ruleId || 'eslint'} — ${item.message}`);
  }
  if (items.length > 50) console.error(`  …and ${items.length - 50} more`);
};

print(errors, `ESLint errors (${errors.length})`);
print(protectedWarnings, `Warnings in zero-warning launch modules (${protectedWarnings.length})`);

if (errors.length || warnings.length > baseline.maximumWarnings || protectedWarnings.length) {
  if (warnings.length > baseline.maximumWarnings) {
    console.error(`\nWarning debt increased: ${warnings.length} > approved ceiling ${baseline.maximumWarnings}.`);
  }
  process.exit(1);
}

console.log(`LINT RATCHET PASS — 0 errors; ${warnings.length}/${baseline.maximumWarnings} warning ceiling; protected launch modules clean`);
