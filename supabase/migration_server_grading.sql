-- ============================================================================
--  MILK POP — SERVER-SIDE ANSWER GRADING (post-Stage-12 fix #2)
--
--  Run order: after migration_stage4_training.sql. Safe to re-run.
--
--  THE GAP: complete_training() trusted the client-computed score — a crafted
--  request could POST p_score = 100. The questions already live server-side
--  in training_assessments.questions, so the RPC now grades the SUBMITTED
--  ANSWERS itself whenever they are provided:
--
--    p_answers — jsonb array aligned with the assessment's questions:
--      • choice questions ('multiple_choice' / 'true_false' / 'scenario' /
--        'image_match'): the selected option STRING;
--      • drag & drop: the ordered array of placed WORDS.
--
--  Grading mirrors the client exactly (src/components/DragDropQuestion.tsx):
--    choice  → answer string === question.correctAnswer
--    drag    → every [[gap]] in dragTemplate holds its word,
--              case-insensitive + trimmed; a template with no gaps counts
--              as incorrect.
--
--  When p_answers is present the server's score REPLACES p_score everywhere
--  (result row, certificate, response — which reports "serverGraded": true).
--  When p_answers is null the legacy clamped-score path still applies, so
--  older clients keep working during rollout.
-- ============================================================================

-- The signature changes, so remove the old overload first (PostgREST would
-- otherwise see two candidates).
drop function if exists complete_training(text, int, text, text);

create or replace function grade_training_answers(p_questions jsonb, p_answers jsonb)
returns int
language plpgsql
immutable
as $$
declare
  v_total   int := coalesce(jsonb_array_length(p_questions), 0);
  v_correct int := 0;
  i         int;
  q         jsonb;
  a         jsonb;
  v_tpl     text;
  v_gaps    text[];
  v_words   text[];
  ok        boolean;
begin
  if v_total = 0 then
    return 0;
  end if;
  for i in 0 .. v_total - 1 loop
    q := p_questions -> i;
    a := case when p_answers is not null and jsonb_typeof(p_answers) = 'array'
              then p_answers -> i else null end;
    ok := false;
    if coalesce(q ->> 'type', '') = 'drag_drop'
       and coalesce(q ->> 'dragTemplate', '') <> '' then
      v_tpl := q ->> 'dragTemplate';
      select coalesce(array_agg(lower(trim(m.match[1])) order by m.ord), '{}')
        into v_gaps
        from regexp_matches(v_tpl, '\[\[(.+?)\]\]', 'g') with ordinality as m(match, ord);
      if array_length(v_gaps, 1) is not null
         and a is not null and jsonb_typeof(a) = 'array'
         and jsonb_array_length(a) = array_length(v_gaps, 1) then
        select coalesce(array_agg(lower(trim(e.value)) order by e.ord), '{}')
          into v_words
          from jsonb_array_elements_text(a) with ordinality as e(value, ord);
        ok := (v_words = v_gaps);
      end if;
    else
      ok := a is not null
            and jsonb_typeof(a) = 'string'
            and (a #>> '{}') = coalesce(q ->> 'correctAnswer', '');
    end if;
    if ok then v_correct := v_correct + 1; end if;
  end loop;
  return round(v_correct * 100.0 / v_total);
end $$;

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
  v_graded     boolean := false;
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

  -- 5. THE SCORE: graded HERE from the submitted answers whenever they are
  --    provided — the client's number is not trusted. Legacy calls without
  --    answers keep the clamped-score path.
  if p_answers is not null then
    if jsonb_typeof(p_answers) <> 'array' then
      raise exception 'invalid_answers';
    end if;
    v_score := grade_training_answers(v_assess.questions, p_answers);
    v_graded := true;
  else
    if p_score is null or p_score < 0 or p_score > 100 then
      raise exception 'invalid_score';
    end if;
    v_score := p_score;
  end if;

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
    case when v_passed then 'Completed training assessment "' || coalesce(v_assess.title, p_assessment_id) || '" (' || v_score || '%' || case when v_graded then ', server-graded' else '' end || ')'
         else 'Attempted training assessment "' || coalesce(v_assess.title, p_assessment_id) || '" (' || v_score || '%' || case when v_graded then ', server-graded' else '' end || ', below pass mark)' end,
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
    'serverGraded', v_graded,
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
revoke all on function grade_training_answers(jsonb, jsonb) from public;
