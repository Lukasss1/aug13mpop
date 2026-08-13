-- ============================================================================
--  MILK POP — R4.10 : ONE publication boundary.
--
--  THE THIRD AUDIT'S CENTRAL FINDING
--  ---------------------------------
--  The system carried TWO competing publication models: the per-record
--  publish_record RPC (repaired, but wired to nothing), and the old
--  whole-collection replace_collection path the real Admin Panel uses — which
--  could carry `available` / `active` / `status` / `is_public` in any payload
--  row and so publish, unpublish or overwrite publication state without ever
--  touching the protected path. A stale browser snapshot could also delete
--  rows created after it was taken. This file leaves exactly one way to
--  change publication state, and makes the other way physically unable to.
--
--  WHAT THIS FILE DOES
--  -------------------
--  1. publish_record enforces the REAL authorisation matrix explicitly:
--       owner + AAL2          → all six collections
--       store_manager + AAL2  → menu_items only
--       AAL1 / anonymous / disabled / any other role → refused, by name.
--     This matches the RLS write policies exactly (menu_write_mgr is
--     is_manager_or_owner(); the other five are content_write_owner =
--     is_owner(); both helpers already require AAL2). The RPC no longer
--     leaves a store manager to discover the boundary as a generic RLS
--     zero-row failure on five of the six collections.
--  2. publish_record refuses to PUBLISH an incomplete record. Every
--     collection has a database-level completeness rule (below); unpublishing
--     is always allowed — retraction must never be blocked by the state of
--     the thing being retracted.
--  3. replace_collection: publication state is IGNORED on the way in. The
--     lifecycle column of each publishable collection is stripped from every
--     payload row, so existing rows KEEP their stored value and new rows take
--     the column DEFAULT (draft / false). Only publish_record changes them.
--  4. replace_collection: the snapshot total is MANDATORY. The caller states
--     how many rows it believes the collection holds; a mismatch is refused
--     as stale before anything is deleted. The old two-argument signature is
--     DROPPED so no caller can skip the statement.
--
--  WHY THE SNAPSHOT GUARD'S TRUNCATION BRANCH IS RETIRED
--  -----------------------------------------------------
--  assert_full_collection_snapshot() refused any payload smaller than the
--  visible table. With totals OPTIONAL that was the only defence against a
--  filtered snapshot — but it also made every deletion impossible, which is
--  why it could never be wired in. With totals MANDATORY the stale and
--  filtered cases are both caught by the total check (a client publishing
--  the filtered projection states the filtered count, which cannot match the
--  base table), and a smaller payload WITH a matching total is an informed
--  deletion by a caller who demonstrably saw the whole collection. One
--  administrator deleting a row they are looking at is not a hazard; a
--  publisher deleting rows it never loaded is, and that is exactly the case
--  the total check refuses.
--
--  APPEND-ONLY: no previously applied migration file is edited.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Database-level completeness: what each collection must carry before it
--    may be PUBLISHED. These are floors, not editorial standards — the Admin
--    UI can and does ask for more, but RPCs can be called directly and a
--    future frontend cannot silently lower the bar. Columns referenced here
--    are the real ones (deals carry no date columns; news derives its public
--    slug from the title, so a non-blank title IS the slug rule).
-- ----------------------------------------------------------------------------
create or replace function publication_completeness_errors(p_table text, p_id text)
returns text[]
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v text[] := '{}';
  r record;
