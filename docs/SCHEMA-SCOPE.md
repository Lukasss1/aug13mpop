# Database schema scope (C1.3, audit finding #8)

The Milk Pop schema deliberately carries some domains beyond the currently
demonstrated launch product (a future CRM/loyalty layer, an inventory layer, and
the deep POS operational tables). That is not a defect on its own — but it needs
**one authoritative classification** so it is obvious which tables are live at
launch, which are backend-only, and which are reserved for later, and so browser
roles never quietly come to depend on a reserved domain.

That classification lives, machine-readable, in
[`supabase/schema-scope.json`](../supabase/schema-scope.json). It is enforced by
`scripts/schema-scope.test.mjs` (`npm run test:schema-scope`, part of
`npm run verify`), which **fails the build** if any table declared in
`schema.sql` or a migration is missing from the registry, if the registry names
a table that does not exist, or if a `reserved` table is exposed to the anonymous
browser role via the `public_read` allow-list. So the registry cannot silently
drift as the schema grows.

## Scope categories

| Scope | Meaning |
|---|---|
| `active` | Used by a launched feature — a browser surface, or a documented server/POS surface. |
| `backend_only` | Written/read **only** by trusted server code (Edge Functions / the service-role connection). No browser role reads it directly. |
| `reserved` | Schema exists for a **future** / not-yet-demonstrated domain. Not wired to any launch surface; browser roles must not depend on it. |
| `deprecated` | Superseded by another table; retained only for back-compat / migration. |

## Current classification (summary)

- **active — website & shop:** `site_settings`, `site_content`, `menu_items`,
  `stores`, `deals`, `job_vacancies`, `news_posts`, `kb_articles`,
  `media_assets` (upload gated by `VITE_MEDIA_V2`).
- **active — team & academy:** `staff_profiles`, `role_permissions`,
  `work_shifts`, `clock_history`, `payslips`, `staff_documents`,
  `checklist_templates`, `sifr_reports`, and the `training_*` tables.
- **active — inbox:** `contact_messages`, `job_applications`,
  `franchise_inquiries`.
- **active — web backup till:** `orders`, `order_items`, `order_item_modifiers`
  (the **Web Till Orders** screen), and `tax_codes` — the WS6d controlled VAT
  classification registry (4 statutory codes; authenticated read-only,
  service-maintained, anon revoked).
- **active — native tablet till:** the `pos_*` tables (the **Native Till Ledger**
  screen). These are two **separate** revenue channels and are reported
  independently — see the scope labels on each screen; a consolidated total is
  deliberately deferred (C1.3 decision).
- **backend_only:** `activity_log`, `email_log`, `form_submission_log`,
  `cv_upload_ip_log`, `media_objects`, `media_references`,
  `storage_cleanup_jobs`, `app_state`.
- **reserved (future):** `customers`, `loyalty_transactions` (CRM/loyalty);
  `ingredients`, `stock_movements` (inventory).
- **deprecated:** `cms_pages` (superseded by `site_content`; still anon-readable
  for back-compat and migrated by the Legacy Import utility).

## Adding a table later

1. Add the table in `schema.sql` (fresh installs) and/or a migration.
2. Add its entry to `supabase/schema-scope.json` with a `scope`, `domain` and a
   short `note`. `npm run test:schema-scope` will fail until you do.
3. Reserved/future tables must **not** be added to the anon `public_read`
   allow-list in `schema.sql`, and should have no browser-role RLS policy until
   the feature is actually built.
