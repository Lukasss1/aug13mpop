#!/usr/bin/env bash
# =============================================================================
#  MILK POP — AUTHORITATIVE MIGRATION MANIFEST  (launch/migration-manifest.sh)
#
#  THE single source of truth for database file order. Every consumer reads
#  THIS file so the order can never fork across the runbook, the tests and the
#  docs:
#    • launch/launch.sh            (--db-fresh / --db-upgrade runners)
#    • scripts/migration-baseline.test.sh   (applies MP_MIGRATIONS on a fresh cluster)
#    • scripts/rls-matrix.local.mjs         (applies the fresh order, then asserts RLS)
#    • scripts/migration-manifest.test.mjs  (fails on drift / omission / stray fixtures)
#
#  USAGE
#    source launch/migration-manifest.sh          # get the arrays below
#    bash   launch/migration-manifest.sh fresh     # print fresh install order
#    bash   launch/migration-manifest.sh upgrade   # print upgrade-only order
#    bash   launch/migration-manifest.sh migrations # print the migration chain
#    bash   launch/migration-manifest.sh all        # fresh-only files + chain
#
#  CLASSIFICATION
#    MP_FRESH_ONLY   Runs ONLY on a brand-new empty project, first, in order.
#                    schema.FRESH-INSTALL-ONLY.sql carries a CLEAN-SLATE section that DROPS ALL
#                    TABLES; seed.sql loads public content. NEITHER is ever run
#                    by the upgrade path.
#    MP_MIGRATIONS   The ordered migration chain. Applies to BOTH paths. Every
#                    file is idempotent (guarded with IF [NOT] EXISTS / DROP …
#                    IF EXISTS), so the upgrade path is safe to re-run and the
#                    baseline test can apply the whole chain on a fresh schema.
#                    The two legacy conditionals (security_lockdown, payroll_cv)
#                    are self-guarding and therefore members of the chain, not
#                    special cases. The Phase B public-forms migration MUST be
#                    the LAST entry in MP_MIGRATIONS (it closes direct anon
#                    inserts, so everything it depends on must exist first).
#
#  Dev fixtures (supabase/seed.dev.sql) are DELIBERATELY absent — they must
#  never reach a real project. The manifest test asserts they stay out.
# =============================================================================

# ---- fresh-install-only files (schema then public seed) ---------------------
MP_FRESH_ONLY=(
  "supabase/schema.FRESH-INSTALL-ONLY.sql"
  "supabase/seed.sql"
)

# ---- the ordered, idempotent migration chain (both paths) -------------------
# OPT-01.2A §1 — the chain is split into an IMMUTABLE historical baseline and an
# APPEND-ONLY future section. The baseline order is frozen (its fingerprint is
# pinned by scripts/migration-manifest.test.mjs): never reorder it, never insert
# into it, never edit an applied file. New migrations are appended to
# MP_FUTURE_MIGRATIONS ONLY. Phase B is the last BASELINE migration (it locks the
# public forms); future migrations legitimately run after it. MP_MIGRATIONS is
# the concatenation and remains the single ordered source every consumer reads.
MP_BASELINE_MIGRATIONS=(
  "supabase/migration_security_lockdown.sql"
  "supabase/migration_payroll_cv.sql"
  "supabase/migration_rls_per_role.sql"
  "supabase/migration_auth_onboarding.sql"
  "supabase/migration_email_log.sql"
  "supabase/migration_cv_pipeline.sql"
  "supabase/migration_public_form_guard.sql"
  "supabase/migration_activity_log.sql"
  "supabase/migration_field_lock.sql"
  "supabase/migration_site_content.sql"
  "supabase/migration_training_academy.sql"
  "supabase/migration_inbox_read.sql"
  "supabase/migration_drink_art.sql"
  "supabase/migration_stage9_staff_onboarding.sql"
  "supabase/migration_staff_documents_storage.sql"
  "supabase/migration_stage4_training.sql"
  "supabase/migration_manager_staff_writes.sql"
  "supabase/migration_server_grading.sql"
  "supabase/migration_stage5_app_state.sql"
  "supabase/migration_stage7_replace_collection.sql"
  "supabase/migration_stage8_permission_seed.sql"
  "supabase/migration_stage10_rls_hardening.sql"
  "supabase/migration_stage11_server_audit.sql"
  "supabase/migration_fix7_sensitive_collections.sql"
  "supabase/migration_fix8_aal2.sql"
  "supabase/migration_fix9_training_integrity.sql"
  "supabase/migration_fix10_server_clock.sql"
  "supabase/migration_fix11_claim_shift.sql"
  "supabase/migration_fix12_server_order.sql"
  "supabase/migration_fix2_explode_definer.sql"
  "supabase/migration_pos_sync.sql"
  "supabase/migration_pos_catalog.sql"
  "supabase/migration_wp01_public_form_identity.sql"
  "supabase/migration_wp02_atomic_submission.sql"
  "supabase/migration_wp01_1_request_hash.sql"
  "supabase/migration_wp02_1_resolve_and_hash.sql"
  "supabase/migration_wp04r_media_objects.sql"
  "supabase/migration_phase_b_public_forms.sql"
)

