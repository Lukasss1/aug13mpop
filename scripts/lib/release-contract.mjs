/**
 * ============================================================================
 *  RELEASE CONTRACT  (P0-4 round 2)  —  the CODE-OWNED stage definition
 * ============================================================================
 *
 *  Round 1 let the release describe itself: `release-set.json` carried its own
 *  `expected_stages`, and the verifier checked the receipts against THAT list.
 *  A release that simply omitted a stage from both the run and the list still
 *  verified, and only a 13-stage "required core" was ever enforced. Receipts
 *  also recorded a `command` that nothing ever checked — a receipt for
 *  `db-baseline` claiming `"command": "true"` satisfied every check.
 *
 *  This module is the fix: the complete stage set and the exact command each
 *  stage must run live HERE, in code that ships inside the archive and is
 *  covered by source_tree_sha256. The set-writer and the verifier both compare
 *  against this contract, never against a list the release supplies about
 *  itself. Adding, renaming or dropping a stage is a source change — visible
 *  in the digest, reviewable, and impossible to do from a manifest alone.
 *
 *  Two kinds of stage:
 *    • ordinary stages — must exist, must have run the contract's command, and
 *      must have exited 0 on the run's source digest.
 *    • BUILD-BOUND stages (`buildBound: true`) — additionally must record the
 *      `build_output_sha256` of the build they exercised, and the verifier
 *      requires that hash to equal the dist/ it extracts from the package.
 *      This is what ties the SHIPPED build to the build that was TESTED; the
 *      frozen-lane stages below are the authoritative browser evidence.
 *
 *  Note `browser-r49` is deliberately NOT build-bound: its method is to
 *  rebuild dist/ against a stub backend to prove the app fails closed, so the
 *  build it exercises is a stub and must never equal the deployable.
 * ============================================================================
 */

