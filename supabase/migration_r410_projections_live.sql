-- ============================================================================
--  MILK POP — R4.10 INCREMENT 5b : the five projections go LIVE.
--
--  This is the second half of a deliberately split increment. 5a built the views
--  and the server-side full-snapshot guard but granted nothing; the public
--  surface was unchanged. 5b flips the reads, and it may only do so because the
--  client half landed with it:
--
--    • src/lib/registries.ts now hydrates dealsFull, newsPostsFull,
--      vacanciesFull, cmsPagesFull and mediaAssetsFull for an authenticated user
--    • src/App.tsx records per-collection AUTHORITY bound to the identity and
--      the hydration generation it came from, and every whole-collection
--      publisher refuses without it
--
--  Without those, narrowing the public read is precisely the P0-2 defect: the
--  client hydrates only the visible rows, publishes the whole collection, and
--  deletes everything it could not see.
--
--  NET EFFECT ON THE ANONYMOUS SURFACE: still twelve relations, but five base
--  tables are replaced by five filtered projections. The count is unchanged; the
--  exposure is not. Draft news, inactive deals, unpublished vacancies, draft CMS
--  pages and the private media library leave the public API here.
--
--  APPEND-ONLY: no previously applied migration is edited by this file.
-- ============================================================================

grant select on deals_public, news_posts_public, job_vacancies_public,
                cms_pages_public, media_assets_public to anon;


-- ----------------------------------------------------------------------------
-- The two projections the BUILD-TIME SEO loader reads need the row timestamps
-- the snapshot/manifest contract requires — the same lesson stores_public taught
-- in Increment 1, caught here by the reconciliation suite before it shipped.
-- ----------------------------------------------------------------------------
create or replace view news_posts_public as
  select id, title, content, category, date, image, tag_color, status, created_at, updated_at
    from news_posts
   where status = 'published';

create or replace view job_vacancies_public as
  select id, title, department, location, salary, type,
         role_description, requirements, responsibilities, created_at, updated_at
    from job_vacancies
   where status = 'published';

grant select on news_posts_public, job_vacancies_public to anon;
grant select on news_posts_public, job_vacancies_public to authenticated;

revoke select on deals, news_posts, job_vacancies, cms_pages, media_assets from anon;

do $acceptance$
declare
  v_missing text[];
  v_open text[];
begin
  select array_agg(x order by x) into v_missing
    from unnest(array['deals_public','news_posts_public','job_vacancies_public',
                      'cms_pages_public','media_assets_public']) as x
   where not has_table_privilege('anon', ('public.' || x)::regclass, 'SELECT');
  if v_missing is not null then
    raise exception 'r410_projections_live: projections not readable by anon: %', v_missing;
  end if;

  select array_agg(x order by x) into v_open
    from unnest(array['deals','news_posts','job_vacancies','cms_pages','media_assets']) as x
   where has_table_privilege('anon', ('public.' || x)::regclass, 'SELECT');
  if v_open is not null then
    raise exception 'r410_projections_live: base tables still anon-readable: %', v_open;
  end if;
end
$acceptance$;
