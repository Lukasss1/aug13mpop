-- ============================================================================
--  MILK POP — R4.10 : launch settings are validated as the state they PROPOSE,
--  and an OPEN store is protected on every write, not only on the transition.
--
--  WHAT WAS WRONG — two findings from the third external audit (of INC9)
--  --------------------------------------------------------------------
--  1. THE ARMING TRIGGER READ THE OLD ROW. assert_launch_settings_transition()
--     ran in BEFORE UPDATE and called assert_launch_ready(), which reads the
--     launch_settings TABLE — i.e. the row as it stood BEFORE this statement.
--     Two failures follow from one cause:
--       • a VALID combined update (fill the missing facts AND arm, atomically)
--         was refused, because readiness saw the old, incomplete values;
--       • an INVALID update could arm, because the old values happened to be
--         valid while the proposed ones were not.
--     The Increment 8 degradation guard was a partial substitute, not a fix:
--     it compared a fixed field list OLD→NEW, so `telephone_alternative_ok`
--     (not on its list) could not license removing the telephone — a swap the
--     single definition of readiness explicitly allows — and any field the
--     list forgot was unguarded. A rival definition, again.
--
--  2. THE STORE GUARD ONLY WATCHED THE TRANSITION. assert_store_open_allowed()
--     checked `new.status = 'open' AND old.status IS DISTINCT FROM 'open'`,
--     and its trigger fired only `ON UPDATE OF status`. So once a store was
--     open, an update that never mentioned `status` could blank its address
--     or opening hours and the store stayed open, invalid, indefinitely.
--
--  THE FIX — one rule, asked of the state a statement LEAVES BEHIND
--  ----------------------------------------------------------------
--  launch_blocking_reasons() gains a CANDIDATE-ROW variant: the same single
--  definition of readiness, evaluated against a launch_settings value passed
--  in rather than read from the table. The zero-argument function now
--  DELEGATES to it with the stored row — one definition, two entry points,
--  no restatement. The transition trigger then validates NEW:
--
--      whenever the resulting state has the gates ARMED,
--      the resulting state must satisfy 'arm_gates' in full.
--
--  That one sentence closes both directions at once: arming on stale facts
--  (NEW must be valid), degrading while armed (NEW must stay valid), the
--  atomic fill-and-arm (NEW is valid, so it succeeds), and the telephone→
--  alternative swap (NEW is valid — `public_telephone` completeness has
--  always been defined as "a number OR an explicit alternative decision").
--  The Increment 8 comparative guard is DROPPED — superseded, not weakened:
--  every state it refused that the definition also refuses is still refused,
--  and the states it wrongly refused (valid swaps) or wrongly allowed
--  (fields off its list) are now decided by the one definition.
--
--  The store guard becomes the same shape: whenever the FINAL row is open —
--  insert or update, whether or not `status` appears in the statement — the
--  row's own facts and the global 'store_open' context must hold.
--
--  APPEND-ONLY: no previously applied migration file is edited. Error names
--  `launch_arm_blocked` and `store_open_blocked` are KEPT (suites pin them);
--  degradation refusals use `launch_degrade_blocked`.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The single definition of readiness, parameterised by a candidate row.
--    Column-for-column the same conditions as the R4.9 G5 definition; the only
--    change is WHERE the launch_settings values come from. Conditions that read
--    OTHER tables (stores, menu_items, declarations, published notices) keep
--    reading them live — the candidate is a launch_settings value, nothing else.
-- ----------------------------------------------------------------------------
create or replace function launch_blocking_reasons(p launch_settings)
returns table (key text, state text, detail text, fix text, blocks text[])
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from (values
    ('legal_business_name',
       case when coalesce(p.legal_business_name,'') <> '' then 'complete' else 'incomplete' end,
       'The registered name the business trades under.', '/admin/settings/',
       array['arm_gates','store_open']),
    ('company_number',
       case when coalesce(p.company_number,'') <> '' then 'complete' else 'warning' end,
       'Required on the website of a limited company (Companies Act 2006). Advisory here because a sole trader has none.',
       '/admin/settings/', array[]::text[]),
    ('registered_address',
       case when coalesce(p.registered_address,'') <> '' then 'complete' else 'incomplete' end,
       'Statutory business address.', '/admin/settings/', array['arm_gates','store_open']),
    ('public_contact_email',
       case when coalesce(p.public_contact_email,'') <> '' then 'complete' else 'incomplete' end,
       'The address customers can reach.', '/admin/settings/', array['arm_gates','store_open']),
    ('privacy_contact_email',
       case when coalesce(p.privacy_contact_email,'') <> '' then 'complete' else 'incomplete' end,
       'Where data-protection requests go.', '/admin/settings/', array['arm_gates','store_open']),
    ('public_telephone',
       case when coalesce(p.public_telephone,'') <> '' or coalesce(p.telephone_alternative_ok, false)
            then 'complete' else 'incomplete' end,
       'A telephone number, or an explicit decision that another channel serves instead.',
       '/admin/settings/', array['arm_gates','store_open']),
    ('canonical_url',
       case when coalesce(p.canonical_url,'') <> '' then 'complete' else 'incomplete' end,
       'The site''s own address, used for canonical links and receipts.', '/admin/settings/',
       array['arm_gates','store_open']),
    ('vat_state_confirmed',
       case when coalesce(p.vat_state_confirmed, false) then 'complete' else 'incomplete' end,
       'The VAT position has been stated deliberately rather than left unset.', '/admin/settings/',
       array['arm_gates','store_open']),
    ('receipt_identity_footer',
       case when coalesce(p.receipt_identity_footer,'') <> '' then 'complete' else 'incomplete' end,
       'The identity line printed on every receipt.', '/admin/settings/', array['arm_gates','store_open']),
    ('notification_recipient',
       case when coalesce(p.notification_recipient,'') <> '' then 'complete' else 'incomplete' end,
       'Where public form submissions are delivered. Blocks form acceptance only.',
       '/admin/settings/', array['form_accept']),
    ('privacy_notice_careers',
       case when current_privacy_version('careers') is not null then 'complete' else 'incomplete' end,
       'A published careers privacy notice to stamp on each submission.', '/admin/settings/',
       array['form_accept']),
    ('privacy_notice_franchise',
       case when current_privacy_version('franchise') is not null then 'complete' else 'incomplete' end,
       'A published franchise privacy notice to stamp on each submission.', '/admin/settings/',
       array['form_accept']),
    ('privacy_notice_contact',
       case when current_privacy_version('contact') is not null then 'complete' else 'incomplete' end,
       'A published contact privacy notice to stamp on each submission.', '/admin/settings/',
       array['form_accept']),
    ('open_store_facts',
       case
         when not exists (select 1 from stores where status = 'open') then 'not_applicable'
         when exists (select 1 from stores where status = 'open'
                        and (coalesce(trim(address),'') = '' or coalesce(trim(opening_hours),'') = ''))
           then 'incomplete'
         else 'complete' end,
       'Every open storefront carries an address and opening hours.', '/admin/stores/',
       array['arm_gates']),
    ('allergen_declarations',
       case
         when coalesce(p.allergen_disclosure_mode, 'in_store_only') <> 'declared' then 'not_applicable'
         when not exists (select 1 from menu_items where available) then 'not_applicable'
         when exists (select 1 from menu_items mi where mi.available and not exists
                (select 1 from product_allergen_declarations d
                  where d.menu_item_id = mi.id and d.state = 'approved')) then 'incomplete'
         else 'complete' end,
       'Publishing allergen data requires an approved declaration on every available product.',
       '/admin/menu/', array['arm_gates','menu_publish']),
    ('public_form_gates_armed',
       case when coalesce(p.enforce_public_gates, false) then 'complete' else 'incomplete' end,
       'The public gates are armed. A storefront may not open before they are.',
       '/admin/settings/', array['store_open'])
  ) as t(key, state, detail, fix, blocks);
