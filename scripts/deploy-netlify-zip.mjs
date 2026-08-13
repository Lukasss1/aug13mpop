#!/usr/bin/env node
/**
 * Upload the exact verified static build as a NON-LIVE Netlify draft deploy.
 *
 * Netlify's documented/recommended API flow is file-digest based:
 *   1. POST { draft:true, files:{path:sha1} }
 *   2. Netlify returns the SHA1 values it does not already hold
 *   3. PUT one representative file for each required SHA1
 *   4. poll the draft deploy until ready
 *
 * The caller must pass a directory whose release build hash matches the signed
 * release-set.json. The production workflow extracts this directory from the
 * already-verified signed package, so the bytes uploaded here are the bytes
 * that were authenticated by the release verifier.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [, , distArg = 'release-out/verified-dist', setArg = 'release-out/release-set.json', receiptArg = 'release-out/netlify-draft.json'] = process.argv;
const dist = path.resolve(root, distArg);
const setPath = path.resolve(root, setArg);
const receiptPath = path.resolve(root, receiptArg);
const token = String(process.env.NETLIFY_AUTH_TOKEN ?? '').trim();
const siteId = String(process.env.NETLIFY_SITE_ID ?? '').trim();
const apiOrigin = String(process.env.NETLIFY_API_ORIGIN ?? 'https://api.netlify.com').replace(/\/$/, '');

const die = (message) => { console.error(`[netlify-draft] ${message}`); process.exit(1); };
if (!token) die('NETLIFY_AUTH_TOKEN is missing');
if (!siteId || !/^[A-Za-z0-9._-]+$/.test(siteId)) die('NETLIFY_SITE_ID is missing or malformed');
if (!fs.existsSync(dist) || !fs.statSync(dist).isDirectory()) die(`dist directory not found: ${dist}`);
if (!fs.existsSync(setPath)) die(`release set not found: ${setPath}`);

const entries = [];
const walk = (dir, rel = '') => {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const childRel = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) die(`dist contains a symbolic link: ${childRel}`);
    if (st.isDirectory()) walk(full, childRel);
    else if (st.isFile()) {
      if (/[#?]/.test(childRel)) die(`dist path is unsafe for Netlify upload: ${childRel}`);
      entries.push({ rel: childRel, full, bytes: st.size });
    } else die(`dist contains a non-file entry: ${childRel}`);
  }
};
walk(dist);
if (!entries.length) die('dist contains no files');
if (entries.length > 25_000) die(`dist contains ${entries.length} files; refusing an unexpectedly large deploy`);

const set = JSON.parse(fs.readFileSync(setPath, 'utf8'));
if (set.build_profile !== 'production') die(`release set is not production (build_profile=${set.build_profile})`);
if (!set.build_output_sha256) die('release set has no build_output_sha256');
if (!/^[a-f0-9]{64}$/.test(String(set.public_function_set_sha256 || ''))) die('release set has no valid public_function_set_sha256');
const actualHash = execFileSync(process.execPath,
  [path.join(root, 'scripts/lib/release-hash.mjs'), '--dir', dist], { encoding: 'utf8' }).trim();
if (actualHash !== set.build_output_sha256) {
  die(`refusing to deploy a different build: ${actualHash} != ${set.build_output_sha256}`);
}

const markerPath = path.join(dist, '.well-known', 'milkpop-release.json');
if (!fs.existsSync(markerPath)) die('verified deploy directory has no /.well-known/milkpop-release.json marker');
let marker;
try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); }
catch { die('release marker is not valid JSON'); }
for (const [field, expected] of [
  ['release_identity', set.release_identity],
  ['release_number', set.release_number],
  ['git_commit', set.git_commit],
  ['build_output_sha256', set.build_output_sha256],
  ['public_function_set_sha256', set.public_function_set_sha256],
]) {
  if (marker?.[field] !== expected) die(`release marker ${field} does not match signed release set`);
}

const sha1 = (file) => createHash('sha1').update(fs.readFileSync(file)).digest('hex');
const files = {};
const representativeBySha = new Map();
let totalBytes = 0;
for (const entry of entries) {
  const digest = sha1(entry.full);
  const apiPath = `/${entry.rel}`;
  files[apiPath] = digest;
  if (!representativeBySha.has(digest)) representativeBySha.set(digest, entry);
  totalBytes += entry.bytes;
}
const manifestSha256 = createHash('sha256')
  .update(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([p, h]) => `${p}\0${h}\n`).join(''))
  .digest('hex');

const fetchWithTimeout = (url, options = {}, timeoutMs = 60_000) => fetch(url, {
  ...options,
  headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  signal: AbortSignal.timeout(timeoutMs),
});

const requestJson = async (url, options = {}) => {
  const response = await fetchWithTimeout(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${url} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
};

const encodeFilePath = (rel) => rel.split('/').map((part) => encodeURIComponent(part)).join('/');
const uploadFile = async (deployId, entry) => {
  const url = `${apiOrigin}/api/v1/deploys/${encodeURIComponent(deployId)}/files/${encodeFilePath(entry.rel)}`;
  const response = await fetchWithTimeout(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: fs.readFileSync(entry.full),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 500);
    throw new Error(`PUT ${url} returned ${response.status}: ${text}`);
  }
};

console.log(`[netlify-draft] creating digest draft with ${entries.length} files (${totalBytes} bytes) for build ${actualHash.slice(0, 16)}…`);
let deploy = await requestJson(`${apiOrigin}/api/v1/sites/${encodeURIComponent(siteId)}/deploys`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ draft: true, files }),
});
const deployId = String(deploy?.id ?? '').trim();
if (!deployId) die('Netlify create-deploy response did not include an id');
if (deploy?.site_id && String(deploy.site_id) !== siteId) die(`Netlify response belongs to unexpected site ${deploy.site_id}`);
if (deploy?.draft !== true) die('Netlify did not create a draft deploy');

let required = Array.isArray(deploy?.required) ? deploy.required.map(String) : [];
const unknownRequired = required.filter((digest) => !representativeBySha.has(digest));
if (unknownRequired.length) die(`Netlify requested ${unknownRequired.length} file digest(s) absent from the submitted manifest`);

for (const digest of [...new Set(required)]) {
  const entry = representativeBySha.get(digest);
  console.log(`[netlify-draft] upload ${entry.rel} (${digest.slice(0, 12)}…)`);
  await uploadFile(deployId, entry);
}

const terminalFailure = new Set(['error', 'failed', 'canceled', 'cancelled']);
const deadline = Date.now() + 5 * 60_000;
while (deploy?.state !== 'ready') {
  if (terminalFailure.has(String(deploy?.state ?? '').toLowerCase())) die(`Netlify deploy ${deployId} entered failure state ${deploy.state}`);
  if (Date.now() >= deadline) die(`Netlify deploy ${deployId} did not become ready within 5 minutes`);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  deploy = await requestJson(`${apiOrigin}/api/v1/deploys/${encodeURIComponent(deployId)}`);
  if (deploy?.site_id && String(deploy.site_id) !== siteId) die(`polled deploy belongs to unexpected site ${deploy.site_id}`);
  if (deploy?.draft !== true) die('polled deploy is not marked as draft');
  required = Array.isArray(deploy?.required) ? deploy.required.map(String) : [];
  if (required.length) {
    const unknown = required.filter((digest) => !representativeBySha.has(digest));
    if (unknown.length) die('polled deploy requested a digest absent from the submitted manifest');
    for (const digest of [...new Set(required)]) {
      const entry = representativeBySha.get(digest);
      console.log(`[netlify-draft] retry requested file ${entry.rel}`);
      await uploadFile(deployId, entry);
    }
  }
  console.log(`[netlify-draft] ${deployId}: ${deploy?.state ?? 'unknown'}`);
}

const deployUrl = deploy.deploy_ssl_url ?? deploy.deploy_url ?? null;
if (!deployUrl || !/^https:\/\//.test(deployUrl)) die('ready draft deploy has no HTTPS deploy URL');
fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
const receipt = {
  kind: 'milkpop-netlify-draft',
  schema: 2,
  transport: 'netlify-file-digest-sha1',
  created_at: new Date().toISOString(),
  deploy_id: deployId,
  state: deploy.state,
  draft: true,
  site_id: deploy.site_id ?? siteId,
  deploy_url: deployUrl,
  release_identity: set.release_identity,
  release_number: set.release_number,
  git_commit: set.git_commit,
  build_output_sha256: actualHash,
  public_function_set_sha256: set.public_function_set_sha256,
  deployment_manifest_sha256: manifestSha256,
  deployment_file_count: entries.length,
  deployment_total_bytes: totalBytes,
};
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`[netlify-draft] ready: ${deployId}; receipt ${receiptPath}`);
