-- ============================================================================
--  MILK POP — MIGRATION STAGE3-WS9: PERSONAL-DATA RETENTION (R4.5.1)
--
--  Implements the WS9 items docs/STAGE3-RETENTION-AND-DELETION.md recorded as
--  pending, and closes the OPT-01 carry-over blocker documented in
--  docs/HOSTING.md ("Media cleanup: deployment ≠ enablement"):
--
--    1. CLAIM-TIME REFERENCE RE-CHECK (the blocker). A storage_cleanup_jobs
--       row for the `cvs` bucket may describe an object whose database link
--       committed while the upload's HTTP response was lost. The deletion
--       executor must therefore re-check job_applications.cv_path AT CLAIM
--       TIME, inside the same transaction that claims the job:
--         • a REFERENCED CV is never claimed and never deleted — the job is
--           closed as status='reconciled' (the race loser was the delete);
--         • a database verification failure aborts the claim query, so
--           nothing is handed to the deleter — it retries later;
--         • only a job whose object is provably unreferenced at claim time
--           is returned for a confirmed Storage delete.
--       (The media pipeline already had this discipline —
--       claim_media_cleanup_batch demotes re-referenced objects; this brings
--       the CV/registration job queue up to the same invariant.)
--
--    2. RETENTION SWEEPS — controlled, idempotent, logged deletion for the
--       three personal-data inboxes:
--         • retention_purge_contact_messages(retain)
--         • retention_purge_franchise_inquiries(retain)
--         • retention_purge_job_applications(retain)   [declined only; the
--           application METADATA row is deleted together with an enqueued,
--           confirmed-delete job for its CV object]
--       plus retention_enqueue_orphan_cvs(grace) — Storage objects in `cvs`
--       that no application references (and no live job already covers) are
--       queued for confirmed deletion. run_retention_sweep(...) is the ONE
--       scheduler entry point.
--
--    3. RETENTION LOG — public.retention_runs. Every sweep writes one row per
--       entity with the cutoff and counts, so "deletion is logged" is a table
--       fact, not a console line. Append-only from the API roles (RLS on,
--       zero policies, revoked) exactly like mp_migration_ledger.
--
--    4. purge_expired_cvs(interval) — the historical function kept its
--       signature and its contract (declined applications older than the
--       period lose the FILE and the link; the metadata row stays) but its
--       body now follows the confirmed-delete discipline: it ENQUEUES the
--       object into storage_cleanup_jobs instead of deleting the
--       storage.objects row directly. Deleting only the registry row never
--       removed the underlying stored bytes — that was itself an
--       orphan-creating path, which WS9 exists to close.
--
--  DELETION EXECUTOR: storage_cleanup_jobs rows are processed by the
--  media-cleanup Edge Function, which performs the HTTP Storage delete and
--  records success ONLY on a confirmed 2xx/404 (spec §11). These sweeps mark
--  and log; nothing here talks to Storage directly.
--
--  IDEMPOTENCY: every sweep is safe to re-run — deletion criteria are
--  absolute cutoffs, enqueues are ON CONFLICT DO NOTHING against the
--  (bucket, storage_path) uniqueness, and a second run over the same data
--  deletes/enqueues zero and logs that honestly.
--
--  SCHEDULING ([HUMAN] decides the periods, launch driver §7 records them):
--    select cron.schedule('mp-retention','0 3 * * *',
--      $$select run_retention_sweep()$$);
--
--  Executable proof: npm run test:retention (scripts/retention.test.sh) —
--  the behavioural evidence the MEDIA_CLEANUP_ENABLED gate (env validator
--  rule R8) now requires before cleanup may be enabled.
--
--  Deploy order: after migration_stage3_ws7c_payment_corrections.sql
--  (appended to MP_FUTURE_MIGRATIONS). Idempotent throughout.
-- ============================================================================

set client_min_messages to warning;

-- ----------------------------------------------------------------------------
-- 0. storage_cleanup_jobs: allow the terminal 'reconciled' status — a job
--    closed WITHOUT deletion because the object turned out to be referenced.
--    'done' keeps meaning "the object is confirmed gone"; the two must never
--    be conflated in an audit.
-- ----------------------------------------------------------------------------
alter table public.storage_cleanup_jobs
  drop constraint if exists storage_cleanup_jobs_status_check;
