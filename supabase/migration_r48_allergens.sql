-- ============================================================================
--  MILK POP — R4.8 LAUNCH CLOSURE 3/4: controlled allergen source of truth
--  (Workstream G · plus launch_readiness(), which reads these tables)
--
--  One controlled system feeding public menu, admin editor, staff portal,
--  till and exports. The 14 UK/EU regulated categories are seeded as FIXED
--  REFERENCE CODES (regulatory constants, not invented business facts).
--  No product ships pre-approved: every declaration starts in 'draft' and can
--  only reach 'approved' through an owner/manager action against recorded
--  ingredient evidence. An empty array is NEVER rendered as "no allergens".
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Regulated catalogue — fixed codes; sub-detail (which cereal / which nut)
--    lives on the declaration rows, so "Nuts" can never stand in for peanuts
--    or a specific tree nut.
-- ----------------------------------------------------------------------------
create table if not exists allergen_catalogue (
  code          text primary key,
  label         text not null,
  requires_detail boolean not null default false,  -- gluten cereals, tree nuts
  sort_order    int not null
);
alter table allergen_catalogue enable row level security;
drop policy if exists allergen_catalogue_read on allergen_catalogue;
create policy allergen_catalogue_read on allergen_catalogue
  for select to anon, authenticated using (true);

insert into allergen_catalogue (code, label, requires_detail, sort_order) values
  ('celery',            'Celery',                                false, 1),
  ('gluten_cereals',    'Cereals containing gluten',             true,  2),
  ('crustaceans',       'Crustaceans',                           false, 3),
  ('eggs',              'Eggs',                                  false, 4),
  ('fish',              'Fish',                                  false, 5),
  ('lupin',             'Lupin',                                 false, 6),
  ('milk',              'Milk',                                  false, 7),
  ('molluscs',          'Molluscs',                              false, 8),
  ('mustard',           'Mustard',                               false, 9),
  ('peanuts',           'Peanuts',                               false, 10),
  ('sesame',            'Sesame',                                false, 11),
  ('soya',              'Soya',                                  false, 12),
  ('sulphites',         'Sulphur dioxide / sulphites',           false, 13),
  ('tree_nuts',         'Tree nuts',                             true,  14)
on conflict (code) do nothing;

-- ----------------------------------------------------------------------------
-- 2. Supplier specification chain — evidence the owner records; nothing here
--    is seeded. Revisions supersede; a superseded spec invalidates dependent
--    approvals (change control, §6 below).
-- ----------------------------------------------------------------------------
create table if not exists ingredient_specifications (
  id                text primary key default gen_random_uuid()::text,
  ingredient_id     text not null references ingredients(id) on delete cascade,
  supplier_name     text not null default '',
  supplier_ref      text not null default '',
  revision          int  not null default 1,
  effective_date    date,
  contains          jsonb not null default '[]'::jsonb,  -- [{code, detail?}]
  may_contain       jsonb not null default '[]'::jsonb,
  cross_contact_notes text not null default '',
  evidence_document_id text,
  reviewed_by_staff_id text references staff_profiles(id),
  reviewed_at       timestamptz,
  superseded_at     timestamptz,
  created_at        timestamptz not null default now(),
  unique (ingredient_id, revision)
);
alter table ingredient_specifications enable row level security;
drop policy if exists ingredient_specs_staff_read on ingredient_specifications;
create policy ingredient_specs_staff_read on ingredient_specifications
  for select to authenticated using (current_staff_id() is not null);
drop policy if exists ingredient_specs_manage on ingredient_specifications;
create policy ingredient_specs_manage on ingredient_specifications
  for all to authenticated using (is_manager_or_owner()) with check (is_manager_or_owner());

-- ----------------------------------------------------------------------------
-- 3. Versioned recipe (BOM) links a sellable item to its ingredients.
-- ----------------------------------------------------------------------------
create table if not exists menu_item_recipes (
  id            text primary key default gen_random_uuid()::text,
  menu_item_id  text not null references menu_items(id) on delete cascade,
  version       int  not null default 1,
  lines         jsonb not null default '[]'::jsonb,  -- [{ingredient_id, qty, unit}]
  state         text not null default 'draft' check (state in
                  ('draft','awaiting_evidence','awaiting_approval','approved','superseded','suspended')),
  approved_by_staff_id text references staff_profiles(id),
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (menu_item_id, version)
);
alter table menu_item_recipes enable row level security;
drop policy if exists recipes_staff_read on menu_item_recipes;
create policy recipes_staff_read on menu_item_recipes
  for select to authenticated using (current_staff_id() is not null);
drop policy if exists recipes_manage on menu_item_recipes;
create policy recipes_manage on menu_item_recipes
  for all to authenticated using (is_manager_or_owner()) with check (is_manager_or_owner());

