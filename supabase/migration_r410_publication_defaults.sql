-- ============================================================================
--  MILK POP — R4.10 INCREMENT 7 : publication becomes an ACT, not a side effect
--  of creation.
--
--  STANDING INSTRUCTION 8: "every newly created business record must default to
--  non-public." Three collections still violated it:
--
--      menu_items.available = true          -> false
--      deals.active         = true          -> false
--      cms_pages.status     = 'published'   -> 'draft'
--
--  (job_vacancies and media_assets were closed in Increment 5a; news_posts was
--  already draft; stores.status became 'coming_soon' in R4.9 G5.)
--
--  WHY THE DEFAULTS CANNOT MOVE ALONE
--  ----------------------------------
--  This is the long-open D-6 finding, and the reason it stayed open is that
--  flipping `available` without giving the owner a way to publish just makes
--  every new product permanently invisible — a worse defect than the one being
--  fixed. The default and the control must land together, so they land here
--  together.
--
--  WHY ONE ALLOW-LISTED PAIR RATHER THAN TWELVE NAMED FUNCTIONS
--  ------------------------------------------------------------
--  The plan lists publish_menu_item / unpublish_menu_item / activate_deal /
--  pause_deal / … as separate RPCs. What they must GUARANTEE is identical in
--  every case: verify the caller, touch exactly ONE publication column on
--  exactly ONE row, write an audit event, and never reach for whole-collection
--  replacement. Twelve near-identical functions is twelve places for those
--  guarantees to drift apart — and this codebase has spent an entire round
--  removing copies that drifted.
--
--  So: one allow-listed pair, mirroring the shape `replace_collection` already
--  established here (a table allow-list carried in the function, dynamic SQL
--  confined to names the allow-list produced). The allow-list IS the set of
--  publishable collections, and it names the publication column for each, so a
--  table that is not listed cannot be published through this path at all.
--
--  SECURITY INVOKER, deliberately: the UPDATE is authorised by the same RLS that
--  governs direct table access, so there is no second permission matrix to keep
--  in sync. The explicit role check below is defence in depth, not the gate.
--
--  APPEND-ONLY: no previously applied migration is edited by this file.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- R4.10.7.1  The remaining defaults close.
-- ----------------------------------------------------------------------------
-- Existing rows are NOT touched. A live product must not vanish because an
-- upgrade ran; only the NEXT row created is affected.
alter table menu_items alter column available set default false;
alter table deals      alter column active    set default false;
alter table cms_pages  alter column status    set default 'draft';

comment on column menu_items.available is
  'R4.10 Increment 7: defaults to FALSE. A new product is created hidden and published '
  'deliberately through publish_record(). Existing rows were left untouched by the change.';
comment on column deals.active is
  'R4.10 Increment 7: defaults to FALSE. A new offer is created paused.';

-- ----------------------------------------------------------------------------
-- R4.10.7.2  publish_record / unpublish_record
-- ----------------------------------------------------------------------------
create or replace function publish_record(p_table text, p_id uuid, p_publish boolean)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_col      text;
  v_on       text;
  v_off      text;
  v_role     text;
  v_before   text;
  v_after    text;
  v_rows     integer;
begin
  -- 1. Allow-list: the publishable collections and each one's SINGLE
  --    publication column, with the value that means public and the value that
  --    means not. A table absent from this list cannot be published here.
  select c, onv, offv into v_col, v_on, v_off from (values
    ('menu_items',    'available', 'true',      'false'),
    ('deals',         'active',    'true',      'false'),
    ('news_posts',    'status',    'published', 'draft'),
    ('cms_pages',     'status',    'published', 'draft'),
    ('job_vacancies', 'status',    'published', 'draft'),
    ('media_assets',  'is_public', 'true',      'false')
  ) as t(tbl, c, onv, offv) where t.tbl = p_table;

  if v_col is null then
    raise exception 'publish_record: % is not a publishable collection', p_table
      using errcode = 'check_violation';
  end if;

  -- 2. Who is asking. RLS is the real gate (SECURITY INVOKER), but an explicit
  --    refusal gives a clear error instead of a silent zero-row update.
  v_role := current_staff_role();
  if v_role is null or v_role not in ('owner', 'manager') then
    raise exception 'publish_record: publishing requires an owner or manager role (got %)',
      coalesce(v_role, 'none') using errcode = 'insufficient_privilege';
  end if;

  -- 3. Exactly one column, exactly one row. No collection replacement, no
  --    second field, no cascade.
  execute format('select %I::text from %I where id = $1', v_col, p_table)
    into v_before using p_id;
  if v_before is null then
    raise exception 'publish_record: no % row with id %', p_table, p_id
      using errcode = 'no_data_found';
  end if;

  execute format('update %I set %I = $1::%s where id = $2', p_table, v_col,
                 case when v_col in ('status') then 'text' else 'boolean' end)
    using (case when p_publish then v_on else v_off end), p_id;
  get diagnostics v_rows = ROW_COUNT;
  if v_rows <> 1 then
    raise exception 'publish_record: expected to update exactly 1 row, updated %', v_rows
      using errcode = 'check_violation';
  end if;

  execute format('select %I::text from %I where id = $1', v_col, p_table)
    into v_after using p_id;

  -- 4. An audit event, always — a publication decision that leaves no trace is
  --    not a decision anyone can review later.
  insert into audit_logs (operator_name, role, action, module, previous_value, new_value)
  values (
    coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', 'unknown'),
    v_role,
    case when p_publish then 'publish' else 'unpublish' end,
    p_table,
    v_before,
    v_after
  );

  return jsonb_build_object(
    'table', p_table, 'id', p_id, 'column', v_col,
    'previous', v_before, 'current', v_after);
end
$$;

revoke all on function publish_record(text, uuid, boolean) from public;
grant execute on function publish_record(text, uuid, boolean) to authenticated;

comment on function publish_record(text, uuid, boolean) is
  'R4.10 Increment 7: the ONLY sanctioned way to change a record''s publication state. '
  'Allow-listed collections only, one column on one row, an audit event every time, and '
  'never whole-collection replacement. SECURITY INVOKER, so RLS remains the real gate.';

-- ----------------------------------------------------------------------------
-- ACCEPTANCE
-- ----------------------------------------------------------------------------
do $acceptance$
declare
  v text;
  v_bad text[];
begin
  -- every publishable collection must now default to NOT public
  select array_agg(t || '.' || c || ' = ' || d order by t) into v_bad from (
    select table_name t, column_name c, coalesce(column_default, '(none)') d
      from information_schema.columns
     where table_schema = 'public'
       and (table_name, column_name) in (
             ('menu_items','available'), ('deals','active'), ('news_posts','status'),
             ('cms_pages','status'), ('job_vacancies','status'), ('media_assets','is_public'))
  ) q
  where d not like '%false%' and d not like '%draft%';
  if v_bad is not null then
    raise exception 'r410_publication_defaults: these still default to PUBLIC: %', v_bad;
  end if;

  -- stores were closed earlier; assert it has not drifted back
  select column_default into v from information_schema.columns
   where table_schema='public' and table_name='stores' and column_name='status';
  if v is null or v not like '%coming_soon%' then
    raise exception 'r410_publication_defaults: stores.status default is % (want coming_soon)', v;
  end if;

  if to_regprocedure('public.publish_record(text, uuid, boolean)') is null then
    raise exception 'r410_publication_defaults: publish_record is absent — the defaults would be a trap';
  end if;
end
$acceptance$;