alter table public.storage_cleanup_jobs
  add constraint storage_cleanup_jobs_status_check
  check (status in ('pending','processing','failed','done','reconciled'));

comment on table public.storage_cleanup_jobs is
  'WP01.1/WS9: durable deletion queue. An object listed here is awaiting a '
  'CONFIRMED Storage delete (2xx/404). Rows are written by Edge Functions and '
  'the WS9 retention sweeps only. claim_storage_cleanup_batch re-checks '
  'job_applications.cv_path at claim time: a referenced CV is closed as '
  'status=reconciled and is NEVER deleted; done = object confirmed gone.';

-- Fast claim-time anti-join and orphan sweep.
create index if not exists job_applications_cv_path_idx
  on public.job_applications (cv_path)
  where cv_path is not null;

-- ----------------------------------------------------------------------------
-- 1. THE CLAIM-TIME RE-CHECK. Same signature, same grants surface as the
--    original (revoked from anon/authenticated; the service role executes it).
--    The reconcile UPDATE and the claim UPDATE run in the caller's one
--    statement transaction: if the reference query cannot complete, the whole
--    claim fails and NOTHING is returned to the deleter — retry later, never
--    delete on uncertainty.
-- ----------------------------------------------------------------------------
create or replace function public.claim_storage_cleanup_batch(p_limit integer default 20)
returns setof public.storage_cleanup_jobs
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  -- (a) Reconcile first: any due CV job whose object is REFERENCED right now
  --     is closed without deletion. This is the race-loser resolution the
  --     invariant requires — the upload's DB link won; the delete stands down.
  update storage_cleanup_jobs j
     set status = 'reconciled',
         last_error = 'referenced: job_applications.cv_path matches at claim time; object retained',
         updated_at = now()
   where j.bucket = 'cvs'
     and j.status in ('pending','failed')
     and j.next_attempt_at <= now()
     and exists (select 1 from job_applications a where a.cv_path = j.storage_path);

  -- (b) Claim only what is provably unreferenced AT THIS MOMENT. The guard is
  --     repeated inside the locked selection so a job re-referenced between
  --     (a) and (b) still cannot be handed out.
  return query
    update storage_cleanup_jobs j
       set status = 'processing', attempts = attempts + 1, updated_at = now()
     where j.id in (
       select s.id from storage_cleanup_jobs s
        where s.status in ('pending','failed')
          and s.next_attempt_at <= now()
          and not (
            s.bucket = 'cvs'
            and exists (select 1 from job_applications a where a.cv_path = s.storage_path)
          )
        order by s.next_attempt_at
        limit greatest(p_limit, 1)
        for update skip locked
     )
    returning j.*;
end;
$$;

revoke all on function public.claim_storage_cleanup_batch(integer) from public;
revoke all on function public.claim_storage_cleanup_batch(integer) from anon, authenticated;

comment on function public.claim_storage_cleanup_batch(integer) is
  'WS9: skip-locked claim for the cleanup worker WITH the claim-time CV '
  'reference re-check. A job whose cvs object is referenced by any '
  'job_applications.cv_path is closed as reconciled (never deleted); a '
  'reference-verification failure aborts the claim (nothing is deleted on '
  'uncertainty). Not client-callable.';

-- ----------------------------------------------------------------------------
-- 2. RETENTION LOG — append-only bookkeeping for every sweep run.
-- ----------------------------------------------------------------------------
create table if not exists public.retention_runs (
  id            uuid primary key default gen_random_uuid(),
  entity        text not null,
  cutoff        timestamptz,
  rows_deleted  integer not null default 0,
  jobs_enqueued integer not null default 0,
  details       jsonb,
  ran_at        timestamptz not null default now()
);
do $ws9ck$ begin
  if not exists (select 1 from pg_constraint where conname = 'retention_runs_entity_ck') then
    alter table public.retention_runs add constraint retention_runs_entity_ck
      check (entity in ('contact_messages','franchise_inquiries','job_applications',
                        'cv_orphans','cv_links'));
  end if;
end $ws9ck$;

comment on table public.retention_runs is
  'WS9 retention log: one row per sweep per entity — the cutoff applied, rows '
  'deleted and cleanup jobs enqueued. Written only by the retention functions '
  '(SECURITY DEFINER); RLS on with zero policies and all API-role grants '
  'revoked, so the browser roles can neither read nor forge it. Not '
  'application data.';

