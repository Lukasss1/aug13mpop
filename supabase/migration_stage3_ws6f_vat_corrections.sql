-- ============================================================================
-- STAGE 3 / WS6f — VAT & SETUP CORRECTIONS (Round-9 audit items 1–10 + F11)
-- ============================================================================
-- The Round-9 audit accepted the Store Setup foundation but rejected the §1
-- completion claim, listing ten correction items plus the public-exposure
-- blocker. This migration closes every DATABASE-side item:
--
--   F1  EFFECTIVE-DATE CHARGING — REGISTERED charges only once the
--       registration's effective date has arrived in the store's OWN
--       business day (local date in its timezone). A future-dated
--       registration snapshots REGISTERED + its date but derives 0 like
--       NOT_REGISTERED until the date arrives.
--   F3  MANDATORY CLASSIFICATION — configure_store_setup() refuses to make a
--       store REGISTERED while any menu item is unclassified
--       (products_unclassified), and classify_products() gives the owner the
--       server path the wizard uses.
--   F4  OWNER-ONLY CLASSIFICATION — trg_menu_tax_code_guard makes
--       menu_items.tax_code writable only by the owner, the classify RPC, or
--       privileged/non-API contexts (tax_code_is_owner_only); the broad
--       manager menu policy no longer reaches this column.
--   F5  MODIFIER TAX — extras are taxed by THEIR OWN classification: the RPC
--       prices every line as COMPONENTS (base + each modifier), allocates the
--       line's discount share across them with the same cumulative
--       largest-exact method, rounds ONCE per component, and snapshots the
--       four tax fields on order_item_modifiers rows; a charging store
--       refuses an unclassified extra.
--   F6  STORE-SCOPED IDEMPOTENCY — a replayed order id must belong to the
--       caller's own store (order_id_conflict), on the fast path AND the
--       insert-race path, closing the cross-store read through the DEFINER
--       function.
--   F10 LAUNCH VOCABULARY — timezone/currency are constrained to the values
--       the platform genuinely drives today (Europe/London, GBP) at the RPC
--       (unsupported_timezone / unsupported_currency) AND the database
--       (CHECK constraints); widening is a deliberate future migration.
--   F11 PUBLIC EXPOSURE — anonymous SELECT on stores is REVOKED; the public
--       locator reads the new stores_public view (the original locator
--       columns only). Signed-in staff keep the full row (the till's
--       configuration path is an authenticated read).
--
-- Client-side items (F2 reopenable wizard, F7 reconciliation, F8 gift-card
-- parity, F9 fail-closed gating, classification UI) land in the same round's
-- frontend changes; matrix §18 proves the database half live.
-- Idempotent; fails closed; appended via MP_FUTURE_MIGRATIONS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- WS6f.1  order_item_modifiers — per-modifier VAT snapshot (auditor F5)
-- ----------------------------------------------------------------------------
alter table order_item_modifiers add column if not exists tax_code text;
alter table order_item_modifiers add column if not exists tax_rate numeric(5,2);
alter table order_item_modifiers add column if not exists taxable_amount numeric(10,2);
alter table order_item_modifiers add column if not exists tax_amount numeric(10,2);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'oim_tax_code_fkey') then
    alter table order_item_modifiers add constraint oim_tax_code_fkey
      foreign key (tax_code) references tax_codes(code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'oim_tax_rate_bounds') then
    alter table order_item_modifiers add constraint oim_tax_rate_bounds check (
      tax_rate is null or (tax_rate >= 0 and tax_rate <= 100)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'oim_tax_nonneg') then
    alter table order_item_modifiers add constraint oim_tax_nonneg check (
      (taxable_amount is null or taxable_amount >= 0)
      and (tax_amount is null or tax_amount >= 0)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'oim_tax_le_taxable') then
    alter table order_item_modifiers add constraint oim_tax_le_taxable check (
      tax_amount is null or taxable_amount is null or tax_amount <= taxable_amount
    );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- WS6f.2  Launch-supported configuration vocabulary (auditor F10)
