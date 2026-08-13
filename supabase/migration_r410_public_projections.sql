-- ============================================================================
--  MILK POP — R4.10 INCREMENT 5a : publication lifecycles, the five public
--  projections, and a server-side guard against truncated whole-collection
--  publishes.
--
--  WHY THIS IS 5a AND NOT ALL OF 5
--  -------------------------------
--  The plan is explicit that a filtered public view must land together with its
--  admin hydration and publish guard, "or it recreates P0-2" — the defect where
--  a client that hydrated from a NARROW public projection then published the
--  whole collection and silently deleted every row it could not see.
--
--  So the ordering here is deliberate:
--    5a (this migration)  the lifecycles, the five views, and the SERVER-SIDE
--                         guard. The views are built but NOT granted to anon,
--                         and no client read is repointed. Nothing about the
--                         public surface changes yet.
--    5b                   repoint SYNC_MAP readTable at each view, split
--                         publicX/adminX hydration, add CollectionAuthority,
--                         then grant each view and revoke its base table in one
--                         step — dropping the anonymous ratchet below 12.
--
--  Landing the guard FIRST means 5b's repoint is protected by a server-side
--  refusal from the moment it happens, rather than depending on the client
--  change being correct.
--
--  APPEND-ONLY: no previously applied migration is edited by this file.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- R4.10.5a.1  Publication lifecycle where there is none.
-- ----------------------------------------------------------------------------
-- job_vacancies has no lifecycle at all today: every row is public the moment it
-- exists. news_posts and cms_pages already carry `status`; deals carries
-- `active`; media_assets carries nothing.
--
-- BACKFILL DECISION, STATED EXPLICITLY: existing rows are set to the value that
-- PRESERVES TODAY'S BEHAVIOUR, and the DEFAULT for new rows is the closed one.
-- Silently unpublishing a live vacancy during an upgrade would be a worse defect
-- than the one being fixed; making the next one draft-by-default is the fix.
do $lifecycle$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'job_vacancies' and column_name = 'status'
  ) then
    alter table job_vacancies add column status text not null default 'draft';
    -- Existing vacancies were visible; keep them visible.
    update job_vacancies set status = 'published';
    alter table job_vacancies
      add constraint job_vacancies_status_chk
      check (status in ('draft', 'published', 'closed'));
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'media_assets' and column_name = 'is_public'
  ) then
    -- No existing asset was ever EXPLICITLY marked for public delivery, so the
    -- honest backfill is false. This changes nothing until 5b repoints the read.
    alter table media_assets add column is_public boolean not null default false;
  end if;
end
$lifecycle$;

comment on column job_vacancies.status is
  'draft | published | closed. R4.10: new vacancies default to draft; existing rows were '
  'backfilled to published so an upgrade does not silently unpublish a live listing.';
comment on column media_assets.is_public is
  'R4.10: explicit public-delivery flag, default false. An asset is published deliberately, never by existing.';

-- ----------------------------------------------------------------------------
-- R4.10.5a.2  The five public projections.
-- ----------------------------------------------------------------------------
-- Built, but deliberately NOT granted to anon. scripts/contracts/public-contract.json
-- carries them with status "built", and the reconciliation suite asserts exactly
-- that: present in the database, absent from the anonymous surface. 5b grants
-- each one and revokes its base table in the same step.
--
-- Column choice: customer-safe only. Anything an operator uses to decide whether
-- to publish (status flags, internal notes, audit columns) stays off the view.

create or replace view deals_public as
  select id, name, description, type, category, badge,
         buy_qty, free_qty, percent_off, amount_off, bundle_price, min_order_value
    from deals
   where active = true;

create or replace view news_posts_public as
  select id, title, content, category, date, image, tag_color
    from news_posts
   where status = 'published';

create or replace view job_vacancies_public as
  select id, title, department, location, salary, type,
         role_description, requirements, responsibilities
    from job_vacancies
   where status = 'published';

create or replace view cms_pages_public as
  select id, page_name, title, hero_headline, hero_subheadline, hero_image,
         about_image1, about_image2, cta_text, section_content,
         seo_title, seo_description
    from cms_pages
   where status = 'published';

create or replace view media_assets_public as
  select id, name, folder, type, url
    from media_assets
   where is_public = true;

-- No grants. The anonymous surface is unchanged by this migration.
revoke all on deals_public, news_posts_public, job_vacancies_public,
               cms_pages_public, media_assets_public from public;
grant select on deals_public, news_posts_public, job_vacancies_public,
                cms_pages_public, media_assets_public to authenticated;

