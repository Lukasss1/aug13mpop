-- ============================================================================
-- STAGE 3 / WS5 + WS7 — FINANCIAL INVARIANTS & BUSINESS UNIQUENESS (web side)
-- ============================================================================
-- The POS tables shipped with pence-integer checks and device-scoped order
-- numbering from day one (see migration_pos_sync.sql). The WEB-side financial
-- tables — orders, order_items, order_item_modifiers, payslips — relied on
-- the server-repricing RPC alone. This migration makes the DATABASE the last
-- line of defence, exactly as Stage-2.1.2 did for salary reads:
--
--   WS5  declarative money invariants (non-negativity, discount ≤ subtotal,
--        cash/change arithmetic, card orders carry NO cash values, completed
--        orders carry completion timestamps, refunds carry reasons,
--        payslip net = gross − deductions);
--   WS7  business uniqueness (per-store order numbers, one payslip per
--        employee+period, ONE active clock-in per employee, one OPEN till
--        shift per device).
--
-- Design notes:
--   • Plain ADD CONSTRAINT (no NOT VALID): a development database holding
--     violating rows must FAIL LOUDLY here — the brief forbids silently
--     accepting or repairing bad financial history. Production launches from
--     an empty baseline, so nothing valid can be rejected there.
--   • The cash model matches submit_web_order(): cash fields are NULL for
--     non-cash orders and exact to 2dp for cash. (`online`/`gift_card`
--     channels are non-cash for this purpose.)
--   • Order-number scope is (coalesce(store_id,'hq'), order_number) — the
--     IDENTICAL expression submit_web_order() locks on, now formalised.
--   • The active-clock-in index uses `clock_out is null`, valid for today's
--     text column and unchanged by the WS2 temporal migration.
--   • pos_shifts uniqueness is per DEVICE (one open trading shift per till),
--     deliberately not per store: a second till at the same store must not be
--     blocked by schema. Documented in STAGE3-RELATIONSHIP-MATRIX.
--   • Deferred to the WS8 lifecycle round (documented, not forgotten):
--     void metadata columns on web orders (voided_at / voided_by / reason),
--     training-assignment retake uniqueness, approval self-review rules.
-- Idempotent; fails closed. Appended via MP_FUTURE_MIGRATIONS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- WS5.1  orders — money invariants
-- ----------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_money_nonneg') then
    alter table orders add constraint orders_money_nonneg check (
      subtotal >= 0 and discount_total >= 0 and tax_amount >= 0
      and tax_rate >= 0 and total >= 0
      and (cash_received is null or cash_received >= 0)
      and (change_given  is null or change_given  >= 0)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_discount_le_subtotal') then
    alter table orders add constraint orders_discount_le_subtotal check (
      discount_total <= subtotal
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_cash_arithmetic') then
    alter table orders add constraint orders_cash_arithmetic check (
      case when payment_method = 'cash' then
        cash_received is not null and change_given is not null
        and cash_received >= total
        and round(change_given, 2) = round(cash_received - total, 2)
      else
        cash_received is null and change_given is null
      end
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_total_equation') then
    -- VAT-inclusive UK pricing: total = subtotal − discount, tax INSIDE total
    -- (identical to submit_web_order()'s pence arithmetic).
    alter table orders add constraint orders_total_equation check (
      round(total, 2) = round(subtotal - discount_total, 2)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_tax_le_total') then
    alter table orders add constraint orders_tax_le_total check (
      tax_amount <= total
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_completed_has_timestamp') then
    alter table orders add constraint orders_completed_has_timestamp check (
      status <> 'completed' or completed_at is not null
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_refund_has_reason') then
    alter table orders add constraint orders_refund_has_reason check (
      status <> 'refunded' or (refund_reason is not null and refund_reason <> '')
    );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- WS5.2  order lines & modifiers — snapshot money is non-negative
--        (quantity > 0 has existed since the schema baseline)
-- ----------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_money_nonneg') then
    alter table order_items add constraint order_items_money_nonneg check (
      unit_price >= 0 and line_total >= 0
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_item_modifiers_price_nonneg') then
    alter table order_item_modifiers add constraint order_item_modifiers_price_nonneg check (
      price >= 0
    );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- WS5.3  payslips (earnings estimates) — arithmetic honesty
-- ----------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payslips_money_nonneg') then
    alter table payslips add constraint payslips_money_nonneg check (
      gross >= 0 and net >= 0 and deductions >= 0
      and hourly_rate >= 0 and hours_total >= 0
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payslips_net_equation') then
    alter table payslips add constraint payslips_net_equation check (
      deductions <= gross and round(net, 2) = round(gross - deductions, 2)
    );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- WS5.4  clock_history — duration sanity (full lifecycle rules land in WS8;
--        these two are pure money/number honesty for downstream pay maths)
-- ----------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'clock_history_numbers_nonneg') then
    alter table clock_history add constraint clock_history_numbers_nonneg check (
      (break_duration_minutes is null or break_duration_minutes >= 0)
      and (total_decimal_hours is null or total_decimal_hours >= 0)
    );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- WS7.1  per-store order numbers cannot collide.
--        Scope expression = submit_web_order()'s advisory-lock scope.
-- ----------------------------------------------------------------------------
create unique index if not exists ux_orders_store_order_number
  on orders ((coalesce(store_id, 'hq')), order_number);

-- ----------------------------------------------------------------------------
-- WS7.2  one payslip per employee and pay period.
--        The publish path upserts by id (fix7 targeted changes), so period
--        regeneration UPDATES in place; a second row for the same period is
--        exactly the duplicate this must reject.
-- ----------------------------------------------------------------------------
create unique index if not exists ux_payslips_employee_period
  on payslips (employee_id, period_key)
  where employee_id is not null;

-- ----------------------------------------------------------------------------
-- WS7.3  ONE active clock-in per employee.
-- ----------------------------------------------------------------------------
create unique index if not exists ux_clock_history_one_active
  on clock_history (employee_id)
  where clock_out is null and employee_id is not null;

-- ----------------------------------------------------------------------------
-- WS7.4  one OPEN trading shift per till device.
-- ----------------------------------------------------------------------------
create unique index if not exists ux_pos_shifts_one_open_per_device
  on pos_shifts (device_id)
  where status = 'open';
