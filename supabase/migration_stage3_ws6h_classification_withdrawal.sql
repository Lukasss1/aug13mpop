-- ============================================================================
-- STAGE 3 / WS6h — CLASSIFICATION WITHDRAWAL GUARD (Round 9f)
-- ============================================================================
-- Round-9e audit finding 4. The till blocks an unclassified product before
-- payment, but only as accurately as its LOCAL catalogue: the web till keeps
-- a durable offline outbox, so a till holding an older copy would still show
-- a since-unclassified product as sellable, take the money, and only then be
-- refused by the server.
--
-- The narrow, honest fix is at the source: while any store is actually
-- CHARGING, a product that currently HAS a classification cannot have it
-- removed. Classifying an unclassified product, or moving one code to
-- another, remain freely available — those never turn a sellable product
-- into an unsellable one. Withdrawal is what strands a till, and the owner's
-- path for that is to withdraw the product from sale first.
--
-- Idempotent; fails closed; appended via MP_FUTURE_MIGRATIONS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- WS6h.1  classify_products() — re-issue (+ cannot_unclassify_while_charging)
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
    -- WS6h (Round-9e audit finding 4): UNCLASSIFYING is the one classification
    -- move that can strand a till. Tills hold a local catalogue and a durable
    -- offline outbox, so a copy that still shows the product as classified
    -- will happily take payment after the owner removes the classification —
    -- and the server then refuses the sale. While ANY store is actually
    -- charging (REGISTERED with an arrived effective date in ITS OWN
    -- timezone), a sellable product cannot be returned to unclassified.
    -- Classifying and RE-classifying stay open; only the removal is barred.
    if v_code is null
       and exists (select 1 from menu_items where id = v_id and tax_code is not null)
       and exists (
         select 1 from stores s
          where s.vat_status = 'REGISTERED'
            and s.vat_registration_effective_date
                <= (now() at time zone coalesce(s.timezone, 'Europe/London'))::date)
    then
      raise exception 'cannot_unclassify_while_charging'
        using detail = 'A VAT-charging store is trading. Withdraw the product from sale before removing its classification.';
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
-- ACCEPTANCE (proven live by matrix §20):
--   • While a store is charging: removing a classification raises
--     cannot_unclassify_while_charging; setting one, and changing one code
--     for another, still succeed.
--   • With no store charging (the launch position, or a future-dated
--     registration): withdrawal is permitted again.
-- ============================================================================
