-- ============================================================================
--  MILK POP — R4.10 INCREMENT 8 : the launch gate cannot be bypassed.
--
--  Closes deployment-audit findings D-4 and D-5, and the external INC6 audit's
--  P0s 1, 2, 3 and 4. Every one of them is the same shape: the gate is a
--  TRANSITION check, so the wrong state is reachable by a path the transition
--  never sees, and once reached it persists.
--
--  WHAT WAS MEASURED, not assumed
--  ------------------------------
--  D-4: `delete from launch_settings` succeeded. With no row, six conditions
--       returned a BLANK state instead of 'incomplete', and
--       `assert_launch_ready('store_open','store_open_blocked')` returned NULL —
--       it did not raise. One DELETE disarmed the entire gate.
--
--  D-5: ONE statement — `update launch_settings set
--       allergen_disclosure_mode='declared', enforce_public_gates=true` —
--       succeeded, because the BEFORE UPDATE trigger re-read the TABLE and so
--       evaluated the OLD posture. The resulting measured state: gates ARMED,
--       24 available products published, 16 of them carrying legacy allergen
--       arrays, and ZERO approved declarations behind them.
--
--  THE SHAPE OF THE FIX
--  --------------------
--  Three separate defences, because each covers a path the others do not:
--
--    1. The singleton cannot be deleted, emptied or re-identified. This removes
--       the missing-row state entirely rather than teaching every downstream
--       condition to recognise it — a smaller change with a larger blast radius
--       closed.
--
--    2. `declared` allergen mode is refused outright for this release. The
--       public view publishes `menu_items.allergens` while the gate checks
--       `product_allergen_declarations`; two sources, and the gate cannot see
--       what the site is actually claiming. Until one system feeds both, the
--       honest posture is the one that publishes no product-level claim at all.
--       This is the external audit's own recommendation, and it is one line
--       rather than an evidence chain nobody has time to build before launch.
--
--    3. Every UPDATE is validated against the PROPOSED row (NEW), not the
--       stored one. This closes arming-with-stale-facts AND post-commissioning
--       degradation with a single rule, because both are the same question:
--       "is the state this statement would LEAVE BEHIND a valid one?"
--
--  APPEND-ONLY: no previously applied migration is edited by this file.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- R4.10.8.1  The singleton is permanent.
-- ----------------------------------------------------------------------------
create or replace function launch_settings_is_permanent()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    raise exception
      'launch_settings_undeletable: the launch settings row cannot be deleted. '
      'Deleting it made every identity condition report a blank state instead of '
      '"incomplete", and assert_launch_ready() then passed. Edit the row instead; '
      'to start over, blank the fields you want to clear.'
      using errcode = 'restrict_violation';
  end if;

  -- UPDATE: the identity of the singleton may not move.
  if NEW.id is distinct from OLD.id then
    raise exception 'launch_settings_immutable_id: the singleton id cannot be changed'
      using errcode = 'restrict_violation';
  end if;

  return NEW;
end
$$;

drop trigger if exists trg_launch_settings_permanent on launch_settings;
create trigger trg_launch_settings_permanent
  before delete or update on launch_settings
  for each row execute function launch_settings_is_permanent();

-- Defence in depth: even a statement that bypassed the row trigger cannot leave
-- the table empty.
create or replace function launch_settings_never_empty()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare v_count bigint;
begin
  select count(*) into v_count from launch_settings;
  if v_count <> 1 then
    raise exception
      'launch_settings_singleton_violated: expected exactly 1 launch settings row, found %. '
      'A missing row silently disarms the launch gate.', v_count
      using errcode = 'restrict_violation';
  end if;
  return null;
end
$$;

drop trigger if exists trg_launch_settings_never_empty on launch_settings;
create constraint trigger trg_launch_settings_never_empty
  after insert or update or delete on launch_settings
  deferrable initially deferred
  for each row execute function launch_settings_never_empty();

-- ----------------------------------------------------------------------------
-- R4.10.8.2  `declared` allergen mode is refused for this release.
-- ----------------------------------------------------------------------------
-- The CHECK is the whole fix. With `declared` unreachable, the two-truth-source
-- defect cannot occur, the single-statement arm cannot reach it, and the public
-- site publishes no product-level allergen claim at all — which is the only
-- claim currently backed by nothing.
alter table launch_settings drop constraint if exists launch_settings_allergen_mode_chk;
alter table launch_settings
  add constraint launch_settings_allergen_mode_chk
  check (allergen_disclosure_mode = 'in_store_only');

comment on column launch_settings.allergen_disclosure_mode is
  'R4.10 Increment 8: constrained to in_store_only for this release. `declared` published '
  'menu_items.allergens while the gate checked product_allergen_declarations — two sources, '
  'so the gate could not see what the site claimed. Re-open it only when one approved-'
  'declaration system feeds the public projection directly.';

