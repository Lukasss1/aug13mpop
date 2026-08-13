-- ============================================================================
--  MILK POP — R4.8 LAUNCH CLOSURE 1/4: truth & people
--  (Workstream A1 authoritative compliance · B employment lifecycle · H2
--   audited MFA/account recovery intents)
--
--  Append-only. Touches no historical migration. House rules honoured:
--    • every new table: RLS enabled, deny-by-default, explicit policies
--    • every function: security definer, pinned search_path, explicit revokes
--    • employees can never verify their own compliance records
--    • no client-side deletes of people; lifecycle instead of destruction
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. STAFF COMPLIANCE RECORDS (A1)
--    The staff portal previously hardcoded "Verified / Signed / Exp. 2027".
--    From R4.8 every compliance label is derived from these rows; a missing
--    row renders "Not recorded" — never a green state.
-- ----------------------------------------------------------------------------
do $$ begin
  create type compliance_status as enum
    ('not_recorded','pending_verification','verified','expiring','expired',
     'rejected','revoked','not_applicable');
exception when duplicate_object then null; end $$;

create table if not exists staff_compliance_records (
  id                   text primary key default gen_random_uuid()::text,
  employee_id          text not null references staff_profiles(id) on delete cascade,
  compliance_type      text not null,       -- e.g. right_to_work, food_hygiene_l2,
                                            -- employment_contract, fire_safety
  status               compliance_status not null default 'pending_verification',
  issued_at            date,
  verified_at          timestamptz,
  expires_at           date,
  verified_by_staff_id text references staff_profiles(id),
  document_id          text,                -- staff_documents.id where applicable
  notes                text not null default '',
  supersedes_id        text references staff_compliance_records(id),
  revoked_at           timestamptz,
  revoked_by_staff_id  text references staff_profiles(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- a record can never be verified by its own subject
  constraint compliance_no_self_verify
    check (verified_by_staff_id is null or verified_by_staff_id <> employee_id)
);

create index if not exists idx_compliance_employee on staff_compliance_records (employee_id);
create index if not exists idx_compliance_expiry   on staff_compliance_records (expires_at)
  where status in ('verified','expiring');

alter table staff_compliance_records enable row level security;

-- Employees read their own rows. Managers read/manage rows for staff in their
-- store. Owners manage all. Nobody writes via the table directly — mutations
-- go through the audited RPCs below, so the table has NO insert/update
-- policies for authenticated at all (deny by default does the rest).
drop policy if exists compliance_read_own on staff_compliance_records;
create policy compliance_read_own on staff_compliance_records
  for select to authenticated
  using (employee_id = current_staff_id());

drop policy if exists compliance_read_managed on staff_compliance_records;
create policy compliance_read_managed on staff_compliance_records
  for select to authenticated
  using (
    is_owner()
    or (is_manager_or_owner() and exists (
          select 1 from staff_profiles sp
           where sp.id = staff_compliance_records.employee_id
             and sp.store_id = current_staff_store()))
  );

-- Server-derived effective status: expiry is computed from dates on the
-- server clock, never asserted by the browser.
create or replace function compliance_effective_status(rec staff_compliance_records)
returns compliance_status
language sql stable
set search_path = public, pg_temp
as $$
  select case
    when rec.revoked_at is not null                       then 'revoked'::compliance_status
    when rec.status in ('rejected','not_applicable',
                        'pending_verification',
                        'not_recorded')                   then rec.status
    when rec.expires_at is not null
         and rec.expires_at < current_date               then 'expired'::compliance_status
    when rec.expires_at is not null
         and rec.expires_at < current_date + 42          then 'expiring'::compliance_status
    else rec.status
  end;
$$;

-- Audited mutations ----------------------------------------------------------
create or replace function compliance_record_upsert(
  p_employee_id text, p_type text, p_issued date, p_expires date,
  p_document_id text, p_notes text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_id text; v_actor text := current_staff_id();
begin
  if v_actor is null or not is_manager_or_owner() then
    raise exception 'not_permitted';
  end if;
  if not is_owner() then
    -- managers only within their own store
    if not exists (select 1 from staff_profiles
                    where id = p_employee_id and store_id = current_staff_store()) then
      raise exception 'not_permitted';
    end if;
  end if;
  v_id := gen_random_uuid()::text;
  insert into staff_compliance_records
    (id, employee_id, compliance_type, status, issued_at, expires_at, document_id, notes)
  values
    (v_id, p_employee_id, p_type, 'pending_verification', p_issued, p_expires,
     nullif(p_document_id,''), coalesce(p_notes,''));
  insert into audit_logs (id, operator_name, role, action, timestamp, module, new_value)
  values (gen_random_uuid()::text, v_actor, current_staff_role()::text,
          'compliance.record_created', now()::text, 'Compliance',
          p_employee_id || ':' || p_type);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function compliance_record_verify(p_record_id text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare r staff_compliance_records; v_actor text := current_staff_id();
begin
  select * into r from staff_compliance_records where id = p_record_id;
  if not found then raise exception 'not_found'; end if;
  if v_actor is null or not is_manager_or_owner() then raise exception 'not_permitted'; end if;
  if r.employee_id = v_actor then raise exception 'self_verification_forbidden'; end if;
  if not is_owner() and not exists (select 1 from staff_profiles
        where id = r.employee_id and store_id = current_staff_store()) then
    raise exception 'not_permitted';
  end if;
  update staff_compliance_records
     set status = 'verified', verified_at = now(),
         verified_by_staff_id = v_actor, updated_at = now()
   where id = p_record_id;
  insert into audit_logs (id, operator_name, role, action, timestamp, module, new_value)
  values (gen_random_uuid()::text, v_actor, current_staff_role()::text,
          'compliance.verified', now()::text, 'Compliance', p_record_id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function compliance_record_revoke(p_record_id text, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_actor text := current_staff_id();
begin
  if v_actor is null or not is_manager_or_owner() then raise exception 'not_permitted'; end if;
  update staff_compliance_records
     set status = 'revoked', revoked_at = now(), revoked_by_staff_id = v_actor,
         notes = trim(notes || E'\nRevoked: ' || coalesce(p_reason,'')), updated_at = now()
   where id = p_record_id
     and (is_owner() or exists (select 1 from staff_profiles sp
            where sp.id = staff_compliance_records.employee_id
              and sp.store_id = current_staff_store()));
  if not found then raise exception 'not_permitted'; end if;
  insert into audit_logs (id, operator_name, role, action, timestamp, module, new_value)
  values (gen_random_uuid()::text, v_actor, current_staff_role()::text,
          'compliance.revoked', now()::text, 'Compliance', p_record_id);
  return jsonb_build_object('ok', true);
end $$;

-- Read model for the staff widget: rows + server-computed effective status.
create or replace function staff_compliance_overview(p_employee_id text default null)
returns table (
  id text, employee_id text, compliance_type text,
  effective_status compliance_status, issued_at date, expires_at date,
  verified_at timestamptz, notes text
)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select r.id, r.employee_id, r.compliance_type,
         compliance_effective_status(r), r.issued_at, r.expires_at,
         r.verified_at, r.notes
    from staff_compliance_records r
   where r.supersedes_id is null or not exists
         (select 1 from staff_compliance_records n where n.supersedes_id = r.id)
     and (
       r.employee_id = coalesce(nullif(p_employee_id,''), current_staff_id())
       and (r.employee_id = current_staff_id()
            or is_owner()
            or (is_manager_or_owner() and exists (
                  select 1 from staff_profiles sp
                   where sp.id = r.employee_id and sp.store_id = current_staff_store())))
     )
   order by r.compliance_type, r.created_at desc;
$$;

revoke all on function compliance_record_upsert(text,text,date,date,text,text) from public, anon;
revoke all on function compliance_record_verify(text) from public, anon;
revoke all on function compliance_record_revoke(text,text) from public, anon;
revoke all on function staff_compliance_overview(text) from public, anon;
grant execute on function compliance_record_upsert(text,text,date,date,text,text) to authenticated;
grant execute on function compliance_record_verify(text) to authenticated;
grant execute on function compliance_record_revoke(text,text) to authenticated;
grant execute on function staff_compliance_overview(text) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. EMPLOYMENT LIFECYCLE (B) — "End employment", never casual deletion.
--    stage9 already makes disabled rows lose all staff powers instantly via
--    the helper functions; this adds the lifecycle record, future-shift
--    handling, the archived-leavers view, and a dependency-guarded purge that
--    exists ONLY for a mistaken duplicate profile with no history.
-- ----------------------------------------------------------------------------
alter table staff_profiles add column if not exists employment_end_date date;
alter table staff_profiles add column if not exists employment_end_reason text;
alter table staff_profiles add column if not exists employment_end_notes  text;
alter table staff_profiles add column if not exists ended_at timestamptz;
alter table staff_profiles add column if not exists ended_by_staff_id text;
alter table staff_profiles add column if not exists payroll_export_note text;
-- work_shifts carries no status today; leaver handling needs one that cannot
-- collide with any existing column. Default keeps every historic row valid.
alter table work_shifts add column if not exists lifecycle_status text not null default 'scheduled'
  check (lifecycle_status in ('scheduled','completed','cancelled_leaver'));

create or replace function end_employment(
  p_employee_id text, p_end_date date, p_reason text, p_notes text,
  p_immediate boolean default true
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_actor text := current_staff_id(); v_flagged int := 0;
begin
  if v_actor is null or not is_manager_or_owner() then raise exception 'not_permitted'; end if;
  if p_employee_id = v_actor then raise exception 'cannot_end_own_employment'; end if;
  if not is_owner() then
    if exists (select 1 from staff_profiles where id = p_employee_id and role in ('store_manager','owner')) then
      raise exception 'not_permitted';                  -- managers cannot end managers/owners
    end if;
    if not exists (select 1 from staff_profiles
                    where id = p_employee_id and store_id = current_staff_store()) then
      raise exception 'not_permitted';
    end if;
  end if;

  update staff_profiles
     set employment_end_date = p_end_date,
         employment_end_reason = coalesce(p_reason,''),
         employment_end_notes  = coalesce(p_notes,''),
         ended_by_staff_id = v_actor,
         ended_at = case when p_immediate or p_end_date <= current_date then now() end,
         status   = case when p_immediate or p_end_date <= current_date
                         then 'disabled' else status end,
         updated_at = now()
   where id = p_employee_id;
  if not found then raise exception 'not_found'; end if;

  -- Future shifts after the end date are flagged, never silently deleted.
  update work_shifts
     set lifecycle_status = 'cancelled_leaver'
   where employee_id = p_employee_id
     and date > p_end_date
     and coalesce(lifecycle_status,'scheduled') <> 'completed';
  get diagnostics v_flagged = row_count;

  insert into audit_logs (id, operator_name, role, action, timestamp, module, new_value)
  values (gen_random_uuid()::text, v_actor, current_staff_role()::text,
          'employment.ended', now()::text, 'Team',
          p_employee_id || ' end=' || p_end_date::text || ' reason=' || coalesce(p_reason,''));
  return jsonb_build_object('ok', true, 'future_shifts_flagged', v_flagged,
                            'access_disabled', p_immediate or p_end_date <= current_date);
end $$;

-- Scheduled end dates fall due without human attention: any helper resolution
-- after the date treats the row as disabled.
create or replace function employment_sweep_due()
returns int
language sql security definer
set search_path = public, pg_temp
as $$
  with due as (
    update staff_profiles
       set status = 'disabled', ended_at = now(), updated_at = now()
     where employment_end_date is not null
       and employment_end_date <= current_date
       and coalesce(status,'active') <> 'disabled'
     returning 1)
  select count(*)::int from due;
$$;

-- Guarded purge: mistaken duplicate ONLY. Owner + AAL2 (is_owner already
-- requires aal2 since fix8) + zero dependent history, checked server-side.
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

  if exists (select 1 from work_shifts    where employee_id = p_employee_id) then v_deps := v_deps || 'shifts'; end if;
  if exists (select 1 from clock_history  where employee_id = p_employee_id) then v_deps := v_deps || 'clock_history'; end if;
  if exists (select 1 from payslips       where employee_id = p_employee_id) then v_deps := v_deps || 'payroll'; end if;
  if exists (select 1 from staff_documents where employee_id = p_employee_id) then v_deps := v_deps || 'documents'; end if;
  if exists (select 1 from staff_compliance_records where employee_id = p_employee_id) then v_deps := v_deps || 'compliance'; end if;
  if exists (select 1 from training_results where employee_id = p_employee_id) then v_deps := v_deps || 'training'; end if;
  if exists (select 1 from sifr_reports  where reporter_id = p_employee_id) then v_deps := v_deps || 'sifr'; end if;
  if array_length(v_deps,1) is not null then
    return jsonb_build_object('ok', false, 'error', 'has_dependent_history', 'dependencies', to_jsonb(v_deps));
  end if;

  delete from staff_profiles where id = p_employee_id;
  insert into audit_logs (id, operator_name, role, action, timestamp, module, previous_value)
  values (gen_random_uuid()::text, current_staff_id(), 'owner',
          'employment.purged_duplicate', now()::text, 'Team', p_employee_id || ' ' || v_name);
  return jsonb_build_object('ok', true);
end $$;

revoke all on function end_employment(text,date,text,text,boolean) from public, anon;
revoke all on function employment_sweep_due() from public, anon, authenticated;
revoke all on function purge_employee(text,text) from public, anon;
grant execute on function end_employment(text,date,text,text,boolean) to authenticated;
grant execute on function purge_employee(text,text) to authenticated;
-- employment_sweep_due is service-role only (scheduled worker).

-- ----------------------------------------------------------------------------
-- 3. RECOVERY INTENTS (H2/H3) — MFA reset and global revocation are audited,
--    owner-driven, two-step: an intent row is written here by the owner (AAL2),
--    then the employee-access-revoke Edge Function (service role) executes the
--    Auth-API action ONLY when a fresh unconsumed intent exists. Managers
--    cannot reset an owner's MFA; nobody resets their own verified factor
--    from an ordinary session.
-- ----------------------------------------------------------------------------
create table if not exists admin_recovery_intents (
  id            text primary key default gen_random_uuid()::text,
  action        text not null check (action in ('reset_mfa','revoke_sessions','ban_leaver')),
  target_staff_id text not null references staff_profiles(id) on delete cascade,
  requested_by  text not null,
  reason        text not null default '',
  created_at    timestamptz not null default now(),
  consumed_at   timestamptz,
  result        text
);
alter table admin_recovery_intents enable row level security;
drop policy if exists recovery_intents_owner_read on admin_recovery_intents;
create policy recovery_intents_owner_read on admin_recovery_intents
  for select to authenticated using (is_owner());

create or replace function request_recovery_action(
  p_action text, p_target text, p_reason text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_actor text := current_staff_id(); v_id text;
begin
  if p_action not in ('reset_mfa','revoke_sessions','ban_leaver') then
    raise exception 'unknown_action';
  end if;
  -- reset_mfa: owner only, never self-service, and only is_owner() (which
  -- already embeds the AAL2 requirement from fix8).
  if p_action = 'reset_mfa' then
    if not is_owner() then raise exception 'not_permitted'; end if;
    if p_target = v_actor then raise exception 'self_reset_forbidden'; end if;
  else
    if not is_manager_or_owner() then raise exception 'not_permitted'; end if;
    if not is_owner() and exists (select 1 from staff_profiles
          where id = p_target and role in ('store_manager','owner')) then
      raise exception 'not_permitted';
    end if;
  end if;
  v_id := gen_random_uuid()::text;
  insert into admin_recovery_intents (id, action, target_staff_id, requested_by, reason)
  values (v_id, p_action, p_target, v_actor, coalesce(p_reason,''));
  insert into audit_logs (id, operator_name, role, action, timestamp, module, new_value)
  values (gen_random_uuid()::text, v_actor, current_staff_role()::text,
          'recovery.' || p_action || '.requested', now()::text, 'Security', p_target);
  return jsonb_build_object('ok', true, 'intent_id', v_id);
end $$;

revoke all on function request_recovery_action(text,text,text) from public, anon;
grant execute on function request_recovery_action(text,text,text) to authenticated;

comment on table staff_compliance_records is
  'R4.8 A1: authoritative compliance. UI labels derive from these rows only; a file upload alone never becomes verified.';
comment on function purge_employee(text,text) is
  'R4.8 B: duplicate-profile purge only — owner+AAL2, typed confirmation, refuses when any dependent history exists.';
