import fs from 'node:fs';
import { ALL_STAGES, STAGE_CONTRACT } from './lib/release-contract.mjs';

const seal = fs.readFileSync(new URL('./release-seal.sh', import.meta.url), 'utf8');
const verifyRelease = fs.readFileSync(new URL('./verify-release.sh', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const evidence = fs.readFileSync(new URL('../CURRENT-RELEASE-EVIDENCE.md', import.meta.url), 'utf8');
const provenance = fs.readFileSync(new URL('./release-provenance-attacks.test.mjs', import.meta.url), 'utf8');
const preflight = fs.readFileSync(new URL('./production-release-preflight.mjs', import.meta.url), 'utf8');

let passed = 0;
const failures = [];
function check(name, ok) {
  if (ok) { passed += 1; console.log(`✓ ${name}`); }
  else { failures.push(name); console.error(`✗ ${name}`); }
}


function normaliseCommand(command) {
  return command.replace(/\s+/g, ' ').trim();
}

function collectScriptStages() {
  const rows = [];
  for (const match of verifyRelease.matchAll(/^\s*stage\s+"([^"]+)"\s+([^\n#]+?)\s*$/gm)) {
    rows.push({ source: 'verify-release.sh', stage: match[1], command: normaliseCommand(match[2]) });
  }
  for (const match of seal.matchAll(/^\s*seal_stage\s+"([^"]+)"\s+([^\n#]+?)\s*$/gm)) {
    rows.push({ source: 'release-seal.sh', stage: match[1], command: normaliseCommand(match[2]) });
  }
  const productionBuild = seal.match(/stage:'production-build'[\s\S]{0,600}?command:'([^']+)'/);
  if (productionBuild) {
    rows.push({ source: 'release-seal.sh', stage: 'production-build', command: normaliseCommand(productionBuild[1]) });
  }
  return rows;
}

const emittedStages = collectScriptStages();
const emittedNames = emittedStages.map((row) => row.stage);
const duplicateStages = [...new Set(emittedNames.filter((stage, index) => emittedNames.indexOf(stage) !== index))].sort();
const unknownStages = [...new Set(emittedNames.filter((stage) => !STAGE_CONTRACT[stage]))].sort();
const missingStages = ALL_STAGES.filter((stage) => !emittedNames.includes(stage));
const commandMismatches = emittedStages.filter((row) => STAGE_CONTRACT[row.stage] && STAGE_CONTRACT[row.stage].command !== row.command);

check('release scripts emit every code-owned contract stage exactly once',
  duplicateStages.length === 0 && unknownStages.length === 0 && missingStages.length === 0);
check('release script commands exactly match the code-owned contract', commandMismatches.length === 0);
check('T13.3.6 closure stages are contract-owned',
  ['db-smallbiz-closure', 'closure-hydration', 'db-closure-2nd-store', 't13-behaviour', 'browser-launch-polish']
    .every((stage) => emittedNames.includes(stage) && STAGE_CONTRACT[stage]));

