#!/usr/bin/env node
/**
 * css-assets.test.mjs — WP-04 build gate.
 *
 * The old stylesheet declared @font-face sources for four files that were
 * never in the repo, producing four PERMANENT build warnings that everyone
 * had learned to scroll past — the exact "boy who cried wolf" state that
 * lets a real missing asset ship unnoticed. This test makes the class of
 * failure impossible: every root-relative url() in the source stylesheets
 * must resolve to a real file under public/. Zero warnings is now the
 * asserted baseline, not an aspiration.
 *
 * Run: node scripts/css-assets.test.mjs   (wired into `npm run verify`)
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

let passed = 0, failed = 0;
const check = (n, cond, d = '') => {
  if (cond) { passed++; console.log(`\u2714 ${n}`); }
  else { failed++; console.error(`\u2716 ${n}\n    ${d}`); }
};

// Collect every .css under src/ (today that is src/index.css; tomorrow-proof).
const cssFiles = [];
(function scan(dir) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) scan(full);
    else if (extname(full) === '.css') cssFiles.push(full);
  }
})('src');

check('at least one stylesheet found under src/', cssFiles.length > 0, 'no CSS files');

const URL_RX = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
let refs = 0;
for (const file of cssFiles) {
  const css = readFileSync(file, 'utf8');
  for (const m of css.matchAll(URL_RX)) {
    const ref = m[1].trim();
    // External and inline refs are not files we ship.
    if (/^(https?:|data:|#)/.test(ref)) continue;
    refs++;
    const clean = ref.split(/[?#]/)[0];
    const target = clean.startsWith('/') ? join('public', clean) : join('public', '/', clean);
    check(`${file}: url(${ref}) resolves`, existsSync(target), `expected file at ${target}`);
  }
}
check('stylesheets reference at least the self-hosted fonts', refs >= 7, `only ${refs} local url() refs found — the @font-face block may have been removed`);

// The GDPR half of WP-04: no third-party font CDN anywhere in the shell.
const html = readFileSync('index.html', 'utf8');
check('index.html has no fonts.googleapis / fonts.gstatic links',
  !/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(html), 'Google Fonts CDN reference present');
const headers = readFileSync('public/_headers', 'utf8');
check("_headers CSP: font-src is 'self' only",
  /font-src 'self';/.test(headers) && !/fonts\.gstatic\.com/.test(headers),
  'CSP still admits a third-party font host');

console.log(`\nCSS ASSETS — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
