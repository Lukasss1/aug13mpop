-- ============================================================================
--  MILK POP — MIGRATION S7 (STAGE 7): ATOMIC COLLECTION PUBLISHING
--
--  Run order: after migration_rls_per_role.sql. Safe to re-run.
--
--  BEFORE: publishing a collection (menu, checklists, rota corrections, the
--  permission matrix…) ran as a client-side sequence of DELETEs and UPSERTs.
--  A failure mid-sequence left the table half old / half new.
--
--  AFTER: `replace_collection(table, rows)` performs the whole replacement in
--  ONE transaction — either every delete and every upsert commits, or none.
--
--  SECURITY MODEL — deliberately SECURITY INVOKER:
--    the function runs AS THE CALLER, so every statement inside it is
--    authorised by the SAME row-level-security policies and column grants
--    that govern direct table access. There is no second permission matrix
--    to keep in sync: a manager can atomically replace what a manager may
--    write; the owner-only tables stay owner-only; anything RLS denies
--    aborts and rolls back the entire replacement. The table allow-list
--    below only prevents dynamic-SQL access to tables that were never meant
--    for collection publishing.
-- ============================================================================

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
  -- 1. Allow-list: publishable collections only, each with its primary key.
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
    when 'clock_history'        then 'id'
    when 'payslips'             then 'id'
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

-- ---------------------------------------------------------------------------
-- HANDOVER NOTES
-- ---------------------------------------------------------------------------
-- • SECURITY INVOKER means this migration grants NO new data power: the RPC
--   can only do what the caller's own policies already allow — it adds
--   atomicity, not privilege.
-- • Postgres casts the text values to each column's declared type (ints,
--   bools, dates, numerics); object/array values are passed as their JSON
--   text and cast to jsonb by the column type. A cast failure aborts the
--   whole transaction — which is the correct fail-closed behaviour.
