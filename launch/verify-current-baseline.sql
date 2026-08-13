-- ============================================================================
--  MILK POP — CURRENT-BASELINE VERIFICATION  (launch/verify-current-baseline.sql)
--  OPT-01.2 §3. Proves an EXISTING database is already at the exact final,
--  fully-migrated state BEFORE the ledger adopts it — so historical migrations
--  can be recorded WITHOUT being replayed.
--
--  Contract:
--    • Read-only: SELECT / DO only. No BEGIN/COMMIT of its own — the caller
--      (--db-adopt-ledger) runs it INSIDE the adoption transaction, so ANY
--      failure here raises and rolls the whole adoption back, writing no
--      ledger rows.
--    • "Table exists" is never treated as sufficient: this asserts columns,
--      constraints, indexes, RLS, privileges, the FINAL policy/RPC set, AND
--      the ABSENCE of known-obsolete policies and function signatures that
--      historical migrations supersede (recreating them is exactly the unsafe
--      intermediate state replay could leave behind).
--    • baseline_version pinned by the caller; bump it when the invariants change.
--
--  Derived empirically from schema.FRESH-INSTALL-ONLY.sql + the full migration chain applied on a
--  clean cluster (see scripts/pre-ledger-adopt.test.sh, which builds that state
--  and asserts THIS file passes on it and fails on any single regression).
-- ============================================================================

-- assert helper (session-local; safe inside the caller's transaction) --------
create or replace function pg_temp.assert(cond boolean, msg text)
  returns void language plpgsql as $$
begin
  if cond is null or cond = false then
    raise exception 'BASELINE FAIL: %', msg using errcode = 'check_violation';
  end if;
end $$;

-- convenience predicate wrappers (all STABLE, catalog-only) ------------------
create or replace function pg_temp.tbl(p text) returns boolean language sql stable as
  $$ select to_regclass(p) is not null $$;
create or replace function pg_temp.col(t text, c text) returns boolean language sql stable as
  $$ select exists (select 1 from information_schema.columns
       where table_schema='public' and table_name=t and column_name=c) $$;
create or replace function pg_temp.fn(sig text) returns boolean language sql stable as
  $$ select to_regprocedure(sig) is not null $$;
create or replace function pg_temp.pol(t text, p text) returns boolean language sql stable as
  $$ select exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname=p) $$;
create or replace function pg_temp.pol_any(p text) returns boolean language sql stable as
  $$ select exists (select 1 from pg_policies where schemaname='public' and policyname=p) $$;
create or replace function pg_temp.trig(t text, g text) returns boolean language sql stable as
  $$ select exists (select 1 from pg_trigger where not tgisinternal
       and tgrelid = ('public.'||t)::regclass and tgname=g) $$;
create or replace function pg_temp.con(t text, c text) returns boolean language sql stable as
  $$ select exists (select 1 from pg_constraint where conrelid=('public.'||t)::regclass and conname=c) $$;
create or replace function pg_temp.fnsrc_has(name text, needle text) returns boolean language sql stable as
  $$ select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname=name and pg_get_functiondef(p.oid) ilike '%'||needle||'%') $$;

