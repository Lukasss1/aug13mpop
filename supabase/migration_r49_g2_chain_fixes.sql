-- ============================================================================
--  migration_r49_g2_chain_fixes.sql
--  R4.9 · Gate G2 — EXECUTABLE-FAILURE CORRECTIONS on the R4.8 chain
-- ============================================================================
--  Append-only function replacements for two R4.8 functions that could never
--  have run. Both were found by executing the chain against PostgreSQL 16 for
--  the first time; both were invisible to the regex-only r48-* suites, which
--  assert that text appears in a file, not that the file works.
--
--  THE DEFECT (one class, two sites)
--    declare v text[] := '{}';
--    ...
--    v := v || 'some_literal';
--
--  PostgreSQL resolves `anyarray || <unknown literal>` in favour of
--  `anyarray || anyarray` and then tries to read the literal as an array
--  constructor, so the statement raises
--    ERROR: malformed array literal: "some_literal"  (SQLSTATE 22P02)
--    DETAIL: Array value must start with "{" or dimension information.
--  Empirically confirmed on 16.14: `v || 'alpha'` raises 22P02, and
--  `v || 'alpha'::text` yields {alpha}.
--
--  WHY IT MATTERS
--    1. assert_store_open_allowed() — the store-open launch gate. The append
--       only executes when a mandatory launch fact is MISSING, i.e. exactly
--       when the gate should return its diagnostic list. Instead of
--         store_open_blocked: missing legal_business_name, registered_address
--       the owner received a raw type error. The gate still refused the
--       transition (any exception does), but it could never say why, and the
--       failure was indistinguishable from a database fault.
--    2. purge_employee() — the guarded duplicate-profile purge. The append
--       only executes when the employee HAS dependent history, i.e. exactly
--       the case the function exists to refuse safely. Instead of the
--       has_dependent_history verdict the caller received a type error.
--
--  Both bodies below are the R4.8 originals VERBATIM with `::text` added at
--  each append site. No logic, signature, privilege, ordering or return shape
--  is altered. Grants are re-asserted for completeness; CREATE OR REPLACE
--  preserves them regardless.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. assert_store_open_allowed() — R4.8 F3 store-open gate
-- ----------------------------------------------------------------------------
create or replace function assert_store_open_allowed()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare ls launch_settings; v_missing text[] := '{}';
begin
  if new.status = 'open' and (old.status is distinct from 'open') then
    select * into ls from launch_settings where id;
    if coalesce(ls.legal_business_name,'') = '' then v_missing := v_missing || 'legal_business_name'::text; end if;
    if coalesce(ls.registered_address,'')  = '' then v_missing := v_missing || 'registered_address'::text; end if;
    if coalesce(ls.public_contact_email,'') = '' then v_missing := v_missing || 'public_contact_email'::text; end if;
    if coalesce(ls.privacy_contact_email,'') = '' then v_missing := v_missing || 'privacy_contact_email'::text; end if;
    if coalesce(ls.public_telephone,'') = '' and not ls.telephone_alternative_ok then v_missing := v_missing || 'public_telephone'::text; end if;
    if not ls.vat_state_confirmed then v_missing := v_missing || 'vat_state_confirmed'::text; end if;
    if coalesce(trim(new.address),'') = '' then v_missing := v_missing || 'store_address'::text; end if;
    if coalesce(trim(new.opening_hours),'') = '' then v_missing := v_missing || 'opening_hours'::text; end if;
    if array_length(v_missing,1) is not null then
      raise exception 'store_open_blocked: missing %', array_to_string(v_missing, ', ');
    end if;
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 2. purge_employee() — R4.8 B guarded duplicate purge
-- ----------------------------------------------------------------------------
create or replace function purge_employee(p_employee_id text, p_typed_name text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_name text; v_deps text[] := '{}';
begin
  if not is_owner() then raise exception 'not_permitted'; end if;
  select name into v_name from staff_profiles where id = p_employee_id;
  if not found then raise exception 'not_found'; end if;
  if p_typed_name is distinct from v_name then raise exception 'confirmation_mismatch'; end if;

  if exists (select 1 from work_shifts    where employee_id = p_employee_id) then v_deps := v_deps || 'shifts'::text; end if;
  if exists (select 1 from clock_history  where employee_id = p_employee_id) then v_deps := v_deps || 'clock_history'::text; end if;
  if exists (select 1 from payslips       where employee_id = p_employee_id) then v_deps := v_deps || 'payroll'::text; end if;
  if exists (select 1 from staff_documents where employee_id = p_employee_id) then v_deps := v_deps || 'documents'::text; end if;
  if exists (select 1 from staff_compliance_records where employee_id = p_employee_id) then v_deps := v_deps || 'compliance'::text; end if;
  if exists (select 1 from training_results where employee_id = p_employee_id) then v_deps := v_deps || 'training'::text; end if;
  if exists (select 1 from sifr_reports  where reporter_id = p_employee_id) then v_deps := v_deps || 'sifr'::text; end if;
  if array_length(v_deps,1) is not null then
    return jsonb_build_object('ok', false, 'error', 'has_dependent_history', 'dependencies', to_jsonb(v_deps));
  end if;

  delete from staff_profiles where id = p_employee_id;
  insert into audit_logs (id, operator_name, role, action, timestamp, module, previous_value)
  values (gen_random_uuid()::text, current_staff_id(), 'owner',
          'employment.purged_duplicate', now()::text, 'Team', p_employee_id || ' ' || v_name);
  return jsonb_build_object('ok', true);
end $$;

revoke all on function purge_employee(text,text) from public, anon;
grant execute on function purge_employee(text,text) to authenticated;

comment on function assert_store_open_allowed() is
  'R4.8 F3 store-open gate, R4.9 G2 correction: array appends cast to ::text so the missing-facts diagnostic can actually be built (the R4.8 form raised SQLSTATE 22P02 instead).';
comment on function purge_employee(text,text) is
  'R4.8 B guarded duplicate purge, R4.9 G2 correction: array appends cast to ::text so has_dependent_history can be returned (the R4.8 form raised SQLSTATE 22P02 instead).';
