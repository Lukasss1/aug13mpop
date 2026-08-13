# Milk Pop T13.3.30 — Current Release Evidence

**Status: SOURCE CANDIDATE — PROTECTED CLOUD PROOF REQUIRED.**  
**PRODUCTION BUILD AND LIVE COMMISSIONING REQUIRED.**

This file contains only the current T13.3.30 evidence. Historical release reports remain under `docs/releases/` and historical commissioning authorities under `docs/archive/commissioning/`.

## Candidate identity

- Release identity: `r4.10.15-t13.3.30-final-production-closure`
- Application version: `4.10.15`
- Production site domain pinned by trust policy: `milkpop.uk`
- Production Supabase project ref pinned by trust policy: `upvbfscpfpkwiuuaplhu`
- Upgrade migration chain: **107 ordered upgrade migrations**
- Fresh-install SQL ledger: **109 entries** (fresh schema + production seed + 107 ordered migrations)
- Edge Function source inventory: **17**
- Public/staff production inventory: **14**
- Deferred POS inventory: **3** — `pos-pair`, `pos-ingest`, `pos-catalog`
- Current public/staff backend fingerprint: `fe23bb678a3aa1c0c920a22db1c845112747fd03068841668aba8558788edae5`

The canonical source-tree SHA-256 and canonical source-file count are recorded in `release-manifest.json`. The ZIP SHA-256 is intentionally detached because an archive cannot truthfully contain its own final archive hash.

## P0 scope implemented

T13.3.30 is a bounded final production-closure patch. It changes release/recovery mechanics, not Milk Pop product behaviour.

Implemented P0 closure:

- exact-incident, transactional recovery for the known T13.3.28 partial first-install state;
- protected GitHub `recover-known-partial` mode; no normal SQL copy/paste recovery procedure;
- shared semantic production-input validation for release and commissioning;
- one verified signed-`dist` materialisation path;
- one code-owned Edge Function inventory;
- signed aggregate `public_function_set_sha256` across the 14 public/staff functions, `_shared` and JWT modes;
- unchanged-backend releases skip Supabase function mutation;
- changed-backend releases deploy the complete 14-function set;
- predecessor-bound complete function recovery using exact Git commit + backend fingerprint;
- release-1-only first-deploy marker exception;
- manual protected production release as the only human production-release initiation path;
- final trust policy pinned to the real domain, project ref and production Ed25519 public key;
- anti-divergence contract preventing duplicate recovery/materialisation/deployment authorities.

No new application feature, product route, business workflow, database migration, POS function, CV-upload launch activation or Supabase key-model migration is introduced by this patch.

## Founder-operability simplification

The production operator surface is deliberately smaller than the underlying recovery tooling:

- one real `PRODUCTION_OWNER_*` identity is reused for owner AAL2/RLS, browser smoke, provider e-mail self-test and the synthetic outbox recipient;
- one dedicated low-role `PROBE_USER_*` identity remains for self-scope/escalation/privacy acceptance;
- obsolete `RLS_OWNER_*`, `PRODUCTION_SMOKE_OWNER_*` and `EMAIL_TEST_USER_*` production secret sets are no longer active;
- the normal GitHub commissioning dropdown exposes only `verify-only`, `recover-known-partial`, `fresh`, `resume` and `upgrade`; legacy pre-ledger `adopt` tooling remains internally tested but is not a routine owner control;
- the routing/SEO operator guide is version-neutral so normal release increments do not create documentation churn.
- every GitHub workflow runner is pinned to `ubuntu-24.04`; the locked application lane uses Node 22.23.2, whose bundled npm is 10.9.8.
- the protected database and backup toolchain is aligned to the connected hosted PostgreSQL 17 production major; workflows install exact PostgreSQL 17 through the signed PGDG repository, active harnesses bind `/usr/lib/postgresql/17/bin`, and backup/restore refuses older clients.
- both protected backend commissioning and the protected production release independently run the canonical full `npm run verify` chain for the exact commit before any production mutation/publication; the release then runs only the additional release-specific Deno, provenance, promotion and rollback checks.
- `upgrade`/`verify-only` also validate the live production hostname, FORM/CV/e-mail origin attestations, notification-recipient readiness, Turnstile server/secret/site-key pairing and Media v2 readiness before any database/function/scheduler mutation; recovery/fresh/resume remain intentionally bootstrap-minimal.
- `recover-known-partial` is now strictly database-only: it validates only the exact project-bound Supabase URL/DB URL, skips unrelated Edge Function provider-secret inventory, records that limitation explicitly, and still runs the full source + PostgreSQL recovery rehearsal before the incident SQL may execute.


