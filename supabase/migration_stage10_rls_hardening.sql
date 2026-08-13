-- ============================================================================
--  MILK POP — MIGRATION S10 (STAGE 10): INCIDENT (SIFR) RLS HARDENING
--
--  Run order: after migration_rls_per_role.sql (helpers) and
--  migration_stage9_staff_onboarding.sql (disabled-aware helpers).
--  Safe to re-run.
--
--  WHAT THIS CLOSES
--  ----------------
--  • IMPERSONATION: the old insert policy only required "is a staff member" —
--    a direct API request could file a report as ANYONE. Now the row's
--    reporter_id/reporter_name/store are FORCED to the verified session's own
--    values by a trigger, and the policy pins reporter_id.
--  • CROSS-STORE READS: managers saw and edited every store's incidents. Now
--    a manager's reach is their OWN store (by the report's store, falling
--    back to the reporter's store for legacy rows); the owner spans stores.
--
--  (The other Stage-10 items live in their feature migrations: staff
--  documents in S3, assignment/profile/certificate locks in S4, app_state in
--  S5, financial records in the POS pipeline / disabled website controls.)
-- ============================================================================

-- The store a report belongs to, for policy purposes: its own store_id, or
-- (legacy rows) the reporter's store.
create or replace function sifr_report_store(r sifr_reports)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(r.store_id, ''),
    (select sp.store_id from staff_profiles sp where sp.id = r.reporter_id limit 1)
  );
$$;

-- Identity/derivation trigger: the browser cannot choose WHO filed a report
-- or WHERE from — those come from the verified session at insert time.
create or replace function sifr_reports_stamp() returns trigger
language plpgsql as $$
declare
  v_id    text;
  v_name  text;
  v_store text;
  v_store_name text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;  -- server contexts (service role) are not browser requests
  end if;
  v_id := current_staff_id();
  if v_id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  select name, store_id, store_name into v_name, v_store, v_store_name
    from staff_profiles where id = v_id;
  new.reporter_id   := v_id;
  new.reporter_name := coalesce(v_name, '');
  new.store_id      := coalesce(nullif(new.store_id, ''), v_store);
  new.store_name    := case when new.store_id = v_store then coalesce(v_store_name, new.store_name) else new.store_name end;
  return new;
end $$;
drop trigger if exists trg_sifr_reports_stamp on sifr_reports;
create trigger trg_sifr_reports_stamp before insert on sifr_reports
  for each row execute function sifr_reports_stamp();

-- Policies: self-read, store-scoped manager read/update, owner everywhere.
drop policy if exists sifr_select_self_or_mgr on sifr_reports;
drop policy if exists sifr_insert_staff       on sifr_reports;
drop policy if exists sifr_update_mgr         on sifr_reports;

create policy sifr_select_self_or_mgr on sifr_reports
  for select to authenticated
  using (
    reporter_id = current_staff_id()
    or is_owner()
    or (is_manager_or_owner() and sifr_report_store(sifr_reports) = current_staff_store())
  );

create policy sifr_insert_staff on sifr_reports
  for insert to authenticated
  with check (
    current_staff_id() is not null
    and reporter_id = current_staff_id()   -- the trigger guarantees this; the
  );                                        -- policy states it for the tests

create policy sifr_update_mgr on sifr_reports
  for update to authenticated
  using (
    is_owner()
    or (is_manager_or_owner() and sifr_report_store(sifr_reports) = current_staff_store())
  )
  with check (
    is_owner()
    or (is_manager_or_owner() and sifr_report_store(sifr_reports) = current_staff_store())
  );
