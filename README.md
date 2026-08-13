# Milk Pop — Web Platform

> **Current source candidate:** `r4.10.15-t13.3.30-final-production-closure`
> Application version `4.10.15` · 107 ordered upgrade migrations · 109 fresh-install SQL entries · 17 Edge Functions in source / 14 deployed for the public website.
> The protected GitHub Actions **release** workflow is the only supported command path that actually publishes Supabase Functions and the frozen Netlify build. Local `npm run public:preflight` checks all public production inputs but deliberately defers the CI-held private signing key check to that protected workflow.

Milk Pop combines a customer website with a small-business staff and owner portal. The public site covers the menu, stores, About and Contact; Careers, Franchise and News are optional and remain hidden until the owner enables them. The internal platform covers rota, timesheets, checklists, training, incidents, website content, menu management and messages. POS/Web Till source is retained for later integration but is hidden from this public-web release.

React 19, TypeScript, Tailwind v4 and Vite are backed by Supabase Postgres, Auth, Row Level Security, Edge Functions and private Storage.

Start here:

1. [`PUBLIC-LAUNCH.md`](PUBLIC-LAUNCH.md) — the shortest safe route to a public production release.
2. [`OPENING-START-HERE.md`](OPENING-START-HERE.md) — what can remain incomplete and what must be entered.
3. [`docs/CONTENT-SETUP.md`](docs/CONTENT-SETUP.md) — where the owner edits each business fact.
4. [`PRODUCTION-COMMISSIONING-T13.3.30.md`](PRODUCTION-COMMISSIONING-T13.3.30.md) — the only current route to production `GO`.
5. [`EVIDENCE-CLOSURE.md`](EVIDENCE-CLOSURE.md) — the enforced browser, database, Deno, staging and post-deploy proof lanes.

This is source, not a prebuilt Netlify upload. A protected workflow must build, test, seal, sign and deploy the exact reviewed source.

## Scope and honest boundaries

- Public products, prices and availability come from Supabase and fail closed; browser seed products never become production truth.
- Careers, Franchise and News are off by default and disappear from navigation, forms, routes and generated SEO until enabled.
- Blank contact, company and social information is omitted cleanly and remains editable later.
- The public-page editor changes website copy and images only. Products are managed only in **Admin → Menu**.
- POS/Web Till is intentionally deferred from this release. Its existing source and database history remain preserved for later integration, but no Till route appears in Staff or Admin navigation.
- Inventory, written performance reviews and automatic media deletion remain intentionally deferred.

## Requirements

- Node 22.23.2 is the exact production baseline across `.nvmrc`, CI and Netlify; `package.json` rejects older Node releases.
- npm 10.9.8 is the preferred release baseline; supported npm is >=10.9.8 <11, matching `package.json`.
- WSL2, macOS or Linux for release/database scripts. App development itself works on Windows, macOS or Linux.
- PostgreSQL tooling and Supabase/Netlify credentials for commissioning.

Run `npm run doctor` before release work.

## Main commands

| Command | Purpose |
|---|---|
| `npm ci` | Install the exact dependency tree from `package-lock.json`. |
| `npm run dev` | Start the local development server. |
| `npm run typecheck` | Typecheck the app and all Edge Functions. |
| `npm run lint` | Run the warning-ratchet ESLint gate. |
| `npm run build` | Validate deployment configuration, build `dist/`, and generate static SEO pages. |
| `npm run verify` | Run the complete source, database-contract, security and build verification chain. |
| `npm run test:smallbiz-usability` | Small-business and deep-opening regression suites. |
| `npm run test:browser` | Provision Chromium, Firefox and WebKit and run the complete built-site browser suite. |
| `npm run test:rls-local` | Execute cross-role RLS checks on local PostgreSQL. |
| `npm run test:baseline` | Exercise fresh schema plus the authoritative ordered migration chain. |
| `npm run verify:bundle` | Build and scan the bundle for secret material. |
| `bash launch/launch.sh` | Interactive fail-fast commissioning driver. |

The migration order lives only in `launch/migration-manifest.sh`; documentation deliberately does not maintain a second list.

## Environment