## Current dependency-free launch gate

The dependency-free P0 gate set was re-run during the independent double-check and again from the final clean-room ZIP extraction. All **64/64 launch-blocking source contracts PASS** with a zero exit status from the exact packaged source.

The current aggregate includes, among others:

- T13.3.30 final closure invariants: **29/29 PASS**;
- known-partial recovery: **38/38 PASS**;
- production release inputs: **15/15 PASS**;
- production commissioning inputs: **15/15 PASS**;
- verified signed-dist materialisation: **7/7 PASS**;
- public-function deploy decision: **6/6 PASS**;
- function rollback/recovery: **6/6 PASS**;
- live production gate contract: **9/9 PASS**;
- backend commissioning workflow: **29/29 PASS**;
- database commissioning: **18/18 PASS**;
- deployment receipt: **12/12 PASS**;
- production scheduler contract: **12/12 PASS**;
- scheduler commissioning: **6/6 PASS**;
- production release preflight: **10/10 PASS**;
- Netlify file-digest draft deployment: **12/12 PASS**;
- Netlify promotion/rollback: **9/9 PASS**;
- live release floor: **12/12 PASS**;
- retained T13.3.29 deployment closure: **23/23 PASS**;
- retained T13.3.28 deployment closure: **21/21 PASS**;
- public website retention: **28/28 PASS**;
- release integrity: **37/37 PASS**;
- permission closure: **43/43 PASS**;
- backend commissioning receipt: **9/9 PASS**;
- OPT-01 / production hosting contract: **99/99 PASS**;
- public deployment handoff: **13/13 PASS**;
- deferred POS contract: **48/48 PASS**.

The long release-provenance attack suite was also executed as exact hermetic shards because its monolithic invocation exceeds the local tool-call wall-clock. The same source/setup and all **43/43 cases** were exercised: the two intended positive cases were accepted and every tampering, forged-signer, rollback, hostile-archive and Edge-Function-inventory attack was rejected. The protected GitHub release/security workflows continue to run the repository's monolithic suite.

## Independent full-verify contract cross-check

A recursive expansion of `npm run verify` identifies **84 direct Node test contracts**. During this double-check:

- **81/84** were executable locally and PASS (including every one exercised by P0 plus the additional retained verify contracts);
- `client-wire-contract.test.mjs` and `closure-hydration.test.mjs` cannot start without the locked `esbuild` package;
- `t133-operational.test.mjs` cannot start without the locked `typescript` package.

Those three are dependency-environment gates, not accepted failures. They remain mandatory under GitHub's exact `npm ci` lane.

## Static integrity

Current source-only parsing/provenance checks completed locally:

- JavaScript/ESM syntax: **196/196 PASS**;
- shell syntax: **31/31 PASS**;
- JSON parse: **13/13 PASS**;
- GitHub/general YAML parse: **4/4 PASS**;
- internal Markdown relative links: **71/71 PASS**;
- migration manifest: **107 upgrade / 109 fresh PASS**;
- no production private signing key material exists in the source tree; one intentionally malformed PEM literal exists only in a negative validation test fixture.

## Recovery safety boundary

The one-time recovery SQL is `ops/RECOVER-PARTIAL-FRESH-T13.3.28.sql`. It is deliberately incident-specific, not a general reset utility.

Before deletion it requires the exact known failed-install fingerprint: exact baseline MilkPop tables/views/routines/types, exact untouched seeded `site_settings` business fields, zero Auth users, zero Storage objects and the exact private empty `cvs` bucket. The only tolerated non-MilkPop public object is Supabase's documented `public.rls_auto_enable()` + enabled `ensure_rls` safety pair, and only when owner, return type, SECURITY DEFINER state, search path, function body, event trigger and tag set all match exactly; it is preserved. Missing, extra, modified or same-name-impostor state refuses recovery. The operation is transactional and verifies a clean postcondition before commit.

