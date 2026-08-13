-- ============================================================================
--  MILK POP — INC11 : GATED WRAPPERS, UNGATED SOURCES — AND THE STORAGE
--                     POSTURE BECOMES A GATE INSTEAD OF A COMMENT
--
--  PART A — A GATE IS ONLY AS STRONG AS THE THING BEHIND IT.
--
--  The previous migration emptied the ANONYMOUS function surface. Continuing
--  the same sweep one role further found the other half of the same
--  disclosure, and a sharper version of it:
--
--      launch_readiness()          SECURITY DEFINER, gated: `if not is_owner()
--                                  then … 'not_permitted'`. Correct.
--      launch_blocking_reasons()   the enumerator it wraps. NOT gated, and
--                                  executable by `authenticated`.
--
--  PostgREST publishes every function in this schema as an RPC endpoint, so
--  the wrapper's owner check was decoration: a signed-in account with no
--  staff row at all is refused by launch_readiness() and then reads all
--  sixteen rows straight out of launch_blocking_reasons() — every unarmed
--  gate, what each is waiting for, and the admin route that fixes it.
--  Reproduced exactly that way before this file was written.
--
--  Neither function has a client caller: the admin panel calls the gated
--  wrapper (useOwnerRpc('launch_readiness')), and the enumerator is used only
--  inside the schema, where SECURITY DEFINER callers run as the owner. So the
--  enumerator loses its browser reachability entirely rather than acquiring a
--  second gate — one gate, at the wrapper, on the only route that exists.
--
--  One neighbour was examined and deliberately LEFT reachable.
--  collection_revision_checkpoint(text) is an ungated write — it inserts a
--  ledger row for whatever table_key it is handed — and revoking it looked
--  right until the matrix proved otherwise: replace_collection() and
--  close_vacancy() are SECURITY INVOKER, so every ordinary admin publish
--  calls the checkpoint AS THE STAFF MEMBER. Revoking it broke publishing
--  outright. It stays, and is declared in the browser-reachable function
--  contract with its residual: the worst an authenticated caller can do is
--  create an unused ledger row keyed by a string that names no table, which
--  discloses nothing and grants nothing.
--
--  PART B — THE STORAGE POSTURE.
--
--  CVs and staff documents are the only personal data this system holds. They
--  are protected by a deliberate and unusual choice: storage.objects has RLS
--  enabled and NO POLICY AT ALL, so every browser role is denied and the Edge
--  Functions' service-role connection is the only way in. That choice was
--  recorded in a comment — "If you ever see a cvs_* policy on storage.objects,
--  someone re-opened the direct-upload path" — and enforced by nothing.
--
--  A comment is not a control. This file asserts the posture at apply time,
--  and scripts/rls-matrix.local.mjs now proves it behaviourally on every run,
--  under production-shaped privileges (the harness previously granted storage
--  only to the service role, so it was proving "denied" for a reason
--  production does not rely on).
--
--  APPEND-ONLY: no previously applied migration file is edited.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The enumerator behind the gate stops being a browser endpoint.
--    Both overloads: the no-argument form and the candidate-row variant.
-- ----------------------------------------------------------------------------
revoke all on function launch_blocking_reasons() from authenticated;
revoke all on function launch_blocking_reasons(launch_settings) from authenticated;

-- ----------------------------------------------------------------------------
-- 2. The storage posture, asserted rather than described.
-- ----------------------------------------------------------------------------
do $storage_posture$
declare
  v_policies text;
  v_public text;
begin
  select string_agg(policyname, ', ') into v_policies
    from pg_policies where schemaname = 'storage' and tablename = 'objects';
  if v_policies is not null then
    raise exception
      'inc11_storage: storage.objects has acquired % — the CV and staff-document buckets are protected by the ABSENCE of policies; a policy here re-opens the direct browser path this design removed',
      v_policies
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'storage' and c.relname = 'objects' and c.relrowsecurity) then
    raise exception 'inc11_storage: row-level security is not enabled on storage.objects';
  end if;

  select string_agg(id, ', ') into v_public
    from storage.buckets where public and id <> 'menu-media';
  if v_public is not null then
    raise exception
      'inc11_storage: bucket(s) % are PUBLIC — only menu-media (published product imagery) may be', v_public;
  end if;

  if not exists (select 1 from storage.buckets where id = 'cvs' and not public) then
    raise exception 'inc11_storage: the cvs bucket is missing or public';
  end if;
  if not exists (select 1 from storage.buckets where id = 'staff-documents' and not public) then
    raise exception 'inc11_storage: the staff-documents bucket is missing or public';
  end if;
end $storage_posture$;

-- ----------------------------------------------------------------------------
-- ACCEPTANCE
-- ----------------------------------------------------------------------------
do $acceptance$
begin
  if has_function_privilege('authenticated', 'public.launch_blocking_reasons()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.launch_blocking_reasons(launch_settings)', 'EXECUTE') then
    raise exception 'inc11_gate: the readiness enumerator is still a browser endpoint';
  end if;
  -- …and the checkpoint every ordinary publish depends on is still callable.
  if not has_function_privilege('authenticated', 'public.collection_revision_checkpoint(text)', 'EXECUTE') then
    raise exception 'inc11_gate: publishing lost the revision checkpoint it calls as the invoking user';
  end if;

  -- The route that SHOULD exist still does: the owner-gated wrapper, which
  -- reaches the enumerator definer-side.
  if not has_function_privilege('authenticated', 'public.launch_readiness()', 'EXECUTE') then
    raise exception 'inc11_gate: the admin readiness panel lost its RPC';
  end if;

  -- And the assert helper stays reachable: it is called from trigger
  -- functions that run as the INVOKING user, so revoking it would break
  -- ordinary writes. It raises with the blocked KEYS for one named context
  -- and returns nothing otherwise — a far narrower surface than the
  -- enumerator, and declared as such in the browser-reachable function
  -- contract in scripts/rls-matrix.local.mjs.
  if not has_function_privilege('authenticated', 'public.assert_launch_ready(text, text)', 'EXECUTE') then
    raise exception 'inc11_gate: assert_launch_ready lost the caller its triggers need';
  end if;
end $acceptance$;
