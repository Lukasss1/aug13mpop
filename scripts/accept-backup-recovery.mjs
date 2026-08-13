#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  console.error(`BACKUP ACCEPTANCE FAILED: ${message}`);
  process.exit(1);
}
async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

const [packageDirArg, databaseReportPath, storageReportPath, outputPath] = process.argv.slice(2);
if (!packageDirArg || !databaseReportPath || !storageReportPath || !outputPath) {
  fail('usage: accept-backup-recovery.mjs <backup-package-dir> <database-report.json> <storage-report.json> <output.json>');
}
const packageDir = path.resolve(packageDirArg);
const output = path.resolve(outputPath);
if (output === packageDir || output.startsWith(`${packageDir}${path.sep}`)) fail('acceptance receipt must be stored outside the backup package');
if (existsSync(output)) fail(`acceptance receipt already exists: ${output}`);
const here = path.dirname(fileURLToPath(import.meta.url));
const packageVerifier = path.resolve(here, 'verify-backup-package.mjs');
const releaseManifestPath = path.resolve(here, '..', 'release-manifest.json');
const verifyResult = spawnSync(process.execPath, [packageVerifier, packageDir, releaseManifestPath], { encoding: 'utf8' });
if (verifyResult.status !== 0) {
  fail(`backup package no longer verifies: ${(verifyResult.stderr || verifyResult.stdout || '').trim()}`);
}
const packageManifestPath = path.join(packageDir, 'backup-manifest.json');
const packageManifest = JSON.parse(await fs.readFile(packageManifestPath, 'utf8'));
const packageManifestSha256 = await sha256File(packageManifestPath);
const database = JSON.parse(await fs.readFile(databaseReportPath, 'utf8'));
const storage = JSON.parse(await fs.readFile(storageReportPath, 'utf8'));

for (const [name, report, kind] of [['database', database, 'database_restore'], ['storage', storage, 'storage_restore']]) {
  if (report?.format_version !== 1 || report?.kind !== kind || report?.status !== 'pass') {
    fail(`${name} report is not a valid passing ${kind} receipt`);
  }
  if (report.backup_manifest_sha256 !== packageManifestSha256) fail(`${name} report belongs to a different backup package`);
  if (report.source_tree_sha256 !== packageManifest.source_tree_sha256) fail(`${name} report source identity mismatch`);
  if (report.migration_fingerprint_sha256 !== packageManifest.migration_fingerprint_sha256) fail(`${name} report migration identity mismatch`);
}
if (database.migration_count !== packageManifest.migration_count) fail('database report migration count mismatch');
if (database.storage_metadata_count !== packageManifest.storage_object_count) fail('database report Storage metadata count mismatch');
if (storage.storage_object_count !== packageManifest.storage_object_count) fail('Storage report object count mismatch');
if (storage.storage_total_bytes !== packageManifest.storage_total_bytes) fail('Storage report byte count mismatch');

const receipt = {
  format_version: 1,
  kind: 'complete_backup_acceptance',
  status: 'pass',
  accepted_at: new Date().toISOString(),
  backup_manifest_sha256: packageManifestSha256,
  source_tree_sha256: packageManifest.source_tree_sha256,
  migration_fingerprint_sha256: packageManifest.migration_fingerprint_sha256,
  source_project_ref: packageManifest.project_ref,
  database_restore_target: database.target_database_identity || 'disposable-database',
  storage_restore_project_ref: storage.target_project_ref,
  migration_count: packageManifest.migration_count,
  storage_object_count: packageManifest.storage_object_count,
  storage_total_bytes: packageManifest.storage_total_bytes,
  database_report_sha256: await sha256File(databaseReportPath),
  storage_report_sha256: await sha256File(storageReportPath),
};
const temporaryOutput = `${output}.tmp-${process.pid}`;
await fs.writeFile(temporaryOutput, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
await fs.rename(temporaryOutput, output);
console.log(`COMPLETE_BACKUP_ACCEPTED migrations=${receipt.migration_count} objects=${receipt.storage_object_count} bytes=${receipt.storage_total_bytes}`);
