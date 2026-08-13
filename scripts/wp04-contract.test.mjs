#!/usr/bin/env node
/**
 * ============================================================================
 *  wp04-contract.test.mjs — WP04R media pipeline invariants (Patch Spec §9–13)
 *
 *  REWRITTEN for the remediation: the original WP-04 design (a media_assets
 *  registry + replacePath deletion + delete-registry-first cleanup) is
 *  WITHDRAWN. These checks pin its replacement:
 *    • the registry is media_objects (the legacy media_assets Library is
 *      untouched — P0-R1),
 *    • uploads are two-phase and DELETION-FREE (P0-R2/R3),
 *    • cleanup is a state machine that never unregisters before Storage
 *      confirms (P0-R4), guarded by reference table AND content scan,
 *    • the browser pipeline enforces the P1-R5 decode limits,
 *    • the Base64 migration is manifest-based with full coverage (P1-R4).
 *
 *  Static shape checks only — the EXECUTABLE proofs (migration-from-baseline,
 *  RPC behaviour, privileges) live in scripts/migration-baseline.test.sh.
 * ============================================================================
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`\u2714 ${name}`); }
  else { failed++; console.error(`\u2716 ${name}${detail ? `\n    ${detail}` : ''}`); }
};
const read = (p) => readFileSync(p, 'utf8');

/* ═══ 1. The condemned artifacts are GONE ═══════════════════════════════════ */
check('withdrawn migration_wp04_media_assets.sql is deleted',
  !existsSync('supabase/migration_wp04_media_assets.sql'), 'the colliding migration is back');
check('withdrawn v1 migrate-base64-media.mjs is deleted',
  !existsSync('scripts/migrate-base64-media.mjs'), 'the incomplete-coverage tool is back');
// OPT-01.1: migration order lives in the authoritative manifest.
const manifest = read('launch/migration-manifest.sh');
check('manifest no longer applies the withdrawn migration',
  !/migration_wp04_media_assets\.sql/.test(manifest), 'the manifest still references it');
check('manifest applies wp01_1 → wp02_1 → wp04r in order', (() => {
  const a = manifest.indexOf('migration_wp01_1_request_hash.sql');
  const b = manifest.indexOf('migration_wp02_1_resolve_and_hash.sql');
  const c = manifest.indexOf('migration_wp04r_media_objects.sql');
  return a > -1 && b > a && c > b;
})(), 'patch migrations missing or misordered');

/* ═══ 2. The wp04r migration ════════════════════════════════════════════════ */
const MIG = 'supabase/migration_wp04r_media_objects.sql';
check(`${MIG} exists`, existsSync(MIG));
const mig = read(MIG);

check('migration defensively removes ONLY the withdrawn objects',
  /drop policy\s+if exists media_assets_read_staff/.test(mig) &&
  /drop index\s+if exists media_assets_created_at_idx/.test(mig) &&
  /drop function if exists public\.cleanup_orphan_media\(int\)/.test(mig),
  'defensive drops missing');
check('migration NEVER alters or drops the legacy media_assets table',
  !/alter\s+table\s+(public\.)?media_assets\b/i.test(mig) &&
  !/drop\s+table\s+(if exists\s+)?(public\.)?media_assets\b/i.test(mig) &&
  !/create\s+table\s+(if not exists\s+)?(public\.)?media_assets\b/i.test(mig),
  'the legacy Library table is being touched (P0-R1 regression)');
check('media_objects carries the full lifecycle state machine',
  /create table if not exists public\.media_objects/.test(mig) &&
  /'pending','attached','cleanup_pending','cleanup_failed','deleted'/.test(mig) &&
  /unique \(bucket, storage_path\)/.test(mig) &&
  /size_bytes\s+int\s+not null check \(size_bytes > 0 and size_bytes <= 512000\)/.test(mig),
  'media_objects shape wrong');
check('media_references pins one object per (entity, field)',
  /create table if not exists public\.media_references/.test(mig) &&
  /unique \(entity_type, entity_id, field_path\)/.test(mig) &&
  /on delete restrict/.test(mig),
  'media_references shape wrong');
