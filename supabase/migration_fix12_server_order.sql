-- ============================================================================
--  MILK POP — MIGRATION FIX-12: SERVER-PRICED WEB ORDERS
--  Closes forensic-audit POS-002.
--
--  PROBLEM: the web till POSTed a COMPLETE order row (prices, line totals,
--  discounts, VAT, total, staff name, order number) straight into orders.
--  RLS checked store scope but nothing recalculated the money — any staff
--  session could write manipulated revenue, and explode_order_items copied
--  the client's numbers into the reporting tables.
--
--  FIX: submit_web_order(p_order) is now the only write path (the direct
--  orders_insert_staff policy is dropped). The client sends only FACTS it
--  legitimately owns: the idempotency id, product ids + size + quantity +
--  chosen extras, deal ids it believes apply, channel, payment method, cash
--  tendered and customer name. The server:
--    • loads every price from menu_items (large size honoured, extras priced
--      as the 'extras' catalogue rows they reference),
--    • recomputes line totals, subtotal, deal discounts (same semantics as
--      the client engine: best single deal, units sorted dearest-first,
--      extras excluded from the deal base), VAT (inclusive) and change —
--      all in integer pence,
--    • stamps staff id/name and store from the CALLER's profile, placed_at
--      from now(), and allocates order_number under a per-store advisory
--      lock,
--    • inserts atomically; a replayed id returns the already-stored order
--      (the durable outbox's at-least-once delivery stays exactly-once).
--  Client dealIds are treated as CLAIMS: a claimed deal that computes to a
--  zero/absent discount server-side is simply not applied.
--
--  Deploy order: after migration_rls_per_role.sql and
--  migration_fix2_explode_definer.sql.
-- ============================================================================

-- The RPC is the only web-order write path now. One deliberate carve-out
-- remains: the OWNER (aal2-verified via is_owner) may still insert rows
-- directly — that is the Legacy Import tool's path for migrating historical
-- sales, and an owner who can run SQL-equivalent imports gains nothing by
-- forging till rows. Every till/staff session must go through the RPC.
drop policy if exists orders_insert_staff on orders;
drop policy if exists orders_insert_owner_import on orders;
create policy orders_insert_owner_import on orders
  for insert to authenticated
  with check (is_owner());

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
  v_id        text := p_order ->> 'id';
  v_channel   text := coalesce(p_order ->> 'channel', 'walk_in');
  v_payment   text := coalesce(p_order ->> 'paymentMethod', 'card');
  v_customer  text := nullif(trim(coalesce(p_order ->> 'customerName', '')), '');
  v_items_in  jsonb := p_order -> 'items';
  v_deal_ids  jsonb := coalesce(p_order -> 'dealIds', '[]'::jsonb);
  v_cash_p    bigint;
  v_vat_rate  numeric := 20;
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
  v_tax_p     bigint;
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

  select coalesce(vat_rate_percent, 20) into v_vat_rate
    from site_settings limit 1;
  if v_vat_rate is null then v_vat_rate := 20; end if;

  -- 4. Price every line from the catalogue (integer pence).
  for i in 0 .. jsonb_array_length(v_items_in) - 1 loop
    it := v_items_in -> i;
    select * into m from menu_items where id = it ->> 'menuItemId';
    if m.id is null then
      raise exception 'unknown_menu_item';
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
    v_items  := v_items || jsonb_build_array(jsonb_build_object(
      'id', 'li_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
      'menuItemId', m.id, 'name', m.name, 'category', m.category,
      'size', v_size, 'unitPrice', v_unit_p / 100.0, 'quantity', v_qty,
      'modifiers', v_mods, 'lineTotal', v_line_p / 100.0,
      'notes', nullif(trim(coalesce(it ->> 'notes', '')), '')));
  end loop;

  -- 5. Deals — recomputed HERE with the client engine's semantics: units are
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

  -- 6. Totals — VAT-inclusive UK pricing; payment facts validated.
  v_total_p := greatest(v_sub_p - v_disc_tot, 0);
  v_tax_p   := round(v_total_p * v_vat_rate / (100 + v_vat_rate));

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

  -- 7. Order number: per-store, race-safe via an advisory lock scoped to this
  --    transaction.
  perform pg_advisory_xact_lock(hashtext('milkpop_order_no_' || coalesce(v_store_id, 'hq')));
  select coalesce(max(order_number), 0) + 1 into v_order_no
    from orders where coalesce(store_id, 'hq') = coalesce(v_store_id, 'hq');

  insert into orders
    (id, order_number, store_id, store_name, channel, items, applied_deals,
     subtotal, discount_total, tax_rate, tax_amount, total,
     payment_method, cash_received, change_given, status,
     customer_name, staff_id, staff_name, placed_at, completed_at)
  values
    (v_id, v_order_no, v_store_id, coalesce(v_store_nm, ''),
     v_channel::order_channel, v_items, v_deals,
     v_sub_p / 100.0, v_disc_tot / 100.0, v_vat_rate, v_tax_p / 100.0, v_total_p / 100.0,
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
-- ACCEPTANCE:
--   • Direct INSERT into orders as any browser session → denied (policy gone).
--   • A payload carrying crafted unitPrice/total/staff/store fields → those
--     fields never influence the stored row (they are not even read).
--   • Unknown product / extra id → unknown_menu_item / unknown_extra.
--   • Cash below the recomputed total → insufficient_cash.
--   • Replaying the same order id (outbox drain, double-tap) → the SAME
--     stored row back, duplicate: true, no second row, no re-explode.
--   • Two tills submitting concurrently → distinct sequential order numbers.
-- ----------------------------------------------------------------------------
