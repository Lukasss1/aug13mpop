# Milk Pop AdminPanel optimisation — bounded controller decomposition

> **ARCHIVED IMPLEMENTATION REPORT.** Kept for engineering history; it is not a current deployment or owner instruction. Start with [`../../README.md`](../../README.md) and [`../../../OPENING-START-HERE.md`](../../../OPENING-START-HERE.md).


Date: 3 August 2026

## Scope and non-negotiable boundaries

This work reduces AdminPanel coupling, repeated computation, stale-state races and unnecessary controller renders without changing database schemas, RPC signatures, role definitions, route URLs, audit event names, publication rules or intended customer/staff workflows.

It deliberately does **not** introduce a new router, Redux/Zustand, React Query, a design-system rewrite or broad transactional refactor. Security remains server-first: UI projection is defence in depth and never replaces RLS, Edge Function guards or RPC authority checks.

## Safety and integrity corrections

- Removed nine props that App supplied but AdminPanel no longer consumed.
- Restricted the shared entity editor to the four entity types it actually renders.
- Made role-invalid URL sections fail closed before panel render and filtered secure search through the same role policy.
- Added synchronous ref/single-flight protection to sensitive mutations and reads.
- Preserved unsaved Company and E-mail drafts across unrelated cloud refreshes.
- Refreshed an open staff drawer from authoritative employee data instead of retaining a stale object copy.
- Prevented a closing editor from racing an in-progress save.
- Prevented a late image-upload callback from writing into a subsequently opened menu form by remounting the uploader per editor session.
- Replaced timestamp-only browser IDs with collision-resistant client IDs.
- Validated pay-rate updates and serialised competing pay-type/rate changes.

## Centralised business projections

The following rules now live in pure, executable models rather than being independently reimplemented in JSX:

- canonical role-aware admin navigation and live badges;
- dashboard cards, alerts, recruitment bars and role-projected aggregates;
- rota grouping, overlap, overnight duration and labour estimates;
- payroll-period projection and prior-month initialisation;
- training analytics with active-roster and duplicate-certificate handling;
- store-timezone sales-day projection and timestamp formatting;
- contact mailbox filtering/counting;
- checklist ordering and next-order calculation;
- deal canonicalisation and mechanic-specific validation.

This also fixed several real defects:

- new franchise enquiries use status `pending`, but the old dashboard compared with impossible status `new`;
- incident badges and alerts previously disagreed on which unresolved states were open;
- duplicate certificates could count one employee more than once in training completion;
- an alert could display the newest timestamp while retaining another record's source ID;
- a just-confirmed store setup could leave the opening dashboard stale;
- Sales used the device timezone instead of each store's business timezone;
- Sales could merge separate products that shared a display name;
- changing a deal mechanic could retain hidden stale fields from the previous mechanic.

## Server-owned lifecycle integrity

Browser actions were compared with their authoritative SQL and Edge Function contracts.

- Terminal application decisions now have one audit/e-mail owner: `transition_application`.
- Publication, vacancy closure and CV access no longer add duplicate browser audit rows on top of server-owned records.
- Shift deletion, timesheet decisions, document lifecycle, incidents, contacts, store status and other destructive actions use named synchronous workflows.
- Irreversible UI actions retain explicit confirmation while server authority remains decisive.

## Extracted controller boundaries

The following panels now own only their bounded local presentation state and are memoized where appropriate:

- `AdminShell.tsx` — sidebar disclosure and secure search;
- `DashboardPanel.tsx`;
- `AnalyticsPanel.tsx`;
- `SalesPanel.tsx`;
- `ContactInboxPanel.tsx`;
- `DealsPanel.tsx`;
- `ChecklistsPanel.tsx`;
- `SifrPanel.tsx`;
- `FranchisePanel.tsx`;
- `RecognitionPanel.tsx`;
- `KnowledgeBasePanel.tsx`;
- `NewsPanel.tsx`;
- `AuditPanel.tsx`;
- `TimesheetsPanel.tsx`;
- `CompliancePanel.tsx`;
- `MediaLibraryPanel.tsx` — upload lock and file-input state;
- `CareersPanel.tsx` — vacancy and candidate presentation only;
- plus the previously extracted `InboxStatusBar.tsx`, `PermissionsPanel.tsx` and `PublicationControls.tsx`.

The parent retains authoritative mutations where moving them would risk changing RPC order, audit ownership, role gates or cross-panel refresh behaviour. Local typing, filtering, disclosure, draft editing, media upload progress, candidate-list rendering and read-only log loading no longer force the entire Admin controller to render. Staff-drawer shifts/timesheets, active employees, sorted payslips and store lookups now reuse memoized projections instead of repeatedly scanning the same collections.

## Measured controller change

- Original `AdminPanel.tsx`: **5,130 lines**.
- Current `AdminPanel.tsx`: **3,492 lines**.
- Reduction: **1,638 lines / 31.9%**.
- Props: **81 → 72**, with the known dead interface removed.
- Dedicated optimisation contract: **114/114**.
- P0 source gate including this contract: **24/24**.
- Security regression: **214/214**.
- Launch-honesty regression: **60/60**.

The goal is not the smallest possible file. The gain is narrower render ownership, fewer independently implemented business rules, fewer repeated collection scans and clearer security/lifecycle boundaries.

## Verification

Run:

```bash
npm run test:admin-optimization
npm run test:p0-source
node scripts/security-regression.test.mjs
node scripts/t1333-launch-honesty.test.mjs
```

The dedicated contract includes executable model tests for overnight shifts, duplicate employee names, store-timezone/BST boundaries, duplicate product names, checklist ordering, deal normalisation, client-ID collision resistance, dashboard status/provenance, training deduplication and payroll semantics.

The directly runnable AdminPanel-coupled and release/security test files used in this pass all succeed in this sandbox, including opening, permissions, POS, security, seed honesty, small-business usability, operational, launch-honesty, VAT, media and deployment-handoff contracts. Three older individual test entry points cannot be launched directly by bare Node because they rely on the project's TypeScript ESM loader for extensionless imports; the corresponding source contracts are exercised by the passing P0 gate. This is not a test-assertion failure.

## Deliberate stopping boundary

The remaining large domains — Staff, Menu, Stores, Rota, Payslips/Earnings and Settings — combine drafts, financial or employment mutations, focus/dialog behaviour, audit events and cross-panel refreshes. Further mechanical extraction without a clean locked install, official typecheck/Vite build and browser parity lane would increase risk rather than reduce it.

The next safe step is one domain at a time after:

1. clean `npm ci` from the committed lockfile;
2. official TypeScript, ESLint and Vite production build;
3. Playwright and manual owner/manager browser parity;
4. unchanged RPC/audit ordering verified before and after each extraction.
