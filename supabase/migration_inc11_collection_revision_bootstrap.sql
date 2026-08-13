-- ============================================================================
--  INC11 — COLLECTION REVISION BOOTSTRAP (chain 89)                    [P0-3]
-- ============================================================================
--
--  THE DEFECT (external audit, P0-3). Chain 78 introduced the revision guard
--  and chain 81 seeded ledger rows for the THREE configuration singletons —
--  but the TWELVE general collections were never seeded. On any database
--  where a collection has no ledger row yet, the first save loops forever:
--
--      no ledger row
--        → the browser hydrates no revision
--        → the browser sends null
--        → collection_revision_checkpoint() lazily inserts revision 0
--        → replace_collection refuses null (collection_revision_required)
--        → the transaction rolls back
--        → the lazily inserted row disappears with it
--        → repeat forever
--
--  The checkpoint's lazy insert can never bootstrap a client that started
--  with no revision, because it lives INSIDE the transaction that the
--  null-revision refusal rolls back. Chain 81 recorded exactly this lesson
--  for the singletons ("lazy rows would dead-end the first save"); this
--  migration applies it to the general collections.
--
--  THE INVARIANT. The server installs every authoritative revision row
--  BEFORE any client hydrates it; the client must still state the exact
--  revision it hydrated. Deliberately NOT done, in any layer:
--    • the browser does NOT convert a missing revision to 0;
--    • replace_collection does NOT treat null as revision 0;
--    • no first save is admitted without a stated revision.
--  Each of those would let a client GUESS the authoritative state and would
--  reopen the stale-snapshot hole the guard exists to close.
--
--  Seeding is idempotent (on conflict do nothing), so:
--    • a fresh install lands every key at revision 0;
--    • a live upgrade fills only the MISSING keys — any revision a real
--      write has already advanced is preserved exactly;
--    • re-applying this file never resets anything.
--
--  Behavioural proof (bootstrap, historical upgrade, positive control,
--  concurrency, preservation): scripts/inc11-revision-guard.test.mjs
--  (npm run test:inc11-revisions).
-- ============================================================================

insert into collection_revisions (table_key, revision)
values
  ('menu_items',           0),
  ('stores',               0),
  ('job_vacancies',        0),
  ('kb_articles',          0),
  ('news_posts',           0),
  ('media_assets',         0),
  ('deals',                0),
  ('checklist_templates',  0),
  ('training_courses',     0),
  ('training_assessments', 0),
  ('training_assignments', 0),
  ('role_permissions',     0)
on conflict (table_key) do nothing;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE — fail the migration loudly unless the full authoritative key
-- set exists. Two checks:
--   1. the twelve general collection keys this migration owns;
--   2. the COMPLETE fifteen-key set (twelve general + the three singletons
--      chain 81 seeds), because the invariant is "every authoritative row
--      exists before a client hydrates it", not "the rows this file wrote".
-- ----------------------------------------------------------------------------
do $acceptance$
declare
  v_missing text[];
begin
  select array_agg(required_key order by required_key)
    into v_missing
  from unnest(array[
    'menu_items',
    'stores',
    'job_vacancies',
    'kb_articles',
    'news_posts',
    'media_assets',
    'deals',
    'checklist_templates',
    'training_courses',
    'training_assessments',
    'training_assignments',
    'role_permissions'
  ]) required_key
  where not exists (
    select 1
    from collection_revisions cr
    where cr.table_key = required_key
  );

  if coalesce(array_length(v_missing, 1), 0) > 0 then
    raise exception
      'inc11_revision_bootstrap: missing revision keys: %',
      array_to_string(v_missing, ', ');
  end if;

  /* The complete authoritative set: every table carrying the bump trigger
     must have a ledger row. Discovery-based so a FUTURE collection that
     gains the trigger without a seed fails HERE, not in a browser. */
  select array_agg(c.relname order by c.relname)
    into v_missing
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where t.tgname = 'trg_zz_collection_revision'
    and n.nspname = 'public'
    and not exists (
      select 1 from collection_revisions cr
      where cr.table_key = c.relname
    );

  if coalesce(array_length(v_missing, 1), 0) > 0 then
    raise exception
      'inc11_revision_bootstrap: trigger-bearing collections without a ledger row: %',
      array_to_string(v_missing, ', ');
  end if;
end
$acceptance$;
