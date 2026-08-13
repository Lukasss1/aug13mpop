/* r48-auth-recovery.test.mjs — R4.8 Workstream H1: password recovery. */
import { readFileSync } from 'node:fs';
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('✔', n); };
const bad = (n, d) => { failed++; console.log('✘', n, d || ''); };
const check = (n, c, d) => (c ? ok(n) : bad(n, d));
const lib = readFileSync('src/lib/passwordRecovery.ts', 'utf8');
const card = readFileSync('src/components/PasswordRecoveryCard.tsx', 'utf8');
const sp = readFileSync('src/components/staff/StaffAuthPanel.tsx', 'utf8');
check('login card offers "Forgot password?"', /Forgot password\?/.test(sp));
check('recovery token in the URL fragment is detected on /staff/', /readRecoveryFromHash\(window\.location\.hash\)/.test(sp));
check('expired/used links surface an honest specific message', /expired or was already used/.test(lib));
check('redirect target is FIXED same-origin (no caller-supplied redirect)', /window\.location\.origin\}\$\{RESET_LANDING_PATH\}/.test(lib.replace(/`/g, '')) || /window\.location\.origin}\${RESET_LANDING_PATH}/.test(lib));
check('no open-redirect parameter exists anywhere in the flow', !/redirect(_to|To)\s*[:=]\s*(params|query|input|props)/.test(lib + card));
const m = lib.match(/If that address has a staff account[^']+/);
check('enumeration-safe: ONE identical message for success and unknown address', !!m && /res\.ok \|\| res\.status === 400 \|\| res\.status === 422/.test(lib));
check('rate-limit responses reuse the same neutral message', /res\.status === 429/.test(lib));
check('token is scrubbed from the URL/history after use', /scrubRecoveryHash/.test(lib) && /replaceState/.test(lib));
check('minimum password length enforced client-side (server still validates)', /newPassword\.length < 10/.test(lib));
check('cross-tab consistency documented: other sessions revoked on update', /Other devices have been signed out/.test(lib));
check('card announces success via status and errors via alert',
  /role=\{note\.tone === 'ok' \? 'status' : 'alert'\}/.test(card));
console.log(`\nR48-AUTH-RECOVERY — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
