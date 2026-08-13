#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'milkpop-netlify-promote-'));
const setPath = path.join(tmp, 'release-set.json');
const draftPath = path.join(tmp, 'draft.json');
const publishPath = path.join(tmp, 'publish.json');
const rollbackPath = path.join(tmp, 'rollback.json');
const identity = { release_identity: 'r-test', release_number: 9, git_commit: 'a'.repeat(40), build_output_sha256: 'b'.repeat(64), public_function_set_sha256: 'c'.repeat(64) };
fs.writeFileSync(setPath, JSON.stringify({ ...identity, build_profile: 'production' }));
fs.writeFileSync(draftPath, JSON.stringify({ kind: 'milkpop-netlify-draft', schema: 1, site_id: 'site-test', deploy_id: 'new-deploy', state: 'ready', draft: true, ...identity }));

let current = 'old-deploy';
const restoreCalls = [];
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/v1/sites/site-test') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'site-test', published_deploy: { id: current, ssl_url: 'https://milkpop.example' } }));
    return;
  }
  const match = req.url?.match(/^\/api\/v1\/sites\/site-test\/deploys\/([^/]+)\/restore$/);
  if (req.method === 'POST' && match) {
    restoreCalls.push(match[1]); current = match[1];
    res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: current })); return;
  }
  res.writeHead(404); res.end('{}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const env = { ...process.env, NETLIFY_AUTH_TOKEN: 'test-token', NETLIFY_SITE_ID: 'site-test', NETLIFY_API_ORIGIN: `http://127.0.0.1:${port}` };
const run = (script, args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(root, 'scripts', script), ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; child.stdout.on('data', (d) => { text += d; }); child.stderr.on('data', (d) => { text += d; });
  child.on('close', (code) => resolve({ code, text }));
});

let passed = 0; const failures = [];
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log(`✓ ${name}`); } else { failures.push(name); console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`); } };
try {
  let result = await run('promote-netlify-deploy.mjs', [draftPath, setPath, publishPath]);
  check('verified draft promotion succeeds', result.code === 0, result.text);
  const published = JSON.parse(fs.readFileSync(publishPath));
  check('promotion restores the exact draft deploy id', restoreCalls[0] === 'new-deploy' && current === 'new-deploy');
  check('promotion receipt preserves prior live deploy for rollback', published.previous_deploy_id === 'old-deploy');
  check('promotion receipt binds frontend and backend release identity', published.build_output_sha256 === identity.build_output_sha256 && published.public_function_set_sha256 === identity.public_function_set_sha256);

  result = await run('rollback-netlify-deploy.mjs', [publishPath, rollbackPath]);
  check('failed release can restore the previous deploy', result.code === 0, result.text);
  check('rollback restores only the recorded previous id', restoreCalls[1] === 'old-deploy' && current === 'old-deploy');
  check('rollback receipt records success', JSON.parse(fs.readFileSync(rollbackPath)).status === 'ROLLED_BACK');

  current = 'newer-human-deploy';
  result = await run('rollback-netlify-deploy.mjs', [publishPath, rollbackPath]);
  check('rollback does not overwrite a newer deployment', result.code === 0 && restoreCalls.length === 2);
  check('newer-deploy protection is explicit in receipt', JSON.parse(fs.readFileSync(rollbackPath)).status === 'SKIPPED_NEWER_DEPLOY_IS_LIVE');
} finally {
  server.close(); fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nNetlify promote/rollback: ${passed}/${passed + failures.length} passed`);
if (failures.length) process.exit(1);
