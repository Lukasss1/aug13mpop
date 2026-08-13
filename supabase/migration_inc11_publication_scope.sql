-- ============================================================================
--  MILK POP — INC11 : THE PUBLICATION BOUNDARY, FINAL FORM
--  Four collections · sanctioned-context lifecycle writes · final-state
--  validation on every write · published records cannot be deleted · a real
--  vacancy close.
--
--  SUPERSESSION NOTE (for the next external auditor)
--  -------------------------------------------------
--  Audit 3 (blocker 1) required a publish workflow for SIX collections, and
--  Increment 10 delivered it in good faith. The subsequent code-level review
--  established two facts the earlier audit did not have:
--    • media_assets.is_public never governed BYTE visibility — the menu-media
--      bucket is public, so object bytes are world-readable once a URL is
--      known; is_public gated only a metadata projection. Publishing media
--      was therefore metadata theatre. Real visibility is governed by the
--      records and content that REFERENCE an asset. The library becomes
--      authenticated metadata; its projection loses anonymous access below.
--    • cms_pages is rendered by NO public route, prerender path, or router
--      entry. Its publication controls implied a pipeline that reaches
--      nobody. It is recorded as deferred legacy data; its projection loses
--      anonymous access below.
--  The honest publication scope is therefore FOUR collections:
--      menu_items.available · deals.active · news_posts.status ·
--      job_vacancies.status
--  This narrowing is a correction of scope, not a weakening of protection:
--  every lifecycle column that actually decides public output is now guarded
--  more strongly than before.
--
--  WHAT THIS FILE ADDS ON TOP OF INCREMENT 10
--  ------------------------------------------
--  1. SANCTIONED-CONTEXT LIFECYCLE WRITES. Increment 10 stripped lifecycle
--     columns from replace_collection; direct PostgREST writes by an
--     authorised owner/manager could still flip them, skipping completeness
--     and audit. Now a transaction-local GUC — set only by publish_record and
--     close_vacancy — is required for ANY lifecycle change. The GUC cannot be
--     fabricated through the API surface: PostgREST executes only functions
--     in the exposed schema, set_config is not among them, and the negative
--     suite proves no exposed function leaks the context.
--  2. FINAL-STATE VALIDATION. publication_candidate_errors(table, candidate)
--     validates the PROPOSED row (never a reload of the stored row — the
--     chain-76 lesson applied to content). A trigger enforces it on every
--     insert/update whose FINAL state is public, so a live record cannot be
--     edited into invalidity through ANY path — publish_record, the
--     collection editor, or direct REST.
--  3. PUBLISHED-DELETE REFUSAL. Deleting public output is a public event;
--     the sanctioned path is Published → Unpublish → Delete draft.
--  4. close_vacancy: the Admin "close" action was DELETION with a "Closed
--     vacancy" audit line; the `closed` status was unreachable. Closing is
--     now a real, audited, revision-checked transition that keeps the
--     vacancy and its application history.
--
--  SUPERUSER EXEMPTION, deliberate and documented: seed.sql publishes
--  content, migrations repair data, and every harness arranges fixtures as
--  postgres. The three new guards therefore stand down for a superuser
--  session — which no API role is. Enforcement is total for anon,
--  authenticated and service-role paths; the suites prove it as the real
--  roles.
--
--  APPEND-ONLY: no previously applied migration file is edited.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. THE definition of a publishable candidate. Validates the proposed row
--    as JSON — publish_record, the final-state trigger, and any future
--    sanctioned save path all call THIS, so the contract cannot fork.
--    Floors carried from Increment 10, plus: the literal 'placeholder' image
--    no longer qualifies (it was a UI default, not an approved asset).
-- ----------------------------------------------------------------------------
create or replace function publication_candidate_errors(p_table text, p_candidate jsonb)
returns text[]
language plpgsql
immutable
set search_path = public
as $$
declare
  v text[] := '{}';
