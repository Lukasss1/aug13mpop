-- ============================================================================
-- Milk Pop T13.3.6 — retention scheduler liveness
--
-- run_retention_sweep() was the documented daily retention entry point, but it
-- did not write the ops_heartbeats row that ops_health() uses to distinguish a
-- working schedule from an uncommissioned one. Preserve the existing retention
-- work and add crash-visible success/failure heartbeats.
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
    null; -- never hide the original retention failure behind heartbeat failure
  end;
  raise;
end;
$$;

revoke all on function public.run_retention_sweep(interval, interval, interval, interval)
  from public, anon, authenticated;

comment on function public.run_retention_sweep(interval, interval, interval, interval) is
  'T13.3.6: scheduled retention entry point; purges configured records, queues '
  'confirmed object deletion work and records an ok/failed retention-sweep heartbeat.';
