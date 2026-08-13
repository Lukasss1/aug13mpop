-- ============================================================================
-- Milk Pop T13.3.6 — scheduler failure heartbeats that survive the function call
--
-- PostgreSQL rolls back every write made by a function when that function
-- rethrows. The previous retention wrapper therefore could not preserve its
-- own `failed` heartbeat. Scheduled jobs now return an explicit failure result
-- after recording the heartbeat; the production acceptance probe treats that
-- heartbeat as a release blocker. Employment expiry receives the same liveness
-- contract.
-- ============================================================================

create or replace function public.run_retention_sweep(
  p_contact_retain      interval default interval '24 months',
  p_franchise_retain    interval default interval '24 months',
  p_applications_retain interval default interval '6 months',
  p_orphan_grace        interval default interval '48 hours'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_contact   integer;
  v_franchise integer;
  v_apps      jsonb;
  v_orphans   integer;
  v_result    jsonb;
begin
  v_contact   := retention_purge_contact_messages(p_contact_retain);
  v_franchise := retention_purge_franchise_inquiries(p_franchise_retain);
  v_apps      := retention_purge_job_applications(p_applications_retain);
  v_orphans   := retention_enqueue_orphan_cvs(p_orphan_grace);
  v_result := jsonb_build_object(
    'ok',                         true,
    'contactMessagesDeleted',    v_contact,
    'franchiseInquiriesDeleted', v_franchise,
    'jobApplications',           v_apps,
    'orphanCvJobsEnqueued',      v_orphans
  );
  perform record_heartbeat('retention-sweep', 'ok', left(v_result::text, 500));
  return v_result;
exception when others then
  begin
    perform record_heartbeat('retention-sweep', 'failed', left(sqlstate || ': ' || sqlerrm, 500));
  exception when others then
    null;
  end;
  -- Do not rethrow: that would roll back the failed heartbeat. Cron liveness
  -- and release acceptance fail closed on last_status='failed'.
  return jsonb_build_object(
    'ok', false,
    'errorCode', sqlstate,
    'error', left(sqlerrm, 300)
  );
end;
$$;

create or replace function public.employment_sweep_due()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_disabled integer := 0;
begin
  update staff_profiles
     set status = 'disabled', ended_at = now(), updated_at = now()
   where employment_end_date is not null
     and employment_end_date <= current_date
     and coalesce(status, 'active') <> 'disabled';
  get diagnostics v_disabled = row_count;
  perform record_heartbeat(
    'employment-sweep',
    'ok',
    'disabled=' || v_disabled::text
  );
  return v_disabled;
exception when others then
  begin
    perform record_heartbeat('employment-sweep', 'failed', left(sqlstate || ': ' || sqlerrm, 500));
  exception when others then
    null;
  end;
  return -1;
end;
$$;

revoke all on function public.run_retention_sweep(interval, interval, interval, interval)
  from public, anon, authenticated;
revoke all on function public.employment_sweep_due()
  from public, anon, authenticated;

comment on function public.run_retention_sweep(interval, interval, interval, interval) is
  'T13.3.6: scheduled retention entry point. Returns {ok:false} instead of '
  'rethrowing so a failed heartbeat commits and blocks production acceptance.';
comment on function public.employment_sweep_due() is
  'T13.3.6: scheduled employment expiry. Returns -1 on failure after persisting '
  'an employment-sweep failed heartbeat; never browser-callable.';
