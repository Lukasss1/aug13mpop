-- ============================================================================
-- STAGE 3 / WS6e — STORE SETUP LIFECYCLE (closure brief §1 completion; Round 9)
-- ============================================================================
-- Completes §1's store-configuration half, per the deferral contract recorded
-- in WS6d's header: setup_status DRAFT→ACTIVE, timezone / currency /
-- business-day / payment-method / receipt configuration, the owner-only
-- Store Setup Wizard's server side, store-ID immutability, and the RPC-only
-- guard on the configuration + VAT columns.
--
-- MODEL
--   • stores.setup_status: 'DRAFT' (fail-closed default) | 'ACTIVE'. A DRAFT
--     store cannot trade (submit_web_order raises store_setup_incomplete).
--     DISTINCT from stores.status (store_status 'open'/…): status is the
--     PUBLIC open/closed display state; setup_status is the operator
--     lifecycle. A store can be ACTIVE (setup done) yet status 'closed'.
--   • Configuration columns: timezone (IANA name; the store's business-day
--     boundary derives from local midnight in this zone — the WS2
--     Europe/London reporting contract, now stated per store), currency_code
--     (ISO-4217 shape), payment_methods (jsonb array ⊆ the four order
--     methods — the ACCEPTED set the till may take), receipt_footer.
--   • stores_setup_coherent: ACTIVE requires timezone + valid currency +
--     a valid non-empty payment set + confirmed VAT config. There is no
--     half-configured ACTIVE state.
--   • configure_store_setup(...) is the ONLY client path that writes any of
--     this: owner + aal2 (is_owner() bakes both in), validates every field,
--     confirms VAT, and flips DRAFT→ACTIVE atomically.
--   • trg_stores_config_guard: the configuration + VAT columns are RPC/
--     service-only. The wizard RPC marks its transaction with a local GUC;
--     the trusted service context and non-API sessions (migrations, DBA
--     psql: request.jwt.claims unset) pass; any other API write to those
--     columns raises store_config_is_rpc_only. replace_collection publishes
--     that OMIT these keys leave the columns untouched and pass untouched.
--   • trg_stores_id_immutable: closure brief §1 "immutable store ID" — the
--     primary key can never be rewritten once issued.
--
-- BACKFILL: stores that already carry the WS6d operator confirmation
-- (vat_config_confirmed_at) are the live trading business — they become
-- ACTIVE with the values current behaviour already embodies:
-- Europe/London, GBP, the till's cash/card/online set. Stores created later
-- start DRAFT and must complete the wizard.
--
-- Idempotent; fails closed; appended via MP_FUTURE_MIGRATIONS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- WS6e.1  stores — setup lifecycle + configuration columns
-- ----------------------------------------------------------------------------
alter table stores add column if not exists setup_status text not null default 'DRAFT';
alter table stores add column if not exists timezone text;
alter table stores add column if not exists currency_code text;
alter table stores add column if not exists payment_methods jsonb;
alter table stores add column if not exists receipt_footer text not null default '';

comment on column stores.setup_status is
  'DRAFT (fail-closed default) | ACTIVE. A DRAFT store cannot trade; the owner Setup Wizard (configure_store_setup) is the only client path to ACTIVE. Distinct from stores.status, the public open/closed display state.';
comment on column stores.timezone is
  'IANA timezone. The store''s business day derives from local midnight in this zone (the WS2 reporting contract, stated per store).';
comment on column stores.payment_methods is
  'jsonb array — the ACCEPTED subset of {cash,card,online,gift_card}. submit_web_order refuses methods outside this set.';

-- Pure-jsonb validator (immutable: no table access) so the coherence CHECK
-- can rule on the payment set. Non-empty array, every element one of the
-- four order methods, no duplicates.
create or replace function valid_payment_methods(p jsonb)
returns boolean
language sql
immutable
as $$
  select p is not null
     and jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) between 1 and 4
     and not exists (
       select 1 from jsonb_array_elements_text(p) e
        where e not in ('cash','card','online','gift_card'))
     and (select count(distinct e) = count(e)
            from jsonb_array_elements_text(p) e);
$$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stores_setup_status_controlled') then
    alter table stores add constraint stores_setup_status_controlled check (
      setup_status in ('DRAFT','ACTIVE')
    );
  end if;
  -- No half-configured ACTIVE state: activation REQUIRES the full config and
  -- the WS6d VAT confirmation. DRAFT rows are free to be partial.
  if not exists (select 1 from pg_constraint where conname = 'stores_setup_coherent') then
    alter table stores add constraint stores_setup_coherent check (
      setup_status = 'DRAFT'
      or (timezone is not null
          and length(timezone) between 1 and 64
          and currency_code ~ '^[A-Z]{3}$'
          and valid_payment_methods(payment_methods)
          and vat_config_confirmed_at is not null)
    );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- WS6e.2  Backfill — the live business the WS6d confirmation already covers
