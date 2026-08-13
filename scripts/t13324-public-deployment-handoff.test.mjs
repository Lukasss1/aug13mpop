#!/usr/bin/env node
/** T13.3.24 — truthful public deployment handoff. */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));
let passed = 0, failed = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`); ok ? passed++ : failed++; };

const pkg = json('package.json');
const lock = json('package-lock.json');
const env = read('.env.example');
const releaseWorkflow = read('.github/workflows/release.yml');
const backendWorkflow = read('.github/workflows/commission-production-backend.yml');
const publicLaunch = read('PUBLIC-LAUNCH.md');
const commissioning = read('PRODUCTION-COMMISSIONING-T13.3.30.md');
const owner = read('OWNERS-GUIDE.md');
const publicSeal = read('scripts/public-launch.mjs');
const guidance = read('scripts/public-release-guidance.mjs');
const publicDeploy = read('launch/deploy-public-functions.sh');

check('application version is 4.10.15', pkg.version === '4.10.15' && lock.version === '4.10.15' && lock.packages?.['']?.version === '4.10.15');
check('release identity retains the T13.3.24 handoff under T13.3.30', /^VITE_RELEASE_IDENTITY=r4\.10\.15-t13\.3\.30-final-production-closure$/m.test(env));
check('current commissioning authority exists', existsSync(path.join(ROOT, 'PRODUCTION-COMMISSIONING-T13.3.30.md')));
check('production release builds on the exact Node 22 runtime', /actions\/setup-node@[a-f0-9]{40}[\s\S]{0,160}node-version:\s*22\.23\.2/.test(releaseWorkflow));
check('backend commissioning uses the same exact Node 22 runtime', /actions\/setup-node@[a-f0-9]{40}[\s\S]{0,160}node-version:\s*22\.23\.2/.test(backendWorkflow));
check('public deployment remains exactly 14 functions', /PUBLIC_FUNCTION_DEPLOY_PASS \(14 functions; POS deferred\)/.test(publicDeploy) && !/pos-pair|pos-ingest|pos-catalog/.test(publicDeploy));
check('owner guide states 14 deployed and 3 deferred', /14 deployed website\/staff Edge Functions/.test(owner) && /Three POS function sources are retained but are not deployed/.test(owner));
check('operator guide names the protected workflow as the live publisher', /GitHub → Actions → release → Run workflow/.test(publicLaunch) && /only supported path/.test(publicLaunch));
check('commissioning authority names the protected workflow as publisher', /GitHub → Actions → release → Run workflow/.test(commissioning) && /only supported production publisher/.test(commissioning));
check('local seal is explicitly non-deploying', /does (?:\*\*)?not(?:\*\*)? publish Netlify, deploy Supabase Functions or apply database migrations/.test(publicLaunch) && /does not deploy the backend or frontend/.test(commissioning));
check('public:seal owns local artefact creation', pkg.scripts?.['public:seal'] === 'node scripts/public-launch.mjs' && /local cryptographic release set; this does not publish/.test(publicSeal));
check('public:release refuses to imitate deployment', pkg.scripts?.['public:release'] === 'node scripts/public-release-guidance.mjs' && /protected GitHub Actions/.test(guidance) && /process\.exit\(2\)/.test(guidance));
check('public preflight tells operator to trigger protected workflow', /trigger the protected GitHub Actions release workflow to publish/.test(publicSeal));

console.log(`\nT13.3.24 PUBLIC DEPLOYMENT HANDOFF — ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
