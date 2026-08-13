# Native iPad till — boundary, status vocabulary and compatibility contract (R4.8, Workstream I)

## What this archive does and does not contain

This website archive contains **no native till deliverable**: no iOS/Xcode
project, no Capacitor configuration, no signed app, no native source. Any
earlier wording implying the native till ships with this package was wrong and
is superseded by this document. The native till, if required, is a **separate
artefact** that must be supplied, audited and commissioned on its own — it is
outside the truthful completion claim of this website-only release.

## The web till is online-only

The built-in web till (`/staff` → Sales POS) is **connectivity-dependent**:

* Pricing, VAT state, quotes, payment reservation and finalisation are
  server-authoritative. Without a connection the till must not record sales.
* There is **no** offline-first capability and none is faked via browser
  caching. Local computations that exist (e.g. VAT display fallback) are
  display fallbacks only — the server wins whenever it has spoken, and sales
  cannot finalise without it.
* Outage procedure (runbook §Outage): stop taking card-present orders through
  the till; use the paper fallback sheet; reconcile through payment recovery
  when connectivity returns; ambiguous payments surface in the recovery queue
  and Operational Health — they are never silently dropped.

## Integration status vocabulary (used by Operational Health)

| Status | Meaning |
|---|---|
| **Not supplied** | No native artefact exists in this deployment. |
| **Not commissioned** | Artefact exists but no device has been paired (`pos_devices` empty). |
| **Connected** | ≥1 paired, un-revoked device; recent sync unknown/stale. |
| **Compatibility mismatch** | A paired device declared an unsupported contract version and was refused. |
| **Healthy** | Paired device(s) with recent successful sync. |

The admin dashboard's Operational Health panel derives the device signal from
`pos_devices` and reports **not_commissioned / unknown** when no devices exist
— never an implied green. The native ledger is shown only where ingested rows
actually exist (`pos_orders`).

## Version / compatibility contract

Every release records, in `release-manifest.json`:

| Field | Source |
|---|---|
| `release_version` | package.json (4.8.0) |
| `migration_fingerprint` | sha256 over the ordered migration chain (manifest generator) |
| `pos_schema_version` | `SYNC-CONTRACT.md` version constant |
| `min_native_app_version` | set at native commissioning; **unset = native path refused** |

`pos-ingest` already authenticates devices and validates the wire contract;
an incompatible or undeclared client version must be refused, surfacing as
**Compatibility mismatch**, not silently accepted. (The refusal path is part
of the native commissioning work — see the closure report classification.)

## Decision boundary

* **Launch with web till only (current honest state):** document online-only
  operation, outage fallback, recovery reconciliation and end-of-day close —
  all present in PRODUCTION-LAUNCH-RUNBOOK-v4.8.md.
* **Launch requiring the native till:** obtain the native artefact separately;
  audit it separately; commission devices against the contract above. Until
  then, all surfaces must (and now do) describe it as **Not supplied**.
