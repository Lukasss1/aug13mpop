-- ============================================================================
-- Milk Pop T13.3.11 — public-form integrity and exact vacancy binding
--
-- Forward-only closure for opening-day public forms:
--   * careers submissions must include the exact published vacancy id/title
--     pair and a non-empty availability statement;
--   * the chosen vacancy id is retained on the application row;
--   * franchise submissions must include country, city, budget and experience;
--   * exact idempotent replays remain valid even if the vacancy later closes;
--   * browser roles cannot call either the validator or submission gates.
-- ============================================================================

alter table public.job_applications
  add column if not exists vacancy_id text;

-- Keep old applications valid. New public submissions are required to bind a
-- vacancy through the guarded wrapper below.
do $fk$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.job_applications'::regclass
       and conname = 'job_applications_vacancy_id_fk'
  ) then
    alter table public.job_applications
      add constraint job_applications_vacancy_id_fk
      foreign key (vacancy_id) references public.job_vacancies(id)
      on update cascade on delete set null;
  end if;
end $fk$;

create index if not exists job_applications_vacancy_id_idx
  on public.job_applications(vacancy_id)
  where vacancy_id is not null;

comment on column public.job_applications.vacancy_id is
  'T13.3.11: exact published vacancy selected at public submission time. Legacy applications may be null.';