A read-only check against the connected production project `upvbfscpfpkwiuuaplhu` confirmed the live incident fingerprint still matches: zero Auth users, one exact private empty `cvs` bucket, no migration ledger entries or Edge Functions, the expected 31 tables / 5 views / 8 enums, the untouched `site_settings` seed, missing `menu_items.available`, and the exact Supabase RLS auto-enable safety pair. No production mutation was performed during this check.

The protected PostgreSQL 17 replay now also executes this exact SQL against a synthetic reconstruction of the historical incident before production mutation: an injected Auth user must refuse recovery without deleting the partial baseline, then the exact incident must recover to a clean public/Auth/Storage state. This executable rehearsal is wired into `upgrade-replay.test.sh`, which runs in protected backend commissioning before database mutation and in the dedicated security CI database gate. It cannot execute in this local container because PostgreSQL is absent, so GitHub remains the execution authority.

Normal owner operation invokes it through **Commission Production Backend → `recover-known-partial`**. Success stops at:

`KNOWN PARTIAL RECOVERY COMPLETE — RUN FRESH`

The separate `fresh` run then remains responsible for the real first installation.

## Release coherence boundary

The signed release marker binds frontend and backend code identity using:

- release identity/number;
- exact 40-character Git commit;
- frontend build SHA-256;
- public/staff function-set SHA-256;
- production profile;
- production domain.

Subsequent releases do not redeploy Supabase functions when the signed backend fingerprint equals the live backend fingerprint. When the backend changed, the complete 14-function set is deployed. A trusted predecessor may be restored only when predecessor Git provenance and computed predecessor backend fingerprint both match the live marker.

Database migrations are never automatically reversed as part of frontend/function rollback.

## Intentionally not claimed locally

This local environment is not the protected production runtime and does not currently provide the repository-owned locked Node/npm dependency installation plus real production providers. Therefore this evidence does **not** claim:

- the exact locked `npm ci` + TypeScript/lint/production-build/browser lane;
- PostgreSQL 17 fresh + upgrade + recovery + RLS + concurrency + backup/restore execution against the protected CI database service;
- real Supabase Edge Function publication, hosted Auth configuration, scheduler/provider delivery or live RLS/form acceptance;
- real Netlify draft upload, draft browser proof, exact promotion or live proof;
- successful owner/store/MFA bootstrap;
- production GO.

Those remain mandatory protected-cloud gates. Do not weaken or skip them because the source gate is green.

## Exact next operational sequence

1. Commit/push the exact sealed T13.3.30 source candidate to reviewed `main`.
2. Require the normal protected `main` CI to be green. The commissioning workflow independently repeats the exact locked `npm ci` + `npm run verify` lane and PostgreSQL 17 rehearsal before any database mutation.
3. Run **Commission Production Backend → `recover-known-partial`** against the known partial project. If its exact incident checks refuse, stop and investigate; do not weaken them.
4. Run **Commission Production Backend → `fresh`**. Required endpoint: `BACKEND INSTALL COMPLETE — OWNER SETUP REQUIRED`.
5. Bootstrap the real owner, owner MFA/AAL2, first real store, low-role acceptance identity, privacy notices, e-mail/notification settings and hosted Auth configuration.
6. Run **Commission Production Backend → `upgrade`** and require the complete post-bootstrap backend receipt green.
7. Confirm final domain/origin/provider configuration and set the separately supplied private Ed25519 key as protected GitHub secret `MP_SIGNING_KEY`.
8. Run **GitHub → Actions → release → Run workflow**, using monotonic `release_number=1` for the first production publication.
9. Require signed Netlify draft verification, exact promotion, live Chromium/WebKit/forms/headers/SEO/owner acceptance and final deployment receipt.
10. Before the final production-branch push, lock Netlify production auto-publishing and keep Git-only deployment enforcement off; before release 1, require the exact HTTPS release-marker URL to return HTTP 404 without redirect; keep the auto-publishing lock in place afterwards so the protected API workflow remains the single production publisher.

When those protected gates are green, stop patching v0.1 and treat this release as the production baseline.
