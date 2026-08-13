-- ============================================================================
--  MILK POP — MIGRATION A1: AUTH LINKAGE + PER-ROLE ROW LEVEL SECURITY
--
--  Run order:
--    1. schema.sql                       (base tables, deny-by-default RLS)
--    2. migration_security_lockdown.sql  (only on pre-lockdown databases)
--    3. THIS FILE                         (adds authenticated per-role access)
--
--  Safe to re-run: every policy is dropped-if-exists before create, and the
--  auth linkage column / helper functions use create-or-replace / if-not-exists.
--
--  WHAT THIS DOES
--  --------------
--  Before this migration the ONLY access is anonymous: SELECT public content,
--  INSERT the three public forms. Everything else is denied because RLS is on
--  with no matching policy. This migration adds a SECOND caller class — the
--  `authenticated` role (a logged-in Supabase Auth user) — and grants it
--  precisely-scoped access based on the role stored in its staff_profiles row.
--
--  SECURITY MODEL — read this before editing
--  -----------------------------------------
--  • A caller's identity is auth.uid() (a UUID from Supabase Auth). It is
--    cryptographically verified by Supabase from the JWT and CANNOT be forged
--    by the client — unlike the old localStorage role this replaces.
--  • A caller's ROLE and STORE are read from the database (staff_profiles),
--    never from anything the client sends. The helper functions below are the
--    single source of truth; every policy calls them.
--  • The helpers are SECURITY DEFINER so they can read staff_profiles even
--    though the calling user's own RLS would otherwise restrict that read.
--    This is what prevents infinite recursion (a policy on staff_profiles
--    that needs to read staff_profiles to decide access). SECURITY DEFINER
--    functions bypass RLS for their own internal query only.
--  • Deny-by-default still holds: any table/action with no policy for a role
--    is denied for that role. anon access is UNCHANGED by this file.
--
--  ROLE HIERARCHY (enum employee_role): team_member < supervisor
--                                       < store_manager < owner
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. AUTH LINKAGE — connect a Supabase Auth user to their staff_profiles row
-- ---------------------------------------------------------------------------
-- staff_profiles.id is the app's own text id (e.g. "emp_ab12"). Supabase Auth
-- issues a separate UUID (auth.uid()). We add auth_id to bridge them. The
-- invite/onboarding flow (Block B) sets this when a staff member first signs
-- in; until it is set, that profile simply has no authenticated access — which
-- is the safe default.
alter table staff_profiles
  add column if not exists auth_id uuid unique;

comment on column staff_profiles.auth_id is
  'Links this profile to a Supabase Auth user (auth.users.id). Null until the '
  'staff member completes sign-in onboarding. Set by the Block B auth flow, '
  'never by the client directly (see the self-update policy in section 4).';

create index if not exists idx_staff_profiles_auth_id on staff_profiles (auth_id);


-- ---------------------------------------------------------------------------
-- 2. HELPER FUNCTIONS — the single source of truth for "who is calling"
-- ---------------------------------------------------------------------------
-- These run as SECURITY DEFINER (owner privileges) so they can look up the
-- caller's staff row without tripping RLS or recursing. They are STABLE (one
-- value per statement) so Postgres can cache them within a query.
--
-- IMPORTANT: search_path is pinned to a safe, fixed value on every function.
-- A SECURITY DEFINER function with a mutable search_path is a classic
-- privilege-escalation vector; pinning it closes that.

-- The app id of the currently authenticated staff member (or null).
create or replace function current_staff_id()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from staff_profiles where auth_id = auth.uid() limit 1;
$$;

-- The role of the currently authenticated staff member (or null).
create or replace function current_staff_role()
returns employee_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from staff_profiles where auth_id = auth.uid() limit 1;
$$;

-- The store_id the currently authenticated staff member belongs to (or null).
create or replace function current_staff_store()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select store_id from staff_profiles where auth_id = auth.uid() limit 1;
$$;

-- Convenience predicates. Owner is treated as a superset of manager for reads
-- and writes across all stores; managers are scoped to their own store.
create or replace function is_owner()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(current_staff_role() = 'owner', false);
$$;