do $$
begin
  -- ========================================================================
  --  A. CORE SCHEMA — required tables
  -- ========================================================================
  perform pg_temp.assert(pg_temp.tbl('public.'||t),
    format('required table public.%s is missing', t))
  from unnest(array[
    'staff_profiles','menu_items','deals','ingredients','customers',
    'orders','order_items','order_item_modifiers','payslips','clock_history',
    'work_shifts','sifr_reports','audit_logs','role_permissions','app_state',
    'contact_messages','franchise_inquiries','job_applications','job_vacancies',
    'news_posts','cms_pages','site_content','site_settings',
    'training_courses','training_assessments','training_assignments',
    'training_certificates','training_progress','training_results',
    'staff_documents','activity_log','email_log',
    'form_submission_log','cv_upload_ip_log',
    'media_assets','media_objects','media_references','storage_cleanup_jobs',
    'pos_orders','pos_order_items','pos_devices','pos_pairing_codes',
    'pos_events','pos_shifts','pos_catalog'
  ]) as t;

  -- WP-01/WP-02 public-form identity + idempotency columns
  perform pg_temp.assert(pg_temp.col(t,'idempotency_key'), format('%s.idempotency_key missing (WP-02)', t))
    from unnest(array['contact_messages','franchise_inquiries','job_applications']) as t;
  perform pg_temp.assert(pg_temp.col(t,'request_hash'), format('%s.request_hash missing (WP-01.1)', t))
    from unnest(array['contact_messages','franchise_inquiries','job_applications']) as t;

  -- WP-04R media registry columns
  perform pg_temp.assert(pg_temp.col('media_objects', c), format('media_objects.%s missing (WP-04R)', c))
    from unnest(array['status','storage_path','bucket','public_url','cleanup_after',
                      'cleanup_attempts','attached_at','uploaded_by','mime_type']) as c;
  perform pg_temp.assert(pg_temp.col('media_references', c), format('media_references.%s missing (WP-04R)', c))
    from unnest(array['media_object_id','entity_type','entity_id','field_path']) as c;

  -- cleanup-job table columns
  perform pg_temp.assert(pg_temp.col('storage_cleanup_jobs', c), format('storage_cleanup_jobs.%s missing', c))
    from unnest(array['status','next_attempt_at','attempts','storage_path','bucket','reason']) as c;

  -- FKs, unique constraints, important indexes
  perform pg_temp.assert(pg_temp.con('media_references','media_references_media_object_id_fkey'),
    'media_references → media_objects FK missing');
  perform pg_temp.assert(pg_temp.con('media_references','media_references_entity_type_entity_id_field_path_key'),
    'media_references (entity_type,entity_id,field_path) UNIQUE missing');
  perform pg_temp.assert(pg_temp.con('media_objects','media_objects_bucket_storage_path_key'),
    'media_objects (bucket,storage_path) UNIQUE missing');
  perform pg_temp.assert(pg_temp.con('media_objects','media_objects_status_check'),
    'media_objects.status CHECK missing');
  perform pg_temp.assert(
    exists (select 1 from pg_class where relname='job_applications_idempotency_key_uq' and relkind='i'),
    'job_applications idempotency unique index missing');
  perform pg_temp.assert(
    exists (select 1 from pg_class where relname='contact_messages_idempotency_key_uq' and relkind='i'),
    'contact_messages idempotency unique index missing');
  perform pg_temp.assert(
    exists (select 1 from pg_class where relname='franchise_inquiries_idempotency_key_uq' and relkind='i'),
    'franchise_inquiries idempotency unique index missing');

  -- RLS enabled on EVERY public table (deny-by-default surface)
  perform pg_temp.assert(
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind='r' and not c.relrowsecurity) = 0,
    'one or more public tables have RLS disabled');

  -- ========================================================================
  --  B. PUBLIC-FORM SECURITY
  -- ========================================================================
  -- Direct anon/authenticated INSERT into the public-form tables is revoked.
  perform pg_temp.assert(not has_table_privilege('anon', 'public.'||t, 'INSERT'),
    format('anon can directly INSERT into %s (Phase B not applied)', t))
    from unnest(array['contact_messages','franchise_inquiries','job_applications']) as t;
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.'||t, 'INSERT'),
    format('authenticated can directly INSERT into %s (Phase B not applied)', t))
    from unnest(array['contact_messages','franchise_inquiries','job_applications']) as t;

  -- The final submission + resolution RPCs exist (5-arg / 3-arg finals).
  -- INC11: the exposed gate is the 7-argument EVIDENCE form (the client
  -- echoes the displayed notice's id + sha); the previous 5-argument body
  -- survives only as submit_public_form_core, callable by nothing but the
  -- gate. Both facts are part of the final baseline.
  perform pg_temp.assert(pg_temp.fn('public.submit_public_form(text, jsonb, uuid, text, text, text, text)'),
    'final submit_public_form 7-arg evidence gate missing');
  perform pg_temp.assert(pg_temp.fn('public.submit_public_form_core(text, jsonb, uuid, text, text)'),
    'submit_public_form_core (5-arg) missing');
  perform pg_temp.assert(not pg_temp.fn('public.submit_public_form(text, jsonb, uuid, text, text)'),
    'evidence-free 5-arg submit_public_form still exposed');
  perform pg_temp.assert(pg_temp.fn('public.resolve_public_submission(text, uuid, text)'),
    'resolve_public_submission(text,uuid,text) RPC missing');

  -- Rate-limit / idempotency reservation surface.
  perform pg_temp.assert(pg_temp.tbl('public.form_submission_log'), 'form_submission_log missing');
  perform pg_temp.assert(pg_temp.tbl('public.cv_upload_ip_log'), 'cv_upload_ip_log missing');

  -- ========================================================================
  --  C. ORDERS & POS INTEGRITY
  -- ========================================================================
  perform pg_temp.assert(not pg_temp.pol('orders','orders_insert_staff'),
    'obsolete permissive policy orders_insert_staff still present on orders');
  -- No orders INSERT policy may be permissive (a NULL/true WITH CHECK); the
  -- only permitted insert path is owner-import (WITH CHECK is_owner()).
  perform pg_temp.assert(
    not exists (select 1 from pg_policies
       where schemaname='public' and tablename='orders' and cmd='INSERT'
         and (with_check is null or btrim(with_check) in ('true','(true)'))),
    'a permissive INSERT policy exists on orders');
  -- WS7: the one-step submit_web_order() path is REMOVED. A completed order
  -- now exists only via quote → reserved payment → finalisation, so the
  -- baseline asserts the new contract and the ABSENCE of the old one.
  perform pg_temp.assert(not pg_temp.fn('public.submit_web_order(jsonb)'),
    'the removed one-step submit_web_order(jsonb) path is still present');
  perform pg_temp.assert(pg_temp.fn('public.create_order_quote(jsonb)'),
    'create_order_quote(jsonb) RPC missing');
  perform pg_temp.assert(pg_temp.fn('public.begin_quote_payment(jsonb)'),
    'begin_quote_payment(jsonb) RPC missing');
  perform pg_temp.assert(pg_temp.fn('public.finalise_order_payment(jsonb)'),
    'finalise_order_payment(jsonb) RPC missing');
  -- WS7b (payment authority): the correction round adds the custody, recovery,
  -- reconciliation and lifecycle surface. The baseline pins every one present
  -- so a launch DB that silently dropped one cannot pass.
  perform pg_temp.assert(pg_temp.fn('public.release_quote_payment(jsonb)'),
    'release_quote_payment(jsonb) RPC missing');
  perform pg_temp.assert(pg_temp.fn('public.cancel_order_quote(jsonb)'),
    'cancel_order_quote(jsonb) RPC missing');
  perform pg_temp.assert(pg_temp.fn('public.open_till_session(jsonb)'),
    'open_till_session(jsonb) RPC missing');
  perform pg_temp.assert(pg_temp.fn('public.close_till_session(jsonb)'),
    'close_till_session(jsonb) RPC missing');
  perform pg_temp.assert(pg_temp.fn('public.enrol_till_device(jsonb)'),
    'enrol_till_device(jsonb) RPC missing');
  perform pg_temp.assert(pg_temp.fn('public.expire_stale_quotes()'),
    'expire_stale_quotes() sweeper missing');
  perform pg_temp.assert(pg_temp.fn('public.resolve_payment_reconciliation(jsonb)'),
    'resolve_payment_reconciliation(jsonb) RPC missing');
  perform pg_temp.assert(pg_temp.fn('public.reconcile_card_payment(jsonb)'),
    'reconcile_card_payment(jsonb) RPC missing');
  -- the SECURITY DEFINER finalisation core the wrapper and the recovery path
  -- both call — revoked from every client role, present in the baseline.
  perform pg_temp.assert(pg_temp.fn('public.finalise_order_payment_core(jsonb, boolean, text)'),
    'finalise_order_payment_core(jsonb, boolean, text) missing');
  perform pg_temp.assert(pg_temp.fn('public.price_basket_internal(stores, jsonb, jsonb, boolean)'),
    'the authoritative pricing helper price_basket_internal() is missing');
  perform pg_temp.assert(
    to_regclass('public.order_quotes') is not null
      and to_regclass('public.quote_payment_attempts') is not null
      and to_regclass('public.web_till_sessions') is not null
      and to_regclass('public.payment_terminals') is not null,
    'a WS7 financial table (quotes, attempts, till sessions, terminals) is missing');
  perform pg_temp.assert(pg_temp.fn('public.pos_ingest_batch(uuid, jsonb)'),
    'server-authoritative pos_ingest_batch(uuid,jsonb) RPC missing');

  -- ========================================================================
  --  D. AUTH & PRIVILEGE BOUNDARIES
  -- ========================================================================
  perform pg_temp.assert(pg_temp.fn('public.is_aal2()'), 'AAL2 helper is_aal2() missing');
  perform pg_temp.assert(pg_temp.fn('public.jwt_aal()'), 'AAL2 helper jwt_aal() missing');
  perform pg_temp.assert(pg_temp.fn('public.is_owner()'), 'is_owner() missing');
  perform pg_temp.assert(pg_temp.fn('public.is_manager_or_owner()'), 'is_manager_or_owner() missing');
  -- The privileged helpers must gate on AAL2 (the final hardening).
  perform pg_temp.assert(pg_temp.fnsrc_has('is_owner','is_aal2'),
    'is_owner() does not enforce is_aal2() (AAL2 regression)');
  perform pg_temp.assert(pg_temp.fnsrc_has('is_manager_or_owner','is_aal2'),
    'is_manager_or_owner() does not enforce is_aal2() (AAL2 regression)');
  -- A privileged policy actually references the final helpers.
  perform pg_temp.assert(
    exists (select 1 from pg_policies where schemaname='public'
       and (qual ilike '%is_owner()%' or with_check ilike '%is_owner()%'
         or qual ilike '%is_manager_or_owner()%' or with_check ilike '%is_manager_or_owner()%')),
    'no policy references is_owner()/is_manager_or_owner()');
  -- Disabled staff cannot satisfy the current-staff helpers.
  perform pg_temp.assert(pg_temp.fnsrc_has('current_staff_id','disabled'),
    'current_staff_id() does not exclude disabled staff');
  perform pg_temp.assert(pg_temp.fnsrc_has('current_staff_role','disabled'),
    'current_staff_role() does not exclude disabled staff');

  -- ========================================================================
  --  E. TRAINING & STAFF DATA
  -- ========================================================================
  -- Certificate rows are protected by a trigger; the permissive demo policy is gone.
  perform pg_temp.assert(pg_temp.trig('training_certificates','trg_training_certificates_protect'),
    'training_certificates protection trigger missing');
  perform pg_temp.assert(not pg_temp.pol('training_certificates','demo_full_access'),
    'obsolete demo_full_access policy still present on training_certificates');
  perform pg_temp.assert(pg_temp.trig('training_assignments','trg_training_assignments_protect'),
    'training_assignments protection trigger missing');
  -- Final staff-document restrictions and no direct anon insert.
  perform pg_temp.assert(pg_temp.pol('staff_documents','docs_select_self_or_mgr'),
    'staff_documents scoped-read policy missing');
  perform pg_temp.assert(not has_table_privilege('anon','public.staff_documents','INSERT'),
    'anon can directly INSERT staff_documents');
  -- Sensitive profile-field protection triggers.
  perform pg_temp.assert(pg_temp.trig('staff_profiles','trg_staff_profiles_protect'),
    'staff_profiles field-protection trigger missing');
  perform pg_temp.assert(pg_temp.trig('staff_profiles','trg_staff_self_update_lock'),
    'staff_profiles self-update lock trigger missing');

  -- ========================================================================
  --  F. MEDIA
  -- ========================================================================
  -- Legacy media_assets remains structurally compatible (old CMS columns).
  perform pg_temp.assert(pg_temp.col('media_assets', c), format('legacy media_assets.%s missing', c))
    from unnest(array['url','folder','type','name','size']) as c;
  -- The technical registry is media_objects, driven by the final RPCs.
  perform pg_temp.assert(pg_temp.fn('public.finalise_media_reference(uuid, text, text, text, text)'),
    'finalise_media_reference RPC missing (registry uses media_objects)');
  perform pg_temp.assert(pg_temp.fn('public.media_path_is_referenced(text, text)'),
    'media_path_is_referenced guard missing');
  -- Cleanup machinery present (operational ENABLEMENT is enforced outside the
  -- DB — the build validator R8 + launch readiness gate — not by SQL).
  perform pg_temp.assert(pg_temp.fn('public.mark_media_cleanup_candidates(integer)'),
    'mark_media_cleanup_candidates missing');
  perform pg_temp.assert(pg_temp.fn('public.claim_media_cleanup_batch(integer)'),
    'claim_media_cleanup_batch missing');
  -- Unsafe legacy replacePath must not be represented in ANY database function.
  perform pg_temp.assert(
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname ~* 'replace.?path'),
    'a replace_path-style function still exists (unsafe legacy media path)');
  perform pg_temp.assert(
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.prokind = 'f'
         and pg_get_functiondef(p.oid) ilike '%replacePath%'),
    'replacePath logic still present in a database function');

  -- ========================================================================
  --  G. FINAL-POLICY / FUNCTION ABSENCE (obsolete objects must be gone)
  -- ========================================================================
  perform pg_temp.assert(not pg_temp.pol_any('orders_insert_staff'),
    'obsolete policy orders_insert_staff present somewhere');
  perform pg_temp.assert(not pg_temp.pol_any('demo_full_access'),
    'obsolete demo_full_access policy present somewhere');
  perform pg_temp.assert(not pg_temp.pol('contact_messages','public_insert')
                     and not pg_temp.pol('franchise_inquiries','public_insert')
                     and not pg_temp.pol('job_applications','public_insert'),
    'obsolete public_insert policy present on a public-form table');
  -- Superseded function signatures must NOT exist.
  perform pg_temp.assert(not pg_temp.fn('public.submit_public_form(text, jsonb, uuid, text)'),
    'obsolete 4-arg submit_public_form still present');
  perform pg_temp.assert(not pg_temp.fn('public.complete_training(text, integer, text, text)'),
    'obsolete 4-arg complete_training still present');
  perform pg_temp.assert(not pg_temp.fn('public.cleanup_orphan_media(integer)'),
    'obsolete cleanup_orphan_media(int) still present (WP-04R removed it)');

  -- ========================================================================
  --  H. WS7c (R3) — HONEST PAYMENT-CORE CORRECTIONS
  -- ========================================================================
  -- Status vocabulary: this system has no provider integration, so a launch
  -- database must carry the honest reconciled state and must NOT still allow
  -- the provider claim.
  perform pg_temp.assert(pg_temp.con('orders','orders_payment_status_controlled'),
    'orders_payment_status_controlled constraint missing');
  perform pg_temp.assert(exists (select 1 from pg_constraint
     where conname = 'orders_payment_status_controlled'
       and pg_get_constraintdef(oid) like '%MANUAL_EVIDENCE_MATCHED%'
       and pg_get_constraintdef(oid) not like '%PROVIDER_RECONCILED%'),
    'orders payment-status vocabulary is not the honest R3 set');
  -- Attribution columns: claimed vs recorded time; operator vs finaliser.
  perform pg_temp.assert(pg_temp.col('orders', c), format('orders.%s missing (R3 attribution)', c))
    from unnest(array['payment_claimed_at','payment_recorded_at',
                      'payment_operator_staff_id','finalised_by_staff_id',
                      'finalisation_reason']) as c;
  -- Manual-evidence contract on the immutable reconciliation record.
  perform pg_temp.assert(pg_temp.col('payment_reconciliations', c),
      format('payment_reconciliations.%s missing (R3 evidence contract)', c))
    from unnest(array['evidence_type','matched_currency','idempotency_key','payment_event_at']) as c;
  perform pg_temp.assert(pg_temp.con('payment_reconciliations','preconc_evidence_type_controlled'),
    'preconc_evidence_type_controlled missing');
  perform pg_temp.assert(pg_temp.con('payment_reconciliations','preconc_manual_evidence_complete'),
    'preconc_manual_evidence_complete missing');
  perform pg_temp.assert(exists (select 1 from pg_indexes
     where schemaname='public' and tablename='payment_reconciliations'
       and indexname='payment_reconciliations_idem_unique'),
    'store-scoped idempotency-key unique index missing');
  -- Idempotent privileged recovery lives on the quote, unique per store.
  perform pg_temp.assert(pg_temp.col('order_quotes','resolution_id')
                     and pg_temp.col('order_quotes','resolution_hash'),
    'order_quotes resolution identity columns missing');
  perform pg_temp.assert(exists (select 1 from pg_indexes
     where schemaname='public' and tablename='order_quotes'
       and indexname='order_quotes_resolution_unique'),
    'order_quotes_resolution_unique index missing');
  -- A completed order''s lines are financial records.
  perform pg_temp.assert(pg_temp.trig('order_items','trg_order_items_immutable'),
    'order_items immutability trigger missing');
  perform pg_temp.assert(pg_temp.trig('order_item_modifiers','trg_order_item_modifiers_immutable'),
    'order_item_modifiers immutability trigger missing');
  -- Sensitive reads are manager/owner scoped; the broad store-wide policies are GONE.
  perform pg_temp.assert(pg_temp.pol('payment_reconciliations','payment_reconciliations_select_mgr')
                     and not pg_temp.pol('payment_reconciliations','payment_reconciliations_select_store'),
    'payment_reconciliations read scope is not the R3 manager/owner policy');
  perform pg_temp.assert(pg_temp.pol('online_payment_accounts','online_payment_accounts_select_mgr')
                     and not pg_temp.pol('online_payment_accounts','online_payment_accounts_select_store'),
    'online_payment_accounts read scope is not the R3 manager/owner policy');
  perform pg_temp.assert(pg_temp.pol('quote_payment_attempts','quote_payment_attempts_select_scoped')
                     and not pg_temp.pol('quote_payment_attempts','quote_payment_attempts_select_store'),
    'quote_payment_attempts read scope is not the R3 own-rows policy');
  perform pg_temp.assert(pg_temp.pol('web_till_sessions','web_till_sessions_select_scoped')
                     and not pg_temp.pol('web_till_sessions','web_till_sessions_select_store'),
    'web_till_sessions read scope is not the R3 own-rows policy');
  -- Behavioural pins: recovery is idempotent + AAL2, evidence content is
  -- validated at the ledger trigger, and cash custody demands the device.
  perform pg_temp.assert(pg_temp.fnsrc_has('resolve_payment_reconciliation','resolution_id_required'),
    'resolve_payment_reconciliation does not require a resolution id');
  perform pg_temp.assert(pg_temp.fnsrc_has('resolve_payment_reconciliation','is_aal2'),
    'resolve_payment_reconciliation does not enforce AAL2');
  perform pg_temp.assert(pg_temp.fnsrc_has('enforce_order_ledger_immutable','MANUAL_EVIDENCE_MATCHED'),
    'order ledger trigger does not gate the manual-evidence transition');
  perform pg_temp.assert(pg_temp.fnsrc_has('finalise_order_payment_core','device_credential_invalid'),
    'cash finalisation does not verify the device credential');
  perform pg_temp.assert(pg_temp.fnsrc_has('close_till_session','device_credential_invalid'),
    'drawer close does not verify the device credential');

  raise notice 'BASELINE OK: current database matches the expected final pre-ledger baseline.';
end $$;
