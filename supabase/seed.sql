-- ============================================================================
--  MILK POP — PRODUCTION SEED
--  Run AFTER schema.sql. Idempotent and NON-DESTRUCTIVE: business-controlled
--  rows are inserted once and are never overwritten on conflict.
--
--  SCOPE (Phase 1 review): this file contains ONLY records a production
--  deployment requires — role/permission matrix, safe configuration defaults
--  (site settings), the draft menu catalogue, and system reference data.
--  Business-controlled public content and staff operating procedures start
--  unpublished/empty until the owner reviews and approves them.
--
--  It contains NO operational records: no applications, enquiries, contact
--  messages, customers, orders, stock movements, incidents, audit entries,
--  employees, shifts, timesheets or payslips. Demo rows of those kinds live in
--  seed.dev.sql (development/test fixtures) which is guarded so it CANNOT run
--  unless the session explicitly opts in — never execute it in production.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- SITE SETTINGS
-- ---------------------------------------------------------------------------
insert into site_settings (id, brand_name, legal_name, company_number, vat_number, website_url,
  instagram_handle, instagram_url, facebook_url, twitter_url, phone, email, gdpr_email, hq_address,
  footer_tagline, allergen_notice, announcement_enabled, announcement_text, currency_symbol,
  vat_rate_percent, default_opening_hours)
-- Unverifiable business facts (company number, VAT, contact phone/e-mail, HQ
-- address, social handles/URLs, default hours) ship BLANK — the owner supplies
-- real values in Admin → Settings → Launch Facts and the UI hides empty fields.
-- website_url is the one repo-verifiable fact (canonical domain) and is set.
-- The historical fresh-schema column vat_rate_percent is seeded at 0 because
-- Milk Pop launches NOT_REGISTERED. A later migration removes this legacy
-- global field and the real authority becomes each store's VAT lifecycle.
values (1, 'MILK POP', '', '', '', 'https://milkpop.uk',
  '', '', '', '',
  '', '', '',
  '',
  '“Every Milk Pop drink is designed to feel like a small moment of happiness — crafted with care, served with warmth, and made to be remembered.”',
  'Allergen notice: Ingredients and allergen information vary by product and supplier. If you have any food allergy or intolerance, please ask a trained team member before ordering. Cross-contact may be possible.',
  false, '', '£', 0,
  '')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- STORES — NONE in the production seed. A launch ships zero storefronts until a
