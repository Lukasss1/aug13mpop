#!/usr/bin/env node
/**
 * Prove the release commit is the current default-branch head without storing
 * GitHub credentials in Git configuration. This proves source identity only;
 * review/branch/environment protection remain GitHub settings outside the ZIP.
 */
import { execFileSync } from 'node:child_process';

const token = String(process.env.GITHUB_TOKEN || '').trim();
const repository = String(process.env.GITHUB_REPOSITORY || '').trim();
const expectedSha = String(process.env.GITHUB_SHA || '').trim().toLowerCase();
const api = String(process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
if (!token || !/^[^/]+\/[^/]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(expectedSha)) {
  console.error('GITHUB_TOKEN, GITHUB_REPOSITORY and a 40-character GITHUB_SHA are required');
  process.exit(2);
}
let localSha;
try { localSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().toLowerCase(); }
catch (error) { console.error(`cannot read local Git HEAD: ${error.message}`); process.exit(1); }
if (localSha !== expectedSha) {
  console.error(`checked-out HEAD ${localSha} does not match workflow SHA ${expectedSha}`);
  process.exit(1);
}
const get = async (path) => {
  const response = await fetch(`${api}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 300) }; }
  if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
};
try {
  const repo = await get(`/repos/${repository}`);
  const branch = String(repo?.default_branch || '').trim();
  if (!branch) throw new Error('repository response has no default_branch');
  const commit = await get(`/repos/${repository}/commits/${encodeURIComponent(branch)}`);
  const remoteSha = String(commit?.sha || '').toLowerCase();
  if (remoteSha !== expectedSha) {
    throw new Error(`release commit ${expectedSha} is not current ${branch} head ${remoteSha || 'unknown'}`);
  }
  console.log(`SOURCE_REF_PASS default_branch=${branch} commit=${expectedSha}`);
  console.log('Note: pull-request review, branch protection and environment reviewers are external GitHub settings and are not proven by this check.');
} catch (error) {
  console.error(`SOURCE_REF_FAILED: ${error.message}`);
  process.exit(1);
}
