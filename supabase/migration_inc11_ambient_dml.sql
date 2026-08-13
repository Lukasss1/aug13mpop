-- ============================================================================
--  MILK POP — INC11 : NO AMBIENT BROWSER-ROLE DML ON NEW RELATIONS
--                     (removing the ROOT CAUSE, not another symptom)
--
--  THE AUDIT POINT. Revoking privileges from the seven existing views closed
--  the immediate vulnerability. It did not stop the NEXT relation from
--  receiving the same permissions, because the grant never came from a
--  migration — it comes from the default-privilege table:
--
--      pg_default_acl:  public | objtype=r | grantor=postgres
--                       acl = authenticated=arwd/postgres
--
--  `arwd` is INSERT, SELECT, UPDATE, DELETE — handed to `authenticated` on
--  every relation created in this schema, automatically, forever. A view added
--  next month inherits it and the finding returns. The refusing trigger and
--  the live catalogue check would both catch that, but neither should be the
--  mechanism COMPENSATING for an unsafe default. This file removes the
--  default itself.
--
--  DEFAULT PRIVILEGES ARE CREATOR-SPECIFIC. Each row in pg_default_acl belongs
--  to one grantor role; fixing `postgres` does nothing about relations created
--  by another owner. This file therefore does not name a role. It DISCOVERS
--  every default-ACL entry for relations that grants anything to a browser
--  role — whatever the grantor, whatever the schema, including the
--  schema-independent entries — and strips them. If a role's defaults cannot
--  be altered by the deploying user the statement fails LOUDLY, naming the
--  role, because a silent partial fix is exactly what this migration exists to
--  end.
--
--  THE MODEL THIS INSTALLS
--    • no ambient browser-role privilege on newly created relations;
--    • SELECT granted EXPLICITLY, per relation, where a browser genuinely
--      needs to read (the public projections do; most tables do not);
--    • mutation only through reviewed paths — RLS-protected tables with
--      deliberate grants, or the SECURITY DEFINER RPCs that carry their own
--      authority checks.
--
--  EXISTING RELATIONS ARE UNAFFECTED. Default privileges are evaluated at
--  CREATE time, so every table and view already in the schema keeps exactly
--  the grants it has today. What changes is what the NEXT one starts with:
--  nothing.
--
--  SEQUENCES ARE DELIBERATELY LEFT ALONE. `authenticated=rU` on sequences is
--  SELECT + USAGE, and USAGE is what lets a caller's INSERT obtain the next
--  identity value. Revoking it would break legitimate inserts into every
--  serial-keyed table, which is a functional regression, not a hardening.
--
--  APPEND-ONLY: no previously applied migration file is edited.
-- ============================================================================

do $strip_ambient_dml$
declare
  r record;
  v_scope text;
  v_fixed int := 0;
begin
  for r in
    select d.defaclrole::regrole::text            as grantor,
           n.nspname                              as schema_name
      from pg_default_acl d
      left join pg_namespace n on n.oid = d.defaclnamespace
     where d.defaclobjtype = 'r'                       -- relations: tables AND views
       and exists (
             select 1 from aclexplode(d.defaclacl) a
              where a.grantee = 0                                   -- PUBLIC
                 or a.grantee = 'anon'::regrole
                 or a.grantee = 'authenticated'::regrole)
     group by 1, 2
  loop
    v_scope := case when r.schema_name is null then ''
                    else format('in schema %I', r.schema_name) end;
    begin
      execute format(
        'alter default privileges for role %s %s revoke all on tables from public, anon, authenticated',
        r.grantor, v_scope);
    exception when insufficient_privilege then
      raise exception
        'inc11_ambient_dml: the deploying user cannot alter default privileges for role % (scope: %). '
        'That role would keep handing browser roles privileges on every new relation it creates. '
        'Re-run this migration as a user with membership in that role.',
        r.grantor, coalesce(r.schema_name, 'all schemas')
        using errcode = 'insufficient_privilege';
    end;
    v_fixed := v_fixed + 1;
  end loop;

  raise notice 'inc11_ambient_dml: stripped browser-role defaults from % relation default-ACL entr%',
    v_fixed, case when v_fixed = 1 then 'y' else 'ies' end;
end $strip_ambient_dml$;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE — catalogue AND behaviour. The catalogue check proves no entry
-- survives for ANY grantor; the behavioural check proves what actually happens
-- to a relation created after this migration, which is the only thing that
-- really matters.
-- ----------------------------------------------------------------------------
do $acceptance$
declare
  v_rows text;
  v_leaked text;
begin
  -- 1. No default-ACL entry for relations grants a browser role anything.
  select string_agg(coalesce(n.nspname, 'all-schemas') || '/' || d.defaclrole::regrole::text
                    || '/' || array_to_string(d.defaclacl, ' '), ', ')
    into v_rows
    from pg_default_acl d
    left join pg_namespace n on n.oid = d.defaclnamespace
   where d.defaclobjtype = 'r'
     and exists (select 1 from aclexplode(d.defaclacl) a
                  where a.grantee = 0
                     or a.grantee = 'anon'::regrole
                     or a.grantee = 'authenticated'::regrole);
  if v_rows is not null then
    raise exception 'inc11_ambient_dml: a relation default-ACL still arms a browser role: %', v_rows;
  end if;

  -- 2. Behaviour: a NEW relation, created here exactly as a future migration
  --    would create one, must arrive with nothing for the browser. A VIEW is
  --    used deliberately: pg_default_acl objtype 'r' governs tables, views and
  --    materialised views alike, so a view proves the same property — and a
  --    scratch `create table` in a shipped migration would (correctly) trip
  --    the schema-scope contract, which requires every table DECLARED in SQL
  --    to be classified in the registry.
  execute 'create view public.mp_ambient_probe_v as select 1 as id';

  select string_agg(x.s, ', ') into v_leaked from (
    select 'public.mp_ambient_probe_v/' || r || '/' || p as s
      from unnest(array['anon', 'authenticated']) r
      cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
     where has_table_privilege(r, 'public.mp_ambient_probe_v', p)
  ) x;

  execute 'drop view public.mp_ambient_probe_v';

  if v_leaked is not null then
    raise exception
      'inc11_ambient_dml: a newly created relation still arrives with browser privileges: %', v_leaked;
  end if;
end $acceptance$;
