-- ============================================================================
--  MILK POP — MIGRATION C1: E-MAIL AUDIT LOG (email_log)
--
--  Run order:
--    1. schema.sql
--    2. migration_security_lockdown.sql   (pre-lockdown databases only)
--    3. migration_rls_per_role.sql        (A1 — defines is_owner(), used below)
--    4. migration_auth_onboarding.sql     (A2)
--    5. THIS FILE                          (C1 — e-mail audit + rate-limit data)
--
--  Safe to re-run: create-if-not-exists / drop-policy-if-exists throughout.
--
--  WHAT THIS DOES
--  --------------
--  One row is written for EVERY attempt the rebuilt `send-email` Edge Function
--  handles after the caller has been identified — sent, provider-failed, or
--  rejected (bad template, out-of-scope recipient, rate-limited…). The same
--  rows are the data source for the function's per-caller and per-recipient
--  hourly rate limits, so the audit trail and the throttle can never disagree.
--
--  SECURITY MODEL — read before editing
--  ------------------------------------
--  • Rows are written EXCLUSIVELY by the Edge Function using the project's
--    SERVICE-ROLE key (which bypasses RLS and lives only in Edge Function
--    secrets — never in this repo or any client). This is the server-side,
--    append-only audit logging the security notes in README.md calls for,
--    scoped to e-mail.
--  • No INSERT / UPDATE / DELETE policy exists for `anon` or `authenticated`,
--    and the verbs are explicitly revoked below — so browser-side code cannot
--    write, backdate, or purge audit rows even if a grant slips in later.
--  • Reads are OWNER-ONLY (matches audit_logs in A1: "Owner-only: audit log
--    reads"). anon has no access of any kind.
-- ============================================================================

create table if not exists email_log (
  id               uuid primary key default gen_random_uuid(),

  -- WHO sent (identified server-side from the verified JWT, never the client)
  sent_by_auth_id  uuid not null,           -- auth.users.id of the caller
  sent_by_staff_id text,                    -- staff_profiles.id at send time
  sent_by_name     text not null default '',
  sent_by_role     text not null default '',

  -- WHAT was sent
  template_id      text not null,           -- server-side template catalogue id
  recipient_kind   text not null,           -- staff | application | franchise | contact | self
  recipient_ref    text,                    -- the DB row id the recipient was resolved from
  recipient_email  text not null default '',
  subject          text not null default '',

  -- OUTCOME
  --   sending        row created, provider call in flight (crash-safe marker)
  --   sent           provider accepted the message
  --   provider_error provider rejected / unreachable
  --   rejected       refused before any provider call (reject_reason says why)
  status           text not null check (status in ('sending','sent','provider_error','rejected')),
  reject_reason    text,                    -- coarse machine code, e.g. rate_limited_caller
  provider_id      text,                    -- Resend message id when sent

  created_at       timestamptz not null default now()
);

-- The two rate-limit lookups the Edge Function performs every send.
create index if not exists idx_email_log_caller_time
  on email_log (sent_by_auth_id, created_at desc);
create index if not exists idx_email_log_recipient_time
  on email_log (recipient_email, created_at desc);

alter table email_log enable row level security;

-- Belt & braces: even if Supabase default privileges auto-granted verbs when
-- the table was created, strip everything client-facing back to the minimum.
revoke all on email_log from anon;
revoke insert, update, delete on email_log from authenticated;
grant  select on email_log to authenticated;   -- rows still gated by the policy below

-- Owner-only reads. There is INTENTIONALLY no insert/update/delete policy for
-- any client role: with RLS enabled and no policy, those verbs are denied —
-- append-only from the browser's point of view. Only the Edge Function's
-- SERVICE-ROLE connection (which bypasses RLS) writes here.
drop policy if exists email_log_select_owner on email_log;
create policy email_log_select_owner on email_log
  for select to authenticated
  using (is_owner());

comment on table email_log is
  'Append-only audit of every send-email Edge Function attempt (sent, failed '
  'or rejected). Written only by the function via the SERVICE-ROLE key; '
  'owner-only reads; also the data source for the per-caller and '
  'per-recipient hourly rate limits.';
