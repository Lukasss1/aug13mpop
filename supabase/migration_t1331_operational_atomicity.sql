-- ============================================================================
-- MILK POP T13.3.1 AUDIT CLOSURE — ATOMIC STORE OPERATIONS
--
-- Follow-up to migration_t133_store_operational_state.sql. The first closure
-- separated each store's JSON documents, but checklist submission still wrote
-- audit + reset as two client RPCs and cover request/retract still replaced the
-- whole cover board. These server transactions mutate only the intended entry
-- and make multi-user operation deterministic.
-- ============================================================================

-- Store audit rows and cover boards are RPC-owned. Ordinary checklist task
-- ticks/notes may still use set_app_state, but a staff member cannot replace
-- the audit history or shift-cover board wholesale.
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
  v_store_id text := null;
  v_suffix text;
  v_timezone text;
  v_today text;
  v_task_count integer;
begin
  if v_staff_id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if p_key is null or length(p_key) > 120 then
    raise exception 'invalid_key';
  end if;

  if p_key like 'milkpop_clock_status_%' then
    raise exception 'clock_keys_are_rpc_only' using errcode = '42501';
  elsif p_key ~ '^milkpop_checklist_tasks:[^:]+$' then
    v_suffix := split_part(p_key, ':', 2);
    if v_store is null or btrim(v_store) = '' then
      raise exception 'store_assignment_required' using errcode = '42501';
    end if;
    if v_suffix <> v_store then
      raise exception 'wrong_store_key' using errcode = '42501';
    end if;
    if jsonb_typeof(p_value) <> 'object'
       or jsonb_typeof(p_value->'tasks') <> 'array'
       or coalesce(p_value->>'businessDate', '') = '' then
      raise exception 'invalid_checklist_state';
    end if;
    select timezone into v_timezone from stores where id = v_store;
    v_today := to_char(now() at time zone coalesce(v_timezone, 'Europe/London'), 'YYYY-MM-DD');
    if p_value->>'businessDate' is distinct from v_today then
      raise exception 'business_date_changed';
    end if;
    select count(*) into v_task_count from checklist_templates;
    if jsonb_array_length(p_value->'tasks') <> v_task_count
       or (select count(distinct item->>'id') from jsonb_array_elements(p_value->'tasks') item) <> v_task_count
       or exists (
         select 1
           from jsonb_array_elements(p_value->'tasks') item
          where not exists (
            select 1 from checklist_templates t
             where t.id = item->>'id'
               and t.category = item->>'category'
               and t.label = item->>'task'
          )
       ) then
      raise exception 'checklist_reload_required';
    end if;
    v_scope := 'store';
    v_store_id := v_store;
  elsif p_key ~ '^(milkpop_checklist_audits|milkpop_shift_covers):' then
    raise exception 'operational_key_is_rpc_only' using errcode = '42501';
  elsif p_key = 'milkpop_email_settings' then
    if not is_owner() then
      raise exception 'owner_only_key' using errcode = '42501';
    end if;
    v_scope := 'global';
  else
    raise exception 'key_not_allowed';
  end if;

  insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
  values (p_key, p_value, v_scope, null, v_store_id, now())
  on conflict (key) do update
     set value = excluded.value,
         scope = excluded.scope,
         owner_staff_id = null,
         store_id = excluded.store_id,
         updated_at = now();

  return jsonb_build_object('ok', true, 'key', p_key, 'scope', v_scope, 'storeId', v_store_id);
end $$;

revoke all on function set_app_state(text, jsonb) from public;
grant execute on function set_app_state(text, jsonb) to authenticated;

