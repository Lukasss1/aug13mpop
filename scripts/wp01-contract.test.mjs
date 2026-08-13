#!/usr/bin/env node
/**
 * wp01-contract.test.mjs — STATIC checks for WP-01 (Public-form identity and
 * Careers/CV attachment contract) from the Production Remediation Technical
 * Pack v1. Offline, zero-dependency, same style as security-regression.test.mjs.
 *
 * Guards the invariant that fixed P0-01:
 *   • the SERVER mints and RETURNS the submission id;
 *   • the client refuses a 2xx without a valid UUID and never echoes its own;
 *   • the Careers CV upload uses ONLY the returned id (no `|| appId` fallback);
 *   • duplicate retries resolve through the idempotency-key unique arbiter;
 *   • cv-upload enforces one-CV-per-application and never orphans an object.
 *
 * The LIVE proof (deployed browser → Edge Function → database journey) is a
 * Molen-side gate documented in docs/INTEGRATION-PLAN.md §4.
 *
 * Run: node scripts/wp01-contract.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log(`\u2714 ${n}`); };
const fail = (n, d) => { failed++; console.error(`\u2716 ${n}\n    ${d}`); };
const check = (n, cond, d = '') => (cond ? ok(n) : fail(n, d));
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

const FN_FORM = 'supabase/functions/public-form/index.ts';
const FN_CV = 'supabase/functions/cv-upload/index.ts';
const SB = 'src/lib/supabase.ts';
const PP = 'src/components/PublicPages.tsx';
const APP = 'src/App.tsx';
const MIG = 'supabase/migration_wp01_public_form_identity.sql';

for (const f of [FN_FORM, FN_CV, SB, PP, APP, MIG]) {
  check(`${f} exists`, existsSync(f), 'file missing');
}
const fnForm = read(FN_FORM), fnCv = read(FN_CV), sb = read(SB), pp = read(PP), app = read(APP), mig = read(MIG);

/* ---- 1. Server mints AND returns the authoritative id ------------------- */
const migWp02 = read('supabase/migration_wp02_atomic_submission.sql');
// WP-02 moved the mint one layer DOWN: the id is now gen_random_uuid() inside
// the atomic RPC. The WP-01 invariant — the SERVER mints the id and the caller
// receives it — is unchanged and asserted against the current layering.
check('server mints the submission id (RPC gen_random_uuid, DB-clock truth)',
  /v_id := gen_random_uuid\(\)::text/.test(migWp02) && /'submission_id', v_id/.test(migWp02),
  'server-minted id missing from submit_public_form');
check('public-form: success response carries the submissionId',
  /json\(\{ ok: true, submissionId: out\.submission_id, duplicate: out\.duplicate === true \}, 200, cors\)/.test(fnForm),
  'the { ok, submissionId } success response is gone — that reintroduces P0-01');
check('public-form: bare { ok: true } success response is retired',
  !/json\(\{ ok: true \}, 200, cors\)/.test(fnForm),
  'an id-less success response still exists');

/* ---- 2. Idempotency: validated key + 409 resolution to the first row ---- */
check('public-form: idempotency key format is validated server-side',
  /UUID_RX/.test(fnForm) && /idempotencyKey/.test(fnForm),
  'idempotency key handling missing');
check('duplicate retry resolves to the ORIGINAL row id (transactional replay)',
  /duplicate_replay/.test(migWp02) && /'duplicate', true/.test(migWp02) && /duplicate: out\.duplicate === true/.test(fnForm),
  'replay path missing — a network retry would fail instead of returning the first submission id');
check('public-form: idempotency_key has a length cap',
  /idempotency_key:\s*64/.test(fnForm),
  'FIELD_MAX entry for idempotency_key missing');

/* ---- 3. Migration: the database arbiter --------------------------------- */
check('migration: idempotency_key column on all three public tables',
  /job_applications\s+add column if not exists idempotency_key uuid/.test(mig) &&
  /franchise_inquiries\s+add column if not exists idempotency_key uuid/.test(mig) &&
  /contact_messages\s+add column if not exists idempotency_key uuid/.test(mig),
  'column additions missing or not idempotent');
check('migration: unique index arbiter per table',
  /job_applications_idempotency_key_uq/.test(mig) &&
  /franchise_inquiries_idempotency_key_uq/.test(mig) &&
  /contact_messages_idempotency_key_uq/.test(mig) &&
  /create unique index if not exists/.test(mig),
  'unique indexes missing — duplicate inserts would create second rows');
check('migration: grants/policies untouched (Phase B closure preserved)',
  !/grant\s/i.test(mig.replace(/--[^\n]*/g, '')) && !/create policy/i.test(mig),
  'WP-01 must not alter grants or policies');
check('manifest: WP-01 migration ordered before Phase B',
  (() => {
    // OPT-01.1: order lives in the authoritative migration manifest.
    const ms = read('launch/migration-manifest.sh');
    const a = ms.indexOf('migration_wp01_public_form_identity.sql');
    const b = ms.indexOf('migration_phase_b_public_forms.sql');
    return a > 0 && b > 0 && a < b;
  })(),
  'migration missing from the manifest or ordered after Phase B');

/* ---- 4. Client: validates the server UUID, never echoes its own --------- */
check('client: submitPublicForm validates the returned UUID',
  /SERVER_UUID_RX/.test(sb) && /SERVER_UUID_RX\.test\(sid\)/.test(sb),
  'response UUID validation missing');
check('client: a 2xx without a valid UUID is a FAILURE, not a success',
  /errorCode: 'invalid_response'/.test(sb),
  'the invalid_response guard is gone — a stale function deployment would silently revive P0-01');
check('client: the caller-id echo is retired',
  !/return \{ status: 'submitted', submissionId \};/.test(sb),
  'submitPublicForm still returns the caller-supplied id verbatim');
