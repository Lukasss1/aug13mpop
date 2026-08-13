#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PUBLIC_FUNCTIONS, POS_FUNCTIONS } from './lib/edge-function-inventory.mjs';
import { validateFunctionDeployEvidence } from './lib/function-deploy-evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deploy = readFileSync(path.join(ROOT, 'launch', 'deploy-public-functions.sh'), 'utf8');
let passed = 0;
let failed = 0;
const check = (name, ok) => {
  if (ok) { passed += 1; console.log(`✓ ${name}`); }
  else { failed += 1; console.error(`✗ ${name}`); }
};

check('code-owned public deploy set contains exactly 14 unique functions',
  PUBLIC_FUNCTIONS.length === 14 && new Set(PUBLIC_FUNCTIONS.map(([name]) => name)).size === 14);
check('POS inventory contains exactly the three deferred functions',
  POS_FUNCTIONS.map(([name]) => name).join(',') === 'pos-pair,pos-ingest,pos-catalog');
check('deploy script consumes code-owned inventory instead of owning literal deploy calls',
  /PUBLIC_FUNCTIONS/.test(deploy) && !/^deploy\s+[a-z0-9-]+\s+(?:on|off)(?:\s|$)/m.test(deploy));
check('deploy script records shared and aggregate public-function source identities',
  /FUNCTION_SHARED_SOURCE sha256=/.test(deploy) && /PUBLIC_FUNCTION_SET_SOURCE sha256=/.test(deploy));
check('partial function deployment emits an explicit recovery marker',
  /FUNCTION_DEPLOY_INCOMPLETE/.test(deploy) && /FUNCTION_DEPLOY_RECOVERY_REQUIRED/.test(deploy) && /mixed function set/.test(deploy));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'milkpop-function-deploy-'));
try {
  const fake = path.join(tmp, 'supabase');
  writeFileSync(fake, '#!/usr/bin/env bash\nprintf "MOCK_SUPABASE %s\\n" "$*"\n', 'utf8');
  chmodSync(fake, 0o755);
  const result = spawnSync('bash', ['launch/deploy-public-functions.sh'], {
    cwd: ROOT,
    env: { ...process.env, PATH: `${tmp}:${process.env.PATH || ''}`, MP_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst' },
    encoding: 'utf8',
  });
  check('mocked deploy completes successfully from the canonical inventory', result.status === 0);
  let evidence;
  try { evidence = validateFunctionDeployEvidence(result.stdout); } catch { evidence = null; }
  check('runtime evidence validates the exact 14-function ordered set', evidence?.functions?.length === 14);
  check('JWT-off modes remain limited to the three designed server-authorised functions',
    evidence?.functions?.filter((row) => row.verify_jwt === 'off').map((row) => row.name).join(',') === 'cv-upload,public-form,outbox-dispatch');
  check('mocked deploy never publishes deferred POS functions',
    !POS_FUNCTIONS.some(([name]) => result.stdout.includes(`MOCK_SUPABASE functions deploy ${name} `)));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nFunction deployment evidence: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
