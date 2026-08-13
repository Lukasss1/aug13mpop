-- ============================================================================
--  MILK POP — MIGRATION: LAUNCH DATA NEUTRALISE  (Phase 1 honesty review)
--
--  Run order: APPEND-ONLY future migration — after the frozen baseline (it is
--  the last entry in launch/migration-manifest.sh → MP_FUTURE_MIGRATIONS).
--
--  WHY
--  ---
--  Databases provisioned BEFORE this review were seeded from a seed.sql that
--  carried fabricated business data — a fake company number / VAT / HQ address,
--  MILKPOP.RU + placeholder socials, three invented storefronts, two published
--  demo vacancies, invented KB-article authors, a "Bullring opening" news post,
--  a broken-URL media record, and a starter inventory with invented suppliers.
--  The corrected seed.sql no longer ships any of it, but --db-upgrade never
--  re-runs seed.sql, so those rows persist on existing projects and are pushed
--  to the live site by App.tsx. This migration removes / blanks them.
--
--  SAFETY
--  ------
--  Every statement is CONDITIONAL on the row STILL matching the exact fabricated
--  value that seed.sql originally wrote. If the owner has since edited a value
--  (their real phone, a real store, a real supplier…), the predicate fails and
--  the row is left untouched. Genuine data is therefore never destroyed.
--
--  IDEMPOTENT: safe to re-run, and a NO-OP on any database created from the
--  corrected seed.sql (nothing matches the fabricated fingerprints).
--
--  The runner wraps this file in a single transaction (launch.sh: psql -1); do
--  not add begin/commit here.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- SITE SETTINGS — blank each fabricated field only if unchanged since seeding.
-- website_url is corrected to the real canonical domain (repo-verifiable).
-- ---------------------------------------------------------------------------
update site_settings set website_url = 'milkpop.uk'
  where id = 1 and website_url = 'MILKPOP.RU';
update site_settings set instagram_handle = ''
  where id = 1 and instagram_handle = '@MILKPOP.SHAKES';
update site_settings set instagram_url = ''
  where id = 1 and instagram_url = 'https://instagram.com/milkpop.shakes';
update site_settings set facebook_url = ''
  where id = 1 and facebook_url = 'https://facebook.com';
update site_settings set twitter_url = ''
  where id = 1 and twitter_url = 'https://twitter.com';
update site_settings set company_number = ''
  where id = 1 and company_number = '12093847-B';
update site_settings set vat_number = ''
  where id = 1 and vat_number = 'GB 987 654 321';
update site_settings set phone = ''
  where id = 1 and phone = '+44 (0) 121 556 9000';
update site_settings set email = ''
  where id = 1 and email = 'hospitality@milkpop.co.uk';
update site_settings set gdpr_email = ''
  where id = 1 and gdpr_email = 'gdpr@milkpop.co.uk';
update site_settings set hq_address = ''
  where id = 1 and hq_address = E'Milk Pop Corporate Headquarters,\n10 Colmore Row, Birmingham, B3 2QD';
update site_settings set default_opening_hours = ''
  where id = 1 and default_opening_hours = 'Mon - Sat: 09:00 - 21:00 | Sun: 11:00 - 17:00';

-- ---------------------------------------------------------------------------
-- STORES — delete the three invented storefronts only if still pristine.
-- FK note: orders.store_id / stock_movements.store_id are ON DELETE SET NULL,
-- so any (dev-only) rows pointing here are detached, not lost. Production has
-- no such rows.
-- ---------------------------------------------------------------------------
delete from stores where id = 's1'
  and name = 'Milk Pop Solihull'
  and address = 'Touchwood Shopping Precinct, Homer Road, Solihull'
  and postcode = 'B91 3GJ' and phone = '+44 121 704 0090'
  and email = 'solihull@milkpop.co.uk';
delete from stores where id = 's2'
  and name = 'Milk Pop Leicester'
  and address = '14 Highcross Street, Leicester City Centre, Leicester'
  and postcode = 'LE1 4FL' and phone = '+44 116 251 4030'
  and email = 'leicester@milkpop.co.uk';
delete from stores where id = 's3'
  and name = 'Milk Pop Birmingham'
  and address = 'Bullring Shopping Centre, Birmingham'
  and postcode = 'B5 4BU' and phone = '+44 121 345 6789'
  and email = 'birmingham@milkpop.co.uk';

-- ---------------------------------------------------------------------------
-- JOB VACANCIES — delete the two demo vacancies only if still pristine.
-- ---------------------------------------------------------------------------
delete from job_vacancies where id = 'v1'
  and title = 'Hospitality Team Member' and location = 'Solihull'
  and salary = '£11.50 - £12.20 / hour';
delete from job_vacancies where id = 'v2'
  and title = 'Shift Supervisor' and location = 'Leicester'
  and salary = '£13.50 - £14.30 / hour';

-- ---------------------------------------------------------------------------
-- NEWS — remove the fabricated "Bullring opening" post if still pristine.
-- ---------------------------------------------------------------------------
delete from news_posts where id = 'news_seed_1'
  and title = 'Birmingham Bullring store coming this autumn';

-- ---------------------------------------------------------------------------
-- MEDIA — remove the broken-URL brandbook fixture if still pristine.
-- ---------------------------------------------------------------------------
delete from media_assets where id = 'media_seed_1'
  and name = 'Brandbook — Милкпоп2.pdf' and url = '#';

-- ---------------------------------------------------------------------------
-- KNOWLEDGE BASE — blank the invented author attributions if still pristine.
-- The generic SOP article bodies are kept.
-- ---------------------------------------------------------------------------
update kb_articles set author = ''
  where id = 'k1' and author = 'Daniel Cross (Ops Director)';
update kb_articles set author = ''
  where id = 'k2' and author = 'Elena Rostova (Compliance Leader)';

-- ---------------------------------------------------------------------------
-- INVENTORY — delete the starter ingredients (invented suppliers + costs) only
-- if each row is still exactly as seeded. FK: stock_movements.ingredient_id is
-- ON DELETE CASCADE, so any (dev-only) movements for a pristine ingredient go
-- with it; production has none.
-- ---------------------------------------------------------------------------
delete from ingredients where id = 'ing_milk'
  and name = 'Whole milk' and supplier = 'DairyDirect UK'
  and cost_per_unit = 0.0011 and par_level = 40000;
delete from ingredients where id = 'ing_icecream'
  and name = 'Soft-serve base mix' and supplier = 'CreamCo'
  and cost_per_unit = 0.0028 and par_level = 20000;
delete from ingredients where id = 'ing_caramel'
  and name = 'Caramel syrup' and supplier = 'SweetSupplies'
  and cost_per_unit = 0.0060 and par_level = 5000;
delete from ingredients where id = 'ing_strawb'
  and name = 'Strawberry purée' and supplier = 'BerryFarm'
  and cost_per_unit = 0.0075 and par_level = 4000;
delete from ingredients where id = 'ing_choc'
  and name = 'Chocolate crumb' and supplier = 'CocoaWorks'
  and cost_per_unit = 0.0090 and par_level = 3000;
delete from ingredients where id = 'ing_cream'
  and name = 'Whipping cream' and supplier = 'DairyDirect UK'
  and cost_per_unit = 0.0040 and par_level = 6000;
delete from ingredients where id = 'ing_straws'
  and name = 'Paper straws' and supplier = 'EcoPack'
  and cost_per_unit = 0.0200 and par_level = 500;
delete from ingredients where id = 'ing_cups_400'
  and name = '400ml dome cups' and supplier = 'EcoPack'
  and cost_per_unit = 0.0900 and par_level = 600;
