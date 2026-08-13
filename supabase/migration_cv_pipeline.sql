-- ============================================================================
--  MILK POP — MIGRATION D1: CV UPLOAD PIPELINE (Block D)
--
--  Run order:
--    1. schema.sql
--    2. migration_security_lockdown.sql   (pre-lockdown databases only)
--    3. migration_rls_per_role.sql        (A1 — defines is_manager_or_owner())
--    4. migration_auth_onboarding.sql     (A2)
--    5. migration_email_log.sql           (C1)
--    6. THIS FILE                          (D1 — CV storage + link column + rate data)
--    7. migration_activity_log.sql        (E1 — server audit; audits CV access)
--
--  Safe to re-run: create-if-not-exists / drop-policy-if-exists throughout.
--
--  WHAT THIS DOES — and, just as importantly, what it does NOT do
--  -------------------------------------------------------------
--  It re-enables candidate CV uploads, but ONLY through two server-side Edge
--  Functions (`cv-upload`, `cv-signed-url`). The bucket stays PRIVATE with NO
--  client policy of any kind — exactly as the fail-closed lockdown left it.
--  Nothing here grants anon or authenticated any access to storage.objects;
--  the ONLY writer/reader of the bucket is the Edge Functions' SERVICE-ROLE
--  connection (which bypasses RLS and lives only in function secrets).
--
--    • The private `cvs` bucket is (re)asserted private.
--    • job_applications gains a single `cv_path` TEXT column — the storage
--      OBJECT KEY (a random UUID), never a URL, never file bytes. The client
--      never sees or sends this path; `cv-signed-url` resolves it server-side.
--    • A tiny `cv_upload_ip_log` table backs the per-IP rate limit in
--      `cv-upload` (same shape/rationale as email_log's rate data: the audit
--      row and the throttle read the same source, so they cannot disagree).
--
--  RETENTION ([HUMAN] sets the period)
--  -----------------------------------
--  CVs of DECLINED candidates must be deleted after a defined period. The
--  period is a business/GDPR decision — set it, document it on the careers
--  page, then schedule `purge_expired_cvs(interval)` (defined at the bottom)
--  via pg_cron or an external scheduler. It is a no-op until you schedule it,
--  so this migration changes no data.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. STORAGE — the `cvs` bucket stays PRIVATE, still with NO client policy
-- ---------------------------------------------------------------------------
-- Re-assert private in case an older database flipped it. We deliberately add
-- NO policy on storage.objects: with RLS on and no policy, every anon AND
-- authenticated read/write is denied. Access is exclusively via the Edge
-- Functions' service-role key. Do NOT add a client upload/read policy here —
-- the whole point of Block D is that the browser never touches the bucket.
insert into storage.buckets (id, name, public)
values ('cvs', 'cvs', false)
on conflict (id) do update set public = false;

-- Belt & braces: drop any historical client policies if this runs over an old DB.
drop policy if exists "cvs_public_upload"    on storage.objects;
drop policy if exists "cvs_public_read"      on storage.objects;
drop policy if exists "cvs_candidate_upload" on storage.objects;
drop policy if exists "cvs_authenticated_read" on storage.objects;


-- ---------------------------------------------------------------------------
-- 2. LINK COLUMN — cv_path on job_applications (object key only, never bytes)
-- ---------------------------------------------------------------------------
-- IMPORTANT: this is the storage OBJECT KEY (e.g. a bare UUID), written ONLY by
-- the `cv-upload` function via the service-role key after a file has passed all
-- server-side checks. It is:
--   • not a URL (the client fetches a short-lived signed URL from cv-signed-url),
--   • not file content (base64 CV bytes were retired in the lockdown — never
--     reintroduce a cv_data column),
--   • not client-writable (job_applications has anon INSERT only, and the anon
--     INSERT policy inserts a fresh row; cv_path is set by a later service-role
--     UPDATE the client cannot perform).
alter table job_applications
  add column if not exists cv_path text;

comment on column job_applications.cv_path is
  'Storage object key of the uploaded CV in the private `cvs` bucket (random '
  'UUID, set ONLY by the cv-upload Edge Function via the service-role key). '
  'Never a URL and never file bytes. Managers/owners fetch a short-lived '
  'signed URL through the cv-signed-url function, which resolves this key '
  'server-side — the client never names a storage path.';

-- If a pre-lockdown database still has the retired CV columns, remove them so
-- the retired base64/URL path cannot silently return. (No-op if absent.)
alter table job_applications drop column if exists cv_data;
alter table job_applications drop column if exists cv_url;


