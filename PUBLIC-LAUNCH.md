# Milk Pop — Public Website Launch

**Current candidate:** `r4.10.15-t13.3.30-final-production-closure`  
**Database:** 107 upgrade migrations / 109 fresh-install SQL entries  
**Edge deployment:** 14 website/staff functions; 3 POS functions retained but not deployed

This release covers the customer website plus staff, manager and owner workflows. POS/Web Till remains preserved for later integration but is hidden and undeployed. Legal wording and owner-supplied business facts are outside this code-readiness decision.

## 1. Freeze Netlify production publishing before the final production-branch push

Before pushing the final production source to the repository branch that Netlify considers production, lock the currently published Netlify deploy / stop auto publishing. Milk Pop production is published only by the protected GitHub `release` workflow through Netlify's API; an ordinary Git push must never replace the live site. Keep Netlify's **Enforce Git-based deployments** setting off, because enabling it would block Milk Pop's protected API publisher. Preview deploys may remain enabled separately.

Before release 1, `https://milkpop.uk/.well-known/milkpop-release.json` must already be reachable directly over HTTPS and return **HTTP 404** with no redirect. DNS/TLS failure, redirecting the apex to another host, or a SPA `200` response is not an acceptable first-release state.

## 2. Commission the backend

Run the protected **commission-production-backend** GitHub Actions workflow against the intended Supabase project. On the first `fresh` installation, keep the successful installation handoff and complete the one-time owner/store setup; then run the post-bootstrap `upgrade` verification described in `PRODUCTION-COMMISSIONING-T13.3.30.md` and keep its green backend commissioning receipt.

## 3. Configure the public local preflight

1. Verify `ops/milkpop-trust-policy.json` already pins the approved production domain, Supabase project reference and **public** Ed25519 verification key. Do **not** edit the sealed trust anchor during release; any deliberate trust change requires a new source seal and verification cycle.
2. Create the ignored local configuration:

```bash
cp ops/public-preflight.env.example .env.production.local
```

3. Fill `.env.production.local` with the public Supabase anon key and the non-secret commissioning attestations. Never place or export the private signing key for this local command; service-role keys, Turnstile secrets and Resend keys also remain server/CI-only.

## 4. Check the reviewed source locally

```bash
npm ci
npm run public:preflight
```

The command derives the release identity, domain, Supabase URL, project reference and canonical site URL. It deliberately defers the monotonic release number, commit hash and private signing-key verification to the protected GitHub release workflow.

## 5. Publish through the protected workflow

Open **GitHub → Actions → release → Run workflow**. This is the only supported path that:

- allocates and checks the release number;
- verifies the protected private key against the committed public key;
- builds the production site once;
- verifies and signs the exact build;
- deploys the 14 public website/staff Edge Functions;
- extracts `dist/` from the verified signed package, creates a Netlify draft with the file-digest API, verifies it and promotes that exact deploy without rebuilding;
- verifies the live release marker and writes the deployment receipt.

`npm run public:seal` is an advanced local artefact-only check. It does not publish Netlify, deploy Supabase Functions or apply database migrations. `npm run public:release` intentionally prints workflow guidance rather than pretending a local command published the website.

Full details: [`PRODUCTION-COMMISSIONING-T13.3.30.md`](PRODUCTION-COMMISSIONING-T13.3.30.md).

## Public GO

Open only after the backend receipt, signed release set, draft/live deployment receipt and live marker agree, hosted Auth/domain checks pass, and the customer/staff/manager/owner walkthrough passes. Normal Git-triggered Netlify production auto-publishing must already be locked before the final production-branch push and must remain locked afterwards. POS is not included.
