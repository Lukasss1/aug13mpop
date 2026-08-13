/**
 * tsconfig-hygiene.test.mjs — Phase 1 Check 4 (TypeScript Integrity).
 *
 * Locks in the Stage A/B outcome so it cannot silently regress:
 *
 *   • the broad `typecheck-shims/` fallback declarations (which told TypeScript
 *     to accept nearly anything involving React) are GONE and can never be
 *     pulled back into any production/CI TypeScript configuration — the audit's
 *     required safeguard (finding 4.5 / task 9);
 *   • the browser app is genuinely strict (`strict`, `useUnknownInCatchVariables`)
 *     with the zero-cost flags on (`noImplicitReturns`,
 *     `noFallthroughCasesInSwitch`), the advanced flags on
 *     (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), and `allowJs`
 *     off, so a future edit cannot quietly reopen the weak-typing hole the
 *     audit failed the project for;
 *   • the genuine React type declarations remain declared dependencies, so the
 *     green typecheck stays backed by real types rather than degrading to `any`.
 *
 * Run: npm run test:tsconfig-hygiene   (also part of `npm run verify`)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

let passed = 0,
  failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    passed++;
    console.log(`\u2714 ${name}`);
  } else {
    failed++;
    console.error(`\u2716 ${name}${detail ? `\n    ${detail}` : ''}`);
  }
};

/* ---- 1. the shim directory must be gone --------------------------------- */
check(
  'typecheck-shims/ directory has been removed',
  !existsSync(path.join(REPO, 'typecheck-shims')),
  'the broad React fallback shim must not exist once real @types/react is installed',
);

/* ---- 2. no tsconfig anywhere may reference the shim ---------------------- */
// Discover every tsconfig in the repo (excluding node_modules) so a NEW config
// added later is covered too, not just the two we know about today.
const tsconfigs = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.git')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/^tsconfig(\..+)?\.json$/.test(entry.name)) tsconfigs.push(full);
  }
};
walk(REPO);

check('at least the browser + functions tsconfigs are present', tsconfigs.length >= 2, `found: ${tsconfigs.map((f) => path.relative(REPO, f)).join(', ')}`);

for (const file of tsconfigs) {
  const rel = path.relative(REPO, file);
  const raw = readFileSync(file, 'utf8');
  check(`${rel} does not reference typecheck-shims`, !raw.includes('typecheck-shims'), 'a production/CI TypeScript config must never re-include the broad React shim');
}

/* ---- 3. browser tsconfig strictness invariants -------------------------- */
const browserPath = path.join(REPO, 'tsconfig.json');
const browser = JSON.parse(readFileSync(browserPath, 'utf8'));
const co = browser.compilerOptions || {};

check('tsconfig.json → strict: true', co.strict === true, `got ${JSON.stringify(co.strict)}`);
check('tsconfig.json → useUnknownInCatchVariables: true', co.useUnknownInCatchVariables === true, `got ${JSON.stringify(co.useUnknownInCatchVariables)}`);
check('tsconfig.json → noImplicitReturns: true', co.noImplicitReturns === true, `got ${JSON.stringify(co.noImplicitReturns)}`);
check('tsconfig.json → noFallthroughCasesInSwitch: true', co.noFallthroughCasesInSwitch === true, `got ${JSON.stringify(co.noFallthroughCasesInSwitch)}`);
check('tsconfig.json → exactOptionalPropertyTypes: true', co.exactOptionalPropertyTypes === true, `got ${JSON.stringify(co.exactOptionalPropertyTypes)}`);
check('tsconfig.json → noUncheckedIndexedAccess: true', co.noUncheckedIndexedAccess === true, `got ${JSON.stringify(co.noUncheckedIndexedAccess)}`);
check('tsconfig.json → allowJs: false (no untyped JS in production source)', co.allowJs === false, `got ${JSON.stringify(co.allowJs)}`);

/* ---- 4. genuine React types stay declared ------------------------------- */
const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const dev = pkg.devDependencies || {};
for (const dep of ['@types/react', '@types/react-dom']) {
  check(`${dep} is a declared devDependency`, typeof dev[dep] === 'string', 'real React declarations must remain installed so typecheck is not hollow');
}

/* ---- 5. the `lint` script is a genuine ESLint pass, not a tsc stand-in --- */
const lintScript = pkg.scripts?.lint;
check('package.json → lint runs the code-owned ESLint ratchet (not a tsc stand-in)',
  lintScript === 'node scripts/lint-ratchet.mjs',
  `lint must invoke the ESLint ratchet, got ${JSON.stringify(lintScript)}`);
const lintRatchet = readFileSync(path.join(REPO, 'scripts/lint-ratchet.mjs'), 'utf8');
const lintBaseline = JSON.parse(readFileSync(path.join(REPO, 'scripts/lint-ratchet-baseline.json'), 'utf8'));
check('lint ratchet executes real ESLint', /spawnSync[\s\S]*eslint/.test(lintRatchet), 'ratchet must execute ESLint');
check('lint ratchet retains or lowers the audited warning ceiling',
  Number.isInteger(lintBaseline.maximumWarnings) && lintBaseline.maximumWarnings <= 239,
  `warning ceiling must not exceed 239, got ${JSON.stringify(lintBaseline.maximumWarnings)}`);
check('package.json → verify runs lint (so the ceiling gates CI)',
  typeof pkg.scripts?.verify === 'string' && /\bnpm run lint\b/.test(pkg.scripts.verify),
  'verify must invoke `npm run lint`');

/* ---- 6. the production build is gated on the type-checker ---------------- */
const buildScript = pkg.scripts?.build;
check('package.json → build gates on tsc (typecheck before vite build)',
  typeof buildScript === 'string' && /tsc\b[^&|]*--noEmit/.test(buildScript) && /\bvite build\b/.test(buildScript)
    && buildScript.indexOf('tsc') < buildScript.indexOf('vite build'),
  `build must run \`tsc --noEmit\` before \`vite build\` so a type error fails the deploy, got ${JSON.stringify(buildScript)}`);
for (const dep of ['eslint', 'typescript-eslint', 'eslint-plugin-react-hooks']) {
  check(`${dep} is a declared devDependency`, typeof dev[dep] === 'string', 'the real ESLint stack must remain installed so `lint` is not hollow');
}

/* ---- summary ------------------------------------------------------------ */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
