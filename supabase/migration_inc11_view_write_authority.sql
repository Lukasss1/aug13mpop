-- ============================================================================
--  MILK POP — INC11 : PUBLIC PROJECTION VIEWS ARE READ-ONLY SURFACES
--
--  THE FINDING (external audit, reproduced and CONFIRMED EXPLOITABLE here).
--  Seven simple public projection views — menu_items_public, stores_public,
--  news_posts_public, job_vacancies_public, deals_public, cms_pages_public,
--  media_assets_public — carried INSERT, UPDATE and DELETE for the
--  `authenticated` role. They are auto-updatable (plain single-table
--  projections), they are owned by `postgres`, and their base tables do NOT
--  have FORCE ROW LEVEL SECURITY. PostgreSQL therefore checks the underlying
--  write as the VIEW OWNER, who is the table owner and thus exempt from RLS:
--  the write lands with every row-level policy skipped.
--
--  PROVEN, not theorised. With a signed-in identity carrying NO staff row at
--  all (a plain customer account), on the chain as packaged:
--      update menu_items        set name='…' where …;  -->  UPDATE 0   (RLS)
--      update menu_items_public set name='…' where …;  -->  UPDATE 1   (!!)
--  and the same through news_posts_public. That is the whole public content
--  surface — menu, deals, vacancies, news, stores, CMS pages, media — writable
--  by any authenticated account, straight past the owner-only content
--  boundary (F2), the AAL2 choke point (M4) and the store-scope predicates.
--
--  WHY IT EXISTED. Nothing granted these privileges deliberately. The project
--  inherits Supabase's default privileges —
--      ALTER DEFAULT PRIVILEGES … GRANT SELECT,INSERT,DELETE,UPDATE
--        ON TABLES TO authenticated
--  — which apply to VIEWS as well as tables. For base tables that is harmless
--  because RLS stands behind the privilege; for a view owned by the table
--  owner there is nothing behind it. Every projection view added since has
--  silently inherited the same hole. anon was never affected: anonymous
--  access is an explicit allow-list (Increment 3) and anon holds SELECT only.
--
--  THE FIX — three layers.
--    1. PRIVILEGE. Every view in the schema is stripped of INSERT, UPDATE,
--       DELETE, TRUNCATE, REFERENCES and TRIGGER for both browser roles.
--       SELECT is untouched, so the public site and the admin projections
--       read exactly as before.
--    2. STRUCTURE. Every auto-updatable view gets an INSTEAD OF trigger that
--       refuses writes outright (`public_view_read_only`). If a future
--       migration creates a view and re-inherits the default privileges, the
--       write is a loud refusal instead of a silent bypass.
--    3. PROOF. scripts/rls-matrix.local.mjs enumerates the views live and
--       fails if any of them ever grants a write privilege to a browser role
--       again, and re-runs the exact exploit above as a permanent negative.
--
--  WHY NOT security_invoker = true. That would push the RLS check onto the
--  caller — and the anonymous caller deliberately has NO base-table read
--  (Increment 3 revoked it; the notice work re-confirmed it). Turning on
--  invoker semantics would close the write hole by breaking every public read
--  the views exist to serve. The views must keep definer-side reads; what
--  they must not keep is write authority.
--
--  WHY NOT strip the default privileges wholesale. Revoking write privileges
--  from `authenticated` for FUTURE tables would change the house pattern for
--  every base table (privilege + RLS + column grants) far beyond this
--  finding, and would fail closed in ways no test currently describes. The
--  recurrence control is layer 3, which catches a new view on the next run.
--
--  APPEND-ONLY: no previously applied migration file is edited.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Strip write authority from every view, for both browser roles.
-- ----------------------------------------------------------------------------
do $revoke_view_writes$
declare
  v record;
begin
  for v in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('v', 'm')
     order by c.relname
  loop
    execute format(
      'revoke insert, update, delete, truncate, references, trigger on public.%I from anon, authenticated',
      v.relname);
  end loop;
end $revoke_view_writes$;

-- ----------------------------------------------------------------------------
-- 2. Structural refusal on every auto-updatable view.
--    (Views that are not auto-updatable — the aggregate reporting views and
--    the DISTINCT ON notice surface — already refuse writes structurally;
--    they keep that property and need no trigger.)
-- ----------------------------------------------------------------------------
create or replace function refuse_public_view_write()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception
    'public_view_read_only: % is a read-only projection — write to the base table through its own guarded path (publish_record, the save RPCs, or the collection publisher), where row-level security and the ownership boundary apply',
    TG_TABLE_NAME
    using errcode = 'insufficient_privilege';
end $$;

do $view_read_only$
declare
  v_names text[];
  v_name text;
begin
  -- Snapshot the auto-updatable views FIRST: attaching an INSTEAD OF trigger
  -- changes what the catalogue reports about them.
  select array_agg(table_name order by table_name) into v_names
    from information_schema.views
   where table_schema = 'public'
     and (is_updatable = 'YES' or is_insertable_into = 'YES');

  if v_names is null then return; end if;

  foreach v_name in array v_names loop
    execute format('drop trigger if exists trg_view_read_only on public.%I', v_name);
    execute format(
      'create trigger trg_view_read_only instead of insert or update or delete on public.%I '
      'for each row execute function refuse_public_view_write()', v_name);
  end loop;
end $view_read_only$;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE — the invariant, asserted on the schema this file produces.
-- ----------------------------------------------------------------------------
do $acceptance$
declare
  v_leaks text;
  v_missing text;
begin
  select string_agg(distinct table_name || '/' || grantee, ', ')
    into v_leaks
    from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee in ('anon', 'authenticated')
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
     and table_name in (select table_name from information_schema.views
                         where table_schema = 'public');
  if v_leaks is not null then
    raise exception 'inc11_view_writes: a view still grants write authority to a browser role: %', v_leaks;
  end if;

  -- The seven named in the finding must all be structurally refusing now.
  select string_agg(t, ', ') into v_missing from unnest(array[
      'menu_items_public', 'stores_public', 'news_posts_public',
      'job_vacancies_public', 'deals_public', 'cms_pages_public',
      'media_assets_public']) t
   where not exists (select 1 from pg_trigger tg
                      where tg.tgname = 'trg_view_read_only'
                        and tg.tgrelid = ('public.' || t)::regclass);
  if v_missing is not null then
    raise exception 'inc11_view_writes: a projection view has no read-only trigger: %', v_missing;
  end if;

  -- And the anonymous read the views exist for is untouched.
  if not exists (select 1 from information_schema.role_table_grants
                  where table_schema = 'public' and grantee = 'anon'
                    and privilege_type = 'SELECT' and table_name = 'menu_items_public') then
    raise exception 'inc11_view_writes: the anonymous read grant was lost — the public site would go dark';
  end if;
end $acceptance$;
