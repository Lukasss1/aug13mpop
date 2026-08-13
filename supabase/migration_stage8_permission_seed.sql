-- ============================================================================
--  MILK POP — MIGRATION S8 (STAGE 8): PERMISSION-MATRIX SEED GUARANTEE
--
--  Run order: any time after schema.sql. Safe to re-run.
--
--  STAGE 8 makes hydration treat an EMPTY server collection as authoritative
--  (no client-side fallback data survives sign-in). For most collections an
--  empty table is a perfectly valid state; the ONE exception is the
--  role-permission matrix, where "no rows" would gate every admin control
--  shut. This migration guarantees the four default rows exist on EVERY
--  database — including ones created before seed.sql carried them — without
--  overwriting an owner's customised matrix (ON CONFLICT DO NOTHING; the
--  fresh-install seed.sql remains the place that intentionally resets).
-- ============================================================================

insert into role_permissions (role, "view", "create", "edit", "delete", "approve", "publish") values
('team_member',   true, false, false, false, false, false),
('supervisor',    true, true,  true,  false, false, false),
('store_manager', true, true,  true,  true,  true,  false),
('owner',         true, true,  true,  true,  true,  true)
on conflict (role) do nothing;
