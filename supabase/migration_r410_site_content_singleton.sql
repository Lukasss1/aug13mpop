-- ============================================================================
--  MILK POP — R4.10 INCREMENT 1 : the site_content singleton must EXIST after a
--  fresh install, or a never-configured project cannot build.
--
--  WHAT WAS FOUND
--  --------------
--  Measured on a database built from the authoritative manifest:
--
--      site_settings = 1     site_content = 0
--
--  supabase/seed.sql inserts the site_settings singleton. NOTHING inserts the
--  site_content one — not the schema, not any migration, not the seed. It only
--  ever comes into existence when someone saves copy in Website Studio.
--
--  The production SEO loader requires BOTH singletons:
--
--      if (!settingsRow) errors.push('site_settings singleton row is absent.');
--      if (!contentRow)  errors.push('site_content singleton row is absent.');
--
--  …and treats their absence as a fail-closed production error. So a project
--  that has been installed but never edited CANNOT PRODUCE A PRODUCTION BUILD.
--  That is a second, independent instance of the same defect class as the
--  stores_public column mismatch, and it sits directly on the empty-launch path:
--  "deploy first, add the content later" is precisely the case that fails.
--
--  WHY THE ROW AND NOT A LOADER RELAXATION
--  ---------------------------------------
--  The loader's strictness is correct and is deliberately kept. A production
--  build should refuse to invent a site out of nothing. What was wrong is that a
--  correctly installed database was missing a row it should always have had.
--  Fixing the database keeps the guard; relaxing the loader would remove it.
--
--  WHY THIS INTRODUCES NO SEED CONTENT
--  -----------------------------------
--  Every jsonb column on site_content defaults to '{}' and the loader hydrates a
--  partial row against DEFAULT_SITE_CONTENT at load time. So inserting the id
--  alone produces a row that carries NO copy, NO product, NO price and NO
--  business claim of any kind — it is an empty container that says "this project
--  exists and has not been configured yet". The default copy continues to live in
--  one place (the TypeScript defaults); it is deliberately NOT duplicated into
--  SQL here, because that would create exactly the kind of second stand-in this
--  round exists to remove.
--
--  UPGRADE SAFETY
--  --------------
--  This runs on the upgrade path too, which is intended: an existing project
--  whose owner never saved copy has the same gap. `on conflict do nothing` makes
--  it inert wherever the row already exists, and it never overwrites saved copy.
--
--  APPEND-ONLY: no previously applied migration is edited by this file.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- R4.10.2  site_content singleton
-- ----------------------------------------------------------------------------
-- id is `integer not null default 1` with a single-row constraint, and every
-- content column is `jsonb not null default '{}'`. Naming only the id therefore
-- produces a completely empty, completely honest row.
insert into site_content (id) values (1)
on conflict (id) do nothing;

comment on table site_content is
  'The single row of editable public copy. R4.10 guarantees the row EXISTS from install '
  'so a never-configured project can still produce a production build; every column starts '
  'empty and the application hydrates defaults for anything unset. Creating the row asserts '
  'nothing about the business.';

-- ----------------------------------------------------------------------------
-- ACCEPTANCE
-- ----------------------------------------------------------------------------
-- This block asserts THIS migration's own effect and nothing else.
--
-- It deliberately does NOT assert the site_settings singleton, even though the
-- production loader needs both. site_settings is created by supabase/seed.sql,
-- which is a FRESH-ONLY file: scripts/migration-baseline.test.sh applies
-- schema + the migration chain WITHOUT the seed, so a chain-level assertion
-- about seeded content would fail a harness that is legitimately testing
-- structure rather than content. Coupling the chain to the seed would be a
-- worse defect than the one being fixed.
--
-- The both-singletons requirement is asserted where it belongs — in
-- scripts/r410-public-contract-reconciliation.mjs, which applies the FULL
-- manifest (fresh-only files included) and then drives a real production
-- content load against it.
do $acceptance$
declare
  v_content bigint;
begin
  select count(*) into v_content from site_content;
  if v_content <> 1 then
    raise exception 'r410_site_content_singleton: expected exactly 1 site_content row, found %', v_content;
  end if;
end
$acceptance$;
