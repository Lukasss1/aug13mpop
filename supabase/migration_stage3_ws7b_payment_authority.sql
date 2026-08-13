-- ============================================================================
-- STAGE 3 / WS7b — PAYMENT AUTHORITY (correction round for the WS7 core)
-- ============================================================================
-- The WS7 interim review found three trust failures in the database itself:
--
--   BEFORE payment  the reservation did not prove the chosen payment route
--                   was valid — method, device, session and terminal were
--                   stored as client claims, unverified;
--   AT payment      the database never independently knew that money moved —
--                   a provider reference was an operator assertion recorded
--                   as "captured";
--   AFTER payment   the completed financial record remained editable and
--                   deletable through manager policies and table grants.
--
-- This migration closes all three at the database layer, before any client
-- is built against the contract. Auditor correction items addressed here:
--
--   1  begin_quote_payment() validates and BINDS the full payment route
--   2  VAT/configuration revalidation before payment starts, plus a quote
--      expiry that can never cross a scheduled VAT boundary
--   3  operator ownership of release, cancellation and finalisation, with an
--      audited manager/owner override path
--   4  cancellation restricted to OPEN
--   5  an explicit NEEDS_RECONCILIATION state and a privileged, audited
--      resolution workflow — a paid transaction can never become permanently
--      unrecordable
--   6  honest payment status: no provider integration exists, so a card or
--      online payment is recorded as OPERATOR_RECORDED_UNRECONCILED and only
--      becomes PROVIDER_RECONCILED against independent settlement evidence
--   7  immutable attempt terminal evidence and complete foreign keys
--   8  canonical SHA-256 request hashes over canonical JSON
--   9  idempotent release and cancellation
--  10  trusted device enrolment: a cash custody device is server-issued with
--      a pairing secret, never self-declared by the browser
--  11  ONLINE is a separate payment authority from CARD (card-present); an
--      online payment resolves against a registered provider ACCOUNT, not a
--      physical terminal
--  12  the completed-order ledger is closed: browser write policies dropped,
--      write verbs revoked, and UPDATE/DELETE denied by trigger for every
--      role including service maintenance paths
--
-- Items 13–15 (writer-authority inventory, client↔database RPC parity, the
-- single reconstruction script) are tooling and live in scripts/ and
-- ws7-build/; the matrix proves the contracts below live.
--
-- EXPIRY SEMANTICS (correction item, finding 5 of the review). The previous
-- begin_quote_payment() updated a quote to EXPIRED and then RAISED — but the
-- exception rolls the update back, so the persisted status could never
-- actually change. Expiry is therefore now DERIVED: expires_at is the
-- authority everywhere, every RPC refuses a logically-expired quote, and
-- expire_stale_quotes() persists the bookkeeping status in its own
-- transaction. No RPC pretends to persist state from a rolled-back branch.
--
-- Idempotent; fails closed; appended via MP_FUTURE_MIGRATIONS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- WS7b.1  Canonical hashing — SHA-256 over canonical JSON
-- ----------------------------------------------------------------------------
-- The previous request hashes were MD5 over '|'-delimited strings: a value
-- containing the delimiter could forge an ambiguous canonical form, and the
-- finalisation hash omitted material facts. jsonb is already canonical in
-- PostgreSQL (sorted keys, normalised spacing), stripping nulls makes
-- "absent" and "null" one claim, and sha256() is a core function — no
-- extension-schema dependency.
create or replace function canonical_request_hash(p jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(sha256(convert_to(jsonb_strip_nulls(p)::text, 'utf8')), 'hex');
$$;

revoke all on function canonical_request_hash(jsonb) from public, anon, authenticated;

-- The store configuration fingerprint a quote snapshots and a reservation
-- revalidates. Any change to setup, VAT state, payment methods, or the menu's
-- prices/classifications changes this value.
create or replace function store_config_fingerprint(p_store stores)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select canonical_request_hash(jsonb_build_object(
    'setupStatus',      p_store.setup_status,
    'vatStatus',        p_store.vat_status,
    'vatEffectiveDate', p_store.vat_registration_effective_date,
    'paymentMethods',   p_store.payment_methods,
    'menuDigest',       encode(sha256(convert_to(coalesce(
        (select string_agg(id || '=' || coalesce(tax_code, '∅') || '=' || price::text,
                           ',' order by id)
           from menu_items), ''), 'utf8')), 'hex')
  ));
$$;

revoke all on function store_config_fingerprint(stores) from public, anon, authenticated;

-- Privileged payment actions (overrides, reconciliations, device enrolment)
-- write to the ONE audit stream the owner reads. The stamp trigger derives
-- the operator from the caller's JWT, so the actor cannot be spoofed.
create or replace function log_payment_authority_event(p_action text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into audit_logs (id, action, module, new_value)
  values ('aud_' || replace(gen_random_uuid()::text, '-', ''),
          p_action, 'ws7_payments', jsonb_strip_nulls(p_payload)::text);
end $$;

revoke all on function log_payment_authority_event(text, jsonb) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- WS7b.2  ONLINE is its own payment authority (correction 11)
-- ----------------------------------------------------------------------------
-- An online (card-not-present) payment has a provider account and a payment
-- intent — it has NO physical terminal, so the terminal registry is the wrong
-- authority for it. Online payments resolve against this registry instead;
-- the derived namespace is (provider, account, 'ONLINE').
create table if not exists online_payment_accounts (
  id          text primary key,
  store_id    text not null references stores(id),
  provider    text not null,
  account_id  text not null,
  status      text not null default 'ACTIVE',
  created_at  timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'opa_status_controlled') then
    alter table online_payment_accounts add constraint opa_status_controlled
      check (status in ('ACTIVE','RETIRED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'opa_identity_present') then
    alter table online_payment_accounts add constraint opa_identity_present
      check (length(btrim(provider)) > 0 and length(btrim(account_id)) > 0);
  end if;
end $$;

create unique index if not exists opa_namespace_unique
  on online_payment_accounts (provider, account_id);

comment on table online_payment_accounts is
  'Registered online (card-not-present) provider accounts. finalise_order_payment DERIVES the online namespace from this table; the client never supplies it. Admin-registered like payment_terminals.';

-- ----------------------------------------------------------------------------
-- WS7b.3  Trusted device enrolment (correction 10)
-- ----------------------------------------------------------------------------
-- The previous open_till_session() inserted whatever device id the browser
-- claimed ("on conflict do nothing"), so a device was a label, not a custody
-- identity. A cash custody device is now ENROLLED by a manager or owner: the
-- SERVER issues the device id and a pairing secret, stores only the secret's
-- SHA-256, and opening a drawer requires presenting that secret.
alter table web_till_devices add column if not exists credential_hash text;

comment on column web_till_devices.credential_hash is
  'SHA-256 of the server-issued pairing secret. NULL means the device pre-dates enrolment and can no longer open a session.';

create or replace function enrol_till_device(p_device jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff  text := current_staff_id();
  v_me     staff_profiles%rowtype;
  v_label  text := nullif(trim(coalesce(p_device ->> 'label','')), '');
  v_store_id text;
  v_store  stores%rowtype;
  v_id     text := 'wtd_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
  v_secret text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_row    web_till_devices%rowtype;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;
  -- is_manager_or_owner() REQUIRES an aal2 (MFA-verified) session since FIX-8.
  if not is_manager_or_owner() then
    raise exception 'device_enrolment_denied' using errcode = '42501',
      detail = 'Only a manager or owner with an MFA-verified session may enrol a till device.';
  end if;
  if v_label is null then
    raise exception 'invalid_device_label';
  end if;

  v_store_id := case when is_owner() and nullif(p_device ->> 'storeId','') is not null
                     then p_device ->> 'storeId' else v_me.store_id end;
  if v_store_id is null then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;
  select * into v_store from stores where id = v_store_id;
  if v_store.id is null then raise exception 'unknown_store'; end if;
  if not is_owner() and v_store.id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;
  if v_store.setup_status is distinct from 'ACTIVE' then
    raise exception 'store_setup_incomplete';
  end if;

  insert into web_till_devices (id, store_id, label, registered_by, credential_hash)
  values (v_id, v_store_id, v_label, v_staff,
          encode(sha256(convert_to(v_secret, 'utf8')), 'hex'))
  returning * into v_row;

  perform log_payment_authority_event('device_enrolled', jsonb_build_object(
    'deviceId', v_id, 'storeId', v_store_id, 'label', v_label, 'enrolledBy', v_staff));

  -- The pairing secret is returned ONCE and never stored in clear.
  return jsonb_build_object(
    'deviceId', v_id, 'storeId', v_store_id, 'label', v_label,
    'pairingSecret', v_secret,
    'note', 'The pairing secret is shown once. The server stores only its hash.');
end $$;

revoke all on function enrol_till_device(jsonb) from public, anon;
grant execute on function enrol_till_device(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS7b.4  Quote DDL — request hash, reconciliation state, transition matrix
-- ----------------------------------------------------------------------------
alter table order_quotes add column if not exists quote_request_hash text;

comment on column order_quotes.quote_request_hash is
  'Canonical SHA-256 of the quote REQUEST (store, staff, channel, raw items, deals, id). A replayed quote id with a different basket is an idempotency_conflict, never a silent substitution.';

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'oq_status_controlled') then
    alter table order_quotes drop constraint oq_status_controlled;
  end if;
  alter table order_quotes add constraint oq_status_controlled check (
    status in ('OPEN','PAYMENT_PENDING','NEEDS_RECONCILIATION','CONSUMED','EXPIRED','CANCELLED')
  );
end $$;

-- The snapshot stays frozen; the lifecycle now moves through an EXPLICIT
-- transition matrix, which is what makes NEEDS_RECONCILIATION a one-way gate
-- into a privileged resolution rather than a state a client can wander out of.
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
     or new.staff_id is distinct from old.staff_id
     or new.channel is distinct from old.channel
     or new.store_vat_status is distinct from old.store_vat_status
     or new.vat_effective_date is distinct from old.vat_effective_date
     or new.allowed_payment_methods is distinct from old.allowed_payment_methods
     or new.config_version is distinct from old.config_version
     or new.quote_request_hash is distinct from old.quote_request_hash
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
  if new.status is distinct from old.status then
    if not (   (old.status = 'OPEN'
                and new.status in ('PAYMENT_PENDING','EXPIRED','CANCELLED'))
            or (old.status = 'PAYMENT_PENDING'
                and new.status in ('OPEN','EXPIRED','CONSUMED','NEEDS_RECONCILIATION'))
            or (old.status = 'NEEDS_RECONCILIATION'
                and new.status in ('CONSUMED','CANCELLED'))) then
      raise exception 'quote_status_transition_invalid' using errcode = '42501',
        detail = format('A quote cannot move %s → %s.', old.status, new.status);
    end if;
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- WS7b.5  Attempt DDL — bound route, resolution actor, complete FKs (item 7)
-- ----------------------------------------------------------------------------
alter table quote_payment_attempts add column if not exists terminal_config_id text;
alter table quote_payment_attempts add column if not exists online_account_id  text;
alter table quote_payment_attempts add column if not exists resolved_by_staff_id text;
alter table quote_payment_attempts add column if not exists resolved_via text;
alter table quote_payment_attempts add column if not exists resolved_at  timestamptz;

comment on column quote_payment_attempts.terminal_config_id is
  'CARD attempts: the registered terminal BOUND at reservation. Finalisation must use exactly this terminal.';
comment on column quote_payment_attempts.online_account_id is
  'ONLINE attempts: the registered provider account BOUND at reservation.';
comment on column quote_payment_attempts.resolved_by_staff_id is
  'Who resolved the attempt (finalised, released, or reconciled it). The reservation operator is recorded separately in operator_staff_id.';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'qpa_store_fkey') then
    alter table quote_payment_attempts add constraint qpa_store_fkey
      foreign key (store_id) references stores(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'qpa_cash_session_fkey') then
    alter table quote_payment_attempts add constraint qpa_cash_session_fkey
      foreign key (cash_session_id) references web_till_sessions(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'qpa_device_fkey') then
    alter table quote_payment_attempts add constraint qpa_device_fkey
      foreign key (device_id) references web_till_devices(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'qpa_completed_order_fkey') then
    alter table quote_payment_attempts add constraint qpa_completed_order_fkey
      foreign key (completed_order_id) references orders(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'qpa_terminal_fkey') then
    alter table quote_payment_attempts add constraint qpa_terminal_fkey
      foreign key (terminal_config_id) references payment_terminals(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'qpa_online_account_fkey') then
    alter table quote_payment_attempts add constraint qpa_online_account_fkey
      foreign key (online_account_id) references online_payment_accounts(id);
  end if;
  -- Every resolution names its actor and mechanism; a PENDING attempt has none.
  if exists (select 1 from pg_constraint where conname = 'qpa_resolved_coherent') then
    alter table quote_payment_attempts drop constraint qpa_resolved_coherent;
  end if;
  alter table quote_payment_attempts add constraint qpa_resolved_coherent check (
    (state <> 'PENDING' and resolved_by_staff_id is not null
       and resolved_via is not null and resolved_at is not null)
    or (state = 'PENDING' and resolved_by_staff_id is null
       and resolved_via is null and resolved_at is null)
  );
  if exists (select 1 from pg_constraint where conname = 'qpa_resolved_via_controlled') then
    alter table quote_payment_attempts drop constraint qpa_resolved_via_controlled;
  end if;
  alter table quote_payment_attempts add constraint qpa_resolved_via_controlled check (
    resolved_via is null or resolved_via in
      ('finalise','override_finalise','release','override_release','reconciliation')
  );
end $$;

-- The attempt trigger now enforces a FULL freeze after resolution: once the
-- state has left PENDING, NO column of the row may ever change again — the
-- terminal evidence (provider, merchant, terminal, reference, completed
-- order) is written once, atomically, in the resolving statement itself.
create or replace function enforce_attempt_identity_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.state <> 'PENDING' then
    if to_jsonb(new) is distinct from to_jsonb(old) then
      raise exception 'attempt_already_resolved' using errcode = '42501',
        detail = 'A resolved payment attempt is final: no column of it can ever change.';
    end if;
    return new;
  end if;
  if new.reservation_id is distinct from old.reservation_id
     or new.quote_id is distinct from old.quote_id
     or new.store_id is distinct from old.store_id
     or new.request_hash is distinct from old.request_hash
     or new.operator_staff_id is distinct from old.operator_staff_id
     or new.payment_method is distinct from old.payment_method
     or new.device_id is distinct from old.device_id
     or new.cash_session_id is distinct from old.cash_session_id
     or new.terminal_config_id is distinct from old.terminal_config_id
     or new.online_account_id is distinct from old.online_account_id
     or new.started_at is distinct from old.started_at
     or new.created_at is distinct from old.created_at then
    raise exception 'attempt_is_immutable' using errcode = '42501',
      detail = 'A payment attempt records what happened; its identity and bound route cannot be rewritten.';
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- WS7b.6  The completed-order ledger is CLOSED (correction 12)
-- ----------------------------------------------------------------------------
-- The effective baseline still carried orders_insert_owner_import,
-- orders_update_mgr and orders_delete_mgr, plus full write verbs for anon and
-- authenticated on orders and the line tables. While those existed, "every
-- completed order originates through finalise_order_payment()" was FALSE.
drop policy if exists orders_insert_owner_import on orders;
drop policy if exists orders_update_mgr on orders;
drop policy if exists orders_delete_mgr on orders;

revoke insert, update, delete on table orders               from anon, authenticated;
revoke insert, update, delete on table order_items          from anon, authenticated;
revoke insert, update, delete on table order_item_modifiers from anon, authenticated;
revoke all on table orders               from anon;
revoke all on table order_items          from anon;
revoke all on table order_item_modifiers from anon;

-- Honest payment vocabulary (correction 6). This system has NO payment
-- provider integration, so the database cannot say "captured": it can only
-- say what it actually knows.
--   CASH_RECORDED                   the operator counted cash against an open
--                                   custody session (first-party evidence);
--   OPERATOR_RECORDED_UNRECONCILED  a staff browser ASSERTED a card/online
--                                   result; the provider has not confirmed it;
--   PROVIDER_RECONCILED             matched against an independent settlement
--                                   record via reconcile_card_payment().
update orders set payment_status = 'OPERATOR_RECORDED_UNRECONCILED'
 where payment_status = 'captured';

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'orders_payment_status_controlled') then
    alter table orders drop constraint orders_payment_status_controlled;
  end if;
  alter table orders add constraint orders_payment_status_controlled check (
    payment_status is null or payment_status in
      ('CASH_RECORDED','OPERATOR_RECORDED_UNRECONCILED','PROVIDER_RECONCILED')
  );
end $$;

-- A completed order is a ledger row. The ONLY change it can ever accept is
-- the payment-status move to PROVIDER_RECONCILED, made by the reconciliation
-- RPC against settlement evidence. Everything else — for every role,
-- including service maintenance paths — is refused by trigger. Round 10A
-- (refunds / order state machine) will extend the allowed transitions in its
-- own append-only migration; nothing may pre-empt that here.
create or replace function enforce_order_ledger_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (to_jsonb(new) - 'payment_status') is distinct from (to_jsonb(old) - 'payment_status') then
    raise exception 'order_ledger_immutable' using errcode = '42501',
      detail = 'A completed order is a financial record; it cannot be edited.';
  end if;
  if new.payment_status is distinct from old.payment_status then
    if not (old.payment_status = 'OPERATOR_RECORDED_UNRECONCILED'
            and new.payment_status = 'PROVIDER_RECONCILED') then
      raise exception 'order_ledger_immutable' using errcode = '42501',
        detail = 'payment_status may only move OPERATOR_RECORDED_UNRECONCILED → PROVIDER_RECONCILED, via reconcile_card_payment().';
    end if;
  end if;
  return new;
end $$;

create or replace function enforce_order_ledger_no_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'order_ledger_immutable' using errcode = '42501',
    detail = 'A completed order is a financial record; it cannot be deleted.';
end $$;

drop trigger if exists trg_order_ledger_immutable on orders;
create trigger trg_order_ledger_immutable
  before update on orders
  for each row execute function enforce_order_ledger_immutable();

drop trigger if exists trg_order_ledger_no_delete on orders;
create trigger trg_order_ledger_no_delete
  before delete on orders
  for each row execute function enforce_order_ledger_no_delete();

-- ----------------------------------------------------------------------------
-- WS7b.7  payment_reconciliations — independent settlement evidence (item 6)
-- ----------------------------------------------------------------------------
create table if not exists payment_reconciliations (
  id                     text primary key,
  attempt_reservation_id text not null references quote_payment_attempts(reservation_id),
  order_id               text not null references orders(id),
  store_id               text not null references stores(id),
  provider               text not null,
  provider_reference     text not null,
  settlement_source      text not null,
  settled_amount         numeric(10,2) not null,
  settled_at             timestamptz not null,
  settlement_reference   text,
  evidence_hash          text not null,
  reason                 text,
  recorded_by_staff_id   text not null,
  created_at             timestamptz not null default now()
);

create unique index if not exists payment_reconciliations_one_per_attempt
  on payment_reconciliations (attempt_reservation_id);

comment on table payment_reconciliations is
  'Append-only record matching an operator-recorded card/online payment against an INDEPENDENT settlement source. Recording one is the only thing that may move an order to PROVIDER_RECONCILED.';

create or replace function enforce_reconciliation_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'reconciliation_immutable' using errcode = '42501',
    detail = 'Settlement evidence is append-only.';
end $$;

drop trigger if exists trg_reconciliation_immutable on payment_reconciliations;
create trigger trg_reconciliation_immutable
  before update or delete on payment_reconciliations
  for each row execute function enforce_reconciliation_immutable();

-- ----------------------------------------------------------------------------
-- WS7b.8  create_order_quote() v2 — request-hash idempotency + boundary cap
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

  return jsonb_build_object('quote', to_jsonb(v_row), 'duplicate', false);
end $$;

revoke all on function create_order_quote(jsonb) from public, anon;
grant execute on function create_order_quote(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS7b.9  begin_quote_payment() v2 — the reservation IS the authorisation
-- ----------------------------------------------------------------------------
-- "The server has validated this exact payment route; payment may now begin"
-- is now literally what this function proves before it reserves anything:
-- the method is allowed, the custody session is real / open / this store's /
-- this device's (and LOCKED, closing the close-vs-begin race), the terminal
-- or online account is real / active / this store's, and the route is BOUND
-- to the attempt so finalisation cannot substitute any part of it.
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
    if v_q.staff_id is distinct from v_staff then
      if v_override is null or not is_manager_or_owner() then
        raise exception 'operator_scope_denied' using errcode = '42501',
          detail = 'Another operator''s sale; a manager/owner override with a reason is required.';
      end if;
      perform log_payment_authority_event('payment_override:begin_replay', jsonb_build_object(
        'quoteId', v_q.id, 'creator', v_q.staff_id, 'overriddenBy', v_staff, 'reason', v_override));
    end if;
    select * into v_o from orders where quote_id = v_q.id;
    return jsonb_build_object('quote', to_jsonb(v_q), 'order', to_jsonb(v_o),
                              'state', 'already_consumed');
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

-- ----------------------------------------------------------------------------
-- WS7b.10  release_quote_payment() v2 — operator-owned and idempotent
-- ----------------------------------------------------------------------------
create or replace function release_quote_payment(p_release jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff    text := current_staff_id();
  v_me       staff_profiles%rowtype;
  v_q        order_quotes%rowtype;
  v_a        quote_payment_attempts%rowtype;
  v_res_id   text := p_release ->> 'reservationId';
  v_outcome  text := p_release ->> 'outcome';
  v_override text := nullif(trim(coalesce(p_release ->> 'overrideReason','')), '');
  v_target   text;
  v_via      text := 'release';
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if v_outcome not in ('declined','abandoned') then
    raise exception 'invalid_release_outcome'
      using detail = 'Only a DEFINITE decline or an abandonment before money moved may release a reservation.';
  end if;
  v_target := case when v_outcome = 'declined' then 'DECLINED' else 'ABANDONED' end;

  select * into v_q from order_quotes where id = p_release ->> 'quoteId' for update;
  if v_q.id is null then raise exception 'unknown_quote'; end if;
  if v_q.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;

  select * into v_a from quote_payment_attempts
   where reservation_id = v_res_id for update;
  if v_a.reservation_id is null or v_a.quote_id is distinct from v_q.id then
    raise exception 'idempotency_conflict' using errcode = '42501',
      detail = 'A reservation may only be released by the attempt that created it.';
  end if;

  -- Only the operator who reserved the payment may release it; anyone else
  -- needs an audited manager/owner override (correction 3).
  if v_a.operator_staff_id is distinct from v_staff then
    if v_override is null or not is_manager_or_owner() then
      raise exception 'operator_scope_denied' using errcode = '42501',
        detail = 'Another operator''s attempt; a manager/owner override with a reason is required.';
    end if;
    v_via := 'override_release';
    perform log_payment_authority_event('payment_override:release', jsonb_build_object(
      'quoteId', v_q.id, 'reservationId', v_res_id, 'operator', v_a.operator_staff_id,
      'overriddenBy', v_staff, 'reason', v_override, 'outcome', v_outcome));
  end if;

  if v_a.state = 'CONSUMED' then
    raise exception 'quote_already_consumed'
      using detail = 'This sale was completed; a completed payment cannot be released.';
  end if;
  if v_a.state in ('DECLINED','ABANDONED') then
    -- Idempotent replay (correction 9): the SAME release, repeated after a
    -- lost response, succeeds again. A DIFFERENT outcome is a different
    -- claim about what happened to the money, and conflicts.
    if v_a.state = v_target then
      return jsonb_build_object('quote', to_jsonb(v_q), 'state', v_q.status, 'duplicate', true);
    end if;
    raise exception 'release_outcome_conflict' using errcode = '42501',
      detail = 'That attempt was already released with a different outcome.';
  end if;

  if v_q.status <> 'PAYMENT_PENDING' or v_q.reservation_id is distinct from v_res_id then
    raise exception 'quote_not_reserved';
  end if;

  -- The attempt is resolved permanently — outcome, actor and mechanism in one
  -- atomic statement; the quote merely stops pointing at it.
  update quote_payment_attempts
     set state = v_target,
         released_at = now(), release_outcome = v_outcome,
         resolved_by_staff_id = v_staff, resolved_via = v_via, resolved_at = now()
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

  return jsonb_build_object('quote', to_jsonb(v_q), 'state', v_q.status, 'duplicate', false);
end $$;

revoke all on function release_quote_payment(jsonb) from public, anon;
grant execute on function release_quote_payment(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS7b.11  finalise_order_payment() v2 — bound route, honest status, windowed
-- ----------------------------------------------------------------------------
-- The core is shared with the privileged reconciliation path so the two can
-- never drift: one implementation of "record the sale from the snapshot".
-- It is NOT callable by any client role.
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
  v_quote_id  text := p_payment ->> 'quoteId';
  v_res_in    text := p_payment ->> 'reservationId';
  v_method    text := p_payment ->> 'method';
  v_ref       text := nullif(trim(coalesce(p_payment ->> 'providerReference','')), '');
  v_term_in   text := nullif(trim(coalesce(p_payment ->> 'terminalConfigId','')), '');
  v_acct_in   text := nullif(trim(coalesce(p_payment ->> 'onlineAccountId','')), '');
  v_sess_in   text := nullif(trim(coalesce(p_payment ->> 'tillSessionId','')), '');
  v_dev_in    text := nullif(trim(coalesce(p_payment ->> 'deviceId','')), '');
  v_override  text := nullif(trim(coalesce(p_payment ->> 'overrideReason','')), '');
  v_customer  text := nullif(trim(coalesce(p_payment ->> 'customerName','')), '');
  v_paid_raw  text := nullif(p_payment ->> 'paidAt','');
  v_paid_at   timestamptz;
  v_cash_p    bigint := case when nullif(p_payment ->> 'cashReceived','') is not null
                        then round((p_payment ->> 'cashReceived')::numeric * 100)::bigint end;
  v_appr_p    bigint := case when nullif(p_payment ->> 'approvedAmount','') is not null
                        then round((p_payment ->> 'approvedAmount')::numeric * 100)::bigint end;
  v_change_p  bigint;
  v_q         order_quotes%rowtype;
  v_att       quote_payment_attempts%rowtype;
  v_s         web_till_sessions%rowtype;
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
  v_paid_at := coalesce(v_paid_raw::timestamptz, now());

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
    -- only reconcile_card_payment() — against an independent settlement
    -- record — may upgrade it (correction 6).
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
      -- A terminal retired mid-payment does not orphan the sale: it was
      -- validated ACTIVE when the payment was authorised to begin.
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
     v_q.id, case when v_method = 'cash' then v_att.cash_session_id else null end,
     v_pay_status, v_ref, v_paid_at,
     case when v_change_p is null then null else v_change_p / 100.0 end)
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

create or replace function finalise_order_payment(p_payment jsonb)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select finalise_order_payment_core(p_payment, false, null);
$$;

revoke all on function finalise_order_payment(jsonb) from public, anon;
grant execute on function finalise_order_payment(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS7b.12  cancel_order_quote() v2 — OPEN only, creator-owned, idempotent
-- ----------------------------------------------------------------------------
create or replace function cancel_order_quote(p_quote jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff    text := current_staff_id();
  v_me       staff_profiles%rowtype;
  v_q        order_quotes%rowtype;
  v_override text := nullif(trim(coalesce(p_quote ->> 'overrideReason','')), '');
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_q from order_quotes where id = p_quote ->> 'quoteId' for update;
  if v_q.id is null then raise exception 'unknown_quote'; end if;
  if v_q.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;
  if v_q.staff_id is distinct from v_staff then
    if v_override is null or not is_manager_or_owner() then
      raise exception 'operator_scope_denied' using errcode = '42501',
        detail = 'Another operator''s quote; a manager/owner override with a reason is required.';
    end if;
    perform log_payment_authority_event('payment_override:cancel', jsonb_build_object(
      'quoteId', v_q.id, 'creator', v_q.staff_id, 'overriddenBy', v_staff, 'reason', v_override));
  end if;
  if v_q.status = 'CONSUMED' then raise exception 'quote_already_consumed'; end if;
  if v_q.status = 'CANCELLED' then
    -- Idempotent replay (correction 9): the historical cancellation time is
    -- never rewritten by a repeated request.
    return jsonb_build_object('quote', to_jsonb(v_q), 'duplicate', true);
  end if;
  -- Cancellation is restricted to OPEN (correction 4). A PAYMENT_PENDING
  -- quote may already have taken the customer's money: it must be finalised,
  -- definitely released, or moved into reconciliation — never destroyed.
  if v_q.status = 'PAYMENT_PENDING' then
    raise exception 'quote_payment_pending' using errcode = '42501',
      detail = 'An active payment reservation must be finalised, released, or reconciled — it cannot be cancelled away.';
  end if;
  if v_q.status = 'NEEDS_RECONCILIATION' then
    raise exception 'quote_needs_reconciliation'
      using detail = 'This quote is awaiting privileged payment reconciliation.';
  end if;
  if v_q.status <> 'OPEN' then
    raise exception 'quote_not_open';
  end if;
  update order_quotes set status = 'CANCELLED', cancelled_at = now()
   where id = v_q.id returning * into v_q;
  return jsonb_build_object('quote', to_jsonb(v_q), 'duplicate', false);
end $$;

revoke all on function cancel_order_quote(jsonb) from public, anon;
grant execute on function cancel_order_quote(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS7b.13  open_till_session() v2 — custody opens with a device CREDENTIAL
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
  v_device text := nullif(trim(coalesce(p_session ->> 'deviceId','')), '');
  v_secret text := nullif(p_session ->> 'deviceSecret', '');
  v_float  numeric := coalesce(nullif(p_session ->> 'openingFloat','')::numeric, 0);
  v_dev    web_till_devices%rowtype;
  v_row    web_till_sessions%rowtype;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if v_me.store_id is null then raise exception 'store_scope_denied' using errcode = '42501'; end if;
  if p_session ? 'id' then
    raise exception 'invalid_session'
      using detail = 'Session ids are server-generated; the client no longer supplies one.';
  end if;
  if v_device is null then raise exception 'invalid_session'; end if;
  if v_float < 0 then raise exception 'invalid_opening_float'; end if;

  -- A till device is a CUSTODY IDENTITY, not a self-declared label
  -- (correction 10): it must have been enrolled by a manager or owner, and
  -- the caller must hold its server-issued pairing secret.
  select * into v_dev from web_till_devices where id = v_device;
  if v_dev.id is null or v_dev.credential_hash is null then
    raise exception 'device_not_enrolled' using errcode = '42501',
      detail = 'This device has not been enrolled by a manager or owner.';
  end if;
  if v_dev.revoked then
    raise exception 'till_device_revoked' using errcode = '42501';
  end if;
  if v_dev.store_id is distinct from v_me.store_id then
    raise exception 'device_store_mismatch' using errcode = '42501';
  end if;
  if v_secret is null
     or encode(sha256(convert_to(v_secret, 'utf8')), 'hex') is distinct from v_dev.credential_hash then
    raise exception 'device_credential_invalid' using errcode = '42501',
      detail = 'The pairing secret does not match this device.';
  end if;

  select * into v_row from web_till_sessions
   where device_id = v_device and status = 'OPEN';
  if v_row.id is not null then
    return jsonb_build_object('session', to_jsonb(v_row), 'duplicate', true);
  end if;

  begin
    insert into web_till_sessions
      (id, store_id, device_id, status, opened_by_staff_id, opening_float)
    values ('wts_' || replace(gen_random_uuid()::text, '-', ''),
            v_me.store_id, v_device, 'OPEN', v_staff, v_float)
    returning * into v_row;
  exception when unique_violation then
    -- Two concurrent opens on one device: custody is exclusive, so the loser
    -- receives the winner's session idempotently.
    select * into v_row from web_till_sessions
     where device_id = v_device and status = 'OPEN';
    return jsonb_build_object('session', to_jsonb(v_row), 'duplicate', true);
  end;
  return jsonb_build_object('session', to_jsonb(v_row), 'duplicate', false);
end $$;

revoke all on function open_till_session(jsonb) from public, anon;
grant execute on function open_till_session(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS7b.14  expire_stale_quotes() — bookkeeping in its OWN transaction
-- ----------------------------------------------------------------------------
-- Logical expiry (expires_at) and the recovery window (payment_started_at +
-- 24h) are authoritative in every RPC above. This function persists the
-- corresponding statuses so reports and screens agree — it can be run by any
-- staff session or a scheduler, its effects are entirely clock-determined,
-- and it is the ONLY writer of EXPIRED and NEEDS_RECONCILIATION.
create or replace function expire_stale_quotes()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff text := current_staff_id();
  v_exp int;
  v_rec int;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  update order_quotes set status = 'EXPIRED'
   where status = 'OPEN' and expires_at < now();
  get diagnostics v_exp = row_count;
  update order_quotes set status = 'NEEDS_RECONCILIATION'
   where status = 'PAYMENT_PENDING'
     and payment_started_at + interval '24 hours' < now();
  get diagnostics v_rec = row_count;
  return jsonb_build_object('expired', v_exp, 'movedToReconciliation', v_rec);
end $$;

revoke all on function expire_stale_quotes() from public, anon;
grant execute on function expire_stale_quotes() to authenticated;

-- ----------------------------------------------------------------------------
-- WS7b.15  resolve_payment_reconciliation() — the privileged dead-end exit
-- ----------------------------------------------------------------------------
-- The 24-hour window previously made a delayed-but-PAID transaction
-- permanently unrecordable. Now it makes it PRIVILEGED: a manager or owner
-- with an MFA-verified session, a written reason, and an immutable audit row
-- either records the order (through the SAME finalisation core) or
-- definitively voids the attempt. Nothing else can leave NEEDS_RECONCILIATION.
create or replace function resolve_payment_reconciliation(p_resolution jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff   text := current_staff_id();
  v_me      staff_profiles%rowtype;
  v_action  text := p_resolution ->> 'action';
  v_reason  text := nullif(trim(coalesce(p_resolution ->> 'reason','')), '');
  v_res_id  text := p_resolution ->> 'reservationId';
  v_q       order_quotes%rowtype;
  v_a       quote_payment_attempts%rowtype;
  v_result  jsonb;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if not is_manager_or_owner() then
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

  select * into v_q from order_quotes
   where id = p_resolution ->> 'quoteId' for update;
  if v_q.id is null then raise exception 'unknown_quote'; end if;
  if not is_owner() and v_q.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
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
           released_at = now(), release_reason = 'reconciled_void'
     where id = v_q.id returning * into v_q;
    perform log_payment_authority_event('payment_reconciliation:void', jsonb_build_object(
      'quoteId', v_q.id, 'reservationId', v_res_id, 'reason', v_reason, 'resolvedBy', v_staff));
    return jsonb_build_object('quote', to_jsonb(v_q), 'resolution', 'void');
  end if;

  -- The payment DID happen: record the sale through the one finalisation
  -- core, from the stored snapshot, with the bound route.
  v_result := finalise_order_payment_core(
    coalesce(p_resolution -> 'payment', '{}'::jsonb)
      || jsonb_build_object('quoteId', v_q.id, 'reservationId', v_res_id),
    true, v_reason);
  perform log_payment_authority_event('payment_reconciliation:record_order', jsonb_build_object(
    'quoteId', v_q.id, 'reservationId', v_res_id, 'reason', v_reason,
    'resolvedBy', v_staff, 'orderId', v_result -> 'order' ->> 'id'));
  return v_result || jsonb_build_object('resolution', 'record_order');
end $$;

revoke all on function resolve_payment_reconciliation(jsonb) from public, anon;
grant execute on function resolve_payment_reconciliation(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS7b.16  reconcile_card_payment() — independent settlement evidence
-- ----------------------------------------------------------------------------
create or replace function reconcile_card_payment(p_settlement jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff   text := current_staff_id();
  v_me      staff_profiles%rowtype;
  v_res_id  text := p_settlement ->> 'reservationId';
  v_order_in text := p_settlement ->> 'orderId';
  v_a       quote_payment_attempts%rowtype;
  v_o       orders%rowtype;
  v_source  text := nullif(trim(coalesce(p_settlement ->> 'settlementSource','')), '');
  v_amt_raw text := nullif(p_settlement ->> 'settledAmount','');
  v_at_raw  text := nullif(p_settlement ->> 'settledAt','');
  v_sref    text := nullif(trim(coalesce(p_settlement ->> 'settlementReference','')), '');
  v_reason  text := nullif(trim(coalesce(p_settlement ->> 'reason','')), '');
  v_amt_p   bigint;
  v_hash    text;
  v_existing payment_reconciliations%rowtype;
  v_row     payment_reconciliations%rowtype;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if not is_manager_or_owner() then
    raise exception 'reconciliation_denied' using errcode = '42501',
      detail = 'Settlement reconciliation requires a manager or owner with an MFA-verified session.';
  end if;

  if v_res_id is null and v_order_in is not null then
    select * into v_a from quote_payment_attempts
     where completed_order_id = v_order_in for update;
  else
    select * into v_a from quote_payment_attempts
     where reservation_id = v_res_id for update;
  end if;
  if v_a.reservation_id is null then
    raise exception 'invalid_reservation'
      using detail = 'No such consumed payment attempt.';
  end if;
  if not is_owner() and v_a.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;
  if v_a.state <> 'CONSUMED' then
    raise exception 'attempt_not_consumed'
      using detail = 'Only a completed payment can be reconciled against settlement.';
  end if;
  if v_a.payment_method = 'cash' then
    raise exception 'cash_not_provider_reconciled'
      using detail = 'Cash is reconciled through drawer counts, not provider settlement.';
  end if;

  select * into v_o from orders where id = v_a.completed_order_id for update;

  if v_source is null or v_amt_raw is null or v_at_raw is null then
    raise exception 'settlement_evidence_required'
      using detail = 'A settlement source, settled amount and settlement time are required.';
  end if;
  v_amt_p := round(v_amt_raw::numeric * 100)::bigint;

  v_hash := canonical_request_hash(jsonb_build_object(
    'op', 'reconcile_card_payment', 'reservationId', v_a.reservation_id,
    'settlementSource', v_source, 'settledAmountP', v_amt_p,
    'settledAt', v_at_raw, 'settlementReference', v_sref));

  select * into v_existing from payment_reconciliations
   where attempt_reservation_id = v_a.reservation_id;
  if v_existing.id is not null then
    if v_existing.evidence_hash = v_hash then
      return jsonb_build_object('reconciliation', to_jsonb(v_existing), 'duplicate', true);
    end if;
    raise exception 'idempotency_conflict' using errcode = '42501',
      detail = 'This payment was already reconciled against different settlement evidence.';
  end if;

  if v_amt_p is distinct from round(v_o.total * 100)::bigint then
    raise exception 'settlement_amount_mismatch'
      using detail = 'The settled amount must equal the recorded order total; discrepancies are a Round-10A financial-actions concern.';
  end if;

  insert into payment_reconciliations
    (id, attempt_reservation_id, order_id, store_id, provider, provider_reference,
     settlement_source, settled_amount, settled_at, settlement_reference,
     evidence_hash, reason, recorded_by_staff_id)
  values
    ('rec_' || replace(gen_random_uuid()::text, '-', ''),
     v_a.reservation_id, v_o.id, v_a.store_id, v_a.payment_provider,
     v_a.provider_reference, v_source, v_amt_p / 100.0, v_at_raw::timestamptz,
     v_sref, v_hash, v_reason, v_staff)
  returning * into v_row;

  update orders set payment_status = 'PROVIDER_RECONCILED' where id = v_o.id;

  perform log_payment_authority_event('payment_reconciliation:provider_settled',
    jsonb_build_object('orderId', v_o.id, 'reservationId', v_a.reservation_id,
                       'settlementSource', v_source, 'recordedBy', v_staff));

  return jsonb_build_object('reconciliation', to_jsonb(v_row),
                            'orderPaymentStatus', 'PROVIDER_RECONCILED',
                            'duplicate', false);
end $$;

revoke all on function reconcile_card_payment(jsonb) from public, anon;
grant execute on function reconcile_card_payment(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- WS7b.17  RLS + grants for the new registries
-- ----------------------------------------------------------------------------
alter table online_payment_accounts  enable row level security;
alter table payment_reconciliations  enable row level security;

revoke all on table online_payment_accounts from anon, authenticated;
revoke all on table payment_reconciliations from anon, authenticated;
grant select on table online_payment_accounts to authenticated;
grant select on table payment_reconciliations to authenticated;

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'online_payment_accounts_select_store') then
    create policy online_payment_accounts_select_store on online_payment_accounts
      for select to authenticated
      using (is_owner() or store_id = current_staff_store());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'payment_reconciliations_select_store') then
    create policy payment_reconciliations_select_store on payment_reconciliations
      for select to authenticated
      using (is_owner() or store_id = current_staff_store());
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE (proven live by matrix §§21, 23, 24 and the concurrency suite):
--   • A reservation is refused unless its entire route is real, active,
--     store-correct and (for cash) locked open — and the route is BOUND.
--   • Finalisation cannot substitute any bound fact, and a consumed replay
--     needs the exact reservation, the exact canonical claim, and either the
--     original operator or an audited override.
--   • A stale configuration or a crossed VAT boundary refuses payment; a
--     quote can never outlive a scheduled charging boundary.
--   • Cancellation is OPEN-only; release and cancellation replay
--     idempotently; a repeated cancel never rewrites history.
--   • Past the 24-hour window a payment moves to NEEDS_RECONCILIATION and is
--     resolved ONLY by manager/owner + MFA + reason + audit — recorded via
--     the same finalisation core, or definitively voided.
--   • Orders say what the database knows: CASH_RECORDED,
--     OPERATOR_RECORDED_UNRECONCILED, or PROVIDER_RECONCILED against
--     independent settlement evidence. "captured" no longer exists.
--   • A resolved attempt is 100% frozen; every attempt reference is a
--     foreign key; a completed order can never be updated or deleted, by any
--     role, and the browser write policies and verbs are gone.
--   • Cash custody devices are server-enrolled with a pairing secret;
--     sessions are server-identified; expiry is derived, and its persisted
--     bookkeeping is written only by expire_stale_quotes().
-- ============================================================================