-- genuine location exists; the public store locator then shows a "coming soon"
-- empty state instead of placeholder cards. Add the real kiosk in Admin →
-- Website / Stores. The three demo storefronts used for local UI testing live
-- in seed.dev.sql.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- MENU ITEMS (full catalogue: milkshakes, smoothies, soft serve, slush, extras)
-- ---------------------------------------------------------------------------
insert into menu_items (id, name, description, category, price, price_large, calories, tags, allergens, image, available) values
('m1','Kinder Bueno','A creamy milkshake with smooth Kinder Bueno flavour. (340ml / 400ml)','milkshakes',5,6,0,'["Creamy","Chocolate"]','["Dairy","Nuts","Gluten","Soya"]','/brand/drinks/m1.svg',false),
('m2','Ferrero Rocher','A rich chocolate and hazelnut-inspired milkshake. (340ml / 400ml)','milkshakes',5,6,0,'["Creamy","Chocolate"]','["Dairy","Nuts","Gluten","Soya"]','/brand/drinks/m2.svg',false),
('m3','Oreo','A classic cookies-and-cream milkshake with Oreo flavour. (340ml / 400ml)','milkshakes',5,6,0,'["Creamy","Classic","Chocolate"]','["Dairy","Gluten","Soya"]','/brand/drinks/m3.svg',false),
('m4','Snickers','A creamy milkshake with chocolate, caramel and peanut-style flavour. (340ml / 400ml)','milkshakes',5,6,0,'["Creamy","Chocolate"]','["Dairy","Nuts","Soya"]','/brand/drinks/m4.svg',false),
('m5','KitKat','A smooth chocolate wafer-style milkshake. (340ml / 400ml)','milkshakes',5,6,0,'["Creamy","Chocolate"]','["Dairy","Gluten","Soya"]','/brand/drinks/m5.svg',false),
('m6','Caramel','A sweet and creamy caramel milkshake. (340ml / 400ml)','milkshakes',5,6,0,'["Creamy","Classic"]','["Dairy"]','/brand/drinks/m6.svg',false),
('m7','Biscoff','A creamy milkshake with warm spiced Biscoff. (340ml / 400ml)','milkshakes',5,6,0,'["Creamy","Classic"]','["Dairy","Gluten","Soya"]','/brand/drinks/m7.svg',false),
('m8','Vanilla','A smooth and simple vanilla classic. (340ml / 400ml)','milkshakes',5,6,0,'["Creamy","Classic"]','["Dairy"]','/brand/drinks/m8.svg',false),
('m9','Strawberry','A sweet and creamy strawberry milkshake. (340ml / 400ml)','milkshakes',5,6,0,'["Creamy","Classic","Fruity"]','["Dairy"]','/brand/drinks/m9.svg',false),
('m10','Banana','A smooth and creamy banana milkshake. (340ml / 400ml)','milkshakes',5,6,0,'["Creamy","Classic","Fruity"]','["Dairy"]','/brand/drinks/m10.svg',false),
('sm1','Strawberry Banana','A fruity smoothie with strawberry and banana flavour. (400ml)','smoothies',5,null,0,'["Fruity","Cold"]','[]','/brand/drinks/sm1.svg',false),
('sm2','Acai','A berry-style smoothie with acai flavour. (400ml)','smoothies',6,null,0,'["Fruity","Signature"]','[]','/brand/drinks/sm2.svg',false),
('sm3','Mango Passion Fruit','A tropical smoothie with mango and passion fruit flavour. (400ml)','smoothies',5,null,0,'["Fruity","Cold"]','[]','/brand/drinks/sm3.svg',false),
('sm4','Berry Mix','A refreshing mixed berry smoothie. (400ml)','smoothies',5,null,0,'["Fruity","Cold"]','[]','/brand/drinks/sm4.svg',false),
('ss1','Classic Cup','Smooth soft serve served in a classic cup.','soft_serve',3,null,0,'["Classic","Sweet"]','["Dairy"]','/brand/drinks/ss1.svg',false),
('ss2','Premium Cup','Smooth soft serve served in a premium cup.','soft_serve',4,null,0,'["Signature","Sweet"]','["Dairy"]','/brand/drinks/ss2.svg',false),
('ss3','Cone','Classic soft serve served in a cone.','soft_serve',2.50,null,0,'["Classic","Sweet"]','["Dairy","Gluten"]','/brand/drinks/ss3.svg',false),
('sl1','Blue Slush','An icy, refreshing blue slush. (340ml / 400ml)','slush',3,4,0,'["Cold","Fruity"]','[]','/brand/drinks/sl1.svg',false),
('sl2','Red Slush','An icy, refreshing red slush. (340ml / 400ml)','slush',3,4,0,'["Cold","Fruity"]','[]','/brand/drinks/sl2.svg',false),
('e1','Mix Flavours','Combine flavours for a customised drink.','extras',0.80,null,0,'["Customisable"]','[]','/brand/drinks/e1.svg',false),
('e2','Whipped Cream','Add whipped cream for a soft, sweet finish.','extras',1,null,0,'["Sweet"]','["Dairy"]','/brand/drinks/e2.svg',false),
('e3','Extra Nutella','Add extra Nutella for a richer flavour.','extras',1,null,0,'["Chocolate"]','["Dairy","Nuts","Soya"]','/brand/drinks/e3.svg',false),
('e4','Cookie Crumbs','Add cookie crumbs for extra texture.','extras',0.80,null,0,'["Sweet"]','["Gluten","Dairy"]','/brand/drinks/e4.svg',false),
('e5','Marshmallows','Add marshmallows for a sweet finishing touch.','extras',0.80,null,0,'["Sweet"]','[]','/brand/drinks/e5.svg',false)
on conflict (id) do nothing;

-- Starter rows are review material, not automatically published business
-- facts. They are inserted unavailable on first install. Because conflicts are
-- ignored, re-running this seed can never disable a catalogue the owner has
-- subsequently reviewed and published.

