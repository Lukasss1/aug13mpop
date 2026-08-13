-- MILK POP — ONE-TIME RECOVERY FROM THE KNOWN T13.3.28 FIRST-PRODUCTION FRESH-INSTALL INCIDENT
-- Hardened by T13.3.30 final production closure.
--
-- Use ONLY for the single incident proved by the protected commissioning log:
--   1. the Supabase project had no Milk Pop application state immediately before fresh install;
--   2. supabase/schema.FRESH-INSTALL-ONLY.sql completed;
--   3. the first site_settings seed row committed;
--   4. seed.sql then failed on menu_items.available before any migration-ledger row existed.
--
-- This is NOT a general reset tool. It deliberately requires the database to
-- match that incident exactly. Missing expected objects, extra objects, changed
-- seed data, Auth users, or any unrelated Storage state abort the transaction
-- before deletion.

begin;

-- 1. The known failed run stopped before migration-ledger creation. Any ledger
-- means the project progressed beyond the incident this script is allowed to
-- repair.
do $$
begin
  if to_regclass('public.mp_migration_ledger') is not null then
    raise exception 'Refusing recovery: public.mp_migration_ledger exists. The project progressed beyond the known T13.3.28 incident.';
  end if;
end $$;

-- 2. A pre-existing Supabase-documented RLS auto-enable safety trigger is
-- not MilkPop application state. The real production project contains this
-- exact helper. Tolerate ONLY the exact official function + enabled event
-- trigger pair; any same-name drift or extra overload still fails closed.
do $$
declare
  f_count integer;
  e_count integer;
  pair_ok boolean := false;
  expected_body constant text := $rls_body$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$rls_body$;
begin
  select count(*) into f_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'rls_auto_enable';
  select count(*) into e_count
    from pg_catalog.pg_event_trigger e
   where e.evtname = 'ensure_rls';

  if f_count = 0 and e_count = 0 then
    perform set_config('milkpop.safe_rls_auto_enable_present', 'false', true);
    return;
  end if;
  if f_count <> 1 or e_count <> 1 then
    raise exception 'Refusing recovery: RLS auto-enable safety pair mismatch (functions=%, triggers=%).', f_count, e_count;
  end if;

  select
    p.pronargs = 0
    and p.prokind = 'f'
    and p.prorettype = 'event_trigger'::regtype
    and l.lanname = 'plpgsql'
    and p.prosecdef is true
    and pg_get_userbyid(p.proowner) = 'postgres'
    and p.proconfig = array['search_path=pg_catalog']::text[]
    and btrim(regexp_replace(p.prosrc, '[[:space:]]+', ' ', 'g'))
        = btrim(regexp_replace(expected_body, '[[:space:]]+', ' ', 'g'))
    and exists (
      select 1 from pg_catalog.pg_event_trigger e
       where e.evtname = 'ensure_rls'
         and e.evtevent = 'ddl_command_end'
         and e.evtenabled = 'O'
         and e.evtfoid = p.oid
         and e.evttags @> array['CREATE TABLE','CREATE TABLE AS','SELECT INTO']::text[]
         and e.evttags <@ array['CREATE TABLE','CREATE TABLE AS','SELECT INTO']::text[]
    )
    and (select count(*) from pg_catalog.pg_event_trigger e where e.evtfoid = p.oid) = 1
    into pair_ok
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_language l on l.oid = p.prolang
   where n.nspname = 'public' and p.proname = 'rls_auto_enable';

  if not coalesce(pair_ok, false) then
    raise exception 'Refusing recovery: public.rls_auto_enable()/ensure_rls is present but does not exactly match the approved Supabase RLS safety helper.';
  end if;
  perform set_config('milkpop.safe_rls_auto_enable_present', 'true', true);
end $$;

-- 3. Require the exact public object fingerprint created by the known failed
-- base schema. Extension-owned objects are provider state and intentionally
-- excluded. Both missing and unexpected application objects fail closed.
do $$
declare
  actual_tables text[];
  actual_views text[];
  actual_routines text[];
  actual_types text[];
  expected_tables constant text[] := array[
    'app_state','audit_logs','checklist_templates','clock_history','cms_pages',
    'contact_messages','customers','deals','franchise_inquiries','ingredients',
    'job_applications','job_vacancies','kb_articles','loyalty_transactions',
    'media_assets','menu_items','news_posts','order_item_modifiers','order_items',
    'orders','payslips','role_permissions','sifr_reports','site_settings',
    'staff_documents','staff_profiles','stock_movements','stores',
    'training_assessments','training_courses','work_shifts'
  ]::text[];
  expected_views constant text[] := array[
    'daily_sales','popular_modifiers','sales_by_channel','stock_levels','top_products'
  ]::text[];
  expected_routines constant text[] := array['explode_order_items','set_updated_at']::text[];
  expected_types constant text[] := array[
    'deal_type','employee_role','item_size','menu_category','order_channel',
    'order_status','payment_method','store_status'
  ]::text[];
