-- ============================================================================
-- STAGE 2.1.1 — RE-AUDIT CLOSURE (CF1–CF3, database layer) — APPENDED
-- ============================================================================
-- HISTORY CORRECTION. Stage 2.1.1 originally shipped these changes by EDITING
-- the already-applied migration_stage2_1_permission_closure.sql in place —
-- which the ledger forbids (an applied file's checksum is frozen; the upgrade
-- runner fails closed on a mismatch). That file is restored to its Stage-2.1
-- content and the 2.1.1 database delta is re-issued HERE, append-only.
-- Idempotent, and correct over EITHER prior state:
--   • a database that applied the ORIGINAL Stage 2.1 (partial column grants);
--   • a database that applied the edited 2.1.1 variant (full grants already).
--
--   CF1  The Stage-2.1 partial column grants are REVERSED. PostgREST
--        `select=*` expands to every column, so a partial grant 42501s every
--        caller — owner included — and breaks profile loading at login. The
--        full-table SELECT is restored here (RLS still row-scopes); pay stays
--        out of a manager's browser via the pay-free client projection and
--        the owner-only owner_staff_pay() RPC (both defined at Stage 2.1).
--        NOTE: migration_stage2_1_2_salary_confidentiality.sql immediately
--        supersedes this with SERVER-ENFORCED column privileges + read RPCs;
--        this step exists so the ledger replays history truthfully.
--   CF2  Analytics views flip to security_invoker; reserved stock_levels is
--        revoked from the browser.
--   CF3  Every remaining GLOBAL manager training write path becomes
--        store-scoped through the target employee.
-- (CF4/CF5/CF7 were Edge-Function/client changes; CF6 removed the fail-open
--  wrappers, whose only members were the CF1-reversed grant blocks above.)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- CF1. Reverse the crash-prone partial column grants (fail CLOSED — no
--      `when others` wrapper: if these grants cannot apply, deployment stops).
-- ----------------------------------------------------------------------------
grant select on staff_profiles   to authenticated;
grant select on job_applications to authenticated;

-- ----------------------------------------------------------------------------
-- CF2. Analytics views bypass RLS (financial-data privacy).
--   The sales views were created as ordinary (definer-rights) views, so any
--   authenticated staff could read store-wide revenue that the orders policy
--   would otherwise hide. On PG15+ we flip them to SECURITY INVOKER so the
--   caller's own RLS on the base tables applies (an employee's aggregates then
--   reflect only their own orders). `stock_levels` reads RESERVED inventory
--   (ingredients/stock_movements) and is revoked from the browser entirely.
-- ----------------------------------------------------------------------------
do $$
declare v text;
begin
  foreach v in array array['daily_sales','top_products','sales_by_channel','popular_modifiers'] loop
    if to_regclass(v) is not null then
      execute format('alter view %I set (security_invoker = true)', v);
    end if;
  end loop;
end $$;

-- Reserved inventory analytics: no browser access while the domain is reserved.
do $$
begin
  if to_regclass('stock_levels') is not null then
    execute 'alter view stock_levels set (security_invoker = true)';
    execute 'revoke all on stock_levels from authenticated, anon';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- CF3. Training store-isolation completeness.
--   Stage 2.1 initially store-scoped only the three manager SELECTs. This
--   closes the remaining GLOBAL manager paths: assignment insert/update/delete,
--   certificate update, and the training_results SELECT — each now joins the
--   target row back to the manager's store (owner stays global). Store match is
--   evaluated through the target employee's staff_profiles.store_id.
-- ----------------------------------------------------------------------------
-- A reusable store-scope predicate builder for "<pol> on <tbl> keyed by emp".
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      -- table,                policy,               verb,   emp_col
      ('training_assignments', 'tassign_insert_mgr', 'insert', 'employee_id'),
      ('training_assignments', 'tassign_update_mgr', 'update', 'employee_id'),
      ('training_assignments', 'tassign_delete_mgr', 'delete', 'employee_id'),
      ('training_certificates','tcert_update_mgr',   'update', 'employee_id'),
      ('training_results',     'tres_select_self_or_mgr', 'select', 'employee_id')
    ) as t(tbl, pol, verb, col)
  loop
    if to_regclass(spec.tbl) is null then
      continue;
    end if;
    execute format('drop policy if exists %I on %I', spec.pol, spec.tbl);
    if spec.verb = 'insert' then
      execute format($f$
        create policy %I on %I for insert to authenticated
          with check (
            is_owner()
            or (is_store_manager() and exists (
              select 1 from staff_profiles sp
              where sp.id = %I.%I and sp.store_id = current_staff_store()))
          )
      $f$, spec.pol, spec.tbl, spec.tbl, spec.col);
    elsif spec.verb = 'delete' then
      execute format($f$
        create policy %I on %I for delete to authenticated
          using (
            is_owner()
            or (is_store_manager() and exists (
              select 1 from staff_profiles sp
              where sp.id = %I.%I and sp.store_id = current_staff_store()))
          )
      $f$, spec.pol, spec.tbl, spec.tbl, spec.col);
    elsif spec.verb = 'update' then
      execute format($f$
        create policy %I on %I for update to authenticated
          using (
            is_owner()
            or (is_store_manager() and exists (
              select 1 from staff_profiles sp
              where sp.id = %I.%I and sp.store_id = current_staff_store()))
          )
          with check (
            is_owner()
            or (is_store_manager() and exists (
              select 1 from staff_profiles sp
              where sp.id = %I.%I and sp.store_id = current_staff_store()))
          )
      $f$, spec.pol, spec.tbl, spec.tbl, spec.col, spec.tbl, spec.col);
    else  -- select
      execute format($f$
        create policy %I on %I for select to authenticated
          using (
            %I = current_staff_id()
            or is_owner()
            or (is_store_manager() and exists (
              select 1 from staff_profiles sp
              where sp.id = %I.%I and sp.store_id = current_staff_store()))
          )
      $f$, spec.pol, spec.tbl, spec.col, spec.tbl, spec.col);
    end if;
  end loop;
end $$;
