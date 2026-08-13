import { createHash } from 'node:crypto';

/**
 * Code-owned Edge Function inventory.
 *
 * This module is the single production authority for which Edge Functions are
 * part of the public/staff release and which remain POS-deferred. Deployment,
 * signed release identity, rollback and evidence all consume this inventory.
 */
export const PUBLIC_FUNCTIONS = Object.freeze([
  ['send-email', 'on'],
  ['cv-signed-url', 'on'],
  ['cv-upload', 'off'],
  ['public-form', 'off'],
  ['training-media', 'on'],
  ['staff-doc-upload', 'on'],
  ['staff-doc-url', 'on'],
  ['staff-doc-delete', 'on'],
  ['staff-invite', 'on'],
  ['media-upload', 'on'],
  ['media-cleanup', 'on'],
  ['request-seo-rebuild', 'on'],
  ['outbox-dispatch', 'off'],
  ['employee-access-revoke', 'on'],
]);

export const POS_FUNCTIONS = Object.freeze([
  ['pos-pair', 'off'],
  ['pos-ingest', 'off'],
  ['pos-catalog', 'off'],
]);

export const PUBLIC_FUNCTION_NAMES = Object.freeze(PUBLIC_FUNCTIONS.map(([name]) => name));
export const POS_FUNCTION_NAMES = Object.freeze(POS_FUNCTIONS.map(([name]) => name));
export const EDGE_FUNCTIONS = Object.freeze([...PUBLIC_FUNCTION_NAMES, ...POS_FUNCTION_NAMES].sort());

const HASH = /^[a-f0-9]{64}$/;

function assertHash(value, label) {
  if (!HASH.test(String(value || ''))) throw new Error(`${label} must be a lowercase sha256`);
}

function assertExactNames(observed, expected, label) {
  if (!Array.isArray(observed)) throw new Error(`${label} must be an array`);
  const names = [...new Set(observed)].sort();
  const sortedExpected = [...expected].sort();
  const missing = sortedExpected.filter((name) => !names.includes(name));
  const unknown = names.filter((name) => !sortedExpected.includes(name));
  const duplicateCount = observed.length - names.length;
  if (duplicateCount) throw new Error(`${label} contains duplicate names`);
  if (missing.length || unknown.length) {
    throw new Error(`${label} is not the code-owned ${expected.length}-function inventory`
      + `${missing.length ? `; missing: ${missing.join(', ')}` : ''}`
      + `${unknown.length ? `; unknown: ${unknown.join(', ')}` : ''}`);
  }
  return true;
}

export function diffEdgeFunctionInventory(observed) {
  const names = [...new Set(observed)].sort();
  return {
    missing: EDGE_FUNCTIONS.filter((name) => !names.includes(name)),
    unknown: names.filter((name) => !EDGE_FUNCTIONS.includes(name)),
    duplicateCount: observed.length - names.length,
  };
}

export function assertExactEdgeFunctionInventory(observed, label = 'Edge Function inventory') {
  return assertExactNames(observed, EDGE_FUNCTIONS, label);
}

export function assertExactPublicFunctionInventory(observed, label = 'public Edge Function inventory') {
  return assertExactNames(observed, PUBLIC_FUNCTION_NAMES, label);
}

export function assertExactEdgeFunctionHashMap(value, label = 'Edge Function hash map') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertExactEdgeFunctionInventory(Object.keys(value), `${label} keys`);
  for (const name of EDGE_FUNCTIONS) assertHash(value[name], `${label} ${name}`);
  return true;
}

export function assertExactPublicFunctionHashMap(value, label = 'public Edge Function hash map') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertExactPublicFunctionInventory(Object.keys(value), `${label} keys`);
  for (const name of PUBLIC_FUNCTION_NAMES) assertHash(value[name], `${label} ${name}`);
  return true;
}

/**
 * Deterministic identity for the complete public/staff Edge Function release.
 * POS functions are deliberately excluded because they are not deployed in
 * MilkPop v0.1. `_shared` is included separately because it influences every
 * deployed function without being a deployable function itself.
 */
export function computePublicFunctionSetSha256(treeHashes, sharedTreeSha256) {
  const publicTrees = {};
  for (const name of PUBLIC_FUNCTION_NAMES) publicTrees[name] = treeHashes?.[name];
  assertExactPublicFunctionHashMap(publicTrees, 'public function tree hashes');
  assertHash(sharedTreeSha256, 'shared Edge Function tree hash');
  const canonical = JSON.stringify({
    schema: 'milkpop-public-function-set/v1',
    shared_tree_sha256: sharedTreeSha256,
    functions: PUBLIC_FUNCTIONS.map(([name, verify_jwt]) => ({
      name,
      verify_jwt,
      tree_sha256: publicTrees[name],
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function assertPublicFunctionSetSha256(value, label = 'public function set sha256') {
  assertHash(value, label);
  return true;
}