comment on view deals_public is 'R4.10 Increment 5: active deals only. NOT yet granted to anon — see 5b.';
comment on view news_posts_public is 'R4.10 Increment 5: published posts only. NOT yet granted to anon — see 5b.';
comment on view job_vacancies_public is 'R4.10 Increment 5: published vacancies only. NOT yet granted to anon — see 5b.';
comment on view cms_pages_public is 'R4.10 Increment 5: published pages only. NOT yet granted to anon — see 5b.';
comment on view media_assets_public is 'R4.10 Increment 5: explicitly public assets only. NOT yet granted to anon — see 5b.';

-- ----------------------------------------------------------------------------
-- R4.10.5a.3  THE GUARD — a whole-collection publish must be a WHOLE collection.
-- ----------------------------------------------------------------------------
-- replace_collection() deletes every row absent from the payload. That is correct
-- when the payload is a complete authenticated snapshot and catastrophic when it
-- is a filtered public projection — the exact shape of P0-2.
--
-- The server cannot tell "deliberately removed" from "never loaded" by looking at
-- the payload alone. So the caller must SAY what it believed it was replacing:
-- an expected total. If the caller's own view of the table disagrees, the
-- publish is refused rather than applied.
--
-- The count is taken AS THE CALLER, inside the same SECURITY INVOKER context, so
-- it is measured through exactly the RLS the caller is subject to. A client that
-- hydrated 3 rows from a public view while the table holds 10 gets a refusal,
-- not a silent deletion of 7.
create or replace function assert_full_collection_snapshot(
  p_table text,
  p_rows jsonb,
  p_expected_total integer
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_visible integer;
  v_payload integer := coalesce(jsonb_array_length(p_rows), 0);
begin
  if p_expected_total is null then
    return;  -- caller has not adopted the guard yet; 5b makes it mandatory
  end if;

  execute format('select count(*) from %I', p_table) into v_visible;

  if p_expected_total <> v_visible then
    raise exception
      'collection_snapshot_stale: % holds % row(s) but the publisher believed it held %. '
      'The snapshot was taken before the table changed, or it came from a filtered '
      'projection. Re-hydrate from the authenticated collection and publish again.',
      p_table, v_visible, p_expected_total
      using errcode = 'check_violation';
  end if;

  if v_payload < v_visible then
    raise exception
      'collection_snapshot_truncated: publishing % row(s) over a table holding % would '
      'delete % row(s) the publisher never loaded. Refused.',
      v_payload, v_visible, v_visible - v_payload
      using errcode = 'check_violation';
  end if;
end
$$;

revoke all on function assert_full_collection_snapshot(text, jsonb, integer) from public;
-- Granted to `authenticated` only. The security scanner forbids the elevated
-- role identifier from appearing anywhere in code, and the guard has no need
-- of it: it is called through replace_collection as the authenticated caller,
-- and an elevated connection bypasses RLS regardless.
grant execute on function assert_full_collection_snapshot(text, jsonb, integer) to authenticated;

comment on function assert_full_collection_snapshot(text, jsonb, integer) is
  'R4.10 Increment 5: refuses a whole-collection publish whose payload is smaller than the '
  'caller-visible table, or whose expected total disagrees with it. SECURITY INVOKER, so the '
  'count is measured through the caller''s own RLS.';

-- ----------------------------------------------------------------------------
-- ACCEPTANCE
-- ----------------------------------------------------------------------------
do $acceptance$
declare
  v text;
  v_missing text[];
  v_granted text[];
begin
  -- 1. all five views exist
  select array_agg(x order by x) into v_missing
    from unnest(array['deals_public','news_posts_public','job_vacancies_public',
                      'cms_pages_public','media_assets_public']) as x
   where to_regclass('public.' || x) is null;
  if v_missing is not null then
    raise exception 'r410_public_projections: views missing: %', v_missing;
  end if;

  -- 2. none of them is anonymously readable YET — that is 5b
  select array_agg(x order by x) into v_granted
    from unnest(array['deals_public','news_posts_public','job_vacancies_public',
                      'cms_pages_public','media_assets_public']) as x
   where has_table_privilege('anon', ('public.' || x)::regclass, 'SELECT');
  if v_granted is not null then
    raise exception 'r410_public_projections: granted to anon before 5b: %', v_granted;
  end if;

  -- 3. the lifecycle columns exist with the closed default
  select column_default into v from information_schema.columns
   where table_schema='public' and table_name='job_vacancies' and column_name='status';
  if v is null or v not like '%draft%' then
    raise exception 'r410_public_projections: job_vacancies.status default is % (want draft)', v;
  end if;

  select column_default into v from information_schema.columns
   where table_schema='public' and table_name='media_assets' and column_name='is_public';
  if v is null or v not like '%false%' then
    raise exception 'r410_public_projections: media_assets.is_public default is % (want false)', v;
  end if;

  -- 4. the guard exists
  if to_regprocedure('public.assert_full_collection_snapshot(text, jsonb, integer)') is null then
    raise exception 'r410_public_projections: the full-snapshot guard is absent';
  end if;
end
$acceptance$;
