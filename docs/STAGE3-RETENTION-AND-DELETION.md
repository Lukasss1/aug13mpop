# STAGE 3 — RETENTION & DELETION MODEL (WS9)

One table; every future migration must conform. "Delete" = physical delete
by application roles. Status transitions in force: active/disabled (staff),
open/completed/refunded/voided (orders), open/closed (till shifts),
draft/sent (payslips), pending→…→declined (applications).

| Entity | Delete | Archive | Version | Keep forever |
|---|---|---|---|---|
| Orders + lines/modifiers | ❌ (no browser path; FK-anchored) | status voided/refunded | immutable snapshots | ✅ |
| POS orders/refunds/voids/corrections/cash movements | ❌ | via sealed shift | pence snapshots | ✅ |
| POS shifts | ❌ | sealed at close (trigger) | — | ✅ |
| Payslips (issued) | ❌ (owner-only writes; period-unique) | status sent | regeneration updates draft in place | ✅ |
| Clock history / timesheets | ❌ factual rows and terminal decisions are database-immutable | server-owned approve/reject command | — | ✅ |
| Staff with history | ❌ (RESTRICT, proven) | status disabled | — | ✅ |
| Stores with transactions | ❌ (RESTRICT, proven) | — | name snapshots on rows | ✅ |
| Audit / activity logs | ❌ (append-only, no grants) | — | — | ✅ |
| Applications + CVs | controlled retention deletion (WS9 RPC: metadata + storage object together) | status declined | — | ❌ (GDPR clock) |
| Contact / franchise messages | controlled retention deletion | — | — | ❌ |
| Draft CMS content | ✅ allowed | published snapshots kept | publish pipeline | drafts ❌ |
| Unused media | controlled deletion (reference-checked via media_references) | — | — | ❌ |
| Training results/certificates | ❌ (FK-anchored; cert requires pass) | — | — | ✅ |

T13.3.19 additionally retains browser-dark staff-document deletion tombstones, owner-visible reconciliation states and scheduled operational evidence retention. Applicant/CV and media retention continue through their existing controlled cleanup queues.
