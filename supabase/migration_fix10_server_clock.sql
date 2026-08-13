-- ============================================================================
--  MILK POP — MIGRATION FIX-10: SERVER-AUTHORITATIVE CLOCKING
--  Closes forensic-audit OPS-001.
--
--  PROBLEM: clock-in/out timestamps, break duration, business date and the
--  decimal-hours total were all computed in the employee's BROWSER and
--  written under policies that only checked employee_id = self. A changed
--  device clock or a crafted request produced false payroll evidence, and
--  manager approval could not prove the original numbers were real.
--
--  FIX: one RPC — staff_clock_action(action, notes) — is now the ONLY way a
--  team member's clock state changes. Every timestamp is database now();
--  the business date is the Europe/London calendar date (DST-correct); break
--  and worked totals are derived here; the clock_history row is inserted by
--  this function. Direct client writes are closed:
--    • set_app_state() now REJECTS milkpop_clock_status_* keys.
--    • clock_insert_self and clock_update_self_open are dropped — staff can
--      no longer insert or edit their own timesheet rows at all. Manager
--      approval (clock_update_mgr) is untouched.
--
--  State/JSON shapes are byte-compatible with what the client already renders
--  (ClockStatus and ClockHistoryItem), so the UI change is only "call the
--  RPC instead of computing locally".
--
--  Deploy order: after migration_stage5_app_state.sql and
--  migration_rls_per_role.sql (it redefines objects from both).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Close the direct write paths.
-- ----------------------------------------------------------------------------
drop policy if exists clock_insert_self      on clock_history;
drop policy if exists clock_update_self_open on clock_history;

-- set_app_state: same function as stage 5, with the clock branch now closed.
create or replace function set_app_state(p_key text, p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id text := current_staff_id();
  v_store    text := current_staff_store();
  v_scope    text;
  v_owner    text := null;
  v_store_id text := null;
begin
  if v_staff_id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if p_key is null or length(p_key) > 120 then
    raise exception 'invalid_key';
  end if;

  if p_key like 'milkpop_clock_status_%' then
    -- FIX-10: clock state is server-derived. The ONLY writer is
    -- staff_clock_action(); a direct client write here would let the browser
    -- forge clock-in times again.
    raise exception 'clock_keys_are_rpc_only' using errcode = '42501';
  elsif p_key in ('milkpop_checklist_tasks','milkpop_checklist_audits','milkpop_shift_covers') then
    -- STORE scope: stamped with the CALLER's store, never a client value.
    v_scope := 'store';
    v_store_id := v_store;
  elsif p_key = 'milkpop_email_settings' then
    -- GLOBAL scope: owner only.
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

  return jsonb_build_object('ok', true, 'key', p_key, 'scope', v_scope);
end $$;

revoke all on function set_app_state(text, jsonb) from public;
grant execute on function set_app_state(text, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. The clock state machine. Returns
--    { status: <ClockStatus JSON>, history: <ClockHistoryItem row or null> }.
-- ----------------------------------------------------------------------------
create or replace function staff_clock_action(p_action text, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

revoke all on function staff_clock_action(text, text) from public;
grant execute on function staff_clock_action(text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE:
--   • rpc set_app_state('milkpop_clock_status_<self>', …)  → 42501.
--   • insert into clock_history …                          → 0 rows / 403.
--   • clock_in → clock_in                                  → already_clocked_in.
--   • A crafted clockInTime cannot exist: the stored one came from now().
--   • Overnight + DST: clock in 23:50, out 00:20 next day → date is the
--     London date of the OUT; totals are duration-based, never date math.
--   • Replayed clock_out (double-tap, two tabs) → second call fails cleanly
--     with not_clocked_in; exactly one history row exists.
-- ----------------------------------------------------------------------------
