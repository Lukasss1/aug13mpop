/**
 * ============================================================================
 *  CANONICAL RELEASE HASHER  (P0-4)  —  the SINGLE source-of-truth digest
 * ============================================================================
 *
 *  Every release script — verify-release.sh, generate-release-manifest,
 *  write-archive-manifest, verify-archive-manifest and release-seal — hashes
 *  "the source tree" and "the build" through THIS module and no other. Before
 *  P0-4 there were three different walkers: the release verifier excluded the
 *  whole `artifacts/` directory, the manifest generator included non-log
 *  artifact files, and both globally ignored every `*.log` and
 *  `*.manifest.json`. Two digests described as "the same identity" were not.
 *  One hasher removes that entire class of bug.
 *
 *  RULES (all deliberate, each closes a specific P0-4 finding):
 *    • Exclude ONLY specifically named generated directories. Never ignore an
 *      extension globally: a stray `evil.log` or `x.manifest.json` in a source
 *      directory MUST change the digest. Generated content lives in named dirs
 *      (dist/, out/, release-out/, artifacts/, node_modules/, .git/, backups/) and those —
 *      and only those — are skipped.
 *    • Reject symlinks. A symlink can point outside the repo or at a file whose
 *      content is not itself hashed; either way the digest would not describe
 *      the real bytes. lstat (never stat) detects them; encountering one is a
 *      hard failure, not a skip.
 *    • Reject any path that escapes the root. We only ever descend into real
 *      directories (symlinks already rejected), so traversal cannot occur — but
 *      the resolved-path guard is asserted anyway, fail-closed.
 *    • Fail rather than return a placeholder. The old resume path fell back to
 *      the literal string "unknown" when hashing failed, so a run could proceed
 *      on a tree it never actually digested. This throws instead.
 *    • Normalize paths to POSIX, relative to the root, so the digest is stable
 *      across machines and extraction locations.
 *
 *  The digest is sha256 over the newline-joined, lexicographically sorted list
 *  of `relative/posix/path:<sha256 of file bytes>` lines.
 *
 *  CLI:
 *    node scripts/lib/release-hash.mjs --source [root]   # source tree digest
 *    node scripts/lib/release-hash.mjs --dir <path>      # any directory (e.g. a build)
 *    node scripts/lib/release-hash.mjs --manifest <path> # the source digest a manifest should carry
 * ============================================================================
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** ROOT-RELATIVE paths of generated directories, never part of a content
 *  digest. These are matched against a directory's path relative to the root —
 *  NOT its base name — so only the real generated directories are skipped and
 *  a nested `src/artifacts/` or `src/dist/` is hashed like any other source. */
export const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'release-out', 'artifacts', 'backups',
]);

/** The one file excluded from the SOURCE digest: it records that digest, so it
 *  cannot be part of it. Nothing else is excluded by name or by extension. */
export const SOURCE_EXCLUDE_EXACT = new Set(['release-manifest.json']);

const shaFile = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * Collect every real file under `root`, rejecting symlinks and escapes.
 * @returns {string[]} absolute paths
 */
function collect(root, { excludeDirs }) {
  const rootReal = realpathSync(root);
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const st = lstatSync(full); // lstat: do NOT follow symlinks
      if (st.isSymbolicLink()) {
        throw new Error(`release-hash: symlink rejected (not hashable): ${path.relative(rootReal, full)}`);
      }
      if (st.isDirectory()) {
        /* ROOT-ANCHORED (P0-4 round 2). This used to test the directory's BASE
           NAME at every depth, so `src/artifacts/`, `scripts/out/` or
           `src/dist/` were silently skipped and any source placed there was
           invisible to the digest — an auditor injected src/artifacts/*.ts,
           repacked, and the release still verified. Generated output lives at
           the repository root; a directory with the same name deeper in the
           tree is ordinary source and MUST be hashed. */
        const relDir = path.relative(rootReal, full).split(path.sep).join('/');
        if (excludeDirs.has(relDir)) continue;
        // A real directory cannot escape root, but assert it anyway.
        const real = realpathSync(full);
        if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
          throw new Error(`release-hash: path escapes root: ${full}`);
        }
        walk(full);
      } else if (st.isFile()) {
        out.push(full);
      } else {
        throw new Error(`release-hash: non-regular file rejected: ${path.relative(rootReal, full)}`);
      }
    }
  };
  walk(rootReal);
  return { rootReal, files: out };
}

/**
 * Deterministic content digest of a directory tree.
 * @param {string} root
 * @param {{excludeDirs?:Set<string>, excludeExact?:Set<string>}} [opts]
 * @returns {string} sha256 hex
 */
export function hashTree(root, opts = {}) {
  const excludeDirs = opts.excludeDirs || EXCLUDE_DIRS;
  const excludeExact = opts.excludeExact || new Set();
  const { rootReal, files } = collect(root, { excludeDirs });
  const lines = files
    .map((f) => [path.relative(rootReal, f).split(path.sep).join('/'), f])
    .filter(([rel]) => !excludeExact.has(rel))
    .map(([rel, f]) => `${rel}:${shaFile(f)}`)
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** The canonical SOURCE-tree digest (excludes the self-referential manifest). */
export function hashSourceTree(root = '.') {
  return hashTree(root, { excludeExact: SOURCE_EXCLUDE_EXACT });
}

/** Number of regular files covered by the canonical SOURCE digest. */
export function countSourceFiles(root = '.') {
  const { rootReal, files } = collect(root, { excludeDirs: EXCLUDE_DIRS });
  return files
    .map((f) => path.relative(rootReal, f).split(path.sep).join('/'))
    .filter((rel) => !SOURCE_EXCLUDE_EXACT.has(rel))
    .length;
}

/** Digest of a build directory (dist). No name exclusions — every byte counts. */
/** The live release marker is written INTO dist after the build hash is
 *  computed, so it must be excluded from that hash or the value would have to
 *  contain itself. Everything else in dist is covered. */
export const BUILD_HASH_EXCLUDE = new Set(['.well-known/milkpop-release.json']);

export function hashBuildDir(dir) {
  return hashTree(dir, {
    excludeDirs: new Set(['node_modules', '.git']),
    excludeExact: BUILD_HASH_EXCLUDE,
  });
}

/* ---- CLI ---------------------------------------------------------------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , mode, arg] = process.argv;
  try {
    if (mode === '--source') {
      process.stdout.write(hashSourceTree(arg || '.') + '\n');
    } else if (mode === '--dir') {
      if (!arg) throw new Error('--dir requires a path');
      process.stdout.write(hashBuildDir(arg) + '\n');
    } else if (mode === '--manifest') {
      if (!arg) throw new Error('--manifest requires a path');
      process.stdout.write(hashSourceTree(path.dirname(arg)) + '\n');
    } else {
      process.stderr.write('usage: release-hash.mjs --source [root] | --dir <path> | --manifest <path>\n');
      process.exit(2);
    }
  } catch (e) {
    // Fail, never fall back to a placeholder.
    process.stderr.write(`release-hash: ${e.message}\n`);
    process.exit(1);
  }
}
