-- ============================================================================
--  MILK POP — MIGRATION E3: COLUMN-LEVEL SELF-UPDATE LOCK (pay_rate etc.)
--
--  Run order: after A1 (migration_rls_per_role.sql — needs is_owner() and the
--  staff_profiles_update_self policy). Safe to re-run.
--
--  WHAT THIS CLOSES  (the security notes in README.md follow-on / A1 handover note (b))
--  ------------------------------------------------------------------------
--  A1's self-update policy already blocks a staff member from changing their
--  own ROLE or STORE (privilege escalation) via `with check`. But the policy
--  still lets a team member update OTHER fields on their own row — including
--  `pay_rate` and `pay_type` (give themselves a raise) and gamification/HR
--  fields (`points`, `level`, `holiday_balance`, `badges`, `next_shift`). A1
--  deferred the per-FIELD lock to "once real sign-in exists" — it now does.
--
--  WHY A TRIGGER, NOT A COLUMN GRANT
--  ---------------------------------
--  The obvious tool — REVOKE UPDATE on the table + GRANT UPDATE (safe cols) —
--  applies to EVERY `authenticated` user, including the owner, because this app
--  uses the single `authenticated` Postgres role for all staff. That would also
--  stop OWNERS setting pay_rate, breaking payroll admin. Splitting owners into a
--  separate DB role is a much larger change. So we enforce the column lock with
--  a BEFORE UPDATE trigger that:
--     • lets OWNERS change anything (is_owner()), and
--     • for anyone else, forbids changes to the PROTECTED columns by forcing the
--       new value back to the old one is NOT enough for pay — we RAISE instead,
--       so an attempted self-raise fails loudly rather than silently no-oping.
--
--  This complements (does not replace) the RLS policy: RLS decides the row is
--  self-owned; this trigger guarantees the sensitive COLUMNS are unchanged
--  unless an owner is making the change.
-- ============================================================================

create or replace function enforce_staff_self_update_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Owners (and the service role, which bypasses RLS and does not hit these
  -- app policies in the same way) may change any field. is_owner() reads the
  -- caller's role from staff_profiles, never from the client.
  if is_owner() then
    return new;
  end if;

  -- For non-owners, the protected columns must be IDENTICAL to the stored row.
  -- `is not distinct from` treats NULLs correctly (NULL = NULL here).
  if (new.pay_rate        is distinct from old.pay_rate)
     or (new.pay_type     is distinct from old.pay_type)
     or (new.role         is distinct from old.role)
     or (new.store_id     is distinct from old.store_id)
     or (new.store_name   is distinct from old.store_name)
     or (new.points       is distinct from old.points)
     or (new.level        is distinct from old.level)
     or (new.holiday_balance is distinct from old.holiday_balance)
     or (new.badges       is distinct from old.badges)
  then
    raise exception 'field is not self-editable (protected column changed by non-owner)'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end $$;

-- BEFORE UPDATE so the check runs on every proposed change, owner or not.
drop trigger if exists trg_staff_self_update_lock on staff_profiles;
create trigger trg_staff_self_update_lock
  before update on staff_profiles
  for each row execute function enforce_staff_self_update_lock();

comment on function enforce_staff_self_update_lock() is
  'Blocks non-owner staff from changing protected staff_profiles columns '
  '(pay_rate, pay_type, role, store, points, level, holiday_balance, badges) '
  'on any row — including their own. Owners may change anything. Complements '
  'the A1 self-update RLS policy with a per-field lock. Editable self-service '
  'fields (e.g. avatar, name, next_shift) remain updatable.';

-- ---------------------------------------------------------------------------
-- HANDOVER NOTE
-- ---------------------------------------------------------------------------
-- If you later add self-editable fields, they are allowed by default (only the
-- listed columns are protected). If you add a NEW sensitive field, add it to
-- the protected list above. To verify live: sign in as a team member and
-- attempt to PATCH your own pay_rate — it must return an error, while an owner
-- PATCH of the same field must succeed (covered in scripts/rls-policy.test.mjs).
-- ============================================================================
