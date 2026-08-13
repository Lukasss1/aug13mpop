# Milk Pop T13.3.24 — Public Website Commissioning

> **HISTORICAL / SUPERSEDED.** This document records an earlier release and is not a current deployment instruction. Use [`../../../PRODUCTION-COMMISSIONING-T13.3.30.md`](../../../PRODUCTION-COMMISSIONING-T13.3.30.md) for production commissioning.


## Scope

This is the current commissioning authority for `r4.10.12-t13.3.24-public-deployment-handoff`.

The release covers:

- customer website and public forms;
- staff authentication and self-service;
- manager and owner workflows;
- storage, e-mail, audit and recovery paths;
- SEO, routing and production deployment.

POS/Web Till is deliberately deferred and hidden from staff and Admin navigation. Its source and database history are retained for later integration, but POS readiness is not a condition of this public-web release. Legal wording and business-detail completeness are owner-supplied content and are outside this code-readiness decision.

The database chain contains **107 ordered upgrade migrations** and **109 fresh-install SQL entries**. The repository retains **17 Edge Functions**, but this public-web release deploys only the **14 website/staff functions**; the three POS device functions remain undeployed until the separate POS product is commissioned.

## 1. Backend

Commission the intended Supabase project from the exact reviewed source:

- `fresh` for a new empty project;
- `upgrade` for an existing ledger-bound project;
- `adopt` only for a verified pre-ledger project.

The backend gate must prove exact migration order and hashes, RLS/role isolation, staff lifecycle truthfulness, immutable timesheet facts, storage cleanup/reconciliation, e-mail reservation, scheduled retention and all 14 public website/staff Edge Functions. POS source remains outside this release decision and is not deployed.

T13.3.24 retains the T13.3.23 route closure and T13.3.22 public-store projection and additionally proves that duplicate store names and long vacancy titles still produce unique, bounded, directly reloadable URLs. It also reconciles every current operator document to the 14-function public deployment.

T13.3.22 specifically proved that a genuine store with a real name, address and postcode can appear as `coming_soon` before POS/trading setup, while `setup_status` remains private and continues to protect trading operations.

## 2. Public website configuration

Enter real customer-facing facts before opening:

- at least one genuine store identity;
- menu items intended for customers;
- contact channel and website copy;
- optional Careers, Franchise and News switches only when those sections are actually used.

The wording and completeness of legal/business content are not assessed by this source audit. Unused optional features should remain off.

## 3. Human walkthrough

### Customer

- Home, Menu, Stores, About and Contact load from live data.
- A genuine `coming_soon` location appears without requiring POS setup.
- Placeholder stores and draft menu items do not appear.
- Disabled optional sections are absent from navigation, routes and SEO.
- Contact retry is exactly-once and failure messages are truthful.

### Staff

- Sign-in, MFA, dashboard, documents, checklists, Academy, incidents and Knowledge Base work.
- No POS/Till route or navigation item is visible.
- Store scope and private-data boundaries remain correct.

### Manager and owner

- Staff invitation/lifecycle actions display only server-confirmed outcomes.
- Rota, timesheet decisions, documents, training, messages and website publishing work.
- POS order and native-ledger sections are not routed or shown.

## 4. Frontend release

From a clean workspace, validate the reviewed source:

```bash
npm ci
npm run public:preflight
```

Then open **GitHub → Actions → release → Run workflow**. The protected workflow is the only supported production publisher. It builds once, freezes and tests the exact output, signs the release set, deploys the 14 website/staff Edge Functions, deploys the frozen Netlify ZIP without rebuilding, and verifies the live release marker against the approved domain and Supabase project.

For an advanced local artefact-only check, `npm run public:seal` may be used with the required production inputs and signing key. It does not deploy the backend or frontend.

## GO rule

Public GO requires a green backend receipt, signed release set, atomic deployment receipt, exact live marker and the non-POS human walkthrough above.
