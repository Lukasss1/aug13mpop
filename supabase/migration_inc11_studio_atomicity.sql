-- ============================================================================
--  MILK POP — INC11 : SINGLETON GUARDS + ATOMIC WEBSITE-STUDIO SAVE
--
--  WHAT THE REVIEW PROVED (and what this session verified at source):
--    • WebsiteStudio's Publish was TWO transactions (content save, then
--      settings save) — a failure between them leaves a torn publish.
--    • The three configuration singletons (site_content, site_settings,
--      launch_settings) had NO concurrency guard at all: two owner tabs
--      last-write-wins clobber each other silently — the same lost-update
--      family the collection revision guard closed for the 12 collections.
--    • VERIFIED DEFECT (this session): the client singleton repo upserts
--      with id:'singleton' against INTEGER primary keys — every real cloud
--      save of site_settings/site_content is a type error
--      (invalid input syntax for type integer: "singleton"). The seeded
--      rows are id = 1; launch_settings is id = true.
--
--  THE MODEL THIS FILE INSTALLS
--  ----------------------------
--  1. The three singletons join the SAME revision ledger the collections
--     use (collection_revisions + the existing SECURITY DEFINER bump
--     trigger) — one concurrency vocabulary across the whole admin surface.
--  2. Direct API-role writes to the singletons are CLOSED by the same
--     sanctioned-context pattern as the publication boundary: a
--     transaction-local GUC set only by the save RPCs (superuser exempt for
--     seed/harness). RLS remains beneath as defence in depth.
--  3. save_website_studio(...) — ONE transaction that verifies the expected
--     revision of every part it touches, applies both singletons, writes a
--     server-side audit row with the DERIVED actor, and returns the new
--     revisions. A failure anywhere rolls the whole publish back.
--  4. save_launch_settings(...) — the same machinery for the launch-facts
--     panel (partial-patch semantics preserved; updated_by is now DERIVED
--     server-side from the caller's staff row, never client-supplied).
--
--  APPEND-ONLY: no previously applied migration file is edited.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Revision plumbing: the singletons join the collection ledger.
-- ----------------------------------------------------------------------------
drop trigger if exists trg_zz_collection_revision on site_settings;
create trigger trg_zz_collection_revision
  after insert or update or delete on site_settings
  for each row execute function bump_collection_revision();

drop trigger if exists trg_zz_collection_revision on site_content;
create trigger trg_zz_collection_revision
  after insert or update or delete on site_content
  for each row execute function bump_collection_revision();

drop trigger if exists trg_zz_collection_revision on launch_settings;
create trigger trg_zz_collection_revision
  after insert or update or delete on launch_settings
  for each row execute function bump_collection_revision();

-- The collections earned their ledger rows lazily through years of writes;
-- a singleton's FIRST save must not dead-end on a row that does not exist
-- yet (client hydrates NULL → revision_required → no way in). Seed the three
-- rows at revision 0 so hydration always returns a number.
insert into collection_revisions (table_key, revision)
values ('site_settings', 0), ('site_content', 0), ('launch_settings', 0)
on conflict (table_key) do nothing;

-- ----------------------------------------------------------------------------
-- 2. Sanctioned-context guard: API roles write singletons ONLY through the
--    save RPCs. Same GUC family as the publication boundary; DELETE of a
--    configuration singleton is refused for every API role unconditionally.
-- ----------------------------------------------------------------------------
create or replace function assert_singleton_write_sanctioned()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_setting('is_superuser') = 'on' then
    if TG_OP = 'DELETE' then return old; end if;
    return new;
  end if;

  if TG_OP = 'DELETE' then
    raise exception
      'singleton_delete_refused: % is a configuration singleton — it is never deleted',
      TG_TABLE_NAME
      using errcode = 'check_violation';
  end if;

  if current_setting('milkpop.singleton_rpc', true) = '1' then
    if TG_OP = 'DELETE' then return old; end if;
    return new;
  end if;

  raise exception
    'singleton_write_refused: % is written only through its save RPC '
    '(save_website_studio / save_launch_settings), which verifies the '
    'expected revision and records the audit row in the same transaction',
    TG_TABLE_NAME
    using errcode = 'check_violation';
end $$;

drop trigger if exists trg_singleton_guard on site_settings;
create trigger trg_singleton_guard
  before insert or update or delete on site_settings
  for each row execute function assert_singleton_write_sanctioned();

drop trigger if exists trg_singleton_guard on site_content;
create trigger trg_singleton_guard
  before insert or update or delete on site_content
  for each row execute function assert_singleton_write_sanctioned();

drop trigger if exists trg_singleton_guard on launch_settings;
create trigger trg_singleton_guard
  before insert or update or delete on launch_settings
  for each row execute function assert_singleton_write_sanctioned();

-- ----------------------------------------------------------------------------
-- 3. Column-typed payload application. One helper, three whitelisted tables.
--    Unknown payload keys are IGNORED; the primary key and the columns the
--    SERVER owns (created_at, updated_at, updated_by) are never taken from
--    the payload. Dynamic SQL is confined to quote_ident over
--    information_schema names — no client string ever becomes an identifier.
-- ----------------------------------------------------------------------------
create or replace function singleton_apply_payload(p_table text, p_payload jsonb, p_updated_by text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pk_sql   text;
  v_exists   boolean;
  v_sets     text := '';
  v_cols     text := '';
  v_vals     text := '';
  r          record;
  v_expr     text;
begin
  -- Whitelist + per-table primary key. Anything else is refused.
  if p_table = 'site_settings' then      v_pk_sql := 'id = 1';
  elsif p_table = 'site_content' then    v_pk_sql := 'id = 1';
  elsif p_table = 'launch_settings' then v_pk_sql := 'id = true';
  else
    raise exception 'singleton_unknown_table: %', p_table using errcode = 'check_violation';
  end if;

  execute format('select exists (select 1 from %I where %s)', p_table, v_pk_sql) into v_exists;

  for r in
    select c.column_name, c.data_type
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = p_table
       and c.column_name not in ('id', 'created_at', 'updated_at', 'updated_by')
       and p_payload ? c.column_name
  loop
    if r.data_type = 'jsonb' then
      v_expr := format('($1 -> %L)', r.column_name);
    elsif r.data_type = 'boolean' then
      v_expr := format('(($1 ->> %L))::boolean', r.column_name);
    elsif r.data_type in ('integer', 'bigint', 'numeric') then
      v_expr := format('(($1 ->> %L))::%s', r.column_name, r.data_type);
    elsif r.data_type = 'timestamp with time zone' then
      v_expr := format('(($1 ->> %L))::timestamptz', r.column_name);
    else
      v_expr := format('($1 ->> %L)', r.column_name);
    end if;
    v_sets := v_sets || case when v_sets = '' then '' else ', ' end
              || format('%I = %s', r.column_name, v_expr);
    v_cols := v_cols || case when v_cols = '' then '' else ', ' end || quote_ident(r.column_name);
    v_vals := v_vals || case when v_vals = '' then '' else ', ' end || v_expr;
  end loop;

  if v_sets = '' then
    raise exception 'singleton_empty_payload: no known columns for %', p_table
      using errcode = 'check_violation';
  end if;

  if v_exists then
    -- updated_at / updated_by are server truth wherever the table has them —
    -- folded into this ONE statement so one logical save is exactly one
    -- revision bump (a second UPDATE would double-count on the ledger).
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = p_table
                  and column_name = 'updated_at') then
      v_sets := v_sets || ', updated_at = now()';
    end if;
    if p_updated_by is not null and exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = p_table
                  and column_name = 'updated_by') then
      v_sets := v_sets || format(', updated_by = %L', p_updated_by);
    end if;
    execute format('update %I set %s where %s', p_table, v_sets, v_pk_sql) using p_payload;
  else
    execute format('insert into %I (%s, id) values (%s, %s)',
                   p_table, v_cols, v_vals,
                   case when p_table = 'launch_settings' then 'true' else '1' end)
      using p_payload;
  end if;