-- ---------------------------------------------------------------------------
-- 3. RATE-LIMIT DATA — per-IP upload attempts (backs cv-upload's throttle)
-- ---------------------------------------------------------------------------
-- One row per upload ATTEMPT the function handles (accepted or rejected), keyed
-- by a coarse client IP. Same design as email_log's rate data: the function
-- reads recent rows to decide the per-IP limit, so the record and the throttle
-- share one source of truth. Written ONLY by the function (service role);
-- owner-read-only; no client write/alter of any kind.
create table if not exists cv_upload_ip_log (
  id            uuid primary key default gen_random_uuid(),
  ip_hash       text not null,                 -- sha-256 of client IP (never the raw IP)
  application_id text,                          -- job_applications.id the upload targeted
  object_key    text,                           -- the stored object key when accepted
  status        text not null check (status in ('accepted','rejected')),
  reject_reason text,                            -- coarse code, e.g. bad_mime / too_large / rate_limited
  created_at    timestamptz not null default now()
);
create index if not exists idx_cv_upload_ip_time
  on cv_upload_ip_log (ip_hash, created_at desc);

alter table cv_upload_ip_log enable row level security;

-- No client may write or read except owners (for review). Verbs stripped back
-- to the minimum; with RLS on and no insert/update/delete policy, those verbs
-- are denied for every client role — append-only from the browser's view.
revoke all on cv_upload_ip_log from anon;
revoke insert, update, delete on cv_upload_ip_log from authenticated;
grant  select on cv_upload_ip_log to authenticated;   -- still gated by the policy below

drop policy if exists cv_upload_ip_log_select_owner on cv_upload_ip_log;
create policy cv_upload_ip_log_select_owner on cv_upload_ip_log
  for select to authenticated
  using (is_owner());

comment on table cv_upload_ip_log is
  'Append-only per-IP record of cv-upload attempts (accepted or rejected). '
  'Written only by the cv-upload Edge Function via the service-role key; '
  'owner-only reads; also the data source for the per-IP upload rate limit. '
  'Stores a hash of the IP, never the raw address.';


-- ---------------------------------------------------------------------------
-- 4. RETENTION — purge_expired_cvs(interval)  ([HUMAN] schedules + sets period)
-- ---------------------------------------------------------------------------
-- Deletes the stored CV object AND clears cv_path for DECLINED applications
-- older than the given age. Runs as the definer so it can reach storage; it is
-- NOT granted to anon/authenticated — schedule it (pg_cron) or call it from a
-- trusted server context. It is idempotent and safe to run repeatedly.
--
-- Example (retain declined-candidate CVs for 6 months — [HUMAN] confirm):
--    select purge_expired_cvs(interval '6 months');
--    -- with pg_cron, once daily:
--    -- select cron.schedule('purge-cvs','0 3 * * *',
--    --   $$select purge_expired_cvs(interval '6 months')$$);
create or replace function purge_expired_cvs(retain interval)
returns integer
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  purged integer := 0;
  r record;
begin
  for r in
    select id, cv_path
      from job_applications
     where status = 'declined'
       and cv_path is not null
       and updated_at < now() - retain
  loop
    -- Remove the stored object first; only clear the link if that succeeds so a
    -- storage failure doesn't orphan the file with no pointer to it.
    delete from storage.objects where bucket_id = 'cvs' and name = r.cv_path;
    update job_applications set cv_path = null where id = r.id;
    purged := purged + 1;
  end loop;
  return purged;
end $$;

revoke all on function purge_expired_cvs(interval) from public;
revoke all on function purge_expired_cvs(interval) from anon;
revoke all on function purge_expired_cvs(interval) from authenticated;

comment on function purge_expired_cvs(interval) is
  'Deletes the stored CV object and clears cv_path for DECLINED applications '
  'older than the given interval. Schedule via pg_cron with the retention '
  'period [HUMAN] decides; documented on the careers page. Not client-callable.';


-- ============================================================================
-- 5. HANDOVER NOTES for D1
-- ============================================================================
-- (a) The bucket has NO storage.objects policy on purpose. If you ever see a
--     "cvs_*" policy on storage.objects, someone re-opened the direct-upload
--     hole — remove it. All access flows through the two Edge Functions.
--
-- (b) cv_path is an object KEY, not a URL and not bytes. The client never sends
--     or receives it. cv-signed-url resolves it server-side and returns a
--     short-lived signed URL; cv-upload sets it via the service role.
--
-- (c) Retention is a [HUMAN] decision: pick the period, document it on the
--     careers page, and schedule purge_expired_cvs(). Until scheduled it does
--     nothing — this migration changes no data.
-- ============================================================================
