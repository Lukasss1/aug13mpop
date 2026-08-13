#!/usr/bin/env node
/**
 * Online anti-rollback floor and predecessor identity discovery.
 *
 * A missing marker is accepted only for release_number=1 and only when the
 * production environment explicitly enables the first-deploy exception. An
 * existing marker must provide the exact predecessor Git commit and public
 * function-set identity needed for coherent backend change detection/rollback.
 */
const domain = String(process.env.MP_SITE_DOMAIN ?? '').trim().toLowerCase().replace(/\.$/, '');
const releaseNumber = Number(String(process.env.MP_RELEASE_NUMBER ?? '').trim());
const allowFirst = String(process.env.MP_ALLOW_FIRST_DEPLOY_WITHOUT_MARKER ?? '').trim();
const markerUrl = String(process.env.MP_LIVE_MARKER_URL ?? `https://${domain}/.well-known/milkpop-release.json`).trim();
const timeoutMs = Number(process.env.MP_LIVE_MARKER_TIMEOUT_MS ?? 20_000);
const githubOutput = String(process.env.GITHUB_OUTPUT ?? '').trim();
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

const die = (message) => { console.error(`[live-release-floor] ${message}`); process.exit(1); };
const emit = async (values) => {
  if (!githubOutput) return;
  const { appendFile } = await import('node:fs/promises');
  const body = Object.entries(values).map(([key, value]) => `${key}=${value ?? ''}\n`).join('');
  await appendFile(githubOutput, body);
};

if (!domain || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
  die(`invalid MP_SITE_DOMAIN: ${domain || '(unset)'}`);
}
if (!Number.isSafeInteger(releaseNumber) || releaseNumber <= 0) die('MP_RELEASE_NUMBER must be a positive safe integer');
if (allowFirst !== 'true' && allowFirst !== 'false') die('MP_ALLOW_FIRST_DEPLOY_WITHOUT_MARKER must be explicitly true or false');

let response;
try {
  response = await fetch(markerUrl, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
} catch (error) {
  die(`could not reach the live HTTPS release marker: ${error.message}`);
}

if (response.status === 404) {
  if (allowFirst !== 'true') die('live release marker is absent; only an explicitly approved first deployment may proceed');
  if (releaseNumber !== 1) die(`first-deploy exception is valid only for release_number=1, not ${releaseNumber}`);
  await emit({
    first_deploy: 'true',
    live_release_number: '',
    live_git_commit: '',
    live_public_function_set_sha256: '',
  });
  console.log('[live-release-floor] PASS  release 1 marker returned 404 and first-deploy exception is explicitly enabled');
  process.exit(0);
}
if (!response.ok) die(`live release marker returned HTTP ${response.status}`);

let marker;
try { marker = await response.json(); }
catch { die('live release marker is not valid JSON'); }

const liveNumber = marker?.release_number;
if (!Number.isSafeInteger(liveNumber) || liveNumber <= 0) die(`live marker has invalid release_number: ${String(liveNumber)}`);
if (marker?.build_profile !== 'production') die(`live marker is not a production release: ${String(marker?.build_profile)}`);
if (typeof marker?.release_identity !== 'string' || marker.release_identity.trim() === '') die('live marker has no release_identity');
if (String(marker?.site_domain ?? '').toLowerCase().replace(/\.$/, '') !== domain) die(`live marker site_domain does not match ${domain}`);
if (!SHA256.test(String(marker?.build_output_sha256 ?? ''))) die('live marker has no valid build_output_sha256');
if (!SHA256.test(String(marker?.public_function_set_sha256 ?? ''))) die('live marker has no valid public_function_set_sha256');
if (!COMMIT.test(String(marker?.git_commit ?? ''))) die('live marker has no exact lowercase 40-character git_commit');
if (releaseNumber <= liveNumber) die(`rollback/replay refused: candidate ${releaseNumber} must be greater than live ${liveNumber}`);

await emit({
  first_deploy: 'false',
  live_release_number: String(liveNumber),
  live_git_commit: marker.git_commit,
  live_public_function_set_sha256: marker.public_function_set_sha256,
});
console.log(`[live-release-floor] PASS  candidate ${releaseNumber} is newer than live ${liveNumber}; predecessor ${marker.git_commit.slice(0, 12)}…`);
