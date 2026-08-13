-- ============================================================================
--  MILK POP — DEVELOPMENT / TEST FIXTURES  ***NEVER RUN IN PRODUCTION***
--
--  Demo operational records for local development and UI testing only:
--  a staff document, an incident report, a job application, a franchise
--  enquiry, a contact message, an audit entry, a walk-in customer, opening
--  stock movements and one sample order (which exercises the JSONB →
--  relational order_items trigger end-to-end).
--
--  Every identifier is synthetic (demo_*) and every e-mail address uses the
--  reserved `example.invalid` domain (RFC 2606) — none of this data refers to
--  a real person, order or incident.
--
--  EXECUTION GUARD: the DO block below aborts unless the session has
--  explicitly opted in. To run locally:
--
--      select set_config('app.environment', 'development', false);
--      \i supabase/seed.dev.sql
--
--  Production pipelines must not set that GUC, must not include this file in
--  any migration chain, and CI asserts seed.sql contains no rows of these
--  kinds (scripts/security-regression.test.mjs §9).
-- ============================================================================

do $$
begin
  if coalesce(current_setting('app.environment', true), '') <> 'development' then
    raise exception using
      message = 'seed.dev.sql refused to run: development/test fixtures only.',
      hint    = 'If this is a local development database, first run: '
                'select set_config(''app.environment'', ''development'', false);';
  end if;
end $$;


-- Development-only catalogue visibility. The production seed deliberately
-- leaves these rows unavailable/inactive until owner review.
update menu_items set available = true
 where id in ('m1','m2','m3','m4','m5','m6','m7','m8','m9','m10',
              'sm1','sm2','sm3','sm4','ss1','ss2','ss3','sl1','sl2',
              'e1','e2','e3','e4','e5');
update deals set active = true where id in ('deal_two_shakes','deal_third_free');

insert into checklist_templates (id, label, category, critical, sort_order) values
('demo_ck_open', 'Demo: verify the opening checklist workflow', 'opening', false, 1),
('demo_ck_close', 'Demo: verify the closing checklist workflow', 'closing', false, 1)
on conflict (id) do update set label = excluded.label, updated_at = now();

insert into training_assessments
(id, title, description, learning_objectives, passing_score, slides, questions, category, points, badge) values
('demo_assessment_1', 'Demo Training Assessment',
 'Development fixture for testing the Academy workflow. Not an approved Milk Pop procedure.',
 '["Verify the training workflow"]', 80, '[]',
 '[{"id":"demo_q1","text":"Is this a development-only training fixture?","type":"multiple_choice","options":["Yes","No"],"correctAnswer":"Yes","explanation":"This content is never part of the production seed.","difficulty":"easy","categoryTag":"demo"}]',
 'brand', 10, 'Demo Badge')
on conflict (id) do update set updated_at = now();

insert into training_courses
(id, title, description, category, progress, points, estimated_time, badge, assessment_id) values
('demo_course_1', 'Demo Academy Course',
 'Development fixture for testing course presentation. Not an approved staff qualification.',
 'induction', 0, 10, '2 mins', 'Demo Badge', 'demo_assessment_1')
on conflict (id) do update set updated_at = now();

insert into kb_articles
(id, title, category, last_updated, author, reading_time, content, steps) values
('demo_kb_1', 'Demo Knowledge Base Article', 'opening', '', '', '1 min',
 'Development fixture only. Replace with approved operating guidance before launch.',
 '["Verify that Knowledge Base content loads from Supabase."]')
on conflict (id) do update set updated_at = now();

-- ---------------------------------------------------------------------------
-- REFERENCE DATA (demo) — moved here from the production seed (Phase 1 honesty
-- review). These storefronts, vacancies and the starter inventory are FICTIONAL
-- and exist ONLY so local development has something to render and so the
-- operational fixtures below (stock movements, the sample order, the SIFR
-- report) can resolve their store_id / ingredient_id foreign keys. NEVER ships
-- to production — the production seed now contains no stores, vacancies or
-- inventory.
-- ---------------------------------------------------------------------------
insert into stores (id, name, address, postcode, opening_hours, status, delivery_links, phone, email, image, coordinates) values
('s1', 'Milk Pop Solihull', 'Touchwood Shopping Precinct, Homer Road, Solihull', 'B91 3GJ',
 'Mon - Sat: 09:00 - 21:00 | Sun: 11:00 - 17:00', 'open',
 '{"deliveroo":"https://deliveroo.co.uk","uberEats":"https://ubereats.com"}',
 '+44 121 704 0090', 'solihull@example.invalid', 'solihull_store', '{"lat":52.4141,"lng":-1.7794}'),
