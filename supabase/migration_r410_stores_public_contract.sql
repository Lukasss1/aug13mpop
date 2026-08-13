-- ============================================================================
--  MILK POP — R4.10 INCREMENT 1 : stores_public carries the row timestamps the
--  PRODUCTION PUBLIC CONTRACT requires.
--
--  WHAT THIS CHANGES, STATED HONESTLY
--  ----------------------------------
--  This is NOT a restoration of columns that were lost by accident, and it is
--  NOT the first time these columns have been public. The exact history:
--
--    • WS6f (chain 51) CREATED stores_public with
--          … , coordinates, created_at, updated_at   from stores
--    • WS6g (chain 52) RE-ISSUED it one migration later WITHOUT them, added the
--      `setup_status = 'ACTIVE'` filter, and recorded the removal deliberately:
--          "Internal setup/VAT columns and row timestamps are deliberately absent"
--          "stores_public … no longer exposes created_at / updated_at"
--
--  So this migration REVERSES A DELIBERATE WS6g EXCLUSION. That deserves a
--  reason, not a shrug.
--
--  THE REASON
--  ----------
--  The production SEO loader (scripts/load-public-content.ts) reads the public
--  store locator through this view and requests `updated_at`, which it needs to
--  compute the snapshot's `latestUpdatedAt` — part of the snapshot/manifest
--  contract that scripts/prerender-seo.ts depends on to generate store pages.
--  Against the real view, that request is SQLSTATE 42703 and PostgREST answers
--  HTTP 400; the loader fails closed, and therefore A PRODUCTION BUILD CANNOT
--  COMPLETE AT ALL. Measured, not assumed:
--
--      stores_public  asked 12 cols  ->  400 42703, missing: updated_at
--      PRODUCTION LOAD VERDICT: THREW — "SEO build failed"
--
--  The opposite fix (drop `updated_at` from the loader) was built and measured
--  in an earlier round: seo-source still passed 57/0 but seo-prerender then
--  failed to generate store pages, because the manifest contract needs it.
--  So the column must exist on the view.
--
--  WHY REVERSING WS6g IS ACCEPTABLE HERE
--  ------------------------------------
--  Every row this view exposes is already deliberately public — name, address,
--  postcode, opening hours, phone, email, coordinates. Adding "when this row was
--  last edited" to a record whose contents are already published discloses no
--  new fact about the business, its staff or its customers. WS6g's exclusion was
--  defensive minimalism, which is a good default; it is being narrowed here for
--  a stated contractual need and nothing else.
--
--  Note for review: only `updated_at` is contractually required. `created_at` is
--  included because the R4.10 plan specifies both and it is equally inert on an
--  already-public locator row. Dropping it is a one-line change if preferred.
--
--  WHAT THIS DELIBERATELY DOES NOT CHANGE
--  --------------------------------------
--    • the `setup_status = 'ACTIVE'` public-row filter (WS6g) — RETAINED
--    • setup_status itself, VAT configuration and every other administrative
--      column — STILL ABSENT from the view
--    • the view's security semantics — this is `create or replace view`, which
--      preserves reloptions, so the view keeps running with the owner's rights
--      exactly as before; no security_invoker is added or removed
--    • anonymous access to the BASE TABLE `stores` — STILL REVOKED, and
--      re-asserted below so this file states the whole invariant it relies on
--
--  APPEND-ONLY: no previously applied migration is edited by this file.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- R4.10.1  stores_public — locator columns + row timestamps
-- ----------------------------------------------------------------------------
-- `create or replace view` may append columns at the end of the column list; it
-- may not rename, retype or reorder the existing ones. The eleven WS6g columns
-- are therefore repeated in their exact original order and the two timestamps
-- are appended, so the replace is accepted and no existing consumer's column
-- positions move.
create or replace view stores_public as
  select id, name, address, postcode, opening_hours, status, delivery_links,
         phone, email, image, coordinates, created_at, updated_at
    from stores
   where setup_status = 'ACTIVE';

-- Re-assert the exact anonymous surface. `create or replace view` preserves
-- existing grants, so these are idempotent; they are written out so this file
-- declares the privilege state it depends on rather than inheriting it silently.
revoke all on stores_public from public;
grant select on stores_public to anon, authenticated;

-- The base table stays closed to anonymous callers (first revoked in WS6f).
-- Re-asserted for the same reason: the view is only a safe public surface while
-- the table behind it is not itself readable.
revoke select on table stores from anon;

comment on view stores_public is
  'The anonymous locator surface: setup-ACTIVE stores only, locator columns plus row timestamps. '
  'created_at/updated_at were removed by WS6g and reinstated by R4.10 because the production SEO '
  'loader requires updated_at for the snapshot/manifest contract — without it a production build '
  'cannot complete. Internal setup/VAT and all other administrative columns remain absent, and the '
  'base table is not anon-readable.';

-- ----------------------------------------------------------------------------
-- ACCEPTANCE (asserted here so a mis-application fails loudly at install time,
-- and re-asserted independently by scripts/r410-public-contract-reconciliation.mjs
-- against information_schema on a freshly built database)
-- ----------------------------------------------------------------------------
do $acceptance$
declare
  v_cols text[];
  v_missing text[];
  v_forbidden text[];
begin
  select array_agg(column_name::text order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'stores_public';

  -- 1. every column the production loader requests must be present
  select array_agg(c) into v_missing
    from unnest(array[
      'id','name','address','postcode','opening_hours','status','delivery_links',
      'phone','email','image','coordinates','updated_at'
    ]) as c
   where c <> all(v_cols);
  if v_missing is not null then
    raise exception 'r410_stores_public_contract: loader columns missing from stores_public: %', v_missing;
  end if;

  -- 2. no administrative column may have crept onto the public surface
  select array_agg(c) into v_forbidden
    from unnest(array[
      'setup_status','vat_config_confirmed_at','vat_scheme','vat_number',
      'payment_methods','timezone','currency'
    ]) as c
   where c = any(v_cols);
  if v_forbidden is not null then
    raise exception 'r410_stores_public_contract: administrative columns exposed publicly: %', v_forbidden;
  end if;

  -- 3. the public-row filter must still be in force
  if position('setup_status' in pg_get_viewdef('public.stores_public'::regclass)) = 0 then
    raise exception 'r410_stores_public_contract: the setup_status public-row filter is no longer present';
  end if;

  -- 4. the base table must not be anonymously readable
  if has_table_privilege('anon', 'public.stores'::regclass, 'SELECT') then
    raise exception 'r410_stores_public_contract: anon can read the stores BASE TABLE';
  end if;

  -- 5. the view must be anonymously readable, or the locator is dark
  if not has_table_privilege('anon', 'public.stores_public'::regclass, 'SELECT') then
    raise exception 'r410_stores_public_contract: anon cannot read stores_public';
  end if;
end
$acceptance$;
