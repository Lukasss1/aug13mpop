#!/usr/bin/env node
/**
 * ============================================================================
 *  RELEASE-PROVENANCE ATTACK SUITE  —  npm run test:provenance
 * ============================================================================
 *
 *  Builds a genuine, self-consistent release set from the current tree, proves
 *  it VERIFIES, then mounts every known tampering attack and asserts each is
 *  REJECTED (writer or verifier exits non-zero).
 *
 *  Round 2 additions, each closing a bypass an external audit executed against
 *  round 1: a changed dist with a REGENERATED manifest (round 1's "rebuild"
 *  attack kept the old manifest, so it never exercised the real bypass);
 *  source hidden under a nested excluded directory; omission of a stage that
 *  was outside the old 13-stage "required core"; a receipt whose command was
 *  rewritten; and two receipts attesting the same stage. Archive-structure
 *  attacks now cover duplicate and symlink entries, not just traversal.
 *
 *  HERMETIC: the suite generates its manifest and build fixture entirely in a
 *  temporary directory. It never rewrites the repository release manifest or
 *  dist tree, so a timeout or forced termination cannot pollute a later source
 *  package with the attack-suite identity or fixture build.
 * ============================================================================
 */

import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync,
  cpSync, readdirSync, statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashSourceTree, hashBuildDir } from './lib/release-hash.mjs';
import { BUILD_BOUND_STAGES, STAGE_CONTRACT, stagesForProfile } from './lib/release-contract.mjs';
import { EDGE_FUNCTIONS } from './lib/edge-function-inventory.mjs';

/* The baseline is a DEVELOPMENT release, so it attests exactly the stages a
   development build owes — production-only evidence must be absent. */
const PROFILE = 'development';
const SUITE_STAGES = stagesForProfile(PROFILE);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const VERIFIER = path.join(ROOT, 'scripts', 'verify-archive-manifest.mjs');
const WRITER = path.join(ROOT, 'scripts', 'write-archive-manifest.mjs');
let pass = 0; let fail = 0;
const results = [];
/* `positive: true` marks a case where the CORRECT outcome is acceptance (the
   gate must be satisfiable, not merely strict). Labelling those "REJECTED
   (correct)" misdescribed what the test proved. */
const judge = (name, ok, note, opts = {}) => {
  const good = opts.positive ? 'ACCEPTED (correct)' : 'REJECTED (correct)';
  const bad = opts.positive ? '✖ REJECTED (WRONG)' : '✖ ACCEPTED (WRONG)';
  if (ok) { pass += 1; results.push(`  ${good}  ${name}${note ? ` — ${note}` : ''}`); }
  else { fail += 1; results.push(`  ${bad}  ${name}${note ? ` — ${note}` : ''}`); }
};
/* A rejection must be a CLEAN verification failure, not a crash. Counting any
   non-zero exit as success hid a real ReferenceError in the hostile-archive
   path: it failed closed, but never ran the code that was supposed to reject. */
const rejects = (args) => {
  try {
    execFileSync('node', args, { cwd: tmpdir(), stdio: 'pipe' });
    return false;                       // accepted — the attack succeeded
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    if (/ReferenceError|TypeError|SyntaxError|Cannot access|is not a function/.test(out)) {
      console.error(`  !! CRASH (not a clean rejection): ${out.split('\n').find((l) => /Error/.test(l))}`);
      return false;                     // a crash does NOT count as a rejection
    }
    return e.status === 1 || e.status === 2; // 1 = verification failed, 2 = refused (bad policy/schema)
  }
};
// content attacks are judged with --self-consistency so a rejection reflects
// the injected CONTENT fault, not merely the STUB-by-default gate.
const setRejects = (p) => rejects([VERIFIER, '--set', p, '--allow-development', '--self-consistency']);
const singleRejects = (a, m) => rejects([VERIFIER, a, m]);
const writerRejects = (a) => {
  try { execFileSync('node', [WRITER, a], { cwd: ROOT, stdio: 'pipe' }); return false; } catch { return true; }
};

