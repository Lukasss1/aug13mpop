-- ============================================================================
-- STAGE 2 AUDIT — ROLE & PERMISSION HARDENING (Findings 1–4)
-- ============================================================================
-- The Stage-2 permission audit found four defects this migration corrects.
-- Idempotent (safe on both --db-fresh and --db-upgrade); supersedes-in-place:
-- earlier files stay byte-identical (ledger fingerprints), the FINAL policy
-- definitions below are what a deployed database enforces.
--
--   F1  staff_profiles_update_mgr used raw current_staff_role() — a manager
--       with only a PASSWORD (aal1) token could reach a privileged write.
--       Managers now go through an AAL2-aware helper, matching the project's
--       single-MFA-choke-point design.
--   F2  content_write_mgr granted every manager write access to ALL public
--       content (brand settings, news, deals, media, CMS, every store) while
--       the UI presented those areas as owner-only. The DATABASE is the real
--       boundary: public-content writes are now OWNER-ONLY. (Store-scoped
--       manager editing needs store-ownership columns first — deferred, see
--       docs/STAGE2-PERMISSIONS-REPORT.md.)
--   F3  Reserved CRM/inventory domains (customers, loyalty_transactions,
--       ingredients, stock_movements) were browser-accessible to any staff
--       member. They are OUTSIDE launch scope: all browser access is revoked
--       and their policies dropped. Server-side access (Edge Functions, POS
--       sync) is unaffected. Re-opening them requires a designed, audited migration.
--   F4  Managers could read EVERY job application and ALL customer messages.
--       Applications are now store-scoped via applied_store (name match, as
--       captured by the public form); unassigned ('') applications and the
--       whole contact inbox are owner-only.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- F1a. AAL2-aware store-manager helper (mirrors migration_fix8_aal2.sql).
-- ----------------------------------------------------------------------------
create or replace function is_store_manager()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(current_staff_role() = 'store_manager', false)
         and is_aal2();
$$;
grant execute on function is_store_manager() to authenticated;

-- ----------------------------------------------------------------------------
-- F1b. Manager staff writes: same scope as before, MFA now mandatory.
-- ----------------------------------------------------------------------------
drop policy if exists staff_profiles_update_mgr on staff_profiles;
create policy staff_profiles_update_mgr on staff_profiles
  for update to authenticated
  using (
    is_store_manager()
    and store_id is not distinct from current_staff_store()
    and role <> 'owner'
    and id <> current_staff_id()
  )
  with check (
    is_store_manager()
    and store_id is not distinct from current_staff_store()
    and role <> 'owner'
    and id <> current_staff_id()
  );

-- ----------------------------------------------------------------------------
-- F2. Public content: writes are OWNER-ONLY. Reads unchanged.
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'site_settings','stores','deals','job_vacancies',
    'news_posts','cms_pages','media_assets','site_content'
  ] loop
    if to_regclass(t) is not null then
      execute format('drop policy if exists content_write_mgr on %I', t);
      execute format('drop policy if exists content_write_owner on %I', t);
      execute format(
        'create policy content_write_owner on %I for all to authenticated '
        'using (is_owner()) with check (is_owner())', t);
    end if;
  end loop;
end $$;

-- F2-exception — MENU. The manager menu-publish is a SHIPPED operational
-- feature (Stage-7 atomic publication, matrix-pinned) and the admin UI exposes
-- the menu section to managers, so UI↔DB parity keeps it manager-writable —
-- MFA-enforced via is_manager_or_owner() — exactly as the audit's conditional
-- allows ("menu items, only if managers should control them"). Store-scoping
-- awaits the store-ownership data model (deferred; see the Stage-2 report).
drop policy if exists content_write_mgr   on menu_items;
drop policy if exists content_write_owner on menu_items;
drop policy if exists menu_write_mgr      on menu_items;
create policy menu_write_mgr on menu_items
  for all to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());

-- ----------------------------------------------------------------------------
-- F3. Reserved domains: full browser lockdown.
-- ----------------------------------------------------------------------------
drop policy if exists customers_rw_staff     on customers;
drop policy if exists customers_delete_mgr   on customers;
drop policy if exists loyalty_rw_staff       on loyalty_transactions;
drop policy if exists ingredients_read_staff on ingredients;
drop policy if exists ingredients_write_mgr  on ingredients;
drop policy if exists stock_read_store       on stock_movements;
drop policy if exists stock_write_staff      on stock_movements;
revoke all on customers            from authenticated, anon;
revoke all on loyalty_transactions from authenticated, anon;
revoke all on ingredients          from authenticated, anon;
revoke all on stock_movements      from authenticated, anon;

-- ----------------------------------------------------------------------------
-- F4. Inbox scoping: applications by store; contact inbox owner-only.
-- ----------------------------------------------------------------------------
drop policy if exists applications_select_mgr on job_applications;
create policy applications_select_mgr on job_applications
  for select to authenticated
  using (
    is_owner()
    or (is_store_manager()
        and applied_store <> ''
        and applied_store = (select s.name from stores s
                             where s.id = current_staff_store()))
  );

drop policy if exists applications_update_mgr on job_applications;
create policy applications_update_mgr on job_applications
  for update to authenticated
  using (
    is_owner()
    or (is_store_manager()
        and applied_store <> ''
        and applied_store = (select s.name from stores s
                             where s.id = current_staff_store()))
  )
  with check (
    is_owner()
    or (is_store_manager()
        and applied_store <> ''
        and applied_store = (select s.name from stores s
                             where s.id = current_staff_store()))
  );

drop policy if exists contact_select_mgr   on contact_messages;
drop policy if exists contact_select_owner on contact_messages;
create policy contact_select_owner on contact_messages
  for select to authenticated
  using (is_owner());