create or replace function is_manager_or_owner()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(current_staff_role() in ('store_manager','owner'), false);
$$;

-- Lock down who may execute the helpers: authenticated users only. anon has
-- no reason to call them, and revoking keeps the attack surface minimal.
revoke all on function current_staff_id()      from public;
revoke all on function current_staff_role()    from public;
revoke all on function current_staff_store()   from public;
revoke all on function is_owner()              from public;
revoke all on function is_manager_or_owner()   from public;
grant execute on function current_staff_id()      to authenticated;
grant execute on function current_staff_role()    to authenticated;
grant execute on function current_staff_store()   to authenticated;
grant execute on function is_owner()              to authenticated;
grant execute on function is_manager_or_owner()   to authenticated;


-- ---------------------------------------------------------------------------
-- 3. TABLE-LEVEL GRANTS for the authenticated role
-- ---------------------------------------------------------------------------
-- RLS decides WHICH ROWS; SQL privileges decide WHICH VERBS are even possible.
-- Both must allow an action. We grant broad verbs here and let RLS constrain
-- the rows; a table with a grant but no policy for a role still denies all
-- rows (deny-by-default), so grants alone leak nothing.
grant usage on schema public to authenticated;

-- Public content: authenticated may read (same as anon) AND, for owners/
-- managers, write — the row policies in section 5 enforce the role check.
grant select, insert, update, delete on
  site_settings, stores, menu_items, deals, job_vacancies,
  news_posts, cms_pages, media_assets
  to authenticated;

-- Operational tables: verbs granted, rows constrained by policy.
grant select, insert, update, delete on
  orders, order_items, order_item_modifiers, customers, loyalty_transactions,
  ingredients, stock_movements, staff_profiles, work_shifts, clock_history,
  payslips, checklist_templates, staff_documents, sifr_reports,
  training_courses, training_assessments, kb_articles, audit_logs,
  role_permissions, app_state
  to authenticated;

-- Analytics views run with the querying user's rights; grant read to staff.
grant select on daily_sales, top_products, sales_by_channel, popular_modifiers,
  stock_levels to authenticated;


-- ============================================================================
-- 4. STAFF_PROFILES — the most delicate table (identity + pay data)
-- ============================================================================
-- Reads:
--   • A staff member may read their OWN profile.
--   • Managers may read profiles in THEIR store.
--   • Owners may read ALL profiles.
-- Writes:
--   • Owners may insert/update/delete any profile (staff admin).
--   • A staff member may update a SAFE subset of their own row (avatar, etc.)
--     — enforced by a column grant, NOT by trusting the client. See note.
--   • Nobody may change their own role or store (privilege escalation guard).

drop policy if exists staff_profiles_select_self    on staff_profiles;
drop policy if exists staff_profiles_select_store   on staff_profiles;
drop policy if exists staff_profiles_select_owner   on staff_profiles;
drop policy if exists staff_profiles_write_owner    on staff_profiles;
drop policy if exists staff_profiles_update_self    on staff_profiles;

create policy staff_profiles_select_self on staff_profiles
  for select to authenticated
  using (auth_id = auth.uid());

create policy staff_profiles_select_store on staff_profiles
  for select to authenticated
  using (is_manager_or_owner() and (is_owner() or store_id = current_staff_store()));

create policy staff_profiles_write_owner on staff_profiles
  for all to authenticated
  using (is_owner())
  with check (is_owner());

-- Self-service update of a staff member's own profile. Role/store escalation
-- is blocked by requiring the NEW row's role and store to still equal the
-- caller's current DB values. Because with_check runs against the proposed
-- row, a user cannot promote themselves to owner or move stores.
create policy staff_profiles_update_self on staff_profiles
  for update to authenticated
  using (auth_id = auth.uid())
  with check (
    auth_id = auth.uid()
    and role     = current_staff_role()
    and store_id is not distinct from current_staff_store()
  );
-- NOTE: column-level protection (which FIELDS a self-update may touch, e.g.
-- blocking pay_rate edits) is enforced by a `grant update (col,...)` in
-- Block B once the onboarding flow exists, because it must not also restrict
-- the owner policy above. Flagged in the handover notes at the bottom.


