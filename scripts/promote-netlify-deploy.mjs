#!/usr/bin/env node
/** Publish one previously verified Netlify draft and record the prior live id. */
import fs from 'node:fs';
import path from 'node:path';

const [, , draftArg = 'release-out/netlify-draft.json', setArg = 'release-out/release-set.json', outArg = 'release-out/netlify-publish.json'] = process.argv;
const draftPath = path.resolve(draftArg);
const setPath = path.resolve(setArg);
const outPath = path.resolve(outArg);
const token = String(process.env.NETLIFY_AUTH_TOKEN ?? '').trim();
const configuredSiteId = String(process.env.NETLIFY_SITE_ID ?? '').trim();
const apiOrigin = String(process.env.NETLIFY_API_ORIGIN ?? 'https://api.netlify.com').replace(/\/$/, '');
const die = (message) => { console.error(`[netlify-promote] ${message}`); process.exit(1); };
if (!token) die('NETLIFY_AUTH_TOKEN is missing');

const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
const set = JSON.parse(fs.readFileSync(setPath, 'utf8'));
const siteId = String(draft.site_id ?? configuredSiteId).trim();
if (!siteId || siteId !== configuredSiteId) die('draft receipt site does not match NETLIFY_SITE_ID');
if (draft.kind !== 'milkpop-netlify-draft' || draft.draft !== true || draft.state !== 'ready') die('input is not a ready Netlify draft receipt');
for (const key of ['release_identity', 'release_number', 'git_commit', 'build_output_sha256', 'public_function_set_sha256']) {
  if (draft[key] !== set[key]) die(`draft receipt does not match release set: ${key}`);
}

const request = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${url} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
};

const siteBefore = await request(`${apiOrigin}/api/v1/sites/${encodeURIComponent(siteId)}`);
const previousDeployId = String(siteBefore?.published_deploy?.id ?? '').trim() || null;
if (previousDeployId === draft.deploy_id) die('draft deploy is already the published deploy');

await request(`${apiOrigin}/api/v1/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(draft.deploy_id)}/restore`, { method: 'POST' });
const deadline = Date.now() + 3 * 60_000;
let siteAfter;
while (true) {
  siteAfter = await request(`${apiOrigin}/api/v1/sites/${encodeURIComponent(siteId)}`);
  if (String(siteAfter?.published_deploy?.id ?? '') === draft.deploy_id) break;
  if (Date.now() >= deadline) die(`draft ${draft.deploy_id} was not published within 3 minutes`);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
const receipt = {
  kind: 'milkpop-netlify-publish',
  schema: 1,
  published_at: new Date().toISOString(),
  site_id: siteId,
  deploy_id: draft.deploy_id,
  previous_deploy_id: previousDeployId,
  url: siteAfter?.published_deploy?.ssl_url ?? siteAfter?.ssl_url ?? siteAfter?.url ?? null,
  release_identity: set.release_identity,
  release_number: set.release_number,
  git_commit: set.git_commit,
  build_output_sha256: set.build_output_sha256,
  public_function_set_sha256: set.public_function_set_sha256,
};
fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`[netlify-promote] published ${draft.deploy_id}; previous=${previousDeployId ?? 'none'}; receipt ${outPath}`);
