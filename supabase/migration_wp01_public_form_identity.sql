-- ============================================================================
--  MIGRATION — WP-01: public-form identity + idempotent submission arbiter
--  (MilkPop Production Remediation Technical Pack v1, Work Package 01)
--
--  WHAT THIS FIXES (P0-01):
--    The public-form Edge Function has always minted the row id server-side
--    (PUB-001) but never RETURNED it, so the browser carried on using its own
--    obsolete `app_<timestamp>` value — and the Careers CV upload then failed
--    deterministically against a row id that does not exist. The function now
--    returns { ok, submissionId }; this migration adds the database arbiter
--    that makes a client network-retry of the SAME submission resolve to the
--    SAME row (and therefore the same submissionId) instead of a second row.
--
--  DESIGN:
--    • One nullable `idempotency_key uuid` column per public form table.
--      NULL = legacy rows / clients that sent no key. Postgres treats NULLs
--      as distinct in a unique index, so legacy data is untouched and clients
--      without a key are never blocked.
--    • A UNIQUE INDEX (not constraint — CREATE UNIQUE INDEX supports
--      IF NOT EXISTS, keeping this migration idempotent) is the atomic
--      arbiter: two racing inserts with the same key → exactly one row; the
--      loser receives unique_violation (PostgREST 409) and the Edge Function
--      answers with the FIRST row's id. No check-then-insert race exists.
--    • No grant or policy changes. anon/authenticated INSERT was closed in
--      migration_phase_b_public_forms.sql; only the service role writes these
--      tables, and the existing table-level SELECT grant (inbox readers)
--      covers the new column automatically.
--
--  Forward-only and idempotent: safe to re-run. Run order: any time after the
--  three tables exist; listed in launch.sh immediately before Phase B.
-- ============================================================================

alter table public.job_applications
  add column if not exists idempotency_key uuid;
alter table public.franchise_inquiries
  add column if not exists idempotency_key uuid;
alter table public.contact_messages
  add column if not exists idempotency_key uuid;

comment on column public.job_applications.idempotency_key is
  'WP-01: client-generated per-attempt UUID. Unique when present; the public-form Edge Function resolves a duplicate insert (network retry) to the original row id.';
comment on column public.franchise_inquiries.idempotency_key is
  'WP-01: client-generated per-attempt UUID. Unique when present; duplicate submits resolve to the original row.';
comment on column public.contact_messages.idempotency_key is
  'WP-01: client-generated per-attempt UUID. Unique when present; duplicate submits resolve to the original row.';

create unique index if not exists job_applications_idempotency_key_uq
  on public.job_applications (idempotency_key);
create unique index if not exists franchise_inquiries_idempotency_key_uq
  on public.franchise_inquiries (idempotency_key);
create unique index if not exists contact_messages_idempotency_key_uq
  on public.contact_messages (idempotency_key);

-- ---------------------------------------------------------------------------
-- Verification (run manually after applying):
--   select indexname from pg_indexes
--    where tablename in ('job_applications','franchise_inquiries','contact_messages')
--      and indexname like '%idempotency_key_uq';
-- Expect three rows. Then confirm anon still cannot write:
--   set role anon;
--   insert into job_applications (id, full_name, email) values ('x','x','x@x.xx');
--   -- must fail with RLS/permission error
--   reset role;
-- ---------------------------------------------------------------------------
