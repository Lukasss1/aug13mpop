-- ============================================================================
-- MIGRATION: site_content — the Website Studio content model
-- ============================================================================
-- One singleton row (id = 1) mirroring the app's `SiteContent` object
-- (src/siteContent.ts): every public headline, paragraph, button label,
-- image URL, legal page and SEO tag, grouped as one JSONB column per
-- top-level section. The client's generic toRow/fromRow mapping handles the
-- camelCase <-> snake_case column names; nested structures ride inside JSONB.
--
-- SECURITY MODEL (identical to site_settings / cms_pages):
--   * RLS enabled, deny-by-default.
--   * anon + authenticated: SELECT only (public website content).
--   * INSERT/UPDATE/DELETE: managers & owners only, via the same
--     is_manager_or_owner() helper the other content tables use — the write
--     policy is added only when that helper exists (i.e. after
--     migration_rls_per_role.sql has run), so this file is safe to run in
--     any order.
--
-- Run AFTER schema.sql. Idempotent.
-- ============================================================================

create table if not exists site_content (
  id             int primary key default 1 check (id = 1),
  nav            jsonb not null default '{}'::jsonb,
  home           jsonb not null default '{}'::jsonb,
  menu_page      jsonb not null default '{}'::jsonb,
  stores_page    jsonb not null default '{}'::jsonb,
  careers_page   jsonb not null default '{}'::jsonb,
  franchise_page jsonb not null default '{}'::jsonb,
  about_page     jsonb not null default '{}'::jsonb,
  contact_page   jsonb not null default '{}'::jsonb,
  news_page      jsonb not null default '{}'::jsonb,
  footer         jsonb not null default '{}'::jsonb,
  legal          jsonb not null default '{}'::jsonb,
  seo            jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Reuse the shared updated_at trigger function from schema.sql.
drop trigger if exists trg_site_content_updated on site_content;
create trigger trg_site_content_updated before update on site_content
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table site_content enable row level security;
drop policy if exists demo_full_access on site_content; -- never recreate

-- Public website content — anonymous SELECT only (matches schema.sql §9b).
drop policy if exists public_read on site_content;
create policy public_read on site_content
  for select to anon, authenticated using (true);

-- Authenticated read + owner/manager write, matching the loop in
-- migration_rls_per_role.sql. Guarded so this migration also works on a
-- database where the per-role migration (and its helper) isn't applied yet.
do $$
begin
  if to_regprocedure('is_manager_or_owner()') is not null then
    drop policy if exists content_read_auth on site_content;
    drop policy if exists content_write_mgr on site_content;
    create policy content_read_auth on site_content
      for select to authenticated using (true);
    create policy content_write_mgr on site_content
      for all to authenticated
      using (is_manager_or_owner()) with check (is_manager_or_owner());
    -- verbs (rows still gated by the policies above)
    grant select on site_content to authenticated;
    grant insert, update, delete on site_content to authenticated;
  end if;
end $$;

-- Belt & braces: the anon role only ever needs SELECT here.
grant select on site_content to anon;
revoke insert, update, delete on site_content from anon;
