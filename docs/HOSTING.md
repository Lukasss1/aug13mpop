# Hosting contract (WP-03)

**Supported production host: Netlify.** `netlify.toml` (build + SPA redirect)
is committed; `public/_headers` is the single source of truth for security
header values and is honoured by Netlify natively. After every deploy, run:

```
STAGING_URL=https://<site>.netlify.app node scripts/headers-smoke.live.mjs
```

It asserts CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy on `/` and
`X-Robots-Tag: noindex` on `/staff` and `/admin`, and that the CSP still
admits Turnstile (`challenges.cloudflare.com`) and Supabase.

## Deploying anywhere else (not supported for v1, snippets for completeness)

Apply the exact header values from `public/_headers`:

**Vercel** — `vercel.json`: map each header under `headers[].headers[]` for
`source: "/(.*)"`, plus the two `X-Robots-Tag` path rules; add a rewrite of
`/(.*)` → `/index.html`.

**Nginx** — `add_header <Name> "<value>" always;` per header inside the
server block; `location /staff` and `location /admin` blocks add
`X-Robots-Tag "noindex, nofollow" always;`; `try_files $uri /index.html;`.

**Apache** — `Header always set <Name> "<value>"` in the vhost;
`<LocationMatch "^/(staff|admin)">` for the robots header; mod_rewrite
fallback to `/index.html`.

Any drift between host config and `_headers` is a deployment defect: the
smoke script is the arbiter.

## HSTS preload (WP03.1 note)

The `Strict-Transport-Security` header we ship (`max-age=31536000;
includeSubDomains`) deliberately does **not** carry the `preload` token.
Submitting milkpop.uk to the browser preload lists is close to irreversible
(removal takes months and breaks any future subdomain that ever needs plain
HTTP). Decide it once, intentionally, after launch is stable — if you want it,
add `; preload` to the header in `netlify.toml`/`_headers`, verify every
subdomain serves HTTPS, then submit at hstspreload.org.

## Database: three deployment paths, and the authoritative manifest (OPT-01.1 / OPT-01.2)

The migration order lives in **one** machine-readable place —
`launch/migration-manifest.sh`. The launch driver, the baseline test
(`npm run test:baseline`), the RLS matrix (`npm run test:rls-local`) and the
manifest-integrity test (`npm run test:manifest`) all read it, so the order
cannot fork across scripts and docs. `npm run test:manifest` fails if any
production migration is missing, duplicated, misclassified, or if a local
fixture (`seed.dev.sql`) ever leaks into a production path.

