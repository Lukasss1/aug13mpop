-- ============================================================================
-- STAGE 2.1.2 — SALARY CONFIDENTIALITY IS SERVER-ENFORCED (re-audit closure)
-- ============================================================================
-- The Stage-2.1.1 pay protection was a CLIENT data-minimisation measure: the
-- directory simply did not ask for pay, while the database still granted
-- full-table SELECT on staff_profiles to `authenticated`. Any store manager
-- could therefore hand-write
--     /rest/v1/staff_profiles?select=id,name,pay_rate,pay_type
-- and the database had no rule refusing it — the same held for auth_id and
-- the other internal columns the directory merely omitted. This migration
-- makes the DATABASE the authority:
--
--   1. General SELECT on the staff_profiles BASE TABLE is withdrawn. Every
--      column-level SELECT grant is cleared first (dynamically, over the live
--      column list), because a database that applied the ORIGINAL Stage 2.1
--      still carries its partial column grants — table-level REVOKE alone
--      would leave those readable.
--   2. A single operational column set — (id, name, role, store_id,
--      store_name) — is re-granted. This is the MINIMUM the rest of the
--      schema needs from a browser session, and every member is already in
--      the sanctioned directory (store_name is the PUBLIC kiosk name):
--        • id          write paths filter and confirm by primary key
--                      (?id=eq.X … select=id representations);
--        • id,store_id RLS policies on clock_history / staff_documents /
--                      app_state / training tables join staff_profiles with
--                      the CALLER's privileges;
--        • id,name,role the SECURITY INVOKER publish RPCs
--                      (replace_collection / apply_collection_changes) and
--                      the audit_logs_stamp() trigger read the caller's
--                      display name + role for the activity trail;
--        • name,store_id,store_name the SECURITY INVOKER
--                      sifr_reports_stamp() trigger derives the VERIFIED
--                      reporter identity + store on every incident insert.
--      Everything else — pay_rate, pay_type, auth_id, email, onboarding,
--      invited_at, holiday/points/level/badges/avatar/lifecycle timestamps —
--      is NOT directly selectable by any browser session, manager included.
--   3. Reads happen through three deliberate, owner/role-gated RPCs:
--        get_my_staff_profile()  the caller's OWN full row (incl. own pay —
--                                the Earnings-Estimates screen is theirs);
--        get_staff_directory()   the safe management directory (NO pay, NO
--                                auth_id) with exactly the Stage-2.1 row
--                                scope: owner → all, AAL2 manager → their
--                                store, everyone else → self;
--        owner_staff_pay()       pay enrichment, owner-only (Stage 2.1).
--
-- Row-scope parity is deliberate: the RPCs reproduce the SELECT policies they
-- replace (self via auth_id = auth.uid(); store via is_store_manager(), which
-- is role AND aal2; owner via the MFA-aware is_owner()). Disabled rows are
-- returned exactly as before — the client's disabled handling depends on
-- READING the status it acts on.
--
-- Idempotent; fails CLOSED (no `when others` wrappers). Appended via
-- MP_FUTURE_MIGRATIONS; the frozen baseline and applied history are untouched.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Withdraw general read access to the base table.
--    Dynamic per-column revoke first: REVOKE SELECT ON TABLE does not touch
--    column-level grants, and the original Stage-2.1 file granted almost every
--    column individually on databases that applied it.
-- ----------------------------------------------------------------------------
do $$
declare col text;
begin
  for col in
    select attname from pg_attribute
    where attrelid = 'public.staff_profiles'::regclass
      and attnum > 0 and not attisdropped
  loop
    execute format(
      'revoke select (%I) on public.staff_profiles from authenticated, anon', col);
  end loop;
end $$;

revoke select on public.staff_profiles from authenticated, anon;

-- ----------------------------------------------------------------------------
-- 2. Re-grant the minimal operational column set (see header for why each).
-- ----------------------------------------------------------------------------
grant select (id, name, role, store_id, store_name)
  on public.staff_profiles to authenticated;

-- ----------------------------------------------------------------------------
-- 3. get_my_staff_profile() — the caller's own row, complete.
--    Same column set the login self-read has always used (no auth_id: the
--    session already knows its own uid). Returns the row even when status is
--    'disabled' — revalidateOwnProfileTyped() branches on that value.
-- ----------------------------------------------------------------------------
create or replace function get_my_staff_profile()
returns table (
  id text, name text, email text, role employee_role, store_id text,
  store_name text, next_shift text, holiday_balance numeric, points int,
  level int, badges jsonb, avatar text, status text, onboarding text,
  invited_at timestamptz, pay_rate numeric, pay_type text,
  created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select sp.id, sp.name, sp.email, sp.role, sp.store_id,
         sp.store_name, sp.next_shift, sp.holiday_balance, sp.points,
         sp.level, sp.badges, sp.avatar, sp.status, sp.onboarding,
         sp.invited_at, sp.pay_rate, sp.pay_type,
         sp.created_at, sp.updated_at
  from staff_profiles sp
  where sp.auth_id = auth.uid();
$$;
revoke all on function get_my_staff_profile() from public, anon;
grant execute on function get_my_staff_profile() to authenticated;

-- ----------------------------------------------------------------------------
-- 4. get_staff_directory() — the safe management directory.
--    Column set = the Stage-2.1.1 client projection, now enforced by the
--    server: NO pay_rate, NO pay_type, NO auth_id. Row scope = the exact
--    Stage-2.1 SELECT policies this replaces (owner all; AAL2 manager their
--    store; every caller their own row). email/onboarding/invited_at remain:
--    the re-audit accepted them as genuine staff-management fields (CF7).
-- ----------------------------------------------------------------------------
create or replace function get_staff_directory()
returns table (
  id text, name text, email text, role employee_role, store_id text,
  store_name text, next_shift text, holiday_balance numeric, points int,
  level int, badges jsonb, avatar text, status text, onboarding text,
  invited_at timestamptz, created_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select sp.id, sp.name, sp.email, sp.role, sp.store_id,
         sp.store_name, sp.next_shift, sp.holiday_balance, sp.points,
         sp.level, sp.badges, sp.avatar, sp.status, sp.onboarding,
         sp.invited_at, sp.created_at, sp.updated_at
  from staff_profiles sp
  where is_owner()
     or (is_store_manager() and sp.store_id = current_staff_store())
     or sp.auth_id = auth.uid();
$$;
revoke all on function get_staff_directory() from public, anon;
grant execute on function get_staff_directory() to authenticated;

-- ----------------------------------------------------------------------------
-- 5. owner_staff_pay() is re-asserted verbatim (defined at Stage 2.1) so this
--    migration is self-sufficient on the day some future refactor moves it —
--    the pay read path must never silently widen.
-- ----------------------------------------------------------------------------
create or replace function owner_staff_pay()
returns table (id text, pay_rate numeric, pay_type text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select sp.id, sp.pay_rate, sp.pay_type
  from staff_profiles sp
  where is_owner();
$$;
revoke all on function owner_staff_pay() from public, anon;
grant execute on function owner_staff_pay() to authenticated;
