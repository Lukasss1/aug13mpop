#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const initial=readFileSync('supabase/migration_t1336_retention_heartbeat.sql','utf8');
const hardening=readFileSync('supabase/migration_t1336_scheduler_failure_heartbeats.sql','utf8');
const usability=readFileSync('supabase/migration_t1337_small_business_usability.sql','utf8');
const manifest=readFileSync('launch/migration-manifest.sh','utf8');
const probe=readFileSync('scripts/deployed-acceptance-probe.mjs','utf8');
const commissioner=readFileSync('scripts/commission-production-schedulers.mjs','utf8');
const checks=[
 ['initial migration adds retention heartbeat',/record_heartbeat\('retention-sweep', 'ok'/.test(initial)],
 ['hardening preserves failed heartbeat without rethrow',/record_heartbeat\('retention-sweep', 'failed'[\s\S]*return jsonb_build_object\([\s\S]*'ok', false/.test(hardening) && !/record_heartbeat\('retention-sweep', 'failed'[\s\S]*raise;/.test(hardening)],
 ['employment sweep records success and failure',/record_heartbeat\([\s\S]*'employment-sweep'[\s\S]*'ok'/.test(hardening) && /record_heartbeat\('employment-sweep', 'failed'/.test(hardening)],
 ['browser roles remain revoked',/revoke all on function public\.run_retention_sweep[\s\S]*authenticated/.test(hardening) && /revoke all on function public\.employment_sweep_due[\s\S]*authenticated/.test(hardening)],
 ['usability migration follows scheduler hardening in ordered ledger',manifest.includes('\"supabase/migration_t1336_scheduler_failure_heartbeats.sql\"\n  \"supabase/migration_t1337_small_business_usability.sql\"')],
 ['commissioner creates all four exact jobs',/cron\.schedule\([\s\S]*'outbox-dispatch'[\s\S]*'employment-sweep'[\s\S]*'retention-sweep'[\s\S]*'ops-health-watch'/.test(commissioner)],
 ['commissioner stores worker secrets in Vault',/vault\.create_secret/.test(commissioner) && /vault\.decrypted_secrets/.test(commissioner)],
 ['deployed probe requires all four active jobs',/employment-sweep,ops-health-watch,outbox-dispatch,retention-sweep/.test(probe)],
 ['deployed probe requires outbox heartbeat',/outbox-dispatch/.test(probe) && /20 minutes/.test(probe)],
 ['deployed probe requires employment heartbeat',/employment-sweep/.test(probe) && /26 hours/.test(probe)],
 ['deployed probe requires retention heartbeat',/retention-sweep/.test(probe) && /30 hours/.test(probe)],
 ['health watch records liveness and has a deployed age gate',/record_heartbeat\('ops-health-watch'/.test(usability) && /ops-health-watch heartbeat[\s\S]*2 hours/.test(probe)],
];
let pass=0;for(const [n,c]of checks){try{assert.equal(c,true);pass++;console.log(`PASS ${n}`)}catch{console.error(`FAIL ${n}`);process.exitCode=1}}
if(!process.exitCode)console.log(`PRODUCTION SCHEDULER CONTRACT — ${pass}/${checks.length} passed`);
