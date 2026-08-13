import {
  PUBLIC_FUNCTIONS,
  assertExactEdgeFunctionHashMap,
  assertPublicFunctionSetSha256,
  computePublicFunctionSetSha256,
} from './edge-function-inventory.mjs';
export { PUBLIC_FUNCTIONS } from './edge-function-inventory.mjs';

export function validateFunctionDeployEvidence(text) {
  const shared = text.match(/^FUNCTION_SHARED_SOURCE sha256=([a-f0-9]{64})$/m)?.[1];
  if (!shared) throw new Error('shared function source hash is missing');
  const setSha = text.match(/^PUBLIC_FUNCTION_SET_SOURCE sha256=([a-f0-9]{64})$/m)?.[1];
  if (!setSha) throw new Error('public function-set source hash is missing');
  assertPublicFunctionSetSha256(setSha);

  const pass = text.match(/^FUNCTION_DEPLOY_PASS count=(\d+) public_function_set_sha256=([a-f0-9]{64}) pos_deferred=(\d+)$/m);
  if (!pass) throw new Error('source-bound FUNCTION_DEPLOY_PASS marker is missing');
  if (Number(pass[1]) !== PUBLIC_FUNCTIONS.length || Number(pass[3]) !== 3) {
    throw new Error('FUNCTION_DEPLOY_PASS reports the wrong public/POS inventory counts');
  }
  if (pass[2] !== setSha) throw new Error('FUNCTION_DEPLOY_PASS public function-set hash does not match source marker');

  const rows = [...text.matchAll(/^FUNCTION_DEPLOYED name=([a-z0-9-]+) sha256=([a-f0-9]{64}) shared_sha256=([a-f0-9]{64}) verify_jwt=(on|off)$/gm)]
    .map((match) => ({ name: match[1], sha256: match[2], shared_sha256: match[3], verify_jwt: match[4] }));
  if (rows.length !== PUBLIC_FUNCTIONS.length) {
    throw new Error(`expected ${PUBLIC_FUNCTIONS.length} deployed-function records, found ${rows.length}`);
  }
  if (new Set(rows.map((row) => row.name)).size !== rows.length) {
    throw new Error('duplicate deployed-function records are not allowed');
  }
  for (let index = 0; index < PUBLIC_FUNCTIONS.length; index += 1) {
    const [expectedName, expectedMode] = PUBLIC_FUNCTIONS[index];
    const row = rows[index];
    if (row.name !== expectedName || row.verify_jwt !== expectedMode) {
      throw new Error(`function deployment order/mode mismatch at ${index + 1}: expected ${expectedName}/${expectedMode}`);
    }
    if (row.shared_sha256 !== shared) throw new Error(`shared source hash mismatch for ${row.name}`);
  }
  const rowHashes = Object.fromEntries(rows.map((row) => [row.name, row.sha256]));
  const calculatedSetSha = computePublicFunctionSetSha256(rowHashes, shared);
  if (calculatedSetSha !== setSha) throw new Error('deployed function rows do not match the public function-set source hash');
  return { shared_sha256: shared, public_function_set_sha256: setSha, functions: rows };
}

export function assertFunctionDeployMatchesIdentity(deployment, identity) {
  const expectedTrees = identity?.edge_function_trees;
  const expectedShared = identity?.edge_shared_tree_sha256;
  const expectedSetSha = identity?.public_function_set_sha256;
  assertExactEdgeFunctionHashMap(expectedTrees, 'signed release Edge Function tree hashes');
  if (!/^[a-f0-9]{64}$/.test(expectedShared || '')) {
    throw new Error('signed release identity has no shared Edge source-tree hash');
  }
  assertPublicFunctionSetSha256(expectedSetSha, 'signed release public function-set hash');
  const calculatedExpectedSetSha = computePublicFunctionSetSha256(expectedTrees, expectedShared);
  if (calculatedExpectedSetSha !== expectedSetSha) {
    throw new Error('signed release public function-set hash does not match its Edge source-tree identity');
  }
  if (deployment.shared_sha256 !== expectedShared) {
    throw new Error('deployed shared Edge source does not match the signed release');
  }
  if (deployment.public_function_set_sha256 !== expectedSetSha) {
    throw new Error('deployed public function set does not match the signed release');
  }
  for (const row of deployment.functions) {
    if (expectedTrees[row.name] !== row.sha256) {
      throw new Error(`deployed ${row.name} source does not match the signed release`);
    }
  }
  return true;
}
