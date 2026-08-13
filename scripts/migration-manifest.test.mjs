#!/usr/bin/env node
/* ============================================================================
 * MILK POP — MIGRATION MANIFEST INTEGRITY (OPT-01.1 §4)
 *
 * The migration order lives in exactly ONE place: launch/migration-manifest.sh.
 * This test fails when the manifest and reality drift:
 *   • a production migration file exists on disk but is missing from the chain;
 *   • a manifest entry does not exist on disk;
 *   • any file appears more than once, or is misclassified;
 *   • a local test fixture (seed.dev.sql) or a stray file sneaks into a
 *     production path;
 *   • the fresh / upgrade / baseline consumers disagree about the order;
 *   • the documented migration list (docs/PATCH-PHASE-REPORT.md, if it pins
 *     one) diverges from the manifest.
 * ==========================================================================*/
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(root, 'launch/migration-manifest.sh');
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log(`✔ ${n}`); };
const bad = (n, d) => { failed++; console.log(`✖ ${n}${d ? `\n    ${d}` : ''}`); };
const check = (n, c, d) => (c ? ok(n) : bad(n, d));

const runManifest = (mode) =>
  execFileSync('bash', [MANIFEST, mode], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);

check('manifest file exists', existsSync(MANIFEST));

const fresh = runManifest('fresh');
const upgrade = runManifest('upgrade');
const migrations = runManifest('migrations');
const baseline = runManifest('baseline');
const future = runManifest('future');

// upgrade and migrations are the same list (the chain); fresh = schema+seed+chain.
check('upgrade order == migration chain', JSON.stringify(upgrade) === JSON.stringify(migrations),
  'upgrade and migrations modes disagree');
check('fresh order = schema.FRESH-INSTALL-ONLY.sql, seed.sql, then the chain (in that order)',
  fresh[0] === 'supabase/schema.FRESH-INSTALL-ONLY.sql' && fresh[1] === 'supabase/seed.sql'
    && JSON.stringify(fresh.slice(2)) === JSON.stringify(migrations),
  `fresh head: ${fresh.slice(0, 2).join(', ')}`);

// Upgrade path must NEVER contain the clean-slate schema or the public seed.
check('upgrade path excludes schema.FRESH-INSTALL-ONLY.sql and seed.sql',
  !upgrade.includes('supabase/schema.FRESH-INSTALL-ONLY.sql') && !upgrade.includes('supabase/seed.sql'));

// OPT-01.2A §1 — the chain = the IMMUTABLE historical baseline followed by the
// APPEND-ONLY future section. Phase B is the last BASELINE migration (it locks
// the public forms); genuinely new migrations run AFTER it, so a future file is
// no longer forced to be dead last in the whole chain (which contradicted the
// runner + adoption test).
check('migration_phase_b_public_forms.sql is LAST in the immutable baseline',
  baseline[baseline.length - 1] === 'supabase/migration_phase_b_public_forms.sql');
check('chain = baseline followed by the future section (append-only)',
  JSON.stringify(migrations) === JSON.stringify([...baseline, ...future]),
  `chain does not equal baseline+future`);
check('future migrations only ever APPEND after the baseline',
  future.every((f) => !baseline.includes(f)),
  `a future entry duplicates a baseline entry: ${future.filter((f) => baseline.includes(f)).join(', ')}`);
// The baseline order is FROZEN: its fingerprint is pinned here. Reordering,
// inserting into, or removing from the baseline changes this hash and fails the
// build — new work must go in MP_FUTURE_MIGRATIONS. (Editing an already-applied
// file is separately caught by the runner's checksum guard.)
const BASELINE_FINGERPRINT =
  'ad03ec0285160042436187088b09426f47ace773d6d64aa249992f3fc3cff306';
const baselineFp = createHash('sha256').update(baseline.join('\n') + '\n').digest('hex');
check('immutable baseline order is unchanged (pinned fingerprint)',
  baselineFp === BASELINE_FINGERPRINT,
  `baseline fingerprint ${baselineFp} != pinned ${BASELINE_FINGERPRINT} — the frozen historical order changed; append to MP_FUTURE_MIGRATIONS instead`);

// No duplicates anywhere.
const dupOf = (arr) => arr.filter((x, i) => arr.indexOf(x) !== i);
check('no duplicate entries in the chain', dupOf(migrations).length === 0, dupOf(migrations).join(', '));
check('no duplicate entries in the fresh order', dupOf(fresh).length === 0, dupOf(fresh).join(', '));

// Every production migration_*.sql on disk appears exactly once in the chain.
const disk = readdirSync(path.join(root, 'supabase'))
  .filter((f) => f.startsWith('migration_') && f.endsWith('.sql'))
  .map((f) => `supabase/${f}`).sort();
const missing = disk.filter((f) => !migrations.includes(f));
const stale = migrations.filter((f) => !disk.includes(f));
check('every on-disk production migration is in the chain', missing.length === 0,
  `missing from manifest: ${missing.join(', ')}`);
check('every chain entry exists on disk', stale.length === 0,
  `in manifest but not on disk: ${stale.join(', ')}`);
check('chain count equals on-disk migration count', migrations.length === disk.length,
  `chain=${migrations.length} disk=${disk.length}`);

// Local/dev fixtures must NEVER appear in any production path.
const FORBIDDEN = ['supabase/seed.dev.sql'];
for (const f of FORBIDDEN) {
  check(`fixture ${path.basename(f)} is absent from every production path`,
    !fresh.includes(f) && !upgrade.includes(f) && !migrations.includes(f));
}

// §4 hazard: a doc maintaining its OWN copy of the migration list, which then
// drifts from the manifest. The fix is that no deployment doc enumerates the
// chain — they point at the manifest/runner. Enforce that: a doc that lists a
// large fraction of the chain has re-introduced a hand-maintained list and
// must be pointed back at launch/migration-manifest.sh. (Scattered prose
// mentions — e.g. "Phase B is always last" — are fine.)
const LIST_REINTRODUCED = Math.ceil(migrations.length / 3); // ~13 of 38
for (const rel of ['docs/PATCH-PHASE-REPORT.md', 'OWNERS-GUIDE.md', 'docs/HOSTING.md', 'README.md']) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) continue;
  const refs = new Set([...readFileSync(abs, 'utf8').matchAll(/(migration_[a-z0-9_]+\.sql)/g)]
    .map((m) => `supabase/${m[1]}`)
    .filter((f) => existsSync(path.join(root, f))));
  check(`${rel} does not re-introduce a hand-maintained migration list`,
    refs.size < LIST_REINTRODUCED,
    `references ${refs.size} chain migrations (≥ ${LIST_REINTRODUCED}) — point it at the manifest instead`);
}

console.log(`\nMIGRATION MANIFEST INTEGRITY — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
