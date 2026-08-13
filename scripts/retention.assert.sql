-- ============================================================================
--  retention.assert.sql — executed by scripts/retention.test.sh against a
--  FRESH database built from schema.FRESH-INSTALL-ONLY.sql + the full migration chain (which now
--  ends in migration_stage3_ws9_retention.sql). This is the EXECUTABLE PROOF
--  the MEDIA_CLEANUP_ENABLED gate (env validator rule R8) requires:
--
--    A. claim-time invariant — a REFERENCED CV is never claimed and never
--       deleted; ambiguity retries; only provably-unreferenced objects are
--       handed to the deleter;
--    B. retention sweeps — contact / franchise / declined-application purges
--       delete exactly the expired rows, enqueue the CV objects for a
--       confirmed delete, and are idempotent on re-run;
--    C. orphan sweep — unreferenced cvs objects past grace are queued; fresh
--       or referenced ones are not;
--    D. every run is LOGGED in retention_runs;
--    E. none of it is reachable from the anon/authenticated API roles.
--
--  Every failure raises, which fails the harness.
-- ============================================================================
-- R4.9 G5: a public submission is not accepted unless a published privacy notice
-- exists to stamp and a recipient exists to deliver to. This suite is about the
-- RETENTION of submissions that already exist, so the surface is commissioned
-- once here rather than the gate being weakened. The gate itself is asserted
-- both ways in scripts/migration-baseline.assert.sql.
update launch_settings set notification_recipient = 'harness@example.invalid' where id;
insert into privacy_notice_versions (audience, version_label, notice_text, published_at)
values ('careers', 'v1-harness', 'harness notice', now()),
       ('franchise', 'v1-harness', 'harness notice', now()),
       ('contact', 'v1-harness', 'harness notice', now())
on conflict (audience, version_label) do nothing;

\set ON_ERROR_STOP on

-- ═══ 0. FIXTURES ═════════════════════════════════════════════════════════════
-- Old/new rows in each inbox; declined/pending applications with CV objects;
-- an orphan object; a fresh orphan inside the grace window.
do $$
begin
  insert into storage.buckets (id, name, public)
  values ('cvs', 'cvs', false)
  on conflict (id) do nothing;

  -- storage objects: the bytes-side of every scenario.
  insert into storage.objects (bucket_id, name, created_at) values
    ('cvs', 'ws9/referenced-live.pdf',   now() - interval '10 days'),
    ('cvs', 'ws9/declined-old.pdf',      now() - interval '200 days'),
    ('cvs', 'ws9/declined-old-link.pdf', now() - interval '200 days'),
    ('cvs', 'ws9/unreferenced-job.pdf',  now() - interval '10 days'),
    ('cvs', 'ws9/retry-job.pdf',         now() - interval '10 days'),
    ('cvs', 'ws9/orphan-old.pdf',        now() - interval '10 days'),
    ('cvs', 'ws9/orphan-fresh.pdf',      now());

  insert into job_applications (id, full_name, email, status, applied_at, created_at, updated_at, cv_path) values
    ('ws9_app_live',     'Live Applicant',     'live@x.test',     'pending',  '', now() - interval '10 days',  now() - interval '10 days',  'ws9/referenced-live.pdf'),
    ('ws9_app_declined', 'Declined Old',       'declined@x.test', 'declined', '', now() - interval '200 days', now() - interval '200 days', 'ws9/declined-old.pdf'),
    ('ws9_app_link',     'Declined Link Only', 'link@x.test',     'declined', '', now() - interval '200 days', now() - interval '200 days', 'ws9/declined-old-link.pdf'),
    ('ws9_app_pending',  'Pending Old',        'pending@x.test',  'pending',  '', now() - interval '200 days', now() - interval '200 days', null),
    ('ws9_app_recent',   'Declined Recent',    'recent@x.test',   'declined', '', now() - interval '5 days',   now() - interval '5 days',   null);

  insert into contact_messages (id, full_name, email, message, created_at) values
    ('ws9_cm_old', 'Old Contact', 'oldc@x.test', 'old', now() - interval '400 days'),
    ('ws9_cm_new', 'New Contact', 'newc@x.test', 'new', now() - interval '5 days');

  insert into franchise_inquiries (id, full_name, email, created_at, updated_at) values
    ('ws9_fr_old', 'Old Franchise', 'oldf@x.test', now() - interval '400 days', now() - interval '400 days'),
    ('ws9_fr_new', 'New Franchise', 'newf@x.test', now() - interval '5 days',   now() - interval '5 days');
end $$;

-- ═══ A. CLAIM-TIME INVARIANT ════════════════════════════════════════════════

