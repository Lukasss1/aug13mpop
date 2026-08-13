#!/usr/bin/env node
/**
 * Milk Pop P0 source gate.
 *
 * Runs the launch-blocking source/contract/security checks that are deliberately
 * independent of npm installation, PostgreSQL and live cloud credentials.
 * It does NOT replace build, browser, database or production commissioning.
 */
import { spawnSync } from 'node:child_process';

const gates = [
  ['deep opening final', 'scripts/opening-final.test.mjs'],
  ['small-business usability', 'scripts/small-business-usability.test.mjs'],
  ['founder readiness', 'scripts/founder-readiness.test.mjs'],
  ['deferred runtime reachability', 'scripts/deferred-import-reachability.test.mjs'],
  ['deployment polish', 'scripts/deployment-polish.test.mjs'],
  ['runtime resilience', 'scripts/runtime-resilience.test.mjs'],
  ['provider resilience', 'scripts/t13316-provider-resilience.test.mjs'],
  ['operator recovery', 'scripts/t13317-operator-recovery.test.mjs'],
  ['storage resilience', 'scripts/t13318-storage-resilience.test.mjs'],
  ['final audit reliability', 'scripts/t13320-final-audit.test.mjs'],
  ['public website scope', 'scripts/t13322-public-web.test.mjs'],
  ['public route closure', 'scripts/t13323-public-route-closure.test.mjs'],
  ['release integrity', 'scripts/t13319-release-integrity.test.mjs'],
  ['OPT-01 production hosting contract', 'scripts/opt01-contract.test.mjs'],
  ['public deployment handoff', 'scripts/t13324-public-deployment-handoff.test.mjs'],
  ['local preflight trust split', 'scripts/t13325-local-preflight-trust-split.test.mjs'],
  ['local preflight configuration', 'scripts/t13326-local-preflight-config.test.mjs'],
  ['production deployment closure', 'scripts/t13328-production-deployment-closure.test.mjs'],
  ['protected deployment closure', 'scripts/t13329-deployment-closure.test.mjs'],
  ['T13.3.30 final closure invariants', 'scripts/t13330-final-closure.test.mjs'],
  ['known-partial recovery contract', 'scripts/partial-fresh-recovery.test.mjs'],
  ['production release input contract', 'scripts/validate-production-release-inputs.test.mjs'],
  ['production commissioning input contract', 'scripts/validate-production-commissioning-inputs.test.mjs'],
  ['verified signed-dist materialization', 'scripts/materialize-verified-dist.test.mjs'],
  ['public function deploy decision', 'scripts/decide-public-function-deploy.test.mjs'],
  ['function rollback recovery', 'scripts/function-rollback-recovery.test.mjs'],
  ['deployment receipt contract', 'scripts/write-deployment-receipt.test.mjs'],
  ['deployment handoff', 'scripts/deployment-handoff.test.mjs'],
  ['launch honesty', 'scripts/t1333-launch-honesty.test.mjs'],
  ['AdminPanel optimisation contract', 'scripts/admin-panel-optimization.test.mjs'],
  ['StaffPortal integrity contract', 'scripts/staff-portal-integrity.test.mjs'],
  ['Staff dashboard model', 'scripts/staff-dashboard-model.test.mjs'],
  ['security regression', 'scripts/security-regression.test.mjs'],
  ['workflow mechanical integrity', 'scripts/workflow-mechanical-integrity.test.mjs'],
  ['complete backup and recovery contract', 'scripts/backup-recovery-contract.test.mjs'],
  ['release hash boundary', 'scripts/release-hash-boundary.test.mjs'],
  ['provenance hermeticity', 'scripts/provenance-hermeticity.test.mjs'],
  ['release package boundary', 'scripts/release-package-boundary.test.mjs'],
  ['Edge Function inventory', 'scripts/edge-function-inventory.test.mjs'],
  ['function deployment evidence', 'scripts/function-deploy-evidence.test.mjs'],
  ['release source ref guard', 'scripts/verify-release-source-ref.test.mjs'],
  ['release pipeline contract', 'scripts/release-pipeline-contract.test.mjs'],
  ['evidence closure contract', 'scripts/evidence-closure.test.mjs'],
  ['locked local toolchain contract', 'scripts/local-toolchain-contract.test.mjs'],
  ['public-form integrity', 'scripts/public-form-integrity.test.mjs'],
  ['public-form live fixture', 'scripts/public-form-live-fixture.test.mjs'],
  ['migration manifest integrity', 'scripts/migration-manifest.test.mjs'],
  ['RLS structure', 'scripts/rls-policy.test.mjs'],
  ['permission parity', 'scripts/permission-parity.test.mjs'],
  ['permission closure', 'scripts/permission-closure.test.mjs'],
  ['backend commissioning workflow', 'scripts/backend-commissioning-workflow.test.mjs'],
  ['backend commissioning receipt', 'scripts/write-backend-commissioning-receipt.test.mjs'],
  ['production scheduler contract', 'scripts/t1336-production-scheduler.test.mjs'],
  ['scheduler commissioning contract', 'scripts/commission-production-schedulers.test.mjs'],
  ['production release preflight', 'scripts/production-release-preflight.test.mjs'],
  ['Netlify file-digest deployment contract', 'scripts/deploy-netlify-zip.test.mjs'],
  ['Netlify promotion and rollback contract', 'scripts/netlify-promotion.test.mjs'],
  ['live release floor', 'scripts/check-live-release-floor.test.mjs'],
  ['live release marker waiter', 'scripts/wait-for-live-release.test.mjs'],
  ['deployed acceptance probe contract', 'scripts/deployed-acceptance-probe.test.mjs'],
  ['database commissioning contract', 'scripts/commission-database.test.mjs'],
  ['Supabase secret contract', 'scripts/verify-supabase-secrets.test.mjs'],
  ['live production gate contract', 'scripts/live-production-gates.test.mjs'],
  ['outbox live-delivery contract', 'scripts/outbox-delivery.live.test.mjs'],
];

let passed = 0;
for (const [name, script] of gates) {
  console.log(`\n=== P0: ${name} ===`);
  const result = spawnSync(process.execPath, [script], {
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '0', TERM: process.env.TERM || 'dumb' },
  });
  if (result.error) {
    console.error(`P0 gate could not start: ${name}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\nP0 SOURCE GATE FAILED at: ${name} (exit ${result.status ?? 'unknown'})`);
    process.exit(result.status || 1);
  }
  passed += 1;
}

console.log(`\nP0 SOURCE GATE PASSED — ${passed}/${gates.length} launch-blocking source contracts`);
console.log('External GO gates remain mandatory: locked npm build/browser, PostgreSQL fresh+upgrade+RLS+concurrency+restore, and live Supabase/Netlify commissioning.');
