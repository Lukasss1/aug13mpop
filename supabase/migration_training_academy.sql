-- ============================================================================
--  MILK POP — TRAINING ACADEMY UPGRADE (assignments, certificates, media)
--
--  Run AFTER schema.sql, migration_security_lockdown.sql and
--  migration_rls_per_role.sql. Idempotent — safe to re-run.
--
--  What this adds:
--    1. training_assessments gains `due_days` (default deadline used when a
--       module is assigned) and `mandatory` (flagged prominently to staff).
--    2. training_assignments — an owner/manager assigns a module to a staff
--       member with a due date. Staff may read their own rows and update the
--       progress fields on their own rows; managers/owners manage all rows.
--    3. training_certificates — issued when a staff member PASSES a module.
--       Staff insert their own certificate (the pass happens on their device)
--       and may stamp emailed_at on their own rows; managers/owners see all.
--    4. A private `training-media` storage bucket for uploaded lesson videos.
--       NO client storage policies — every byte goes through the
--       training-media Edge Function (upload: manager/owner; signed playback
--       URL: any linked staff member). Mirrors the `cvs` bucket model.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. training_assessments — assignment defaults
-- ---------------------------------------------------------------------------
alter table training_assessments
  add column if not exists due_days  int     not null default 7,
  add column if not exists mandatory boolean not null default false;

comment on column training_assessments.due_days is
  'Default deadline (days after assignment) pre-filled when this module is assigned.';
comment on column training_assessments.mandatory is
  'Mandatory modules are flagged prominently in the staff Academy.';


-- ---------------------------------------------------------------------------
-- 2. training_assignments
-- ---------------------------------------------------------------------------
create table if not exists training_assignments (
  id               text primary key,
  assessment_id    text not null,
  assessment_title text not null default '',
  employee_id      text not null,
  employee_name    text not null default '',
  assigned_by      text not null default '',
  assigned_at      timestamptz not null default now(),
  due_date         date not null,
  status           text not null default 'assigned'
                     check (status in ('assigned','in_progress','completed')),
  completed_at     timestamptz,
  score            int,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

drop trigger if exists trg_training_assignments_updated on training_assignments;
create trigger trg_training_assignments_updated before update on training_assignments
  for each row execute function set_updated_at();

create index if not exists idx_training_assignments_employee
  on training_assignments (employee_id, status);

alter table training_assignments enable row level security;
drop policy if exists demo_full_access on training_assignments;

-- Staff read their OWN assignments; managers/owners read all.
drop policy if exists tassign_select_self_or_mgr on training_assignments;
create policy tassign_select_self_or_mgr on training_assignments
  for select to authenticated
  using (employee_id = current_staff_id() or is_manager_or_owner());

-- Only managers/owners create or delete assignments.
drop policy if exists tassign_insert_mgr on training_assignments;
create policy tassign_insert_mgr on training_assignments
  for insert to authenticated
  with check (is_manager_or_owner());

drop policy if exists tassign_delete_mgr on training_assignments;
create policy tassign_delete_mgr on training_assignments
  for delete to authenticated
  using (is_manager_or_owner());

-- A staff member may progress their OWN assignment (assigned → in_progress →
-- completed + score). The row's identity/due fields are pinned by WITH CHECK:
-- the updated row must still belong to them — combined with the update grant
-- below this lets them move status/score/completed_at but a manager remains
-- the only one who can re-point or re-date an assignment.
drop policy if exists tassign_update_self on training_assignments;
create policy tassign_update_self on training_assignments
  for update to authenticated
  using (employee_id = current_staff_id())
  with check (employee_id = current_staff_id());

drop policy if exists tassign_update_mgr on training_assignments;
create policy tassign_update_mgr on training_assignments
  for update to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());

grant select, insert, update, delete on training_assignments to authenticated;


-- ---------------------------------------------------------------------------
-- 3. training_certificates
-- ---------------------------------------------------------------------------
create table if not exists training_certificates (
  id               text primary key,          -- human-readable cert no
  employee_id      text not null,
  employee_name    text not null default '',
  assessment_id    text not null,
  assessment_title text not null default '',
  category         text not null default '',
  score            int  not null default 0,
  issued_at        timestamptz not null default now(),
  emailed_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

drop trigger if exists trg_training_certificates_updated on training_certificates;
create trigger trg_training_certificates_updated before update on training_certificates
  for each row execute function set_updated_at();

create index if not exists idx_training_certificates_employee
  on training_certificates (employee_id);

alter table training_certificates enable row level security;
drop policy if exists demo_full_access on training_certificates;

-- Staff read their OWN certificates; managers/owners read all.
drop policy if exists tcert_select_self_or_mgr on training_certificates;
create policy tcert_select_self_or_mgr on training_certificates
  for select to authenticated
  using (employee_id = current_staff_id() or is_manager_or_owner());

-- A pass is recorded from the staff member's own session: they may insert a
-- certificate FOR THEMSELVES only. Managers/owners may insert for anyone
-- (manual back-fill of paper certificates).
drop policy if exists tcert_insert_self_or_mgr on training_certificates;
create policy tcert_insert_self_or_mgr on training_certificates
  for insert to authenticated
  with check (employee_id = current_staff_id() or is_manager_or_owner());

-- Staff may stamp emailed_at on their own rows (row stays theirs); managers
-- may correct any row. Only the owner may revoke (delete) a certificate.
drop policy if exists tcert_update_self on training_certificates;
create policy tcert_update_self on training_certificates
  for update to authenticated
  using (employee_id = current_staff_id())
  with check (employee_id = current_staff_id());

drop policy if exists tcert_update_mgr on training_certificates;
create policy tcert_update_mgr on training_certificates
  for update to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());

drop policy if exists tcert_delete_owner on training_certificates;
create policy tcert_delete_owner on training_certificates
  for delete to authenticated
  using (is_owner());

grant select, insert, update, delete on training_certificates to authenticated;


-- ---------------------------------------------------------------------------
-- 4. STORAGE — private `training-media` bucket, Edge-Function-only access
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('training-media', 'training-media', false)
on conflict (id) do update set public = false;

-- No client policies of any kind: uploads and signed playback URLs are minted
-- exclusively by the training-media Edge Function using the service role.
drop policy if exists "training_media_public_read"   on storage.objects;
drop policy if exists "training_media_public_upload" on storage.objects;
drop policy if exists "training_media_authed_read"   on storage.objects;
drop policy if exists "training_media_authed_upload" on storage.objects;
