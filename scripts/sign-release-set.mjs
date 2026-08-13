#!/usr/bin/env node
/**
 * ============================================================================
 *  sign-release-set.mjs  —  sign release-set.json with an Ed25519 key
 * ============================================================================
 *  Reads the private key from a path OUTSIDE the release (MP_SIGNING_KEY or the
 *  first argument), signs the canonical set (metadata retained, bytes omitted),
 *  and writes the signature back into signature.value with scheme
 *  "ed25519-pinned". The private key never enters the repository or the archive.
 *
 *  Usage:  node scripts/sign-release-set.mjs <release-set.json> <ed25519-private-key.pem>
 * ============================================================================
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, sign as edSign } from 'node:crypto';
import { canonicalPayload } from './lib/release-signature.mjs';

const [, , setPath, keyPath] = process.argv;
const key = keyPath || process.env.MP_SIGNING_KEY;
if (!setPath || !key) {
  console.error('usage: sign-release-set.mjs <release-set.json> <private-key.pem>  (or MP_SIGNING_KEY)');
  process.exit(2);
}
const set = JSON.parse(readFileSync(setPath, 'utf8'));
set.signature = { scheme: 'ed25519-pinned', run_id: set.run_id };
const priv = createPrivateKey(readFileSync(key, 'utf8'));
set.signature.value = edSign(null, canonicalPayload(set), priv).toString('base64');
writeFileSync(setPath, `${JSON.stringify(set, null, 2)}\n`);
console.log(`signed ${setPath} with ed25519-pinned (run ${set.run_id})`);
