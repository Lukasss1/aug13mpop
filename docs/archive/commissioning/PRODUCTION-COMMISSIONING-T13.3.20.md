# Milk Pop T13.3.20 — Production Commissioning

> **HISTORICAL / SUPERSEDED.** This document records an earlier release and is not a current deployment instruction. Use [`../../../PRODUCTION-COMMISSIONING-T13.3.30.md`](../../../PRODUCTION-COMMISSIONING-T13.3.30.md) for production commissioning.


## Purpose

This is the only current path from the corrected source candidate to a real production launch. Do not upload the source ZIP and do not reuse an older `dist`.

The candidate is `r4.10.8-t13.3.20-final-audit`. It contains **106 ordered upgrade migrations**, **108 fresh-install SQL entries** and **17 Edge Functions**. T13.3.20 preserves the T13.3.19 release-integrity architecture and adds one small append-only final-audit migration. It makes concurrent staff-document finalisation idempotent and enforces the simple terminal rule that ended employees remain disabled until a deliberate re-hire clears `ended_at`. The source pass also standardises bounded internal Edge transport, truthful cleanup/reconciliation outcomes, reproducible release file counts and the final verification contracts.

## 1. Protected environments

Use a protected default branch and a reviewed `production` environment. Configure the browser-safe values, protected secrets and Edge Function secrets listed in `PRODUCTION-ENV-AND-FUNCTION-INVENTORY.md`. In addition to the existing provider values, configure `ABUSE_HMAC_SECRET` as a high-entropy server-only secret for keyed anonymous pseudonyms.

## 2. Production backend

Run **Commission Production Backend** from the exact reviewed default-branch HEAD.

Choose:

- `fresh` for a new empty project;
- `adopt` only for a verified pre-ledger project;
- `upgrade` for an existing ledger-bound project.

`verify-only` is not appropriate when moving from T13.3.19 to T13.3.20 because the new migration must be applied.

The workflow must:

1. apply or verify all **106** ordered upgrade migrations (**108** SQL entries on a fresh installation);
2. prove exact order, checksums and absence of unexpected live migrations;
3. execute PostgreSQL fresh-install and ordered-upgrade replay tests;
4. prove manager/owner timesheet decisions use `decide_timesheets`, factual clock columns are immutable, terminal decisions cannot be reversed and stale approve/reject races fail atomically;
5. prove `apply_collection_changes` rejects `clock_history`;
6. prove POS rate reservation, pairing-code consumption and device creation are one transaction, and verify retention of operational attempt data;
7. prove staff invitation never updates onboarding when Auth or delivery truth is unavailable;
8. prove disable/enable uses claimed recovery intents, exposes partial/reconciliation results, and cannot reactivate a profile whose employment has ended;
9. prove staff-document HTTP 400 does not remove metadata, successful deletion retains a tombstone, concurrent finalisation returns idempotent success, zero-row recovery writes are not treated as restored state, and unconfirmed upload rollback creates a cleanup job;
10. verify required Edge Function secrets and deploy all 17 functions, pruning stale remote functions;
11. commission `outbox-dispatch`, `employment-sweep`, `retention-sweep` and `ops-health-watch`, then establish fresh successful heartbeats;
12. run live owner/manager/staff RLS and two-store isolation checks;
13. test Contact, Careers and Franchise, including disabled-section behaviour, bounded requests, exact-origin CORS and Turnstile;
14. test direct e-mail reservation, provider idempotency and reconciliation outcomes;
15. keep public CV attachment disabled until its live malware/quarantine gate passes;
16. run owner-MFA media and staff-document upload/view/delete smoke tests, including an ambiguous media registration response that must be read back before any cleanup is queued;
17. retain the signed backend commissioning receipt and raw evidence.

Any migration mismatch, mutable clock fact, false-success lifecycle result, untracked storage object, failed/stale required heartbeat, provider ambiguity without reconciliation evidence or scope leak is `NO-GO`.

## 3. Real business configuration

Before frontend release, enter and independently review the legal/public contact fields, VAT state, first store, opening hours, menu, allergen process, privacy notices, owner notification recipient, staff roles and approved training/checklist content. Leave Careers, Franchise, News, CV attachment and media upload disabled until their relevant live gates pass.

Do not treat seed or preview content as business truth.

## 4. Human walkthrough

### Customer

- Home, Menu, Stores, About and Contact load from live data.
- Disabled optional programmes are absent from navigation, routes and SEO.
- Anonymous oversized or malformed requests fail quickly without growing rejection tables.
- Contact submission is exactly-once under retry.

### Owner

- MFA login and role-correct navigation.
- Invite, refresh, disable and enable show only server-confirmed outcomes.
- A provider failure does not mark an invitation sent.
- A partial account action is visibly marked for reconciliation.
- Timesheet approval/rejection changes only decision fields and refuses stale decisions.
- Staff-document deletion removes the private object, hides the live row and retains the audit tombstone.
- E-mail is not sent unless a durable `email_log` reservation exists.

### Manager and team member

- Correct store scope and no owner-only data.
- Rota, clocking, timesheets, checklists, documents, training and shift cover behave as documented.
- Managers cannot alter clock facts through approval or generic publication.

### Web Till

Complete a controlled cash sale, confirmed-card recording, failed-card path, duplicate-click protection, pairing recovery, connectivity interruption, shift close and reconciliation. Use a real external terminal for cards.

## 5. Production frontend release

Run the protected release workflow with a strictly increasing release number. It must:

1. install the committed lockfile in a clean workspace;
2. run official TypeScript, ESLint, source-contract, PostgreSQL and browser/accessibility suites;
3. verify the live backend and commissioning receipt match this source;
4. build production exactly once;
5. freeze and scan the bundle;
6. sign and verify the release set;
7. deploy the exact frozen ZIP atomically without rebuilding;
8. verify the live marker against release number, source, domain, build hash and production profile;
9. retain deployment and rollback receipts.

## GO rule

Only a green backend receipt, signed release set, deployment receipt, exact live marker and completed human walkthrough support:

`PRODUCTION GO — READY TO OPEN MILK POP`
