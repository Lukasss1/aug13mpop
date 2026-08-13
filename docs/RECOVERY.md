# Milk Pop — backup and recovery runbook

This runbook covers the small-business recovery path for the database and the four application Storage buckets:

- `cvs`
- `menu-media`
- `staff-documents`
- `training-media`

A database-only backup is incomplete. PostgreSQL contains Storage metadata, but the actual file bytes must be copied separately.

## What the backup package contains

`scripts/backup-export.sh` creates one private directory containing:

- a PostgreSQL 17 custom-format dump;
- the exact `public.mp_migration_ledger` snapshot;
- a database inventory of every object in the four application buckets;
- the downloaded Storage bytes;
- byte counts and SHA-256 hashes for every Storage object;
- a package manifest bound to the current release source and migration fingerprint.

It does not contain Supabase, Netlify, e-mail-provider or Turnstile secret values. Keep those separately in the approved password manager and protected environment configuration.

## Prerequisites

- PostgreSQL 17 `pg_dump`, `pg_restore` and `psql`;
- Node matching the repository toolchain;
- Supabase CLI `2.84.2`;
- the repository linked to exactly the source or disposable target project; normal restore drills must use a separate disposable project;
- `SUPABASE_ACCESS_TOKEN` available only in the operator shell;
- an encrypted destination with restricted access.

The scripts use `umask 077`, but the operator is still responsible for encrypting and protecting the backup after creation. The database dump contains the complete operational database, including Auth-linked records, staff data, messages and audit history; the Storage copy contains CVs, staff documents and media. Treat the whole package as highly confidential.

## 1. Create a complete backup

```bash
export DATABASE_URL='postgres://...'
export SUPABASE_URL='https://SOURCE_REF.supabase.co'
export SUPABASE_PROJECT_REF='SOURCE_REF'
export SUPABASE_ACCESS_TOKEN='...'

npm run backup:export -- /secure/encrypted/milkpop-backups
```

The command refuses a mismatched linked project, an unexpected PostgreSQL or Supabase CLI version, migration-ledger drift, missing Storage bytes or unexpected Storage files.

Create the package during a quiet or short maintenance window. Because PostgreSQL and the Storage API cannot share one distributed transaction, the command captures the Storage metadata inventory before the database dump, after the dump and after file download. Any object path, size, content type or `updated_at` change aborts the package instead of producing a mixed-time backup.

A newly created package is deliberately marked `accepted: false`.

## 2. Prove the database restore

Use a clean disposable PostgreSQL/Supabase-compatible database with the required platform roles available:

```bash
export STAGING_URL='postgres://...'
export MP_RESTORE_TARGET_IDENTITY='monthly-recovery-drill'
export MP_RESTORE_REPORT='/secure/reports/database-restore.md'
export MP_RESTORE_REPORT_JSON='/secure/reports/database-restore.json'

npm run backup:verify-database -- /secure/encrypted/milkpop-backups/milkpop-backup-YYYYMMDDTHHMMSSZ
```

The drill fails unless:

- the package and detached checksums match;
- the target is empty;
- `pg_restore` succeeds;
- the restored migration ledger exactly matches the release;
- restored Storage metadata exactly matches the backup inventory;
- RLS remains enabled on public application tables;
- critical financial and timekeeping invariants remain valid.

## 3. Prove the Storage restore

Follow the Supabase project-restore procedure for the disposable project first, then link this repository to that exact target and run:

```bash
export SUPABASE_URL='https://DISPOSABLE_TARGET_REF.supabase.co'
export SUPABASE_PROJECT_REF='DISPOSABLE_TARGET_REF'
export SUPABASE_ACCESS_TOKEN='...'
export MP_STORAGE_RESTORE_CONFIRMATION='RESTORE STORAGE DISPOSABLE_TARGET_REF'
export MP_STORAGE_RESTORE_REPORT='/secure/reports/storage-restore.json'

npm run backup:verify-storage -- /secure/encrypted/milkpop-backups/milkpop-backup-YYYYMMDDTHHMMSSZ
```

The drill uploads all four bucket trees, downloads them again, and compares every file path, byte count and SHA-256 hash. Extra or missing objects fail the drill.

Normal drills are refused when the target project is the same project that produced the backup. During an approved real disaster recovery operation only, the operator must additionally set `MP_ALLOW_SOURCE_PROJECT_STORAGE_RESTORE='RESTORE SOURCE STORAGE SOURCE_REF'`. Never use that override for a routine test.

## 4. Accept the backup

Bind the two passing machine-readable reports to the exact package:

```bash
npm run backup:accept -- \
  /secure/encrypted/milkpop-backups/milkpop-backup-YYYYMMDDTHHMMSSZ \
  /secure/reports/database-restore.json \
  /secure/reports/storage-restore.json \
  /secure/reports/complete-backup-acceptance.json
```

The acceptance command re-verifies the complete package and rejects reports from another backup, another source tree or another migration fingerprint. Acceptance receipts are immutable, must be stored outside the package and cannot be overwritten.

## Operating policy

For a one-to-three-store business:

- keep automated platform database backups enabled;
- create an off-platform complete package on a regular schedule appropriate to the business's acceptable data-loss window;
- retain at least one accepted package outside the Supabase project and outside the website host;
- run a complete restore drill after major database/storage changes and periodically during normal operation;
- record the time needed to restore and verify the system;
- never commit backup packages or recovery reports containing operational details to Git.
