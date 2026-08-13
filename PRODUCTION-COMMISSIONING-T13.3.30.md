# Milk Pop T13.3.30 — Final Production Closure

## Scope

This is the only current commissioning authority for `r4.10.15-t13.3.30-final-production-closure`.

T13.3.30 is a bounded release/recovery closure for the public website and the staff/manager/owner portal. It does **not** redesign the product, activate POS/Web Till, enable CV uploads, add stores/users, change the Supabase key model, or introduce a new hosting platform.

The frozen v0.1 topology is:

- database: **107 ordered upgrade migrations / 109 fresh-install SQL entries**;
- Edge Function source: **17** directories;
- production public/staff Edge Functions: **14**;
- deferred POS functions: **3** (`pos-pair`, `pos-ingest`, `pos-catalog`).

## What T13.3.30 closes

T13.3.30 reconciles the divergent T13.3.29 hardening work into one production authority:

- exact-incident, fail-closed recovery for the known failed first `fresh` installation;
- protected `recover-known-partial` GitHub mode, so normal recovery does not require SQL copy/paste;
- one shared production-input validation rule set;
- one verified signed-`dist` materialiser;
- one code-owned 14/3 Edge Function inventory;
- a signed `public_function_set_sha256` binding the complete public/staff backend to each release;
- unchanged frontend releases skip Supabase function mutation entirely;
- changed backend releases deploy the complete 14-function set and can restore the exact trusted predecessor set;
- the first-release marker exception can authorize **release 1 only**;
- production release starts only through the protected manual GitHub `release` workflow.

## 1. Production inputs and target binding

Use only the protected GitHub `production` environment and reviewed `main`.

`SUPABASE_DB_URL` must resolve to the approved Supabase project through a supported Direct or Session Pooler connection on port `5432`. Transaction-pooler port `6543` is refused for commissioning.

T13.3.30 intentionally retains the existing legacy JWT-shaped Supabase `anon` / `service_role` variables. Do not substitute `sb_publishable_*` / `sb_secret_*` values during this closure.

The committed trust policy contains only public trust information. `MP_SIGNING_KEY` remains a protected GitHub secret.

## 2. Recover the known partial first-install incident

The real first commissioning attempt proved the project empty, completed the fresh schema, inserted the first `site_settings` seed row, then stopped when `seed.sql` referenced the missing `menu_items.available` column. The project must be repaired only if it still matches that exact incident fingerprint.

Open **GitHub → Actions → Commission Production Backend → Run workflow** on `main` and use:

- `database_mode`: `recover-known-partial`
- exact production project ref
- confirmation: `RECOVER KNOWN PARTIAL <project-ref>`

Before mutation the workflow runs the protected source/configuration gates and PostgreSQL 17 rehearsal. Because this mode is database-only and never deploys/invokes Edge Functions, it requires only the exact project-bound `SUPABASE_URL` / `SUPABASE_DB_URL` connection inputs and deliberately skips the unrelated Resend/Turnstile/CORS Edge Function secret inventory. The recovery then requires the exact known MilkPop public object set, exact untouched seed state, zero Auth users, zero Storage objects and the exact private empty `cvs` bucket state. One non-MilkPop exception is permitted only when it exactly matches Supabase's documented `public.rls_auto_enable()` + enabled `ensure_rls` event-trigger safety pair; that pair is preserved. Any same-name drift or any other extra application state refuses recovery.

A successful recovery ends at:

`KNOWN PARTIAL RECOVERY COMPLETE — RUN FRESH`

Recovery is terminal. It does **not** deploy functions, start schedulers, create users or continue automatically into `fresh`.

Do not weaken the recovery guards if they refuse the real project. Diagnose the mismatch instead.

## 3. First backend installation

Run **Commission Production Backend** again with:

- `database_mode`: `fresh`
- confirmation: `ERASE AND INSTALL <project-ref>`

The workflow must install the exact npm lock (`npm ci`), pass the complete `npm run verify` chain, prove source identity, complete the PostgreSQL 17 rehearsal, validate protected inputs and bind the exact project before database mutation. Fresh schema + production seed + empty migration ledger commit atomically; the 107 ordered migrations are then reconciled.

A successful first install ends at:

