# Milk Pop — Technical Release and Recovery Reference

The current production authority is [`../PRODUCTION-COMMISSIONING-T13.3.30.md`](../PRODUCTION-COMMISSIONING-T13.3.30.md). This file explains the mechanics behind that workflow. If the two disagree, stop and correct the source before deployment.

Scope: Milk Pop v0.1 public website plus staff/manager/owner portal. The database remains 107 ordered upgrade migrations / 109 fresh-install SQL entries. Source contains 17 Edge Functions; production deploys 14 website/staff functions and defers the three POS functions.

## 0. Release principles

Production has one human release initiation path: **GitHub → Actions → release → Run workflow**. A normal Git push or tag must not publish production.

The protected workflow:

1. validates the exact production target and protected input semantics;
2. proves the committed source manifest is current;
3. runs locked source/database/browser verification;
4. performs one production build;
5. signs and independently verifies the release set;
6. materialises `dist/` only from the verified signed archive;
7. compares the signed public-backend fingerprint with the live release marker;
8. mutates Edge Functions only when that fingerprint changed;
9. verifies a non-live Netlify draft;
10. promotes that exact draft and performs live acceptance;
11. records a deployment receipt.

The source ZIP is never uploaded to Netlify directly.

## 1. Database — append-only chain and known-incident recovery

The ordered database manifest is authoritative:

```bash
bash launch/migration-manifest.sh fresh
bash launch/migration-manifest.sh upgrade
```

Do not reorder, edit or remove an applied migration. Corrections after production are new append-only migrations. Frontend or function rollback never automatically reverses database migrations.

### Known failed first-install incident

`ops/RECOVER-PARTIAL-FRESH-T13.3.28.sql` exists only for the already-observed first-production incident where:

- the project was proven empty;
- the fresh base schema completed;
- the first `site_settings` seed row was inserted;
- `seed.sql` then failed on `menu_items.available`.

The SQL is intentionally not a general reset utility. Normal operation invokes it only through **Commission Production Backend → `recover-known-partial`**, using the exact project-bound confirmation phrase. It requires the exact known object/data/Auth/Storage fingerprint and aborts on any missing, extra or changed state. Success is terminal: run `fresh` separately afterwards.

## 2. Edge Functions — public production set (14)

The code-owned inventory in `scripts/lib/edge-function-inventory.mjs` is the authority. `launch/deploy-public-functions.sh` consumes that inventory rather than maintaining a second literal list.

For manual engineering verification, the maintained deploy helper is:

```bash
bash launch/deploy-public-functions.sh
```

This helper is **not a second production publisher**; normal production function publication is owned by the protected GitHub release/commissioning workflows. It deploys the **14 public website/staff functions** and records the source tree hash, JWT mode and aggregate `public_function_set_sha256`.

Do not deploy these POS functions during public opening:

- `pos-pair`
- `pos-ingest`
- `pos-catalog`

They remain source-preserved and use the separate later-stage `launch/deploy-pos-functions.sh` path after a future POS commissioning decision.

### Backend change detection

Every signed production release carries one deterministic `public_function_set_sha256`, derived from the 14 production functions, `_shared` source and expected JWT modes.

- first release: deploy all 14;
- later release with the same signed/live backend fingerprint: **skip Supabase function mutation** and still run live backend acceptance;
- later release with a different fingerprint: deploy the complete 14-function set.

This minimises production mutation for normal content/frontend releases.

## 3. Edge Function recovery

Supabase multi-function publication is treated as recoverable, not falsely transactional.

For an existing trusted Milk Pop release, the live marker supplies the predecessor Git commit and predecessor `public_function_set_sha256`. `scripts/restore-public-functions-from-git.sh`:

1. requires an exact 40-character predecessor commit;
2. proves it exists and is an ancestor of the reviewed current source;
3. extracts only predecessor `supabase/functions` source;
4. recomputes the complete predecessor 14-function fingerprint;
5. refuses mutation unless it exactly equals the live marker;
6. restores the complete predecessor 14-function set through the current code-owned inventory/deploy policy.

Never repair a mixed function set ad hoc.

Failure handling:

