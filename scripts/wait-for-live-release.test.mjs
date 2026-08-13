#!/usr/bin/env node
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'milkpop-live-marker-'));
const setPath = join(dir, 'release-set.json');
const expected = { release_number: 12, git_commit: 'a'.repeat(40), site_domain: 'example.test', build_output_sha256: 'b'.repeat(64), build_profile: 'production' };
writeFileSync(setPath, JSON.stringify(expected));
let requests = 0;
const server = http.createServer((req, res) => {
  requests += 1;
  const body = requests < 3 ? { ...expected, release_number: 11 } : expected;
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const run = (attempts) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['scripts/wait-for-live-release.mjs', setPath], {
    env: { ...process.env, MP_LIVE_ORIGIN: `http://127.0.0.1:${port}`, MP_LIVE_MARKER_ATTEMPTS: String(attempts), MP_LIVE_MARKER_DELAY_MS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = ''; child.stdout.on('data', (d) => { text += d; }); child.stderr.on('data', (d) => { text += d; }); child.on('close', (code) => resolve({ code, text }));
});
let passed = 0; const failures = [];
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log(`✓ ${name}`); } else { failures.push(name); console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`); } };
try {
  let result = await run(4);
  check('waiter retries an old but valid marker until the exact release appears', result.code === 0 && requests === 3, result.text);
  requests = 0;
  result = await run(2);
  check('waiter fails closed when the exact release never appears', result.code !== 0 && /LIVE RELEASE MARKER FAILED/.test(result.text), result.text);
} finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
console.log(`\nLive marker waiter: ${passed}/${passed + failures.length} passed`);
if (failures.length) process.exit(1);