-- A1. The lost-response race: a cleanup job exists for an object whose DB link
--     COMMITTED. Claiming must return nothing, close the job as 'reconciled',
--     and leave both the object and the application link untouched.
do $$
declare n int; s text; e text;
begin
  insert into storage_cleanup_jobs (bucket, storage_path, reason, next_attempt_at)
  values ('cvs', 'ws9/referenced-live.pdf', 'ws9-test: ambiguous upload', now() - interval '1 minute');

  select count(*) into n from claim_storage_cleanup_batch(50)
   where storage_path = 'ws9/referenced-live.pdf';
  if n <> 0 then raise exception 'ASSERT A1: a REFERENCED cv job was claimed for deletion'; end if;

  select status, last_error into s, e from storage_cleanup_jobs
   where bucket='cvs' and storage_path='ws9/referenced-live.pdf';
  if s <> 'reconciled' then raise exception 'ASSERT A1: referenced job status is % (want reconciled)', s; end if;
  if e is null or e not like 'referenced:%' then raise exception 'ASSERT A1: reconciled job carries no reason'; end if;

  perform 1 from storage.objects where bucket_id='cvs' and name='ws9/referenced-live.pdf';
  if not found then raise exception 'ASSERT A1: the referenced object vanished'; end if;
  perform 1 from job_applications where id='ws9_app_live' and cv_path='ws9/referenced-live.pdf';
  if not found then raise exception 'ASSERT A1: the application link was disturbed'; end if;
end $$;

-- A2. Reconciliation is terminal and idempotent: a second claim pass neither
--     claims nor re-touches the reconciled job.
do $$
declare n int; a int;
begin
  select count(*) into n from claim_storage_cleanup_batch(50)
   where storage_path = 'ws9/referenced-live.pdf';
  if n <> 0 then raise exception 'ASSERT A2: reconciled job was claimed on replay'; end if;
  select attempts into a from storage_cleanup_jobs
   where bucket='cvs' and storage_path='ws9/referenced-live.pdf';
  if a <> 0 then raise exception 'ASSERT A2: reconciled job accrued attempts (%)', a; end if;
end $$;

-- A3. An UNREFERENCED job is claimed exactly once per pass, moves to
--     processing, and a confirmed delete closes it as done.
do $$
declare r storage_cleanup_jobs%rowtype; n int;
begin
  insert into storage_cleanup_jobs (bucket, storage_path, reason, next_attempt_at)
  values ('cvs', 'ws9/unreferenced-job.pdf', 'ws9-test: genuine orphan', now() - interval '1 minute');

  select * into r from claim_storage_cleanup_batch(50)
   where storage_path = 'ws9/unreferenced-job.pdf';
  if r.id is null then raise exception 'ASSERT A3: unreferenced job was not claimed'; end if;
  if r.status <> 'processing' or r.attempts <> 1 then
    raise exception 'ASSERT A3: claim state % attempts %', r.status, r.attempts; end if;

  -- while processing, a second claimer gets nothing (status excludes it).
  select count(*) into n from claim_storage_cleanup_batch(50)
   where storage_path = 'ws9/unreferenced-job.pdf';
  if n <> 0 then raise exception 'ASSERT A3: processing job double-claimed'; end if;

  perform record_storage_cleanup_result(r.id, true, null);
  perform 1 from storage_cleanup_jobs where id = r.id and status = 'done' and last_error is null;
  if not found then raise exception 'ASSERT A3: confirmed delete did not close the job as done'; end if;
end $$;

-- A4. A FAILED delete retries with backoff — never silently dropped, never
--     immediately re-claimed.
do $$
declare r storage_cleanup_jobs%rowtype; n int; r2 storage_cleanup_jobs%rowtype;
begin
  insert into storage_cleanup_jobs (bucket, storage_path, reason, next_attempt_at)
  values ('cvs', 'ws9/retry-job.pdf', 'ws9-test: transient failure', now() - interval '1 minute');

  select * into r from claim_storage_cleanup_batch(50) where storage_path = 'ws9/retry-job.pdf';
  if r.id is null then raise exception 'ASSERT A4: retry job not claimed'; end if;
  perform record_storage_cleanup_result(r.id, false, 'storage 503');

  perform 1 from storage_cleanup_jobs
   where id = r.id and status = 'failed' and last_error = 'storage 503' and next_attempt_at > now();
  if not found then raise exception 'ASSERT A4: failure not recorded with backoff'; end if;

  select count(*) into n from claim_storage_cleanup_batch(50) where storage_path = 'ws9/retry-job.pdf';
  if n <> 0 then raise exception 'ASSERT A4: failed job re-claimed before its backoff elapsed'; end if;

  update storage_cleanup_jobs set next_attempt_at = now() - interval '1 second' where id = r.id;
  select * into r2 from claim_storage_cleanup_batch(50) where storage_path = 'ws9/retry-job.pdf';
  if r2.id is null or r2.attempts <> 2 then
    raise exception 'ASSERT A4: due retry not re-claimed (attempts %)', coalesce(r2.attempts, -1); end if;
  perform record_storage_cleanup_result(r2.id, true, null);
