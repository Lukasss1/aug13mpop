#!/usr/bin/env node
/**
 * T13.3.20 bounded final-audit contracts.
 *
 * These checks pin the small, local reliability corrections found during the
 * final full-tree audit. They deliberately avoid architectural preferences:
 * every assertion protects a user-visible truth, a recoverable failure, or a
 * reproducible release fact.
 */
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS — ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL — ${name}${detail ? `\n  ${detail}` : ''}`);
  }
}

const launchScope = read('scripts/launch-scope.test.ts');
const releaseHash = read('scripts/lib/release-hash.mjs');
const generateManifest = read('scripts/generate-release-manifest.mjs');
const writeManifest = read('scripts/write-archive-manifest.mjs');
const verifyManifest = read('scripts/verify-archive-manifest.mjs');
const mediaCleanup = read('supabase/functions/media-cleanup/index.ts');
const mediaUpload = read('supabase/functions/media-upload/index.ts');
const cvUpload = read('supabase/functions/cv-upload/index.ts');
const cvSignedUrl = read('supabase/functions/cv-signed-url/index.ts');
const trainingMedia = read('supabase/functions/training-media/index.ts');
const staffInvite = read('supabase/functions/staff-invite/index.ts');
const outbox = read('supabase/functions/outbox-dispatch/index.ts');
const staffDocDelete = read('supabase/functions/staff-doc-delete/index.ts');
const staffDocUpload = read('supabase/functions/staff-doc-upload/index.ts');
const staffDocUrl = read('supabase/functions/staff-doc-url/index.ts');
const internalFetch = read('supabase/functions/_shared/internalFetch.ts');
const storageHelper = read('supabase/functions/_shared/storage.ts');
const releaseIntegritySql = read('supabase/migration_t13319_release_integrity.sql');
const finalAuditSql = read('supabase/migration_t13320_final_audit.sql');
const seoCore = read('supabase/functions/request-seo-rebuild/core.ts');
const docsIndex = read('docs/README.md');
const superseded = read('docs/SUPERSEDED-DOCUMENTS.md');

check('launch-scope loads the media panel before asserting it',
  launchScope.includes("const mediaPanel = readFileSync(path.join(REPO, 'src/components/admin/MediaLibraryPanel.tsx'), 'utf8');") &&
  launchScope.indexOf('const mediaPanel =') < launchScope.indexOf("check('media library upload control"),
  'The complete verification command would otherwise crash before asserting launch scope.');

check('canonical source counting is shared by release tooling',
  /export function countSourceFiles\(/.test(releaseHash) &&
  /countSourceFiles\('\.'\)/.test(generateManifest) &&
  /countSourceFiles\(work\)/.test(writeManifest) &&
  /countSourceFiles\(work\)/.test(verifyManifest),
  'Release file totals must be computed from the same canonical source collector.');

check('archive creation refuses an inner release-manifest file-count mismatch',
  /inner\.file_count !== contentFileCount/.test(writeManifest) &&
  /inner manifest file_count does not match the archive's canonical source content/i.test(writeManifest));

check('archive verification independently checks the canonical source count',
  /inner\.file_count === contentFileCount/.test(verifyManifest) &&
  /source_file_count/.test(verifyManifest));


check('all Edge endpoints use bounded transports rather than direct fetch',
  /AbortController/.test(internalFetch) && /INTERNAL_FETCH_TIMEOUT_MS = 10_000/.test(internalFetch) &&
  /parentSignal\?\.addEventListener/.test(internalFetch) &&
  [
    'cv-signed-url', 'cv-upload', 'employee-access-revoke', 'media-cleanup', 'media-upload',
    'outbox-dispatch', 'pos-catalog', 'pos-ingest', 'pos-pair', 'public-form', 'send-email',
    'staff-doc-delete', 'staff-doc-upload', 'staff-doc-url', 'staff-invite', 'training-media',
  ].every((name) => !/(^|[^A-Za-z])fetch\(/m.test(read(`supabase/functions/${name}/index.ts`))));

check('storage requests encode individual object-path segments without losing folders',
  /objectPath\.split\('\/'\)\.map/.test(storageHelper) &&
  /encodeStoragePath\(objectPath\)/.test(mediaCleanup) &&
  /encodeStoragePath\(storagePath\)/.test(staffDocUpload) &&
  /encodeStoragePath\(storagePath\)/.test(staffDocDelete) &&
  /encodeStoragePath\(String\(doc\.storage_path\)\)/.test(staffDocUrl));

check('media cleanup treats only Storage success or absence as deletion success',
  /response\.ok \|\| response\.status === 404/.test(mediaCleanup) &&
  !/response\.status === 400/.test(mediaCleanup));

check('media cleanup checks both cleanup-result persistence calls',
  /record_media_cleanup_result/.test(mediaCleanup) &&
  /record_storage_cleanup_result/.test(mediaCleanup) &&
  /recorded\?\.ok/.test(mediaCleanup) &&
  /reconciliationRequired/.test(mediaCleanup));

check('media upload promises automatic cleanup only after queue confirmation',
  /return !!cleanup\?\.ok/.test(mediaUpload) &&
  /upload_registration_missing_id/.test(mediaUpload) &&
  /registration_failed_cleanup_queued/.test(mediaUpload) &&
  /registration_failed_cleanup_unconfirmed/.test(mediaUpload));


check('media upload verifies registration before cleanup after an ambiguous response',
  /const findRegistration = async/.test(mediaUpload) &&
  /media_objects\?bucket=eq\./.test(mediaUpload) &&
  /A lost\/malformed response is ambiguous/.test(mediaUpload) &&
  /if \(verified\.objectId\)/.test(mediaUpload) &&
  /else if \(!verified\.available\)/.test(mediaUpload) &&
  /registration_unconfirmed/.test(mediaUpload));

check('media upload never queues deletion while registration truth is unavailable',
  /registrationUnconfirmed[\s\S]{0,500}cleanupQueued: false[\s\S]{0,250}reconciliationRequired: true/.test(mediaUpload) &&
  /if \(verified\.objectId\)[\s\S]{0,260}else if \(!verified\.available\)[\s\S]{0,140}registrationUnconfirmed\(\)[\s\S]{0,220}else \{[\s\S]{0,180}enqueueCleanup/.test(mediaUpload));

check('CV upload returns confirmed versus unconfirmed cleanup states',
  /const enqueueCleanup = async[\s\S]{0,700}return response\.ok/.test(cvUpload) &&
  /cleanupQueued/.test(cvUpload) && /reconciliationRequired/.test(cvUpload));

check('training-media does not claim cleanup was queued when it was not',
  /audit_failed_cleanup_queued/.test(trainingMedia) &&
  /audit_failed_cleanup_unconfirmed/.test(trainingMedia));

check('CV signed access is refused when the access audit cannot be persisted',
  /if \(!auditRecorded\)/.test(cvSignedUrl) &&
  /audit_unavailable/.test(cvSignedUrl) &&
  /audit_unavailable' \}, 503/.test(cvSignedUrl));

check('outbox provider outcomes are not reported until outbox_mark confirms them',
  /const mark = async/.test(outbox) &&
  /resultAfterMark\(recorded, 'delivered'\)/.test(outbox) &&
  /resultAfterMark\(recorded, 'retry'\)/.test(outbox) &&
  /reconciliation_required/.test(outbox));

check('outbox heartbeat persistence is checked before the worker reports success',
  /const heartbeat = await rpc\('record_heartbeat'/.test(outbox) &&
  /!heartbeat\?\.ok/.test(outbox) &&
  /reconciliationRequired \? 502 : 200/.test(outbox));

check('staff-document deletion requires a returned row before claiming state restoration',
  /const patchDocumentState = async/.test(staffDocDelete) &&
  /Prefer: 'return=representation'/.test(staffDocDelete) &&
  /Array\.isArray\(rows\) && rows\.length === 1/.test(staffDocDelete) &&
  /reconciliationRequired: !restored/.test(staffDocDelete));

check('document tombstone lookup distinguishes absence from an unavailable audit store',
  /type TombstoneLookup/.test(staffDocDelete) &&
  /status: 'unavailable'/.test(staffDocDelete) &&
  /tombstone_lookup_unavailable/.test(staffDocDelete));


check('staff-document finalisation remains idempotent under concurrent retries',
  /select \* into v_doc[\s\S]{0,900}if not found then[\s\S]{0,700}staff_document_tombstones[\s\S]{0,500}alreadyFinalized/.test(finalAuditSql),
  'A concurrent second finaliser must re-check the tombstone after waiting for the document lock.');

check('ended staff are denied by the remaining document and SEO endpoints',
  /status,ended_at/.test(staffDocUrl) && /caller\.ended_at/.test(staffDocUrl) &&
  /status,ended_at/.test(staffDocUpload) && /caller\.ended_at/.test(staffDocUpload) &&
  /status,ended_at/.test(seoCore) && /caller\.ended_at/.test(seoCore));


check('the database normalises and prevents an ended employee from being re-enabled',
  /update public\.staff_profiles[\s\S]{0,180}status='disabled'[\s\S]{0,220}ended_at is not null/.test(finalAuditSql) &&
  /create or replace function public\.enforce_ended_staff_disabled/.test(finalAuditSql) &&
  /new\.ended_at is not null[\s\S]{0,180}new\.status/.test(finalAuditSql) &&
  /trg_staff_profiles_ended_disabled/.test(finalAuditSql));


check('inactive or ended employees cannot receive onboarding invitations',
  /target\.status[\s\S]{0,180}target\.ended_at/.test(staffInvite) &&
  /target_employment_ended/.test(staffInvite) && /target_disabled/.test(staffInvite));

check('current documentation advances to T13.3.30 while retaining earlier release history',
  /T13\.3\.30-FINAL-PRODUCTION-CLOSURE/.test(docsIndex) && /T13\.3\.30-FINAL-PRODUCTION-CLOSURE/.test(superseded) &&
  /T13\.3\.28-PRODUCTION-DEPLOYMENT-CLOSURE/.test(docsIndex) &&
  /T13\.3\.27-VERIFIER-CLOSURE/.test(docsIndex) &&
  /T13\.3\.26-LOCAL-PREFLIGHT-CONFIG/.test(docsIndex) &&
  /T13\.3\.22-PUBLIC-WEB/.test(docsIndex) &&
  /T13\.3\.20-FINAL-AUDIT/.test(docsIndex) &&
  !/T13\.3\.20[^\n]{0,80}\bcurrent release summary\b/i.test(superseded));

console.log(`\nT13.3.20 FINAL AUDIT — ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
