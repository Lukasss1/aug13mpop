-- ============================================================================
--  MILK POP — INC11 : COLUMN-LEVEL WRITE GRANTS ON VIEWS
--
--  THE AUDIT POINT. The view write-authority migration performs RELATION-level
--  revokes. PostgreSQL column privileges are a SEPARATE access-control list —
--  they live in `pg_attribute.attacl`, not `pg_class.relacl` — and they
--  survive a table-level REVOKE entirely. The packaged schema carries none, and
--  the suites prove that. But a live project that acquired a column-level grant
--  at some point in its history — a console click, a hand-run GRANT during an
--  incident — would NOT be repaired by that migration. The deployed probe would
--  report it; nothing would fix it.
--
--  A finding that a probe can only report is a finding someone has to remember
--  to act on. This migration repairs it instead.
--
--  WHAT IT DOES. For every view and materialised view in a schema a browser
--  role can actually reach, it discovers genuine COLUMN-level INSERT, UPDATE
--  and REFERENCES grants held by `anon`, `authenticated` or PUBLIC, and revokes
--  them column by column. Nothing is hardcoded: no view list, no column list,
--  no schema list.
--
--  WHAT IT DELIBERATELY DOES NOT TOUCH
--    • column-level SELECT — narrowing a read to particular columns is a
--      legitimate pattern, and revoking it would break reads the projections
--      exist to serve;
--    • base tables — column grants there are a deliberate house pattern (the
--      status-column grant on applications, for one) and are backstopped by
--      row-level security. This finding is about views, where nothing stands
--      behind the privilege.
--
--  It reads `pg_attribute.attacl` rather than
--  `information_schema.column_privileges`, because the latter reports one row
--  per column for TABLE-level grants too — which would make this migration
--  attempt to revoke column privileges that do not exist.
--
--  APPEND-ONLY: no previously applied migration file is edited.
-- ============================================================================

do $strip_column_grants$
declare
  r record;
  v_grantee text;
  v_count int := 0;
begin
  for r in
    select n.nspname                                   as sch,
           c.relname                                   as rel,
           a.attname                                   as col,
           x.privilege_type                            as priv,
           x.grantee                                   as grantee_oid
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      cross join lateral aclexplode(a.attacl) x
     where c.relkind in ('v', 'm')
       and a.attacl is not null
       and n.nspname not like 'pg\_%' and n.nspname <> 'information_schema'
       and (has_schema_privilege('anon', n.nspname, 'USAGE')
         or has_schema_privilege('authenticated', n.nspname, 'USAGE'))
       and x.privilege_type in ('INSERT', 'UPDATE', 'REFERENCES')
       and (x.grantee = 0
         or x.grantee = 'anon'::regrole
         or x.grantee = 'authenticated'::regrole)
  loop
    v_grantee := case when r.grantee_oid = 0 then 'PUBLIC'
                      else quote_ident(r.grantee_oid::regrole::text) end;
    execute format('revoke %s (%I) on %I.%I from %s',
                   r.priv, r.col, r.sch, r.rel, v_grantee);
    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    raise notice 'inc11_column_grants: revoked % column-level write grant(s) on views', v_count;
  end if;
end $strip_column_grants$;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE
-- ----------------------------------------------------------------------------
do $acceptance$
declare
  v_left text;
  v_probe_left text;
begin
  -- 1. Nothing of the kind survives anywhere it could matter.
  select string_agg(n.nspname || '.' || c.relname || '.' || a.attname
                    || '/' || x.privilege_type, ', ')
    into v_left
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join lateral aclexplode(a.attacl) x
   where c.relkind in ('v', 'm')
     and a.attacl is not null
     and x.privilege_type in ('INSERT', 'UPDATE', 'REFERENCES')
     and (x.grantee = 0 or x.grantee = 'anon'::regrole or x.grantee = 'authenticated'::regrole);
  if v_left is not null then
    raise exception 'inc11_column_grants: a column-level write grant survives on a view: %', v_left;
  end if;

  -- 2. The repair actually repairs: plant one, run the same logic, prove it
  --    is gone. Without this the block above only asserts that nothing was
  --    there to begin with.
  execute 'create view public.mp_colgrant_probe_v as select 1 as id';
  execute 'grant update (id) on public.mp_colgrant_probe_v to authenticated';

  declare
    r2 record;
    g2 text;
  begin
    for r2 in
      select a.attname as col, x.privilege_type as priv, x.grantee as grantee_oid
        from pg_class c
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        cross join lateral aclexplode(a.attacl) x
       where c.oid = 'public.mp_colgrant_probe_v'::regclass
         and a.attacl is not null
         and x.privilege_type in ('INSERT', 'UPDATE', 'REFERENCES')
         and (x.grantee = 0 or x.grantee = 'anon'::regrole or x.grantee = 'authenticated'::regrole)
    loop
      g2 := case when r2.grantee_oid = 0 then 'PUBLIC'
                 else quote_ident(r2.grantee_oid::regrole::text) end;
      execute format('revoke %s (%I) on public.mp_colgrant_probe_v from %s', r2.priv, r2.col, g2);
    end loop;
  end;

  select string_agg(a.attname || '/' || x.privilege_type, ', ')
    into v_probe_left
    from pg_class c
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join lateral aclexplode(a.attacl) x
   where c.oid = 'public.mp_colgrant_probe_v'::regclass
     and x.privilege_type in ('INSERT', 'UPDATE', 'REFERENCES')
     and (x.grantee = 0 or x.grantee = 'anon'::regrole or x.grantee = 'authenticated'::regrole);

  execute 'drop view public.mp_colgrant_probe_v';

  if v_probe_left is not null then
    raise exception 'inc11_column_grants: the repair did NOT remove a planted column grant: %', v_probe_left;
  end if;
end $acceptance$;
