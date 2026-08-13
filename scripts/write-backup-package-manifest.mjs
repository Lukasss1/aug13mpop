#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

function fail(message) {
  console.error(`BACKUP PACKAGE MANIFEST FAILED: ${message}`);
  process.exit(1);
}

async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

const [packageDirArg, releaseManifestPath, outputPath] = process.argv.slice(2);
if (!packageDirArg || !releaseManifestPath || !outputPath) {
  fail('usage: write-backup-package-manifest.mjs <package-dir> <release-manifest.json> <output.json>');
}

const packageDir = path.resolve(packageDirArg);
const release = JSON.parse(await fs.readFile(releaseManifestPath, 'utf8'));
const storage = JSON.parse(await fs.readFile(path.join(packageDir, 'storage-manifest.json'), 'utf8'));
const ledger = JSON.parse(await fs.readFile(path.join(packageDir, 'database-ledger.json'), 'utf8'));
const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
let projectRef = '';
try {
  const host = new URL(supabaseUrl).hostname;
  projectRef = host.endsWith('.supabase.co') ? host.split('.')[0] : host;
} catch {
  fail('SUPABASE_URL must be a valid absolute URL');
}
if (!projectRef) fail('could not derive project ref from SUPABASE_URL');

const files = ['database.dump', 'database.dump.sha256', 'database-ledger.json', 'storage-objects.json', 'storage-manifest.json'];
const hashes = {};
for (const relative of files) {
  hashes[relative] = await sha256File(path.join(packageDir, relative));
}

const createdAt = process.env.MP_BACKUP_CREATED_AT || new Date().toISOString();
const manifest = {
  format_version: 1,
  created_at: createdAt,
  project_ref: projectRef,
  release_identity: release.release_identity,
  release_version: release.release_version,
  source_tree_sha256: release.source_tree_sha256,
  migration_fingerprint_sha256: release.migration_fingerprint_sha256,
  migration_count: ledger.length,
  storage_buckets: storage.buckets,
  storage_object_count: storage.object_count,
  storage_total_bytes: storage.total_bytes,
  files_sha256: hashes,
  accepted: false,
  acceptance_requirement: 'Run both restore drills, then bind their JSON receipts with accept-backup-recovery.mjs.',
};

await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`BACKUP_PACKAGE_MANIFEST_PASS project=${projectRef} migrations=${ledger.length} objects=${storage.object_count}`);
