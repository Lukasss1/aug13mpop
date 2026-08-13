-- ============================================================================
--  MILK POP — R4.10 INCREMENT 3 : the anonymous surface becomes an EXPLICIT
--  ALLOW-LIST instead of an ambient grant that was narrowed twice.
--
--  WHAT WAS WRONG
--  --------------
--  The migration chain contains ZERO `grant ... to anon`. It inherited Supabase's
--  ambient default privileges — which grant the API roles on every new table in
--  the public schema — and narrowed that by revoking exactly two relations
--  (menu_items in R4.9, stores in WS6f). The deployment audit measured what that
--  leaves, on a database built from this chain with production-fidelity defaults:
--
--      anon holds SELECT on 33 tables and 6 views
--      10 are actually readable
--      23 are HELD-BUT-DENIED — closed by RLS deny-by-default alone
--
--  Those 23 include payslips, clock_history, work_shifts, job_applications,
--  contact_messages, franchise_inquiries, staff_compliance_records,
--  payroll_export_batches, admin_recovery_intents and notification_outbox. Every
--  one of them is a single accidental `create policy ... using (true)` away from
--  being readable by anyone on the internet, and NO SUITE WOULD HAVE FAILED —
--  the RLS matrix asserts what IS permitted, never what must NEVER be.
--
--  There is no defence in depth in that arrangement. RLS is load-bearing and
--  alone.
--
--  WHAT THIS DOES
--  --------------
--  Inverts the default. Revoke every table and view in the public schema from
--  anon, then grant back ONLY the relations the public application demonstrably
--  needs. The allow-list is declared in scripts/contracts/anon-surface.json and
--  reconciled against the real database by
--  scripts/r410-public-contract-reconciliation.mjs §8, which fails in BOTH
--  directions — a relation gaining access that is not declared, or a declared
--  relation losing it.
--
--  HOW THE ALLOW-LIST WAS DERIVED — from the code, not from opinion:
--    • src/lib/cloudSync.ts SYNC_MAP entries marked access: 'public_read',
--      using `readTable` where declared (menu_items -> menu_items_public,
--      stores -> stores_public)
--    • the relations scripts/load-public-content.ts fetches at build time
--    • the relations the public forms need to show a published privacy notice
--
--  WHAT THIS DELIBERATELY DOES NOT DO
--  ----------------------------------
--  1. It does not touch `authenticated`. Staff and admin access is gated by RLS
--     against a real identity; narrowing it here would be a second, unrelated
--     change landing inside a security migration.
--  2. It grants the three public form tables NOTHING. Phase B already moved
--     submission to the public-form Edge Function (service role, server side);
--     launch/verify-current-baseline.sql enforces that anon holds no direct
--     INSERT, and this file asserts the same.
--  3. It does not yet close deals, news_posts, job_vacancies, cms_pages or
--     media_assets. The public application reads those BASE TABLES directly
--     today, so revoking them now would break the public site and undo
--     Increment 1's exit criterion. They stay on the allow-list marked TEMPORARY
--     with the reason recorded, and Increment 5 replaces each with a filtered
--     projection. That is honest sequencing, not an oversight: the 23
--     held-but-denied relations are the actual risk and they close here.
--  4. It does not remove the stale policies that still name `anon` on
--     menu_items and stores. Those tables are revoked, so the policies are inert;
--     they are tracked by the `stale_anon_policies_expected` ratchet and removed
--     in Increment 5 alongside the new views.
--
--  DEFAULT PRIVILEGES
--  ------------------
--  Revoking today's objects is not enough — the ambient default would re-grant
--  the NEXT table someone creates. The default privileges are altered too, so a
--  new relation is private on creation and must be added to the allow-list
--  deliberately.
--
--  APPEND-ONLY: no previously applied migration is edited by this file.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- R4.10.3a  Stop the ambient grant at the source.
-- ----------------------------------------------------------------------------
-- Both forms are issued: the role-qualified one matches how Supabase records its
-- defaults, and the unqualified one covers objects created by whichever role runs
-- a future migration.
do $defaults$
declare
  v_owner text := current_user;
begin
  execute format(
    'alter default privileges for role %I in schema public revoke all on tables from anon', v_owner);
  execute format(
    'alter default privileges for role %I in schema public revoke all on sequences from anon', v_owner);
exception when others then
  -- A managed platform may not permit altering defaults for another role; the
  -- explicit revoke below is the load-bearing part and still applies.
  raise notice 'r410_anon_surface: could not alter default privileges for %: %', v_owner, sqlerrm;
end
$defaults$;

alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

-- ----------------------------------------------------------------------------
-- R4.10.3b  Revoke every existing table and view from anon.
-- ----------------------------------------------------------------------------
-- SELECT and every other verb: a relation that anon may not read is also one it
-- may not write. The three public form tables get their INSERT back immediately
-- afterwards, so the window is within this transaction only.
do $revoke_all$
declare
  r record;
begin
  for r in
    select c.oid::regclass as rel
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'v', 'm', 'p')
  loop
    execute format('revoke all on %s from anon', r.rel);
  end loop;
end
$revoke_all$;