('s2', 'Milk Pop Leicester', '14 Highcross Street, Leicester City Centre, Leicester', 'LE1 4FL',
 'Mon - Sun: 10:00 - 22:00', 'open',
 '{"deliveroo":"https://deliveroo.co.uk","justEat":"https://just-eat.co.uk"}',
 '+44 116 251 4030', 'leicester@example.invalid', 'leicester_store', '{"lat":52.6369,"lng":-1.1398}'),
('s3', 'Milk Pop Birmingham', 'Bullring Shopping Centre, Birmingham', 'B5 4BU',
 'Coming Soon - Autumn 2026', 'coming_soon', '{}',
 '+44 121 345 6789', 'birmingham@example.invalid', 'birmingham_store', '{"lat":52.4772,"lng":-1.8942}')
on conflict (id) do nothing;

insert into job_vacancies (id, title, department, location, salary, type, role_description, requirements, responsibilities) values
('v1', 'Hospitality Team Member', 'Front of House & Barista Ops', 'Solihull', '£11.50 - £12.20 / hour', 'Part-time',
 'Demo vacancy fixture. In this energetic and friendly role, you will prepare signature shakes, greet guests with warmth, and preserve high hygiene standards.',
 '["Genuine passion for hospitality and retail excellence.","Ability to thrive in a rapid, cooperative environment.","Impeccable punctuality and professional hygiene values."]',
 '["Operate blend counters, ensuring exact recipe compliance.","Engage with guests cheerfully across the dessert range.","Maintain sanitisation along storage sections and seating zones."]'),
('v2', 'Shift Supervisor', 'Store Management Operations', 'Leicester', '£13.50 - £14.30 / hour', 'Full-time',
 'Demo vacancy fixture. The supervisor co-pilots daily team workflows, validating compliance across prep, food safety and cash-close procedures.',
 '["Minimum of 1 year in a leadership or supervising capacity in food/retail.","Robust problem-solving and transparent communication.","Sound understanding of health-safety regulations."]',
 '["Supervise operational lines during peaks.","Audit close checklists, register logs and stock balances.","Lead short huddles at shift start to communicate targets."]')
on conflict (id) do nothing;

insert into ingredients (id, name, unit, par_level, cost_per_unit, supplier) values
('ing_milk',      'Whole milk',            'ml',   40000, 0.0011, 'DemoDairy (fixture)'),
('ing_icecream',  'Soft-serve base mix',   'ml',   20000, 0.0028, 'DemoDairy (fixture)'),
('ing_caramel',   'Caramel syrup',         'ml',    5000, 0.0060, 'DemoSupplies (fixture)'),
('ing_strawb',    'Strawberry purée',      'ml',    4000, 0.0075, 'DemoSupplies (fixture)'),
('ing_choc',      'Chocolate crumb',       'g',     3000, 0.0090, 'DemoSupplies (fixture)'),
('ing_cream',     'Whipping cream',        'ml',    6000, 0.0040, 'DemoDairy (fixture)'),
('ing_straws',    'Paper straws',          'unit',   500, 0.0200, 'DemoPack (fixture)'),
('ing_cups_400',  '400ml dome cups',       'unit',   600, 0.0900, 'DemoPack (fixture)')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- STAFF DOCUMENT (demo)
-- ---------------------------------------------------------------------------
insert into staff_documents (id, name, type, category, upload_date, status, url) values
('demo_doc_1', 'Level 2 Food Hygiene Certificate — demo fixture', 'PDF', 'compliance', '2026-05-01', 'approved', '#')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- INCIDENT / SIFR REPORT (demo)
-- ---------------------------------------------------------------------------
insert into sifr_reports (id, title, category, date, involved_people, store_id, store_name, description,
  impact, suggested_action, confidentiality, status, reporter_name, reporter_id, submitted_at, replies) values
('demo_sifr_1', 'Blender guard latch loose on unit 2', 'health_safety', '2026-06-20', 'Maintenance',
 's1', 'Milk Pop Solihull', 'The safety latch on blender unit 2 does not click fully shut.',
 'Potential hand-safety risk during peak service.', 'Engineer visit; take unit 2 out of rotation until fixed.',
 'standard', 'resolved', 'Demo Reporter', 'demo_emp_1', '2026-06-20T10:15:00Z',
 '[{"id":"demo_reply_1","user":"Demo Manager","role":"store_manager","message":"Engineer booked for Friday.","timestamp":"2026-06-21T09:00:00Z"}]')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- JOB APPLICATION (demo) — note: no CV columns exist any more (Phase 1 review)
