#!/usr/bin/env node
/** T13.3.18 — blocked browser storage and legacy money-store recovery. */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
const check = (label, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`PASS — ${label}`); }
  else { failed += 1; console.log(`FAIL — ${label}${detail ? ` (${detail})` : ''}`); }
};

const runTypedModuleScenario = (source) => spawnSync(process.execPath, [
  '--experimental-strip-types', '--input-type=module', '--eval', source,
], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });

const tillLeaseUrl = pathToFileURL(path.join(ROOT, 'src/lib/tillLease.ts')).href;
const outboxUrl = pathToFileURL(path.join(ROOT, 'src/lib/orderOutbox.ts')).href;
const lease = read('src/lib/tillLease.ts');
const outbox = read('src/lib/orderOutbox.ts');
const tillOrders = read('src/components/admin/TillOrders.tsx');
const staffPortal = read('src/components/StaffPortal.tsx');
const salesPos = read('src/components/SalesPOS.tsx');
const env = read('.env.example');
const pkg = JSON.parse(read('package.json'));
const migrationManifest = read('launch/migration-manifest.sh');

console.log('\n— Till module import under blocked storage —');
const blockedLease = runTypedModuleScenario(`
  globalThis.window = {};
  Object.defineProperty(globalThis.window, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('blocked by policy', 'SecurityError'); },
  });
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  const lease = await import(${JSON.stringify(tillLeaseUrl)});
  const before = { state: lease.leaseState(), mechanism: lease.leaseMechanism(), money: lease.moneyAllowed() };
  const acquired = await lease.acquireTillLease();
  const after = { state: lease.leaseState(), mechanism: lease.leaseMechanism(), money: lease.moneyAllowed() };
  console.log(JSON.stringify({ before, acquired, after }));
`);
check('tillLease module loads when the localStorage getter throws', blockedLease.status === 0, blockedLease.stderr.trim());
let blockedLeaseResult = null;
try { blockedLeaseResult = JSON.parse(blockedLease.stdout.trim().split('\n').at(-1)); } catch { /* checked below */ }
check('blocked storage starts fail-closed rather than money-capable',
  blockedLeaseResult?.before?.state === 'unknown'
  && blockedLeaseResult?.before?.mechanism === 'none'
  && blockedLeaseResult?.before?.money === false);
check('blocked storage acquisition resolves secondary with zero money capability',
  blockedLeaseResult?.acquired === 'secondary'
  && blockedLeaseResult?.after?.state === 'secondary'
  && blockedLeaseResult?.after?.money === false);

const blockedLeaseWithLocks = runTypedModuleScenario(`
  globalThis.window = {};
  Object.defineProperty(globalThis.window, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('blocked by policy', 'SecurityError'); },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: (_name, _opts, cb) => Promise.resolve(cb({ name: 'milkpop_till_primary_v1' })) } },
  });
  const lease = await import(${JSON.stringify(`${tillLeaseUrl}?locks`)});
  const acquired = await lease.acquireTillLease();
  console.log(JSON.stringify({ acquired, mechanism: lease.leaseMechanism(), storage: lease.leaseStorageAvailable(), money: lease.moneyAllowed() }));
`);
check('a Web Lock cannot bypass missing durable storage', blockedLeaseWithLocks.status === 0, blockedLeaseWithLocks.stderr.trim());
let blockedWithLocksResult = null;
try { blockedWithLocksResult = JSON.parse(blockedLeaseWithLocks.stdout.trim().split('\n').at(-1)); } catch { /* checked below */ }
check('blocked storage remains money-incapable even while this tab owns the Web Lock',
  blockedWithLocksResult?.acquired === 'primary'
  && blockedWithLocksResult?.mechanism === 'locks'
  && blockedWithLocksResult?.storage === false
  && blockedWithLocksResult?.money === false);
check('storage resolution is guarded during singleton detection',
  /function resolveStorage\(hasWindow: boolean\)/.test(lease)
  && /try\s*\{\s*return window\.localStorage;\s*\}\s*catch\s*\{\s*return null;\s*\}/s.test(lease)
  && /storage: resolveStorage\(hasWindow\)/.test(lease));
