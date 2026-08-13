-- ============================================================================
--  MIGRATION: drink artwork  (supabase/migration_drink_art.sql)
--
--  Points every seeded menu item that is still showing the generic
--  'placeholder' at its branded illustration in /public/brand/drinks/.
--
--  SAFE BY DESIGN
--   • Only touches rows whose image is exactly 'placeholder' — any real photo
--     an owner has already uploaded through Website Studio is left alone.
--   • Idempotent: run it twice and the second run changes nothing.
--   • No policies, no grants, no schema changes — data only.
-- ============================================================================

update menu_items set image = '/brand/drinks/' || id || '.svg'
where image = 'placeholder'
  and id in (
    'm1','m2','m3','m4','m5','m6','m7','m8','m9','m10',
    'sm1','sm2','sm3','sm4',
    'ss1','ss2','ss3',
    'sl1','sl2',
    'e1','e2','e3','e4','e5'
  );