begin
  if p_table = 'menu_items' then
    if coalesce(trim(p_candidate->>'name'), '') = '' then v := v || 'name is blank'::text; end if;
    if (p_candidate->>'price') is null or (p_candidate->>'price')::numeric < 0 then
      v := v || 'price must be zero or more'::text; end if;
    if (p_candidate->>'price_large') is not null and (p_candidate->>'price_large')::numeric < 0 then
      v := v || 'large price must be zero or more'::text; end if;
    if coalesce(trim(p_candidate->>'image'), '') = '' then v := v || 'image is missing'::text;
    elsif trim(p_candidate->>'image') = 'placeholder' then
      v := v || 'image is the ''placeholder'' default — attach a real approved image'::text; end if;

  elsif p_table = 'deals' then
    if coalesce(trim(p_candidate->>'name'), '') = '' then v := v || 'name is blank'::text; end if;
    if p_candidate->>'type' = 'bundle_price' then
      if coalesce((p_candidate->>'buy_qty')::int, 0) < 1 then v := v || 'bundle_price needs buy_qty of at least 1'::text; end if;
      if (p_candidate->>'bundle_price') is null or (p_candidate->>'bundle_price')::numeric <= 0 then
        v := v || 'bundle_price needs a positive bundle price'::text; end if;
      if (p_candidate->>'category') is null then v := v || 'bundle_price needs a category'::text; end if;
    elsif p_candidate->>'type' = 'buy_x_get_y_free' then
      if coalesce((p_candidate->>'buy_qty')::int, 0) < 1 then v := v || 'buy_x_get_y_free needs buy_qty of at least 1'::text; end if;
      if coalesce((p_candidate->>'free_qty')::int, 0) < 1 then v := v || 'buy_x_get_y_free needs free_qty of at least 1'::text; end if;
      if (p_candidate->>'category') is null then v := v || 'buy_x_get_y_free needs a category'::text; end if;
    elsif p_candidate->>'type' = 'percent_off_category' then
      if (p_candidate->>'percent_off') is null
         or (p_candidate->>'percent_off')::numeric <= 0
         or (p_candidate->>'percent_off')::numeric > 100 then
        v := v || 'percent_off must be between 0 and 100'::text; end if;
      if (p_candidate->>'category') is null then v := v || 'percent_off_category needs a category'::text; end if;
    elsif p_candidate->>'type' = 'fixed_off_order' then
      if (p_candidate->>'amount_off') is null or (p_candidate->>'amount_off')::numeric <= 0 then
        v := v || 'fixed_off_order needs a positive amount off'::text; end if;
      if (p_candidate->>'min_order_value') is not null and (p_candidate->>'min_order_value')::numeric < 0 then
        v := v || 'minimum order value cannot be negative'::text; end if;
    end if;

  elsif p_table = 'news_posts' then
    if coalesce(trim(p_candidate->>'title'), '') = '' then
      v := v || 'title is blank (the public slug derives from it)'::text; end if;
    if coalesce(trim(p_candidate->>'content'), '') = '' then v := v || 'content is blank'::text; end if;
    if coalesce(trim(p_candidate->>'date'), '') = '' then v := v || 'date is blank'::text; end if;

  elsif p_table = 'job_vacancies' then
    if coalesce(trim(p_candidate->>'title'), '') = '' then v := v || 'title is blank'::text; end if;
    if coalesce(trim(p_candidate->>'location'), '') = '' then v := v || 'location is blank'::text; end if;
    if coalesce(trim(p_candidate->>'salary'), '') = '' then v := v || 'salary wording is blank'::text; end if;
    if coalesce(trim(p_candidate->>'role_description'), '') = '' then v := v || 'role description is blank'::text; end if;

  else
    return array[p_table || ' has no publication contract'];
  end if;

  return v;
end $$;

revoke all on function publication_candidate_errors(text, jsonb) from public, anon;
grant execute on function publication_candidate_errors(text, jsonb) to authenticated;

comment on function publication_candidate_errors(text, jsonb) is
  'INC11: THE publication contract, evaluated against a CANDIDATE row as JSON. '
  'Never reloads the stored row — inside BEFORE UPDATE that would be the OLD '
  'row (the chain-76 lesson). Called by publish_record, the final-state '
  'trigger, and every future sanctioned save path.';

-- ----------------------------------------------------------------------------
-- 2. The sanctioned-context guard: lifecycle columns move only inside the
--    publication RPCs. Fires FIRST (trigger names order execution).
-- ----------------------------------------------------------------------------
create or replace function assert_lifecycle_change_sanctioned()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_col   text;
  v_draft text;
  v_old   text;
  v_new   text;
