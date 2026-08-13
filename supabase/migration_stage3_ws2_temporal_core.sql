-- ============================================================================
-- STAGE 3 / WS2 — TEMPORAL TYPES FOR THE HR/OPS CORE (clock, shifts,
--                 payslips, audit trail)
-- ============================================================================
-- These columns have carried ISO-8601 / YYYY-MM-DD / HH:MM TEXT since the
-- prototype era. The SERVER already writes them correctly —
-- staff_clock_action() stores full ISO instants and derives the business
-- date DST-correctly via `at time zone 'Europe/London'` — so this migration
-- makes the TYPES tell the truth the writers already speak:
--
--   clock_history.clock_in / clock_out / approved_at  → timestamptz (UTC)
--   clock_history.date                                → date  (London business day)
--   work_shifts.start_time / end_time                 → time  (rota wall-clock)
--   work_shifts.starts_at / ends_at (NEW, GENERATED)  → timestamptz, derived
--       in Europe/London with automatic next-day rollover for overnight
--       shifts — DST-correct by construction (a 00:30–05:00 shift is 3.5
--       real hours on the spring-forward night and 5.5 on the fall-back).
--   payslips.generated_at / sent_at                   → timestamptz
--   audit_logs."timestamp"                            → timestamptz
--       (+ audit_logs_stamp() re-issued to assign now() directly)
--
-- Conversion policy (per the brief): STRICT casts only. `alter column …
-- using nullif(col,'')::<type>` REJECTS any historical value that does not
-- parse — a development database holding garbage temporal text fails the
-- migration loudly instead of silently absorbing bad history. Production
-- launches from an empty baseline. Empty strings become NULL only where the
-- column was nullable anyway.
--
-- Deliberate design decisions (documented, auditable):
--   • COLUMN NAMES ARE KEPT. The brief's preferred model (business_date,
--     clocked_in_at, clocked_out_at, starts_at, ends_at) is adopted
--     SEMANTICALLY: `date` IS the London business date, `clock_in`/`clock_out`
--     ARE the clocked-in/out instants, and starts_at/ends_at are added on
--     work_shifts. The existing names stay because they are the wire
--     contract of staff_clock_action(), claim_shift(), the fix7 publish
--     path and every client type — a rename would force a synchronised
--     breaking change across web + POS for zero semantic gain.
--   • Writers keep working UNCHANGED: text→timestamptz/date/time assignment
--     casts cover staff_clock_action()'s to_char/ISO inserts and the
--     client's toISOString()/"HH:MM" payloads; PostgREST keeps returning
--     ISO strings, so TypeScript types (`string`) are untouched.
--   • claim_shift()'s time-overlap comparison is unchanged and remains
--     valid on `time`. Its same-day overlap semantics for OVERNIGHT rota
--     rows are a WS8 lifecycle item (pre-existing, now visible).
-- Idempotent; fails closed. Appended via MP_FUTURE_MIGRATIONS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. COMPATIBILITY BRIDGE — assignment casts text → timestamptz / date.
--    Text LITERALS always cast into these columns, but text EXPRESSIONS
--    (plpgsql variables, jsonb ->> extractions — the exact shapes
--    staff_clock_action(), the grading auditor and the fix7 payslip upsert
--    write) do NOT without an assignment-context cast. These casts use the
--    types' own input functions (WITH INOUT): parsing stays STRICT — garbage
--    still errors — and applies to INSERT/UPDATE assignment only, never to
--    comparisons. This is the deliberate bridge that lets every text-era
--    server writer keep working unchanged; a later Stage-3 round may re-issue
--    those writers with explicit casts and retire the bridge.
-- ----------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_cast c
      join pg_type s on s.oid = c.castsource join pg_type t on t.oid = c.casttarget
      where s.typname = 'text' and t.typname = 'timestamptz') then
    create cast (text as timestamptz) with inout as assignment;
  end if;
  if not exists (select 1 from pg_cast c
      join pg_type s on s.oid = c.castsource join pg_type t on t.oid = c.casttarget
      where s.typname = 'text' and t.typname = 'date') then
    create cast (text as date) with inout as assignment;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. clock_history — instants + business date + range honesty
