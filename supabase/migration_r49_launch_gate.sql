-- ============================================================================
--  migration_r49_launch_gate.sql
--  R4.9 · Gate G5 — ONE AUTHORITATIVE LAUNCH GATE
-- ============================================================================
--  R4.8 shipped THREE separate opinions about launch readiness:
--    • launch_readiness()            — a 16-item dashboard (reporting)
--    • assert_store_open_allowed()   — its own 8 checks (enforcement)
--    • assert_menu_publish_allowed() — its own check      (enforcement)
--  They could drift, and they did: G3 proved that arming enforce_public_gates
--  revalidated NOTHING, so every product inherited from an upgrade stayed
--  publicly visible while the dashboard reported the same rows as incomplete.
--
--  This migration makes ONE function the definition of every mandatory
--  condition. The dashboard RENDERS it; the triggers RAISE from it. There is no
--  second, weaker interpretation left to drift.
--
--  SCOPE, NOT ONE FLAT SET
--    A condition names which actions it blocks. Requiring a careers privacy
--    notice before a STORE may open would be arbitrary, and arbitrary gates get
--    switched off. Each condition is still defined exactly once; `blocks` is
--    metadata on that single definition, not a second opinion.
--
--  THE ALLERGEN CONDITION — the one judgement call in this migration
--    The external audit specified "gates cannot be armed while visible products
--    lack approved allergen status", and separately advised keeping the allergen
--    workflow uncommissioned until real supplier specifications exist. Those two
--    together are unsatisfiable: arming becomes impossible and the gate blocks
--    the launch it exists to protect.
--
--    Resolved by making the POSTURE explicit and structural rather than
--    weakening the condition. launch_settings.allergen_disclosure_mode is:
--
--      'in_store_only' (default) — menu_items_public returns NO allergen data at
--          all, so there is no public claim to verify. This is the audit's own
--          "easier launch alternative", enforced at the anonymous boundary
--          instead of being asserted in prose. The public page already renders
--          the correct copy for an empty array ("not yet verified — please ask
--          before ordering"), so no frontend change is required.
--
--      'declared' — allergen data IS published, and every available product must
--          therefore carry an approved declaration.
--
--    The condition is then satisfiable today, honest in both modes, and tightens
--    automatically the moment the mode changes. Reversing this judgement means
--    changing one CASE arm, not unpicking a design.
--
--  DELIBERATE BEHAVIOURAL CHANGES, both recorded in the change map:
--    1. A store may not open unless the public gates are armed.
--    2. stores.status stops defaulting to 'open'. The absence of a decision
--       published a storefront as open; that is the same fail-open class as the
--       static menu seed. New rows default to 'coming_soon'.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The allergen posture
-- ----------------------------------------------------------------------------
alter table launch_settings
  add column if not exists allergen_disclosure_mode text not null default 'in_store_only';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'launch_settings_allergen_mode_chk') then
    alter table launch_settings add constraint launch_settings_allergen_mode_chk
      check (allergen_disclosure_mode in ('in_store_only', 'declared'));
  end if;
end $$;

comment on column launch_settings.allergen_disclosure_mode is
  'R4.9 G5: in_store_only (default) publishes NO product-level allergen data — menu_items_public masks it, so there is no public claim to verify. declared publishes it and requires an approved declaration on every available product.';

-- The posture is enforced where the anonymous surface is defined, not in the
-- browser: in in_store_only mode the data does not leave the database.
create or replace view menu_items_public as
  select mi.id, mi.name, mi.description, mi.category, mi.price, mi.price_large,
         mi.calories, mi.tags,
         case when (select ls.allergen_disclosure_mode from launch_settings ls where ls.id) = 'declared'
              then mi.allergens else '[]'::jsonb end as allergens,
         mi.image, mi.available, mi.created_at, mi.updated_at
    from menu_items mi
   where mi.available;

