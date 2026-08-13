#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const EXPECTED_BUCKETS = Object.freeze(['cvs', 'menu-media', 'staff-documents', 'training-media']);

function fail(message) {
  console.error(`STORAGE BACKUP MANIFEST FAILED: ${message}`);
  process.exit(1);
}

function safeObjectPath(name) {
  if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\') || /[\0\r\n\t]/.test(name)) {
    fail(`unsafe storage object name: ${JSON.stringify(name)}`);
  }
  const segments = name.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail(`unsafe storage object path segments: ${JSON.stringify(name)}`);
  }
  return segments;
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

async function walkFiles(root) {
  const out = [];
  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) fail(`symbolic link is not allowed in storage backup: ${absolute}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) out.push(absolute);
      else fail(`unsupported filesystem entry in storage backup: ${absolute}`);
    }
  }
  await walk(root);
  return out;
}

function normaliseInventory(raw) {
  if (!Array.isArray(raw)) fail('object inventory must be a JSON array');
  const seen = new Set();
  const objects = raw.map((entry) => {
    const bucket = entry?.bucket;
    const name = entry?.name;
    if (!EXPECTED_BUCKETS.includes(bucket)) fail(`unexpected storage bucket in database inventory: ${String(bucket)}`);
    safeObjectPath(name);
    const key = `${bucket}\0${name}`;
    if (seen.has(key)) fail(`duplicate storage object in database inventory: ${bucket}/${name}`);
    seen.add(key);
    const declaredSizeText = entry?.declared_size == null ? '' : String(entry.declared_size);
    const declaredSize = /^\d+$/.test(declaredSizeText) ? Number(declaredSizeText) : null;
    return {
      bucket,
      name,
      declared_size: Number.isSafeInteger(declaredSize) ? declaredSize : null,
      declared_content_type: typeof entry?.content_type === 'string' && entry.content_type.trim()
        ? entry.content_type.trim()
        : null,
      declared_updated_at: typeof entry?.updated_at === 'string' && entry.updated_at.trim()
        ? entry.updated_at.trim()
        : null,
    };
  });
  return objects.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.name.localeCompare(b.name));
}

const [inventoryPath, storageRootArg, outputPath] = process.argv.slice(2);
if (!inventoryPath || !storageRootArg || !outputPath) {
  fail('usage: storage-backup-manifest.mjs <storage-objects.json> <storage-root> <output.json>');
}

const storageRoot = path.resolve(storageRootArg);
const inventory = normaliseInventory(JSON.parse(await fs.readFile(inventoryPath, 'utf8')));
const expectedRelativeFiles = new Set(inventory.map((entry) => `${entry.bucket}/${entry.name}`));
const actualFiles = await walkFiles(storageRoot);
const actualRelativeFiles = actualFiles.map((file) => path.relative(storageRoot, file).split(path.sep).join('/'));

for (const relative of actualRelativeFiles) {
  if (!expectedRelativeFiles.has(relative)) fail(`untracked file exists in storage backup: ${relative}`);
}
for (const relative of expectedRelativeFiles) {
  if (!actualRelativeFiles.includes(relative)) fail(`database object is missing from storage backup: ${relative}`);
}

const files = [];
let totalBytes = 0;
for (const entry of inventory) {
  const absolute = path.resolve(storageRoot, entry.bucket, ...safeObjectPath(entry.name));
  const bucketRoot = path.resolve(storageRoot, entry.bucket) + path.sep;
  if (!absolute.startsWith(bucketRoot)) fail(`resolved storage path escaped bucket root: ${entry.bucket}/${entry.name}`);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) fail(`storage object is not a regular file: ${entry.bucket}/${entry.name}`);
  if (entry.declared_size != null && entry.declared_size !== stat.size) {
    fail(`size mismatch for ${entry.bucket}/${entry.name}: database=${entry.declared_size}, downloaded=${stat.size}`);
  }
  const sha256 = await sha256File(absolute);
  totalBytes += stat.size;
  files.push({
    bucket: entry.bucket,
    name: entry.name,
    relative_path: `${entry.bucket}/${entry.name}`,
    bytes: stat.size,
    sha256,
    declared_content_type: entry.declared_content_type,
    declared_updated_at: entry.declared_updated_at,
  });
}

const bucketCounts = Object.fromEntries(EXPECTED_BUCKETS.map((bucket) => [bucket, files.filter((file) => file.bucket === bucket).length]));
const manifest = {
  format_version: 1,
  buckets: [...EXPECTED_BUCKETS],
  object_count: files.length,
  total_bytes: totalBytes,
  bucket_counts: bucketCounts,
  objects: files,
};

await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`STORAGE_BACKUP_MANIFEST_PASS objects=${files.length} bytes=${totalBytes}`);
