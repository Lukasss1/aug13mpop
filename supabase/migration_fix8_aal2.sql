-- ============================================================================
--  MILK POP — MIGRATION FIX-8: SERVER-ENFORCED MFA ASSURANCE (AAL2)
--  Closes forensic-audit SEC-001 / AUTH-003.
--
--  PROBLEM: MFA for owner / store-manager roles was enforced only by the
--  browser (useAuth.finalise checked that a verified TOTP factor EXISTS).
--  A caller holding valid owner credentials could mint an aal1 token via the
--  password grant and call PostgREST / RPCs directly — every privileged
--  policy checked ROLE but never the token's assurance level.
--
--  FIX: is_owner() and is_manager_or_owner() are the single choke points that
--  every privileged RLS policy and SECURITY DEFINER RPC in this codebase
--  already calls. They now ALSO require the CURRENT JWT to carry aal = aal2.
--  An aal1 owner token therefore answers "false" to every privileged check —
--  reads and writes alike — until the second factor is presented.
--
--  Team members are unaffected: their access paths test current_staff_id(),
--  not these helpers, and their roles never pass the role test anyway.
--
--  NOTE for enrolment: first-time MFA enrolment happens at aal1 by design.
--  Enrolment only needs the caller's OWN staff_profiles row (auth_id =
--  auth.uid() policy) and the GoTrue factor endpoints — neither goes through
--  these helpers, so enrolment still works.
--
--  Deploy order: any time after migration_rls_per_role.sql.
-- ============================================================================

-- The assurance level of the CURRENT request's JWT. GoTrue stamps 'aal1' on
-- password/refresh grants and 'aal2' after a TOTP verify; a missing claim is
-- treated as aal1 (fail closed).
create or replace function jwt_aal()
returns text
language sql
stable
as $$
  select coalesce(nullif(auth.jwt() ->> 'aal', ''), 'aal1');
$$;

create or replace function is_aal2()
returns boolean
language sql
stable
as $$
  select jwt_aal() = 'aal2';
$$;

revoke all on function jwt_aal()  from public;
revoke all on function is_aal2() from public;
grant execute on function jwt_aal()  to authenticated;
grant execute on function is_aal2() to authenticated;

-- ----------------------------------------------------------------------------
-- Redefine the two privileged-role helpers to REQUIRE aal2. Same signatures,
-- same grants — every existing policy and RPC picks the change up untouched.
-- ----------------------------------------------------------------------------
create or replace function is_owner()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(current_staff_role() = 'owner', false) and is_aal2();
$$;

create or replace function is_manager_or_owner()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(current_staff_role() in ('store_manager','owner'), false)
         and is_aal2();
$$;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE (run as an owner with an aal1 password-grant token):
--   select is_owner();                      -- must be FALSE
--   update site_settings set brand_name = 'x';  -- must affect 0 rows / 403
-- After TOTP verify (aal2 token):
--   select is_owner();                      -- must be TRUE
-- ----------------------------------------------------------------------------