end $$;

revoke all on function singleton_apply_payload(text, jsonb, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. save_website_studio — ONE transaction for the studio Publish.
--    Each part is optional; every part provided is revision-guarded. The
--    audit row and both writes commit or roll back together.
-- ----------------------------------------------------------------------------
create or replace function save_website_studio(
  p_site_settings jsonb,
  p_site_content jsonb,
  p_expected_settings_revision bigint,
  p_expected_content_revision bigint
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_name text;
  v_actor_role text;
  v_rev bigint;
  v_settings_rev bigint;
  v_content_rev bigint;
  v_parts text := '';
begin
  if not is_owner() then
    raise exception 'studio_owner_only: Website Studio publishes require the owner with MFA'
      using errcode = 'insufficient_privilege';
  end if;
  if p_site_settings is null and p_site_content is null then
    raise exception 'studio_empty_save: nothing to publish' using errcode = 'check_violation';
  end if;

  select name, role into v_actor_name, v_actor_role
    from staff_profiles where auth_id = auth.uid() limit 1;

  perform set_config('milkpop.singleton_rpc', '1', true);

  if p_site_settings is not null then
    v_rev := collection_revision_checkpoint('site_settings');
    if p_expected_settings_revision is null then
      raise exception 'collection_revision_required: site_settings — re-hydrate and retry'
        using errcode = 'check_violation';
    end if;
    if v_rev <> p_expected_settings_revision then
      raise exception
        'collection_snapshot_stale: site_settings changed (revision % vs expected %) — re-hydrate, review, publish again',
        v_rev, p_expected_settings_revision using errcode = 'check_violation';
    end if;
    perform singleton_apply_payload('site_settings', p_site_settings);
    v_parts := v_parts || 'settings ';
  end if;

  if p_site_content is not null then
    v_rev := collection_revision_checkpoint('site_content');
    if p_expected_content_revision is null then
      raise exception 'collection_revision_required: site_content — re-hydrate and retry'
        using errcode = 'check_violation';
    end if;
    if v_rev <> p_expected_content_revision then
      raise exception
        'collection_snapshot_stale: site_content changed (revision % vs expected %) — re-hydrate, review, publish again',
        v_rev, p_expected_content_revision using errcode = 'check_violation';
    end if;
    perform singleton_apply_payload('site_content', p_site_content);
    v_parts := v_parts || 'content ';
  end if;

  -- Server-side audit — same transaction as the writes it describes.
  insert into audit_logs (id, operator_name, role, action, module, new_value)
  values ('aud_' || replace(gen_random_uuid()::text, '-', ''),
          coalesce(v_actor_name, 'owner'), coalesce(v_actor_role, 'owner'),
          'Published Website Studio changes (' || trim(v_parts) || ')',
          'Website Studio',
          jsonb_build_object('parts', trim(v_parts)));

  select revision into v_settings_rev from collection_revisions where table_key = 'site_settings';
  select revision into v_content_rev  from collection_revisions where table_key = 'site_content';
  return jsonb_build_object(
    'settings_revision', v_settings_rev,
    'content_revision',  v_content_rev
  );
end $$;

revoke all on function save_website_studio(jsonb, jsonb, bigint, bigint) from public, anon;

-- ----------------------------------------------------------------------------
-- 5. save_launch_settings — the launch-facts panel through the same machinery
--    (partial-patch semantics kept; updated_by DERIVED, never client-sent).
-- ----------------------------------------------------------------------------
create or replace function save_launch_settings(
  p_patch jsonb,
  p_expected_revision bigint
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_name text;
  v_actor_role text;
  v_rev bigint;
begin
  if not is_owner() then
    raise exception 'launch_settings_owner_only: launch facts are recorded by the owner with MFA'
      using errcode = 'insufficient_privilege';
  end if;
  if p_patch is null or p_patch = '{}'::jsonb then
    raise exception 'launch_settings_empty_patch: nothing to save' using errcode = 'check_violation';
  end if;

  select name, role into v_actor_name, v_actor_role
    from staff_profiles where auth_id = auth.uid() limit 1;

  v_rev := collection_revision_checkpoint('launch_settings');
  if p_expected_revision is null then
    raise exception 'collection_revision_required: launch_settings — re-hydrate and retry'
      using errcode = 'check_violation';
  end if;
  if v_rev <> p_expected_revision then
    raise exception
      'collection_snapshot_stale: launch_settings changed (revision % vs expected %) — re-hydrate, review, save again',
      v_rev, p_expected_revision using errcode = 'check_violation';
  end if;

  perform set_config('milkpop.singleton_rpc', '1', true);
  perform singleton_apply_payload('launch_settings', p_patch, coalesce(v_actor_name, 'owner'));

  insert into audit_logs (id, operator_name, role, action, module, new_value)
  values ('aud_' || replace(gen_random_uuid()::text, '-', ''),
          coalesce(v_actor_name, 'owner'), coalesce(v_actor_role, 'owner'),
          'Updated launch facts', 'Launch settings',
          jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k)));

  select revision into v_rev from collection_revisions where table_key = 'launch_settings';
  return jsonb_build_object('revision', v_rev);
end $$;

revoke all on function save_launch_settings(jsonb, bigint) from public, anon;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE — structural; role behaviour lives in scripts/inc11-studio.test.mjs
-- ----------------------------------------------------------------------------
do $acceptance$
begin
  if to_regprocedure('public.save_website_studio(jsonb, jsonb, bigint, bigint)') is null then
    raise exception 'inc11_studio: save_website_studio is absent';
  end if;
  if to_regprocedure('public.save_launch_settings(jsonb, bigint)') is null then
    raise exception 'inc11_studio: save_launch_settings is absent';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_singleton_guard'
                   and tgrelid = 'site_content'::regclass) then
    raise exception 'inc11_studio: the site_content singleton guard is absent';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_zz_collection_revision'
                   and tgrelid = 'launch_settings'::regclass) then
    raise exception 'inc11_studio: launch_settings is not on the revision ledger';
  end if;
end $acceptance$;
