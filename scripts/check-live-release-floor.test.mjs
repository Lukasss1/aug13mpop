#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = mkdtempSync(path.join(tmpdir(), 'milkpop-live-floor-'));
const script = path.join(root, 'scripts/check-live-release-floor.mjs');
const LIVE_COMMIT = '1'.repeat(40);
const LIVE_SET = 'b'.repeat(64);
let mode = 'ready';
const server = http.createServer((req, res) => {
  if (mode === '404') { res.writeHead(404); res.end('not found'); return; }
  if (mode === 'bad-json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{'); return; }
  const release_number = mode === 'newer' ? 20 : 10;
  const build_profile = mode === 'development' ? 'development' : 'production';
  const marker = {
    release_identity: 'r4.10.15-t13.3.29-live',
    release_number,
    git_commit: mode === 'bad-commit' ? 'abc123' : LIVE_COMMIT,
    build_profile,
    site_domain: 'milkpop.uk',
    build_output_sha256: 'a'.repeat(64),
    public_function_set_sha256: mode === 'bad-function-hash' ? 'bad' : LIVE_SET,
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(marker));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
let runNo = 0;
const run = (overrides = {}) => new Promise((resolve) => {
  runNo += 1;
  const outputFile = path.join(outputDir, `github-output-${runNo}.txt`);
  writeFileSync(outputFile, '');
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: {
      ...process.env,
      MP_SITE_DOMAIN: 'milkpop.uk',
      MP_RELEASE_NUMBER: '11',
      MP_ALLOW_FIRST_DEPLOY_WITHOUT_MARKER: 'false',
      MP_LIVE_MARKER_URL: `http://127.0.0.1:${port}/.well-known/milkpop-release.json`,
      MP_LIVE_MARKER_TIMEOUT_MS: '2000',
      GITHUB_OUTPUT: outputFile,
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr, output: readFileSync(outputFile, 'utf8') }));
});

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`✓ ${name}`); }
  else { failures.push(name); console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
try {
  mode = 'ready';
  let r = await run();
  check('strictly newer candidate passes', r.status === 0, `${r.stdout}${r.stderr}`);
  check('existing predecessor identity is exposed to the protected workflow',
    /first_deploy=false/.test(r.output)
      && /live_release_number=10/.test(r.output)
      && r.output.includes(`live_git_commit=${LIVE_COMMIT}`)
      && r.output.includes(`live_public_function_set_sha256=${LIVE_SET}`));

  r = await run({ MP_RELEASE_NUMBER: '10' });
  check('same release number is refused', r.status !== 0 && /greater than live/.test(`${r.stdout}${r.stderr}`));

  mode = 'newer';
  r = await run();
  check('older candidate is refused', r.status !== 0 && /rollback\/replay refused/.test(`${r.stdout}${r.stderr}`));

  mode = 'development';
  r = await run();
  check('non-production live marker is refused', r.status !== 0 && /not a production release/.test(`${r.stdout}${r.stderr}`));

  mode = 'bad-commit';
  r = await run();
  check('predecessor commit must be exact provenance', r.status !== 0 && /40-character git_commit/.test(`${r.stdout}${r.stderr}`));

  mode = 'bad-function-hash';
  r = await run();
  check('predecessor backend identity is mandatory', r.status !== 0 && /public_function_set_sha256/.test(`${r.stdout}${r.stderr}`));

  mode = '404';
  r = await run();
  check('missing marker fails without first-deploy approval', r.status !== 0 && /first deployment/.test(`${r.stdout}${r.stderr}`));
  r = await run({ MP_ALLOW_FIRST_DEPLOY_WITHOUT_MARKER: 'true', MP_RELEASE_NUMBER: '1' });
  check('explicit first deployment passes only for release 1', r.status === 0 && /first_deploy=true/.test(r.output), `${r.stdout}${r.stderr}`);
  r = await run({ MP_ALLOW_FIRST_DEPLOY_WITHOUT_MARKER: 'true', MP_RELEASE_NUMBER: '2' });
  check('forgotten first-deploy flag cannot authorize release 2+', r.status !== 0 && /only for release_number=1/.test(`${r.stdout}${r.stderr}`));

  mode = 'bad-json';
  r = await run({ MP_ALLOW_FIRST_DEPLOY_WITHOUT_MARKER: 'true' });
  check('invalid marker never uses the first-deploy exception', r.status !== 0 && /not valid JSON/.test(`${r.stdout}${r.stderr}`));

  r = await run({ MP_ALLOW_FIRST_DEPLOY_WITHOUT_MARKER: '' });
  check('first-deploy state must be explicit', r.status !== 0 && /explicitly true or false/.test(`${r.stdout}${r.stderr}`));
} finally {
  server.close();
  rmSync(outputDir, { recursive: true, force: true });
}
console.log(`\nLive release floor: ${passed}/${passed + failures.length} passed`);
if (failures.length) process.exit(1);