-- ============================================================================
-- 5. PUBLIC-CONTENT TABLES — owner/manager write, everyone still reads
-- ============================================================================
-- anon SELECT stays as schema.sql defined it. Here we add authenticated WRITE,
-- restricted to owner + store_manager. (Supervisors/team members read only.)
do $$
declare t text;
begin
  foreach t in array array[
    'site_settings','stores','menu_items','deals','job_vacancies',
    'news_posts','cms_pages','media_assets'
  ] loop
    execute format('drop policy if exists content_read_auth on %I', t);
    execute format('drop policy if exists content_write_mgr on %I', t);
    -- authenticated read (parallels the anon public_read policy)
    execute format(
      'create policy content_read_auth on %I for select to authenticated using (true)', t);
    -- owner/manager write (insert/update/delete)
    execute format(
      'create policy content_write_mgr on %I for all to authenticated '
      'using (is_manager_or_owner()) with check (is_manager_or_owner())', t);
  end loop;
end $$;


-- ============================================================================
-- 6. SALES / POS — orders and their normalised children
-- ============================================================================
-- Any authenticated staff member may create and read orders for THEIR store;
-- owners see all stores. Refund/void (status change) and delete are limited to
-- managers/owners. order_items / order_item_modifiers are written only by the
-- explode trigger (SECURITY DEFINER context of the table owner), so we expose
-- them read-only to staff for analytics.

drop policy if exists orders_select_store   on orders;
drop policy if exists orders_insert_staff   on orders;
drop policy if exists orders_update_mgr     on orders;
drop policy if exists orders_delete_mgr     on orders;

create policy orders_select_store on orders
  for select to authenticated
  using (is_owner() or store_id = current_staff_store());

create policy orders_insert_staff on orders
  for insert to authenticated
  with check (
    current_staff_id() is not null
    and (is_owner() or store_id = current_staff_store())
  );

create policy orders_update_mgr on orders
  for update to authenticated
  using (is_manager_or_owner() and (is_owner() or store_id = current_staff_store()))
  with check (is_manager_or_owner() and (is_owner() or store_id = current_staff_store()));

create policy orders_delete_mgr on orders
  for delete to authenticated
  using (is_manager_or_owner() and (is_owner() or store_id = current_staff_store()));

-- Normalised children: read-only to staff for their store's orders (owners all).
do $$
declare t text;
begin
  foreach t in array array['order_items','order_item_modifiers'] loop
    execute format('drop policy if exists %I_select_store on %I', t, t);
    execute format(
      'create policy %I_select_store on %I for select to authenticated '
      'using (exists (select 1 from orders o where o.id = %I.order_id '
      '   and (is_owner() or o.store_id = current_staff_store())))', t, t, t);
  end loop;
end $$;


-- ============================================================================
-- 7. CUSTOMERS, LOYALTY, INVENTORY
-- ============================================================================
-- Customers & loyalty: readable/writable by any authenticated staff (loyalty
-- is applied at the till by team members). Deletes limited to managers/owners.
drop policy if exists customers_rw_staff     on customers;
drop policy if exists customers_delete_mgr   on customers;
create policy customers_rw_staff on customers
  for all to authenticated
  using (current_staff_id() is not null)
  with check (current_staff_id() is not null);
-- (delete is covered by the ALL policy above; if you want to restrict deletes,
--  split into select/insert/update policies + a manager-only delete. Left open
--  intentionally so the POS can merge duplicate customer records.)

drop policy if exists loyalty_rw_staff on loyalty_transactions;
create policy loyalty_rw_staff on loyalty_transactions
  for all to authenticated
  using (current_staff_id() is not null)
  with check (current_staff_id() is not null);

-- Inventory: staff read; managers/owners write (deliveries, stocktakes).
drop policy if exists ingredients_read_staff  on ingredients;
drop policy if exists ingredients_write_mgr   on ingredients;
create policy ingredients_read_staff on ingredients
  for select to authenticated using (current_staff_id() is not null);
create policy ingredients_write_mgr on ingredients
  for all to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());