check('deferred POS keeps its guarded storage boundary without remaining in Staff Portal',
  !/from ['"]\.\/SalesPOS['"]/.test(staffPortal)
  && /from ['"]\.\.\/lib\/tillLease['"]/.test(salesPos));

console.log('\n— malformed legacy money-store recovery —');
const corruptOutbox = runTypedModuleScenario(`
  const raw = '{"id":"truncated"';
  let setCalls = 0;
  const storage = {
    getItem() { return raw; },
    setItem() { setCalls += 1; },
    removeItem() {},
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  const outbox = await import(${JSON.stringify(outboxUrl)});
  const snapshot = outbox.legacySnapshot();
  const removed = outbox.removeEntry('anything');
  console.log(JSON.stringify({ snapshot, removed, setCalls, recovery: outbox.legacyRecoverySnapshot() }));
`);
check('corrupt legacy JSON is detected without throwing', corruptOutbox.status === 0, corruptOutbox.stderr.trim());
let corruptResult = null;
try { corruptResult = JSON.parse(corruptOutbox.stdout.trim().split('\n').at(-1)); } catch { /* checked below */ }
check('corrupt legacy JSON is preserved verbatim for recovery',
  corruptResult?.snapshot?.status === 'corrupt'
  && corruptResult?.snapshot?.entries?.length === 0
  && corruptResult?.snapshot?.raw === '{"id":"truncated"'
  && corruptResult?.recovery === '{"id":"truncated"');
check('removeEntry cannot overwrite an unreadable money-bearing store',
  corruptResult?.removed === false && corruptResult?.setCalls === 0);

const unavailableOutbox = runTypedModuleScenario(`
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('blocked', 'SecurityError'); },
  });
  const outbox = await import(${JSON.stringify(`${outboxUrl}?unavailable`)});
  console.log(JSON.stringify(outbox.legacySnapshot()));
`);
check('unavailable legacy storage becomes an explicit recoverable state', unavailableOutbox.status === 0, unavailableOutbox.stderr.trim());
let unavailableResult = null;
try { unavailableResult = JSON.parse(unavailableOutbox.stdout.trim().split('\n').at(-1)); } catch { /* checked below */ }
check('unavailable legacy storage never masquerades as a healthy empty queue',
  unavailableResult?.status === 'unavailable' && unavailableResult?.entries?.length === 0);

const validOutbox = runTypedModuleScenario(`
  let raw = JSON.stringify([{ id: 'legacy-1', row: { total: 650 }, queuedAt: '2026-01-01T00:00:00.000Z', attempts: 1 }]);
  let setCalls = 0;
  const storage = {
    getItem() { return raw; },
    setItem(_key, value) { setCalls += 1; raw = String(value); },
    removeItem() {},
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  const outbox = await import(${JSON.stringify(`${outboxUrl}?valid`)});
  const before = outbox.legacySnapshot();
  const removed = outbox.removeEntry('legacy-1');
  const after = outbox.legacySnapshot();
  console.log(JSON.stringify({ before, removed, after, setCalls }));
`);
check('valid legacy entries retain the existing deliberate-removal workflow', validOutbox.status === 0, validOutbox.stderr.trim());
let validResult = null;
try { validResult = JSON.parse(validOutbox.stdout.trim().split('\n').at(-1)); } catch { /* checked below */ }
check('valid removal is verified as one explicit write',
  validResult?.before?.status === 'ok'
  && validResult?.before?.entries?.length === 1
  && validResult?.removed === true
  && validResult?.after?.status === 'ok'
  && validResult?.after?.entries?.length === 0
  && validResult?.setCalls === 1);

console.log('\n— manager recovery surface —');
check('legacy store exposes typed status and raw-recovery access',
  /export type LegacyOutboxReadStatus = 'ok' \| 'unavailable' \| 'corrupt'/.test(outbox)
  && /export function legacySnapshot\(\)/.test(outbox)
  && /export function legacyRecoverySnapshot\(\)/.test(outbox));
check('manager UI surfaces corruption as an alert and forbids destructive guidance',
  /Legacy held-sale data is unreadable/.test(tillOrders)
  && /do not clear browser data or retry\/remove entries/.test(tillOrders)
  && /role="alert"/.test(tillOrders));
check('manager UI can download untouched raw recovery data',
  /downloadLegacyRecovery/.test(tillOrders)
  && /Download raw recovery data/.test(tillOrders)
  && /legacyRecoverySnapshot\(\)/.test(tillOrders));
check('manager UI surfaces unavailable storage instead of claiming no held sales',
  /legacyStatus === 'unavailable'/.test(tillOrders)
  && /Browser storage is unavailable/.test(tillOrders)
  && /legacyStatus === 'ok' && legacy\.length === 0/.test(tillOrders));
check('cashier and recovery write controls explicitly block unavailable durable storage',
  /leaseStorageAvailable\(\)/.test(salesPos)
  && /Browser storage is blocked or unavailable/.test(salesPos)
  && /leaseStorageAvailable\(\)/.test(tillOrders)
  && /cannot durably retain the exact request/.test(tillOrders));

console.log('\n— release continuity —');
check('application version is current', pkg.version === '4.10.15');
check('current release retains T13.3.18 storage resilience',
  /^VITE_RELEASE_IDENTITY=r4\.10\.15-t13\.3\.30-final-production-closure$/m.test(env));
check('database chain retains storage resilience in the current append-only ledger',
  /migration_t13313_staff_portal_integrity\.sql"[\s\S]*migration_t13319_release_integrity\.sql"\s+"supabase\/migration_t13320_final_audit\.sql"\s+"supabase\/migration_t13322_public_store_scope\.sql"\s*\)/s.test(migrationManifest)
  && !/migration_t1331[45678]/.test(migrationManifest));
check('current T13.3.30 commissioning authority exists',
  existsSync(path.join(ROOT, 'PRODUCTION-COMMISSIONING-T13.3.30.md')));
check('storage resilience is included in complete verification',
  /npm run test:storage-resilience/.test(pkg.scripts?.verify || '')
  && pkg.scripts?.['test:storage-resilience'] === 'node scripts/t13318-storage-resilience.test.mjs');

console.log(`\nT13.3.18 STORAGE RESILIENCE — ${passed}/${passed + failed} passed`);
if (passed + failed !== 24) {
  console.error(`Contract definition error: expected 24 checks, found ${passed + failed}.`);
  process.exit(1);
}
process.exit(failed ? 1 : 0);
