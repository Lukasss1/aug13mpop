#!/usr/bin/env node
/**
 * Materialize deployable dist/ ONLY from the already signed-and-verified
 * production release package.
 *
 * The protected workflow cryptographically verifies the release set first.
 * This helper independently re-binds the package descriptor, archive bytes,
 * extracted build hash and live release marker to that same release set before
 * exposing a clean directory to Netlify. Workspace dist/ is never deployed.
 */
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { hashBuildDir } from './lib/release-hash.mjs';

const [, , setArg = 'release-out/release-set.json', outArg = 'release-out/verified-dist'] = process.argv;
const fail = (message) => { throw new Error(`materialize-verified-dist: ${message}`); };
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const safeArchiveName = (name) => typeof name === 'string' && name.length > 0
  && path.basename(name) === name && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..';

function requireRegularFile(file, label) {
  if (!existsSync(file)) fail(`${label} not found`);
  const st = lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) fail(`${label} must be a regular non-symlink file`);
  return st;
}

function validateArchiveEntry(name) {
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\0')) {
    fail(`unsafe archive entry: ${JSON.stringify(name)}`);
  }
  const parts = name.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) fail(`archive traversal entry rejected: ${name}`);
}

function walkRegularFiles(root) {
  let count = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) fail(`symlink rejected in extracted dist: ${path.relative(root, full)}`);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) count += 1;
      else fail(`non-regular file rejected in extracted dist: ${path.relative(root, full)}`);
    }
  };
  walk(root);
  return count;
}

function validateReleaseSet(set) {
  if (set?.kind !== 'milkpop-release-set' || set?.schema !== 2) fail('unsupported release-set contract');
  if (set?.build_profile !== 'production') fail('release set is not a production build');
  if (!Number.isSafeInteger(set?.release_number) || set.release_number <= 0) fail('release set release_number is invalid');
  if (!COMMIT.test(String(set?.git_commit ?? ''))) fail('release set git_commit must be an exact lowercase 40-character SHA');
  if (!SHA256.test(String(set?.build_output_sha256 ?? ''))) fail('release set build_output_sha256 is invalid');
  if (!SHA256.test(String(set?.public_function_set_sha256 ?? ''))) fail('release set public_function_set_sha256 is invalid');
  const domain = String(set?.site_domain ?? '').toLowerCase().replace(/\.$/, '');
  if (!HOSTNAME.test(domain)) fail('release set site_domain is invalid');
  return domain;
}

function validateMarker(set, marker) {
  for (const [field, expected] of [
    ['release_identity', set.release_identity],
    ['release_number', set.release_number],
    ['git_commit', set.git_commit],
    ['build_output_sha256', set.build_output_sha256],
    ['public_function_set_sha256', set.public_function_set_sha256],
    ['build_profile', set.build_profile],
    ['site_domain', set.site_domain],
  ]) {
    if (marker?.[field] !== expected) fail(`release marker ${field} disagrees with signed release set`);
  }
}

let tmp = null;
try {
  const setPath = path.resolve(setArg);
  requireRegularFile(setPath, 'release set');
  let set;
  try { set = JSON.parse(readFileSync(setPath, 'utf8')); }
  catch { fail('release set is not valid JSON'); }
  validateReleaseSet(set);

  const pkg = set?.archives?.package;
  if (!pkg || !safeArchiveName(pkg.name)) fail('signed package archive name is unsafe or missing');
  if (!Number.isSafeInteger(pkg.bytes) || pkg.bytes <= 0) fail('signed package byte count is invalid');
  if (!SHA256.test(String(pkg.sha256 ?? ''))) fail('signed package SHA-256 is invalid');

  const releaseDir = path.dirname(setPath);
  const pkgPath = path.resolve(releaseDir, pkg.name);
  if (!pkgPath.startsWith(`${releaseDir}${path.sep}`)) fail('package path escapes release directory');
  const pkgStat = requireRegularFile(pkgPath, 'signed package archive');
  if (pkgStat.size !== pkg.bytes) fail('package byte size disagrees with signed release set');
  if (sha256File(pkgPath) !== pkg.sha256) fail('package SHA-256 disagrees with signed release set');

  let entries;
  try {
    entries = execFileSync('unzip', ['-Z1', pkgPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split(/\r?\n/).filter(Boolean);
  } catch { fail('could not enumerate the signed package archive'); }
  for (const entry of entries) validateArchiveEntry(entry);
  const distEntries = entries.filter((entry) => entry === 'dist/' || entry.startsWith('dist/'));
  if (!distEntries.some((entry) => entry !== 'dist/')) fail('signed package contains no deployable dist files');

  const output = path.resolve(outArg);
  const outputParent = path.dirname(output);
  if (!existsSync(outputParent) || !lstatSync(outputParent).isDirectory()) fail(`output parent does not exist: ${outputParent}`);
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) fail('output directory is a symlink');

  tmp = mkdtempSync(path.join(os.tmpdir(), 'milkpop-verified-dist-'));
  try { execFileSync('unzip', ['-qq', pkgPath, 'dist/*', '-d', tmp], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch { fail('could not extract dist from the signed package'); }
  const extracted = path.join(tmp, 'dist');
  if (!existsSync(extracted) || !lstatSync(extracted).isDirectory()) fail('signed package did not extract a dist directory');
  const fileCount = walkRegularFiles(extracted);
  if (fileCount < 1) fail('extracted dist is empty');

  const gotBuild = hashBuildDir(extracted);
  if (gotBuild !== set.build_output_sha256) fail(`extracted build hash ${gotBuild} disagrees with signed release set ${set.build_output_sha256}`);

  const markerPath = path.join(extracted, '.well-known', 'milkpop-release.json');
  requireRegularFile(markerPath, 'live release marker');
  let marker;
  try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); }
  catch { fail('live release marker is not valid JSON'); }
  validateMarker(set, marker);

  if (existsSync(output)) rmSync(output, { recursive: true, force: true });
  renameSync(extracted, output);
  rmSync(tmp, { recursive: true, force: true });
  tmp = null;

  console.log(`VERIFIED DIST MATERIALIZED — ${fileCount} regular files`);
  console.log(`build_output_sha256=${gotBuild}`);
  console.log(`output=${output}`);
} catch (error) {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  console.error(error?.message || String(error));
  process.exit(1);
}