-- ---------------------------------------------------------------------------
-- DEALS — the brandbook menu combos "1+1" and "1+1=3"
-- ---------------------------------------------------------------------------
insert into deals (id, name, description, type, active, category, buy_qty, bundle_price, free_qty, badge) values
('deal_two_shakes', 'Two Milkshakes Combo', 'Any two milkshakes together — the classic pair from our menu.', 'bundle_price', false, 'milkshakes', 2, 9, null, '1+1'),
('deal_third_free', 'Third Milkshake Free', 'Buy two milkshakes and the third one is on the house.', 'buy_x_get_y_free', false, 'milkshakes', 2, null, 1, '1+1=3')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- STAFF, SHIFTS & CHECKLIST TEMPLATES
-- ---------------------------------------------------------------------------
-- No checklist templates are inserted in production. Operating procedures are
-- business facts: the owner creates and approves the real opening, midday and
-- closing tasks for the actual kiosk and equipment. Development examples live
-- behind the explicit development guard in seed.dev.sql.

-- SECURITY: the seed creates no staff account or shift. Staff accounts are
-- provisioned through Supabase Auth and assigned to a real store by the owner.

-- ---------------------------------------------------------------------------
-- STAFF DOCUMENTS / SIFR — none in production seed.
-- Demo document + incident fixtures moved to seed.dev.sql (Phase 1 review).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- TRAINING AND KNOWLEDGE BASE
-- ---------------------------------------------------------------------------
-- Empty in production. Training assessments and operating guidance must be
-- reviewed by the business before staff rely on them. Development examples are
-- available only in seed.dev.sql.

-- ---------------------------------------------------------------------------
-- RECRUITMENT — NO published vacancies in the production seed. The careers page
-- shows a "no open roles" empty state until the owner posts a genuine vacancy
-- (with a real location, salary and publication status). The two demo vacancies
-- used for local UI testing live in seed.dev.sql.
-- ---------------------------------------------------------------------------

-- Applications / franchise enquiries / contact messages: NONE in production
-- seed — these tables receive real public submissions only. Demo fixtures for
-- development live in seed.dev.sql.

-- ---------------------------------------------------------------------------
-- CONTENT — news, CMS pages, media
-- ---------------------------------------------------------------------------
-- No news or CMS page is auto-published in production. The public website uses
-- its reviewed built-in presentation copy until the owner publishes real
-- updates through Website Studio. This prevents a fresh database from
-- presenting a dated announcement as a current business fact.

-- Media library: EMPTY in the production seed. The earlier fixture referenced a
-- brandbook PDF that was never shipped (its URL was a "#" placeholder), so it is
-- removed. Upload real assets in Admin → Website → Media.

-- ---------------------------------------------------------------------------
-- GOVERNANCE — permissions matrix & audit trail opener
-- ---------------------------------------------------------------------------
insert into role_permissions (role, "view", "create", "edit", "delete", "approve", "publish") values
('team_member',   true, false, false, false, false, false),
('supervisor',    true, true,  true,  false, false, false),
('store_manager', true, true,  true,  true,  true,  false),
('owner',         true, true,  true,  true,  true,  true)
on conflict (role) do update set "view" = excluded."view", "create" = excluded."create",
  "edit" = excluded."edit", "delete" = excluded."delete", "approve" = excluded."approve", "publish" = excluded."publish";

-- Audit trail: intentionally EMPTY in production — an audit log records real
-- events only; seeding entries fabricates history. (Demo audit rows for
-- development UI work live in seed.dev.sql.)

-- ---------------------------------------------------------------------------
-- INVENTORY — NONE in the production seed. The earlier starter set carried
-- invented supplier names (DairyDirect UK, CreamCo, CocoaWorks…) and made-up
-- unit costs / par levels, so it is not shipped. The owner adds real ingredients,
-- suppliers and costs in Admin. The demo inventory used by the development order
-- and stock-movement fixtures lives in seed.dev.sql.
-- ---------------------------------------------------------------------------

-- Stock movements: none in production seed — real deliveries are recorded by
-- staff. (Demo opening-stock rows live in seed.dev.sql.)

-- ---------------------------------------------------------------------------
-- CUSTOMERS / ORDERS — none in production seed (Phase 1 review).
-- The demo customer and the sample order that exercises the JSONB→relational
-- trigger moved to seed.dev.sql.
-- ---------------------------------------------------------------------------
