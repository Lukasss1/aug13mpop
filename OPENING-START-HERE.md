# Milk Pop — Opening Start Here

This is the clean source package for the deep-opening Milk Pop platform.

## What can remain incomplete

The site is designed to open honestly while information is added over time:

- Careers, Franchise and News are off by default and disappear from navigation, SEO and forms until enabled.
- Empty phone, email, address and social fields are omitted instead of showing placeholders.
- An empty menu or store list shows a clear opening message, not invented products or locations.
- Website wording and images remain editable through **Admin → Website**.
- Products, prices and availability remain editable through **Admin → Menu**.

See [`docs/CONTENT-SETUP.md`](docs/CONTENT-SETUP.md) for the exact editing locations.

## Before opening

1. Follow [`PRODUCTION-COMMISSIONING-T13.3.30.md`](PRODUCTION-COMMISSIONING-T13.3.30.md).
2. Connect the real Supabase and Netlify projects.
3. Enter at least the first store, opening menu, public contact/privacy details and owner account.
4. Leave unused optional programmes switched off.
5. Complete the protected build, database, browser and live-provider gates.
6. Create and accept one complete database-and-Storage recovery package using [`docs/RECOVERY.md`](docs/RECOVERY.md).

The source ZIP is not a prebuilt Netlify upload. The protected release workflow must build and sign the exact source before deployment.
