#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'milkpop-backend-plan-'));
const setPath = path.join(tmp, 'release-set.json');
const out = path.join(tmp, 'out.txt');
const HASH = 'a'.repeat(64);
writeFileSync(setPath, JSON.stringify({ kind: 'milkpop-release-set', schema: 2, build_profile: 'production', public_function_set_sha256: HASH }));
const run = (env) => {
  writeFileSync(out, '');
  const r = spawnSync(process.execPath, ['scripts/decide-public-function-deploy.mjs', setPath], {
    encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out, ...env },
  });
  return { ...r, output: readFileSync(out, 'utf8') };
};
let passed = 0; let failed = 0;
const check = (name, ok) => { if (ok) { passed++; console.log(`✓ ${name}`); } else { failed++; console.error(`✗ ${name}`); } };
try {
  let r = run({ FIRST_DEPLOY: 'true', LIVE_PUBLIC_FUNCTION_SET_SHA256: '' });
  check('first release deploys the complete public function set', r.status === 0 && /deploy_functions=true/.test(r.output) && /reason=first-deploy/.test(r.output));
  r = run({ FIRST_DEPLOY: 'false', LIVE_PUBLIC_FUNCTION_SET_SHA256: HASH });
  check('unchanged backend skips Supabase mutation', r.status === 0 && /deploy_functions=false/.test(r.output) && /reason=unchanged/.test(r.output));
  r = run({ FIRST_DEPLOY: 'false', LIVE_PUBLIC_FUNCTION_SET_SHA256: 'b'.repeat(64) });
  check('changed backend deploys the complete public function set', r.status === 0 && /deploy_functions=true/.test(r.output) && /reason=changed/.test(r.output));
  r = run({ FIRST_DEPLOY: 'false', LIVE_PUBLIC_FUNCTION_SET_SHA256: '' });
  check('existing release without backend identity fails closed', r.status !== 0);
  r = run({ FIRST_DEPLOY: 'true', LIVE_PUBLIC_FUNCTION_SET_SHA256: HASH });
  check('first release cannot claim a predecessor backend identity', r.status !== 0);
  r = run({ FIRST_DEPLOY: '', LIVE_PUBLIC_FUNCTION_SET_SHA256: '' });
  check('deployment state must be explicit', r.status !== 0);
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`\nPublic function deploy decision: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
