-- ============================================================================
-- STAGE 3 / WS7c — R3 PAYMENT-AUTHORITY CORRECTIONS (append-only)
-- ============================================================================
-- INPUT ARCHIVE : MilkPop-web-full-Stage3-Round9h-OnlineConfirmedSelling.zip
-- INPUT SHA-256 : 6c8a336fdc4db123225d672557b5d4237a478288d1883b2406d4a9170881d2b4
--
-- Append-only corrections to the WS7b payment-authority contract. This file
-- closes the R2-audit findings WITHOUT changing any working WS7/WS7b behaviour:
-- it only CREATE OR REPLACEs corrected functions and ALTERs constraints,
-- triggers and columns. It introduces NO new payment workflow and NO provider
-- integration.
--
-- This migration is applied AFTER migration_stage3_ws7b_payment_authority.sql;
-- the objects it replaces already exist. Idempotent; fails closed.
--
-- Slice R3.1 (this section of the file) covers the reconciliation-honesty and
-- ledger-immutability findings:
--
--   * HONEST STATUS NAMING (audit finding 2). PROVIDER_RECONCILED overstated
--     manager-entered evidence as independent provider settlement. It is renamed
--     MANUAL_EVIDENCE_MATCHED. PROVIDER_RECONCILED is RESERVED for a future
--     integration that receives independently authenticated evidence via a
--     provider API, webhook or imported settlement file — none is built here.
--
--   * EVIDENCE BEFORE STATUS (audit finding 3). An order may reach
--     MANUAL_EVIDENCE_MATCHED only when its immutable payment_reconciliations
--     row already exists in the SAME transaction. No direct status update can
--     mark an order reconciled; the state is transactionally dependent on the
--     evidence row.
--
--   * MANUAL-EVIDENCE CONTRACT. reconcile_card_payment() now requires
--     manager/owner + AAL2 + a written reason + a typed evidence kind + an
--     external evidence reference + matched amount and currency + a
--     payment-event timestamp + an idempotency key + a canonical SHA-256
--     request hash, and writes an immutable reconciliation row and a server
--     audit entry.
--
--   * COMPLETED-ORDER LINE IMMUTABILITY. order_items and order_item_modifiers
--     are frozen against UPDATE/DELETE for every role, matching the header.
--     (Round 10A will extend allowed transitions in its own append-only file.)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- R3.1a  Honest status vocabulary: PROVIDER_RECONCILED -> MANUAL_EVIDENCE_MATCHED
-- ----------------------------------------------------------------------------
-- In a clean-room build there are no order rows, so this touches no data. If a
-- PERSISTENT database ever carried R2/WS7b's PROVIDER_RECONCILED state, those
-- rows are converted to the honest name here (under a scoped trigger relaxation)
-- BEFORE the new constraint is added, so the upgrade never fails on old data.
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'orders_payment_status_controlled') then
    alter table orders drop constraint orders_payment_status_controlled;
  end if;
  if exists (select 1 from orders where payment_status = 'PROVIDER_RECONCILED') then
    alter table orders disable trigger trg_order_ledger_immutable;
    update orders set payment_status = 'MANUAL_EVIDENCE_MATCHED'
     where payment_status = 'PROVIDER_RECONCILED';
    alter table orders enable trigger trg_order_ledger_immutable;
  end if;
  alter table orders add constraint orders_payment_status_controlled check (
    payment_status is null or payment_status in
      ('CASH_RECORDED','OPERATOR_RECORDED_UNRECONCILED','MANUAL_EVIDENCE_MATCHED')
  );
end $$;

-- ----------------------------------------------------------------------------
-- R3.1b  Immutable ledger: the reconciled move now REQUIRES an evidence row
-- ----------------------------------------------------------------------------
create or replace function enforce_order_ledger_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Nothing but payment_status may ever change on a completed order.
  if (to_jsonb(new) - 'payment_status') is distinct from (to_jsonb(old) - 'payment_status') then
    raise exception 'order_ledger_immutable' using errcode = '42501',
      detail = 'A completed order is a financial record; it cannot be edited.';
  end if;
  if new.payment_status is distinct from old.payment_status then
    -- The only permitted transition, and only towards honest evidence.
    if not (old.payment_status = 'OPERATOR_RECORDED_UNRECONCILED'
            and new.payment_status = 'MANUAL_EVIDENCE_MATCHED') then
      raise exception 'order_ledger_immutable' using errcode = '42501',
        detail = 'payment_status may only move OPERATOR_RECORDED_UNRECONCILED -> MANUAL_EVIDENCE_MATCHED, via reconcile_card_payment().';
    end if;
    -- EVIDENCE BEFORE STATUS: a COMPLETE, matching immutable reconciliation
    -- record must already exist (inserted earlier in this same transaction by
    -- the RPC). "A row exists" is not enough, and neither are non-null columns:
    -- the row must carry a real written reason, an external evidence reference,
    -- GBP, an amount equal to THIS order's total, a usable idempotency key and a
    -- plausible payment-event time, and must belong to a CONSUMED payment
    -- attempt of THIS order. A privileged path that inserts a thin row and flips
    -- the status is refused here. ('legacy_unspecified' is deliberately absent:
    -- a pre-R3 row can never authorise a NEW reconciliation.)
    if not exists (
      select 1 from payment_reconciliations pr
       where pr.order_id = new.id
         and pr.attempt_reservation_id is not null
         and pr.evidence_type in ('terminal_receipt','z_report','merchant_portal','settlement_statement')
         and pr.reason is not null and length(trim(pr.reason)) >= 10
         and pr.settlement_reference is not null
         and length(trim(pr.settlement_reference)) > 0
         and upper(pr.matched_currency) = 'GBP'
         and round(pr.settled_amount * 100)::bigint = round(new.total * 100)::bigint
         and pr.idempotency_key is not null and length(pr.idempotency_key) >= 8
         and pr.payment_event_at is not null
         and pr.payment_event_at <= now() + interval '1 hour'
         and pr.payment_event_at >= new.created_at - interval '2 days'
         and exists (
           select 1 from quote_payment_attempts a
            where a.reservation_id     = pr.attempt_reservation_id
              and a.completed_order_id = new.id
              and a.state              = 'CONSUMED')
    ) then
      raise exception 'reconciliation_evidence_required' using errcode = '42501',
        detail = 'An order may only be marked MANUAL_EVIDENCE_MATCHED when a complete, matching reconciliation record for its consumed attempt exists.';
    end if;
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- R3.1c  Extend the immutable evidence record with the manual-evidence contract
-- ----------------------------------------------------------------------------
alter table payment_reconciliations add column if not exists evidence_type    text;
alter table payment_reconciliations add column if not exists matched_currency text;
alter table payment_reconciliations add column if not exists idempotency_key  text;
alter table payment_reconciliations add column if not exists payment_event_at timestamptz;

-- The evidence-kind vocabulary. 'legacy_unspecified' exists ONLY to label rows
-- written under the pre-R3 contract, where the operator never chose an evidence
-- kind; it is never accepted from a caller (reconcile_card_payment rejects it).
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'preconc_evidence_type_controlled') then
    alter table payment_reconciliations drop constraint preconc_evidence_type_controlled;
  end if;
  alter table payment_reconciliations add constraint preconc_evidence_type_controlled check (
    evidence_type is null or evidence_type in
      ('terminal_receipt','z_report','merchant_portal','settlement_statement','legacy_unspecified')
  );
end $$;

-- UPGRADE SAFETY: a persistent WS7b/R2 database already holds reconciliation
-- rows whose new columns are NULL. They are backfilled from what the old
-- contract actually recorded — never invented — BEFORE the completeness
-- constraint is added, so the migration cannot fail on existing data. The
-- evidence row is append-only, so the backfill runs under a scoped relaxation of
-- its own immutability trigger. In a clean-room build this is a no-op.
do $$ begin
  if exists (
    select 1 from payment_reconciliations
     where evidence_type is null or matched_currency is null
        or idempotency_key is null or payment_event_at is null
  ) then
    alter table payment_reconciliations disable trigger trg_reconciliation_immutable;
    update payment_reconciliations
       set evidence_type = coalesce(
             evidence_type,
             case when settlement_source in
                    ('terminal_receipt','z_report','merchant_portal','settlement_statement')
                  then settlement_source
                  else 'legacy_unspecified' end),
           -- GBP is the only currency the platform has ever sold in.
           matched_currency = coalesce(matched_currency, 'GBP'),
           -- Row-unique, so the store-scoped idempotency index still holds.
           idempotency_key  = coalesce(idempotency_key, 'legacy_' || id),
           -- The old contract's settlement time IS the payment-event time.
           payment_event_at = coalesce(payment_event_at, settled_at)
     where evidence_type is null or matched_currency is null
        or idempotency_key is null or payment_event_at is null;
    alter table payment_reconciliations enable trigger trg_reconciliation_immutable;
  end if;
