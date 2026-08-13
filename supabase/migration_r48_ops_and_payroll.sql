-- ============================================================================
--  MILK POP — R4.8 LAUNCH CLOSURE 4/4: operational health & payroll boundary
--  (Workstream M monitoring · O payroll/financial boundary, daily close)
--
--  Health never reports green for absence-of-data: every signal is one of
--  healthy / warning / failed / unknown, and "unknown / not configured" is a
--  first-class state the dashboard must show as such.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Worker heartbeats — scheduled jobs prove liveness by writing here.
-- ----------------------------------------------------------------------------
create table if not exists ops_heartbeats (
  job_name    text primary key,
  last_run_at timestamptz not null default now(),
  last_status text not null default 'ok' check (last_status in ('ok','failed')),
  detail      text not null default ''
);
alter table ops_heartbeats enable row level security;
drop policy if exists heartbeats_owner_read on ops_heartbeats;
create policy heartbeats_owner_read on ops_heartbeats
  for select to authenticated using (is_owner());

create or replace function record_heartbeat(p_job text, p_status text, p_detail text)
returns void
language sql security definer
set search_path = public, pg_temp
as $$
  insert into ops_heartbeats (job_name, last_run_at, last_status, detail)
  values (p_job, now(), case when p_status='ok' then 'ok' else 'failed' end, coalesce(p_detail,''))
  on conflict (job_name) do update
    set last_run_at = excluded.last_run_at,
        last_status = excluded.last_status,
        detail      = excluded.detail;
$$;
revoke all on function record_heartbeat(text,text,text) from public, anon, authenticated;
-- service-role workers only.

-- ----------------------------------------------------------------------------
-- 2. ops_health() — owner aggregate. Uses to_regclass guards so a signal
--    whose source table is absent reports 'unknown', never a fabricated pass.
-- ----------------------------------------------------------------------------
create or replace function ops_health()
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := '[]'::jsonb;
  n bigint;
  hb ops_heartbeats;
begin
  if not is_owner() then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;

  -- Notification outbox
  select count(*) into n from notification_outbox where status in ('pending','retry','processing');
  v := v || jsonb_build_object('key','outbox_pending','value',n,
        'state', case when n = 0 then 'healthy' when n < 25 then 'warning' else 'failed' end);
  select count(*) into n from notification_outbox where status in ('dead_letter','blocked_config');
  v := v || jsonb_build_object('key','outbox_dead_or_blocked','value',n,
        'state', case when n = 0 then 'healthy' else 'failed' end);

  -- Unresolved till payments (recovery backlog). Table names guarded.
  if to_regclass('public.pos_payment_recovery') is not null then
    execute 'select count(*) from pos_payment_recovery where resolved_at is null' into n;
    v := v || jsonb_build_object('key','payment_recovery_backlog','value',n,
          'state', case when n = 0 then 'healthy' else 'warning' end);
  elsif to_regclass('public.payment_recovery_records') is not null then
    execute 'select count(*) from payment_recovery_records where resolved_at is null' into n;
    v := v || jsonb_build_object('key','payment_recovery_backlog','value',n,
          'state', case when n = 0 then 'healthy' else 'warning' end);
  else
    v := v || jsonb_build_object('key','payment_recovery_backlog','value',null,'state','unknown');
  end if;

  -- Reserved quotes older than expected (30 min), if the quotes table exists.
  if to_regclass('public.pos_quotes') is not null then
    execute $q$select count(*) from pos_quotes
               where status = 'reserved' and created_at < now() - interval '30 minutes'$q$ into n;
    v := v || jsonb_build_object('key','stale_reserved_quotes','value',n,
          'state', case when n = 0 then 'healthy' else 'warning' end);
  else
    v := v || jsonb_build_object('key','stale_reserved_quotes','value',null,'state','unknown');
  end if;

  -- Disabled-user access attempts (last 24 h), from the server audit if present.
  if to_regclass('public.server_audit_events') is not null then
    execute $q$select count(*) from server_audit_events
               where event = 'disabled_user_attempt' and created_at > now() - interval '24 hours'$q$ into n;
    v := v || jsonb_build_object('key','disabled_access_attempts_24h','value',n,
          'state', case when n = 0 then 'healthy' else 'warning' end);
  else
    v := v || jsonb_build_object('key','disabled_access_attempts_24h','value',null,'state','unknown');
  end if;

  -- Scheduled-job heartbeats: outbox dispatcher, retention sweep, media cleanup,
  -- employment sweep. Missing row ⇒ unknown/not-configured, stale ⇒ failed.
  for hb in select * from ops_heartbeats loop
    v := v || jsonb_build_object('key','job:'||hb.job_name,
          'value', hb.last_run_at,
          'state', case when hb.last_status='failed' then 'failed'
                        when hb.last_run_at < now() - interval '26 hours' then 'failed'
                        else 'healthy' end);
  end loop;
  if not exists (select 1 from ops_heartbeats where job_name='outbox-dispatch') then
    v := v || jsonb_build_object('key','job:outbox-dispatch','value',null,'state','unknown');
  end if;
  if not exists (select 1 from ops_heartbeats where job_name='retention-sweep') then
    v := v || jsonb_build_object('key','job:retention-sweep','value',null,'state','unknown');
  end if;

  -- Native till integration: external channel, honest states only.
  if to_regclass('public.pos_devices') is not null then
    execute 'select count(*) from pos_devices where revoked_at is null' into n;
    v := v || jsonb_build_object('key','native_till_devices','value',n,
          'state', case when n = 0 then 'unknown' else 'healthy' end,
          'note', case when n = 0 then 'not_commissioned' else 'paired' end);
  end if;

  return jsonb_build_object('ok', true, 'generated_at', now(), 'signals', v);
