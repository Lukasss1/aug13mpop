#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'milkpop-source-ref-'));
spawnSync('git', ['init', '-q'], { cwd: dir });
spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
spawnSync('git', ['commit', '--allow-empty', '-qm', 'test'], { cwd: dir });
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
let remoteSha = sha;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url === '/repos/acme/milkpop') res.end(JSON.stringify({ default_branch: 'main' }));
  else if (req.url === '/repos/acme/milkpop/commits/main') res.end(JSON.stringify({ sha: remoteSha }));
  else { res.statusCode = 404; res.end('{}'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const run = () => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(process.cwd(), 'scripts/verify-release-source-ref.mjs')], {
    cwd: dir,
    env: { ...process.env, GITHUB_TOKEN: 'read-only-test', GITHUB_REPOSITORY: 'acme/milkpop', GITHUB_SHA: sha, GITHUB_API_URL: `http://127.0.0.1:${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = ''; child.stdout.on('data', (d) => { text += d; }); child.stderr.on('data', (d) => { text += d; }); child.on('close', (code) => resolve({ code, text }));
});
let passed = 0; const failures = [];
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log(`✓ ${name}`); } else { failures.push(name); console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`); } };
try {
  let result = await run();
  check('current default-branch head is accepted', result.code === 0 && /SOURCE_REF_PASS/.test(result.text), result.text);
  remoteSha = 'f'.repeat(40);
  result = await run();
  check('stale release commit is rejected', result.code !== 0 && /not current main head/.test(result.text), result.text);
} finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
console.log(`\nRelease source ref: ${passed}/${passed + failures.length} passed`);
if (failures.length) process.exit(1);