-- ---------------------------------------------------------------------------
insert into job_applications (id, full_name, email, phone, applied_for, applied_store, availability, experience, message, status, applied_at) values
('demo_app_1', 'Amelia Demo', 'amelia.demo@example.invalid', '+44 7700 900123', 'Hospitality Team Member', 'Milk Pop Solihull',
 'Weekends and evenings', '1 year café experience', 'Demo application fixture — not a real candidate.', 'pending', '2026-06-28T14:30:00Z')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- FRANCHISE ENQUIRY (demo)
-- ---------------------------------------------------------------------------
insert into franchise_inquiries (id, full_name, email, phone, country, city, budget, experience, message, status, submitted_at) values
('demo_fran_1', 'Tomas Demo', 'tomas.demo@example.invalid', '+44 7700 900456', 'Sweden', 'Gothenburg', '£80k – £120k',
 'Owns two coffee kiosks', 'Demo franchise fixture — not a real enquiry.', 'pending', '2026-06-25T09:00:00Z')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- CONTACT MESSAGE (demo)
-- ---------------------------------------------------------------------------
insert into contact_messages (id, full_name, email, reason, message, submitted_at) values
('demo_msg_1', 'Priya Demo', 'priya.demo@example.invalid', 'Feedback', 'Demo contact fixture — not a real message.', '2026-06-30T16:45:00Z')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- AUDIT ENTRY (demo) — production audit logs start empty and record real
-- events only; this row exists so the audit UI has something to render in dev.
-- ---------------------------------------------------------------------------
insert into audit_logs (id, operator_name, role, action, timestamp, module) values
('demo_aud_1', 'Demo System', 'system', 'Development fixtures loaded from seed.dev.sql', now()::text, 'Cloud Database')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- CUSTOMER (demo)
-- ---------------------------------------------------------------------------
insert into customers (id, full_name, email, phone, marketing_ok, loyalty_points) values
('demo_cust_1', 'Walk-in Guest (demo)', null, null, false, 0)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- OPENING STOCK MOVEMENTS (demo)
-- ---------------------------------------------------------------------------
delete from stock_movements where recorded_by = 'demo_seed';  -- idempotent re-runs
insert into stock_movements (id, ingredient_id, store_id, quantity, movement_type, note, recorded_by) values
(gen_random_uuid(), 'ing_milk',     's1', 60000, 'delivery', 'Opening stock (demo)', 'demo_seed'),
(gen_random_uuid(), 'ing_icecream', 's1', 30000, 'delivery', 'Opening stock (demo)', 'demo_seed'),
(gen_random_uuid(), 'ing_caramel',  's1',  8000, 'delivery', 'Opening stock (demo)', 'demo_seed'),
(gen_random_uuid(), 'ing_straws',   's1',  1000, 'delivery', 'Opening stock (demo)', 'demo_seed'),
(gen_random_uuid(), 'ing_cups_400', 's1',  1200, 'delivery', 'Opening stock (demo)', 'demo_seed');

-- ---------------------------------------------------------------------------
-- SAMPLE ORDER (demo) — exercises the JSONB→relational explosion trigger.
-- After running, check: select * from order_items; select * from daily_sales;
-- ---------------------------------------------------------------------------
insert into orders (id, order_number, store_id, store_name, channel, items, applied_deals,
  subtotal, discount_total, tax_rate, tax_amount, total, payment_method, status,
  customer_name, staff_id, staff_name, placed_at, completed_at) values
('demo_ord_1', 1001, 's1', 'Milk Pop Solihull', 'walk_in',
 '[
    {"id":"demo_li_1","menuItemId":"m6","name":"Caramel","category":"milkshakes","size":"large","unitPrice":6,"quantity":1,
     "modifiers":[{"id":"demo_mod_1","menuItemId":"e2","name":"Whipped Cream","price":1}],"lineTotal":7},
    {"id":"demo_li_2","menuItemId":"m9","name":"Strawberry","category":"milkshakes","size":"regular","unitPrice":5,"quantity":1,
     "modifiers":[],"lineTotal":5}
  ]'::jsonb,
 '[{"dealId":"deal_two_shakes","dealName":"Two Milkshakes Combo","discount":2}]'::jsonb,
 12, 2, 20, 1.67, 10, 'card', 'completed', 'Demo Guest', 'demo_emp_1', 'Demo Staff Member',
 now() - interval '2 hours', now() - interval '2 hours')
on conflict (id) do update set items = excluded.items, updated_at = now();
