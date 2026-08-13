# STAGE 3 — SCHEMA INVENTORY (Workstream 1)

Generated from the LIVE effective state: a disposable PostgreSQL 17 database
after `schema.sql` + the full manifest-migration chain
(catalog introspection, not per-file scanning). Canonical machine-readable
detail: `artifacts/stage3-schema-inventory.json` — the same snapshot engine
Workstream 14 will use for baseline equivalence.

## Object counts

| Section | Count |
|---|---|
| tables | 69 |
| columns | 855 |
| constraints | 286 |
| indexes | 154 |
| policies | 106 |
| table_grants | 780 |
| column_grants | 6029 |
| functions | 125 |
| function_grants | 191 |
| triggers | 49 |
| views | 6 |
| enums | 8 |
| sequences | 0 |
| extensions | 1 |
| casts | 2 |
| storage_buckets | 4 |
| migration_ledger | 0 |

## Audit findings feeding Workstreams 2–12

### WS2 — temporal values stored as text (13)

(`kb_articles.reading_time` and `training_courses.estimated_time` are
display strings — "5 min read" — not temporal values; they stay text.)

| table | name | data_type | nullable |
|---|---|---|---|
| cms_pages | last_edited_date | text | false |
| contact_messages | submitted_at | text | false |
| franchise_inquiries | submitted_at | text | false |
| job_applications | applied_at | text | false |
| kb_articles | reading_time | text | false |
| media_assets | uploaded_at | text | false |
| news_posts | date | text | false |
| sifr_reports | date | text | false |
| sifr_reports | submitted_at | text | false |
| staff_documents | expiry_date | text | true |
| staff_documents | upload_date | text | false |
| staff_documents | verified_at | text | true |
| training_courses | estimated_time | text | false |

### WS3 — relationship-shaped columns WITHOUT a foreign key (67)

| table | column | type |
|---|---|---|
| activity_log | actor_auth_id | uuid |
| activity_log | actor_staff_id | text |
| app_state | owner_staff_id | text |
| clock_history | approved_by | text |
| cms_pages | last_edited_by | text |
| cv_upload_ip_log | application_id | text |
| email_log | provider_id | text |
| email_log | sent_by_auth_id | uuid |
| email_log | sent_by_staff_id | text |
| email_log | template_id | text |
| media_objects | uploaded_by | text |
| media_references | entity_id | text |
| online_payment_accounts | account_id | text |
| order_item_modifiers | row_id | uuid |
| order_items | row_id | uuid |
| order_quotes | order_id | text |
| order_quotes | reservation_id | text |
| order_quotes | resolution_id | text |
| order_quotes | staff_id | text |
| orders | finalised_by_staff_id | text |
| orders | payment_operator_staff_id | text |
| payment_reconciliations | recorded_by_staff_id | text |
| payment_terminals | merchant_id | text |
| payment_terminals | terminal_id | text |
| payslips | generated_by | text |
| pos_approvals | approver_user_id | text |
| pos_approvals | entity_id | text |
| pos_approvals | requested_by_user_id | text |
| pos_audit_events | entity_id | text |
| pos_cash_movements | approved_by_user_id | text |
| pos_cash_movements | user_id | text |
| pos_catalog | published_by | text |
| pos_corrections | approved_by_user_id | text |
| pos_corrections | user_id | text |
| pos_devices | installation_id | text |
| pos_events | entity_id | text |
| pos_events | event_id | text |
| pos_order_item_modifiers | modifier_id | text |
| pos_order_items | product_id | text |
| pos_orders | sold_by_user_id | text |
| pos_pairing_codes | created_by | text |
| pos_refunds | approved_by_user_id | text |
| pos_refunds | user_id | text |
| pos_shifts | closed_by_user_id | text |
| pos_shifts | opened_by_user_id | text |
| pos_voids | approved_by_user_id | text |
| pos_voids | user_id | text |
| quote_payment_attempts | operator_staff_id | text |
| quote_payment_attempts | provider_merchant_id | text |
| quote_payment_attempts | provider_terminal_id | text |
| quote_payment_attempts | reservation_id | text |
| quote_payment_attempts | resolved_by_staff_id | text |
| staff_documents | approved_by | text |
| staff_documents | uploaded_by | text |
| staff_documents | verified_by | text |
| staff_profiles | auth_id | uuid |
| stock_movements | recorded_by | text |
| training_assignments | assessment_id | text |
| training_assignments | assigned_by | text |
| training_certificates | assessment_id | text |
| training_courses | assessment_id | text |
| training_results | assessment_id | text |
| training_results | course_id | text |
| training_results | submission_id | text |
| web_till_devices | registered_by | text |
| web_till_sessions | closed_by_staff_id | text |
| web_till_sessions | opened_by_staff_id | text |

Existing foreign keys: 84 (full definitions + delete rules in the JSON; the
WS3 relationship matrix will classify each).

### WS5/6 — money-bearing columns (49 found; 1 non-exact types)

Numeric shapes in use: numeric(10,2), numeric(12,4), numeric(5,1), numeric(7,2), numeric(8,2)

**Non-exact (float/text) money columns — WS6 blockers:**

| table | column | type |
|---|---|---|
| job_vacancies | salary | text |

### RLS coverage — public tables WITHOUT row security (0)

Every public table has RLS enabled.

### SECURITY DEFINER functions without a pinned search_path (0)

All definer functions pin search_path.

### WS7 input — primary/unique constraints in force: 83

Per-table detail in the JSON (`constraints` where type ∈ {p, u}); the
uniqueness/idempotency audit evaluates the brief's business-key list against
these.

## Notes

- Column-level grants are captured (`column_grants`) — the Stage-2.1.2
  staff_profiles surface is part of the canonical state.
- `migration_ledger` records dev-chain provenance and is EXCLUDED from the
  WS14 equivalence comparison by design (documented development difference).
- storage.buckets rows are system reference data and part of the baseline.
