# Milk Pop T13.3.29 — Protected Deployment Closure

## Scope

This is the current commissioning authority for `r4.10.15-t13.3.29-protected-deployment-closure`.

T13.3.29 is a bounded deployment/recovery hardening release for the public website and staff/manager/owner portal. It does **not** redesign the application, activate POS/Web Till, add stores or users, or introduce another hosting platform. The source retains **17 Edge Function sources**; public launch deploys exactly **14 website/staff functions**. `pos-pair`, `pos-ingest` and `pos-catalog` remain deferred.

The database authority remains **107 ordered upgrade migrations** plus the fresh schema and production seed (**109 fresh-install SQL entries**).

## What T13.3.29 closes

T13.3.29 keeps the T13.3.28 database correction and closes the remaining first-production deployment contradictions:

- Netlify draft publication uses the documented file-digest deploy flow instead of an invented base64-in-JSON ZIP request;
- the missing first-release marker has an exact 404 rule before the SPA fallback, while a real marker file still wins by normal file shadowing;
- Netlify receives `dist/` extracted from the **verified signed release package**, not a later mutable workspace copy;
- every protected production release input is checked before mutation/publication begins;
- a destructive `fresh` install requires an exact Direct/Session-Pooler project binding and proves no public application objects, Auth users, Storage buckets or Storage objects exist;
- fresh schema + production seed + the empty migration ledger commit in one transaction;
- a guarded `resume` lane can continue only a bootstrap-pending first installation that has no real Auth/business/form/Storage-object data;
- production RLS smoke supports the real one-store launch topology; exhaustive two-store adversarial tests remain in the non-production test suite;
- `request-seo-rebuild` records that static SEO refresh is pending for the next protected release and **never publishes Netlify directly**;
- a partial 14-function deployment emits an explicit mixed-version recovery instruction;
- Netlify rollback is labelled honestly as **frontend-only** unless the backend functions are separately restored.

## 1. Before touching production

Use only the protected GitHub `production` environment and the `main` branch.

For GitHub Actions, `SUPABASE_DB_URL` should use the Supabase **Session Pooler** on port `5432` unless the runner genuinely has compatible Direct connectivity. The database target validator binds the URL to the exact protected project reference and rejects transaction-pooler port `6543` for this session/lock-sensitive commissioning path.

Confirm the full inventory in [`PRODUCTION-ENV-AND-FUNCTION-INVENTORY.md`](../../../PRODUCTION-ENV-AND-FUNCTION-INVENTORY.md). T13.3.29 intentionally keeps the existing legacy JWT-shaped Supabase `anon` / `service_role` key contract for this launch closure. Do not put `sb_publishable_*` / `sb_secret_*` values into those legacy variables; migrate the key model separately after stable production.

Do **not** run production recovery SQL, `fresh`, or `resume` until the protected workflow's PostgreSQL 16 rehearsal and source-manifest check are green.

## 2. Recover the known partial first-install incident once

The failed T13.3.27/T13.3.28-era first attempt committed a fresh schema and then stopped in `seed.sql`. For that **known project only**, use:

`ops/RECOVER-PARTIAL-FRESH-T13.3.28.sql`

from the Supabase SQL Editor after this T13.3.29 source passes protected CI.

The recovery is fail-closed and must refuse unexpected migration history, real business rows, unexpected public objects or CV objects. Do not weaken its guards to make it pass.

After it succeeds, run `fresh` once. Never keep rerunning `fresh` after a baseline has committed.

## 3. First backend installation

Open **GitHub → Actions → Commission Production Backend → Run workflow** on `main`.

Use:

- `database_mode`: `fresh`
- exact production project ref
- confirmation: `ERASE AND INSTALL <project-ref>`

The workflow must pass source identity, PostgreSQL 16 rehearsal, protected-secret inventory and exact target checks **before** database mutation. It then installs the database, applies the 107-migration ledger, deploys the 14 public website/staff Edge Functions and commissions schedules.

A successful first installation ends with:

`BACKEND INSTALL COMPLETE — OWNER SETUP REQUIRED`

That is a successful installation handoff, not public GO.

### Interrupted first install

If the baseline/ledger committed but the first installation stopped **before owner/bootstrap data existed**, use:

- `database_mode`: `resume`
- confirmation: `RESUME INSTALL <project-ref>`

`resume` applies only the unrecorded migration suffix. It refuses to run once Auth users, real business/staff/form data, Storage objects or unrelated buckets exist. If that guard refuses the target, stop and diagnose; do not bypass it.

## 4. One-time real bootstrap

After a successful `fresh`/`resume` handoff:

