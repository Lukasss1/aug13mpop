#!/usr/bin/env node
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const security = fs.readFileSync(new URL('../.github/workflows/security.yml', import.meta.url), 'utf8');
const release = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const staging = fs.readFileSync(new URL('../.github/workflows/staging-integration.yml', import.meta.url), 'utf8');
const verifyRelease = fs.readFileSync(new URL('./verify-release.sh', import.meta.url), 'utf8');
const browserRunner = fs.readFileSync(new URL('./run-browser-suite.sh', import.meta.url), 'utf8');
const deploymentReceipt = fs.readFileSync(new URL('./write-deployment-receipt.mjs', import.meta.url), 'utf8');
const stagingIntegration = fs.readFileSync(new URL('./staging-integration.test.mjs', import.meta.url), 'utf8');

let passed = 0;
const failed = [];
function check(name, condition) {
  if (condition) { passed += 1; console.log(`✓ ${name}`); }
  else { failed.push(name); console.error(`✗ ${name}`); }
}

check('one browser runner owns the complete local/CI suite',
  pkg.scripts['test:browser:run'] === 'bash scripts/run-browser-suite.sh'
  && /test:routing/.test(browserRunner)
  && /audit:clicks/.test(browserRunner)
  && /audit:final/.test(browserRunner)
  && /audit:launch-polish/.test(browserRunner)
  && /test:browser-compat/.test(browserRunner)
  && /test:auth-multitab-browser/.test(browserRunner)
  && /test:r49-browser/.test(browserRunner));
check('browser runner starts preview before launch-polish and always cleans it up',
  browserRunner.indexOf('vite" preview') < browserRunner.indexOf('audit:launch-polish')
  && /trap cleanup EXIT INT TERM/.test(browserRunner));
check('CI browser job uses the complete runner',
  /Run the complete browser suite[\s\S]*MP_BROWSER_SKIP_BUILD:[\s\S]*npm run test:browser:run/.test(security));
check('CI installs and runs Chromium, Firefox and WebKit compatibility coverage',
  /playwright install --with-deps chromium firefox webkit/.test(security)
  && /test:browser-compat/.test(browserRunner));
check('Deno-native Edge Function checks are blocking in CI and release',
  /edge-functions-deno:/.test(security) && /npm run test:deno/.test(security)
  && /denoland\/setup-deno@[a-f0-9]{40}/.test(release) && /npm run test:deno/.test(release));
check('CI has a blocking database durability job',
  /database-durability:[\s\S]*test:database-durability/.test(security)
  && /test:backup-restore/.test(pkg.scripts['test:database-durability'])
  && /test:ws7-concurrency-repeat/.test(pkg.scripts['test:database-durability']));
check('release verification includes retention, restore and repeated concurrency',
  /stage "db-retention"\s+npm run test:retention/.test(verifyRelease)
  && /stage "db-backup-restore"\s+npm run test:backup-restore/.test(verifyRelease)
  && /stage "db-concurrency-repeat"\s+npm run test:ws7-concurrency-repeat/.test(verifyRelease));
check('release browser verification includes accessibility and real multi-tab auth',
  /stage "browser-launch-polish"\s+npm run audit:launch-polish/.test(verifyRelease)
  && /stage "browser-auth-multitab"\s+npm run test:auth-multitab-browser/.test(verifyRelease));
check('launch-polish is not run before the preview server block',
  verifyRelease.indexOf('stage "browser-launch-polish"') > verifyRelease.indexOf('vite" preview'));
check('release verifies a Netlify draft before exact-id promotion and retains rollback', /netlify-draft\.json/.test(release) && /promote-netlify-deploy\.mjs/.test(release) && /rollback-netlify-deploy\.mjs/.test(release));
check('post-deploy release gate executes live headers and SEO parity',
  /test:headers-live/.test(release) && /test:seo-live/.test(release)
  && release.indexOf('test:headers-live') < release.indexOf('Record the complete production deployment receipt'));
check('deployment receipt hashes and validates complete backend/frontend evidence',
  /evidencePaths/.test(deploymentReceipt) && /evidence/.test(deploymentReceipt)
  && /deployed-acceptance\.log/.test(deploymentReceipt)
  && /netlify-draft\.json/.test(deploymentReceipt)
  && /live-marker\.log/.test(deploymentReceipt)
  && /auth-browser-chromium\.log/.test(deploymentReceipt)
  && /auth-browser-webkit\.log/.test(deploymentReceipt)
  && /requires exactly/.test(deploymentReceipt));
check('release mandates real authenticated owner browser smoke in Chromium and WebKit',
  !/RUN_AUTH_BROWSER_SMOKE/.test(release)
  && !/AUTHENTICATED_BROWSER_SMOKE_SKIPPED/.test(release)
  && /SMOKE_BROWSER: chromium/.test(release)
  && /SMOKE_BROWSER: webkit/.test(release)
  && (release.match(/test:live-auth-browser/g) || []).length === 4
  && (release.match(/SMOKE_BROWSER: chromium/g) || []).length === 3
  && (release.match(/SMOKE_BROWSER: webkit/g) || []).length === 1
  && /PRODUCTION_OWNER_EMAIL/.test(release));
check('stateful authenticated integration is isolated to a protected staging workflow',
  !/staging-integration\.test\.mjs/.test(fs.readFileSync(new URL('../.github/workflows/commission-production-backend.yml', import.meta.url), 'utf8'))
  &&   /environment: staging/.test(staging)
  && /MP_STAGING_SUPABASE_PROJECT_REF/.test(staging)
  && /RUN STAGING INTEGRATION/.test(staging)
  && /npm run test:staging/.test(staging));
check('protected staging proves the exact source ledger and functions before the stateful journey',
  /MP_STAGING_DISPOSABLE/.test(staging)
  && /commission-database\.sh upgrade/.test(staging)
  && /deploy-public-functions\.sh/.test(staging)
  && /deployed-acceptance-probe\.mjs/.test(staging)
  && staging.indexOf('commission-database.sh upgrade') < staging.indexOf('npm run test:staging'));
check('staging integration validates the URL against the confirmed project ref',
  /STAGING_SUPABASE_URL does not match the protected staging project ref/.test(staging));
check('staging integration upgrades enrolled accounts to real AAL2',
  /factors\/\$\{encodeURIComponent\(factor\.id\)\}\/challenge/.test(stagingIntegration)
  && /factors\/\$\{encodeURIComponent\(factor\.id\)\}\/verify/.test(stagingIntegration)
  && /totpWindow\(totpSecret\)/.test(stagingIntegration));
check('stateful staging probes minimise rewards and fail closed on cleanup',
  /points: 0, badge: ''/.test(stagingIntegration)
  && /stg_menu_probe_/.test(stagingIntegration)
  && /cleanup: \${item\.label}/.test(stagingIntegration)
  && /p_expected_revision: rev1/.test(stagingIntegration));
check('the normal static verify lane enforces this closure contract',
  /npm run test:evidence-closure/.test(pkg.scripts.verify));

console.log(`\nEvidence closure contract: ${passed}/${passed + failed.length} passed`);
if (failed.length) process.exit(1);