`BACKEND INSTALL COMPLETE — OWNER SETUP REQUIRED`

That is a successful infrastructure handoff, not public GO.

### Interrupted bootstrap-pending install

Use `resume` only when the atomic baseline/ledger committed but owner/business bootstrap has not begun:

- `database_mode`: `resume`
- confirmation: `RESUME INSTALL <project-ref>`

`resume` refuses Auth users, real business/form data, Storage objects or unrelated buckets.

## 4. One-time real bootstrap

After the successful first-install handoff, bootstrap the real owner through the supported one-time path. Do **not** invent an owner row manually and do not edit `staff_profiles.auth_id` directly.

1. In the Supabase SQL Editor, run the privileged first-owner helper **once** with the exact production owner e-mail and name:

   ```sql
   select public.bootstrap_owner('OWNER_EMAIL_HERE', 'OWNER_NAME_HERE');
   ```

   The helper refuses if any owner already exists and is not executable by `anon` or `authenticated`. Keep the function in the schema after use; do not manually drop migration-owned objects.

2. Confirm there is exactly one owner profile and that it is not yet linked to Auth:

   ```sql
   select id, name, email, role, auth_id, status
   from public.staff_profiles
   where role = 'owner';
   ```

   The e-mail must exactly match the Auth account you create next.

3. **Before sending any invitation**, configure the hosted Supabase Auth settings for production: Site URL `https://milkpop.uk`; exact Redirect URLs `https://milkpop.uk/staff` (staff invitation) **and** `https://milkpop.uk/staff/` (password-recovery landing); intentional public-sign-up/e-mail-confirmation policy; and production SMTP/delivery if invitations or password recovery depend on it. Do not add an unnecessary broad wildcard.

4. In **Supabase → Authentication → Users**, invite/create the owner using exactly the same e-mail as the owner profile. Never insert rows directly into `auth.users`.

5. Complete the invitation/password flow, then sign in through the Milk Pop staff portal. On the first login the client automatically attempts the protected `link_staff_profile()` RPC if no profile is linked; that RPC can claim only the unclaimed profile whose e-mail matches the verified JWT e-mail. Do not manually write `auth_id` unless diagnosing a failed bootstrap.

6. Because `owner` is MFA-required, the portal must stop at TOTP enrolment before owner access is granted. Select **Begin set-up**, scan the QR (or copy the manual Base32 setup key), enter the first six-digit code and complete enrolment. Preserve that exact Base32 setup key securely: after verification it becomes the protected GitHub `PRODUCTION_OWNER_TOTP_SECRET` used only by the production AAL2 smoke test.

7. After AAL2 owner access succeeds, create the first **real** Milk Pop store through **Admin → Operations → Store Locations** using real opening information only. Do not create a fake second store.

8. From **Operations → Staff Directory**, create one low-role (`team_member` or `supervisor`) production acceptance profile in that real first store, then use the Milk Pop **Invite** action on that profile. The `staff-invite` Edge Function generates the Auth invite for the profile's exact e-mail and sends the invitation through the configured provider; its redirect is `${SITE_URL}/staff`. The user's first sign-in uses the same automatic `link_staff_profile()` claim path. Store that account as `PROBE_USER_EMAIL` / `PROBE_USER_PASSWORD`; it exists only to prove low-role privacy and non-escalation boundaries.

9. Publish the privacy-notice versions required by enabled public forms and confirm the monitored notification recipient / production e-mail sender are configured.

10. Add the resulting owner/probe credentials to the protected GitHub `production` environment, then run `upgrade` for full live acceptance.

## 5. Full backend acceptance

Run **Commission Production Backend** with:

- `database_mode`: `upgrade`
- confirmation: `APPLY MIGRATIONS <project-ref>`

A full green receipt must prove database/ledger parity, owner AAL2, low-role self-scope, anonymous private-data denial, forms/privacy, Turnstile, exact-origin CORS, direct e-mail, durable outbox delivery and scheduler health.

Before `upgrade` can mutate production, the protected validator also requires the production hostname, FORM/CV/e-mail origin attestations, monitored notification recipient, coherent Turnstile server/secret/site-key state and any enabled Media v2 backend readiness. Missing live-acceptance configuration therefore fails before migrations/functions/schedulers are touched.

