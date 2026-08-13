-- pos-local-e2e prelude: what Supabase's platform provides, recreated for a
-- LOCAL PostgREST so the real migrations apply verbatim and the REAL Edge
-- Functions run against them. Staff identity comes from JWT claims exactly
-- as in production (request.jwt.claims), just minted by the local gateway.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then
    create role authenticator noinherit login password 'e2e-local-pw';
  end if;
end $$;
grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to service_role;

create or replace function current_staff_id() returns text language sql stable as
$$ select nullif(current_setting('request.jwt.claims', true)::jsonb->>'staff_id','') $$;
create or replace function current_staff_store() returns text language sql stable as
$$ select nullif(current_setting('request.jwt.claims', true)::jsonb->>'staff_store','') $$;
create or replace function is_owner() returns boolean language sql stable as
$$ select coalesce(current_setting('request.jwt.claims', true)::jsonb->>'app_role','') = 'owner' $$;
create or replace function is_manager_or_owner() returns boolean language sql stable as
$$ select coalesce(current_setting('request.jwt.claims', true)::jsonb->>'app_role','') in ('owner','store_manager') $$;
grant execute on function current_staff_id() to anon, authenticated, service_role;
grant execute on function current_staff_store() to anon, authenticated, service_role;
grant execute on function is_owner() to anon, authenticated, service_role;
grant execute on function is_manager_or_owner() to anon, authenticated, service_role;