begin
  select coalesce(array_agg(c.relname order by c.relname), array[]::text[])
    into actual_tables
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r','p')
     and not exists (
       select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_class'::regclass
          and d.objid = c.oid
          and d.deptype = 'e'
     );
  if actual_tables is distinct from expected_tables then
    raise exception 'Refusing recovery: public table fingerprint mismatch. Expected %, found %.', expected_tables, actual_tables;
  end if;

  select coalesce(array_agg(c.relname order by c.relname), array[]::text[])
    into actual_views
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('v','m')
     and not exists (
       select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_class'::regclass
          and d.objid = c.oid
          and d.deptype = 'e'
     );
  if actual_views is distinct from expected_views then
    raise exception 'Refusing recovery: public view fingerprint mismatch. Expected %, found %.', expected_views, actual_views;
  end if;

  select coalesce(array_agg(p.proname order by p.proname), array[]::text[])
    into actual_routines
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname <> 'rls_auto_enable'
     and not exists (
       select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_proc'::regclass
          and d.objid = p.oid
          and d.deptype = 'e'
     );
  if actual_routines is distinct from expected_routines then
    raise exception 'Refusing recovery: public routine fingerprint mismatch. Expected %, found %.', expected_routines, actual_routines;
  end if;

  select coalesce(array_agg(t.typname order by t.typname), array[]::text[])
    into actual_types
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public'
     and t.typrelid = 0
     and t.typtype in ('e','d','r','m')
     and not exists (
       select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_type'::regclass
          and d.objid = t.oid
          and d.deptype = 'e'
     );
  if actual_types is distinct from expected_types then
    raise exception 'Refusing recovery: public standalone-type fingerprint mismatch. Expected %, found %.', expected_types, actual_types;
  end if;
end $$;

-- 4. The known incident occurred before owner/Auth bootstrap and before any
-- uploaded Storage object existed. The base schema created exactly one private,
-- empty `cvs` bucket. Any other provider state means this is no longer the
-- known incident.
do $$
declare
  n bigint;
begin
  select count(*) into n from auth.users;
  if n <> 0 then
    raise exception 'Refusing recovery: % Auth user(s) exist. The target progressed beyond the known T13.3.28 incident.', n;
  end if;

  select count(*) into n from storage.objects;
  if n <> 0 then
    raise exception 'Refusing recovery: % Storage object(s) exist. The known incident had no uploaded objects.', n;
  end if;

  select count(*) into n from storage.buckets;
  if n <> 1 then
    raise exception 'Refusing recovery: expected exactly one Storage bucket (private cvs), found %.', n;
  end if;
  if not exists (
    select 1 from storage.buckets
     where id = 'cvs' and name = 'cvs' and public is false
  ) then
    raise exception 'Refusing recovery: the sole Storage bucket is not the exact private cvs bucket created by the known baseline.';
  end if;
end $$;

-- 5. The only row that committed before the known seed failure was the initial
-- site_settings row. Every other baseline table must still be completely empty.
do $$
declare
  tbl text;
  has_rows boolean;
begin
  foreach tbl in array array[
    'app_state','audit_logs','checklist_templates','clock_history','cms_pages',
    'contact_messages','customers','deals','franchise_inquiries','ingredients',
    'job_applications','job_vacancies','kb_articles','loyalty_transactions',
    'media_assets','menu_items','news_posts','order_item_modifiers','order_items',
    'orders','payslips','role_permissions','sifr_reports','staff_documents',
    'staff_profiles','stock_movements','stores','training_assessments',
    'training_courses','work_shifts'
  ] loop
    execute format('select exists (select 1 from public.%I)', tbl) into has_rows;
    if has_rows then
      raise exception 'Refusing recovery: data exists in public.%. The known failed baseline left this table empty.', tbl;
    end if;
  end loop;
end $$;

-- 6. Require the exact known site_settings seed row. Timestamps are intentionally
-- ignored; all business-controlled values must still equal the original seed.
do $$
declare
  n bigint;
begin
  select count(*) into n from public.site_settings;
  if n <> 1 then
    raise exception 'Refusing recovery: expected exactly one site_settings row, found %.', n;
  end if;

  if not exists (
    select 1
      from public.site_settings s
     where s.id = 1
       and s.brand_name = 'MILK POP'
       and s.legal_name = ''
       and s.company_number = ''
       and s.vat_number = ''
       and s.website_url = 'https://milkpop.uk'
       and s.instagram_handle = ''
       and s.instagram_url = ''
       and s.facebook_url = ''
       and s.twitter_url = ''
       and s.phone = ''
       and s.email = ''
       and s.gdpr_email = ''
       and s.hq_address = ''
       and s.footer_tagline = '“Every Milk Pop drink is designed to feel like a small moment of happiness — crafted with care, served with warmth, and made to be remembered.”'
       and s.allergen_notice = 'Allergen notice: Ingredients and allergen information vary by product and supplier. If you have any food allergy or intolerance, please ask a trained team member before ordering. Cross-contact may be possible.'
       and s.announcement_enabled is false
       and s.announcement_text = ''
       and s.currency_symbol = '£'
       and s.vat_rate_percent = 0
       and s.default_opening_hours = ''
  ) then
    raise exception 'Refusing recovery: site_settings no longer matches the exact row committed by the known failed seed.';
  end if;
