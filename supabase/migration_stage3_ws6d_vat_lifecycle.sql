-- ============================================================================
-- STAGE 3 / WS6d — VAT LIFECYCLE CORE (closure brief §1; Round 8)
-- ============================================================================
-- OPERATOR DECISION (recorded in the Stage-3 closure brief and in
-- docs/STAGE3-MONEY-AND-VAT-RULES.md): Milk Pop launches NOT_REGISTERED for
-- VAT. Tax charged is 0, tax amount is 0, no VAT number exists, and NO code
-- path may fall back to an automatic 20% rate. Missing VAT configuration
-- BLOCKS trading instead of selecting a default.
--
-- WHAT THIS MIGRATION DOES
--   1. tax_codes            controlled classification registry (4 statutory
--                           reference rows — system data, not business data).
--   2. stores               store-level VAT lifecycle: vat_status,
--                           vat_number, vat_registration_effective_date,
--                           vat_config_confirmed_at (the trading gate).
--   3. site_settings        the global vat_rate_percent (source of every 20%
--                           fallback) and the display-only vat_number are
--                           REMOVED. Store-level config is the single truth.
--   4. orders               immutable per-order VAT snapshot: store_vat_status
--                           + vat_effective_date; tax_rate loses its silent
--                           DEFAULT 20 and becomes nullable (NULL = mixed-rate
--                           order whose truth lives on the lines).
--   5. order_items          immutable per-line snapshot: tax_code, tax_rate,
--                           taxable_amount, tax_amount.
--   6. menu_items           tax_code classification (nullable = unclassified;
--                           classification is explicit, never defaulted).
--   7. explode_order_items  re-issued to project the line tax snapshots.
--   8. submit_web_order     re-issued: trading gate, zero-rate NOT_REGISTERED
--                           path, registered per-line rates from the registry,
--                           deterministic discount allocation, line-level
--                           rounding, order tax = sum of line taxes.
--
-- WHAT IT DELIBERATELY DOES NOT DO (Round 9+, documented in the plan):
--   setup_status DRAFT→ACTIVE lifecycle, timezone/currency/business-day/
--   payment-method/receipt configuration, and the owner-only Store Setup
--   Wizard. The trading gate below (vat_config_confirmed_at) is the §1
--   "missing configuration blocks trading" rule and will become one of the
--   wizard's completion facts.
--
-- BACKFILL SEMANTICS
--   • Existing stores get vat_config_confirmed_at = now(): the operator's
--     NOT_REGISTERED decision covers every store trading today. Stores
--     created AFTER this migration start unconfirmed and cannot trade until
--     explicitly configured.
--   • Historical orders keep NULL snapshots — we do not invent a VAT status
--     for rows that predate the lifecycle. The coherence constraints only
--     bind rows that CARRY a snapshot.
--
-- Idempotent; fails closed; appended via MP_FUTURE_MIGRATIONS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- WS6d.1  tax_codes — the controlled classification registry
-- ----------------------------------------------------------------------------
-- Four codes only (closure brief §1). Rates are UK statutory REFERENCE values
-- for the future REGISTERED mode; while a store is NOT_REGISTERED they are
-- never applied. vat_charged=false marks OUTSIDE_SCOPE semantics (no VAT is
-- chargeable at all, distinct from a chargeable 0% zero rate).
create table if not exists tax_codes (
  code          text primary key,
  rate_percent  numeric(5,2) not null,
  vat_charged   boolean not null,
  description   text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint tax_codes_code_controlled check (
    code in ('ZERO_RATED','STANDARD_RATE','REDUCED_RATE','OUTSIDE_SCOPE')
  ),
  constraint tax_codes_rate_bounds check (rate_percent >= 0 and rate_percent <= 100),
  constraint tax_codes_uncharged_is_zero check (vat_charged or rate_percent = 0)
);

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_tax_codes_updated') then
    create trigger trg_tax_codes_updated before update on tax_codes
      for each row execute function set_updated_at();
  end if;
end $$;

insert into tax_codes (code, rate_percent, vat_charged, description) values
  ('ZERO_RATED',    0,  true,  'UK zero rate (0%) — chargeable at 0%.'),
  ('REDUCED_RATE',  5,  true,  'UK reduced rate (5%).'),
  ('STANDARD_RATE', 20, true,  'UK standard rate (20%).'),
  ('OUTSIDE_SCOPE', 0,  false, 'Outside the scope of UK VAT — no VAT chargeable.')
on conflict (code) do nothing;

-- Supabase-parity access: reads for signed-in surfaces; NO client write
-- policies exist, so anon/authenticated writes are RLS-denied and only the
-- trusted service context can maintain the registry.
alter table tax_codes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'tax_codes' and policyname = 'tax_codes_read_authed') then
    create policy tax_codes_read_authed on tax_codes for select to authenticated using (true);
  end if;
