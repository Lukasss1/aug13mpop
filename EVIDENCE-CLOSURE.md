# Milk Pop — Evidence Closure

This file explains the test enforcement added after the founder-readiness audit. It does not claim that the live tests have run for this source archive. It defines the protected paths that must produce that evidence before production acceptance.

## What changed

- One browser runner now owns the built-site suite used locally and in CI.
- Chromium, Firefox and WebKit receive the same public/staff-shell compatibility smoke.
- The browser lane now includes routing, click coverage, deployment audit, accessibility polish, real multi-tab auth behaviour and fail-closed rendering.
- Deno checks every Edge Function and shared TypeScript module with the runtime-native toolchain.
- Database backup/restore and five repeated concurrency runs are blocking CI evidence. The complete operator backup contract additionally proves that PostgreSQL and all four Storage buckets are packaged and accepted through separate restore receipts.
- Full release verification includes retention, restore and repeated concurrency stages.
- A deployed release must pass live security-header and SEO/database-parity checks before its deployment receipt is written.
- The deployment receipt records hashes of the live evidence logs.
- A protected, non-mutating owner browser smoke can verify production sign-in, TOTP, Admin access, cross-tab session hydration and cross-tab logout.
- The stateful owner/manager/staff integration journey is isolated to a separate protected staging workflow. It is not part of production commissioning.

## Required CI protection

Configure these workflow jobs as required checks for the protected release branch, together with the repository's existing security/database jobs:

- `Browser E2E (routing + click + deployment audits on the prerendered build)`
- `Database durability (backup/restore + repeated concurrency)`
- `Edge Functions (Deno-native type check)`
- the existing fresh-install, upgrade, RLS, publication, provenance and production-closure jobs in `.github/workflows/security.yml`

The release workflow assumes branch protection has already required the security workflow. A workflow file existing in the repository is not evidence until the exact commit has a successful protected run.

## Protected production browser smoke

The release workflow requires a non-mutating browser smoke before and after backend deployment and again after frontend publication. Configure these protected production-environment secrets for the real MFA-enrolled production owner identity:

```text
PRODUCTION_OWNER_EMAIL
PRODUCTION_OWNER_PASSWORD
PRODUCTION_OWNER_TOTP_SECRET
```

This step uses `MP_SITE_DOMAIN` and therefore tests the newly deployed production site. The owner must already have TOTP enrolled. The browser smoke does not edit business records; it signs in, opens Admin, proves a second tab hydrates the same session, then signs out and proves both tabs are revoked. The same owner credentials also back the provider e-mail self-test and the synthetic outbox acknowledgement, eliminating a separate privileged production test account.

These credentials are mandatory for the protected production release. There is no skip path in the current release workflow.

## Protected staging integration

Run `.github/workflows/staging-integration.yml` only against a separate staging Supabase project and dedicated test store/accounts. The workflow requires:

```text
Repository/environment variable:
MP_STAGING_SUPABASE_PROJECT_REF

Staging environment secrets:
STAGING_SUPABASE_URL
STAGING_SUPABASE_ANON_KEY
STAGING_OWNER_EMAIL
STAGING_OWNER_PASSWORD
STAGING_OWNER_TOTP_SECRET
STAGING_MANAGER_A_EMAIL
STAGING_MANAGER_A_PASSWORD
STAGING_MANAGER_A_TOTP_SECRET
STAGING_STAFF_A_EMAIL
STAGING_STAFF_A_PASSWORD
STAGING_STAFF_A_TOTP_SECRET
```

Optional second-store coverage uses:

```text
STAGING_MANAGER_B_EMAIL
STAGING_MANAGER_B_PASSWORD
STAGING_MANAGER_B_TOTP_SECRET
STAGING_STAFF_B_EMAIL
STAGING_STAFF_B_PASSWORD
STAGING_STAFF_B_TOTP_SECRET
```

The operator must confirm the exact staging project ref and type:

```text
RUN STAGING INTEGRATION
```

The journey is intentionally stateful. It verifies real Auth/AAL2, RLS, training, incident, checklist, document Storage/signed URLs, atomic menu publication and audit behaviour. Temporary deletable objects are cleaned up and cleanup failures fail the run. It also changes one dedicated staging checklist item and creates an immutable audit event, so it must not target production or a store used for real work.

## Live release evidence

Before the protected deployment receipt is written, the release workflow now requires:

- `headers-live.log` containing a passing live security-header smoke;
- `seo-live.log` proving the deployed SEO output matches live Supabase publication state;
- `auth-browser.log` containing either a passing authenticated owner smoke or an explicit protected skip marker.

The receipt hashes these logs. A missing or malformed pass/skip marker fails closed.

## Local commands

After a clean locked install:

```bash
npm run test:evidence-closure
npm run test:deno
npm run test:browser
sudo env "PATH=$PATH" npm run test:database-durability
```

The complete release verifier additionally runs the broader PostgreSQL and browser chain:

```bash
npm run verify:release
```

## Evidence still external to a source ZIP

A source archive cannot prove any of the following by itself:

- a successful `npm ci` in the protected runner;
- semantic TypeScript, ESLint and production-build success;
- real PostgreSQL fresh-install, upgrade, RLS, concurrency and restore results;
- deployed Edge Function startup and secret configuration;
- live email, Turnstile, Storage, scheduler and outbox behaviour;
- Netlify headers, SEO parity and authenticated production browser behaviour;
- human owner, manager, staff and customer walkthroughs.

Keep the source manifest, CI artifacts, backend commissioning receipt, signed release set, Netlify deploy receipt, live deployment receipt and complete backup-acceptance receipt together as the production acceptance package. See `docs/RECOVERY.md`.
## Exact Edge Function source identity

The generated release manifest and the signed release set must enumerate the
complete code-owned **17-function** source tree exactly. The 14 launch functions
and the three deferred POS functions are all part of the signed repository
identity even though POS deployment remains disabled. A release is rejected if
a function is omitted, an unknown function is substituted at the same count, a
hash is missing, or the archive directories disagree with the signed inventory.

The public deployment evidence remains a separate 14-function contract, so this
source-identity hardening does not activate POS.
