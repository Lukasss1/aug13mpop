-- ============================================================================
--  MIGRATION: authenticated inbox reads  (supabase/migration_inbox_read.sql)
--
--  Before this migration the three public-form tables were INSERT-only for
--  everyone (anon and authenticated alike), so the admin panel could not show
--  real submissions — reviewing them meant opening the Supabase dashboard.
--  This adds the missing, tightly-scoped read path for signed-in staff:
--
--    job_applications    SELECT → store managers + owners
--                        UPDATE → status column ONLY (managers + owners)
--    franchise_inquiries SELECT → owners only
--                        UPDATE → status column ONLY (owners)
--    contact_messages    SELECT → store managers + owners (no update; the
--                        table has no workflow column)
--
--  SECURITY INVARIANTS (all preserved)
--   • anon gains NOTHING here — every grant/policy targets `authenticated`,
--     and rows are still gated by is_owner()/is_manager_or_owner() from
--     migration_rls_per_role.sql, which resolve the caller's role from
--     staff_profiles via their verified JWT. A random signed-up account with
--     no staff profile matches no policy and sees nothing.
--   • UPDATE is a COLUMN-LEVEL grant on `status` only, so even an owner
--     session cannot rewrite an applicant's name, e-mail or message through
--     the API — the submission stays an untampered record.
--   • No DELETE for anyone: the inbox is append + triage. Removing rows (e.g.
--     a GDPR erasure request) is a deliberate act done in the Supabase
--     dashboard, where it is captured by Postgres audit logging.
--
--  DEPENDS ON: migration_rls_per_role.sql (helper functions + RLS enabled).
--  Idempotent: safe to re-run.
-- ============================================================================

-- --------------------------------------------------------------------------
-- 1. Verb-level grants (RLS below still decides WHICH rows)
-- --------------------------------------------------------------------------
grant select on job_applications, franchise_inquiries, contact_messages
  to authenticated;
grant update (status) on job_applications  to authenticated;
grant update (status) on franchise_inquiries to authenticated;

-- --------------------------------------------------------------------------
-- 2. Row policies
-- --------------------------------------------------------------------------
drop policy if exists applications_select_mgr on job_applications;
create policy applications_select_mgr on job_applications
  for select to authenticated
  using (is_manager_or_owner());

drop policy if exists applications_update_mgr on job_applications;
create policy applications_update_mgr on job_applications
  for update to authenticated
  using (is_manager_or_owner())
  with check (is_manager_or_owner());

drop policy if exists franchise_select_owner on franchise_inquiries;
create policy franchise_select_owner on franchise_inquiries
  for select to authenticated
  using (is_owner());

drop policy if exists franchise_update_owner on franchise_inquiries;
create policy franchise_update_owner on franchise_inquiries
  for update to authenticated
  using (is_owner())
  with check (is_owner());

drop policy if exists contact_select_mgr on contact_messages;
create policy contact_select_mgr on contact_messages
  for select to authenticated
  using (is_manager_or_owner());

-- --------------------------------------------------------------------------
-- 3. Post-run check (paste in the SQL editor if you want proof):
--      select * from pg_policies
--      where tablename in
--        ('job_applications','franchise_inquiries','contact_messages');
--    You should see public_insert (anon+authenticated) plus the five
--    policies above — and nothing granting anon any SELECT.
-- --------------------------------------------------------------------------
