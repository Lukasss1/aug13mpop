#!/usr/bin/env node
import { readFileSync, appendFileSync } from 'node:fs';
import { assertPublicFunctionSetSha256 } from './lib/edge-function-inventory.mjs';

const [, , setPath = 'release-out/release-set.json'] = process.argv;
const die = (message) => { console.error(`decide-public-function-deploy: ${message}`); process.exit(1); };
let set;
try { set = JSON.parse(readFileSync(setPath, 'utf8')); } catch (error) { die(`cannot read release set: ${error.message}`); }
if (set?.kind !== 'milkpop-release-set' || set?.schema !== 2 || set?.build_profile !== 'production') {
  die('release set is not the supported production contract');
}
try { assertPublicFunctionSetSha256(set.public_function_set_sha256, 'candidate public function-set hash'); }
catch (error) { die(error.message); }

const firstDeploy = String(process.env.FIRST_DEPLOY ?? '').trim();
if (firstDeploy !== 'true' && firstDeploy !== 'false') die('FIRST_DEPLOY must be explicitly true or false');
const liveHash = String(process.env.LIVE_PUBLIC_FUNCTION_SET_SHA256 ?? '').trim();
let deploy;
let reason;
if (firstDeploy === 'true') {
  if (liveHash) die('first deployment must not carry a predecessor public function-set hash');
  deploy = true;
  reason = 'first-deploy';
} else {
  try { assertPublicFunctionSetSha256(liveHash, 'live public function-set hash'); }
  catch (error) { die(error.message); }
  deploy = liveHash !== set.public_function_set_sha256;
  reason = deploy ? 'changed' : 'unchanged';
}

const output = String(process.env.GITHUB_OUTPUT ?? '').trim();
if (output) {
  appendFileSync(output,
    `deploy_functions=${deploy ? 'true' : 'false'}\n`
    + `reason=${reason}\n`
    + `candidate_public_function_set_sha256=${set.public_function_set_sha256}\n`);
}
console.log(`PUBLIC_FUNCTION_DEPLOY_DECISION deploy=${deploy ? 'true' : 'false'} reason=${reason} sha256=${set.public_function_set_sha256}`);
