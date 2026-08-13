# Milk Pop — Operations Runbook (rollback & recovery)

Stage 9 (9.8) deliverable. Who does what when production misbehaves. All procedures assume owner access to the Netlify site, the Supabase project, and the GitHub repo.

## 1 · Roll back the frontend (minutes)
Netlify keeps every previous deploy immutable. **Netlify → Deploys → pick the last good deploy → "Publish deploy".** Instant, no rebuild, no data impact (the frontend is stateless). Roll forward again the same way. If the bad deploy came from a bad commit, also `git revert` it so CI/main stays truthful.

## 2 · Roll back Edge Functions (minutes)
Functions are versioned in git under `supabase/functions/`. `git revert <bad commit>` (or check out the last good tag), then `supabase functions deploy <name>` for each affected function. Functions are stateless; safe to redeploy any time. Undeployed/broken functions already **fail closed** in the app (404/501 → controlled error, security‑suite‑guarded), so a partial rollback does not corrupt state.

## 3 · Database migrations — forward-only + backup restore
The migration ledger (OPT‑01) is **forward-only by design**: `--db-upgrade` applies pending migrations under an advisory lock; there is no automatic down‑migration. Recovery options, in order of preference:
1. **Write a corrective forward migration** (new ledger entry that undoes the schema change). This is the normal path — it keeps the ledger truthful.
2. **Supabase point‑in‑time recovery / daily backup restore** (Supabase dashboard → Database → Backups) for data-destroying incidents. Restoring rewinds *data and schema together*; afterwards re‑run `--db-upgrade` to reach the intended ledger head, and re‑verify with the RLS/contract suites.
Never hand‑edit the ledger table; `--db-adopt-ledger` exists only for the one‑time pre‑ledger adoption.

## 4 · Disable a feature quickly (kill switches)
- **Gated features** (`media`, CV upload, legacy import): flip the env var in **Netlify → Site settings → Environment variables** (`VITE_MEDIA_V2`, `VITE_CAREERS_CV_UPLOAD`, `VITE_LEGACY_IMPORT`) and trigger a redeploy (~2 min). The UI degrades to its honest disabled state; the deployment validator enforces coherent pairings (R4/R7/R8).
- **Deferred features** are not routable at all (launch registry) — nothing to disable.
- **Whole‑site emergency**: publish a previous Netlify deploy (§1) or enable Netlify's password protection to take the site private while investigating.

## 5 · Restore from backup
Supabase: dashboard → Database → Backups → restore (PITR if enabled on the plan, otherwise the most recent daily). After any restore: run `npm run verify` suites that hit the DB in CI (`test:rls`, migration jobs) and spot-check one privileged flow per role. If POS is commissioned later, reconcile its ledger against the tablet's local day files under the separate POS runbook; it is not part of the public-web restore gate.

## 6 · Emergency access changes (who can, and how)
- **Disable a staff account instantly**: Admin → Staff Directory → set status `disabled` (server enforces on next request; access checks are server‑side/RLS, not UI‑side). For a compromised session, additionally revoke the user's sessions in Supabase → Authentication → Users → the user → "Sign out user" (refresh becomes invalid; the app's 401 path signs the tab out and broadcasts `SIGNED_OUT` to other tabs).
- **Compromised owner credentials**: reset the password in Supabase Auth, revoke sessions, rotate the anon key **only if leaked** (Settings → API) — rotating it requires a frontend redeploy with the new key.
- **Secrets rotation** (Resend, Turnstile secret): rotate at the provider → update the Supabase function secrets / Netlify env → redeploy functions. Nothing secret lives in the browser bundle (Stage 6 verified).

## 7 · Incident quick table
| Symptom | First move |
| --- | --- |
| Bad deploy / white screens | Publish previous Netlify deploy (§1) |
| Stale‑tab chunk errors after deploy | None needed — root error boundary shows "reload to update" |
| Form spam wave | Confirm Turnstile keys valid; tighten at Cloudflare; forms fail closed without a token |
| Function 5xx spike | Roll back functions (§2); app degrades with controlled errors |
| Data corruption | Stop writes (password‑protect site), restore backup (§5), corrective migration (§3) |
| Compromised staff account | Disable + revoke sessions (§6) |
