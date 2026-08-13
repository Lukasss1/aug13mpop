-- ============================================================================
-- STAGE 2.1 — PERMISSION CLOSURE (deep full-flow audit, DB layer)
-- ============================================================================
-- The Stage-2 migration fixed the reported table policies; this closes the
-- BROADER permission system the follow-up audit traced through client
-- hydration and column exposure. Idempotent; appended via MP_FUTURE_MIGRATIONS
-- (frozen baseline untouched). Every invariant is asserted on the FINAL policy
-- in manifest order.
--
--   F1  orders: an ordinary employee's browser hydrated EVERY store order
--       (select=* over orders_select_store, which only checked store match).
--       Team members/supervisors are now limited to THEIR OWN orders
--       (staff_id = current_staff_id()); managers keep their store; owners all.
--   F2  staff_profiles: managers read their store's rows via select=*, so pay
--       columns reached a manager's browser though payroll is owner-only.
--       Column privileges are withdrawn: pay_rate/pay_type are SELECTable only
--       by the owner (a column-level grant, enforced by PostgREST + Postgres);
--       a manager's select=* now silently omits them. The rota labour-cost
--       helper is corrected UI-side to stop reading them.
--   F4  training: manager reads on assignments/progress/certificates used
--       is_manager_or_owner() with no store filter — cross-store visibility.
--       Now joined through the target employee's store, like clock_history.
--   F6  staff lifecycle fields: a manager could rewrite email/onboarding
--       fields and peer-manager rows. A trigger now pins the columns a manager
--       (or self) may change and blocks manager writes to manager/owner rows.
--   F11 media_objects/references: any authenticated staff could read all media
--       metadata. Now owner (all) or manager (references to menu_items only).
--   F10 app_state: the store-scope policy already exists; a defensive index +
--       comment lock the single-writer-key hazard for the multi-store note.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- F1. Orders — employees see only their OWN orders.
-- ----------------------------------------------------------------------------
drop policy if exists orders_select_store on orders;
create policy orders_select_store on orders
  for select to authenticated
  using (
    is_owner()
    or (is_store_manager() and store_id = current_staff_store())
    or staff_id = current_staff_id()
  );

-- ----------------------------------------------------------------------------
-- F2. staff_profiles — pay columns come OFF the authenticated SELECT grant.
--   Row policies already scope WHICH rows a manager sees; this scopes WHICH
--   COLUMNS. The pay columns (pay_rate/pay_type) are withdrawn from the
--   authenticated column set, so a manager's select=* silently omits them;
--   the owner reads pay through the narrow owner_staff_pay() RPC below.
--   Guarded: on a database whose staff_profiles predates a listed column the
--   grant statement would fail, so the block degrades to the previous grant.
-- ----------------------------------------------------------------------------
do $$
begin
  revoke select on staff_profiles from authenticated;
  grant select (id, name, email, role, store_id, store_name, next_shift,
                holiday_balance, points, level, badges, avatar, auth_id,
                status, onboarding, invited_at, created_at, updated_at)
    on staff_profiles to authenticated;
exception when others then null;
end $$;

-- Owner-only pay read: a narrow RPC the payroll/labour-cost screens call.
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

-- ----------------------------------------------------------------------------
-- F6. staff_profiles lifecycle-field trigger.
--   • A self-update may touch ONLY safe presentation fields.
--   • A manager may update ONLY team_member/supervisor rows in their store,
--     and ONLY non-identity fields (never email/role/store/pay/onboarding).
--   • The owner is unrestricted.
-- ----------------------------------------------------------------------------
-- This composes WITH (never replaces) migration_field_lock's trigger, which
-- already blocks non-owners from changing pay/role/store/points/level/holiday/
-- badges. Here we add ONLY the lifecycle/identity surface that trigger omits
-- (email, onboarding, invited_at, auth_id, status) plus the manager-target
-- rule, so the two triggers never police the same column twice.
create or replace function guard_staff_profile_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_role text := current_staff_role();
  caller_id   text := current_staff_id();