-- ----------------------------------------------------------------------------
-- R4.10.3c  Grant back the declared allow-list.
-- ----------------------------------------------------------------------------
-- PERMANENT — intentionally public projections and reference data.
grant select on site_settings                  to anon;
grant select on site_content                   to anon;
grant select on menu_items_public              to anon;
grant select on stores_public                  to anon;
grant select on privacy_notice_versions        to anon;  -- RLS: published_at is not null
grant select on product_allergen_declarations  to anon;  -- RLS: state = 'approved'
grant select on allergen_catalogue             to anon;  -- statutory reference data

-- TEMPORARY — base tables the public app still reads directly. Increment 5
-- replaces each with a filtered projection and revokes the base table. Recorded
-- in scripts/contracts/anon-surface.json with `status: "TEMPORARY"`.
grant select on deals                          to anon;  -- -> deals_public
grant select on news_posts                     to anon;  -- -> news_posts_public
grant select on job_vacancies                  to anon;  -- -> job_vacancies_public
grant select on cms_pages                      to anon;  -- -> cms_pages_public
grant select on media_assets                   to anon;  -- -> media_assets_public

-- PUBLIC FORM TABLES — NO ANONYMOUS PRIVILEGE OF ANY KIND, not even INSERT.
--
-- An earlier draft of this migration granted anon INSERT on the three form
-- tables, on the strength of a comment in src/lib/cloudSync.ts describing
-- "anon INSERT only (typed wrappers in lib/supabase.ts)". That comment is STALE.
-- launch/verify-current-baseline.sql:358 asserts the opposite as a baseline
-- invariant, and it caught the regression immediately:
--
--     BASELINE FAIL: anon can directly INSERT into contact_messages
--                    (Phase B not applied)
--
-- Phase B moved public submission to the `public-form` Edge Function, which
-- writes server-side with the service role after Turnstile, rate limiting and
-- the privacy-notice gate. A direct anonymous INSERT would bypass all of it.
-- Nothing is granted here, and the acceptance block below asserts the absence.

-- ----------------------------------------------------------------------------
-- ACCEPTANCE — fails the install if the surface is not exactly as declared.
-- ----------------------------------------------------------------------------
do $acceptance$
declare
  v_allowed text[] := array[
    'site_settings','site_content','menu_items_public','stores_public',
    'privacy_notice_versions','product_allergen_declarations','allergen_catalogue',
    'deals','news_posts','job_vacancies','cms_pages','media_assets'
  ];
  v_never text[] := array[
    'stores','menu_items','staff_profiles','payslips','work_shifts','clock_history',
    'job_applications','contact_messages','franchise_inquiries','launch_settings',
    'admin_recovery_intents','payroll_export_batches','notification_outbox',
    'staff_compliance_records','sifr_reports','orders','app_state',
    'daily_sales','sales_by_channel','top_products','popular_modifiers'
  ];
  v_unexpected text[];
  v_missing text[];
  v_leaked text[];
  r record;
begin
  -- 1. nothing outside the allow-list may be anon-selectable
  select array_agg(c.relname order by c.relname) into v_unexpected
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind in ('r','v','m','p')
     and has_table_privilege('anon', c.oid, 'SELECT')
     and c.relname <> all(v_allowed);
  if v_unexpected is not null then
    raise exception 'r410_anon_surface: relations anon can SELECT that are NOT on the allow-list: %', v_unexpected;
  end if;

  -- 2. every allow-listed relation must actually be readable, or the public site is dark
  select array_agg(a order by a) into v_missing
    from unnest(v_allowed) as a
   where to_regclass('public.' || a) is not null
     and not has_table_privilege('anon', ('public.' || a)::regclass, 'SELECT');
  if v_missing is not null then
    raise exception 'r410_anon_surface: allow-listed relations anon CANNOT read: %', v_missing;
  end if;

  -- 3. the never-list must hold, explicitly and by name
  select array_agg(t order by t) into v_leaked
    from unnest(v_never) as t
   where to_regclass('public.' || t) is not null
     and has_table_privilege('anon', ('public.' || t)::regclass, 'SELECT');
  if v_leaked is not null then
    raise exception 'r410_anon_surface: relations that must NEVER be anon-readable are readable: %', v_leaked;
  end if;

  -- 4. the three public form tables must carry NO anonymous privilege at all.
  --    Phase B routes submission through the public-form Edge Function; a direct
  --    anon INSERT would bypass Turnstile, rate limiting and the notice gate.
  for r in select unnest(array['job_applications','contact_messages','franchise_inquiries']) as t loop
    if has_table_privilege('anon', ('public.' || r.t)::regclass, 'INSERT')
       or has_table_privilege('anon', ('public.' || r.t)::regclass, 'SELECT') then
      raise exception 'r410_anon_surface: anon holds a direct privilege on % — Phase B requires the public-form Edge Function', r.t;
    end if;
  end loop;
end
$acceptance$;

comment on schema public is
  'Milk Pop application schema. R4.10 Increment 3: anonymous access is an EXPLICIT ALLOW-LIST — '
  'everything is revoked from anon by default (including default privileges for future relations) '
  'and only the relations declared in scripts/contracts/anon-surface.json are granted back. '
  'Adding a table does NOT make it public; it must be added to the contract deliberately.';
