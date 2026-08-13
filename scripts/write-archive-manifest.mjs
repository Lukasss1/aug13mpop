#!/usr/bin/env node
/**
 * ============================================================================
 *  DETACHED ARCHIVE MANIFEST — binds the shipped ZIP to the source IT CONTAINS
 * ============================================================================
 *
 *  P0-4: the previous version hashed the supplied ZIP's bytes but read the
 *  release identity and source digest from the CURRENT WORKING DIRECTORY. It
 *  never opened the archive. So the detached manifest described whatever tree
 *  the operator happened to be standing in, stapled to an unrelated ZIP's byte
 *  hash — and a ZIP containing a single junk file could be "bound" to the real
 *  source. Two independent objects, nothing connecting them.
 *
 *  This version derives EVERY semantic value from INSIDE the archive:
 *    1. reject a structurally hostile archive (traversal, symlink, dupes);
 *    2. extract the ZIP into a fresh temporary directory;
 *    3. read the inner release-manifest.json FROM that extraction;
 *    4. recompute source_tree_sha256 and build_output_sha256 over the
 *       extracted content, through the one canonical hasher;
 *    5. REFUSE to write a manifest unless the archive's own inner manifest
 *       already matches its own contents.
 *
 *  The working directory is never consulted for a semantic value.
 *
 *  Usage:
 *    node scripts/write-archive-manifest.mjs <archive.zip> [companion.zip]
 * ============================================================================
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hashSourceTree, hashBuildDir, countSourceFiles } from './lib/release-hash.mjs';
import { inspectZipEntries, extractZip } from './lib/zip-inspect.mjs';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const die = (msg) => { console.error(`write-archive-manifest: ${msg}`); process.exit(2); };

const archive = process.argv[2];
const companion = process.argv[3] || null;
if (!archive || !existsSync(archive)) die('usage: write-archive-manifest.mjs <archive.zip> [companion.zip]');
if (companion && !existsSync(companion)) die(`companion archive named but not found: ${companion}`);

/* 1. Refuse a structurally hostile archive before extracting it. */
const entryReport = inspectZipEntries(archive);
if (entryReport.problems.length) {
  die(`archive has unsafe entries: ${entryReport.problems.join('; ')}`);
}

/* 2. Extract into a throwaway directory and work only from there. */
const work = mkdtempSync(path.join(tmpdir(), 'mp-writemanifest-'));
try {
  extractZip(archive, work);

  const innerPath = path.join(work, 'release-manifest.json');
  if (!existsSync(innerPath)) die('archive does not contain release-manifest.json — it is not a release archive');
  const inner = JSON.parse(readFileSync(innerPath, 'utf8'));

  /* 3. Recompute the content digests over the EXTRACTED tree. */
  const contentSource = hashSourceTree(work);
  const contentFileCount = countSourceFiles(work);
  const distDir = path.join(work, 'dist');
  const contentBuild = existsSync(distDir) ? hashBuildDir(distDir) : null;

  /* 4. The archive must not lie about its own contents. */
  if (inner.source_tree_sha256 !== contentSource) {
    die(`inner manifest source_tree_sha256 does not match the archive's actual source content\n`
      + `  inner:   ${inner.source_tree_sha256}\n  content: ${contentSource}`);
  }
  if (inner.file_count !== contentFileCount) {
    die(`inner manifest file_count does not match the archive's canonical source content\n`
      + `  inner:   ${inner.file_count}\n  content: ${contentFileCount}`);
  }
  if ((inner.build_output_sha256 || null) !== contentBuild) {
    die(`inner manifest build_output_sha256 does not match the archive's actual dist/\n`
      + `  inner:   ${inner.build_output_sha256}\n  content: ${contentBuild}`);
  }

  const detached = {
    kind: 'detached-archive-manifest',
    schema: 2,
    archive_name: path.basename(archive),
    archive_sha256: sha(archive),
    archive_bytes: statSync(archive).size,
    archive_entry_count: entryReport.count,
    source_file_count: contentFileCount,
    generated_at: new Date().toISOString(),

    // Bound to the manifest INSIDE the archive…
    release_manifest_sha256: sha(innerPath),
    // …and to the content that manifest describes, RECOMPUTED from the archive.
    source_tree_sha256: contentSource,
    build_output_sha256: contentBuild,
    release_identity: inner.release_identity || null,
    release_version: inner.release_version || null,
    migration_count: inner.migration_count ?? null,
    migration_fingerprint_sha256: inner.migration_fingerprint_sha256 || null,
    run_id: inner.run_id || null,
    node_version: inner.node_version || null,

    companion_archive_name: companion ? path.basename(companion) : null,
    companion_archive_sha256: companion ? sha(companion) : null,
    companion_archive_bytes: companion ? statSync(companion).size : null,

    verify: [
      'node scripts/verify-archive-manifest.mjs <archive> <archive>.manifest.json',
      '  (extracts the archive itself; needs NO working directory)',
    ],
    note: "Every value here is derived from the archive's own contents, not from any working directory. The verifier re-extracts and re-derives them.",
  };

  const out = `${archive}.manifest.json`;
  writeFileSync(out, `${JSON.stringify(detached, null, 2)}\n`);
  console.log(`${out} written (from archive contents)`);
  console.log(`  archive_sha256          ${detached.archive_sha256}`);
  console.log(`  source_tree_sha256      ${detached.source_tree_sha256}  (recomputed from inside the ZIP)`);
  console.log(`  build_output_sha256     ${detached.build_output_sha256}`);
  console.log(`  release_identity        ${detached.release_identity}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
