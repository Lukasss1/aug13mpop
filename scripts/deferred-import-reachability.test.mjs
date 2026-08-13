#!/usr/bin/env node
/**
 * Proves that deferred POS/Web Till runtime modules are unreachable from the
 * public launch entry point. Hidden navigation is not enough: a future import
 * must not silently pull deferred payment code into the launch bundle.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src/main.tsx');
const forbidden = new Set([
  'src/components/SalesPOS.tsx',
  'src/components/admin/SalesPanel.tsx',
  'src/components/admin/TillOrders.tsx',
  'src/components/admin/adminSales.ts',
  'src/lib/posCatalog.ts',
  'src/lib/posContract.ts',
  'src/lib/tillLease.ts',
  'src/lib/tillPayments.ts',
  'src/lib/orderOutbox.ts',
  'src/lib/posData.ts',
]);
const requiredReachable = new Set([
  'src/main.tsx',
  'src/App.tsx',
  'src/components/AdminPanel.tsx',
  'src/components/StaffPortal.tsx',
]);
const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

function normalise(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function resolveRelative(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    ...extensions.map((ext) => `${base}${ext}`),
    ...extensions.map((ext) => path.join(base, `index${ext}`)),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function importSpecifiers(source) {
  const found = new Set();
  const staticPattern = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicPattern = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const pattern of [staticPattern, dynamicPattern]) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

const queue = [ENTRY];
const parent = new Map([[ENTRY, null]]);
const visited = new Set();
let reachedForbidden = null;

while (queue.length) {
  const file = queue.shift();
  if (!file || visited.has(file)) continue;
  visited.add(file);
  const relative = normalise(file);
  if (forbidden.has(relative)) {
    reachedForbidden = file;
    break;
  }
  const source = readFileSync(file, 'utf8');
  for (const specifier of importSpecifiers(source)) {
    const resolved = resolveRelative(file, specifier);
    if (!resolved || parent.has(resolved)) continue;
    parent.set(resolved, file);
    queue.push(resolved);
  }
}

if (reachedForbidden) {
  const chain = [];
  let current = reachedForbidden;
  while (current) {
    chain.push(normalise(current));
    current = parent.get(current) || null;
  }
  console.error(`FAIL — deferred runtime is reachable from src/main.tsx:\n${chain.reverse().join(' -> ')}`);
  process.exit(1);
}

const reached = new Set([...visited].map(normalise));
const missingPositiveControls = [...requiredReachable].filter((file) => !reached.has(file));
if (missingPositiveControls.length) {
  console.error(`FAIL — import scanner missed required launch modules: ${missingPositiveControls.join(', ')}`);
  process.exit(1);
}

console.log(`PASS — ${visited.size} launch-reachable modules exclude all deferred POS/Web Till runtime modules`);
