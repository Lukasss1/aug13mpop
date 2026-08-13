# Milk Pop T13.3.28 — Production Deployment Closure

## Scope

This is the current commissioning authority for `r4.10.15-t13.3.28-production-deployment-closure`.

T13.3.28 is a bounded deployment-reliability correction for the public website and staff/manager/owner portal. It does not activate POS/Web Till, add customer features, redesign the application, or introduce new hosting infrastructure. The source retains **17 Edge Function sources** and the public release deploys the same **14 website/staff functions**; `pos-pair`, `pos-ingest` and `pos-catalog` remain undeployed.

The database chain remains **107 ordered upgrade migrations** and **109 fresh-install SQL entries**.

## What T13.3.28 changes

The first real production commissioning attempt proved that GitHub could reach the Supabase Session Pooler and verify a new project as empty, but the base schema committed before `seed.sql` failed because `menu_items.available` was missing. T13.3.28 closes that deployment path without changing the intended business model:

- the fresh schema includes the seed-required `menu_items.available` column;
- fresh schema + production seed run as one PostgreSQL transaction;
- the exact fresh/upgrade path is rehearsed against PostgreSQL 16 before a mutating production run;
- production configuration and Edge Function secret presence are checked before database mutation;
- a first `fresh` run installs the backend and stops honestly for owner/store/MFA bootstrap instead of pretending those identities already exist;
- the live public-form, Turnstile and RLS probes follow the current privacy-notice and MFA contracts;
- deferred POS behaviour is not exercised by the public-web live RLS probe;
- the commissioning workflow is restricted to `main` and always deploys the fixed 14-function public set for mutating modes.

## 1. Before touching production

Use the protected GitHub `production` environment. For GitHub Actions, set `SUPABASE_DB_URL` to the Supabase **Session Pooler** PostgreSQL URI for the production project. The workflow never prints its credentials.

Confirm the required GitHub secrets and Supabase Edge Function secrets from `PRODUCTION-ENV-AND-FUNCTION-INVENTORY.md`. In particular, production Edge Function configuration includes `ABUSE_HMAC_SECRET`, e-mail provider settings and the SEO deploy hook. T13.3.28 keeps the existing JWT-shaped Supabase `anon` / `service_role` key contract; the workflow fails early if newer opaque `sb_publishable_*` / `sb_secret_*` keys are placed into those legacy variables.

Do not run a fresh production installation unless the workflow's local PostgreSQL 16 rehearsal is green.

## 2. One-time recovery from the failed T13.3.27 fresh attempt

Only for the known partially installed project from the failed first fresh attempt, use `ops/RECOVER-PARTIAL-FRESH-T13.3.28.sql` in the Supabase SQL Editor **after this T13.3.28 source has passed its source/CI checks**.

The recovery script is fail-closed. It refuses to clean if it sees migration history, real business rows, unexpected public tables or CV objects. It does not delete Auth users or unrelated Supabase platform data.

After recovery, verify the project is empty before running `fresh` again.

## 3. First backend installation

Open **GitHub → Actions → Commission Production Backend → Run workflow** on `main`.

Use:

- mode: `fresh`;
- the exact protected Supabase project reference;
- confirmation: `ERASE AND INSTALL <project-ref>`.

The workflow must first pass its PostgreSQL 16 rehearsal and secret/configuration checks. It then installs the real backend, applies the 107-migration ledger, deploys the 14 website/staff Edge Functions and commissions the required schedules.

A successful first installation ends with:

`BACKEND INSTALL COMPLETE — OWNER SETUP REQUIRED`

That is a successful installation handoff, **not public GO**.

## 4. One-time owner/bootstrap setup

After the successful fresh install:

1. create/link the owner Supabase Auth identity;
2. enable owner MFA;
3. create the first real store;
4. create the dedicated low-value acceptance manager/staff users required by the live RLS checks and link them to their intended stores;
5. publish the current privacy notices needed by enabled public forms;
6. set the owner-facing notification recipient and verify the already-configured Resend/e-mail provider settings. (The provider secrets themselves must already exist before `fresh`, because production preflight checks them before database mutation.)

Keep acceptance accounts separate from the personal owner account.

## 5. Full backend verification

Run **Commission Production Backend** again using `upgrade` and confirmation `APPLY MIGRATIONS <project-ref>`. With no new migration it is still safe: the ledger runner applies only genuinely new entries and then executes the live acceptance gates.

Full backend acceptance must prove, at minimum:

- exact deployed database/ledger state;
- owner and manager MFA/AAL2 behaviour;
- exact manager store isolation and staff self-only access;
- public form/privacy-notice behaviour;
- Turnstile pairing state;
- exact-origin CORS;
- direct e-mail and durable outbox delivery;
- scheduler health.

Only a full green backend commissioning receipt qualifies toward public GO.

## 6. Frontend publication

After the backend is fully verified, use the protected **GitHub → Actions → release → Run workflow**. It remains the only supported production publisher. The protected release performs the locked build, PostgreSQL/browser verification, signing, 14-function reconciliation, frozen Netlify deployment, live marker verification and receipt creation.

`npm run public:preflight` and `npm run public:seal` are local verification/artefact tools; neither is a substitute for the protected publisher. The local seal does not deploy the backend or frontend.

## 7. GO rule

Public GO requires:

- a full green backend commissioning receipt after bootstrap;
- a signed protected release set;
- exact Netlify live-marker parity;
- the customer/owner/manager/staff non-POS walkthrough in `docs/COMMISSIONING-CHECKLIST.md`.

A source ZIP, a successful `fresh` installation alone, or a Netlify build alone is not public GO.
