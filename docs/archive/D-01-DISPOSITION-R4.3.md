# D-01 DISPOSITION — dependency advisories against the frozen R4.3 lockfile

Per Addendum A1 §5.1. Mechanical evidence produced by `dep-triage.sh` on a
verified extraction of `038d873c…`; files listed at the end.

## Audit result

`npm ci` at audit time (2026-07-24 19:53 UTC) reported **1** high advisory;
the same frozen lockfile audited on 2026-07-25 reports **6** — the advisory
database moved overnight (the brace-expansion OOM and postcss advisories).
This is why the gate pins `npm-audit.json`, never the ci summary line.

| Advisory | Path into the tree | Disposition |
|---|---|---|
| postcss ≤8.5.17 — path traversal via `sourceMappingURL` auto-loading (GHSA-r28c-9q8g-f849) | `vite@6.4.3 → postcss@8.5.15` | **FIXED**: postcss → 8.5.23, in-range, lockfile-only (`npm audit fix`, non-forced); nanoid bumped as its transitive |
| brace-expansion DoS (unbounded expansion → OOM) — v5 line | `typescript-eslint → typescript-estree → minimatch@10 → brace-expansion@5.0.7` | **FIXED**: 5.0.8, in-range |
| brace-expansion DoS — v1 line, plus its dependents minimatch@3, `@eslint/config-array`, `@eslint/eslintrc`, eslint | `eslint@9.39.5` config machinery (`minimatch@3.1.5 → brace-expansion@1.1.16`) | **FORMALLY DEFERRED** — the 5 remaining highs; no in-range fix exists, npm's only fix is `eslint@10.8.0` (semver-major) |

## Reachability

Every flagged node is lint-toolchain or build-time only. None appears in the
shipped `dist/` output (the bundle scan is the cross-check at G2/G6). The
exploit precondition for the deferred set is attacker-controlled glob/pattern
input reaching the linter **in the development environment**; the production
site never executes any of this code.

## Deferral rationale and compensating control

Adopting eslint 10 is a semver-major toolchain migration: config and rule
churn that would disturb the 239-warning ratchet baseline and widen this
round's delta far beyond the two payment findings. It is scheduled with the
plan-C source-cleanup round (new SHA, after F-01/F-02 close), where rule
churn belongs. Until then: lint runs only on trusted repository content in
dev/CI; no untrusted input reaches minimatch; the advisory class (resource
exhaustion of the lint process) cannot touch production or customer data.

## Evidence trail

`analysis/npm-audit.json` + `npm-audit-summary.txt` + `npm-ls-paths.txt`
(frozen lockfile, pre-fix) · `analysis/npm-audit-after-fix.json` (post-fix:
5 high, all eslint-chain) · `logs/npm-ci.log` (§5.2 format) · lockfile diff
= exactly three nodes, `package.json` byte-identical.
