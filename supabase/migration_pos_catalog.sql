-- ============================================================================
--  MILK POP — POS catalogue push (integration plan Gate 9)
--
--  The website publishes a versioned catalogue snapshot; tills learn the
--  newest version from every ingest acknowledgement and pull the snapshot
--  through the pos-catalog Edge Function with their device token.
--
--   • pos_catalog — append-only versions; snapshot jsonb per the contract's
--     CatalogSnapshot (sections optional; products require categories).
--   • publish_pos_catalog(p_snapshot) — Owner-only; validates shape, money
--     integers and the forbidden-key rule; returns the new version.
--   • pos_catalog_current() — newest {catalogVersion, catalog}; service
--     role only (the Edge Function).
--   • pos_catalog_version() — just the number; also for the signed-in
--     admin badge.
--   • pos_ingest_batch is re-created here to include catalogVersion in its
--     acknowledgement (additive optional response field — the Gate 7 worker
--     already persists it).
--
--  Run AFTER migration_pos_sync.sql. RLS: deny-by-default; browsers touch
--  the catalogue only through the two granted functions.
-- ============================================================================

create table if not exists pos_catalog (
  version      integer primary key,
  snapshot     jsonb not null,
  published_by text,
  published_at timestamptz not null default now()
);

alter table pos_catalog enable row level security;
revoke all on table pos_catalog from anon;
revoke all on table pos_catalog from authenticated;

-- ---------------------------------------------------------------------------
-- Publish (Owner-only). The snapshot is validated structurally so a bad
-- publish can never brick every till at once.
-- ---------------------------------------------------------------------------
create or replace function publish_pos_catalog(p_snapshot jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_version integer;
  section text;
  arr jsonb;
  it jsonb;
begin
  if not is_owner() then
    raise exception 'Only the owner can publish the till catalogue.';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'The catalogue snapshot must be a JSON object.';
  end if;
  if pos_payload_has_forbidden_key(p_snapshot) then
    raise exception 'The catalogue snapshot contains a forbidden key.';
  end if;

  foreach section in array array['categories','products','modifiers','deals'] loop
    arr := p_snapshot -> section;
    if arr is not null and jsonb_typeof(arr) <> 'array' then
      raise exception 'Catalogue section % must be an array.', section;
    end if;
  end loop;
  if (p_snapshot ? 'products') and not (p_snapshot ? 'categories') then
    raise exception 'Products may only be published together with categories.';
  end if;

  -- Money and identity spot-checks (the till re-validates on apply).
  for it in select * from jsonb_array_elements(coalesce(p_snapshot -> 'products', '[]'::jsonb)) loop
    perform pos_text(it, '{id}', 'product.id');
    perform pos_text(it, '{categoryId}', 'product.categoryId');
    perform pos_text(it, '{name}', 'product.name');
    perform pos_pence(it, '{basePricePence}');
    perform pos_pence(it, '{largePricePence}', false);
    perform pos_pence(it, '{vatRateBp}');
  end loop;
  for it in select * from jsonb_array_elements(coalesce(p_snapshot -> 'modifiers', '[]'::jsonb)) loop
    perform pos_text(it, '{id}', 'modifier.id');
    perform pos_pence(it, '{pricePence}');
  end loop;
  for it in select * from jsonb_array_elements(coalesce(p_snapshot -> 'categories', '[]'::jsonb)) loop
    perform pos_text(it, '{id}', 'category.id');
    perform pos_text(it, '{name}', 'category.name');
  end loop;

  insert into pos_catalog (version, snapshot, published_by)
  values (coalesce((select max(version) from pos_catalog), 0) + 1,
          p_snapshot, current_staff_id())
  returning version into v_version;
  return v_version;
end;
$$;

-- ---------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------
create or replace function pos_catalog_current()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('catalogVersion', version, 'catalog', snapshot)
    from pos_catalog order by version desc limit 1;
$$;

create or replace function pos_catalog_version()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select max(version) from pos_catalog), 0);
$$;

revoke all on function publish_pos_catalog(jsonb) from public, anon;
revoke all on function pos_catalog_current()      from public, anon, authenticated;
revoke all on function pos_catalog_version()      from public, anon;
grant execute on function publish_pos_catalog(jsonb) to authenticated;
grant execute on function pos_catalog_version()      to authenticated;

-- Note: pos_ingest_batch (migration_pos_sync.sql) detects this table at
-- runtime and starts advertising catalogVersion in its acknowledgements the
-- moment this migration lands — no redefinition here, one source of truth.
