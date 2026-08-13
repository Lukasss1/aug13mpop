#!/usr/bin/env node
/** T13.3.21 — bounded public-launch handoff contracts. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));
let passed = 0;
const failed = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`PASS — ${name}`); }
  else { failed.push(name); console.error(`FAIL — ${name}${detail ? `: ${detail}` : ''}`); }
};

const identity = 'r4.10.9-t13.3.21-public-launch';
const pkg = json('package.json');
const lock = json('package-lock.json');
const manifest = json('release-manifest.json');
const env = read('.env.example');
const launch = read('scripts/public-launch.mjs');
const buildRequired = read('BUILD-REQUIRED.md');
const currentDocs = ['README.md','OPENING-START-HERE.md','OWNERS-GUIDE.md','ROUTING-SEO.md','BUILD-REQUIRED.md','docs/KNOWN-ISSUES.md'];

check('package and lock versions are 4.10.9', pkg.version === '4.10.9' && lock.version === '4.10.9' && lock.packages?.['']?.version === '4.10.9');
check('browser release identity is current', new RegExp(`^VITE_RELEASE_IDENTITY=${identity}$`, 'm').test(env));
check('release manifest identity is current', manifest.release_identity === identity);
check('release manifest version matches package', manifest.release_version === pkg.version);
check('public launch scripts are exposed', pkg.scripts?.['public:preflight'] === 'node scripts/public-launch.mjs --preflight-only' && pkg.scripts?.['public:release'] === 'node scripts/public-launch.mjs');
check('public launch wrapper delegates instead of duplicating release logic', /production-release-preflight\.mjs/.test(launch) && /release-seal\.sh/.test(launch) && !/vite build|npm ci/.test(launch));
check('concise public launch authority exists', fs.existsSync(path.join(ROOT,'PUBLIC-LAUNCH.md')) && /npm run public:release/.test(read('PUBLIC-LAUNCH.md')));
check('current commissioning authority exists', fs.existsSync(path.join(ROOT,'docs/archive/commissioning/PRODUCTION-COMMISSIONING-T13.3.21.md')));
check('public handoff adds no migration', !fs.existsSync(path.join(ROOT,'supabase/migration_t13321_public_launch.sql')) && manifest.migration_count === 106 && manifest.sql_ledger_entry_count === 108);
check('build handoff carries current counts and identity', /T13\.3\.21/.test(buildRequired) && /106 ordered upgrade migrations/.test(buildRequired) && /108 fresh-install SQL entries/.test(buildRequired) && new RegExp(identity).test(buildRequired));
check('production backendless wording is fail-closed', /always refused/.test(env) && /forbidden in production/.test(env) && !/refused UNLESS this is explicitly/.test(env));
check('current operator documents use T13.3.21 authority', currentDocs.every((f) => /PRODUCTION-COMMISSIONING-T13\.3\.21\.md/.test(read(f))), currentDocs.filter((f)=>!/PRODUCTION-COMMISSIONING-T13\.3\.21\.md/.test(read(f))).join(', '));
check('current operator documents do not direct deployment to T13.3.18', currentDocs.every((f) => !/PRODUCTION-COMMISSIONING-T13\.3\.18\.md/.test(read(f))));
check('historical T13.3.20 commissioning remains preserved', fs.existsSync(path.join(ROOT,'docs/archive/commissioning/PRODUCTION-COMMISSIONING-T13.3.20.md')));
check('T13.3.21 release note records no workflow or database change', /Database change:\*\* none/.test(read('docs/releases/T13.3.21-PUBLIC-LAUNCH.md')) && /Application workflow change:\*\* none/.test(read('docs/releases/T13.3.21-PUBLIC-LAUNCH.md')));

console.log(`\nT13.3.21 PUBLIC LAUNCH — ${passed}/${passed + failed.length} passed`);
if (failed.length) process.exit(1);