-- ----------------------------------------------------------------------------
-- 4. Product allergen declaration — the ONLY thing customer surfaces render.
-- ----------------------------------------------------------------------------
create table if not exists product_allergen_declarations (
  id             text primary key default gen_random_uuid()::text,
  menu_item_id   text not null references menu_items(id) on delete cascade,
  recipe_id      text references menu_item_recipes(id),
  contains       jsonb not null default '[]'::jsonb,   -- [{code, detail?}]
  may_contain    jsonb not null default '[]'::jsonb,
  cross_contact_statement text not null default '',
  state          text not null default 'draft' check (state in
                   ('draft','awaiting_evidence','awaiting_approval','approved','superseded','suspended')),
  approved_by_staff_id text references staff_profiles(id),
  approved_at    timestamptz,
  superseded_reason text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_pad_item on product_allergen_declarations (menu_item_id, state);
alter table product_allergen_declarations enable row level security;
drop policy if exists pad_public_read_approved on product_allergen_declarations;
create policy pad_public_read_approved on product_allergen_declarations
  for select to anon, authenticated using (state = 'approved');
drop policy if exists pad_staff_read_all on product_allergen_declarations;
create policy pad_staff_read_all on product_allergen_declarations
  for select to authenticated using (current_staff_id() is not null);
drop policy if exists pad_manage on product_allergen_declarations;
create policy pad_manage on product_allergen_declarations
  for all to authenticated using (is_manager_or_owner()) with check (is_manager_or_owner());

-- Approval is a distinct audited act; declarations cannot be born approved.
create or replace function allergen_declaration_approve(p_declaration_id text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare d product_allergen_declarations; v_actor text := current_staff_id();
begin
  if not is_manager_or_owner() then raise exception 'not_permitted'; end if;
  select * into d from product_allergen_declarations where id = p_declaration_id;
  if not found then raise exception 'not_found'; end if;
  if d.state not in ('awaiting_approval','draft','awaiting_evidence') then
    raise exception 'not_approvable_state';
  end if;
  -- every referenced code must exist in the regulated catalogue; detail is
  -- mandatory where the category requires it (no bare "tree_nuts").
  if exists (
    select 1 from jsonb_array_elements(d.contains || d.may_contain) e
    left join allergen_catalogue c on c.code = e->>'code'
    where c.code is null
       or (c.requires_detail and coalesce(trim(e->>'detail'),'') = ''))
  then raise exception 'invalid_allergen_entries'; end if;

  update product_allergen_declarations
     set state='approved', approved_by_staff_id=v_actor, approved_at=now(), updated_at=now()
   where id = p_declaration_id;
  update product_allergen_declarations
     set state='superseded', superseded_reason='replaced by '||p_declaration_id, updated_at=now()
   where menu_item_id = d.menu_item_id and id <> p_declaration_id and state='approved';
  insert into audit_logs (id, operator_name, role, action, timestamp, module, new_value)
  values (gen_random_uuid()::text, v_actor, current_staff_role()::text,
          'allergen.declaration_approved', now()::text, 'Menu', d.menu_item_id);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function allergen_declaration_approve(text) from public, anon;
grant execute on function allergen_declaration_approve(text) to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Availability + publish gate. `available` defaults TRUE so the upgrade
--    changes nothing visible by itself; the trigger gates only the
--    TRANSITION to available once commissioning arms enforce_public_gates.
--    Customer surfaces additionally refuse to render an unapproved
--    declaration as fact (frontend, R4.8) — absence reads as
--    "allergen information not yet verified", never "no allergens".
-- ----------------------------------------------------------------------------
alter table menu_items add column if not exists available boolean not null default true;

create or replace function assert_menu_publish_allowed()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare v_armed boolean;
begin
  select enforce_public_gates into v_armed from launch_settings where id;
  if coalesce(v_armed,false)
     and new.available
     and (tg_op = 'INSERT' or old.available is distinct from true or old.available is null or not old.available) then
    if not exists (select 1 from product_allergen_declarations
                    where menu_item_id = new.id and state = 'approved') then
      raise exception 'menu_publish_blocked: allergen declaration not approved for %', new.id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_menu_publish_gate on menu_items;
create trigger trg_menu_publish_gate
  before insert or update of available on menu_items
  for each row execute function assert_menu_publish_allowed();

-- ----------------------------------------------------------------------------
-- 6. Change control — recipe or specification change invalidates approvals.
-- ----------------------------------------------------------------------------
create or replace function supersede_declarations_on_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_table_name = 'menu_item_recipes' then
    update product_allergen_declarations
       set state='superseded', superseded_reason='recipe changed', updated_at=now()
     where menu_item_id = new.menu_item_id and state='approved'
       and (tg_op='UPDATE' and (old.lines is distinct from new.lines));
  elsif tg_table_name = 'ingredient_specifications' then
    update product_allergen_declarations d
       set state='superseded', superseded_reason='ingredient specification changed', updated_at=now()
      from menu_item_recipes r
     where d.state='approved' and d.recipe_id = r.id
       and r.lines @> jsonb_build_array(jsonb_build_object('ingredient_id', new.ingredient_id));
  end if;
  return new;
end $$;

drop trigger if exists trg_recipe_change_control on menu_item_recipes;
create trigger trg_recipe_change_control
  after update on menu_item_recipes
  for each row execute function supersede_declarations_on_change();
drop trigger if exists trg_spec_change_control on ingredient_specifications;
create trigger trg_spec_change_control
  after insert or update on ingredient_specifications
  for each row execute function supersede_declarations_on_change();

-- ----------------------------------------------------------------------------
-- 7. launch_readiness() (F2) — relocated here so every table it reads exists.
-- ----------------------------------------------------------------------------
create or replace function launch_readiness()
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select case when not is_owner() then jsonb_build_object('ok', false, 'error', 'not_permitted')
  else (
    with ls as (select * from launch_settings where id)
    select jsonb_build_object('ok', true, 'items', jsonb_build_array(
      jsonb_build_object('key','legal_business_name','state', case when coalesce((select legal_business_name from ls),'')<>'' then 'complete' else 'incomplete' end, 'fix','/admin/settings/'),
      jsonb_build_object('key','company_number','state', case when coalesce((select company_number from ls),'')<>'' then 'complete' else 'warning' end, 'fix','/admin/settings/'),
      jsonb_build_object('key','registered_address','state', case when coalesce((select registered_address from ls),'')<>'' then 'complete' else 'incomplete' end, 'fix','/admin/settings/'),
      jsonb_build_object('key','public_contact_email','state', case when coalesce((select public_contact_email from ls),'')<>'' then 'complete' else 'incomplete' end, 'fix','/admin/settings/'),
      jsonb_build_object('key','privacy_contact_email','state', case when coalesce((select privacy_contact_email from ls),'')<>'' then 'complete' else 'incomplete' end, 'fix','/admin/settings/'),
      jsonb_build_object('key','public_telephone','state', case when coalesce((select public_telephone from ls),'')<>'' or (select telephone_alternative_ok from ls) then 'complete' else 'incomplete' end, 'fix','/admin/settings/'),
      jsonb_build_object('key','canonical_url','state', case when coalesce((select canonical_url from ls),'')<>'' then 'complete' else 'incomplete' end, 'fix','/admin/settings/'),
      jsonb_build_object('key','vat_state_confirmed','state', case when (select vat_state_confirmed from ls) then 'complete' else 'incomplete' end, 'fix','/admin/settings/'),
      jsonb_build_object('key','receipt_identity_footer','state', case when coalesce((select receipt_identity_footer from ls),'')<>'' then 'complete' else 'incomplete' end, 'fix','/admin/settings/'),
      jsonb_build_object('key','notification_recipient','state', case when coalesce((select notification_recipient from ls),'')<>'' then 'complete' else 'incomplete' end, 'fix','/admin/settings/'),
      jsonb_build_object('key','privacy_notice_careers','state', case when current_privacy_version('careers') is not null then 'complete' else 'incomplete' end, 'fix','/admin/settings/'),
      jsonb_build_object('key','privacy_notice_franchise','state', case when current_privacy_version('franchise') is not null then 'complete' else 'incomplete' end, 'fix','/admin/settings/'),
      jsonb_build_object('key','privacy_notice_contact','state', case when current_privacy_version('contact') is not null then 'complete' else 'incomplete' end, 'fix','/admin/settings/'),
      jsonb_build_object('key','open_store_facts','state', case
          when not exists (select 1 from stores where status='open') then 'not_applicable'
          when exists (select 1 from stores where status='open' and (coalesce(trim(address),'')='' or coalesce(trim(opening_hours),'')='')) then 'incomplete'
          else 'complete' end, 'fix','/admin/stores/'),
      jsonb_build_object('key','allergen_declarations','state', case
          when not exists (select 1 from menu_items where available) then 'not_applicable'
          when exists (select 1 from menu_items mi where mi.available and not exists
                 (select 1 from product_allergen_declarations d
                   where d.menu_item_id = mi.id and d.state = 'approved')) then 'incomplete'
          else 'complete' end, 'fix','/admin/menu/'),
      jsonb_build_object('key','public_form_gates_armed','state', case when (select enforce_public_gates from ls) then 'complete' else 'warning' end, 'fix','/admin/settings/')
    ))
  ) end;
$$;
revoke all on function launch_readiness() from public, anon;
grant execute on function launch_readiness() to authenticated;

comment on table allergen_catalogue is
  'R4.8 G1: the 14 regulated categories as fixed reference codes. Business facts (which product contains what) are never seeded — they enter only via recorded, approved declarations.';
comment on function allergen_declaration_approve(text) is
  'R4.8 G3/G4: the only path to an approved declaration — audited, validated against the catalogue, detail mandatory for gluten cereals and tree nuts.';
