-- ============================================================================
--  MILK POP — MIGRATION FIX-7: SENSITIVE COLLECTIONS LEAVE "REPLACE-ALL"
--
--  Run order: after migration_stage11_server_audit.sql (and after
--  migration_stage7_replace_collection.sql, which it partially supersedes).
--  Safe to re-run. migration_phase_b_public_forms.sql stays LAST.
--
--  PROBLEM (final-fixes audit, FIX-7): replace_collection deletes every row
--  the caller can see that is absent from the submitted snapshot. For content
--  collections that matches the editor's intent. For clock_history and
--  payslips it is a data-loss hazard even with a SINGLE admin, because those
--  tables have a second, concurrent writer: staff clocking out append
--  clock_history rows on their own. An owner who hydrated the payroll screen,
--  waited, then approved a timesheet would silently DELETE any shift recorded
--  in between — the stale snapshot simply doesn't contain it, and the owner's
--  RLS lets the delete through, so the stage-7 contract check never fires.
--
--  FIX (two halves, both in this file):
--    1. clock_history and payslips are REMOVED from replace_collection's
--       allow-list — replace-all can no longer touch payroll/time data.
--    2. A new invoker-rights RPC, apply_collection_changes(table, upserts,
--       delete_ids), serves those two tables with EXPLICIT semantics:
--       it upserts exactly the rows the caller changed and deletes exactly
--       the ids the caller named — never "everything not in the snapshot".
--       A concurrent row added by someone else is neither upserted nor
--       named for deletion, so it survives untouched. Deleting therefore
--       becomes possible ONLY by explicit action (TZ acceptance criterion).
--
--  CONTENT COLLECTIONS (menu, stores, news, …) — assessed, deliberately
--  unchanged: they have a single writer class (admins), one admin exists at
--  launch, replace-all remains atomic + RLS-scoped, and the worst case is a
--  lost content edit rather than lost money/time records. Optimistic locking
--  (stale-snapshot rejection via max(updated_at)) is the documented
--  post-launch hardening path if the admin team grows.
--
--  SECURITY MODEL — SECURITY INVOKER, exactly like stage 7: every statement
--  runs as the caller, authorised by the caller's own RLS policies and
--  grants. clock_history has NO delete policy for browser clients, so even a
--  malicious explicit-delete request affects 0 rows and the contract check
--  below aborts the transaction — the table is effectively append-only+update.
--  payslips deletes remain owner-only (payslips_write_owner, FOR ALL).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. replace_collection: same body as stage 7, minus the two sensitive tables.
-- ----------------------------------------------------------------------------
create or replace function replace_collection(p_table text, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_pk       text;
  v_row      jsonb;
  v_cols     text;
  v_sets     text;
  v_ids      text[];
  v_final    jsonb;
begin
  -- 1. Allow-list: publishable CONTENT collections only, each with its
  --    primary key. clock_history and payslips are deliberately ABSENT —
  --    they are served by apply_collection_changes() below (FIX-7).
  v_pk := case p_table
    when 'menu_items'           then 'id'
    when 'stores'               then 'id'
    when 'job_vacancies'        then 'id'
    when 'kb_articles'          then 'id'
    when 'news_posts'           then 'id'
    when 'media_assets'         then 'id'
    when 'deals'                then 'id'
    when 'checklist_templates'  then 'id'
    when 'training_courses'     then 'id'
    when 'training_assessments' then 'id'
    when 'training_assignments' then 'id'
    when 'role_permissions'     then 'role'
    else null
  end;
  if v_pk is null then
    raise exception 'table_not_allowed';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows_must_be_array';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'too_many_rows';
  end if;

  -- 2. Every payload row must carry the primary key.
  if exists (select 1 from jsonb_array_elements(p_rows) e
              where not (e.value ? v_pk) or coalesce(e.value->>v_pk, '') = '') then
    raise exception 'row_missing_primary_key';
  end if;
  select coalesce(array_agg(value->>v_pk), '{}') into v_ids
    from jsonb_array_elements(p_rows);

  -- 3. DELETE everything the CALLER can see that is not in the new payload.
  --    RLS delete policies scope this; rows the caller may see but not
  --    delete are caught by the contract check in step 5, which aborts and
  --    rolls the whole replacement back.
  if v_ids is null or array_length(v_ids, 1) is null then
    execute format('delete from %I', p_table);
  else
    execute format('delete from %I where %I <> all($1)', p_table, v_pk) using v_ids;
  end if;

  -- 4. UPSERT every payload row using ONLY the columns that row provides
  --    (PostgREST semantics: absent keys keep column defaults / stored
  --    values). jsonb_populate_record performs the type conversions the
  --    table declares — ints, bools, dates, numerics and jsonb columns.
  for v_row in select value from jsonb_array_elements(p_rows) loop
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

  -- 5. Server-side audit row for the publication (actor derived here).
  insert into audit_logs (id, operator_name, role, action, timestamp, module)
  select 'aud_' || replace(gen_random_uuid()::text, '-', ''),
         coalesce(sp.name, current_staff_id()),
         coalesce(sp.role::text, ''),
         'Published collection "' || p_table || '" (' || jsonb_array_length(p_rows) || ' rows)',
         now()::text,
         'Publishing (server)'
    from staff_profiles sp where sp.id = current_staff_id();

  -- 6. Contract check + the final collection AS THE CALLER SEES IT.
  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from %I t', p_table)
    into v_final;
  if (select count(*) from jsonb_array_elements(v_final) e
       where not (e.value->>v_pk = any(coalesce(v_ids, '{}')))) > 0 then
    raise exception 'stale_rows_not_deletable' using errcode = '42501';
  end if;

  return v_final;
end $$;

revoke all on function replace_collection(text, jsonb) from public;
grant execute on function replace_collection(text, jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. apply_collection_changes: explicit upserts + explicit deletes, ONE
--    transaction, for the two money/time collections only.
-- ----------------------------------------------------------------------------
create or replace function apply_collection_changes(
  p_table      text,
  p_upserts    jsonb,
  p_delete_ids text[]
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_pk       text;
  v_row      jsonb;
  v_cols     text;
  v_sets     text;
  v_del      text[];
  v_final    jsonb;
  v_upserts  int;
  v_hit      int;
begin
  -- 1. Allow-list: ONLY the sensitive collections that replace-all must
  --    never touch again. Both are keyed by `id`.
  v_pk := case p_table
    when 'clock_history' then 'id'
    when 'payslips'      then 'id'
    else null
  end;
  if v_pk is null then
    raise exception 'table_not_allowed';
  end if;
  if p_upserts is null or jsonb_typeof(p_upserts) <> 'array' then
    raise exception 'rows_must_be_array';
  end if;
  if jsonb_array_length(p_upserts) > 2000
     or coalesce(array_length(p_delete_ids, 1), 0) > 2000 then
    raise exception 'too_many_rows';
  end if;
  v_upserts := jsonb_array_length(p_upserts);
  v_del := (select coalesce(array_agg(x), '{}') from unnest(coalesce(p_delete_ids, '{}')) as x
             where coalesce(x, '') <> '');

  -- 2. Every upsert row must carry the primary key, and no row may be both
  --    upserted and deleted in the same call (ambiguous intent → reject).
  if exists (select 1 from jsonb_array_elements(p_upserts) e
              where not (e.value ? v_pk) or coalesce(e.value->>v_pk, '') = '') then
    raise exception 'row_missing_primary_key';
  end if;
  if exists (select 1 from jsonb_array_elements(p_upserts) e
              where (e.value->>v_pk) = any(v_del)) then
    raise exception 'row_both_upserted_and_deleted';
  end if;

  -- 3. DELETE exactly the named ids — nothing implicit, ever. RLS delete
  --    policies scope this (clock_history exposes none to browser clients;
  --    payslips deletes are owner-only).
  if array_length(v_del, 1) is not null then
    execute format('delete from %I where %I = any($1)', p_table, v_pk) using v_del;
  end if;

  -- 4. UPSERT exactly the submitted rows — UPDATE-FIRST, insert only when the
  --    row does not exist. This is deliberate and load-bearing: Postgres
  --    evaluates INSERT policies' WITH CHECK on every row proposed to
  --    `insert ... on conflict do update`, even when the update path would be
  --    taken — so a manager/owner (who may UPDATE a staff clock row via
  --    clock_update_mgr but holds no INSERT right over it, clock_insert_self
  --    being self-only) can never "upsert" it. Updating first routes the
  --    common case (amending an existing row) through the UPDATE policies
  --    that actually authorise it; only a genuinely new row takes the INSERT
  --    path and faces the INSERT policy. A row the caller cannot SEE updates
  --    0 rows, falls to INSERT, and aborts on the primary key / RLS — the
  --    whole transaction rolls back, fail-closed.
  --    As in stage 7, each row writes ONLY the columns it provides; absent
  --    keys keep stored values, and jsonb_populate_record applies the
  --    table-declared type conversions.
  for v_row in select value from jsonb_array_elements(p_upserts) loop
    select string_agg(format('%I', k), ', '),
           string_agg(case when k = v_pk then null
                           else format('%I = src.%I', k, k) end, ', ')
      into v_cols, v_sets
      from jsonb_object_keys(v_row) as k;
    v_hit := 0;
    if v_sets is not null then
      execute format(
        'update %I t set %s from jsonb_populate_record(null::%I, $1) src where t.%I = src.%I',
        p_table, v_sets, p_table, v_pk, v_pk
      ) using v_row;
      get diagnostics v_hit = row_count;
    else
      -- pk-only payload: nothing to change; treat "caller can see it" as done.
      execute format('select count(*) from %I where %I = $1', p_table, v_pk)
        into v_hit using (v_row->>v_pk);
    end if;
    if v_hit = 0 then
      execute format(
        'insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1)',
        p_table, v_cols, v_cols, p_table
      ) using v_row;
    end if;
  end loop;

  -- 5. Server-side audit row (actor derived here; stage-11 trigger stamps it).
  insert into audit_logs (id, operator_name, role, action, timestamp, module)
  select 'aud_' || replace(gen_random_uuid()::text, '-', ''),
         coalesce(sp.name, current_staff_id()),
         coalesce(sp.role::text, ''),
         'Applied changes to "' || p_table || '" (' || v_upserts || ' upserted, '
           || coalesce(array_length(v_del, 1), 0) || ' deleted)',
         now()::text,
         'Publishing (server)'
    from staff_profiles sp where sp.id = current_staff_id();

  -- 6. Contract check: every explicitly named delete must actually be gone
  --    (a delete RLS silently filtered → 42501, whole transaction rolls
  --    back), then return the collection AS THE CALLER SEES IT.
  if array_length(v_del, 1) is not null then
    execute format('select count(*) from %I where %I = any($1)', p_table, v_pk)
      into v_upserts using v_del;  -- reuse int var
    if v_upserts > 0 then
      raise exception 'requested_rows_not_deletable' using errcode = '42501';
    end if;
  end if;

  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from %I t', p_table)
    into v_final;
  return v_final;
end $$;

revoke all on function apply_collection_changes(text, jsonb, text[]) from public;
grant execute on function apply_collection_changes(text, jsonb, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- HANDOVER NOTES
-- ---------------------------------------------------------------------------
-- • SECURITY INVOKER on both functions: this migration grants NO new data
--   power — it removes an implicit-delete footgun and adds atomicity, not
--   privilege. RLS remains the sole authority on every row touched.
-- • Client pairing: src/lib/registries.ts applyCollectionChanges() +
--   the diff publisher in src/App.tsx (publishClockHistory/publishPayslips).
--   The client sends ONLY changed rows and ONLY explicitly removed ids.
-- • Re-running this file is safe (create or replace / revoke / grant).