begin
  if current_setting('is_superuser') = 'on' then return new; end if;
  if current_setting('milkpop.publication_rpc', true) = '1' then return new; end if;

  select col, draft into v_col, v_draft from (values
    ('menu_items',    'available', 'false'),
    ('deals',         'active',    'false'),
    ('news_posts',    'status',    'draft'),
    ('job_vacancies', 'status',    'draft')
  ) as t(tbl, col, draft) where t.tbl = TG_TABLE_NAME;

  v_new := row_to_json(new)::jsonb ->> v_col;
  if TG_OP = 'INSERT' then
    if v_new is distinct from v_draft then
      raise exception
        'lifecycle_change_refused: a new % row must be born a draft — % moves only '
        'through publish_record%', TG_TABLE_NAME, v_col,
        case when TG_TABLE_NAME = 'job_vacancies' then ' or close_vacancy' else '' end
        using errcode = 'insufficient_privilege';
    end if;
  else
    v_old := row_to_json(old)::jsonb ->> v_col;
    if v_new is distinct from v_old then
      raise exception
        'lifecycle_change_refused: %.% moves only through publish_record%',
        TG_TABLE_NAME, v_col,
        case when TG_TABLE_NAME = 'job_vacancies' then ' or close_vacancy' else '' end
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Final-state validation: whenever the row a statement LEAVES BEHIND is
--    public, the whole candidate must satisfy the contract. Covers
--    publish_record, collection saves, and direct REST alike.
--    Error name kept from Increment 10 (`publish_blocked_incomplete`) — the
--    suites pin it, and it is equally honest for "publishing this" and
--    "leaving this published".
-- ----------------------------------------------------------------------------
create or replace function assert_public_record_valid()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_public  boolean;
  v_errors  text[];
begin
  if current_setting('is_superuser') = 'on' then return new; end if;

  -- Field access via jsonb, NOT static record references: a plpgsql CASE is
  -- compiled as ONE SQL expression, so `new.active` in an untaken branch
  -- still fails to parse against a menu_items row. (Found by the real-role
  -- matrix on first contact — the lifecycle guard below already used the
  -- json form for the same reason.)
  v_public := case TG_TABLE_NAME
    when 'menu_items'    then (to_jsonb(new)->>'available')::boolean
    when 'deals'         then (to_jsonb(new)->>'active')::boolean
    when 'news_posts'    then (to_jsonb(new)->>'status') = 'published'
    when 'job_vacancies' then (to_jsonb(new)->>'status') = 'published'
  end;

  if coalesce(v_public, false) then
    v_errors := publication_candidate_errors(TG_TABLE_NAME, to_jsonb(new));
    if coalesce(array_length(v_errors, 1), 0) > 0 then
      raise exception 'publish_blocked_incomplete: % % — %',
        TG_TABLE_NAME, new.id, array_to_string(v_errors, '; ')
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 4. Published records cannot be deleted. The sanctioned path is
--    Published → Unpublish → Delete draft. No GUC exemption on purpose:
--    there is no sanctioned direct deletion of public output.
-- ----------------------------------------------------------------------------
create or replace function assert_published_delete_refused()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare v_public boolean;
begin
  if current_setting('is_superuser') = 'on' then return old; end if;
  v_public := case TG_TABLE_NAME
    when 'menu_items'    then (to_jsonb(old)->>'available')::boolean
    when 'deals'         then (to_jsonb(old)->>'active')::boolean
    when 'news_posts'    then (to_jsonb(old)->>'status') = 'published'
    when 'job_vacancies' then (to_jsonb(old)->>'status') = 'published'
  end;
  if coalesce(v_public, false) then
    raise exception
      'published_delete_refused: "%" is live on the public site — unpublish it first, '
      'then delete the draft', old.id
      using errcode = 'check_violation';
  end if;
  return old;
end $$;

