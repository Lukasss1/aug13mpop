-- ============================================================================
-- STAGE 3 / WS7 — QUOTE → PAYMENT → FINALISATION (clean-room financial core)
-- ============================================================================
-- INPUT ARCHIVE : MilkPop-web-full-Stage3-Round9h-OnlineConfirmedSelling.zip
-- INPUT SHA-256 : 6c8a336fdc4db123225d672557b5d4237a478288d1883b2406d4a9170881d2b4
--
-- Reconstructed in a clean room from that archive alone. No file from any
-- surviving working tree was inherited.
--
-- WHY THIS EXISTS. Until now a sale was booked in ONE call: submit_web_order()
-- priced the basket and inserted a COMPLETED order with payment facts in the
-- same statement. The database therefore recorded a completed, paid-looking
-- sale BEFORE any money could have moved — a declined card or a customer who
-- walked away still left a completed order — and a queued attempt could be
-- replayed later as a sale for which nothing was ever collected.
--
-- The flow is now the standard financial one:
--
--     create_order_quote()      price the basket; create NO sale
--          ↓                    (immutable snapshot, short expiry)
--     begin_quote_payment()     reserve the quote; ordinary expiry suspended
--          ↓                    because money is about to move
--     [ cash counted / card approved ]
--          ↓
--     finalise_order_payment()  record the sale FROM THE SNAPSHOT, with
--                               payment evidence and a custody anchor
--
-- PRICING IS EXTRACTED, NOT REWRITTEN. price_basket_internal() carries the
-- WS6d–WS6f arithmetic verbatim — component-level VAT, cumulative
-- largest-exact discount allocation, one rounding step per component.
-- submit_web_order() is re-issued to call the SAME helper, so two independent
-- implementations of money cannot exist, and is then revoked from browser
-- roles so the one-step path is unreachable from any client.
--
-- FINALISATION NEVER REPRICES. It copies the stored snapshot. A quote priced
-- at 14:00 records 14:00 prices, 14:00 tax codes and 14:00 deals however late
-- it is finalised.
--
-- CASH HAS A CUSTODY ANCHOR. Cash may only be finalised against an OPEN
-- web-till session belonging to the quote's store and the registered device
-- that took the money. pos_shifts was inspected for reuse and rejected: its
-- device_id is a NOT NULL reference to the paired Android registry, its rows
-- are projections of the till's event chain (close_summary is the stored
-- Z-report, received_at is cloud receipt time), and it carries no way to keep
-- Android and web shifts distinguishable. The model here is the smallest
-- enforceable custody anchor and deliberately stores NO editable drawer
-- balance — expected cash is derived from immutable events in a later round.
--
-- LOCK ORDER. Every financial RPC takes row locks in ONE canonical order:
--
--     order_quotes  →  quote_payment_attempts  →  web_till_sessions  →  orders
--
-- Two individually safe functions that lock the same rows in opposite orders
-- can deadlock, so the order is stated here and followed by
-- begin_quote_payment, release_quote_payment, finalise_order_payment and
-- cancel_order_quote alike. close_till_session locks only the session and
-- READS attempts without locking them, so it cannot close a cycle.
--
-- Idempotent; fails closed; appended via MP_FUTURE_MIGRATIONS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- WS7.1  Cash custody: registered web tills and their sessions
-- ----------------------------------------------------------------------------
create table if not exists web_till_devices (
  id             text primary key,
  store_id       text not null references stores(id),
  label          text not null,
  registered_by  text,
  registered_at  timestamptz not null default now(),
  revoked        boolean not null default false
);