create or replace function public.assert_current_public_form_payload(
  p_kind text,
  p_row jsonb,
  p_idempotency_key uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing boolean := false;
  v_vacancy_id text;
  v_title text;
begin
  if p_kind not in ('careers', 'franchise', 'contact') then
    raise exception 'form_kind_unknown: %', p_kind using errcode = 'check_violation';
  end if;

  -- Preserve retry semantics. If this key already belongs to any committed row,
  -- the core is the authority on same-hash duplicate versus hash conflict. A
  -- later vacancy closure must not turn a successful retry into a new refusal.
  if p_idempotency_key is not null then
    if p_kind = 'careers' then
      select exists(select 1 from public.job_applications where idempotency_key = p_idempotency_key)
        into v_existing;
    elsif p_kind = 'franchise' then
      select exists(select 1 from public.franchise_inquiries where idempotency_key = p_idempotency_key)
        into v_existing;
    else
      select exists(select 1 from public.contact_messages where idempotency_key = p_idempotency_key)
        into v_existing;
    end if;
    if v_existing then
      return;
    end if;
  end if;

  -- The optional programme must remain published through commit. Lock the
  -- singleton setting row so an owner cannot disable Careers/Franchise in the
  -- gap between the Edge check and the guarded insert.
  if p_kind = 'careers' then
    perform 1 from public.site_settings where id = 1 and show_careers is true for share;
    if not found then
      raise exception 'section_closed' using errcode = 'check_violation';
    end if;
  elsif p_kind = 'franchise' then
    perform 1 from public.site_settings where id = 1 and show_franchise is true for share;
    if not found then
      raise exception 'section_closed' using errcode = 'check_violation';
    end if;
  end if;

  if p_kind = 'careers' then
    v_vacancy_id := nullif(trim(p_row->>'vacancy_id'), '');
    v_title := nullif(trim(p_row->>'applied_for'), '');
    if v_vacancy_id is null or v_title is null
       or nullif(trim(p_row->>'availability'), '') is null
       or nullif(trim(p_row->>'phone'), '') is null then
      raise exception 'missing_required_field' using errcode = 'check_violation';
    end if;
    if (p_row->>'phone') !~ '^[+0-9(][0-9 ()-]{6,49}$'
       or length(regexp_replace(p_row->>'phone', '[^0-9]', '', 'g')) not between 7 and 15 then
      raise exception 'invalid_phone' using errcode = 'check_violation';
    end if;
    -- Lock the published vacancy through commit. A concurrent close, title
    -- edit or delete must wait, so the application cannot pass validation and
    -- then be inserted against a role that changed in the same transaction.
    perform 1
      from public.job_vacancies
     where id = v_vacancy_id
       and title = v_title
       and status = 'published'
     for share;
    if not found then
      raise exception 'vacancy_not_open' using errcode = 'check_violation';
    end if;
  elsif p_kind = 'franchise' then
    if nullif(trim(p_row->>'country'), '') is null
       or nullif(trim(p_row->>'city'), '') is null
       or nullif(trim(p_row->>'budget'), '') is null
       or nullif(trim(p_row->>'experience'), '') is null then
      raise exception 'missing_required_field' using errcode = 'check_violation';
    end if;
    if nullif(trim(p_row->>'phone'), '') is not null
       and ((p_row->>'phone') !~ '^[+0-9(][0-9 ()-]{6,49}$'
         or length(regexp_replace(p_row->>'phone', '[^0-9]', '', 'g')) not between 7 and 15) then
      raise exception 'invalid_phone' using errcode = 'check_violation';
    end if;
  end if;
end;
$$;

revoke all on function public.assert_current_public_form_payload(text, jsonb, uuid)
  from public, anon, authenticated;
-- This helper is called only inside the SECURITY DEFINER wrapper. Keep it
-- unavailable as a direct API surface, including to service_role.
revoke all on function public.assert_current_public_form_payload(text, jsonb, uuid)
  from service_role;

comment on function public.assert_current_public_form_payload(text, jsonb, uuid) is
  'T13.3.11: internal SECURITY DEFINER current-state validator. Exact committed retries bypass dynamic publication checks and are resolved by submit_public_form_core.';

-- Replace only the public seven-argument wrapper. The historical atomic core
-- remains untouched and retains idempotency/rate/insert semantics.
create or replace function public.submit_public_form(
  p_kind text,
  p_row jsonb,
  p_idempotency_key uuid,
  p_request_hash text,
  p_ip_hash text,
  p_notice_id text,
  p_notice_sha256 text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_audience text;
  v_current  privacy_notice_current%rowtype;
  v_result   jsonb;
begin
  v_audience := case p_kind
    when 'contact'   then 'contact'
    when 'careers'   then 'careers'
    when 'franchise' then 'franchise'
    else null end;
  if v_audience is null then
    raise exception 'form_kind_unknown: %', p_kind using errcode = 'check_violation';
  end if;

  select * into v_current from privacy_notice_current where audience = v_audience;
  if not found then
    raise exception
      'form_notice_missing: no published % privacy notice exists — the form is closed',
      v_audience using errcode = 'check_violation';
  end if;
  if p_notice_id is null or p_notice_sha256 is null
     or p_notice_id <> v_current.id or p_notice_sha256 <> v_current.content_sha256 then
    raise exception
      'notice_version_changed: the % privacy notice changed since this form was displayed',
      v_audience using errcode = 'check_violation';
  end if;

  perform public.assert_current_public_form_payload(p_kind, p_row, p_idempotency_key);

  v_result := submit_public_form_core(
    p_kind, p_row, p_idempotency_key, p_request_hash, p_ip_hash
  );

  if (v_result->>'ok') = 'true'
     and coalesce(v_result->>'duplicate', 'false') <> 'true' then
    if p_kind = 'careers' then
      update public.job_applications
         set notice_id = v_current.id,
             notice_sha256 = v_current.content_sha256,
             vacancy_id = nullif(trim(p_row->>'vacancy_id'), '')
       where id = (v_result->>'submission_id');
    elsif p_kind = 'franchise' then
      update public.franchise_inquiries
         set notice_id = v_current.id,
             notice_sha256 = v_current.content_sha256
       where id = (v_result->>'submission_id');
    else
      update public.contact_messages
         set notice_id = v_current.id,
             notice_sha256 = v_current.content_sha256
       where id = (v_result->>'submission_id');
    end if;
  end if;
  return v_result;
end;
$$;

revoke all on function public.submit_public_form(text, jsonb, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_public_form(text, jsonb, uuid, text, text, text, text)
  to service_role;

-- The Edge Function resolves committed idempotency keys before consuming a
-- single-use CAPTCHA token. Bind that existing RPC to the same explicit
-- server-only role instead of relying on project-level default privileges.
revoke all on function public.resolve_public_submission(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.resolve_public_submission(text, uuid, text)
  to service_role;

comment on function public.submit_public_form(text, jsonb, uuid, text, text, text, text) is
  'T13.3.11: privacy-evidence gate plus current public-form payload validation. Careers bind the exact still-published vacancy before the atomic core inserts.';

-- Retain only the operationally useful abuse-control window. The Edge Function
-- rate limit reads one hour; 30 days gives the owner enough evidence to inspect
-- repeated abuse without keeping pseudonymous network identifiers forever.
create index if not exists form_submission_log_created_at_idx
  on public.form_submission_log(created_at);

do $retention_entity$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.retention_runs'::regclass
       and conname = 'retention_runs_entity_ck'
  ) then
    alter table public.retention_runs drop constraint retention_runs_entity_ck;
  end if;
  alter table public.retention_runs
    add constraint retention_runs_entity_ck check (
      entity in (
        'contact_messages', 'franchise_inquiries', 'job_applications',
        'cv_orphans', 'cv_links', 'form_submission_log'
      )
    );
end $retention_entity$;

create or replace function public.retention_purge_form_submission_log(
  retain interval default interval '30 days'
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cutoff timestamptz := now() - retain;
  v_deleted integer := 0;
begin
  if retain is null or retain < interval '24 hours' then
    raise exception 'form_submission_log retention must be at least 24 hours'
      using errcode = 'invalid_parameter_value';
  end if;
  delete from public.form_submission_log where created_at < v_cutoff;
  get diagnostics v_deleted = row_count;
  insert into public.retention_runs(entity, cutoff, rows_deleted)
  values ('form_submission_log', v_cutoff, v_deleted);
  return v_deleted;
end;
$$;

revoke all on function public.retention_purge_form_submission_log(interval)
  from public, anon, authenticated, service_role;

comment on function public.retention_purge_form_submission_log(interval) is
  'T13.3.11: internal daily purge for pseudonymous public-form rate-limit evidence; default retention 30 days.';

-- Preserve the existing scheduled signature and failure-heartbeat contract.
-- No new cron job or operator setting is required.
create or replace function public.run_retention_sweep(
  p_contact_retain      interval default interval '24 months',
  p_franchise_retain    interval default interval '24 months',
  p_applications_retain interval default interval '6 months',
  p_orphan_grace        interval default interval '48 hours'
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contact   integer;
  v_franchise integer;
  v_apps      jsonb;
  v_orphans   integer;
  v_form_log  integer;
  v_result    jsonb;
begin
  v_contact   := retention_purge_contact_messages(p_contact_retain);
  v_franchise := retention_purge_franchise_inquiries(p_franchise_retain);
  v_apps      := retention_purge_job_applications(p_applications_retain);
  v_orphans   := retention_enqueue_orphan_cvs(p_orphan_grace);
  v_form_log  := retention_purge_form_submission_log(interval '30 days');
  v_result := jsonb_build_object(
    'ok',                         true,
    'contactMessagesDeleted',    v_contact,
    'franchiseInquiriesDeleted', v_franchise,
    'jobApplications',           v_apps,
    'orphanCvJobsEnqueued',      v_orphans,
    'formSubmissionLogDeleted',  v_form_log
  );
  perform record_heartbeat('retention-sweep', 'ok', left(v_result::text, 500));
  return v_result;
exception when others then
  begin
    perform record_heartbeat('retention-sweep', 'failed', left(sqlstate || ': ' || sqlerrm, 500));
  exception when others then
    null;
  end;
  return jsonb_build_object(
    'ok', false,
    'errorCode', sqlstate,
    'error', left(sqlerrm, 300)
  );
end;
$$;

revoke all on function public.run_retention_sweep(interval, interval, interval, interval)
  from public, anon, authenticated, service_role;

comment on function public.run_retention_sweep(interval, interval, interval, interval) is
  'T13.3.11: scheduled retention entry point including 30-day public-form rate-limit evidence cleanup; persists ok/failed heartbeat.';

-- Acceptance: structural facts that are safe to prove during every migration.
do $acceptance$
declare
  v_src text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'job_applications'
       and column_name = 'vacancy_id'
  ) then
    raise exception 't13311: job_applications.vacancy_id is absent';
  end if;
  if to_regprocedure('public.assert_current_public_form_payload(text,jsonb,uuid)') is null then
    raise exception 't13311: current payload validator is absent';
  end if;
  if to_regprocedure('public.submit_public_form(text,jsonb,uuid,text,text,text,text)') is null then
    raise exception 't13311: seven-argument form gate is absent';
  end if;
  select p.prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'submit_public_form'
     and pg_get_function_identity_arguments(p.oid) =
       'p_kind text, p_row jsonb, p_idempotency_key uuid, p_request_hash text, p_ip_hash text, p_notice_id text, p_notice_sha256 text';
  if position('assert_current_public_form_payload' in coalesce(v_src, '')) = 0 then
    raise exception 't13311: form gate does not invoke the current payload validator';
  end if;
  if has_function_privilege('anon', 'public.assert_current_public_form_payload(text,jsonb,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.assert_current_public_form_payload(text,jsonb,uuid)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.assert_current_public_form_payload(text,jsonb,uuid)', 'EXECUTE') then
    raise exception 't13311: current payload validator is exposed as a direct API';
  end if;
  if not has_function_privilege('service_role', 'public.submit_public_form(text,jsonb,uuid,text,text,text,text)', 'EXECUTE') then
    raise exception 't13311: service_role cannot execute the guarded submission wrapper';
  end if;
  if not has_function_privilege('service_role', 'public.resolve_public_submission(text,uuid,text)', 'EXECUTE') then
    raise exception 't13311: service_role cannot resolve form idempotency';
  end if;
  if to_regprocedure('public.retention_purge_form_submission_log(interval)') is null then
    raise exception 't13311: form submission log retention helper is absent';
  end if;
  if has_function_privilege('anon', 'public.retention_purge_form_submission_log(interval)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.retention_purge_form_submission_log(interval)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.retention_purge_form_submission_log(interval)', 'EXECUTE') then
    raise exception 't13311: form submission log retention helper is exposed';
  end if;
end $acceptance$;
