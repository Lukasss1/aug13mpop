# Known Issues and External Gates — T13.3.30

No remaining application/business-logic defect is accepted as launch-safe by this document; this source candidate is still **not** a production deployment. The external and operator-controlled gates below remain mandatory.

## Mandatory unexecuted production gates

- Protected PostgreSQL 17 fresh/upgrade/recovery rehearsal against the exact committed source.
- One-time guarded cleanup of the known partial Supabase first-install incident, then real `fresh` commissioning.
- Owner/first-store/MFA/privacy/notification/e-mail bootstrap followed by full `upgrade` live acceptance.
- Supabase function/secret/scheduler commissioning against the intended production project.
- Live Turnstile, forms, exact-origin CORS, direct e-mail/outbox and staff/private-data checks.
- Full locked npm/typecheck/lint/build/Playwright accessibility/browser lane in protected CI.
- Production Auth Site URL/Redirect URLs/signup/e-mail/MFA/SMTP settings verified in the hosted Supabase project.
- Production trust policy/signing public key/domain completed; no placeholders may remain.
- One signed frozen production release, Netlify draft acceptance, promotion of the exact verified deploy and live release-marker parity.
- Netlify continuous Git publication stopped once the protected release workflow becomes the production authority.
- Final customer, owner, manager/staff non-POS walkthrough.

## Intentional technical boundary

T13.3.30 keeps the existing legacy JWT-shaped Supabase `anon` / `service_role` key contract. Supabase's newer publishable/secret key model is a separate post-launch migration because the current source contains Bearer/JWT paths that must change together. Do not substitute opaque keys into the legacy variables during this release.

## Intentional product boundaries

- Careers, Franchise and News are off by default unless the owner explicitly enables them.
- CV attachment stays off until malware/quarantine and live upload gates pass.
- Media upload/cleanup remain gated by their dedicated evidence.
- Inventory and written performance reviews remain deferred.
- POS/Web Till is deliberately hidden and deferred; its source remains for later integration and is not part of this GO decision.
- Static SEO crawler artefacts refresh through the next protected signed release, not through a direct hosting hook.

Use `PRODUCTION-COMMISSIONING-T13.3.30.md` as the only production authority.
