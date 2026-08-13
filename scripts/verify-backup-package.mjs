#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const EXPECTED_BUCKETS = Object.freeze(['cvs', 'menu-media', 'staff-documents', 'training-media']);
const HASH_RE = /^[0-9a-f]{64}$/;

function fail(message) {
  console.error(`BACKUP PACKAGE VERIFY FAILED: ${message}`);
  process.exit(1);
}

function safeObjectName(name) {
  if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\') || /[\0\r\n\t]/.test(name)) {
    fail(`unsafe Storage object name: ${JSON.stringify(name)}`);
  }
  const segments = name.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail(`unsafe Storage object path: ${JSON.stringify(name)}`);
  }
  return segments;
}

function exactArray(actual, expected, label) {
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} must equal exactly: ${expected.join(', ')}`);
  }
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
  return value;
}

async function walkPackage(root) {
  const out = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) fail(`symbolic link is not allowed in backup package: ${relative}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) out.push(relative);
      else fail(`unsupported entry in backup package: ${relative}`);
    }
  }
  await walk(root);
  return out.sort();
}

function parseChecksumLine(text, expectedName) {
  const match = String(text).trim().match(/^([0-9a-f]{64})  (.+)$/);
  if (!match || match[2] !== expectedName) fail(`invalid checksum file for ${expectedName}`);
  return match[1];
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

const [packageDirArg, releaseManifestPath] = process.argv.slice(2);
if (!packageDirArg || !releaseManifestPath) {
  fail('usage: verify-backup-package.mjs <package-dir> <release-manifest.json>');
}
const packageDir = path.resolve(packageDirArg);
const manifestPath = path.join(packageDir, 'backup-manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const release = JSON.parse(await fs.readFile(releaseManifestPath, 'utf8'));
const packageFiles = await walkPackage(packageDir);

const allowedTopLevel = new Set([
  'backup-manifest.json',
  'backup-manifest.json.sha256',
  'database.dump',
  'database.dump.sha256',
  'database-ledger.json',
  'storage-objects.json',
  'storage-manifest.json',
]);
for (const relative of packageFiles) {
  if (!relative.startsWith('storage/') && !allowedTopLevel.has(relative)) fail(`unbound file exists in backup package: ${relative}`);
}
for (const required of allowedTopLevel) {
  if (!packageFiles.includes(required)) fail(`required backup package file is missing: ${required}`);
}

const detachedManifestHash = parseChecksumLine(
  await fs.readFile(path.join(packageDir, 'backup-manifest.json.sha256'), 'utf8'),
  'backup-manifest.json',
);
if (detachedManifestHash !== await sha256File(manifestPath)) fail('backup-manifest.json detached checksum mismatch');
const detachedDumpHash = parseChecksumLine(
  await fs.readFile(path.join(packageDir, 'database.dump.sha256'), 'utf8'),
  'database.dump',
);
if (detachedDumpHash !== await sha256File(path.join(packageDir, 'database.dump'))) fail('database.dump detached checksum mismatch');

if (manifest.format_version !== 1) fail(`unsupported format_version: ${String(manifest.format_version)}`);
if (typeof manifest.created_at !== 'string' || Number.isNaN(Date.parse(manifest.created_at))) fail('created_at is not a valid timestamp');
if (typeof manifest.project_ref !== 'string' || !/^[a-z0-9-]{3,64}$/.test(manifest.project_ref)) fail('project_ref is invalid');
if (manifest.release_identity !== release.release_identity || !manifest.release_identity) fail('backup release identity mismatch');
if (manifest.release_version !== release.release_version || !manifest.release_version) fail('backup release version mismatch');
if (!HASH_RE.test(String(manifest.source_tree_sha256)) || manifest.source_tree_sha256 !== release.source_tree_sha256) {
  fail('backup was created from a different source tree');
}
if (!HASH_RE.test(String(manifest.migration_fingerprint_sha256))
  || manifest.migration_fingerprint_sha256 !== release.migration_fingerprint_sha256) {
  fail('backup migration fingerprint does not match this release');
}
if (manifest.accepted !== false) fail('new backup package manifest must remain accepted=false');
exactArray(manifest.storage_buckets, EXPECTED_BUCKETS, 'storage_buckets');

const ledger = JSON.parse(await fs.readFile(path.join(packageDir, 'database-ledger.json'), 'utf8'));
if (!Array.isArray(ledger)) fail('database-ledger.json must be an array');
if (!Array.isArray(release._migration_order) || typeof release.migrations !== 'object' || !release.migrations) {
  fail('release manifest migration inventory is missing');
}
const expectedMigrations = release._migration_order.slice(2);
if (expectedMigrations.length !== release.migration_count) fail('release migration order/count mismatch');
if (ledger.length !== expectedMigrations.length || manifest.migration_count !== expectedMigrations.length) {
  fail('backup migration count does not match the exact release ledger');
}
for (let index = 0; index < expectedMigrations.length; index += 1) {
  const filename = expectedMigrations[index];
  const row = ledger[index];
  if (!row || Number(row.ordinal) !== index + 1 || row.filename !== filename || row.checksum !== release.migrations[filename]) {
    fail(`database ledger mismatch at ordinal ${index + 1}: ${filename}`);
  }
}

if (!manifest.files_sha256 || typeof manifest.files_sha256 !== 'object' || Array.isArray(manifest.files_sha256)) {
  fail('files_sha256 is missing');
}
const expectedHashedFiles = ['database.dump', 'database.dump.sha256', 'database-ledger.json', 'storage-objects.json', 'storage-manifest.json'];
const actualHashedFiles = Object.keys(manifest.files_sha256).sort();
if (JSON.stringify(actualHashedFiles) !== JSON.stringify([...expectedHashedFiles].sort())) {
  fail(`files_sha256 must enumerate exactly: ${expectedHashedFiles.join(', ')}`);
}
for (const [relative, expected] of Object.entries(manifest.files_sha256)) {
  if (!HASH_RE.test(String(expected))) fail(`invalid SHA-256 for ${relative}`);
  const absolute = path.resolve(packageDir, relative);
  if (!absolute.startsWith(`${packageDir}${path.sep}`)) fail(`manifest path escapes package: ${relative}`);
  if (await sha256File(absolute) !== expected) fail(`file hash mismatch: ${relative}`);
}

const inventory = JSON.parse(await fs.readFile(path.join(packageDir, 'storage-objects.json'), 'utf8'));
if (!Array.isArray(inventory)) fail('storage-objects.json must be an array');
const inventoryMap = new Map();
for (const entry of inventory) {
  if (!EXPECTED_BUCKETS.includes(entry?.bucket)) fail(`unexpected bucket in storage inventory: ${String(entry?.bucket)}`);
  safeObjectName(entry?.name);
  const key = `${entry.bucket}\0${entry.name}`;
  if (inventoryMap.has(key)) fail(`duplicate object in storage inventory: ${entry.bucket}/${entry.name}`);
  const sizeText = entry?.declared_size == null ? '' : String(entry.declared_size);
  const declaredSize = /^\d+$/.test(sizeText) ? Number(sizeText) : null;
  if (declaredSize != null && !Number.isSafeInteger(declaredSize)) fail(`invalid declared size: ${entry.bucket}/${entry.name}`);
  inventoryMap.set(key, {
    declaredSize,
    contentType: typeof entry?.content_type === 'string' && entry.content_type.trim() ? entry.content_type.trim() : null,
    updatedAt: typeof entry?.updated_at === 'string' && entry.updated_at.trim() ? entry.updated_at.trim() : null,
  });
}

const storage = JSON.parse(await fs.readFile(path.join(packageDir, 'storage-manifest.json'), 'utf8'));
if (storage.format_version !== 1) fail(`unsupported storage manifest version: ${String(storage.format_version)}`);
exactArray(storage.buckets, EXPECTED_BUCKETS, 'storage manifest buckets');
if (!Array.isArray(storage.objects)) fail('storage manifest objects must be an array');
safeInteger(storage.object_count, 'storage object_count');
safeInteger(storage.total_bytes, 'storage total_bytes');
if (storage.object_count !== storage.objects.length || storage.object_count !== inventory.length
  || storage.object_count !== manifest.storage_object_count) {
  fail('storage object counts disagree across package inventory and manifests');
}
if (storage.total_bytes !== manifest.storage_total_bytes) fail('storage byte totals disagree across manifests');

const expectedStorageFiles = [];
const seenStorage = new Set();
let computedBytes = 0;
const computedBucketCounts = Object.fromEntries(EXPECTED_BUCKETS.map((bucket) => [bucket, 0]));
let previousSortKey = null;
for (const object of storage.objects) {
  if (!EXPECTED_BUCKETS.includes(object?.bucket)) fail(`unexpected bucket in storage manifest: ${String(object?.bucket)}`);
  safeObjectName(object?.name);
  const relative = `${object.bucket}/${object.name}`;
  if (object.relative_path !== relative) fail(`storage relative_path mismatch: ${relative}`);
  const sortKey = `${object.bucket}\0${object.name}`;
  if (previousSortKey != null && previousSortKey.localeCompare(sortKey) > 0) fail('storage objects are not in deterministic order');
  previousSortKey = sortKey;
  if (seenStorage.has(sortKey)) fail(`duplicate object in storage manifest: ${relative}`);
  seenStorage.add(sortKey);
  const inventoryEntry = inventoryMap.get(sortKey);
  if (!inventoryEntry) fail(`storage manifest object is absent from database inventory: ${relative}`);
  safeInteger(object.bytes, `storage bytes for ${relative}`);
  if (!HASH_RE.test(String(object.sha256))) fail(`invalid storage SHA-256: ${relative}`);
  if (inventoryEntry.declaredSize != null && inventoryEntry.declaredSize !== object.bytes) fail(`declared size mismatch: ${relative}`);
  if ((object.declared_content_type ?? null) !== inventoryEntry.contentType) fail(`content type mismatch: ${relative}`);
  if ((object.declared_updated_at ?? null) !== inventoryEntry.updatedAt) fail(`updated_at mismatch: ${relative}`);

  const absolute = path.resolve(packageDir, 'storage', object.bucket, ...safeObjectName(object.name));
  const storageRoot = path.resolve(packageDir, 'storage') + path.sep;
  if (!absolute.startsWith(storageRoot)) fail(`storage path escapes package: ${relative}`);
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.size !== object.bytes) fail(`storage file size mismatch: ${relative}`);
  if (await sha256File(absolute) !== object.sha256) fail(`storage file hash mismatch: ${relative}`);
  expectedStorageFiles.push(`storage/${relative}`);
  computedBytes += object.bytes;
  computedBucketCounts[object.bucket] += 1;
}
for (const key of inventoryMap.keys()) {
  if (!seenStorage.has(key)) fail(`database inventory object is absent from storage manifest: ${key.replace('\0', '/')}`);
}
if (computedBytes !== storage.total_bytes) fail('storage total_bytes is not the sum of object bytes');
if (!storage.bucket_counts || typeof storage.bucket_counts !== 'object' || Array.isArray(storage.bucket_counts)) {
  fail('storage bucket_counts is missing');
}
if (JSON.stringify(storage.bucket_counts) !== JSON.stringify(computedBucketCounts)) fail('storage bucket_counts mismatch');
const actualStorageFiles = packageFiles.filter((relative) => relative.startsWith('storage/')).sort();
if (JSON.stringify(actualStorageFiles) !== JSON.stringify(expectedStorageFiles.sort())) {
  fail('storage directory contains missing or untracked file bytes');
}

console.log(`BACKUP_PACKAGE_VERIFY_PASS files=${Object.keys(manifest.files_sha256).length} objects=${storage.object_count} bytes=${storage.total_bytes}`);