end $$;
-- Verb revocation (Stage-2 house style): RLS alone turns a client UPDATE into
-- a silent 0-row no-op; revoking the write verbs makes it a hard
-- permission-denied instead, and anon has no business reading tax reference
-- data at all.
revoke all on table tax_codes from anon;
revoke insert, update, delete, truncate, references, trigger on table tax_codes from authenticated;

-- ----------------------------------------------------------------------------
-- WS6d.2  stores — VAT lifecycle configuration
-- ----------------------------------------------------------------------------
alter table stores add column if not exists vat_status text not null default 'NOT_REGISTERED';
alter table stores add column if not exists vat_number text;
alter table stores add column if not exists vat_registration_effective_date date;
alter table stores add column if not exists vat_config_confirmed_at timestamptz;

comment on column stores.vat_status is
  'NOT_REGISTERED | REGISTERED. Fail-closed default: a new store charges no VAT and cannot trade until vat_config_confirmed_at is set.';
comment on column stores.vat_config_confirmed_at is
  'Trading gate (closure brief §1): submit_web_order() refuses to trade for a store whose VAT configuration has not been explicitly confirmed. Becomes a Store Setup Wizard completion fact in the setup-lifecycle round.';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stores_vat_status_controlled') then
    alter table stores add constraint stores_vat_status_controlled check (
      vat_status in ('NOT_REGISTERED','REGISTERED')
    );
  end if;
  -- Registration coherence: NOT_REGISTERED carries no number and no effective
  -- date; REGISTERED requires a well-formed GB VAT number AND the effective
  -- date. There is no state in which a rate could need "defaulting".
  if not exists (select 1 from pg_constraint where conname = 'stores_vat_coherent') then
    alter table stores add constraint stores_vat_coherent check (
      (vat_status = 'NOT_REGISTERED'
        and vat_number is null
        and vat_registration_effective_date is null)
      or
      (vat_status = 'REGISTERED'
        and vat_number ~ '^GB[0-9]{9}([0-9]{3})?$'
        and vat_registration_effective_date is not null)
    );
  end if;
end $$;

-- Operator-decision backfill: every store existing at migration time is the
-- live NOT_REGISTERED business the closure brief rules on. Idempotent (the
-- second run finds no NULLs). Stores created later start unconfirmed.
update stores set vat_config_confirmed_at = now()
  where vat_config_confirmed_at is null;

-- ----------------------------------------------------------------------------
-- WS6d.3  site_settings — remove the fallback source entirely
-- ----------------------------------------------------------------------------
-- vat_rate_percent was the single global number every 20% fallback coalesced
-- to; vat_number was a display duplicate of what is now store-level truth.
-- Both go. (schema.sql/seed.sql are fresh-only historical files; the chain
-- transforms their output to this end state, exactly like
-- migration_launch_data_neutralise does for seed data.)
alter table site_settings drop constraint if exists site_settings_vat_rate_bounds;
alter table site_settings drop column if exists vat_rate_percent;
alter table site_settings drop column if exists vat_number;

-- ----------------------------------------------------------------------------
-- WS6d.4  orders — per-order VAT snapshot; no silent defaults
-- ----------------------------------------------------------------------------
alter table orders add column if not exists store_vat_status text;
alter table orders add column if not exists vat_effective_date date;
alter table orders alter column tax_rate drop default;
alter table orders alter column tax_rate drop not null;

comment on column orders.tax_rate is
  'Headline applied rate SNAPSHOT: 0 under NOT_REGISTERED; the uniform per-line rate when REGISTERED lines share one rate; NULL for a mixed-rate order (the per-line snapshots on order_items are the authority). Never defaulted.';
comment on column orders.store_vat_status is
  'Immutable snapshot of the store''s VAT status at the moment of sale. NULL only on rows that predate the VAT lifecycle.';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_store_vat_status_controlled') then
    alter table orders add constraint orders_store_vat_status_controlled check (
      store_vat_status is null or store_vat_status in ('NOT_REGISTERED','REGISTERED')
    );
  end if;
  -- The launch seal: a NOT_REGISTERED sale is 0 / 0 — no writer, including a
  -- privileged one, can record charged VAT against a NOT_REGISTERED snapshot.
  -- coalesce() closes the NULL-passes-CHECK loophole.
  if not exists (select 1 from pg_constraint where conname = 'orders_vat_snapshot_coherent') then
    alter table orders add constraint orders_vat_snapshot_coherent check (
      store_vat_status is distinct from 'NOT_REGISTERED'
      or (coalesce(tax_rate, -1) = 0 and tax_amount = 0)
    );
  end if;
  -- A REGISTERED sale must carry the registration's effective date…
  if not exists (select 1 from pg_constraint where conname = 'orders_vat_registered_has_effective') then
    alter table orders add constraint orders_vat_registered_has_effective check (
      store_vat_status is distinct from 'REGISTERED'
      or vat_effective_date is not null
    );
  end if;
  -- …and only a REGISTERED sale may carry one.
  if not exists (select 1 from pg_constraint where conname = 'orders_vat_effective_scope') then
    alter table orders add constraint orders_vat_effective_scope check (
      vat_effective_date is null or store_vat_status = 'REGISTERED'
    );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- WS6d.5  order_items — per-line VAT snapshot
