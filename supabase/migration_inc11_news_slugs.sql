-- ============================================================================
--  MILK POP — INC11 : NEWS SET-ONCE SLUGS
--
--  THE PROBLEM (from the public-test plan). News URLs are DERIVED client-side
--  from the post title (slugify(title) || slugify(id)). Titles are editable
--  after publication, so editing a published headline silently changes the
--  post's address: shared links 404 to the list view, the sitemap and the
--  prerendered page part company with the live route, and search engines see
--  a moved page with no forwarding address.
--
--  THE MODEL. A post's address is FROZEN the moment it first becomes
--  published:
--    • news_posts.slug — stamped server-side at first publication from the
--      title (same normalisation as the client: unaccent → lower →
--      non-alphanumerics collapse to '-' → trimmed → 80 chars), with the
--      last 4 id characters appended only if the base collides.
--    • Once stamped, the slug is IMMUTABLE — corrections change the title,
--      never the address. (Published posts already cannot be deleted — the
--      publication-scope guard from the lifecycle migration — so a frozen
--      address cannot be freed for reuse either.)
--    • Unpublished drafts have NO slug and their titles remain freely
--      editable; the client keeps deriving a preview address for them.
--    • Existing published posts are BACKFILLED with the slug their title
--      derives today, so every link already in the wild keeps working.
--
--  APPEND-ONLY: no previously applied migration file is edited.
-- ============================================================================

alter table news_posts add column if not exists slug text;

create unique index if not exists news_posts_slug_key
  on news_posts (slug) where slug is not null;

-- ----------------------------------------------------------------------------
-- 1. The server's slugify — mirrors src/lib/router.ts slugify():
--    diacritic fold → lower → [^a-z0-9]+ → '-' → trim '-' → 80 chars.
--    The fold is a SELF-CONTAINED translate() map (the launch baseline is
--    deliberately extension-free, so unaccent is not available to it):
--    the Latin diacritics an owner-written headline will realistically
--    contain fold to their base letters exactly as the client's NFKD strip
--    does; anything rarer collapses to '-' like every other non-alphanumeric.
-- ----------------------------------------------------------------------------
create or replace function news_slugify(p_input text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select left(
           trim(both '-' from
             regexp_replace(
               lower(translate(coalesce(p_input, ''),
                 'ÀÁÂÃÄÅàáâãäåĀāĂăĄąÇçĆćČčÈÉÊËèéêëĒēĖėĘęĚěÌÍÎÏìíîïĪīĮįÑñŃńŇňÒÓÔÕÖØòóôõöøŌōŒœŚśŠšÙÚÛÜùúûüŪūŮůŸÿÝýŹźŻżŽžÐðÞþßŁł',
                 'AAAAAAaaaaaaAaAaAaCcCcCcEEEEeeeeEeEeEeEeIIIIiiiiIiIiNnNnNnOOOOOOooooooOoOoSsSsUUUUuuuuUuUuYyYyZzZzZzDdTtsLl')),
               '[^a-z0-9]+', '-', 'g')),
           80);
$$;

-- ----------------------------------------------------------------------------
-- 2. Stamp at first publication; refuse every later change.
--    Runs BEFORE the row lands, on both vehicles that can make a post
--    published: publish_record's sanctioned UPDATE and a born-published
--    INSERT (seed/superuser). Collision policy: base slug, else
--    base-<last 4 of id>, else refuse loudly (two posts would need equal
--    titles AND equal id tails — configuration, not runtime, territory).
-- ----------------------------------------------------------------------------
create or replace function assert_news_slug_discipline()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_base text;
  v_candidate text;
begin
  -- Immutability: once a slug exists it never changes and never empties.
  if TG_OP = 'UPDATE' and old.slug is not null
     and new.slug is distinct from old.slug then
    raise exception
      'news_slug_immutable: the address of a published post is frozen — edit the title, not the slug (post %)',
      old.id
      using errcode = 'check_violation';
  end if;

  -- Stamp exactly once: the row is becoming (or arriving) published with no
  -- slug yet. Everything else passes through untouched.
  if new.status = 'published' and new.slug is null then
    v_base := news_slugify(new.title);
    if v_base = '' then v_base := news_slugify(new.id); end if;
    v_candidate := v_base;
    if exists (select 1 from news_posts where slug = v_candidate and id <> new.id) then
      v_candidate := left(v_base, 75) || '-' || right(new.id, 4);
    end if;
    if exists (select 1 from news_posts where slug = v_candidate and id <> new.id) then
      raise exception
        'news_slug_collision: % is already the address of another post — retitle one of them',
        v_candidate
        using errcode = 'unique_violation';
    end if;
    new.slug := v_candidate;
  end if;

  return new;
end $$;

drop trigger if exists trg_news_slug_discipline on news_posts;
create trigger trg_news_slug_discipline
  before insert or update on news_posts
  for each row execute function assert_news_slug_discipline();

-- ----------------------------------------------------------------------------
-- 3. Backfill: every already-published post gets the slug its title derives
--    TODAY — the address links in the wild are already using.
-- ----------------------------------------------------------------------------
do $backfill$
declare
  r record;
begin
  for r in select id from news_posts where status = 'published' and slug is null
           order by created_at, id
  loop
    -- A slug-only no-op touch routes each row through the stamping trigger
    -- (slug null + published → stamp), so the collision policy above is the
    -- ONLY minting code path — while deliberately NOT re-asserting status,
    -- which would invite the publication-scope final-state guard to
    -- re-validate legacy rows this migration has no business re-judging.
    update news_posts set slug = slug where id = r.id;
  end loop;
end $backfill$;

-- ----------------------------------------------------------------------------
-- 4. The anonymous projection carries the frozen address — public visitors
--    build links from THIS view, so the canonical slug must be in it.
--    (Same definition as before, plus slug; still published rows only.)
-- ----------------------------------------------------------------------------
create or replace view news_posts_public as
  select id, title, content, category, date, image, tag_color,
         status, created_at, updated_at, slug
    from news_posts
   where status = 'published';

-- ----------------------------------------------------------------------------
-- ACCEPTANCE
-- ----------------------------------------------------------------------------
do $acceptance$
begin
  if not exists (select 1 from information_schema.columns
                  where table_name = 'news_posts' and column_name = 'slug') then
    raise exception 'inc11_slugs: news_posts.slug is absent';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_news_slug_discipline'
                   and tgrelid = 'news_posts'::regclass) then
    raise exception 'inc11_slugs: the slug discipline trigger is absent';
  end if;
  if exists (select 1 from news_posts where status = 'published' and slug is null) then
    raise exception 'inc11_slugs: a published post is missing its frozen address';
  end if;
  if news_slugify('Café Crème & Friends!') <> 'cafe-creme-friends' then
    raise exception 'inc11_slugs: news_slugify does not match the client algorithm';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_name = 'news_posts_public' and column_name = 'slug') then
    raise exception 'inc11_slugs: the public projection does not expose the frozen address';
  end if;
end $acceptance$;
