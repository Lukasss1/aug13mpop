# Milk Pop T13.3.12 — Production Commissioning

> **HISTORICAL / SUPERSEDED.** This document records an earlier release and is not a current deployment instruction. Use [`../../../PRODUCTION-COMMISSIONING-T13.3.30.md`](../../../PRODUCTION-COMMISSIONING-T13.3.30.md) for production commissioning.


## Purpose

This is the required path from the audited deep-opening source candidate to a real launch. Do not upload the source ZIP or reuse an older `dist`.

## 1. Protected environments

Use a protected GitHub default branch and a `production` environment with required reviewers. Configure the variables and secrets listed in `PRODUCTION-ENV-AND-FUNCTION-INVENTORY.md`. Protect release tags and the rollback counter.

## 2. Production backend

Run **Commission Production Backend** from the exact reviewed default-branch HEAD.

Choose the correct database mode:

- `fresh` for a new empty project;
- `adopt` only for a verified pre-ledger project;
- `upgrade` for an existing ledger-bound project;
- `verify-only` when no database change is required.

The workflow must:

1. apply or verify all **103** ordered upgrade migrations (**105** SQL entries on a fresh installation);
2. prove exact order, checksum and absence of unexpected live migrations;
3. verify required Edge Function secrets and forbidden unsafe feature secrets;
4. deploy and inventory all 17 source-controlled Edge Functions, pruning stale remote functions;
5. commission four Vault-backed schedules:
   - `outbox-dispatch` every five minutes;
   - `employment-sweep` daily;
   - `retention-sweep` daily;
   - `ops-health-watch` hourly;
6. establish fresh successful heartbeats and prove failed/stale/recovery alert transitions;
7. run live owner/manager/staff RLS and two-store isolation checks;
8. test Contact, Careers and Franchise, including disabled-section behaviour;
9. test Turnstile, exact-origin CORS and direct provider-backed email;
10. deliver a synthetic notification through the durable outbox and retain its provider message ID;
11. prove the CV endpoint remains server-disabled;
12. perform the owner-MFA media upload → attach → database/storage verification → cleanup smoke;
13. create and retain the signed backend commissioning receipt and raw evidence.

Any migration mismatch, failed/stale required heartbeat, failed provider test or scope leak is `NO-GO`.

## 3. Real business configuration

Before frontend release, enter and independently review:

- legal name, company number where applicable, address, public email, privacy email, phone and canonical domain;
- VAT state (`NOT_REGISTERED`, 0% and no VAT number at launch unless the real tax position changed);
- first store, timezone, address and opening hours;
- real menu names, prices, availability, images and tags;
- real allergen procedure and supplier/recipe evidence;
- current Contact privacy notice;
- Careers, Franchise and News visibility switches — leave unused programmes off; verify disabled sections are also absent from the sitemap and static SEO output;
- Careers and Franchise privacy notices before enabling either form;
- owner notification recipients;
- approved checklist, Academy and Knowledge Base material.

Do not treat seed or preview content as business truth.

## 4. Small-business usability walkthrough

### Customer

- Home, Menu, Stores, About and Contact load from live data.
- Disabled Careers, Franchise and News links are absent and direct routes do not expose their forms.
- Menu outage uses the build-bound, hash-verified last-known-good production snapshot or an honest unavailable state.
- Mobile form text is readable and all primary touch targets are at least 44px.
- Contact submission retains fields on failure and succeeds exactly once on retry.

### Owner

- MFA login.
- Public-page editing can change website copy/images but cannot replace or delete catalogue rows.
- Admin → Menu is the only product-management path; test one visible and one hidden/unavailable product and confirm the hidden product survives publication.
- Website visibility toggles persist and immediately control public navigation/routes.
- Contact Inbox moves messages through New → Replied → Closed → Reopened; the dashboard badge counts New only.
- Reply and holiday dialogs preserve entered values after a simulated failure.
- Everyday, Operations and Advanced navigation groups remain usable on phone/tablet/desktop.
- Operational health shows four fresh workers and sends one deduplicated failure/recovery notification.

### Manager and team member

- Correct store scope and no owner-only data.
- Knowledge Base dashboard links open the real `staff_kb` route.
- Rota, timesheets, clocking, checklists, documents, training, shift cover and honest earnings behave as documented.

### Second store

Prove independent manager/staff scope, shifts, checklists, cover requests and inbox/operational data. No Store A data may be writable or readable from Store B credentials.

## 5. Web Till

Use a real external terminal for cards. Complete one controlled commissioning cash sale, one confirmed-card recording, a failed-card path, duplicate-click protection, connectivity interruption, shift close and reconciliation. Do not delete completed financial history.

## 6. Production frontend release

Run the protected **release** workflow with a strictly increasing integer release number. It must:

1. install locked dependencies from a clean workspace;
2. run official typecheck, lint ratchet, full verification and Playwright/browser accessibility suites;
3. provision PostgreSQL and run fresh, upgrade, RLS, concurrency and restore gates;
4. verify the live backend exactly matches this source and its commissioning receipt;
5. build production exactly once from the reviewed commit;
6. scan the frozen bundle for secrets and production-contract violations;
7. sign and verify the release set against the protected trust policy;
8. deploy the exact frozen ZIP atomically to Netlify without rebuilding;
9. verify the live marker matches release number, commit, domain, build hash and production profile;
10. retain the deployment receipt and all bound evidence.

## GO rule

Only a green backend receipt, signed release set, deployment receipt, exact live marker and completed human walkthrough support:

`PRODUCTION GO — READY TO OPEN MILK POP`
