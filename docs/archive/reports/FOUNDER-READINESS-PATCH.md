# Milk Pop founder-readiness patch

> **ARCHIVED IMPLEMENTATION REPORT.** Kept for engineering history; it is not a current deployment or owner instruction. Start with [`../../README.md`](../../README.md) and [`../../../OPENING-START-HERE.md`](../../../OPENING-START-HERE.md).


## Purpose

This patch improves the existing R4.10.14 source candidate for a non-technical small-business owner without changing the proven database, RLS, authentication, migration, publication or staff-workflow architecture.

It is a bounded source correction, not a new production release. The package must still pass the official locked install, production build, browser, PostgreSQL and live commissioning gates before deployment.

## Implemented changes

### Clear owner-facing infrastructure guidance

- Centralised the cloud-not-configured message and added stable reference `MP-CLD-001`.
- Removed instructions that incorrectly told the owner to connect Supabase in Company Settings.
- Cloud-dependent e-mail and Academy video actions now explain that technical support is required without exposing secrets.

### Safer Website Studio drafts

- Added a browser close/refresh warning while a Website Studio draft is dirty.
- Kept drafts memory-only; no private or sensitive information was added to browser persistence.
- Scoped the in-memory draft to the signed-in operator so one owner cannot inherit another operator's unfinished work on a shared device.
- Preserved newly uploaded image object references across normal Admin-tab switches, not only the visible text/image draft.
- Added a real retry path when a page is live but image-reference finalisation is interrupted.
- Kept a shared uploaded image retryable until every field using that image is finalised.
- Removed unpublished upload bookkeeping when a draft is discarded, preventing false recovery prompts.
- Aligned locally normalised settings with the exact value accepted by publication so successful trimming cannot leave a false dirty state.
- Removed hidden-but-focusable publish controls by rendering the publish bar only when changes exist.
- Added an accessible live unsaved-change status.
- Clarified that the public allergen model is the commissioned in-store disclosure mode, not a complete online allergen declaration.

### Honest e-mail preference behaviour

- Removed the incorrect statement that e-mail preferences save automatically.
- Added clear saved/unsaved status.
- Prevented a test e-mail from being sent against unsaved preference changes.

### Direct system health access

- Reused the existing operational and notification health panels under a real, focusable `System status` section.
- Replaced an obsolete navigation instruction with a working `Open system status` action.
- Added a privacy-safe `Copy status` summary containing only release identity, timestamp and coarse service states.

### Better failure support

- Added a per-failure support reference to the root React error boundary.
- Added a privacy-safe `Copy support reference` action containing only issue ID and release identity.
- Kept raw errors, stack traces, tokens and business data out of the copied reference.

### Targeted accessibility and readability

- Added a deterministic 12px `text-2xs` utility because it is used throughout the existing UI but is not a Tailwind default.
- Increased selected owner-critical labels, instructions and controls that were below a practical readable size.
- Preserved compact decorative labels where changing layout would add unnecessary release risk.
- Ensured new actions meet the existing 44px touch-target convention.
- Added accessible names to active icon-only owner and staff actions; the remaining icon-only findings are confined to deferred POS code outside the launch graph.
- Associated visible labels with core Website Studio, menu, store, staff, rota, Academy, checklist, deal and settings controls.
- Replaced a nested clickable vacancy card/link with one semantic whole-card link, avoiding duplicate navigation and restoring normal keyboard behaviour.
- Made rota deletion actions visible on touch devices and discoverable through keyboard focus.

### New regression gates

- Added `test:founder-readiness` to prevent the corrected owner flows from regressing.
- Added `test:deferred-reachability` to prove the launch entry point cannot import deferred POS/Web Till runtime modules.
- Added both tests to `npm run verify` and the P0 source gate.
- Added all new files to the zero-warning lint-ratchet paths.

## Deliberately unchanged

The patch does not change:

- PostgreSQL schema or migration history;
- RLS policies, role authority or MFA;
- authentication and session contracts;
- draft/published content architecture;
- public-form idempotency;
- staff clocking, rota, training or document workflows;
- POS/Web Till commissioning status;
- Supabase, Netlify or e-mail secrets;
- route framework or state-management libraries;
- large components solely to reduce line count.

These areas are already protected by extensive project gates. Reworking them before launch would add regression risk without proportionate value for a one-to-three-store business.

## Verification completed in this environment

- Founder-readiness source gate: **23/23** passed after the deeper workflow and accessibility pass.
- Deferred import-reachability gate: passed; launch graph excludes deferred POS/Web Till runtime.
- P0 dependency-free source suite: passed after the implementation.
- TypeScript/TSX syntax transpilation across application and Edge Function source: passed.
- Runtime resilience and lint-ratchet contract checks: passed.
- Static launch-UI audits found no duplicate literal IDs, nested interactive controls, accidental form-submit buttons or unlabeled visible launch controls. Intentionally hidden file inputs are activated through named buttons.

## Verification still mandatory before deployment

The execution environment's internal npm mirror did not provide multiple locked dependency tarballs (including `yocto-queue` and `yargs-parser`), so a clean dependency installation could not be completed here. This is an external package-mirror limitation, not a repository test failure.

The official release runner must still complete:

1. clean locked `npm ci`;
2. full TypeScript typecheck and ESLint;
3. production build and bundle checks;
4. browser and accessibility journeys;
5. PostgreSQL fresh install and upgrade replay;
6. RLS, concurrency and backup/restore tests;
7. live Supabase, Netlify, e-mail, storage, MFA and public-form commissioning;
8. release sealing, production identity binding and deployment receipt verification.

## Small-business decision

This patch intentionally stops at the point where further work becomes a separate product enhancement rather than a launch-quality correction. Owner exports, arbitrary custom roles, stock control, payroll, POS and broad component rewrites should be commissioned only when the operating business creates a real need for them.
