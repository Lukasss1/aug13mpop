-- ============================================================================
--  MILK POP — THE SHARED SUPABASE PRIVILEGE POSTURE FOR LOCAL DATABASE HARNESSES
--
--  WHY THIS FILE EXISTS
--  --------------------
--  The R4.10 deployment audit measured a split across the ten database
--  harnesses. Four of them (rls-matrix, r49-publish-safety, r49-recovery,
--  r48-upgrade-scenario) mirrored Supabase's REAL default privileges, in which
--  `anon` and `authenticated` are granted on new tables in the public schema and
--  RLS is the actual gate. The other six granted tables only to `service_role`.
--
--  A suite running on the restrictive shim starts from a MORE LOCKED-DOWN state
--  than production. It can still prove that an explicit REVOKE worked — but it
--  can never detect a relation left readable by ambient grant, because in its
--  world that relation was never granted in the first place. That asymmetry is
--  exactly why the wide anonymous read surface survived 1,606 passing assertions.
--
--  So: ONE posture, stated once, in a file every harness can source. The point
--  of a test database is to be wrong in the same way production is wrong.
--
--  USAGE
--    psql -v ON_ERROR_STOP=1 -d "$DB" -f scripts/lib/supabase-local-privileges.sql
--
--  R4.10 INCREMENT 1 introduces this file and uses it from the new public-contract
--  reconciliation suite. INCREMENT 4 repoints the remaining harnesses at it and
--  adds the meta-test that forbids local GRANT/REVOKE setup outside this file.
--  Existing harnesses are deliberately NOT edited here — that is its own
--  increment with its own re-proof, and this file must not silently change what
--  a passing suite was asserting.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. The three PostgREST API roles.
-- ----------------------------------------------------------------------------
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$roles$;

grant usage on schema public to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. Supabase's ambient default privileges — THE POINT OF THIS FILE.
--
--    In a real Supabase project the public schema carries default privileges
--    granting the API roles on objects created by the migration owner. That is
--    why the chain contains REVOKE statements (menu_items, stores) and no
--    matching GRANTs: it is narrowing an ambient grant, not building up from
--    nothing. Reproduce that, or every privilege assertion is measured against
--    a database that does not resemble the deployed one.
-- ----------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to anon, authenticated, service_role;

-- Also set them unqualified, so objects created by whichever role runs the
-- harness (not only `postgres`) inherit the same posture.
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to service_role;

-- ----------------------------------------------------------------------------
-- 3. auth: session-variable-backed uid()/jwt() so tests can impersonate.
--    `grant usage on schema auth` matters — replace_collection is SECURITY
--    INVOKER, so auth.jwt() runs as the caller and fails without it.
-- ----------------------------------------------------------------------------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- auth.uid() must accept BOTH conventions the harnesses use, because
-- consolidating them revealed they disagreed. Some set the discrete
-- `request.jwt.claim.sub`; others set the whole `request.jwt.claims` JSON blob,
-- which is what real Supabase and PostgREST actually do. A shim that honours
-- only one silently returns NULL for the other, and every ownership check
-- evaluated against it quietly fails open or closed depending on the policy.
-- The claims blob is preferred, with the discrete variable as fallback.
create or replace function auth.uid() returns uuid language sql stable as
  $$ select coalesce(
       nullif(coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub', ''),
       nullif(current_setting('request.jwt.claim.sub', true), '')
     )::uuid $$;

create or replace function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;

-- ----------------------------------------------------------------------------
-- 4. storage: only the columns the application SQL actually touches.
-- ----------------------------------------------------------------------------
-- auth.role(): PostgREST exposes the request role through the same claims blob.
-- The RLS matrix reads it; every other harness simply never needed it, which is
-- another way the shims had drifted apart.
create or replace function auth.role() returns text language sql stable as
  $$ select coalesce(auth.jwt() ->> 'role', 'anon') $$;

create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner uuid,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;
grant all on storage.buckets, storage.objects to service_role;
-- PRODUCTION SHAPE (INC11): Supabase grants the browser roles table
-- privileges on storage.objects and governs access ENTIRELY through RLS
-- policies. The harness previously granted storage to the service role
-- alone, so every suite proved "the browser cannot reach a CV" for a reason
-- production does not rely on. Granting them here means the local proof
-- rests on what actually protects the bytes in production: RLS is on and
-- there is NO POLICY, so every browser read and write is denied.
grant all on storage.buckets, storage.objects to anon, authenticated;
