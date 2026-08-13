/**
 * ============================================================================
 *  RELEASE SIGNATURE VERIFICATION  (P0-4 round 3)
 * ============================================================================
 *
 *  Round 2 accepted STUB outside production mode and rejected EVERY claimed
 *  real signature unconditionally — so no genuinely signed release could ever
 *  pass `--production`. The production gate existed but nothing could satisfy
 *  it. This module implements verification that a real release can actually
 *  meet.
 *
 *  TRUST ANCHOR (round 4). The verifier previously read the "pinned" public key
 *  from `release-signing.pub` INSIDE the package it was verifying. That is
 *  circular: an attacker generates a key pair, drops their public key into a
 *  modified package, regenerates the source and build manifests and the
 *  receipts, signs the set with their private key, and every check agrees —
 *  because nothing external says WHICH key is allowed to sign a Milk Pop
 *  release. A signature only proves authorship against a key you already
 *  trusted for some other reason.
 *
 *  So the trusted key (or cosign identity) must be supplied to the verifier
 *  from OUTSIDE the release: `--trust <policy.json>`, `--trusted-key <file>`,
 *  or MP_TRUST_POLICY / MP_TRUSTED_KEY in the environment. Production
 *  verification REFUSES to run without one. A key found inside the package is
 *  never authoritative; if it disagrees with the trusted key the release is
 *  rejected outright, because that is exactly what a forged-signer attack
 *  looks like.
 *
 *  Two real schemes:
 *
 *  • `ed25519-pinned` — the set is signed with an Ed25519 key whose PUBLIC half
 *    is pinned in the repository as `release-signing.pub`. The verifier reads
 *    that key FROM THE EXTRACTED PACKAGE, never from the working directory, so
 *    swapping the key changes source_tree_sha256 and is caught by the source
 *    binding. Signing needs the private half, which lives only where releases
 *    are made — it is deliberately NOT in this repository.
 *
 *  • `cosign-keyless` — verified by invoking cosign with the issuer and
 *    identity the set declares. Absent cosign is a FAILURE, never a skip.
 *
 *  What is signed is the set with its `signature` block removed, serialised
 *  with sorted keys, so the signature covers every other field (archive
 *  hashes, digests, stage list, build profile) and cannot be transplanted.
 * ============================================================================
 */

import { createPublicKey, createHash, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Deterministic bytes that a signature covers: the set minus its signature. */
export function canonicalPayload(set) {
  const copy = { ...set };
  /* Retain the signature METADATA (scheme, run_id, key/identity hints) and omit
     ONLY the signature bytes. Round 4 stripped the whole block, so scheme was
     not covered — a genuine ed25519 signature could be swapped for
     {scheme:"STUB"} and the payload was unchanged, downgrading a real release
     to unsigned. The bytes cannot sign themselves, so they alone are removed. */
  if (copy.signature && typeof copy.signature === 'object') {
    const sig = { ...copy.signature };
    delete sig.value;   // ed25519 bytes
    delete sig.bundle;  // cosign bundle path
    copy.signature = sig;
  }
  const sortDeep = (v) => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
    }
    return v;
  };
  return Buffer.from(JSON.stringify(sortDeep(copy)), 'utf8');
}