end $$;

-- ═══ B. RETENTION SWEEPS ════════════════════════════════════════════════════

-- B1. Contact messages: only the expired row goes; the run is logged;
--     a replay deletes zero.
do $$
declare n int;
begin
  n := retention_purge_contact_messages(interval '30 days');
  if n <> 1 then raise exception 'ASSERT B1: contact purge deleted % (want 1)', n; end if;
  perform 1 from contact_messages where id = 'ws9_cm_old';
  if found then raise exception 'ASSERT B1: expired contact message survived'; end if;
  perform 1 from contact_messages where id = 'ws9_cm_new';
  if not found then raise exception 'ASSERT B1: in-retention contact message was deleted'; end if;
  perform 1 from retention_runs where entity = 'contact_messages' and rows_deleted = 1;
  if not found then raise exception 'ASSERT B1: contact purge was not logged'; end if;

  n := retention_purge_contact_messages(interval '30 days');
  if n <> 0 then raise exception 'ASSERT B1: contact purge is not idempotent (%)', n; end if;
end $$;

-- B2. Franchise enquiries: same contract.
do $$
declare n int;
begin
  n := retention_purge_franchise_inquiries(interval '30 days');
  if n <> 1 then raise exception 'ASSERT B2: franchise purge deleted % (want 1)', n; end if;
  perform 1 from franchise_inquiries where id = 'ws9_fr_new';
  if not found then raise exception 'ASSERT B2: in-retention enquiry was deleted'; end if;
  n := retention_purge_franchise_inquiries(interval '30 days');
  if n <> 0 then raise exception 'ASSERT B2: franchise purge is not idempotent (%)', n; end if;
end $$;

-- B3. Declined applications past retention: metadata row AND file go together
--     — the row is deleted, the object is queued for a confirmed delete, the
--     queue row is claimable (nothing references it any more), and the
--     recent-declined / old-pending rows are untouched. Replay deletes zero.
do $$
declare j jsonb; r storage_cleanup_jobs%rowtype;
begin
  j := retention_purge_job_applications(interval '90 days');
  if (j->>'deleted')::int <> 2 then
    raise exception 'ASSERT B3: application purge deleted % (want 2: ws9_app_declined + ws9_app_link)', j->>'deleted'; end if;
  if (j->>'cvJobsEnqueued')::int <> 2 then
    raise exception 'ASSERT B3: cv jobs enqueued % (want 2)', j->>'cvJobsEnqueued'; end if;
  perform 1 from job_applications where id in ('ws9_app_declined','ws9_app_link');
  if found then raise exception 'ASSERT B3: an expired declined application survived'; end if;
  perform 1 from job_applications where id = 'ws9_app_pending';
  if not found then raise exception 'ASSERT B3: an old PENDING application was deleted (status guard broken)'; end if;
  perform 1 from job_applications where id = 'ws9_app_recent';
  if not found then raise exception 'ASSERT B3: a recent declined application was deleted (cutoff broken)'; end if;

  -- the file is now provably unreferenced → the executor may take it.
  select * into r from claim_storage_cleanup_batch(50) where storage_path = 'ws9/declined-old.pdf';
  if r.id is null then raise exception 'ASSERT B3: purged application''s cv job not claimable'; end if;
  perform record_storage_cleanup_result(r.id, true, null);

  j := retention_purge_job_applications(interval '90 days');
  if (j->>'deleted')::int <> 0 then
    raise exception 'ASSERT B3: application purge is not idempotent (%)', j->>'deleted'; end if;
end $$;

-- B4. Re-reference between enqueue and claim: if a NEW application adopts the
--     queued path before the executor runs, the claim reconciles instead of
--     deleting — the invariant holds end-to-end, not just at enqueue time.
do $$
declare n int; s text;
begin
  insert into job_applications (id, full_name, email, status, applied_at, created_at, updated_at, cv_path)
  values ('ws9_app_adopt', 'Adopted Path', 'adopt@x.test', 'pending', '', now(), now(), 'ws9/declined-old-link.pdf');

  select count(*) into n from claim_storage_cleanup_batch(50)
   where storage_path = 'ws9/declined-old-link.pdf';
  if n <> 0 then raise exception 'ASSERT B4: re-referenced object was claimed'; end if;
  select status into s from storage_cleanup_jobs
   where bucket='cvs' and storage_path='ws9/declined-old-link.pdf';
  if s <> 'reconciled' then raise exception 'ASSERT B4: re-referenced job status % (want reconciled)', s; end if;
  perform 1 from storage.objects where bucket_id='cvs' and name='ws9/declined-old-link.pdf';
  if not found then raise exception 'ASSERT B4: re-referenced object vanished'; end if;
