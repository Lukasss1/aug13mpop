-- ============================================================================
-- STAGE 3 / WS6g — STORE SETUP OPERATIONAL CLOSURE (Round 9e)
-- ============================================================================
-- The Round-9d review held Round 10A and required the §1 OPERATIONAL blockers
-- to be closed first: faults that let a cashier take payment for a sale the
-- server will reject, or that advertise/accept configuration the platform
-- cannot honour. This migration carries the two DATABASE-side items; the
-- other four are client-side in the same round.
--
--   ITEM 2  GIFT CARD OUT OF THE LAUNCH VOCABULARY. gift_card remains a
--           payment_method enum value (POS imports and future work), but no
--           store may CONFIGURE it until genuine balance validation and
--           redemption exist. Enforced at the RPC (unsupported_payment_method)
--           and at the database (stores_payment_methods_supported). Because
--           submit_web_order already refuses any method outside the store's
--           configured set, closing configuration closes the sale path.
--   ITEM 5  THE PUBLIC VIEW SHOWS DELIBERATELY PUBLIC STORES ONLY. stores_public
--           now exposes only setup-ACTIVE stores — a store that has not
--           completed setup cannot trade, so advertising it invites a journey
--           that dead-ends — and drops the internal row timestamps
--           (created_at/updated_at), which are setup bookkeeping, not locator
--           data. The client discards them anyway (stripDbFields).
--
-- Idempotent; fails closed; appended via MP_FUTURE_MIGRATIONS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- WS6g.1  Launch payment vocabulary (item 2)
-- ----------------------------------------------------------------------------
-- Existing configurations are reconciled BEFORE the constraint lands. A store
-- left with no usable method cannot be silently "fixed" with invented
-- configuration, so it returns to DRAFT and the owner must reconfigure —
-- fail-closed, consistent with the WS6e lifecycle.
-- ONE STATEMENT, deliberately. stores_setup_coherent is a plain CHECK, so it
-- is evaluated per row AS THIS STATEMENT RUNS — not at end of transaction.
-- Stripping the method in one statement and demoting in a second would leave
-- an ACTIVE row holding an empty method set in between, and the CHECK would
-- abort the migration on any store whose ONLY method was gift_card. Both
-- columns therefore move together: such a row goes straight from
-- ACTIVE/["gift_card"] to DRAFT/null and is never momentarily incoherent.
update stores
   set payment_methods = nullif(payment_methods - 'gift_card', '[]'::jsonb),
       setup_status    = case
                           when jsonb_array_length(payment_methods - 'gift_card') = 0
                             then 'DRAFT'
                           else setup_status
                         end
 where payment_methods ? 'gift_card';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stores_payment_methods_supported') then
    alter table stores add constraint stores_payment_methods_supported check (
      payment_methods is null or not (payment_methods ? 'gift_card')
    );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- WS6g.2  configure_store_setup() — re-issue (+ unsupported_payment_method)
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
-- WS6g.3  stores_public — deliberately public stores only (item 5)
-- ----------------------------------------------------------------------------
-- A view cannot drop columns in place; recreate it and restore the grants.
drop view if exists stores_public;

create view stores_public as
  select id, name, address, postcode, opening_hours, status, delivery_links,
         phone, email, image, coordinates
    from stores
   where setup_status = 'ACTIVE';

revoke all on stores_public from public;
grant select on stores_public to anon, authenticated;

comment on view stores_public is
  'The anonymous locator surface: setup-ACTIVE stores only, locator columns only. Internal setup/VAT columns and row timestamps are deliberately absent; the base table is not anon-readable.';

-- ----------------------------------------------------------------------------
-- ACCEPTANCE (proven live by matrix §19):
--   • The wizard refuses a gift_card configuration (unsupported_payment_method)
--     and a privileged direct write is refused by the CHECK; a store that
--     previously carried gift_card no longer does.
--   • stores_public excludes DRAFT stores and no longer exposes created_at /
--     updated_at; anon still cannot read the base table.
-- ============================================================================
