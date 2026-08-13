-- ============================================================================
--  MIGRATION — WP04R: media_objects / media_references + safe lifecycle
--  (MilkPop WP01–04 Remediation Patch Specification v1, §9–§11)
--
--  WHAT THIS REPLACES: migration_wp04_media_assets.sql (deleted; never
--  deploy it). That migration tried to CREATE a registry named media_assets —
--  but schema.sql:679 already owns that name for the Media Library
--  (id/name/folder/size/type/uploaded_at/url). Against a live database the
--  CREATE silently no-ops and every registry insert then fails at runtime.
--
--  DESIGN (P0-R1..R4):
--    • The technical Storage registry is a NEW table, media_objects. The
--      legacy media_assets Library table is left exactly as it is.
--    • Uploads register status='pending'. NOTHING is deleted at upload time —
--      replacePath is gone from the API entirely.
--    • Attachment is a separate, transactional step (finalise_media_reference)
--      that records WHERE an object is used (media_references) and promotes
--      it to 'attached'. For menu items the parent column update itself is
--      inside the same transaction.
--    • Cleanup is a STATE MACHINE, and eligibility is decided by TWO
--      independent checks: the reference table (intent) AND a whole-content
--      scan of every media-bearing column (ground truth). An object that any
--      published content still points at is never marked, even if a client
--      forgot to attach it — the failure direction is "kept too long",
--      never "deleted while referenced".
--    • The registry row is removed only AFTER Storage deletion is CONFIRMED
--      (2xx/404); failures back off exponentially and stay visible.
--
--  Forward-only, idempotent. Runs after migration_wp02_1_resolve_and_hash.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Defensive un-do — ONLY the objects the withdrawn WP-04 migration would
--    have created, in case it was applied to a staging database. The legacy
--    media_assets table itself is not touched.
-- ---------------------------------------------------------------------------
drop policy   if exists media_assets_read_staff on public.media_assets;
drop index    if exists media_assets_created_at_idx;
drop function if exists public.cleanup_orphan_media(int);

-- ---------------------------------------------------------------------------
-- 1. Public bucket for optimised menu/CMS images (idempotent).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('menu-media', 'menu-media', true)
on conflict (id) do update set public = true;

-- ---------------------------------------------------------------------------
-- 2. The technical registry (spec §9.1) — collision-free names.
-- ---------------------------------------------------------------------------
create table if not exists public.media_objects (
  id                 uuid primary key default gen_random_uuid(),
  bucket             text not null,
  storage_path       text not null,
  public_url         text,
  mime_type          text not null,
  size_bytes         int  not null check (size_bytes > 0 and size_bytes <= 512000),
  width              int,
  height             int,
  alt_text           text not null default '',
  status             text not null default 'pending'
                       check (status in ('pending','attached','cleanup_pending','cleanup_failed','deleted')),
  uploaded_by        text not null,
  created_at         timestamptz not null default now(),
  attached_at        timestamptz,
  cleanup_after      timestamptz,
  cleanup_attempts   int  not null default 0,
  last_cleanup_error text,
  unique (bucket, storage_path)
);

comment on table public.media_objects is
  'WP04R: technical Storage registry (NOT the Media Library — that is the legacy media_assets table). Lifecycle: pending → attached → cleanup_pending → deleted, with cleanup_failed as the retry state. Written only via Edge Functions / SECURITY DEFINER RPCs.';

create table if not exists public.media_references (
  id               uuid primary key default gen_random_uuid(),
  media_object_id  uuid not null references public.media_objects(id) on delete restrict,
  entity_type      text not null,
  entity_id        text not null,
  field_path       text not null,
  created_at       timestamptz not null default now(),
  unique (entity_type, entity_id, field_path)
);

comment on table public.media_references is
  'WP04R: which entity field uses which object — one row per (entity, field). Replacing a field''s image moves this row to the new object; the OLD object is only a cleanup CANDIDATE if it then has zero rows here AND the content scan cannot find its path anywhere.';

create index if not exists media_objects_cleanup_idx
  on public.media_objects (status, cleanup_after);
create index if not exists media_references_object_idx
  on public.media_references (media_object_id);

-- Staff may SELECT (admin UI listings); nobody writes from the browser.
alter table public.media_objects    enable row level security;
alter table public.media_references enable row level security;
revoke all on public.media_objects, public.media_references from public, anon, authenticated;
grant select on public.media_objects, public.media_references to authenticated;

drop policy if exists media_objects_select_staff on public.media_objects;
create policy media_objects_select_staff on public.media_objects
  for select to authenticated
  using (exists (
    select 1 from staff_profiles sp
     where sp.auth_id = auth.uid() and sp.status <> 'disabled'
  ));
drop policy if exists media_references_select_staff on public.media_references;
create policy media_references_select_staff on public.media_references
  for select to authenticated
  using (exists (
    select 1 from staff_profiles sp
     where sp.auth_id = auth.uid() and sp.status <> 'disabled'
  ));

