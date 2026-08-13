-- ============================================================================
--  MILK POP — INC11 : APPLICATION TRANSITIONS — ONE SANCTIONED VEHICLE
--
--  THE PROBLEM (from the public-test plan). Candidacy status changes were a
--  bare column-granted PATCH: no compare-and-swap (two staff screens move the
--  same candidate and the second silently overwrites the first), no
--  server-side audit, and the candidate-facing consequence (offer/decline
--  mail) lived nowhere — a status could change with no record and no message.
--
--  THE MODEL.
--    • transition_application(id, from, to) is the ONLY way an API role
--      changes job_applications.status. It locks the row, verifies the
--      caller's authority with the SAME store-scoped MFA-aware predicate as
--      the RLS policy, compare-and-swaps the status (the expected FROM value
--      is the row's optimistic version), writes the audit row, and — for the
--      two candidate-visible outcomes (offer, declined) — enqueues the
--      notification in the SAME transaction, using the existing outbox
--      (recipient resolved server-side at dispatch; gated by the same
--      customer_ack_enabled posture as every candidate-facing mail).
--    • A guard trigger closes the old direct path for status changes only:
--      non-status columns (cv_path from the upload function, evidence
--      columns) are untouched, INSERTs (the public-form core) are untouched.
--    • Statuses stay the shipped five: pending, reviewing, interview,
--      offer, declined — now also CHECK-constrained in the database.
--
--  APPEND-ONLY: no previously applied migration file is edited.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The status vocabulary becomes database truth.
-- ----------------------------------------------------------------------------
do $status_check$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'job_applications_status_check') then
    alter table job_applications
      add constraint job_applications_status_check
      check (status in ('pending', 'reviewing', 'interview', 'offer', 'declined'));
  end if;
end $status_check$;

-- ----------------------------------------------------------------------------
-- 2. Guard: status changes happen ONLY inside the transition RPC.
--    (Superuser exempt for seed/harness; every other column update — the
--    cv-upload function's cv_path stamp, evidence columns — passes through.)
-- ----------------------------------------------------------------------------
create or replace function assert_application_transition_sanctioned()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    if current_setting('is_superuser') = 'on' then return new; end if;
    if current_setting('milkpop.application_rpc', true) = '1' then return new; end if;
    raise exception
      'application_transition_refused: candidacy status changes go through transition_application, which locks the row, verifies the expected status and records the audit + candidate notification in one transaction'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_application_transition_guard on job_applications;
create trigger trg_application_transition_guard
  before update on job_applications
  for each row execute function assert_application_transition_sanctioned();

-- ----------------------------------------------------------------------------
-- 3. The transition itself.
-- ----------------------------------------------------------------------------
create or replace function transition_application(
  p_id text,
  p_from_status text,
  p_to_status text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row job_applications%rowtype;
  v_actor_name text;
  v_actor_role text;
  v_ack boolean;
begin
  if p_to_status not in ('pending', 'reviewing', 'interview', 'offer', 'declined') then
    raise exception 'application_bad_status: % is not a candidacy status', p_to_status
      using errcode = 'check_violation';
  end if;
  if p_from_status = p_to_status then
    raise exception 'application_transition_noop: the application is already %', p_to_status
      using errcode = 'check_violation';
  end if;

  select * into v_row from job_applications where id = p_id for update;
  if not found then
    raise exception 'application_not_found: %', p_id using errcode = 'no_data_found';
  end if;

  -- Authority: the SAME predicate as the RLS update policy (owner, or an
  -- MFA-verified store manager whose store the application names).
  if not (is_owner() or (is_store_manager() and v_row.applied_store <> ''
          and v_row.applied_store = (select s.name from stores s
                                       where s.id = current_staff_store()))) then
    raise exception
      'application_forbidden: candidacy transitions require the owner or the named store''s manager (two-step verified)'
      using errcode = 'insufficient_privilege';
  end if;

  -- Compare-and-swap: the expected FROM status is the optimistic version.
  if v_row.status <> p_from_status then
    raise exception
      'application_status_stale: the application is now % (you expected %) — refresh, review, decide again',
      v_row.status, p_from_status
      using errcode = 'check_violation';
  end if;

  select name, role into v_actor_name, v_actor_role
    from staff_profiles where auth_id = auth.uid() limit 1;

  perform set_config('milkpop.application_rpc', '1', true);
  update job_applications
     set status = p_to_status, updated_at = now()
   where id = p_id;

  insert into audit_logs (id, operator_name, role, action, module, new_value)
  values ('aud_' || replace(gen_random_uuid()::text, '-', ''),
          coalesce(v_actor_name, 'staff'), coalesce(v_actor_role, 'staff'),
          'Moved application ' || p_id || ' from ' || p_from_status || ' to ' || p_to_status,
          'Careers Desk',
          jsonb_build_object('application_id', p_id,
                             'from', p_from_status, 'to', p_to_status));

  -- Candidate-visible outcomes notify IN THIS TRANSACTION — the same outbox,
  -- posture gate and server-side recipient resolution as every other
  -- candidate-facing mail (dispatch reads the address from the application
  -- row itself; the browser never chooses one).
  if p_to_status in ('offer', 'declined') then
    select coalesce(customer_ack_enabled, false) into v_ack
      from launch_settings where id = true;
    if v_ack and coalesce(trim(v_row.email), '') <> '' then
      insert into notification_outbox
        (event_type, entity_type, entity_id, recipient_kind, template_id, payload)
      values ('application.' || p_to_status, 'careers', p_id, 'customer_ack',
              'application-' || p_to_status,
              jsonb_build_object('application_id', p_id,
                                 'applied_for', v_row.applied_for,
                                 'to_status', p_to_status));
    end if;
  end if;

  return jsonb_build_object('ok', true, 'status', p_to_status);
end $$;

revoke all on function transition_application(text, text, text) from public, anon;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE
-- ----------------------------------------------------------------------------
do $acceptance$
begin
  if to_regprocedure('public.transition_application(text, text, text)') is null then
    raise exception 'inc11_transitions: transition_application is absent';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_application_transition_guard'
                   and tgrelid = 'job_applications'::regclass) then
    raise exception 'inc11_transitions: the status guard is absent';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'job_applications_status_check') then
    raise exception 'inc11_transitions: the status CHECK constraint is absent';
  end if;
end $acceptance$;
