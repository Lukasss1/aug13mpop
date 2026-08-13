# Production Environment and Function Inventory — T13.3.30

This is the active configuration inventory for `r4.10.15-t13.3.30-final-production-closure`. Values belong only in the named trust boundary. Never copy a protected secret into a `VITE_*` variable.

## Browser-safe build values

- `VITE_DEPLOYMENT_MODE=production`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_TURNSTILE_SITE_KEY` — empty only when Turnstile is deliberately disabled
- `VITE_RELEASE_IDENTITY`
- `VITE_CONFIRMED_CONTACT_EMAIL` when intentionally configured
- `VITE_MEDIA_V2` only after its live media gate
- `VITE_CAREERS_CV_UPLOAD=false` at launch unless its dedicated live gate has passed
- `VITE_ALLOW_BACKENDLESS=false`
- `VITE_LEGACY_IMPORT=false`

No service-role, database, e-mail-provider, signing or Netlify credential may use a `VITE_*` name.

## Supabase key contract for this bounded launch

T13.3.30 deliberately retains the existing **legacy JWT-shaped** Supabase `anon` and `service_role` contract because several current Bearer/JWT paths were built and tested around it.

- `VITE_SUPABASE_ANON_KEY` = legacy JWT-shaped `anon` key
- `SUPABASE_ANON_KEY` = the same legacy JWT-shaped `anon` key
- `SUPABASE_SERVICE_ROLE_KEY` = legacy JWT-shaped `service_role` key

Do not place `sb_publishable_*` or `sb_secret_*` values into those variables. The workflows fail early if opaque keys are substituted into this legacy contract. Migration to Supabase's newer API-key model is a separate post-launch task and must update the actual authentication/call paths together; do not perform a half-migration during commissioning.

Never expose the service-role key to the browser.

## Protected GitHub `production` environment secrets

Backend commissioning and/or protected release use:

- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_DB_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NETLIFY_AUTH_TOKEN`
- `NETLIFY_SITE_ID`
- `MP_SIGNING_KEY`
- `PROBE_USER_EMAIL`, `PROBE_USER_PASSWORD` — dedicated low-role first-store acceptance user
- `PRODUCTION_OWNER_EMAIL`, `PRODUCTION_OWNER_PASSWORD`, `PRODUCTION_OWNER_TOTP_SECRET` — the one real owner identity used for AAL2/RLS, live browser smoke, direct e-mail self-test and synthetic outbox recipient

The owner variables are the real protected production owner identity. The direct e-mail self-test and synthetic outbox acknowledgement intentionally target that owner, so no separate privileged e-mail-test account is required. Keep only the low-role probe as a dedicated low-value acceptance account. Production commissioning no longer requires a fake second store, fake Store-B staff member or fake second-store manager solely to make CI pass.

### Database URL

For GitHub Actions use the Supabase **Session Pooler** on port `5432` unless the runner genuinely has Direct connectivity. The database wrapper accepts only:

- Direct: exact `db.<project-ref>.supabase.co:5432` with user `postgres`; or
- Session Pooler: `*.pooler.supabase.com:5432` with user `postgres.<project-ref>`.

Transaction-pooler port `6543` is rejected for this commissioning path.

## Protected GitHub `production` environment variables

- `MP_SITE_DOMAIN`
- `MP_SUPABASE_PROJECT_REF`
- `VITE_TURNSTILE_SITE_KEY`
- `TURNSTILE_SERVER_ENABLED`
- `TURNSTILE_SECRET_SET`
- `FORM_ALLOWED_ORIGINS_SET`
- `CV_ALLOWED_ORIGINS_SET`
- `EMAIL_ALLOWED_ORIGINS_SET`
- `NOTIFICATION_RECIPIENT_SET`
- `VITE_MEDIA_V2`
- `MEDIA_BACKEND_READY`
- `MP_ALLOW_FIRST_DEPLOY_WITHOUT_MARKER` — `true` only for the controlled first signed publication; return to `false` afterwards
- `VITE_CONFIRMED_CONTACT_EMAIL` — optional monitored public fallback when intentionally configured

## Supabase Edge Function secrets / configuration

Required for public website/staff commissioning:

- `APP_ENV=production`
- `SITE_URL`
- exact `FORM_ALLOWED_ORIGINS`
- exact `CV_ALLOWED_ORIGINS`
- exact `EMAIL_ALLOWED_ORIGINS`
- `TURNSTILE_SERVER_ENABLED`
- `TURNSTILE_SECRET` when Turnstile is enabled
- `RESEND_API_KEY`
- `EMAIL_FROM`
- `ABUSE_HMAC_SECRET` — high-entropy server-only keyed abuse pseudonyms

`SEO_DEPLOY_HOOK_URL` is **not used** in T13.3.30. `request-seo-rebuild` records a protected-release-pending SEO refresh and never calls a hosting publisher.

`MEDIA_CLEANUP_ENABLED` must remain absent at launch unless the separate media-cleanup commissioning decision explicitly changes that state.

Provider request deadlines are source-owned constants, not secrets.

Supabase injects its backend URL/platform administrative key into Edge Functions. The production scheduler commissioner stores its scheduler material in Vault and references it from `cron.job`; it does not embed raw protected credentials in source.

## Deployable Edge Function source inventory — 17

1. `cv-signed-url`
2. `cv-upload`
3. `employee-access-revoke`
4. `media-cleanup`
5. `media-upload`
6. `outbox-dispatch`
7. `pos-catalog`
8. `pos-ingest`
9. `pos-pair`
10. `public-form`
11. `request-seo-rebuild`
12. `send-email`
13. `staff-doc-delete`
14. `staff-doc-upload`
15. `staff-doc-url`
16. `staff-invite`
17. `training-media`

`_shared` is imported source, not a deployable function.

## Public-launch deployment scope — exactly 14

`launch/deploy-public-functions.sh` deploys the 14 functions required by the public website and staff/manager/owner portal.

The following three POS functions remain **undeployed**:

- `pos-pair`
- `pos-ingest`
- `pos-catalog`

Do not add them to the public release to make an inventory test green. POS has a separate commissioning decision.

## Launch feature state

- Careers capability is deployed; the public Careers section may remain disabled until the owner enables it.
- CV attachment remains off until real CV upload/quarantine acceptance is complete.
- Media v2 remains gated by its live evidence.
- Media cleanup remains inert unless separately commissioned.
- POS/Web Till remains deferred.
- Static SEO refresh occurs only through the next protected signed release; admin content publication never directly triggers Netlify.

## Hosted Supabase Auth configuration — manual production check

These are dashboard/platform settings, not repository secrets and not created by SQL migrations:

- unrestricted public sign-up state;
- e-mail-confirmation behaviour;
- production Site URL;
- exact production Redirect URLs;
- MFA configuration/enrolment;
- custom SMTP when invitations/password resets must deliver reliably.

Record these as part of production commissioning rather than assuming source code configured them.