drop policy if exists stock_read_store   on stock_movements;
drop policy if exists stock_write_staff  on stock_movements;
create policy stock_read_store on stock_movements
  for select to authenticated
  using (is_owner() or store_id = current_staff_store());
create policy stock_write_staff on stock_movements
  for insert to authenticated
  with check (current_staff_id() is not null
              and (is_owner() or store_id = current_staff_store()));


-- ============================================================================
-- 8. ROTA / SHIFTS
-- ============================================================================
-- Staff read shifts for their own store (to see the schedule); owners all.
-- Managers/owners write the rota for their store.
drop policy if exists shifts_select_store on work_shifts;
drop policy if exists shifts_write_mgr    on work_shifts;
create policy shifts_select_store on work_shifts
  for select to authenticated
  using (is_owner() or store_id = current_staff_store());
create policy shifts_write_mgr on work_shifts
  for all to authenticated
  using (is_manager_or_owner() and (is_owner() or store_id = current_staff_store()))
  with check (is_manager_or_owner() and (is_owner() or store_id = current_staff_store()));


-- ============================================================================
-- 9. TIMESHEETS (clock_history) — self-service clock, manager approval
-- ============================================================================
-- • A staff member reads their OWN entries and may INSERT their own clock-ins
--   and UPDATE their own OPEN (unapproved) entry to clock out.
-- • They may NOT approve their own hours (approved/rejected/approved_by are
--   set by managers only — enforced below by splitting the update policies).
-- • Managers read+approve their store's entries; owners all.
drop policy if exists clock_select_self_or_mgr on clock_history;
drop policy if exists clock_insert_self        on clock_history;
drop policy if exists clock_update_self_open   on clock_history;
drop policy if exists clock_update_mgr         on clock_history;

create policy clock_select_self_or_mgr on clock_history
  for select to authenticated
  using (
    employee_id = current_staff_id()
    or is_owner()
    or (is_manager_or_owner()
        and exists (select 1 from staff_profiles sp
                    where sp.id = clock_history.employee_id
                      and sp.store_id = current_staff_store()))
  );

create policy clock_insert_self on clock_history
  for insert to authenticated
  with check (employee_id = current_staff_id());

-- Self clock-out: may edit own row ONLY while it is not yet approved/rejected,
-- and may NOT flip the approval fields (those must equal their existing false
-- state). Approval is a manager action, below.
create policy clock_update_self_open on clock_history
  for update to authenticated
  using (employee_id = current_staff_id() and coalesce(approved,false) = false
                                          and coalesce(rejected,false) = false)
  with check (
    employee_id = current_staff_id()
    and coalesce(approved,false) = false
    and coalesce(rejected,false) = false
  );

create policy clock_update_mgr on clock_history
  for update to authenticated
  using (
    is_manager_or_owner() and (
      is_owner() or exists (select 1 from staff_profiles sp
                            where sp.id = clock_history.employee_id
                              and sp.store_id = current_staff_store()))
  )
  with check (
    is_manager_or_owner() and (
      is_owner() or exists (select 1 from staff_profiles sp
                            where sp.id = clock_history.employee_id
                              and sp.store_id = current_staff_store()))
  );


-- ============================================================================
-- 10. PAYSLIPS — the most sensitive financial data
-- ============================================================================
-- • A staff member reads ONLY their own payslips, and cannot write any.
-- • Payslip generation (insert/update/delete) is OWNER-ONLY. Managers do NOT
--   get payroll write access — payroll is owner-only by design.
drop policy if exists payslips_select_self  on payslips;
drop policy if exists payslips_write_owner  on payslips;
create policy payslips_select_self on payslips
  for select to authenticated
  using (employee_id = current_staff_id() or is_owner());
create policy payslips_write_owner on payslips
  for all to authenticated
  using (is_owner()) with check (is_owner());


-- ============================================================================
-- 11. STAFF DOCUMENTS, SIFR, CHECKLISTS, TRAINING, KB
-- ============================================================================
-- staff_documents: has NO owner column in the current schema (see handover
-- note). Until an owner_staff_id column is added, per-staff scoping is
-- impossible, so we FAIL SAFE: managers/owners only. No team-member self-read
-- of documents yet — better to withhold than to over-share HR files.
drop policy if exists docs_mgr_only on staff_documents;
create policy docs_mgr_only on staff_documents
  for all to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());

