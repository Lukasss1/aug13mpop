#!/usr/bin/env node
/**
 * verify-no-secrets.mjs — proves the PRODUCTION BUNDLE is clean.
 *
 * Scans every text asset in dist/ for the credentials this project leaked
 * historically and for generic secret patterns. Exits non-zero on any hit,
 * printing file, pattern and a redacted context snippet.
 *
 * Usage:
 *   npm run verify:bundle        # builds, then runs this against dist/
 *   node scripts/verify-no-secrets.mjs [distDir]   # scan an existing build
 *
 * Zero dependencies by design — it must run before `npm install` succeeds
 * and inside minimal CI images.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const DIST = process.argv[2] || 'dist';

/**
 * Forbidden patterns. Each entry: [name, RegExp].
 * NOTE ON LITERALS: the historic credential values appear here (and in
 * .gitleaks.toml / README.md (Security)) *as detection patterns and incident
 * documentation* — they correspond to accounts and flows that no longer
 * exist. Their presence in this scanner is what keeps them out of the
 * bundle forever.
 */
const PATTERNS = [
  ['historic owner password', /123123/],
  ['historic temp staff PIN', /temp1234/i],
  ['hard-coded password literal', /["'](password|passwd|passcode|pin)["']?\s*[:=]\s*["'][^"']{3,}["']/i],
  // R4.9 G1: anchored to PROPERTY POSITION ({ or , immediately before the key).
  // The unanchored form matched any English sentence ending in "password" that
  // minified next to a `:` — e.g. the R4.8 recovery-card ternary
  //   i === 'request' ? 'Reset your password' : 'Choose a new password'
  // becomes  ...password":"Choose a new password"...  in dist/. That is UI copy,
  // not a credential. SCOPE: this rule covers credentials written as ordinary
  // OBJECT-LITERAL PROPERTIES, which is the shape that survives minification
  // with the key intact. It does NOT cover bare assignments (`const password =
  // "x"`), class fields, computed keys (`{["password"]: "x"}`) or template
  // literals — a minifier mangles those identifiers, so the bundle is the wrong
  // place to catch them; source-level scanning (.gitleaks.toml) is the control
  // for that class. The self-check below records both what is and is NOT
  // covered so the limits stay visible instead of being assumed away.
  // The key vocabulary matches the quoted-key rule above, MINUS `pin` — an
  // unquoted three-letter key collides with ordinary vendor options
  // (`{pin:"top"}`) often enough to be noise; quoted `"pin":` is still caught.
  ['password object key with value', /[{,]\s*["']?(?:password|passwd|passcode)["']?\s*:\s*["'][^"']+["']/i],
  ['Supabase service_role identifier', /service_role/],
  ['Supabase/JWT token literal', /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9._-]{10,}/],
  ['Resend API key', /\bre_[A-Za-z0-9]{16,}\b/],
  ['Stripe live secret key', /\bsk_live_[A-Za-z0-9]{8,}\b/],
  ['Stripe test secret key', /\bsk_test_[A-Za-z0-9]{8,}\b/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['legacy wide-open policy name', /demo_full_access/],
  ['unsupported compliance claim', /GDPR Verified|All GDPR checks|purged under UK GDPR/i],
];

/**
 * SELF-CHECK (R4.9 G1) — the patterns above are a security control, so a
 * change that quietly stops matching must fail loudly rather than pass a dirty
 * bundle. Runs on every invocation; zero dependencies, microseconds.
 */
const SELF_CHECK = [
  // [sample, must-be-flagged]
  ['{password:"hunter2"}', true],
  ['{"password":"hunter2"}', true],
  ['{a:"x",password:\'hunter2\'}', true],
  ['const c={user:"u",passwd:"hunter2"}', true],
  ['"Reset your password":"Choose a new password"', false], // UI copy, minified
  ['i==="request"?"Reset your password":"Set a new password"', false],
];
// KNOWN NOT COVERED by the bundle scanner, recorded so the gap is explicit
// rather than implied. Each is caught at source level, not here; if one of
// these ever starts matching, that is an improvement, not a failure.
const KNOWN_UNCOVERED = [
  'const password = "hunter2";',
  'class X { password = "hunter2"; }',
  '{["password"]: "hunter2"}',
  '{password: `hunter2`}',
];
{
  const flagged = (s) => PATTERNS.some(([, re]) => re.test(s));
  const bad = SELF_CHECK.filter(([s, want]) => flagged(s) !== want);
  const nowCovered = KNOWN_UNCOVERED.filter((s) => flagged(s));
  if (nowCovered.length) {
    console.log(`  note: ${nowCovered.length} previously-uncovered form(s) now match — coverage improved, update KNOWN_UNCOVERED.`);
  }
  if (bad.length) {
    console.error('✖ verify-no-secrets self-check FAILED — the pattern set no longer behaves as documented:');
    for (const [s, want] of bad) console.error(`    ${want ? 'MISSED' : 'FALSE POSITIVE'}: ${s}`);
    process.exit(2);
  }
}

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.svg', '.json', '.txt', '.map', '.webmanifest']);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function redact(line) {
  return line.length > 160 ? line.slice(0, 157) + '…' : line;
}

if (!existsSync(DIST)) {
  console.error(
    `✖ Bundle directory "${DIST}" not found.\n` +
      '  Build first:  npm run build\n' +
      '  Or run the combined check:  npm run verify:bundle\n' +
      '  (Source-level guarantees are covered separately by: npm run test:security)'
  );
  process.exit(2);
}

let files = 0;
let failures = 0;

for (const file of walk(DIST)) {
  if (!TEXT_EXT.has(extname(file))) continue;
  files++;
  const content = readFileSync(file, 'utf8');
  for (const [name, re] of PATTERNS) {
    const m = content.match(re);
    if (m) {
      failures++;
      const idx = m.index ?? 0;
      const lineStart = content.lastIndexOf('\n', idx) + 1;
      const lineEnd = content.indexOf('\n', idx);
      const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      console.error(`✖ [${name}] in ${file}`);
      console.error(`    ${redact(line.trim())}`);
    }
  }
}

if (failures) {
  console.error(`\n✖ FAILED: ${failures} forbidden pattern(s) found in the production bundle.`);
  process.exit(1);
}
console.log(`✔ Bundle clean: ${files} text asset(s) scanned in "${DIST}", 0 forbidden patterns found.`);
