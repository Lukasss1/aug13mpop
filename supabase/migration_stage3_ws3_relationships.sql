-- ============================================================================
-- STAGE 3 / WS3 — RELATIONSHIP INTEGRITY + IMPOSSIBLE-STATE ELIMINATION
-- ============================================================================
-- Every FK below is a DESIGN decision, not a mechanical addition; the full
-- parent/child/rule/reason/retention table is docs/STAGE3-RELATIONSHIP-MATRIX.md.
-- Delete-rule doctrine (from the retention model, STAGE3-RETENTION-AND-DELETION.md):
--   RESTRICT   employment/financial/incident history — parents with history
--              are PERMANENT; people are deactivated (status), never deleted.
--   SET NULL   snapshot-backed references (menu items in order lines): the
--              line's name/price/VAT snapshot is authoritative; the catalog
--              row is replaceable.
--   NO FK      polymorphic ids, external idempotency keys, auth-schema
--              boundary, and *_by display-name snapshots (documented).
-- Plain ADD CONSTRAINT (no NOT VALID): a dev database holding orphans FAILS
-- LOUDLY. Production launches empty. Idempotent via conname guards.
-- ============================================================================

do $$
declare
  fk record;
begin
  for fk in select * from (values
    -- employment & HR history → staff_profiles: RESTRICT (people deactivate)
    ('clock_history',        'employee_id', 'staff_profiles', 'id', 'restrict'),
    ('work_shifts',          'employee_id', 'staff_profiles', 'id', 'restrict'),
    ('payslips',             'employee_id', 'staff_profiles', 'id', 'restrict'),
    ('staff_documents',      'employee_id', 'staff_profiles', 'id', 'restrict'),
    ('training_assignments', 'employee_id', 'staff_profiles', 'id', 'restrict'),
    ('training_certificates','employee_id', 'staff_profiles', 'id', 'restrict'),
    ('training_progress',    'employee_id', 'staff_profiles', 'id', 'restrict'),
    ('training_results',     'employee_id', 'staff_profiles', 'id', 'restrict'),
    ('sifr_reports',         'reporter_id', 'staff_profiles', 'id', 'restrict'),
    ('orders',               'staff_id',    'staff_profiles', 'id', 'restrict'),
    -- store scoping → stores: RESTRICT (stores with history are permanent)
    ('work_shifts',          'store_id',    'stores', 'id', 'restrict'),
    ('staff_documents',      'store_id',    'stores', 'id', 'restrict'),
    ('sifr_reports',         'store_id',    'stores', 'id', 'restrict'),
    ('app_state',            'store_id',    'stores', 'id', 'restrict'),
    ('staff_profiles',       'store_id',    'stores', 'id', 'restrict'),
    ('orders',               'store_id',    'stores', 'id', 'restrict'),
    ('pos_devices',          'store_id',    'stores', 'id', 'restrict'),
    ('pos_shifts',           'store_id',    'stores', 'id', 'restrict'),
    ('pos_orders',           'store_id',    'stores', 'id', 'restrict'),
    ('pos_refunds',          'store_id',    'stores', 'id', 'restrict'),
    ('pos_voids',            'store_id',    'stores', 'id', 'restrict'),
    ('pos_corrections',      'store_id',    'stores', 'id', 'restrict'),
    ('pos_cash_movements',   'store_id',    'stores', 'id', 'restrict'),
    ('pos_approvals',        'store_id',    'stores', 'id', 'restrict'),
    ('pos_pairing_codes',    'store_id',    'stores', 'id', 'restrict'),
    ('pos_audit_events',     'store_id',    'stores', 'id', 'restrict'),
    -- POS financial chains → pos_shifts: RESTRICT (shift is the ledger unit)
    ('pos_orders',           'shift_id',    'pos_shifts', 'id', 'restrict'),
    ('pos_refunds',          'shift_id',    'pos_shifts', 'id', 'restrict'),
    ('pos_voids',            'shift_id',    'pos_shifts', 'id', 'restrict'),
    ('pos_corrections',      'shift_id',    'pos_shifts', 'id', 'restrict'),
    ('pos_cash_movements',   'shift_id',    'pos_shifts', 'id', 'restrict'),
    ('pos_refund_items',     'order_item_id','pos_order_items', 'id', 'restrict'),
    -- training chain
    ('training_results',     'assignment_id','training_assignments', 'id', 'restrict'),
    ('training_progress',    'course_id',   'training_courses', 'id', 'restrict'),
    -- catalog references from immutable financial snapshots: SET NULL
    ('order_items',          'menu_item_id','menu_items', 'id', 'set null'),
    ('order_item_modifiers', 'menu_item_id','menu_items', 'id', 'set null')
  ) as v(child, col, parent, pcol, rule)
  loop
    if not exists (select 1 from pg_constraint
                   where conname = 'fk_' || fk.child || '_' || fk.col) then
      execute format(
        'alter table %I add constraint %I foreign key (%I) references %I (%I) on delete %s',
        fk.child, 'fk_' || fk.child || '_' || fk.col, fk.col, fk.parent, fk.pcol,
        case fk.rule when 'set null' then 'set null' else 'restrict' end);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- IMPOSSIBLE STATES — rows that must not be able to exist at all.
-- ----------------------------------------------------------------------------

-- 1. A non-owner ACTIVE employee with no home store. (The owner bootstrap
--    row is HQ-scoped by design; the only store-less non-owner state is
--    'disabled' — the lifecycle's exit state, since people are never deleted.)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'staff_active_requires_store') then
    alter table staff_profiles add constraint staff_active_requires_store check (
      role = 'owner' or status is distinct from 'active' or store_id is not null
    );
  end if;
end $$;

-- 2. A training certificate without a PASSING graded result.
--    complete_training() creates result + certificate atomically; this
--    trigger makes that ordering a LAW rather than a convention.
create or replace function cert_requires_pass() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from training_results r
    where r.employee_id = new.employee_id
      and r.assessment_id = new.assessment_id
      and r.passed
  ) then
    raise exception 'certificate_without_passing_result';
  end if;
  return new;
end $$;
drop trigger if exists trg_cert_requires_pass on training_certificates;
create trigger trg_cert_requires_pass before insert on training_certificates
  for each row execute function cert_requires_pass();

-- 3. Till-shift close honesty: a CLOSED shift carries its closing facts, and
--    a shift cannot be closed twice or reopened (the close is the cash
--    ledger seal — duplicate closes were on the re-audit impossible list).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pos_shifts_closed_has_facts') then
    alter table pos_shifts add constraint pos_shifts_closed_has_facts check (
      status <> 'closed' or (closed_at is not null and closed_by_user_id is not null)
    );
  end if;
end $$;

create or replace function pos_shift_seal() returns trigger
language plpgsql as $$
begin
  if old.status = 'closed' then
    raise exception 'shift_already_closed';
  end if;
  return new;
end $$;
drop trigger if exists trg_pos_shift_seal on pos_shifts;
create trigger trg_pos_shift_seal before update on pos_shifts
  for each row execute function pos_shift_seal();

-- Documented but NOT enforceable here (owners: see the two Stage-3 docs):
--   owner-without-MFA        session property; enforced by is_owner()=role∧aal2
--                            at every privileged gate (Stage 2), not storable.
--   payslip↔approved hours   requires the WS8 approval-workflow columns.
--   application→active store stores carry no status column yet (WS8/WS9).
--   invitation-after-termination, orphaned storage/audit → WS8/WS9 rounds.
