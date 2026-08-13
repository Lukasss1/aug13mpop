# STAGE 3 — RELATIONSHIP & DELETION MATRIX (WS3)

Every relationship is a design decision. Enforced set lives in
`migration_stage3_ws3_relationships.sql`; behavioural proofs in matrix §15.
Answering the auditor's design questions directly: `orders.staff_id` →
`staff_profiles.id` (there is no separate employees table; staff_profiles IS
the employee registry, text business ids, auth-linked via auth_id). Deleted
staff do NOT exist as a state: people are `disabled`, never deleted, and
RESTRICT makes that physical law once history exists. Ownership columns stay
nullable where the business fact can be absent (an online order without an
assigned staff member), with RESTRICT protecting the reference when present.

## Enforced foreign keys

| Child.column | Parent | On delete | Reason / retention impact |
|---|---|---|---|
| clock_history/work_shifts/payslips/staff_documents/training_{assignments,certificates,progress,results}.employee_id, sifr_reports.reporter_id, orders.staff_id | staff_profiles.id | RESTRICT | Employment, payroll, safety and sales attribution are permanent history; a person with any such row is undeletable — deactivate via status. |
| staff_profiles/orders/work_shifts/staff_documents/sifr_reports/app_state/pos_{devices,shifts,orders,refunds,voids,corrections,cash_movements,approvals,pairing_codes,audit_events}.store_id | stores.id | RESTRICT | A store with any operational trace is permanent (proven: unused stores still delete). Precondition for WS4 immutable store identity. |
| pos_{orders,refunds,voids,corrections,cash_movements}.shift_id | pos_shifts.id | RESTRICT | The till shift is the cash-ledger unit; nothing financial may float free of it. |
| pos_refund_items.order_item_id | pos_order_items.id | RESTRICT | A refund line derives from the original stored sale (WS5 rule). |
| training_results.assignment_id → training_assignments; training_progress.course_id → training_courses | — | RESTRICT | Grading history anchors to its assignment/course. |
| order_items.menu_item_id, order_item_modifiers.menu_item_id | menu_items.id | SET NULL | The line's name/price/VAT SNAPSHOT is authoritative; catalog rows are replaceable. Proven: deleting the item nulls the ref and the snapshot survives. |

## Deliberately NOT foreign keys

`*_by` display-name snapshots (approved_by, verified_by, generated_by,
last_edited_by, recorded_by, published_by, uploaded_by, pos *_by_user_id +
*_by_name pairs — id+name snapshot pattern, id validity enforced at write by
definer RPCs); polymorphic entity_id (media_references, pos_audit_events,
pos_events); external/idempotency ids (pos_events.event_id, email_log
provider/template, pos_devices.installation_id); staff_profiles.auth_id
(auth-schema boundary — GoTrue owns that lifecycle);
cv_upload_ip_log.application_id (retention-decoupled forensic log, WS9);
activity_log actor ids (audit must survive its subject);
order_items.order_id already carried its FK from the schema baseline.

## Impossible states (this round)

Enforced: non-owner ACTIVE staff without a home store; training certificate
without a passing graded result; closed till shift without closing facts;
any edit to a sealed (closed) shift — duplicate close included.
Documented for WS8/WS9 (not yet storable/enforceable): owner-without-MFA
(session property, enforced at every gate by is_owner()=role∧aal2);
payslip↔approved-hours linkage (needs approval-workflow columns);
application→active-store (stores lack a status column); invitation after
termination; orphaned storage objects / audit records (controlled-deletion
RPCs). Completed-order-with-zero-items is registered for the WS8
lifecycle round together with web-order void metadata.
