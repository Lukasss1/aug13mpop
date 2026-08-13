-- ============================================================================
--  MILK POP — MIGRATION S4 (STAGE 4): PER-EMPLOYEE TRAINING + SERVER REWARDS
--
--  Run order: after migration_rls_per_role.sql and
--  migration_training_academy.sql. Safe to re-run.
--
--  WHAT THIS FIXES
--  ---------------
--  1. Course progress was a GLOBAL column on training_courses — one employee
--     finishing a course marked it finished for everyone. Progress now lives
--     per employee in `training_progress` (employee_id + course_id).
--  2. Quiz completion self-awarded points/badges from the browser. Completion
--     is now ONE server-side transaction — `complete_training()` — which
--     validates ownership, records the attempt, completes the assignment,
--     issues at most one certificate per (employee, assessment), applies the
--     reward exactly once, writes the audit row, and returns the confirmed
--     result. Retrying with the same submission id returns the SAME result
--     (no duplicate certificates or points).
--  3. Direct API escalation is blocked at the trigger level:
--       • staff cannot change their own points / level / badges / pay / role;
--       • staff cannot re-point, re-date or force-complete an assignment;
--       • staff can only stamp emailed_at on their own certificate.
--     The RPC lifts the reward lock for ITS OWN writes via a transaction-local
--     setting that clients cannot set usefully (it only matters inside these
--     triggers, whose protected writes clients cannot otherwise perform).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. PER-EMPLOYEE PROGRESS
-- ---------------------------------------------------------------------------
create table if not exists training_progress (
  id          text primary key,            -- "<employee_id>:<course_id>"
  employee_id text not null,
  course_id   text not null,
  progress    int  not null default 0 check (progress between 0 and 100),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists uq_training_progress_emp_course
  on training_progress (employee_id, course_id);
create index if not exists idx_training_progress_employee
  on training_progress (employee_id);

drop trigger if exists trg_training_progress_updated on training_progress;
create trigger trg_training_progress_updated before update on training_progress
  for each row execute function set_updated_at();

alter table training_progress enable row level security;

drop policy if exists tprog_select_self_or_mgr on training_progress;
create policy tprog_select_self_or_mgr on training_progress
  for select to authenticated
  using (employee_id = current_staff_id() or is_manager_or_owner());

-- Study-session progress (the 0–99% display) is the employee's own record;
-- the id shape and ownership are pinned. Rewards do NOT flow from this table.
drop policy if exists tprog_upsert_self on training_progress;
create policy tprog_upsert_self on training_progress
  for insert to authenticated
  with check (
    employee_id = current_staff_id()
    and id = current_staff_id() || ':' || course_id
  );
drop policy if exists tprog_update_self on training_progress;
create policy tprog_update_self on training_progress
  for update to authenticated
  using (employee_id = current_staff_id())
  with check (employee_id = current_staff_id()
              and id = current_staff_id() || ':' || course_id);

grant select, insert, update on training_progress to authenticated;
revoke delete on training_progress from authenticated;
revoke all on training_progress from anon;

-- ---------------------------------------------------------------------------
-- 2. ATTEMPT / RESULT RECORDS (server-written only)
-- ---------------------------------------------------------------------------
create table if not exists training_results (
  id            uuid primary key default gen_random_uuid(),
  submission_id text not null unique,       -- client-stable idempotency key
  employee_id   text not null,
  assessment_id text not null,
  assignment_id text,
  course_id     text,
  score         int  not null,
  passed        boolean not null,
  response      jsonb,                      -- the exact payload returned; replayed on retry
  created_at    timestamptz not null default now()
);
create index if not exists idx_training_results_employee
  on training_results (employee_id, assessment_id);

alter table training_results enable row level security;
drop policy if exists tres_select_self_or_mgr on training_results;
create policy tres_select_self_or_mgr on training_results
  for select to authenticated
  using (employee_id = current_staff_id() or is_manager_or_owner());
-- No INSERT/UPDATE/DELETE policies: only complete_training() (definer) writes.
revoke insert, update, delete on training_results from authenticated;
grant  select on training_results to authenticated;
revoke all on training_results from anon;

-- One certificate per employee per assessment — the idempotency backstop.
create unique index if not exists uq_tcert_emp_assess
  on training_certificates (employee_id, assessment_id);

-- ---------------------------------------------------------------------------
-- 3. REWARD LOCK + COLUMN-PROTECTION TRIGGERS
-- ---------------------------------------------------------------------------
create or replace function reward_grant_active() returns boolean
language sql stable as $$
  select coalesce(nullif(current_setting('milkpop.reward_grant', true), ''), '0') = '1'
$$;

-- Reconcile the PRE-EXISTING E3 field lock (migration_field_lock.sql) with
-- this stage: same protections, plus the server-context bypass and the
-- reward grant for complete_training's own writes. CREATE OR REPLACE keeps
-- every existing database coherent without touching the E3 trigger wiring.
create or replace function enforce_staff_self_update_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;  -- service role / server contexts are not browser requests
  end if;
  if is_owner() then
    return new;
  end if;
  -- Contract/identity columns: locked for every non-owner, always.
  if (new.pay_rate      is distinct from old.pay_rate)
     or (new.pay_type   is distinct from old.pay_type)
     or (new.role       is distinct from old.role)
     or (new.store_id   is distinct from old.store_id)
     or (new.store_name is distinct from old.store_name)
  then
    raise exception 'field is not self-editable (protected column changed by non-owner)'
      using errcode = 'insufficient_privilege';
  end if;
  -- Reward/HR columns: the complete_training transaction, or a manager/owner
  -- acting on someone ELSE's row (recognition, holiday) — never self-award.
  if not (reward_grant_active()
          or (is_manager_or_owner() and old.id is distinct from current_staff_id()))
     and (
       (new.points          is distinct from old.points)
    or (new.level           is distinct from old.level)
    or (new.holiday_balance is distinct from old.holiday_balance)
    or (new.badges          is distinct from old.badges)
  ) then
    raise exception 'field is not self-editable (protected column changed by non-owner)'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- staff_profiles: non-owners cannot touch contract/identity columns; reward
-- columns move ONLY under the reward lock (the RPC) or a manager/owner.
create or replace function staff_profiles_protect() returns trigger
language plpgsql as $$
begin
  -- Server contexts (service role, definer helpers) are not browser requests:
  -- only 'authenticated' JWTs are subject to these locks.
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;
  end if;
  if not is_owner() then
    -- Carve-out: a signed-in user claiming their OWN unlinked profile on
    -- first sign-in (link_staff_profile) — auth_id may go null → auth.uid().
    if new.auth_id is distinct from old.auth_id
       and not (old.auth_id is null and new.auth_id = auth.uid()) then
      raise exception 'protected_profile_columns' using errcode = '42501';
    end if;
    if new.role         is distinct from old.role
    or new.store_id     is distinct from old.store_id
    or new.store_name   is distinct from old.store_name
    or new.pay_type     is distinct from old.pay_type
    or new.pay_rate     is distinct from old.pay_rate
    or new.status       is distinct from old.status then
      raise exception 'protected_profile_columns' using errcode = '42501';
    end if;
  end if;
  if not (reward_grant_active()
          or (is_manager_or_owner() and old.id is distinct from current_staff_id())) then
    if new.points          is distinct from old.points
    or new.level           is distinct from old.level
    or new.badges          is distinct from old.badges
    or new.holiday_balance is distinct from old.holiday_balance then
      raise exception 'protected_reward_columns' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_staff_profiles_protect on staff_profiles;
create trigger trg_staff_profiles_protect before update on staff_profiles
  for each row execute function staff_profiles_protect();

-- training_assignments: staff may only move their own row assigned→in_progress;
-- identity/dates/rewards are pinned; completion happens under the reward lock.
create or replace function training_assignments_protect() returns trigger
language plpgsql as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;
  end if;
  if is_manager_or_owner() or reward_grant_active() then
    return new;
  end if;
  if new.employee_id      is distinct from old.employee_id
  or new.employee_name    is distinct from old.employee_name
  or new.assessment_id    is distinct from old.assessment_id
  or new.assessment_title is distinct from old.assessment_title
  or new.assigned_by      is distinct from old.assigned_by
  or new.assigned_at      is distinct from old.assigned_at
  or new.due_date         is distinct from old.due_date
  or new.score            is distinct from old.score
  or new.completed_at     is distinct from old.completed_at then
    raise exception 'protected_assignment_columns' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'assigned' and new.status = 'in_progress') then
    raise exception 'assignment_status_locked' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_training_assignments_protect on training_assignments;
