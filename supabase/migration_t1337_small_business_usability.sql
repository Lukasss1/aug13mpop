-- ============================================================================
-- Milk Pop T13.3.7 — small-business usability and operational closure
--
-- 1. Owner-controlled public sections.
-- 2. Customer-message lifecycle with compare-and-swap transitions + audit.
-- 3. Holiday allowance changes through one audited transactional RPC.
-- 4. Deduplicated owner alerts when scheduled workers fail/recover or go stale.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Public-section visibility. Safe default is OFF: a one-store launch should not
-- advertise a programme the owner is not actively operating.
-- ---------------------------------------------------------------------------
alter table public.site_settings add column if not exists show_careers boolean not null default false;
alter table public.site_settings add column if not exists show_franchise boolean not null default false;
alter table public.site_settings add column if not exists show_news boolean not null default false;

-- Existing public projection, with the three new presentation flags appended so
-- CREATE OR REPLACE preserves every pre-existing output column and its ordinal.
create or replace view public.public_site_configuration as
select
  s.id,
  coalesce(nullif(l.legal_business_name, ''), s.legal_name)    as legal_name,
  coalesce(nullif(l.company_number, ''),     s.company_number) as company_number,
  coalesce(nullif(l.registered_address, ''), s.hq_address)     as hq_address,
  coalesce(nullif(l.public_contact_email,''),s.email)          as email,
  coalesce(nullif(l.privacy_contact_email,''), s.gdpr_email)   as gdpr_email,
  coalesce(nullif(l.public_telephone, ''),   s.phone)          as phone,
  coalesce(nullif(l.canonical_url, ''),      s.website_url)    as website_url,
  s.brand_name,
  s.instagram_handle,
  s.instagram_url,
  s.facebook_url,
  s.twitter_url,
  s.footer_tagline,
  s.allergen_notice,
  s.announcement_enabled,
  s.announcement_text,
  s.currency_symbol,
  s.default_opening_hours,
  s.updated_at,
  s.show_careers,
  s.show_franchise,
  s.show_news
from public.site_settings s
left join public.launch_settings l on l.id = true
where s.id = 1;
revoke all on public.public_site_configuration from public, anon, authenticated;
grant select on public.public_site_configuration to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Customer inbox lifecycle.
-- ---------------------------------------------------------------------------
alter table public.contact_messages add column if not exists status text not null default 'new';
alter table public.contact_messages add column if not exists replied_at timestamptz;
alter table public.contact_messages add column if not exists closed_at timestamptz;

do $$ begin
  alter table public.contact_messages add constraint contact_messages_status_check
    check (status in ('new','replied','closed'));
exception when duplicate_object then null; end $$;

create or replace function public.guard_contact_message_lifecycle()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (new.status, new.replied_at, new.closed_at)
       is distinct from (old.status, old.replied_at, old.closed_at)
     and coalesce(current_setting('milkpop.contact_lifecycle_rpc', true), '') <> '1' then
    raise exception 'contact_lifecycle_rpc_required'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_contact_message_lifecycle() from public, anon, authenticated;

drop trigger if exists trg_contact_message_lifecycle_guard on public.contact_messages;
create trigger trg_contact_message_lifecycle_guard
before update of status, replied_at, closed_at on public.contact_messages
for each row execute function public.guard_contact_message_lifecycle();