create table if not exists web_till_sessions (
  id                  text primary key,
  store_id            text not null references stores(id),
  device_id           text not null references web_till_devices(id),
  status              text not null default 'OPEN',
  opened_by_staff_id  text not null,
  opened_at           timestamptz not null default now(),
  opening_float       numeric(10,2) not null default 0,
  closed_by_staff_id  text,
  closed_at           timestamptz
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'wts_status_controlled') then
    alter table web_till_sessions add constraint wts_status_controlled
      check (status in ('OPEN','CLOSED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wts_float_nonneg') then
    alter table web_till_sessions add constraint wts_float_nonneg
      check (opening_float >= 0);
  end if;
  -- A closed session must record who closed it and when; an open one must not.
  if not exists (select 1 from pg_constraint where conname = 'wts_close_coherent') then
    alter table web_till_sessions add constraint wts_close_coherent check (
      (status = 'OPEN'   and closed_at is null     and closed_by_staff_id is null)
      or (status = 'CLOSED' and closed_at is not null and closed_by_staff_id is not null)
    );
  end if;
end $$;

-- One open drawer per registered till: custody is exclusive.
create unique index if not exists wts_one_open_per_device
  on web_till_sessions (device_id) where status = 'OPEN';

comment on table web_till_sessions is
  'Cash custody anchor for the browser till. No drawer balance is stored: expected cash is derived from immutable financial events.';

-- ----------------------------------------------------------------------------
-- WS7.1b  payment_terminals — the namespace is SERVER-KNOWN, not client-claimed
-- ----------------------------------------------------------------------------
-- Uniqueness scoped to (provider, merchant, terminal) is only meaningful if
-- the client cannot choose those values. A till that could name its own
-- merchant id would defeat the constraint simply by claiming a different
-- terminal. They are therefore registered here and DERIVED at finalisation:
-- the client names a registered terminal, or none at all, and never supplies
-- the namespace itself.
create table if not exists payment_terminals (
  id           text primary key,
  store_id     text not null references stores(id),
  provider     text not null,
  merchant_id  text not null,
  terminal_id  text not null,
  status       text not null default 'ACTIVE',
  created_at   timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payment_terminals_status_controlled') then
    alter table payment_terminals add constraint payment_terminals_status_controlled
      check (status in ('ACTIVE','RETIRED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_terminals_identity_present') then
    alter table payment_terminals add constraint payment_terminals_identity_present
      check (length(btrim(provider)) > 0 and length(btrim(merchant_id)) > 0
             and length(btrim(terminal_id)) > 0);
  end if;
end $$;

create unique index if not exists payment_terminals_namespace_unique
  on payment_terminals (provider, merchant_id, terminal_id);

comment on table payment_terminals is
  'Registered card terminals. finalise_order_payment DERIVES the provider namespace from this table; the client never supplies provider, merchant or terminal identifiers.';

-- ----------------------------------------------------------------------------
-- WS7.2  order_quotes — the immutable priced snapshot and its lifecycle
-- ----------------------------------------------------------------------------
create table if not exists order_quotes (
  id                      text primary key,
  store_id                text not null references stores(id),
  staff_id                text,
  channel                 order_channel not null,
  status                  text not null default 'OPEN',
  items                   jsonb not null,
  applied_deals           jsonb not null default '[]'::jsonb,
  subtotal                numeric(10,2) not null,
  discount_total          numeric(10,2) not null,
  tax_rate                numeric(5,2),
  tax_amount              numeric(10,2) not null,
  total                   numeric(10,2) not null,
  store_vat_status        text not null,
  vat_effective_date      date,
  allowed_payment_methods jsonb not null,
  config_version          text not null,
  expires_at              timestamptz not null,
  payment_started_at      timestamptz,
  reservation_id          text,
  reservation_hash        text,
  released_at             timestamptz,
  release_reason          text,
  payment_hash            text,
  consumed_at             timestamptz,
  order_id                text,
  cancelled_at            timestamptz,
  created_at              timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'oq_status_controlled') then
    alter table order_quotes add constraint oq_status_controlled check (
      status in ('OPEN','PAYMENT_PENDING','CONSUMED','EXPIRED','CANCELLED')
    );
  end if;
  -- A consumed quote is exactly the one that produced a sale.
  if not exists (select 1 from pg_constraint where conname = 'oq_consumed_coherent') then
    alter table order_quotes add constraint oq_consumed_coherent check (
      (status = 'CONSUMED' and consumed_at is not null and order_id is not null and payment_hash is not null)
      or (status <> 'CONSUMED' and consumed_at is null and order_id is null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'oq_money_nonneg') then
    alter table order_quotes add constraint oq_money_nonneg check (
      subtotal >= 0 and discount_total >= 0 and tax_amount >= 0 and total >= 0
      and tax_amount <= total
    );
  end if;
end $$;

comment on table order_quotes is
  'An immutable priced snapshot. Finalisation copies from it and never reprices; the financial columns cannot be rewritten after creation.';

-- The financial snapshot is frozen at creation. Only the lifecycle columns may
-- move, and only forward — this is what makes "finalisation cannot reprice" a
-- property of the DATABASE rather than of one function's good behaviour.
create or replace function enforce_quote_snapshot_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.items is distinct from old.items
     or new.applied_deals is distinct from old.applied_deals
     or new.subtotal is distinct from old.subtotal
     or new.discount_total is distinct from old.discount_total
     or new.tax_rate is distinct from old.tax_rate
     or new.tax_amount is distinct from old.tax_amount
     or new.total is distinct from old.total
     or new.store_id is distinct from old.store_id
     or new.channel is distinct from old.channel
     or new.store_vat_status is distinct from old.store_vat_status
     or new.vat_effective_date is distinct from old.vat_effective_date
     or new.allowed_payment_methods is distinct from old.allowed_payment_methods
     or new.created_at is distinct from old.created_at
  then
    raise exception 'quote_snapshot_immutable' using errcode = '42501',
      detail = 'A quote''s priced snapshot is frozen at creation.';
  end if;
  -- A reservation, once recorded, is immutable for that attempt: a second
  -- device cannot silently take over an active reservation by rewriting it.
  if old.reservation_id is not null and old.status = 'PAYMENT_PENDING'
     and new.reservation_id is distinct from old.reservation_id
     and new.status = 'PAYMENT_PENDING' then
    raise exception 'quote_snapshot_immutable' using errcode = '42501',
      detail = 'An active reservation cannot be replaced in place.';
  end if;
  if old.status = 'CONSUMED' and new.status is distinct from 'CONSUMED' then
    raise exception 'quote_snapshot_immutable' using errcode = '42501',
      detail = 'A consumed quote is final.';
  end if;
  return new;
end $$;

drop trigger if exists trg_quote_snapshot_immutable on order_quotes;
create trigger trg_quote_snapshot_immutable
  before update on order_quotes
  for each row execute function enforce_quote_snapshot_immutable();

-- ----------------------------------------------------------------------------
-- WS7.2b  quote_payment_attempts — one permanent row per payment attempt
-- ----------------------------------------------------------------------------
-- A quote row can only describe its CURRENT attempt. A basket declined twice
-- and then paid in cash is three separate interactions with real money, and
-- all three are history. Attempts are therefore their own records.
--
-- NOT "append-only": the row IS updated, exactly once, when the attempt
-- resolves. The accurate description is ONE IMMUTABLE-IDENTITY ROW PER
-- ATTEMPT, with a one-way state transition and an immutable terminal
-- outcome. The reservation id is the PRIMARY KEY, so an identity can never be
-- recycled, and a resolved attempt can never change again.
create table if not exists quote_payment_attempts (
  reservation_id    text primary key,
  quote_id          text not null references order_quotes(id),
  store_id          text not null,
  payment_method    text,
  device_id         text,
  cash_session_id   text,
  operator_staff_id text not null,
  request_hash      text not null,
  state             text not null default 'PENDING',
  started_at        timestamptz not null default now(),
  released_at       timestamptz,
  release_outcome   text,
  payment_provider   text,
  provider_merchant_id text,
  provider_terminal_id text,
  provider_reference text,
  completed_order_id text,
  created_at        timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'qpa_state_controlled') then
    alter table quote_payment_attempts add constraint qpa_state_controlled check (
      state in ('PENDING','DECLINED','ABANDONED','CONSUMED')
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'qpa_release_coherent') then
    alter table quote_payment_attempts add constraint qpa_release_coherent check (
      (state in ('DECLINED','ABANDONED') and released_at is not null and release_outcome is not null)
      or (state not in ('DECLINED','ABANDONED') and released_at is null and release_outcome is null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'qpa_consumed_coherent') then
    alter table quote_payment_attempts add constraint qpa_consumed_coherent check (
      (state = 'CONSUMED' and completed_order_id is not null)
      or (state <> 'CONSUMED' and completed_order_id is null)
    );
  end if;
end $$;

-- At most ONE unresolved attempt per quote: a second attempt cannot begin
-- while the outcome of the first is still unknown.
create unique index if not exists qpa_one_pending_per_quote
  on quote_payment_attempts (quote_id) where state = 'PENDING';

comment on table quote_payment_attempts is
  'One immutable-identity row per payment attempt: PENDING resolves once to DECLINED, ABANDONED or CONSUMED and can never change again. Reservation ids are never recycled. The quote points at its active attempt; it is not the history.';

-- An attempt is a historical fact: its identity and payment facts are frozen,
-- and its state moves one way, once.
create or replace function enforce_attempt_identity_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.reservation_id is distinct from old.reservation_id
     or new.quote_id is distinct from old.quote_id
     or new.request_hash is distinct from old.request_hash
     or new.operator_staff_id is distinct from old.operator_staff_id
     or new.payment_method is distinct from old.payment_method
     or new.device_id is distinct from old.device_id
     or new.cash_session_id is distinct from old.cash_session_id
     or new.started_at is distinct from old.started_at then
    raise exception 'attempt_is_immutable' using errcode = '42501',
      detail = 'A payment attempt records what happened; its identity and facts cannot be rewritten.';
  end if;
  if old.state <> 'PENDING' and new.state is distinct from old.state then
    raise exception 'attempt_already_resolved' using errcode = '42501',
      detail = 'A resolved payment attempt is final.';
  end if;
  return new;
end $$;

drop trigger if exists trg_attempt_identity_immutable on quote_payment_attempts;
create trigger trg_attempt_identity_immutable
  before update on quote_payment_attempts
  for each row execute function enforce_attempt_identity_immutable();

-- ----------------------------------------------------------------------------
-- WS7.3  orders — the quote it came from, and the payment that paid for it
-- ----------------------------------------------------------------------------
alter table orders add column if not exists quote_id text;
alter table orders add column if not exists till_session_id text;
alter table orders add column if not exists payment_status text;
alter table orders add column if not exists payment_reference text;
alter table orders add column if not exists payment_captured_at timestamptz;
alter table orders add column if not exists cash_change numeric(10,2);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_quote_fkey') then
    -- RESTRICT: a consumed quote is the evidence behind a completed order and
    -- cannot be deleted out from under it.
    alter table orders add constraint orders_quote_fkey
      foreign key (quote_id) references order_quotes(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_till_session_fkey') then
    alter table orders add constraint orders_till_session_fkey
      foreign key (till_session_id) references web_till_sessions(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_payment_status_controlled') then
    alter table orders add constraint orders_payment_status_controlled check (
      payment_status is null or payment_status = 'captured'
    );
  end if;
end $$;

-- ONE QUOTE MAY CREATE AT MOST ONE COMPLETED ORDER. Enforced by the database,
-- not by the retry logic that happens to run above it. orders.id is a NEW
-- identity generated at finalisation: a quote is a proposed transaction and an
-- order is a completed one, so they must not share an identifier. quote_id is
-- the unique link and the anchor a retry resolves against, which also keeps
-- quote expiry and cleanup away from order identifiers entirely.
create unique index if not exists orders_one_per_quote
  on orders (quote_id) where quote_id is not null;

-- A provider reference proves money moved, but it is only unique WITHIN the
-- namespace that issued it. device_id here is the WEB TILL installation — the
-- browser — which does NOT own that namespace, so it is the wrong boundary.
-- The owning namespace is the payment provider, the merchant account and the
-- physical terminal, all stored explicitly so the constraint can explain
-- itself rather than relying on an overloaded generic column. Values are
-- trimmed before they are stored or compared.
create unique index if not exists qpa_provider_reference_namespace
  on quote_payment_attempts (payment_provider, provider_merchant_id,
                             provider_terminal_id, provider_reference)
  where provider_reference is not null;

-- ----------------------------------------------------------------------------
-- WS7.4  price_basket_internal() — THE authoritative pricing implementation
-- ----------------------------------------------------------------------------
-- The body below is the WS6d–WS6f arithmetic lifted verbatim out of
-- submit_web_order(): component-level VAT, cumulative largest-exact discount
-- allocation across lines and then across each line's components, a single
-- rounding step per component, NULL line/headline rates where rates mix.
-- Both callers use this function, so the quote a customer is charged and the
-- order eventually recorded cannot be priced by different code.
create or replace function price_basket_internal(
  p_store    stores,
  p_items    jsonb,
  p_deals    jsonb,
  p_charging boolean
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_items_in jsonb := p_items;
  v_deal_ids jsonb := coalesce(p_deals, '[]'::jsonb);
  v_charging boolean := p_charging;
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
  g           int;
  i           int;
  j           int;
begin
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

  return jsonb_build_object(
    'items',          v_items,
    'deals',          v_deals,
    'subtotalP',      v_sub_p,
    'discountTotalP', v_disc_tot,
    'taxAmountP',     v_tax_sum_p,
    'totalP',         v_total_p,
    'uniform',        v_uniform,
    'headRate',       v_head_rate
  );
end $$;

revoke all on function price_basket_internal(stores, jsonb, jsonb, boolean) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- WS7.5  create_order_quote() — price the basket; create NO sale
-- ----------------------------------------------------------------------------
create or replace function create_order_quote(p_quote jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff      text := current_staff_id();
  v_me         staff_profiles%rowtype;
  v_store_id   text;
  v_store      stores%rowtype;
  v_id         text := p_quote ->> 'id';
  v_channel    text := coalesce(p_quote ->> 'channel', 'walk_in');
  v_items_in   jsonb := p_quote -> 'items';
  v_deal_ids   jsonb := coalesce(p_quote -> 'dealIds', '[]'::jsonb);
  v_charging   boolean;
  v_status_reg boolean;
  v_today      date;
  v_priced     jsonb;
  v_row        order_quotes%rowtype;
  v_ttl        interval := interval '20 minutes';
begin
  if v_staff is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  select * into v_me from staff_profiles where id = v_staff;
  -- A disabled employee has NO staff identity: current_staff_id() already
  -- excludes them (migration_stage9), so a separate status = 'disabled'
  -- branch here could never fire. Dead security branches read like controls
  -- and produce misleading evidence, so the identity gate is the control.
  if v_me.id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if v_id is null or length(v_id) < 6 then
    raise exception 'invalid_quote_id';
  end if;
  if v_items_in is null or jsonb_typeof(v_items_in) <> 'array'
     or jsonb_array_length(v_items_in) = 0 then
    raise exception 'empty_basket';
  end if;
  if v_channel not in ('walk_in','phone','website','deliveroo','uber_eats','just_eat') then
    raise exception 'invalid_channel';
  end if;

  v_store_id := v_me.store_id;
  if v_store_id is null then
    raise exception 'store_vat_unconfigured'
      using detail = 'The caller has no home store; sales must belong to a VAT-configured store.';
  end if;
  select * into v_store from stores where id = v_store_id;
  if v_store.id is null or v_store.vat_config_confirmed_at is null then
    raise exception 'store_vat_unconfigured';
  end if;
  if v_store.setup_status is distinct from 'ACTIVE' then
    raise exception 'store_setup_incomplete';
  end if;

  v_status_reg := (v_store.vat_status = 'REGISTERED');
  v_today      := (now() at time zone v_store.timezone)::date;
  v_charging   := v_status_reg
                  and v_store.vat_registration_effective_date <= v_today;

  -- An existing quote id is returned as-is: quoting is idempotent, and a
  -- retried quote must never become a second basket.
  select * into v_row from order_quotes where id = v_id;
  if v_row.id is not null then
    if v_row.store_id is distinct from v_store_id then
      raise exception 'quote_id_conflict' using errcode = '42501';
    end if;
    return jsonb_build_object('quote', to_jsonb(v_row), 'duplicate', true);
  end if;

  v_priced := price_basket_internal(v_store, v_items_in, v_deal_ids, v_charging);

  insert into order_quotes
    (id, store_id, staff_id, channel, status, items, applied_deals,
     subtotal, discount_total, tax_rate, tax_amount, total,
     store_vat_status, vat_effective_date, allowed_payment_methods,
     config_version, expires_at)
  values
    (v_id, v_store_id, v_staff, v_channel::order_channel, 'OPEN',
     v_priced -> 'items', v_priced -> 'deals',
     (v_priced ->> 'subtotalP')::bigint / 100.0,
     (v_priced ->> 'discountTotalP')::bigint / 100.0,
     case when (v_priced ->> 'uniform')::boolean
          then nullif(v_priced ->> 'headRate','')::numeric else null end,
     (v_priced ->> 'taxAmountP')::bigint / 100.0,
     (v_priced ->> 'totalP')::bigint / 100.0,
     v_store.vat_status,
     case when v_status_reg then v_store.vat_registration_effective_date else null end,
     v_store.payment_methods,
     md5(coalesce(v_store.setup_status,'') || '|' || coalesce(v_store.vat_status,'') || '|'
      || coalesce(v_store.vat_registration_effective_date::text,'') || '|'
      || coalesce(v_store.payment_methods::text,'') || '|'
      || coalesce((select string_agg(id || '=' || coalesce(tax_code,'∅') || '=' || price::text, ',' order by id)
                     from menu_items), '')),
     now() + v_ttl)
  returning * into v_row;

  return jsonb_build_object('quote', to_jsonb(v_row), 'duplicate', false);
end $$;

revoke all on function create_order_quote(jsonb) from public, anon;
grant execute on function create_order_quote(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS7.6  begin_quote_payment() — reserve the quote BEFORE money moves
-- ----------------------------------------------------------------------------
-- This is what makes the paid-but-finalisation-lost case recoverable. Once a
-- quote is PAYMENT_PENDING the ordinary expiry no longer applies, because the
-- customer may already have handed over money; the quote is instead resolved
-- inside a bounded recovery window.
create or replace function begin_quote_payment(p_payment jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff   text := current_staff_id();
  v_me      staff_profiles%rowtype;
  v_quote_id text := p_payment ->> 'quoteId';
  v_res_id  text := p_payment ->> 'reservationId';
  v_method  text := p_payment ->> 'method';
  v_device  text := p_payment ->> 'deviceId';
  v_session text := p_payment ->> 'cashSessionId';
  v_hash    text;
  v_q       order_quotes%rowtype;
  v_o       orders%rowtype;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if v_res_id is null or length(v_res_id) < 6 then
    raise exception 'invalid_reservation';
  end if;

  select * into v_q from order_quotes where id = v_quote_id for update;
  if v_q.id is null then raise exception 'unknown_quote'; end if;
  if v_q.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;

  -- The CANONICAL reservation identity. The operator is derived server-side,
  -- never accepted from the payload.
  v_hash := md5(v_quote_id || '|' || v_res_id || '|' || coalesce(v_method,'') || '|'
             || coalesce(v_device,'') || '|' || coalesce(v_session,'') || '|' || v_staff);

  -- A reservation identity is global and permanent: it can never be recycled,
  -- and a released attempt can never be reopened.
  if exists (select 1 from quote_payment_attempts a where a.reservation_id = v_res_id) then
    declare v_a quote_payment_attempts%rowtype;
    begin
      select * into v_a from quote_payment_attempts where reservation_id = v_res_id;
      if v_a.quote_id is distinct from v_q.id then
        raise exception 'idempotency_conflict' using errcode = '42501',
          detail = 'That reservation identity belongs to another quote.';
      end if;
      if v_a.request_hash is distinct from v_hash then
        raise exception 'idempotency_conflict' using errcode = '42501',
          detail = 'The same reservation was replayed with different payment facts.';
      end if;
      if v_a.state in ('DECLINED','ABANDONED') then
        raise exception 'reservation_released' using errcode = '42501',
          detail = 'That attempt was released; a new attempt needs a new reservation id.';
      end if;
      if v_a.state = 'CONSUMED' then
        select * into v_o from orders where quote_id = v_q.id;
        return jsonb_build_object('quote', to_jsonb(v_q), 'order', to_jsonb(v_o),
                                  'state', 'already_consumed');
      end if;
      return jsonb_build_object('quote', to_jsonb(v_q), 'state', 'reserved', 'duplicate', true);
    end;
  end if;

  if v_q.status = 'CONSUMED' then
    select * into v_o from orders where quote_id = v_q.id;
    return jsonb_build_object('quote', to_jsonb(v_q), 'order', to_jsonb(v_o),
                              'state', 'already_consumed');
  end if;
  if v_q.status in ('EXPIRED','CANCELLED') then
    raise exception 'quote_not_open';
  end if;

  if v_q.status = 'PAYMENT_PENDING' then
    if v_q.reservation_id is distinct from v_res_id then
      -- A second tab or device must not take over a payment that may already
      -- be in progress on the first.
      raise exception 'payment_already_pending' using errcode = '42501',
        detail = 'This quote already has an active payment reservation.';
    end if;
    if v_q.reservation_hash is distinct from v_hash then
      raise exception 'idempotency_conflict' using errcode = '42501',
        detail = 'The same reservation was replayed with different payment facts.';
    end if;
    return jsonb_build_object('quote', to_jsonb(v_q), 'state', 'reserved', 'duplicate', true);
  end if;

  if now() > v_q.expires_at then
    update order_quotes set status = 'EXPIRED' where id = v_q.id;
    raise exception 'quote_expired'
      using detail = 'Re-price the basket before taking payment.';
  end if;

  -- A previous decline stays on the record: released_at / release_reason are
  -- deliberately NOT cleared when a new attempt begins.
  insert into quote_payment_attempts
    (reservation_id, quote_id, store_id, payment_method, device_id,
     cash_session_id, operator_staff_id, request_hash, state)
  values (v_res_id, v_q.id, v_q.store_id, v_method, v_device,
          v_session, v_staff, v_hash, 'PENDING');

  update order_quotes
     set status = 'PAYMENT_PENDING', payment_started_at = now(),
         reservation_id = v_res_id, reservation_hash = v_hash
   where id = v_q.id
  returning * into v_q;

  return jsonb_build_object('quote', to_jsonb(v_q), 'state', 'reserved', 'duplicate', false);
end $$;

-- ----------------------------------------------------------------------------
-- WS7.6b  release_quote_payment() — a DEFINITE decline frees the basket
-- ----------------------------------------------------------------------------
-- PAYMENT_PENDING exists because a payment outcome may be unresolved, so the
-- client may not casually reset it. A release requires the SAME reservation
-- identity and states an outcome, and it is refused once the quote has been
-- consumed. An ambiguous terminal result must NOT be released — it stays
-- pending and is resolved through finalisation.
create or replace function release_quote_payment(p_release jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff   text := current_staff_id();
  v_me      staff_profiles%rowtype;
  v_q       order_quotes%rowtype;
  v_res_id  text := p_release ->> 'reservationId';
  v_outcome text := p_release ->> 'outcome';
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if v_outcome not in ('declined','abandoned') then
    raise exception 'invalid_release_outcome'
      using detail = 'Only a DEFINITE decline or an abandonment before money moved may release a reservation.';
  end if;

  select * into v_q from order_quotes where id = p_release ->> 'quoteId' for update;
  if v_q.id is null then raise exception 'unknown_quote'; end if;
  if v_q.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;
  if v_q.status = 'CONSUMED' then
    raise exception 'quote_already_consumed'
      using detail = 'This sale was completed; a completed payment cannot be released.';
  end if;
  if v_q.status <> 'PAYMENT_PENDING' then
    raise exception 'quote_not_reserved';
  end if;
  if v_q.reservation_id is distinct from v_res_id then
    raise exception 'idempotency_conflict' using errcode = '42501',
      detail = 'A reservation may only be released by the attempt that created it.';
  end if;

  -- The attempt is resolved permanently; the quote merely stops pointing at it.
  update quote_payment_attempts
     set state = case when v_outcome = 'declined' then 'DECLINED' else 'ABANDONED' end,
         released_at = now(), release_outcome = v_outcome
   where reservation_id = v_res_id and state = 'PENDING';
  if not found then
    raise exception 'attempt_already_resolved' using errcode = '42501';
  end if;

  update order_quotes
     set status = case when now() > expires_at then 'EXPIRED' else 'OPEN' end,
         reservation_id = null, reservation_hash = null,
         payment_started_at = null,
         released_at = now(), release_reason = v_outcome
   where id = v_q.id
  returning * into v_q;

  return jsonb_build_object('quote', to_jsonb(v_q), 'state', v_q.status);
end $$;

revoke all on function release_quote_payment(jsonb) from public, anon;
grant execute on function release_quote_payment(jsonb) to authenticated;

revoke all on function begin_quote_payment(jsonb) from public, anon;
grant execute on function begin_quote_payment(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS7.7  finalise_order_payment() — record the sale AFTER the money moved
-- ----------------------------------------------------------------------------
create or replace function finalise_order_payment(p_payment jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff     text := current_staff_id();
  v_me        staff_profiles%rowtype;
  v_quote_id  text := p_payment ->> 'quoteId';
  v_method    text := p_payment ->> 'method';
  v_ref       text := nullif(trim(coalesce(p_payment ->> 'providerReference','')), '');
  v_term_cfg  text := nullif(trim(coalesce(p_payment ->> 'terminalConfigId','')), '');
  v_term      payment_terminals%rowtype;
  v_provider  text;
  v_merchant  text;
  v_terminal  text;
  v_session   text := p_payment ->> 'tillSessionId';
  v_device    text := p_payment ->> 'deviceId';
  v_cash_p    bigint;
  v_change_p  bigint;
  v_approved_p bigint;
  v_paid_at   timestamptz;
  v_customer  text := nullif(trim(coalesce(p_payment ->> 'customerName','')), '');
  v_q         order_quotes%rowtype;
  v_s         web_till_sessions%rowtype;
  v_total_p   bigint;
  v_hash      text;
  v_order_no  bigint;
  v_order_id  text := 'ord_' || replace(gen_random_uuid()::text, '-', '');
  v_res_in    text := p_payment ->> 'reservationId';
  v_att       quote_payment_attempts%rowtype;
  v_row       orders%rowtype;
  v_recovery  interval := interval '24 hours';
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  -- A disabled employee has NO staff identity: current_staff_id() already
  -- excludes them (migration_stage9), so a separate status = 'disabled'
  -- branch here could never fire. Dead security branches read like controls
  -- and produce misleading evidence, so the identity gate is the control.
  if v_me.id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;

  select * into v_q from order_quotes where id = v_quote_id for update;
  if v_q.id is null then raise exception 'unknown_quote'; end if;
  if v_q.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;

  v_total_p  := round(v_q.total * 100)::bigint;
  v_paid_at  := coalesce(nullif(p_payment ->> 'paidAt','')::timestamptz, now());
  v_cash_p   := round(coalesce(nullif(p_payment ->> 'cashReceived','')::numeric, 0) * 100)::bigint;
  v_approved_p := round(coalesce(nullif(p_payment ->> 'approvedAmount','')::numeric, 0) * 100)::bigint;

  -- The CANONICAL finalisation identity: the same basket paid the same way is
  -- one transaction however many times a lost response is replayed. Anything
  -- materially different about the money is a DIFFERENT claim about reality.
  v_hash := md5(v_quote_id || '|' || coalesce(v_method,'') || '|' || v_cash_p::text || '|'
             || coalesce(v_ref,'') || '|' || coalesce(v_session,'') || '|'
             || coalesce(v_device,'') || '|' || v_approved_p::text);

  -- Identity first: a released attempt can never finalise, whatever the quote
  -- has since gone on to do.
  if v_res_in is not null then
    select * into v_att from quote_payment_attempts where reservation_id = v_res_in;
    if v_att.reservation_id is not null and v_att.state in ('DECLINED','ABANDONED') then
      raise exception 'reservation_released' using errcode = '42501',
        detail = 'That attempt was released; it cannot be finalised.';
    end if;
  end if;

  if v_q.status = 'CONSUMED' then
    if v_q.payment_hash = v_hash then
      -- The retry anchor is the QUOTE, not the order id: the order carries its
      -- own identity and is found through the unique quote link.
      select * into v_row from orders where quote_id = v_q.id;
      return jsonb_build_object('order', to_jsonb(v_row), 'duplicate', true);
    end if;
    raise exception 'idempotency_conflict' using errcode = '42501',
      detail = 'This quote was already finalised with different payment facts.';
  end if;

  -- Payment must have been RESERVED first: that is the step which proves the
  -- till was about to take money, and which suspends ordinary expiry.
  if v_q.status <> 'PAYMENT_PENDING' then
    raise exception 'quote_not_reserved'
      using detail = 'Reserve the quote with begin_quote_payment() before taking payment.';
  end if;
  -- Finalisation must name and consume ONE exact attempt: the quote's active
  -- one. A delayed request for a superseded attempt can never consume a quote.
  if v_res_in is null then
    raise exception 'invalid_reservation'
      using detail = 'Finalisation must present the reservation that took the payment.';
  end if;
  select * into v_att from quote_payment_attempts
   where reservation_id = v_res_in for update;
  if v_att.reservation_id is null or v_att.quote_id is distinct from v_q.id then
    raise exception 'idempotency_conflict' using errcode = '42501',
      detail = 'That reservation does not belong to this quote.';
  end if;
  if v_att.state in ('DECLINED','ABANDONED') then
    raise exception 'reservation_released' using errcode = '42501',
      detail = 'That attempt was released; it cannot be finalised.';
  end if;
  if v_q.reservation_id is distinct from v_res_in then
    raise exception 'idempotency_conflict' using errcode = '42501',
      detail = 'A superseded attempt cannot finalise this quote.';
  end if;
  if now() > v_q.payment_started_at + v_recovery then
    raise exception 'quote_expired'
      using detail = 'The payment recovery window has passed; resolve this sale manually.';
  end if;

  if v_method is null or not (v_q.allowed_payment_methods ? v_method) then
    raise exception 'payment_method_not_accepted';
  end if;

  if v_method = 'cash' then
    -- CASH CUSTODY. Cash is only truthful when it is bound to an accountable
    -- drawer: which till, which session, which operator.
    if v_session is null or v_device is null then
      raise exception 'till_session_required'
        using detail = 'Cash may only be taken against an open till session.';
    end if;
    select * into v_s from web_till_sessions where id = v_session for update;
    if v_s.id is null or v_s.status <> 'OPEN' then
      raise exception 'till_session_not_open';
    end if;
    if v_s.store_id is distinct from v_q.store_id then
      raise exception 'till_session_store_mismatch' using errcode = '42501';
    end if;
    if v_s.device_id is distinct from v_device then
      raise exception 'till_session_device_mismatch' using errcode = '42501';
    end if;
    if v_cash_p < v_total_p then
      raise exception 'insufficient_cash';
    end if;
    v_change_p := v_cash_p - v_total_p;
    if p_payment ? 'change'
       and round(coalesce(nullif(p_payment ->> 'change','')::numeric, -1) * 100)::bigint
           is distinct from v_change_p then
      raise exception 'change_mismatch'
        using detail = 'Change must equal cash received minus the quoted total.';
    end if;
  else
    -- CARD / ONLINE. A database row saying "refunded" or "paid" is not proof
    -- that money moved: the provider's reference is.
    if v_ref is null then
      raise exception 'payment_reference_required'
        using detail = 'A card or online payment must carry its provider reference.';
    end if;
    -- The namespace is RESOLVED from the registry, never accepted from the
    -- payload: anything the client claimed about provider, merchant or
    -- terminal is ignored outright.
    if v_term_cfg is not null then
      select * into v_term from payment_terminals where id = v_term_cfg;
      if v_term.id is null then
        raise exception 'unknown_terminal';
      end if;
    else
      -- No terminal named: resolve the store's single active terminal. If the
      -- store has none, or more than one, the till must say which.
      select * into v_term from payment_terminals
       where store_id = v_q.store_id and status = 'ACTIVE'
       limit 2;
      if v_term.id is null then
        raise exception 'unknown_terminal'
          using detail = 'No registered card terminal for this store.';
      end if;
      if (select count(*) from payment_terminals
           where store_id = v_q.store_id and status = 'ACTIVE') > 1 then
        raise exception 'terminal_ambiguous'
          using detail = 'This store has several terminals; the till must name the one that took the payment.';
      end if;
    end if;
    if v_term.status <> 'ACTIVE' then
      raise exception 'terminal_not_active';
    end if;
    if v_term.store_id is distinct from v_q.store_id then
      raise exception 'terminal_store_mismatch' using errcode = '42501',
        detail = 'That terminal belongs to another store.';
    end if;
    v_provider := btrim(v_term.provider);
    v_merchant := btrim(v_term.merchant_id);
    v_terminal := btrim(v_term.terminal_id);
    if v_approved_p is distinct from v_total_p then
      raise exception 'approved_amount_mismatch'
        using detail = 'The approved amount must equal the quoted total.';
    end if;
    v_cash_p := null;
    v_change_p := null;
  end if;

  perform pg_advisory_xact_lock(hashtext('milkpop_order_no_' || coalesce(v_q.store_id, 'hq')));
  select coalesce(max(order_number), 0) + 1 into v_order_no
    from orders where coalesce(store_id, 'hq') = coalesce(v_q.store_id, 'hq');

  -- The sale is written FROM THE SNAPSHOT. Nothing is re-derived from the
  -- current catalogue, so the record matches the money that was collected.
  insert into orders
    (id, order_number, store_id, store_name, channel, items, applied_deals,
     subtotal, discount_total, tax_rate, tax_amount, total,
     store_vat_status, vat_effective_date,
     payment_method, cash_received, change_given, status,
     customer_name, staff_id, staff_name, placed_at, completed_at,
     quote_id, till_session_id, payment_status, payment_reference,
     payment_captured_at, cash_change)
  values
    (v_order_id, v_order_no, v_q.store_id,
     coalesce((select name from stores where id = v_q.store_id), ''),
     v_q.channel, v_q.items, v_q.applied_deals,
     v_q.subtotal, v_q.discount_total, v_q.tax_rate, v_q.tax_amount, v_q.total,
     v_q.store_vat_status, v_q.vat_effective_date,
     v_method::payment_method,
     case when v_cash_p is null then null else v_cash_p / 100.0 end,
     case when v_change_p is null then null else v_change_p / 100.0 end,
     'completed', v_customer, v_staff, coalesce(v_me.name, ''),
     v_q.created_at,                       -- placed: when the basket was priced
     v_paid_at,                            -- completed: when the money moved
     v_q.id, case when v_method = 'cash' then v_session else null end,
     'captured', v_ref, v_paid_at,
     case when v_change_p is null then null else v_change_p / 100.0 end)
  returning * into v_row;

  update quote_payment_attempts
     set state = 'CONSUMED', completed_order_id = v_row.id,
         provider_reference = v_ref, payment_provider = v_provider,
         provider_merchant_id = v_merchant, provider_terminal_id = v_terminal
   where reservation_id = v_res_in;

  update order_quotes
     set status = 'CONSUMED', consumed_at = now(),
         order_id = v_row.id, payment_hash = v_hash
   where id = v_q.id;

  return jsonb_build_object('order', to_jsonb(v_row), 'duplicate', false);
end $$;

revoke all on function finalise_order_payment(jsonb) from public, anon;
grant execute on function finalise_order_payment(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS7.8  cancel_order_quote() — an abandoned basket is not a sale
-- ----------------------------------------------------------------------------
create or replace function cancel_order_quote(p_quote jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff text := current_staff_id();
  v_me    staff_profiles%rowtype;
  v_q     order_quotes%rowtype;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  select * into v_q from order_quotes where id = p_quote ->> 'quoteId' for update;
  if v_q.id is null then raise exception 'unknown_quote'; end if;
  if v_q.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;
  if v_q.status = 'CONSUMED' then raise exception 'quote_already_consumed'; end if;
  update order_quotes set status = 'CANCELLED', cancelled_at = now()
   where id = v_q.id returning * into v_q;
  return jsonb_build_object('quote', to_jsonb(v_q));
end $$;

revoke all on function cancel_order_quote(jsonb) from public, anon;
grant execute on function cancel_order_quote(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS7.9  Till session lifecycle (custody open/close)
-- ----------------------------------------------------------------------------
create or replace function open_till_session(p_session jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff  text := current_staff_id();
  v_me     staff_profiles%rowtype;
  v_id     text := p_session ->> 'id';
  v_device text := p_session ->> 'deviceId';
  v_label  text := coalesce(nullif(trim(coalesce(p_session ->> 'deviceLabel','')), ''), 'Web till');
  v_float  numeric := coalesce(nullif(p_session ->> 'openingFloat','')::numeric, 0);
  v_row    web_till_sessions%rowtype;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  -- A disabled employee has NO staff identity: current_staff_id() already
  -- excludes them (migration_stage9), so a separate status = 'disabled'
  -- branch here could never fire. Dead security branches read like controls
  -- and produce misleading evidence, so the identity gate is the control.
  if v_me.id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if v_me.store_id is null then raise exception 'store_scope_denied' using errcode = '42501'; end if;
  if v_id is null or v_device is null then raise exception 'invalid_session'; end if;
  if v_float < 0 then raise exception 'invalid_opening_float'; end if;

  -- A till registers itself on first use, bound to the operator's own store.
  insert into web_till_devices (id, store_id, label, registered_by)
  values (v_device, v_me.store_id, v_label, v_staff)
  on conflict (id) do nothing;

  if (select store_id from web_till_devices where id = v_device) is distinct from v_me.store_id then
    raise exception 'till_session_store_mismatch' using errcode = '42501';
  end if;
  if (select revoked from web_till_devices where id = v_device) then
    raise exception 'till_device_revoked' using errcode = '42501';
  end if;

  select * into v_row from web_till_sessions
   where device_id = v_device and status = 'OPEN';
  if v_row.id is not null then
    return jsonb_build_object('session', to_jsonb(v_row), 'duplicate', true);
  end if;

  insert into web_till_sessions
    (id, store_id, device_id, status, opened_by_staff_id, opening_float)
  values (v_id, v_me.store_id, v_device, 'OPEN', v_staff, v_float)
  returning * into v_row;
  return jsonb_build_object('session', to_jsonb(v_row), 'duplicate', false);
end $$;

create or replace function close_till_session(p_session jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff text := current_staff_id();
  v_me    staff_profiles%rowtype;
  v_row   web_till_sessions%rowtype;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  select * into v_row from web_till_sessions where id = p_session ->> 'id' for update;
  if v_row.id is null then raise exception 'unknown_session'; end if;
  if v_row.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;
  if v_row.status = 'CLOSED' then
    return jsonb_build_object('session', to_jsonb(v_row), 'duplicate', true);
  end if;
  -- A drawer must not close while a cash payment's outcome is unknown: the
  -- cashier may already hold the customer's money.
  if exists (select 1 from quote_payment_attempts a
              where a.cash_session_id = v_row.id and a.state = 'PENDING') then
    raise exception 'session_has_unresolved_payments' using errcode = '42501',
      detail = 'Resolve the outstanding cash payment before closing this drawer.';
  end if;
  update web_till_sessions
     set status = 'CLOSED', closed_by_staff_id = v_staff, closed_at = now()
   where id = v_row.id returning * into v_row;
  return jsonb_build_object('session', to_jsonb(v_row), 'duplicate', false);
end $$;

revoke all on function open_till_session(jsonb) from public, anon;
revoke all on function close_till_session(jsonb) from public, anon;
grant execute on function open_till_session(jsonb) to authenticated;
grant execute on function close_till_session(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS7.10  RLS + grants — quotes and sessions are RPC-written, never direct
-- ----------------------------------------------------------------------------
alter table payment_terminals enable row level security;
alter table quote_payment_attempts enable row level security;
alter table order_quotes      enable row level security;
alter table web_till_sessions enable row level security;
alter table web_till_devices  enable row level security;

revoke all on table payment_terminals from anon, authenticated;
revoke all on table quote_payment_attempts from anon, authenticated;
revoke all on table order_quotes      from anon, authenticated;
revoke all on table web_till_sessions from anon, authenticated;
revoke all on table web_till_devices  from anon, authenticated;
grant select on table payment_terminals to authenticated;
grant select on table quote_payment_attempts to authenticated;
grant select on table order_quotes      to authenticated;
grant select on table web_till_sessions to authenticated;
grant select on table web_till_devices  to authenticated;

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'payment_terminals_select_store') then
    create policy payment_terminals_select_store on payment_terminals for select to authenticated
      using (is_owner() or store_id = current_staff_store());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'quote_payment_attempts_select_store') then
    create policy quote_payment_attempts_select_store on quote_payment_attempts for select to authenticated
      using (is_owner() or store_id = current_staff_store());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'order_quotes_select_store') then
    create policy order_quotes_select_store on order_quotes for select to authenticated
      using (is_owner() or store_id = current_staff_store());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'web_till_sessions_select_store') then
    create policy web_till_sessions_select_store on web_till_sessions for select to authenticated
      using (is_owner() or store_id = current_staff_store());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'web_till_devices_select_store') then
    create policy web_till_devices_select_store on web_till_devices for select to authenticated
      using (is_owner() or store_id = current_staff_store());
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- WS7.11  The one-step completed-sale writer is REMOVED
-- ----------------------------------------------------------------------------
-- submit_web_order() booked a completed, paid-looking sale in a single call
-- before any money could have moved. Revoking it from browser roles was
-- necessary but not sufficient: while it existed it remained a path to a
-- completed order that carried no payment evidence, no idempotency key and no
-- cash custody. It is dropped outright. EVERY completed order now originates
-- through finalise_order_payment(), which cannot run without a consumed quote
-- and proven payment. A future payment-provider callback or historical import
-- must be a visibly distinct channel with equivalent safeguards.
drop function if exists submit_web_order(jsonb);

-- The deployment verifier (launch/verify-current-baseline.sql) asserted that
-- submit_web_order existed, because for every prior round it was the
-- server-authoritative sale path. WS7 replaces it, so that assertion is
-- updated in the same round: adoption of an existing production database must
-- verify the CURRENT contract, not a superseded one.

-- ----------------------------------------------------------------------------
-- ACCEPTANCE (proven live by matrix §§21-23):
--   • A quote prices exactly as the Round-9h implementation did (§22 parity)
--     and creates NO order.
--   • Every trading gate fires at quote time; a disabled operator is refused
--     at quote, reservation, finalisation and cash-session opening alike.
--   • A reservation carries its own identity: replaying it returns the
--     original, changing its payment facts raises idempotency_conflict, and a
--     second device raises payment_already_pending.
--   • A definite decline releases the reservation back to OPEN; a consumed
--     quote can never be released.
--   • No order exists until finalisation presents payment evidence, and the
--     order carries its OWN identity linked to the quote by a unique key.
--   • Finalising twice with the same facts returns the same order; different
--     facts conflict; one quote can never become two orders.
--   • Cash requires an OPEN session for the quote's store and registered
--     device, exact server-computed change, and sufficient cash.
--   • Card requires a provider reference and an approved amount equal to the
--     quoted total.
--   • A reserved quote survives ordinary expiry inside the recovery window.
--   • placed_at is the quote's time and completed_at the payment's.
--   • The quote snapshot cannot be rewritten, so finalisation cannot reprice.
--   • submit_web_order() no longer exists in any schema.
-- ============================================================================
