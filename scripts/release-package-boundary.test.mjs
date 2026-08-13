#!/usr/bin/env node
/**
 * Release package boundary regression.
 *
 * The production ZIP is written inside root release-out/. That generated
 * directory must never be read back into the package while the ZIP is being
 * created. A nested source directory named release-out remains valid source.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seal = readFileSync(path.join(ROOT, 'scripts', 'release-seal.sh'), 'utf8');
let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`✓ ${name}`); }
  else { failed += 1; console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const line = seal.split('\n').find((row) => row.includes('zip -qr "$PKG" .')) ?? '';
const excludes = [...line.matchAll(/-x\s+"([^"]+)"/g)].map((match) => match[1]);
check('release package command excludes generated root release-out', excludes.includes('release-out/*'));
check('release package command excludes the archive being written', excludes.includes('*.zip'));
check('release package command excludes unbound build and evidence directories',
  ['artifacts/*', 'out/*', 'backups/*', 'node_modules/*'].every((entry) => excludes.includes(entry)));

const fixture = mkdtempSync(path.join(tmpdir(), 'milkpop-package-boundary-'));
try {
  mkdirSync(path.join(fixture, 'release-out'), { recursive: true });
  mkdirSync(path.join(fixture, 'src', 'release-out'), { recursive: true });
  writeFileSync(path.join(fixture, 'app.txt'), 'source\n');
  writeFileSync(path.join(fixture, 'release-out', 'generated-secret.txt'), 'must-not-ship\n');
  writeFileSync(path.join(fixture, 'src', 'release-out', 'source.txt'), 'must-ship\n');

  const archive = path.join(fixture, 'release-out', 'fixture.zip');
  const zip = spawnSync('zip', ['-qr', archive, '.', ...excludes.flatMap((entry) => ['-x', entry])], {
    cwd: fixture,
    encoding: 'utf8',
  });
  check('fixture package can be created with the production exclusions', zip.status === 0, zip.stderr?.trim());

  const list = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
  const entries = list.stdout.split(/\r?\n/).filter(Boolean);
  check('generated root release-out content is absent from the package',
    !entries.some((entry) => entry === 'release-out/' || entry.startsWith('release-out/')),
    entries.join(', '));
  check('nested source/release-out content remains in the package', entries.includes('src/release-out/source.txt'));
  check('ordinary source content remains in the package', entries.includes('app.txt'));
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log(`\nRelease package boundary: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