-- ----------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stores_timezone_supported') then
    alter table stores add constraint stores_timezone_supported check (
      timezone is null or timezone = 'Europe/London'
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stores_currency_supported') then
    alter table stores add constraint stores_currency_supported check (
      currency_code is null or currency_code = 'GBP'
    );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- WS6f.3  menu_items.tax_code — owner-only classification (auditor F4)
-- ----------------------------------------------------------------------------
-- SECURITY INVOKER (the WS6e lesson): current_user must be the CALLING role.
-- Unchanged tax_code passes untouched, so manager menu publishes (which omit
-- the key by client contract) are unaffected; changing it requires the
-- classify RPC's GUC, a non-API session, the bypass-RLS role, or the owner.
create or replace function enforce_menu_tax_code_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.tax_code is not distinct from old.tax_code then
    return new;
  end if;
  if tg_op = 'INSERT' and new.tax_code is null then
    return new;
  end if;
  if current_setting('milkpop.tax_classify_rpc', true) = '1' then
    return new;
  end if;
  if nullif(current_setting('request.jwt.claims', true), '') is null then
    return new;
  end if;
  if exists (select 1 from pg_roles r where r.rolname = current_user and r.rolbypassrls) then
    return new;
  end if;
  if is_owner() then
    return new;
  end if;
  raise exception 'tax_code_is_owner_only' using errcode = '42501',
    detail = 'Product VAT classification is an owner decision (classify_products or an owner session).';
end $$;

drop trigger if exists trg_menu_tax_code_guard on menu_items;
create trigger trg_menu_tax_code_guard
  before insert or update of tax_code on menu_items
  for each row execute function enforce_menu_tax_code_guard();

-- ----------------------------------------------------------------------------
-- WS6f.4  classify_products() — the owner classification path (auditor F3/F4)
-- ----------------------------------------------------------------------------
create or replace function classify_products(p jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  e      jsonb;
  v_id   text;
  v_code text;
  v_n    int := 0;
begin
  if not is_owner() then
    raise exception 'owner_aal2_required' using errcode = '42501';
  end if;
  if p is null or jsonb_typeof(p) <> 'array'
     or jsonb_array_length(p) = 0 or jsonb_array_length(p) > 500 then
    raise exception 'invalid_classifications';
  end if;
  perform set_config('milkpop.tax_classify_rpc', '1', true);
  for e in select * from jsonb_array_elements(p) loop
    v_id   := e ->> 'id';
    v_code := e ->> 'taxCode';   -- json null = explicit unclassify
    if v_id is null then
      raise exception 'invalid_classifications';
    end if;
    if v_code is not null and not exists (select 1 from tax_codes where code = v_code) then
      raise exception 'invalid_tax_code';
    end if;
    update menu_items set tax_code = v_code where id = v_id;
    if not found then
      raise exception 'unknown_menu_item';
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

revoke all on function classify_products(jsonb) from public, anon;
grant execute on function classify_products(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS6f.5  stores_public — the anonymous locator surface (auditor F11)
-- ----------------------------------------------------------------------------
-- Definer-style view (NOT security_invoker): anonymous visitors get exactly
-- the locator columns; the base table stops being anonymously readable at
-- all. Signed-in staff keep the full row via the authenticated grant + the
-- existing public_read policy.
create or replace view stores_public as
  select id, name, address, postcode, opening_hours, status, delivery_links,
         phone, email, image, coordinates, created_at, updated_at
    from stores;

revoke all on stores_public from public;
grant select on stores_public to anon, authenticated;
revoke select on table stores from anon;

-- ----------------------------------------------------------------------------
-- WS6f.6  configure_store_setup() — re-issue (F10 vocabulary + F3 gate)
-- ----------------------------------------------------------------------------
create or replace function configure_store_setup(p_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id  text := p_config ->> 'storeId';
  v_tz        text := p_config ->> 'timezone';
  v_cur       text := p_config ->> 'currencyCode';
  v_methods   jsonb := p_config -> 'paymentMethods';
  v_footer    text := coalesce(p_config ->> 'receiptFooter', '');
  v_vat       jsonb := p_config -> 'vat';
  v_vstatus   text;
  v_vnumber   text;
  v_veff      date;
  v_uncls     int;
  v_row       stores%rowtype;
begin
  -- Owner + MFA: is_owner() bakes aal2 in (FIX-8).
  if not is_owner() then
    raise exception 'owner_aal2_required' using errcode = '42501';
  end if;

  select * into v_row from stores where id = v_store_id;
  if v_row.id is null then
    raise exception 'unknown_store';
  end if;

  -- Timezone: must be a real IANA name — proven by asking PostgreSQL to use it.
  if v_tz is null or length(v_tz) < 1 or length(v_tz) > 64 then
    raise exception 'invalid_timezone';
  end if;
  -- WS6f (auditor F10): the LAUNCH-SUPPORTED vocabulary rules FIRST — the
  -- operator's actionable answer for any non-launch value is "unsupported",
  -- whether or not it happens to be a real IANA zone. Reporting/business-day
  -- logic is Europe/London and money display is GBP; widening either is a
  -- deliberate future migration (the CHECK constraints mirror this at the
  -- database).
  if v_tz <> 'Europe/London' then
    raise exception 'unsupported_timezone';
  end if;
  begin
    perform now() at time zone v_tz;   -- defense for the day the vocabulary widens
  exception when others then
    raise exception 'invalid_timezone';
  end;

  if v_cur is null or v_cur !~ '^[A-Z]{3}$' then
    raise exception 'invalid_currency';
  end if;
  if v_cur <> 'GBP' then
    raise exception 'unsupported_currency';
  end if;
  if not valid_payment_methods(v_methods) then
    raise exception 'invalid_payment_methods';
  end if;
  if length(v_footer) > 500 then
    raise exception 'invalid_receipt_footer';
  end if;

  -- VAT: the same two coherent shapes stores_vat_coherent enforces; the RPC
  -- validates FIRST so the operator gets a named error, then the constraint
  -- still guarantees it at the database.
  v_vstatus := v_vat ->> 'status';
  if v_vstatus not in ('NOT_REGISTERED','REGISTERED') then
    raise exception 'invalid_vat_config';
  end if;
  if v_vstatus = 'REGISTERED' then
    v_vnumber := v_vat ->> 'vatNumber';
    if v_vnumber is null or v_vnumber !~ '^GB[0-9]{9}([0-9]{3})?$' then
      raise exception 'invalid_vat_config';
    end if;
    begin
      v_veff := (v_vat ->> 'effectiveDate')::date;
    exception when others then
      raise exception 'invalid_vat_config';
    end;
    if v_veff is null then
      raise exception 'invalid_vat_config';
    end if;
    -- WS6f (auditor F3): a store cannot become REGISTERED while ANY product
    -- (or extra) lacks a controlled classification — its sales would then
    -- fail one by one at the till. Classification precedes registration.
    select count(*) into v_uncls from menu_items where tax_code is null;
    if v_uncls > 0 then
      raise exception 'products_unclassified'
        using detail = v_uncls || ' menu item(s) have no VAT classification.';
    end if;
  else
    v_vnumber := null;
    v_veff := null;
  end if;

  -- Mark this transaction as the wizard so the column guard admits the write.
  perform set_config('milkpop.store_setup_rpc', '1', true);

  update stores
     set timezone        = v_tz,
         currency_code   = v_cur,
         payment_methods = v_methods,
         receipt_footer  = v_footer,
         vat_status      = v_vstatus,
         vat_number      = v_vnumber,
         vat_registration_effective_date = v_veff,
         vat_config_confirmed_at = now(),
         setup_status    = 'ACTIVE'
   where id = v_store_id
  returning * into v_row;

  return to_jsonb(v_row);
end $$;

revoke all on function configure_store_setup(jsonb) from public, anon;
grant execute on function configure_store_setup(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS6f.7  submit_web_order() — re-issue (F1 charging, F5 components, F6 scope)
-- ----------------------------------------------------------------------------
-- Derived from the WS6e issue; every change is one of the audit corrections
-- named in the header, everything else is byte-identical.
create or replace function submit_web_order(p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff     text := current_staff_id();
  v_me        staff_profiles%rowtype;
  v_store_id  text;
  v_store_nm  text := '';
  v_store     stores%rowtype;
  v_id        text := p_order ->> 'id';
  v_channel   text := coalesce(p_order ->> 'channel', 'walk_in');
  v_payment   text := coalesce(p_order ->> 'paymentMethod', 'card');
  v_customer  text := nullif(trim(coalesce(p_order ->> 'customerName', '')), '');
  v_items_in  jsonb := p_order -> 'items';
  v_deal_ids  jsonb := coalesce(p_order -> 'dealIds', '[]'::jsonb);
  v_cash_p    bigint;
  it          jsonb;
  md          jsonb;
  m           menu_items%rowtype;
  x           menu_items%rowtype;
  v_size      text;
  v_qty       int;
  v_unit_p    bigint;
  v_mods_p    bigint;
  v_mods      jsonb;
  v_line_p    bigint;
  v_items     jsonb := '[]'::jsonb;
  v_sub_p     bigint := 0;
  -- per-line tax state
  v_line_ps   bigint[]  := '{}';
  v_codes     text[]    := '{}';
  v_rates     numeric[] := '{}';
  v_rate      numeric;
  v_alloc_p   bigint;
  v_taxable_p bigint;
  v_ltax_p    bigint;
  v_cum_prev  bigint;
  v_cum_here  bigint;
  v_tax_sum_p bigint := 0;
  v_uniform   boolean := true;
  v_head_rate numeric := null;
  -- WS6f: effective-date charging + per-line COMPONENT tax model
  v_status_reg boolean;
  v_charging  boolean;
  v_today     date;
  v_mod_rate  numeric;
  v_comps     jsonb := '[]'::jsonb;
  v_lcomp     jsonb;
  v_lc        jsonb;
  v_mods2     jsonb;
  v_line_rate numeric;
  v_line_uniform boolean;
  v_ccum_prev bigint;
  v_ccum_here bigint;
  v_cp        bigint;
  v_crate     numeric;
  v_calloc    bigint;
  v_ctaxable  bigint;
  v_ctax      bigint;
  v_mi        int;
  v_uncls_mod text;
  k           int;
  v_items_tx  jsonb := '[]'::jsonb;
  elem        jsonb;
  -- deal engine state
  d           deals%rowtype;
  v_units     bigint[];
  v_group_sum bigint;
  v_disc_p    bigint;
  v_best_p    bigint := 0;
  v_best_deal deals%rowtype;
  v_deals     jsonb := '[]'::jsonb;
  v_disc_tot  bigint := 0;
  v_total_p   bigint;
  v_change_p  bigint;
  v_order_no  bigint;
  v_row       orders%rowtype;
  g           int;
  i           int;
  j           int;
begin
  -- 1. Caller: a linked staff member; store is THEIRS, never the payload's.
  if v_staff is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  select * into v_me from staff_profiles where id = v_staff;
  v_store_id := v_me.store_id;
  if v_store_id is not null then
    select name into v_store_nm from stores where id = v_store_id;
  end if;

  -- 2. Validate the envelope.
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'invalid_order_id';
  end if;
  if v_items_in is null or jsonb_typeof(v_items_in) <> 'array'
     or jsonb_array_length(v_items_in) = 0
     or jsonb_array_length(v_items_in) > 100 then
    raise exception 'invalid_items';
  end if;
  if v_customer is not null and length(v_customer) > 120 then
    raise exception 'invalid_customer';
  end if;

  -- 3. Idempotency FIRST: a replayed id returns the stored truth.
  select * into v_row from orders where id = v_id;
  if found then
    -- WS6f (auditor F6): idempotency is CALLER-STORE-SCOPED. This is a
    -- SECURITY DEFINER function; without this check a guessed foreign order
    -- id would exfiltrate another store's order around RLS. A replay is only
    -- a replay when the stored row belongs to the caller's own store.
    if v_row.store_id is distinct from v_store_id then
      raise exception 'order_id_conflict' using errcode = '42501';
    end if;
    return jsonb_build_object('order', to_jsonb(v_row), 'duplicate', true);
  end if;

  -- 4. TRADING GATE (closure brief §1): the sale must belong to a store whose
  --    VAT configuration has been explicitly confirmed. No store, or an
  --    unconfirmed store, blocks trading — nothing is ever defaulted.
  if v_store_id is null then
    raise exception 'store_vat_unconfigured'
      using detail = 'The caller has no home store; sales must belong to a VAT-configured store.';
  end if;
  select * into v_store from stores where id = v_store_id;
  if v_store.id is null or v_store.vat_config_confirmed_at is null then
    raise exception 'store_vat_unconfigured'
      using detail = 'The store''s VAT configuration has not been confirmed; trading is blocked.';
  end if;
  -- 4b. SETUP GATE (WS6e): a store still in DRAFT has not completed the
  --     owner Setup Wizard and cannot trade, even when its VAT facts exist.
  if v_store.setup_status is distinct from 'ACTIVE' then
    raise exception 'store_setup_incomplete'
      using detail = 'The store''s Setup Wizard has not been completed; trading is blocked.';
  end if;
  -- WS6f (auditor F1): REGISTERED alone does NOT charge — the registration's
  -- EFFECTIVE DATE must have arrived in the store's OWN business day (the
  -- local date in its configured timezone). A future-dated registration
  -- snapshots REGISTERED + its date, but every amount derives exactly like
  -- NOT_REGISTERED until the date arrives. Registering is forward-only.
  v_status_reg := (v_store.vat_status = 'REGISTERED');
  v_today      := (now() at time zone v_store.timezone)::date;
  v_charging   := v_status_reg
                  and v_store.vat_registration_effective_date <= v_today;

  -- 5. Price every line from the catalogue (integer pence) and capture its
  --    tax classification. REGISTERED trading refuses unclassified products.
  for i in 0 .. jsonb_array_length(v_items_in) - 1 loop
    it := v_items_in -> i;
    select * into m from menu_items where id = it ->> 'menuItemId';
    if m.id is null then
      raise exception 'unknown_menu_item';
    end if;
    if v_charging and m.tax_code is null then
      raise exception 'product_tax_unclassified'
        using detail = 'Product "' || m.id || '" has no VAT classification; a VAT-charging store cannot sell it.';
    end if;
    if v_charging then
      select rate_percent into v_rate from tax_codes where code = m.tax_code;
    else
      v_rate := 0;
    end if;
    v_qty := coalesce(nullif(it ->> 'quantity', '')::int, 0);
    if v_qty < 1 or v_qty > 99 then
      raise exception 'invalid_quantity';
    end if;
    v_size := case when it ->> 'size' = 'large' then 'large' else 'regular' end;
    v_unit_p := round((case when v_size = 'large' and m.price_large is not null
                            then m.price_large else m.price end) * 100)::bigint;

    v_mods_p := 0;
    v_mods := '[]'::jsonb;
    -- Base component (the product portion of the line) — modifiers append
    -- their own components in payload order inside the loop below.
    v_lcomp := jsonb_build_array(jsonb_build_object(
      'p', v_unit_p * v_qty, 'rate', v_rate, 'code', m.tax_code, 'mi', -1));
    if jsonb_typeof(it -> 'modifiers') = 'array' then
      if jsonb_array_length(it -> 'modifiers') > 20 then
        raise exception 'invalid_modifiers';
      end if;
      for j in 0 .. jsonb_array_length(it -> 'modifiers') - 1 loop
        md := it -> 'modifiers' -> j;
        select * into x from menu_items
          where id = md ->> 'menuItemId' and category = 'extras';
        if x.id is null then
          raise exception 'unknown_extra';
        end if;
        -- WS6f (auditor F5): an extra is taxed by ITS OWN classification,
        -- never by the base product's. A charging store refuses an
        -- unclassified extra exactly as it refuses an unclassified product.
        if v_charging and x.tax_code is null then
          raise exception 'product_tax_unclassified'
            using detail = 'Extra "' || x.id || '" has no VAT classification; a VAT-charging store cannot sell it.';
        end if;
        if v_charging then
          select rate_percent into v_mod_rate from tax_codes where code = x.tax_code;
        else
          v_mod_rate := 0;
        end if;
        v_mods_p := v_mods_p + round(x.price * 100)::bigint;
        v_lcomp := v_lcomp || jsonb_build_array(jsonb_build_object(
          'p', round(x.price * 100)::bigint * v_qty,
          'rate', v_mod_rate, 'code', x.tax_code, 'mi', j));
        v_mods := v_mods || jsonb_build_array(jsonb_build_object(
          'id', 'mod_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10),
          'menuItemId', x.id, 'name', x.name, 'price', round(x.price * 100) / 100.0));
      end loop;
    end if;

    v_line_p := (v_unit_p + v_mods_p) * v_qty;
    v_sub_p  := v_sub_p + v_line_p;
    v_line_ps := v_line_ps || v_line_p;
    v_comps   := v_comps || jsonb_build_array(v_lcomp);
    v_codes   := v_codes   || m.tax_code;
    v_rates   := v_rates   || v_rate;
    v_items  := v_items || jsonb_build_array(jsonb_build_object(
      'id', 'li_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
      'menuItemId', m.id, 'name', m.name, 'category', m.category,
      'size', v_size, 'unitPrice', v_unit_p / 100.0, 'quantity', v_qty,
      'modifiers', v_mods, 'lineTotal', v_line_p / 100.0,
      'notes', nullif(trim(coalesce(it ->> 'notes', '')), '')));
  end loop;

  -- 6. Deals — recomputed HERE with the client engine's semantics: units are
  --    the BASE prices (extras stay charged), sorted dearest-first; only the
  --    single best-scoring claimed deal applies; a claim that computes to
  --    zero is dropped.
  if jsonb_typeof(v_deal_ids) = 'array' and jsonb_array_length(v_deal_ids) > 0 then
    for i in 0 .. least(jsonb_array_length(v_deal_ids), 10) - 1 loop
      select * into d from deals
        where id = v_deal_ids ->> i and active = true;
      if d.id is null then continue; end if;
      v_disc_p := 0;

      if d.type in ('bundle_price', 'buy_x_get_y_free', 'percent_off_category')
         and d.category is not null then
        select coalesce(array_agg(u order by u desc), '{}')
          into v_units
          from (select round((q ->> 'unitPrice')::numeric * 100)::bigint as u
                  from jsonb_array_elements(v_items) q,
                       generate_series(1, (q ->> 'quantity')::int)
                 where q ->> 'category' = d.category::text) s;
      end if;

      if d.type = 'bundle_price'
         and d.buy_qty is not null and d.buy_qty > 0 and d.bundle_price is not null then
        for g in 0 .. (coalesce(array_length(v_units, 1), 0) / d.buy_qty) - 1 loop
          v_group_sum := 0;
          for j in 1 .. d.buy_qty loop
            v_group_sum := v_group_sum + v_units[g * d.buy_qty + j];
          end loop;
          if v_group_sum > round(d.bundle_price * 100)::bigint then
            v_disc_p := v_disc_p + v_group_sum - round(d.bundle_price * 100)::bigint;
          end if;
        end loop;

      elsif d.type = 'buy_x_get_y_free'
         and d.buy_qty is not null and d.buy_qty > 0
         and d.free_qty is not null and d.free_qty > 0 then
        for g in 0 .. (coalesce(array_length(v_units, 1), 0) / (d.buy_qty + d.free_qty)) - 1 loop
          -- within each dearest-first group, the trailing free_qty units are
          -- the cheapest — those go free.
          for j in d.buy_qty + 1 .. d.buy_qty + d.free_qty loop
            v_disc_p := v_disc_p + v_units[g * (d.buy_qty + d.free_qty) + j];
          end loop;
        end loop;

      elsif d.type = 'percent_off_category' and d.percent_off is not null then
        select coalesce(sum(u), 0) into v_group_sum from unnest(v_units) u;
        v_disc_p := round(v_group_sum * d.percent_off / 100);

      elsif d.type = 'fixed_off_order' and d.amount_off is not null then
        if d.min_order_value is null
           or v_sub_p >= round(d.min_order_value * 100)::bigint then
          v_disc_p := least(round(d.amount_off * 100)::bigint, v_sub_p);
        end if;
      end if;

      if v_disc_p > v_best_p then
        v_best_p := v_disc_p;
        v_best_deal := d;
      end if;
    end loop;

    if v_best_p > 0 then
      v_best_p := least(v_best_p, v_sub_p);
      v_disc_tot := v_best_p;
      v_deals := jsonb_build_array(jsonb_build_object(
        'dealId', v_best_deal.id, 'dealName', v_best_deal.name,
        'discount', v_best_p / 100.0));
    end if;
  end if;

  -- 7. Totals — VAT-inclusive UK pricing; payment facts validated.
  v_total_p := greatest(v_sub_p - v_disc_tot, 0);

  -- 7a. Per-line tax snapshots (WS6f component model). The order discount is
  --     allocated over the LINES by cumulative largest-exact shares, then the
  --     SAME method splits each line's share across its COMPONENTS (base
  --     portion first, then each modifier in payload order). Every component
  --     is taxed at ITS OWN rate with the single rounding step
  --     round(taxable_pence × rate / (100 + rate)); the line's tax is the sum
  --     of its component taxes, the order's tax is the sum of the line taxes
  --     — no re-rounding anywhere. A line whose components carry mixed rates
  --     snapshots a NULL line rate (the modifier rows are the authority),
  --     exactly as a mixed-rate ORDER snapshots a NULL headline rate.
  v_cum_prev := 0;
  for i in 1 .. coalesce(array_length(v_line_ps, 1), 0) loop
    v_cum_here := v_cum_prev + v_line_ps[i];
    if v_sub_p > 0 then
      v_alloc_p := (v_disc_tot * v_cum_here / v_sub_p)
                 - (v_disc_tot * v_cum_prev / v_sub_p);
    else
      v_alloc_p := 0;
    end if;
    v_cum_prev  := v_cum_here;
    v_taxable_p := v_line_ps[i] - v_alloc_p;

    v_lc := v_comps -> (i - 1);
    v_ltax_p := 0;
    v_line_rate := null;
    v_line_uniform := true;
    v_ccum_prev := 0;
    v_mods2 := (v_items -> (i - 1)) -> 'modifiers';
    for k in 0 .. jsonb_array_length(v_lc) - 1 loop
      v_cp    := ((v_lc -> k) ->> 'p')::bigint;
      v_crate := ((v_lc -> k) ->> 'rate')::numeric;
      v_ccum_here := v_ccum_prev + v_cp;
      if v_line_ps[i] > 0 then
        v_calloc := (v_alloc_p * v_ccum_here / v_line_ps[i])
                  - (v_alloc_p * v_ccum_prev / v_line_ps[i]);
      else
        v_calloc := 0;
      end if;
      v_ccum_prev := v_ccum_here;
      v_ctaxable := v_cp - v_calloc;
      v_ctax     := round(v_ctaxable * v_crate / (100 + v_crate));
      v_ltax_p   := v_ltax_p + v_ctax;
      if v_line_rate is null then v_line_rate := v_crate;
      elsif v_line_rate <> v_crate then v_line_uniform := false;
      end if;
      if v_head_rate is null then v_head_rate := v_crate;
      elsif v_head_rate <> v_crate then v_uniform := false;
      end if;
      v_mi := ((v_lc -> k) ->> 'mi')::int;
      if v_mi >= 0 then
        v_mods2 := jsonb_set(v_mods2, array[v_mi::text], (v_mods2 -> v_mi) || jsonb_build_object(
          'taxCode', (v_lc -> k) -> 'code',
          'taxRate', v_crate,
          'taxableAmount', v_ctaxable / 100.0,
          'taxAmount', v_ctax / 100.0));
      end if;
    end loop;
    v_tax_sum_p := v_tax_sum_p + v_ltax_p;
    elem := (v_items -> (i - 1)) || jsonb_build_object(
      'modifiers', v_mods2,
      'taxCode', v_codes[i],
      'taxRate', case when v_line_uniform then v_line_rate else null end,
      'taxableAmount', v_taxable_p / 100.0,
      'taxAmount', v_ltax_p / 100.0);
    v_items_tx := v_items_tx || jsonb_build_array(elem);
  end loop;
  v_items := v_items_tx;

  if v_payment not in ('cash', 'card', 'online', 'gift_card') then
    raise exception 'invalid_payment_method';
  end if;
  if v_channel not in ('walk_in','phone','website','deliveroo','uber_eats','just_eat') then
    raise exception 'invalid_channel';
  end if;
  -- WS6e: the store's ACCEPTED payment methods are configuration, not a
  -- constant. A syntactically valid method outside the configured set is
  -- refused (jsonb ? = string membership in the configured array).
  if not (v_store.payment_methods ? v_payment) then
    raise exception 'payment_method_not_accepted'
      using detail = 'Payment method "' || v_payment || '" is not enabled for this store.';
  end if;
  v_change_p := null;
  v_cash_p := null;
  if v_payment = 'cash' then
    v_cash_p := round(coalesce(nullif(p_order ->> 'cashReceived', '')::numeric, 0) * 100)::bigint;
    if v_cash_p < v_total_p then
      raise exception 'insufficient_cash';
    end if;
    v_change_p := v_cash_p - v_total_p;
  end if;

  -- 8. Order number: per-store, race-safe via an advisory lock scoped to this
  --    transaction.
  perform pg_advisory_xact_lock(hashtext('milkpop_order_no_' || coalesce(v_store_id, 'hq')));
  select coalesce(max(order_number), 0) + 1 into v_order_no
    from orders where coalesce(store_id, 'hq') = coalesce(v_store_id, 'hq');

  insert into orders
    (id, order_number, store_id, store_name, channel, items, applied_deals,
     subtotal, discount_total, tax_rate, tax_amount, total,
     store_vat_status, vat_effective_date,
     payment_method, cash_received, change_given, status,
     customer_name, staff_id, staff_name, placed_at, completed_at)
  values
    (v_id, v_order_no, v_store_id, coalesce(v_store_nm, ''),
     v_channel::order_channel, v_items, v_deals,
     v_sub_p / 100.0, v_disc_tot / 100.0,
     case when v_uniform then v_head_rate else null end,
     v_tax_sum_p / 100.0, v_total_p / 100.0,
     v_store.vat_status,
     case when v_status_reg then v_store.vat_registration_effective_date else null end,
     v_payment::payment_method,
     case when v_cash_p is null then null else v_cash_p / 100.0 end,
     case when v_change_p is null then null else v_change_p / 100.0 end,
     'completed', v_customer, v_staff, coalesce(v_me.name, ''), now(), now())
  on conflict (id) do nothing
  returning * into v_row;

  if v_row.id is null then
    -- Lost an id race after the step-3 check: return the stored truth —
    -- under the SAME caller-store scope rule as step 3 (auditor F6).
    select * into v_row from orders where id = v_id;
    if v_row.store_id is distinct from v_store_id then
      raise exception 'order_id_conflict' using errcode = '42501';
    end if;
    return jsonb_build_object('order', to_jsonb(v_row), 'duplicate', true);
  end if;

  return jsonb_build_object('order', to_jsonb(v_row), 'duplicate', false);
end $$;

revoke all on function submit_web_order(jsonb) from public;
grant execute on function submit_web_order(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS6f.8  explode_order_items() — project the modifier tax snapshots (F5)
-- ----------------------------------------------------------------------------
create or replace function explode_order_items() returns trigger as $$
declare
  item jsonb;
  mod  jsonb;
  new_item_row uuid;
begin
  delete from order_items where order_id = new.id;  -- cascades to modifiers
  for item in select * from jsonb_array_elements(coalesce(new.items, '[]'::jsonb))
  loop
    insert into order_items (id, order_id, menu_item_id, name, category, size,
                             unit_price, quantity, line_total, notes,
                             tax_code, tax_rate, taxable_amount, tax_amount)
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
      item->>'notes',
      nullif(item->>'taxCode', ''),
      (item->>'taxRate')::numeric,
      (item->>'taxableAmount')::numeric,
      (item->>'taxAmount')::numeric
    )
    returning row_id into new_item_row;

    for mod in select * from jsonb_array_elements(coalesce(item->'modifiers', '[]'::jsonb))
    loop
      insert into order_item_modifiers (id, order_item_id, order_id, menu_item_id, name, price,
                                        tax_code, tax_rate, taxable_amount, tax_amount)
      values (
        coalesce(mod->>'id', gen_random_uuid()::text),
        new_item_row,
        new.id,
        mod->>'menuItemId',
        coalesce(mod->>'name',''),
        coalesce((mod->>'price')::numeric, 0),
        nullif(mod->>'taxCode', ''),
        (mod->>'taxRate')::numeric,
        (mod->>'taxableAmount')::numeric,
        (mod->>'taxAmount')::numeric
      );
    end loop;
  end loop;
  return new;
end $$ language plpgsql;

alter function explode_order_items() security definer;
alter function explode_order_items() set search_path = public;
revoke all on function explode_order_items() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE (proven live by matrix §18):
--   • A future-dated REGISTERED store derives 0/0 with a REGISTERED + date
--     snapshot; a past-dated one charges. (F1)
--   • Cross-store id replay raises order_id_conflict; same-store replay
--     still returns the stored truth. (F6)
--   • A manager (aal2) cannot change or pre-set menu_items.tax_code
--     (tax_code_is_owner_only); the owner classify RPC can, including
--     explicit unclassify; the wizard refuses REGISTERED while anything is
--     unclassified (products_unclassified). (F3/F4)
--   • A standard-rated extra on a zero-rated base is taxed at ITS rate with
--     exact pence, the modifier row carries the snapshot, the line rate is
--     NULL when its components mix. (F5)
--   • unsupported_timezone / unsupported_currency at the RPC and the CHECKs
--     at the database. (F10)
--   • anon cannot read stores at all; stores_public exposes exactly the
--     locator columns; authenticated staff read the full row. (F11)
-- ============================================================================