-- ----------------------------------------------------------------------------
-- 2. THE single definition of launch readiness
-- ----------------------------------------------------------------------------
--   state  : complete | incomplete | warning | not_applicable
--            only `incomplete` blocks; `warning` is advisory and never refuses.
--   blocks : the actions this condition gates.
--            arm_gates | store_open | menu_publish | form_accept
create or replace function launch_blocking_reasons()
returns table (key text, state text, detail text, fix text, blocks text[])
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with ls as (select * from launch_settings where id)
  select * from (values
    ('legal_business_name',
       (select case when coalesce(legal_business_name,'') <> '' then 'complete' else 'incomplete' end from ls),
       'The registered name the business trades under.', '/admin/settings/',
       array['arm_gates','store_open']),
    ('company_number',
       (select case when coalesce(company_number,'') <> '' then 'complete' else 'warning' end from ls),
       'Required on the website of a limited company (Companies Act 2006). Advisory here because a sole trader has none.',
       '/admin/settings/', array[]::text[]),
    ('registered_address',
       (select case when coalesce(registered_address,'') <> '' then 'complete' else 'incomplete' end from ls),
       'Statutory business address.', '/admin/settings/', array['arm_gates','store_open']),
    ('public_contact_email',
       (select case when coalesce(public_contact_email,'') <> '' then 'complete' else 'incomplete' end from ls),
       'The address customers can reach.', '/admin/settings/', array['arm_gates','store_open']),
    ('privacy_contact_email',
       (select case when coalesce(privacy_contact_email,'') <> '' then 'complete' else 'incomplete' end from ls),
       'Where data-protection requests go.', '/admin/settings/', array['arm_gates','store_open']),
    ('public_telephone',
       (select case when coalesce(public_telephone,'') <> '' or telephone_alternative_ok then 'complete' else 'incomplete' end from ls),
       'A telephone number, or an explicit decision that another channel serves instead.',
       '/admin/settings/', array['arm_gates','store_open']),
    ('canonical_url',
       (select case when coalesce(canonical_url,'') <> '' then 'complete' else 'incomplete' end from ls),
       'The site''s own address, used for canonical links and receipts.', '/admin/settings/',
       array['arm_gates','store_open']),
    ('vat_state_confirmed',
       (select case when vat_state_confirmed then 'complete' else 'incomplete' end from ls),
       'The VAT position has been stated deliberately rather than left unset.', '/admin/settings/',
       array['arm_gates','store_open']),
    ('receipt_identity_footer',
       (select case when coalesce(receipt_identity_footer,'') <> '' then 'complete' else 'incomplete' end from ls),
       'The identity line printed on every receipt.', '/admin/settings/', array['arm_gates','store_open']),
    ('notification_recipient',
       (select case when coalesce(notification_recipient,'') <> '' then 'complete' else 'incomplete' end from ls),
       'Where public form submissions are delivered. Blocks form acceptance only.',
       '/admin/settings/', array['form_accept']),
    ('privacy_notice_careers',
       case when current_privacy_version('careers') is not null then 'complete' else 'incomplete' end,
       'A published careers privacy notice to stamp on each submission.', '/admin/settings/',
       array['form_accept']),
    ('privacy_notice_franchise',
       case when current_privacy_version('franchise') is not null then 'complete' else 'incomplete' end,
       'A published franchise privacy notice to stamp on each submission.', '/admin/settings/',
       array['form_accept']),
    ('privacy_notice_contact',
       case when current_privacy_version('contact') is not null then 'complete' else 'incomplete' end,
       'A published contact privacy notice to stamp on each submission.', '/admin/settings/',
       array['form_accept']),
    ('open_store_facts',
       case
         when not exists (select 1 from stores where status = 'open') then 'not_applicable'
         when exists (select 1 from stores where status = 'open'
                        and (coalesce(trim(address),'') = '' or coalesce(trim(opening_hours),'') = ''))
           then 'incomplete'
         else 'complete' end,
       'Every open storefront carries an address and opening hours.', '/admin/stores/',
       array['arm_gates']),
    -- THE CONDITION G3 PROVED WAS NEVER ENFORCED.
    -- In in_store_only mode there is no public allergen claim, so nothing needs
    -- approving. In declared mode EVERY available product needs one — including
    -- the rows an upgrade made available without anyone deciding.
    ('allergen_declarations',
       case
         when (select allergen_disclosure_mode from ls) <> 'declared' then 'not_applicable'
         when not exists (select 1 from menu_items where available) then 'not_applicable'
         when exists (select 1 from menu_items mi where mi.available and not exists
                (select 1 from product_allergen_declarations d
                  where d.menu_item_id = mi.id and d.state = 'approved')) then 'incomplete'
         else 'complete' end,
       'Publishing allergen data requires an approved declaration on every available product.',
       '/admin/menu/', array['arm_gates','menu_publish']),
    ('public_form_gates_armed',
       (select case when enforce_public_gates then 'complete' else 'incomplete' end from ls),
       'The public gates are armed. A storefront may not open before they are.',
       '/admin/settings/', array['store_open'])
  ) as t(key, state, detail, fix, blocks);
$$;

comment on function launch_blocking_reasons() is
  'R4.9 G5: THE definition of launch readiness. launch_readiness() renders it; assert_launch_ready() raises from it. Nothing else may hold a second opinion.';

