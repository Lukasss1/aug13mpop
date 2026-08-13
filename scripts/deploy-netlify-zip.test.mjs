#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/deploy-netlify-zip.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'milkpop-netlify-test-'));
const dist = path.join(tmp, 'dist');
const setPath = path.join(tmp, 'release-set.json');
const receipt = path.join(tmp, 'receipt.json');
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
fs.mkdirSync(path.join(dist, '.well-known'), { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><h1>Milk Pop</h1>');
fs.writeFileSync(path.join(dist, 'assets/app.js'), 'console.log("milkpop")');
const hash = spawnSync(process.execPath,
  [path.join(root, 'scripts/lib/release-hash.mjs'), '--dir', dist], { encoding: 'utf8' }).stdout.trim();
const set = {
  build_profile: 'production', build_output_sha256: hash, public_function_set_sha256: 'c'.repeat(64),
  release_identity: 'test', release_number: 7, git_commit: '0'.repeat(40),
};
fs.writeFileSync(setPath, JSON.stringify(set));
fs.writeFileSync(path.join(dist, '.well-known/milkpop-release.json'), JSON.stringify({
  release_identity: set.release_identity,
  release_number: set.release_number,
  git_commit: set.git_commit,
  build_output_sha256: set.build_output_sha256,
  public_function_set_sha256: set.public_function_set_sha256,
}));

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');
const expectedIndexSha = sha1(fs.readFileSync(path.join(dist, 'index.html')));
let createBody = null;
const uploads = [];
let pollCount = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/v1/sites/site-test/deploys') {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      createBody = JSON.parse(text);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'deploy-1', state: 'uploading', site_id: 'site-test', draft: true,
        required: [expectedIndexSha], deploy_ssl_url: 'https://deploy-1--milkpop.netlify.app',
      }));
    });
    return;
  }
  if (req.method === 'PUT' && req.url === '/api/v1/deploys/deploy-1/files/index.html') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      uploads.push({ url: req.url, contentType: req.headers['content-type'], body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/v1/deploys/deploy-1') {
    pollCount += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'deploy-1', state: 'ready', site_id: 'site-test', draft: true, required: [],
      deploy_ssl_url: 'https://deploy-1--milkpop.netlify.app',
    }));
    return;
  }
  res.writeHead(404); res.end('{}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const run = (setFile = setPath) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, dist, setFile, receipt], {
    cwd: root,
    env: { ...process.env, NETLIFY_AUTH_TOKEN: 'test-token', NETLIFY_SITE_ID: 'site-test', NETLIFY_API_ORIGIN: `http://127.0.0.1:${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout.on('data', (chunk) => { text += chunk; });
  child.stderr.on('data', (chunk) => { text += chunk; });
  child.on('close', (code) => resolve({ code, text }));
});

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`✓ ${name}`); }
  else { failures.push(name); console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

try {
  let result = await run();
  check('documented file-digest draft upload succeeds', result.code === 0, result.text.slice(-500));
  check('create request explicitly marks deploy draft', createBody?.draft === true);
  check('create request carries SHA1 file digest map', createBody?.files?.['/index.html'] === expectedIndexSha && typeof createBody?.files?.['/assets/app.js'] === 'string');
  check('required file is uploaded to documented files endpoint', uploads.length === 1 && uploads[0].url.endsWith('/files/index.html'));
  check('file upload is raw application/octet-stream', uploads[0]?.contentType === 'application/octet-stream' && uploads[0]?.body.equals(fs.readFileSync(path.join(dist, 'index.html'))));
  check('deploy is polled to ready after required upload', pollCount >= 1);
  const out = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  check('draft receipt binds the release build hash', out.build_output_sha256 === hash);
  check('draft receipt records digest transport and inventory', out.transport === 'netlify-file-digest-sha1' && out.deployment_file_count === 3 && out.deployment_total_bytes > 0);
  check('draft receipt records a ready non-live deploy', out.deploy_id === 'deploy-1' && out.state === 'ready' && out.draft === true);
  check('draft receipt records its unique HTTPS URL', out.deploy_url === 'https://deploy-1--milkpop.netlify.app');

  const badSet = path.join(tmp, 'bad-set.json');
  fs.writeFileSync(badSet, JSON.stringify({ ...set, build_output_sha256: '0'.repeat(64) }));
  result = await run(badSet);
  check('build hash mismatch is refused before upload', result.code !== 0 && /different build/.test(result.text));

  const badMarker = JSON.parse(fs.readFileSync(path.join(dist, '.well-known/milkpop-release.json'), 'utf8'));
  badMarker.release_number = 999;
  fs.writeFileSync(path.join(dist, '.well-known/milkpop-release.json'), JSON.stringify(badMarker));
  result = await run();
  check('release-marker drift is refused before upload', result.code !== 0 && /release marker release_number/.test(result.text));
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nNetlify digest draft deploy: ${passed}/${passed + failures.length} checks passed.`);
if (failures.length) process.exit(1);
