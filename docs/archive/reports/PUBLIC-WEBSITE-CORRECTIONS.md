# Milk Pop public website — nine-finding correction record

> **ARCHIVED IMPLEMENTATION REPORT.** Kept for engineering history; it is not a current deployment or owner instruction. Start with [`../../README.md`](../../README.md) and [`../../../OPENING-START-HERE.md`](../../../OPENING-START-HERE.md).


**Source baseline:** `MilkPop-web-R4_10-T13.3.27-VERIFIER-CLOSED-SOURCE(1).zip`  
**Correction date:** 5 August 2026  
**Scope:** the nine core public-website findings in `MilkPop_T13.3.27_Public_Launch_Audit.md` only. No POS/Till activation, database migration, new service or redesign was added.

## Closure summary

All nine findings are implemented:

1. **Extras are public:** the Menu now includes an Extras filter and no longer removes published Extras rows.
2. **Truthful store status:** the static `open` state is labelled **Open**, not **Open Now**.
3. **Store-card interaction:** the outer click handler was removed. Store name, telephone, delivery, directions and details are independent links.
4. **Price clarity:** dual prices are labelled **Regular** and **Large** on both home favourites and the full Menu.
5. **Postcode search:** store filtering now checks name, address and postcode; default copy uses UK terminology.
6. **Store locator simplification:** the decorative UK map was removed. Cards use the available space and provide a safe Google Maps directions link.
7. **SEO opening hours:** one shared parser accepts both the legacy pipe/colon format and the exact en-dash/middle-dot format shown by Admin, while rejecting invalid clock values.
8. **Deterministic public ordering:** runtime hydration and build-time snapshots share pure sorting helpers:
   - menu: business category order, then name and id;
   - stores: name and id;
   - vacancies: newest creation date, then title and id;
   - news: newest publication date, then title and id.
9. **Contact trimming:** full name, email, reason and message are trimmed before validation, idempotency hashing and submission.

## Changed source files

- `src/components/PublicPages.tsx`
- `src/components/admin/WebsiteStudio.tsx`
- `src/lib/cloudSync.ts`
- `src/lib/openingHours.ts` *(new)*
- `src/lib/publicContentSnapshot.ts`
- `src/lib/publicOrdering.ts` *(new)*
- `src/lib/publishRules.ts`
- `src/siteContent.ts`
- `scripts/prerender-seo.ts`
- `scripts/public-launch-corrections.test.ts` *(new)*
- `scripts/publish-rules.test.ts`
- `package.json`

## Design decisions

The implementation deliberately stays small:

- no live “open now” calculation was invented from free-text hours;
- no map provider SDK, API key, geocoder or location database was added;
- no `display_order` database column or migration was added;
- no new dependency was introduced;
- sorting and opening-hours parsing are small, shared and dependency-free;
- historic POS/Till and optional public-feature scope is unchanged.

## Verification completed

A total of **741 static assertions passed after implementation**:

- new correction regression suite: **17/17**;
- existing public launch chain through T13.3.27: **87/87**;
- small-business usability: **50/50**;
- opening-final suite: **78/78**;
- public-form integrity: **45/45**;
- runtime resilience: **21/21**;
- deployment handoff: **24/24**;
- deployment polish: **16/16**;
- final-audit continuity: **23/23**;
- CSS/public assets: **11/11**;
- security regression: **214/214**;
- collection contract: **2/2**;
- seed honesty: **60/60**;
- fail-closed structural guards: **31/31**;
- allergen presentation: **28/28**;
- contrast/public empty states: **13/13**;
- public safe-URL/headers contract: **21/21**.

Additional compiler checks:

- TypeScript syntax transpilation: every modified `.ts`/`.tsx` file passed;
- strict semantic type-check: all changed library modules and their local dependency graph passed;
- no dependency or package-lock change was introduced.

## Environment limitation

A fresh `npm ci --ignore-scripts` could not run in the audit container because its configured package mirror returns HTTP 404 for the locked `yocto-queue@0.1.0` tarball, while direct public npm DNS is unavailable. Consequently, a fresh Vite build and Playwright browser run are not claimed here. This is an environment retrieval failure, not a dependency resolution change introduced by these corrections.

The shipped regression command uses the repository's existing Node-20-compatible `tsx` toolchain:

```sh
npm run test:public-corrections
```

Normal release commissioning should still run `npm ci`, typecheck, production build, browser checks and the protected deployment seal in an environment with the configured package mirror available.