check('seal accepts a general release identity', !seal.includes('must end in a tranche'));
check('seal has no legacy TRANCHE derivation', !/TRANCHE=/.test(seal));
check('seal has no hard-coded INC11 artifact path', !/MilkPop-web-full-R4_10-INC11/.test(seal));
check('seal derives a sanitised artifact slug', /ARTIFACT_SLUG=.*sed -E/.test(seal));
check('seal defaults to stable current evidence', /MP_EVIDENCE_DOC:-CURRENT-RELEASE-EVIDENCE\.md/.test(seal));
check('seal rejects unsafe evidence paths', /unsafe MP_EVIDENCE_DOC/.test(seal) && /resolves outside the source tree/.test(seal));
check('seal excludes generated release-out from the source package', /zip -qr \"\$PKG\" \. [^\n]*-x \"release-out\/\*\"/.test(seal));
check('workflow serialises production releases', /group: milkpop-production-mutation/.test(workflow) && /cancel-in-progress: false/.test(workflow));
check('workflow installs PostgreSQL for the seal lane', /Install and start PostgreSQL/.test(workflow) && /service postgresql start/.test(workflow));
check('workflow adapts legacy su-postgres harnesses without weakening them', /milkpop-ci-bin/.test(workflow) && /sudo -n -u postgres bash -lc/.test(workflow) && /GITHUB_PATH/.test(workflow));
check('workflow separates release identity from release number', /identity=/.test(workflow) && /number=/.test(workflow));
check('workflow validates integer release number', /release number must be a positive integer/.test(workflow));
check('workflow passes selected evidence document', /MP_EVIDENCE_DOC:.*steps\.rel\.outputs\.evidence/.test(workflow));
check('workflow uses resolved identity', /MP_RELEASE_IDENTITY:.*steps\.rel\.outputs\.identity/.test(workflow));
check('workflow derives identity from the reviewed source template', /SOURCE_IDENT=.*VITE_RELEASE_IDENTITY/.test(workflow) && /IDENT=\"\$SOURCE_IDENT\"/.test(workflow));
check('workflow rejects an operator identity that differs from source', /requested release identity does not match the source-owned identity/.test(workflow) && /\[ \"\$IDENT\" != \"\$SOURCE_IDENT\" \]/.test(workflow));
check('workflow does not invent tag or manual identities', !/r4\.10-\$\{GITHUB_REF_NAME/.test(workflow) && !/r4\.10-manual-\$N/.test(workflow));
check('seal validates the monotonic release number itself', /production seal requires MP_RELEASE_NUMBER/.test(seal) && /MP_RELEASE_NUMBER must be a positive integer/.test(seal));
check('current evidence identifies commissioning requirement', /SOURCE CANDIDATE — PROTECTED CLOUD PROOF REQUIRED|PRODUCTION BUILD AND LIVE COMMISSIONING REQUIRED/.test(evidence));
check('pre-seal provenance suite creates an isolated deterministic build fixture', /release provenance fixture/.test(provenance) && /fixtureDist/.test(provenance) && /MP_RELEASE_BUILD_DIR: fixtureDist/.test(provenance));
check('workflow passes all production deployment markers',
  /TURNSTILE_SERVER_ENABLED:.*vars\.TURNSTILE_SERVER_ENABLED/.test(workflow)
  && /FORM_ALLOWED_ORIGINS_SET:.*vars\.FORM_ALLOWED_ORIGINS_SET/.test(workflow)
  && /CV_ALLOWED_ORIGINS_SET:.*vars\.CV_ALLOWED_ORIGINS_SET/.test(workflow)
  && /EMAIL_ALLOWED_ORIGINS_SET:.*vars\.EMAIL_ALLOWED_ORIGINS_SET/.test(workflow)
  && /MEDIA_BACKEND_READY:.*vars\.MEDIA_BACKEND_READY/.test(workflow));
check('workflow keeps unsafe gated features explicitly disabled',
  /VITE_CAREERS_CV_UPLOAD: "false"/.test(workflow)
  && /MEDIA_CLEANUP_ENABLED: "false"/.test(workflow));
check('workflow cleans up the temporary signing key with a trap', /trap 'rm -f "\$KEY_FILE"' EXIT/.test(workflow));
check('workflow runs production preflight before sealing', /node scripts\/production-release-preflight\.mjs[\s\S]*bash scripts\/release-seal\.sh/.test(workflow));
check('workflow records authenticated release verification as bound evidence', /verify-archive-manifest\.mjs[\s\S]*signed-release-verification\.log[\s\S]*write-deployment-receipt\.mjs/.test(workflow));
check('workflow pins the official Supabase CLI action', /supabase\/setup-cli@[a-f0-9]{40}/.test(workflow));
check('workflow requires exact live migration ledger acceptance before sealing', /deployed-acceptance-probe\.mjs[\s\S]*Seal — ONE production build/.test(workflow));
check('workflow mutates the public 14-function set only when the signed backend identity changed',
  /decide-public-function-deploy\.mjs/.test(workflow)
    && /FUNCTION_DEPLOY_SKIPPED_UNCHANGED/.test(workflow)
    && /bash launch\/deploy-public-functions\.sh/.test(workflow)
    && !/supabase functions deploy --project-ref/.test(workflow));
check('workflow verifies required Edge Function secrets', /verify-supabase-secrets\.mjs/.test(workflow));
check('workflow retains backend gate logs in release evidence', /artifacts\/release-backend\//.test(workflow) && /path:[\s\S]*artifacts\/release-backend\//.test(workflow));
check('workflow proves durable outbox delivery with protected service role', /SUPABASE_SERVICE_ROLE_KEY:.*secrets\.SUPABASE_SERVICE_ROLE_KEY/.test(workflow) && /outbox-delivery\.live\.mjs/.test(workflow));
check('deployment receipt binds signed provenance, backend compatibility, draft, live and two-browser owner evidence', /write-deployment-receipt\.mjs[\s\S]*signed-release-verification\.log[\s\S]*deployed-acceptance\.log[\s\S]*auth-before-backend\.log[\s\S]*function-deploy\.log[\s\S]*auth-after-backend\.log[\s\S]*netlify-draft\.json[\s\S]*live-marker\.log[\s\S]*auth-browser-chromium\.log[\s\S]*auth-browser-webkit\.log/.test(workflow));
check('release verifies live headers and SEO parity before writing the deployment receipt',
  /Verify live security headers and SEO\/database parity[\s\S]*test:headers-live[\s\S]*test:seo-live[\s\S]*Record the complete production deployment receipt/.test(workflow));
check('release retains post-deploy live-smoke evidence', /artifacts\/release-live\//.test(workflow));
check('live deployment proof waits for the exact signed release marker', /wait-for-live-release\.mjs/.test(workflow) && /LIVE RELEASE MARKER PASS/.test(fs.readFileSync(new URL('./wait-for-live-release.mjs', import.meta.url), 'utf8')));
check('workflow deploys through the in-repo file-digest draft publisher', /node scripts\/deploy-netlify-zip\.mjs/.test(workflow) && !/npx netlify-cli/.test(workflow));
check('workflow uploads detached manifests and Netlify draft/publish receipts', /release-out\/\*\.manifest\.json/.test(workflow) && /release-out\/netlify-draft\.json/.test(workflow) && /release-out\/netlify-publish\.json/.test(workflow));
check('workflow verifies a non-live draft before promoting the exact deploy', /non-live Netlify draft[\s\S]*Verify the non-live draft[\s\S]*promote-netlify-deploy\.mjs/.test(workflow));
check('workflow proves the old owner/MFA flow before and after the backend compatibility boundary',
  /Verify the current live owner flow before changing backend functions[\s\S]*Deploy the complete public\/staff Edge Function set only when its signed identity changed[\s\S]*Verify the previously live owner\/MFA flow still works with the newly deployed backend[\s\S]*Promote the exact verified Netlify draft/.test(workflow));
check('workflow restores the prior coherent release after failed post-publication proof',
  /failure\(\) && steps\.promote\.outcome == 'success'/.test(workflow)
    && /rollback-netlify-deploy\.mjs/.test(workflow)
    && /restore-public-functions-from-git\.sh/.test(workflow));
check('workflow checks the live rollback floor before seal and before deploy', (workflow.match(/check-live-release-floor\.mjs/g) || []).length >= 2 && /MP_ALLOW_FIRST_DEPLOY_WITHOUT_MARKER/.test(workflow));
check('direct production seal runs the same preflight', /production release preflight[\s\S]*production-release-preflight\.mjs/.test(seal));
check('preflight binds signing key, trust policy, domain and backend',
  /private signing key matches the pinned public key/.test(preflight)
  && /trust policy approves this site domain/.test(preflight)
  && /trust policy approves this Supabase project/.test(preflight));

console.log(`\nRelease pipeline contract: ${passed}/${passed + failures.length} passed`);
if (failures.length) process.exit(1);
