-- T13.3.13 — Staff Portal identity and SIFR integrity
--
-- Small-business scope:
--   * keep the existing SIFR table and UI model;
--   * make reporter/store/time server-authoritative;
--   * replace manager whole-row updates with narrow atomic operations;
--   * preserve owner-only direct repair; service-role imports keep explicit facts.

begin;

create or replace function public.sifr_reports_stamp()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id text;
  v_name text;
  v_store text;
  v_store_name text;
  v_timezone text;
  v_now timestamptz := now();
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new; -- trusted service contexts keep explicit import values
  end if;

  v_id := current_staff_id();
  if v_id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;

  select sp.name, sp.store_id, sp.store_name, coalesce(s.timezone, 'Europe/London')
    into v_name, v_store, v_store_name, v_timezone
    from staff_profiles sp
    left join stores s on s.id = sp.store_id
   where sp.id = v_id;

  if coalesce(v_store, '') = '' then
    raise exception 'staff_store_required' using errcode = '23514';
  end if;
  -- Historical test/import data used `safety`; retain upgrade compatibility
  -- while storing the current canonical category.
  if new.category = 'safety' then
    new.category := 'health_safety';
  end if;
  if new.category not in ('attendance','communication','behaviour','training','customer_service','health_safety','operations','teamwork','other') then
    raise exception 'invalid_category' using errcode = '23514';
  end if;
  if length(trim(coalesce(new.title, ''))) not between 1 and 160
     or length(trim(coalesce(new.description, ''))) not between 1 and 5000
     or length(trim(coalesce(new.impact, ''))) not between 1 and 3000
     or length(trim(coalesce(new.suggested_action, ''))) not between 1 and 3000
     or length(trim(coalesce(new.involved_people, ''))) > 1000 then
    raise exception 'invalid_report_length' using errcode = '22001';
  end if;

  -- Browser-supplied identity, store and lifecycle facts are never trusted.
  new.reporter_id := v_id;
  new.reporter_name := coalesce(v_name, '');
  new.store_id := v_store;
  new.store_name := coalesce(v_store_name, '');
  new.status := 'submitted';
  new.replies := '[]'::jsonb;
  new.submitted_at := to_char(v_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  new.date := to_char(v_now at time zone v_timezone, 'YYYY-MM-DD');
  return new;
end;
$$;

create or replace function public.sifr_reports_update_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;
  end if;

  -- Owner retains the existing repair/import capability. Store managers must
  -- use the narrow RPCs below so a stale browser copy cannot overwrite a reply
  -- or alter reporter/store/content fields.
  if is_owner() or current_setting('app.sifr_rpc', true) = 'on' then
    return new;
  end if;

  raise exception 'sifr_update_requires_rpc' using errcode = '42501';
end;
$$;

drop trigger if exists trg_sifr_reports_update_guard on public.sifr_reports;
create trigger trg_sifr_reports_update_guard
before update on public.sifr_reports
for each row execute function public.sifr_reports_update_guard();

-- Generic browser updates are owner-only. Store managers use the narrow
-- SECURITY DEFINER RPCs below, which apply row locks and store checks. This
-- means a manager cannot bypass the trigger marker with a crafted whole-row
-- update even if the browser holds a stale report object.
drop policy if exists sifr_update_mgr on public.sifr_reports;
drop policy if exists sifr_update_owner_only on public.sifr_reports;
create policy sifr_update_owner_only on public.sifr_reports
  for update to authenticated
  using (is_owner())
  with check (is_owner());

create or replace function public.create_sifr_report(
  p_title text,
  p_category text,
  p_involved_people text,
  p_description text,
  p_impact text,
  p_suggested_action text,
  p_confidentiality text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff text := current_staff_id();
  v_report sifr_reports%rowtype;
begin
  if v_staff is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if p_category not in ('attendance','communication','behaviour','training','customer_service','health_safety','operations','teamwork','other') then
    raise exception 'invalid_category' using errcode = '23514';
  end if;
  if p_confidentiality not in ('standard','confidential') then
    raise exception 'invalid_confidentiality' using errcode = '23514';
  end if;
  if length(trim(coalesce(p_title, ''))) not between 1 and 160
     or length(trim(coalesce(p_description, ''))) not between 1 and 5000
     or length(trim(coalesce(p_impact, ''))) not between 1 and 3000
     or length(trim(coalesce(p_suggested_action, ''))) not between 1 and 3000
     or length(trim(coalesce(p_involved_people, ''))) > 1000 then
    raise exception 'invalid_report_length' using errcode = '22001';
  end if;

  insert into sifr_reports (
    id, title, category, date, involved_people, store_id, store_name,
    description, impact, suggested_action, confidentiality, status,
    reporter_name, reporter_id, submitted_at, replies
  ) values (
    'sifr_' || replace(gen_random_uuid()::text, '-', ''),
    trim(p_title), p_category, '', trim(coalesce(p_involved_people, '')), null, '',
    trim(p_description), trim(p_impact), trim(p_suggested_action),
    p_confidentiality, 'submitted', '', null, '', '[]'::jsonb
  ) returning * into v_report;

  return to_jsonb(v_report);
end;
$$;

create or replace function public.append_sifr_reply(
  p_report_id text,
  p_message text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor text := current_staff_id();
  v_actor_name text;
  v_actor_role text;
  v_actor_store text;
  v_report sifr_reports%rowtype;
  v_reply jsonb;
begin
  if v_actor is null or not is_manager_or_owner() then
    raise exception 'manager_required' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_message, ''))) not between 1 and 2000 then
    raise exception 'invalid_reply_length' using errcode = '22001';
  end if;

  select name, role::text, store_id
    into v_actor_name, v_actor_role, v_actor_store
    from staff_profiles where id = v_actor;

  select * into v_report from sifr_reports where id = p_report_id for update;
  if not found then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  if not is_owner() and v_report.store_id is distinct from v_actor_store then
    raise exception 'wrong_store' using errcode = '42501';
  end if;

  v_reply := jsonb_build_object(
    'id', 'reply_' || replace(gen_random_uuid()::text, '-', ''),
    'user', coalesce(v_actor_name, ''),
    'role', coalesce(v_actor_role, ''),
    'message', trim(p_message),
    'timestamp', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  perform set_config('app.sifr_rpc', 'on', true);
  update sifr_reports
     set replies = coalesce(replies, '[]'::jsonb) || jsonb_build_array(v_reply),
         updated_at = now()
   where id = p_report_id
   returning * into v_report;

  return to_jsonb(v_report);
end;
$$;

create or replace function public.set_sifr_status(
  p_report_id text,
  p_status text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor text := current_staff_id();
  v_actor_store text;
  v_report sifr_reports%rowtype;
begin
  if v_actor is null or not is_manager_or_owner() then
    raise exception 'manager_required' using errcode = '42501';
  end if;
  if p_status not in ('submitted','under_review','escalated','action_required','resolved','closed') then
    raise exception 'invalid_status' using errcode = '23514';
  end if;

  select store_id into v_actor_store from staff_profiles where id = v_actor;
  select * into v_report from sifr_reports where id = p_report_id for update;
  if not found then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  if not is_owner() and v_report.store_id is distinct from v_actor_store then
    raise exception 'wrong_store' using errcode = '42501';
  end if;

  perform set_config('app.sifr_rpc', 'on', true);
  update sifr_reports
     set status = p_status,
         updated_at = now()
   where id = p_report_id
   returning * into v_report;

  return to_jsonb(v_report);
end;
$$;


-- A daily checklist audit is final: every configured item must be complete.
-- This also prevents a rapid second click from recording an empty audit after
-- the first transaction resets the category.
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
  if v_completed <> v_total then raise exception 'checklist_category_incomplete'; end if;

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

-- First-ever clock actions also require serialization; a SELECT FOR UPDATE on
-- a missing app_state row cannot lock anything.
create or replace function public.staff_clock_action(p_action text, p_notes text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff    text := current_staff_id();
  v_name     text;
  v_key      text;
  v_cur      jsonb;
  v_status   text;
  v_now      timestamptz := now();
  v_iso      text := to_char(v_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_acc_ms   bigint;
  v_break_ms bigint;
  v_work_ms  bigint;
  v_in_ts    timestamptz;
  v_new      jsonb;
  v_hist     jsonb := null;
  v_hist_id  text;
begin
  if v_staff is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if p_notes is not null and length(p_notes) > 500 then
    raise exception 'notes_too_long';
  end if;
  select name into v_name from staff_profiles where id = v_staff;

  v_key := 'milkpop_clock_status_' || v_staff;
  -- A row lock cannot protect the first-ever action because no app_state row
  -- exists yet. This transaction-scoped advisory lock serialises the key even
  -- before its first insert; the existing row lock remains a second boundary.
  perform pg_advisory_xact_lock(76131, hashtext(v_key));
  -- Serialise per employee: two devices racing the same clock see a queue,
  -- not interleaved half-states.
  select value into v_cur from app_state where key = v_key for update;
  v_status := coalesce(v_cur ->> 'status', 'clocked_out');
  v_acc_ms := coalesce(nullif(v_cur ->> 'accumulatedBreakMs', '')::bigint, 0);

  if p_action = 'clock_in' then
    if v_status <> 'clocked_out' then
      raise exception 'already_clocked_in';
    end if;
    v_new := jsonb_build_object(
      'employeeId', v_staff, 'status', 'clocked_in',
      'lastActivity', v_iso, 'clockInTime', v_iso, 'accumulatedBreakMs', 0);

  elsif p_action = 'start_break' then
    if v_status <> 'clocked_in' then
      raise exception 'not_clocked_in';
    end if;
    v_new := v_cur || jsonb_build_object(
      'status', 'on_break', 'lastActivity', v_iso, 'breakStartTime', v_iso);

  elsif p_action = 'end_break' then
    if v_status <> 'on_break' or coalesce(v_cur ->> 'breakStartTime', '') = '' then
      raise exception 'not_on_break';
    end if;
    v_acc_ms := v_acc_ms + greatest(0,
      (extract(epoch from (v_now - (v_cur ->> 'breakStartTime')::timestamptz)) * 1000)::bigint);
    v_new := (v_cur - 'breakStartTime') || jsonb_build_object(
      'status', 'clocked_in', 'lastActivity', v_iso, 'accumulatedBreakMs', v_acc_ms);

  elsif p_action = 'clock_out' then
    if v_status not in ('clocked_in', 'on_break')
       or coalesce(v_cur ->> 'clockInTime', '') = '' then
      raise exception 'not_clocked_in';
    end if;
    v_break_ms := v_acc_ms;
    if v_status = 'on_break' and coalesce(v_cur ->> 'breakStartTime', '') <> '' then
      v_break_ms := v_break_ms + greatest(0,
        (extract(epoch from (v_now - (v_cur ->> 'breakStartTime')::timestamptz)) * 1000)::bigint);
    end if;
    v_in_ts   := (v_cur ->> 'clockInTime')::timestamptz;
    v_work_ms := greatest(0,
      (extract(epoch from (v_now - v_in_ts)) * 1000)::bigint - v_break_ms);

    v_hist_id := 'clock_' || replace(gen_random_uuid()::text, '-', '');
    insert into clock_history
      (id, employee_id, employee_name, date, clock_in, clock_out,
       break_duration_minutes, total_decimal_hours, approved, rejected, notes)
    values
      (v_hist_id, v_staff, coalesce(v_name, ''),
       -- Business date: the LONDON calendar day of the clock-out, DST-correct.
       to_char(v_now at time zone 'Europe/London', 'YYYY-MM-DD'),
       v_cur ->> 'clockInTime', v_iso,
       round(v_break_ms / 60000.0)::int,
       round(v_work_ms / 3600000.0, 2),
       false, false, nullif(trim(coalesce(p_notes, '')), ''));

    v_hist := jsonb_build_object(
      'id', v_hist_id, 'employeeId', v_staff, 'employeeName', coalesce(v_name, ''),
      'date', to_char(v_now at time zone 'Europe/London', 'YYYY-MM-DD'),
      'clockIn', v_cur ->> 'clockInTime', 'clockOut', v_iso,
      'breakDurationMinutes', round(v_break_ms / 60000.0)::int,
      'totalDecimalHours', round(v_work_ms / 3600000.0, 2),
      'approved', false,
      'notes', nullif(trim(coalesce(p_notes, '')), ''));

    v_new := jsonb_build_object(
      'employeeId', v_staff, 'status', 'clocked_out', 'lastActivity', v_iso);

  else
    raise exception 'unknown_action';
  end if;

  insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
  values (v_key, v_new, 'user', v_staff, null, now())
  on conflict (key) do update
     set value = excluded.value, scope = 'user',
         owner_staff_id = excluded.owner_staff_id, updated_at = now();

  return jsonb_build_object('status', v_new, 'history', v_hist);
end $$;

revoke all on function public.sifr_reports_stamp() from public, anon, authenticated;
revoke all on function public.sifr_reports_update_guard() from public, anon, authenticated;
revoke all on function public.create_sifr_report(text,text,text,text,text,text,text) from public;
revoke all on function public.append_sifr_reply(text,text) from public;
revoke all on function public.set_sifr_status(text,text) from public;
grant execute on function public.create_sifr_report(text,text,text,text,text,text,text) to authenticated;
grant execute on function public.append_sifr_reply(text,text) to authenticated;
grant execute on function public.set_sifr_status(text,text) to authenticated;

comment on function public.create_sifr_report(text,text,text,text,text,text,text) is
  'Creates a SIFR report with server-owned id, reporter, store, business date, timestamp, status and replies.';
comment on function public.append_sifr_reply(text,text) is
  'Atomically appends one server-attributed management reply under a report row lock.';
comment on function public.set_sifr_status(text,text) is
  'Changes only the SIFR lifecycle status after manager/owner and store checks.';

commit;