end $$;

-- 7. Remove only the exact known failed-baseline objects. CASCADE is confined
-- to this proven object set and the whole operation remains transactional.
drop view if exists public.popular_modifiers cascade;
drop view if exists public.sales_by_channel cascade;
drop view if exists public.top_products cascade;
drop view if exists public.daily_sales cascade;
drop view if exists public.stock_levels cascade;

drop table if exists public.order_item_modifiers cascade;
drop table if exists public.order_items cascade;
drop table if exists public.loyalty_transactions cascade;
drop table if exists public.stock_movements cascade;
drop table if exists public.clock_history cascade;
drop table if exists public.payslips cascade;
drop table if exists public.orders cascade;
drop table if exists public.customers cascade;
drop table if exists public.ingredients cascade;
drop table if exists public.deals cascade;
drop table if exists public.menu_items cascade;
drop table if exists public.sifr_reports cascade;
drop table if exists public.staff_documents cascade;
drop table if exists public.work_shifts cascade;
drop table if exists public.checklist_templates cascade;
drop table if exists public.training_assessments cascade;
drop table if exists public.training_courses cascade;
drop table if exists public.kb_articles cascade;
drop table if exists public.media_assets cascade;
drop table if exists public.audit_logs cascade;
drop table if exists public.role_permissions cascade;
drop table if exists public.app_state cascade;
drop table if exists public.contact_messages cascade;
drop table if exists public.franchise_inquiries cascade;
drop table if exists public.job_applications cascade;
drop table if exists public.job_vacancies cascade;
drop table if exists public.news_posts cascade;
drop table if exists public.cms_pages cascade;
drop table if exists public.staff_profiles cascade;
drop table if exists public.stores cascade;
drop table if exists public.site_settings cascade;

drop function if exists public.explode_order_items() cascade;
drop function if exists public.set_updated_at() cascade;

drop type if exists public.deal_type cascade;
drop type if exists public.item_size cascade;
drop type if exists public.payment_method cascade;
drop type if exists public.order_status cascade;
drop type if exists public.order_channel cascade;
drop type if exists public.store_status cascade;
drop type if exists public.employee_role cascade;
drop type if exists public.menu_category cascade;

-- Platform schemas remain intact. Only the exact empty bucket metadata proved
-- above is removed.
delete from storage.buckets where id = 'cvs';

-- 8. Postcondition: the normal protected fresh installer must now observe zero
-- Milk Pop public application state, zero Auth users and zero Storage state.
do $$
declare
  n bigint;
begin
  select count(*) into n
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relkind in ('r','p','v','m','S','f','c')
     and not exists (
       select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_class'::regclass
          and d.objid = c.oid
          and d.deptype = 'e'
     );
  if n <> 0 then
    raise exception 'Recovery postcondition failed: % public application relation(s) remain.', n;
  end if;

  select count(*) into n
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname <> 'rls_auto_enable'
     and not exists (
       select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_proc'::regclass
          and d.objid = p.oid
          and d.deptype = 'e'
     );
  if n <> 0 then
    raise exception 'Recovery postcondition failed: % public application routine(s) remain.', n;
  end if;

  if current_setting('milkpop.safe_rls_auto_enable_present', true) = 'true' then
    if not exists (
      select 1
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
        join pg_catalog.pg_event_trigger e on e.evtfoid = p.oid
       where ns.nspname = 'public'
         and p.proname = 'rls_auto_enable'
         and e.evtname = 'ensure_rls'
         and e.evtevent = 'ddl_command_end'
         and e.evtenabled = 'O'
    ) then
      raise exception 'Recovery postcondition failed: approved RLS auto-enable safety helper did not survive intact.';
    end if;
  elsif exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) or exists (select 1 from pg_catalog.pg_event_trigger where evtname = 'ensure_rls') then
    raise exception 'Recovery postcondition failed: unexpected RLS auto-enable safety state appeared.';
  end if;

  select count(*) into n
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace ns on ns.oid = t.typnamespace
   where ns.nspname = 'public'
     and t.typrelid = 0
     and t.typtype in ('e','d','r','m')
     and not exists (
       select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_type'::regclass
          and d.objid = t.oid
          and d.deptype = 'e'
     );
  if n <> 0 then
    raise exception 'Recovery postcondition failed: % public standalone type(s) remain.', n;
  end if;

  if exists (select 1 from auth.users) then
    raise exception 'Recovery postcondition failed: Auth users remain.';
  end if;
  if exists (select 1 from storage.objects) or exists (select 1 from storage.buckets) then
    raise exception 'Recovery postcondition failed: Storage state remains.';
  end if;
end $$;

commit;
