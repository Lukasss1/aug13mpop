-- ============================================================================
--  MILK POP — MIGRATION A2: AUTH ONBOARDING & LINKAGE SUPPORT
--
--  Run order:
--    1. schema.sql
--    2. migration_security_lockdown.sql   (pre-lockdown databases only)
--    3. migration_rls_per_role.sql        (A1 — adds auth_id + per-role RLS)
--    4. THIS FILE                          (A2 — safe linkage + owner bootstrap)
--
--  Safe to re-run.
--
--  WHY THIS EXISTS
--  ---------------
--  A1 added staff_profiles.auth_id and made every authenticated policy depend
--  on it. But something has to SET auth_id safely. The danger to design around:
--  a newly signed-up Auth user must NOT be able to point auth_id at an existing
--  owner's profile and inherit owner powers. So linkage is a controlled server
--  function, not a client UPDATE — and the very first owner is bootstrapped by
--  a privileged one-time call, not by self-service.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. link_staff_profile(email) — a signed-in user claims their OWN profile
-- ---------------------------------------------------------------------------
-- The Block B invite flow works like this:
--   • An owner creates the staff_profiles row (name, email, role, store) via
--     the owner RLS policy — auth_id stays null.
--   • The staff member is invited through Supabase Auth and signs in. Their
--     JWT email is verified by Supabase.
--   • The client calls select link_staff_profile() ONCE after first sign-in.
--
-- The function links the caller's auth.uid() to the profile whose email
-- matches their VERIFIED auth email — and only if that profile is still
-- unclaimed. It cannot be used to hijack a profile that is already linked, and
-- it never lets the caller choose which profile or which role: the email comes
-- from the verified JWT (auth.jwt()->>'email'), not from a parameter.
create or replace function link_staff_profile()
returns staff_profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed staff_profiles;
  jwt_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if jwt_email = '' then
    raise exception 'no verified email on token';
  end if;

  -- Already linked? Return the existing profile (idempotent, no error).
  select * into claimed from staff_profiles where auth_id = auth.uid() limit 1;
  if found then
    return claimed;
  end if;

  -- Claim the unclaimed profile whose email matches the verified JWT email.
  update staff_profiles
     set auth_id = auth.uid()
   where auth_id is null
     and lower(email) = jwt_email
  returning * into claimed;

  if not found then
    raise exception 'no unclaimed staff profile matches this account';
  end if;

  return claimed;
end $$;

revoke all on function link_staff_profile() from public;
grant execute on function link_staff_profile() to authenticated;

comment on function link_staff_profile() is
  'Called once after first sign-in. Links auth.uid() to the unclaimed '
  'staff_profiles row whose email equals the verified JWT email. Cannot '
  'hijack an already-linked profile and cannot choose a role.';


-- ---------------------------------------------------------------------------
-- 2. bootstrap_owner(target_email) — one-time first-owner creation
-- ---------------------------------------------------------------------------
-- Chicken-and-egg: owner-only policies need an owner to already exist. This
-- privileged helper mints the first owner. It is NOT granted to anon or
-- authenticated — you run it from the Supabase SQL editor (which executes as a
-- superuser) exactly once, then optionally drop it.
--
-- It is idempotent-ish: if an owner already exists it refuses, so it cannot be
-- used later to silently add a second owner.
create or replace function bootstrap_owner(target_email text, target_name text default 'Owner')
returns staff_profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  result staff_profiles;
begin
  if exists (select 1 from staff_profiles where role = 'owner') then
    raise exception 'an owner already exists; refusing to create another via bootstrap';
  end if;

  insert into staff_profiles (id, name, email, role, store_name)
  values ('owner_' || substr(md5(random()::text), 1, 8),
          target_name, lower(target_email), 'owner', 'HQ')
  returning * into result;

  return result;
end $$;

-- Deliberately NOT granted to anon/authenticated. SQL-editor / service use only.
revoke all on function bootstrap_owner(text, text) from public;
revoke all on function bootstrap_owner(text, text) from authenticated;
revoke all on function bootstrap_owner(text, text) from anon;

comment on function bootstrap_owner(text, text) is
  'ONE-TIME first-owner creation, run from the SQL editor. Refuses if any '
  'owner already exists. Not callable by anon or authenticated roles.';


-- ---------------------------------------------------------------------------
-- 3. HANDOVER NOTES for A2
-- ---------------------------------------------------------------------------
-- Onboarding order the client (Block B) will follow:
--   1. You (owner) run once in the SQL editor:
--        select bootstrap_owner('you@milkpop.co.uk', 'Your Name');
--      Then invite that same email in Supabase Auth and sign in. Call
--        select link_staff_profile();
--      to attach your auth.uid() to the owner row.
--   2. From then on you create staff rows in the Admin Panel (owner RLS), invite
--      each person in Auth with the same email, and they call
--        select link_staff_profile();
--      on first sign-in to claim their row.
--
-- Security properties to keep:
--   • Never grant bootstrap_owner to anon/authenticated.
--   • link_staff_profile trusts ONLY the verified JWT email, never a client
--     parameter — do not add an email argument to it.
-- ============================================================================