Copy `.env.example` to a private `.env`. Production requires the browser-safe Supabase pair:

```text
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
```

For T13.3.30, `VITE_SUPABASE_ANON_KEY` is the project's legacy JWT-shaped `anon` key (from Supabase's Legacy API Keys section), not an `sb_publishable_*` key. This bounded release keeps the existing Bearer/JWT call contract; migration to Supabase's newer opaque key model is intentionally separate. Only the anon key belongs in browser configuration. Service-role, provider, signing and deployment credentials must remain protected server/CI secrets. Production builds set `VITE_DEPLOYMENT_MODE=production`; optional features remain off until their live gates pass.

`VITE_DEV_SEED_CONTENT=true` is a local-development convenience only. The code additionally requires Vite development mode, so the branch cannot activate in a production build.

## Project layout

```text
src/                  React application and typed clients
public/               static brand assets, redirects and security headers
supabase/             fresh schema, ordered migrations, seeds and Edge Functions
scripts/              verification, commissioning and release tooling
launch/               authoritative migration ledger and launch driver
docs/                 current operating, hosting, scope and compatibility notes
```

The documentation index is [`docs/README.md`](docs/README.md). Production operators should still begin with [`OPENING-START-HERE.md`](OPENING-START-HERE.md).

The repository retains **17 source-controlled Edge Functions**, while the public-web workflow deploys and verifies only the **14 website/staff functions**. The three POS functions are activated later through `launch/deploy-pos-functions.sh`. `_shared` is imported source, not an independently deployed function.

## Security model

- Supabase Auth is the identity source; roles and stores are read from protected staff profiles.
- RLS is deny-by-default and role/store scoped. Sensitive manager actions require MFA where defined.
- Anonymous form tables have no direct browser insert path. `supabase/migration_phase_b_public_forms.sql` revokes direct inserts; submissions go through the guarded `public-form` Edge Function.
- Turnstile, rate limiting, idempotency and versioned privacy-notice evidence protect public forms.
- Owner-editable URLs cross context-specific HTTPS, telephone, e-mail or same-site policy-link validators before becoming anchors.
- E-mail recipients and templates are resolved server-side; the browser cannot supply arbitrary HTML or recipient addresses. Turnstile and Resend calls are bounded through response-body completion, and durable outbox retries use a stable provider idempotency key.
- Staff documents and media use private Storage and short-lived signed access after server-side scope checks.
- Financial and POS records use server-owned append-only or transactional flows; the website does not directly mutate settlement truth.
- Public data has runtime validation and a build-bound, hash-verified last-known-good snapshot; private operational data continues to fail closed.
- Security headers are defined in `public/_headers`; staff/admin routes are `noindex` by header and runtime meta.
- The release is bound to source, migration and build hashes and protected by a signed release set and rollback floor.

## Production route

Do not upload this ZIP directly to Netlify and do not reuse an older `dist`.

Follow [`PRODUCTION-COMMISSIONING-T13.3.30.md`](PRODUCTION-COMMISSIONING-T13.3.30.md). Production `GO` requires, at minimum:

- clean locked dependency installation;
- official app typecheck, lint, build and browser/accessibility gates;
- PostgreSQL fresh/upgrade/RLS/concurrency/restore gates;
- one accepted recovery package covering both the database and all four application Storage buckets;
- exact live migration and all **14** public website/staff Edge Functions, with the three POS functions absent;
- four healthy Vault-backed schedules;
- real forms, Turnstile, CORS, e-mail/outbox and media checks;
- one signed frozen build, verified-package Netlify draft/promotion and live-marker parity;
- customer, owner, manager and staff walkthroughs.

Recovery tooling and acceptance are documented in [`docs/RECOVERY.md`](docs/RECOVERY.md). Current evidence is summarised in [`CURRENT-RELEASE-EVIDENCE.md`](CURRENT-RELEASE-EVIDENCE.md). The audited StaffPortal ownership, state-lifetime policy, honest root-versus-total metrics and intentional stopping point are documented in [`STAFF-PORTAL-OPTIMIZATION.md`](STAFF-PORTAL-OPTIMIZATION.md).
