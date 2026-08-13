#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashBuildDir } from './lib/release-hash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS — ${name}`); }
  else { fail += 1; console.error(`FAIL — ${name}${detail ? `: ${detail}` : ''}`); }
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function snapshotDir(root) {
  if (!existsSync(root)) return null;
  const rows = [];
  function walk(current) {
    for (const name of readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = statSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) rows.push(`${relative}:${sha256(readFileSync(absolute))}`);
      else rows.push(`${relative}:unsupported`);
    }
  }
  walk(root);
  return sha256(rows.join('\n'));
}

const rootManifestPath = path.join(ROOT, 'release-manifest.json');
const rootDistPath = path.join(ROOT, 'dist');
const manifestBefore = readFileSync(rootManifestPath);
const rootDistPresentBefore = existsSync(rootDistPath);
const rootDistBefore = snapshotDir(rootDistPath);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'milkpop-provenance-hermeticity-'));
try {
  const fixtureDist = path.join(tmp, 'dist');
  const fixtureManifest = path.join(tmp, 'release-manifest.json');
  mkdirSync(path.join(fixtureDist, 'assets'), { recursive: true });
  writeFileSync(path.join(fixtureDist, 'index.html'), '<!doctype html><title>fixture</title>\n');
  writeFileSync(path.join(fixtureDist, 'assets', 'fixture.js'), 'console.log("fixture")\n');

  const generated = spawnSync(process.execPath, ['scripts/generate-release-manifest.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      MP_RELEASE_IDENTITY: 'r4.10-hermetic-fixture',
      MP_RUN_ID: 'hermetic-fixture-run',
      MP_BUILD_PROFILE: 'development',
      MP_RELEASE_MANIFEST_OUTPUT: fixtureManifest,
      MP_RELEASE_BUILD_DIR: fixtureDist,
    },
  });
  check('manifest generator supports isolated output and build paths', generated.status === 0, `${generated.stdout}\n${generated.stderr}`.slice(-1000));
  check('isolated manifest is written outside the repository root', existsSync(fixtureManifest));
  if (existsSync(fixtureManifest)) {
    const fixture = JSON.parse(readFileSync(fixtureManifest, 'utf8'));
    check('isolated manifest carries only the fixture identity',
      fixture.release_identity === 'r4.10-hermetic-fixture' && fixture.run_id === 'hermetic-fixture-run');
    check('isolated manifest hashes the isolated build tree', fixture.build_output_sha256 === hashBuildDir(fixtureDist));
  }

  const manifestAfter = readFileSync(rootManifestPath);
  check('isolated generation never modifies the repository release manifest', manifestBefore.equals(manifestAfter));
  check('isolated generation never creates or removes the repository dist directory', existsSync(rootDistPath) === rootDistPresentBefore);
  check('isolated generation never changes repository build contents', snapshotDir(rootDistPath) === rootDistBefore);

  const attackSource = readFileSync(path.join(ROOT, 'scripts/release-provenance-attacks.test.mjs'), 'utf8');
  check('adversarial provenance suite uses isolated manifest and build overrides',
    attackSource.includes('MP_RELEASE_MANIFEST_OUTPUT: fixtureManifest')
    && attackSource.includes('MP_RELEASE_BUILD_DIR: fixtureDist'));
  check('adversarial provenance suite no longer overwrites root release state',
    !attackSource.includes('writeFileSync(MANIFEST')
    && !attackSource.includes('rmSync(DIST')
    && !attackSource.includes('manifestBackup')
    && !attackSource.includes('distBackupRoot'));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`PROVENANCE HERMETICITY — ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
