-- ============================================================================
--  !! FRESH-INSTALL-ONLY — DESTRUCTIVE !!            (R4.8, Workstream J3)
--
--  This file DROPS AND RECREATES the entire public schema. It exists ONLY for
--  a brand-new, EMPTY database. It is NOT part of any production upgrade:
--  production changes flow exclusively through the migration ledger
--  (launch/migration-manifest.sh → MP_MIGRATIONS/MP_FUTURE_MIGRATIONS).
--
--  The DO block below makes that rule EXECUTABLE: if any user table already
--  exists in `public`, the file refuses to run and nothing is touched.
--  Deliberately bypassing it requires deleting the guard — an unmistakably
--  destructive act that cannot happen by accident from a runbook paste.
-- ============================================================================
do $$
declare v_existing int;
begin
  select count(*) into v_existing
    from pg_catalog.pg_tables
   where schemaname = 'public';
  if v_existing > 0 then
    raise exception using
      message = 'REFUSED: schema.FRESH-INSTALL-ONLY.sql may only run on an EMPTY database. '
             || 'This database already has ' || v_existing || ' public table(s). '
             || 'Production and existing installs upgrade ONLY via the migration ledger '
             || '(see docs/PRODUCTION-LAUNCH-RUNBOOK-v4.8.md). Nothing was changed.';
  end if;
end $$;

-- ============================================================================
--  MILK POP — COMPLETE SUPABASE / POSTGRESQL SCHEMA
--  FRESH INSTALL ONLY: run on an EMPTY project (the guard above enforces it),
--  then seed.sql. Existing/production databases use the migration ledger.
--
--  Design notes
--  ------------
--  • Column names are the snake_case mirror of the app's TypeScript types
--    (src/types.ts), so the client syncs with a mechanical camel⇄snake map.
--  • Nested arrays the app owns (order lines, quiz questions, SIFR replies…)
--    are stored as JSONB on the parent row — AND the sales core is ALSO fully
--    normalised: a trigger explodes orders.items into order_items /
--    order_item_modifiers so SQL analytics never touch JSON.
--  • SECURITY: every table has RLS enabled and access is DENY BY DEFAULT.
--    The anon key can SELECT public website content and INSERT public form
--    submissions — nothing else. There is no "demo" policy. See section 9.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- CLEAN SLATE (safe to re-run: drops existing tables in dependency order)
-- Comment this section out if you want to preserve existing data on re-run.
-- ---------------------------------------------------------------------------
drop table if exists order_item_modifiers cascade;
drop table if exists order_items cascade;
drop table if exists loyalty_transactions cascade;
drop table if exists stock_movements cascade;
drop table if exists clock_history cascade;
drop table if exists payslips cascade;
drop table if exists orders cascade;
drop table if exists customers cascade;
drop table if exists ingredients cascade;
drop table if exists deals cascade;
drop table if exists menu_items cascade;
drop table if exists sifr_reports cascade;
drop table if exists staff_documents cascade;
drop table if exists work_shifts cascade;
drop table if exists checklist_templates cascade;
drop table if exists training_assessments cascade;
drop table if exists training_courses cascade;
drop table if exists kb_articles cascade;
drop table if exists media_assets cascade;
drop table if exists audit_logs cascade;
drop table if exists role_permissions cascade;
drop table if exists app_state cascade;
drop table if exists contact_messages cascade;
drop table if exists franchise_inquiries cascade;
drop table if exists job_applications cascade;
drop table if exists job_vacancies cascade;
drop table if exists news_posts cascade;
drop table if exists cms_pages cascade;
drop table if exists staff_profiles cascade;
drop table if exists stores cascade;
drop table if exists site_settings cascade;
drop type if exists deal_type cascade;
drop type if exists item_size cascade;
drop type if exists payment_method cascade;
drop type if exists order_status cascade;
drop type if exists order_channel cascade;
drop type if exists store_status cascade;
drop type if exists employee_role cascade;
drop type if exists menu_category cascade;
drop function if exists set_updated_at cascade;
drop function if exists explode_order_items cascade;

-- ---------------------------------------------------------------------------
-- 0. EXTENSIONS & ENUM TYPES
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;

do $$ begin
  create type menu_category as enum ('milkshakes','smoothies','soft_serve','slush','extras');
exception when duplicate_object then null; end $$;

do $$ begin
  create type employee_role as enum ('team_member','supervisor','store_manager','owner');
