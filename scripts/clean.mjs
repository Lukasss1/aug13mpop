#!/usr/bin/env node
// Cross-platform `clean` — replaces the Unix-only `rm -rf dist server.js`.
// Audit #2 (Clean Installation Reproducibility), finding 3: the ordinary Vite
// dev/build/clean loop should run on any OS the toolchain supports (Windows,
// macOS, Linux). The DB/release orchestration (launch/launch.sh, psql, the
// bash test harnesses) remains WSL2/macOS/Linux only — that split is documented
// in README.md and OWNERS-GUIDE.md.
//
// rmSync with { recursive: true, force: true } removes a directory (dist) or a
// single file (server.js) and never errors when the target is already absent,
// so a clean checkout and a repeated `npm run clean` both behave identically.

import { rmSync } from 'node:fs';

const targets = ['dist', 'server.js'];

for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
}

console.log(`clean: removed ${targets.join(', ')} (if present)`);