`SUPABASE_DB_URL` (the project's **direct** Postgres URI) is **mandatory** for
every database path — there is no "paste the chain into the SQL Editor"
fallback. The URL is parsed once into libpq environment variables and its
password is written to a private `PGPASSFILE`, so credentials never appear in
the process argument list; the runner only ever prints `host:port/dbname`.

Three explicit, non-interchangeable paths — a normal upgrade can **never** run
the clean-slate schema, and history is **never** replayed on an existing
database:

```
bash launch/launch.sh --db-fresh         # NEW, COMPLETELY EMPTY project only
bash launch/launch.sh --db-adopt-ledger  # EXISTING project already at the verified
                                       #   final pre-ledger baseline: records history
                                       #   WITHOUT running it
bash launch/launch.sh --db-upgrade       # LEDGER-MANAGED project: applies only
                                       #   genuinely new migrations
```

| Path | Target state | What it does |
|------|--------------|--------------|
| `--db-fresh` | brand-new, empty | `schema.FRESH-INSTALL-ONLY.sql` (drops all tables) → `seed.sql` → whole chain, each recorded in the ledger as `method='executed'`. Refuses if **any** user table exists in `public`; **fails closed** if the emptiness check can't run (no override). Phrase: `ERASE AND INSTALL`. |
| `--db-adopt-ledger` | already fully migrated, but **no ledger** | verifies the database against the expected final baseline, then **records every historical migration in the ledger without executing any of them**, atomically. Phrase: `ADOPT EXISTING BASELINE`. |
| `--db-upgrade` | ledger-managed | applies **only** migrations not yet recorded — never `schema.FRESH-INSTALL-ONLY.sql`, never `seed.sql`, never historical replay. |

All three check prerequisites up front: `psql` on `PATH` (Debian/Ubuntu
`apt install postgresql-client`, macOS `brew install libpq`, Windows the
PostgreSQL installer's command-line tools) and a SHA-256 tool (`sha256sum`,
`shasum` or `openssl`).

### Why a dedicated adoption path (OPT-01.2)

A database created before the ledger existed holds the complete current schema
and every historical migration, but no ledger rows. Treating that empty ledger
as "nothing applied" and replaying the chain is **unsafe**: historical
migrations temporarily recreate superseded, weaker policies and permissions, so
a replay that fails part-way could leave production in an intermediate, less
secure state. `--db-upgrade` therefore **refuses** on a pre-ledger database
(application tables present + empty/absent ledger) and stops with:

```
Existing pre-ledger Milk Pop database detected.
Historical migrations will not be replayed automatically.
Run --db-adopt-ledger after creating and verifying a backup.
```

`--db-adopt-ledger` is the safe alternative. It runs
`launch/verify-current-baseline.sql` — a strict check of the **final** expected
state, not merely "these tables exist": required tables, WP-01/02/04R columns,
foreign keys / unique constraints / indexes, RLS on every table, revoked direct
inserts on the public-form tables, the final submission and server-authoritative
order/POS RPCs, AAL2 helpers and their use in privileged policies, disabled-staff
exclusion, sensitive-field protection triggers, legacy `media_assets`
compatibility, **and the explicit absence** of known-obsolete policies and
function signatures. If any check fails, the whole thing rolls back and **no
ledger rows are written** — adoption is all-or-nothing.

### The migration ledger (`public.mp_migration_ledger`)

One row per migration recorded on the database: `filename` (manifest-relative,
primary key), `checksum` (SHA-256 as recorded), `applied_at`, `ordinal` (the
migration's position in the manifest when it was recorded — OPT-01.2A), and
OPT-01.2 adoption metadata — `method` (`executed` when this runner ran the file,
`verified_existing_baseline` when it was present beforehand and adopted after
verification), `adopted_at`, and `baseline_version` (a fingerprint of the
ordered chain + checksums at adoption time). Adopted rows are therefore **never
misrepresented as migrations this runner executed**. Bootstrap is idempotent and
evolves an OPT-01.1 ledger in place. The table is deployment bookkeeping, not
application schema: RLS is on with zero policies and privileges are revoked from
`anon`/`authenticated`, so it is invisible to the API roles.

Per file, `--db-upgrade` behaves as follows:

- recorded **with the same checksum** → **skipped** (nothing is replayed);
- recorded **with a different checksum** → **hard failure**: an applied
  migration is immutable — restore the original file and ship the change as a
  *new* migration;
- **not recorded** → the file and its ledger row are applied in **one
  transaction** (`psql -1`), so a failure leaves *no* ledger entry and *no*
  partial DDL;
- any error **stops the run at that file** (`ON_ERROR_STOP=1`).

**Immutable baseline, append-only future (OPT-01.2A).** The manifest is split
into `MP_BASELINE_MIGRATIONS` (the frozen historical chain, whose order is pinned
by a fingerprint in `scripts/migration-manifest.test.mjs`) and
`MP_FUTURE_MIGRATIONS` (append-only). Phase B is the last *baseline* migration —
new migrations run **after** it and are added to the future section only.
Reordering or inserting into the baseline fails the build; editing an applied
file fails the runner's checksum guard.

**Full preflight (OPT-01.2 §5 / §2 order proof).** Before the first new migration
runs, `--db-upgrade` validates the whole manifest and ledger together: filenames
are unique and present on disk; every ledger row maps to a manifest entry
(nothing unknown, renamed or removed); every recorded checksum still matches the
file on disk; and the applied migrations are an exact ordered **prefix** of the
manifest — each recorded `ordinal` must still equal the file's current manifest
position, so a new migration can never be slipped in *before* an already-applied
one. Any mismatch aborts **before** the database is touched.

**Deployment advisory lock (OPT-01.2 §7).** Both `--db-adopt-ledger` and
`--db-upgrade` take a PostgreSQL advisory lock (`--db-upgrade` holds a
session-level lock across the whole run via a co-process; `--db-adopt-ledger`
uses a transaction-level try-lock inside its single atomic transaction). They
share one key, so a second concurrent runner waits and then fails rather than
two runners applying the same migration at once.

`npm run test:upgrade-replay` (ledger semantics: zero-replay, exactly-once,
tamper hard-fail, rollback-without-ledger-entry, fail-closed fresh guards) and
`npm run test:adopt` (OPT-01.2 Tests A–F: pre-ledger refusal, verified adoption
with a DDL-event canary proving nothing historical ran, incomplete/obsolete
baselines rejected, future-migration exactly-once, preflight checksum failure,
and advisory-lock contention) prove all of the above behaviourally against a
real PostgreSQL cluster, and run as the `upgrade-replay` and `pre-ledger-adopt`
CI jobs.

### Adopting the ledger on your existing database (one-off)

1. Take **and verify** a restorable backup (or a tested PITR point).
2. Set `SUPABASE_DB_URL` to a production-compatible PostgreSQL URI. For GitHub Actions use the project's Supabase **Session Pooler** URI; use the direct URI only from an environment that can reach the direct endpoint.
3. Run `bash launch/launch.sh --db-adopt-ledger`; confirm `BACKED UP`, then
   `ADOPT EXISTING BASELINE`.
4. If it reports a `BASELINE FAIL`, the database is **not** at the expected
   final state — bring it to baseline (apply the missing object, or remove the
   obsolete one it names) and re-run. Nothing was written.
5. On success the ledger holds every historical migration as
   `verified_existing_baseline`. From then on use `--db-upgrade` for new
   migrations only.

### Rolling back

Migrations move **forward only** — never edit or delete an applied migration
(the checksum guard exists precisely to catch that). To undo an upgrade:

1. **Preferred — restore the backup** taken at the `BACKED UP` gate (or the
   PITR point); the ledger is a table like any other, so it restores to the
   matching state and a re-run resumes correctly.
2. **Forward-fix** — ship a *new* migration that reverses the unwanted change;
   the ledger applies it exactly once.
3. A migration that **failed mid-run** needs no rollback of its own: its
   transaction already rolled back and it has no ledger entry — fix the file and
   re-run; completed files are skipped.
4. **Adoption** writes only ledger rows and executes nothing, so an aborted
   adoption changes nothing. To undo a *successful* adoption you would only
   remove the ledger rows (e.g. drop `public.mp_migration_ledger`) — but there
   is rarely any reason to, since adoption reflects the database's real state.

## Media cleanup: deployment ≠ enablement (OPT-01 carry-over blocker)

`media-cleanup` ships in the launch set so a clean deployment publishes every
required function, but it is **inert by design**: the first thing it does is
refuse unless the `MEDIA_CLEANUP_ENABLED=true` function secret is set. Leave
the secret unset.

**This is now enforced at deploy time, not just documented.** The build-time
validator hard-fails (rule R8, in **every** mode) if `MEDIA_CLEANUP_ENABLED=true`
is present in the environment, and the launch driver's readiness check aborts
the deploy if the secret exists on the target project at all — with the fix
being `supabase secrets unset MEDIA_CLEANUP_ENABLED`. Cleanup enablement is out
of scope for this release, so the secret must be **absent**.

It must stay unset until the CV cleanup reconciliation case is fixed **and
behaviourally tested**: a CV's database link may have committed while the
upload's HTTP response was lost, so an ambiguous cleanup job must re-check
`job_applications.cv_path` at deletion time — a referenced CV is never
deleted; a database verification failure retries later instead of deleting;
only an object confirmed unreferenced (or a proven race-loser) may be removed.
Until that invariant has an executable proof, the media cleanup system is
**not production-ready**, deployed or not.

## Technical debt accepted at OPT-01 (deliberately deferred)

**R4.8 update — this debt is PAID.** Every Edge Function now delegates to the single shared builder in `_shared/cors.ts`, and the builder FAILS CLOSED in production: an exact-origin allow-list is required (deploy validator R12), trusted origins are echoed exactly, everything else — including a missing list — answers `Access-Control-Allow-Origin: null` with an observable `X-MP-Cors: misconfigured` marker. The wildcard fallback survives only in non-production environments with no list configured. Contract suite: `scripts/r48-cors.test.ts` runs the shipped decision core.
