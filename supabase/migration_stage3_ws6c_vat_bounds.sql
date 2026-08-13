-- ============================================================================
-- STAGE 3 / WS6c — VAT RATE BOUNDS (round-6b Finding 5; closure brief §4)
-- ============================================================================
-- The UI capped the configurable rate at 50; the DATABASE accepted anything —
-- including -100, which divides by zero inside the VAT-inclusive formula
-- rate/(100+rate). Both the setting and every order's rate SNAPSHOT are now
-- bounded. The full VAT lifecycle (NOT_REGISTERED launch status, product tax
-- classifications, line-level snapshots, consumption mode) lands with the
-- closure-brief §1 round and its submit_web_order() re-issue.
-- ============================================================================
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'site_settings_vat_rate_bounds') then
    alter table site_settings add constraint site_settings_vat_rate_bounds check (
      vat_rate_percent >= 0 and vat_rate_percent <= 100
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_tax_rate_bounds') then
    alter table orders add constraint orders_tax_rate_bounds check (
      tax_rate >= 0 and tax_rate <= 100
    );
  end if;
end $$;
