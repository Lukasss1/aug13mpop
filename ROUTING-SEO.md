# Milk Pop Routing and SEO

Milk Pop uses a small History API router in `src/lib/router.ts`. Navigation controls are real anchors, while normal left-clicks are upgraded to instant in-app navigation. Public paths use trailing-slash canonicals.

## Core public routes

| Route | Purpose | Indexed |
|---|---|---|
| `/` | Home | Yes |
| `/menu/` | Published products and prices | Yes |
| `/stores/` | Published store locations | Yes |
| `/stores/<slug>/` | One complete published store | Yes, with LocalBusiness JSON-LD |
| `/about/` | About Milk Pop | Yes |
| `/contact/` | Contact form and store route | Yes |
| `/privacy/`, `/gdpr/` | Public information pages | Yes |

## Optional routes

- `/careers/` and vacancy detail pages are generated and linked only when **Careers is enabled**. Until then, the navigation, form, static pages, sitemap entries and structured data are absent.
- `/news/` and article pages are generated and linked only when **News is enabled**. Draft posts never enter the public snapshot.
- **Franchise is indexed only when enabled**. The route, enquiry form, footer link, disclosure and sitemap entry remain absent while the programme is off.
- `/fdd/` follows the Franchise publication switch.

Unknown optional detail slugs return to the enabled listing route; a disabled optional section resolves to the not-found view with `noindex` rather than exposing its form.

## Internal routes

- `/staff/` and `/staff/<section>/` are authentication-gated and `noindex`.
- `/admin/` and `/admin/<section>/` are role-gated and `noindex`.
- Internal section names come from the code-owned route/feature registries; unknown or unauthorised sections fall back safely.

## Static SEO source

A production build reads the anonymous public Supabase projections through `scripts/load-public-content.ts`. Required singleton failures, malformed rows or an unreachable backend fail the production build; bundled development defaults are not a production SEO fallback.

`scripts/prerender-seo.ts` derives static heads, JSON-LD, `sitemap.xml`, `robots.txt` and `seo-manifest.json` from one validated, deterministically sorted `PublicContentSnapshot`.

Generated output includes:

- unique title, description, canonical and social-card metadata;
- Menu/MenuItem JSON-LD for published products;
- LocalBusiness JSON-LD for complete published stores;
- JobPosting JSON-LD only for enabled, publishable vacancies;
- NewsArticle JSON-LD only for enabled, published articles;
- Organization data using only valid contact/social values;
- a secret-free content hash and collection counts in `seo-manifest.json`.

Incomplete stores, vacancies and products are excluded by the same publication rules used by the live site.

## Keeping SEO current

After a confirmed public-content write, authorised owner/manager actions record `SEO_REFRESH_PROTECTED_RELEASE`. The database write is valid immediately; the action **never calls the hosting platform and never publishes production**. Static crawler pages are refreshed by the next protected signed release, keeping one production publisher.

The deploy-time live parity check recomputes the public-content hash from Supabase and compares it with deployed `seo-manifest.json`.

## Hosting contract

- Netlify is the supported production host.
- Unmatched application routes rewrite to `/index.html` with HTTP 200.
- Pre-rendered route files win before the SPA fallback.
- `public/_headers` is the security-header source of truth.
- Do not add a generic `404.html` that would bypass the intended SPA fallback.

## Verification

Use the package scripts rather than hand-checking generated files:

```text
npm run test:seo
npm run build
npm run test:routing
npm run test:seo-live
```

The production sequence is defined only in `PRODUCTION-COMMISSIONING-T13.3.30.md`.