do $triggers$
declare t text;
begin
  foreach t in array array['menu_items','deals','news_posts','job_vacancies'] loop
    execute format('drop trigger if exists trg_a1_lifecycle_sanctioned on %I', t);
    execute format(
      'create trigger trg_a1_lifecycle_sanctioned
         before insert or update on %I
         for each row execute function assert_lifecycle_change_sanctioned()', t);
    execute format('drop trigger if exists trg_a2_public_record_valid on %I', t);
    execute format(
      'create trigger trg_a2_public_record_valid
         before insert or update on %I
         for each row execute function assert_public_record_valid()', t);
    execute format('drop trigger if exists trg_published_delete_guard on %I', t);
    execute format(
      'create trigger trg_published_delete_guard
         before delete on %I
         for each row execute function assert_published_delete_refused()', t);
  end loop;
end $triggers$;

-- ----------------------------------------------------------------------------
-- 5. publish_record v4: four collections; the explicit matrix, AAL2 and
--    audit stay from v3; the completeness call moves OUT — the final-state
--    trigger is now the single enforcement point (same pinned error). The
--    function's job is WHO and WHICH; the trigger's job is WHAT.
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
  v_rev     bigint;
begin
  select c, onv, offv, ty into v_col, v_on, v_off, v_type from (values
    ('menu_items',    'available', 'true',      'false', 'boolean'),
    ('deals',         'active',    'true',      'false', 'boolean'),
    ('news_posts',    'status',    'published', 'draft', 'text'),
    ('job_vacancies', 'status',    'published', 'draft', 'text')
  ) as t(tbl, c, onv, offv, ty) where t.tbl = p_table;

  if v_col is null then
    if p_table in ('media_assets', 'cms_pages') then
      raise exception
        'publish_record: % left the publication scope in INC11 — media byte visibility '
        'is governed by the records that reference an asset (the bucket is public), and '
        'cms_pages drives no public route. See the supersession note in '
        'migration_inc11_publication_scope.sql.', p_table
        using errcode = 'check_violation';
    end if;
    raise exception 'publish_record: % is not a publishable collection', p_table
      using errcode = 'check_violation';
  end if;

  v_role := current_staff_role();
  if v_role is null then
    raise exception 'publish_record: publishing requires an active staff account '
      '(anonymous and disabled sessions are refused)'
      using errcode = 'insufficient_privilege';
  end if;
  if not is_aal2() then
    raise exception 'publish_record: publishing requires a verified second factor (AAL2). '
      'Complete the TOTP step and try again.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_role = 'owner' then
    null;
  elsif v_role = 'store_manager' then
    if p_table <> 'menu_items' then
      raise exception 'publish_record: a store manager may publish menu items only — % requires the owner', p_table
        using errcode = 'insufficient_privilege';
    end if;
  else
    raise exception 'publish_record: role % may not publish', v_role
      using errcode = 'insufficient_privilege';
  end if;

  execute format('select count(*) from %I where id = $1', p_table) into v_exists using p_id;
  if v_exists <> 1 then
    raise exception 'publish_record: expected exactly 1 % row with id %, found %',
      p_table, p_id, v_exists using errcode = 'no_data_found';
  end if;

  -- Sanction the lifecycle write for THIS transaction only. The final-state
  -- trigger still validates the candidate; the launch-context gates
  -- (armed-gates, allergen posture) still fire on the same write.
  perform set_config('milkpop.publication_rpc', '1', true);

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
  values ('aud_' || replace(gen_random_uuid()::text, '-', ''),
          coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', 'unknown'),
          v_role,
          case when p_publish then 'publish' else 'unpublish' end,
          now(), p_table, v_before, v_after);

  select revision into v_rev from collection_revisions where table_key = p_table;
  return jsonb_build_object(
    'table', p_table, 'id', p_id, 'column', v_col,
    'previous', v_before, 'current', v_after, 'revision', v_rev);
end
$$;

revoke all on function publish_record(text, text, boolean) from public, anon;
grant execute on function publish_record(text, text, boolean) to authenticated;

comment on function publish_record(text, text, boolean) is
  'INC11: the sanctioned publication path for the FOUR public collections. '
  'Explicit matrix + AAL2 + audit; sets the transaction-local sanction the '
  'lifecycle guard requires; completeness is enforced by the final-state '
  'trigger on the same write. Returns the new collection revision so editors '
  'know their snapshot aged.';

-- ----------------------------------------------------------------------------
-- 6. close_vacancy: a real transition. Owner + AAL2; revision-checked so a
--    stale tab cannot close what it has not seen; keeps the vacancy and its
--    application history; idempotent when already closed.
-- ----------------------------------------------------------------------------
create or replace function close_vacancy(p_id text, p_expected_revision bigint)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_role   text;
  v_status text;
  v_rev    bigint;
begin
  v_role := current_staff_role();
  if v_role is null then
    raise exception 'close_vacancy: an active staff account is required'
      using errcode = 'insufficient_privilege';
  end if;
  if v_role <> 'owner' then
    raise exception 'close_vacancy: closing a vacancy requires the owner'
      using errcode = 'insufficient_privilege';
  end if;
  if not is_aal2() then
    raise exception 'close_vacancy: a verified second factor (AAL2) is required'
      using errcode = 'insufficient_privilege';
  end if;

  v_rev := collection_revision_checkpoint('job_vacancies');
  if p_expected_revision is null then
    raise exception 'collection_revision_required: state the revision your careers view was hydrated at'
      using errcode = 'check_violation';
  end if;
  if p_expected_revision <> v_rev then
    raise exception
      'collection_snapshot_stale: job_vacancies is at revision % but you hydrated %. '
      'Re-load the careers list and close from the current state.', v_rev, p_expected_revision
      using errcode = 'check_violation';
  end if;

  select status into v_status from job_vacancies where id = p_id for update;
  if not found then
    raise exception 'close_vacancy: no vacancy with id %', p_id using errcode = 'no_data_found';
  end if;
  if v_status = 'closed' then
    return jsonb_build_object('id', p_id, 'status', 'closed', 'revision', v_rev, 'idempotent', true);
  end if;
  if v_status <> 'published' then
    raise exception
      'close_vacancy: "%" is a draft — closing records that a LIVE vacancy ended; '
      'a draft is simply deleted', p_id
      using errcode = 'check_violation';
  end if;

  perform set_config('milkpop.publication_rpc', '1', true);
  update job_vacancies set status = 'closed' where id = p_id;

  insert into audit_logs (id, operator_name, role, action, timestamp, module,
                          previous_value, new_value)
  values ('aud_' || replace(gen_random_uuid()::text, '-', ''),
          coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', 'unknown'),
          v_role, 'close', now(), 'job_vacancies', 'published', 'closed');

  select revision into v_rev from collection_revisions where table_key = 'job_vacancies';
  return jsonb_build_object('id', p_id, 'status', 'closed', 'revision', v_rev);
end $$;

revoke all on function close_vacancy(text, bigint) from public, anon;
grant execute on function close_vacancy(text, bigint) to authenticated;

-- ----------------------------------------------------------------------------
-- 7. The two retired projections lose anonymous access (supersession above).
--    Authenticated reads stay — the library and the legacy pages remain
--    staff-visible metadata.
-- ----------------------------------------------------------------------------
revoke select on media_assets_public from anon;
revoke select on cms_pages_public from anon;

-- ----------------------------------------------------------------------------
-- 8. UPGRADE PREFLIGHT (non-blocking): list already-published rows that the
--    contract would now refuse to EDIT (any content save re-validates the
--    final state). Fresh installs report zero. The operator's choices per
--    row: fix the fields, or unpublish. Nothing is auto-modified — a chain
--    migration does not rewrite business data it cannot see the meaning of.
-- ----------------------------------------------------------------------------
do $preflight$
declare
  r record;
  n integer;
  total integer := 0;
begin
  for r in select * from (values
    ('menu_items',    'available = true'),
    ('deals',         'active = true'),
    ('news_posts',    $q$status = 'published'$q$),
    ('job_vacancies', $q$status = 'published'$q$)
  ) as t(tbl, pub) loop
    execute format(
      'select count(*) from %I t where %s
        and coalesce(array_length(publication_candidate_errors(%L, to_jsonb(t)), 1), 0) > 0',
      r.tbl, r.pub, r.tbl) into n;
    if n > 0 then
      raise notice 'INC11 preflight: % published %(s) violate the publication contract — editing them will be refused until each is fixed or unpublished.', n, r.tbl;
      total := total + n;
    end if;
  end loop;
  if total = 0 then
    raise notice 'INC11 preflight: every published record satisfies the publication contract.';
  end if;
end $preflight$;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE — structural + the refusals provable without a session.
-- Role/GUC behaviour needs real sessions: scripts/inc11-boundary.test.mjs.
-- ----------------------------------------------------------------------------
do $acceptance$
declare v text;
begin
  if to_regprocedure('public.publication_candidate_errors(text, jsonb)') is null then
    raise exception 'inc11_scope: the candidate contract is absent';
  end if;
  if to_regprocedure('public.close_vacancy(text, bigint)') is null then
    raise exception 'inc11_scope: close_vacancy is absent';
  end if;
  begin
    perform publish_record('media_assets', 'x', true);
    raise exception 'inc11_scope: media_assets was accepted by publish_record';
  exception when others then
    v := sqlerrm;
    if position('left the publication scope' in v) = 0 then
      raise exception 'inc11_scope: media refusal has the wrong shape: %', v;
    end if;
  end;
  if has_table_privilege('anon', 'public.media_assets_public', 'select') then
    raise exception 'inc11_scope: anon still reads media_assets_public';
  end if;
  if has_table_privilege('anon', 'public.cms_pages_public', 'select') then
    raise exception 'inc11_scope: anon still reads cms_pages_public';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_a1_lifecycle_sanctioned'
                  and tgrelid = 'public.deals'::regclass) then
    raise exception 'inc11_scope: the lifecycle guard is missing on deals';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_a2_public_record_valid'
                  and tgrelid = 'public.news_posts'::regclass) then
    raise exception 'inc11_scope: the final-state trigger is missing on news_posts';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_published_delete_guard'
                  and tgrelid = 'public.job_vacancies'::regclass) then
    raise exception 'inc11_scope: the delete guard is missing on job_vacancies';
  end if;
end
$acceptance$;
