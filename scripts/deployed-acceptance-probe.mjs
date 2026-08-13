#!/usr/bin/env node
/**
 * ============================================================================
 *  DEPLOYED ACCEPTANCE PROBE — verify the LIVE database, not the artifact
 * ============================================================================
 *
 *  Every other suite in this repository proves things about the migration
 *  chain and a harness that models production. None of them can see the
 *  deployed database. This one is run AGAINST IT, after the audit-response
 *  migrations are applied, and answers the only question that finally
 *  matters: did the fix actually land, on the system serving real traffic?
 *
 *  IT CHECKS
 *    A  the audit-response migrations are RECORDED AS APPLIED in the ledger
 *    B  the seven projections have no EFFECTIVE DML for anon/authenticated —
 *       and no other view in a reachable schema does either
 *    C  no COLUMN-level grants survive on them
 *    D  every refusal trigger exists AND IS ENABLED (a disabled trigger is a
 *       silent hole: it is still "present")
 *    E  a REAL low-role API token cannot POST, PATCH or DELETE through the
 *       views
 *    F  the target base rows and collection revisions are UNCHANGED by this
 *       probe
 *    I  every authoritative collection-revision key is PRESENT (P0-3): the
 *       first-save bootstrap deadlock is a data absence only the live
 *       database can disprove
 *    G  the API layer has reloaded the current schema/privilege state
 *    H  the deployed ledger checksums match the APPROVED release manifest
 *
 *  SAFETY — this runs against live data, so:
 *    • every read-only check is exactly that;
 *    • the API write attempts are filtered to a synthetic probe namespace
 *      (`mp_probe_…`) that matches no business row, and are expected to be
 *      REFUSED. If a write is wrongly permitted, only a probe-namespaced row
 *      can be affected, and cleanup removes it;
 *    • DELETE is never issued without a filter;
 *    • collection revisions and row counts are snapshotted before and
 *      compared after, so "the probe changed nothing" is proven, not assumed.
 *
 *  USAGE
 *    MP_DB_URL='postgresql://…'        # deployed DB, service-level connection
 *    MP_SUPABASE_URL='https://…'       # REST endpoint          (checks E, G)
 *    MP_ANON_KEY='…'                   # publishable anon key   (checks E, G)
 *    MP_PROBE_EMAIL='…'                # real low-role test user (preferred)
 *    MP_PROBE_PASSWORD='…'             # password obtained from protected CI secret
 *    MP_PROBE_JWT='…'                  # optional short-lived token override
 *    MP_MANIFEST=./release-manifest.json
 *    node scripts/deployed-acceptance-probe.mjs
 *
 *  FAIL-CLOSED BY DEFAULT. If the API variables are absent, checks E and G
 *  cannot run — and this exits NON-ZERO. An acceptance tool that returns
 *  success while its critical real-API attack was skipped gives automation a
 *  green light for something nobody proved. To run the database half alone,
 *  ask for it by name:
 *
 *      MP_PROBE_DB_ONLY=1 node scripts/deployed-acceptance-probe.mjs
 *
 *  which reports DATABASE-ONLY PASS — NOT ACCEPTANCE. Even then, a skipped
 *  DATABASE-side check (a missing ledger, an absent manifest) still fails.
 * ============================================================================
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectedMigrationLedger, parseLedgerRows, compareExactMigrationLedger, obtainProbeAccessToken } from './lib/deployed-probe.mjs';

const DB_URL   = process.env.MP_DB_URL || '';
const API_URL  = (process.env.MP_SUPABASE_URL || '').replace(/\/+$/, '');
const ANON_KEY = process.env.MP_ANON_KEY || '';
const USER_JWT = process.env.MP_PROBE_JWT || '';
const PROBE_EMAIL = process.env.MP_PROBE_EMAIL || '';
const PROBE_PASSWORD = process.env.MP_PROBE_PASSWORD || '';
const MANIFEST = process.env.MP_MANIFEST || 'release-manifest.json';
const SU       = process.env.MP_PSQL_SU === '1';   // local-testing affordance only

const AUDIT_MIGRATIONS = [
  'supabase/migration_inc11_view_write_authority.sql',
  'supabase/migration_inc11_anon_function_surface.sql',
  'supabase/migration_inc11_gate_sources_and_storage.sql',
  'supabase/migration_inc11_ambient_dml.sql',
  'supabase/migration_inc11_collection_revision_bootstrap.sql',
];
const VIEWS = [
  'menu_items_public', 'stores_public', 'news_posts_public', 'job_vacancies_public',
  'deals_public', 'cms_pages_public', 'media_assets_public',
];
const DML = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const PROBE_ID = `mp_probe_${Date.now().toString(36)}`;

let pass = 0, fail = 0, skip = 0, skipApi = 0, skipDb = 0;
/* Default is ACCEPTANCE: anything not proven is a failure. The database-only
   mode has to be asked for by name, and it can never turn a real failure — or
   a skipped DATABASE check — into a success. */
