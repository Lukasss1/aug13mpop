-- ============================================================================
-- STAGE 3 / WS6i — CLASSIFICATION PERMANENCE + SERIALISATION (Round 9g)
-- ============================================================================
-- The Round-9f review found the WS6h withdrawal guard genuinely incomplete:
--
--   F1  TIME COULD BREAK A VALID DATABASE. The guard keyed on "currently
--       charging". Under a FUTURE-dated registration a product could be
--       unclassified legally, and when the effective date arrived the store
--       began charging with an unclassified product — no transaction exists
--       at midnight to revalidate completeness.
--   F2  THE INVARIANT WAS BYPASSABLE. It lived only in classify_products(),
--       while trg_menu_tax_code_guard still admitted any aal2 OWNER writing
--       menu_items.tax_code directly through PostgREST. An invariant that
--       depends on the owner choosing the preferred RPC is not an invariant.
--   F3  NO SERIALISATION. configure_store_setup() counted unclassified
--       products and then registered; classify_products() checked state and
--       then wrote. Separate transactions, no shared lock, so two owner
--       sessions could interleave and both commit.
--   F5  THE DOCUMENTED WORKFLOW DID NOT EXIST. The old error told the owner
--       to "withdraw the product from sale first", but menu_items has no
--       sellability state to withdraw it into.
--
-- DECISION (F5, and it dissolves F1): a VAT classification is PERMANENT
-- HISTORICAL METADATA. Once set it may be changed to another controlled code
-- but never returned to unclassified. Nothing about this rule depends on
-- registration status, effective dates or the passage of time, so there is no
-- longer a state the clock can invalidate. The escapes are honest ones:
-- reclassify (including to OUTSIDE_SCOPE), or delete the product.
--
-- PLACEMENT (F2): the invariant now lives in the TRIGGER, ahead of the
-- authority ladder, so it binds every API writer — the owner's direct
-- PostgREST update, the classify RPC's own GUC, and the service role alike.
-- Only a non-API session (a migration or an operator holding real database
-- credentials, where request.jwt.claims is unset) can repair data; that is
-- the deliberate, auditable repair path, not an application capability.
--
-- Idempotent; fails closed; appended via MP_FUTURE_MIGRATIONS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- WS6i.1  trg_menu_tax_code_guard — the invariant moves INTO the trigger (F2)
-- ----------------------------------------------------------------------------
create or replace function enforce_menu_tax_code_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.tax_code is not distinct from old.tax_code then
    return new;
  end if;

  -- THE INVARIANT, ahead of every authority branch: a classification, once
  -- set, cannot be removed by ANY API writer — owner, classify RPC or
  -- service role. Non-API sessions (claims unset: migrations, DBA repair)
  -- remain the single documented escape.
  if tg_op = 'UPDATE'
     and old.tax_code is not null
     and new.tax_code is null
     and nullif(current_setting('request.jwt.claims', true), '') is not null
  then
    raise exception 'tax_code_withdrawal_forbidden' using errcode = '42501',
      detail = 'A product''s VAT classification is permanent once set: change it to another code, or delete the product.';
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
-- WS6i.2  classify_products() — re-issue (permanence + shared lock)
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
  -- WS6i (finding 3): serialise against store registration. configure_store_setup
  -- counts unclassified products and then registers; without a shared lock the
  -- two checks run in separate transactions and could interleave. Both take
  -- this transaction-scoped lock, so completeness cannot be validated by one
  -- session while the other changes it.
  perform pg_advisory_xact_lock(hashtext('milkpop.vat_classification'));
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
    -- WS6i (Round-9f findings 1/2/5): a classification, once set, is
    -- PERMANENT HISTORICAL METADATA. It may be changed to another controlled
    -- code, but never removed. The previous rule keyed on "currently
    -- charging", which let a product be unclassified under a FUTURE-dated
    -- registration and then broke by itself when the date arrived — no
    -- transaction exists at midnight to revalidate. Time can no longer move
    -- this database from a valid state to an invalid one.
    if v_code is null
       and exists (select 1 from menu_items where id = v_id and tax_code is not null)
    then
      raise exception 'tax_code_withdrawal_forbidden'
        using detail = 'A product''s VAT classification is permanent once set: change it to another code, or delete the product. It cannot be returned to unclassified.';
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
-- WS6i.3  configure_store_setup() — re-issue (shared lock, F3)
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
  -- WS6i (finding 3): the SAME lock classify_products takes, so a registration
  -- and a classification change can never validate against each other's
  -- pre-state and both commit.
  perform pg_advisory_xact_lock(hashtext('milkpop.vat_classification'));
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
  -- WS6g (Round-9e item 2): gift_card is OUT of the launch vocabulary. The
  -- till would record a gift-card payment with no balance validation and no
  -- redemption — an unverified money movement. Structurally shaped methods
  -- outside the supported launch set are refused here and by the CHECK.
  if v_methods ? 'gift_card' then
    raise exception 'unsupported_payment_method'
      using detail = 'gift_card is not available at launch: balance validation and redemption are not implemented.';
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
-- WS6i.4  store_trading_state() — server-authoritative trading facts (F4)
-- ----------------------------------------------------------------------------
-- The browser derives its business date from the DEVICE clock. A wrong tablet
-- clock disagrees with the server, and because the till may accept payment
-- optimistically the disagreement can surface after money is taken. This
-- read-only RPC lets the till ask the database what is true RIGHT NOW —
-- called on mount, at the business-day boundary, and immediately before
-- payment whenever the till is online. Offline, the till falls back to its
-- local computation and the outbox reconciles, exactly as before.
create or replace function store_trading_state(p_store_id text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_s      stores%rowtype;
  v_today  date;
  v_uncls  int;
begin
  select * into v_s from stores where id = p_store_id;
  if v_s.id is null then
    raise exception 'unknown_store';
  end if;
  if not (is_owner() or p_store_id = current_staff_store()) then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;

  v_today := (now() at time zone coalesce(v_s.timezone, 'Europe/London'))::date;
  select count(*) into v_uncls from menu_items where tax_code is null;

  return jsonb_build_object(
    'storeId',           v_s.id,
    'businessDate',      v_today,
    'vatChargingNow',    (v_s.vat_status = 'REGISTERED'
                          and v_s.vat_registration_effective_date <= v_today),
    'vatStatus',         v_s.vat_status,
    'vatEffectiveDate',  v_s.vat_registration_effective_date,
    'setupStatus',       v_s.setup_status,
    'paymentMethods',    v_s.payment_methods,
    'unclassifiedCount', v_uncls,
    -- Cheap change detector: any edit to the store's configuration or to the
    -- catalogue's classifications changes this string, so the till can tell
    -- that VAT-relevant state moved without diffing everything.
    'configVersion',     md5(coalesce(v_s.setup_status,'') || '|' || coalesce(v_s.vat_status,'') || '|'
                          || coalesce(v_s.vat_registration_effective_date::text,'') || '|'
                          || coalesce(v_s.payment_methods::text,'') || '|'
                          || coalesce(v_s.timezone,'') || '|' || coalesce(v_s.currency_code,'') || '|'
                          || coalesce((select string_agg(id || '=' || coalesce(tax_code,'∅'), ',' order by id)
                                         from menu_items), ''))
  );
end $$;

revoke all on function store_trading_state(text) from public, anon;
grant execute on function store_trading_state(text) to authenticated;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE (proven live by matrix §21):
--   • Withdrawal is refused for the owner through the RPC AND through a
--     DIRECT PostgREST update, under a future-dated registration, under an
--     arrived one, and with no registration at all. Re-classification and
--     first-time classification remain available throughout.
--   • A non-API session (migration/DBA) can still repair a row.
--   • Both RPCs take the same advisory lock (registration and classification
--     can no longer validate against each other's pre-state).
--   • store_trading_state returns the server's business date and charging
--     flag, is store-scoped, and its configVersion moves when either the
--     store configuration or a classification changes.
-- ============================================================================
