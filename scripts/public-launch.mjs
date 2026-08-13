#!/usr/bin/env node
/**
 * One small-business public release entrypoint.
 *
 * --preflight-only loads the operator's ignored `.env.production.local`,
 * derives source-owned and trust-policy-owned public values, then validates the
 * exact production configuration. CI-owned release metadata and the private
 * signing key remain deferred to the protected release workflow.
 *
 * A full run delegates to release-seal.sh. This is a wrapper around the one
 * release pipeline, not a second build/deploy implementation.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalPublicPreflightEnv } from './lib/public-preflight-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preflightOnly = process.argv.includes('--preflight-only');

function run(command, args, childEnv = process.env) {
  const result = spawnSync(command, args, { cwd: root, env: childEnv, stdio: 'inherit' });
  if (result.error) {
    console.error(`[public-launch] could not start ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('[public-seal] verifying the current T13.3.30 protected deployment closure');
run(process.execPath, ['scripts/t13322-public-web.test.mjs']);
run(process.execPath, ['scripts/t13323-public-route-closure.test.mjs']);
run(process.execPath, ['scripts/t13324-public-deployment-handoff.test.mjs']);
run(process.execPath, ['scripts/t13325-local-preflight-trust-split.test.mjs']);
run(process.execPath, ['scripts/t13326-local-preflight-config.test.mjs']);
run(process.execPath, ['scripts/t13327-verifier-closure.test.mjs']);
run(process.execPath, ['scripts/t13328-production-deployment-closure.test.mjs']);

if (preflightOnly) {
  console.log('[public-seal] checking locally configured production inputs');
  let localEnv;
  try {
    localEnv = loadLocalPublicPreflightEnv(root);
  } catch (error) {
    console.error(`[public-preflight] ${error.message}`);
    process.exit(1);
  }
  run(process.execPath, [
    'scripts/production-release-preflight.mjs',
    '--defer-ci-signing-key',
    '--defer-ci-release-metadata',
  ], localEnv);
  console.log('[public-seal] local preflight passed; trigger the protected GitHub Actions release workflow to publish.');
} else {
  console.log('[public-seal] producing a local cryptographic release set; this does not publish Netlify or Supabase');
  run('bash', ['scripts/release-seal.sh']);
}
