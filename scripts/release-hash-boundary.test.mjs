#!/usr/bin/env node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashSourceTree } from './lib/release-hash.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'milkpop-release-hash-'));
let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`✓ ${name}`); }
  else { failures.push(name); console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

try {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'app.ts'), 'export const version = 1;\n');
  const baseline = hashSourceTree(root);

  mkdirSync(path.join(root, 'release-out'), { recursive: true });
  writeFileSync(path.join(root, 'release-out', 'generated.json'), '{"generated":true}\n');
  check('root release-out is excluded from the canonical source digest', hashSourceTree(root) === baseline);

  mkdirSync(path.join(root, 'src', 'release-out'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'release-out', 'source.ts'), 'export const nested = true;\n');
  check('nested source directory named release-out is still hashed', hashSourceTree(root) !== baseline);

  const afterNested = hashSourceTree(root);
  writeFileSync(path.join(root, 'release-manifest.json'), '{"source_tree_sha256":"self-referential"}\n');
  check('self-referential root release manifest remains excluded', hashSourceTree(root) === afterNested);

  let rejected = false;
  try {
    symlinkSync(path.join(root, 'src', 'app.ts'), path.join(root, 'src', 'alias.ts'));
    hashSourceTree(root);
  } catch (error) {
    rejected = /symlink rejected/.test(String(error?.message ?? error));
  }
  check('source hashing rejects symlinks instead of following them', rejected);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nRelease hash boundary: ${passed}/${passed + failures.length} passed`);
if (failures.length) process.exit(1);
