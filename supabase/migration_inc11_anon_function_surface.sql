-- ============================================================================
--  MILK POP — INC11 : THE ANONYMOUS FUNCTION SURFACE IS EMPTY
--
--  WHY THIS FILE EXISTS. The external audit's view finding was one symptom of
--  a class, not a lone defect: inherited default privileges hand out
--  authority on objects that have NO row-level security standing behind them.
--  Views were the write-side instance and are closed (previous migration).
--  Functions are the larger instance, and they were still open.
--
--  WHAT THE SWEEP FOUND. Two defaults compound:
--    • PostgreSQL grants EXECUTE to PUBLIC on every new function.
--    • The project inherits ALTER DEFAULT PRIVILEGES … GRANT ALL ON FUNCTIONS
--      TO anon (visible in pg_default_acl as anon=X).
--  So every function ever added has been anonymously executable unless its
--  author remembered an explicit revoke. Seventeen SECURITY DEFINER functions
--  were reachable by `anon` on the chain as packaged. Sixteen fail closed on
--  their own internal gate (not_staff / not authenticated) — by each author's
--  diligence, not by any mechanical control. One did not:
--
--      set role anon; select launch_blocking_reasons();
--        -> the full launch-readiness checklist: which gates are unarmed,
--           what each one is waiting for, and the admin route to fix it
--           (/admin/menu/, /admin/settings/) — to the unauthenticated
--           internet.
--
--  Not a data breach: no personal data, no credentials, no write. It is an
--  operational-posture disclosure that tells a stranger exactly which
--  controls are not yet armed, and it exists for precisely the reason the
--  audit's finding existed — nobody granted it deliberately.
--
--  THE POSTURE THIS FILE INSTALLS. What Increment 3 did for relations
--  ("anonymous access is an EXPLICIT ALLOW-LIST"), this does for functions:
--  the anonymous function surface is EMPTY, and stays empty by default.
--    1. Every project function in the schema has PUBLIC and anon stripped.
--       Nothing else is touched: it was measured, on a scratch database built
--       to the previous migration, that NO function depends on the PUBLIC
--       grant for its real caller — every one already carries an explicit
--       entry of its own. So the revoke removes anonymous inheritance and
--       nothing besides.
--    2. The defaults themselves are corrected, so a function added next year
--       does not re-open this. Safe because pg_default_acl already grants
--       EXECUTE to `authenticated` and to the platform's Edge-Function role
--       in their own right — verified in pg_default_acl, not assumed, so
--       revoking the PUBLIC and anon defaults leaves both untouched.
--    3. scripts/rls-matrix.local.mjs enumerates the anonymous function
--       surface live and fails if it is ever non-empty again.
--
--  NOTE ON SCOPE. No function loses an authorised caller. `authenticated`
--  keeps every RPC it can call today (each gated internally — is_owner(),
--  current_staff_id(), the store-scope predicates), and the Edge Functions'
--  service-role connection is untouched.
--
--  APPEND-ONLY: no previously applied migration file is edited.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Strip PUBLIC and anon from every project function.
--    Deliberately NOT a materialise-then-revoke: re-granting each function's
--    current callers would rewrite ACLs that need no rewriting, and it was
--    verified beforehand that no function depends on PUBLIC for its real
--    caller, so a plain revoke cannot orphan one.
-- ----------------------------------------------------------------------------
do $anon_function_surface$
declare
  f record;
  v_sig text;
begin
  for f in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       -- EXTENSION MEMBERS ARE NOT OURS. pgcrypto's utilities (digest, crypt,
       -- armor…) live in this schema but belong to the extension: rewriting
       -- their ACLs is both an over-reach and unreproducible — pg_dump does
       -- not emit privileges for extension-owned objects, so the baseline
       -- snapshot would no longer rebuild to the same database (caught by the
       -- equivalence gate, which found exactly 22 such grants). They are pure
       -- computation, hold no SECURITY DEFINER rights and reach no data.
       and not exists (select 1 from pg_depend d
                        where d.objid = p.oid and d.deptype = 'e')
     order by p.proname
  loop
    v_sig := format('public.%I(%s)', f.proname, f.args);
    execute format('revoke all on function %s from public, anon', v_sig);
  end loop;