alter table public.retention_runs enable row level security;
revoke all on table public.retention_runs from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. THE SWEEPS. All SECURITY DEFINER, all revoked from the API roles — they
--    run from pg_cron (or a trusted service-role caller), never a browser.
--    Each returns its counts AND logs them; each is a no-op the second time.
-- ----------------------------------------------------------------------------

-- 3a. Contact messages: hard delete past the retention period.
create or replace function public.retention_purge_contact_messages(retain interval)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_cutoff  timestamptz := now() - retain;
  v_deleted integer;
begin
  delete from contact_messages where created_at < v_cutoff;
  get diagnostics v_deleted = row_count;
  insert into retention_runs (entity, cutoff, rows_deleted)
  values ('contact_messages', v_cutoff, v_deleted);
  return v_deleted;
end;
$$;

-- 3b. Franchise enquiries: hard delete past the retention period.
create or replace function public.retention_purge_franchise_inquiries(retain interval)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_cutoff  timestamptz := now() - retain;
  v_deleted integer;
begin
  delete from franchise_inquiries where created_at < v_cutoff;
  get diagnostics v_deleted = row_count;
  insert into retention_runs (entity, cutoff, rows_deleted)
  values ('franchise_inquiries', v_cutoff, v_deleted);
  return v_deleted;
end;
$$;

-- 3c. Declined job applications past retention: the METADATA row is deleted
--     and the CV object (when present) is enqueued for a confirmed Storage
--     delete IN THE SAME TRANSACTION. The queue row is the durable pointer to
--     the file after the metadata is gone, so a Storage outage can never
--     orphan an unlisted object. Non-declined applications are untouched.
create or replace function public.retention_purge_job_applications(retain interval)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_cutoff   timestamptz := now() - retain;
  v_deleted  integer := 0;
  v_enqueued integer := 0;
begin
  with expired as (
    select id, cv_path
      from job_applications
     where status = 'declined'
       and updated_at < v_cutoff
  ),
  enqueue as (
    insert into storage_cleanup_jobs (bucket, storage_path, reason)
    select 'cvs', e.cv_path, 'ws9_retention: declined application purged'
      from expired e
     where e.cv_path is not null and e.cv_path <> ''
    on conflict (bucket, storage_path) do nothing
    returning 1
  ),
  removed as (
    delete from job_applications a
     using expired e
     where a.id = e.id
    returning 1
  )
  select coalesce((select count(*) from removed), 0),
         coalesce((select count(*) from enqueue), 0)
    into v_deleted, v_enqueued;

  insert into retention_runs (entity, cutoff, rows_deleted, jobs_enqueued)
  values ('job_applications', v_cutoff, v_deleted, v_enqueued);
  return jsonb_build_object('deleted', v_deleted, 'cvJobsEnqueued', v_enqueued);
end;
$$;

-- 3d. Orphaned CV objects: present in Storage, referenced by NOTHING — no
--     application row, and no live queue row already covering them. Older
--     than the grace period (so an in-flight upload whose row has not yet
--     committed is never swept). Enqueued, not deleted — the executor's
--     claim-time re-check runs again before any byte is removed.
create or replace function public.retention_enqueue_orphan_cvs(grace interval default interval '48 hours')
returns integer
language plpgsql
security definer
set search_path to 'public', 'storage', 'pg_temp'
as $$
declare
  v_cutoff   timestamptz := now() - grace;
  v_enqueued integer := 0;
begin
  with orphans as (
    select o.name
      from storage.objects o
     where o.bucket_id = 'cvs'
       and o.created_at < v_cutoff
       and not exists (select 1 from job_applications a where a.cv_path = o.name)
  ),
  enqueue as (
    insert into storage_cleanup_jobs (bucket, storage_path, reason)
    select 'cvs', orphans.name, 'ws9_retention: orphaned storage object'
      from orphans
    on conflict (bucket, storage_path) do nothing
    returning 1
  )
  select coalesce((select count(*) from enqueue), 0) into v_enqueued;

  insert into retention_runs (entity, cutoff, jobs_enqueued)
  values ('cv_orphans', v_cutoff, v_enqueued);
  return v_enqueued;