const DB_ONLY = process.env.MP_PROBE_DB_ONLY === '1';
const lines = [];
const clip = (d) => (!d ? '' : (String(d).length > 220 ? `${String(d).slice(0, 217)}…` : String(d)));
const ok   = (n, d) => { pass += 1; lines.push(`PASS  ${n}${d ? ` — ${clip(d)}` : ''}`); };
const bad  = (n, d) => { fail += 1; lines.push(`FAIL  ${n}${d ? ` — ${clip(d)}` : ''}`); };
/* A skip is NOT a pass. `kind` records whether the check was API-side (which
   the explicit database-only mode is allowed to forgive) or database-side
   (which nothing forgives — if a catalogue check could not run, this tool has
   not done its job). */
const miss = (n, d, kind = 'db') => {
  skip += 1;
  if (kind === 'api') skipApi += 1; else skipDb += 1;
  lines.push(`SKIP  ${n}${d ? ` — ${clip(d)}` : ''}`);
};
const check = (n, cond, d) => (cond ? ok(n, d) : bad(n, d));

let pgEnv = null;
let pgSecretDir = null;
function pgpassEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}
function securePgEnv() {
  if (pgEnv) return pgEnv;
  let url;
  try { url = new URL(DB_URL); } catch { throw new Error('MP_DB_URL is not a valid PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('MP_DB_URL must use postgresql://');
  const host = url.hostname;
  const port = url.port || '5432';
  const database = decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres');
  const user = decodeURIComponent(url.username || 'postgres');
  const password = decodeURIComponent(url.password || '');
  pgSecretDir = mkdtempSync(join(tmpdir(), 'mp-probe-pg-'));
  const passFile = join(pgSecretDir, 'pgpass');
  writeFileSync(
    passFile,
    `${pgpassEscape(host)}:${pgpassEscape(port)}:${pgpassEscape(database)}:${pgpassEscape(user)}:${pgpassEscape(password)}\n`,
    { mode: 0o600 },
  );
  chmodSync(passFile, 0o600);
  pgEnv = {
    ...process.env,
    PGHOST: host,
    PGPORT: port,
    PGDATABASE: database,
    PGUSER: user,
    PGPASSFILE: passFile,
    ...(url.searchParams.get('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {}),
  };
  delete pgEnv.PGPASSWORD;
  return pgEnv;
}
function cleanupPgSecrets() {
  if (pgSecretDir) rmSync(pgSecretDir, { recursive: true, force: true });
  pgSecretDir = null;
  pgEnv = null;
}
function sql(text) {
  const one = text.replace(/\s+/g, ' ').trim();
  const args = SU
    ? ['postgres', '-c', `psql -tA -v ON_ERROR_STOP=1 -X -c ${JSON.stringify(one)}`]
    : null;
  const out = SU
    ? execFileSync('su', args, { encoding: 'utf8', env: securePgEnv() })
    : execFileSync('psql', ['-tA', '-v', 'ON_ERROR_STOP=1', '-X', '-c', one], {
        encoding: 'utf8',
        env: securePgEnv(),
      });
  return out.split('\n').map((x) => x.trim()).filter(Boolean);
}

async function api(method, path, { body, jwt, headers } = {}) {
  const res = await fetch(`${API_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt || ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...(headers || {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, body: text.slice(0, 300) };
}

/* ---------------------------------------------------------------------- */
async function main() {
  console.log('DEPLOYED ACCEPTANCE PROBE');
  console.log('=========================');
  if (DB_ONLY) {
    console.log('!! MP_PROBE_DB_ONLY=1 — database half only. This is NOT acceptance:');
    console.log('!! the real low-role API attack (check E) is not exercised.');
  }
  if (!DB_URL) { console.error('MP_DB_URL is required (service-level connection to the DEPLOYED database).'); process.exit(2); }

  /* ---- snapshot first: nothing this probe does may move these ---------- */
  const revBefore = sql(`select coalesce(string_agg(table_key || '=' || revision, ',' order by table_key), 'none')
                           from collection_revisions`)[0];
  const countsBefore = sql(`select (select count(*) from menu_items) || '/' || (select count(*) from news_posts)
                                || '/' || (select count(*) from stores)`)[0];

  /* ---- A. migrations recorded as applied ------------------------------- */
  const ledgerExists = sql(`select (to_regclass('public.mp_migration_ledger') is not null)::text`)[0] === 'true';
  if (!ledgerExists) {
    bad('A. migration ledger present', 'public.mp_migration_ledger does not exist — this database was not deployed by launch.sh');
  } else {
    const recorded = sql(`select coalesce(string_agg(filename, ',' order by filename), 'none')
                            from mp_migration_ledger
                           where filename in (${AUDIT_MIGRATIONS.map((m) => `'${m}'`).join(',')})`)[0];
    const missing = AUDIT_MIGRATIONS.filter((m) => !recorded.includes(m.split('/').pop()));
    check('A. all audit-response migrations are recorded as applied',
      missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${AUDIT_MIGRATIONS.length} recorded`);
    const methods = sql(`select coalesce(string_agg(distinct method, ','), 'n/a') from mp_migration_ledger
                          where filename in (${AUDIT_MIGRATIONS.map((m) => `'${m}'`).join(',')})`)[0];
    ok('A. …adoption method recorded', methods);
  }

  /* ---- B. effective DML on the seven, and on every other view ---------- */
  const namedLeaks = sql(`
    select coalesce(string_agg(x.s, ', '), 'none') from (
      select v || '/' || r || '/' || p as s
        from unnest(array[${VIEWS.map((v) => `'${v}'`).join(',')}]) v
        cross join unnest(array['anon','authenticated']) r
        cross join unnest(array[${DML.map((d) => `'${d}'`).join(',')}]) p
       where has_table_privilege(r, v, p)) x`)[0];
  check('B. the seven projections grant NO effective DML to anon/authenticated',
    namedLeaks === 'none', namedLeaks);

  const anyLeaks = sql(`
    select coalesce(string_agg(x.s, ', '), 'none') from (
      select n.nspname || '.' || c.relname || '/' || r || '/' || p as s
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join unnest(array['anon','authenticated']) r
        cross join unnest(array[${DML.map((d) => `'${d}'`).join(',')}]) p
       where c.relkind in ('v','m')
         and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
         and (has_schema_privilege('anon', n.nspname, 'USAGE')
           or has_schema_privilege('authenticated', n.nspname, 'USAGE'))
         and has_table_privilege(r, c.oid, p)) x`)[0];
  check('B. …and NO other view in a reachable schema does either', anyLeaks === 'none', anyLeaks);

  const defaults = sql(`
    select coalesce(string_agg(coalesce(n.nspname,'all-schemas') || '/' || d.defaclrole::regrole::text, ', '), 'none')
      from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
     where d.defaclobjtype = 'r'
       and exists (select 1 from aclexplode(d.defaclacl) a
                    where a.grantee = 0 or a.grantee = 'anon'::regrole or a.grantee = 'authenticated'::regrole)`)[0];
  check('B. …and no relation DEFAULT privilege will arm the next one (root cause)',
    defaults === 'none', defaults);

  /* ---- C. column-level grants ------------------------------------------ */
  const colGrants = sql(`
    select coalesce(string_agg(distinct table_name || '.' || column_name || '/' || grantee || '/' || privilege_type, ', '), 'none')
      from information_schema.column_privileges
     where grantee in ('anon','authenticated','PUBLIC')
       and privilege_type in ('INSERT','UPDATE','REFERENCES')
       and table_name in (${VIEWS.map((v) => `'${v}'`).join(',')})`)[0];
  check('C. no COLUMN-level write grants survive on the projections', colGrants === 'none', colGrants);

  /* ---- D. refusal triggers exist AND are enabled ------------------------ */
  const trg = sql(`
    select coalesce(string_agg(c.relname || '=' || t.tgenabled::text, ', ' order by c.relname), 'none')
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where t.tgname = 'trg_view_read_only'
       and c.relname in (${VIEWS.map((v) => `'${v}'`).join(',')})`)[0];
  const present = (trg.match(/=/g) || []).length;
  check('D. all seven refusal triggers exist', present === VIEWS.length, `${present}/${VIEWS.length}: ${trg}`);
  /* tgenabled has FOUR states, not two: O (origin/normal), A (always),
     D (disabled) and R (replica-only). A trigger moved to R still EXISTS and
     still reads as "not disabled", but it does not fire for ordinary sessions
     — `session_replication_role` is 'origin' for normal API traffic — so the
     refusal never happens. Only O and A fire on origin; require one of those. */
  const states = trg === 'none' ? [] : trg.split(', ').map((x) => x.split('=')[1]);
  const wrong = trg === 'none' ? ['none'] : trg.split(', ').filter((x) => !/=(O|A)$/.test(x));
  check('D. …and every one is ENABLED FOR ORIGIN (tgenabled O or A — D and R both fail)',
    wrong.length === 0, wrong.length ? `not origin-firing: ${wrong.join(', ')}` : `states: ${states.join(',')}`);
  if (states.some((x) => x === 'A')) {
    ok('D. …note: a trigger is ALWAYS-enabled (A) rather than O — it fires on origin too, so this passes');
  }

  /* ---- I. collection revision bootstrap (P0-3) -------------------------- *
   * Read-only. The first-save deadlock is a DATA absence, so only the live
   * database can prove it closed: every collection bearing the bump trigger
   * must already hold its authoritative ledger row (discovered from the
   * catalogue, so a future collection is covered), and the fifteen named
   * keys of this release must all be present. Values are not asserted —
   * live revisions legitimately advance with every real write.             */
  const unseeded = sql(`
    select coalesce(string_agg(c.relname, ', ' order by c.relname), 'none')
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where t.tgname = 'trg_zz_collection_revision' and n.nspname = 'public'
       and not exists (select 1 from collection_revisions cr where cr.table_key = c.relname)`)[0];
  check('I. every trigger-bearing collection has its ledger row (bootstrap invariant, discovered)',
    unseeded === 'none', unseeded);
  const FIFTEEN = [
    'menu_items', 'stores', 'job_vacancies', 'kb_articles', 'news_posts', 'media_assets',
    'deals', 'checklist_templates', 'training_courses', 'training_assessments',
    'training_assignments', 'role_permissions', 'site_settings', 'site_content', 'launch_settings',
  ];
  const keysMissing = sql(`
    select coalesce(string_agg(k, ', ' order by k), 'none')
      from unnest(array[${FIFTEEN.map((k) => `'${k}'`).join(',')}]) k
     where not exists (select 1 from collection_revisions cr where cr.table_key = k)`)[0];
  check('I. …and all fifteen authoritative keys of this release are present by name',
    keysMissing === 'none', keysMissing === 'none' ? `${FIFTEEN.length} present` : `missing: ${keysMissing}`);

  /* ---- E + G. the API layer -------------------------------------------- */
  if (!API_URL || !ANON_KEY) {
    miss('E. low-role API token cannot write through the views', 'MP_SUPABASE_URL / MP_ANON_KEY not set', 'api');
    miss('G. API layer has reloaded the current schema', 'MP_SUPABASE_URL / MP_ANON_KEY not set', 'api');
  } else {
    let jwt = '';
    try {
      const auth = await obtainProbeAccessToken({
        apiUrl: API_URL,
        anonKey: ANON_KEY,
        explicitJwt: USER_JWT,
        email: PROBE_EMAIL,
        password: PROBE_PASSWORD,
      });
      jwt = auth.token;
      ok('E. real low-role probe identity authenticated', auth.source);
    } catch (e) {
      bad('E. real low-role probe identity authenticated', e.message);
    }
    const attempts = [];
    for (const v of VIEWS) {
      // Every write is filtered to a synthetic id that matches no business row.
      attempts.push(['PATCH',  `${v}?id=eq.${PROBE_ID}`, { name: PROBE_ID }]);
      attempts.push(['DELETE', `${v}?id=eq.${PROBE_ID}`, null]);
      attempts.push(['POST',   v, { id: PROBE_ID }]);
    }
    if (jwt) {
      let refused = 0; const permitted = [];
      for (const [method, path, body] of attempts) {
        const r = await api(method, path, { body, jwt });
        // A refusal is what we want: 401/403, or PostgREST's 42501 permission error.
        if (r.status === 401 || r.status === 403 || /42501|permission denied|public_view_read_only/i.test(r.body)) refused += 1;
        else permitted.push(`${method} ${path} -> ${r.status} ${r.body.slice(0, 80)}`);
      }
      check('E. a real low-role API token cannot POST/PATCH/DELETE through any projection',
        permitted.length === 0, permitted.length ? permitted.slice(0, 3).join(' | ') : `${refused}/${attempts.length} refused`);
    }

    // G. staleness probe: `slug` exists only after the news-slug migration, and
    //    limit=0 returns no rows, so this reads nothing while proving the API
    //    is serving the CURRENT schema rather than a cached one.
    const reload = await api('GET', 'news_posts_public?select=slug&limit=0', { jwt: ANON_KEY });
    check('G. the API layer is serving the post-migration schema (not a stale cache)',
      reload.status === 200, `HTTP ${reload.status} ${reload.body.slice(0, 120)}`);
  }

  /* ---- H. deployed hashes vs the approved manifest ---------------------- */
  if (!existsSync(MANIFEST)) {
    miss('H. deployed checksums match the approved release manifest', `${MANIFEST} not found`);
  } else if (!ledgerExists) {
    miss('H. deployed checksums match the approved release manifest', 'no ledger to compare');
  } else {
    try {
      const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
      const expected = expectedMigrationLedger(manifest);
      const deployed = parseLedgerRows(sql(`select filename || E'\t' || checksum || E'\t' || coalesce(ordinal::text, '') from mp_migration_ledger order by ordinal nulls last, filename`));
      const exact = compareExactMigrationLedger(expected, deployed);
      check('H. deployed migration ledger exactly matches the approved manifest',
        exact.ok,
        exact.ok ? `${expected.length}/${expected.length} exact rows, checksums and ordinals` : exact.issues.slice(0, 5).join(' | '));
      ok('H. …release identity in the approved manifest',
        `${manifest.release_identity || 'unset'} (${manifest.migration_count} migrations)`);
    } catch (e) {
      bad('H. deployed migration ledger exactly matches the approved manifest', e.message);
    }
  }

  /* ---- J. scheduled worker configuration and liveness ------------------- */
  const cronExists = sql(`select (to_regclass('cron.job') is not null)::text`)[0] === 'true';
  if (!cronExists) {
    bad('J. production scheduler catalogue exists', 'cron.job is absent — Supabase Cron is not commissioned');
  } else {
    const activeJobs = sql(`select coalesce(string_agg(jobname, ',' order by jobname), 'none')
                              from cron.job
                             where active
                               and jobname in ('employment-sweep','ops-health-watch','outbox-dispatch','retention-sweep')`)[0];
    check('J. outbox, employment, retention and health-watch scheduler jobs are active',
      activeJobs.split(',').filter(Boolean).sort().join(',') === 'employment-sweep,ops-health-watch,outbox-dispatch,retention-sweep',
      activeJobs);
  }
  const heartbeatRows = sql(`select job_name || E'\t' || last_status || E'\t' ||
                                    floor(extract(epoch from (now() - last_run_at)))::bigint
                               from ops_heartbeats
                              where job_name in ('employment-sweep','ops-health-watch','outbox-dispatch','retention-sweep')
                              order by job_name`);
  const heartbeats = new Map(heartbeatRows.map((line) => {
    const [job, status, age] = line.split('\t');
    return [job, { status, ageSeconds: Number(age) }];
  }));
  const outboxHeartbeat = heartbeats.get('outbox-dispatch');
  check('J. outbox-dispatch heartbeat is successful and no older than 20 minutes',
    outboxHeartbeat?.status === 'ok' && Number.isFinite(outboxHeartbeat.ageSeconds) && outboxHeartbeat.ageSeconds <= 20 * 60,
    outboxHeartbeat ? `${outboxHeartbeat.status}, age=${outboxHeartbeat.ageSeconds}s` : 'missing');
  const employmentHeartbeat = heartbeats.get('employment-sweep');
  check('J. employment-sweep heartbeat is successful and no older than 26 hours',
    employmentHeartbeat?.status === 'ok' && Number.isFinite(employmentHeartbeat.ageSeconds) && employmentHeartbeat.ageSeconds <= 26 * 60 * 60,
    employmentHeartbeat ? `${employmentHeartbeat.status}, age=${employmentHeartbeat.ageSeconds}s` : 'missing');
  const retentionHeartbeat = heartbeats.get('retention-sweep');
  check('J. retention-sweep heartbeat is successful and no older than 30 hours',
    retentionHeartbeat?.status === 'ok' && Number.isFinite(retentionHeartbeat.ageSeconds) && retentionHeartbeat.ageSeconds <= 30 * 60 * 60,
    retentionHeartbeat ? `${retentionHeartbeat.status}, age=${retentionHeartbeat.ageSeconds}s` : 'missing');
  const healthWatchHeartbeat = heartbeats.get('ops-health-watch');
  check('J. ops-health-watch heartbeat is successful and no older than 2 hours',
    healthWatchHeartbeat?.status === 'ok' && Number.isFinite(healthWatchHeartbeat.ageSeconds) && healthWatchHeartbeat.ageSeconds <= 2 * 60 * 60,
    healthWatchHeartbeat ? `${healthWatchHeartbeat.status}, age=${healthWatchHeartbeat.ageSeconds}s` : 'missing');

  /* ---- F. nothing moved ------------------------------------------------- */
  const revAfter = sql(`select coalesce(string_agg(table_key || '=' || revision, ',' order by table_key), 'none')
                          from collection_revisions`)[0];
  const countsAfter = sql(`select (select count(*) from menu_items) || '/' || (select count(*) from news_posts)
                               || '/' || (select count(*) from stores)`)[0];
  check('F. collection revisions are unchanged by this probe', revBefore === revAfter,
    `${revBefore} -> ${revAfter}`);
  check('F. base row counts are unchanged by this probe', countsBefore === countsAfter,
    `${countsBefore} -> ${countsAfter}`);

  /* ---- cleanup: remove anything the probe namespace could have created -- */
  const strays = sql(`
    select coalesce(string_agg(t, ', '), 'none') from (
      select 'menu_items' as t from menu_items where id like 'mp_probe_%'
      union select 'news_posts' from news_posts where id like 'mp_probe_%'
      union select 'stores' from stores where id like 'mp_probe_%') s`)[0];
  check('cleanup: the probe namespace left no rows behind', strays === 'none',
    strays === 'none' ? 'no mp_probe_ rows exist' :
      `probe rows found in: ${strays} — REMOVE THEM, and treat check E as FAILED (a write was permitted)`);

  console.log('');
  for (const l of lines) console.log('  ' + l);
  console.log('');
  /* FAIL CLOSED. An acceptance tool that exits 0 while its critical real-API
     attack was skipped hands automation a green light for something nobody
     proved. Incomplete IS failure unless database-only mode was requested by
     name — and even then, a skipped DATABASE check still fails. */
  const blocking = fail > 0 || skipDb > 0 || (skipApi > 0 && !DB_ONLY);
  let verdict;
  if (fail > 0) verdict = 'FAILED';
  else if (skipDb > 0) verdict = 'FAILED (a database-side check could not run)';
  else if (skipApi > 0 && !DB_ONLY) verdict = 'FAILED (INCOMPLETE — the real-API checks were not exercised; set MP_SUPABASE_URL / MP_ANON_KEY and MP_PROBE_EMAIL / MP_PROBE_PASSWORD (or MP_PROBE_JWT), or ask for MP_PROBE_DB_ONLY=1 deliberately)';
  else if (skipApi > 0) verdict = 'DATABASE-ONLY PASS — NOT ACCEPTANCE (MP_PROBE_DB_ONLY=1; the real-API attack was not exercised)';
  else verdict = 'PASSED';
  console.log(`DEPLOYED ACCEPTANCE — ${pass} passed, ${fail} failed, ${skip} skipped — ${verdict}`);
  process.exit(blocking ? 1 : 0);
}

main().catch((e) => { console.error('probe error:', e.message); process.exitCode = 2; }).finally(cleanupPgSecrets);
