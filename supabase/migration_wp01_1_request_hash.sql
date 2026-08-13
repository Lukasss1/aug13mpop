-- ============================================================================
--  MIGRATION — WP01.1: request hash columns + storage cleanup queue
--  (MilkPop WP01–04 Remediation Patch Specification v1, §6.2 / §6.5)
--
--  WHAT THIS FIXES:
--    P1-R2 — an idempotency key was not bound to its payload, so a crafted
--    (or buggy) client re-using a key with CHANGED data would receive the
--    ORIGINAL submission id and believe the new data was saved. request_hash
--    stores the SHA-256 of the canonical, allow-listed, normalised payload;
--    the WP02.1 RPCs return the original row only when key AND hash match,
--    and an explicit idempotency_conflict when they don't.
--
--    §6.4/§6.5 — cv-upload (and later media-upload) must never delete a
--    Storage object it cannot PROVE is unreferenced; ambiguous outcomes are
--    parked in storage_cleanup_jobs and retried by the cleanup worker with
--    backoff instead of being destroyed on suspicion.
--
--  Columns are NULLABLE for rollout (legacy clients send no key, therefore
--  no hash). Tightening to NOT NULL is a later, separate migration once the
--  frontend rollout is complete (spec §6.2).
--
--  Forward-only, idempotent. Runs after migration_wp01_public_form_identity.
-- ============================================================================

alter table public.job_applications
  add column if not exists request_hash text;
alter table public.franchise_inquiries
  add column if not exists request_hash text;
alter table public.contact_messages
  add column if not exists request_hash text;

comment on column public.job_applications.request_hash is
  'WP01.1: SHA-256 hex of the canonical normalised payload. Same idempotency_key + same hash → original row; same key + different hash → idempotency_conflict.';
comment on column public.franchise_inquiries.request_hash is
  'WP01.1: SHA-256 hex of the canonical normalised payload (see job_applications.request_hash).';
comment on column public.contact_messages.request_hash is
  'WP01.1: SHA-256 hex of the canonical normalised payload (see job_applications.request_hash).';

-- ---------------------------------------------------------------------------
-- Cleanup job queue (spec §6.5): a durable record of every Storage object
-- whose deletion is REQUIRED but has not yet been CONFIRMED. Written only by
-- Edge Functions (service role); processed by the cleanup worker.
-- ---------------------------------------------------------------------------
create table if not exists public.storage_cleanup_jobs (
  id              uuid primary key default gen_random_uuid(),
  bucket          text not null,
  storage_path    text not null,
  reason          text not null,
  status          text not null default 'pending'
                    check (status in ('pending','processing','failed','done')),
  attempts        int  not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (bucket, storage_path)
);

comment on table public.storage_cleanup_jobs is
  'WP01.1: durable deletion queue. An object listed here is awaiting a CONFIRMED Storage delete (2xx/404). Rows are written by Edge Functions only and processed by the cleanup worker with exponential backoff — nothing is deleted "fire and forget" any more.';

drop trigger if exists trg_storage_cleanup_jobs_updated on public.storage_cleanup_jobs;
create trigger trg_storage_cleanup_jobs_updated
  before update on public.storage_cleanup_jobs
  for each row execute function set_updated_at();

create index if not exists storage_cleanup_jobs_due_idx
  on public.storage_cleanup_jobs (status, next_attempt_at);

-- Service-connection only: no browser role can see or touch the queue.
alter table public.storage_cleanup_jobs enable row level security;
revoke all on public.storage_cleanup_jobs from public;
revoke all on public.storage_cleanup_jobs from anon;
revoke all on public.storage_cleanup_jobs from authenticated;

-- ---------------------------------------------------------------------------
-- Verification (run manually after applying):
--   select column_name from information_schema.columns
--    where table_name in ('job_applications','franchise_inquiries','contact_messages')
--      and column_name = 'request_hash';                       -- 3 rows
--   select relrowsecurity from pg_class where relname = 'storage_cleanup_jobs'; -- t
--   set role anon;    select count(*) from storage_cleanup_jobs; -- permission denied
--   reset role;
-- ---------------------------------------------------------------------------