exception when duplicate_object then null; end $$;

do $$ begin
  create type store_status as enum ('open','closed','coming_soon');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_channel as enum ('walk_in','phone','website','deliveroo','uber_eats','just_eat');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status as enum ('open','completed','refunded','voided');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_method as enum ('cash','card','online','gift_card');
exception when duplicate_object then null; end $$;

do $$ begin
  create type item_size as enum ('regular','large','one_size');
exception when duplicate_object then null; end $$;

do $$ begin
  create type deal_type as enum ('bundle_price','buy_x_get_y_free','percent_off_category','fixed_off_order');
exception when duplicate_object then null; end $$;

-- updated_at housekeeping trigger, shared by every table
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end $$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 1. SITE SETTINGS (single row, id = 1)
-- ---------------------------------------------------------------------------
create table if not exists site_settings (
  id                     int primary key default 1 check (id = 1),
  brand_name             text not null default 'MILK POP',
  legal_name             text not null default '',
  company_number         text not null default '',
  vat_number             text not null default '',
  website_url            text not null default 'https://milkpop.uk',
  instagram_handle       text not null default '',
  instagram_url          text not null default '',
  facebook_url           text not null default '',
  twitter_url            text not null default '',
  phone                  text not null default '',
  email                  text not null default '',
  gdpr_email             text not null default '',
  hq_address             text not null default '',
  footer_tagline         text not null default '',
  allergen_notice        text not null default '',
  announcement_enabled   boolean not null default false,
  announcement_text      text not null default '',
  currency_symbol        text not null default '£',
  vat_rate_percent       numeric(5,2) not null default 20,
  default_opening_hours  text not null default '',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create trigger trg_site_settings_updated before update on site_settings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. CATALOGUE — stores, menu, deals
-- ---------------------------------------------------------------------------
create table if not exists stores (
  id             text primary key,
  name           text not null unique,
  address        text not null,
  postcode       text not null,
  opening_hours  text not null default '',
  status         store_status not null default 'open',
  delivery_links jsonb not null default '{}'::jsonb,
  phone          text not null default '',
  email          text not null default '',
  image          text not null default '',
  coordinates    jsonb not null default '{}'::jsonb,   -- { "lat": .., "lng": .. }
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger trg_stores_updated before update on stores
  for each row execute function set_updated_at();

create table if not exists menu_items (
  id           text primary key,
  name         text not null,
  description  text not null default '',
  category     menu_category not null,
  price        numeric(10,2) not null check (price >= 0),
  price_large  numeric(10,2) check (price_large is null or price_large >= 0),
  calories     int not null default 0,
  tags         jsonb not null default '[]'::jsonb,
  allergens    jsonb not null default '[]'::jsonb,
  image        text not null default '',
  -- Fresh installs run seed.sql before replaying the historical migration chain.
  -- The production seed deliberately inserts starter products unavailable, so
  -- this compatibility column must exist before migration_r48_allergens.sql.
  -- Keep the historical R4.8 default (TRUE); the seed writes FALSE explicitly,
  -- and migration_r410_publication_defaults later changes the default to FALSE.
  available    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_menu_items_category on menu_items (category);
create trigger trg_menu_items_updated before update on menu_items
  for each row execute function set_updated_at();

create table if not exists deals (
  id              text primary key,
  name            text not null,
  description     text not null default '',
  type            deal_type not null,
  active          boolean not null default true,
  category        menu_category,
  buy_qty         int,
  bundle_price    numeric(10,2),
  free_qty        int,
  percent_off     numeric(5,2),
  amount_off      numeric(10,2),
  min_order_value numeric(10,2),
  badge           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger trg_deals_updated before update on deals
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. SALES CORE — orders (JSONB source of truth) + normalised children
-- ---------------------------------------------------------------------------
create table if not exists orders (
  id              text primary key,
  order_number    bigint not null,
  store_id        text references stores(id) on delete set null,
  store_name      text not null default '',
  channel         order_channel not null default 'walk_in',
  items           jsonb not null default '[]'::jsonb,   -- OrderItem[] snapshot
  applied_deals   jsonb not null default '[]'::jsonb,   -- AppliedDeal[]
  subtotal        numeric(10,2) not null default 0,
  discount_total  numeric(10,2) not null default 0,
  tax_rate        numeric(5,2)  not null default 20,
  tax_amount      numeric(10,2) not null default 0,
  total           numeric(10,2) not null default 0,
  payment_method  payment_method not null default 'card',
  cash_received   numeric(10,2),
  change_given    numeric(10,2),
  status          order_status not null default 'completed',
  customer_name   text,
  staff_id        text,
  staff_name      text not null default '',
  placed_at       timestamptz not null default now(),
  completed_at    timestamptz,
  refund_reason   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_orders_placed_at on orders (placed_at desc);
create index if not exists idx_orders_status on orders (status);
create index if not exists idx_orders_channel on orders (channel);
create index if not exists idx_orders_store on orders (store_id);
create trigger trg_orders_updated before update on orders
  for each row execute function set_updated_at();

create table if not exists order_items (
  row_id       uuid primary key default gen_random_uuid(),
  id           text not null,                                   -- line id from the app
  order_id     text not null references orders(id) on delete cascade,
  menu_item_id text,                                            -- soft link (menu items may be renamed/deleted)
  name         text not null,
  category     menu_category not null,
  size         item_size not null default 'one_size',
  unit_price   numeric(10,2) not null,
  quantity     int not null check (quantity > 0),
  line_total   numeric(10,2) not null,
  notes        text
);
create index if not exists idx_order_items_order on order_items (order_id);
create index if not exists idx_order_items_menu_item on order_items (menu_item_id);

create table if not exists order_item_modifiers (
  row_id        uuid primary key default gen_random_uuid(),
  id            text not null,
  order_item_id uuid not null references order_items(row_id) on delete cascade,
  order_id      text not null references orders(id) on delete cascade,
  menu_item_id  text,
  name          text not null,
  price         numeric(10,2) not null default 0
);
create index if not exists idx_oim_order on order_item_modifiers (order_id);

-- Trigger: explode orders.items JSONB into the normalised child tables.
-- The client only ever writes to `orders`; the database keeps analytics tables
-- perfectly in sync — one write, one organism.
create or replace function explode_order_items() returns trigger as $$
declare
  item jsonb;
  mod  jsonb;
  new_item_row uuid;
begin
  delete from order_items where order_id = new.id;  -- cascades to modifiers
  for item in select * from jsonb_array_elements(coalesce(new.items, '[]'::jsonb))
  loop
    insert into order_items (id, order_id, menu_item_id, name, category, size, unit_price, quantity, line_total, notes)
    values (
      coalesce(item->>'id', gen_random_uuid()::text),
      new.id,
      item->>'menuItemId',
      coalesce(item->>'name',''),
      coalesce((item->>'category')::menu_category, 'milkshakes'),
      coalesce((item->>'size')::item_size, 'one_size'),
      coalesce((item->>'unitPrice')::numeric, 0),
      greatest(coalesce((item->>'quantity')::int, 1), 1),
      coalesce((item->>'lineTotal')::numeric, 0),
      item->>'notes'
    )
    returning row_id into new_item_row;

    for mod in select * from jsonb_array_elements(coalesce(item->'modifiers', '[]'::jsonb))
    loop
      insert into order_item_modifiers (id, order_item_id, order_id, menu_item_id, name, price)
      values (
        coalesce(mod->>'id', gen_random_uuid()::text),
        new_item_row,
        new.id,
        mod->>'menuItemId',
        coalesce(mod->>'name',''),
        coalesce((mod->>'price')::numeric, 0)
      );
    end loop;
  end loop;
  return new;
end $$ language plpgsql;

drop trigger if exists trg_orders_explode on orders;
create trigger trg_orders_explode after insert or update of items on orders
  for each row execute function explode_order_items();

-- ---------------------------------------------------------------------------
-- 4. CUSTOMERS & LOYALTY (ready for the next phase: online ordering)
-- ---------------------------------------------------------------------------
create table if not exists customers (
  id            text primary key default gen_random_uuid()::text,
  full_name     text not null,
  email         text unique,
  phone         text,
  marketing_ok  boolean not null default false,
  loyalty_points int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger trg_customers_updated before update on customers
  for each row execute function set_updated_at();

create table if not exists loyalty_transactions (
  id          uuid primary key default gen_random_uuid(),
  customer_id text not null references customers(id) on delete cascade,
  order_id    text references orders(id) on delete set null,
  points      int not null,                 -- positive = earned, negative = redeemed
  reason      text not null default 'purchase',
  created_at  timestamptz not null default now()
);
create index if not exists idx_loyalty_customer on loyalty_transactions (customer_id);

-- ---------------------------------------------------------------------------
-- 5. INVENTORY (ingredients & stock movements per store)
-- ---------------------------------------------------------------------------
create table if not exists ingredients (
  id          text primary key default gen_random_uuid()::text,
  name        text not null unique,
  unit        text not null default 'unit',        -- ml, g, unit…
  par_level   numeric(12,2) not null default 0,    -- reorder threshold
  cost_per_unit numeric(12,4) not null default 0,
  supplier    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_ingredients_updated before update on ingredients
  for each row execute function set_updated_at();

create table if not exists stock_movements (
  id            uuid primary key default gen_random_uuid(),
  ingredient_id text not null references ingredients(id) on delete cascade,
  store_id      text references stores(id) on delete set null,
  quantity      numeric(12,2) not null,            -- positive delivery, negative usage/waste
  movement_type text not null default 'delivery' check (movement_type in ('delivery','usage','waste','stocktake_adjustment')),
  note          text,
  recorded_by   text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_stock_ingredient on stock_movements (ingredient_id);
create or replace view stock_levels as
  select i.id, i.name, i.unit, i.par_level,
         coalesce(sum(m.quantity), 0) as on_hand,
         coalesce(sum(m.quantity), 0) < i.par_level as below_par
  from ingredients i
  left join stock_movements m on m.ingredient_id = i.id
  group by i.id;

-- ---------------------------------------------------------------------------
-- 6. PEOPLE & OPERATIONS — staff, shifts, checklists, documents, SIFR, training
-- ---------------------------------------------------------------------------
create table if not exists staff_profiles (
  id                   text primary key,
  name                 text not null,
  -- NOTE: e-mail uniqueness is enforced by the Admin Panel form. A hard DB
  -- unique constraint here would make one duplicate fail an entire bulk
  -- upsert batch, silently losing every other row in the same sync push.
  email                text not null,
  -- SECURITY: there is intentionally NO password column. An earlier version
  -- stored plaintext passwords here that the browser compared client-side;
  -- staff authentication belongs to Supabase Auth (auth.users), with this
  -- table holding profile data only. migration_security_lockdown.sql drops
  -- the column (after nulling it) on databases created from the old schema.
  role                 employee_role not null default 'team_member',
  store_id             text,
  store_name           text not null default '',
  next_shift           text not null default '',
  holiday_balance      numeric(5,1) not null default 28,
  points               int not null default 0,
  level                int not null default 1,
  badges               jsonb not null default '[]'::jsonb,
  avatar               text not null default '',
  pay_rate             numeric(10,2),
  pay_type             text check (pay_type in ('hourly','salary')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger trg_staff_updated before update on staff_profiles
  for each row execute function set_updated_at();

create table if not exists work_shifts (
  id            text primary key,
  employee_id   text,
  employee_name text not null default '',
  role          employee_role not null default 'team_member',
  store_id      text,
  store_name    text not null default '',
  date          date not null,
  start_time    text not null,
  end_time      text not null,
  type          text not null default 'mid' check (type in ('opening','mid','closing','delivery','training')),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_shifts_date on work_shifts (date);
create trigger trg_shifts_updated before update on work_shifts
  for each row execute function set_updated_at();

-- Timesheets: one row per clock-in/clock-out pair. Entries start as Pending
-- (approved = false) and a store manager / owner approves or rejects them.
-- Only approved hours feed the payslips.
create table if not exists clock_history (
  id                     text primary key,
  employee_id            text,
  employee_name          text not null default '',
  date                   text not null,                -- YYYY-MM-DD
  clock_in               text not null,                -- ISO timestamp
  clock_out              text,                         -- ISO timestamp
  break_duration_minutes int default 0,
  total_decimal_hours    numeric(7,2) default 0,
  approved               boolean default false,
  rejected               boolean default false,
  approved_by            text,
  approved_at            text,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists idx_clock_history_emp on clock_history (employee_id);
create index if not exists idx_clock_history_date on clock_history (date);
create trigger trg_clock_history_updated before update on clock_history
  for each row execute function set_updated_at();

-- Payslips: generated per employee per calendar month from approved hours.
create table if not exists payslips (
  id            text primary key,
  employee_id   text,
  employee_name text not null default '',
  email         text not null default '',
  period_key    text not null,                          -- e.g. 2026-06
  period_label  text not null default '',               -- e.g. June 2026
  hours_total   numeric(8,2) not null default 0,
  hourly_rate   numeric(10,2) not null default 0,
  gross         numeric(10,2) not null default 0,
  deductions    numeric(10,2) not null default 0,
  net           numeric(10,2) not null default 0,
  status        text not null default 'draft' check (status in ('draft','sent')),
  generated_at  text not null default '',
  generated_by  text not null default '',
  sent_at       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_payslips_emp on payslips (employee_id);
create index if not exists idx_payslips_period on payslips (period_key);
create trigger trg_payslips_updated before update on payslips
  for each row execute function set_updated_at();

create table if not exists checklist_templates (
  id         text primary key,
  label      text not null,
  category   text not null check (category in ('opening','midday','closing')),
  critical   boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_checklists_updated before update on checklist_templates
  for each row execute function set_updated_at();

create table if not exists staff_documents (
  id          text primary key,
  name        text not null,
  type        text not null default '',
  category    text not null check (category in ('contracts','compliance','payslips','performance','id_verification')),
  upload_date text not null default '',
  status      text not null default 'pending' check (status in ('approved','pending','action_required')),
  url         text not null default '',
  approved_by text,
  -- Ownership (documented in migration_payroll_cv for pre-payroll DBs; the
  -- fresh install carries it here so the skip-on-fresh note stays true):
  employee_id   text,
  employee_name text not null default '',
  expiry_date text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_docs_updated before update on staff_documents
  for each row execute function set_updated_at();

create table if not exists sifr_reports (
  id               text primary key,
  title            text not null,
  category         text not null,
  date             text not null default '',
  involved_people  text not null default '',
  store_id         text,
  store_name       text not null default '',
  description      text not null default '',
  impact           text not null default '',
  suggested_action text not null default '',
  confidentiality  text not null default 'standard' check (confidentiality in ('confidential','standard')),
  status           text not null default 'submitted' check (status in ('submitted','under_review','escalated','action_required','resolved','closed')),
  reporter_name    text not null default '',
  reporter_id      text,
  submitted_at     text not null default '',
  replies          jsonb default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger trg_sifr_updated before update on sifr_reports
  for each row execute function set_updated_at();

create table if not exists training_courses (
  id             text primary key,
  title          text not null,
  description    text not null default '',
  category       text not null default 'induction',
  progress       int not null default 0,
  points         int not null default 0,
  estimated_time text not null default '',
  badge          text not null default '',
  assessment_id  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger trg_courses_updated before update on training_courses
  for each row execute function set_updated_at();

create table if not exists training_assessments (
  id                  text primary key,
  title               text not null,
  description         text not null default '',
  learning_objectives jsonb not null default '[]'::jsonb,
  passing_score       int not null default 80,
  slides              jsonb not null default '[]'::jsonb,
  questions           jsonb not null default '[]'::jsonb,
  category            text not null default 'brand',
  points              int not null default 0,
  badge               text not null default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger trg_assessments_updated before update on training_assessments
  for each row execute function set_updated_at();

create table if not exists kb_articles (
  id           text primary key,
  title        text not null,
  category     text not null default 'recipes',
  last_updated text not null default '',
  author       text not null default '',
  reading_time text not null default '',
  content      text not null default '',
  steps        jsonb default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger trg_kb_updated before update on kb_articles
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. RECRUITMENT, LEADS, CONTENT & GOVERNANCE
-- ---------------------------------------------------------------------------
create table if not exists job_vacancies (
  id               text primary key,
  title            text not null,
  department       text not null default '',
  location         text not null default '',
  salary           text not null default '',
  type             text not null default 'Part-time' check (type in ('Full-time','Part-time')),
  role_description text not null default '',
  requirements     jsonb not null default '[]'::jsonb,
  responsibilities jsonb not null default '[]'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger trg_vacancies_updated before update on job_vacancies
  for each row execute function set_updated_at();

create table if not exists job_applications (
  id             text primary key,
  full_name      text not null,
  email          text not null,
  phone          text not null default '',
  applied_for    text not null default '',
  applied_store  text not null default '',
  availability   text not null default '',
  experience     text not null default '',
  -- SECURITY (Phase 1 review): no CV columns. CV capture is disabled until the
  -- Phase 5 upload pipeline exists; storing CV paths — or worse, base64 file
  -- bytes — on this row was retired with it (see migration_security_lockdown).
  message        text not null default '',
  status         text not null default 'pending' check (status in ('pending','reviewing','interview','offer','declined')),
  applied_at     text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger trg_applications_updated before update on job_applications
  for each row execute function set_updated_at();

create table if not exists franchise_inquiries (
  id           text primary key,
  full_name    text not null,
  email        text not null,
  phone        text not null default '',
  country      text not null default '',
  city         text not null default '',
  budget       text not null default '',
  experience   text not null default '',
  message      text not null default '',
  status       text not null default 'pending' check (status in ('pending','reviewed','contacted','approved','declined')),
  submitted_at text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger trg_franchise_updated before update on franchise_inquiries
  for each row execute function set_updated_at();

create table if not exists contact_messages (
  id           text primary key,
  full_name    text not null,
  email        text not null,
  reason       text not null default '',
  message      text not null default '',
  submitted_at text not null default '',
  created_at   timestamptz not null default now()
);

create table if not exists news_posts (
  id         text primary key,
  title      text not null,
  content    text not null default '',
  category   text not null default 'Announcement',
  date       text not null default '',
  status     text not null default 'draft' check (status in ('draft','published')),
  image      text,
  tag_color  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_news_updated before update on news_posts
  for each row execute function set_updated_at();

create table if not exists cms_pages (
  id               text primary key,
  page_name        text not null,
  title            text not null default '',
  hero_headline    text not null default '',
  hero_subheadline text not null default '',
  hero_image       text not null default '',
  about_image1     text,
  about_image2     text,
  cta_text         text not null default '',
  section_content  text not null default '',
  seo_title        text not null default '',
  seo_description  text not null default '',
  status           text not null default 'published' check (status in ('draft','published')),
  last_edited_by   text not null default '',
  last_edited_date text not null default '',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger trg_cms_updated before update on cms_pages
  for each row execute function set_updated_at();

create table if not exists media_assets (
  id          text primary key,
  name        text not null,
  folder      text not null default 'brand' check (folder in ('products','stores','banners','documents','brand')),
  size        text not null default '',
  type        text not null default '',
  uploaded_at text not null default '',
  url         text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists audit_logs (
  id             text primary key,
  operator_name  text not null default '',
  role           text not null default '',
  action         text not null default '',
  timestamp      text not null default '',
  module         text not null default '',
  previous_value text,
  new_value      text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_audit_module on audit_logs (module);

-- Generic key-value store: catches every remaining piece of app state so the
-- website syncs "every step" — checklist ticks, clock records, shift covers…
create table if not exists app_state (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz not null default now()
);
create trigger trg_app_state_updated before update on app_state
  for each row execute function set_updated_at();

create table if not exists role_permissions (
  role      employee_role primary key,
  "view"    boolean not null default true,
  "create"  boolean not null default false,
  "edit"    boolean not null default false,
  "delete"  boolean not null default false,
  "approve" boolean not null default false,
  "publish" boolean not null default false
);

-- ---------------------------------------------------------------------------
-- 8. ANALYTICS VIEWS — pure SQL over the normalised sales core
-- ---------------------------------------------------------------------------
create or replace view daily_sales as
  select
    date_trunc('day', placed_at)::date as sales_date,
    store_name,
    count(*)                                             as orders_count,
    sum(total)                                           as gross_revenue,
    sum(tax_amount)                                      as vat_collected,
    sum(discount_total)                                  as discounts_given,
    round(avg(total), 2)                                 as average_ticket
  from orders
  where status = 'completed'
  group by 1, 2
  order by 1 desc;

create or replace view top_products as
  select
    oi.menu_item_id,
    oi.name,
    oi.category,
    sum(oi.quantity)   as units_sold,
    sum(oi.line_total) as revenue
  from order_items oi
  join orders o on o.id = oi.order_id and o.status = 'completed'
  group by 1, 2, 3
  order by units_sold desc;

create or replace view sales_by_channel as
  select
    channel,
    count(*)        as orders_count,
    sum(total)      as gross_revenue,
    round(avg(total), 2) as average_ticket
  from orders
  where status = 'completed'
  group by channel
  order by gross_revenue desc;

create or replace view popular_modifiers as
  select m.name, count(*) as times_added, sum(m.price) as revenue
  from order_item_modifiers m
  join orders o on o.id = m.order_id and o.status = 'completed'
  group by m.name
  order by times_added desc;

-- ---------------------------------------------------------------------------
-- 9. ROW LEVEL SECURITY — deny by default
-- ---------------------------------------------------------------------------
-- RLS is ON for every table. With RLS enabled and no matching policy,
-- PostgreSQL denies the operation — that is the default posture here.
--
-- The ONLY things an anonymous client may do:
--   • SELECT the public website content tables (the site needs them to render);
--   • INSERT into the three public form tables (careers / franchise / contact).
--     Note: INSERT only — no SELECT, so a visitor can never read anyone
--     else's application, enquiry or message back out.
--
-- Explicitly PRIVATE (no anon policies of any kind): staff_profiles,
-- work_shifts (rota), clock_history (timesheets), payslips (payroll),
-- staff_documents, sifr_reports (incidents), orders / order_items /
-- order_item_modifiers (payments & refunds), customers, loyalty_transactions,
-- ingredients, stock_movements, training_courses, training_assessments,
-- kb_articles (internal knowledge base), audit_logs, role_permissions,
-- checklist_templates and app_state (private settings).
--
-- When staff move onto Supabase Auth, add per-role policies scoped to
-- auth.uid() — worked examples:
--   create policy "staff read own profile" on staff_profiles
--     for select using (auth.uid()::text = id);
--   create policy "owners manage staff" on staff_profiles
--     for all using (exists (
--       select 1 from staff_profiles p
--       where p.id = auth.uid()::text and p.role = 'owner'));
-- NEVER recreate a using(true)/with check(true) policy for the anon role.

-- 9a. Enable RLS everywhere and clear the legacy wide-open demo policy.
do $$
declare t text;
begin
  foreach t in array array[
    'site_settings','stores','menu_items','deals','orders','order_items',
    'order_item_modifiers','customers','loyalty_transactions','ingredients',
    'stock_movements','staff_profiles','work_shifts','checklist_templates',
    'staff_documents','sifr_reports','training_courses','training_assessments',
    'kb_articles','job_vacancies','job_applications','franchise_inquiries',
    'contact_messages','news_posts','cms_pages','media_assets','audit_logs',
    'role_permissions','app_state','clock_history','payslips'
  ] loop
    execute format('alter table %I enable row level security', t);
    -- Remove the historical demo_full_access policy if this schema is being
    -- re-run over an old database. It must never be recreated.
    execute format('drop policy if exists demo_full_access on %I', t);
  end loop;
end $$;

-- 9b. Public website content — anonymous SELECT only.
do $$
declare t text;
begin
  foreach t in array array[
    'site_settings','stores','menu_items','deals','job_vacancies',
    'news_posts','cms_pages','media_assets'
  ] loop
    execute format('drop policy if exists public_read on %I', t);
    execute format('create policy public_read on %I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

-- 9c. Public forms — PHASE B: NO direct client INSERT, anonymous or
--     authenticated. Submissions reach these tables exclusively through the
--     `public-form` Edge Function (service role, bypasses RLS) after field
--     allow-listing, per-IP rate limiting and CAPTCHA verification.
--     A fresh install therefore ends with the secure final state; databases
--     created before Phase B are closed by migration_phase_b_public_forms.sql.
do $$
declare t text;
begin
  foreach t in array array[
    'job_applications','franchise_inquiries','contact_messages'
  ] loop
    -- Remove the historical direct-insert policy if this schema is re-run on
    -- an older database, and revoke the table-level INSERT grants so RLS
    -- deny-by-default is backed by missing privileges too.
    execute format('drop policy if exists public_insert on %I', t);
    execute format('revoke insert on %I from anon', t);
    execute format('revoke insert on %I from authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 10. STORAGE — `cvs` bucket: PRIVATE and FAIL-CLOSED (no policies at all)
-- ---------------------------------------------------------------------------
-- SECURITY (Phase 1 review): anonymous CV upload is DISABLED until the Phase 5
-- controls exist (server-side validation, file-size limits, MIME verification,
-- random object paths, overwrite prevention, CAPTCHA, rate limiting, orphan
-- cleanup — see the security notes in README.md). The bucket is created private with NO
-- read policy and NO insert policy for any client role: with RLS on
-- storage.objects and no matching policy, every anonymous read AND write is
-- denied. Do not add an upload policy here — it ships with the Phase 5 work.
insert into storage.buckets (id, name, public)
values ('cvs', 'cvs', false)
on conflict (id) do update set public = false;

drop policy if exists "cvs_public_upload" on storage.objects;
drop policy if exists "cvs_candidate_upload" on storage.objects;
drop policy if exists "cvs_public_read" on storage.objects;
