-- ============================================================================
-- MILK POP — T13.3.3 ROTA OVERLAP GUARD
--
-- Normal rota writes previously upserted work_shifts directly. Cover claims
-- rejected overlaps, but an owner/manager could still create two overlapping
-- shifts for the same employee — especially from two browser tabs. This trigger
-- serialises schedule writes per employee and refuses an overlapping interval.
-- Existing historical rows are not rewritten; the guard applies to every new
-- or materially rescheduled shift.
-- ============================================================================

create or replace function prevent_work_shift_overlap()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
begin
  -- The table already requires these values, but keeping the function total
  -- makes its failure mode clear during schema upgrades.
  if new.employee_id is null or new.date is null
     or new.start_time is null or new.end_time is null then
    return new;
  end if;

  -- Two concurrent tabs scheduling the same employee must evaluate the overlap
  -- check one after the other. This lock is transaction-scoped and does not
  -- block unrelated employees.
  perform pg_advisory_xact_lock(
    hashtextextended('milkpop:work_shift:' || new.employee_id::text, 0)
  );

  v_start := timezone('Europe/London', new.date + new.start_time);
  v_end := timezone(
    'Europe/London',
    new.date + new.end_time
      + case when new.end_time <= new.start_time
             then interval '1 day' else interval '0' end
  );

  if exists (
    select 1
      from work_shifts w
     where w.employee_id = new.employee_id
       and w.id <> new.id
       and tstzrange(w.starts_at, w.ends_at, '[)')
           && tstzrange(v_start, v_end, '[)')
  ) then
    raise exception
      'shift_overlap: this employee already has a shift during the selected time'
      using errcode = '23P01';
  end if;

  return new;
end;
$$;

revoke all on function prevent_work_shift_overlap() from public, anon, authenticated;

drop trigger if exists trg_work_shifts_no_overlap on work_shifts;
create trigger trg_work_shifts_no_overlap
before insert or update of employee_id, date, start_time, end_time
on work_shifts
for each row execute function prevent_work_shift_overlap();

comment on function prevent_work_shift_overlap() is
  'T13.3.3: serialises rota writes per employee and refuses overlapping work_shifts, including overnight intervals.';

do $$
begin
  if to_regprocedure('public.prevent_work_shift_overlap()') is null then
    raise exception 't1333_shift_overlap_guard: function missing';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.work_shifts'::regclass
       and tgname = 'trg_work_shifts_no_overlap'
       and not tgisinternal
  ) then
    raise exception 't1333_shift_overlap_guard: trigger missing';
  end if;
end;
$$;