- failure before function mutation: no backend rollback;
- partial changed-function deployment: restore all 14 predecessor functions when a trusted predecessor exists;
- failed backend proof before frontend publication: restore predecessor functions and do not promote the draft;
- failed post-publication proof: restore the previous Netlify deploy and, when backend changed, the predecessor 14-function set;
- first-ever release: no predecessor exists, so failure is recorded honestly and must be corrected before another controlled attempt.

## 4. Schedulers

Do not create production schedules by hand. `Commission Production Backend` runs `scripts/commission-production-schedulers.mjs`, stores scheduler credentials in Supabase Vault and commissions the exact expected jobs:

- `outbox-dispatch` — every 5 minutes;
- `employment-sweep` — daily;
- `retention-sweep` — daily;
- `ops-health-watch` — hourly.

Acceptance requires recent successful worker heartbeats. Raw protected credentials must not appear in `cron.job`.

## 5. CORS, Turnstile and e-mail

Production origin allow-lists are exact origins, comma-separated and wildcard-free:

- `FORM_ALLOWED_ORIGINS`
- `CV_ALLOWED_ORIGINS`
- `EMAIL_ALLOWED_ORIGINS`

An unset allow-list is deliberately fail-closed.

`TURNSTILE_SERVER_ENABLED` must be explicit `true` or `false`. If true, both the site key and server secret pairing must be commissioned. Release/backend acceptance also proves direct e-mail, durable outbox delivery and cleanup using protected test identities.

## 6. Signed release and trust policy

`ops/milkpop-trust-policy.json` is the committed public trust anchor. It pins:

- the production Ed25519 public key;
- approved `milkpop.uk` domain;
- approved production Supabase project ref;
- an offline emergency `minimum_release_number` floor.

The matching private Ed25519 key exists only as the protected GitHub `MP_SIGNING_KEY` secret and must never be committed or placed in a `VITE_*` variable.

The live signed release marker is the routine anti-rollback authority. `minimum_release_number` is not edited after every ordinary release; change the committed trust anchor only deliberately, such as key rotation, project/domain migration or an emergency trust-floor change.

The production marker contains only compact public release identity:

- `release_identity`
- `release_number`
- `git_commit`
- `build_output_sha256`
- `public_function_set_sha256`
- `build_profile`
- `site_domain`

## 7. Verified frontend bytes and Netlify

The protected seal performs **one production build**. The signed package is then verified and `scripts/materialize-verified-dist.mjs` reconstructs a clean `release-out/verified-dist` from that verified package.

The materialiser rejects unsafe ZIP paths/symlinks, verifies archive size/hash, recomputes the build hash and requires the embedded release marker to match the signed release set exactly.

Netlify's file-digest publisher may consume only that verified directory. It first creates a non-live draft. The workflow verifies the draft before promoting the exact same deploy ID.

Before the final source is pushed to the branch Netlify treats as production, lock the currently published deploy / stop Netlify auto publishing. Keep that production auto-publishing lock in place afterwards. Preview deploys may remain separate. Keep Netlify's **Enforce Git-based deployments** setting off because Milk Pop publishes the verified production deploy through the protected API workflow.

## 8. First release floor

A missing live release marker is accepted only when **both** are true:

- `MP_ALLOW_FIRST_DEPLOY_WITHOUT_MARKER=true`; and
- candidate `release_number` is exactly `1`.

Therefore accidentally leaving the flag true cannot authorise release 2 or later without a valid predecessor marker.

## 9. Static SEO

`request-seo-rebuild` does not hold a Netlify/build-hook publishing secret. It records that crawler artefacts need refresh. Static SEO artefacts are refreshed only by the next protected signed release; public database content can become live immediately.

## 10. Production GO

Do not infer GO from a source ZIP or local green suite. Production requires:

- exact committed source/manifest parity;
- locked Node/npm install and full verify lane;
- PostgreSQL 17 fresh/upgrade/recovery/RLS/concurrency/restore proof;
- successful real Supabase commissioning;
- owner/store/MFA bootstrap and full post-bootstrap backend receipt;
- signed non-live Netlify draft and exact promotion;
- live Chromium/WebKit, forms, headers and SEO acceptance;
- one protected production publisher.