The exhaustive two-store adversarial RLS matrix remains a non-production PostgreSQL/staging test. Production uses the real one-store topology.

## 6. Domain and trust configuration

Before public release, align as one change:

- Netlify custom domain / DNS / TLS;
- `MP_SITE_DOMAIN` and `SITE_URL`;
- form/CV/e-mail allowed origins;
- Supabase Auth Site URL and Redirect URLs;
- SEO canonical origin;
- `ops/milkpop-trust-policy.json` approved domain/project/public signing key.

Do not half-switch the origin set.

## 7. Protected production release

Production release has one human initiation path. **Before the final source is pushed to the branch Netlify treats as production, lock the currently published Netlify deploy / stop auto publishing.** Keep Netlify's **Enforce Git-based deployments** setting off, because the protected Milk Pop publisher uses the Netlify API. The protected GitHub release workflow is the **only supported production publisher**:

**GitHub → Actions → release → Run workflow**

Supply the monotonic positive `release_number`. Release 1 is the only release allowed to use the explicit no-marker first-deploy exception.
Before starting release 1, prove `https://milkpop.uk/.well-known/milkpop-release.json` is directly reachable over HTTPS and returns exact HTTP `404` without redirecting. The first-release exception does not accept DNS/TLS errors, redirects, `200` SPA fallbacks or any other status.

The workflow must:

1. validate protected production inputs;
2. run the locked source/build/database/browser gates;
3. create one production build;
4. seal/sign and independently verify the release set;
5. materialise `dist/` only from the verified signed package;
6. recheck the live rollback floor and predecessor identity;
7. compare the signed `public_function_set_sha256` with the live marker;
8. **skip Edge Function deployment when unchanged**;
9. otherwise deploy the complete code-owned 14-function set;
10. run backend acceptance;
11. create and verify a non-live Netlify draft;
12. promote that exact draft;
13. verify the exact live marker, headers, SEO and owner MFA in Chromium/WebKit;
14. write the final deployment receipt.

`npm run public:seal` is artefact-only: it **does not deploy the backend or frontend**.

Normal Netlify Git-triggered **production** auto-publishing must already be disabled before the final production-branch push and must remain disabled afterwards so there is one production authority. Preview deploys may remain separate. Do not enable Netlify's Git-only deployment enforcement; Milk Pop's protected publisher intentionally uses the Netlify API.

## 8. Backend rollback truth

Supabase multi-function deployment is treated as recoverable, not falsely atomic.

If a changed 14-function deployment fails part-way and a previous trusted MilkPop release exists, the workflow restores **all 14 predecessor functions** from the exact predecessor Git commit. The reconstructed predecessor source must hash to the `live_public_function_set_sha256` recorded by the live marker before any restore mutation is allowed.

If backend proof fails after all changed functions deployed but before frontend publication, restore the predecessor 14-function set and do not promote the draft.

If post-publication proof fails and a predecessor exists, restore the previous Netlify deploy and restore the predecessor backend when this release changed it. If the backend fingerprint was unchanged, only frontend rollback is required.

On the first-ever release there is no trusted predecessor to restore. Failure is recorded honestly and must be corrected before another controlled release attempt.

Database migrations are **not** automatically rolled backwards by frontend/function rollback.

## 9. Static SEO policy

`request-seo-rebuild` records that static SEO refresh is pending for the next protected release. It never publishes Netlify directly. Database content can become live immediately; crawler artefacts refresh through the protected release path.

## 10. GO rule

Production GO requires all of:

- exact T13.3.30 source/manifest parity;
- full locked CI verification on the repository-owned Node/npm toolchain;
- PostgreSQL 17 fresh/upgrade/recovery/RLS proof;
- successful real partial-project recovery and `fresh` installation;
- completed real owner/store/MFA bootstrap;
- full green post-bootstrap backend receipt;
- final Auth/domain/trust configuration;
- signed release verification;
- exact Netlify draft/live proof;
- live customer + owner + manager/staff non-POS walkthrough;
- one protected production publisher.

A source ZIP, local green tests, successful recovery, successful `fresh`, or a Netlify build alone is not production GO.
