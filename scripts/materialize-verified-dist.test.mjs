#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashBuildDir } from './lib/release-hash.mjs';

let pass = 0;
const check = (name, ok) => { try { assert.equal(ok, true); pass++; console.log(`✓ ${name}`); } catch { console.error(`✗ ${name}`); process.exitCode = 1; } };
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mp-materialize-dist-test-'));
const fixture = path.join(tmp, 'fixture');
const releaseDir = path.join(tmp, 'release-out');
mkdirSync(path.join(fixture, 'dist', '.well-known'), { recursive: true });
mkdirSync(path.join(fixture, 'dist', 'assets'), { recursive: true });
mkdirSync(releaseDir);
writeFileSync(path.join(fixture, 'dist', 'index.html'), '<h1>signed</h1>\n');
writeFileSync(path.join(fixture, 'dist', 'assets', 'app.js'), 'console.log("signed")\n');
const build = hashBuildDir(path.join(fixture, 'dist'));
const publicFunctionSetSha = 'f'.repeat(64);
const marker = { release_identity: 'r4.10.15-t13.3.30-test', release_number: 41, git_commit: 'a'.repeat(40), build_output_sha256: build, public_function_set_sha256: publicFunctionSetSha, build_profile: 'production', site_domain: 'milkpop.uk' };
writeFileSync(path.join(fixture, 'dist', '.well-known', 'milkpop-release.json'), `${JSON.stringify(marker, null, 2)}\n`);
const pkg = path.join(releaseDir, 'package.zip');
execFileSync('zip', ['-qr', pkg, 'dist'], { cwd: fixture });
const set = {
  kind: 'milkpop-release-set', schema: 2, release_identity: 'r4.10.15-t13.3.30-test', build_output_sha256: build,
  build_profile: 'production', release_number: 41, git_commit: 'a'.repeat(40), site_domain: 'milkpop.uk',
  public_function_set_sha256: publicFunctionSetSha,
  archives: { package: { name: 'package.zip', sha256: sha(pkg), bytes: readFileSync(pkg).length } },
};
const setPath = path.join(releaseDir, 'release-set.json');
writeFileSync(setPath, JSON.stringify(set));
const out = path.join(releaseDir, 'verified-dist');
const run = (setFile = setPath, output = out) => spawnSync(process.execPath, ['scripts/materialize-verified-dist.mjs', setFile, output], { encoding: 'utf8' });

let r = run();
check('signed package dist materializes successfully', r.status === 0);
check('materialized bytes come from the signed package', readFileSync(path.join(out, 'index.html'), 'utf8').includes('signed'));
check('materialized build hash equals the signed build', hashBuildDir(out) === build);

writeFileSync(path.join(fixture, 'dist', 'index.html'), '<h1>workspace-tampered</h1>\n');
r = run();
check('workspace drift cannot affect materialized signed bytes', r.status === 0 && !readFileSync(path.join(out, 'index.html'), 'utf8').includes('tampered'));

writeFileSync(pkg, Buffer.concat([readFileSync(pkg), Buffer.from('tamper')]));
r = run();
check('package tampering is rejected against signed SHA-256/size', r.status !== 0);

// Restore the package for descriptor/contract failures.
execFileSync('zip', ['-qr', pkg, 'dist'], { cwd: fixture });
set.archives.package.sha256 = sha(pkg); set.archives.package.bytes = readFileSync(pkg).length;
writeFileSync(setPath, JSON.stringify({ ...set, build_profile: 'development' }));
r = run();
check('non-production release set is rejected', r.status !== 0 && /not a production build/.test(r.stderr));
writeFileSync(setPath, JSON.stringify({ ...set, git_commit: 'abc123' }));
r = run();
check('non-canonical git commit is rejected', r.status !== 0 && /40-character/.test(r.stderr));

writeFileSync(setPath, JSON.stringify(set));
rmSync(out, { recursive: true, force: true });
console.log(`\nVerified dist materialization: ${pass}/7 passed`);
rmSync(tmp, { recursive: true, force: true });
if (process.exitCode) process.exit(1);
