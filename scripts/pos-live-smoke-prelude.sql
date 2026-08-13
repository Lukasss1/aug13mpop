-- pos-live-smoke prelude — creates ONLY what Supabase provides out of the
-- box (the three API roles) and settable stand-ins for the staff helpers
-- from migration_rls_per_role.sql, so migration_pos_sync.sql can be applied
-- VERBATIM to a vanilla local Postgres. Nothing here ships to production.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase grants EXECUTE on every new function to the API roles by default;
-- mirror that so the migration's REVOKES are what carries the security.
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

-- Session-settable identity, mirroring what auth.uid()+staff_profiles give
-- the real helpers:  set smoke.role = 'owner' | 'store_manager' | '' ;
--                    set smoke.store = '<store id>' ;  set smoke.staff = '<id>';
create or replace function current_staff_id() returns text
language sql stable as $$ select nullif(current_setting('smoke.staff', true), '') $$;

create or replace function current_staff_store() returns text
language sql stable as $$ select nullif(current_setting('smoke.store', true), '') $$;

create or replace function is_owner() returns boolean
language sql stable as $$
  select coalesce(current_setting('smoke.role', true) = 'owner', false) $$;

create or replace function is_manager_or_owner() returns boolean
language sql stable as $$
  select coalesce(current_setting('smoke.role', true) in ('owner','store_manager'), false) $$;

grant execute on function current_staff_id() to anon, authenticated, service_role;
grant execute on function current_staff_store() to anon, authenticated, service_role;
grant execute on function is_owner() to anon, authenticated, service_role;
grant execute on function is_manager_or_owner() to anon, authenticated, service_role;
