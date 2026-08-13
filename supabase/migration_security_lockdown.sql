-- ============================================================================
--  MILK POP — MIGRATION: EMERGENCY SECURITY LOCKDOWN
--  Run this ONCE, immediately, on every EXISTING Supabase project that was
--  created from the pre-lockdown schema.sql / migration_payroll_cv.sql.
--  (Fresh projects don't need it: the rewritten schema.sql is already locked.)
--
--  What it fixes (see README.md (Security) for the full incident write-up):
--   1. Deletes plaintext staff passwords, then drops the column entirely.
--   2. Removes the wide-open `demo_full_access using(true) with check(true)`
--      policy from every table → RLS becomes deny-by-default.
--   3. Grants the anon role exactly two capabilities:
--        SELECT on the public website-content tables,
--        INSERT on the public form tables (write-only drop box).
--   4. Makes the `cvs` storage bucket PRIVATE and FAIL-CLOSED (no anonymous
--      read OR write), and destroys legacy CV paths/base64 on applications.
--
--  After running: rotate the anon key (Project Settings → API → "Reset") —
--  the old key was effectively a master credential and must be assumed leaked.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Plaintext passwords: destroy the data first, then the column.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'staff_profiles' and column_name = 'password'
  ) then
    update staff_profiles set password = null;
    alter table staff_profiles drop column password;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'staff_profiles' and column_name = 'must_change_password'
  ) then
    alter table staff_profiles drop column must_change_password;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Remove the demo policy everywhere and (re)assert RLS.
--    With RLS enabled and no policy, PostgreSQL denies everything: that is
--    the intended default for every private table.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'site_settings','stores','menu_items','deals','orders','order_items',
    'order_item_modifiers','customers','loyalty_transactions','ingredients',
    'stock_movements','staff_profiles','work_shifts','checklist_templates',
    'staff_documents','sifr_reports','training_courses','training_assessments',
    'kb_articles','job_vacancies','job_applications','franchise_inquiries',
    'contact_messages','news_posts','cms_pages','media_assets','audit_logs',
    'role_permissions','app_state','clock_history','payslips'
  ] loop
    if exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = t) then
      execute format('alter table %I enable row level security', t);
      execute format('drop policy if exists demo_full_access on %I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3a. Public website content — anonymous SELECT only.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'site_settings','stores','menu_items','deals','job_vacancies',
    'news_posts','cms_pages','media_assets'
  ] loop
    if exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = t) then
      execute format('drop policy if exists public_read on %I', t);
      execute format('create policy public_read on %I for select to anon, authenticated using (true)', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3b. Public forms — anonymous INSERT only. No SELECT: a visitor can never
--     read anyone's application, franchise enquiry or message back out.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'job_applications','franchise_inquiries','contact_messages'
  ] loop
    if exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = t) then
      execute format('drop policy if exists public_insert on %I', t);
      -- HISTORICAL STATE ONLY: recreated here for the pre-Phase-B upgrade
      -- window. The deployment sequence ALWAYS ends with
      -- migration_phase_b_public_forms.sql, which drops this policy and
      -- revokes the INSERT grants — see launch/launch.sh (§1 manifest).
      execute format('create policy public_insert on %I for insert to anon, authenticated with check (true)', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. CV storage: private bucket, FAIL-CLOSED — no policies of any kind.
--    (Phase 1 review: anonymous CV upload is disabled until the Phase 5
--    controls exist. With RLS on storage.objects and no matching policy,
--    all anonymous reads AND writes are denied. Do not add an upload
--    policy here — it ships with the Phase 5 pipeline.)
-- ---------------------------------------------------------------------------
update storage.buckets set public = false where id = 'cvs';

drop policy if exists "cvs_public_upload" on storage.objects;
drop policy if exists "cvs_public_read" on storage.objects;
drop policy if exists "cvs_candidate_upload" on storage.objects;

-- ---------------------------------------------------------------------------
-- 4b. Destroy legacy CV material on application rows, then drop the columns.
--     Older builds stored a storage path (cv_url) and even base64 file bytes
--     (cv_data) on job_applications — including rows harvested while the
--     table was world-readable. Blank the data first so no dump keeps it,
--     then remove the columns entirely (the app no longer sends them).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'job_applications' and column_name = 'cv_data') then
    update job_applications set cv_data = '';
    alter table job_applications drop column cv_data;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'job_applications' and column_name = 'cv_url') then
    update job_applications set cv_url = '';
    alter table job_applications drop column cv_url;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'job_applications' and column_name = 'cv_name') then
    alter table job_applications drop column cv_name;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Post-run checklist (manual):
--    [ ] Rotate the anon key and update the app's configuration.
--    [ ] Review job_applications / franchise_inquiries / contact_messages
--        for anything harvested while the tables were world-readable.
--    [ ] Treat every password that ever lived in staff_profiles.password as
--        compromised; if staff reused them elsewhere, tell them to change
--        those accounts.
--    [ ] Review objects already in the `cvs` bucket (Supabase dashboard →
--        Storage) and delete any that must not remain; nothing can read or
--        write the bucket with the anon key either way.
-- ============================================================================