check('browser roles cannot write the registry',
  /revoke all on public\.media_objects, public\.media_references from public, anon, authenticated/.test(mig),
  'registry revoke missing');
const rpcNames = ['media_path_is_referenced','finalise_media_reference','mark_media_cleanup_candidates',
  'claim_media_cleanup_batch','record_media_cleanup_result','claim_storage_cleanup_batch','record_storage_cleanup_result'];
check('all seven lifecycle RPCs exist, SECURITY DEFINER, house search_path',
  rpcNames.every((n) => new RegExp(`create or replace function public\\.${n}`).test(mig)) &&
  (mig.match(/security definer/g) || []).length === 7 &&
  (mig.match(/set search_path = public, pg_temp/g) || []).length === 7,
  'an RPC is missing its definer/search_path discipline');
check('every lifecycle RPC is revoked from browser roles',
  rpcNames.every((n) => new RegExp(`revoke all on function public\\.${n}\\([^)]*\\) from public, anon, authenticated`).test(mig)),
  'an RPC revoke is missing');
check('the content scan covers every §12.3 media-bearing table',
  ['menu_items','stores','news_posts','cms_pages','media_assets','site_content','app_state']
    .every((t) => new RegExp(`from ${t}`).test(mig)),
  'a table is missing from media_path_is_referenced');
check('cleanup marks candidates only when the scan finds nothing',
  /if not media_path_is_referenced\(r\.storage_path, r\.public_url\) then/.test(mig),
  'mark step does not consult the scan');
check('claim re-verifies the scan and DEMOTES, never returns, referenced objects',
  /if media_path_is_referenced\(r\.storage_path, r\.public_url\) then[\s\S]{0,120}set status = 'attached'/.test(mig),
  'claim-time re-verification missing');
check('failed cleanup backs off exponentially and stays visible',
  /cleanup_attempts = cleanup_attempts \+ 1/.test(mig) && /power\(2, least\(cleanup_attempts, 6\)\)/.test(mig),
  'backoff missing');
check('displaced objects get a GRACE period, never immediate deletion',
  /cleanup_after = now\(\) \+ v_grace/.test(mig) && /interval '24 hours'/.test(mig),
  'grace period missing');

