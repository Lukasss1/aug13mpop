#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const sourceRoot = process.cwd();
const tmp = mkdtempSync(path.join(os.tmpdir(), 'milkpop-function-rollback-test-'));
const repo = path.join(tmp, 'repo');
const bin = path.join(tmp, 'bin');
mkdirSync(repo, { recursive: true });
mkdirSync(bin, { recursive: true });

// The source candidate ZIP deliberately contains no .git directory. Build the
// smallest real Git fixture the rollback mechanism needs so this contract
// proves predecessor provenance without depending on caller repository state.
for (const rel of [
  'supabase/functions',
  'supabase/config.toml',
  'launch/deploy-public-functions.sh',
  'scripts/public-function-set-hash.mjs',
  'scripts/restore-public-functions-from-git.sh',
  'scripts/lib/release-hash.mjs',
  'scripts/lib/edge-function-inventory.mjs',
]) {
  cpSync(path.join(sourceRoot, rel), path.join(repo, rel), { recursive: true });
}
chmodSync(path.join(repo, 'launch/deploy-public-functions.sh'), 0o755);
chmodSync(path.join(repo, 'scripts/restore-public-functions-from-git.sh'), 0o755);
chmodSync(path.join(repo, 'scripts/public-function-set-hash.mjs'), 0o755);

const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(['init', '-q']);
git(['config', 'user.email', 'rollback-contract@milkpop.invalid']);
git(['config', 'user.name', 'MilkPop rollback contract']);
git(['add', '.']);
git(['commit', '-q', '-m', 'trusted predecessor fixture']);
const commit = git(['rev-parse', 'HEAD']);
const expected = execFileSync(process.execPath, ['scripts/public-function-set-hash.mjs'], { cwd: repo, encoding: 'utf8' }).trim();

const fake = path.join(bin, 'supabase');
writeFileSync(fake, '#!/usr/bin/env bash\nprintf "MOCK_SUPABASE %s\\n" "$*"\n', 'utf8');
chmodSync(fake, 0o755);
const run = (args, env = {}) => spawnSync('bash', ['scripts/restore-public-functions-from-git.sh', ...args], {
  cwd: repo,
  env: { ...process.env, PATH: `${bin}:${process.env.PATH || ''}`, MP_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst', ...env },
  encoding: 'utf8',
});
let passed = 0; let failed = 0;
const check = (name, ok, detail='') => { if (ok) { passed++; console.log(`✓ ${name}`); } else { failed++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`); } };
try {
  let r = run([commit, expected]);
  check('trusted predecessor source can restore the complete 14-function set', r.status === 0 && /FUNCTION_ROLLBACK_PASS/.test(r.stdout), `${r.stdout}${r.stderr}`);
  check('rollback validates predecessor backend identity before mutation', /FUNCTION_ROLLBACK_SOURCE/.test(r.stdout) && r.stdout.includes(`public_function_set_sha256=${expected}`));
  check('rollback never deploys deferred POS functions', !/functions deploy pos-(?:pair|ingest|catalog)/.test(r.stdout));
  r = run([commit, 'f'.repeat(64)]);
  check('wrong predecessor backend fingerprint refuses before deployment', r.status !== 0 && /does not match trusted live marker/.test(`${r.stdout}${r.stderr}`) && !/MOCK_SUPABASE/.test(r.stdout));
  r = run(['abc123', expected]);
  check('noncanonical predecessor commit is refused', r.status !== 0 && /40-character/.test(`${r.stdout}${r.stderr}`));
  r = run(['0'.repeat(40), expected]);
  check('unknown predecessor commit is refused', r.status !== 0 && /not present in repository history/.test(`${r.stdout}${r.stderr}`));
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`\nFunction rollback recovery: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
