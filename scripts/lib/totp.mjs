/**
 * totp.mjs — RFC 6238 TOTP for the live test suites (R4.5.1, item: real
 * MFA/TOTP verification in the owner/manager integration tests).
 *
 * Zero dependencies by design: node:crypto HMAC only, so the live suites can
 * compute a genuine second factor without pulling an authenticator library
 * into the tree. The enrolment secret comes from the GoTrue TOTP enrol
 * response (the same base32 string the QR code encodes) and is supplied to
 * the suites via MP_*_TOTP_SECRET environment variables — never committed,
 * never logged.
 *
 * Correctness is pinned by scripts/totp.unit.test.mjs against the RFC 6238
 * Appendix B reference vectors (SHA-1), so a drift here fails `npm run
 * verify` before it can strand a live MFA run.
 */
import { createHmac } from 'node:crypto';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 → bytes. Case-insensitive; ignores spaces and '='
 *  padding (authenticator apps present secrets in grouped lowercase). */
export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=]/g, '');
  if (clean.length === 0) throw new Error('TOTP secret is empty.');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`TOTP secret contains a non-base32 character ("${ch}").`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * The TOTP code for a base32 secret at a moment in time.
 * @param {string} secretBase32  the enrolment secret (base32)
 * @param {object} [opts]
 * @param {number} [opts.timestamp]  Unix milliseconds (default: now)
 * @param {number} [opts.stepSeconds=30]
 * @param {number} [opts.digits=6]
 * @param {'sha1'|'sha256'|'sha512'} [opts.algorithm='sha1']
 * @param {number} [opts.stepOffset=0]  ±N steps for clock-skew retries
 * @returns {string} zero-padded code
 */
export function totp(secretBase32, opts = {}) {
  const {
    timestamp = Date.now(),
    stepSeconds = 30,
    digits = 6,
    algorithm = 'sha1',
    stepOffset = 0,
  } = opts;
  const key = base32Decode(secretBase32);
  const counter = Math.floor(timestamp / 1000 / stepSeconds) + stepOffset;
  const msg = Buffer.alloc(8);
  // 64-bit big-endian counter without BigInt gymnastics: the high word first.
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac(algorithm, key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const bin =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The current code plus its clock-skew neighbours (for a single retry pass
 *  when a code expires mid-flight). Order: now, previous step, next step. */
export function totpWindow(secretBase32, opts = {}) {
  return [0, -1, 1].map((stepOffset) => totp(secretBase32, { ...opts, stepOffset }));
}
