-- ============================================================================
-- MILK POP — T13.3.5 SHIFT-COVER LIFECYCLE CLOSURE
--
-- Store-scoped cover documents and row locks were already in place, but an
-- orphaned board entry could still be claimed after the shift started. Reissue
-- request/claim so only a future scheduled shift can enter or leave the board.
-- A claim updates the existing shift row in place, preserving its identity and
-- any external references, and records the transfer in the audit trail.
-- ============================================================================

create or replace function request_shift_cover(p_shift_id text, p_message text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff text := current_staff_id();
  v_store text := current_staff_store();
  v_me staff_profiles%rowtype;
  v_shift work_shifts%rowtype;
  v_key text;
  v_covers jsonb;
  v_message text;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if v_store is null or btrim(v_store) = '' then raise exception 'store_assignment_required' using errcode = '42501'; end if;

  v_message := btrim(coalesce(p_message, ''));
  if length(v_message) < 3 then raise exception 'shift_cover_reason_required'; end if;
  v_message := left(v_message, 500);

  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;

  select * into v_shift from work_shifts where id = p_shift_id for update;
  if v_shift.id is null then raise exception 'shift_not_found'; end if;
  if v_shift.store_id is distinct from v_store then raise exception 'wrong_store' using errcode = '42501'; end if;
  if v_shift.employee_id is distinct from v_staff then raise exception 'not_your_shift' using errcode = '42501'; end if;
  if coalesce(v_shift.lifecycle_status, 'scheduled') <> 'scheduled' or v_shift.starts_at <= now() then
    raise exception 'shift_cover_window_closed';
  end if;

  v_key := 'milkpop_shift_covers:' || v_store;
  insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
  values (v_key, '{}'::jsonb, 'store', null, v_store, now())
  on conflict (key) do nothing;

  select value into v_covers from app_state where key = v_key for update;
  if v_covers is null or jsonb_typeof(v_covers) <> 'object' then v_covers := '{}'::jsonb; end if;

  v_covers := jsonb_set(
    v_covers,
    array[p_shift_id],
    jsonb_build_object(
      'requestedBy', coalesce(nullif(btrim(v_me.name), ''), v_staff),
      'requestedById', v_staff,
      'message', v_message,
      'date', clock_timestamp()
    ),
    true
  );

  update app_state set value = v_covers, updated_at = now() where key = v_key;
  return jsonb_build_object('ok', true, 'covers', v_covers, 'storeId', v_store);
end $$;

revoke all on function request_shift_cover(text, text) from public, anon;
grant execute on function request_shift_cover(text, text) to authenticated;

create or replace function claim_shift(p_shift_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff text := current_staff_id();
  v_me staff_profiles%rowtype;
  v_shift work_shifts%rowtype;
  v_previous_employee_id text;
  v_previous_employee_name text;
  v_covers jsonb;
  v_cover_key text;
  v_new work_shifts%rowtype;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;

  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;

  -- Request, retract and claim all lock in shift → board order.
  select * into v_shift from work_shifts where id = p_shift_id for update;
  if v_shift.id is null then raise exception 'not_open_for_cover'; end if;
  if v_shift.store_id is null or btrim(v_shift.store_id) = '' then raise exception 'shift_store_required'; end if;
  if coalesce(v_me.store_id, '') <> v_shift.store_id then raise exception 'wrong_store' using errcode = '42501'; end if;
  if coalesce(v_shift.lifecycle_status, 'scheduled') <> 'scheduled' or v_shift.starts_at <= now() then
    raise exception 'shift_cover_window_closed';
  end if;

  v_cover_key := 'milkpop_shift_covers:' || v_shift.store_id;
  select value into v_covers from app_state where key = v_cover_key for update;
  if v_covers is null or jsonb_typeof(v_covers) <> 'object' or not (v_covers ? p_shift_id) then
    raise exception 'not_open_for_cover';
  end if;

  if v_shift.employee_id = v_staff then raise exception 'own_shift'; end if;
  if exists (
    select 1 from work_shifts w
     where w.employee_id = v_staff
       and w.id <> v_shift.id
       and coalesce(w.lifecycle_status, 'scheduled') = 'scheduled'
       and tstzrange(w.starts_at, w.ends_at, '[)')
           && tstzrange(v_shift.starts_at, v_shift.ends_at, '[)')
  ) then
    raise exception 'schedule_conflict';
  end if;

  v_previous_employee_id := v_shift.employee_id;
  v_previous_employee_name := v_shift.employee_name;

  update work_shifts
     set employee_id = v_staff,
         employee_name = coalesce(nullif(btrim(v_me.name), ''), v_staff),
         role = v_me.role
   where id = p_shift_id
   returning * into v_new;

  v_covers := v_covers - p_shift_id;
  update app_state set value = v_covers, updated_at = now() where key = v_cover_key;

  insert into audit_logs (id, operator_name, role, action, timestamp, module, previous_value, new_value)
  values (
    gen_random_uuid()::text,
    coalesce(nullif(btrim(v_me.name), ''), v_staff),
    v_me.role::text,
    'shift.cover_claimed',
    now()::text,
    'Rota',
    jsonb_build_object('shiftId', p_shift_id, 'employeeId', v_previous_employee_id, 'employeeName', v_previous_employee_name)::text,
    jsonb_build_object('shiftId', p_shift_id, 'employeeId', v_staff, 'employeeName', v_new.employee_name)::text
  );

  return jsonb_build_object(
    'newShift', to_jsonb(v_new),
    'removedShiftId', p_shift_id,
    'covers', v_covers,
    'storeId', v_shift.store_id
  );
end $$;

revoke all on function claim_shift(text) from public, anon;
grant execute on function claim_shift(text) to authenticated;

comment on function request_shift_cover(text, text) is
  'T13.3.5: posts a genuine reason only for the caller own future scheduled same-store shift.';
comment on function claim_shift(text) is
  'T13.3.5: atomically transfers a future scheduled same-store shift in place, closes its cover advert and audits the change.';

do $$
begin
  if to_regprocedure('public.request_shift_cover(text,text)') is null
     or to_regprocedure('public.claim_shift(text)') is null then
    raise exception 't1335_shift_cover_lifecycle: required functions missing';
  end if;
end $$;
