# Milk Pop T13.3.26 — Public Website Commissioning

> **HISTORICAL / SUPERSEDED.** This document records an earlier release and is not a current deployment instruction. Use [`../../../PRODUCTION-COMMISSIONING-T13.3.30.md`](../../../PRODUCTION-COMMISSIONING-T13.3.30.md) for production commissioning.


## Scope

This is the current commissioning authority for `r4.10.14-t13.3.26-local-preflight-config`.

It covers the customer website, public forms, staff authentication and self-service, manager/owner workflows, storage, e-mail, audit, recovery, routing, SEO and production deployment. POS/Web Till is retained for later but hidden and undeployed. Legal wording and owner-supplied business facts are outside this code-readiness decision.

The database chain contains **107 ordered upgrade migrations** and **109 fresh-install SQL entries**. The repository retains **17 Edge Function sources**; the public release deploys the **14 website/staff functions** only.

## 1. Backend commissioning

Run the protected `commission-production-backend` workflow against the intended Supabase project. Use `fresh` for a new empty project, `upgrade` for a ledger-bound project, and `adopt` only for a verified pre-ledger project. Keep the commissioning receipt.

## 2. Local non-secret production check

Populate `ops/milkpop-trust-policy.json` with the approved domain, project reference and public Ed25519 key. Then:

```bash
cp ops/public-preflight.env.example .env.production.local
# Fill only public values and non-secret commissioning attestations.
npm ci
npm run public:preflight
```

The local wrapper loads `.env.production.local` and derives:

- the source-owned release identity;
- the approved domain and Supabase project from the trust policy;
- `VITE_SUPABASE_URL` from the project reference;
- `SITE_URL` from the approved domain;
- the current evidence and trust-policy paths.

It does **not** request or simulate the CI-owned release number, Git commit or private signing key. Those checks remain mandatory in the protected `release` workflow. Supplying `MP_SIGNING_KEY` locally—through dotenv or the shell—is explicitly refused.

## 3. Protected publication

Open **GitHub → Actions → release → Run workflow**. This is the only supported production publisher. The protected workflow performs the clean locked install, PostgreSQL verification, production build, signing-key match, release sealing, 14-function deployment, frozen Netlify ZIP deployment, live-marker verification and receipt creation.

`npm run public:seal` is an advanced local artefact-only check. It does not deploy the backend or frontend.

## 4. Human walkthrough

### Customer

- Home, Menu, Stores, About and Contact load from live data.
- A genuine `coming_soon` location appears without POS setup.
- Duplicate store names and long vacancy titles have distinct, reloadable URLs.
- Placeholder stores and draft content remain hidden.
- Contact retries remain exactly-once and failure messages are truthful.

### Staff

- Sign-in, MFA, dashboard, documents, checklists, Academy, incidents and Knowledge Base work.
- No POS/Till route or navigation item is visible.

### Manager and owner

- Staff lifecycle actions display server-confirmed outcomes.
- Rota, timesheet decisions, documents, training, messages and website publishing work.
- POS order/native-ledger sections remain absent.

## GO rule

Public GO requires a green backend receipt, signed release set, atomic deployment receipt, exact live marker and the non-POS walkthrough above.
