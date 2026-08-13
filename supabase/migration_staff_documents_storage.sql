-- ============================================================================
--  MILK POP — MIGRATION S3 (STAGE 3): STAFF DOCUMENTS ON PRIVATE STORAGE
--
--  Run order: after migration_rls_per_role.sql (needs the role helpers) and
--  migration_payroll_cv.sql (added employee_id/employee_name). Safe to re-run.
--
--  WHAT CHANGES
--  ------------
--  Staff documents stop being base64 data-URLs inside a Postgres text column
--  and become objects in a PRIVATE Storage bucket with a metadata row here:
--
--    authenticated user
--      → `staff-doc-upload` Edge Function   (validates, sniffs magic bytes,
--                                            builds the controlled path)
--      → private `staff-documents` bucket    (service-role write, upsert=false)
--      → metadata row in staff_documents     (service-role insert AFTER the
--                                            object is stored; the object is
--                                            deleted if the insert fails)
--
--  Reads never expose a permanent URL: `staff-doc-url` issues a short-lived
--  signed URL only after an access check, and nothing stores that URL.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. PRIVATE BUCKET — fail-closed like `cvs`: NO storage.objects policies at
--    all, so only the service role (Edge Functions) can touch objects.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('staff-documents', 'staff-documents', false)
on conflict (id) do update set public = false;

-- Belt-and-braces if any old permissive policy ever existed for this bucket.
drop policy if exists "staff_documents_public_read" on storage.objects;

-- ---------------------------------------------------------------------------
-- 2. METADATA COLUMNS
-- ---------------------------------------------------------------------------
alter table staff_documents add column if not exists store_id          text;
alter table staff_documents add column if not exists store_name        text not null default '';
alter table staff_documents add column if not exists storage_bucket    text;
alter table staff_documents add column if not exists storage_path      text;
alter table staff_documents add column if not exists original_filename text not null default '';
alter table staff_documents add column if not exists mime_type         text not null default '';
alter table staff_documents add column if not exists size_bytes        bigint not null default 0;
alter table staff_documents add column if not exists checksum          text not null default '';
alter table staff_documents add column if not exists uploaded_by       text;
alter table staff_documents add column if not exists verified_by       text;
alter table staff_documents add column if not exists verified_at       text;
-- (expiry_date already exists and serves as expires_at.)

create index if not exists idx_staff_documents_employee on staff_documents (employee_id);
create index if not exists idx_staff_documents_store    on staff_documents (store_id);

-- A storage object may be referenced by at most one metadata row.
create unique index if not exists uq_staff_documents_storage_path
  on staff_documents (storage_path) where storage_path is not null;

-- ---------------------------------------------------------------------------
-- 3. BASE64 REMOVAL — the historic `url` column held data: URLs. Destroy the
--    payloads (they are unverifiable client uploads) and drop the column so
--    the shape cannot return. Legacy rows keep their metadata; their files
--    were never real server objects, so there is nothing to migrate.
-- ---------------------------------------------------------------------------
alter table staff_documents drop column if exists url;

-- ---------------------------------------------------------------------------
-- 4. RLS — replace the blanket manager policy with per-role access:
--      • staff SELECT their own documents;
--      • managers SELECT documents of employees in THEIR store;
--      • owners SELECT everything;
--      • INSERT/DELETE: no client policy at all — the upload/removal path is
--        the Edge Function (service role, bypasses RLS);
--      • UPDATE: managers/owners only, and ONLY the verification columns
--        (enforced twice: policy + column-level grant).
-- ---------------------------------------------------------------------------
drop policy if exists docs_mgr_only          on staff_documents;
drop policy if exists docs_select_self_or_mgr on staff_documents;
drop policy if exists docs_update_mgr        on staff_documents;

create policy docs_select_self_or_mgr on staff_documents
  for select to authenticated
  using (
    employee_id = current_staff_id()
    or is_owner()
    or (is_manager_or_owner()
        and exists (select 1 from staff_profiles sp
                    where sp.id = staff_documents.employee_id
                      and sp.store_id = current_staff_store()))
  );

create policy docs_update_mgr on staff_documents
  for update to authenticated
  using (
    is_manager_or_owner() and (
      is_owner() or exists (select 1 from staff_profiles sp
                            where sp.id = staff_documents.employee_id
                              and sp.store_id = current_staff_store()))
  )
  with check (
    is_manager_or_owner() and (
      is_owner() or exists (select 1 from staff_profiles sp
                            where sp.id = staff_documents.employee_id
                              and sp.store_id = current_staff_store()))
  );

-- Column-level grants: the browser can only ever flip verification fields.
revoke insert, update, delete on staff_documents from authenticated;
grant  select on staff_documents to authenticated;
grant  update (status, approved_by, verified_by, verified_at, expiry_date)
  on staff_documents to authenticated;
revoke all on staff_documents from anon;

-- ---------------------------------------------------------------------------
-- HANDOVER NOTES
-- ---------------------------------------------------------------------------
-- • Backups: rows in this table restore with the database, but the OBJECTS in
--   the `staff-documents` bucket need their own backup/restore (same as `cvs`
--   and payslip attachments) — see the Phase E backup drill.
-- • Deletion policy: prefer status='action_required' + expiry over deletion.
--   Controlled removal (metadata + object together, audited) is an owner
--   action through the service role — never a browser DELETE.
