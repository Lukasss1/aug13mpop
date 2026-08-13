-- ============================================================================
--  MILK POP — MIGRATION FIX-9: ASSESSMENT INTEGRITY
--  Closes forensic-audit TRN-001 (self-award via the legacy score path) and
--  TRN-002 (answer keys delivered to trainees).
--
--  TRN-001 — complete_training() previously kept a legacy branch: when
--  p_answers was null it accepted a client-chosen p_score (0–100). Any linked
--  staff member could call the RPC directly with p_answers = null and
--  p_score = 100 and receive a pass, certificate, points and badge. The
--  branch is REMOVED: answers are now mandatory, must be an array whose
--  length exactly matches the stored question count, and the score is ALWAYS
--  computed server-side by grade_training_answers(). p_score is retained in
--  the signature purely for wire compatibility and is ignored.
--
--  TRN-002 — every authenticated staff member could SELECT
--  training_assessments, whose questions JSON carries correctAnswer and the
--  drag-drop answer words inline in dragTemplate. The table is now readable
--  by managers/owners only (they author it); trainees receive their quiz
--  content through get_staff_assessments(), which strips correctAnswer and
--  explanation, blanks the drag gaps to [[⋯]], and supplies the gap words as
--  a separate alphabetically-sorted dragWords bank (sorted so the word ORDER
--  cannot leak the answer sequence). Managers/owners get the full rows from
--  the same RPC so one client code path serves both.
--
--  Deploy order: after migration_server_grading.sql and
--  migration_rls_per_role.sql (it redefines objects from both).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. TRN-001: answers are mandatory; the server grade is the only grade.
--    Body identical to migration_server_grading.sql except step 5.
-- ----------------------------------------------------------------------------
create or replace function complete_training(
  p_assessment_id text,
  p_score         int,
  p_submission_id text,
  p_assignment_id text default null,
  p_answers       jsonb default null
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
  v_score      int;
  v_response   jsonb;
begin
  -- 1. Authenticate: a LINKED, active staff member.
  if v_staff_id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  select * into v_staff from staff_profiles where id = v_staff_id;

  -- 2. Validate inputs.
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

  -- 5. THE SCORE — FIX-9: graded HERE, always. The legacy client-score path
  --    is gone: null/malformed/short/long answer arrays are all rejected, and
  --    p_score is never read. The client cannot be the grading boundary.
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then
    raise exception 'answers_required';
  end if;
  if jsonb_array_length(p_answers) <> coalesce(jsonb_array_length(v_assess.questions), 0) then
    raise exception 'answers_count_mismatch';
  end if;
  v_score := grade_training_answers(v_assess.questions, p_answers);

  v_passed := v_score >= coalesce(v_assess.passing_score, 80);
  select * into v_course from training_courses
    where assessment_id = p_assessment_id or id = p_assessment_id
    limit 1;

  -- 6. Lift the reward lock for THIS transaction's own protected writes.
  perform set_config('milkpop.reward_grant', '1', true);

  -- 7. Attempt record (also the idempotency anchor via its unique key).
  insert into training_results (submission_id, employee_id, assessment_id, assignment_id, course_id, score, passed)
  values (p_submission_id, v_staff_id, p_assessment_id, p_assignment_id, v_course.id, v_score, v_passed);

  -- 8. Assignment completion (this employee's rows for this assessment only).
  if v_passed then
    update training_assignments
       set status = 'completed',
           completed_at = now(),
           score = greatest(coalesce(score, 0), v_score)
     where employee_id = v_staff_id
       and assessment_id = p_assessment_id
       and status <> 'completed';
  elsif p_assignment_id is not null and v_assign.status = 'assigned' then
    update training_assignments set status = 'in_progress' where id = p_assignment_id;
  end if;

  -- 9. Per-employee course progress.
  if v_course.id is not null and v_passed then
    insert into training_progress (id, employee_id, course_id, progress)
    values (v_staff_id || ':' || v_course.id, v_staff_id, v_course.id, 100)
    on conflict (id) do update set progress = 100, updated_at = now();
  end if;

  -- 10. Certificate — at most one per (employee, assessment), ever.
  if v_passed then
    insert into training_certificates (id, employee_id, employee_name, assessment_id, assessment_title, category, score)
    values (
      'MP-' || upper(substr(regexp_replace(p_assessment_id, '[^a-zA-Z0-9]', '', 'g') || 'MODULE', 1, 6))
            || '-' || upper(substr(md5(v_staff_id || ':' || p_assessment_id), 1, 8)),
      v_staff_id, coalesce(v_staff.name, ''), p_assessment_id,
      coalesce(v_assess.title, ''), coalesce(v_assess.category, ''), v_score
    )
    on conflict (employee_id, assessment_id) do nothing;
    v_new_cert := found;
    select * into v_cert from training_certificates
      where employee_id = v_staff_id and assessment_id = p_assessment_id;

    -- 11. Reward exactly once — the first time the certificate is issued.
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

  -- 12. Server-side audit row (actor derived here, never from the client).
  insert into audit_logs (id, operator_name, role, action, timestamp, module, previous_value, new_value)
  values (
    'aud_' || replace(gen_random_uuid()::text, '-', ''),
    coalesce(v_staff.name, v_staff_id),
    coalesce(v_staff.role::text, ''),
    case when v_passed then 'Completed training assessment "' || coalesce(v_assess.title, p_assessment_id) || '" (' || v_score || '%, server-graded)'
         else 'Attempted training assessment "' || coalesce(v_assess.title, p_assessment_id) || '" (' || v_score || '%, server-graded, below pass mark)' end,
    now()::text,
    'Training Academy (server)',
    null,
    case when v_new_cert then 'certificate ' || v_cert.id || ', +' || v_points || ' pts' else null end
  );

  -- 13. The confirmed result — stored so a retry replays it verbatim.
  v_response := jsonb_build_object(
    'ok', true,
    'passed', v_passed,
    'score', v_score,
    'serverGraded', true,
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

revoke all on function complete_training(text, int, text, text, jsonb) from public;
grant execute on function complete_training(text, int, text, text, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. TRN-002: the raw table (with answer keys) is manager/owner-only.
--    (Replaces the grouped *_read_staff policy from migration_rls_per_role.)
-- ----------------------------------------------------------------------------
drop policy if exists training_assessments_read_staff on training_assessments;
drop policy if exists training_assessments_read_mgr   on training_assessments;
create policy training_assessments_read_mgr on training_assessments
  for select to authenticated
  using (is_manager_or_owner());

-- ----------------------------------------------------------------------------
-- 3. The redaction: strip correctAnswer + explanation; blank drag gaps to
--    [[⋯]]; publish the gap words as an alphabetised dragWords bank.
-- ----------------------------------------------------------------------------
create or replace function redact_assessment_row(p jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_qs    jsonb := coalesce(p -> 'questions', '[]'::jsonb);
  v_out   jsonb := '[]'::jsonb;
  v_n     int   := coalesce(jsonb_array_length(p -> 'questions'), 0);
  q       jsonb;
  v_tpl   text;
  v_words jsonb;
  i       int;
begin
  for i in 0 .. v_n - 1 loop
    q := (v_qs -> i) - 'correctAnswer' - 'explanation';
    if coalesce(q ->> 'type', '') = 'drag_drop'
       and coalesce(q ->> 'dragTemplate', '') <> '' then
      v_tpl := q ->> 'dragTemplate';
      select coalesce(jsonb_agg(w order by lower(w)), '[]'::jsonb)
        into v_words
        from (select trim(m.match[1]) as w
                from regexp_matches(v_tpl, '\[\[(.+?)\]\]', 'g') as m(match)) s;
      q := jsonb_set(q, '{dragWords}', v_words);
      q := jsonb_set(q, '{dragTemplate}',
                     to_jsonb(regexp_replace(v_tpl, '\[\[[^\]]*\]\]', '[[⋯]]', 'g')));
    end if;
    v_out := v_out || jsonb_build_array(q);
  end loop;
  return jsonb_set(p, '{questions}', v_out);
end $$;

-- ----------------------------------------------------------------------------
-- 4. The staff read path. One RPC for everyone: managers/owners (aal2, via
--    is_manager_or_owner) receive full rows so the Academy Studio keeps
--    working; every other staff member receives redacted rows. Row shape is
--    to_jsonb(table) — identical keys to a PostgREST select, so the existing
--    client row mapper applies unchanged.
-- ----------------------------------------------------------------------------
create or replace function get_staff_assessments()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_rows jsonb;
begin
  if current_staff_id() is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if is_manager_or_owner() then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at), '[]'::jsonb)
      into v_rows from training_assessments t;
  else
    select coalesce(jsonb_agg(redact_assessment_row(to_jsonb(t)) order by t.created_at), '[]'::jsonb)
      into v_rows from training_assessments t;
  end if;
  return v_rows;
end $$;

revoke all on function redact_assessment_row(jsonb) from public;
revoke all on function get_staff_assessments()     from public;
grant execute on function get_staff_assessments()  to authenticated;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE:
--   • As a team member: select * from training_assessments  → 0 rows.
--   • select get_staff_assessments()  → questions contain NO correctAnswer,
--     NO explanation; dragTemplate shows only [[⋯]] gaps; dragWords is
--     alphabetised.
--   • rpc complete_training(p_answers := null)          → answers_required.
--   • rpc complete_training(p_answers := '[]')          → answers_count_mismatch
--     (for any assessment with ≥1 question).
--   • A fully-correct payload passes; p_score = 0 with correct answers still
--     scores 100 (p_score is dead).
-- ----------------------------------------------------------------------------
