-- ============================================================================
--  MILK POP — MIGRATION S11 (STAGE 11): AUTHORITATIVE AUDIT LOGGING
--
--  Run order: after migration_rls_per_role.sql. Safe to re-run.
--
--  MODEL
--  -----
--  • audit_logs stays the single audit stream the owner reads in the panel.
--  • For every row written from a BROWSER session, the actor identity
--    (operator_name, role) and the timestamp are DERIVED on the server from
--    the verified session — whatever the client sent in those fields is
--    discarded. The client's action/module text remains informational.
--  • Server transactions (complete_training, replace_collection, the Edge
--    Functions' activity_log rows) write their own authoritative entries.
--  • Append-only: no UPDATE or DELETE path exists for any browser client —
--    no policies, and the grants are revoked outright.
-- ============================================================================

-- 1. Spoof-proof actor derivation for browser-written rows.
create or replace function audit_logs_stamp() returns trigger
language plpgsql as $$
declare
  v_id   text;
  v_name text;
  v_role text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;  -- server-written rows carry their own derived actor
  end if;
  v_id := current_staff_id();
  if v_id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  select name, role::text into v_name, v_role from staff_profiles where id = v_id;
  new.operator_name := coalesce(v_name, v_id);
  new.role          := coalesce(v_role, '');
  new.timestamp     := now()::text;
  return new;
end $$;
drop trigger if exists trg_audit_logs_stamp on audit_logs;
create trigger trg_audit_logs_stamp before insert on audit_logs
  for each row execute function audit_logs_stamp();

-- 2. Append-only for browsers: reads stay owner-gated; writes are insert-only.
revoke update, delete on audit_logs from authenticated;
revoke all on audit_logs from anon;
grant  select, insert on audit_logs to authenticated;

-- 3. The activity_log stream (Edge-Function audits: document access, uploads,
--    onboarding actions) becomes owner-readable in the panel, still
--    server-written only.
alter table activity_log enable row level security;
drop policy if exists activity_select_owner on activity_log;
create policy activity_select_owner on activity_log
  for select to authenticated using (is_owner());
revoke insert, update, delete on activity_log from authenticated;
grant  select on activity_log to authenticated;
revoke all on activity_log from anon;