end $$;

-- ═══ C. ORPHAN SWEEP ════════════════════════════════════════════════════════
do $$
declare n int;
begin
  n := retention_enqueue_orphan_cvs(interval '1 hour');
  -- exactly the old orphan: the fresh one is inside grace; the referenced one
  -- is linked (ws9_app_adopt); everything else already has a job row.
  if n <> 1 then raise exception 'ASSERT C: orphan sweep enqueued % (want 1)', n; end if;
  perform 1 from storage_cleanup_jobs where bucket='cvs' and storage_path='ws9/orphan-old.pdf' and status='pending';
  if not found then raise exception 'ASSERT C: old orphan not queued'; end if;
  perform 1 from storage_cleanup_jobs where bucket='cvs' and storage_path='ws9/orphan-fresh.pdf';
  if found then raise exception 'ASSERT C: in-grace orphan was queued'; end if;

  n := retention_enqueue_orphan_cvs(interval '1 hour');
  if n <> 0 then raise exception 'ASSERT C: orphan sweep is not idempotent (%)', n; end if;
end $$;

-- ═══ D. purge_expired_cvs — historical contract on the new discipline ═══════
do $$
declare n int;
begin
  insert into storage.objects (bucket_id, name, created_at)
  values ('cvs', 'ws9/legacy-purge.pdf', now() - interval '200 days');
  insert into job_applications (id, full_name, email, status, applied_at, created_at, updated_at, cv_path)
  values ('ws9_app_legacy', 'Legacy Purge', 'legacy@x.test', 'declined', '', now() - interval '200 days', now() - interval '200 days', 'ws9/legacy-purge.pdf');

  n := purge_expired_cvs(interval '90 days');
  if n <> 1 then raise exception 'ASSERT D: purge_expired_cvs purged % (want 1)', n; end if;
  perform 1 from job_applications where id='ws9_app_legacy' and cv_path is null;
  if not found then raise exception 'ASSERT D: cv_path not cleared (or row deleted — the row must STAY)'; end if;
  perform 1 from storage_cleanup_jobs where bucket='cvs' and storage_path='ws9/legacy-purge.pdf';
  if not found then raise exception 'ASSERT D: no confirmed-delete job for the purged cv'; end if;
  perform 1 from storage.objects where bucket_id='cvs' and name='ws9/legacy-purge.pdf';
  if not found then raise exception 'ASSERT D: object deleted DIRECTLY (bypassing the confirmed-delete queue)'; end if;
  perform 1 from retention_runs where entity='cv_links' and rows_deleted = 1;
  if not found then raise exception 'ASSERT D: purge_expired_cvs run not logged'; end if;

  n := purge_expired_cvs(interval '90 days');
  if n <> 0 then raise exception 'ASSERT D: purge_expired_cvs is not idempotent (%)', n; end if;
end $$;

-- ═══ E. THE ONE SCHEDULER ENTRY POINT + LOG SHAPE ═══════════════════════════
do $$
declare j jsonb; n int;
begin
  j := run_retention_sweep();
  if not (j ? 'contactMessagesDeleted' and j ? 'franchiseInquiriesDeleted'
          and j ? 'jobApplications' and j ? 'orphanCvJobsEnqueued') then
    raise exception 'ASSERT E: run_retention_sweep summary incomplete: %', j; end if;
  select count(*) into n from retention_runs;
  if n < 8 then raise exception 'ASSERT E: retention_runs holds % rows (want >= 8 — every sweep logs)', n; end if;
end $$;

-- ═══ F. PRIVILEGE — nothing here is client-reachable ════════════════════════
set role anon;
do $$
begin
  begin
    perform run_retention_sweep();
    raise exception 'ASSERT F: anon executed run_retention_sweep';
  exception when insufficient_privilege then null;
  end;
  begin
    perform retention_purge_job_applications(interval '1 day');
    raise exception 'ASSERT F: anon executed retention_purge_job_applications';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from retention_runs;
    raise exception 'ASSERT F: anon read retention_runs';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role authenticated;
do $$
begin
  begin
    perform run_retention_sweep();
    raise exception 'ASSERT F: authenticated executed run_retention_sweep';
  exception when insufficient_privilege then null;
  end;
  begin
    perform purge_expired_cvs(interval '1 day');
    raise exception 'ASSERT F: authenticated executed purge_expired_cvs';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from retention_runs;
    raise exception 'ASSERT F: authenticated read retention_runs';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select 'WS9 RETENTION — all assertions passed' as result;
