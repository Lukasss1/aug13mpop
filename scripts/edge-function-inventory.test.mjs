#!/usr/bin/env node
import { readdirSync, statSync, readFileSync } from 'node:fs';
import {
  EDGE_FUNCTIONS, PUBLIC_FUNCTIONS, POS_FUNCTIONS,
  assertExactEdgeFunctionInventory, assertExactEdgeFunctionHashMap,
} from './lib/edge-function-inventory.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`✓ ${name}`); }
  else { failed += 1; console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const rejects = (fn) => { try { fn(); return false; } catch { return true; } };

const dirs = readdirSync('supabase/functions')
  .filter((name) => name !== '_shared' && statSync(`supabase/functions/${name}`).isDirectory())
  .sort();
check('code-owned inventory contains exactly 17 unique functions',
  EDGE_FUNCTIONS.length === 17 && new Set(EDGE_FUNCTIONS).size === 17);
check('repository function directories exactly match the code-owned inventory',
  JSON.stringify(dirs) === JSON.stringify(EDGE_FUNCTIONS), `${dirs.length} directories`);
check('launch and deferred subsets partition the complete inventory',
  PUBLIC_FUNCTIONS.length === 14 && POS_FUNCTIONS.length === 3
  && new Set([...PUBLIC_FUNCTIONS, ...POS_FUNCTIONS].map(([name]) => name)).size === 17);
check('every declared function has index.ts',
  EDGE_FUNCTIONS.every((name) => {
    try { return statSync(`supabase/functions/${name}/index.ts`).isFile(); } catch { return false; }
  }));

const hashes = Object.fromEntries(EDGE_FUNCTIONS.map((name) => [name, 'a'.repeat(64)]));
check('complete exact hash map is accepted', !rejects(() => assertExactEdgeFunctionHashMap(hashes)));
check('missing function is rejected', rejects(() => {
  const copy = { ...hashes }; delete copy['pos-catalog']; assertExactEdgeFunctionHashMap(copy);
}));
check('unknown replacement at the same count is rejected', rejects(() => {
  const copy = { ...hashes }; delete copy['pos-catalog']; copy['rogue-function'] = 'b'.repeat(64);
  assertExactEdgeFunctionHashMap(copy);
}));
check('invalid function hash is rejected', rejects(() => {
  assertExactEdgeFunctionHashMap({ ...hashes, 'send-email': 'not-a-hash' });
}));
check('duplicate inventory names are rejected', rejects(() => {
  assertExactEdgeFunctionInventory([...EDGE_FUNCTIONS, EDGE_FUNCTIONS[0]]);
}));

const generator = readFileSync('scripts/generate-release-manifest.mjs', 'utf8');
const writer = readFileSync('scripts/write-release-set.mjs', 'utf8');
const verifier = readFileSync('scripts/verify-archive-manifest.mjs', 'utf8');
check('manifest generation fails closed against the exact inventory',
  /assertExactEdgeFunctionInventory\(fnDirs/.test(generator)
  && /edge_function_inventory: EDGE_FUNCTIONS/.test(generator));
check('release-set writer refuses incomplete function maps',
  /assertExactEdgeFunctionHashMap\(manifest\.edge_function_trees/.test(writer)
  && /edge_function_inventory: EDGE_FUNCTIONS/.test(writer));
check('archive verifier checks disk, manifest and signed-set inventories',
  /archive carries the exact code-owned Edge Function inventory/.test(verifier)
  && /set: enumerates the complete code-owned Edge Function inventory/.test(verifier));

console.log(`\nEdge Function inventory: ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
