#!/usr/bin/env node
/**
 * ============================================================================
 *  R4.10 INCREMENT 4 — HARNESS SHIM PARITY
 * ============================================================================
 *
 *  THE EXIT CRITERION
 *    "A public-access regression is visible to every relevant database suite,
 *     not only four of ten."
 *
 *  WHY
 *  ---
 *  The deployment audit measured a split. Four harnesses mirrored Supabase's
 *  real default privileges, in which anon and authenticated are granted on new
 *  tables and RLS is the actual gate. The other nine granted tables only to
 *  service_role. A suite on the restrictive shim starts from a MORE locked-down
 *  database than production: it can prove an explicit REVOKE worked, but it can
 *  never detect a relation left readable by ambient grant. That asymmetry is why
 *  a wide anonymous read surface survived 1,606 passing assertions.
 *
 *  Consolidating them surfaced two further disagreements that had nothing to do
 *  with privileges and everything to do with the same root cause:
 *    • identity was injected through DIFFERENT session variables — some set
 *      `request.jwt.claim.sub`, others the whole `request.jwt.claims` blob (what
 *      PostgREST actually does). A harness honouring only one returns NULL for
 *      the other, and every ownership check evaluated against it quietly changes
 *      meaning.
 *    • only the RLS matrix defined auth.role().
 *  Both are now reconciled inside the one shared file.
 *
 *  This suite is the ratchet that keeps them together: it reads every database
 *  harness and fails if one grows its own privilege setup again.
 *
 *  Run:  npm run test:r410-shim-parity
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIM_REL = 'lib/supabase-local-privileges.sql';
const SHIM_ABS = path.join(ROOT, 'scripts', SHIM_REL);

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed += 1; console.log(`  \u2714 ${label}`); }
  else { failed += 1; failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  \u2716 ${label}${detail ? ` — ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

/**
 * Files allowed to carry their own privilege setup, each with a stated reason.
 * An exemption is a decision, not a loophole — anything not listed here must use
 * the shared file.
 */
const EXEMPT = {
  'scripts/lib/supabase-local-privileges.sql':
    'IS the shared shim.',
  'scripts/pos-live-smoke-prelude.sql':
    'Prelude for the LIVE POS smoke test, which runs against a real Supabase project rather than a local cluster — it configures a session, not a test database.',
  'scripts/pos-local-e2e/prelude-rest.sql':
    'Standalone local POS end-to-end rig with its own PostgREST container; it is not part of the migration/RLS suite set and does not assert the anonymous surface.',
};

/* ------------------------------------------------------------------ */
/*  Discover every harness that stands up a database.                   */
/* ------------------------------------------------------------------ */

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(sh|mjs|sql|ts)$/.test(entry)) out.push(p);
  }
  return out;
}

// A "database harness" is any file that stands up a Milk Pop database: it either
// executes the shared shim, or it drives psql against the authoritative migration
// manifest, or it still provisions the API roles itself (which is precisely what
// this suite is here to catch). Discovering them by behaviour rather than from a
// hand-kept list means a new harness is covered the day it is written.
//
// NOTE: the first signal used to be `create role anon` alone. That stopped
// working the moment the harnesses were repointed — they no longer contain it —
// and the suite silently discovered 4 files instead of 15. A discovery rule that
// depends on the thing being removed is not a discovery rule.
const HARNESS_SIGNALS = [
  new RegExp(SHIM_REL.replace(/[/.]/g, '\\$&')),
  /create role anon/,
  /rolname\s*=?\s*'anon'/,
];
// Reading the manifest is not the same as standing up a database. A harness
// CREATES one; a contract test merely inspects files. Require both signals.
const DRIVES_CHAIN = (text) =>
  /migration-manifest/.test(text) && /create database|createdb|initdb/i.test(text);
// This suite reads the patterns it searches for, so it matches itself. Exclude it.
const SELF = 'scripts/r410-harness-shim-parity.mjs';
// Anchored to the START of a line so this matches EXECUTABLE SQL, not prose.
// The first version matched any mention of the phrase and flagged
// stage3-build-baseline.sh for a sed filter and an echoed comment — a false
// positive that would have trained someone to add an exemption for a file that
// never had a problem.
const PRIVILEGE_SETUP = [
  /^\s*alter default privileges/im,
  /^\s*create role (anon|authenticated|service_role)/im,
  /^\s*do \$\$?\w*\$? begin[\s\S]{0,200}create role anon/im,
];

async function main() {
  console.log('R4.10 HARNESS SHIM PARITY');
  console.log('=========================');

  const files = walk(path.join(ROOT, 'scripts'))
    .map((f) => path.relative(ROOT, f))
    .filter((rel) => {
      if (rel === SELF) return false;
      const text = readFileSync(path.join(ROOT, rel), 'utf8');
      return HARNESS_SIGNALS.some((re) => re.test(text)) || DRIVES_CHAIN(text);
    })
    .sort();

  console.log(`\n  discovered ${files.length} files that provision the API roles`);

  section('\u00a71  The shared shim exists and states the posture it mirrors');
  const shim = readFileSync(SHIM_ABS, 'utf8');
  check('scripts/lib/supabase-local-privileges.sql is present', shim.length > 0);
  check('it grants the ambient table defaults production has',
    /alter default privileges[\s\S]*?on tables to anon/i.test(shim),
    'without this the harnesses are more locked down than production');
  check('it grants USAGE on the auth schema',
    /grant usage on schema auth/i.test(shim),
    'replace_collection is SECURITY INVOKER; auth.jwt() runs as the caller');
  check('auth.uid() accepts the request.jwt.claims blob',
    /request\.jwt\.claims/.test(shim));
  check('auth.uid() also accepts the discrete request.jwt.claim.sub',
    /request\.jwt\.claim\.sub/.test(shim),
    'harnesses disagreed about this; the shim must honour both');
  check('auth.role() is defined', /function auth\.role\(\)/.test(shim));

  section('\u00a72  Every database harness executes the shared shim');
  for (const rel of files) {
    if (EXEMPT[rel]) continue;
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    check(`${rel} references the shared shim`, text.includes(SHIM_REL),
      'it still stands up its own database surface');
  }

  section('\u00a73  No harness carries its own privilege setup');
  for (const rel of files) {
    if (EXEMPT[rel]) continue;
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    const offending = PRIVILEGE_SETUP.filter((re) => re.test(text)).map(String);
    check(`${rel} has no local GRANT/REVOKE/role setup`, offending.length === 0,
      offending.join(' '));
  }

  section('\u00a74  Exemptions are declared, and only the declared ones exist');
  for (const [rel, reason] of Object.entries(EXEMPT)) {
    console.log(`     exempt: ${rel}`);
    console.log(`             ${reason}`);
  }
  const undeclaredExempt = files.filter((rel) => {
    if (EXEMPT[rel]) return false;
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    return PRIVILEGE_SETUP.some((re) => re.test(text));
  });
  check('no file carries privilege setup without being declared exempt',
    undeclaredExempt.length === 0, undeclaredExempt.join(', '));

  console.log('');
  if (failed === 0) console.log(`\u2714 R4.10 HARNESS SHIM PARITY — ${passed} passed, 0 failed`);
  else {
    console.log(`\u2716 R4.10 HARNESS SHIM PARITY — ${passed} passed, ${failed} FAILED`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`\u2716 parity error: ${e.message}`); process.exit(1); });
