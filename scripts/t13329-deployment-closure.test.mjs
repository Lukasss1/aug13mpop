#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(p, 'utf8');
const redirects = read('public/_redirects');
const netlify = read('netlify.toml');
const uploader = read('scripts/deploy-netlify-zip.mjs');
const release = read('.github/workflows/release.yml');
const commission = read('.github/workflows/commission-production-backend.yml');
const launch = read('launch/launch.sh');
const dbWrapper = read('scripts/commission-database.sh');
const seoCore = read('supabase/functions/request-seo-rebuild/core.ts');
const seoSecrets = read('scripts/verify-supabase-secrets.mjs');
const functionDeploy = read('launch/deploy-public-functions.sh');
const prodRls = read('scripts/rls-production-smoke.mjs');
const inputGate = read('scripts/validate-production-release-inputs.mjs');
const productionInputs = read('scripts/lib/production-inputs.mjs');
const localPreflight = read('scripts/production-release-preflight.mjs');
const rollback = read('scripts/rollback-netlify-deploy.mjs');
const currentCommissioning = read('PRODUCTION-COMMISSIONING-T13.3.30.md');

let pass = 0, fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (ok) pass++; else { fail++; process.exitCode = 1; }
};

const staticMarker = redirects.indexOf('/.well-known/milkpop-release.json');
const staticSpa = redirects.indexOf('/*');
const netlifyMarker = netlify.indexOf('from = "/.well-known/milkpop-release.json"');
const netlifySpa = netlify.indexOf('from = "/*"');
check('static redirects define a non-forced exact release-marker 404', /\/\.well-known\/milkpop-release\.json\s+\/index\.html\s+404/.test(redirects));
check('static marker rule precedes SPA fallback', staticMarker >= 0 && staticSpa > staticMarker);
check('Netlify config defines exact marker rule', /from = "\/\.well-known\/milkpop-release\.json"[\s\S]{0,100}status = 404/.test(netlify));
check('Netlify exact marker rule precedes catch-all SPA rule', netlifyMarker >= 0 && netlifySpa > netlifyMarker);
check('marker redirect is not forced, allowing real signed file shadowing', !/from = "\/\.well-known\/milkpop-release\.json"[\s\S]{0,140}force = true/.test(netlify));

check('Netlify publisher uses documented digest inventory rather than base64 ZIP JSON',
  /JSON\.stringify\(\{ draft: true, files \}\)/.test(uploader) && /application\/octet-stream/.test(uploader) && !/toString\(['"]base64['"]\)/.test(uploader));
check('release deploys bytes materialized from the verified signed package',
  /materialize-verified-dist\.mjs/.test(release) && /release-out\/verified-dist/.test(release));
check('all late production secrets are validated before deployment mutation',
  /Validate every protected production input before any mutation/.test(release) && /PRODUCTION_OWNER_TOTP_SECRET/.test(productionInputs) && /NETLIFY_AUTH_TOKEN/.test(productionInputs) && /validateReleaseInputs/.test(inputGate));
check('local public preflight also rejects opaque Supabase keys in the legacy anon variable',
  /validateLegacyJwt/.test(localPreflight) && /startsWith\('sb_'\)/.test(productionInputs));

check('fresh emptiness proof includes Auth and Storage, not just public tables',
  /auth\.users/.test(launch) && /storage\.buckets/.test(launch) && /storage\.objects/.test(launch) && /public application routines/.test(launch) && /db_rls_auto_enable_safety_state/.test(launch));
check('database URL uses exact Supabase target parser', /validate-supabase-db-target\.mjs/.test(dbWrapper));
check('fresh schema+seed+empty ledger commit atomically',
  /schema \+ public seed \+ empty migration ledger committed together/.test(launch) && /ledger_ddl \| pg -q -1/.test(launch));
check('bootstrap-pending resume is guarded and never replays schema/seed',
  /--db-resume-install/.test(launch) && /db_resume_install_safe/.test(launch) && /no Auth users, business\/staff\/form data or Storage objects/.test(launch));
check('commissioning exposes guarded resume and skips identity gates until bootstrap',
  /options: \[verify-only, recover-known-partial, fresh, resume, upgrade\]/.test(commission) && /RECOVER KNOWN PARTIAL/.test(commission) && /RESUME INSTALL/.test(commission) && /database_mode != 'fresh' && inputs\.database_mode != 'resume' && inputs\.database_mode != 'recover-known-partial'/.test(commission));

check('production RLS smoke needs no fake manager/second store',
  /STAFF_EMAIL/.test(prodRls) && /OWNER_TOTP_SECRET/.test(prodRls) && !/MGR_A_EMAIL|STAFF_B_EMAIL|Store B/.test(prodRls));
check('cross-store production topology is not required by commissioning',
  /rls-production-smoke\.mjs/.test(commission) && !/MGR_A_TOTP_SECRET:/.test(commission));

check('SEO publisher cannot call a hosting hook',
  /NEVER publishes production directly/.test(seoCore) && /SEO_REFRESH_PROTECTED_RELEASE/.test(seoCore) && !/SEO_DEPLOY_HOOK_URL/.test(seoCore));
check('SEO deploy hook is no longer a required Supabase secret', !/SEO_DEPLOY_HOOK_URL/.test(seoSecrets));

check('partial Edge Function deployment emits explicit mixed-state recovery',
  /FUNCTION_DEPLOY_INCOMPLETE/.test(functionDeploy) && /FUNCTION_DEPLOY_RECOVERY_REQUIRED/.test(functionDeploy));
check('post-publication workflow restores the previous coherent frontend/backend release when possible',
  /Restore the previous frontend and backend after failed post-publication proof/.test(release)
    && /rollback-netlify-deploy\.mjs/.test(release)
    && /restore-public-functions-from-git\.sh/.test(release));
check('Netlify rollback helper stays frontend-scoped while the release workflow coordinates backend recovery separately',
  /scope:\s*'frontend-only'/.test(rollback) && /backend_functions_unchanged:\s*true/.test(rollback));
check('previous-live compatibility wording matches the owner-MFA proof actually run',
  /Verify the previously live owner\/MFA flow/.test(release) && !/Prove the previously live frontend still works/.test(release));
check('current operator authority documents one protected publisher and hosted Auth commissioning',
  /one production authority|one protected production publisher/.test(currentCommissioning)
  && /hosted Supabase Auth (?:Site URL|settings)/i.test(currentCommissioning)
  && /before the final production-branch push/.test(currentCommissioning)
  && /must remain disabled afterwards/.test(currentCommissioning)
  && /Enforce Git-based deployments/.test(currentCommissioning));

console.log(`\nT13.3.29 deployment closure: ${pass}/${pass + fail} checks passed.`);