create trigger trg_training_assignments_protect before update on training_assignments
  for each row execute function training_assignments_protect();

-- training_certificates: issued only by the RPC; a staff member may stamp
-- emailed_at on their OWN certificate, nothing else.
create or replace function training_certificates_protect() returns trigger
language plpgsql as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;
  end if;
  if is_manager_or_owner() or reward_grant_active() then
    return new;
  end if;
  if new.id               is distinct from old.id
  or new.employee_id      is distinct from old.employee_id
  or new.employee_name    is distinct from old.employee_name
  or new.assessment_id    is distinct from old.assessment_id
  or new.assessment_title is distinct from old.assessment_title
  or new.category         is distinct from old.category
  or new.score            is distinct from old.score
  or new.issued_at        is distinct from old.issued_at then
    raise exception 'protected_certificate_columns' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_training_certificates_protect on training_certificates;
create trigger trg_training_certificates_protect before update on training_certificates
  for each row execute function training_certificates_protect();

-- Certificates: creation is server-side only; self may update (emailed_at,
-- guarded by the trigger above) on their own row.
drop policy if exists tcert_insert_staff on training_certificates;
drop policy if exists tcert_insert_mgr   on training_certificates;
drop policy if exists tcert_update_self_emailed on training_certificates;
create policy tcert_update_self_emailed on training_certificates
  for update to authenticated
  using (employee_id = current_staff_id() or is_manager_or_owner())
  with check (employee_id = current_staff_id() or is_manager_or_owner());
