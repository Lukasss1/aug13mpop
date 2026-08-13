-- ============================================================================
--  MILK POP — MIGRATION FIX-2b: EXPLODE TRIGGER GETS ITS DECLARED CONTEXT
--
--  Run order: after migration_fix7_sensitive_collections.sql.
--  Safe to re-run. migration_phase_b_public_forms.sql stays LAST.
--
--  PROBLEM (found by live RLS proof of FIX-2 against real Postgres 16):
--  migration_rls_per_role.sql §6 documents that order_items /
--  order_item_modifiers "are written only by the explode trigger (SECURITY
--  DEFINER context of the table owner)" and therefore exposes them
--  READ-ONLY to staff. But schema.sql never actually declared
--  explode_order_items() as SECURITY DEFINER — a plain plpgsql trigger runs
--  as the INVOKER, and with no INSERT policy on order_items every
--  authenticated web-till order INSERT aborts inside the trigger:
--
--      ERROR: new row violates row-level security policy for "order_items"
--
--  The native till never noticed because pos-ingest writes under the
--  service context (BYPASSRLS). The authed web-till path — the one FIX-2's
--  durable outbox replays through — could never have persisted a sale.
--
--  FIX: make the trigger function what the security design already says it
--  is. This grants no new client capability: order_items rows can only come
--  into existence through an orders INSERT/UPDATE that itself passed the
--  orders RLS (orders_insert_staff scopes store + identity; item updates are
--  manager-gated), and the derived rows are a pure projection of that
--  parent row's `items` payload. Fixed search_path per house style.
-- ============================================================================

alter function explode_order_items() security definer;
alter function explode_order_items() set search_path = public;

-- Defence-in-depth: the definer function must never be callable directly.
revoke all on function explode_order_items() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- HANDOVER NOTES
-- ---------------------------------------------------------------------------
-- • order_items / order_item_modifiers keep ZERO insert/update/delete
--   policies for browser clients — exactly as §6 intended. The ONLY write
--   path is this trigger, and the trigger only fires on RLS-approved parent
--   writes.
-- • Verified live (local RLS matrix DB): a team_member orders INSERT now
--   succeeds and explodes items; a replay of the same order id via
--   ON CONFLICT DO NOTHING is a silent no-op (no duplicate order_items,
--   no RLS error) — the FIX-2 idempotency contract.
-- ============================================================================
