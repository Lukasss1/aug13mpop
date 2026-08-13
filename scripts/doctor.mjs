#!/usr/bin/env node
/*
 * Milk Pop — `npm run doctor`
 * ---------------------------------------------------------------------------
 * A friendly, read-only prerequisite check for whoever builds or deploys.
 * Audit #2 (Clean Installation Reproducibility), finding 6.
 *
 * It reports, without changing anything:
 *   • Node and npm versions, checked against package.json "engines"
 *   • the operating environment (and whether release/DB ops are supported here)
 *   • presence of the external tools the full workflow needs
 *     (psql, Supabase CLI, bash, curl, git, sha256)
 *   • whether Playwright's Chromium has been provisioned
 *   • whether the required build-time environment variables are set
 *
 * Nothing here is fatal on its own: app development (dev/build/typecheck/clean)
 * needs only Node + npm; the other tools matter only for database and release
 * operations, which are supported on WSL2 / macOS / Linux. Secrets are never
 * printed — only whether a variable is present.
 *
 * Pure Node built-ins, no dependencies, safe to run before `npm ci`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const TAG = {
  ok: 'OK   ',
  warn: 'WARN ',
  miss: 'MISS ',
  info: 'INFO ',
};

let warnings = 0;

function line(tag, label, detail) {
  if (tag === TAG.warn || tag === TAG.miss) warnings += 1;
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`  [${tag}] ${label}${suffix}`);
}

function heading(text) {
  console.log(`\n${text}`);
}

// Run `<cmd> <flag>` and return the trimmed first output line, or null if the
// command is not on PATH / does not run. Never throws.
function probe(cmd, args) {
  try {
    const r = spawnSync(cmd, args, {
      stdio: 'pipe',
      timeout: 5000,
      encoding: 'utf8',
      shell: false,
    });
    if (r.error || r.status === null) return null; // ENOENT / killed / not found
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    return out.split(/\r?\n/)[0] || '';
  } catch {
    return null;
  }
}

function parseVersion(version) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)/.exec(String(version || '').trim());
  return match ? match.slice(1).map(Number) : null;
}

function compareVersion(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return NaN;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function majorOf(version) {
  return parseVersion(version)?.[0] ?? NaN;
}

// ---------------------------------------------------------------------------
console.log('Milk Pop — environment doctor');
console.log('(read-only; nothing is installed or modified)');

// --- Engines / toolchain ---------------------------------------------------
heading('Toolchain');

let engines = {};
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  engines = pkg.engines || {};
} catch {
  line(TAG.warn, 'package.json', 'could not read "engines" — run this from the project root');
}

const nodeVersion = process.versions.node;
if (compareVersion(nodeVersion, '22.23.2') >= 0 && majorOf(nodeVersion) === 22) {
  line(TAG.ok, `Node v${nodeVersion}`, `satisfies engines.node "${engines.node || '>=22.23.2 <23'}"`);
} else {
  line(TAG.warn, `Node v${nodeVersion}`, `outside supported range "${engines.node || '>=22.23.2 <23'}" (use the exact version in .nvmrc)`);
}

const npmVersion = probe('npm', ['--version']);
if (npmVersion == null) {
  line(TAG.miss, 'npm', 'not found on PATH (ships with Node)');
} else if (compareVersion(npmVersion, '10.9.8') >= 0 && majorOf(npmVersion) === 10) {
  line(TAG.ok, `npm ${npmVersion}`, `satisfies engines.npm "${engines.npm || '>=10.9.8 <11'}"`);
} else {
  line(TAG.warn, `npm ${npmVersion}`, `outside supported range "${engines.npm || '>=10.9.8 <11'}"`);
}

// --- Operating environment -------------------------------------------------
heading('Operating environment');

const plat = platform(); // 'win32' | 'darwin' | 'linux' (WSL reports 'linux')
if (plat === 'win32') {
  line(
    TAG.warn,
    'Native Windows detected',
    'app dev (dev/build/typecheck/clean) works, but release & database ops (launch/launch.sh, psql, the bash test harnesses) require WSL2 / macOS / Linux',
  );
} else if (plat === 'darwin' || plat === 'linux') {
  line(TAG.ok, `${plat === 'darwin' ? 'macOS' : 'Linux/WSL2'} detected`, 'supported for app dev and release/DB operations');
} else {
  line(TAG.info, `Platform "${plat}"`, 'untested; WSL2 / macOS / Linux is the supported standard');
}

// --- External tools --------------------------------------------------------
heading('External tools (needed for database & release operations)');

const tools = [
  { cmd: 'psql', args: ['--version'], why: 'PostgreSQL client — required for every --db-* path in launch.sh' },
  { cmd: 'supabase', args: ['--version'], why: 'Supabase CLI — DB push + Edge Function deploy (optional if you use the dashboard)' },
  { cmd: 'bash', args: ['--version'], why: 'shell for launch.sh and the migration/RLS test harnesses' },
  { cmd: 'curl', args: ['--version'], why: 'used by the deployed-header verification in launch.sh §5' },
  { cmd: 'git', args: ['--version'], why: 'version control' },
];

for (const t of tools) {
  const v = probe(t.cmd, t.args);
  if (v == null) {
    line(TAG.warn, t.cmd, `not found — ${t.why}`);
  } else {
    line(TAG.ok, v);
  }
}

// SHA-256 utility: the migration ledger accepts any one of these.
const sha = ['sha256sum', 'shasum', 'openssl'].find((c) => probe(c, ['--help']) !== null || probe(c, ['version']) !== null || probe(c, ['-v']) !== null);
if (sha) {
  line(TAG.ok, `SHA-256 tool: ${sha}`, 'available for the migration ledger');
} else {
  line(TAG.warn, 'SHA-256 tool', 'none of sha256sum / shasum / openssl found — required by the migration ledger');
}

// --- Playwright browser ----------------------------------------------------
heading('Playwright browser (needed only for npm run test:browser)');

const cacheDir =
  process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0'
    ? process.env.PLAYWRIGHT_BROWSERS_PATH
    : plat === 'win32'
      ? join(homedir(), 'AppData', 'Local', 'ms-playwright')
      : plat === 'darwin'
        ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
        : join(homedir(), '.cache', 'ms-playwright');

let chromiumInstalled = false;
try {
  chromiumInstalled = existsSync(cacheDir) && readdirSync(cacheDir).some((d) => d.startsWith('chromium'));
} catch {
  chromiumInstalled = false;
}

if (chromiumInstalled) {
  line(TAG.ok, 'Chromium', `installed under ${cacheDir}`);
} else {
  line(TAG.info, 'Chromium', 'not provisioned — run `npm run test:browser` (or `npm exec --offline -- playwright install --with-deps chromium`) before browser audits');
}

// --- Required build-time environment variables -----------------------------
heading('Build-time environment variables');

const hasUrl = Boolean(process.env.VITE_SUPABASE_URL);
const hasKey = Boolean(process.env.VITE_SUPABASE_ANON_KEY);
const mode = process.env.VITE_DEPLOYMENT_MODE || '(unset → development default)';

line(hasUrl ? TAG.ok : TAG.info, 'VITE_SUPABASE_URL', hasUrl ? 'set' : 'unset → app runs backend-less (public pages from seeds)');
line(hasKey ? TAG.ok : TAG.info, 'VITE_SUPABASE_ANON_KEY', hasKey ? 'set (value hidden)' : 'unset → app runs backend-less');
line(TAG.info, 'VITE_DEPLOYMENT_MODE', mode);

if ((hasUrl && !hasKey) || (!hasUrl && hasKey)) {
  line(TAG.warn, 'Supabase pair', 'only one of URL/ANON_KEY is set — the production build validator fails closed on a half-configured pair');
}
if (String(process.env.VITE_DEPLOYMENT_MODE).toLowerCase() === 'production' && (!hasUrl || !hasKey)) {
  line(TAG.warn, 'Production mode', 'requires BOTH VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY — the build will fail closed');
}

// --- Summary ---------------------------------------------------------------
heading('Summary');
if (warnings === 0) {
  console.log('  All checks passed. You are ready to build and (on a Unix shell) run the release workflow.\n');
} else {
  console.log(`  ${warnings} item(s) need attention above.`);
  console.log('  Reminder: app development needs only Node + npm; the WARN items matter for database & release operations.\n');
}

// Doctor is advisory: it reports, it does not block. Always exit 0.
process.exit(0);