-- ----------------------------------------------------------------------------
-- R4.10.8.3  A live configuration cannot be degraded.
-- ----------------------------------------------------------------------------
-- One rule closes two findings. Arming with stale facts and degrading a live
-- configuration are the same question asked at different moments, and both are
-- answered by validating NEW rather than re-reading the table.
create or replace function launch_settings_no_degradation_while_armed()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_lost text[];
begin
  -- Only the ARMED state carries obligations. An unarmed, half-configured row is
  -- a legitimate work-in-progress and must stay freely editable — the empty-launch
  -- definition depends on that.
  if NEW.enforce_public_gates is not true then
    return NEW;
  end if;

  -- THIS GUARD DOES NOT DEFINE "COMPLETE".
  --
  -- An earlier draft carried its own nine-field list of what a complete launch
  -- identity means. That was a second definition of something
  -- assert_launch_ready('arm_gates') already defines, and it immediately drifted:
  -- the r48 upgrade suite satisfied the real gate and failed the copy. Writing a
  -- rival definition is the exact defect this round exists to remove, so this
  -- guard asks a question only IT can answer and leaves completeness alone.
  --
  -- The question is comparative, not absolute: did this statement take something
  -- away that was there a moment ago, while the gates are armed? Arming itself
  -- stays with the existing predicate, which is the single definition of ready.
  if TG_OP <> 'UPDATE' then
    return NEW;
  end if;

  select array_agg(f order by f) into v_lost from (
    select 'legal_business_name' as f
      where coalesce(OLD.legal_business_name, '') <> '' and coalesce(NEW.legal_business_name, '') = ''
    union all select 'company_number'
      where coalesce(OLD.company_number, '') <> '' and coalesce(NEW.company_number, '') = ''
    union all select 'registered_address'
      where coalesce(OLD.registered_address, '') <> '' and coalesce(NEW.registered_address, '') = ''
    union all select 'public_contact_email'
      where coalesce(OLD.public_contact_email, '') <> '' and coalesce(NEW.public_contact_email, '') = ''
    union all select 'privacy_contact_email'
      where coalesce(OLD.privacy_contact_email, '') <> '' and coalesce(NEW.privacy_contact_email, '') = ''
    union all select 'public_telephone'
      where coalesce(OLD.public_telephone, '') <> '' and coalesce(NEW.public_telephone, '') = ''
    union all select 'canonical_url'
      where coalesce(OLD.canonical_url, '') <> '' and coalesce(NEW.canonical_url, '') = ''
    union all select 'receipt_identity_footer'
      where coalesce(OLD.receipt_identity_footer, '') <> '' and coalesce(NEW.receipt_identity_footer, '') = ''
    union all select 'vat_state_confirmed'
      where OLD.vat_state_confirmed is true and NEW.vat_state_confirmed is not true
  ) q;

  if v_lost is not null then
    raise exception
      'launch_settings_degraded: this update would remove % from a LIVE configuration '
      'while the public gates are armed. Disarm the gates first, or keep the fact. '
      'The check is on what the statement takes AWAY, not on what completeness means — '
      'that stays with assert_launch_ready().', v_lost
      using errcode = 'check_violation';
  end if;

  return NEW;
end
$$;

drop trigger if exists trg_launch_settings_proposed_valid on launch_settings;
create trigger trg_launch_settings_proposed_valid
  before update on launch_settings
  for each row execute function launch_settings_no_degradation_while_armed();

-- ----------------------------------------------------------------------------
-- ACCEPTANCE
-- ----------------------------------------------------------------------------
do $acceptance$
declare v_ok boolean;
begin
  if to_regprocedure('public.launch_settings_is_permanent()') is null
     or to_regprocedure('public.launch_settings_no_degradation_while_armed()') is null then
    raise exception 'r410_launch_gate_invariants: guard functions absent';
  end if;

  select count(*) = 3 into v_ok from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
   where c.relname = 'launch_settings' and not t.tgisinternal
     and t.tgname in ('trg_launch_settings_permanent',
                      'trg_launch_settings_never_empty',
                      'trg_launch_settings_proposed_valid');
  if not v_ok then
    raise exception 'r410_launch_gate_invariants: expected all three guards on launch_settings';
  end if;

  -- the declared mode must be unreachable
  begin
    update launch_settings set allergen_disclosure_mode = 'declared';
    raise exception 'r410_launch_gate_invariants: declared mode was accepted';
  exception
    when check_violation then null;
    when others then
      if sqlstate = 'P0001' and sqlerrm like '%declared mode was accepted%' then raise; end if;
  end;
end
$acceptance$;
