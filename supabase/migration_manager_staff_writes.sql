-- ============================================================================
--  MILK POP — MANAGER STAFF WRITES (post-Stage-12 fix #1)
--
--  Run order: after migration_stage4_training.sql (needs its triggers).
--  Safe to re-run.
--
--  THE GAP: staff_profiles had only owner-write + self-update policies, so a
--  store manager's Recognition awards and holiday adjustments were silently
--  denied — while the UI showed the buttons. This adds the missing policy;
--  WHAT a manager may change stays enforced by the column-protection
--  triggers (reconciled in migration_stage4_training.sql):
--
--    manager, employee of THEIR store, not an owner, not THEMSELVES:
--      may change points / level / badges / holiday_balance
--      (recognition + holiday — the Team-tab features)
--    contract & identity columns (pay_rate, pay_type, role, store, status,
--      auth_id) remain OWNER-ONLY — payroll is owner-only by design.
-- ============================================================================

drop policy if exists staff_profiles_update_mgr on staff_profiles;
create policy staff_profiles_update_mgr on staff_profiles
  for update to authenticated
  using (
    current_staff_role() = 'store_manager'
    and store_id is not distinct from current_staff_store()
    and role <> 'owner'
    and id <> current_staff_id()
  )
  with check (
    current_staff_role() = 'store_manager'
    and store_id is not distinct from current_staff_store()
    and role <> 'owner'
    and id <> current_staff_id()
  );