-- ---------------------------------------------------------------------------
-- 3. Whole-content reference scan — the GROUND TRUTH for "is this path used
--    anywhere". Covers every media-bearing column found in schema + code
--    (spec §12.3): menu_items.image, stores.image, news_posts.image,
--    cms_pages hero/about images, the legacy Library's url, and the two
--    JSON document stores (site_content, app_state).
-- ---------------------------------------------------------------------------
create or replace function public.media_path_is_referenced(p_storage_path text, p_public_url text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_needle_path text := coalesce(p_storage_path, '');
  v_needle_url  text := coalesce(p_public_url, '');
begin
  if v_needle_path = '' and v_needle_url = '' then
    return true; -- fail SAFE: an unidentifiable object is never eligible
  end if;
  -- Either the storage path or the public URL appearing anywhere counts.
  return exists (select 1 from menu_items  where image like '%' || v_needle_path || '%' or (v_needle_url <> '' and image like '%' || v_needle_url || '%'))
      or exists (select 1 from stores      where image like '%' || v_needle_path || '%' or (v_needle_url <> '' and image like '%' || v_needle_url || '%'))
      or exists (select 1 from news_posts  where image like '%' || v_needle_path || '%' or (v_needle_url <> '' and image like '%' || v_needle_url || '%'))
      or exists (select 1 from cms_pages   where hero_image  like '%' || v_needle_path || '%' or coalesce(about_image1,'') like '%' || v_needle_path || '%' or coalesce(about_image2,'') like '%' || v_needle_path || '%'
                                              or (v_needle_url <> '' and (hero_image like '%' || v_needle_url || '%' or coalesce(about_image1,'') like '%' || v_needle_url || '%' or coalesce(about_image2,'') like '%' || v_needle_url || '%')))
      or exists (select 1 from media_assets where url like '%' || v_needle_path || '%' or (v_needle_url <> '' and url like '%' || v_needle_url || '%'))
      or exists (select 1 from site_content sc where sc::text like '%' || v_needle_path || '%' or (v_needle_url <> '' and sc::text like '%' || v_needle_url || '%'))
      or exists (select 1 from app_state a  where a::text  like '%' || v_needle_path || '%' or (v_needle_url <> '' and a::text  like '%' || v_needle_url || '%'));
end;
$$;
revoke all on function public.media_path_is_referenced(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. finalise_media_reference — the two-phase ATTACH (spec §10.2).
--    entity_type 'menu_item' also updates the parent column in the SAME
--    transaction; the JSON-document entity types (site_content, app_state,
--    news_post, cms_page, media_library) are saved by their existing
--    publish paths, so here the reference is recorded and statuses move.
--    Old-object handling: reference moved → if the old object now has zero
--    references it becomes a cleanup CANDIDATE (grace period); the worker
--    still re-verifies with the content scan before anything is deleted.
-- ---------------------------------------------------------------------------
create or replace function public.finalise_media_reference(
  p_object_id   uuid,
  p_entity_type text,
  p_entity_id   text,
  p_field_path  text,
  p_actor       text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_obj        record;
  v_old_object uuid;
  v_grace      constant interval := interval '24 hours';
begin
  if p_entity_type not in ('menu_item','site_content','app_state','news_post','cms_page','media_library') then
    raise exception 'unknown_entity_type';
  end if;

  select * into v_obj from media_objects where id = p_object_id for update;
  if v_obj.id is null then
    return jsonb_build_object('status','failed','error','object_not_found');
  end if;
  if v_obj.status not in ('pending','attached') then
    return jsonb_build_object('status','failed','error','object_not_attachable');
  end if;

  -- Previous holder of this exact field, if any.
  select media_object_id into v_old_object
    from media_references
   where entity_type = p_entity_type and entity_id = p_entity_id and field_path = p_field_path
   for update;

  if v_old_object is not null and v_old_object = p_object_id then
    -- Idempotent re-attach of the same object to the same field.
    update media_objects set status = 'attached', attached_at = coalesce(attached_at, now())
     where id = p_object_id;
    return jsonb_build_object('status','attached','object_id',p_object_id,'url',v_obj.public_url,
                              'previous_object_cleanup','not_needed');
  end if;

  -- Parent column update — atomic here for the plain-column entity.
  if p_entity_type = 'menu_item' then
    update menu_items set image = coalesce(v_obj.public_url, v_obj.storage_path)
     where id = p_entity_id;
    if not found then
      return jsonb_build_object('status','failed','error','parent_not_found');
    end if;
  end if;

  insert into media_references (media_object_id, entity_type, entity_id, field_path)
  values (p_object_id, p_entity_type, p_entity_id, p_field_path)
  on conflict (entity_type, entity_id, field_path)
    do update set media_object_id = excluded.media_object_id, created_at = now();

  update media_objects set status = 'attached', attached_at = coalesce(attached_at, now())
   where id = p_object_id;

  -- Old object: zero remaining references → cleanup CANDIDATE after grace.
  if v_old_object is not null
     and not exists (select 1 from media_references where media_object_id = v_old_object) then
    update media_objects
       set status = 'cleanup_pending', cleanup_after = now() + v_grace
     where id = v_old_object and status in ('pending','attached');
    return jsonb_build_object('status','attached','object_id',p_object_id,'url',v_obj.public_url,
                              'previous_object_cleanup','scheduled');
  end if;

  return jsonb_build_object('status','attached','object_id',p_object_id,'url',v_obj.public_url,
                            'previous_object_cleanup','not_needed');
end;
$$;
revoke all on function public.finalise_media_reference(uuid, text, text, text, text) from public, anon, authenticated;

comment on function public.finalise_media_reference(uuid, text, text, text, text) is
  'WP04R §10.2: transactional attach — records the (entity, field) → object reference, promotes the object, moves the previous reference and schedules the displaced object for GRACE-PERIOD cleanup only when nothing references it. menu_item also updates menu_items.image in the same transaction. Edge Function (service role) only.';

-- ---------------------------------------------------------------------------
-- 5. Cleanup state machine (spec §11).
-- ---------------------------------------------------------------------------

-- 5a. Mark candidates: pending objects past the grace window and attached
--     objects with zero references — each ONLY when the content scan also
--     finds nothing. Belt AND braces; the scan always has the last word.
create or replace function public.mark_media_cleanup_candidates(p_grace_hours int default 24)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_marked int := 0;
  r record;
begin
  for r in
    select id, storage_path, public_url from media_objects
     where (status = 'pending'  and created_at < now() - make_interval(hours => greatest(p_grace_hours, 1)))
        or (status = 'attached' and not exists
             (select 1 from media_references mr where mr.media_object_id = media_objects.id))
  loop
    if not media_path_is_referenced(r.storage_path, r.public_url) then
      update media_objects
         set status = 'cleanup_pending',
             cleanup_after = coalesce(cleanup_after, now())
       where id = r.id;
      v_marked := v_marked + 1;
    end if;
  end loop;
  return v_marked;
end;
$$;
revoke all on function public.mark_media_cleanup_candidates(int) from public, anon, authenticated;

-- 5b. Claim a batch for the worker (skip-locked so runs can overlap safely).
--     The content scan is re-checked AT CLAIM TIME: anything that became
--     referenced since marking is demoted back to attached, not deleted.
create or replace function public.claim_media_cleanup_batch(p_limit int default 20)
returns setof media_objects
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r media_objects%rowtype;
begin
  for r in
    select * from media_objects
     where status in ('cleanup_pending','cleanup_failed')
       and coalesce(cleanup_after, now()) <= now()
     order by cleanup_after nulls first
     limit greatest(p_limit, 1)
     for update skip locked
  loop
    if media_path_is_referenced(r.storage_path, r.public_url) then
      update media_objects set status = 'attached', cleanup_after = null where id = r.id;
      continue;
    end if;
    return next r;
  end loop;
end;
$$;
revoke all on function public.claim_media_cleanup_batch(int) from public, anon, authenticated;

-- 5c. Record the Storage outcome. 2xx/404 = confirmed gone → 'deleted' (the
--     row is KEPT as the audit trail; a later housekeeping migration may
--     purge old 'deleted' rows). Anything else = cleanup_failed with
--     exponential backoff — never silently dropped.
create or replace function public.record_media_cleanup_result(p_id uuid, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_ok then
    update media_objects
       set status = 'deleted', cleanup_after = null, last_cleanup_error = null
     where id = p_id;
  else
    update media_objects
       set status = 'cleanup_failed',
           cleanup_attempts = cleanup_attempts + 1,
           last_cleanup_error = left(coalesce(p_error,'unknown'), 500),
           cleanup_after = now() + (interval '5 minutes') * power(2, least(cleanup_attempts, 6))
     where id = p_id;
  end if;
end;
$$;
revoke all on function public.record_media_cleanup_result(uuid, boolean, text) from public, anon, authenticated;

-- 5d. The CV/object job queue gets the same claim/record discipline.
create or replace function public.claim_storage_cleanup_batch(p_limit int default 20)
returns setof storage_cleanup_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
    update storage_cleanup_jobs j
       set status = 'processing', attempts = attempts + 1
     where j.id in (
       select id from storage_cleanup_jobs
        where status in ('pending','failed')
          and next_attempt_at <= now()
        order by next_attempt_at
        limit greatest(p_limit, 1)
        for update skip locked
     )
    returning j.*;
end;
$$;
revoke all on function public.claim_storage_cleanup_batch(int) from public, anon, authenticated;

create or replace function public.record_storage_cleanup_result(p_id uuid, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_ok then
    update storage_cleanup_jobs
       set status = 'done', last_error = null
     where id = p_id;
  else
    update storage_cleanup_jobs
       set status = 'failed',
           last_error = left(coalesce(p_error,'unknown'), 500),
           next_attempt_at = now() + (interval '5 minutes') * power(2, least(attempts, 6))
     where id = p_id;
  end if;
end;
$$;
revoke all on function public.record_storage_cleanup_result(uuid, boolean, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Verification (run manually after applying):
--   select column_name from information_schema.columns
--    where table_name = 'media_assets' order by ordinal_position;
--   -- must STILL be: id,name,folder,size,type,uploaded_at,url,created_at
--   set role anon; select mark_media_cleanup_candidates(); -- permission denied
--   reset role;
-- ---------------------------------------------------------------------------