-- ----------------------------------------------------------------------------
do $$ begin
  if (select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'clock_history'
        and column_name = 'clock_in') = 'text' then
    alter table clock_history
      alter column clock_in    type timestamptz using nullif(clock_in, '')::timestamptz,
      alter column clock_out   type timestamptz using nullif(clock_out, '')::timestamptz,
      alter column approved_at type timestamptz using nullif(approved_at, '')::timestamptz,
      alter column "date"      type date        using nullif("date", '')::date;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'clock_history_out_after_in') then
    alter table clock_history add constraint clock_history_out_after_in check (
      clock_out is null or clock_out > clock_in
    );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. work_shifts — rota wall-clock times + DST-correct absolute bounds
-- ----------------------------------------------------------------------------
do $$ begin
  if (select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'work_shifts'
        and column_name = 'start_time') = 'text' then
    alter table work_shifts
      alter column start_time type time using nullif(start_time, '')::time,
      alter column end_time   type time using nullif(end_time, '')::time;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'work_shifts_times_distinct') then
    -- A zero-length shift is meaningless; equal times would otherwise roll
    -- over into a fake 24-hour shift. Overnight (end < start) is VALID.
    alter table work_shifts add constraint work_shifts_times_distinct check (
      start_time <> end_time
    );
  end if;
end $$;

alter table work_shifts
  add column if not exists starts_at timestamptz generated always as
    (timezone('Europe/London', ("date" + start_time))) stored;
alter table work_shifts
  add column if not exists ends_at timestamptz generated always as
    (timezone('Europe/London', ("date" + end_time)
       + case when end_time <= start_time then interval '1 day'
              else interval '0' end)) stored;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'work_shifts_ends_after_starts') then
    alter table work_shifts add constraint work_shifts_ends_after_starts check (
      ends_at > starts_at
    );
  end if;
end $$;

-- The generated bounds are the sanctioned reporting surface for shift
-- duration and cross-midnight queries; expose them to the browser roles the
-- table already grants.
grant select (starts_at, ends_at) on work_shifts to authenticated;

-- ----------------------------------------------------------------------------
-- 3. payslips — generation/dispatch instants
-- ----------------------------------------------------------------------------
do $$ begin
  if (select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'payslips'
        and column_name = 'generated_at') = 'text' then
    alter table payslips
      alter column generated_at drop default,
      alter column generated_at type timestamptz using nullif(generated_at, '')::timestamptz,
      alter column sent_at      type timestamptz using nullif(sent_at, '')::timestamptz;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 4. audit_logs — the trail's own clock becomes a real instant, and the
--    stamp trigger assigns now() directly (previously now()::text).
-- ----------------------------------------------------------------------------
do $$ begin
  if (select data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'audit_logs'
        and column_name = 'timestamp') = 'text' then
    alter table audit_logs
      alter column "timestamp" drop default,
      alter column "timestamp" type timestamptz using nullif("timestamp", '')::timestamptz,
      alter column "timestamp" set default now();
  end if;
end $$;

create or replace function audit_logs_stamp() returns trigger
language plpgsql as $$
declare
  v_id   text;
  v_name text;
  v_role text;
begin
  -- Byte-faithful to the Stage-11 original except the final assignment:
  -- the timestamp column is now timestamptz, so now() is assigned directly.
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;  -- server-written rows carry their own derived actor
  end if;
  v_id := current_staff_id();
  if v_id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  select name, role::text into v_name, v_role from staff_profiles where id = v_id;
  new.operator_name := coalesce(v_name, v_id);
  new.role          := coalesce(v_role, '');
  new."timestamp"   := now();
  return new;
end $$;
