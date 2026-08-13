# Milk Pop T13.3.30 — Public Website GO Checklist

Use this as a sign-off sheet only. The executable authority is [`../PRODUCTION-COMMISSIONING-T13.3.30.md`](../PRODUCTION-COMMISSIONING-T13.3.30.md). A source ZIP is never a production release.

## 1. Frozen source and clean build

- [ ] Verify the source candidate and committed `release-manifest.json` refer to the exact same source tree.
- [ ] Run `npm ci` with the locked Node/npm contract.
- [ ] Run the complete `npm run verify` pipeline with zero failed gates.
- [ ] Pass the protected PostgreSQL 17 rehearsal.
- [ ] Produce one fresh production build; do not reuse an older `dist/`.
- [ ] Confirm release identity `r4.10.15-t13.3.30-final-production-closure`.

## 2. Database and backend

- [ ] Confirm the exact Supabase project ref and exact Direct/Session-Pooler URL binding.
- [ ] For first install only, run `fresh` only after the target is proven brand-new and confirm `BACKEND INSTALL COMPLETE — OWNER SETUP REQUIRED`.
- [ ] If the first installation stops after its baseline/ledger but before bootstrap, use guarded `resume`; do not blindly rerun `fresh`.
- [ ] Complete owner + real first store + owner MFA + one low-role acceptance user + privacy notices + notification/e-mail bootstrap.
- [ ] Run post-bootstrap `upgrade` commissioning and retain a full green backend receipt.
- [ ] Verify the exact 107-migration ledger, ordinals and checksums.
- [ ] Deploy exactly 14 public website/staff Edge Functions; confirm all three POS functions remain absent.
- [ ] Verify production Edge Function secrets by name without printing values.
- [ ] Commission required schedules and prove fresh heartbeats.
- [ ] Verify direct e-mail/outbox delivery, forms, CORS and declared Turnstile state.

## 3. Hosted Auth and domain

- [ ] Supabase unrestricted public signup state is intentional (normally disabled for this staff portal).
- [ ] Production Auth Site URL is exact.
- [ ] Production Redirect URLs are exact/minimal; no unnecessary broad wildcard remains.
- [ ] E-mail confirmation behaviour is intentional and owner MFA/AAL2 is proven.
- [ ] Custom SMTP is configured if production invites/password resets rely on it.
- [ ] Netlify domain/DNS/TLS, `MP_SITE_DOMAIN`, `SITE_URL`, allowed origins, Auth URLs, SEO canonical base and trust-policy domain all agree.

## 4. Live customer/owner/staff paths

- [ ] Home, Menu, Stores, About, Contact, Privacy and GDPR routes load directly and after refresh.
- [ ] Disabled Careers, Franchise and News routes remain hidden/non-indexable as intended.
- [ ] Contact form produces one accepted database row and one notification path with honest retries.
- [ ] Menu, stores, prices and availability match owner-approved opening information.
- [ ] Owner MFA login works and owner-only areas remain owner-only.
- [ ] Manager/staff permissions are scoped correctly; low-role staff cannot read another employee's private data or escalate themselves.
- [ ] No POS/Web Till route or navigation item is visible in the public-web release.

## 5. Protected publication

- [ ] Configure the production trust policy and signing key; no placeholders remain.
- [ ] Seal/sign the exact frozen release set and verify it before upload.
- [ ] Extract deployable `dist/` from the verified signed package.
- [ ] Create a Netlify **draft** with the file-digest API, run draft acceptance, then promote that exact deploy ID.
- [ ] Verify live CSP/HSTS/cache headers, sitemap, robots, canonical URLs and exact release-marker parity.
- [ ] Static SEO publication has no separate hosting build hook; pending SEO refreshes move only with the protected release.
- [ ] Before the final production-branch push, lock Netlify production auto-publishing; keep **Enforce Git-based deployments** off so the protected API publisher remains allowed, and keep the auto-publishing lock in place afterwards.
- [ ] Before release 1, verify `https://milkpop.uk/.well-known/milkpop-release.json` returns exact HTTP `404` over HTTPS with no redirect.
- [ ] If rollback occurs, record whether it was frontend-only and reconcile all 14 Edge Functions explicitly when required.
- [ ] Complete customer + owner + manager/staff non-POS walkthrough and record owner/date/evidence location for GO.