/** stage → { command, buildBound } */
export const STAGE_CONTRACT = Object.freeze({
  /* static + build */
  'verify-static': { command: 'npm run verify', buildBound: false },
  build: { command: 'npm run build', buildBound: false },

  /* database chain */
  'db-baseline': { command: 'npm run test:baseline', buildBound: false },
  'db-rls-local': { command: 'npm run test:rls-local', buildBound: false },
  'db-r48-upgrade': { command: 'npm run test:r48-upgrade', buildBound: false },
  'db-adopt': { command: 'npm run test:adopt', buildBound: false },
  'db-r410-contract': { command: 'npm run test:r410-contract', buildBound: false },
  'db-r410-authz': { command: 'npm run test:r410-authz', buildBound: false },
  'db-r410-lifecycle': { command: 'npm run test:r410-lifecycle', buildBound: false },
  'db-r410-launch': { command: 'npm run test:r410-launch-candidate', buildBound: false },
  'db-r410-form-matrix': { command: 'npm run test:r410-form-matrix', buildBound: false },
  'db-r410-publish-mech': { command: 'npm run test:r410-publish-record', buildBound: false },
  'db-r49-publish-safety': { command: 'npm run test:r49-publish-safety', buildBound: false },
  'client-wire': { command: 'npm run test:client-wire', buildBound: false },
  'db-stage3-equivalence': { command: 'npm run stage3:baseline', buildBound: false },
  'db-inc11-view-authority': { command: 'npm run test:inc11-view-authority', buildBound: false },
  'db-inc11-boundary': { command: 'npm run test:inc11-boundary', buildBound: false },
  'db-inc11-notices': { command: 'npm run test:inc11-notices', buildBound: false },
  'db-inc11-studio': { command: 'npm run test:inc11-studio', buildBound: false },
  'db-inc11-lifecycle': { command: 'npm run test:inc11-lifecycle', buildBound: false },
  'db-inc11-revisions': { command: 'npm run test:inc11-revisions', buildBound: false },
  'db-retention': { command: 'npm run test:retention', buildBound: false },
  'db-backup-restore': { command: 'npm run test:backup-restore', buildBound: false },
  'db-concurrency-repeat': { command: 'npm run test:ws7-concurrency-repeat', buildBound: false },

  /* small-business and T13 closure gates */
  'db-smallbiz-closure': { command: 'npm run test:smallbiz', buildBound: false },
  'closure-hydration': { command: 'npm run test:closure-hydration', buildBound: false },
  'db-closure-2nd-store': { command: 'npm run test:closure-second-store', buildBound: false },
  't13-behaviour': { command: 'npm run test:t13', buildBound: false },

  /* artefact scans + provenance */
  'seed-scan': { command: 'npm run test:seed-honesty', buildBound: false },
  'bundle-scan': { command: 'npm run scan:bundle', buildBound: false },
  provenance: { command: 'npm run test:provenance', buildBound: false },

  /* browser lane inside verify-release (against whatever dist exists then) */
  'browser-routing': { command: 'npm run test:routing', buildBound: false },
  'browser-clicks': { command: 'npm run audit:clicks', buildBound: false },
  'browser-launch-polish': { command: 'npm run audit:launch-polish', buildBound: false },
  'browser-auth-multitab': { command: 'npm run test:auth-multitab-browser', buildBound: false },
  'browser-r49': { command: 'npm run test:r49-browser', buildBound: false },

  /* ---- PRODUCTION BUILD (production profile only) ----------------------
     Proves the shipped dist came from `npm run build:production`, rather than
     trusting a build_profile string in a manifest. Required when the release
     declares build_profile "production"; it must be ABSENT otherwise, so a
     development release cannot borrow production evidence. */
  'production-build': { command: 'npm run build:production', buildBound: true, productionOnly: true },
  /* P0-5: the shipped dist must be a REAL production artefact — approved
     backend and site actually injected, no demo/placeholder/dev remnants,
     commercial output enabled. Build-bound, so the artefact it judged is the
     artefact that ships. */
  'production-artifact': { command: 'npm run verify:production-artifact', buildBound: true, productionOnly: true },
  /* SEO/commercial output is part of "is this fit to be public", so the SEO
     suites are contract stages for a production release rather than an
     optional lane someone remembers to run. */
  'production-seo': { command: 'npm run test:seo', buildBound: true, productionOnly: true },

  /* ---- AUTHORITATIVE FROZEN-BUILD LANE (release:seal, after restore) ----
     These run against the exact deployable that gets packaged, and each
     records that build's hash. They are the binding between tested and
     shipped: the verifier requires their build_output_sha256 to equal the
     dist/ it extracts from the archive. */
  'frozen-routing': { command: 'npm run test:routing', buildBound: true },
  'frozen-clicks': { command: 'npm run audit:clicks', buildBound: true },
  'frozen-final': { command: 'npm run audit:final', buildBound: true },
  'frozen-bundle': { command: 'npm run scan:bundle', buildBound: true },
});

/** Every stage in the contract, sorted (including production-only ones). */
export const ALL_STAGES = Object.freeze(Object.keys(STAGE_CONTRACT).sort());

/** Stages required only when the release declares build_profile "production". */
export const PRODUCTION_ONLY_STAGES = Object.freeze(
  ALL_STAGES.filter((s) => STAGE_CONTRACT[s].productionOnly),
);

/** The stages a release must attest for a given build profile. */
export function stagesForProfile(profile) {
  return profile === 'production'
    ? ALL_STAGES
    : ALL_STAGES.filter((s) => !STAGE_CONTRACT[s].productionOnly);
}

/** Stages that must carry a build_output_sha256 equal to the shipped dist. */
export const BUILD_BOUND_STAGES = Object.freeze(
  ALL_STAGES.filter((s) => STAGE_CONTRACT[s].buildBound),
);

/** The command a stage must have run, or undefined if the stage is unknown. */
export function commandFor(stage) {
  return STAGE_CONTRACT[stage]?.command;
}

/**
 * Compare a set of observed stage names against the contract.
 * @returns {{missing:string[], unknown:string[]}}
 */
export function diffStages(observed, profile = 'development') {
  const seen = new Set(observed);
  const required = stagesForProfile(profile);
  return {
    missing: required.filter((s) => !seen.has(s)),
    // a stage outside the contract, OR a production-only stage in a
    // development release (which would be borrowed evidence)
    unknown: [...seen].filter((s) => !STAGE_CONTRACT[s] || !required.includes(s)).sort(),
  };
}

/** Build profiles a release may declare. Only 'production' is deployable. */
export const BUILD_PROFILES = Object.freeze(['production', 'development']);