-- ----------------------------------------------------------------------------
alter table order_items add column if not exists tax_code text;
alter table order_items add column if not exists tax_rate numeric(5,2);
alter table order_items add column if not exists taxable_amount numeric(10,2);
alter table order_items add column if not exists tax_amount numeric(10,2);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_tax_code_fkey') then
    alter table order_items add constraint order_items_tax_code_fkey
      foreign key (tax_code) references tax_codes(code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_items_tax_rate_bounds') then
    alter table order_items add constraint order_items_tax_rate_bounds check (
      tax_rate is null or (tax_rate >= 0 and tax_rate <= 100)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_items_tax_nonneg') then
    alter table order_items add constraint order_items_tax_nonneg check (
      (taxable_amount is null or taxable_amount >= 0)
      and (tax_amount is null or tax_amount >= 0)
    );
  end if;
  -- VAT-inclusive: the contained tax can never exceed what it is contained in.
  if not exists (select 1 from pg_constraint where conname = 'order_items_tax_le_taxable') then
    alter table order_items add constraint order_items_tax_le_taxable check (
      tax_amount is null or taxable_amount is null or tax_amount <= taxable_amount
    );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- WS6d.6  menu_items — controlled classification (explicit, never defaulted)
-- ----------------------------------------------------------------------------
alter table menu_items add column if not exists tax_code text;
comment on column menu_items.tax_code is
  'Controlled VAT classification (tax_codes). NULL = not yet classified. Classification is an explicit owner act; REGISTERED trading refuses unclassified products; NOT_REGISTERED trading records rate 0 regardless.';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'menu_items_tax_code_fkey') then
    alter table menu_items add constraint menu_items_tax_code_fkey
      foreign key (tax_code) references tax_codes(code);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- WS6d.7  explode_order_items() — project the line tax snapshots
-- ----------------------------------------------------------------------------
-- Same contract as FIX-2b (SECURITY DEFINER projection of the RLS-approved
-- parent row; never callable directly), extended with the four tax fields.
-- No coalesce-to-a-number for tax values: an absent field projects as NULL,
-- never as a silently invented figure.
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

alter function explode_order_items() security definer;
alter function explode_order_items() set search_path = public;
revoke all on function explode_order_items() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- WS6d.8  submit_web_order() — re-issue (closure brief §1)
-- ----------------------------------------------------------------------------
-- Changes from the FIX-12 issue, and ONLY these:
--   • TRADING GATE: the sale must belong to a store whose VAT configuration
--     is confirmed (vat_config_confirmed_at). A staff profile without a home
--     store, or a store left unconfirmed, cannot trade — no default rate is
--     ever selected (raise 'store_vat_unconfigured').
--   • NOT_REGISTERED: every line snapshots {product tax_code, rate 0, its
--     taxable share, tax 0}; the order snapshots store_vat_status and 0 / 0.
--   • REGISTERED: every line requires an explicit product classification
--     (raise 'product_tax_unclassified'), takes its rate from tax_codes,
--     receives a deterministic share of the order discount (cumulative
--     largest-exact allocation summing exactly to the discount), and derives
--     its contained VAT by the single rounding step
--     round(taxable_pence × rate / (100 + rate)). Order tax = Σ line taxes;
--     order tax_rate = the uniform line rate, or NULL when rates are mixed.
--   • The 20% fallback chain (":= 20", coalesce(vat_rate_percent, 20)) is
--     GONE and its source column no longer exists.
-- Everything else — envelope validation, idempotency-first replay, catalogue
-- repricing, the deal engine, payment facts, the per-store advisory lock and
-- the conflict path — is byte-for-byte the FIX-12 logic.
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
-- ACCEPTANCE (proven live by matrix §16):
--   • The 4-code registry exists, is read-only to clients, and carries the
--     statutory reference rates; a fifth code is impossible.
--   • REGISTERED without a valid GB number + effective date is impossible;
--     NOT_REGISTERED with either is impossible.
--   • A sale for an unconfirmed store (or a staff profile with no store)
--     raises store_vat_unconfigured — trading blocked, nothing defaulted.
--   • A NOT_REGISTERED sale records tax_rate 0 / tax_amount 0 at order AND
--     line level even for a STANDARD_RATE-classified product, and snapshots
--     store_vat_status.
--   • Direct writes cannot fake charged VAT onto a NOT_REGISTERED snapshot
--     (orders_vat_snapshot_coherent).
--   • Flipping the store to REGISTERED alters no prior order; a REGISTERED
--     sale of an unclassified product raises product_tax_unclassified; a
--     mixed-rate REGISTERED sale carries NULL order tax_rate with exact
--     line-level shares and order tax = Σ line taxes.
--   • site_settings.vat_rate_percent and orders.tax_rate's DEFAULT 20 no
--     longer exist anywhere in the effective schema.
-- ============================================================================
