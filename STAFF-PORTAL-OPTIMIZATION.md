# StaffPortal optimisation boundary

## Scope

This document describes the StaffPortal structure inside the release identity:

`r4.10.6-t13.3.13-staff-portal-integrity`

T13.3.13 contains one database migration, `supabase/migration_t13313_staff_portal_integrity.sql`, which closes the SIFR, checklist and first-clock-action integrity defects documented in the release note.

The later component split is a **client-structure refinement within the same T13.3.13 source candidate**. It adds no further migration, changes no RPC signature, and does not alter RLS, role definitions, POS payment authority or Academy grading authority.

The goal is deliberately small-business focused:

- make each employee workflow easier to understand and change;
- prevent unrelated staff screens from rerendering together;
- preserve all staff routes, controls and authoritative server operations;
- keep route-level draft lifetime simple and explicit;
- avoid new state frameworks, routers or data abstractions.

## Honest size result

The root controller became much smaller, but the total StaffPortal implementation did not shrink by the same amount.

| Measurement | Integrity baseline | Current source |
|---|---:|---:|
| `src/components/StaffPortal.tsx` | 3,131 lines | 358 lines |
| Existing/extracted staff modules | 74 lines | 3,332 lines |
| Complete StaffPortal module | 3,205 lines | 3,690 lines |

The root controller is approximately **88.6% smaller**. The Complete StaffPortal module is approximately **15.1% larger** because implicit inline responsibilities are now represented by explicit component interfaces, types, a pure rota/earnings model, timer isolation and security comments.

This is a reduction in **coupling and state ownership**, not a claim that nearly 90% of the product code disappeared.

## Component ownership

| Owner | Responsibility | Local state lifetime | Authoritative writes |
|---|---|---|---|
| `StaffPortal.tsx` | Authentication-aware shell, hydration banners, current store, business date and active panel selection | Current staff route | None |
| `staff/StaffAuthPanel.tsx` | Sign-in, recovery and MFA ceremony | Current auth/MFA route and security scope | Existing Supabase Auth callbacks |
| `staff/StaffDashboardPanel.tsx` | Clock, rota, cover board, timesheets and earnings presentation | Current Dashboard route | Existing clock and cover RPC callbacks |
| `staff/StaffClockTicker.tsx` | Store clock and active-duty timer | Current Dashboard route | None |
| `staff/StaffChecklistPanel.tsx` | Checklist category, comments and hydrated task presentation | Current Checklist route | Existing atomic checklist callbacks |
| `staff/StaffAcademyPanel.tsx` | Course viewer, lesson position and assessment attempt | Current Academy route | Existing server grading/completion callback |
| `staff/StaffDocumentsPanel.tsx` | Document form, selected file and secure preview UI | Current Documents route | Existing private upload and signed-URL paths |
| `staff/StaffSifrPanel.tsx` | Sensitive-report and permitted management-reply drafts | Current SIFR route | Existing narrow SIFR RPC callbacks |
| `staff/StaffKnowledgeBasePanel.tsx` | Search, category filter and article presentation | Current Knowledge Base route | None |
| `staff/staffDashboardModel.ts` | Pure store-time rota, cover, timeline, timesheet and earnings projections | No React state | None |

## State-lifetime policy

Staff routes are active-route mounted. `App.tsx` keys the route container to `currentTab`, so changing staff tabs destroys the previous StaffPortal instance and mounts the selected route cleanly.

Therefore unfinished local UI state is deliberately discarded when the employee changes staff routes, including:

- Academy lesson position and unsubmitted answers;
- an unfinished SIFR draft;
- a selected document upload;
- unsaved checklist comments;
- Dashboard filters and cover-request text;
- Knowledge Base search text.

This matches the original route-level lifetime and is the simplest safe policy for one store. It avoids keeping hidden videos, file inputs, forms, timers or background effects alive. No sensitive draft is written to `localStorage` or `sessionStorage`.

The complete portal is also destroyed when the authenticated identity or MFA ceremony changes because `App.tsx` keys `StaffPortal` to that security scope. This prevents one employee's MFA, document, incident or Academy state from crossing into another session.

