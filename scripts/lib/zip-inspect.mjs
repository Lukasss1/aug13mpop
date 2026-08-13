/**
 * ============================================================================
 *  ZIP ENTRY INSPECTION + SAFE EXTRACTION  (P0-4)
 * ============================================================================
 *
 *  A release verifier that extracts an archive must first refuse the archives
 *  designed to escape the extraction directory or smuggle a link where a file
 *  is expected. This module answers, from the central directory alone (no
 *  extraction), whether an archive is structurally safe, and then extracts it
 *  only if it is.
 *
 *  Detected and rejected:
 *    • path traversal   — any entry whose normalised path leaves the root
 *      (`../`, absolute paths, Windows drive/backslash forms);
 *    • symlink entries  — Unix mode S_IFLNK in the entry's external attributes
 *      (an extracted symlink can redirect later reads outside the tree);
 *    • duplicate names  — the same path twice (which of the two "is" the file?);
 *    • case collisions  — names equal only under case folding, which collide on
 *      case-insensitive filesystems and let one entry silently shadow another.
 *
 *  Entry inspection uses Python's zipfile, which exposes the Unix mode bits
 *  that `unzip -l` does not surface cleanly.
 * ============================================================================
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PY_INSPECT = `
import json, sys, stat, zipfile, posixpath
path = sys.argv[1]
# Resource limits — an UNAUTHENTICATED archive must not be able to exhaust disk,
# memory or CPU before it is rejected (zip-bomb defence).
MAX_ENTRIES = 20000
MAX_TOTAL_UNCOMPRESSED = 2 * 1024 * 1024 * 1024   # 2 GiB
MAX_FILE_UNCOMPRESSED = 512 * 1024 * 1024         # 512 MiB
MAX_RATIO = 500                                    # uncompressed:compressed
problems = []
names = []
seen = {}
seen_ci = {}
total_uncompressed = 0
try:
    zf = zipfile.ZipFile(path)
except Exception as e:
    print(json.dumps({"count": 0, "names": [], "problems": ["not a readable zip: %s" % e]}))
    sys.exit(0)
infos = zf.infolist()
if len(infos) > MAX_ENTRIES:
    problems.append("too many entries: %d > %d" % (len(infos), MAX_ENTRIES))
for info in infos:
    total_uncompressed += info.file_size
    if info.file_size > MAX_FILE_UNCOMPRESSED:
        problems.append("oversize entry: %s (%d bytes)" % (info.filename, info.file_size))
    if info.compress_size > 0 and info.file_size / info.compress_size > MAX_RATIO:
        problems.append("suspicious compression ratio: %s (%.0fx)" % (info.filename, info.file_size / info.compress_size))
if total_uncompressed > MAX_TOTAL_UNCOMPRESSED:
    problems.append("total uncompressed size too large: %d bytes" % total_uncompressed)
for info in infos:
    name = info.filename
    names.append(name)
    # directory entries end with '/'
    is_dir = name.endswith('/')
    # symlink?
    mode = info.external_attr >> 16
    if mode and stat.S_ISLNK(mode):
        problems.append("symlink entry: %s" % name)
    # traversal / absolute / windows forms
    n = name.replace('\\\\', '/')
    if n.startswith('/') or (len(n) > 1 and n[1] == ':'):
        problems.append("absolute path: %s" % name)
    norm = posixpath.normpath(n)
    if norm == '..' or norm.startswith('../') or '/../' in ('/' + norm):
        problems.append("path traversal: %s" % name)
    # duplicates
    if not is_dir:
        if name in seen:
            problems.append("duplicate entry: %s" % name)
        seen[name] = True
        lo = name.lower()
        if lo in seen_ci and seen_ci[lo] != name:
            problems.append("case collision: %s vs %s" % (name, seen_ci[lo]))
        seen_ci[lo] = name
print(json.dumps({"count": len(names), "names": names, "problems": problems}))
`;

/**
 * Inspect a ZIP's central directory for unsafe entries. Never extracts.
 * @returns {{count:number, names:string[], problems:string[]}}
 */
export function inspectZipEntries(archivePath) {
  const out = execFileSync('python3', ['-c', PY_INSPECT, archivePath], { encoding: 'utf8' });
  return JSON.parse(out);
}

/**
 * Extract a ZIP into destDir. Callers MUST run inspectZipEntries first and
 * refuse on problems; this is the second line of defence, not the first.
 */
export function extractZip(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  // -q quiet, -o overwrite (dest is a fresh temp dir). unzip itself refuses
  // to write outside the destination for traversal entries.
  execFileSync('unzip', ['-q', '-o', archivePath, '-d', destDir], { stdio: 'pipe' });
}
