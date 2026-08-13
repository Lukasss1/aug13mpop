-- ============================================================================
-- MILK POP T13.3.2 AUDIT CLOSURE — ATOMIC CHECKLIST ITEM MUTATIONS
--
-- T13.3.1 made category submission and shift-cover board mutations atomic.
-- The remaining checklist tick/comment path still replaced the whole daily
-- envelope from the browser. A concurrent tick could overwrite another task
-- or reintroduce a category immediately after its atomic submission reset.
-- This migration makes each task mutation a one-item server transaction and
-- makes every checklist operational key RPC-owned.
-- ============================================================================

-- Rebuild the mutable daily task array from the current manager-owned template,
-- preserving only safe operational fields for matching stable template ids.
-- This lets a template edit reconcile naturally rather than leaving a state
-- that can never be submitted until somebody performs an unsafe full rewrite.
create or replace function reconcile_checklist_tasks(p_tasks jsonb)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'id', t.id,
        'task', t.label,
        'category', t.category,
        'completed', case when prior.item->'completed' = 'true'::jsonb then true else false end,
        'completedBy', case when prior.item->'completed' = 'true'::jsonb then nullif(left(prior.item->>'completedBy', 200), '') else null end,
        'completedAt', case when prior.item->'completed' = 'true'::jsonb then nullif(left(prior.item->>'completedAt', 80), '') else null end,
        'comment', nullif(left(prior.item->>'comment', 1000), '')
      ))
      order by case t.category when 'opening' then 1 when 'midday' then 2 else 3 end,
               t.sort_order,
               t.id
    ),
    '[]'::jsonb
  )
  from checklist_templates t
  left join lateral (
    select item
      from jsonb_array_elements(
        case when jsonb_typeof(p_tasks) = 'array' then p_tasks else '[]'::jsonb end
      ) as source(item)
     where item->>'id' = t.id
     limit 1
  ) prior on true;
$$;

revoke all on function reconcile_checklist_tasks(jsonb) from public, anon, authenticated;

