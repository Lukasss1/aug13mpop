#!/usr/bin/env node
import { promises as fs } from 'node:fs';

function fail(message) {
  console.error(`BACKUP LEDGER VERIFY FAILED: ${message}`);
  process.exit(1);
}

const [ledgerPath, releaseManifestPath] = process.argv.slice(2);
if (!ledgerPath || !releaseManifestPath) {
  fail('usage: verify-backup-ledger.mjs <ledger.json> <release-manifest.json>');
}

const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
const release = JSON.parse(await fs.readFile(releaseManifestPath, 'utf8'));
if (!Array.isArray(ledger)) fail('ledger snapshot must be an array');
if (!Array.isArray(release._migration_order) || typeof release.migrations !== 'object' || !release.migrations) {
  fail('release manifest does not contain the canonical migration inventory');
}
const expectedNames = release._migration_order.slice(2);
if (expectedNames.length !== release.migration_count) {
  fail(`release manifest migration count mismatch: order=${expectedNames.length}, declared=${release.migration_count}`);
}
if (ledger.length !== expectedNames.length) {
  fail(`deployed ledger count mismatch: deployed=${ledger.length}, expected=${expectedNames.length}`);
}

for (let index = 0; index < expectedNames.length; index += 1) {
  const expectedName = expectedNames[index];
  const expectedHash = release.migrations[expectedName];
  const row = ledger[index];
  const expectedOrdinal = index + 1;
  if (!row || row.filename !== expectedName) {
    fail(`migration ${expectedOrdinal} filename mismatch: deployed=${row?.filename ?? 'missing'}, expected=${expectedName}`);
  }
  if (Number(row.ordinal) !== expectedOrdinal) {
    fail(`migration ${expectedName} ordinal mismatch: deployed=${String(row.ordinal)}, expected=${expectedOrdinal}`);
  }
  if (row.checksum !== expectedHash) {
    fail(`migration ${expectedName} checksum mismatch`);
  }
}

console.log(`BACKUP_LEDGER_VERIFY_PASS migrations=${ledger.length}`);
