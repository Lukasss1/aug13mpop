# Milk Pop documentation map

Start with the current operator documents, not the historical compatibility references.

## Opening and production

- [`../OPENING-START-HERE.md`](../OPENING-START-HERE.md) — owner-facing starting point.
- [`../PRODUCTION-COMMISSIONING-T13.3.30.md`](../PRODUCTION-COMMISSIONING-T13.3.30.md) — the only production commissioning authority.
- [`COMMISSIONING-CHECKLIST.md`](COMMISSIONING-CHECKLIST.md) — concise execution checklist.
- [`RELEASE-RUNBOOK.md`](RELEASE-RUNBOOK.md) — protected build, seal and deployment workflow.
- [`OPERATIONS-RUNBOOK.md`](OPERATIONS-RUNBOOK.md) — opening-day and ongoing operational checks.
- [`RECOVERY.md`](RECOVERY.md) — complete database-and-Storage backup, restore drills and acceptance evidence.
- [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md) — intentional product boundaries and external gates.

## Owner setup

- [`CONTENT-SETUP.md`](CONTENT-SETUP.md) — where to edit stores, menu, contact facts, website copy and optional sections.
- [`../OWNERS-GUIDE.md`](../OWNERS-GUIDE.md) — owner administration and staff operations.

## Technical scope

- [`HOSTING.md`](HOSTING.md), [`SCHEMA-SCOPE.md`](SCHEMA-SCOPE.md), [`INVENTORY-BOUNDARY.md`](INVENTORY-BOUNDARY.md), [`NATIVE-TILL-BOUNDARY.md`](NATIVE-TILL-BOUNDARY.md), and [`CV-UPLOAD-GATE.md`](CV-UPLOAD-GATE.md) document supported boundaries.
- [`STAGING-COMMISSIONING.md`](STAGING-COMMISSIONING.md) describes staging evidence.
- [`releases/T13.3.30-FINAL-PRODUCTION-CLOSURE.md`](releases/T13.3.30-FINAL-PRODUCTION-CLOSURE.md) records the current protected-deployment closure.
- [`releases/T13.3.28-PRODUCTION-DEPLOYMENT-CLOSURE.md`](releases/T13.3.28-PRODUCTION-DEPLOYMENT-CLOSURE.md) records the preceding first-production deployment correction.
- [`releases/T13.3.27-VERIFIER-CLOSURE.md`](releases/T13.3.27-VERIFIER-CLOSURE.md) records the preceding deferred-POS verifier closure.
- [`releases/T13.3.26-LOCAL-PREFLIGHT-CONFIG.md`](releases/T13.3.26-LOCAL-PREFLIGHT-CONFIG.md) records the preceding local non-secret preflight configuration and protected-CI trust split.
- [`releases/T13.3.22-PUBLIC-WEB.md`](releases/T13.3.22-PUBLIC-WEB.md) records the preceding public-web scope.
- [`releases/T13.3.21-PUBLIC-LAUNCH.md`](releases/T13.3.21-PUBLIC-LAUNCH.md) records the preceding handoff.
- [`releases/T13.3.20-FINAL-AUDIT.md`](releases/T13.3.20-FINAL-AUDIT.md) records the preceding whole-tree final-audit closure. T13.3.19 remains the preceding trust-boundary release.
- [`releases/T13.3.18-STORAGE-RESILIENCE.md`](releases/T13.3.18-STORAGE-RESILIENCE.md) records the preceding browser-storage and legacy-sale recovery increment.
- [`releases/T13.3.18-INDEPENDENT-AUDIT-CLOSURE.md`](releases/T13.3.18-INDEPENDENT-AUDIT-CLOSURE.md) records the bounded post-audit verification and prerender corrections.
- [`releases/T13.3.17-OPERATOR-RECOVERY.md`](releases/T13.3.17-OPERATOR-RECOVERY.md) records the preceding operator-recovery and browser-reliability increment.
- [`releases/T13.3.15-RUNTIME-RESILIENCE.md`](releases/T13.3.15-RUNTIME-RESILIENCE.md) records the preceding browser-runtime resilience increment.
- [`releases/T13.3.14-DEPLOYMENT-POLISH.md`](releases/T13.3.14-DEPLOYMENT-POLISH.md) records the preceding deployment-polish increment.
- [`releases/T13.3.13-STAFF-PORTAL-INTEGRITY.md`](releases/T13.3.13-STAFF-PORTAL-INTEGRITY.md) records the preceding Staff Portal integrity increment.

## Compatibility and historical references

The project root contains only the current production commissioning authority, `PRODUCTION-COMMISSIONING-T13.3.30.md`. Earlier commissioning guides have been moved to `archive/commissioning/` and are marked historical/superseded. They remain only where release-history or regression evidence needs them.

Files named for earlier stages remain active only where regression tests pin an old security or migration contract. They are not current deployment instructions. See [`SUPERSEDED-DOCUMENTS.md`](SUPERSEDED-DOCUMENTS.md). Historical evidence and implementation reports that are useful for audit context but not for opening are kept under `archive/`.