-- Post or update the caller's own cover request without replacing colleagues'
-- entries. The shift row and board row are locked in a stable order.
create or replace function request_shift_cover(p_shift_id text, p_message text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
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

  select * into v_me from staff_profiles where id = v_staff;
  select * into v_shift from work_shifts where id = p_shift_id for update;
  if v_shift.id is null then raise exception 'shift_not_found'; end if;
  if v_shift.store_id is distinct from v_store then raise exception 'wrong_store' using errcode = '42501'; end if;
  if v_shift.employee_id is distinct from v_staff then raise exception 'not_your_shift' using errcode = '42501'; end if;

  v_key := 'milkpop_shift_covers:' || v_store;
  insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
  values (v_key, '{}'::jsonb, 'store', null, v_store, now())
  on conflict (key) do nothing;

  select value into v_covers from app_state where key = v_key for update;
  if v_covers is null or jsonb_typeof(v_covers) <> 'object' then v_covers := '{}'::jsonb; end if;

  v_message := left(coalesce(nullif(btrim(p_message), ''), 'Needs cover due to a schedule clash.'), 500);
  v_covers := jsonb_set(
    v_covers,
    array[p_shift_id],
    jsonb_build_object(
      'requestedBy', coalesce(v_me.name, v_staff),
      'requestedById', v_staff,
      'message', v_message,
      'date', clock_timestamp()
    ),
    true
  );

  update app_state set value = v_covers, updated_at = now() where key = v_key;
  return jsonb_build_object('ok', true, 'covers', v_covers, 'storeId', v_store);
end $$;

revoke all on function request_shift_cover(text, text) from public;
grant execute on function request_shift_cover(text, text) to authenticated;

-- Withdraw one request. Staff may withdraw their own shift; a same-store
-- manager/owner may remove a stale request during operations.
create or replace function retract_shift_cover(p_shift_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff text := current_staff_id();
  v_store text := current_staff_store();
  v_shift work_shifts%rowtype;
  v_key text;
  v_covers jsonb;
  v_entry jsonb;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if v_store is null or btrim(v_store) = '' then raise exception 'store_assignment_required' using errcode = '42501'; end if;

  select * into v_shift from work_shifts where id = p_shift_id for update;
  if v_shift.id is not null and v_shift.store_id is distinct from v_store then
    raise exception 'wrong_store' using errcode = '42501';
  end if;

  v_key := 'milkpop_shift_covers:' || v_store;
  select value into v_covers from app_state where key = v_key for update;
  if v_covers is null or jsonb_typeof(v_covers) <> 'object' then
    return jsonb_build_object('ok', true, 'covers', '{}'::jsonb, 'storeId', v_store);
  end if;

  v_entry := v_covers->p_shift_id;
  if v_entry is null then
    return jsonb_build_object('ok', true, 'covers', v_covers, 'storeId', v_store);
  end if;

  if not is_manager_or_owner()
     and coalesce(v_shift.employee_id, '') <> v_staff
     and coalesce(v_entry->>'requestedById', '') <> v_staff then
    raise exception 'not_your_request' using errcode = '42501';
  end if;

  v_covers := v_covers - p_shift_id;
  update app_state set value = v_covers, updated_at = now() where key = v_key;
  return jsonb_build_object('ok', true, 'covers', v_covers, 'storeId', v_store);
end $$;

revoke all on function retract_shift_cover(text) from public;
grant execute on function retract_shift_cover(text) to authenticated;

-- Submit one checklist category. The current task envelope is read from the
-- database, the audit is prepended, and that category is reset atomically.
create or replace function submit_checklist_category(p_business_date text, p_category text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff text := current_staff_id();
  v_store text := current_staff_store();
  v_me staff_profiles%rowtype;
  v_store_name text;
  v_timezone text;
  v_today text;
  v_tasks_key text;
  v_audits_key text;
  v_state jsonb;
  v_tasks jsonb;
  v_updated_tasks jsonb;
  v_audits jsonb;
  v_items jsonb;
  v_total integer;
  v_completed integer;
  v_audit jsonb;
  v_seed_tasks jsonb;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if v_store is null or btrim(v_store) = '' then raise exception 'store_assignment_required' using errcode = '42501'; end if;
  if p_category not in ('opening', 'midday', 'closing') then raise exception 'invalid_category'; end if;

  select * into v_me from staff_profiles where id = v_staff;
  select name, timezone into v_store_name, v_timezone from stores where id = v_store;
  if v_store_name is null then raise exception 'store_not_found'; end if;
  v_today := to_char(now() at time zone coalesce(v_timezone, 'Europe/London'), 'YYYY-MM-DD');
  if p_business_date is distinct from v_today then raise exception 'business_date_changed'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'task', label,
      'category', category,
      'completed', false
    ) order by category, sort_order, id), '[]'::jsonb)
    into v_seed_tasks
    from checklist_templates;

  v_tasks_key := 'milkpop_checklist_tasks:' || v_store;
  v_audits_key := 'milkpop_checklist_audits:' || v_store;

  insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
  values (v_tasks_key, jsonb_build_object('businessDate', v_today, 'tasks', v_seed_tasks), 'store', null, v_store, now())
  on conflict (key) do nothing;
  insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
  values (v_audits_key, '[]'::jsonb, 'store', null, v_store, now())
  on conflict (key) do nothing;

  -- Fixed lexical order prevents opposite lock order between submissions.
  perform 1 from app_state
   where key in (v_tasks_key, v_audits_key)
   order by key
   for update;

  select value into v_state from app_state where key = v_tasks_key;
  select value into v_audits from app_state where key = v_audits_key;

  if jsonb_typeof(v_state) <> 'object'
     or v_state->>'businessDate' is distinct from v_today
     or jsonb_typeof(v_state->'tasks') <> 'array' then
    v_state := jsonb_build_object('businessDate', v_today, 'tasks', v_seed_tasks);
  end if;
  v_tasks := v_state->'tasks';
  if jsonb_typeof(v_audits) <> 'array' then v_audits := '[]'::jsonb; end if;

  if jsonb_array_length(v_tasks) <> (select count(*) from checklist_templates)
     or (select count(distinct item->>'id') from jsonb_array_elements(v_tasks) item) <> (select count(*) from checklist_templates)
     or exists (
       select 1
         from jsonb_array_elements(v_tasks) item
        where not exists (
          select 1 from checklist_templates t
           where t.id = item->>'id'
             and t.category = item->>'category'
             and t.label = item->>'task'
        )
     ) then
    raise exception 'checklist_reload_required';
  end if;

  select coalesce(jsonb_agg(item order by ord), '[]'::jsonb),
         count(*)::integer,
         (count(*) filter (where item->>'completed' = 'true'))::integer
    into v_items, v_total, v_completed
    from jsonb_array_elements(v_tasks) with ordinality as x(item, ord)
   where item->>'category' = p_category;

  if v_total = 0 then raise exception 'checklist_category_not_configured'; end if;

  select coalesce(jsonb_agg(
      case when item->>'category' = p_category
        then (item - 'completedBy' - 'completedAt' - 'comment') || jsonb_build_object('completed', false)
        else item
      end order by ord
    ), '[]'::jsonb)
    into v_updated_tasks
    from jsonb_array_elements(v_tasks) with ordinality as x(item, ord);

  v_audit := jsonb_build_object(
    'id', 'audit_' || replace(gen_random_uuid()::text, '-', ''),
    'businessDate', v_today,
    'submittedAt', clock_timestamp(),
    'submittedBy', coalesce(v_me.name, v_staff),
    'submittedById', v_staff,
    'storeName', v_store_name,
    'category', p_category,
    'completedCount', v_completed,
    'totalCount', v_total,
    'items', v_items
  );
  v_audits := jsonb_build_array(v_audit) || v_audits;
  v_state := jsonb_build_object('businessDate', v_today, 'tasks', v_updated_tasks);

  update app_state set value = v_state, updated_at = now() where key = v_tasks_key;
  update app_state set value = v_audits, updated_at = now() where key = v_audits_key;

  return jsonb_build_object('ok', true, 'state', v_state, 'audits', v_audits, 'audit', v_audit, 'storeId', v_store);
end $$;

revoke all on function submit_checklist_category(text, text) from public;
grant execute on function submit_checklist_category(text, text) to authenticated;