$$;

revoke all on function launch_blocking_reasons(launch_settings) from public, anon;
grant execute on function launch_blocking_reasons(launch_settings) to authenticated;

comment on function launch_blocking_reasons(launch_settings) is
  'R4.10: THE definition of launch readiness, evaluated against a CANDIDATE launch_settings '
  'value. The zero-argument form delegates here with the stored row. Triggers validate NEW '
  'through this, so a statement is judged by the state it proposes, never the state it replaces.';

-- ----------------------------------------------------------------------------
-- 2. The zero-argument form becomes a DELEGATE — the stored row is just one
--    more candidate. Same signature, same security posture, same callers
--    (launch_readiness(), assert_launch_ready(), the form-notice trigger);
--    behaviour is identical for every one of them. A missing singleton row
--    yields a NULL candidate whose every condition reads 'incomplete' — fail
--    closed — though the Increment 8 permanence triggers make that unreachable.
-- ----------------------------------------------------------------------------
create or replace function launch_blocking_reasons()
returns table (key text, state text, detail text, fix text, blocks text[])
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from launch_blocking_reasons((select l from launch_settings l where id limit 1));
$$;

-- ----------------------------------------------------------------------------
-- 3. assert_launch_ready for a candidate — raises from the one definition,
--    exactly like the two-argument form it mirrors.
-- ----------------------------------------------------------------------------
create or replace function assert_launch_ready(p_context text, p_error text, p_candidate launch_settings)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_missing text;
begin
  select string_agg(key, ', ' order by key) into v_missing
    from launch_blocking_reasons(p_candidate)
   where state = 'incomplete' and p_context = any(blocks);
  if v_missing is not null then
    raise exception '%: missing %', p_error, v_missing;
  end if;