check('client: wrappers carry an idempotencyKey, not a display id',
  /submitJobApplication\(row: Record<string, unknown>, idempotencyKey: string/.test(sb) &&
  /submitFranchiseInquiry\(row: Record<string, unknown>, idempotencyKey: string/.test(sb) &&
  /submitContactMessage\(row: Record<string, unknown>, idempotencyKey: string/.test(sb),
  'wrapper signatures still take submissionId');
// INC11 repoint: the body grew noticeId/noticeSha256 (display-evidence echo),
// so the exact-shape regex no longer matches. The protected property is that
// the idempotencyKey is INSIDE the JSON.stringify'd request body — assert
// that directly instead of pinning the whole literal.
check('client: request body includes the idempotencyKey',
  /body: JSON\.stringify\(\{ kind: FORM_KIND_BY_TABLE\[table\], row, captchaToken, idempotencyKey[\s\S]{0,120}?\}\)/.test(sb),
  'idempotencyKey not sent to the Edge Function');

/* ---- 5. App handlers: fresh key per attempt, session adopts server id --- */
// WP01.1 flipped this contract: the key is a STABLE attempt from the form
// layer (payload-bound, rotates on edit/success). App must THREAD it, never
// mint its own — a crypto.randomUUID() reappearing in App's submit handlers
// is the regression (it silently restores per-call keys / duplicate rows).
check('App: handlers thread the form-layer stable attempt key',
  /submitJobApplication\(row, idempotencyKey[,)]/.test(app) &&
  /submitFranchiseInquiry\(toRow\(fran as any\), idempotencyKey[,)]/.test(app) &&
  /submitContactMessage\(toRow\(msg as any\), idempotencyKey[,)]/.test(app),
  'a handler no longer threads the attempt key');
check('App: no per-call key minting survives in submit handlers',
  !/submit(JobApplication|FranchiseInquiry|ContactMessage)\([^)]*crypto\.randomUUID/.test(app),
  'crypto.randomUUID() reappeared in a submit call');
check('PublicPages: all three forms hold a stable attempt hook',
  (pp.match(/useStableSubmissionAttempt\(\)/g) || []).length === 3 &&
  /attCareers\.getAttempt\(/.test(pp) && /attFranchise\.getAttempt\(/.test(pp) && /attContact\.getAttempt\(/.test(pp),
  'a form is missing its stable attempt');
check('PublicPages: attempts rotate on success and on idempotency_conflict',
  (pp.match(/\.rotate\(\)/g) || []).length >= 6,
  'rotation calls missing');
check('App: session state adopts the SERVER id after a confirmed submit',
  /\{ \.\.\.app, id: result\.submissionId \}/.test(app) &&
  /\{ \.\.\.fran, id: result\.submissionId \}/.test(app) &&
  /\{ \.\.\.msg, id: result\.submissionId \}/.test(app),
  'session rows keep the client placeholder id — inbox status updates would target a non-existent row');

/* ---- 6. Careers page: CV attaches to the server id ONLY ----------------- */
check('PublicPages: CV upload uses result.submissionId with NO fallback',
  /uploadCv\(result\.submissionId, cvFile[,)]/.test(pp),
  'strict server-id upload call missing');
check('PublicPages: the `|| appId` fallback is deleted',
  !/result\.submissionId \|\| appId/.test(pp),
  'the client-timestamp fallback that caused the deterministic CV failure is back');

/* ---- 7. cv-upload: one CV per application, zero orphaned objects -------- */
check('cv-upload: pre-check rejects already_attached BEFORE storing bytes',
  /select=id,cv_path/.test(fnCv) && /already_attached/.test(fnCv) && /409/.test(fnCv),
  'already_attached pre-check missing');
check('cv-upload: link PATCH is conditional on cv_path IS NULL',
  /cv_path=is\.null/.test(fnCv) && /return=representation/.test(fnCv),
  'unconditional link PATCH — a concurrent second upload would orphan the first object');
// WP01.1 §6.4 flipped this contract: NOTHING is deleted on suspicion. The
// loser (and every ambiguous outcome) is QUEUED in storage_cleanup_jobs; the
// worker deletes with a CONFIRMED status. A direct DELETE here is the
// regression now.
check('cv-upload: ambiguous PATCH outcomes are re-read before any verdict',
  /const readCvPath/.test(fnCv) && /check\.cvPath === objectKey/.test(fnCv),
  'reconciliation read missing');
check('cv-upload: the race loser is QUEUED for confirmed cleanup',
  /if \(!linked\)/.test(fnCv) && /enqueueCleanup\('cv_link_lost_race'\)/.test(fnCv),
  'loser enqueue missing');
check('cv-upload: unverifiable outcomes are parked, not destroyed',
  /cv_link_ambiguous_unverified/.test(fnCv) && /cv_link_failed_unlinked/.test(fnCv),
  'ambiguity queue reasons missing');
check('cv-upload: no direct storage DELETE remains',
  !/method:\s*'DELETE'/.test(fnCv),
  'a fire-and-forget delete reappeared');
check('cv-upload: existing controls preserved (existence check, magic bytes, upsert=false)',
  /no_application/.test(fnCv) && /sniffDocType/.test(fnCv) && /'x-upsert':\s*'false'/.test(fnCv),
  'a pre-existing security control was removed');

/* ---- 8. Client CV mapping ------------------------------------------------ */
check('client: uploadCv maps 409 to already_attached',
  /res\.status === 409.*already_attached/.test(sb),
  '409 mapping missing');
check('PublicPages: honest copy for already_attached',
  /case 'already_attached'/.test(pp),
  'cvFailureCopy has no already_attached branch');

console.log(`\nWP-01 CONTRACT CHECKS — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
