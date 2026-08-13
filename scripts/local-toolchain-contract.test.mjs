#!/usr/bin/env node
/**
 * Milk Pop T13.3.12 — locked local toolchain contract.
 *
 * npm scripts may invoke package binaries by name because npm prepends
 * node_modules/.bin to PATH. Shell scripts and CI workflow commands must use
 * explicit ./node_modules/.bin paths. No release/test lane may fall back to
 * npx downloading a different executor from the network.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) { passed++; console.log(`✔ ${name}`); }
  else { failed++; console.log(`✖ ${name}${detail ? `\n    ${detail}` : ''}`); }
};
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const scriptText = Object.entries(pkg.scripts ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n');

const nvmrc = read('.nvmrc').trim();
const lock = JSON.parse(read('package-lock.json'));
const netlify = read('netlify.toml');
const doctor = read('scripts/doctor.mjs');
check('exact supported Node runtime is consistent across local metadata',
  nvmrc === '22.23.2'
  && pkg.engines?.node === '>=22.23.2 <23'
  && lock.packages?.['']?.engines?.node === '>=22.23.2 <23'
  && /NODE_VERSION\s*=\s*"22\.23\.2"/.test(netlify));
check('supported npm range is consistent across package metadata',
  pkg.packageManager === 'npm@10.9.8'
  && pkg.engines?.npm === '>=10.9.8 <11'
  && lock.packages?.['']?.engines?.npm === '>=10.9.8 <11');
check('doctor enforces the same Node and npm floors',
  /compareVersion\(nodeVersion, '22\.23\.2'\)/.test(doctor)
  && /compareVersion\(npmVersion, '10\.9\.8'\)/.test(doctor));

check('package scripts never invoke npx', !/(^|\s)npx(?:\s|$)/m.test(scriptText));
check('TypeScript test runners use the locked local tsx binary',
  !/npx[^\n]*tsx/.test(scriptText) && /\btsx scripts\//.test(scriptText));
const t133Operational = read('scripts/t133-operational.test.mjs');
check('T13.3 operational test uses the project-local TypeScript dependency',
  /from ['\"]typescript['\"]/.test(t133Operational)
  && !t133Operational.includes('/opt/nvm/'));
check('browser setup uses the locked local Playwright binary',
  pkg.scripts?.['test:browser']?.startsWith('playwright install --with-deps chromium'));

for (const rel of [
  'scripts/verify-release.sh',
  'scripts/release-seal.sh',
  'launch/launch.sh',
  '.github/workflows/security.yml',
  '.github/workflows/release.yml',
]) {
  const src = read(rel);
  check(`${rel} has no network-fallback npx executor`, !/(^|\s)npx(?:\s|$)/m.test(src));
}

check('verify-release uses explicit local Playwright',
  /node_modules\/\.bin\/playwright/.test(read('scripts/verify-release.sh')));
check('verify-release uses explicit local Vite',
  /node_modules\/\.bin\/vite/.test(read('scripts/verify-release.sh')));
check('release-seal uses explicit local Vite',
  /node_modules\/\.bin\/vite/.test(read('scripts/release-seal.sh')));
check('legacy launch gate uses explicit local Vite',
  /\.\/node_modules\/\.bin\/vite/.test(read('launch/launch.sh')));
check('security workflow uses the locked browser and the repository-owned preview runner',
  /\.\/node_modules\/\.bin\/playwright/.test(read('.github/workflows/security.yml'))
  && /npm run test:browser:run/.test(read('.github/workflows/security.yml'))
  && /node_modules\/\.bin\/vite/.test(read('scripts/run-browser-suite.sh')));
check('release workflow runs the canonical locked full verify chain',
  /npm run verify\b/.test(read('.github/workflows/release.yml')));

console.log(`\nLOCAL TOOLCHAIN CONTRACT — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
