-- ============================================================================
--  MILK POP — MIGRATION FIX-11: ATOMIC SHIFT CLAIM
--  Closes forensic-audit OPS-002.
--
--  PROBLEM: the staff portal's "claim this shift" ran THREE separate client
--  operations (insert replacement shift → delete original → rewrite the
--  shared milkpop_shift_covers JSON). Ordinary team members cannot pass the
--  manager-only work_shifts write policy, so the advertised action failed;
--  and had the policies been loosened, a partial failure could duplicate the
--  shift or leave a stale cover advert, and two simultaneous claimers could
--  both "win".
--
--  FIX: claim_shift(p_shift_id) — one SECURITY DEFINER transaction that
--  locks the shift row AND the covers document, verifies eligibility
--  (open cover, not your own shift, same store, no schedule overlap),
--  reassigns atomically and closes the advert. Two simultaneous claims
--  queue on the row lock: exactly one winner, one clean 'not_open_for_cover'.
--  Ordinary staff direct writes to work_shifts stay DENIED.
--
--  Deploy order: after migration_stage5_app_state.sql and
--  migration_rls_per_role.sql.
-- ============================================================================

create or replace function claim_shift(p_shift_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff   text := current_staff_id();
  v_me      staff_profiles%rowtype;
  v_shift   work_shifts%rowtype;
  v_covers  jsonb;
  v_new_id  text := 'shift_' || replace(gen_random_uuid()::text, '-', '');
  v_new     work_shifts%rowtype;
begin
  if v_staff is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  select * into v_me from staff_profiles where id = v_staff;

  -- Lock the covers document FIRST (stable lock order: covers → shift), then
  -- the shift row. Everything below is one serialised critical section.
  select value into v_covers
    from app_state where key = 'milkpop_shift_covers' for update;
  if v_covers is null or not (v_covers ? p_shift_id) then
    raise exception 'not_open_for_cover';
  end if;

  select * into v_shift from work_shifts where id = p_shift_id for update;
  if v_shift.id is null then
    -- Advertised but already gone: tidy the stale advert and report cleanly.
    update app_state set value = v_covers - p_shift_id, updated_at = now()
     where key = 'milkpop_shift_covers';
    raise exception 'not_open_for_cover';
  end if;

  if v_shift.employee_id = v_staff then
    raise exception 'own_shift';
  end if;
  -- Store scope: you can only cover shifts at your own store (a shift with no
  -- store set is claimable by anyone — matches the rota's behaviour).
  if v_shift.store_id is not null
     and coalesce(v_me.store_id, '') <> v_shift.store_id then
    raise exception 'wrong_store' using errcode = '42501';
  end if;
  -- Schedule overlap: HH:MM strings compare correctly as text.
  if exists (select 1 from work_shifts w
              where w.employee_id = v_staff
                and w.date = v_shift.date
                and w.start_time < v_shift.end_time
                and w.end_time   > v_shift.start_time) then
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
  update app_state set value = v_covers, updated_at = now()
   where key = 'milkpop_shift_covers';

  return jsonb_build_object(
    'newShift', to_jsonb(v_new),
    'removedShiftId', p_shift_id,
    'covers', v_covers);
end $$;

revoke all on function claim_shift(text) from public;
grant execute on function claim_shift(text) to authenticated;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE:
--   • Team member claims an open, eligible request → one new shift row
--     (their name, server id), original deleted, advert cleared — atomically.
--   • Two simultaneous claims → exactly one winner; the loser receives
--     not_open_for_cover and no rows change.
--   • Claiming your own shift / another store's shift / an overlapping slot
--     → own_shift / wrong_store / schedule_conflict, nothing written.
--   • Direct insert/delete on work_shifts as a team member still → denied.
-- ----------------------------------------------------------------------------