end $$;
revoke all on function ops_health() from public, anon;
grant execute on function ops_health() to authenticated;

-- ----------------------------------------------------------------------------
-- 3. PAYROLL BOUNDARY (O) — internal figures are ESTIMATES until an official
--    provider result is attached. The historic `payslips` table name is kept
--    (renaming a synced table would break the wire contract) but every row is
--    typed, and the UI language derives from the type.
-- ----------------------------------------------------------------------------
alter table payslips add column if not exists kind text not null default 'estimate'
  check (kind in ('estimate','official_reference'));
alter table payslips add column if not exists provider_run_ref text;
alter table payslips add column if not exists official_document_id text;
alter table payslips add column if not exists payment_status text not null default 'not_recorded'
  check (payment_status in ('not_recorded','exported','paid_confirmed'));

create table if not exists payroll_export_batches (
  id            text primary key default gen_random_uuid()::text,
  period_key    text not null,
  provider_name text not null default '',
  employee_count int not null default 0,
  approved_hours_total numeric(10,2) not null default 0,
  status        text not null default 'draft' check (status in
                  ('draft','exported','provider_confirmed','superseded')),
  exported_at   timestamptz,
  exported_by_staff_id text references staff_profiles(id),
  provider_run_ref text,
  notes         text not null default '',
  created_at    timestamptz not null default now()
);
alter table payroll_export_batches enable row level security;
drop policy if exists payroll_batches_owner on payroll_export_batches;
create policy payroll_batches_owner on payroll_export_batches
  for all to authenticated using (is_owner()) with check (is_owner());

-- ----------------------------------------------------------------------------
-- 4. DAILY CLOSE — append-only reconciliation. A posted close is immutable;
--    corrections are new rows referencing the original.
-- ----------------------------------------------------------------------------
create table if not exists daily_closes (
  id             text primary key default gen_random_uuid()::text,
  store_id       text not null,
  business_date  date not null,
  gross_sales    numeric(12,2) not null default 0,
  discounts      numeric(12,2) not null default 0,
  refunds        numeric(12,2) not null default 0,
  net_sales      numeric(12,2) not null default 0,
  cash_expected  numeric(12,2) not null default 0,
  cash_counted   numeric(12,2) not null default 0,
  cash_variance  numeric(12,2) generated always as (cash_counted - cash_expected) stored,
  card_total     numeric(12,2) not null default 0,
  card_settlement_ref text not null default '',
  paid_outs      numeric(12,2) not null default 0,
  closed_by_staff_id  text references staff_profiles(id),
  approved_by_staff_id text references staff_profiles(id),
  closed_at      timestamptz not null default now(),
  corrects_close_id text references daily_closes(id),
  correction_reason text
);
create unique index if not exists idx_daily_close_once
  on daily_closes (store_id, business_date) where corrects_close_id is null;
alter table daily_closes enable row level security;
drop policy if exists daily_close_read on daily_closes;
create policy daily_close_read on daily_closes
  for select to authenticated
  using (is_owner() or (is_manager_or_owner() and store_id = current_staff_store()));
drop policy if exists daily_close_insert on daily_closes;
create policy daily_close_insert on daily_closes
  for insert to authenticated
  with check (is_manager_or_owner()
              and (is_owner() or store_id = current_staff_store())
              and closed_by_staff_id = current_staff_id());
-- No update/delete policies AT ALL: closes are append-only by construction —
-- a correction is a new row with corrects_close_id + correction_reason set.

comment on table daily_closes is
  'R4.8 O: daily reconciliation. Posted closes are immutable (no update/delete policy); corrections append with an audited reason and reference.';
comment on column payslips.kind is
  'R4.8 O: estimate until an official provider result is attached; the UI must present estimates as "Earnings estimate", never as a statutory payslip.';