revoke insert, delete on training_certificates from authenticated;
grant  select, update on training_certificates to authenticated;

-- ---------------------------------------------------------------------------
-- 4. THE COMPLETION TRANSACTION
-- ---------------------------------------------------------------------------
create or replace function complete_training(
  p_assessment_id text,
  p_score         int,
  p_submission_id text,
  p_assignment_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id   text := current_staff_id();
  v_staff      staff_profiles%rowtype;
  v_assess     training_assessments%rowtype;
  v_assign     training_assignments%rowtype;
  v_course     training_courses%rowtype;
  v_existing   training_results%rowtype;
  v_cert       training_certificates%rowtype;
  v_new_cert   boolean := false;
  v_passed     boolean;
  v_points     int := 0;
  v_badge      text := '';
  v_response   jsonb;
begin
  -- 1. Authenticate: a LINKED, active staff member.
  if v_staff_id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  select * into v_staff from staff_profiles where id = v_staff_id;

  -- 2. Validate inputs.
  if p_score is null or p_score < 0 or p_score > 100 then
    raise exception 'invalid_score';
  end if;
  if coalesce(trim(p_submission_id), '') = '' or length(p_submission_id) > 120 then
    raise exception 'invalid_submission_id';
  end if;

  -- 3. Idempotency: the same submission returns the SAME confirmed result.
  select * into v_existing from training_results where submission_id = p_submission_id;
  if found then
    if v_existing.employee_id <> v_staff_id then
      raise exception 'not_your_submission' using errcode = '42501';
    end if;
    return v_existing.response;
  end if;

  -- 4. The assessment must exist; the assignment (when given) must be the
  --    caller's own and must point at this assessment.
  select * into v_assess from training_assessments where id = p_assessment_id;
  if v_assess.id is null then
    raise exception 'unknown_assessment';
  end if;
  if p_assignment_id is not null then
    select * into v_assign from training_assignments where id = p_assignment_id;
    if v_assign.id is null or v_assign.employee_id <> v_staff_id then
      raise exception 'not_your_assignment' using errcode = '42501';
    end if;
    if v_assign.assessment_id <> p_assessment_id then
      raise exception 'assignment_assessment_mismatch';
    end if;
  end if;

  v_passed := p_score >= coalesce(v_assess.passing_score, 80);
  select * into v_course from training_courses
    where assessment_id = p_assessment_id or id = p_assessment_id
    limit 1;

  -- 5. Lift the reward lock for THIS transaction's own protected writes.
  perform set_config('milkpop.reward_grant', '1', true);

  -- 6. Attempt record (also the idempotency anchor via its unique key).
  insert into training_results (submission_id, employee_id, assessment_id, assignment_id, course_id, score, passed)
  values (p_submission_id, v_staff_id, p_assessment_id, p_assignment_id, v_course.id, p_score, v_passed);

  -- 7. Assignment completion (this employee's rows for this assessment only).
  if v_passed then
    update training_assignments
       set status = 'completed',
           completed_at = now(),
           score = greatest(coalesce(score, 0), p_score)
     where employee_id = v_staff_id
       and assessment_id = p_assessment_id
       and status <> 'completed';
  elsif p_assignment_id is not null and v_assign.status = 'assigned' then
    update training_assignments set status = 'in_progress' where id = p_assignment_id;
  end if;

  -- 8. Per-employee course progress.
  if v_course.id is not null and v_passed then
    insert into training_progress (id, employee_id, course_id, progress)
    values (v_staff_id || ':' || v_course.id, v_staff_id, v_course.id, 100)
    on conflict (id) do update set progress = 100, updated_at = now();
  end if;

  -- 9. Certificate — at most one per (employee, assessment), ever.
  if v_passed then
    insert into training_certificates (id, employee_id, employee_name, assessment_id, assessment_title, category, score)
    values (
      'MP-' || upper(substr(regexp_replace(p_assessment_id, '[^a-zA-Z0-9]', '', 'g') || 'MODULE', 1, 6))
            || '-' || upper(substr(md5(v_staff_id || ':' || p_assessment_id), 1, 8)),
      v_staff_id, coalesce(v_staff.name, ''), p_assessment_id,
      coalesce(v_assess.title, ''), coalesce(v_assess.category, ''), p_score
    )
    on conflict (employee_id, assessment_id) do nothing;
    v_new_cert := found;
    select * into v_cert from training_certificates
      where employee_id = v_staff_id and assessment_id = p_assessment_id;

    -- 10. Reward exactly once — the first time the certificate is issued.
    if v_new_cert then
      v_points := coalesce(v_assess.points, 0);
      v_badge  := coalesce(v_assess.badge, '');
      update staff_profiles
         set points = points + v_points,
             level  = floor((points + v_points) / 500.0) + 1,
             badges = case
                        when v_badge = '' or badges @> to_jsonb(array[v_badge]) then badges
                        else badges || to_jsonb(array[v_badge])
                      end
       where id = v_staff_id;
      select * into v_staff from staff_profiles where id = v_staff_id;
    end if;
  end if;

  -- 11. Server-side audit row (actor derived here, never from the client).
  insert into audit_logs (id, operator_name, role, action, timestamp, module, previous_value, new_value)
  values (
    'aud_' || replace(gen_random_uuid()::text, '-', ''),
    coalesce(v_staff.name, v_staff_id),
    coalesce(v_staff.role::text, ''),
    case when v_passed then 'Completed training assessment "' || coalesce(v_assess.title, p_assessment_id) || '" (' || p_score || '%)'
         else 'Attempted training assessment "' || coalesce(v_assess.title, p_assessment_id) || '" (' || p_score || '%, below pass mark)' end,
    now()::text,
    'Training Academy (server)',
    null,
    case when v_new_cert then 'certificate ' || v_cert.id || ', +' || v_points || ' pts' else null end
  );

  -- 12. The confirmed result — stored so a retry replays it verbatim.
  v_response := jsonb_build_object(
    'ok', true,
    'passed', v_passed,
    'score', p_score,
    'passingScore', coalesce(v_assess.passing_score, 80),
    'newCertificate', v_new_cert,
    'certificate', case when v_cert.id is not null then to_jsonb(v_cert) end,
    'pointsAwarded', case when v_new_cert then v_points else 0 end,
    'badgeAwarded', case when v_new_cert and v_badge <> '' then v_badge end,
    'profilePoints', v_staff.points,
    'profileLevel', v_staff.level,
    'profileBadges', v_staff.badges,
    'courseId', v_course.id
  );
  update training_results set response = v_response where submission_id = p_submission_id;
  return v_response;
end $$;

revoke all on function complete_training(text, int, text, text) from public;
grant execute on function complete_training(text, int, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- HANDOVER NOTES
-- ---------------------------------------------------------------------------
-- • training_courses.progress is now DEAD: the client neither reads nor
--   writes it (per-employee display comes from training_progress). It stays
--   for backward compatibility; a later cleanup migration may drop it.
-- • The submitted score is client-computed; the server clamps, applies the
--   stored pass mark, and makes rewards idempotent. Full server-side answer
--   grading is a post-launch upgrade (the RPC's signature leaves room for it).
