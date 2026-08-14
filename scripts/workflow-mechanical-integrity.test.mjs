#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(ROOT, '.github', 'workflows');
const workflowFiles = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name)).sort();
const workflows = new Map(workflowFiles.map((name) => [name, readFileSync(path.join(workflowDir, name), 'utf8')]));
const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const nvmrc = readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim();
const netlify = readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
const postgresInstaller = readFileSync(path.join(ROOT, 'scripts', 'install-postgresql-17.sh'), 'utf8');

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`✓ ${name}`); }
  else { failures.push(name); console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const all = [...workflows.values()].join('\n');
const uses = [...all.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((m) => m[1]);
const externalUses = uses.filter((ref) => !ref.startsWith('./'));
check('every external GitHub Action is pinned to a full commit SHA',
  externalUses.length > 0 && externalUses.every((ref) => /@(?:[0-9a-f]{40})$/i.test(ref)),
  externalUses.filter((ref) => !/@(?:[0-9a-f]{40})$/i.test(ref)).join(', '));

let checkoutSafe = true;
for (const [name, src] of workflows) {
  for (const match of src.matchAll(/^(\s*)- uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*\n([\s\S]*?)(?=^\1- |^\s{0,6}[A-Za-z_-]+:|(?![\s\S]))/gm)) {
    if (!/persist-credentials:\s*false/.test(match[2])) checkoutSafe = false;
  }
}
check('every checkout disables persisted Git credentials', checkoutSafe);

check('local, CI and Netlify use one exact Node runtime',
  nvmrc === '22.23.2'
  && packageJson.engines?.node === '>=22.23.2 <23'
  && /NODE_VERSION\s*=\s*"22\.23\.2"/.test(netlify)
  && !/node-version:\s*20\b/.test(all)
  && [...all.matchAll(/node-version:\s*([^\n#]+)/g)].every((m) => /22\.23\.2|matrix\.node-version/.test(m[1])));
check('npm minimum matches the declared package manager floor',
  packageJson.packageManager === 'npm@10.9.8' && packageJson.engines?.npm === '>=10.9.8 <11');
check('workflow dependency caches are not used in privileged evidence lanes', !/^\s*cache:\s*npm\s*$/m.test(all));
check('PostgreSQL workflows use one source-owned PostgreSQL 17 installer',
  /install-postgresql-17\.sh/.test(all)
  && !/postgresql-(?:client-)?16\b/.test(all)
  && /postgresql-17 postgresql-client-17/.test(postgresInstaller)
  && /postgresql-client-17/.test(postgresInstaller));
check('PostgreSQL 17 installer uses the signed official PGDG repository and pins the actual client major',
  /apt\.postgresql\.org\/pub\/repos\/apt/.test(postgresInstaller)
  && /ACCC4CF8\.asc/.test(postgresInstaller)
  && /Signed-By: \/usr\/share\/postgresql-common\/pgdg\/apt\.postgresql\.org\.asc/.test(postgresInstaller)
  && /psql --version \| grep -Eq ' 17\\\.'/g.test(postgresInstaller));
const activeDbHarnesses = readdirSync(path.join(ROOT, 'scripts'))
  .filter((name) => /\.(?:sh|mjs)$/.test(name))
  .map((name) => readFileSync(path.join(ROOT, 'scripts', name), 'utf8'))
  .join('\n');
check('database harnesses cannot silently select an older installed PostgreSQL major',
  !/\/usr\/lib\/postgresql\/\*\/bin/.test(activeDbHarnesses)
  && /PGBIN="\/usr\/lib\/postgresql\/17\/bin"/.test(activeDbHarnesses));

check('GitHub CI makes PostgreSQL 17 the default server, not only the default client',
  /pg_conftool 17 main set port 5432/.test(postgresInstaller)
  && /show server_version_num/.test(postgresInstaller));
const denoVersions = [...all.matchAll(/deno-version:\s*(v[0-9.]+)/g)].map((m) => m[1]);
check('Deno runtime is exact-pinned and consistent across CI and release',
  denoVersions.length === 2 && denoVersions.every((version) => version === 'v2.9.5'));

check('production workflows share one mutation lock',
  /group:\s*milkpop-production-mutation/.test(workflows.get('release.yml'))
  && /group:\s*milkpop-production-mutation/.test(workflows.get('commission-production-backend.yml')));
check('staging workflow uses the protected staging mutation lock',
  /group:\s*milkpop-staging-mutation/.test(workflows.get('staging-integration.yml')));

const security = workflows.get('security.yml');
const securityRegression = security.match(/\n {2}security-regression:[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:|\s*$)/)?.[0] ?? '';
check('security-regression installs the locked dependency tree before package executables',
  /run:\s*npm ci/.test(securityRegression)
  && securityRegression.indexOf('npm ci') < securityRegression.indexOf('npm run test:security'));

const backend = workflows.get('commission-production-backend.yml');
check('Supabase management token is not exposed at backend job scope',
  !/\n\s{4}env:[\s\S]{0,300}SUPABASE_ACCESS_TOKEN/.test(backend));
check('release source guard receives the GitHub token only for its read-only step', /Verify the release commit[\s\S]*GITHUB_TOKEN: \${{ github\.token }}[\s\S]*verify-release-source-ref\.mjs/.test(workflows.get('release.yml')));
check('release verifier defines an absolute repository root before using it',
  /ROOT="\$\(cd "\$\(dirname "\$0"\)\/\.\." && pwd\)"/.test(readFileSync(path.join(ROOT, 'scripts/verify-release.sh'), 'utf8')));
check('canonical source hashing excludes only the generated root release-out directory',
  /'release-out'/.test(readFileSync(path.join(ROOT, 'scripts/lib/release-hash.mjs'), 'utf8')));

console.log(`\nWorkflow mechanical integrity: ${passed}/${passed + failures.length} passed`);
if (failures.length) process.exit(1);
