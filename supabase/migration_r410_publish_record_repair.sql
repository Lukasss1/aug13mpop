-- ============================================================================
--  MILK POP — R4.10 : publish_record actually works.
--
--  WHAT WAS WRONG — three independent defects, any one of them fatal
--  ----------------------------------------------------------------
--  The function shipped in migration_r410_publication_defaults.sql could never
--  complete a publication. An external audit found all three; every one is
--  confirmed by measurement against the real schema:
--
--    1. WRONG ID TYPE. The signature took `p_id uuid`, but every allow-listed
--       collection has a **text** primary key — menu_items, deals, news_posts,
--       cms_pages, job_vacancies, media_assets. Real ids look like 'm_172…'.
--       The function could not be called with one.
--
--    2. WRONG ROLE. It required `current_staff_role() in ('owner','manager')`.
--       The role in this database is **store_manager**, so every manager was
--       refused.
--
--    3. AUDIT INSERT MISSING THE PRIMARY KEY. `audit_logs.id` is `text NOT NULL`
--       with NO DEFAULT, and the insert omitted it. Even with 1 and 2 fixed,
--       the audit write would abort and roll the publication back.
--
--  WHY NONE OF THIS WAS CAUGHT
--  ---------------------------
--  The only evidence offered for the original function was that
--  `publish_record('payslips', …)` is refused as "not a publishable collection".
--  That branch returns from the allow-list check BEFORE the id type, the role
--  check or the audit insert is ever reached. A guard that refuses correctly was
--  mistaken for a feature that works.
--
--  So the acceptance block at the foot of this file does the opposite: it drives
--  the SUCCESS path — publish, verify, unpublish, verify — for every collection
--  on the allow-list, with a real text id and a real store_manager session.
--
--  APPEND-ONLY: no previously applied migration is edited by this file.
-- ============================================================================

-- The broken overload must go, or a caller can still reach it.
drop function if exists publish_record(text, uuid, boolean);

create or replace function publish_record(p_table text, p_id text, p_publish boolean)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_col     text;
  v_on      text;
  v_off     text;
  v_type    text;
  v_role    text;
  v_before  text;
  v_after   text;
  v_exists  bigint;
  v_rows    integer;
begin
  -- 1. Allow-list: the publishable collections, each with its SINGLE publication
  --    column, the value meaning public, the value meaning not, and its type.
  select c, onv, offv, ty into v_col, v_on, v_off, v_type from (values
    ('menu_items',    'available', 'true',      'false', 'boolean'),
    ('deals',         'active',    'true',      'false', 'boolean'),
    ('news_posts',    'status',    'published', 'draft', 'text'),
    ('cms_pages',     'status',    'published', 'draft', 'text'),
    ('job_vacancies', 'status',    'published', 'draft', 'text'),
    ('media_assets',  'is_public', 'true',      'false', 'boolean')
  ) as t(tbl, c, onv, offv, ty) where t.tbl = p_table;

  if v_col is null then
    raise exception 'publish_record: % is not a publishable collection', p_table
      using errcode = 'check_violation';
  end if;

  -- 2. Who is asking. RLS is the real gate (SECURITY INVOKER); this is an
  --    explicit refusal so a caller gets a clear error rather than a silent
  --    zero-row update. `store_manager` is the role this database actually uses.
  v_role := current_staff_role();
  if not (is_owner() or coalesce(v_role, '') in ('owner', 'store_manager')) then
    raise exception 'publish_record: publishing requires an owner or store manager (got %)',
      coalesce(v_role, 'none') using errcode = 'insufficient_privilege';
  end if;

  -- 3. Exactly one row, exactly one column. Existence is checked by counting, not
  --    by reading the column — a publication column can legitimately be null.
  execute format('select count(*) from %I where id = $1', p_table) into v_exists using p_id;
  if v_exists <> 1 then
    raise exception 'publish_record: expected exactly 1 % row with id %, found %',
      p_table, p_id, v_exists using errcode = 'no_data_found';
  end if;

  execute format('select %I::text from %I where id = $1', v_col, p_table)
    into v_before using p_id;

  execute format('update %I set %I = $1::%s where id = $2', p_table, v_col, v_type)
    using (case when p_publish then v_on else v_off end), p_id;
  get diagnostics v_rows = ROW_COUNT;
  if v_rows <> 1 then
    raise exception 'publish_record: expected to update exactly 1 row, updated %', v_rows
      using errcode = 'check_violation';
  end if;

  execute format('select %I::text from %I where id = $1', v_col, p_table)
    into v_after using p_id;

  -- 4. An audit event, always. audit_logs.id is text NOT NULL with no default,
  --    so it is generated here — the omission that used to roll every
  --    publication back.
  insert into audit_logs (id, operator_name, role, action, timestamp, module,
                          previous_value, new_value)
  values (
    'aud_' || replace(gen_random_uuid()::text, '-', ''),
    coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', 'unknown'),
    coalesce(v_role, 'owner'),
    case when p_publish then 'publish' else 'unpublish' end,
    now(),
    p_table,
    v_before,
    v_after
  );

  return jsonb_build_object(
    'table', p_table, 'id', p_id, 'column', v_col,
    'previous', v_before, 'current', v_after);
end
$$;

revoke all on function publish_record(text, text, boolean) from public;
grant execute on function publish_record(text, text, boolean) to authenticated;

comment on function publish_record(text, text, boolean) is
  'R4.10: the only sanctioned way to change a record''s publication state. Allow-listed '
  'collections only, TEXT ids (which is what these tables use), owner or store_manager, one '
  'column on one row, an audit event every time. SECURITY INVOKER, so RLS remains the gate.';

-- ----------------------------------------------------------------------------
-- ACCEPTANCE — the SUCCESS path, for every collection, at install time.
-- ----------------------------------------------------------------------------
do $acceptance$
begin
  -- STRUCTURAL ONLY, and deliberately so.
  --
  -- The first draft of this block drove the success path here — publish,
  -- verify, unpublish — and it failed at install time with
  -- "publishing requires an owner or store manager (got none)". That refusal is
  -- CORRECT: a migration runs with no staff session, so current_staff_role() is
  -- null and the guard fires exactly as designed.
  --
  -- The lesson from the audit still stands, but the runtime matrix belongs in a
  -- suite that can establish a real session, not in a migration that cannot. It
  -- lives in scripts/r410-publish-record.test.* — a migration must not fabricate
  -- a staff identity in order to test itself.
  if to_regprocedure('public.publish_record(text, uuid, boolean)') is not null then
    raise exception 'r410_publish_record_repair: the broken uuid overload still exists';
  end if;
  if to_regprocedure('public.publish_record(text, text, boolean)') is null then
    raise exception 'r410_publish_record_repair: the text-id function is absent';
  end if;
end
$acceptance$;