begin
  if p_table = 'menu_items' then
    select * into r from menu_items where id = p_id;
    if not found then return array['record not found']; end if;
    if coalesce(trim(r.name), '') = '' then v := v || 'name is blank'::text; end if;
    if r.price is null or r.price < 0 then v := v || 'price must be zero or more'::text; end if;
    if r.price_large is not null and r.price_large < 0 then v := v || 'large price must be zero or more'::text; end if;
    if coalesce(trim(r.image), '') = '' then v := v || 'image is missing'::text; end if;

  elsif p_table = 'deals' then
    select * into r from deals where id = p_id;
    if not found then return array['record not found']; end if;
    if coalesce(trim(r.name), '') = '' then v := v || 'name is blank'::text; end if;
    if r.type = 'bundle_price' then
      if coalesce(r.buy_qty, 0) < 1 then v := v || 'bundle_price needs buy_qty of at least 1'::text; end if;
      if r.bundle_price is null or r.bundle_price <= 0 then v := v || 'bundle_price needs a positive bundle price'::text; end if;
      if r.category is null then v := v || 'bundle_price needs a category'::text; end if;
    elsif r.type = 'buy_x_get_y_free' then
      if coalesce(r.buy_qty, 0) < 1 then v := v || 'buy_x_get_y_free needs buy_qty of at least 1'::text; end if;
      if coalesce(r.free_qty, 0) < 1 then v := v || 'buy_x_get_y_free needs free_qty of at least 1'::text; end if;
      if r.category is null then v := v || 'buy_x_get_y_free needs a category'::text; end if;
    elsif r.type = 'percent_off_category' then
      if r.percent_off is null or r.percent_off <= 0 or r.percent_off > 100 then
        v := v || 'percent_off must be between 0 and 100'::text; end if;
      if r.category is null then v := v || 'percent_off_category needs a category'::text; end if;
    elsif r.type = 'fixed_off_order' then
      if r.amount_off is null or r.amount_off <= 0 then v := v || 'fixed_off_order needs a positive amount off'::text; end if;
      if r.min_order_value is not null and r.min_order_value < 0 then v := v || 'minimum order value cannot be negative'::text; end if;
    end if;

  elsif p_table = 'job_vacancies' then
    select * into r from job_vacancies where id = p_id;
    if not found then return array['record not found']; end if;
    if coalesce(trim(r.title), '') = '' then v := v || 'title is blank'::text; end if;
    if coalesce(trim(r.location), '') = '' then v := v || 'location is blank'::text; end if;
    if coalesce(trim(r.salary), '') = '' then v := v || 'salary wording is blank'::text; end if;
    if coalesce(trim(r.role_description), '') = '' then v := v || 'role description is blank'::text; end if;

  elsif p_table = 'news_posts' then
    select * into r from news_posts where id = p_id;
    if not found then return array['record not found']; end if;
    if coalesce(trim(r.title), '') = '' then v := v || 'title is blank (the public slug derives from it)'::text; end if;
    if coalesce(trim(r.content), '') = '' then v := v || 'content is blank'::text; end if;
    if coalesce(trim(r.date), '') = '' then v := v || 'date is blank'::text; end if;

  elsif p_table = 'cms_pages' then
    select * into r from cms_pages where id = p_id;
    if not found then return array['record not found']; end if;
    if coalesce(trim(r.page_name), '') = '' then v := v || 'page name is blank'::text; end if;
    if coalesce(trim(r.title), '') = '' then v := v || 'title is blank'::text; end if;
    if coalesce(trim(r.hero_headline), '') = '' and coalesce(trim(r.section_content), '') = '' then
      v := v || 'page has neither a hero headline nor section content'::text; end if;
    if coalesce(trim(r.seo_title), '') = '' then v := v || 'SEO title is blank'::text; end if;

  elsif p_table = 'media_assets' then
    select * into r from media_assets where id = p_id;
    if not found then return array['record not found']; end if;
    if coalesce(trim(r.url), '') = '' then v := v || 'asset URL is blank'::text; end if;
    if coalesce(trim(r.type), '') = '' then v := v || 'asset type is blank'::text; end if;

  else
    return array[p_table || ' has no completeness rule'];
  end if;

  return v;
end $$;

revoke all on function publication_completeness_errors(text, text) from public, anon;
grant execute on function publication_completeness_errors(text, text) to authenticated;