# APPEND-ONLY. New migrations go here, in order, after the frozen baseline.
MP_FUTURE_MIGRATIONS=(
  "supabase/migration_launch_data_neutralise.sql"
  "supabase/migration_stage2_role_hardening.sql"
  "supabase/migration_stage2_1_permission_closure.sql"
  "supabase/migration_stage2_1_1_reaudit_closure.sql"
  "supabase/migration_stage2_1_2_salary_confidentiality.sql"
  "supabase/migration_stage3_ws5_ws7_financial_uniqueness.sql"
  "supabase/migration_stage3_ws2_temporal_core.sql"
  "supabase/migration_stage3_ws3_relationships.sql"
  "supabase/migration_stage3_ws3b_cert_update_integrity.sql"
  "supabase/migration_stage3_ws6c_vat_bounds.sql"
  "supabase/migration_stage3_ws6d_vat_lifecycle.sql"
  "supabase/migration_stage3_ws6e_store_setup_lifecycle.sql"
  "supabase/migration_stage3_ws6f_vat_corrections.sql"
  "supabase/migration_stage3_ws6g_operational_closure.sql"
  "supabase/migration_stage3_ws6h_classification_withdrawal.sql"
  "supabase/migration_stage3_ws6i_classification_permanence.sql"
  "supabase/migration_stage3_ws7_quote_finalise.sql"
  "supabase/migration_stage3_ws7b_payment_authority.sql"
  "supabase/migration_stage3_ws7c_payment_corrections.sql"
  "supabase/migration_stage3_ws9_retention.sql"
  # ---- R4.8 launch-closure (append-only) ----
  # R4.9 G2 ORDER CORRECTION. The shipped order ran allergens BEFORE gates, with
  # the comment "launch_readiness reads them". launch_readiness() reads allergen
  # tables AND launch_settings AND current_privacy_version(), the latter two
  # created by the gates migration — and it is `language sql`, whose body
  # PostgreSQL validates at CREATE time. On a fresh install the chain therefore
  # died at migration_r48_allergens.sql with
  #   ERROR: relation "launch_settings" does not exist
  # The dependency runs one way only (the gates migration references nothing
  # from allergens), so gates now precedes allergens. No migration file content
  # is changed; neither file had ever been applied anywhere.
  "supabase/migration_r48_truth_and_people.sql"
  "supabase/migration_r48_outbox_and_gates.sql"
  "supabase/migration_r48_allergens.sql"
  "supabase/migration_r48_ops_and_payroll.sql"
  # ---- R4.9 launch-closure corrections (append-only) ----
  "supabase/migration_r49_g2_chain_fixes.sql"
  "supabase/migration_r49_public_menu.sql"
  "supabase/migration_r49_launch_gate.sql"
  "supabase/migration_r49_recovery.sql"
  "supabase/migration_r410_stores_public_contract.sql"
  "supabase/migration_r410_site_content_singleton.sql"
  "supabase/migration_r410_anon_surface.sql"
  "supabase/migration_r410_public_projections.sql"
  "supabase/migration_r410_projections_live.sql"
  "supabase/migration_r410_publication_defaults.sql"
  "supabase/migration_r410_launch_gate_invariants.sql"
  "supabase/migration_r410_form_notice_scope.sql"
  "supabase/migration_r410_publish_record_repair.sql"
  "supabase/migration_r410_candidate_state.sql"
  "supabase/migration_r410_publication_boundary.sql"
  "supabase/migration_inc11_collection_revisions.sql"
  "supabase/migration_inc11_publication_scope.sql"
  "supabase/migration_inc11_notice_evidence.sql"
  "supabase/migration_inc11_studio_atomicity.sql"
  "supabase/migration_inc11_news_slugs.sql"
  "supabase/migration_inc11_application_transitions.sql"
  "supabase/migration_inc11_view_write_authority.sql"
  "supabase/migration_inc11_anon_function_surface.sql"
  "supabase/migration_inc11_gate_sources_and_storage.sql"
  "supabase/migration_inc11_ambient_dml.sql"
  "supabase/migration_inc11_column_grants.sql"
  "supabase/migration_inc11_collection_revision_bootstrap.sql"
  # ---- Small-business production closure (append-only) ----
  "supabase/migration_closure_public_site_configuration.sql"
  "supabase/migration_t133_store_operational_state.sql"
  "supabase/migration_t1331_operational_atomicity.sql"
  "supabase/migration_t1332_checklist_item_atomicity.sql"
  "supabase/migration_t1333_launch_content_honesty.sql"
  "supabase/migration_t1333_shift_overlap_guard.sql"
  "supabase/migration_t1334_cover_reason_honesty.sql"
  "supabase/migration_t1335_shift_cover_lifecycle.sql"
  "supabase/migration_t1336_retention_heartbeat.sql"
  "supabase/migration_t1336_scheduler_failure_heartbeats.sql"
  "supabase/migration_t1337_small_business_usability.sql"
  "supabase/migration_t13310_public_boundary_cleanup.sql"
  "supabase/migration_t13311_public_form_integrity.sql"
  "supabase/migration_t13312_deployment_handoff.sql"
  "supabase/migration_t13313_staff_portal_integrity.sql"
  "supabase/migration_t13319_release_integrity.sql"
  "supabase/migration_t13320_final_audit.sql"
  "supabase/migration_t13322_public_store_scope.sql"
)

MP_MIGRATIONS=(
  "${MP_BASELINE_MIGRATIONS[@]}"
  "${MP_FUTURE_MIGRATIONS[@]}"
)

# Resolved orders for the deployment paths.
mp_fresh_order()   { printf '%s\n' "${MP_FRESH_ONLY[@]}" "${MP_MIGRATIONS[@]}"; }
mp_upgrade_order() { printf '%s\n' "${MP_MIGRATIONS[@]}"; }

# When executed (not sourced), print a requested list — machine-readable, one
# path per line, no comments — for non-bash consumers and quick inspection.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-}" in
    fresh)               mp_fresh_order ;;
    upgrade|migrations)  mp_upgrade_order ;;
    baseline)            printf '%s\n' "${MP_BASELINE_MIGRATIONS[@]}" ;;
    future)              ((${#MP_FUTURE_MIGRATIONS[@]})) && printf '%s\n' "${MP_FUTURE_MIGRATIONS[@]}" || true ;;
    all)                 mp_fresh_order ;;
    *) echo "usage: bash launch/migration-manifest.sh {fresh|upgrade|migrations|baseline|future|all}" >&2; exit 2 ;;
  esac
fi
