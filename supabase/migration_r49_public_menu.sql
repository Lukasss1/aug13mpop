-- ============================================================================
--  migration_r49_public_menu.sql
--  R4.9 · Gate G4 — THE PUBLIC MENU FAILS CLOSED (database half)
-- ============================================================================
--  R4.8 added menu_items.available and a trigger that gates the transition to
--  available, but anonymous visitors still read the BASE TABLE, so an
--  unavailable product was still on the wire and the browser was the only thing
--  deciding whether to render it. This migration moves the anonymous surface
--  behind a view, exactly as WS6f did for the store locator with stores_public:
--
--    • the view exposes ONLY available rows, and only customer-facing columns;
--    • the base table is revoked from anon entirely;
--    • a view runs with its OWNER's rights, so the anon role cannot reach the
--      hidden rows by any route — the filter is not advisory.
--
--  DELIBERATELY NOT INCLUDED
--    tax_code — internal VAT classification, never customer data. It has never
--    belonged on the anonymous surface; moving the surface is the moment to stop
--    shipping it.
--
--    product_allergen_declarations — the R4.8 allergen register is real but
--    UNCOMMISSIONED (its approval function is Phase 2 work and the table is
--    empty). Joining it now would build machinery against data that does not
--    exist. The public page's honest-display behaviour already handles both the
--    present and the absent case; the declaration join lands when approvals do.
--
--  CONSUMERS UPDATED IN THE SAME CHANGE (both use the anon key):
--    • src/lib/cloudSync.ts     — runtime SPA read  (readTable)
--    • scripts/load-public-content.ts — build-time prerender read
--  Repointing one without the other is precisely the defect this round found in
--  the store locator, where WS6f revoked the base table and left the build-time
--  loader pointing at it.
-- ============================================================================

create or replace view menu_items_public as
  select id, name, description, category, price, price_large, calories,
         tags, allergens, image, available, created_at, updated_at
    from menu_items
   where available;

revoke all on menu_items_public from public;
grant select on menu_items_public to anon, authenticated;

-- The anonymous role loses the base table. Staff (authenticated) keep it: the
-- admin surface must still see unavailable products in order to manage them.
revoke select on table menu_items from anon;

comment on view menu_items_public is
  'R4.9 G4: the anonymous menu surface. Available products only, customer-facing columns only; tax_code and the internal timestamps of unavailable rows are unreachable because the base table is not anon-readable. Mirrors stores_public.';