end;
$$;

-- 3e. ONE scheduler entry point. Defaults are deliberately conservative;
--     [HUMAN] confirms the real periods at launch driver §2/§7 and passes
--     them explicitly in the cron expression if they differ.
create or replace function public.run_retention_sweep(
  p_contact_retain      interval default interval '24 months',
  p_franchise_retain    interval default interval '24 months',
  p_applications_retain interval default interval '6 months',
  p_orphan_grace        interval default interval '48 hours'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_contact   integer;
  v_franchise integer;
  v_apps      jsonb;
  v_orphans   integer;
begin
  v_contact   := retention_purge_contact_messages(p_contact_retain);
  v_franchise := retention_purge_franchise_inquiries(p_franchise_retain);
  v_apps      := retention_purge_job_applications(p_applications_retain);
  v_orphans   := retention_enqueue_orphan_cvs(p_orphan_grace);
  return jsonb_build_object(
    'contactMessagesDeleted',   v_contact,
    'franchiseInquiriesDeleted', v_franchise,
    'jobApplications',          v_apps,
    'orphanCvJobsEnqueued',     v_orphans
  );
end;
$$;

revoke all on function public.retention_purge_contact_messages(interval)   from public, anon, authenticated;
revoke all on function public.retention_purge_franchise_inquiries(interval) from public, anon, authenticated;
revoke all on function public.retention_purge_job_applications(interval)   from public, anon, authenticated;
revoke all on function public.retention_enqueue_orphan_cvs(interval)       from public, anon, authenticated;
revoke all on function public.run_retention_sweep(interval, interval, interval, interval) from public, anon, authenticated;

comment on function public.run_retention_sweep(interval, interval, interval, interval) is
  'WS9: the one scheduled retention entry point — purges contact messages, '
  'franchise enquiries and declined job applications past their periods '
  '(metadata + a confirmed-delete job for the CV object together), and queues '
  'orphaned cvs objects. Idempotent; every run is logged in retention_runs. '
  'Not client-callable.';

-- ----------------------------------------------------------------------------
-- 4. purge_expired_cvs — historical contract kept (declined + older than the
--    period → the FILE goes and cv_path clears; the row stays), body brought
--    up to the confirmed-delete discipline. The old body deleted the
--    storage.objects registry row directly, which never removed the stored
--    bytes and so ORPHANED the object — the exact class of leak WS9 closes.
-- ----------------------------------------------------------------------------
create or replace function public.purge_expired_cvs(retain interval)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_cutoff   timestamptz := now() - retain;
  v_purged   integer := 0;
  v_enqueued integer := 0;
begin
  with expired as (
    select id, cv_path
      from job_applications
     where status = 'declined'
       and cv_path is not null and cv_path <> ''
       and updated_at < v_cutoff
  ),
  enqueue as (
    insert into storage_cleanup_jobs (bucket, storage_path, reason)
    select 'cvs', e.cv_path, 'ws9_retention: cv link purged (purge_expired_cvs)'
      from expired e
    on conflict (bucket, storage_path) do nothing
    returning 1
  ),
  cleared as (
    update job_applications a
       set cv_path = null
      from expired e
     where a.id = e.id
    returning 1
  )
  select coalesce((select count(*) from cleared), 0),
         coalesce((select count(*) from enqueue), 0)
    into v_purged, v_enqueued;

  -- v_enqueued can be lower than v_purged only when a job for that object
  -- already exists — the queue's (bucket, storage_path) uniqueness at work.
  insert into retention_runs (entity, cutoff, rows_deleted, jobs_enqueued, details)
  values ('cv_links', v_cutoff, v_purged, v_enqueued,
          jsonb_build_object('function', 'purge_expired_cvs'));
  return v_purged;
end;
$$;

revoke all on function public.purge_expired_cvs(interval) from public;
revoke all on function public.purge_expired_cvs(interval) from anon;
revoke all on function public.purge_expired_cvs(interval) from authenticated;

comment on function public.purge_expired_cvs(interval) is
  'Clears cv_path and enqueues a CONFIRMED Storage delete for DECLINED '
  'applications older than the given interval (metadata row retained — use '
  'retention_purge_job_applications to delete the row as well). Idempotent; '
  'logged in retention_runs. Schedule via pg_cron. Not client-callable.';
