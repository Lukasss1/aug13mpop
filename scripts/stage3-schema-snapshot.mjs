/* ============================================================================
 * stage3-schema-snapshot.mjs — canonical live-catalog snapshot.
 *
 * Introspects a running PostgreSQL database (the applied EFFECTIVE state)
 * into deterministic, sorted JSON. Dependency-free: every section is one
 * psql json_agg query. The output is the Workstream-1 inventory AND the
 * Workstream-14 equivalence input: snapshot(chain-db) vs snapshot(baseline-db)
 * must canonically match, so every section here avoids environment noise
 * (OIDs, timestamps, physical storage details) by construction.
 *
 * Usage: PGHOST=… PGPORT=… PGDB=… [PGBINDIR=…] node stage3-schema-snapshot.mjs out.json
 * ==========================================================================*/
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) { console.error('usage: stage3-schema-snapshot.mjs <out.json>'); process.exit(2); }
const psqlBin = `${process.env.PGBINDIR || '/usr/lib/postgresql/16/bin'}/psql`;
const args = ['-v', 'ON_ERROR_STOP=1', '-X', '-q', '-tA',
  '-h', process.env.PGHOST || '127.0.0.1', '-p', process.env.PGPORT || '5432',
  '-U', process.env.PGUSER || 'postgres', '-d', process.env.PGDB || 'postgres'];