1. Create the real owner Supabase Auth user and link the owner staff profile using the repository's documented bootstrap function.
2. Enrol and prove owner MFA/AAL2.
3. Create the first **real** Milk Pop store.
4. Create one dedicated low-value `team_member`/`supervisor` acceptance user in that real first store for production self-scope checks. Do **not** create a fake second store merely for production CI.
5. Publish the current privacy-notice versions for every public form you intend to enable.
6. Set the monitored notification recipient.
7. Confirm Resend/e-mail sender configuration and keep the dedicated email acceptance account available.

### Hosted Supabase Auth settings

Before staff use the portal, verify in the Supabase dashboard:

- unrestricted public sign-up is disabled unless intentionally required;
- the production **Site URL** is exact;
- production Redirect URLs are exact and minimal (avoid broad production wildcards);
- email-confirmation behaviour is intentional;
- owner MFA is enrolled and working;
- custom SMTP is configured if production invitations/password resets are expected to deliver reliably.

These are hosted-platform settings and are not created by SQL migrations.

## 5. Full backend verification after bootstrap

Run **Commission Production Backend** again with:

- `database_mode`: `upgrade`
- confirmation: `APPLY MIGRATIONS <project-ref>`

With no new migrations, the ledger runner applies nothing and continues to live acceptance.

A full green backend receipt must prove at least:

- exact database/ledger state;
- owner MFA/AAL2 and owner access;
- low-role staff self-only restrictions in the real first store;
- anonymous denial of private data;
- current privacy-notice public-form behaviour;
- Turnstile pairing state;
- exact-origin CORS;
- direct email and durable outbox delivery;
- scheduler health.

The exhaustive Store A/Store B adversarial RLS matrix remains mandatory in PostgreSQL/staging tests, but it does not require fake second-store data in production.

## 6. Domain commissioning — one coordinated change

Bootstrap may use the Netlify `.netlify.app` hostname. Before the real public release, change the production origin as one controlled operation so these agree:

- Netlify custom domain / DNS / TLS;
- `MP_SITE_DOMAIN`;
- `SITE_URL`;
- `FORM_ALLOWED_ORIGINS`, `CV_ALLOWED_ORIGINS`, `EMAIL_ALLOWED_ORIGINS`;
- Supabase Auth Site URL and Redirect URLs;
- SEO canonical origin;
- production trust policy approved domain.

Do not switch only half of this set.

## 7. Static SEO refresh policy

Publishing menu/news/store/vacancy content writes the valid database change immediately. The owner SEO action records `SEO_REFRESH_PROTECTED_RELEASE`; it does **not** call a hosting build hook and cannot publish production.

Static crawler pages (`sitemap.xml`, JSON-LD, pre-rendered pages and `seo-manifest.json`) refresh with the next protected signed release. This is intentional for v0.1: there is one production publisher and no unsigned SEO side-channel.

## 8. Protected frontend publication

`npm run public:seal` is a local artefact/cryptographic check only; it does not deploy the backend or frontend. `npm run public:release` provides protected-workflow guidance rather than publishing locally.

After backend verification, use **GitHub → Actions → release → Run workflow**. It is the only supported production publisher.

The release must:

1. validate every protected input before mutation;
2. run the locked build/test/database/browser gates;
3. seal and sign the release set;
4. verify the signed package;
5. extract the deployable `dist/` from that verified package;
6. reconcile the 14 public website/staff Edge Functions;
7. create a Netlify **draft** from the verified files using the file-digest API;
8. test the draft;
9. promote that exact deploy;
10. verify the live marker and acceptance gates;
11. write the deployment receipt.

A first release may legitimately have no previous MilkPop marker. Subsequent releases must satisfy the live anti-rollback floor.

### Netlify continuous deployment

Once this protected publisher is proven and before treating it as the production authority, stop normal Netlify Git-triggered builds/production publication. Manual API deploys from the protected release remain the intended publishing path. Do not keep two independent production publishers.

## 9. Failure and rollback truth

If sequential Edge Function deployment stops part-way, production may contain a mixed 14-function set. Recover by redeploying **all 14** from either the exact current candidate or one previous trusted signed release; do not repair individual functions ad hoc.

If a post-publication live check restores the previous Netlify deploy, that is **frontend rollback only**. Newly deployed Supabase functions remain new until the explicit 14-function recovery step is run. The receipt/log must state that truth.

## 10. GO rule

Public GO requires all of:

- exact source/manifest parity;
- successful PostgreSQL 16 rehearsal;
- full green post-bootstrap backend commissioning receipt;
- production Auth/domain configuration checked;
- production trust policy/signing key configured;
- complete locked build/browser/database/security verification;
- signed release set;
- Netlify draft acceptance and exact live-marker parity;
- customer + owner + manager/staff non-POS walkthrough;
- continuous publishing controlled so the protected release is the production authority.

A source ZIP, successful `fresh`, successful Netlify build, or green local source tests alone are not public GO.
