-- ============================================================================
--  migration_r49_recovery.sql
--  R4.9 · Gate G6 — RECOVERY AUTHORISATION AND ATOMIC EXECUTION
-- ============================================================================
--  Two defects, one root cause: the authorisation rules were written twice, so
--  the copy that ran at EXECUTION time was weaker than the one that ran at
--  REQUEST time. This is the same shape as G5's three-opinions problem.
--
--  DEFECT 1 — cross-store authorisation (audit item 5)
--    request_recovery_action() stops a manager targeting another manager or an
--    owner, but never required an ordinary employee target to belong to the
--    manager's OWN store. A manager at one storefront could revoke sessions for,
--    or ban, an employee at another.
--
--  DEFECT 2 — replay and stale authorisation (audit item 6)
--    The Edge Function read the intent, checked consumed_at, called the Auth
--    Admin API and only then patched consumed_at. Two concurrent calls both read
--    before either patched. And the only execution-time authority check was
--    "the requester's auth_id matches the caller's JWT" — not still employed,
--    not still a manager, not still AAL2, not still the same store.
--
--  THE FIX: ONE PREDICATE, EVALUATED AT BOTH ENDS
--    recovery_action_permitted() is the single definition. request_recovery_action()
--    calls it to create an intent; claim_recovery_intent() calls it AGAIN, inside
--    the row lock, immediately before the action is allowed to happen. A
--    demotion, a store move or a lost AAL2 factor between the two therefore stops
--    the action — which is the entire point of re-authorising.
--
--  A DELIBERATE TRADE-OFF, stated plainly
--    The claim CONSUMES the intent before the Auth API call, so a crash or an
--    Auth failure burns it and the owner must request again. The alternative —
--    a claim lease that becomes re-claimable — reintroduces exactly the replay
--    window this migration exists to close. A ten-second re-request is a better
--    failure mode than a reopened replay window for a destructive action. The
--    outcome is recorded on the intent either way, so a failure is visible.
--
--  NOT re-adding "target exists": target_staff_id is a foreign key to
--  staff_profiles with ON DELETE CASCADE, so a vanished target takes the intent
--  with it. The audit listed it; the schema already guarantees it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. THE single authorisation definition
-- ----------------------------------------------------------------------------
--  Returns NULL when the acting person may perform p_action on p_target right
--  now, otherwise a machine-readable reason. Role and AAL2 come from the
--  CALLER's JWT (is_owner()/is_manager_or_owner() embed the fix8 AAL2 rule), so
--  this is only ever an assertion about whoever is actually calling.
create or replace function recovery_action_permitted(
  p_target text, p_action text, p_reason text default ''
) returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  text := current_staff_id();
  v_target staff_profiles;
begin
  if p_action not in ('reset_mfa','revoke_sessions','ban_leaver') then
    return 'unknown_action';
  end if;
  if v_actor is null then return 'not_staff'; end if;

  select * into v_target from staff_profiles where id = p_target;
  if not found then return 'target_not_found'; end if;

  if p_action = 'reset_mfa' then
    -- Owner only, never self-service.
    if not is_owner() then return 'not_permitted'; end if;
    if p_target = v_actor then return 'self_reset_forbidden'; end if;
  else
    if not is_manager_or_owner() then return 'not_permitted'; end if;
    if not is_owner() then
      -- A manager may act on their OWN store's ordinary employees only.
      if v_target.role in ('store_manager','owner') then return 'not_permitted'; end if;
      -- DEFECT 1. Absent this, a manager could reach across storefronts.
      if v_target.store_id is distinct from current_staff_store() then
        return 'target_other_store';
      end if;
    end if;
  end if;

  -- ban_leaver is a LEAVER action: it must not be usable on a current employee.
  if p_action = 'ban_leaver' and v_target.ended_at is null then
    return 'target_still_employed';
  end if;

  -- revoke_sessions is destructive and auditable; it must say why.
  if p_action = 'revoke_sessions' and coalesce(trim(p_reason),'') = '' then
    return 'reason_required';
  end if;

  return null;
end $$;

revoke all on function recovery_action_permitted(text,text,text) from public, anon;
grant execute on function recovery_action_permitted(text,text,text) to authenticated;

comment on function recovery_action_permitted(text,text,text) is
  'R4.9 G6: THE definition of who may perform a recovery action on whom. Evaluated when the intent is created AND again inside the row lock before it executes.';