function q(sql) {
  const raw = execFileSync(psqlBin, [...args, '-c', sql], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
  return raw === '' ? [] : JSON.parse(raw);
}
const agg = (inner) => `select coalesce(json_agg(t), '[]'::json) from (${inner}) t`;

const snap = {};

/* -- tables + RLS flags ---------------------------------------------------- */
snap.tables = q(agg(`
  select n.nspname as schema, c.relname as name,
         c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'r' and n.nspname in ('public', 'storage')
  order by 1, 2`));

/* -- columns ---------------------------------------------------------------- */
snap.columns = q(agg(`
  select table_schema as schema, table_name as "table", column_name as name,
         data_type, coalesce(character_maximum_length, -1) as char_len,
         coalesce(numeric_precision, -1) as num_precision,
         coalesce(numeric_scale, -1) as num_scale,
         is_nullable = 'YES' as nullable, column_default as "default",
         udt_name
  from information_schema.columns
  where table_schema in ('public', 'storage')
    and table_name in (select c.relname from pg_class c
                       join pg_namespace n on n.oid = c.relnamespace
                       where c.relkind = 'r' and n.nspname = table_schema)
  order by table_schema, table_name, column_name`));

/* -- constraints (pk / fk / unique / check), canonical definitions ---------- */
snap.constraints = q(agg(`
  select n.nspname as schema, rel.relname as "table", con.conname as name,
         con.contype as type, pg_get_constraintdef(con.oid) as definition,
         case when con.contype = 'f' then confdel.confdeltype_text else null end as fk_on_delete
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
  left join lateral (select case con.confdeltype
      when 'a' then 'NO ACTION' when 'r' then 'RESTRICT' when 'c' then 'CASCADE'
      when 'n' then 'SET NULL' when 'd' then 'SET DEFAULT' end as confdeltype_text) confdel on true
  where n.nspname in ('public', 'storage')
  order by 1, 2, 3`));

/* -- indexes ---------------------------------------------------------------- */
snap.indexes = q(agg(`
  select schemaname as schema, tablename as "table", indexname as name, indexdef as definition
  from pg_indexes where schemaname in ('public', 'storage')
  order by 1, 2, 3`));

/* -- policies ---------------------------------------------------------------- */
snap.policies = q(agg(`
  select schemaname as schema, tablename as "table", policyname as name,
         cmd, permissive, array_to_string(roles, ',') as roles,
         coalesce(qual, '') as qual, coalesce(with_check, '') as with_check
  from pg_policies where schemaname in ('public', 'storage')
  order by 1, 2, 3`));

/* -- table-level grants for the API roles ----------------------------------- */
snap.table_grants = q(agg(`
  select table_schema as schema, table_name as "table", grantee, privilege_type
  from information_schema.role_table_grants
  where grantee in ('anon', 'authenticated', 'service_role')
    and table_schema in ('public', 'storage')
  order by 1, 2, 3, 4`));

/* -- COLUMN-level grants (the Stage-2.1.2 surface) --------------------------- */
snap.column_grants = q(agg(`
  select table_schema as schema, table_name as "table", column_name as "column",
         grantee, privilege_type
  from information_schema.column_privileges
  where grantee in ('anon', 'authenticated', 'service_role')
    and table_schema in ('public', 'storage')
  order by 1, 2, 3, 4, 5`));

/* -- functions: signature, security mode, volatility, config, body hash ----- */
snap.functions = q(agg(`
  select n.nspname as schema, p.proname as name,
         pg_get_function_identity_arguments(p.oid) as args,
         p.prosecdef as security_definer,
         p.provolatile as volatility,
         coalesce(array_to_string(p.proconfig, ';'), '') as config,
         l.lanname as language,
         md5(pg_get_functiondef(p.oid)) as def_md5
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public' and p.prokind in ('f')
  order by 1, 2, 3`));

/* -- function EXECUTE grants ------------------------------------------------- */
snap.function_grants = q(agg(`
  select distinct routine_schema as schema, routine_name as name,
         grantee, privilege_type
  from information_schema.routine_privileges
  where grantee in ('anon', 'authenticated', 'service_role')
    and routine_schema = 'public'
  order by 1, 2, 3, 4`));

/* -- triggers ----------------------------------------------------------------- */
snap.triggers = q(agg(`
  select n.nspname as schema, rel.relname as "table", t.tgname as name,
         p.proname as function, t.tgenabled as enabled,
         pg_get_triggerdef(t.oid) as definition
  from pg_trigger t
  join pg_class rel on rel.oid = t.tgrelid
  join pg_namespace n on n.oid = rel.relnamespace
  join pg_proc p on p.oid = t.tgfoid
  where not t.tgisinternal and n.nspname in ('public', 'storage')
  order by 1, 2, 3`));

/* -- views + matviews (definition hash + invoker option) --------------------- */
snap.views = q(agg(`
  select n.nspname as schema, c.relname as name,
         c.relkind = 'm' as materialized,
         coalesce(array_to_string(c.reloptions, ';'), '') as options,
         md5(pg_get_viewdef(c.oid)) as def_md5
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('v', 'm') and n.nspname = 'public'
  order by 1, 2`));

/* -- enums -------------------------------------------------------------------- */
snap.enums = q(agg(`
  select t.typname as name,
         array_to_string(array_agg(e.enumlabel order by e.enumsortorder), ',') as labels
  from pg_type t join pg_enum e on e.enumtypid = t.oid
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public'
  group by t.typname order by 1`));

/* -- sequences ----------------------------------------------------------------- */
snap.sequences = q(agg(`
  select sequence_schema as schema, sequence_name as name, data_type
  from information_schema.sequences where sequence_schema = 'public'
  order by 1, 2`));

/* -- installed extensions (name/version/schema) -------------------------- */
snap.extensions = q(agg(`
  select e.extname as name, e.extversion as version, n.nspname as schema
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname <> 'plpgsql'
  order by 1`));

/* -- user-defined casts (pg_dump does NOT emit these — the WS2 bridge lives
 *    or dies by this section; the restore test proved it) ------------------ */
snap.casts = q(agg(`
  select s.typname as source, t.typname as target,
         c.castcontext as context, c.castmethod as method
  from pg_cast c
  join pg_type s on s.oid = c.castsource
  join pg_type t on t.oid = c.casttarget
  where c.oid > 16384
  order by 1, 2`));

/* -- storage: bucket reference rows (system reference data, not business) ----- */
snap.storage_buckets = q(agg(`
  select id, name, public from storage.buckets order by id`));

/* -- collection revision bootstrap keys (P0-3): the authoritative KEY SET is
 *    system reference data the SERVER must install before any client hydrates
 *    it. The key set — and ONLY the key set — is compared: revision VALUES
 *    count writes and legitimately differ between install paths with
 *    different content histories (the r48 upgrade-vs-fresh comparison proved
 *    exactly that). Any path missing a key fails equivalence — the bootstrap
 *    deadlock cannot silently return. Value determinism, where it holds, is
 *    pinned by scripts/inc11-revision-guard.test.mjs \u00a71 instead. ---------- */
try {
  snap.collection_revisions = q(agg(`
    select table_key from public.collection_revisions order by table_key`));
} catch { snap.collection_revisions = []; }

/* -- migration ledger (dev-chain provenance; excluded from WS14 comparison) --- */
try {
  snap.migration_ledger = q(agg(`
    select ordinal, filename, checksum from public.mp_migration_ledger order by ordinal`));
} catch { snap.migration_ledger = []; }

const counts = Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, v.length]));
writeFileSync(out, JSON.stringify({ generated_for: 'MilkPop Stage 3 WS1', sections: snap }, null, 1));
console.log('snapshot sections:', JSON.stringify(counts));