create or replace function public.transition_contact_message(
  p_id text,
  p_from_status text,
  p_to_status text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.contact_messages%rowtype;
  v_actor_name text;
  v_actor_role text;
begin
  if not public.is_owner() then
    raise exception 'contact_inbox_owner_only' using errcode = 'insufficient_privilege';
  end if;
  if p_to_status not in ('new','replied','closed') or p_from_status not in ('new','replied','closed') then
    raise exception 'invalid_contact_status' using errcode = 'check_violation';
  end if;

  select * into v_row from public.contact_messages where id = p_id for update;
  if not found then raise exception 'contact_message_not_found' using errcode = 'no_data_found'; end if;
  if v_row.status <> p_from_status then
    raise exception 'contact_message_status_changed: expected %, found %', p_from_status, v_row.status
      using errcode = 'serialization_failure';
  end if;

  perform set_config('milkpop.contact_lifecycle_rpc', '1', true);
  update public.contact_messages
     set status = p_to_status,
         replied_at = case
           when p_to_status = 'replied' then coalesce(replied_at, now())
           else replied_at
         end,
         closed_at = case
           when p_to_status = 'closed' then coalesce(closed_at, now())
           when p_to_status = 'new' then null
           else closed_at
         end
   where id = p_id
   returning * into v_row;

  select name, role into v_actor_name, v_actor_role
    from public.staff_profiles where auth_id = auth.uid() limit 1;
  insert into public.audit_logs
    (id, operator_name, role, action, timestamp, module, previous_value, new_value)
  values
    ('aud_' || replace(gen_random_uuid()::text, '-', ''),
     coalesce(v_actor_name, 'owner'), coalesce(v_actor_role, 'owner'),
     'Changed customer message status', now()::text, 'Contact Inbox',
     p_from_status, p_to_status);

  return jsonb_build_object(
    'status', v_row.status,
    'repliedAt', v_row.replied_at,
    'closedAt', v_row.closed_at
  );
end;
$$;
revoke all on function public.transition_contact_message(text,text,text) from public, anon, authenticated;
grant execute on function public.transition_contact_message(text,text,text) to authenticated;

-- ---------------------------------------------------------------------------
-- Holiday allowance: guarded column + audited server transaction.
-- ---------------------------------------------------------------------------
create or replace function public.guard_holiday_allowance_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.holiday_balance is distinct from old.holiday_balance
     and coalesce(current_setting('milkpop.holiday_allowance_rpc', true), '') <> '1' then
    raise exception 'holiday_allowance_rpc_required'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_holiday_allowance_update() from public, anon, authenticated;

drop trigger if exists trg_staff_holiday_allowance_guard on public.staff_profiles;
create trigger trg_staff_holiday_allowance_guard
before update of holiday_balance on public.staff_profiles
for each row execute function public.guard_holiday_allowance_update();

create or replace function public.set_staff_holiday_allowance(
  p_employee_id text,
  p_expected_allowance numeric,
  p_allowance numeric
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target public.staff_profiles%rowtype;
  v_actor_name text;
  v_actor_role text;
begin
  if p_allowance is null or p_allowance < 0 or p_allowance > 366 then
    raise exception 'invalid_holiday_allowance' using errcode = 'check_violation';
  end if;
  select * into v_target from public.staff_profiles where id = p_employee_id for update;
  if not found then raise exception 'staff_profile_not_found' using errcode = 'no_data_found'; end if;

  if not public.is_owner() and not (
    public.is_store_manager()
    and v_target.store_id is not distinct from public.current_staff_store()
    and v_target.role in ('team_member','supervisor')
    and v_target.id <> public.current_staff_id()
  ) then
    raise exception 'holiday_allowance_not_permitted' using errcode = 'insufficient_privilege';
  end if;
  if v_target.holiday_balance is distinct from p_expected_allowance then
    raise exception 'holiday_allowance_changed: expected %, found %', p_expected_allowance, v_target.holiday_balance
      using errcode = 'serialization_failure';
  end if;

  select name, role into v_actor_name, v_actor_role
    from public.staff_profiles where auth_id = auth.uid() limit 1;
  perform set_config('milkpop.holiday_allowance_rpc', '1', true);
  update public.staff_profiles
     set holiday_balance = p_allowance
   where id = p_employee_id
   returning * into v_target;

  insert into public.audit_logs
    (id, operator_name, role, action, timestamp, module, previous_value, new_value)
  values
    ('aud_' || replace(gen_random_uuid()::text, '-', ''),
     coalesce(v_actor_name, 'manager'), coalesce(v_actor_role, 'store_manager'),
     'Set annual holiday allowance for ' || v_target.name,
     now()::text, 'Staff HR Directory', p_expected_allowance::text, p_allowance::text);

  return jsonb_build_object(
    'id', v_target.id,
    'name', v_target.name,
    'email', v_target.email,
    'role', v_target.role,
    'storeId', v_target.store_id,
    'storeName', v_target.store_name,
    'nextShift', v_target.next_shift,
    'holidayBalance', v_target.holiday_balance,
    'points', v_target.points,
    'level', v_target.level,
    'badges', v_target.badges,
    'avatar', v_target.avatar,
    'payRate', v_target.pay_rate,
    'payType', v_target.pay_type,
    'status', v_target.status,
    'onboarding', v_target.onboarding,
    'invitedAt', v_target.invited_at
  );
end;
$$;
revoke all on function public.set_staff_holiday_allowance(text,numeric,numeric) from public, anon, authenticated;
grant execute on function public.set_staff_holiday_allowance(text,numeric,numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- Owner health alerts. State transitions deduplicate notifications: one alert
-- when a worker first fails/goes stale and one recovery notice when it is OK.
-- ---------------------------------------------------------------------------
create table if not exists public.ops_alert_state (
  job_name text primary key,
  alert_state text not null check (alert_state in ('ok','failed','stale')),
  changed_at timestamptz not null default now(),
  alerted_at timestamptz
);
alter table public.ops_alert_state enable row level security;
revoke all on table public.ops_alert_state from public, anon, authenticated;
grant select on table public.ops_alert_state to authenticated;
drop policy if exists ops_alert_state_owner_read on public.ops_alert_state;
create policy ops_alert_state_owner_read on public.ops_alert_state
  for select to authenticated using (public.is_owner());

create or replace function public.record_heartbeat(p_job text, p_status text, p_detail text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new text := case when p_status = 'ok' then 'ok' else 'failed' end;
  v_old text;
begin
  if nullif(trim(p_job), '') is null then
    raise exception 'heartbeat_job_required' using errcode = 'check_violation';
  end if;
  -- Serialise the first transition too: SELECT ... FOR UPDATE cannot lock a
  -- state row that does not exist yet, so concurrent first failures would
  -- otherwise enqueue duplicate owner alerts.
  perform pg_advisory_xact_lock(hashtext(p_job));
  select alert_state into v_old from public.ops_alert_state where job_name = p_job for update;

  insert into public.ops_heartbeats (job_name, last_run_at, last_status, detail)
  values (p_job, now(), v_new, coalesce(p_detail,''))
  on conflict (job_name) do update
    set last_run_at = excluded.last_run_at,
        last_status = excluded.last_status,
        detail = excluded.detail;

  if v_old is distinct from v_new then
    insert into public.ops_alert_state(job_name, alert_state, changed_at, alerted_at)
    values (p_job, v_new, now(), now())
    on conflict (job_name) do update
      set alert_state = excluded.alert_state, changed_at = now(), alerted_at = now();

    if v_new = 'failed' then
      insert into public.notification_outbox
        (event_type, entity_type, entity_id, recipient_kind, template_id, payload)
      values
        ('ops.health.failed', 'ops_health', p_job, 'owner_notification', 'ops-health-failed',
         jsonb_build_object('job', p_job, 'status', 'failed', 'detail', left(coalesce(p_detail,''), 500)));
    elsif v_old in ('failed','stale') then
      insert into public.notification_outbox
        (event_type, entity_type, entity_id, recipient_kind, template_id, payload)
      values
        ('ops.health.recovered', 'ops_health', p_job, 'owner_notification', 'ops-health-recovered',
         jsonb_build_object('job', p_job, 'status', 'ok', 'detail', left(coalesce(p_detail,''), 500)));
    end if;
  else
    insert into public.ops_alert_state(job_name, alert_state, changed_at)
    values (p_job, v_new, now())
    on conflict (job_name) do nothing;
  end if;
end;
$$;
revoke all on function public.record_heartbeat(text,text,text) from public, anon, authenticated;

create or replace function public.check_ops_heartbeat_staleness(p_max_age interval default interval '26 hours')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hb public.ops_heartbeats%rowtype;
  v_old text;
  v_max_age interval;
  v_count integer := 0;
begin
  -- The watchdog cannot meaningfully alert while it is not running, and
  -- alerting on itself when it resumes would create a stale+recovered pair in
  -- the same transaction. Its own freshness is checked by the deployed probe.
  for v_hb in
    select * from public.ops_heartbeats where job_name <> 'ops-health-watch'
  loop
    v_max_age := case v_hb.job_name
      when 'outbox-dispatch' then interval '20 minutes'
      when 'retention-sweep' then interval '30 hours'
      else p_max_age
    end;
    if v_hb.last_run_at < now() - v_max_age then
      perform pg_advisory_xact_lock(hashtext(v_hb.job_name));
      select alert_state into v_old from public.ops_alert_state where job_name = v_hb.job_name for update;
      if v_old is distinct from 'stale' then
        insert into public.ops_alert_state(job_name, alert_state, changed_at, alerted_at)
        values (v_hb.job_name, 'stale', now(), now())
        on conflict (job_name) do update
          set alert_state='stale', changed_at=now(), alerted_at=now();
        insert into public.notification_outbox
          (event_type, entity_type, entity_id, recipient_kind, template_id, payload)
        values
          ('ops.health.stale', 'ops_health', v_hb.job_name, 'owner_notification', 'ops-health-failed',
           jsonb_build_object('job', v_hb.job_name, 'status', 'stale', 'detail', 'No heartbeat since ' || v_hb.last_run_at::text));
        v_count := v_count + 1;
      end if;
    end if;
  end loop;
  perform public.record_heartbeat('ops-health-watch', 'ok', 'stale alerts enqueued=' || v_count::text);
  return jsonb_build_object('stale_alerts_enqueued', v_count, 'checked_at', now());
exception when others then
  begin
    perform public.record_heartbeat('ops-health-watch', 'failed', left(sqlstate || ': ' || sqlerrm, 500));
  exception when others then null;
  end;
  raise;
end;
$$;
revoke all on function public.check_ops_heartbeat_staleness(interval) from public, anon, authenticated;

-- Acceptance: the operational surfaces exist and anonymous users gained no new
-- table access beyond the read-only public configuration projection.
do $acceptance$
begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='contact_messages' and column_name='status') then
    raise exception 't1337: contact status missing';
  end if;
  if to_regprocedure('public.transition_contact_message(text,text,text)') is null
     or to_regprocedure('public.set_staff_holiday_allowance(text,numeric,numeric)') is null
     or to_regprocedure('public.check_ops_heartbeat_staleness(interval)') is null then
    raise exception 't1337: required RPC missing';
  end if;
  if has_table_privilege('anon','public.contact_messages','SELECT')
     or has_table_privilege('anon','public.ops_alert_state','SELECT') then
    raise exception 't1337: private operational data leaked to anon';
  end if;
end
$acceptance$;
