#!/usr/bin/env node
/**
 * headers-smoke.live.mjs — WP-03 deployment gate.
 *
 * Fetches the DEPLOYED site and asserts the security-header contract that
 * public/_headers promises actually reached the edge. Run after every deploy:
 *
 *   STAGING_URL=https://<site>.netlify.app node scripts/headers-smoke.live.mjs
 */

const base = (process.env.STAGING_URL || '').replace(/\/$/, '');
if (!base) { console.error('✖ STAGING_URL is required.'); process.exit(1); }

let passed = 0, failed = 0;
const check = (n, cond, d = '') => {
  if (cond) { passed++; console.log(`\u2714 ${n}`); }
  else { failed++; console.error(`\u2716 ${n}\n    ${d}`); }
};

async function headersOf(path) {
  const res = await fetch(base + path, { redirect: 'manual' });
  return { status: res.status, h: res.headers };
}

// --- / -----------------------------------------------------------------
const root = await headersOf('/');
check('/ responds 200', root.status === 200, `status ${root.status}`);
const csp = root.h.get('content-security-policy') || '';
check('/ has a Content-Security-Policy', csp.length > 0, 'header missing');
check("CSP: default-src 'self'", /default-src 'self'/.test(csp), csp.slice(0, 120));
check('CSP: frame-ancestors none (clickjacking)', /frame-ancestors 'none'/.test(csp), 'frame-ancestors missing');
check('CSP: admits Turnstile (script-src + frame-src challenges.cloudflare.com)',
  /script-src[^;]*challenges\.cloudflare\.com/.test(csp) && /frame-src[^;]*challenges\.cloudflare\.com/.test(csp),
  'Turnstile hosts missing — enabling CAPTCHA would break the widget');
check('CSP: admits Supabase (connect-src *.supabase.co)', /connect-src[^;]*supabase\.co/.test(csp), 'Supabase connect-src missing');
check('HSTS present with preload', /max-age=\d+.*includeSubDomains.*preload/i.test(root.h.get('strict-transport-security') || ''), root.h.get('strict-transport-security') || 'missing');
check('X-Frame-Options: DENY', (root.h.get('x-frame-options') || '').toUpperCase() === 'DENY', root.h.get('x-frame-options') || 'missing');
check('X-Content-Type-Options: nosniff', (root.h.get('x-content-type-options') || '').toLowerCase() === 'nosniff', root.h.get('x-content-type-options') || 'missing');
check('Referrer-Policy: strict-origin-when-cross-origin', /strict-origin-when-cross-origin/.test(root.h.get('referrer-policy') || ''), root.h.get('referrer-policy') || 'missing');

// --- /staff and /admin: session-gated app screens must be noindex --------
for (const path of ['/staff', '/admin']) {
  const r = await headersOf(path);
  check(`${path} carries X-Robots-Tag noindex`, /noindex/.test(r.h.get('x-robots-tag') || ''), r.h.get('x-robots-tag') || 'missing');
}

// --- SPA fallback ---------------------------------------------------------
const deep = await headersOf('/definitely-not-a-real-page-xyz');
check('SPA fallback serves the shell with 200 (netlify.toml redirect)', deep.status === 200, `status ${deep.status}`);

// --- Hashed build assets are immutable-cached ------------------------------
// Discover a real hashed asset from the served shell (filenames change every
// build, so the smoke must not hard-code one), then assert the cache contract.
const shellHtml = await (await fetch(base + '/')).text();
const assetPath = (shellHtml.match(/\/assets\/[A-Za-z0-9._-]+\.js/) || [])[0];
check('shell references a hashed /assets/ bundle', Boolean(assetPath), 'no /assets/*.js found in served HTML');
if (assetPath) {
  const asset = await headersOf(assetPath);
  const cc = asset.h.get('cache-control') || '';
  check('/assets/* served with immutable year-long cache', /max-age=31536000/.test(cc) && /immutable/.test(cc), cc || 'missing');
}

console.log(`\nHEADERS SMOKE — ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