The Web Till remains active-route mounted. Employees should not navigate away during an unfinished sale.

Preserving selected drafts across routes would be a separate feature. It would require explicit lifted state or a dedicated session-scoped draft controller, video/polling pause rules and browser lifecycle tests. It is not part of this small-business release.

## Behaviour and authority preserved

The structural refactor does not change:

- Supabase Auth, recovery or MFA callbacks;
- clock, cover, checklist or SIFR RPC signatures;
- RLS, role or store boundaries;
- Academy grading, certificate or reward transactions;
- private document storage and short-lived signed URL rules;
- POS quote, reservation, finalisation or recovery lifecycle;
- staff route names;
- server/browser audit and notification ownership.

Server-authoritative operations remain server-authoritative. Extracted components receive the same narrow callbacks previously used by the root controller.

The parity audit mapped all **9 staff routes**, **21 active callbacks** and **31 workflow handlers** into the bounded components. The interactive surface remained **49 buttons, 3 forms, 11 inputs, 3 selects, 5 textareas and 47 click handlers**. Browser execution is still required to prove rendered parity.

## Corrections included

The integrity and structural work corrects these proven issues:

- employee-local state is destroyed on account or MFA-ceremony replacement;
- SIFR identity/store stamping and replies/status transitions are server-owned;
- checklist completion and first-ever clock serialization are enforced server-side;
- the entire portal no longer rerenders once per second;
- operational time is displayed as store time;
- Dashboard timers exist only while the Dashboard route is mounted;
- empty selected rota days render an honest empty state;
- invalid, expired, orphaned or cross-store cover adverts are excluded;
- overnight timeline bars cannot extend beyond the visible range;
- earnings month boundaries follow the store timezone;
- seven unused StaffPortal inputs were removed;
- employee-facing labels use direct small-store language.

## Performance claims

### Structurally proven

- the root no longer owns a one-second timer;
- second-level clock updates are confined to `StaffClockTicker`;
- leaving Dashboard unmounts its timers and rendered tree;
- typing in Academy, SIFR, documents, checklists or Knowledge Base updates only the owning bounded panel;
- rota and earnings use one pure derived model rather than repeated JSX filtering;
- inactive staff panels do not remain in the DOM.

### Expected but not yet browser-profiled

- lower render work during form entry and staff-tab use;
- easier React reconciliation due to smaller ownership boundaries;
- easier future debugging and code review.

No React Profiler comparison or production bundle analysis has been completed. The panels are statically imported, so this refactor is **not lazy bundle splitting** and does not claim a smaller initial JavaScript download.

## Verification

Source-level verification includes:

- `npm run test:staff-portal-integrity`;
- `npm run test:staff-dashboard`;
- `npm run test:p0-source`;
- security, operational, launch-honesty, small-business and opening regressions;
- isolated TypeScript/TSX transpilation;
- extracted-ZIP source hash and migration/function inventory verification.

The official locked dependency install, semantic TypeScript check, Vite build, ESLint, Playwright and physical Safari/browser parity remain mandatory external release gates.

## Safe extension rules

When adding a staff feature:

1. keep local form/filter/display state inside the bounded panel that owns it;
2. use a narrow callback or RPC for business mutations—do not give a panel generic table-write authority;
3. assume unfinished local state resets when the employee changes staff routes;
4. add explicit session-scoped preservation only when there is a demonstrated operational need and browser lifecycle coverage;
5. never persist MFA secrets, SIFR drafts, Academy answers or selected documents in browser storage;
6. update location-sensitive tests to inspect the exact new owner rather than weakening assertions to a repository-wide search;
7. do not add Redux, Zustand, React Query or a new router without a concrete operational need.

## Intentional stopping point

`StaffDashboardPanel` and `StaffAcademyPanel` remain the largest bounded panels. Their current state is cohesive, and splitting them further without an official browser build would add prop plumbing and indirection without a proven benefit for one store.

The current architecture is therefore the intended simple boundary: one small shell, explicit domain owners, pure derived models, active-route state lifetime and existing server-authoritative operations.