end $$;

revoke all on function assert_launch_ready(text, text, launch_settings) from public, anon;
grant execute on function assert_launch_ready(text, text, launch_settings) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. The transition trigger asks the question of NEW.
--    • Arming (was off, will be on):        NEW must satisfy arm_gates
--                                            → 'launch_arm_blocked'  (name kept)
--    • Staying armed (was on, still on):    NEW must satisfy arm_gates
--                                            → 'launch_degrade_blocked'
--    • Disarming while a storefront trades: refused, unchanged.
--    The atomic fill-and-arm now SUCCEEDS (NEW is complete), and the
--    telephone → approved-alternative swap now SUCCEEDS while armed, because
--    both leave behind a state the single definition accepts.
-- ----------------------------------------------------------------------------
create or replace function assert_launch_settings_transition()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.enforce_public_gates then
    perform assert_launch_ready(
      'arm_gates',
      case when old.enforce_public_gates then 'launch_degrade_blocked' else 'launch_arm_blocked' end,
      new);
  end if;
  if old.enforce_public_gates and not new.enforce_public_gates
     and exists (select 1 from stores where status = 'open') then
    raise exception 'launch_disarm_blocked: a storefront is open';
  end if;
  return new;
end $$;

-- The trigger itself already exists with the right shape (BEFORE UPDATE, each
-- row); replacing the function body is enough. Re-issued anyway so this file
-- stands alone if the chain is ever replayed from here.
drop trigger if exists trg_launch_settings_transition on launch_settings;
create trigger trg_launch_settings_transition
  before update on launch_settings
  for each row execute function assert_launch_settings_transition();

