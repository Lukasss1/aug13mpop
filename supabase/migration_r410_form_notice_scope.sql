-- ============================================================================
--  MILK POP — R4.10 : each public form requires only ITS OWN privacy notice.
--
--  Closes the external INC6 audit's P0 5 — the last of its six.
--
--  WHAT WAS WRONG
--  --------------
--  All three destination tables fire the same trigger, and that trigger asked
--  one generic question:
--
--      perform assert_launch_ready('form_accept', 'form_accept_blocked');
--
--  Meanwhile all three notice conditions declare `array['form_accept']` as the
--  context they block. So a missing FRANCHISE notice blocked CONTACT messages,
--  and a missing CAREERS notice blocked both. One unpublished notice disabled
--  every public form on the site.
--
--  This is overblocking rather than exposure, but for an empty launch it is
--  exactly the wrong failure: the whole point of commissioning surfaces
--  independently is that careers can go live while contact is still being
--  written, and vice versa.
--
--  WHAT THIS DOES — AND WHAT IT DELIBERATELY DOES NOT
--  --------------------------------------------------
--  The trigger now derives the form kind from TG_TABLE_NAME and ignores the two
--  notices that have nothing to do with the submission in hand.
--
--  It does NOT restate what "ready to accept a form" means. It reads
--  `launch_blocking_reasons()` — the single existing definition — and filters
--  out only the two irrelevant notice keys. Every other form_accept blocker
--  still applies, including `notification_recipient`, because delivery is
--  genuinely shared: a submission nobody receives is not accepted, whichever
--  form produced it.
--
--  That distinction matters. An earlier guard in this round carried its own copy
--  of a rule the database already defined, and the copy drifted within a day.
--  Filtering a definition is safe; restating one is not.
--
--  APPEND-ONLY: no previously applied migration is edited by this file.
-- ============================================================================

create or replace function assert_public_form_accept_allowed()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_kind       text;
  v_irrelevant text[];
  v_blocking   text[];
begin
  -- 1. Which form is this? Derived from the table the trigger fired on, so a new
  --    form table cannot silently inherit another form's notice requirement.
  v_kind := case TG_TABLE_NAME
              when 'job_applications'    then 'careers'
              when 'franchise_inquiries' then 'franchise'
              when 'contact_messages'    then 'contact'
            end;

  if v_kind is null then
    raise exception
      'form_accept_unknown_form: % is not a recognised public form table. Add it to '
      'assert_public_form_accept_allowed() with its notice kind before accepting '
      'submissions.', TG_TABLE_NAME
      using errcode = 'raise_exception';
  end if;

  -- 2. The OTHER two notices are irrelevant to this submission.
  v_irrelevant := array(
    select 'privacy_notice_' || k
      from unnest(array['careers', 'franchise', 'contact']) as k
     where k <> v_kind);

  -- 3. Ask the ONE definition, then subtract only what does not apply. Every
  --    other form_accept blocker is still enforced.
  select array_agg(r.key order by r.key)
    into v_blocking
    from launch_blocking_reasons() r
   where r.state = 'incomplete'
     and 'form_accept' = any(r.blocks)
     and r.key <> all(v_irrelevant);

  if v_blocking is not null then
    raise exception 'form_accept_blocked: %', array_to_string(v_blocking, ', ')
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

comment on function assert_public_form_accept_allowed() is
  'R4.10: each public form requires only its OWN privacy notice. The form kind comes from '
  'TG_TABLE_NAME; the readiness rules still come from launch_blocking_reasons(), filtered '
  'rather than restated, so notification_recipient and every other shared blocker still apply.';

-- ----------------------------------------------------------------------------
-- ACCEPTANCE
-- ----------------------------------------------------------------------------
do $acceptance$
declare v_src text;
begin
  select prosrc into v_src from pg_proc where proname = 'assert_public_form_accept_allowed';
  if v_src is null or position('TG_TABLE_NAME' in v_src) = 0 then
    raise exception 'r410_form_notice_scope: the gate does not derive the form from TG_TABLE_NAME';
  end if;
  if position('launch_blocking_reasons' in v_src) = 0 then
    raise exception 'r410_form_notice_scope: the gate no longer reads the single readiness definition';
  end if;
end
$acceptance$;