-- ----------------------------------------------------------------------------
-- 3. Enforcement and reporting, from that one definition
-- ----------------------------------------------------------------------------
create or replace function assert_launch_ready(p_context text, p_error text default 'launch_blocked')
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_missing text;
begin
  select string_agg(key, ', ' order by key) into v_missing
    from launch_blocking_reasons()
   where state = 'incomplete' and p_context = any(blocks);
  if v_missing is not null then
    raise exception '%: missing %', p_error, v_missing;
  end if;
end $$;

-- The dashboard now RENDERS the same rows it used to re-implement.
create or replace function launch_readiness()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when not is_owner() then jsonb_build_object('ok', false, 'error', 'not_permitted')
  else jsonb_build_object('ok', true, 'items', coalesce((
    select jsonb_agg(jsonb_build_object('key', key, 'state', state, 'fix', fix,
                                        'detail', detail, 'blocks', to_jsonb(blocks))
                     order by key)
      from launch_blocking_reasons()
  ), '[]'::jsonb)) end;
$$;

-- ----------------------------------------------------------------------------
-- 4. The four attachment points
-- ----------------------------------------------------------------------------

-- 4a. Arming the gates — and the missing inverse: they cannot be disarmed while
--     a storefront is trading on them.
create or replace function assert_launch_settings_transition()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.enforce_public_gates and not old.enforce_public_gates then
    -- THE G3 FIX: arming revalidates the WHOLE current state, including rows an
    -- upgrade made available without anyone choosing to publish them.
    perform assert_launch_ready('arm_gates', 'launch_arm_blocked');
  end if;
  if old.enforce_public_gates and not new.enforce_public_gates
     and exists (select 1 from stores where status = 'open') then
    raise exception 'launch_disarm_blocked: a storefront is open';
  end if;
  return new;
end $$;

drop trigger if exists trg_launch_settings_transition on launch_settings;
create trigger trg_launch_settings_transition
  before update on launch_settings
  for each row execute function assert_launch_settings_transition();

-- 4b. Opening a storefront. Global facts come from the one definition; address
--     and opening hours are properties of the ROW being opened and stay here.
create or replace function assert_store_open_allowed()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare v_missing text[] := '{}';
begin
  if new.status = 'open' and (old.status is distinct from 'open') then
    if coalesce(trim(new.address),'') = '' then v_missing := v_missing || 'store_address'::text; end if;
    if coalesce(trim(new.opening_hours),'') = '' then v_missing := v_missing || 'opening_hours'::text; end if;
    if array_length(v_missing,1) is not null then
      raise exception 'store_open_blocked: missing %', array_to_string(v_missing, ', ');
    end if;
    perform assert_launch_ready('store_open', 'store_open_blocked');
  end if;
  return new;
end $$;

-- 4c. Publishing a product.
create or replace function assert_menu_publish_allowed()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.available and (tg_op = 'INSERT' or not old.available) then
    perform assert_launch_ready('menu_publish', 'menu_publish_blocked');
  end if;
  return new;
end $$;

-- 4d. stores.status stops defaulting to open — see the header. Existing rows are
--     untouched; only the absence of a decision changes meaning.
alter table stores alter column status set default 'coming_soon';

comment on function assert_launch_ready(text, text) is
  'R4.9 G5: raises when any condition in launch_blocking_reasons() that gates p_context is incomplete. Warnings never block.';

-- ----------------------------------------------------------------------------
-- 5. Accepting a public form
-- ----------------------------------------------------------------------------
--  submit_public_form() already stamps current_privacy_version(kind) — but it
--  stamps NULL when no notice is published, i.e. it records that the visitor
--  agreed to nothing. The gate belongs on the destination tables rather than
--  inside that 180-line function: a trigger covers every write path, and the
--  function itself is left untouched (append-only discipline).
create or replace function assert_public_form_accept_allowed()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform assert_launch_ready('form_accept', 'form_accept_blocked');
  return new;
end $$;

drop trigger if exists trg_form_accept_gate on job_applications;
create trigger trg_form_accept_gate before insert on job_applications
  for each row execute function assert_public_form_accept_allowed();

drop trigger if exists trg_form_accept_gate on franchise_inquiries;
create trigger trg_form_accept_gate before insert on franchise_inquiries
  for each row execute function assert_public_form_accept_allowed();

drop trigger if exists trg_form_accept_gate on contact_messages;
create trigger trg_form_accept_gate before insert on contact_messages
  for each row execute function assert_public_form_accept_allowed();

comment on function assert_public_form_accept_allowed() is
  'R4.9 G5: a public submission is not accepted unless a published privacy notice exists to stamp and a recipient exists to deliver it to.';