-- ----------------------------------------------------------------------------
-- 5. The Increment 8 comparative guard is SUPERSEDED and removed.
--    Why removal is the honest move rather than a weakening:
--      • Everything it correctly refused (blanking a required fact while
--        armed) is still refused — by the candidate validation above, which
--        names the field through the same definition every dashboard renders.
--      • What it WRONGLY refused is now allowed: blanking public_telephone in
--        the same statement that sets telephone_alternative_ok is a valid
--        state by the one definition, and the audit requires it to succeed.
--      • What it SILENTLY MISSED is now covered: any degradation of a field
--        its hand-written list forgot (telephone_alternative_ok itself being
--        the audit's example) is caught, because the check is no longer a
--        list — it is the definition.
--    Two guards answering the same question from different lists is the
--    rival-definition defect this round exists to remove.
-- ----------------------------------------------------------------------------
drop trigger if exists trg_launch_settings_proposed_valid on launch_settings;
drop function if exists launch_settings_no_degradation_while_armed();

-- ----------------------------------------------------------------------------
-- 6. The open-store invariant: whenever the FINAL row is open, the final row
--    and the global launch configuration must be valid. Every insert, every
--    update — not only the transition, and not only statements that mention
--    `status`. The old trigger fired ON UPDATE OF status, so an update that
--    blanked the address without touching status never woke it.
-- ----------------------------------------------------------------------------
create or replace function assert_store_open_allowed()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare v_missing text[] := '{}';
begin
  if new.status = 'open' then
    if coalesce(trim(new.address),'') = '' then v_missing := v_missing || 'store_address'::text; end if;
    if coalesce(trim(new.opening_hours),'') = '' then v_missing := v_missing || 'opening_hours'::text; end if;
    if array_length(v_missing,1) is not null then
      raise exception 'store_open_blocked: missing %', array_to_string(v_missing, ', ');
    end if;
    perform assert_launch_ready('store_open', 'store_open_blocked');
  end if;
  return new;
end $$;

drop trigger if exists trg_store_open_gate on stores;
create trigger trg_store_open_gate
  before insert or update on stores
  for each row execute function assert_store_open_allowed();

comment on function assert_store_open_allowed() is
  'R4.10: an open storefront must be valid on EVERY write whose final state is open — '
  'address, opening hours, and the global store_open context. The transition-only check '
  'let an already-open store degrade through updates that never mentioned status.';

-- ----------------------------------------------------------------------------
-- ACCEPTANCE — structural, deliberately.
--
-- The behavioural matrix for this file (atomic fill-and-arm succeeds; arming
-- an incomplete state fails; the telephone→alternative swap succeeds; losing
-- a mandatory fact while armed fails; an open store refuses to lose its
-- address through a status-less update) needs BOTH directions of success and
-- refusal, and success depends on the surrounding data: on an upgraded
-- database with trading stores the arm-context includes conditions this
-- migration must not assume. A chain-level acceptance that arms the gates on
-- whatever data happens to exist would couple the chain to its environment —
-- the exact harness-fidelity trap Increment 1 recorded. The matrix lives in
-- scripts/r410-launch-candidate.test.mjs, which builds its own fresh database
-- and drives every case listed by the audit.
-- ----------------------------------------------------------------------------
do $acceptance$
begin
  if to_regprocedure('public.launch_blocking_reasons(launch_settings)') is null then
    raise exception 'r410_candidate_state: the candidate-row definition is absent';
  end if;
  if to_regprocedure('public.assert_launch_ready(text, text, launch_settings)') is null then
    raise exception 'r410_candidate_state: the candidate assert is absent';
  end if;
  if to_regprocedure('public.launch_settings_no_degradation_while_armed()') is not null then
    raise exception 'r410_candidate_state: the superseded comparative guard still exists';
  end if;
  -- The store gate must now fire on every write, not only on updates that
  -- mention `status`: a column-filtered trigger records the filter in
  -- pg_trigger.tgattr, so an empty attribute list is the property we need.
  if exists (
    select 1 from pg_trigger
     where tgrelid = 'public.stores'::regclass
       and tgname = 'trg_store_open_gate'
       and coalesce(array_length(tgattr::int2[], 1), 0) > 0
  ) then
    raise exception 'r410_candidate_state: trg_store_open_gate is still column-filtered (UPDATE OF status)';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.launch_settings'::regclass
       and tgname = 'trg_launch_settings_transition'
  ) then
    raise exception 'r410_candidate_state: the transition trigger is missing';
  end if;
end
$acceptance$;
