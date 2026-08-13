-- ============================================================================
--  MILK POP — MIGRATION E1: SERVER-SIDE ACTIVITY LOG (activity_log)
--
--  Run order:
--    1. schema.sql
--    2. migration_security_lockdown.sql   (pre-lockdown databases only)
--    3. migration_rls_per_role.sql        (A1 — defines is_owner())
--    4. migration_auth_onboarding.sql     (A2)
--    5. migration_email_log.sql           (C1)
--    6. migration_cv_pipeline.sql         (D1)
--    7. THIS FILE                          (E1 — server audit for privileged actions)
--
--  Safe to re-run: create-if-not-exists / drop-policy-if-exists throughout.
--
--  WHY THIS EXISTS  (the security notes in README.md)
--  -------------------------------------------------
--  Block C shipped `email_log`: server-written, append-only, owner-read-only —
--  the pattern for auditing privileged actions. This file EXTENDS that exact
--  pattern to the remaining privileged actions the task names — PAYROLL,
--  PERMISSIONS and SETTINGS — plus CV access (used by cv-signed-url).
--
--  Because those actions still run through the app (not yet all behind Edge
--  Functions), the ONLY trustworthy audit is one the client cannot forge,
--  backdate or purge. So, like email_log:
--    • Rows are written EXCLUSIVELY by trusted server code using the project's
--      SERVICE-ROLE key (Edge Functions today; the same key for any server
--      action added later). The service-role key bypasses RLS and lives only
--      in Edge Function secrets — never in this repo or any client.
--    • No INSERT/UPDATE/DELETE policy exists for anon or authenticated, and the
--      verbs are explicitly revoked — the browser cannot write, alter or purge
--      audit rows even if a grant slips in later. Append-only by construction.
--    • Reads are OWNER-ONLY.
--
--  This is what lets us REMOVE the client "Purge Registry" capability: the
--  authoritative log is the server-written one here, which no client can touch.
--  The old client-written `audit_logs` rows remain informational only (and are
--  already owner-read / no-update / no-delete under A1).
-- ============================================================================

create table if not exists activity_log (
  id             uuid primary key default gen_random_uuid(),

  -- WHO acted (identified server-side from the verified JWT, never the client)
  actor_auth_id  uuid,                     -- auth.users.id of the actor (null for system)
  actor_staff_id text,                     -- staff_profiles.id at action time
  actor_name     text not null default '',
  actor_role     text not null default '',

  -- WHAT happened. `action` is a coarse machine code; keep it stable.
  --   payroll_generate | payroll_send | payslip_delete
  --   permissions_update
  --   settings_update
  --   cv_access
  action         text not null,
  target_kind    text,                      -- e.g. payslip | role_permission | site_settings | job_application
  target_ref     text,                      -- the row id / key the action targeted
  outcome        text not null default 'ok' check (outcome in ('ok','granted','denied','error')),
  detail         text,                      -- coarse reason / summary — never secrets or PII dumps

  created_at     timestamptz not null default now()
);

-- Common lookups: by actor over time, and by target.
create index if not exists idx_activity_log_actor_time on activity_log (actor_auth_id, created_at desc);
create index if not exists idx_activity_log_action_time on activity_log (action, created_at desc);
create index if not exists idx_activity_log_target on activity_log (target_kind, target_ref);

alter table activity_log enable row level security;

-- Belt & braces: strip everything client-facing back to the minimum. Even if a
-- default privilege auto-granted verbs at create time, the browser cannot write.
revoke all on activity_log from anon;
revoke insert, update, delete on activity_log from authenticated;
grant  select on activity_log to authenticated;   -- rows still gated by the policy below

-- Owner-only reads. There is INTENTIONALLY no insert/update/delete policy for
-- any client role: with RLS enabled and no policy, those verbs are denied —
-- append-only from the browser's point of view. Only server code using the
-- SERVICE-ROLE connection (which bypasses RLS) writes here.
drop policy if exists activity_log_select_owner on activity_log;
create policy activity_log_select_owner on activity_log
  for select to authenticated
  using (is_owner());

comment on table activity_log is
  'Append-only audit of privileged actions (payroll, permissions, settings, CV '
  'access). Written only by trusted server code via the SERVICE-ROLE key; '
  'owner-only reads; no client INSERT/UPDATE/DELETE. Extends the email_log '
  'pattern to satisfy the security notes in README.md and lets the client '
  '"Purge Registry" capability be removed.';


-- ---------------------------------------------------------------------------
-- HANDOVER NOTE
-- ---------------------------------------------------------------------------
-- As payroll/permissions/settings mutations are migrated behind Edge Functions
-- (or any server action), have each write ONE activity_log row via the service
-- role at the point the action succeeds or is refused — exactly as
-- cv-signed-url already writes `cv_access` rows here. Never write activity_log
-- from the browser; a client-written audit row is worthless as evidence.
-- ============================================================================
