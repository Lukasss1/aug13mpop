-- ============================================================================
--  MILK POP — INC11 : COLLECTION REVISIONS — the edit-edit concurrency guard
--
--  WHAT THE SNAPSHOT TOTAL CANNOT SEE (the v3 finding this file closes)
--  --------------------------------------------------------------------
--  Increment 10 made replace_collection refuse a snapshot whose stated TOTAL
--  no longer matches the table — which catches every add and every remove the
--  caller never saw. It cannot catch a SAME-COUNT change: the owner edits a
--  row, a store manager's stale tab then saves its older copy of all N rows
--  with total N, the guard compares N to N, and the owner's edit is silently
--  overwritten. With launch provisioning a manager who edits the menu, that
--  lost update is in scope on day one.
--
--  THE MECHANISM
--  -------------
--  One monotonic revision per replaceable collection:
--
--    collection_revisions(table_key primary key, revision bigint)
--
--  Every row write to an allow-listed table bumps its collection's revision
--  through an AFTER trigger (lazy upsert — no seeding step, correct on fresh
--  installs and upgrades alike). Hydration reads {revision, rows}; the
--  publisher states the revision it hydrated; replace_collection locks the
--  revision row, refuses a mismatch BEFORE anything is deleted, performs the
--  replacement (its own writes bump the counter), and returns the new
--  revision with the authoritative rows.
--
--  Why row-level bump triggers rather than bumping only inside the RPC: a
--  direct single-row write by an owner (a path the UI does not use, but the
--  API allows) would otherwise leave the counter stale, and a later
--  whole-collection save from an older tab would pass the check while
--  reverting that write. With row-level bumps, EVERY write path invalidates
--  stale editors — including publication changes, which is deliberate: after
--  a publish, an editor should re-hydrate before replacing the collection.
--
--  The revision check REPLACES nothing: the total stays as the secondary
--  defence (a caller that states both a fresh revision and a wrong total is
--  confused in a way worth refusing), and the error name for both is the
--  already-pinned `collection_snapshot_stale`.
--
--  CONTRACT CHANGE, deliberate and breaking: replace_collection now returns
--    { "revision": <bigint>, "rows": [...] }
--  instead of the bare rows array, and takes a fourth argument. The
--  three-argument signature is DROPPED — a caller that cannot state what it
--  hydrated has no business replacing a collection (the same reasoning that
--  removed the two-argument form in Increment 10).
--
--  APPEND-ONLY: no previously applied migration file is edited.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The revision ledger. RLS on; authenticated may read (editors need the
--    revision at hydration); nobody writes it directly — the trigger and the
--    RPC are the only writers, and they run as definer/invoker paths that
--    end in the same lazy upsert.
-- ----------------------------------------------------------------------------
create table if not exists collection_revisions (
  table_key  text primary key,
  revision   bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table collection_revisions enable row level security;

drop policy if exists collection_revisions_read on collection_revisions;
create policy collection_revisions_read on collection_revisions
  for select to authenticated using (true);

revoke all on collection_revisions from anon;
grant select on collection_revisions to authenticated;

comment on table collection_revisions is
  'INC11: one monotonic revision per replaceable collection. Bumped by row '
  'triggers on every write; read at hydration; checked (FOR UPDATE) by '
  'replace_collection so a stale tab cannot overwrite a same-count edit.';

-- ----------------------------------------------------------------------------
-- 2. The bump. SECURITY DEFINER because the writer of a row (a manager under
--    RLS) has no INSERT/UPDATE grant on the ledger — the trigger runs the
--    upsert with the function owner's rights, which is exactly the "server-
--    controlled counter" the guard needs.
-- ----------------------------------------------------------------------------
create or replace function bump_collection_revision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into collection_revisions as cr (table_key, revision, updated_at)
  values (TG_TABLE_NAME, 1, now())
  on conflict (table_key) do update
    set revision = cr.revision + 1, updated_at = now();
  return null;  -- AFTER trigger; the row itself is untouched
end $$;

revoke all on function bump_collection_revision() from public, anon, authenticated;

do $triggers$
declare t text;
begin
  foreach t in array array[
    'menu_items','stores','job_vacancies','kb_articles','news_posts',
    'media_assets','deals','checklist_templates','training_courses',
    'training_assessments','training_assignments','role_permissions']
  loop
    execute format('drop trigger if exists trg_zz_collection_revision on %I', t);
    execute format(
      'create trigger trg_zz_collection_revision
         after insert or update or delete on %I
         for each row execute function bump_collection_revision()', t);
  end loop;
end $triggers$;


-- ----------------------------------------------------------------------------
-- 2b. The checkpoint: lazily create the ledger row, LOCK it for this
--     transaction, return the revision. SECURITY DEFINER because the calling
--     RPCs are SECURITY INVOKER and the caller has no write privilege on the
--     ledger (deliberately — nobody sets a revision through the API). The
--     helper can only read-and-lock; it cannot move the counter.
-- ----------------------------------------------------------------------------
create or replace function collection_revision_checkpoint(p_table text)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_rev bigint;
begin
  insert into collection_revisions (table_key) values (p_table)
  on conflict (table_key) do nothing;
  select revision into v_rev
    from collection_revisions where table_key = p_table
    for update;
  return v_rev;
end $$;

revoke all on function collection_revision_checkpoint(text) from public, anon;
grant execute on function collection_revision_checkpoint(text) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. replace_collection v5: four arguments, {revision, rows} result.
--    The three-argument form is dropped. Everything Increment 10 built stays:
--    the mandatory total, the lifecycle-column strip, the allow-list, the
--    per-row provided-columns upsert, the audit row, the final contract
--    check. What is added: the revision lock-and-check FIRST (it also
--    serialises concurrent replaces of the same collection), and the new
--    return shape.
-- ----------------------------------------------------------------------------
drop function if exists replace_collection(text, jsonb, integer);

create or replace function replace_collection(
  p_table text,
  p_rows jsonb,
  p_expected_total integer,
  p_expected_revision bigint
) returns jsonb
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
  v_rev      bigint;
begin
  -- 3a. Allow-list (unchanged from Increment 10, lifecycle columns included).
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

  -- 3b. THE REVISION CHECK, before anything else touches data. The lazy
  --     insert makes the ledger row exist on first contact; FOR UPDATE
  --     serialises concurrent replaces and blocks row-trigger bumps from
  --     other transactions until this one decides.
  v_rev := collection_revision_checkpoint(p_table);
  if p_expected_revision is null then
    raise exception
      'collection_revision_required: state the revision your snapshot of % was '
      'hydrated at. A publisher that cannot say what it loaded must not replace '
      'the collection.', p_table
      using errcode = 'check_violation';
  end if;
  if p_expected_revision <> v_rev then
    raise exception
      'collection_snapshot_stale: % is at revision % but the publisher hydrated '
      'revision %. Someone changed the collection since — re-hydrate and apply '
      'your edit to the current state.',
      p_table, v_rev, p_expected_revision
      using errcode = 'check_violation';
  end if;

  -- 3c. The total stays as the secondary defence (Increment 10 semantics,
  --     message unchanged).
  perform assert_full_collection_snapshot(p_table, p_rows, p_expected_total);

  -- 3d. Primary keys present on every row.
  if exists (select 1 from jsonb_array_elements(p_rows) e
              where not (e.value ? v_pk) or coalesce(e.value->>v_pk, '') = '') then
    raise exception 'row_missing_primary_key';
  end if;
  select coalesce(array_agg(value->>v_pk), '{}') into v_ids
    from jsonb_array_elements(p_rows);

  -- 3e. Delete what the caller can see that is not in the payload.
  if v_ids is null or array_length(v_ids, 1) is null then
    execute format('delete from %I', p_table);
  else
    execute format('delete from %I where %I <> all($1)', p_table, v_pk) using v_ids;
  end if;

  -- 3f. Upsert each row from ONLY its provided columns, lifecycle stripped
  --     first (existing rows keep server truth; new rows land as drafts).
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

  -- 3g. Audit (unchanged).
  insert into audit_logs (id, operator_name, role, action, timestamp, module)
  select 'aud_' || replace(gen_random_uuid()::text, '-', ''),
         coalesce(sp.name, current_staff_id()),
         coalesce(sp.role::text, ''),
         'Replaced collection "' || p_table || '" (' || jsonb_array_length(p_rows) ||
           ' rows; publication state preserved server-side)',
         now()::text,
         'Publishing (server)'
    from staff_profiles sp where sp.id = current_staff_id();

  -- 3h. Contract check + the caller's view of the result, WITH the new
  --     revision (this transaction's own bumps are visible here).
  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from %I t', p_table)
    into v_final;
  if (select count(*) from jsonb_array_elements(v_final) e
       where not (e.value->>v_pk = any(coalesce(v_ids, '{}')))) > 0 then
    raise exception 'stale_rows_not_deletable' using errcode = '42501';
  end if;

  select revision into v_rev from collection_revisions where table_key = p_table;
  return jsonb_build_object('revision', v_rev, 'rows', v_final);
end $$;

revoke all on function replace_collection(text, jsonb, integer, bigint) from public, anon;
grant execute on function replace_collection(text, jsonb, integer, bigint) to authenticated;

comment on function replace_collection(text, jsonb, integer, bigint) is
  'INC11: whole-collection CONTENT replacement. The caller states BOTH the row '
  'total and the collection revision it hydrated; a mismatch of either refuses '
  'the call as stale before any delete. Lifecycle columns are stripped (only '
  'publish_record/close_vacancy change them). Returns {revision, rows}.';

-- ----------------------------------------------------------------------------
-- ACCEPTANCE — structural. Behaviour (the edit-edit refusal, the serialised
-- concurrent replace, the {revision, rows} contract) needs real sessions and
-- lives in scripts/inc11-revision-guard.test.mjs.
-- ----------------------------------------------------------------------------
do $acceptance$
begin
  if to_regprocedure('public.replace_collection(text, jsonb, integer)') is not null then
    raise exception 'inc11_revisions: the three-argument replace_collection still exists';
  end if;
  if to_regprocedure('public.replace_collection(text, jsonb, integer, bigint)') is null then
    raise exception 'inc11_revisions: the four-argument replace_collection is absent';
  end if;
  if to_regclass('public.collection_revisions') is null then
    raise exception 'inc11_revisions: the revision ledger is absent';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgname = 'trg_zz_collection_revision'
       and tgrelid = 'public.menu_items'::regclass) then
    raise exception 'inc11_revisions: the bump trigger is missing on menu_items';
  end if;
end
$acceptance$;
