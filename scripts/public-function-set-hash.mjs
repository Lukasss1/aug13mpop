#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashBuildDir } from './lib/release-hash.mjs';
import {
  PUBLIC_FUNCTION_NAMES,
  computePublicFunctionSetSha256,
} from './lib/edge-function-inventory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const functionsRoot = path.resolve(ROOT, process.argv[2] || 'supabase/functions');
const hashes = Object.fromEntries(
  PUBLIC_FUNCTION_NAMES.map((name) => [name, hashBuildDir(path.join(functionsRoot, name))]),
);
const shared = hashBuildDir(path.join(functionsRoot, '_shared'));
process.stdout.write(`${computePublicFunctionSetSha256(hashes, shared)}\n`);