comment on function publication_completeness_errors(text, text) is
  'R4.10: the database-level floor a record must meet before publish_record may make it '
  'public. Empty array = publishable. UI validation can be stricter; it can never be the '
  'only line, because RPCs are callable without the UI.';

-- ----------------------------------------------------------------------------
-- 2. publish_record: the explicit matrix, AAL2, completeness — then the same
--    proven mechanics as the chain-75 repair (text ids, count-based existence,
--    one column on one row, an audit event every time, SECURITY INVOKER so
--    RLS remains the second gate behind the explicit first one).
-- ----------------------------------------------------------------------------
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
  v_errors  text[];
begin
  -- 2a. Allow-list: each collection's SINGLE publication column.
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

  -- 2b. WHO. current_staff_role() already resolves anonymous and DISABLED
  --     sessions to null (stage 9), so one check names both refusals.
  v_role := current_staff_role();
  if v_role is null then
    raise exception 'publish_record: publishing requires an active staff account '
      '(anonymous and disabled sessions are refused)'
      using errcode = 'insufficient_privilege';
  end if;

  -- 2c. ASSURANCE. Publication changes what the public sees; a password-only
  --     session may not do that. Same AAL2 rule the RLS helpers enforce —
  --     stated here so the caller learns WHY, not just that zero rows changed.
  if not is_aal2() then
    raise exception 'publish_record: publishing requires a verified second factor (AAL2). '
      'Complete the TOTP step and try again.'
      using errcode = 'insufficient_privilege';
  end if;

  -- 2d. THE MATRIX, explicitly. Mirrors the RLS write policies exactly:
  --     owner → all six; store_manager → menu_items only; everyone else → no.
  if v_role = 'owner' then
    null; -- all six collections
  elsif v_role = 'store_manager' then
    if p_table <> 'menu_items' then
      raise exception 'publish_record: a store manager may publish menu items only — % requires the owner', p_table
        using errcode = 'insufficient_privilege';
    end if;
  else
    raise exception 'publish_record: role % may not publish', v_role
      using errcode = 'insufficient_privilege';
  end if;

  -- 2e. Exactly one row exists (counted, because a publication column can
  --     legitimately be null).
  execute format('select count(*) from %I where id = $1', p_table) into v_exists using p_id;
  if v_exists <> 1 then
    raise exception 'publish_record: expected exactly 1 % row with id %, found %',
      p_table, p_id, v_exists using errcode = 'no_data_found';
  end if;

  -- 2f. COMPLETENESS — publishing only. Unpublishing is retraction and is
  --     never blocked by the record's own state.
  if p_publish then
    v_errors := publication_completeness_errors(p_table, p_id);
    if coalesce(array_length(v_errors, 1), 0) > 0 then
      raise exception 'publish_blocked_incomplete: % % — %',
        p_table, p_id, array_to_string(v_errors, '; ')
        using errcode = 'check_violation';
    end if;
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

  insert into audit_logs (id, operator_name, role, action, timestamp, module,
                          previous_value, new_value)
  values (
    'aud_' || replace(gen_random_uuid()::text, '-', ''),
    coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', 'unknown'),
    v_role,
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

-- The shim (and real Supabase) grant EXECUTE on new functions to anon through
-- default privileges; `revoke … from public` alone does not touch that grant.
revoke all on function publish_record(text, text, boolean) from public, anon;
grant execute on function publish_record(text, text, boolean) to authenticated;

comment on function publish_record(text, text, boolean) is
  'R4.10: the ONLY way publication state changes. Explicit matrix (owner+AAL2: all six; '
  'store_manager+AAL2: menu_items only), completeness enforced on publish, retraction always '
  'allowed, one column on one row, an audit event every time. SECURITY INVOKER — RLS stays '
  'the gate behind the explicit refusals.';

-- ----------------------------------------------------------------------------
-- 3. The snapshot guard, totals now mandatory. Message 'collection_snapshot_stale'
--    is kept verbatim; the truncation branch is retired (header explains why).
-- ----------------------------------------------------------------------------
create or replace function assert_full_collection_snapshot(
  p_table text,
  p_rows jsonb,
  p_expected_total integer
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_visible integer;
begin
  if p_expected_total is null then
    raise exception
      'collection_snapshot_total_required: state how many % rows the snapshot was taken '
      'over. A publisher that cannot say what it loaded must not replace the collection.',
      p_table
      using errcode = 'check_violation';
  end if;

  execute format('select count(*) from %I', p_table) into v_visible;

  if p_expected_total <> v_visible then
    raise exception
      'collection_snapshot_stale: % holds % row(s) but the publisher believed it held %. '
      'The snapshot was taken before the table changed, or it came from a filtered '
      'projection. Re-hydrate from the authenticated collection and publish again.',
      p_table, v_visible, p_expected_total
      using errcode = 'check_violation';
  end if;
end
$$;

revoke all on function assert_full_collection_snapshot(text, jsonb, integer) from public, anon;
grant execute on function assert_full_collection_snapshot(text, jsonb, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. replace_collection: three arguments, lifecycle stripped, total enforced.
--    Same allow-list, same per-row upsert semantics, same audit row, same
--    final contract check as the FIX-7 body it supersedes. The two-argument
--    signature is DROPPED — a caller that cannot state its snapshot total has
--    no business replacing a collection.
-- ----------------------------------------------------------------------------
drop function if exists replace_collection(text, jsonb);

create or replace function replace_collection(p_table text, p_rows jsonb, p_expected_total integer)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_pk       text;
  v_life     text;
  v_row      jsonb;
  v_cols     text;
  v_sets     text;
  v_ids      text[];
  v_final    jsonb;
begin
  -- 4a. Allow-list, with each publishable collection's LIFECYCLE column.
  --     A null lifecycle means the collection has no public projection and no
  --     publication state to protect (internal collections). `stores` keeps
  --     `status` writable here deliberately: store opening is not a
  --     publish_record concern — it is guarded row-by-row by the always-on
  --     open-store invariant (migration_r410_candidate_state.sql), and a
  --     stale snapshot attempting to flip it is refused by the total check
  --     before any row is touched.
  select pk, life into v_pk, v_life from (values
    ('menu_items',           'id',   'available'),
    ('stores',               'id',   null),
    ('job_vacancies',        'id',   'status'),
    ('kb_articles',          'id',   null),
    ('news_posts',           'id',   'status'),
    ('media_assets',         'id',   'is_public'),
    ('deals',                'id',   'active'),
    ('checklist_templates',  'id',   null),
    ('training_courses',     'id',   null),
    ('training_assessments', 'id',   null),
    ('training_assignments', 'id',   null),
    ('role_permissions',     'role', null)
  ) as t(tbl, pk, life) where t.tbl = p_table;
  if v_pk is null then
    raise exception 'table_not_allowed';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows_must_be_array';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'too_many_rows';
  end if;

  -- 4b. STALE SNAPSHOTS ARE REFUSED BEFORE ANYTHING IS DELETED. The caller
  --     states the count it hydrated; if the collection has changed since —
  --     or the caller hydrated a filtered projection — nothing happens.
  perform assert_full_collection_snapshot(p_table, p_rows, p_expected_total);

  -- 4c. Every payload row must carry the primary key.
  if exists (select 1 from jsonb_array_elements(p_rows) e
              where not (e.value ? v_pk) or coalesce(e.value->>v_pk, '') = '') then
    raise exception 'row_missing_primary_key';
  end if;
  select coalesce(array_agg(value->>v_pk), '{}') into v_ids
    from jsonb_array_elements(p_rows);

  -- 4d. DELETE everything the CALLER can see that is not in the new payload.
  if v_ids is null or array_length(v_ids, 1) is null then
    execute format('delete from %I', p_table);
  else
    execute format('delete from %I where %I <> all($1)', p_table, v_pk) using v_ids;
  end if;

  -- 4e. UPSERT every payload row using ONLY the columns that row provides —
  --     with the LIFECYCLE COLUMN STRIPPED FIRST. An absent key means an
  --     existing row keeps its stored value and a new row takes the column
  --     default (draft / false), so this one subtraction is the whole rule:
  --     publication state cannot arrive through this function, whatever the
  --     payload says. Only publish_record changes it.
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if v_life is not null then
      v_row := v_row - v_life;
    end if;
    select string_agg(format('%I', k), ', '),
           string_agg(case when k = v_pk then null
                           else format('%I = excluded.%I', k, k) end, ', ')
      into v_cols, v_sets
      from jsonb_object_keys(v_row) as k;
    execute format(
      'insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1)
       on conflict (%I) do update set %s',
      p_table, v_cols, v_cols, p_table, v_pk,
      coalesce(v_sets, format('%I = excluded.%I', v_pk, v_pk))
    ) using v_row;
  end loop;

  -- 4f. Server-side audit row (actor derived here).
  insert into audit_logs (id, operator_name, role, action, timestamp, module)
  select 'aud_' || replace(gen_random_uuid()::text, '-', ''),
         coalesce(sp.name, current_staff_id()),
         coalesce(sp.role::text, ''),
         'Replaced collection "' || p_table || '" (' || jsonb_array_length(p_rows) ||
           ' rows; publication state preserved server-side)',
         now()::text,
         'Publishing (server)'
    from staff_profiles sp where sp.id = current_staff_id();

  -- 4g. Contract check + the final collection AS THE CALLER SEES IT.
  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from %I t', p_table)
    into v_final;
  if (select count(*) from jsonb_array_elements(v_final) e
       where not (e.value->>v_pk = any(coalesce(v_ids, '{}')))) > 0 then
    raise exception 'stale_rows_not_deletable' using errcode = '42501';
  end if;

  return v_final;
end $$;

revoke all on function replace_collection(text, jsonb, integer) from public, anon;
grant execute on function replace_collection(text, jsonb, integer) to authenticated;

comment on function replace_collection(text, jsonb, integer) is
  'R4.10: whole-collection CONTENT replacement. The snapshot total is mandatory (stale and '
  'filtered snapshots are refused before any delete), and each publishable collection''s '
  'lifecycle column is stripped from every payload row — existing rows keep their stored '
  'publication state, new rows land as drafts, and only publish_record may change either.';

-- ----------------------------------------------------------------------------
-- ACCEPTANCE — structural. The behavioural evidence lives in two suites that
-- can establish real sessions, which a migration cannot (the chain-75 lesson:
-- a migration must not fabricate a staff identity to test itself):
--   • scripts/r410-publication-authz.test.mjs — the full role/AAL matrix,
--     executed as the REAL `authenticated` database role, not the superuser.
--   • scripts/r410-lifecycle-preservation.test.mjs — replace_collection
--     preserving publication state and refusing stale snapshots.
-- ----------------------------------------------------------------------------
do $acceptance$
begin
  if to_regprocedure('public.replace_collection(text, jsonb)') is not null then
    raise exception 'r410_publication_boundary: the two-argument replace_collection still exists';
  end if;
  if to_regprocedure('public.replace_collection(text, jsonb, integer)') is null then
    raise exception 'r410_publication_boundary: the three-argument replace_collection is absent';
  end if;
  if to_regprocedure('public.publication_completeness_errors(text, text)') is null then
    raise exception 'r410_publication_boundary: the completeness rule is absent';
  end if;
  if to_regprocedure('public.publish_record(text, text, boolean)') is null then
    raise exception 'r410_publication_boundary: publish_record is absent';
  end if;
end
$acceptance$;
