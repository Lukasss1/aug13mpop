-- ============================================================================
--  MILK POP — MIGRATION E2: PUBLIC-FORM ABUSE CONTROLS (Block E)
--
--  Run order: after schema.sql + A1 (needs is_owner()). Safe to re-run.
--
--  WHY  (the security notes in README.md)
--  -------------------------------------
--  The careers / franchise / contact forms are INSERT-only for anon — safe
--  against reads, but open to automated spam. This adds the data backing a
--  server-side defence: a per-IP/session rate-limit + attempt log the
--  `public-form` Edge Function writes with the service-role key. The function
--  also verifies a CAPTCHA (Cloudflare Turnstile) when a secret is configured.
--
--  The anon INSERT policy on the three form tables is UNCHANGED — the Edge
--  Function inserts via the service role after its checks pass, and the direct
--  anon INSERT remains only as the honest fallback when the function/CAPTCHA
--  isn't deployed. Nothing here grants any new client capability.
-- ============================================================================

create table if not exists form_submission_log (
  id           uuid primary key default gen_random_uuid(),
  ip_hash      text not null,                 -- sha-256 of client IP (never raw)
  form_kind    text not null check (form_kind in ('careers','franchise','contact')),
  status       text not null check (status in ('accepted','rejected')),
  reject_reason text,                          -- coarse: rate_limited / captcha_failed / ...
  created_at   timestamptz not null default now()
);
create index if not exists idx_form_submission_ip_time
  on form_submission_log (ip_hash, created_at desc);

alter table form_submission_log enable row level security;

-- Append-only from the browser's view; owner-only reads. Written only by the
-- Edge Function's service-role connection (bypasses RLS).
revoke all on form_submission_log from anon;
revoke insert, update, delete on form_submission_log from authenticated;
grant  select on form_submission_log to authenticated;

drop policy if exists form_submission_log_select_owner on form_submission_log;
create policy form_submission_log_select_owner on form_submission_log
  for select to authenticated
  using (is_owner());

comment on table form_submission_log is
  'Append-only per-IP record of public-form submissions (careers/franchise/'
  'contact), written only by the public-form Edge Function via the service '
  'role. Owner-only reads; also the data source for the per-IP form rate '
  'limit. Stores a hash of the IP, never the raw address.';