/** sha256 fingerprint of a PEM public key, for pinning by value. */
export function keyFingerprint(pem) {
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/**
 * Load the EXTERNAL trust policy. Never derived from the release.
 * Accepts a JSON policy file, or individual key/identity overrides.
 * @returns {null|{source:string, ed25519Pem?:string, ed25519Fingerprint?:string,
 *                 cosignIssuer?:string, cosignIdentity?:string}}
 */
export function loadTrustPolicy(argv = [], env = {}) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  const policyPath = flag('--trust') || env.MP_TRUST_POLICY;
  const keyPath = flag('--trusted-key') || env.MP_TRUSTED_KEY;
  const identity = flag('--trusted-identity') || env.MP_TRUSTED_IDENTITY;
  const issuer = flag('--trusted-issuer') || env.MP_TRUSTED_ISSUER;

  let policy = null;
  if (policyPath) {
    const raw = JSON.parse(readFileSync(policyPath, 'utf8'));
    /* Relative key paths resolve from the POLICY FILE's directory, never the
       verifier's CWD. Running the verifier from an attacker-controlled release
       directory previously loaded that directory's release-signing.pub. */
    const policyDir = path.dirname(path.resolve(policyPath));
    const resolveKey = (p) => (path.isAbsolute(p) ? p : path.join(policyDir, p));
    policy = {
      source: `policy file ${policyPath}`,
      ed25519Pem: raw.ed25519_public_key_pem
        || (raw.ed25519_public_key_file ? readFileSync(resolveKey(raw.ed25519_public_key_file), 'utf8') : undefined),
      ed25519Fingerprint: raw.ed25519_public_key_sha256
        ? String(raw.ed25519_public_key_sha256).toLowerCase() : undefined,
      cosignIssuer: raw.cosign_certificate_oidc_issuer,
      cosignIdentity: raw.cosign_certificate_identity,
      /* ENFORCEABLE production fields. A "_note" saying a key is for demo use
         only is a comment the verifier ignores; key_purpose is checked. */
      keyPurpose: raw.key_purpose,
      keyId: raw.key_id,
      approvedSiteDomain: raw.approved_site_domain,
      approvedSupabaseRef: raw.approved_supabase_project_ref,
      minimumReleaseNumber: Number.isInteger(raw.minimum_release_number)
        ? raw.minimum_release_number : undefined,
    };
  }
  if (keyPath) {
    policy = { ...(policy || {}), source: `trusted key file ${keyPath}`, ed25519Pem: readFileSync(keyPath, 'utf8') };
  }
  if (identity || issuer) {
    policy = {
      ...(policy || { source: 'command-line identity' }),
      cosignIdentity: identity || policy?.cosignIdentity,
      cosignIssuer: issuer || policy?.cosignIssuer,
    };
  }
  /* A policy that supplies BOTH a PEM and a fingerprint must be internally
     consistent, or it is rejected. Otherwise the fingerprint check passes
     against a legit value while signature verification uses an attacker PEM. */
  if (policy && policy.ed25519Pem && policy.ed25519Fingerprint) {
    const actual = keyFingerprint(policy.ed25519Pem);
    if (actual !== policy.ed25519Fingerprint) {
      throw new Error(`trust policy is inconsistent: PEM fingerprint ${actual.slice(0, 16)}… does not match declared ed25519_public_key_sha256 ${policy.ed25519Fingerprint.slice(0, 16)}…`);
    }
  }
  return policy;
}

/**
 * Verify an ed25519-pinned signature against an EXTERNALLY TRUSTED key.
 * @param {object} set     the release set (with its signature block)
 * @param {string} pubPem  PEM public key from the TRUST POLICY, not the package
 * @returns {{ok:boolean, detail:string}}
 */
export function verifyEd25519(set, pubPem) {
  try {
    const sig = Buffer.from(String(set.signature?.value || ''), 'base64');
    if (!sig.length) return { ok: false, detail: 'signature.value is empty' };
    const key = createPublicKey(pubPem);
    const ok = edVerify(null, canonicalPayload(set), key, sig);
    return { ok, detail: ok ? 'ed25519 signature valid over the canonical release set' : 'signature does not verify against the pinned public key' };
  } catch (e) {
    return { ok: false, detail: `verification error: ${e.message}` };
  }
}

/**
 * Verify a cosign-keyless bundle. Requires the cosign binary; its absence is a
 * failure, so a release cannot be waved through on a missing tool.
 */
export function verifyCosign(set, setPath, policy) {
  const s = set.signature || {};
  if (!s.bundle) return { ok: false, detail: 'signature.bundle is not named' };
  /* The identity is dictated by the TRUST POLICY, not by the release. A set
     that names its own certificate identity is nominating its own signer. */
  if (!policy?.cosignIdentity || !policy?.cosignIssuer) {
    return { ok: false, detail: 'no externally trusted cosign identity/issuer supplied — refusing to accept the identity the release names for itself' };
  }
  if (s.certificate_identity && s.certificate_identity !== policy.cosignIdentity) {
    return { ok: false, detail: `release names identity ${s.certificate_identity}, trust policy allows ${policy.cosignIdentity}` };
  }
  if (s.certificate_oidc_issuer && s.certificate_oidc_issuer !== policy.cosignIssuer) {
    return { ok: false, detail: `release names issuer ${s.certificate_oidc_issuer}, trust policy allows ${policy.cosignIssuer}` };
  }
  try {
    execFileSync('cosign', ['version'], { stdio: 'pipe' });
  } catch {
    return { ok: false, detail: 'cosign is not installed — cannot verify; refusing to pass an unverified signature' };
  }
  try {
    execFileSync('cosign', ['verify-blob', '--bundle', s.bundle,
      '--certificate-oidc-issuer', policy.cosignIssuer,
      '--certificate-identity', policy.cosignIdentity, setPath], { stdio: 'pipe' });
    return { ok: true, detail: `cosign verified against the trusted identity ${policy.cosignIdentity}` };
  } catch (e) {
    return { ok: false, detail: `cosign verification failed: ${String(e.stderr || e.message).slice(0, 160)}` };
  }
}

export const REAL_SCHEMES = Object.freeze(['ed25519-pinned', 'cosign-keyless']);
export const PINNED_KEY_FILE = 'release-signing.pub';
