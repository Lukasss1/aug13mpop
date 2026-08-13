-- ============================================================================
--  MILK POP — MIGRATION: timesheet approvals, payslips, CV storage
--  Run this ONCE in the Supabase SQL Editor on an EXISTING project.
--  It only ADDS things — none of your current data is touched.
--  (Fresh projects don't need this: the updated schema.sql includes it all.)
-- ============================================================================

-- 1. Timesheets — every clock-out becomes a Pending row awaiting approval
create table if not exists clock_history (
  id                     text primary key,
  employee_id            text,
  employee_name          text not null default '',
  date                   text not null,
  clock_in               text not null,
  clock_out              text,
  break_duration_minutes int default 0,
  total_decimal_hours    numeric(7,2) default 0,
  approved               boolean default false,
  rejected               boolean default false,
  approved_by            text,
  approved_at            text,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists idx_clock_history_emp on clock_history (employee_id);
create index if not exists idx_clock_history_date on clock_history (date);
drop trigger if exists trg_clock_history_updated on clock_history;
create trigger trg_clock_history_updated before update on clock_history
  for each row execute function set_updated_at();

-- 2. Payslips — generated per employee per month from APPROVED hours
create table if not exists payslips (
  id            text primary key,
  employee_id   text,
  employee_name text not null default '',
  email         text not null default '',
  period_key    text not null,
  period_label  text not null default '',
  hours_total   numeric(8,2) not null default 0,
  hourly_rate   numeric(10,2) not null default 0,
  gross         numeric(10,2) not null default 0,
  deductions    numeric(10,2) not null default 0,
  net           numeric(10,2) not null default 0,
  status        text not null default 'draft' check (status in ('draft','sent')),
  generated_at  text not null default '',
  generated_by  text not null default '',
  sent_at       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_payslips_emp on payslips (employee_id);
create index if not exists idx_payslips_period on payslips (period_key);
drop trigger if exists trg_payslips_updated on payslips;
create trigger trg_payslips_updated before update on payslips
  for each row execute function set_updated_at();

-- 3. CV attachment columns on job applications
alter table job_applications add column if not exists cv_url  text default '';
alter table job_applications add column if not exists cv_data text default '';

-- 4. Relax the hard unique-email constraint on staff.
--    Uniqueness is now validated in the Admin Panel form. A DB-level conflict
--    would fail an ENTIRE bulk upsert batch and silently lose every row in
--    that sync push — one of the reasons new staff were not saving.
alter table staff_profiles drop constraint if exists staff_profiles_email_key;

-- 5. Row level security for the new tables.
-- SECURITY (edited during the lockdown): this step used to create the same
-- wide-open demo_full_access policy as the rest of the old schema. It now
-- enables RLS and adds NO policies — timesheets and payslips are private,
-- deny-by-default. Run migration_security_lockdown.sql for the full cleanup.
do $$
declare t text;
begin
  foreach t in array array['clock_history','payslips'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists demo_full_access on %I', t);
  end loop;
end $$;

-- 6. Storage bucket for CV uploads.
-- SECURITY (re-edited, Phase 1 review): the bucket is PRIVATE and FAIL-CLOSED.
-- No read policy and no insert policy exist for any client role — anonymous
-- CV upload stays disabled until the Phase 5 controls ship (see
-- the security notes in README.md). Do not recreate an upload policy here.
insert into storage.buckets (id, name, public)
values ('cvs', 'cvs', false)
on conflict (id) do update set public = false;

drop policy if exists "cvs_public_upload" on storage.objects;
drop policy if exists "cvs_public_read" on storage.objects;
drop policy if exists "cvs_candidate_upload" on storage.objects;

-- 7. If clock history was previously synced into the app_state KV table,
--    it now lives in its own clock_history table; remove the stale KV copy.
delete from app_state where key = 'milkpop_clock_history';

-- ============================================================================
--  GRAND-OPENING PATCH (safe to run on any existing project — additive only)
-- ============================================================================

-- 8a. The app's bulk sync sends an explicit NULL for any optional field that
--     one row in a batch has and another doesn't. NOT NULL constraints on
--     such columns would reject the ENTIRE batch, silently losing changes.
--     Relax them (defaults still apply when the column is simply omitted):
alter table if exists clock_history    alter column break_duration_minutes drop not null;
alter table if exists clock_history    alter column total_decimal_hours    drop not null;
alter table if exists clock_history    alter column approved                drop not null;
alter table if exists clock_history    alter column rejected                drop not null;
alter table if exists job_applications alter column cv_url                  drop not null;
alter table if exists job_applications alter column cv_data                 drop not null;
alter table if exists sifr_reports     alter column replies                 drop not null;
alter table if exists kb_articles      alter column steps                   drop not null;

-- 8b. Staff documents now belong to a person (the staff portal shows each
--     employee only their own files; legacy rows without an owner stay
--     visible to everyone as before):
alter table staff_documents add column if not exists employee_id   text;
alter table staff_documents add column if not exists employee_name text;