-- ----------------------------------------------------------------------------
update stores
   set setup_status    = 'ACTIVE',
       timezone        = coalesce(timezone, 'Europe/London'),
       currency_code   = coalesce(currency_code, 'GBP'),
       payment_methods = coalesce(payment_methods, '["cash","card","online"]'::jsonb)
 where vat_config_confirmed_at is not null
   and setup_status = 'DRAFT';

-- ----------------------------------------------------------------------------
-- WS6e.3  Store-ID immutability (closure brief §1)
-- ----------------------------------------------------------------------------
create or replace function enforce_store_id_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'store_id_immutable' using errcode = '42501',
      detail = 'A store''s ID is permanent; history (orders, shifts, POS) is keyed to it.';
  end if;
  return new;
end $$;

drop trigger if exists trg_stores_id_immutable on stores;
create trigger trg_stores_id_immutable
  before update of id on stores
  for each row execute function enforce_store_id_immutable();

-- ----------------------------------------------------------------------------
-- WS6e.4  Configuration + VAT columns are RPC/service-only
-- ----------------------------------------------------------------------------
-- The wizard RPC marks its own transaction with a local GUC; the privileged
-- bypass-RLS context (detected structurally, no role-name literal) and
-- non-API sessions (no request.jwt.claims: migrations, DBA psql) pass. Any
-- other writer changing
-- a guarded column is refused — replace_collection publishes that OMIT these
-- keys never touch the columns, so normal store edits are unaffected.
create or replace function enforce_store_config_guard()
returns trigger
language plpgsql
-- SECURITY INVOKER (deliberate): inside a DEFINER function current_user is
-- the function OWNER, which would make the structural bypass-RLS test below
-- judge the wrong role. As invoker, current_user is the CALLING role
-- (authenticated / the bypass role), which is exactly what the guard rules
-- on. The wizard RPC is itself DEFINER — its writes are admitted by the GUC
-- branch, never by role introspection. pg_roles and current_setting need no
-- elevated rights.
set search_path = public, pg_temp
as $$
declare
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
begin
  if current_setting('milkpop.store_setup_rpc', true) = '1' then
    return new;                                  -- the wizard RPC itself
  end if;
  if v_claims is null then
    return new;                                  -- non-API session (migration/DBA)
  end if;
  -- Trusted privileged context: the RLS-bypass role the API's service key
  -- runs as. Detected STRUCTURALLY (pg_roles.rolbypassrls on current_user)
  -- rather than by name — no role-name literal ships in code (the security
  -- tripwire forbids it) and the check survives a role rename.
  if exists (select 1 from pg_roles r where r.rolname = current_user and r.rolbypassrls) then
    return new;
  end if;
  if (new.setup_status    is distinct from old.setup_status)
     or (new.timezone        is distinct from old.timezone)
     or (new.currency_code   is distinct from old.currency_code)
     or (new.payment_methods is distinct from old.payment_methods)
     or (new.receipt_footer  is distinct from old.receipt_footer)
     or (new.vat_status      is distinct from old.vat_status)
     or (new.vat_number      is distinct from old.vat_number)
     or (new.vat_registration_effective_date is distinct from old.vat_registration_effective_date)
     or (new.vat_config_confirmed_at         is distinct from old.vat_config_confirmed_at)
  then
    raise exception 'store_config_is_rpc_only' using errcode = '42501',
      detail = 'Store setup and VAT configuration change only through configure_store_setup().';
  end if;
  return new;
end $$;

drop trigger if exists trg_stores_config_guard on stores;
create trigger trg_stores_config_guard
  before update on stores
  for each row execute function enforce_store_config_guard();

