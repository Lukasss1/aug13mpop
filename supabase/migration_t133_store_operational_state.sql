-- ============================================================================
-- MILK POP T13.3 — STORE-SCOPED OPERATIONAL app_state
--
-- The old checklist/audit/cover keys were globally unique even though their
-- rows carried a store_id. A second store therefore overwrote the first store's
-- JSON document. This append-only migration moves those three documents to
-- <base>:<store_id>, tightens set_app_state(), and makes claim_shift() operate
-- on the shift's real store document.
-- ============================================================================

-- 1. Move legacy unsuffixed operational rows without discarding data.
do $$
declare
  r app_state%rowtype;
  v_store_id text;
  v_store_count integer;
  v_timezone text;
  v_new_key text;
  v_value jsonb;
begin
  select count(*) into v_store_count from stores;

  for r in
    select * from app_state
     where key in ('milkpop_checklist_tasks', 'milkpop_checklist_audits', 'milkpop_shift_covers')
     order by key
  loop
    v_store_id := r.store_id;

    if (v_store_id is null or btrim(v_store_id) = '') and v_store_count = 1 then
      select id into v_store_id from stores limit 1;
    end if;

    if v_store_id is not null and btrim(v_store_id) <> '' then
      v_new_key := r.key || ':' || v_store_id;
      v_value := r.value;

      -- Legacy checklist tasks were a raw array. Stamp the migration-day
      -- business date so they remain visible once and are naturally refreshed
      -- at the next store-local day boundary.
      if r.key = 'milkpop_checklist_tasks' and jsonb_typeof(r.value) = 'array' then
        select timezone into v_timezone from stores where id = v_store_id;
        v_value := jsonb_build_object(
          'businessDate', to_char(now() at time zone coalesce(v_timezone, 'Europe/London'), 'YYYY-MM-DD'),
          'tasks', r.value
        );
      end if;

      insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
      values (v_new_key, v_value, 'store', null, v_store_id, r.updated_at)
      on conflict (key) do update
        set value = case
              when excluded.updated_at >= app_state.updated_at then excluded.value
              else app_state.value
            end,
            scope = 'store',
            owner_staff_id = null,
            store_id = excluded.store_id,
            updated_at = greatest(app_state.updated_at, excluded.updated_at);

      delete from app_state where key = r.key;
    else
      -- Multiple stores but no reliable owner: retain the document for owner
      -- review, but keep it out of live store operations.
      v_new_key := 'legacy_review:' || r.key || ':' || replace(gen_random_uuid()::text, '-', '');
      insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
      values (v_new_key, r.value, 'global', null, null, r.updated_at);
      delete from app_state where key = r.key;
    end if;
  end loop;
end $$;

-- 2. Store-state writes require a suffixed key that matches the caller's
-- server-derived store. Clock keys remain RPC-only and e-mail settings owner-only.
create or replace function set_app_state(p_key text, p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id text := current_staff_id();
  v_store text := current_staff_store();
  v_scope text;
  v_owner text := null;
  v_store_id text := null;
  v_base text;
  v_suffix text;
begin
  if v_staff_id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if p_key is null or length(p_key) > 120 then
    raise exception 'invalid_key';
  end if;

  if p_key like 'milkpop_clock_status_%' then
    raise exception 'clock_keys_are_rpc_only' using errcode = '42501';
  elsif p_key ~ '^(milkpop_checklist_tasks|milkpop_checklist_audits|milkpop_shift_covers):[^:]+$' then
    v_base := split_part(p_key, ':', 1);
    v_suffix := split_part(p_key, ':', 2);
    if v_store is null or btrim(v_store) = '' then
      raise exception 'store_assignment_required' using errcode = '42501';
    end if;
    if v_suffix <> v_store then
      raise exception 'wrong_store_key' using errcode = '42501';
    end if;
    v_scope := 'store';
    v_store_id := v_store;
  elsif p_key = 'milkpop_email_settings' then
    if not is_owner() then
      raise exception 'owner_only_key' using errcode = '42501';
    end if;
    v_scope := 'global';
  else
    raise exception 'key_not_allowed';
  end if;

  insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
  values (p_key, p_value, v_scope, v_owner, v_store_id, now())
  on conflict (key) do update
     set value = excluded.value,
         scope = excluded.scope,
         owner_staff_id = excluded.owner_staff_id,
         store_id = excluded.store_id,
         updated_at = now();

  return jsonb_build_object('ok', true, 'key', p_key, 'scope', v_scope, 'storeId', v_store_id);
end $$;

revoke all on function set_app_state(text, jsonb) from public;
grant execute on function set_app_state(text, jsonb) to authenticated;

-- 3. Claim the cover document for the shift's actual store. Null-store shifts
-- are invalid for cover claiming: cross-store ambiguity must fail closed.
create or replace function claim_shift(p_shift_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff text := current_staff_id();
  v_me staff_profiles%rowtype;
  v_shift work_shifts%rowtype;
  v_covers jsonb;
  v_cover_key text;
  v_new_id text := 'shift_' || replace(gen_random_uuid()::text, '-', '');
  v_new work_shifts%rowtype;
begin
  if v_staff is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;

  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;

  -- Stable order for concurrent claims of the same advert: shift then its
  -- store cover document. Exactly one transaction can retain the row.
  select * into v_shift from work_shifts where id = p_shift_id for update;
  if v_shift.id is null then
    raise exception 'not_open_for_cover';
  end if;
  if v_shift.store_id is null or btrim(v_shift.store_id) = '' then
    raise exception 'shift_store_required';
  end if;
  if coalesce(v_me.store_id, '') <> v_shift.store_id then
    raise exception 'wrong_store' using errcode = '42501';
  end if;

  v_cover_key := 'milkpop_shift_covers:' || v_shift.store_id;
  select value into v_covers from app_state where key = v_cover_key for update;
  if v_covers is null or jsonb_typeof(v_covers) <> 'object' or not (v_covers ? p_shift_id) then
    raise exception 'not_open_for_cover';
  end if;

  if v_shift.employee_id = v_staff then
    raise exception 'own_shift';
  end if;
  if exists (
    select 1 from work_shifts w
     where w.employee_id = v_staff
       and w.date = v_shift.date
       and w.start_time < v_shift.end_time
       and w.end_time > v_shift.start_time
  ) then
    raise exception 'schedule_conflict';
  end if;

  insert into work_shifts
    (id, employee_id, employee_name, role, store_id, store_name,
     date, start_time, end_time, type, notes)
  values
    (v_new_id, v_staff, coalesce(v_me.name, ''), v_me.role,
     v_shift.store_id, v_shift.store_name,
     v_shift.date, v_shift.start_time, v_shift.end_time, v_shift.type,
     'Shift coverage claimed by ' || coalesce(v_me.name, v_staff))
  returning * into v_new;

  delete from work_shifts where id = p_shift_id;

  v_covers := v_covers - p_shift_id;
  update app_state set value = v_covers, updated_at = now() where key = v_cover_key;

  return jsonb_build_object(
    'newShift', to_jsonb(v_new),
    'removedShiftId', p_shift_id,
    'covers', v_covers,
    'storeId', v_shift.store_id
  );
end $$;

revoke all on function claim_shift(text) from public;
grant execute on function claim_shift(text) to authenticated;
