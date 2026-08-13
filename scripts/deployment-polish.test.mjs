#!/usr/bin/env node
/** T13.3.14 deployment-polish invariants retained by the current source. */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
const check = (label, condition) => {
  if (condition) { passed += 1; console.log(`PASS — ${label}`); }
  else { failed += 1; console.log(`FAIL — ${label}`); }
};

const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const env = read('.env.example');
const netlify = read('netlify.toml');
const headers = read('public/_headers');
const index = read('index.html');
const artifactGate = read('scripts/verify-production-artifact.mjs');
const provenance = read('scripts/release-provenance-attacks.test.mjs');
const publicPages = read('src/components/PublicPages.tsx');
const footer = read('src/components/Footer.tsx');
const app = read('src/App.tsx');
const manifest = read('launch/migration-manifest.sh');
const headerRule = (route) => {
  const lines = headers.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === route);
  if (start < 0) return '';
  const values = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s+\S/.test(line)) values.push(line.trim());
    else if (line.trim().startsWith('/')) break;
  }
  return values.join('\n');
};

check('application version is 4.10.15', pkg.version === '4.10.15' && lock.version === '4.10.15' && lock.packages?.['']?.version === '4.10.15');
check('current release identity retains the deployment-polish layer', /^VITE_RELEASE_IDENTITY=r4\.10\.15-t13\.3\.30-final-production-closure$/m.test(env));
check('current append-only chain retains deployment polish and runtime resilience', /migration_t13313_staff_portal_integrity\.sql"[\s\S]*migration_t13319_release_integrity\.sql"\s+"supabase\/migration_t13320_final_audit\.sql"\s+"supabase\/migration_t13322_public_store_scope\.sql"\s*\)/s.test(manifest) && !/migration_t1331[456]/.test(manifest));
check('production Netlify builds use the hard production wrapper', /\[context\.production\][\s\S]{0,120}command\s*=\s*"npm run build:production"/.test(netlify));
check('deploy previews retain the normal advisory build', /\[build\][\s\S]{0,100}command\s*=\s*"npm run build"/.test(netlify) && /\[context\.deploy-preview\.environment\][\s\S]{0,100}VITE_DEPLOYMENT_MODE\s*=\s*"preview"/.test(netlify));
check('catch-all security headers do not shadow hashed-asset caching', !/Cache-Control:/i.test(headerRule('/*')));
check('hashed assets remain immutable', /\/assets\/\*[\s\S]{0,120}Cache-Control:\s*public,\s*max-age=31536000,\s*immutable/.test(headers));
check('live release marker is never cached', /\/\.well-known\/milkpop-release\.json[\s\S]{0,140}Cache-Control:\s*no-store,\s*max-age=0/.test(headers));
check('the shell declares its light-only colour scheme', /<meta name="color-scheme" content="light"/.test(index) && /html \{ color-scheme: light; \}/.test(read('src/index.css')));
check('the homepage LCP mascot is discovered from HTML', /rel="preload" as="image"[^>]+mascot_wave\.webp[^>]+fetchpriority="high"/.test(index));
check('the LCP image keeps intrinsic dimensions and high fetch priority', /src=\{MASCOT\.wave\}[\s\S]{0,180}width=\{800\}[\s\S]{0,80}height=\{800\}[\s\S]{0,120}fetchPriority="high"/.test(publicPages));
check('secondary branded imagery carries decode/layout metadata', /STICKERS\.bunny[\s\S]{0,160}width=\{413\}[\s\S]{0,100}height=\{420\}[\s\S]{0,120}decoding="async"/.test(footer) && /PortalLoading[\s\S]{0,260}width=\{800\}[\s\S]{0,80}height=\{800\}[\s\S]{0,100}decoding="async"/.test(app));
check('production artefact rejects source maps and unhashed cache assets', /no JavaScript or CSS source maps ship publicly/.test(artifactGate) && /every cacheable JS\/CSS asset has a content hash/.test(artifactGate));
check('production artefact enforces bounded JS and CSS output', /initialJs:\s*1\.75 \* MIB/.test(artifactGate) && /totalJs:\s*4 \* MIB/.test(artifactGate) && /largestCss:\s*512 \* KIB/.test(artifactGate));
check('release-provenance positive control models the hardened artefact shape', /assets\/app-abcdef12\.js/.test(provenance) && /path\.join\(d, '_headers'\)/.test(provenance) && /path\.join\(d, '_redirects'\)/.test(provenance));
check('current T13.3.30 commissioning authority exists', existsSync(path.join(ROOT, 'PRODUCTION-COMMISSIONING-T13.3.30.md')));

console.log(`\nDEPLOYMENT POLISH RETAINED — ${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
