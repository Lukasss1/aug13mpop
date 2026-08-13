-- ============================================================================
--  MILK POP — MIGRATION S9a (STAGE 9): STAFF LIFECYCLE COLUMNS
--
--  Run order: AFTER migration_rls_per_role.sql and BEFORE
--  migration_staff_documents_storage.sql / migration_stage4_training.sql
--  (their functions and triggers read staff_profiles.status).
--  Safe to re-run.
--
--  Adds the columns the onboarding pipeline needs:
--    • status      — 'active' | 'disabled'. A disabled employee is refused by
--                    every Edge Function and keeps no internal access.
--    • onboarding  — the honest lifecycle label shown in the staff directory:
--                    profile_created → invited → active   (disabled overrides)
--    • invited_at  — when the last Supabase Auth invitation went out.
--
--  The `staff-invite` Edge Function (service role) is the ONLY writer of
--  onboarding/invited_at; auth linking on first sign-in stays with
--  link_staff_profile(). The browser cannot set these fields: the update
--  grant below deliberately omits them, and status is locked to owners by
--  the staff_profiles_protect trigger.
-- ============================================================================

alter table staff_profiles add column if not exists status text not null default 'active'
  check (status in ('active','disabled'));
alter table staff_profiles add column if not exists onboarding text not null default 'profile_created'
  check (onboarding in ('profile_created','invited','active'));
alter table staff_profiles add column if not exists invited_at timestamptz;

create index if not exists idx_staff_profiles_status on staff_profiles (status);

-- A disabled employee's sessions lose staff powers immediately: every helper
-- (current_staff_id → policies everywhere) resolves through this row, so the
-- cleanest cut is to make the helpers treat disabled rows as "no staff".
create or replace function current_staff_id()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from staff_profiles
   where auth_id = auth.uid() and coalesce(status, 'active') <> 'disabled'
   limit 1;
$$;

create or replace function current_staff_role()
returns employee_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from staff_profiles
   where auth_id = auth.uid() and coalesce(status, 'active') <> 'disabled'
   limit 1;
$$;

create or replace function current_staff_store()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select store_id from staff_profiles
   where auth_id = auth.uid() and coalesce(status, 'active') <> 'disabled'
   limit 1;
$$;
