# Milk Pop — Owner’s Guide

This guide explains the finished **web platform** in plain language. It is for day-to-day use after the protected production commissioning in `PRODUCTION-COMMISSIONING-T13.3.30.md` has passed.

## 1. What this package contains

The package contains:

1. **The public website** — Home, Menu, Stores, About and Contact. Careers, Franchise and News stay hidden until you enable them.
2. **The Admin area** — website content, menu, stores, rota, messages, staff, training and technical settings.
3. **The Staff Portal** — shifts, timesheets, checklists, documents, training and internal information appropriate to the signed-in role.
4. **The Supabase database and 14 deployed website/staff Edge Functions** — secure storage, forms, email/outbox, staff access, media, documents and training. Three POS function sources are retained but are not deployed for this opening.

POS/Web Till source is preserved for later integration, but it is hidden from Staff and Admin navigation and is outside this public-web opening scope.

The database is the shared source of truth. Do not edit production tables manually unless the commissioning guide explicitly instructs it.

## 2. Information can be completed gradually

You do not need to fill every field before working on the website.

- Blank contact, company and social fields stay hidden.
- A store with a genuine name, address and postcode can be listed publicly as **Coming Soon**; opening hours are required before marking it **Open**.
- Unavailable or incomplete menu products remain private.
- Careers, Franchise and News are off by default.
- Public forms remain closed until their privacy notice, notification recipient and live function checks are complete.

This means you can add confirmed information over time without publishing placeholders.

## 3. Where to make everyday changes

Sign in and open **Admin**. The navigation is grouped around normal small-business work.

### Everyday

- **Today** — opening setup, new messages and important alerts.
- **Menu** — products, prices, availability and images.
- **Team & Rota** — shifts and normal scheduling.
- **Messages** — customer messages marked New, Replied or Closed.
- **Website** — public wording, page images, SEO text and optional-section switches.

### Operations

Use this group for stores, deals, staff, timesheets, documents, checklists, training, the Knowledge Base, incidents, recognition, job applications and franchise leads.

### Advanced

Use this group for Company Settings, permissions, the audit trail and analytics. Live service checks are kept on **Today → System status**, where you can refresh the checks and copy a safe support summary without exposing secrets.

## 4. The minimum customer-facing opening setup

The **Today → Opening setup** panel leads you through the basics:

1. Add at least one genuine store listing and choose whether it appears as Coming Soon, Closed or Open.
2. Publish at least one confirmed menu product.
3. Add a usable public email address or telephone number.
4. Open **Advanced → Company Settings** and complete the formal launch-readiness items.

A visible address alone is not treated as a customer contact channel. The formal readiness panel remains authoritative and may require additional legal, privacy, VAT, receipt and notification information.

## 5. Editing the website safely

### Website wording and general images

Open **Website**. Edit the required page and press **Publish**. Website publishing does not replace the menu catalogue. Unsaved edits, including the reference details for newly uploaded images, survive normal Admin-tab changes; if you refresh or close the browser, the browser warns before the memory-only draft is discarded.

If the page goes live but an uploaded image reference cannot be finalised because the connection drops, the Studio shows **Retry image references**. That retry does not republish the page or require a cosmetic edit. Discarding an unpublished image draft removes the unnecessary retry state automatically.

### Menu products

Open **Menu**. This is the only place that publishes products, prices, availability and product images. Hidden or unavailable products are preserved when website content changes.

### Stores

Open **Operations → Store Locations**. Add only real information. A genuine store appears publicly as Coming Soon. It cannot be marked Open until its required customer-facing fields are complete.

### Optional sections

In **Website**, enable Careers, Franchise or News only when the programme is genuinely ready. Enabling a section affects navigation, routes, forms, static SEO pages and the sitemap together.

### Contact and company facts

Open **Advanced → Company Settings → Launch Facts**. Blank values stay hidden, but malformed email addresses, telephone numbers and canonical URLs are rejected.

## 6. Messages and forms

Public submissions go through the protected `public-form` Edge Function. Anonymous visitors do **not** receive direct insert access to the form tables.

Customer messages use a simple lifecycle:

- **New** — requires attention.
- **Replied** — a reply was sent.
- **Closed** — no further action is expected.

A successful reply automatically changes the message to Replied. Failed sends preserve the draft.

Careers and Franchise forms are unavailable while their public section is switched off. Every enabled form also requires a current privacy notice and commissioned delivery path.

## 7. Staff access

Create and manage staff through **Operations → Staff Directory**. Do not share the owner login.

- The owner account should use MFA.
- Managers receive only their permitted store and operational scope.
- Staff see the Staff Portal, not the owner Admin area.
- End employment through the application workflow so profile status, sessions and audit evidence stay consistent. Do not rely on deleting only a database row.

## 8. Email, media and technical features

These features work only after their live commissioning checks pass:

- email and durable outbox delivery;
- Turnstile-protected public forms;
- media upload and cleanup;
- production schedules and heartbeat monitoring;
- protected-release SEO refresh handoffs (no direct hosting publisher).

A disabled control is not a defect when its commissioning flag is intentionally off. Do not enable a feature merely to remove a disabled notice.

Check **Today → System status** when a cloud, e-mail or scheduler action fails. The **Copy status** button copies only the release, timestamp and coarse healthy/warning/failed states; it does not copy secrets, personal records or raw server errors.

## 9. Opening-day owner checklist

Before opening to customers:

- Review the website on a phone and a desktop.
- Confirm the public menu, prices, sizes and allergen wording.
- Confirm the real store address, postcode, opening hours and delivery links.
- Confirm the public email/telephone and privacy contact route.
- Submit one real Contact test and, only when enabled, one Careers and Franchise test.
- Confirm the message appears in Admin and the email/outbox evidence is healthy.
- Sign in as owner, manager and staff and verify each role sees only the correct areas.
- Confirm the production release marker matches the signed deployment receipt.
- Keep POS/Web Till outside the opening scope until its separate integration and acceptance work is complete.

## 10. What not to do

- Do not upload this source ZIP directly to Netlify.
- Do not place `service_role`, database, signing, email-provider or Netlify secrets in a `VITE_*` variable.
- Do not paste the full migration chain into the Supabase SQL Editor manually.
- Do not publish invented company, store, product, vacancy or allergen information to make a page look complete.
- Do not turn on media cleanup or CV upload without their dedicated live evidence, and do not expose POS routes before the separate POS integration is accepted.
- Do not treat a source test report as proof that production email, schedules or payments work.
- Do not run the stateful staging integration workflow against production. It temporarily publishes a probe menu item, changes a dedicated staging checklist and appends an immutable audit event.

## 11. Production and recovery

The local preflight never requires the production private signing key; GitHub verifies that key inside the protected release workflow. The technical operator must follow `PRODUCTION-COMMISSIONING-T13.3.30.md`. Production GO requires the locked install, official build, browser tests, PostgreSQL tests, live Supabase checks, signed deployment and post-deploy walkthrough.

The ordered database manifest remains the only migration authority. Its frozen historical baseline ends with `supabase/migration_phase_b_public_forms.sql`, which removes direct anonymous form-table writes; every newer migration is appended after that baseline. Do not maintain or run a separate hand-copied migration list.

For normal content mistakes, correct the record in Admin and republish. For a failed website deployment, follow the signed release rollback procedure. For database recovery, never improvise in the Table Editor. Follow `docs/RECOVERY.md`: a complete accepted backup must include both PostgreSQL data and the actual files from all four application Storage buckets, with separate database and Storage restore receipts bound into one acceptance record.
