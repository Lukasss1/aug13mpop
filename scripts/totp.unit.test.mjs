#!/usr/bin/env node
/* ============================================================================
 * totp.unit.test.mjs — pins scripts/lib/totp.mjs to the RFC 6238 Appendix B
 * reference vectors (SHA-1, 8 digits, T0=0, X=30s, ASCII secret
 * "12345678901234567890" = base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ), plus the
 * 6-digit truncation and base32 robustness the live suites rely on. A drift
 * here would strand every MFA-verified live run, so it fails `npm run verify`
 * first.
 * ==========================================================================*/
import { totp, totpWindow, base32Decode } from './lib/totp.mjs';

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`\u2714 ${name}`); }
  else { failed++; console.log(`\u2716 ${name}${detail ? `\n    ${detail}` : ''}`); }
};

const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

check('base32 decodes the RFC secret to the ASCII key',
  base32Decode(RFC_SECRET_B32).toString('utf8') === '12345678901234567890');
check('base32 tolerates lowercase, spaces and padding',
  base32Decode('gezd gnbv GY3T QOJQ gezdgnbvgy3tqojq====').toString('utf8') === '12345678901234567890');
{
  let threw = false;
  try { base32Decode('GEZD1NBV'); } catch { threw = true; }  // '1' is not base32
  check('base32 rejects non-alphabet characters', threw);
}

// RFC 6238 Appendix B — SHA-1 rows.
const VECTORS = [
  [59,            '94287082'],
  [1111111109,    '07081804'],
  [1111111111,    '14050471'],
  [1234567890,    '89005924'],
  [2000000000,    '69279037'],
  [20000000000,   '65353130'],
];
for (const [t, want] of VECTORS) {
  const got = totp(RFC_SECRET_B32, { timestamp: t * 1000, digits: 8 });
  check(`RFC 6238 vector t=${t} → ${want}`, got === want, `got ${got}`);
}

check('6-digit truncation matches the RFC value\u2019s tail (t=59 → 287082)',
  totp(RFC_SECRET_B32, { timestamp: 59 * 1000 }) === '287082');
check('codes are zero-padded to the requested width',
  /^\d{6}$/.test(totp(RFC_SECRET_B32, { timestamp: 59 * 1000 })));
check('stepOffset moves exactly one 30s step',
  totp(RFC_SECRET_B32, { timestamp: 59 * 1000, stepOffset: 1 })
    === totp(RFC_SECRET_B32, { timestamp: (59 + 30) * 1000 }));
{
  const w = totpWindow(RFC_SECRET_B32, { timestamp: 1111111109 * 1000, digits: 8 });
  check('totpWindow returns [now, previous, next] distinct codes',
    w[0] === '07081804' && w.length === 3 && new Set(w).size === 3, w.join(','));
}

console.log(`\n${failed === 0 ? '\u2714' : '\u2716'} TOTP UNIT — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