/* ═══ 3. media-upload: two-phase, deletion-free ═════════════════════════════ */
const FN = 'supabase/functions/media-upload/index.ts';
const fn = read(FN);
check('media-upload registers media_objects, never the legacy Library',
  /svc\('media_objects\?select=id'/.test(fn) && !/svc\('media_assets/.test(fn),
  'registry target wrong');
check('media-upload has NO delete capability at all',
  !/method:\s*'DELETE'/.test(fn) && !/storageDelete/.test(fn),
  'a delete path reappeared (P0-R2/R3 regression)');
check('replacePath is gone from the entire API surface (comments exempt)', (() => {
  // Comment lines may DOCUMENT the removal; functional code may not use it.
  const files = execSync(`grep -rl "replacePath" src/ supabase/functions/ || true`, { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  for (const f of files) {
    const functional = read(f).split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .some((l) => l.includes('replacePath'));
    if (functional) return false;
  }
  return true;
})(), 'replacePath survives in functional code');
check('failed registration reports cleanup only when the durable queue accepted it',
  /storage_cleanup_jobs\?on_conflict=bucket,storage_path/.test(fn) &&
  /upload_registration_failed/.test(fn) && /upload_registration_missing_id/.test(fn) && /return !!cleanup\?\.ok/.test(fn) &&
  /registration_failed_cleanup_queued/.test(fn) && /registration_failed_cleanup_unconfirmed/.test(fn) &&
  /reconciliationRequired: !cleanupQueued/.test(fn),
  'registration-failure cleanup truthfulness missing');
check('attach action drives finalise_media_reference',
  /action.*attach/.test(fn) && /rpc\/finalise_media_reference/.test(fn) && /previousObjectCleanup/.test(fn),
  'attach path missing');
check('upload defences preserved (AAL2, magic bytes, no upsert, immutable cache)',
  /callerAal2/.test(fn) && /sniffImageType/.test(fn) && /'x-upsert':\s*'false'/.test(fn) && /immutable/.test(fn),
  'a WP-04 defence was dropped');
check('§16 upload result shape (objectId + storagePath + pending)',
  /status: 'uploaded', objectId, url: publicUrl, storagePath: objectKey/.test(fn),
  'MediaUploadResult contract wrong');

/* ═══ 4. media-cleanup: the only deleter, twice-gated ═══════════════════════ */
const CLEAN = 'supabase/functions/media-cleanup/index.ts';
check(`${CLEAN} exists`, existsSync(CLEAN));
const clean = read(CLEAN);
check('cleanup refuses unless MEDIA_CLEANUP_ENABLED=true',
  /MEDIA_CLEANUP_ENABLED/.test(clean) && /!== 'true'/.test(clean), 'env gate missing');
check('cleanup is owner-only with AAL2',
  /String\(caller\.role \|\| ''\) !== 'owner'/.test(clean) && /jwtHasAal2\(token\)/.test(clean),
  'owner/AAL2 gate missing');
check('cleanup judges the Storage HTTP status; 404 counts as gone',
  /response\.ok \|\| response\.status === 404/.test(clean),
  'status check missing (P0-R4 regression)');
check('cleanup records outcomes through the RPCs, never touches rows directly',
  /rpc\/record_media_cleanup_result/.test(clean) && /rpc\/record_storage_cleanup_result/.test(clean) &&
  !/svc\('media_objects\?/.test(clean) && !/method:\s*'PATCH'/.test(clean),
  'direct row manipulation found');
check('cleanup processes BOTH queues (registry objects + CV jobs)',
  /rpc\/claim_media_cleanup_batch/.test(clean) && /rpc\/claim_storage_cleanup_batch/.test(clean),
  'a queue is unprocessed');

/* ═══ 5. Browser pipeline (P1-R5) ═══════════════════════════════════════════ */
const MU = read('src/lib/mediaUpload.ts');
check('client pipeline is gated by MEDIA_V2 and NEVER falls back to Base64',
  /if \(!MEDIA_V2\)/.test(MU) && /'disabled'/.test(MU) && !/readAsDataURL|FileReader/.test(MU),
  'flag gate or Base64 ban missing');
check('explicit MIME allow-list with an honest HEIC message',
  /ACCEPTED_IMAGE_MIME = \['image\/jpeg', 'image\/png', 'image\/webp'\]/.test(MU) && /HEIC photos are not supported/.test(MU),
  'MIME list or HEIC copy missing');
check('pre-decode source cap: 10 MB', /SOURCE_MAX_BYTES = 10 \* 1024 \* 1024/.test(MU) && /file\.size > SOURCE_MAX_BYTES/.test(MU));
check('post-decode caps: 8000×8000 and 40 MP',
  /MAX_DIMENSION = 8000/.test(MU) && /MAX_PIXELS = 40_000_000/.test(MU) &&
  /decoded\.width > MAX_DIMENSION \|\| decoded\.height > MAX_DIMENSION \|\| decoded\.width \* decoded\.height > MAX_PIXELS/.test(MU));
check('EXIF orientation honoured via createImageBitmap',
  /createImageBitmap\(file, \{ imageOrientation: 'from-image' \}/.test(MU), 'orientation handling missing');
check('dimension fallback before an honest refusal',
  /DIMENSION_FALLBACK_STEPS/.test(MU) && /maxDim \* 0\.8/.test(MU) && /could not be compressed under the 500 KB limit/.test(MU));
check('attachMediaReference client helper exists (two-phase step 2)',
  /export async function attachMediaReference/.test(MU) && /action: 'attach'/.test(MU));

/* ═══ 6. Editors: draft-safe wiring ═════════════════════════════════════════ */
const inline = read('src/components/ImageUploadInline.tsx');
check('ImageUploadInline: explicit accept list + onUploaded, no deletion inputs',
  /ACCEPTED_IMAGE_ACCEPT_ATTR/.test(inline) && /onUploaded\?\.\(res\.objectId, res\.storagePath\)/.test(inline),
  'inline widget contract wrong');
const studio = read('src/components/admin/WebsiteStudio.tsx');
check('Studio: upload never passes a previous value; publish awaits finalised image references',
  /uploadImage\(file, set\)/.test(studio)
  && /const finaliseImageReferences = async/.test(studio)
  && /await attachMediaReference\(reference\.objectId, 'site_content', '1', fieldPath\)/.test(studio)
  && (studio.match(/await finaliseImageReferences\(\)/g) || []).length >= 2,
  'studio wiring wrong');
const admin = read('src/components/AdminPanel.tsx');
/* SMALL-BIZ CLOSURE P0-8 repoint (repointed, not weakened): the attach call
   is no longer fire-and-forget under a shared 'last' key — it is AWAITED on
   both save paths, bound to the open form's upload SESSION, and a failure is
   surfaced retryably instead of hidden behind the content success. The pin
   follows the mechanism it protects. */
check('AdminPanel: menu save AWAITS the session-bound attachment on BOTH edit and create paths',
  (admin.match(/const r = await attachMediaReference\(pending\.objectId, 'menu_item'/g) || []).length === 2 &&
  (admin.match(/pending\.session === menuFormSessionRef\.current/g) || []).length === 2,
  'menu attach wiring incomplete');
check('feature flags module defines MEDIA_V2 + CAREERS_CV_UPLOAD',
  /export const MEDIA_V2/.test(read('src/lib/featureFlags.ts')) && /export const CAREERS_CV_UPLOAD/.test(read('src/lib/featureFlags.ts')));

/* ═══ 7. Base64 migration v2 (P1-R4) ════════════════════════════════════════ */
const TOOL = 'scripts/migrate-base64-media-v2.mjs';
check(`${TOOL} exists`, existsSync(TOOL));
const tool = read(TOOL);
check('tool refuses a real run without --confirm-backup',
  /--confirm-backup/.test(tool) && /!DRY && !CONFIRMED/.test(tool) && /process\.exit\(1\)/.test(tool));
check('tool writes the §12.2 manifest fields',
  ['migration_id','table_name','row_id','field_path','old_value_sha256','old_value_length',
   'new_object_id','new_storage_path','new_url','status','error','started_at','completed_at']
    .every((f) => tool.includes(f)), 'a manifest field is missing');
check('tool resumes from the manifest and dedupes by sha256',
  /doneKeys/.test(tool) && /shaToUrl/.test(tool) && /sha256/.test(tool));
check('tool covers every §12.3 field',
  ['menu_items','stores','news_posts','cms_pages','media_assets','site_content','app_state']
    .every((t) => new RegExp(`eachRow\\('${t}'`).test(tool)), 'a coverage table is missing');
check('tool registers migrated objects as attached in media_objects',
  /media_objects\?select=id/.test(tool) && /'base64-migration'/.test(tool) && /status: 'attached'/.test(tool));

/* ═══ 8. The executable proof layer is wired ════════════════════════════════ */
check('migration-from-baseline harness + assertions exist',
  existsSync('scripts/migration-baseline.test.sh') && existsSync('scripts/migration-baseline.assert.sql'));
const pkg = read('package.json');
// OPT-01 note: this check previously pinned test:safeurl as the IMMEDIATE
// neighbour of test:wp04 in the verify chain; OPT-01 inserts test:opt01
// between them by design. The intent — baseline wired, and BOTH wp04 and
// safeurl required members of verify — is unchanged and asserted directly.
check('package.json wires test:baseline and keeps wp04 + safeurl in verify', (() => {
  const verify = (JSON.parse(pkg).scripts || {}).verify || '';
  return /"test:baseline":\s*"bash scripts\/migration-baseline\.test\.sh"/.test(pkg)
      && verify.includes('npm run test:wp04') && verify.includes('npm run test:safeurl');
})());
check('baseline assertions include the P0-R1 fingerprint and RPC behaviour', (() => {
  const a = read('scripts/migration-baseline.assert.sql');
  return /id,name,folder,size,type,uploaded_at,url,created_at/.test(a) &&
         /idempotency_conflict/.test(a) && /finalise_media_reference/.test(a) &&
         /claim_media_cleanup_batch/.test(a);
})(), 'assertion coverage shrank');

console.log(`\nWP-04R CONTRACT CHECKS — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