-- All operational documents are now RPC-owned. The generic key/value writer is
-- retained only for owner-controlled global e-mail settings.
create or replace function set_app_state(p_key text, p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff_id text := current_staff_id();
begin
  if v_staff_id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if p_key is null or length(p_key) > 120 then
    raise exception 'invalid_key';
  end if;

  if p_key like 'milkpop_clock_status_%' then
    raise exception 'clock_keys_are_rpc_only' using errcode = '42501';
  elsif p_key ~ '^(milkpop_checklist_tasks|milkpop_checklist_audits|milkpop_shift_covers):' then
    raise exception 'operational_key_is_rpc_only' using errcode = '42501';
  elsif p_key = 'milkpop_email_settings' then
    if not is_owner() then
      raise exception 'owner_only_key' using errcode = '42501';
    end if;
  else
    raise exception 'key_not_allowed';
  end if;

  insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
  values (p_key, p_value, 'global', null, null, now())
  on conflict (key) do update
     set value = excluded.value,
         scope = 'global',
         owner_staff_id = null,
         store_id = null,
         updated_at = now();

  return jsonb_build_object('ok', true, 'key', p_key, 'scope', 'global', 'storeId', null);
end $$;

revoke all on function set_app_state(text, jsonb) from public;
grant execute on function set_app_state(text, jsonb) to authenticated;

-- Update exactly one checklist task under a row lock. The server derives the
-- staff identity/store, uses the store-local date, reconciles the latest
-- template, stamps completion identity/time, and bounds observations.
create or replace function update_checklist_task(
  p_business_date text,
  p_task_id text,
  p_completed boolean default null,
  p_comment text default null,
  p_clear_comment boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff text := current_staff_id();
  v_store text := current_staff_store();
  v_me staff_profiles%rowtype;
  v_timezone text;
  v_today text;
  v_key text;
  v_state jsonb;
  v_tasks jsonb;
  v_updated jsonb := '[]'::jsonb;
  v_item jsonb;
  v_found boolean := false;
  v_comment text;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if v_store is null or btrim(v_store) = '' then raise exception 'store_assignment_required' using errcode = '42501'; end if;
  if p_task_id is null or btrim(p_task_id) = '' or length(p_task_id) > 200 then raise exception 'invalid_task_id'; end if;

  select * into v_me from staff_profiles where id = v_staff;
  select timezone into v_timezone from stores where id = v_store;
  if not found then raise exception 'store_not_found'; end if;
  v_today := to_char(now() at time zone coalesce(v_timezone, 'Europe/London'), 'YYYY-MM-DD');
  if p_business_date is distinct from v_today then raise exception 'business_date_changed'; end if;

  if not exists (select 1 from checklist_templates where id = p_task_id) then
    raise exception 'checklist_task_not_configured';
  end if;

  v_key := 'milkpop_checklist_tasks:' || v_store;
  insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
  values (
    v_key,
    jsonb_build_object('businessDate', v_today, 'tasks', reconcile_checklist_tasks('[]'::jsonb)),
    'store', null, v_store, now()
  )
  on conflict (key) do nothing;

  select value into v_state from app_state where key = v_key for update;
  if jsonb_typeof(v_state) <> 'object'
     or v_state->>'businessDate' is distinct from v_today
     or jsonb_typeof(v_state->'tasks') <> 'array' then
    v_tasks := reconcile_checklist_tasks('[]'::jsonb);
  else
    v_tasks := reconcile_checklist_tasks(v_state->'tasks');
  end if;

  v_comment := left(btrim(coalesce(p_comment, '')), 1000);

  for v_item in select value from jsonb_array_elements(v_tasks)
  loop
    if v_item->>'id' = p_task_id then
      v_found := true;

      if p_completed is not null then
        if p_completed then
          v_item := jsonb_set(v_item, '{completed}', 'true'::jsonb, true);
          v_item := jsonb_set(v_item, '{completedBy}', to_jsonb(coalesce(v_me.name, v_staff)), true);
          v_item := jsonb_set(
            v_item,
            '{completedAt}',
            to_jsonb(to_char(clock_timestamp() at time zone coalesce(v_timezone, 'Europe/London'), 'HH24:MI')),
            true
          );
        else
          v_item := (v_item - 'completedBy' - 'completedAt') || jsonb_build_object('completed', false);
        end if;
      end if;

      if p_clear_comment then
        v_item := v_item - 'comment';
      elsif p_comment is not null then
        if v_comment = '' then
          v_item := v_item - 'comment';
        else
          v_item := jsonb_set(v_item, '{comment}', to_jsonb(v_comment), true);
        end if;
      end if;
    end if;
    v_updated := v_updated || jsonb_build_array(v_item);
  end loop;

  if not v_found then raise exception 'checklist_task_not_configured'; end if;

  v_state := jsonb_build_object('businessDate', v_today, 'tasks', v_updated);
  update app_state
     set value = v_state,
         scope = 'store',
         owner_staff_id = null,
         store_id = v_store,
         updated_at = now()
   where key = v_key;

  return jsonb_build_object('ok', true, 'state', v_state, 'storeId', v_store);
end $$;

revoke all on function update_checklist_task(text, text, boolean, text, boolean) from public;
grant execute on function update_checklist_task(text, text, boolean, text, boolean) to authenticated;

-- Re-issue category submission so a manager template edit is reconciled under
-- the same transaction instead of leaving the daily row permanently stale.
create or replace function submit_checklist_category(p_business_date text, p_category text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
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
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if v_store is null or btrim(v_store) = '' then raise exception 'store_assignment_required' using errcode = '42501'; end if;
  if p_category not in ('opening', 'midday', 'closing') then raise exception 'invalid_category'; end if;

  select * into v_me from staff_profiles where id = v_staff;
  select name, timezone into v_store_name, v_timezone from stores where id = v_store;
  if v_store_name is null then raise exception 'store_not_found'; end if;
  v_today := to_char(now() at time zone coalesce(v_timezone, 'Europe/London'), 'YYYY-MM-DD');
  if p_business_date is distinct from v_today then raise exception 'business_date_changed'; end if;

  v_tasks_key := 'milkpop_checklist_tasks:' || v_store;
  v_audits_key := 'milkpop_checklist_audits:' || v_store;

  insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
  values (
    v_tasks_key,
    jsonb_build_object('businessDate', v_today, 'tasks', reconcile_checklist_tasks('[]'::jsonb)),
    'store', null, v_store, now()
  )
  on conflict (key) do nothing;
  insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
  values (v_audits_key, '[]'::jsonb, 'store', null, v_store, now())
  on conflict (key) do nothing;

  perform 1 from app_state
   where key in (v_tasks_key, v_audits_key)
   order by key
   for update;

  select value into v_state from app_state where key = v_tasks_key;
  select value into v_audits from app_state where key = v_audits_key;

  if jsonb_typeof(v_state) <> 'object'
     or v_state->>'businessDate' is distinct from v_today
     or jsonb_typeof(v_state->'tasks') <> 'array' then
    v_tasks := reconcile_checklist_tasks('[]'::jsonb);
  else
    v_tasks := reconcile_checklist_tasks(v_state->'tasks');
  end if;
  if jsonb_typeof(v_audits) <> 'array' then v_audits := '[]'::jsonb; end if;

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