/* ---- hermetic fixtures: NEVER mutate the repository manifest or dist/ ---
 * A hard timeout cannot execute a finally block. Earlier versions temporarily
 * overwrote both files in ROOT and could therefore leak the attack identity or
 * its tiny build fixture into the next source package when the process was
 * killed. All generated state now lives outside the repository. */
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'mp-provenance-fixture-'));
const fixtureDist = path.join(fixtureRoot, 'dist');
const fixtureManifest = path.join(fixtureRoot, 'release-manifest.json');
const repositoryDist = path.join(ROOT, 'dist');
if (existsSync(repositoryDist)) {
  cpSync(repositoryDist, fixtureDist, { recursive: true });
} else {
  mkdirSync(path.join(fixtureDist, 'assets'), { recursive: true });
  writeFileSync(path.join(fixtureDist, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/audit.js"></script></body></html>\n');
  writeFileSync(path.join(fixtureDist, 'assets', 'audit.js'), 'document.getElementById("root").textContent="release provenance fixture";\n');
}
const RUN_ID = 'attack-suite-run';
const IDENT = 'r4.10-provenance-attacks';
const base = mkdtempSync(path.join(tmpdir(), 'mp-attacks-'));

try {
  /* ---- build a genuine baseline release set ----------------------------- */
  execFileSync('node', [path.join(ROOT, 'scripts', 'generate-release-manifest.mjs')], {
    cwd: ROOT,
    stdio: 'pipe',
    env: {
      ...process.env,
      MP_RELEASE_IDENTITY: IDENT,
      MP_RUN_ID: RUN_ID,
      MP_BUILD_PROFILE: 'development',
      MP_RELEASE_MANIFEST_OUTPUT: fixtureManifest,
      MP_RELEASE_BUILD_DIR: fixtureDist,
    },
  });
  const inner = JSON.parse(readFileSync(fixtureManifest, 'utf8'));
  const srcSha = hashSourceTree(ROOT);
  const buildSha = hashBuildDir(fixtureDist);

  const PKG = path.join(base, 'pkg.zip');
  const EVID = path.join(base, 'evidence.zip');
  const LOGS = path.join(base, 'logs.zip');
  execFileSync('zip', ['-qr', PKG, '.', '-x', 'node_modules/*', '-x', '*.log', '-x', '*.zip',
    '-x', '*.manifest.json', '-x', 'release-manifest.json', '-x', 'dist/*',
    '-x', 'artifacts/*', '-x', 'out/*', '-x', '.git/*'], { cwd: ROOT, stdio: 'pipe' });
  execFileSync('zip', ['-qj', PKG, fixtureManifest], { stdio: 'pipe' });
  execFileSync('zip', ['-qr', PKG, 'dist'], { cwd: fixtureRoot, stdio: 'pipe' });
  writeFileSync(path.join(base, 'ev.md'), 'evidence\n');
  execFileSync('zip', ['-qj', EVID, path.join(base, 'ev.md')], { stdio: 'pipe' });

  /* receipts for EVERY contract stage, with the contract's own commands */
  const logDir = path.join(base, 'logbundle');
  mkdirSync(path.join(logDir, 'receipts'), { recursive: true });
  const makeReceipts = (dir, mutate) => {
    for (const stage of SUITE_STAGES) {
      const logName = `${stage}.log`;
      const logPath = path.join(dir, logName);
      writeFileSync(logPath, `${stage}: passed\n`);
      const r = {
        kind: 'release-stage-receipt',
        run_id: RUN_ID,
        stage,
        source_tree_sha256: srcSha,
        build_output_sha256: BUILD_BOUND_STAGES.includes(stage) ? buildSha : null,
        command: STAGE_CONTRACT[stage].command,
        exit_code: 0,
        log: logName,
        log_sha256: sha(logPath),
        started_at: '2026-01-01T00:00:00Z',
        completed_at: '2026-01-01T00:01:00Z',
      };
      writeFileSync(path.join(dir, 'receipts', `${stage}.receipt.json`), JSON.stringify(r, null, 2));
    }
    if (mutate) mutate(dir);
  };
  makeReceipts(logDir);
  execFileSync('zip', ['-qr', LOGS, '.'], { cwd: logDir, stdio: 'pipe' });
  execFileSync('node', [WRITER, PKG, EVID], { cwd: ROOT, stdio: 'pipe' });

  const buildSet = (dir, over = {}) => {
    const pkgP = path.join(dir, 'pkg.zip');
    const evP = path.join(dir, 'evidence.zip');
    const lgP = path.join(dir, 'logs.zip');
    const set = {
      kind: 'milkpop-release-set',
      schema: 2,
      release_identity: IDENT,
      release_version: inner.release_version,
      run_id: RUN_ID,
      build_profile: 'development',
      source_tree_sha256: srcSha,
      build_output_sha256: buildSha,
      migration_count: inner.migration_count,
      migration_fingerprint_sha256: inner.migration_fingerprint_sha256,
      edge_function_count: EDGE_FUNCTIONS.length,
      edge_function_inventory: EDGE_FUNCTIONS,
      edge_function_trees: inner.edge_function_trees,
      edge_shared_tree_sha256: inner.edge_shared_tree_sha256,
      public_function_set_sha256: inner.public_function_set_sha256,
      contract_stages: SUITE_STAGES,
      archives: {
        package: { name: 'pkg.zip', sha256: sha(pkgP), bytes: statSync(pkgP).size },
        evidence: { name: 'evidence.zip', sha256: sha(evP), bytes: statSync(evP).size },
        logs: { name: 'logs.zip', sha256: sha(lgP), bytes: statSync(lgP).size },
      },
      signature: { scheme: 'STUB', run_id: RUN_ID, note: 'stub' },
      ...over,
    };
    const p = path.join(dir, 'release-set.json');
    writeFileSync(p, JSON.stringify(set, null, 2));
    return p;
  };
  const baseSet = buildSet(base);

  if (rejects([VERIFIER, '--set', baseSet, '--allow-development', '--self-consistency'])) {
    console.error('BASELINE DID NOT VERIFY — the suite would be meaningless');
    try { execFileSync('node', [VERIFIER, '--set', baseSet, '--allow-development', '--self-consistency'], { cwd: tmpdir(), stdio: 'inherit' }); } catch { /* shown */ }
    process.exit(1);
  }
  console.log(`baseline verifies (${SUITE_STAGES.length} contract stages attested) — mounting attacks\n`);

  const clone = () => { const d = mkdtempSync(path.join(tmpdir(), 'mp-atk-')); cpSync(base, d, { recursive: true }); return d; };
  const setIn = (d) => path.join(d, 'release-set.json');
  const unpack = (d, name) => { const w = path.join(d, name); mkdirSync(w); execFileSync('unzip', ['-qo', path.join(d, 'pkg.zip'), '-d', w], { stdio: 'pipe' }); return w; };
  const repack = (d, w) => {
    const p = path.join(d, 'pkg.zip'); rmSync(p, { force: true });
    execFileSync('zip', ['-qr', p, '.'], { cwd: w, stdio: 'pipe' });
    const s = JSON.parse(readFileSync(setIn(d), 'utf8'));
    s.archives.package.sha256 = sha(p); s.archives.package.bytes = statSync(p).size;
    writeFileSync(setIn(d), JSON.stringify(s, null, 2));
    return s;
  };
  const rezipLogs = (d, w) => {
    const p = path.join(d, 'logs.zip'); rmSync(p, { force: true });
    execFileSync('zip', ['-qr', p, '.'], { cwd: w, stdio: 'pipe' });
    const s = JSON.parse(readFileSync(setIn(d), 'utf8'));
    s.archives.logs.sha256 = sha(p); s.archives.logs.bytes = statSync(p).size;
    writeFileSync(setIn(d), JSON.stringify(s, null, 2));
  };
  const unpackLogs = (d) => { const w = path.join(d, 'lb'); mkdirSync(w); execFileSync('unzip', ['-qo', path.join(d, 'logs.zip'), '-d', w], { stdio: 'pipe' }); return w; };

  /* 1 */ {
    const d = clone();
    const junk = path.join(d, 'junk.zip');
    writeFileSync(path.join(d, 'x.txt'), 'not the project\n');
    execFileSync('zip', ['-qj', junk, path.join(d, 'x.txt')], { stdio: 'pipe' });
    const m = JSON.parse(readFileSync(path.join(d, 'pkg.zip.manifest.json'), 'utf8'));
    m.archive_name = 'junk.zip'; m.archive_sha256 = sha(junk); m.archive_bytes = statSync(junk).size;
    writeFileSync(path.join(d, 'junk.zip.manifest.json'), JSON.stringify(m, null, 2));
    judge('1. unrelated ZIP paired with real source claims', singleRejects(junk, path.join(d, 'junk.zip.manifest.json')));
    rmSync(d, { recursive: true, force: true });
  }
  /* 2 */ {
    const d = clone(); const w = unpack(d, 'x2');
    writeFileSync(path.join(w, 'src', '_tamper.ts'), 'injected\n');
    repack(d, w);
    judge('2. source modified after testing', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 3 */ {
    const d = clone(); const w = unpackLogs(d);
    const rf = path.join(w, 'receipts', 'build.receipt.json');
    const r = JSON.parse(readFileSync(rf, 'utf8')); r.run_id = 'some-other-run';
    writeFileSync(rf, JSON.stringify(r, null, 2));
    rezipLogs(d, w);
    judge('3. copied logs from another run (receipt run_id mismatch)', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 4 */ {
    const d = clone(); const w = unpackLogs(d);
    rmSync(path.join(w, 'receipts', 'db-baseline.receipt.json'), { force: true });
    rezipLogs(d, w);
    judge('4. a marker without its receipt (core stage missing)', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 5 */ {
    const d = clone(); const w = unpackLogs(d);
    writeFileSync(path.join(w, 'build.log'), 'tampered\n');
    rezipLogs(d, w);
    judge('5. modified log (log_sha256 mismatch)', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 6 */ {
    const d = clone(); const w = unpack(d, 'x6');
    const idx = path.join(w, 'dist', 'index.html');
    if (existsSync(idx)) writeFileSync(idx, `${readFileSync(idx, 'utf8')}<!-- tampered -->`);
    else writeFileSync(path.join(w, 'dist', 'sneak.js'), 'x');
    repack(d, w);
    judge('6. altered final dist/ (manifest untouched)', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 7 */ {
    const d = clone(); const w = unpack(d, 'x7');
    const assets = path.join(w, 'dist', 'assets');
    writeFileSync(path.join(existsSync(assets) ? assets : path.join(w, 'dist'), 'index-REBUILT9f2c.js'), 'console.log(1)\n');
    repack(d, w);
    judge('7. manual rebuild after verification (manifest untouched)', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 8 */ {
    const d = clone();
    writeFileSync(path.join(d, 'evidence.zip'), 'swapped\n');
    judge('8. swapped evidence archive', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 9 */ {
    const d = clone();
    const m = JSON.parse(readFileSync(path.join(d, 'pkg.zip.manifest.json'), 'utf8'));
    m.release_identity = 'r9.9-not-the-inner-identity';
    writeFileSync(path.join(d, 'pkg.zip.manifest.json'), JSON.stringify(m, null, 2));
    judge('9. detached manifest disagrees with the inner manifest',
      singleRejects(path.join(d, 'pkg.zip'), path.join(d, 'pkg.zip.manifest.json')));
    rmSync(d, { recursive: true, force: true });
  }
  /* 10 */ {
    const d = clone(); const w = unpack(d, 'x10');
    writeFileSync(path.join(w, 'supabase', 'migration_9999_injected.sql'), 'DROP TABLE users;\n');
    repack(d, w);
    judge('10. unlisted migration injected', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 11 */ {
    const d = clone(); const w = unpack(d, 'x11');
    const shared = path.join(w, 'supabase', 'functions', '_shared');
    const f = existsSync(shared) ? readdirSync(shared).find((x) => x.endsWith('.ts')) : null;
    if (f) {
      const t = path.join(shared, f);
      writeFileSync(t, `${readFileSync(t, 'utf8')}\n// tampered\n`);
      repack(d, w);
      judge('11. imported _shared Edge module changed', setRejects(setIn(d)));
    } else judge('11. imported _shared Edge module changed', true, 'no _shared modules present');
    rmSync(d, { recursive: true, force: true });
  }
  /* 12 — traversal, duplicate AND symlink entries */ {
    const d = clone();
    const mk = (name, py) => {
      const z = path.join(d, name);
      execFileSync('python3', ['-c', py, z], { stdio: 'pipe' });
      const m = JSON.parse(readFileSync(path.join(d, 'pkg.zip.manifest.json'), 'utf8'));
      m.archive_name = name; m.archive_sha256 = sha(z); m.archive_bytes = statSync(z).size;
      const mp = path.join(d, `${name}.manifest.json`);
      writeFileSync(mp, JSON.stringify(m, null, 2));
      return [z, mp];
    };
    const [tz, tm] = mk('trav.zip', 'import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],"w")\nz.writestr("../escape.txt","x")\nz.writestr("release-manifest.json","{}")\nz.close()');
    const [dz, dm] = mk('dupe.zip', 'import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],"w")\nz.writestr("release-manifest.json","{}")\nz.writestr("src/a.ts","one")\nz.writestr("src/a.ts","two")\nz.close()');
    const [sz, sm] = mk('link.zip', 'import zipfile,sys,stat\nz=zipfile.ZipFile(sys.argv[1],"w")\nz.writestr("release-manifest.json","{}")\ni=zipfile.ZipInfo("src/evil")\ni.external_attr=(stat.S_IFLNK|0o777)<<16\nz.writestr(i,"/etc/passwd")\nz.close()');
    const all = singleRejects(tz, tm) && writerRejects(tz)
      && singleRejects(dz, dm) && writerRejects(dz)
      && singleRejects(sz, sm) && writerRejects(sz);
    judge('12. hostile archive entries — traversal, duplicate AND symlink (writer + verifier)', all);
    rmSync(d, { recursive: true, force: true });
  }
  /* 13 */ {
    const a = clone(); const s1 = JSON.parse(readFileSync(setIn(a), 'utf8')); delete s1.signature;
    writeFileSync(setIn(a), JSON.stringify(s1, null, 2));
    const missing = setRejects(setIn(a)); rmSync(a, { recursive: true, force: true });
    const b = clone(); const s2 = JSON.parse(readFileSync(setIn(b), 'utf8'));
    s2.signature = { scheme: 'cosign', run_id: RUN_ID, sig: 'AAAA' };
    writeFileSync(setIn(b), JSON.stringify(s2, null, 2));
    const fake = setRejects(setIn(b)); rmSync(b, { recursive: true, force: true });
    judge('13. missing signature AND claimed-but-unverifiable signature', missing && fake);
  }
  /* 14 — THE round-1 bypass: changed dist WITH a regenerated manifest */ {
    const d = clone(); const w = unpack(d, 'x14');
    const idx = path.join(w, 'dist', 'index.html');
    if (existsSync(idx)) writeFileSync(idx, `${readFileSync(idx, 'utf8')}<!-- swapped build -->`);
    else writeFileSync(path.join(w, 'dist', 'swapped.js'), 'x');
    // regenerate the inner manifest so it HONESTLY describes the new dist
    execFileSync('node', [path.join(ROOT, 'scripts', 'generate-release-manifest.mjs')], {
      cwd: w,
      stdio: 'pipe',
      env: {
        ...process.env, MP_RELEASE_IDENTITY: IDENT, MP_RUN_ID: RUN_ID, MP_BUILD_PROFILE: 'development',
      },
    });
    const newInner = JSON.parse(readFileSync(path.join(w, 'release-manifest.json'), 'utf8'));
    const s = repack(d, w);
    // and update the set to agree with the regenerated manifest
    s.build_output_sha256 = newInner.build_output_sha256;
    s.source_tree_sha256 = newInner.source_tree_sha256;
    writeFileSync(setIn(d), JSON.stringify(s, null, 2));
    judge('14. changed dist + REGENERATED manifest + updated set (round-1 bypass)', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 15 — source hidden under a nested excluded directory name */ {
    const d = clone(); const w = unpack(d, 'x15');
    mkdirSync(path.join(w, 'src', 'artifacts'), { recursive: true });
    writeFileSync(path.join(w, 'src', 'artifacts', 'injected.ts'), 'export const backdoor = 1;\n');
    repack(d, w);
    judge('15. source injected under src/artifacts/ (nested excluded name)', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 16 — omission of a stage outside the old 13-stage core */ {
    const d = clone(); const w = unpackLogs(d);
    rmSync(path.join(w, 'receipts', 'db-r410-authz.receipt.json'), { force: true });
    rezipLogs(d, w);
    judge('16. non-core stage omitted (db-r410-authz)', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 17 — receipt command rewritten */ {
    const d = clone(); const w = unpackLogs(d);
    const rf = path.join(w, 'receipts', 'db-baseline.receipt.json');
    const r = JSON.parse(readFileSync(rf, 'utf8')); r.command = 'true';
    writeFileSync(rf, JSON.stringify(r, null, 2));
    rezipLogs(d, w);
    judge('17. receipt command rewritten to "true"', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 18 — two receipts attesting the same stage */ {
    const d = clone(); const w = unpackLogs(d);
    const r = JSON.parse(readFileSync(path.join(w, 'receipts', 'db-baseline.receipt.json'), 'utf8'));
    writeFileSync(path.join(w, 'receipts', 'db-baseline-copy.receipt.json'), JSON.stringify(r, null, 2));
    rezipLogs(d, w);
    judge('18. duplicate semantic stage receipt', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }

  /* 19 — a file shipped under a root generated directory, bound by nothing */ {
    const d = clone(); const w = unpack(d, 'x19');
    mkdirSync(path.join(w, 'backups'), { recursive: true });
    writeFileSync(path.join(w, 'backups', 'unbound-secret.txt'), 'db dump / secrets\n');
    repack(d, w);
    judge('19. unbound file shipped under backups/ (covered by no digest)', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 20 — a false migration count in BOTH manifests */ {
    const d = clone(); const w = unpack(d, 'x20');
    const im = JSON.parse(readFileSync(path.join(w, 'release-manifest.json'), 'utf8'));
    im.migration_count = 0;
    writeFileSync(path.join(w, 'release-manifest.json'), JSON.stringify(im, null, 2));
    const st = repack(d, w);
    st.migration_count = 0;
    writeFileSync(setIn(d), JSON.stringify(st, null, 2));
    judge('20. migration_count: 0 while the whole chain ships', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 21 — an empty declared order whose fingerprint is sha256("") */ {
    const d = clone(); const w = unpack(d, 'x21');
    const im = JSON.parse(readFileSync(path.join(w, 'release-manifest.json'), 'utf8'));
    im._migration_order = [];
    im.migration_fingerprint_sha256 = createHash('sha256').update('').digest('hex');
    writeFileSync(path.join(w, 'release-manifest.json'), JSON.stringify(im, null, 2));
    const st = repack(d, w);
    st.migration_fingerprint_sha256 = im.migration_fingerprint_sha256;
    writeFileSync(setIn(d), JSON.stringify(st, null, 2));
    judge('21. empty _migration_order + empty-string fingerprint', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 22 — a receipt naming a log OUTSIDE the logs archive */ {
    const d = clone(); const w = unpackLogs(d);
    const rf = path.join(w, 'receipts', 'db-baseline.receipt.json');
    const r = JSON.parse(readFileSync(rf, 'utf8'));
    rmSync(path.join(w, 'db-baseline.log'), { force: true });
    r.log = '../../etc/hosts';
    r.log_sha256 = existsSync('/etc/hosts') ? sha('/etc/hosts') : 'x';
    writeFileSync(rf, JSON.stringify(r, null, 2));
    rezipLogs(d, w);
    judge('22. receipt log path escapes the archive (../../etc/hosts)', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 23 — real signature verification actually works, and fails when it should */ {
    const { generateKeyPairSync, sign: edSign } = await import('node:crypto');
    const { canonicalPayload, verifyEd25519 } = await import('./lib/release-signature.mjs');
    const a = generateKeyPairSync('ed25519');
    const b = generateKeyPairSync('ed25519');
    const pubA = a.publicKey.export({ type: 'spki', format: 'pem' });
    const pubB = b.publicKey.export({ type: 'spki', format: 'pem' });
    const testSet = JSON.parse(readFileSync(baseSet, 'utf8'));
    testSet.signature = { scheme: 'ed25519-pinned', run_id: RUN_ID };
    testSet.signature.value = edSign(null, canonicalPayload(testSet), a.privateKey).toString('base64');
    const good = verifyEd25519(testSet, pubA).ok;
    const wrongKey = verifyEd25519(testSet, pubB).ok;
    const tampered = JSON.parse(JSON.stringify(testSet));
    tampered.source_tree_sha256 = 'tampered';
    const tamperedOk = verifyEd25519(tampered, pubA).ok;
    judge('23. ed25519 signature: valid ACCEPTED, wrong key REJECTED, tampered payload REJECTED',
      good && !wrongKey && !tamperedOk,
      `valid=${good} wrongKey=${wrongKey} tampered=${tamperedOk}`);
  }

  /* 24 — FORGED SIGNER: the attacker supplies their own key inside the package,
     regenerates every manifest and receipt, and signs the whole release. The
     verifier is given the LEGITIMATE key externally and must reject. */ {
    const { generateKeyPairSync, sign: edSign } = await import('node:crypto');
    const { canonicalPayload } = await import('./lib/release-signature.mjs');
    const legit = generateKeyPairSync('ed25519');
    const attacker = generateKeyPairSync('ed25519');
    const legitPub = path.join(base, 'legit.pub');
    writeFileSync(legitPub, legit.publicKey.export({ type: 'spki', format: 'pem' }));

    const d = clone();
    const w = unpack(d, 'x24');
    // 1. the attacker's public key goes into the package
    writeFileSync(path.join(w, 'release-signing.pub'),
      attacker.publicKey.export({ type: 'spki', format: 'pem' }));
    // 2. regenerate the inner manifest so it describes the modified tree
    execFileSync('node', [path.join(ROOT, 'scripts', 'generate-release-manifest.mjs')], {
      cwd: w,
      stdio: 'pipe',
      env: {
        ...process.env, MP_RELEASE_IDENTITY: IDENT, MP_RUN_ID: RUN_ID, MP_BUILD_PROFILE: PROFILE,
      },
    });
    const forgedInner = JSON.parse(readFileSync(path.join(w, 'release-manifest.json'), 'utf8'));
    repack(d, w);
    // 3. regenerate every receipt for the attacker's source digest
    const lw = path.join(d, 'lb24');
    mkdirSync(path.join(lw, 'receipts'), { recursive: true });
    for (const stage of SUITE_STAGES) {
      const logName = `${stage}.log`;
      writeFileSync(path.join(lw, logName), `${stage}: passed\n`);
      writeFileSync(path.join(lw, 'receipts', `${stage}.receipt.json`), JSON.stringify({
        kind: 'release-stage-receipt',
        run_id: RUN_ID,
        stage,
        source_tree_sha256: forgedInner.source_tree_sha256,
        build_output_sha256: BUILD_BOUND_STAGES.includes(stage) ? forgedInner.build_output_sha256 : null,
        command: STAGE_CONTRACT[stage].command,
        exit_code: 0,
        log: logName,
        log_sha256: sha(path.join(lw, logName)),
        started_at: '2026-01-01T00:00:00Z',
        completed_at: '2026-01-01T00:01:00Z',
      }, null, 2));
    }
    rezipLogs(d, lw);
    // 4. sign the complete set with the attacker's private key
    const forged = JSON.parse(readFileSync(setIn(d), 'utf8'));
    forged.source_tree_sha256 = forgedInner.source_tree_sha256;
    forged.build_output_sha256 = forgedInner.build_output_sha256;
    forged.signature = { scheme: 'ed25519-pinned', run_id: RUN_ID };
    forged.signature.value = edSign(null, canonicalPayload(forged), attacker.privateKey).toString('base64');
    writeFileSync(setIn(d), JSON.stringify(forged, null, 2));

    const rejected = rejects([VERIFIER, '--set', setIn(d), '--allow-development', '--trusted-key', legitPub]);
    judge('24. FORGED SIGNER — attacker key in package, everything regenerated and re-signed', rejected);
    rmSync(d, { recursive: true, force: true });
  }
  /* 25 — the trust anchor must be external, and must actually work */ {
    const { generateKeyPairSync, sign: edSign } = await import('node:crypto');
    const { canonicalPayload } = await import('./lib/release-signature.mjs');
    const legit = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    const legitPub = path.join(base, 'legit25.pub');
    const otherPub = path.join(base, 'other25.pub');
    writeFileSync(legitPub, legit.publicKey.export({ type: 'spki', format: 'pem' }));
    writeFileSync(otherPub, other.publicKey.export({ type: 'spki', format: 'pem' }));

    const d = clone();
    const signed = JSON.parse(readFileSync(setIn(d), 'utf8'));
    signed.signature = { scheme: 'ed25519-pinned', run_id: RUN_ID };
    signed.signature.value = edSign(null, canonicalPayload(signed), legit.privateKey).toString('base64');
    writeFileSync(setIn(d), JSON.stringify(signed, null, 2));

    const acceptedWithTrusted = !rejects([VERIFIER, '--set', setIn(d), '--allow-development', '--trusted-key', legitPub]);
    const rejectedWithWrongKey = rejects([VERIFIER, '--set', setIn(d), '--allow-development', '--trusted-key', otherPub]);
    const rejectedWithNoAnchor = rejects([VERIFIER, '--set', setIn(d), '--allow-development']);
    judge('25. external trust anchor: correct key ACCEPTED, wrong key REJECTED, no anchor REJECTED',
      acceptedWithTrusted && rejectedWithWrongKey && rejectedWithNoAnchor,
      `trusted=${acceptedWithTrusted} wrongKey=${rejectedWithWrongKey} noAnchor=${rejectedWithNoAnchor}`);
    rmSync(d, { recursive: true, force: true });
  }

  /* 26 — production build + STUB accepted by the DEFAULT set verifier */ {
    const d = clone();
    const st = JSON.parse(readFileSync(setIn(d), 'utf8'));
    st.build_profile = 'production';                 // claim production
    st.signature = { scheme: 'STUB', run_id: RUN_ID }; // but stay unsigned
    writeFileSync(setIn(d), JSON.stringify(st, null, 2));
    // no flags at all — the ordinary path must NOT pass this
    judge('26. production profile + STUB via the default verifier', rejects([VERIFIER, '--set', setIn(d)]));
    rmSync(d, { recursive: true, force: true });
  }
  /* 27 — a plain STUB set must not read as PROVENANCE VERIFIED by default */ {
    const d = clone();
    // baseline is STUB + development; without --self-consistency it must fail
    const rejectedByDefault = rejects([VERIFIER, '--set', setIn(d), '--allow-development']);
    // with --self-consistency it PASSES but must NOT print PROVENANCE VERIFIED
    let text = '';
    try { text = execFileSync('node', [VERIFIER, '--set', setIn(d), '--allow-development', '--self-consistency'], { cwd: tmpdir(), encoding: 'utf8' }); } catch (e) { text = String(e.stdout || ''); }
    const wordingOk = !text.includes('PROVENANCE VERIFIED')
      && (text.includes('SELF-CONSISTENCY VERIFIED — NOT AUTHENTICATED')
        || text.includes('DEVELOPMENT BUILD CHECKED'));
    judge('27. STUB: rejected by default, and self-consistency never says PROVENANCE VERIFIED',
      rejectedByDefault && wordingOk, `default-rejected=${rejectedByDefault} wording=${wordingOk}`);
    rmSync(d, { recursive: true, force: true });
  }
  /* 28 — real-signature DOWNGRADE to STUB (scheme not covered by the payload) */ {
    const { generateKeyPairSync, sign: edSign } = await import('node:crypto');
    const { canonicalPayload } = await import('./lib/release-signature.mjs');
    const kp = generateKeyPairSync('ed25519');
    const pub = path.join(base, 'k28.pub');
    writeFileSync(pub, kp.publicKey.export({ type: 'spki', format: 'pem' }));
    const d = clone();
    const signed = JSON.parse(readFileSync(setIn(d), 'utf8'));
    signed.signature = { scheme: 'ed25519-pinned', run_id: RUN_ID };
    signed.signature.value = edSign(null, canonicalPayload(signed), kp.privateKey).toString('base64');
    // attacker downgrades scheme to STUB, keeping other fields
    signed.signature = { scheme: 'STUB', run_id: RUN_ID };
    writeFileSync(setIn(d), JSON.stringify(signed, null, 2));
    // with the real key trusted, a downgraded STUB must fail (default too)
    judge('28. real signature downgraded to STUB', rejects([VERIFIER, '--set', setIn(d), '--allow-development', '--trusted-key', pub]));
    rmSync(d, { recursive: true, force: true });
  }
  /* 29 — trust policy with a RELATIVE key path must resolve from the policy dir */ {
    const { generateKeyPairSync, sign: edSign } = await import('node:crypto');
    const { canonicalPayload } = await import('./lib/release-signature.mjs');
    const legit = generateKeyPairSync('ed25519');
    const attacker = generateKeyPairSync('ed25519');
    const d = clone();
    // legit policy stored OUTSIDE the release, naming the key by relative path
    const polDir = mkdtempSync(path.join(tmpdir(), 'mp-pol-'));
    writeFileSync(path.join(polDir, 'release-signing.pub'), legit.publicKey.export({ type: 'spki', format: 'pem' }));
    writeFileSync(path.join(polDir, 'policy.json'), JSON.stringify({ ed25519_public_key_file: 'release-signing.pub' }));
    // attacker drops THEIR key with the same name into the release dir, signs with their key
    writeFileSync(path.join(d, 'release-signing.pub'), attacker.publicKey.export({ type: 'spki', format: 'pem' }));
    const forged = JSON.parse(readFileSync(setIn(d), 'utf8'));
    forged.signature = { scheme: 'ed25519-pinned', run_id: RUN_ID };
    forged.signature.value = edSign(null, canonicalPayload(forged), attacker.privateKey).toString('base64');
    writeFileSync(setIn(d), JSON.stringify(forged, null, 2));
    // run FROM the release dir; policy path is relative-resolved to polDir, not cwd
    const rejected = (() => { try { execFileSync('node', [VERIFIER, '--set', setIn(d), '--allow-development', '--trust', path.join(polDir, 'policy.json')], { cwd: d, stdio: 'pipe' }); return false; } catch { return true; } })();
    judge('29. trust-policy relative key path resolves from the policy dir, not CWD', rejected);
    rmSync(d, { recursive: true, force: true }); rmSync(polDir, { recursive: true, force: true });
  }
  /* 30 — trust policy where declared fingerprint and PEM disagree */ {
    const { generateKeyPairSync, sign: edSign } = await import('node:crypto');
    const { canonicalPayload, keyFingerprint } = await import('./lib/release-signature.mjs');
    const legit = generateKeyPairSync('ed25519');
    const attacker = generateKeyPairSync('ed25519');
    const legitFp = keyFingerprint(legit.publicKey.export({ type: 'spki', format: 'pem' }));
    const d = clone();
    const polDir = mkdtempSync(path.join(tmpdir(), 'mp-pol2-'));
    // policy: legit fingerprint BUT attacker PEM
    writeFileSync(path.join(polDir, 'policy.json'), JSON.stringify({
      ed25519_public_key_sha256: legitFp,
      ed25519_public_key_pem: attacker.publicKey.export({ type: 'spki', format: 'pem' }),
    }));
    const forged = JSON.parse(readFileSync(setIn(d), 'utf8'));
    forged.signature = { scheme: 'ed25519-pinned', run_id: RUN_ID };
    forged.signature.value = edSign(null, canonicalPayload(forged), attacker.privateKey).toString('base64');
    writeFileSync(setIn(d), JSON.stringify(forged, null, 2));
    const rejected = rejects([VERIFIER, '--set', setIn(d), '--allow-development', '--trust', path.join(polDir, 'policy.json')]);
    judge('30. contradictory trust policy (legit fingerprint + attacker PEM)', rejected);
    rmSync(d, { recursive: true, force: true }); rmSync(polDir, { recursive: true, force: true });
  }
  /* 31 — evidence archive with a traversal entry */ {
    const d = clone();
    const evil = path.join(d, 'evidence.zip'); rmSync(evil, { force: true });
    execFileSync('python3', ['-c', 'import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],"w")\nz.writestr("../outside.txt","x")\nz.close()', evil], { stdio: 'pipe' });
    const st = JSON.parse(readFileSync(setIn(d), 'utf8'));
    const b = readFileSync(evil);
    st.archives.evidence.sha256 = createHash('sha256').update(b).digest('hex');
    st.archives.evidence.bytes = b.length;
    writeFileSync(setIn(d), JSON.stringify(st, null, 2));
    judge('31. evidence archive contains a traversal entry (../outside.txt)', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }
  /* 32 — END-TO-END: a properly signed set is AUTHENTICATED and passes */ {
    const { generateKeyPairSync } = await import('node:crypto');
    const legit = generateKeyPairSync('ed25519');
    const keyDir = mkdtempSync(path.join(tmpdir(), 'mp-key-'));
    const privPem = path.join(keyDir, 'priv.pem');
    const pubPem = path.join(keyDir, 'pub.pem');
    writeFileSync(privPem, legit.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(pubPem, legit.publicKey.export({ type: 'spki', format: 'pem' }));
    writeFileSync(path.join(keyDir, 'policy.json'), JSON.stringify({ ed25519_public_key_file: 'pub.pem' }));
    const d = clone();
    // sign the real set with the signer script
    execFileSync('node', [path.join(ROOT, 'scripts', 'sign-release-set.mjs'), setIn(d), privPem], { stdio: 'pipe' });
    const accepted = (() => { try { execFileSync('node', [VERIFIER, '--set', setIn(d), '--allow-development', '--trust', path.join(keyDir, 'policy.json')], { cwd: tmpdir(), stdio: 'pipe' }); return true; } catch { return false; } })();
    judge('32. end-to-end: a correctly signed set is AUTHENTICATED and accepted', accepted, undefined, { positive: true });
    rmSync(d, { recursive: true, force: true }); rmSync(keyDir, { recursive: true, force: true });
  }

  /* 33-37 — the small-business production rules: a signed release must be the
     RIGHT release, for the RIGHT site, against the RIGHT backend, and not older
     than what is already live. */ {
    const { generateKeyPairSync } = await import('node:crypto');
    const kp = generateKeyPairSync('ed25519');
    const keyDir = mkdtempSync(path.join(tmpdir(), 'mp-prod-'));
    writeFileSync(path.join(keyDir, 'priv.pem'), kp.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(path.join(keyDir, 'pub.pem'), kp.publicKey.export({ type: 'spki', format: 'pem' }));
    const policy = (over = {}) => {
      const p = path.join(keyDir, `pol-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(p, JSON.stringify({
        key_purpose: 'production',
        key_id: 'test',
        ed25519_public_key_file: 'pub.pem',
        approved_site_domain: 'milkpop.uk',
        approved_supabase_project_ref: 'prod-ref',
        minimum_release_number: 5,
        ...over,
      }));
      return p;
    };
    // a production-profile set, correctly signed, with correct binding
    const makeProd = (d, over = {}) => {
      const st = JSON.parse(readFileSync(setIn(d), 'utf8'));
      Object.assign(st, {
        build_profile: 'production',
        release_number: 6,
        git_commit: 'a'.repeat(40),
        git_tree_clean: true,
        site_domain: 'milkpop.uk',
        supabase_project_ref: 'prod-ref',
      }, over);
      st.signature = { scheme: 'ed25519-pinned', run_id: RUN_ID };
      // sign AFTER mutating so the signature is genuine for these values
      return st;
    };
    const signInto = async (d, st) => {
      const { canonicalPayload } = await import('./lib/release-signature.mjs');
      const { sign: edSign } = await import('node:crypto');
      st.signature.value = edSign(null, canonicalPayload(st), kp.privateKey).toString('base64');
      writeFileSync(setIn(d), JSON.stringify(st, null, 2));
    };

    // 33 — a DEVELOPMENT build must fail the default (production) verification
    {
      const d = clone();
      judge('33. development build via the DEFAULT verify command (no --allow-development)',
        rejects([VERIFIER, '--set', setIn(d), '--trust', policy()]));
      rmSync(d, { recursive: true, force: true });
    }
    // 34 — wrong Supabase project, correctly signed
    {
      const d = clone();
      await signInto(d, makeProd(d, { supabase_project_ref: 'staging-ref' }));
      judge('34. correctly signed release pointing at the WRONG Supabase project',
        rejects([VERIFIER, '--set', setIn(d), '--trust', policy()]));
      rmSync(d, { recursive: true, force: true });
    }
    // 35 — wrong site domain
    {
      const d = clone();
      await signInto(d, makeProd(d, { site_domain: 'evil.example' }));
      judge('35. correctly signed release pointing at the WRONG domain',
        rejects([VERIFIER, '--set', setIn(d), '--trust', policy()]));
      rmSync(d, { recursive: true, force: true });
    }
    // 36 — ROLLBACK: an older, correctly signed release
    {
      const d = clone();
      await signInto(d, makeProd(d, { release_number: 3 }));
      judge('36. ROLLBACK — correctly signed release older than the last deployed',
        rejects([VERIFIER, '--set', setIn(d), '--trust', policy()]));
      rmSync(d, { recursive: true, force: true });
    }
    // 37 — the demonstration key must not sign a production release
    {
      const d = clone();
      await signInto(d, makeProd(d));
      judge('37. demonstration key (key_purpose != production) signing a production release',
        rejects([VERIFIER, '--set', setIn(d), '--trust', policy({ key_purpose: 'development' })]));
      rmSync(d, { recursive: true, force: true });
    }
    rmSync(keyDir, { recursive: true, force: true });
  }

  /* 38-41 — P0-5 production artefact readiness. The scanner is exercised
     directly: these judge a dist, not a release set. */ {
    const SCAN = path.join(ROOT, 'scripts', 'verify-production-artifact.mjs');
    const REF = 'abcdefghijklmnop';
    const mkDist = (over = {}) => {
      const d = mkdtempSync(path.join(tmpdir(), 'mp-dist-'));
      mkdirSync(path.join(d, 'assets'), { recursive: true });
      writeFileSync(path.join(d, 'index.html'),
        '<!doctype html><html><head><link rel="canonical" href="https://milkpop.uk/">'
        + '<link rel="stylesheet" href="/assets/app-abcdef12.css"></head><body>'
        + '<script type="module" src="/assets/app-abcdef12.js"></script></body></html>');
      writeFileSync(path.join(d, 'assets', 'app-abcdef12.js'),
        `const U="https://${over.ref || REF}.supabase.co";const S="https://milkpop.uk";`
        + 'const hint={placeholder:"sarah@example.com"};const t={"page.searchPlaceholder":"Search"};'
        + (over.extra || ''));
      writeFileSync(path.join(d, 'assets', 'app-abcdef12.css'), '::placeholder{opacity:1}');
      writeFileSync(path.join(d, '_headers'),
        '/*\n  X-Frame-Options: DENY\n\n'
        + '/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n'
        + '/.well-known/milkpop-release.json\n  Cache-Control: no-store, max-age=0\n');
      writeFileSync(path.join(d, '_redirects'), '/* /index.html 200\n');
      writeFileSync(path.join(d, 'seo-manifest.json'), JSON.stringify({
        schemaVersion: 3,
        source: over.seoSource || 'supabase',
        siteUrl: 'https://milkpop.uk',
        commercialOutputSuppressed: over.suppressed === true,
        publishedCounts: over.published === 0 ? {} : { stores: 1, products: 9 },
      }));
      return d;
    };
    const scanRejects = (d) => rejects([SCAN, d, '--site-domain', 'milkpop.uk', '--supabase-ref', REF]);
    const scanAccepts = (d) => {
      try { execFileSync('node', [SCAN, d, '--site-domain', 'milkpop.uk', '--supabase-ref', REF], { cwd: tmpdir(), stdio: 'pipe' }); return true; } catch { return false; }
    };

    // 38 — the gate must be SATISFIABLE, and must not fire on legitimate UI copy
    {
      const d = mkDist();
      judge('38. a correctly configured production artefact is ACCEPTED (and ::placeholder / example.com UI copy does not trip it)',
        scanAccepts(d), undefined, { positive: true });
      rmSync(d, { recursive: true, force: true });
    }
    // 39 — built against the wrong backend
    {
      const d = mkDist({ ref: 'stagingprojectxyz' });
      judge('39. production artefact built against the WRONG Supabase project', scanRejects(d));
      rmSync(d, { recursive: true, force: true });
    }
    // 40 — development snapshot / commercial output suppressed
    {
      const d = mkDist({ seoSource: 'development-defaults', suppressed: true, published: 0 });
      judge('40. artefact with development-defaults content and commercial output suppressed', scanRejects(d));
      rmSync(d, { recursive: true, force: true });
    }
    // 41 — dev remnants and leaked secrets
    {
      const a = mkDist({ extra: 'const api="http://localhost:54321";' });
      const b = mkDist({ extra: 'const k="service_role.eyJhbGciOi";' });
      const c = mkDist({ extra: 'const x="REPLACE-WITH-REAL-VALUE";' });
      judge('41. artefact carrying a localhost URL / service_role key / unfilled placeholder',
        scanRejects(a) && scanRejects(b) && scanRejects(c));
      for (const d of [a, b, c]) rmSync(d, { recursive: true, force: true });
    }
  }

  /* 42 — remove one deferred POS function from both manifests. The source
     archive still carries it, but a signed set may not narrow the code-owned
     repository identity to only the functions currently deployed. */ {
    const d = clone(); const w = unpack(d, 'x42');
    const im = JSON.parse(readFileSync(path.join(w, 'release-manifest.json'), 'utf8'));
    const removed = 'pos-catalog';
    im.edge_function_count = EDGE_FUNCTIONS.length - 1;
    im.edge_function_inventory = im.edge_function_inventory.filter((name) => name !== removed);
    delete im.edge_functions[removed];
    delete im.edge_function_trees[removed];
    writeFileSync(path.join(w, 'release-manifest.json'), JSON.stringify(im, null, 2));
    const st = repack(d, w);
    st.edge_function_count = im.edge_function_count;
    st.edge_function_inventory = im.edge_function_inventory;
    st.edge_function_trees = im.edge_function_trees;
    writeFileSync(setIn(d), JSON.stringify(st, null, 2));
    judge('42. signed identity omits one deferred POS function tree', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }

  /* 43 — preserve the count while replacing a real function with an unknown
     tree. Count-only validation would accept this; the exact name set must not. */ {
    const d = clone(); const w = unpack(d, 'x43');
    const im = JSON.parse(readFileSync(path.join(w, 'release-manifest.json'), 'utf8'));
    const removed = 'pos-catalog';
    const rogue = 'rogue-function';
    mkdirSync(path.join(w, 'supabase', 'functions', rogue), { recursive: true });
    writeFileSync(path.join(w, 'supabase', 'functions', rogue, 'index.ts'), 'Deno.serve(() => new Response("rogue"));\n');
    im.edge_function_inventory = im.edge_function_inventory.map((name) => name === removed ? rogue : name).sort();
    delete im.edge_functions[removed];
    delete im.edge_function_trees[removed];
    im.edge_functions[rogue] = sha(path.join(w, 'supabase', 'functions', rogue, 'index.ts'));
    im.edge_function_trees[rogue] = hashBuildDir(path.join(w, 'supabase', 'functions', rogue));
    writeFileSync(path.join(w, 'release-manifest.json'), JSON.stringify(im, null, 2));
    const st = repack(d, w);
    st.edge_function_inventory = im.edge_function_inventory;
    st.edge_function_trees = im.edge_function_trees;
    writeFileSync(setIn(d), JSON.stringify(st, null, 2));
    judge('43. signed identity swaps a real function for an unknown tree at the same count', setRejects(setIn(d)));
    rmSync(d, { recursive: true, force: true });
  }

  console.log(results.join('\n'));
  console.log('');
  if (fail) {
    console.log(`✖ RELEASE PROVENANCE — ${pass} passed, ${fail} failed  (a bypass was ACCEPTED)`);
    process.exit(1);
  }
  console.log(`✔ RELEASE PROVENANCE — ${pass} passed, 0 failed  (${pass - 2} tampering attacks rejected, 2 positive cases accepted)`);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
}
