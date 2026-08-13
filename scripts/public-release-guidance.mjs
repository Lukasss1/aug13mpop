#!/usr/bin/env node
console.error(`Milk Pop public deployment is performed only by the protected GitHub Actions “release” workflow.

Run locally first:
  npm ci
  npm run public:preflight

Then open GitHub Actions → release → Run workflow.

For an advanced local signed artefact only (no deployment), use:
  npm run public:seal
`);
process.exit(2);
