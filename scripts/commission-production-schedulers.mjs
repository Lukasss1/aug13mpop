#!/usr/bin/env node
/** Configure the four required production schedulers without placing secrets
 * in process arguments or cron.job command text. Project URL and the legacy
 * service-role scheduler key are stored encrypted in Supabase Vault and read
 * only at execution time by pg_cron/pg_net. */
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseAndValidateSupabaseDbUrl } from './lib/supabase-db-target.mjs';

const dbUrl = process.env.SUPABASE_DB_URL || '';
const projectUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const psqlBin = process.env.MP_PSQL_BIN || 'psql';
if (!dbUrl || !projectUrl || !serviceKey) {
  console.error('SUPABASE_DB_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(2);
}
if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(projectUrl)) {
  console.error('SUPABASE_URL must be the exact hosted production project URL.');
  process.exit(2);
}
const projectRef = new URL(projectUrl).hostname.split('.')[0];
let dbTarget;
try { dbTarget = parseAndValidateSupabaseDbUrl(dbUrl, projectRef); }
catch (error) {
  console.error(`SUPABASE_DB_URL does not exactly match the production project: ${error.message}`);
  process.exit(2);
}

const parsed = dbTarget.url;
const dir = mkdtempSync(join(tmpdir(), 'milkpop-schedulers-'));
const pgpass = join(dir, '.pgpass');
const escPg = (s) => String(s).replace(/([\\:])/g, '\\$1');
const sqlLiteral = (s) => `'${String(s).replaceAll("'", "''")}'`;
writeFileSync(pgpass, `${escPg(parsed.hostname)}:${parsed.port || '5432'}:${escPg(parsed.pathname.slice(1) || 'postgres')}:${escPg(decodeURIComponent(parsed.username))}:${escPg(decodeURIComponent(parsed.password))}\n`, { mode: 0o600 });
chmodSync(pgpass, 0o600);

const projectSecret = sqlLiteral(projectUrl);
const serviceSecret = sqlLiteral(serviceKey);
const sql = String.raw`
\set ON_ERROR_STOP on
create schema if not exists extensions;
create schema if not exists vault;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

do $vault$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name='milkpop_project_url' limit 1;
  if v_id is null then
    perform vault.create_secret(${projectSecret}, 'milkpop_project_url', 'Milk Pop production Edge Function base URL');
  else
    perform vault.update_secret(v_id, ${projectSecret}, 'milkpop_project_url', 'Milk Pop production Edge Function base URL');
  end if;
  select id into v_id from vault.secrets where name='milkpop_scheduler_service_role' limit 1;
  if v_id is null then
    perform vault.create_secret(${serviceSecret}, 'milkpop_scheduler_service_role', 'Milk Pop scheduled worker key');
  else
    perform vault.update_secret(v_id, ${serviceSecret}, 'milkpop_scheduler_service_role', 'Milk Pop scheduled worker key');
  end if;
end
$vault$;

select cron.unschedule(jobid)
  from cron.job
 where jobname in ('outbox-dispatch','employment-sweep','retention-sweep','ops-health-watch');

select cron.schedule(
  'outbox-dispatch',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='milkpop_project_url') || '/functions/v1/outbox-dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name='milkpop_scheduler_service_role'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='milkpop_scheduler_service_role')
    ),
    body := '{}'::jsonb
  );
  $job$
);

select cron.schedule(
  'employment-sweep',
  '10 0 * * *',
  $job$ select public.employment_sweep_due(); $job$
);

select cron.schedule(
  'retention-sweep',
  '17 3 * * *',
  $job$ select public.run_retention_sweep(); $job$
);

select cron.schedule(
  'ops-health-watch',
  '23 * * * *',
  $job$ select public.check_ops_heartbeat_staleness(); $job$
);

-- Establish immediate liveness evidence rather than waiting for tomorrow.
select public.employment_sweep_due();
select public.run_retention_sweep();
select public.check_ops_heartbeat_staleness();

select case when count(*)=4 then 'SCHEDULER_ROWS_OK' else 'SCHEDULER_ROWS_BAD_' || count(*)::text end
  from cron.job
 where active and jobname in ('outbox-dispatch','employment-sweep','retention-sweep','ops-health-watch');
`;

const env = {
  ...process.env,
  PGHOST: parsed.hostname,
  PGPORT: parsed.port || '5432',
  PGDATABASE: parsed.pathname.slice(1) || 'postgres',
  PGUSER: decodeURIComponent(parsed.username),
  PGPASSFILE: pgpass,
  PGSSLMODE: parsed.searchParams.get('sslmode') || 'require',
};
delete env.SUPABASE_DB_URL;
delete env.SUPABASE_SERVICE_ROLE_KEY;

let result;
try {
  result = spawnSync(psqlBin, ['-X', '-v', 'ON_ERROR_STOP=1', '-At'], {
    input: sql,
    encoding: 'utf8',
    env,
    maxBuffer: 4 * 1024 * 1024,
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (result.error || result.status !== 0) {
  console.error(`SCHEDULER COMMISSION FAIL — ${result.error?.message || String(result.stderr || '').slice(0, 500)}`);
  process.exit(1);
}
if (!String(result.stdout).includes('SCHEDULER_ROWS_OK')) {
  console.error('SCHEDULER COMMISSION FAIL — required active cron rows were not confirmed');
  process.exit(1);
}

// Run the worker once now so its heartbeat exists before the deployed probe.
const response = await fetch(`${projectUrl}/functions/v1/outbox-dispatch`, {
  method: 'POST',
  headers: {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  },
  body: '{}',
});
if (!response.ok) {
  console.error(`SCHEDULER COMMISSION FAIL — immediate outbox worker HTTP ${response.status}`);
  process.exit(1);
}
console.log('PRODUCTION SCHEDULERS PASS — outbox every 5m, employment and retention daily, health watch hourly; immediate heartbeats established');
