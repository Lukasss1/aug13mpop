-- ============================================================================
--  MILK POP — MIGRATION S5 (STAGE 5): SCOPED app_state
--
--  Run order: after migration_rls_per_role.sql. Safe to re-run.
--
--  BEFORE: one policy let ANY authenticated staff member read and write EVERY
--  app_state row — another team member's clock status, the shared checklists,
--  even the e-mail configuration.
--
--  AFTER: every row carries an explicit scope, derived and enforced on the
--  SERVER from an allow-listed key shape. Direct table writes are revoked;
--  the ONLY write path is the `set_app_state()` transaction below.
--
--    key shape                     scope    write                read
--    ---------                     -----    -----                ----
--    clock_status_<staff_id>       user     that staff member    self + same-store mgr + owner
--    milkpop_checklist_tasks       store    same-store staff     same-store staff + owner
--    milkpop_checklist_audits      store    same-store staff     same-store staff + owner
--    milkpop_shift_covers          store    same-store staff     same-store staff + owner
--    milkpop_email_settings        global   owner                owner
--    anything else                 —        REJECTED             —
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. SCOPE COLUMNS + BACKFILL
-- ---------------------------------------------------------------------------
alter table app_state add column if not exists scope          text not null default 'user'
  check (scope in ('user','store','global'));
alter table app_state add column if not exists owner_staff_id text;
alter table app_state add column if not exists store_id       text;

-- Backfill existing rows by key shape. Clock rows adopt the staff id embedded
-- in the key; store rows without a known store stay NULL (readable only by
-- the owner until the next legitimate write stamps the store).
update app_state
   set scope = 'user',
       owner_staff_id = replace(key, 'milkpop_clock_status_', '')
 where key like 'milkpop_clock_status_%';

update app_state
   set scope = 'store'
 where key in ('milkpop_checklist_tasks','milkpop_checklist_audits','milkpop_shift_covers');

update app_state
   set scope = 'global', owner_staff_id = null, store_id = null
 where key = 'milkpop_email_settings';

-- ---------------------------------------------------------------------------
-- 2. RLS — scope-aware READS; NO direct client writes at all.
-- ---------------------------------------------------------------------------
drop policy if exists appstate_staff        on app_state;
drop policy if exists appstate_select_scope on app_state;

create policy appstate_select_scope on app_state
  for select to authenticated
  using (
    is_owner()
    or (scope = 'user' and (
          owner_staff_id = current_staff_id()
          or (is_manager_or_owner()
              and exists (select 1 from staff_profiles sp
                          where sp.id = app_state.owner_staff_id
                            and sp.store_id = current_staff_store()))))
    or (scope = 'store' and store_id is not distinct from current_staff_store()
        and current_staff_id() is not null)
  );

revoke insert, update, delete on app_state from authenticated;
grant  select on app_state to authenticated;
revoke all on app_state from anon;

-- ---------------------------------------------------------------------------
-- 3. THE ONLY WRITE PATH — allow-listed keys, server-derived scope/ownership.
-- ---------------------------------------------------------------------------
create or replace function set_app_state(p_key text, p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id text := current_staff_id();
  v_store    text := current_staff_store();
  v_scope    text;
  v_owner    text := null;
  v_store_id text := null;
  v_suffix   text;
begin
  if v_staff_id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if p_key is null or length(p_key) > 120 then
    raise exception 'invalid_key';
  end if;

  if p_key like 'milkpop_clock_status_%' then
    -- USER scope: the embedded staff id MUST be the caller's own.
    v_suffix := replace(p_key, 'milkpop_clock_status_', '');
    if v_suffix <> v_staff_id then
      raise exception 'not_your_clock_key' using errcode = '42501';
    end if;
    v_scope := 'user';
    v_owner := v_staff_id;
  elsif p_key in ('milkpop_checklist_tasks','milkpop_checklist_audits','milkpop_shift_covers') then
    -- STORE scope: stamped with the CALLER's store, never a client value.
    v_scope := 'store';
    v_store_id := v_store;
  elsif p_key = 'milkpop_email_settings' then
    -- GLOBAL scope: owner only.
    if not is_owner() then
      raise exception 'owner_only_key' using errcode = '42501';
    end if;
    v_scope := 'global';
  else
    raise exception 'key_not_allowed';
  end if;

  insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
  values (p_key, p_value, v_scope, v_owner, v_store_id, now())
  on conflict (key) do update
     set value = excluded.value,
         scope = excluded.scope,
         owner_staff_id = excluded.owner_staff_id,
         store_id = excluded.store_id,
         updated_at = now();

  return jsonb_build_object('ok', true, 'key', p_key, 'scope', v_scope);
end $$;

revoke all on function set_app_state(text, jsonb) from public;
grant execute on function set_app_state(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- HANDOVER NOTES
-- ---------------------------------------------------------------------------
-- • Store-scoped keys currently hold ONE row per key (matching the app's
--   single-operations-board behaviour). When a second store starts using the
--   checklists, split the keys per store (e.g. milkpop_checklist_tasks:<store>)
--   — the RPC's allow-list is the single place to extend.
-- • A store-scope write by a staff member with NO store (store_id null)
--   creates an owner-only row; assign the person to a store first.
