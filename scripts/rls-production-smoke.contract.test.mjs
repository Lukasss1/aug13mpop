#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const s = readFileSync('scripts/rls-production-smoke.mjs', 'utf8');
const checks = [
  ['requires AAL2 owner', /OWNER_TOTP_SECRET/.test(s) && /owner session is AAL2/.test(s)],
  ['uses one low-role production identity', /STAFF_EMAIL/.test(s) && /team_member.*supervisor/.test(s)],
  ['does not require fake manager', !/MGR_A_EMAIL|MANAGER_EMAIL/.test(s)],
  ['does not require a second store', !/different stores|Store B|dedicated acceptance stores/.test(s)],
  ['proves anonymous payslip isolation', /anonymous callers see no payslip data/.test(s)],
  ['proves exact self payslip ownership', /every visible payslip belongs/.test(s)],
  ['proves self escalation denied', /cannot self-promote/.test(s) && /cannot alter own pay rate/.test(s)],
  ['keeps CV access checks', /private cvs bucket/.test(s) && /cv-signed-url refuses/.test(s)],
];
let pass = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (ok) pass++; else process.exitCode = 1;
}
console.log(`\nProduction RLS smoke contract: ${pass}/${checks.length} checks passed.`);
