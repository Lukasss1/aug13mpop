#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUCKETS = ['cvs', 'menu-media', 'staff-documents', 'training-media'];
let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`PASS — ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL — ${name}${detail ? `: ${detail}` : ''}`);
  }
}
function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options });
}
function executable(file, contents) {
  writeFileSync(file, contents, { mode: 0o755 });
  chmodSync(file, 0o755);
}
function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}
function resetRemote(remote) {
  rmSync(remote, { recursive: true, force: true });
  for (const bucket of BUCKETS) mkdirSync(path.join(remote, bucket), { recursive: true });
}
function diagnostic(result, limit = 1400) {
  return `${result.stdout || ''}\n${result.stderr || ''}`.slice(-limit);
}

const backupSource = readFileSync(path.join(ROOT, 'scripts/backup-export.sh'), 'utf8');
const restoreSource = readFileSync(path.join(ROOT, 'scripts/restore-verify.sh'), 'utf8');
const storageRestoreSource = readFileSync(path.join(ROOT, 'scripts/storage-restore-drill.sh'), 'utf8');
const acceptSource = readFileSync(path.join(ROOT, 'scripts/accept-backup-recovery.mjs'), 'utf8');
check('backup no longer uses invalid --no-privileges=false', !backupSource.includes('--no-privileges=false'));
check('backup snapshots the authoritative mp_migration_ledger', backupSource.includes('public.mp_migration_ledger'));
check('backup includes all four application Storage buckets', BUCKETS.every((bucket) => backupSource.includes(bucket)));
check('backup requires exact linked-project identity', backupSource.includes('MP_LINKED_PROJECT_REF_FILE') && backupSource.includes('SUPABASE_PROJECT_REF'));
check('backup checks Storage inventory before dump, after dump and after download',
  backupSource.includes('storage-objects-before.json')
  && backupSource.includes('storage-objects-after.json')
  && (backupSource.match(/storage_inventory >/g) || []).length === 3);
check('backup and restore normalise Storage timestamps to UTC before comparison',
  backupSource.includes("to_char(updated_at at time zone 'UTC'")
  && restoreSource.includes("to_char(updated_at at time zone 'UTC'"));
check('database restore fails closed through package and ledger verification',
  restoreSource.includes('verify-backup-package.mjs')
  && restoreSource.includes('verify-backup-ledger.mjs')
  && restoreSource.includes('set -euo pipefail'));
check('Storage restore requires an exact destructive confirmation', storageRestoreSource.includes('RESTORE STORAGE $SUPABASE_PROJECT_REF'));
check('routine Storage drills refuse the backup source project without a second disaster-recovery confirmation',
  storageRestoreSource.includes('RESTORE SOURCE STORAGE $SUPABASE_PROJECT_REF')
  && storageRestoreSource.includes('normal recovery drills must use a different disposable project'));
check('Storage restore downloads expected-empty buckets and byte-compares the restored tree',
  storageRestoreSource.includes('Always download the target bucket')
  && storageRestoreSource.includes('restored-storage-manifest.json')
  && storageRestoreSource.includes('cmp -s'));
check('complete backup acceptance requires both machine-readable restore receipts',
  acceptSource.includes('complete_backup_acceptance')
  && acceptSource.includes("'database_restore'")
  && acceptSource.includes("'storage_restore'"));
check('acceptance receipt is immutable and stored outside the backup package',
  acceptSource.includes('acceptance receipt already exists')
  && acceptSource.includes('acceptance receipt must be stored outside'));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'milkpop-backup-contract-'));
