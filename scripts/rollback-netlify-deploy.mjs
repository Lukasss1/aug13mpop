#!/usr/bin/env node
/** Restore the prior deploy only when the failed release is still live. */
import fs from 'node:fs';
import path from 'node:path';

const [, , publishArg = 'release-out/netlify-publish.json', outArg = 'release-out/netlify-rollback.json'] = process.argv;
const publishPath = path.resolve(publishArg);
const outPath = path.resolve(outArg);
const token = String(process.env.NETLIFY_AUTH_TOKEN ?? '').trim();
const configuredSiteId = String(process.env.NETLIFY_SITE_ID ?? '').trim();
const apiOrigin = String(process.env.NETLIFY_API_ORIGIN ?? 'https://api.netlify.com').replace(/\/$/, '');
const die = (message) => { console.error(`[netlify-rollback] ${message}`); process.exit(1); };
if (!token) die('NETLIFY_AUTH_TOKEN is missing');
const published = JSON.parse(fs.readFileSync(publishPath, 'utf8'));
const siteId = String(published.site_id ?? '').trim();
if (!siteId || siteId !== configuredSiteId) die('publish receipt site does not match NETLIFY_SITE_ID');
if (published.kind !== 'milkpop-netlify-publish' || !published.deploy_id) die('invalid publish receipt');

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

const site = await request(`${apiOrigin}/api/v1/sites/${encodeURIComponent(siteId)}`);
const current = String(site?.published_deploy?.id ?? '').trim();
let status;
if (current !== published.deploy_id) {
  status = 'SKIPPED_NEWER_DEPLOY_IS_LIVE';
} else if (!published.previous_deploy_id) {
  status = 'FAILED_NO_PREVIOUS_DEPLOY';
} else {
  await request(`${apiOrigin}/api/v1/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(published.previous_deploy_id)}/restore`, { method: 'POST' });
  const deadline = Date.now() + 3 * 60_000;
  while (true) {
    const after = await request(`${apiOrigin}/api/v1/sites/${encodeURIComponent(siteId)}`);
    if (String(after?.published_deploy?.id ?? '') === published.previous_deploy_id) break;
    if (Date.now() >= deadline) die(`previous deploy ${published.previous_deploy_id} was not restored within 3 minutes`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  status = 'ROLLED_BACK';
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
const receipt = {
  kind: 'milkpop-netlify-rollback',
  schema: 2,
  scope: 'frontend-only',
  backend_functions_unchanged: true,
  attempted_at: new Date().toISOString(),
  site_id: siteId,
  failed_deploy_id: published.deploy_id,
  previous_deploy_id: published.previous_deploy_id ?? null,
  observed_current_deploy_id: current || null,
  status,
};
fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`[netlify-rollback] ${status}; FRONTEND ONLY — Supabase Edge Functions remain at the newly deployed source unless separately recovered; receipt ${outPath}`);
if (status === 'FAILED_NO_PREVIOUS_DEPLOY') process.exit(1);