end $$;

-- Every manual-evidence row must be COMPLETE (defence in depth with the RPC and
-- the ledger trigger): an incomplete row cannot be inserted to later satisfy a
-- status flip. A future provider-authenticated path will define its own shape.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'preconc_manual_evidence_complete') then
    alter table payment_reconciliations add constraint preconc_manual_evidence_complete check (
      evidence_type is not null and matched_currency is not null
      and idempotency_key is not null and payment_event_at is not null
    );
  end if;
end $$;

-- Idempotency-key uniqueness (scoped to the store) so a lost response can be
-- safely replayed without a second evidence row.
create unique index if not exists payment_reconciliations_idem_unique
  on payment_reconciliations (store_id, idempotency_key) where idempotency_key is not null;

comment on table payment_reconciliations is
  'Append-only manager/owner-attested MANUAL_EVIDENCE_MATCHED record: a card/online payment matched against external evidence (terminal receipt, Z-report, merchant portal or settlement statement). Recording one is the only thing that may move an order to MANUAL_EVIDENCE_MATCHED. NOT independent provider settlement; PROVIDER_RECONCILED is reserved for a future authenticated integration.';

-- ----------------------------------------------------------------------------
-- R3.1d  reconcile_card_payment() v3 — the full manual-evidence contract
-- ----------------------------------------------------------------------------
create or replace function reconcile_card_payment(p_settlement jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff    text := current_staff_id();
  v_me       staff_profiles%rowtype;
  v_res_id   text := p_settlement ->> 'reservationId';
  v_order_in text := p_settlement ->> 'orderId';
  v_a        quote_payment_attempts%rowtype;
  v_o        orders%rowtype;
  v_etype    text := nullif(trim(coalesce(p_settlement ->> 'evidenceType','')), '');
  v_extref   text := nullif(trim(coalesce(p_settlement ->> 'externalReference','')), '');
  v_ccy      text := nullif(trim(coalesce(p_settlement ->> 'currency','')), '');
  v_amt_raw  text := nullif(p_settlement ->> 'matchedAmount','');
  v_evt_raw  text := nullif(p_settlement ->> 'paymentEventAt','');
  v_reason   text := nullif(trim(coalesce(p_settlement ->> 'reason','')), '');
  v_idem     text := nullif(trim(coalesce(p_settlement ->> 'idempotencyKey','')), '');
  v_amt_p    bigint;
  v_hash     text;
  v_existing payment_reconciliations%rowtype;
  v_row      payment_reconciliations%rowtype;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;
  -- manager/owner AND an MFA-verified session (explicit, per the R3 contract).
  if not is_manager_or_owner() or not is_aal2() then
    raise exception 'reconciliation_denied' using errcode = '42501',
      detail = 'Manual reconciliation requires a manager or owner with an MFA-verified session.';
  end if;

  -- Required manual-evidence fields.
  if v_reason is null or length(v_reason) < 10 then
    raise exception 'reason_required'
      using detail = 'A written reason (at least 10 characters) is required.';
  end if;
  if v_etype is null then
    raise exception 'evidence_type_required'
      using detail = 'An evidence type is required (terminal_receipt, z_report, merchant_portal or settlement_statement).';
  end if;
  if v_etype not in ('terminal_receipt','z_report','merchant_portal','settlement_statement') then
    raise exception 'invalid_evidence_type';
  end if;
  if v_extref is null then
    raise exception 'external_reference_required'
      using detail = 'An external evidence reference is required.';
  end if;
  if v_ccy is null then raise exception 'currency_required'; end if;
  if v_amt_raw is null or v_evt_raw is null then
    raise exception 'settlement_evidence_required'
      using detail = 'A matched amount and payment-event timestamp are required.';
  end if;
  if v_idem is null or length(v_idem) < 8 then
    raise exception 'idempotency_key_required'
      using detail = 'An idempotency key (at least 8 characters) is required.';
  end if;
  -- Currency bound (finding 4): MilkPop sells in GBP; a mismatched currency is
  -- not something manual reconciliation may assert away.
  if upper(v_ccy) <> 'GBP' then
    raise exception 'currency_not_supported' using errcode = '42501',
      detail = 'Manual reconciliation currency must be GBP.';
  end if;
  v_amt_p := round(v_amt_raw::numeric * 100)::bigint;

  -- Locate the consumed attempt (by reservation, or by completed order).
  if v_res_id is null and v_order_in is not null then
    select * into v_a from quote_payment_attempts
     where completed_order_id = v_order_in for update;
  else
    select * into v_a from quote_payment_attempts
     where reservation_id = v_res_id for update;
  end if;
  if v_a.reservation_id is null then
    raise exception 'invalid_reservation' using detail = 'No such consumed payment attempt.';
  end if;
  -- Identity coherence (finding 5): when BOTH ids are supplied they must resolve
  -- to the SAME payment, never a reservation of order A with the id of order B.
  if v_res_id is not null and v_order_in is not null
     and v_a.completed_order_id is distinct from v_order_in then
    raise exception 'payment_identity_mismatch' using errcode = '42501',
      detail = 'The reservation and order do not identify the same payment.';
  end if;
  if not is_owner() and v_a.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;
  if v_a.state <> 'CONSUMED' then
    raise exception 'attempt_not_consumed'
      using detail = 'Only a completed payment can be reconciled against evidence.';
  end if;
  if v_a.payment_method = 'cash' then
    raise exception 'cash_not_provider_reconciled'
      using detail = 'Cash is reconciled through drawer counts, not external card/online evidence.';
  end if;

  -- CANONICAL request hash, built only AFTER the payment identity is resolved.
  -- It names the RESOLVED reservation and order — never the supplied variant —
  -- so an equivalent retry sent by reservation, by order, or by both hashes
  -- identically and replays cleanly instead of conflicting. The payment-event
  -- time is normalised to epoch milliseconds so equivalent timestamp spellings
  -- (offsets, trailing zeros) are the same claim, and the written reason is part
  -- of the claim, so a changed reason is a DIFFERENT claim, not a silent replay.
  v_hash := canonical_request_hash(jsonb_build_object(
    'op', 'reconcile_card_payment',
    'reservationId', v_a.reservation_id,
    'orderId', v_a.completed_order_id,
    'evidenceType', v_etype, 'externalReference', v_extref, 'currency', upper(v_ccy),
    'matchedAmountP', v_amt_p,
    'paymentEventAtMs', (extract(epoch from v_evt_raw::timestamptz) * 1000)::bigint,
    'idempotencyKey', v_idem, 'reason', v_reason));

  -- Idempotent replay: same idempotency key.
  select * into v_existing from payment_reconciliations
   where store_id = v_a.store_id and idempotency_key = v_idem;
  if v_existing.id is not null then
    if v_existing.evidence_hash = v_hash then
      return jsonb_build_object('reconciliation', to_jsonb(v_existing), 'duplicate', true);
    end if;
    raise exception 'idempotency_conflict' using errcode = '42501',
      detail = 'That idempotency key was already used with different evidence.';
  end if;
  -- One evidence row per attempt (unchanged invariant).
  if exists (select 1 from payment_reconciliations where attempt_reservation_id = v_a.reservation_id) then
    raise exception 'already_reconciled' using errcode = '42501',
      detail = 'This payment already has a reconciliation record.';
  end if;

  select * into v_o from orders where id = v_a.completed_order_id for update;
  -- Payment-event time must be plausible (finding 4): not materially in the
  -- future, and not materially before the recorded sale.
  if v_evt_raw::timestamptz > now() + interval '1 hour' then
    raise exception 'payment_time_in_future' using errcode = '42501',
      detail = 'The payment-event time cannot be in the future.';
  end if;
  if v_evt_raw::timestamptz < v_o.created_at - interval '2 days' then
    raise exception 'payment_time_implausible' using errcode = '42501',
      detail = 'The payment-event time predates the recorded sale.';
  end if;
  -- Matched amount must equal the recorded order total; discrepancies are a
  -- Round-10A financial-actions concern, not something reconciliation invents.
  if v_amt_p is distinct from round(v_o.total * 100)::bigint then
    raise exception 'settlement_amount_mismatch'
      using detail = 'The matched amount must equal the recorded order total.';
  end if;

  -- Immutable evidence row FIRST (the ledger trigger requires it to exist).
  -- Concurrency-safe idempotency (finding 3): if a simultaneous call won the
  -- race, catch the unique violation and resolve it as a proper replay/conflict
  -- rather than surfacing a raw constraint error.
  begin
    insert into payment_reconciliations
      (id, attempt_reservation_id, order_id, store_id, provider, provider_reference,
       settlement_source, settled_amount, settled_at, settlement_reference,
       evidence_hash, reason, recorded_by_staff_id,
       evidence_type, matched_currency, idempotency_key, payment_event_at)
    values
      ('rec_' || replace(gen_random_uuid()::text, '-', ''),
       v_a.reservation_id, v_o.id, v_a.store_id, coalesce(v_a.payment_provider, 'manual'),
       v_a.provider_reference, v_etype, v_amt_p / 100.0, v_evt_raw::timestamptz, v_extref,
       v_hash, v_reason, v_staff,
       v_etype, upper(v_ccy), v_idem, v_evt_raw::timestamptz)
    returning * into v_row;
  exception when unique_violation then
    -- The winner has committed (our insert blocked on its lock, then failed), so
    -- its row is now visible. Same key + same hash is a no-op; different hash is
    -- a genuine conflict; otherwise the one-per-attempt guard fired.
    select * into v_existing from payment_reconciliations
     where store_id = v_a.store_id and idempotency_key = v_idem;
    if v_existing.id is not null then
      if v_existing.evidence_hash = v_hash then
        return jsonb_build_object('reconciliation', to_jsonb(v_existing), 'duplicate', true);
      end if;
      raise exception 'idempotency_conflict' using errcode = '42501',
        detail = 'That idempotency key was already used with different evidence.';
    end if;
    if exists (select 1 from payment_reconciliations where attempt_reservation_id = v_a.reservation_id) then
      raise exception 'already_reconciled' using errcode = '42501',
        detail = 'This payment already has a reconciliation record.';
    end if;
    raise;
  end;

  -- Now the status may move (trigger sees the row above).
  update orders set payment_status = 'MANUAL_EVIDENCE_MATCHED' where id = v_o.id;

  perform log_payment_authority_event('payment_reconciliation:manual_evidence_matched',
    jsonb_build_object('orderId', v_o.id, 'reservationId', v_a.reservation_id,
                       'evidenceType', v_etype, 'externalReference', v_extref,
                       'recordedBy', v_staff));

  return jsonb_build_object('reconciliation', to_jsonb(v_row),
                            'orderPaymentStatus', 'MANUAL_EVIDENCE_MATCHED',
                            'duplicate', false);
end $$;

revoke all on function reconcile_card_payment(jsonb) from public, anon;
grant execute on function reconcile_card_payment(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- R3.1e  Completed-order LINE immutability (order_items, order_item_modifiers)
-- ----------------------------------------------------------------------------
-- The header is already frozen; its lines must be too, against every role
-- including service paths. INSERT is untouched (finalisation writes lines once
-- from the snapshot); only later UPDATE/DELETE is refused.
create or replace function enforce_order_line_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'order_line_immutable' using errcode = '42501',
      detail = 'A completed order line is a financial record; it cannot be deleted.';
  end if;
  -- UPDATE: the priced snapshot is frozen. The ONLY permitted change is the
  -- SOFT catalog link being CLEARED when its menu item is deleted
  -- (order_items.menu_item_id / order_item_modifiers.menu_item_id are ON DELETE
  -- SET NULL). Everything financial — name, size, unit_price, quantity,
  -- line_total, price — is preserved, and the link may only be nulled, never
  -- repointed at a different item.
  if (to_jsonb(new) - 'menu_item_id') is distinct from (to_jsonb(old) - 'menu_item_id') then
    raise exception 'order_line_immutable' using errcode = '42501',
      detail = 'A completed order line is a financial record; its priced snapshot cannot be edited.';
  end if;
  if new.menu_item_id is distinct from old.menu_item_id and new.menu_item_id is not null then
    raise exception 'order_line_immutable' using errcode = '42501',
      detail = 'The catalog link on a completed order line may only be cleared, not repointed.';
  end if;
  return new;
end $$;

drop trigger if exists trg_order_items_immutable on order_items;
create trigger trg_order_items_immutable
  before update or delete on order_items
  for each row execute function enforce_order_line_immutable();

drop trigger if exists trg_order_item_modifiers_immutable on order_item_modifiers;
create trigger trg_order_item_modifiers_immutable
  before update or delete on order_item_modifiers
  for each row execute function enforce_order_line_immutable();

-- ============================================================================
-- Slice R3.2 — core cash/payment-path corrections (findings 1-4)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- R3.2a  begin_quote_payment() — cash-reservation device credential (finding 1)
--        + exact consumed-attempt replay (finding 2)
-- ----------------------------------------------------------------------------
-- Preserves every WS7b behaviour verbatim; adds exactly two guards:
--   * a cash reservation must now re-present the enrolled device pairing secret
--     (deviceSecret), not merely name an enrolled device + open session, so a
--     stolen non-secret session/device id cannot reserve cash from elsewhere;
--   * the quote-CONSUMED replay branch must be handed the EXACT reservation the
--     order was paid under before it returns the completed order.
-- The reservation-identity hash is unchanged (the secret is authentication, not
-- part of the claim), so existing reservations remain byte-identical.
create or replace function begin_quote_payment(p_payment jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff    text := current_staff_id();
  v_me       staff_profiles%rowtype;
  v_quote_id text := p_payment ->> 'quoteId';
  v_res_id   text := p_payment ->> 'reservationId';
  v_method   text := p_payment ->> 'method';
  v_device   text := nullif(trim(coalesce(p_payment ->> 'deviceId','')), '');
  v_secret   text := nullif(p_payment ->> 'deviceSecret', '');
  v_session  text := nullif(trim(coalesce(p_payment ->> 'cashSessionId','')), '');
  v_term_in  text := nullif(trim(coalesce(p_payment ->> 'terminalConfigId','')), '');
  v_acct_in  text := nullif(trim(coalesce(p_payment ->> 'onlineAccountId','')), '');
  v_override text := nullif(trim(coalesce(p_payment ->> 'overrideReason','')), '');
  v_hash     text;
  v_q        order_quotes%rowtype;
  v_o        orders%rowtype;
  v_store    stores%rowtype;
  v_dev      web_till_devices%rowtype;
  v_sess     web_till_sessions%rowtype;
  v_term     payment_terminals%rowtype;
  v_acct     online_payment_accounts%rowtype;
  v_today    date;
  v_created_day date;
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

  -- The CANONICAL reservation identity: SHA-256 over the canonical JSON of
  -- the SUPPLIED request. The operator is derived server-side, never accepted
  -- from the payload; replaying the identity with any different fact is a
  -- different claim and conflicts.
  v_hash := canonical_request_hash(jsonb_build_object(
    'op', 'begin_quote_payment', 'quoteId', v_quote_id, 'reservationId', v_res_id,
    'method', v_method, 'deviceId', v_device, 'cashSessionId', v_session,
    'terminalConfigId', v_term_in, 'onlineAccountId', v_acct_in,
    'operatorStaffId', v_staff));

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
        -- The completed order is returned only to the operator who took the
        -- payment, or to an audited manager/owner override (correction 8).
        if v_a.operator_staff_id is distinct from v_staff then
          if v_override is null or not is_manager_or_owner() then
            raise exception 'operator_scope_denied' using errcode = '42501',
              detail = 'Another operator''s payment; a manager/owner override with a reason is required.';
          end if;
          perform log_payment_authority_event('payment_override:begin_replay', jsonb_build_object(
            'quoteId', v_q.id, 'reservationId', v_res_id, 'operator', v_a.operator_staff_id,
            'overriddenBy', v_staff, 'reason', v_override));
        end if;
        select * into v_o from orders where quote_id = v_q.id;
        return jsonb_build_object('quote', to_jsonb(v_q), 'order', to_jsonb(v_o),
                                  'state', 'already_consumed');
      end if;
      return jsonb_build_object('quote', to_jsonb(v_q), 'state', 'reserved', 'duplicate', true);
    end;
  end if;

  if v_q.status = 'CONSUMED' then
    -- EXACT-ATTEMPT REPLAY (finding 1/2): reaching here means NO attempt carries
    -- the supplied reservation — the matching-attempt branch above already
    -- returned the real order. A wrong reservation is refused; a reservation
    -- that matches the quote's own field but has NO consumed attempt behind it
    -- is an inconsistent ledger. We FAIL CLOSED and NEVER hand back an order
    -- from the quote's reservation field alone.
    if v_res_id is distinct from v_q.reservation_id then
      raise exception 'invalid_reservation' using errcode = '42501',
        detail = 'That reservation is not the one this order was paid under.';
    end if;
    raise exception 'payment_state_inconsistent' using errcode = '42501',
      detail = 'This consumed quote has no matching consumed payment attempt.';
  end if;
  if v_q.status in ('EXPIRED','CANCELLED') then
    raise exception 'quote_not_open';
  end if;
  if v_q.status = 'NEEDS_RECONCILIATION' then
    raise exception 'quote_needs_reconciliation'
      using detail = 'This quote is awaiting privileged payment reconciliation.';
  end if;
  if v_q.status = 'PAYMENT_PENDING' then
    -- A second tab or device must not take over a payment that may already
    -- be in progress on the first. (An identity replay was handled above.)
    raise exception 'payment_already_pending' using errcode = '42501',
      detail = 'This quote already has an active payment reservation.';
  end if;

  -- Only the operator who priced the basket reserves it; anyone else needs
  -- an audited manager/owner override (correction 3).
  if v_q.staff_id is distinct from v_staff then
    if v_override is null or not is_manager_or_owner() then
      raise exception 'operator_scope_denied' using errcode = '42501',
        detail = 'Another operator''s quote; a manager/owner override with a reason is required.';
    end if;
    perform log_payment_authority_event('payment_override:begin', jsonb_build_object(
      'quoteId', v_q.id, 'creator', v_q.staff_id, 'overriddenBy', v_staff, 'reason', v_override));
  end if;

  -- Expiry is DERIVED and refused here; the persisted EXPIRED status is
  -- bookkeeping written by expire_stale_quotes() in its own transaction.
  if now() > v_q.expires_at then
    raise exception 'quote_expired'
      using detail = 'Re-price the basket before taking payment.';
  end if;

  -- Config/VAT revalidation (correction 2): the store must still be in
  -- EXACTLY the configuration the quote priced under, and the VAT charging
  -- boundary must not have been crossed since pricing.
  select * into v_store from stores where id = v_q.store_id;
  if store_config_fingerprint(v_store) is distinct from v_q.config_version then
    raise exception 'quote_config_stale'
      using detail = 'The store configuration changed after quoting; re-price the basket.';
  end if;
  v_today       := (now() at time zone v_store.timezone)::date;
  v_created_day := (v_q.created_at at time zone v_store.timezone)::date;
  if v_q.store_vat_status = 'REGISTERED'
     and v_q.vat_effective_date is not null
     and v_q.vat_effective_date > v_created_day
     and v_q.vat_effective_date <= v_today then
    raise exception 'quote_config_stale'
      using detail = 'The VAT charging boundary was crossed after quoting; re-price the basket.';
  end if;

  -- The payment ROUTE is validated and bound HERE, before any money moves.
  if v_method is null or v_method not in ('cash','card','online')
     or not (v_q.allowed_payment_methods ? v_method) then
    raise exception 'payment_method_not_accepted';
  end if;

  if v_method = 'cash' then
    if v_term_in is not null or v_acct_in is not null then
      raise exception 'payment_route_invalid'
        using detail = 'A cash reservation names a device and session, nothing else.';
    end if;
    if v_device is null or v_session is null then
      raise exception 'till_session_required'
        using detail = 'Cash may only be reserved against an open till session on an enrolled device.';
    end if;
    select * into v_dev from web_till_devices where id = v_device;
    if v_dev.id is null or v_dev.credential_hash is null then
      raise exception 'device_not_enrolled' using errcode = '42501',
        detail = 'Cash custody requires a device enrolled by a manager or owner.';
    end if;
    if v_dev.revoked then
      raise exception 'till_device_revoked' using errcode = '42501';
    end if;
    if v_dev.store_id is distinct from v_q.store_id then
      raise exception 'device_store_mismatch' using errcode = '42501';
    end if;
    -- DEVICE CREDENTIAL ON THE CASH OP (finding 1): the enrolled device pairing
    -- secret must be re-presented for this reservation, not only at session
    -- open, so a captured session/device id alone cannot move cash.
    if v_secret is null
       or encode(sha256(convert_to(v_secret, 'utf8')), 'hex') is distinct from v_dev.credential_hash then
      raise exception 'device_credential_invalid' using errcode = '42501',
        detail = 'The device pairing secret is required to reserve cash on this device.';
    end if;
    -- LOCKING the session here closes the close-vs-begin race (correction 1 /
    -- finding 12): a concurrent close_till_session() serialises against this
    -- row lock, so a new cash attempt can never slip under a closing drawer.
    select * into v_sess from web_till_sessions where id = v_session for update;
    if v_sess.id is null or v_sess.status <> 'OPEN' then
      raise exception 'till_session_not_open';
    end if;
    if v_sess.store_id is distinct from v_q.store_id then
      raise exception 'till_session_store_mismatch' using errcode = '42501';
    end if;
    if v_sess.device_id is distinct from v_device then
      raise exception 'till_session_device_mismatch' using errcode = '42501';
    end if;

  elsif v_method = 'card' then
    if v_device is not null or v_session is not null or v_acct_in is not null then
      raise exception 'payment_route_invalid'
        using detail = 'A card-present reservation names a registered terminal, nothing else.';
    end if;
    if v_term_in is not null then
      select * into v_term from payment_terminals where id = v_term_in;
      if v_term.id is null then
        raise exception 'unknown_terminal';
      end if;
    else
      select * into v_term from payment_terminals
       where store_id = v_q.store_id and status = 'ACTIVE';
      if v_term.id is null then
        raise exception 'unknown_terminal'
          using detail = 'No registered card terminal for this store.';
      end if;
      if (select count(*) from payment_terminals
           where store_id = v_q.store_id and status = 'ACTIVE') > 1 then
        raise exception 'terminal_ambiguous'
          using detail = 'This store has several terminals; the till must name the one that will take the payment.';
      end if;
    end if;
    if v_term.status <> 'ACTIVE' then
      raise exception 'terminal_not_active';
    end if;
    if v_term.store_id is distinct from v_q.store_id then
      raise exception 'terminal_store_mismatch' using errcode = '42501',
        detail = 'That terminal belongs to another store.';
    end if;

  else -- online
    if v_device is not null or v_session is not null or v_term_in is not null then
      raise exception 'payment_route_invalid'
        using detail = 'An online reservation names a registered provider account, nothing else.';
    end if;
    if v_acct_in is not null then
      select * into v_acct from online_payment_accounts where id = v_acct_in;
      if v_acct.id is null then
        raise exception 'unknown_online_account';
      end if;
    else
      select * into v_acct from online_payment_accounts
       where store_id = v_q.store_id and status = 'ACTIVE';
      if v_acct.id is null then
        raise exception 'unknown_online_account'
          using detail = 'No registered online payment account for this store.';
      end if;
      if (select count(*) from online_payment_accounts
           where store_id = v_q.store_id and status = 'ACTIVE') > 1 then
        raise exception 'online_account_ambiguous';
      end if;
    end if;
    if v_acct.status <> 'ACTIVE' then
      raise exception 'online_account_not_active';
    end if;
    if v_acct.store_id is distinct from v_q.store_id then
      raise exception 'online_account_store_mismatch' using errcode = '42501';
    end if;
  end if;

  -- A previous decline stays on the record: released_at / release_reason are
  -- deliberately NOT cleared when a new attempt begins.
  insert into quote_payment_attempts
    (reservation_id, quote_id, store_id, payment_method, device_id,
     cash_session_id, terminal_config_id, online_account_id,
     operator_staff_id, request_hash, state)
  values (v_res_id, v_q.id, v_q.store_id, v_method, v_device,
          v_session, v_term.id, v_acct.id, v_staff, v_hash, 'PENDING');

  update order_quotes
     set status = 'PAYMENT_PENDING', payment_started_at = now(),
         reservation_id = v_res_id, reservation_hash = v_hash
   where id = v_q.id
  returning * into v_q;

  return jsonb_build_object(
    'quote', to_jsonb(v_q), 'state', 'reserved', 'duplicate', false,
    'binding', jsonb_strip_nulls(jsonb_build_object(
      'method', v_method, 'deviceId', v_device, 'cashSessionId', v_session,
      'terminalConfigId', v_term.id, 'onlineAccountId', v_acct.id)));
end $$;

revoke all on function begin_quote_payment(jsonb) from public, anon;
grant execute on function begin_quote_payment(jsonb) to authenticated;

-- ============================================================================
-- Slice R3.3 — cash finalisation + drawer close (findings 1, 3, 4)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- R3.3a  Attribution columns (bounded; written once at finalisation)
-- ----------------------------------------------------------------------------
-- The ledger trigger already freezes every column but payment_status, so these
-- are insert-time facts. They exist to stop the record from CONFLATING three
-- different things it previously wrote into one field.
alter table orders add column if not exists payment_claimed_at        timestamptz;
alter table orders add column if not exists payment_recorded_at       timestamptz;
alter table orders add column if not exists payment_operator_staff_id text;
alter table orders add column if not exists finalised_by_staff_id     text;
alter table orders add column if not exists finalisation_reason       text;

comment on column orders.payment_claimed_at is
  'The payment time ASSERTED by the client, after server bounds-checking. NULL when the client asserted none.';
comment on column orders.payment_recorded_at is
  'The SERVER clock when the sale was written. Always server-generated; never accepted from a caller.';
comment on column orders.payment_operator_staff_id is
  'The operator who actually took the payment (from the reservation). Preserved even when a manager finalises or recovers.';
comment on column orders.finalised_by_staff_id is
  'Who wrote this record — the same as the operator on an ordinary sale, a manager/owner on an override or recovery.';

-- ----------------------------------------------------------------------------
-- R3.3b  finalise_order_payment_core() v2
--        finding 1  device credential on the CASH finalise
--        finding 3  bounded, attributable payment timestamps
--        finding 4  the original payment operator is preserved
-- ----------------------------------------------------------------------------
create or replace function finalise_order_payment_core(
  p_payment jsonb, p_recovery boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff     text := current_staff_id();
  v_me        staff_profiles%rowtype;
  v_op        staff_profiles%rowtype;
  v_quote_id  text := p_payment ->> 'quoteId';
  v_res_in    text := p_payment ->> 'reservationId';
  v_method    text := p_payment ->> 'method';
  v_ref       text := nullif(trim(coalesce(p_payment ->> 'providerReference','')), '');
  v_term_in   text := nullif(trim(coalesce(p_payment ->> 'terminalConfigId','')), '');
  v_acct_in   text := nullif(trim(coalesce(p_payment ->> 'onlineAccountId','')), '');
  v_sess_in   text := nullif(trim(coalesce(p_payment ->> 'tillSessionId','')), '');
  v_dev_in    text := nullif(trim(coalesce(p_payment ->> 'deviceId','')), '');
  v_secret    text := nullif(p_payment ->> 'deviceSecret', '');
  v_override  text := nullif(trim(coalesce(p_payment ->> 'overrideReason','')), '');
  v_customer  text := nullif(trim(coalesce(p_payment ->> 'customerName','')), '');
  v_paid_raw  text := nullif(p_payment ->> 'paidAt','');
  v_claimed   timestamptz;
  v_recorded  timestamptz;
  v_paid_at   timestamptz;
  v_cash_p    bigint := case when nullif(p_payment ->> 'cashReceived','') is not null
                        then round((p_payment ->> 'cashReceived')::numeric * 100)::bigint end;
  v_appr_p    bigint := case when nullif(p_payment ->> 'approvedAmount','') is not null
                        then round((p_payment ->> 'approvedAmount')::numeric * 100)::bigint end;
  v_change_p  bigint;
  v_q         order_quotes%rowtype;
  v_att       quote_payment_attempts%rowtype;
  v_s         web_till_sessions%rowtype;
  v_dev       web_till_devices%rowtype;
  v_term      payment_terminals%rowtype;
  v_acct      online_payment_accounts%rowtype;
  v_provider  text;
  v_merchant  text;
  v_terminal  text;
  v_total_p   bigint;
  v_hash      text;
  v_order_no  bigint;
  v_order_id  text := 'ord_' || replace(gen_random_uuid()::text, '-', '');
  v_row       orders%rowtype;
  v_recovery  interval := interval '24 hours';
  v_via       text;
  v_pay_status text;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  -- Finalisation must name and consume ONE exact attempt — ALWAYS, including
  -- for a consumed replay (correction 8: the replay path can no longer omit
  -- the reservation).
  if v_res_in is null then
    raise exception 'invalid_reservation'
      using detail = 'Finalisation must present the reservation that took the payment.';
  end if;

  select * into v_q from order_quotes where id = v_quote_id for update;
  if v_q.id is null then raise exception 'unknown_quote'; end if;
  if v_q.store_id is distinct from v_me.store_id
     and not (p_recovery and is_owner()) then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;

  select * into v_att from quote_payment_attempts
   where reservation_id = v_res_in for update;
  if v_att.reservation_id is null then
    raise exception 'invalid_reservation'
      using detail = 'No such payment reservation.';
  end if;
  if v_att.quote_id is distinct from v_q.id then
    raise exception 'idempotency_conflict' using errcode = '42501',
      detail = 'That reservation does not belong to this quote.';
  end if;

  -- Only the operator who took the payment may finalise it; anyone else
  -- needs an audited manager/owner override, and the reconciliation path is
  -- privileged by construction (correction 3).
  if v_att.operator_staff_id is distinct from v_staff and not p_recovery then
    if v_override is null or not is_manager_or_owner() then
      raise exception 'operator_scope_denied' using errcode = '42501',
        detail = 'Another operator''s payment; a manager/owner override with a reason is required.';
    end if;
    perform log_payment_authority_event('payment_override:finalise', jsonb_build_object(
      'quoteId', v_q.id, 'reservationId', v_res_in, 'operator', v_att.operator_staff_id,
      'overriddenBy', v_staff, 'reason', v_override));
  end if;

  -- The method and route were BOUND at reservation. Finalisation may repeat
  -- them, but it can never substitute any part of them (correction 1).
  if v_method is distinct from v_att.payment_method then
    raise exception 'payment_method_mismatch'
      using detail = 'Finalisation must use the payment method that was reserved.';
  end if;
  if v_term_in is not null and v_term_in is distinct from v_att.terminal_config_id then
    raise exception 'payment_binding_mismatch' using errcode = '42501',
      detail = 'The reserved terminal is the one that must finalise.';
  end if;
  if v_acct_in is not null and v_acct_in is distinct from v_att.online_account_id then
    raise exception 'payment_binding_mismatch' using errcode = '42501',
      detail = 'The reserved online account is the one that must finalise.';
  end if;
  if v_sess_in is not null and v_sess_in is distinct from v_att.cash_session_id then
    raise exception 'payment_binding_mismatch' using errcode = '42501',
      detail = 'The reserved till session is the one that must finalise.';
  end if;
  if v_dev_in is not null and v_dev_in is distinct from v_att.device_id then
    raise exception 'payment_binding_mismatch' using errcode = '42501',
      detail = 'The reserved device is the one that must finalise.';
  end if;

  v_total_p := round(v_q.total * 100)::bigint;

  -- BOUNDED, ATTRIBUTABLE TIME (finding 3). Three different facts stop being
  -- one field: what the client CLAIMED, what the server RECORDED, and the
  -- captured time the ledger shows. The claim is bounds-checked, never trusted
  -- outright — it can no longer sit in the future or before the basket existed.
  v_recorded := now();
  v_claimed  := v_paid_raw::timestamptz;   -- null when the client claimed none
  if v_claimed is not null then
    if v_claimed > v_recorded + interval '5 minutes' then
      raise exception 'payment_time_in_future' using errcode = '42501',
        detail = 'The claimed payment time is in the future.';
    end if;
    if v_claimed < v_q.created_at - interval '5 minutes' then
      raise exception 'payment_time_implausible' using errcode = '42501',
        detail = 'The claimed payment time precedes the priced basket.';
    end if;
    -- The payment cannot predate the ATTEMPT it settles — on the ordinary path
    -- and in recovery alike. An older-but-legitimate time (a delayed recovery
    -- of a real payment) passes, because the attempt itself is that old; a time
    -- from before this attempt began does not, so a timestamp belonging to some
    -- other payment cannot be grafted onto this one.
    if v_att.started_at is not null
       and v_claimed < v_att.started_at - interval '5 minutes' then
      raise exception 'payment_time_implausible' using errcode = '42501',
        detail = 'The claimed payment time precedes this payment attempt.';
    end if;
  end if;
  v_paid_at := coalesce(v_claimed, v_recorded);

  -- The CANONICAL finalisation identity (correction 8): every fact whose
  -- change is a different claim about the payment — including the exact
  -- reservation and its bound route. Same claim replayed = same order;
  -- anything different conflicts.
  v_hash := canonical_request_hash(jsonb_build_object(
    'op', 'finalise_order_payment', 'quoteId', v_quote_id,
    'reservationId', v_res_in, 'method', v_method,
    'cashReceivedP', v_cash_p, 'approvedAmountP', v_appr_p,
    'providerReference', v_ref, 'paidAt', v_paid_raw, 'customerName', v_customer,
    'cashSessionId', v_att.cash_session_id, 'deviceId', v_att.device_id,
    'terminalConfigId', v_att.terminal_config_id,
    'onlineAccountId', v_att.online_account_id));

  if v_att.state in ('DECLINED','ABANDONED') then
    raise exception 'reservation_released' using errcode = '42501',
      detail = 'That attempt was released; it cannot be finalised.';
  end if;
  if v_att.state = 'CONSUMED' then
    if v_q.payment_hash = v_hash then
      -- The retry anchor is the QUOTE, not the order id: the order carries
      -- its own identity and is found through the unique quote link.
      select * into v_row from orders where quote_id = v_q.id;
      return jsonb_build_object('order', to_jsonb(v_row), 'duplicate', true);
    end if;
    raise exception 'idempotency_conflict' using errcode = '42501',
      detail = 'This quote was already finalised with different payment facts.';
  end if;

  if p_recovery then
    if v_q.status <> 'NEEDS_RECONCILIATION' then
      raise exception 'quote_not_reserved'
        using detail = 'Reconciliation applies to a quote in NEEDS_RECONCILIATION.';
    end if;
  else
    if v_q.status <> 'PAYMENT_PENDING' then
      raise exception 'quote_not_reserved'
        using detail = 'Reserve the quote with begin_quote_payment() before taking payment.';
    end if;
    -- A paid transaction is NEVER permanently unrecordable (correction 5):
    -- past the window, the path is resolve_payment_reconciliation(), not a
    -- dead end.
    if now() > v_q.payment_started_at + v_recovery then
      raise exception 'recovery_window_elapsed'
        using detail = 'The ordinary recovery window has passed; a manager or owner must resolve this payment through resolve_payment_reconciliation().';
    end if;
  end if;
  if v_q.reservation_id is distinct from v_res_in then
    raise exception 'idempotency_conflict' using errcode = '42501',
      detail = 'A superseded attempt cannot finalise this quote.';
  end if;

  if v_method = 'cash' then
    -- CASH CUSTODY: the BOUND session, locked, still open, still this store's
    -- drawer on this device.
    select * into v_s from web_till_sessions where id = v_att.cash_session_id for update;
    if v_s.id is null or v_s.status <> 'OPEN' then
      raise exception 'till_session_not_open';
    end if;
    if v_s.store_id is distinct from v_q.store_id then
      raise exception 'till_session_store_mismatch' using errcode = '42501';
    end if;
    if v_s.device_id is distinct from v_att.device_id then
      raise exception 'till_session_device_mismatch' using errcode = '42501';
    end if;
    -- DEVICE CREDENTIAL ON THE CASH FINALISE (finding 1). The ordinary path
    -- must re-present the enrolled pairing secret: taking money into the drawer
    -- is a custody act, not merely a call naming an open session. The PRIVILEGED
    -- RECOVERY path is deliberately exempt — it exists precisely for when the
    -- till is gone, and it is already manager/owner-gated, reasoned and audited;
    -- demanding a secret nobody can produce would make a real payment
    -- permanently unrecordable, which WS7b correction 5 forbids.
    if not p_recovery then
      select * into v_dev from web_till_devices where id = v_att.device_id;
      if v_dev.id is null or v_dev.credential_hash is null then
        raise exception 'device_not_enrolled' using errcode = '42501',
          detail = 'Cash custody requires a device enrolled by a manager or owner.';
      end if;
      if v_dev.revoked then
        raise exception 'till_device_revoked' using errcode = '42501';
      end if;
      if v_secret is null
         or encode(sha256(convert_to(v_secret, 'utf8')), 'hex') is distinct from v_dev.credential_hash then
        raise exception 'device_credential_invalid' using errcode = '42501',
          detail = 'The device pairing secret is required to record cash on this device.';
      end if;
    end if;
    if v_cash_p is null or v_cash_p < v_total_p then
      raise exception 'insufficient_cash';
    end if;
    v_change_p := v_cash_p - v_total_p;
    if p_payment ? 'change'
       and round(coalesce(nullif(p_payment ->> 'change','')::numeric, -1) * 100)::bigint
           is distinct from v_change_p then
      raise exception 'change_mismatch'
        using detail = 'Change must equal cash received minus the quoted total.';
    end if;
    v_pay_status := 'CASH_RECORDED';
  else
    -- CARD / ONLINE. This system has no provider integration, so what the
    -- database can honestly record is that a STAFF BROWSER asserted this
    -- result. The order therefore says OPERATOR_RECORDED_UNRECONCILED, and
    -- only reconcile_card_payment() — against manager-attested external
    -- evidence — may upgrade it (correction 6).
    if v_ref is null then
      raise exception 'payment_reference_required'
        using detail = 'A card or online payment must carry the reference the operator observed.';
    end if;
    if v_appr_p is distinct from v_total_p then
      raise exception 'approved_amount_mismatch'
        using detail = 'The approved amount must equal the quoted total.';
    end if;
    if v_method = 'card' then
      -- The namespace is RESOLVED from the terminal BOUND at reservation —
      -- never accepted from the payload, never re-chosen at finalisation.
      select * into v_term from payment_terminals where id = v_att.terminal_config_id;
      if v_term.id is null then
        raise exception 'unknown_terminal';
      end if;
      v_provider := btrim(v_term.provider);
      v_merchant := btrim(v_term.merchant_id);
      v_terminal := btrim(v_term.terminal_id);
    else
      select * into v_acct from online_payment_accounts where id = v_att.online_account_id;
      if v_acct.id is null then
        raise exception 'unknown_online_account';
      end if;
      v_provider := btrim(v_acct.provider);
      v_merchant := btrim(v_acct.account_id);
      v_terminal := 'ONLINE';
    end if;
    v_cash_p := null;
    v_change_p := null;
    v_pay_status := 'OPERATOR_RECORDED_UNRECONCILED';
  end if;

  perform pg_advisory_xact_lock(hashtext('milkpop_order_no_' || coalesce(v_q.store_id, 'hq')));
  select coalesce(max(order_number), 0) + 1 into v_order_no
    from orders where coalesce(store_id, 'hq') = coalesce(v_q.store_id, 'hq');

  -- PRESERVE THE PAYMENT OPERATOR (finding 4): the sale belongs to the cashier
  -- who actually took the money, even when a manager finalises or recovers it.
  -- Who WROTE the record is recorded separately, never on top of the operator.
  select * into v_op from staff_profiles where id = v_att.operator_staff_id;

  -- The sale is written FROM THE SNAPSHOT. Nothing is re-derived from the
  -- current catalogue, so the record matches the money that was collected.
  insert into orders
    (id, order_number, store_id, store_name, channel, items, applied_deals,
     subtotal, discount_total, tax_rate, tax_amount, total,
     store_vat_status, vat_effective_date,
     payment_method, cash_received, change_given, status,
     customer_name, staff_id, staff_name, placed_at, completed_at,
     quote_id, till_session_id, payment_status, payment_reference,
     payment_captured_at, cash_change,
     payment_claimed_at, payment_recorded_at, payment_operator_staff_id,
     finalised_by_staff_id, finalisation_reason)
  values
    (v_order_id, v_order_no, v_q.store_id,
     coalesce((select name from stores where id = v_q.store_id), ''),
     v_q.channel, v_q.items, v_q.applied_deals,
     v_q.subtotal, v_q.discount_total, v_q.tax_rate, v_q.tax_amount, v_q.total,
     v_q.store_vat_status, v_q.vat_effective_date,
     v_method::payment_method,
     case when v_cash_p is null then null else v_cash_p / 100.0 end,
     case when v_change_p is null then null else v_change_p / 100.0 end,
     'completed', v_customer,
     coalesce(v_att.operator_staff_id, v_staff),
     coalesce(v_op.name, v_me.name, ''),
     v_q.created_at,                       -- placed: when the basket was priced
     v_paid_at,                            -- completed: when the money moved
     v_q.id, case when v_method = 'cash' then v_att.cash_session_id else null end,
     v_pay_status, v_ref, v_paid_at,
     case when v_change_p is null then null else v_change_p / 100.0 end,
     v_claimed, v_recorded, v_att.operator_staff_id,
     v_staff, coalesce(p_reason, v_override))
  returning * into v_row;

  -- The attempt's terminal evidence is written ONCE, atomically, in the
  -- resolving statement; the trigger freezes every column afterwards
  -- (correction 7).
  v_via := case when p_recovery then 'reconciliation'
                when v_att.operator_staff_id is distinct from v_staff then 'override_finalise'
                else 'finalise' end;
  update quote_payment_attempts
     set state = 'CONSUMED', completed_order_id = v_row.id,
         provider_reference = v_ref, payment_provider = v_provider,
         provider_merchant_id = v_merchant, provider_terminal_id = v_terminal,
         resolved_by_staff_id = v_staff, resolved_via = v_via, resolved_at = now()
   where reservation_id = v_res_in;

  update order_quotes
     set status = 'CONSUMED', consumed_at = now(),
         order_id = v_row.id, payment_hash = v_hash
   where id = v_q.id;

  return jsonb_build_object('order', to_jsonb(v_row), 'duplicate', false,
                            'paymentStatus', v_pay_status);
end $$;

revoke all on function finalise_order_payment_core(jsonb, boolean, text)
  from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- R3.3c  close_till_session() — device credential on the drawer close (finding 1)
-- ----------------------------------------------------------------------------
-- Closing a drawer is a cash-custody act. It now requires the enrolled device
-- pairing secret, with ONE audited alternative: a manager/owner with an
-- MFA-verified session and a written reason (the broken-or-lost-device case).
-- That mirrors the override pattern WS7b already uses, and is logged.
create or replace function close_till_session(p_session jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff    text := current_staff_id();
  v_me       staff_profiles%rowtype;
  v_row      web_till_sessions%rowtype;
  v_dev      web_till_devices%rowtype;
  v_secret   text := nullif(p_session ->> 'deviceSecret', '');
  v_override text := nullif(trim(coalesce(p_session ->> 'overrideReason','')), '');
  v_dev_ok   boolean;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  select * into v_row from web_till_sessions where id = p_session ->> 'id' for update;
  if v_row.id is null then raise exception 'unknown_session'; end if;
  if v_row.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;

  -- AUTHENTICATION FIRST (R3.1 audit correction). This DEFINER function
  -- bypasses the scoped read policy on till sessions, so NOTHING — including
  -- the idempotent CLOSED replay — may be returned before the caller proves
  -- authority. The device path accepts only an ENROLLED, UNREVOKED device of
  -- THIS session's store presenting the exact pairing secret (matching the
  -- reserve and finalise paths); the audited manager/owner + AAL2 +
  -- written-reason override remains the one alternative, and deliberately
  -- still works for a revoked or lost device.
  select * into v_dev from web_till_devices where id = v_row.device_id;
  v_dev_ok := v_secret is not null
          and v_dev.id is not null
          and v_dev.credential_hash is not null
          and not coalesce(v_dev.revoked, false)
          and v_dev.store_id = v_row.store_id
          and encode(sha256(convert_to(v_secret, 'utf8')), 'hex') = v_dev.credential_hash;
  if v_dev_ok then
    null;  -- the device proved itself
  elsif v_override is not null and length(v_override) >= 10
        and is_manager_or_owner() and is_aal2() then
    -- sessionStatus is recorded because, with authentication first, an
    -- override may legitimately fire on an already-CLOSED session (a
    -- privileged idempotent replay) without closing anything.
    perform log_payment_authority_event('till_session:close_override', jsonb_build_object(
      'sessionId', v_row.id, 'deviceId', v_row.device_id, 'sessionStatus', v_row.status,
      'closedBy', v_staff, 'reason', v_override));
  elsif v_secret is not null and v_dev.id is not null
        and v_dev.credential_hash is not null
        and coalesce(v_dev.revoked, false)
        and encode(sha256(convert_to(v_secret, 'utf8')), 'hex') = v_dev.credential_hash then
    -- The RIGHT secret for a REVOKED device: name the real reason, exactly
    -- as begin_quote_payment and finalise_order_payment_core do.
    raise exception 'till_device_revoked' using errcode = '42501',
      detail = 'This till device is revoked; a manager or owner override is required to close its drawer.';
  else
    raise exception 'device_credential_invalid' using errcode = '42501',
      detail = 'Closing a drawer requires the device pairing secret, or a manager/owner override with a written reason.';
  end if;

  -- Only now may session state be disclosed or changed.
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

revoke all on function close_till_session(jsonb) from public, anon;
grant execute on function close_till_session(jsonb) to authenticated;

-- ============================================================================
-- Slice R3.4 — idempotent privileged recovery (finding 5)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- R3.4a  Resolution identity on the quote (bounded; no new table)
-- ----------------------------------------------------------------------------
-- The quote is already the anchor for a payment's lifecycle and its snapshot
-- trigger freezes only the priced facts, so the resolution identity lives here
-- rather than in a new store. One resolution per quote, unique per store.
alter table order_quotes add column if not exists resolution_id   text;
alter table order_quotes add column if not exists resolution_hash text;

create unique index if not exists order_quotes_resolution_unique
  on order_quotes (store_id, resolution_id) where resolution_id is not null;

comment on column order_quotes.resolution_id is
  'Caller-supplied identity of the privileged recovery that resolved this payment. Replaying it with the same claim returns the original outcome; replaying it with a changed claim conflicts.';

-- ----------------------------------------------------------------------------
-- R3.4b  resolve_payment_reconciliation() v2 — idempotent, AAL2-gated
-- ----------------------------------------------------------------------------
-- Preserves the WS7b workflow exactly (void / record_order, the 24-hour window,
-- store scope, the one finalisation core, the audit events). It adds:
--   * an explicit AAL2 check to match the authority the errors already claim;
--   * a required resolutionId + canonical request hash, so a lost response can
--     be retried safely instead of returning quote_already_consumed /
--     reservation_released;
--   * replay semantics: same id + same claim returns the ORIGINAL outcome, and
--     same id + ANY changed fact (including the claimed payment time inside the
--     nested payment object) is an idempotency_conflict.
create or replace function resolve_payment_reconciliation(p_resolution jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff    text := current_staff_id();
  v_me       staff_profiles%rowtype;
  v_action   text := p_resolution ->> 'action';
  v_reason   text := nullif(trim(coalesce(p_resolution ->> 'reason','')), '');
  v_res_id   text := p_resolution ->> 'reservationId';
  v_resol_id text := nullif(trim(coalesce(p_resolution ->> 'resolutionId','')), '');
  v_hash     text;
  v_q        order_quotes%rowtype;
  v_a        quote_payment_attempts%rowtype;
  v_o        orders%rowtype;
  v_result   jsonb;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if not is_manager_or_owner() or not is_aal2() then
    raise exception 'reconciliation_denied' using errcode = '42501',
      detail = 'Payment reconciliation requires a manager or owner with an MFA-verified session.';
  end if;
  if v_reason is null or length(v_reason) < 10 then
    raise exception 'reason_required'
      using detail = 'A written reason (at least 10 characters) is required for payment reconciliation.';
  end if;
  if v_action not in ('record_order','void') then
    raise exception 'invalid_reconciliation_action';
  end if;
  if v_res_id is null then raise exception 'invalid_reservation'; end if;
  if v_resol_id is null or length(v_resol_id) < 8 then
    raise exception 'resolution_id_required'
      using detail = 'A resolution id (at least 8 characters) is required so a lost response can be retried safely.';
  end if;

  select * into v_q from order_quotes
   where id = p_resolution ->> 'quoteId' for update;
  if v_q.id is null then raise exception 'unknown_quote'; end if;
  if not is_owner() and v_q.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;

  -- The canonical recovery claim. The nested payment object is included whole,
  -- so a retry that alters the recorded payment — its reference, its amount or
  -- its claimed time — is a DIFFERENT claim, never a silent replay.
  v_hash := canonical_request_hash(jsonb_build_object(
    'op', 'resolve_payment_reconciliation', 'quoteId', v_q.id,
    'reservationId', v_res_id, 'action', v_action, 'reason', v_reason,
    'resolutionId', v_resol_id,
    'payment', coalesce(p_resolution -> 'payment', '{}'::jsonb)));

  -- IDEMPOTENT REPLAY (finding 5), checked BEFORE the state guards that would
  -- otherwise answer a lost-response retry with quote_already_consumed or
  -- reservation_released.
  if v_q.resolution_id is not null and v_q.resolution_id = v_resol_id then
    if v_q.resolution_hash is distinct from v_hash then
      raise exception 'idempotency_conflict' using errcode = '42501',
        detail = 'That resolution id was already used with a different claim.';
    end if;
    if v_action = 'void' then
      return jsonb_build_object('quote', to_jsonb(v_q), 'resolution', 'void',
                                'duplicate', true);
    end if;
    select * into v_o from orders where quote_id = v_q.id;
    return jsonb_build_object('order', to_jsonb(v_o), 'resolution', 'record_order',
                              'duplicate', true);
  end if;

  select * into v_a from quote_payment_attempts
   where reservation_id = v_res_id for update;
  if v_a.reservation_id is null or v_a.quote_id is distinct from v_q.id then
    raise exception 'invalid_reservation'
      using detail = 'That reservation does not belong to this quote.';
  end if;
  if v_a.state = 'CONSUMED' then raise exception 'quote_already_consumed'; end if;
  if v_a.state in ('DECLINED','ABANDONED') then
    raise exception 'reservation_released' using errcode = '42501';
  end if;

  if v_q.status = 'PAYMENT_PENDING' then
    if now() <= v_q.payment_started_at + interval '24 hours' then
      raise exception 'reconciliation_not_required'
        using detail = 'The ordinary recovery window is still open; finalise or release the payment normally.';
    end if;
    update order_quotes set status = 'NEEDS_RECONCILIATION'
     where id = v_q.id returning * into v_q;
  elsif v_q.status <> 'NEEDS_RECONCILIATION' then
    raise exception 'quote_not_reserved';
  end if;

  if v_action = 'void' then
    -- The payment definitively did NOT happen: the attempt is closed and the
    -- quote is cancelled — never silently reopened for fresh payment.
    update quote_payment_attempts
       set state = 'ABANDONED', released_at = now(), release_outcome = 'abandoned',
           resolved_by_staff_id = v_staff, resolved_via = 'reconciliation',
           resolved_at = now()
     where reservation_id = v_res_id and state = 'PENDING';
    if not found then
      raise exception 'attempt_already_resolved' using errcode = '42501';
    end if;
    update order_quotes
       set status = 'CANCELLED', cancelled_at = now(),
           released_at = now(), release_reason = 'reconciled_void',
           resolution_id = v_resol_id, resolution_hash = v_hash
     where id = v_q.id returning * into v_q;
    perform log_payment_authority_event('payment_reconciliation:void', jsonb_build_object(
      'quoteId', v_q.id, 'reservationId', v_res_id, 'reason', v_reason,
      'resolutionId', v_resol_id, 'resolvedBy', v_staff));
    return jsonb_build_object('quote', to_jsonb(v_q), 'resolution', 'void');
  end if;

  -- The payment DID happen: record the sale through the one finalisation
  -- core, from the stored snapshot, with the bound route.
  v_result := finalise_order_payment_core(
    coalesce(p_resolution -> 'payment', '{}'::jsonb)
      || jsonb_build_object('quoteId', v_q.id, 'reservationId', v_res_id),
    true, v_reason);
  -- Stamp the resolution identity on the (now CONSUMED) quote. The snapshot
  -- trigger permits this: the priced facts and the status are unchanged.
  update order_quotes
     set resolution_id = v_resol_id, resolution_hash = v_hash
   where id = v_q.id;
  perform log_payment_authority_event('payment_reconciliation:record_order', jsonb_build_object(
    'quoteId', v_q.id, 'reservationId', v_res_id, 'reason', v_reason,
    'resolutionId', v_resol_id, 'resolvedBy', v_staff,
    'orderId', v_result -> 'order' ->> 'id'));
  return v_result || jsonb_build_object('resolution', 'record_order');
end $$;

revoke all on function resolve_payment_reconciliation(jsonb) from public, anon;
grant execute on function resolve_payment_reconciliation(jsonb) to authenticated;

-- ============================================================================
-- Slice R3.5 — sensitive read scoping (finding 7) + scoped expiry (finding 13)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- R3.5a  Payment and settlement reads are no longer store-wide
-- ----------------------------------------------------------------------------
-- Previously every authenticated member of a store could read every payment
-- attempt, till session, provider account and reconciliation record for that
-- store. Financial evidence and provider configuration are now manager/owner
-- reads; an ordinary operator keeps exactly what their own work needs — their
-- own payment attempts and their own till sessions.
do $$ begin
  drop policy if exists payment_reconciliations_select_store on payment_reconciliations;
  create policy payment_reconciliations_select_mgr on payment_reconciliations
    for select to authenticated
    using (is_manager_or_owner() and (is_owner() or store_id = current_staff_store()));

  drop policy if exists online_payment_accounts_select_store on online_payment_accounts;
  create policy online_payment_accounts_select_mgr on online_payment_accounts
    for select to authenticated
    using (is_manager_or_owner() and (is_owner() or store_id = current_staff_store()));

  drop policy if exists quote_payment_attempts_select_store on quote_payment_attempts;
  create policy quote_payment_attempts_select_scoped on quote_payment_attempts
    for select to authenticated
    using (
      (is_owner() or store_id = current_staff_store())
      and (is_manager_or_owner() or operator_staff_id = current_staff_id())
    );

  drop policy if exists web_till_sessions_select_store on web_till_sessions;
  create policy web_till_sessions_select_scoped on web_till_sessions
    for select to authenticated
    using (
      (is_owner() or store_id = current_staff_store())
      and (is_manager_or_owner() or opened_by_staff_id = current_staff_id())
    );
end $$;

-- ----------------------------------------------------------------------------
-- R3.5b  expire_stale_quotes() — store-scoped, not a global sweep
-- ----------------------------------------------------------------------------
-- The housekeeping sweep is callable from any staff browser, and it used to
-- rewrite quote state for EVERY store in the estate. It now acts on the
-- caller's own store; an OWNER sweeps the estate, matching the is_owner()
-- scope convention used everywhere else in the schema. The signature is
-- unchanged, so no client contract moves.
create or replace function expire_stale_quotes()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff text := current_staff_id();
  v_store text := current_staff_store();
  v_exp int;
  v_rec int;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if not is_owner() and v_store is null then
    raise exception 'store_scope_denied' using errcode = '42501',
      detail = 'Quote expiry acts on your own store.';
  end if;
  update order_quotes set status = 'EXPIRED'
   where status = 'OPEN' and expires_at < now()
     and (is_owner() or store_id = v_store);
  get diagnostics v_exp = row_count;
  update order_quotes set status = 'NEEDS_RECONCILIATION'
   where status = 'PAYMENT_PENDING'
     and payment_started_at + interval '24 hours' < now()
     and (is_owner() or store_id = v_store);
  get diagnostics v_rec = row_count;
  return jsonb_build_object('expired', v_exp, 'movedToReconciliation', v_rec);
end $$;

revoke all on function expire_stale_quotes() from public, anon;
grant execute on function expire_stale_quotes() to authenticated;

-- ============================================================================
-- Slice R3.6 — atomic idempotent quote creation (finding 6)
-- ============================================================================
-- WS7b checked for an existing quote and then inserted. Two simultaneous calls
-- with the same id both saw nothing, so one inserted and the other surfaced a
-- raw unique-violation instead of the idempotent answer the contract promises.
-- The pre-check stays as the fast path; the race is now caught and resolved
-- through exactly the same comparison, so a concurrent duplicate is a duplicate
-- and a concurrent DIFFERENT basket is still a conflict. Nothing else changes.
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
  v_expires    timestamptz;
  v_boundary   timestamptz;
  v_req_hash   text;
begin
  if v_staff is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  select * into v_me from staff_profiles where id = v_staff;
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

  -- The CANONICAL quote request. Same id + same request = one quote; same id
  -- + a DIFFERENT basket is a conflict, never a silent substitution.
  v_req_hash := canonical_request_hash(jsonb_build_object(
    'op', 'create_order_quote', 'quoteId', v_id, 'storeId', v_store_id,
    'staffId', v_staff, 'channel', v_channel,
    'items', v_items_in, 'dealIds', v_deal_ids));

  select * into v_row from order_quotes where id = v_id;
  if v_row.id is not null then
    if v_row.store_id is distinct from v_store_id then
      raise exception 'quote_id_conflict' using errcode = '42501';
    end if;
    if v_row.quote_request_hash is distinct from v_req_hash then
      raise exception 'idempotency_conflict' using errcode = '42501',
        detail = 'That quote id was replayed with a different basket or request.';
    end if;
    return jsonb_build_object('quote', to_jsonb(v_row), 'duplicate', true);
  end if;

  -- A quote may never straddle a scheduled VAT boundary (correction 2): if
  -- charging begins at the next London midnight, the quote dies first. With
  -- this cap, an OPEN quote priced under one VAT regime cannot survive into
  -- the other; begin_quote_payment() revalidates as belt and braces.
  v_expires := now() + v_ttl;
  if v_status_reg and v_store.vat_registration_effective_date > v_today then
    v_boundary := (v_store.vat_registration_effective_date::timestamp)
                    at time zone v_store.timezone;
    v_expires := least(v_expires, v_boundary);
  end if;

  v_priced := price_basket_internal(v_store, v_items_in, v_deal_ids, v_charging);

  begin
    insert into order_quotes
      (id, store_id, staff_id, channel, status, items, applied_deals,
       subtotal, discount_total, tax_rate, tax_amount, total,
       store_vat_status, vat_effective_date, allowed_payment_methods,
       config_version, quote_request_hash, expires_at)
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
       store_config_fingerprint(v_store),
       v_req_hash,
       v_expires)
    returning * into v_row;
  exception when unique_violation then
    -- ATOMIC IDEMPOTENCY (finding 6): a concurrent caller won the race between
    -- the pre-check and this insert. Its row is now visible, so answer with the
    -- SAME contract the pre-check would have applied.
    select * into v_row from order_quotes where id = v_id;
    if v_row.id is null then raise; end if;
    if v_row.store_id is distinct from v_store_id then
      raise exception 'quote_id_conflict' using errcode = '42501';
    end if;
    if v_row.quote_request_hash is distinct from v_req_hash then
      raise exception 'idempotency_conflict' using errcode = '42501',
        detail = 'That quote id was replayed with a different basket or request.';
    end if;
    return jsonb_build_object('quote', to_jsonb(v_row), 'duplicate', true);
  end;

  return jsonb_build_object('quote', to_jsonb(v_row), 'duplicate', false);
end $$;

revoke all on function create_order_quote(jsonb) from public, anon;
grant execute on function create_order_quote(jsonb) to authenticated;