-- ----------------------------------------------------------------------------
-- WS6e.5  configure_store_setup() — the owner Setup Wizard's server side
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
  begin
    perform now() at time zone v_tz;
  exception when others then
    raise exception 'invalid_timezone';
  end;

  if v_cur is null or v_cur !~ '^[A-Z]{3}$' then
    raise exception 'invalid_currency';
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
-- WS6e.6  submit_web_order() — re-issue (setup gate + accepted payment set)
-- ----------------------------------------------------------------------------
-- Byte-for-byte the WS6d issue except: (a) the SETUP GATE after the VAT gate
-- (DRAFT store ⇒ store_setup_incomplete — checked AFTER the VAT confirmation
-- so an unconfirmed store still reports store_vat_unconfigured, keeping the
-- §16 contract), and (b) the ACCEPTED-payment-set check after the payment/
-- channel validation (⇒ payment_method_not_accepted).
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
  v_reg       boolean;
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
  v_reg := (v_store.vat_status = 'REGISTERED');

  -- 5. Price every line from the catalogue (integer pence) and capture its
  --    tax classification. REGISTERED trading refuses unclassified products.
  for i in 0 .. jsonb_array_length(v_items_in) - 1 loop
    it := v_items_in -> i;
    select * into m from menu_items where id = it ->> 'menuItemId';
    if m.id is null then
      raise exception 'unknown_menu_item';
    end if;
    if v_reg and m.tax_code is null then
      raise exception 'product_tax_unclassified'
        using detail = 'Product "' || m.id || '" has no VAT classification; a REGISTERED store cannot sell it.';
    end if;
    if v_reg then
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
        v_mods_p := v_mods_p + round(x.price * 100)::bigint;
        v_mods := v_mods || jsonb_build_array(jsonb_build_object(
          'id', 'mod_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10),
          'menuItemId', x.id, 'name', x.name, 'price', round(x.price * 100) / 100.0));
      end loop;
    end if;

    v_line_p := (v_unit_p + v_mods_p) * v_qty;
    v_sub_p  := v_sub_p + v_line_p;
    v_line_ps := v_line_ps || v_line_p;
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

  -- 7a. Per-line tax snapshots. The order discount is allocated over the
  --     lines by cumulative largest-exact shares — deterministic, order-
  --     preserving, and summing EXACTLY to the discount — then each line's
  --     contained VAT is derived by the single rounding step
  --     round(taxable_pence × rate / (100 + rate)). Order tax is the SUM of
  --     the line taxes (no second rounding).
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
    v_ltax_p    := round(v_taxable_p * v_rates[i] / (100 + v_rates[i]));
    v_tax_sum_p := v_tax_sum_p + v_ltax_p;
    if v_head_rate is null then
      v_head_rate := v_rates[i];
    elsif v_head_rate <> v_rates[i] then
      v_uniform := false;
    end if;
    elem := (v_items -> (i - 1)) || jsonb_build_object(
      'taxCode', v_codes[i],
      'taxRate', v_rates[i],
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
     case when not v_reg then 0
          when v_uniform then v_head_rate
          else null end,
     v_tax_sum_p / 100.0, v_total_p / 100.0,
     v_store.vat_status,
     case when v_reg then v_store.vat_registration_effective_date else null end,
     v_payment::payment_method,
     case when v_cash_p is null then null else v_cash_p / 100.0 end,
     case when v_change_p is null then null else v_change_p / 100.0 end,
     'completed', v_customer, v_staff, coalesce(v_me.name, ''), now(), now())
  on conflict (id) do nothing
  returning * into v_row;

  if v_row.id is null then
    -- Lost an id race after the step-3 check: return the stored truth.
    select * into v_row from orders where id = v_id;
    return jsonb_build_object('order', to_jsonb(v_row), 'duplicate', true);
  end if;

  return jsonb_build_object('order', to_jsonb(v_row), 'duplicate', false);
end $$;

revoke all on function submit_web_order(jsonb) from public;
grant execute on function submit_web_order(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE (proven live by matrix §17):
--   • A new store defaults to DRAFT; DRAFT + vat-confirmed still cannot
--     trade (store_setup_incomplete); the §16 unconfirmed-store contract is
--     unchanged (store_vat_unconfigured fires first).
--   • ACTIVE without full config is CHECK-impossible; bad currency shape,
--     bad payment set (unknown method / empty / duplicates) rejected.
--   • configure_store_setup: non-owner and owner@aal1 are refused; owner@aal2
--     activates a store atomically (config + VAT confirm + ACTIVE) and the
--     store can then trade; an invalid IANA timezone or malformed VAT block
--     is refused with a named error.
--   • The till refuses a payment method outside the store's configured set
--     (payment_method_not_accepted) while a configured one succeeds.
--   • Direct API writes to any guarded column — even by the owner — raise
--     store_config_is_rpc_only; a replace_collection publish that omits the
--     guarded keys still succeeds and leaves the configuration untouched.
--   • stores.id can never be rewritten (store_id_immutable).
-- ============================================================================