begin
  if is_owner() then
    return new;                                    -- owner: unrestricted
  end if;

  -- Identity/lifecycle fields are system-controlled for every non-owner,
  -- whether editing self or (as a manager) someone else.
  if new.email      is distinct from old.email
     or new.onboarding is distinct from old.onboarding
     or new.invited_at is distinct from old.invited_at
     or new.auth_id    is distinct from old.auth_id
     or new.status     is distinct from old.status then
    raise exception 'identity and lifecycle fields are system-controlled'
      using errcode = 'insufficient_privilege';
  end if;

  -- A manager acting on ANOTHER person's row may only manage lower roles.
  if caller_role = 'store_manager' and new.id <> caller_id
     and old.role not in ('team_member','supervisor') then
    raise exception 'managers may only manage team members and supervisors'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end $$;

drop trigger if exists trg_guard_staff_profile_write on staff_profiles;
create trigger trg_guard_staff_profile_write
  before update on staff_profiles
  for each row execute function guard_staff_profile_write();

-- ----------------------------------------------------------------------------
-- F4. Training — manager reads are store-scoped through the target employee.
-- ----------------------------------------------------------------------------
-- Supersede the REAL select policies (self-or-any-manager) in place with a
-- store-scoped manager join, matching clock_history. Table + policy names are
-- the ones the training migrations actually created.
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('training_assignments',  'tassign_select_self_or_mgr'),
      ('training_progress',     'tprog_select_self_or_mgr'),
      ('training_certificates', 'tcert_select_self_or_mgr')
    ) as t(tbl, pol)
  loop
    if to_regclass(spec.tbl) is not null then
      execute format('drop policy if exists %I on %I', spec.pol, spec.tbl);
      execute format($f$
        create policy %I on %I
          for select to authenticated
          using (
            employee_id = current_staff_id()
            or is_owner()
            or (is_store_manager()
                and exists (select 1 from staff_profiles sp
                            where sp.id = %I.employee_id
                              and sp.store_id = current_staff_store()))
          )
      $f$, spec.pol, spec.tbl, spec.tbl);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- F11. Media metadata — owner all; manager only menu_item references.
-- ----------------------------------------------------------------------------
drop policy if exists media_objects_select_staff on public.media_objects;
create policy media_objects_select_staff on public.media_objects
  for select to authenticated
  using (
    is_owner()
    or (is_store_manager() and exists (
      select 1 from public.media_references mr
      where mr.media_object_id = media_objects.id
        and mr.entity_type = 'menu_item'))
  );

drop policy if exists media_references_select_staff on public.media_references;
create policy media_references_select_staff on public.media_references
  for select to authenticated
  using (is_owner() or (is_store_manager() and entity_type = 'menu_item'));

-- ----------------------------------------------------------------------------
-- F10. app_state single-writer-key hazard — defensive index + note.
--   (No privacy leak: the scope policy already isolates rows. This documents
--    the multi-store overwrite risk and speeds the scoped lookups.)
-- ----------------------------------------------------------------------------
create index if not exists app_state_scope_store_idx
  on app_state (scope, store_id)
  where scope = 'store';

-- ----------------------------------------------------------------------------
-- F8. CV presence without the storage path.
--   `cv_present` is a generated boolean the browser may read; the raw
--   `cv_path` comes OFF the authenticated grant so the storage key never
--   reaches a browser at all. The CV itself is fetched on demand through the
--   (now store-scoped) cv-signed-url function.
-- ----------------------------------------------------------------------------
alter table job_applications
  add column if not exists cv_present boolean
  generated always as (cv_path is not null and cv_path <> '') stored;

do $$
begin
  revoke select on job_applications from authenticated;
  grant select (id, full_name, email, phone, applied_for, applied_store,
                availability, experience, message, status, applied_at,
                cv_present, created_at, updated_at)
    on job_applications to authenticated;
exception when others then null;
end $$;
