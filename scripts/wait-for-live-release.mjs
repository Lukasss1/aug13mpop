#!/usr/bin/env node
/** Wait until the public marker matches the exact signed release, not merely any valid marker. */
import { readFileSync } from 'node:fs';

const setPath = process.argv[2] || 'release-out/release-set.json';
const set = JSON.parse(readFileSync(setPath, 'utf8'));
const domain = String(process.env.MP_SITE_DOMAIN || set.site_domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const origin = String(process.env.MP_LIVE_ORIGIN || (domain ? `https://${domain}` : '')).replace(/\/$/, '');
const attempts = Number(process.env.MP_LIVE_MARKER_ATTEMPTS || 18);
const delayMs = Number(process.env.MP_LIVE_MARKER_DELAY_MS || 10_000);
if (!origin || !Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(delayMs) || delayMs < 0) {
  console.error('valid MP_SITE_DOMAIN/MP_LIVE_ORIGIN and retry settings are required');
  process.exit(2);
}
const expected = {
  release_identity: set.release_identity,
  release_number: set.release_number,
  git_commit: set.git_commit,
  site_domain: set.site_domain,
  build_output_sha256: set.build_output_sha256,
  public_function_set_sha256: set.public_function_set_sha256,
  build_profile: 'production',
};
let last = 'no response';
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const url = `${origin}/.well-known/milkpop-release.json?release=${encodeURIComponent(String(set.release_number))}&attempt=${attempt}`;
    const response = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const live = await response.json();
    const mismatches = Object.entries(expected).filter(([key, value]) => live?.[key] !== value).map(([key]) => key);
    if (!mismatches.length) {
      console.log(`LIVE RELEASE MARKER PASS — release ${set.release_number} matches the signed build`);
      process.exit(0);
    }
    last = `marker mismatch: ${mismatches.join(', ')}`;
  } catch (error) {
    last = String(error?.message ?? error);
  }
  console.log(`live marker attempt ${attempt}/${attempts}: ${last}`);
  if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
}
console.error(`LIVE RELEASE MARKER FAILED — ${last}`);
process.exit(1);