end $anon_function_surface$;

-- ----------------------------------------------------------------------------
-- 2. The defaults, so this cannot silently return.
--    PUBLIC must be revoked as well as anon: anon is a member of PUBLIC, so
--    stripping only the anon default leaves PostgreSQL's built-in PUBLIC
--    EXECUTE grant handing the same access straight back.
--
--    SUBTLETY, VERIFIED THE HARD WAY. The schema-scoped form of that revoke —
--        alter default privileges … IN SCHEMA public revoke … from PUBLIC
--    executes without error, records nothing, and does NOT suppress the
--    built-in grant: a function created afterwards still arrives with
--    `=X/postgres` (PUBLIC) on it. Only the SCHEMA-INDEPENDENT form takes
--    effect. This was caught by the acceptance probe at the bottom of this
--    file, which creates a throwaway function and asks whether anon can
--    execute it, rather than trusting the shape of pg_default_acl.
--
--    Scope note: the schema-independent revoke covers functions created by
--    `postgres` in ANY schema. Every function this project creates lives in
--    `public`; Supabase's own objects in the auth/storage schemas are created
--    by other roles and are untouched.
-- ----------------------------------------------------------------------------
alter default privileges for role postgres
  revoke all on functions from public;
alter default privileges for role postgres in schema public
  revoke all on functions from anon;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE
-- ----------------------------------------------------------------------------
do $acceptance$
declare
  v_reachable text;
begin
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    into v_reachable
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_reachable is not null then
    raise exception 'inc11_anon_functions: anon can still execute: %', v_reachable;
  end if;

  -- The authorised callers are intact — asserted on named, load-bearing
  -- examples rather than trusting the loop.
  if not has_function_privilege('authenticated', 'public.save_website_studio(jsonb, jsonb, bigint, bigint)', 'EXECUTE') then
    raise exception 'inc11_anon_functions: the studio publish RPC lost its authenticated caller';
  end if;
  if not has_function_privilege('authenticated', 'public.transition_application(text, text, text)', 'EXECUTE') then
    raise exception 'inc11_anon_functions: the candidacy transition RPC lost its authenticated caller';
  end if;
  -- The Edge-only public-form gate keeps a non-browser caller: it must be
  -- unreachable by both browser roles and still held by someone.
  if has_function_privilege('anon', 'public.submit_public_form(text, jsonb, uuid, text, text, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.submit_public_form(text, jsonb, uuid, text, text, text, text)', 'EXECUTE') then
    raise exception 'inc11_anon_functions: the public-form gate became browser-reachable';
  end if;
  if (select count(*) from pg_proc p, aclexplode(p.proacl) a
       where p.oid = 'public.submit_public_form(text, jsonb, uuid, text, text, text, text)'::regprocedure
         and a.grantee <> 0
         and a.grantee not in ('anon'::regrole, 'authenticated'::regrole)) = 0 then
    raise exception 'inc11_anon_functions: the public-form gate lost its Edge Function caller';
  end if;

  -- And the corrected defaults BEHAVE, not merely look, correct: create a
  -- throwaway function exactly as a future migration would and ask whether
  -- the anonymous role can execute it.
  execute 'create function public.mp_anon_default_probe() returns int language sql as ''select 1''';
  if has_function_privilege('anon', 'public.mp_anon_default_probe()', 'EXECUTE') then
    execute 'drop function public.mp_anon_default_probe()';
    raise exception 'inc11_anon_functions: a NEWLY created function is still anonymously executable — the default-privilege revoke did not take';
  end if;
  if not has_function_privilege('authenticated', 'public.mp_anon_default_probe()', 'EXECUTE') then
    execute 'drop function public.mp_anon_default_probe()';
    raise exception 'inc11_anon_functions: the revoke over-reached — future functions would be unreachable by the app';
  end if;
  execute 'drop function public.mp_anon_default_probe()';
end $acceptance$;