try {
  const bin = path.join(tmp, 'bin');
  const remote = path.join(tmp, 'remote');
  const out = path.join(tmp, 'out');
  const linkFile = path.join(tmp, 'source-project-ref');
  const targetLinkFile = path.join(tmp, 'target-project-ref');
  const marker = path.join(tmp, 'restored.marker');
  mkdirSync(bin, { recursive: true });
  resetRemote(remote);
  writeFileSync(path.join(remote, 'menu-media', 'hero.webp'), 'MENU');
  mkdirSync(path.join(remote, 'staff-documents', 'emp_1'), { recursive: true });
  writeFileSync(path.join(remote, 'staff-documents', 'emp_1', 'contract.pdf'), 'DOC123');
  writeFileSync(linkFile, 'source-ref\n');
  writeFileSync(targetLinkFile, 'fixture-ref\n');

  executable(path.join(bin, 'pg_dump'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [[ "${1:-}" == --version ]]; then echo "pg_dump (PostgreSQL) 17.6"; exit 0; fi',
    'f=""',
    'for arg in "$@"; do case "$arg" in --file=*) f="${arg#--file=}";; esac; done',
    ': "${f:?missing --file}"',
    'printf "FAKE-DATABASE-DUMP" > "$f"',
    '',
  ].join('\n'));
  executable(path.join(bin, 'pg_restore'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [[ "${1:-}" == --version ]]; then echo "pg_restore (PostgreSQL) 17.6"; exit 0; fi',
    'if [[ "${1:-}" == --list ]]; then test -s "$2"; exit 0; fi',
    'touch "${FAKE_RESTORE_MARKER:?}"',
    '',
  ].join('\n'));
  executable(path.join(bin, 'psql'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [[ "${1:-}" == --version ]]; then echo "psql (PostgreSQL) 17.6"; exit 0; fi',
    'query=""',
    'file=""',
    'while (($#)); do',
    '  case "$1" in',
    '    -c|-Atc) shift; query="${1:-}" ;;',
    '    -f) shift; file="${1:-}" ;;',
    '  esac',
    '  shift || true',
    'done',
    'if [[ -n "$file" ]]; then',
    '  [[ "${FAKE_PSQL_FAIL_CHECKS:-0}" == 1 ]] && exit 2',
    '  exit 0',
    'fi',
    'if [[ "$query" == *"schemaname not in"* ]]; then',
    '  [[ -f "${FAKE_RESTORE_MARKER:?}" ]] && echo 84 || echo 0',
    'elif [[ "$query" == *"mp_migration_ledger"* && "$query" == *"json_agg"* ]]; then',
    '  cat "${FAKE_LEDGER:?}"',
    'elif [[ "$query" == *"storage.objects"* && "$query" == *"json_agg"* ]]; then',
    '  if [[ -n "${FAKE_STORAGE_COUNTER:-}" ]]; then',
    '    count=0; [[ -f "$FAKE_STORAGE_COUNTER" ]] && count="$(cat "$FAKE_STORAGE_COUNTER")"',
    '    count=$((count + 1)); printf "%s" "$count" > "$FAKE_STORAGE_COUNTER"',
    '    if [[ "$count" -ge 2 && "${FAKE_STORAGE_OBJECTS_CHANGED:-0}" == 1 ]]; then',
    '      cat "${FAKE_STORAGE_OBJECTS_ALT:?}"; exit 0',
    '    fi',
    '  fi',
    '  cat "${FAKE_STORAGE_OBJECTS:?}"',
    'elif [[ "$query" == *"pg_tables where schemaname=\'public\'"* ]]; then echo 84',
    'elif [[ "$query" == *"count(*) from public.mp_migration_ledger"* ]]; then echo 107',
    'else echo 1',
    'fi',
    '',
  ].join('\n'));
  executable(path.join(bin, 'supabase'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '[[ "${1:-}" == --version ]] && { echo "2.84.2"; exit 0; }',
    '[[ "${1:-}" == storage && "${2:-}" == cp ]] || exit 2',
    'src="$3"; dst="$4"',
    'copy_contents() {',
    '  local from="$1" to="$2"',
    '  mkdir -p "$to"',
    '  if [[ -d "$from" ]] && compgen -G "$from/*" >/dev/null; then cp -R "$from"/. "$to"/; fi',
    '}',
    'if [[ "$src" == ss://* ]]; then',
    '  bucket="${src#ss://}"',
    '  copy_contents "${FAKE_REMOTE_STORAGE:?}/$bucket" "$dst"',
    'elif [[ "$dst" == ss://* ]]; then',
    '  bucket="${dst#ss://}"',
    '  rm -rf "${FAKE_REMOTE_STORAGE:?}/$bucket"',
    '  copy_contents "$src" "${FAKE_REMOTE_STORAGE:?}/$bucket"',
    'else exit 3',
    'fi',
    '',
  ].join('\n'));

  const objects = [
    {
      bucket: 'menu-media',
      name: 'hero.webp',
      declared_size: '4',
      content_type: 'image/webp',
      updated_at: '2026-08-05T15:55:00+00:00',
    },
    {
      bucket: 'staff-documents',
      name: 'emp_1/contract.pdf',
      declared_size: '6',
      content_type: 'application/pdf',
      updated_at: '2026-08-05T15:56:00+00:00',
    },
  ];
  const changedObjects = objects.map((object, index) => ({
    ...object,
    updated_at: index === 0 ? '2026-08-05T16:01:00+00:00' : object.updated_at,
  }));
  const objectsPath = path.join(tmp, 'storage-objects.json');
  const changedObjectsPath = path.join(tmp, 'storage-objects-changed.json');
  writeFileSync(objectsPath, `${JSON.stringify(objects)}\n`);
  writeFileSync(changedObjectsPath, `${JSON.stringify(changedObjects)}\n`);

  const release = JSON.parse(readFileSync(path.join(ROOT, 'release-manifest.json'), 'utf8'));
  const ledger = release._migration_order.slice(2).map((filename, index) => ({
    ordinal: index + 1,
    filename,
    checksum: release.migrations[filename],
  }));
  const ledgerPath = path.join(tmp, 'database-ledger.json');
  writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    DATABASE_URL: 'postgres://fixture',
    SUPABASE_URL: 'https://source-ref.supabase.co',
    SUPABASE_PROJECT_REF: 'source-ref',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role',
    SUPABASE_ACCESS_TOKEN: 'fixture-access-token',
    MP_LINKED_PROJECT_REF_FILE: linkFile,
    MP_BACKUP_TIMESTAMP: '20260805T160000Z',
    MP_BACKUP_CREATED_AT: '2026-08-05T16:00:00Z',
    FAKE_LEDGER: ledgerPath,
    FAKE_STORAGE_OBJECTS: objectsPath,
    FAKE_REMOTE_STORAGE: remote,
    FAKE_RESTORE_MARKER: marker,
  };
  const storageEnv = {
    ...env,
    SUPABASE_URL: 'https://fixture-ref.supabase.co',
    SUPABASE_PROJECT_REF: 'fixture-ref',
    MP_LINKED_PROJECT_REF_FILE: targetLinkFile,
  };

  const backup = run('bash', ['scripts/backup-export.sh', out], { env });
  const packageDir = path.join(out, 'milkpop-backup-20260805T160000Z');
  check('complete database-and-Storage backup fixture succeeds', backup.status === 0, diagnostic(backup));
  check('backup contains database, exact ledger, all Storage bytes and bound manifests',
    [
      'database.dump',
      'database.dump.sha256',
      'database-ledger.json',
      'storage-objects.json',
      'storage-manifest.json',
      'backup-manifest.json',
      'backup-manifest.json.sha256',
      'storage/menu-media/hero.webp',
      'storage/staff-documents/emp_1/contract.pdf',
    ].every((relative) => existsSync(path.join(packageDir, relative))));

  const packageVerify = run(process.execPath, ['scripts/verify-backup-package.mjs', packageDir, 'release-manifest.json']);
  check('complete backup package independently verifies', packageVerify.status === 0, diagnostic(packageVerify));

  const badLedgerPackage = path.join(tmp, 'bad-ledger-package');
  cpSync(packageDir, badLedgerPackage, { recursive: true });
  const badLedgerPath = path.join(badLedgerPackage, 'database-ledger.json');
  const badLedger = JSON.parse(readFileSync(badLedgerPath, 'utf8'));
  badLedger[0].filename = '00000000000000_rogue.sql';
  writeFileSync(badLedgerPath, `${JSON.stringify(badLedger)}\n`);
  const badPackageManifestPath = path.join(badLedgerPackage, 'backup-manifest.json');
  const badPackageManifest = JSON.parse(readFileSync(badPackageManifestPath, 'utf8'));
  badPackageManifest.files_sha256['database-ledger.json'] = sha256File(badLedgerPath);
  writeFileSync(badPackageManifestPath, `${JSON.stringify(badPackageManifest, null, 2)}\n`);
  writeFileSync(
    path.join(badLedgerPackage, 'backup-manifest.json.sha256'),
    `${sha256File(badPackageManifestPath)}  backup-manifest.json\n`,
  );
  const badLedgerVerify = run(process.execPath, ['scripts/verify-backup-package.mjs', badLedgerPackage, 'release-manifest.json']);
  check('package verification rejects a semantically forged migration ledger even with refreshed hashes', badLedgerVerify.status !== 0);

  const untrackedStorage = path.join(packageDir, 'storage', 'cvs', 'untracked.txt');
  writeFileSync(untrackedStorage, 'UNTRACKED');
  const untrackedVerify = run(process.execPath, ['scripts/verify-backup-package.mjs', packageDir, 'release-manifest.json']);
  check('package verification rejects extra unlisted Storage files', untrackedVerify.status !== 0);
  rmSync(untrackedStorage, { force: true });

  const sameSourceRefused = run('bash', ['scripts/storage-restore-drill.sh', packageDir], {
    env: { ...env, MP_STORAGE_RESTORE_CONFIRMATION: 'RESTORE STORAGE source-ref' },
  });
  check('routine Storage drill refuses to target the backup source project', sameSourceRefused.status !== 0);

  resetRemote(remote);
  const sourceOverrideReport = path.join(tmp, 'source-override-storage-restore.json');
  const sameSourceApproved = run('bash', ['scripts/storage-restore-drill.sh', packageDir], {
    env: {
      ...env,
      MP_STORAGE_RESTORE_CONFIRMATION: 'RESTORE STORAGE source-ref',
      MP_ALLOW_SOURCE_PROJECT_STORAGE_RESTORE: 'RESTORE SOURCE STORAGE source-ref',
      MP_STORAGE_RESTORE_REPORT: sourceOverrideReport,
    },
  });
  check('approved disaster recovery can explicitly restore into the original source project',
    sameSourceApproved.status === 0 && existsSync(sourceOverrideReport), diagnostic(sameSourceApproved));

  const badConfirmation = run('bash', ['scripts/storage-restore-drill.sh', packageDir], {
    env: { ...storageEnv, MP_STORAGE_RESTORE_CONFIRMATION: 'RESTORE STORAGE wrong-ref' },
  });
  check('Storage drill refuses a wrong target confirmation', badConfirmation.status !== 0);

  resetRemote(remote);
  writeFileSync(path.join(remote, 'cvs', 'stale.pdf'), 'STALE');
  const staleStorageReport = path.join(tmp, 'stale-storage-restore.json');
  const staleStorageDrill = run('bash', ['scripts/storage-restore-drill.sh', packageDir], {
    env: {
      ...storageEnv,
      MP_STORAGE_RESTORE_CONFIRMATION: 'RESTORE STORAGE fixture-ref',
      MP_STORAGE_RESTORE_REPORT: staleStorageReport,
    },
  });
  check('Storage drill rejects stale objects in a bucket expected to be empty', staleStorageDrill.status !== 0 && !existsSync(staleStorageReport));

  resetRemote(remote);
  const storageReport = path.join(tmp, 'storage-restore.json');
  const storageDrill = run('bash', ['scripts/storage-restore-drill.sh', packageDir], {
    env: {
      ...storageEnv,
      MP_STORAGE_RESTORE_CONFIRMATION: 'RESTORE STORAGE fixture-ref',
      MP_STORAGE_RESTORE_REPORT: storageReport,
    },
  });
  check('Storage drill restores and re-verifies every byte across all four buckets',
    storageDrill.status === 0 && existsSync(storageReport), diagnostic(storageDrill));

  rmSync(marker, { force: true });
  const databaseMarkdown = path.join(tmp, 'database-restore.md');
  const databaseReport = path.join(tmp, 'database-restore.json');
  const restore = run('bash', ['scripts/restore-verify.sh', packageDir], {
    env: {
      ...env,
      STAGING_URL: 'postgres://staging',
      MP_RESTORE_REPORT: databaseMarkdown,
      MP_RESTORE_REPORT_JSON: databaseReport,
    },
  });
  check('database restore verifies exact ledger, Storage metadata, RLS and business invariants',
    restore.status === 0 && existsSync(databaseMarkdown) && existsSync(databaseReport), diagnostic(restore));

  const acceptance = path.join(tmp, 'backup-acceptance.json');
  const accept = run(process.execPath, ['scripts/accept-backup-recovery.mjs', packageDir, databaseReport, storageReport, acceptance]);
  check('database and Storage receipts bind into one immutable complete-backup acceptance',
    accept.status === 0 && existsSync(acceptance), diagnostic(accept));

  const duplicateAccept = run(process.execPath, ['scripts/accept-backup-recovery.mjs', packageDir, databaseReport, storageReport, acceptance]);
  check('complete-backup acceptance refuses to overwrite an existing receipt', duplicateAccept.status !== 0);

  const inPackageAccept = run(process.execPath, [
    'scripts/accept-backup-recovery.mjs',
    packageDir,
    databaseReport,
    storageReport,
    path.join(packageDir, 'acceptance.json'),
  ]);
  check('complete-backup acceptance refuses to write inside the backup package', inPackageAccept.status !== 0);

  const wrongDatabaseReport = JSON.parse(readFileSync(databaseReport, 'utf8'));
  wrongDatabaseReport.backup_manifest_sha256 = '0'.repeat(64);
  const wrongDatabaseReportPath = path.join(tmp, 'wrong-database-restore.json');
  writeFileSync(wrongDatabaseReportPath, `${JSON.stringify(wrongDatabaseReport)}\n`);
  const wrongAccept = run(process.execPath, [
    'scripts/accept-backup-recovery.mjs',
    packageDir,
    wrongDatabaseReportPath,
    storageReport,
    path.join(tmp, 'wrong-acceptance.json'),
  ]);
  check('complete acceptance rejects a restore receipt belonging to another backup', wrongAccept.status !== 0);

  rmSync(marker, { force: true });
  const failedMarkdown = path.join(tmp, 'failed-database-restore.md');
  const failedJson = path.join(tmp, 'failed-database-restore.json');
  const failedChecks = run('bash', ['scripts/restore-verify.sh', packageDir], {
    env: {
      ...env,
      STAGING_URL: 'postgres://staging-failure',
      MP_RESTORE_REPORT: failedMarkdown,
      MP_RESTORE_REPORT_JSON: failedJson,
      FAKE_PSQL_FAIL_CHECKS: '1',
    },
  });
  check('database restore truly executes the restore before rejecting a failed invariant query',
    failedChecks.status !== 0 && existsSync(marker) && !existsSync(failedMarkdown) && !existsSync(failedJson));

  const raceOut = path.join(tmp, 'race-out');
  const raceCounter = path.join(tmp, 'storage-counter');
  const raceBackup = run('bash', ['scripts/backup-export.sh', raceOut], {
    env: {
      ...env,
      MP_BACKUP_TIMESTAMP: '20260805T161000Z',
      MP_BACKUP_CREATED_AT: '2026-08-05T16:10:00Z',
      FAKE_STORAGE_COUNTER: raceCounter,
      FAKE_STORAGE_OBJECTS_CHANGED: '1',
      FAKE_STORAGE_OBJECTS_ALT: changedObjectsPath,
    },
  });
  check('backup fails closed if Storage metadata changes during the backup window',
    raceBackup.status !== 0 && !existsSync(path.join(raceOut, 'milkpop-backup-20260805T161000Z')));

  const storageFile = path.join(packageDir, 'storage', 'menu-media', 'hero.webp');
  writeFileSync(storageFile, 'TAMPERED');
  const tampered = run(process.execPath, ['scripts/verify-backup-package.mjs', packageDir, 'release-manifest.json']);
  check('backup verification rejects tampered Storage bytes', tampered.status !== 0);
  const tamperedAccept = run(process.execPath, [
    'scripts/accept-backup-recovery.mjs',
    packageDir,
    databaseReport,
    storageReport,
    path.join(tmp, 'tampered-acceptance.json'),
  ]);
  check('complete acceptance re-verifies the package and rejects post-drill tampering', tamperedAccept.status !== 0);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`BACKUP/RECOVERY CONTRACT — ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