-- SIFR incident reports: a reporter reads their own; managers/owners read all
-- (they triage). Any staff member may file one. Only managers/owners update
-- status / add official replies.
drop policy if exists sifr_select_self_or_mgr on sifr_reports;
drop policy if exists sifr_insert_staff       on sifr_reports;
drop policy if exists sifr_update_mgr         on sifr_reports;
create policy sifr_select_self_or_mgr on sifr_reports
  for select to authenticated
  using (reporter_id = current_staff_id() or is_manager_or_owner());
create policy sifr_insert_staff on sifr_reports
  for insert to authenticated
  with check (current_staff_id() is not null);
create policy sifr_update_mgr on sifr_reports
  for update to authenticated
  using (is_manager_or_owner()) with check (is_manager_or_owner());

-- Checklists, training courses/assessments, KB articles: staff READ; managers/
-- owners WRITE (they author the content). Grouped for brevity.
do $$
declare t text;
begin
  foreach t in array array[
    'checklist_templates','training_courses','training_assessments','kb_articles'
  ] loop
    execute format('drop policy if exists %I_read_staff on %I', t, t);
    execute format('drop policy if exists %I_write_mgr on %I', t, t);
    execute format(
      'create policy %I_read_staff on %I for select to authenticated '
      'using (current_staff_id() is not null)', t, t);
    execute format(
      'create policy %I_write_mgr on %I for all to authenticated '
      'using (is_manager_or_owner()) with check (is_manager_or_owner())', t, t);
  end loop;
end $$;


-- ============================================================================
-- 12. GOVERNANCE — audit_logs, role_permissions, app_state
-- ============================================================================
-- audit_logs: OWNER read only (audit reads are owner-only by design).
-- Client-written audit rows are informational only (Block E replaces these
-- with server-side append-only logging); we allow authenticated INSERT so the
-- current client can keep writing them, but reads are owner-gated and NOBODY
-- may update or delete (append-only by omission of those policies).
drop policy if exists audit_select_owner on audit_logs;
drop policy if exists audit_insert_staff on audit_logs;
create policy audit_select_owner on audit_logs
  for select to authenticated using (is_owner());
create policy audit_insert_staff on audit_logs
  for insert to authenticated with check (current_staff_id() is not null);

-- role_permissions: owner-only read+write (it governs the app's own UI gating).
drop policy if exists roleperms_owner on role_permissions;
create policy roleperms_owner on role_permissions
  for all to authenticated
  using (is_owner()) with check (is_owner());

-- app_state KV: can hold per-staff clock status + internal prefs. Keep it
-- authenticated-only, any staff read/write (keys are namespaced client-side).
-- Tighten later if any sensitive keys land here.
drop policy if exists appstate_staff on app_state;
create policy appstate_staff on app_state
  for all to authenticated
  using (current_staff_id() is not null)
  with check (current_staff_id() is not null);


-- ============================================================================
-- 13. HANDOVER NOTES  (decisions you need to make — read before deploying)
-- ============================================================================
-- (a) staff_documents has no owner column, so staff cannot yet read "their
--     own" documents; this migration restricts it to managers/owners to fail
--     safe. If you want per-staff document access, add:
--        alter table staff_documents add column owner_staff_id text;
--     then tell me and I'll add a self-read policy.
--
-- (b) Column-level self-update on staff_profiles (letting a team member change
--     avatar but NOT pay_rate) needs a `grant update (col,...) to authenticated`
--     that lists only the safe columns. That belongs with Block B (onboarding)
--     so it can be tested against a real signed-in session. Until then the
--     self-update policy still blocks role/store escalation via with_check.
--
-- (c) These policies assume the Block B auth flow sets staff_profiles.auth_id
--     for each user. A profile with a null auth_id has NO authenticated access
--     (safe default) — it is reachable only by an owner via the owner policy.
--
-- (d) anon access is UNCHANGED. This file never grants anon anything; run
--     `npm run test:security` after applying to confirm no anon using(true).
-- ============================================================================