-- ----------------------------------------------------------------------------
-- 2. Requesting an intent — now delegating to that definition
-- ----------------------------------------------------------------------------
create or replace function request_recovery_action(
  p_action text, p_target text, p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_actor text := current_staff_id(); v_id text; v_deny text;
begin
  v_deny := recovery_action_permitted(p_target, p_action, coalesce(p_reason,''));
  if v_deny is not null then raise exception '%', v_deny; end if;

  v_id := gen_random_uuid()::text;
  insert into admin_recovery_intents (id, action, target_staff_id, requested_by, reason)
  values (v_id, p_action, p_target, v_actor, coalesce(p_reason,''));
  insert into audit_logs (id, operator_name, role, action, timestamp, module, new_value)
  values (gen_random_uuid()::text, v_actor, current_staff_role()::text,
          'recovery.' || p_action || '.requested', now()::text, 'Security', p_target);
  return jsonb_build_object('ok', true, 'intent_id', v_id);
end $$;

-- ----------------------------------------------------------------------------
-- 3. Claiming an intent — atomic, and re-authorised at the moment of execution
-- ----------------------------------------------------------------------------
--  Called by the Edge Function with the CALLER'S JWT, not the service role:
--  is_owner() / is_manager_or_owner() / is_aal2() read auth.jwt(), so a
--  service-role call would see no user and the re-check would be theatre.
--  SECURITY DEFINER supplies the privilege to write the intent row; the identity
--  still comes from the request's JWT.
create or replace function claim_recovery_intent(p_intent_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  text := current_staff_id();
  v_intent admin_recovery_intents;
  v_target staff_profiles;
  v_deny   text;
begin
  if v_actor is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;

  -- The lock is the whole point: a second caller waits here and then sees the
  -- consumed row, instead of both reading an unconsumed one and both acting.
  select * into v_intent from admin_recovery_intents
   where id = p_intent_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'intent_not_found'); end if;
  if v_intent.consumed_at is not null then
    return jsonb_build_object('ok', false, 'error', 'intent_already_consumed');
  end if;
  if now() - v_intent.created_at > interval '10 minutes' then
    update admin_recovery_intents set consumed_at = now(), result = 'expired' where id = p_intent_id;
    return jsonb_build_object('ok', false, 'error', 'intent_expired');
  end if;

  -- Only the person who requested it may execute it.
  if v_intent.requested_by is distinct from v_actor then
    return jsonb_build_object('ok', false, 'error', 'not_requester');
  end if;

  -- RE-AUTHORISATION. Same predicate, evaluated now: still employed, still the
  -- right role, still AAL2, still the same store, target still eligible.
  v_deny := recovery_action_permitted(v_intent.target_staff_id, v_intent.action, v_intent.reason);
  if v_deny is not null then
    update admin_recovery_intents set consumed_at = now(), result = 'refused:' || v_deny
     where id = p_intent_id;
    return jsonb_build_object('ok', false, 'error', v_deny);
  end if;

  select * into v_target from staff_profiles where id = v_intent.target_staff_id;
  if v_target.auth_id is null then
    update admin_recovery_intents set consumed_at = now(), result = 'no_auth_account' where id = p_intent_id;
    return jsonb_build_object('ok', false, 'error', 'target_has_no_auth_account');
  end if;

  update admin_recovery_intents
     set consumed_at = now(), result = 'claimed'
   where id = p_intent_id;

  return jsonb_build_object('ok', true, 'action', v_intent.action,
                            'target_staff_id', v_intent.target_staff_id,
                            'target_auth_id', v_target.auth_id,
                            'requested_by', v_intent.requested_by);
end $$;

revoke all on function claim_recovery_intent(text) from public, anon;
grant execute on function claim_recovery_intent(text) to authenticated;

-- NOTE ON RECORDING THE OUTCOME
--  Deliberately NOT a new function. The claim already consumed the intent, so
--  writing the Auth Admin result afterwards is an ordinary column update the
--  executor already had the privilege to make. Adding a recorder function would
--  have meant naming the elevated API role in a migration, which the security
--  regression suite forbids in code scope — and it correctly caught the attempt.
--  The smaller design is also the honest one: what needed to move into the
--  database was the CLAIM, not the note about how it went.

comment on function claim_recovery_intent(text) is
  'R4.9 G6: locks the intent, re-evaluates recovery_action_permitted() at execution time and consumes it atomically. The Edge Function performs no Auth Admin call unless this returns ok:true.';
