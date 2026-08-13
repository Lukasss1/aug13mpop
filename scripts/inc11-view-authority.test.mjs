#!/usr/bin/env node
/**
 * ============================================================================
 *  EXTERNAL AUDIT FINDING — PUBLIC-VIEW WRITE-AUTHORITY BYPASS
 *  Standing proof that the finding is closed, from every angle it can be
 *  attacked. This file exists to be handed to the auditor.
 * ============================================================================
 *
 *  THE FINDING, VERBATIM
 *    "authenticated users receive INSERT, UPDATE and DELETE on seven simple
 *     public projection views, potentially bypassing the intended base-table
 *     RLS and owner/manager write boundaries."
 *
 *  IT WAS NOT "POTENTIAL". The views are auto-updatable, owned by the table
 *  owner, and their base tables are not FORCE RLS — so PostgreSQL checked the
 *  underlying write as the VIEW OWNER, who is exempt from row-level security.
 *  §4 below rebuilds a database at the migration BEFORE the fix and proves the
 *  bypass really lands there: without that positive control this suite could
 *  pass while testing nothing.
 *
 *  WHAT IS PROVEN HERE
 *    §1  Privilege catalogue — DISCOVERED, not a list. Every view and
 *        materialised view in every schema a browser role can reach is found
 *        dynamically, and each is asked the EFFECTIVE privilege question for
 *        INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER — so a
 *        grant inherited through PUBLIC or role membership is caught, which a
 *        scan of direct ACL rows would miss. Column-level grants are checked
 *        separately because they survive a table-level REVOKE. An eighth
 *        public view added next year is covered without editing this file.
 *    §2  Behaviour — all seven views × {INSERT, UPDATE, DELETE} × four caller
 *        identities, including the roles the finding names: a store manager
 *        and a team member with real staff rows, not just an anonymous
 *        stranger. 84 refusals.
 *    §3  Defence in depth — the privileges are RE-GRANTED, simulating a future
 *        migration or a dashboard mistake, and the writes are attempted again.
 *        The INSTEAD OF trigger must refuse them. This proves the second layer
 *        WORKS rather than merely EXISTS.
 *    §4  Historical upgrade — the chain is built EXACTLY through the
 *        migration before the fix (the manifest is truncated positionally, so
 *        nothing later is applied out of order), the pre-fix state is PROVEN
 *        rather than assumed, the bypass is reproduced, and then chains 84,
 *        85, 86 and 87 are applied IN MANIFEST ORDER — the upgrade a deployed
 *        estate will actually perform. Afterwards the exploit is closed, the
 *        default privileges no longer arm browser roles, and a relation
 *        created on that upgraded database receives nothing. A fresh install
 *        proving clean says nothing about the databases already out there.
 *    §5  Production install path — a database built from the canonical
 *        baseline snapshot (what a fresh production install actually applies,
 *        not the development chain) is closed too.
 *    §6  The reads the views exist for are untouched.
 *
 *  ROOT CAUSE, not just symptom: §1 also proves the default-privilege table
 *  itself no longer arms browser roles on newly created relations — for any
 *  grantor and any schema, since default privileges are creator-specific — and
 *  proves it behaviourally by creating a relation and asking what the browser
 *  actually receives. The refusing trigger is defence in depth; it is not the
 *  mechanism compensating for an unsafe default.
 *
 *  Run:  npm run test:inc11-view-authority
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB      = process.env.MP_VA_DB      || 'mp_view_authority';
const DB_PRE  = process.env.MP_VA_PRE_DB  || 'mp_view_authority_pre';
const DB_BASE = process.env.MP_VA_BASE_DB || 'mp_view_authority_base';
const SHIM = path.join(ROOT, 'scripts/lib/supabase-local-privileges.sql');

/** The seven views the finding names. */
const VIEWS = [
  'menu_items_public', 'stores_public', 'news_posts_public', 'job_vacancies_public',
  'deals_public', 'cms_pages_public', 'media_assets_public',
];
/** The migrations that close the finding — applied on top of the pre-fix DB in §4. */
/* The COMPLETE audit-response set, in manifest order. Chain 87 (ambient_dml)
   belongs here: leaving it out once meant the "pre-fix" database was built
   with the root-cause correction ALREADY APPLIED and chains 84-86 absent — a
   state that never existed in history. The immediate-view proof survived that
   mistake (changing default privileges does not alter the grants on views
   that already exist), but the claim "a database at the migration before the
   fix" was false, and the 84->87 upgrade path was never exercised in order. */
const FIX_FILES = [
  'supabase/migration_inc11_view_write_authority.sql',
  'supabase/migration_inc11_anon_function_surface.sql',
  'supabase/migration_inc11_gate_sources_and_storage.sql',
  'supabase/migration_inc11_ambient_dml.sql',
  'supabase/migration_inc11_column_grants.sql',
];

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed += 1; console.log(`  \u2714 ${label}`); }
  else { failed += 1; failures.push(label); console.log(`  \u2716 ${label}${detail ? ` \u2014 ${detail}` : ''}`); }
};

const psqlOn = (db, sql) => execFileSync('su', ['postgres', '-c',
  `psql -tA -v ON_ERROR_STOP=1 -d ${db} -c ${JSON.stringify(sql.replace(/\s+/g, ' ').trim())}`], { encoding: 'utf8' });
const rowsOn = (db, sql) => psqlOn(db, sql).split('\n').map((x) => x.trim()).filter(Boolean);
const fileOn = (db, file) => execFileSync('su', ['postgres', '-c',
  `psql -q -X -v ON_ERROR_STOP=1 -d ${db} -f ${JSON.stringify(file)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/* Identities. The finding is about "authenticated users" — so the callers
   below deliberately include real staff, not only an anonymous stranger. */
const IDS = {
  stranger: { sub: '00000000-0000-4000-8000-00000000fa01', aal: 'aal1', label: 'signed-in, no staff row' },
  member:   { sub: '00000000-0000-4000-8000-00000000fa02', aal: 'aal2', label: 'team member (aal2)' },
  manager:  { sub: '00000000-0000-4000-8000-00000000fa03', aal: 'aal2', label: 'store manager (aal2)' },
};
function runAs(db, who, sql) {
  const claims = who === 'anon' ? null
    : JSON.stringify({ sub: IDS[who].sub, email: `${who}@milkpop.uk`, role: 'authenticated', aal: IDS[who].aal });
  const preamble = who === 'anon'
    ? 'set role anon;'
    : `select set_config('request.jwt.claims', '${claims}', false); set role authenticated;`;
  try {
    execFileSync('su', ['postgres', '-c',
      `psql -tA -v ON_ERROR_STOP=1 -d ${db} -c ${JSON.stringify(`${preamble} ${sql}`.replace(/\s+/g, ' ').trim())}`],
      { encoding: 'utf8' });
    return { ok: true };
  } catch (e) { return { ok: false, err: String(e.stderr || e.message) }; }
}

/* Privilege-isolating probes: `where false` / `limit 0` touch no rows, so a
   refusal can only come from the PRIVILEGE, never from a constraint. */
const probes = (v) => ([
  ['INSERT', `insert into ${v} (id) select id from ${v} limit 0;`],
  ['UPDATE', `update ${v} set id = id where false;`],
  ['DELETE', `delete from ${v} where false;`],
]);

function buildChain(db, { upToBefore } = {}) {
  let files = execFileSync('bash', [path.join(ROOT, 'launch/migration-manifest.sh'), 'all'], { encoding: 'utf8' })
    .split('\n').map((x) => x.trim()).filter(Boolean);
  /* Truncate the manifest POSITIONALLY rather than subtracting filenames: the
     pre-fix database must be the chain as it stood at a point in time, with
     nothing from later applied out of order. */
  if (upToBefore) {
    const idx = files.findIndex((f) => f.endsWith(upToBefore));
    if (idx < 0) throw new Error(`buildChain: ${upToBefore} is not in the manifest`);
    files = files.slice(0, idx);
  }
  execFileSync('su', ['postgres', '-c', `psql -q -X -c "drop database if exists ${db}" -c "create database ${db}"`],
    { encoding: 'utf8' });
  fileOn(db, SHIM);
  for (const rel of files) fileOn(db, path.join(ROOT, rel));
  return files.length;
}

function seedFixtures(db) {
  psqlOn(db, `insert into stores (id, name, address, postcode, opening_hours, status)
              values ('st_va', 'Authority Store', '9 Test Way', 'B9 9AA', 'Mon-Sun 9-5', 'coming_soon')
              on conflict (id) do nothing`);
  psqlOn(db, `insert into staff_profiles (id, name, email, role, store_id, auth_id, status) values
              ('sp_va_mem', 'Tam Member',  'fa02@milkpop.uk', 'team_member',   'st_va', '${IDS.member.sub}',  'active'),
              ('sp_va_mgr', 'Morgan Mgr',  'fa03@milkpop.uk', 'store_manager', 'st_va', '${IDS.manager.sub}', 'active')
              on conflict (id) do nothing`);
  // One published row behind each projection, so §3's trigger probes have
  // something to fire on and §6's reads have something to return.
  // No tax_code: the canonical baseline snapshot deliberately carries schema
  // and no business data, so the tax_codes reference table is empty there.
  // This suite is about VIEW WRITE AUTHORITY — the row only needs to exist.
  // available = true MATTERS: menu_items_public filters on it, and a fixture
  // row outside the projection would make every probe below vacuous — the
  // first run of this suite failed exactly that way.
  // A COMPLETE, publishable row. Two reasons, both learned the hard way on the
  // first runs: available=true because menu_items_public filters on it (a row
  // outside the projection makes every probe vacuous), and a real image
  // because the publication validator refuses an available product without
  // one. A view write bypasses RLS but still fires base-table TRIGGERS, so an
  // incomplete fixture gets refused by the wrong guard and the positive
  // control in §4 proves nothing.
  psqlOn(db, `insert into menu_items (id, name, category, price, image, available)
              values ('mi_va', 'Authority Shake', 'milkshakes', 4,
                      'https://images.example.invalid/authority-shake.png', true)
              on conflict (id) do nothing`);
  psqlOn(db, `update menu_items
                 set available = true,
                     image = 'https://images.example.invalid/authority-shake.png'
               where id = 'mi_va'`);
  psqlOn(db, `insert into news_posts (id, title, content, category, date, status)
              values ('np_va', 'Authority Post', 'x', 'News', '2026-07-31', 'published') on conflict (id) do nothing`);
}

/* ------------------------------------------------------------------------ */
function s1_privileges(db) {
  console.log('\n\u00a71  Privilege catalogue — DISCOVERED, effective, every view');

  /* The seven named in the finding are a snapshot, not the invariant. This
     section therefore hardcodes NOTHING: it discovers every view and
     materialised view in every schema a browser role can actually reach, and
     asks the EFFECTIVE privilege question — has_table_privilege() accounts for
     grants held directly, grants inherited through role membership, and grants
     made to PUBLIC, none of which a scan of direct ACL rows would see.

     "API-exposed" is itself discovered rather than listed: a schema counts if
     anon or authenticated holds USAGE on it, because without USAGE nothing
     inside is reachable whatever the table grants say. Expose a new schema and
     this section extends to it on the next run. */
  const EXPOSED = `n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
      and (has_schema_privilege('anon', n.nspname, 'USAGE')
        or has_schema_privilege('authenticated', n.nspname, 'USAGE'))`;

  const schemas = rowsOn(db, `
    select coalesce(string_agg(distinct n.nspname, ', ' order by n.nspname), 'none')
      from pg_namespace n where ${EXPOSED}`)[0];
  const discovered = rowsOn(db, `
    select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('v', 'm') and ${EXPOSED}`)[0];
  check(`discovery found views to check (${discovered} across: ${schemas})`,
    Number(discovered) > 0 && schemas !== 'none', `${discovered} views in ${schemas}`);
  check('discovery covers at least the seven the finding names',
    Number(discovered) >= VIEWS.length, `${discovered} < ${VIEWS.length}`);

  /* EFFECTIVE privilege: anon / authenticated × the six write privileges. */
  const leaks = rowsOn(db, `
    select coalesce(string_agg(distinct x.s, ', '), 'none') from (
      select n.nspname || '.' || c.relname || ' -> ' || r || '/' || p as s
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join unnest(array['anon', 'authenticated']) r
        cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
       where c.relkind in ('v', 'm') and ${EXPOSED}
         and has_table_privilege(r, c.oid, p)
    ) x`)[0];
  check('NO view in a browser-reachable schema grants any of the six write privileges (effective, not just direct ACL rows)',
    leaks === 'none', leaks);

  /* PUBLIC named explicitly. The effective check above already covers it —
     every role is a member of PUBLIC — but naming it reports the SOURCE, and
     catches a PUBLIC grant that would also arm roles created in future. */
  const publicGrants = rowsOn(db, `
    select coalesce(string_agg(distinct n.nspname || '.' || c.relname || '/' || a.privilege_type, ', '), 'none')
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     where c.relkind in ('v', 'm') and ${EXPOSED}
       and a.grantee = 0
       and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')`)[0];
  check('…and PUBLIC itself holds none of them on any view', publicGrants === 'none', publicGrants);

  /* Column-level grants are a separate ACL and survive a table-level REVOKE. */
  const colGrants = rowsOn(db, `
    select coalesce(string_agg(distinct table_schema || '.' || table_name || '.' || column_name
                               || '/' || grantee || '/' || privilege_type, ', '), 'none')
      from information_schema.column_privileges
     where grantee in ('anon', 'authenticated', 'PUBLIC')
       and privilege_type in ('INSERT', 'UPDATE', 'REFERENCES')
       and (table_schema, table_name) in (
         select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('v', 'm') and ${EXPOSED})`)[0];
  check('no COLUMN-level write grant on any discovered view either', colGrants === 'none', colGrants);

  /* Structural invariant, also discovered: a view in a reachable schema may be
     writable through NO mechanism unless it carries the refusing trigger. */
  const writable = rowsOn(db, `
    select coalesce(string_agg(v.table_schema || '.' || v.table_name, ', '), 'none')
      from information_schema.views v
      join pg_class c on c.relname = v.table_name
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = v.table_schema
     where c.relkind = 'v' and ${EXPOSED}
       and (v.is_updatable = 'YES' or v.is_insertable_into = 'YES'
         or v.is_trigger_updatable = 'YES' or v.is_trigger_insertable_into = 'YES'
         or v.is_trigger_deletable = 'YES')
       and not exists (select 1 from pg_trigger t
                        where t.tgname = 'trg_view_read_only'
                          and t.tgenabled in ('O', 'A')
                          and t.tgrelid = c.oid)`)[0];
  check('every writable view carries an ORIGIN-FIRING read-only trigger; the rest are structurally unwritable',
    writable === 'none', writable);
  /* tgenabled has FOUR states: O (origin), A (always), D (disabled),
     R (replica-only). An R trigger still EXISTS and still reads as "not
     disabled", but ordinary sessions run session_replication_role='origin',
     so it never fires — the refusal silently stops happening. */
  const notOrigin = rowsOn(db, `
    select coalesce(string_agg(c.relname || '=' || t.tgenabled::text, ', '), 'none')
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where t.tgname = 'trg_view_read_only' and t.tgenabled not in ('O', 'A')`)[0];
  check('…and NO refusal trigger is disabled (D) or replica-only (R)', notOrigin === 'none', notOrigin);

  /* SELF-TEST: the catalogue must catch the case this section exists for —
     a view added LATER that silently inherits the default privileges. A gate
     that cannot fail proves nothing, so one is created here exactly as a
     future migration would create it, the catalogue is re-asked, and it is
     dropped again. */
  {
    const leakQuery = `
      select coalesce(string_agg(distinct x.s, ', '), 'none') from (
        select n.nspname || '.' || c.relname || ' -> ' || r || '/' || p as s
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          cross join unnest(array['anon', 'authenticated']) r
          cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
         where c.relkind in ('v', 'm') and ${EXPOSED}
           and has_table_privilege(r, c.oid, p)
      ) x`;
    psqlOn(db, `create view mp_future_view as select id from menu_items`);
    /* First: the eighth view arrives CLEAN, because the ambient default that
       used to arm it has been removed at source (see the ROOT CAUSE checks
       below). This assertion is the reason the next one has to grant
       explicitly — inheriting the privilege is no longer possible. */
    check('SELF-TEST: an EIGHTH view added later arrives with NO inherited privilege',
      rowsOn(db, leakQuery)[0] === 'none', rowsOn(db, leakQuery)[0]);
    /* Then: hand it the privilege the way it could still happen — a migration
       that grants deliberately, or a console click — and prove the catalogue
       catches that. A gate that cannot fail proves nothing. */
    psqlOn(db, `grant insert, update on mp_future_view to authenticated`);
    const caught = rowsOn(db, leakQuery)[0];
    check('SELF-TEST: …and if something GRANTS it DML anyway, the catalogue catches that',
      caught !== 'none' && caught.includes('mp_future_view'), `catalogue said: ${caught}`);
    const untriggered = rowsOn(db, `
      select coalesce(string_agg(v.table_name, ', '), 'none')
        from information_schema.views v
        join pg_class c on c.relname = v.table_name
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = v.table_schema
       where c.relkind = 'v' and ${EXPOSED}
         and (v.is_updatable = 'YES' or v.is_insertable_into = 'YES')
         and not exists (select 1 from pg_trigger t
                          where t.tgname = 'trg_view_read_only'
                            and t.tgenabled in ('O', 'A') and t.tgrelid = c.oid)`)[0];
    check('SELF-TEST: …and is also flagged as writable without the read-only trigger',
      untriggered.includes('mp_future_view'), untriggered);
    psqlOn(db, `drop view mp_future_view`);
    check('SELF-TEST: with it dropped, the catalogue is clean again',
      rowsOn(db, leakQuery)[0] === 'none');
  }

  /* ROOT CAUSE. Everything above proves the CURRENT relations are safe. None
     of it stops the NEXT one from arriving armed, because the grant never came
     from a migration — it came from pg_default_acl, which hands every newly
     created relation a fixed set of privileges. Default privileges are
     CREATOR-SPECIFIC: one row per grantor role, so fixing one owner says
     nothing about relations created by another. These checks are therefore
     grantor-agnostic — they assert that NO default-ACL entry for relations,
     for ANY grantor, in ANY schema (including the schema-independent
     entries), arms a browser role. The refusing trigger stays as defence in
     depth; it is not what makes this safe. */
  {
    const creators = rowsOn(db, `
      select coalesce(string_agg(distinct d.defaclrole::regrole::text, ', '), 'none')
        from pg_default_acl d where d.defaclobjtype = 'r'`)[0];
    const schemaCreators = rowsOn(db, `
      select coalesce(string_agg(distinct r.rolname, ', '), 'none')
        from pg_roles r join pg_namespace n on n.nspname = 'public'
       where pg_has_role(r.oid, n.nspowner, 'USAGE') or r.rolsuper`)[0];
    check(`default-ACL grantors for relations inspected: ${creators} (schema creators: ${schemaCreators})`, true);

    const armed = rowsOn(db, `
      select coalesce(string_agg(coalesce(n.nspname, 'all-schemas') || '/' ||
                                 d.defaclrole::regrole::text || '/' ||
                                 array_to_string(d.defaclacl, ' '), ', '), 'none')
        from pg_default_acl d
        left join pg_namespace n on n.oid = d.defaclnamespace
       where d.defaclobjtype = 'r'
         and exists (select 1 from aclexplode(d.defaclacl) a
                      where a.grantee = 0
                         or a.grantee = 'anon'::regrole
                         or a.grantee = 'authenticated'::regrole)`)[0];
    check('ROOT CAUSE: no relation default-ACL arms anon, authenticated or PUBLIC — for ANY grantor, in ANY schema',
      armed === 'none', armed);

    /* Behaviour beats catalogue: create a relation exactly as a future
       migration would and ask what the browser actually gets. */
    psqlOn(db, `create table mp_ambient_t (id int primary key)`);
    psqlOn(db, `create view mp_ambient_v as select id from mp_ambient_t`);
    const leaked = rowsOn(db, `
      select coalesce(string_agg(x.s, ', '), 'none') from (
        select rel || '/' || r || '/' || p as s
          from unnest(array['mp_ambient_t', 'mp_ambient_v']) rel
          cross join unnest(array['anon', 'authenticated']) r
          cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
         where has_table_privilege(r, rel, p)) x`)[0];
    check('ROOT CAUSE (behavioural): a NEWLY created table and view arrive with NO browser privilege at all',
      leaked === 'none', leaked);
    const svcKept = rowsOn(db, `select has_table_privilege('service_role','mp_ambient_t','INSERT')::text`)[0];
    check('…while the trusted server role keeps the access the platform needs', svcKept === 'true');
    psqlOn(db, `drop view mp_ambient_v`);
    psqlOn(db, `drop table mp_ambient_t`);
  }

  /* The seven keep the SELECT they exist for. */
  const selects = rowsOn(db, `
    select count(*)::text from information_schema.role_table_grants
     where table_schema='public' and grantee='authenticated' and privilege_type='SELECT'
       and table_name in (${VIEWS.map((v) => `'${v}'`).join(',')})`)[0];
  check('…while all seven named projections keep SELECT — they still serve their purpose',
    selects === '7', selects);
}

function s2_behaviour(db) {
  console.log('\n\u00a72  Behaviour — 7 views \u00d7 3 verbs \u00d7 4 callers');
  for (const who of ['anon', 'stranger', 'member', 'manager']) {
    const label = who === 'anon' ? 'anonymous' : IDS[who].label;
    let refused = 0; const landed = [];
    for (const v of VIEWS) {
      for (const [verb, sql] of probes(v)) {
        const r = runAs(db, who, sql);
        if (r.ok) landed.push(`${verb} ${v}`);
        else refused += 1;
      }
    }
    check(`${label}: all 21 write attempts across the seven projections refused`,
      refused === 21, landed.length ? `LANDED: ${landed.slice(0, 3).join('; ')}` : `refused ${refused}/21`);
  }
}

function s3_defence_in_depth(db) {
  console.log('\n\u00a73  Defence in depth — privileges RE-GRANTED, writes must still refuse');
  for (const v of VIEWS) {
    psqlOn(db, `grant insert, update, delete on ${v} to authenticated`);
  }
  const regranted = rowsOn(db, `
    select count(*)::text from information_schema.role_table_grants
     where table_schema='public' and grantee='authenticated' and privilege_type='UPDATE'
       and table_name in (${VIEWS.map((v) => `'${v}'`).join(',')})`)[0];
  check('the mistake is genuinely re-introduced (privileges are back)', regranted === '7', regranted);

  // Unrestricted statements: an INSTEAD OF trigger fires per affected ROW, so
  // these must touch real rows to prove the trigger, not the privilege.
  const cases = [
    ['UPDATE', 'menu_items_public', `update menu_items_public set name = name;`],
    ['DELETE', 'news_posts_public', `delete from news_posts_public;`],
    // news_posts_public holds the seeded published row, so this INSERT
    // actually presents one — stores_public is empty in a fresh database and
    // a zero-row INSERT fires no trigger at all (a vacuous pass).
    ['INSERT', 'news_posts_public', `insert into news_posts_public (id) select id from news_posts_public;`],
  ];
  for (const [verb, v, sql] of cases) {
    const r = runAs(db, 'manager', sql);
    check(`with the privilege restored, ${verb} on ${v} is still refused by the trigger`,
      !r.ok && /public_view_read_only/.test(r.err), r.ok ? 'THE WRITE LANDED' : r.err.split('\n')[0]);
  }
  check('…and the underlying rows are untouched after those attempts',
    rowsOn(db, `select count(*)::text from news_posts where id='np_va'`)[0] === '1'
      && rowsOn(db, `select name from menu_items where id='mi_va'`)[0] === 'Authority Shake');

  for (const v of VIEWS) {
    psqlOn(db, `revoke insert, update, delete on ${v} from authenticated`);
  }
}

function s4_upgrade_path() {
  console.log('\n\u00a74  Historical upgrade — built through chain 83, then 84->87 IN ORDER');

  /* The database must be the chain AS IT STOOD before any audit-response
     migration, with nothing from later applied out of order. Truncating the
     manifest at the first fix file is what makes the word "before" true. */
  const n = buildChain(DB_PRE, { upToBefore: 'migration_inc11_view_write_authority.sql' });
  seedFixtures(DB_PRE);
  check(`a database is built EXACTLY through the migration before the fix (${n} files)`, n > 0);

  /* Prove the starting state is genuinely pre-fix, rather than asserting it.
     Each of the four artefacts below is introduced by one of chains 84-87. */
  const trgPresent = rowsOn(DB_PRE, `
    select count(*)::text from pg_trigger
     where tgname = 'trg_view_read_only' and tgenabled in ('O', 'A')`)[0];
  check('…with NONE of the audit-response migrations applied: no refusal trigger exists yet',
    trgPresent === '0', `${trgPresent} triggers`);
  const dmlPresent = rowsOn(DB_PRE, `
    select has_table_privilege('authenticated', 'menu_items_public', 'UPDATE')::text`)[0];
  check('…the projection still carries the inherited DML the finding describes',
    dmlPresent === 'true');
  const ambient = rowsOn(DB_PRE, `
    select coalesce(string_agg(array_to_string(d.defaclacl, ' '), '; '), 'none')
      from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
     where n.nspname = 'public' and d.defaclobjtype = 'r'`)[0];
  check('…and the ROOT CAUSE is still in place (default privileges arm new relations)',
    /authenticated=arwd/.test(ambient), ambient);
  const anonFn = rowsOn(DB_PRE, `
    select has_function_privilege('anon', 'public.launch_blocking_reasons()', 'EXECUTE')::text`)[0];
  check('…and the anonymous function surface is still open (chain 85 not applied)',
    anonFn === 'true');

  check('the fixture row is genuinely INSIDE the projection (else every probe is vacuous)',
    rowsOn(DB_PRE, `select count(*)::text from menu_items_public where id='mi_va'`)[0] === '1');

  /* The live-project case the auditor raised: a column-level grant added by
     hand at some point in history. Column privileges live in
     pg_attribute.attacl and survive a table-level REVOKE, so the relation
     migration alone would leave it in place. Plant one HERE, on the pre-fix
     database, and require the upgrade to REPAIR it rather than merely report
     it. */
  psqlOn(DB_PRE, `grant update (name), insert (name) on menu_items_public to authenticated`);
  const plantedCols = rowsOn(DB_PRE, `
    select count(*)::text from pg_attribute a join pg_class c on c.oid = a.attrelid
     where c.relname = 'menu_items_public' and a.attacl is not null`)[0];
  check('…and a HISTORICAL column-level grant is planted on it (survives a table-level REVOKE)',
    plantedCols === '1', plantedCols);

  const direct = runAs(DB_PRE, 'stranger', `update menu_items set name = 'BYPASSED' where id='mi_va';`);
  const rowsAfterDirect = rowsOn(DB_PRE, `select name from menu_items where id='mi_va'`)[0];
  check('BEFORE: the direct base-table write is refused by RLS (0 rows changed)',
    direct.ok && rowsAfterDirect === 'Authority Shake', `${direct.err || ''} name=${rowsAfterDirect}`);

  const viaView = runAs(DB_PRE, 'stranger', `update menu_items_public set name = 'BYPASSED' where id='mi_va';`);
  const nameAfter = rowsOn(DB_PRE, `select name from menu_items where id='mi_va'`)[0];
  check('BEFORE: the SAME write through the projection LANDS — the finding, reproduced',
    viaView.ok && nameAfter === 'BYPASSED', `landed=${viaView.ok} name=${nameAfter}`);

  /* Now the upgrade the deployed estate will actually perform: chains 84, 85,
     86 and 87, applied IN MANIFEST ORDER, one after another. */
  for (const f of FIX_FILES) fileOn(DB_PRE, path.join(ROOT, f));
  check(`the four audit-response migrations apply in manifest order (${FIX_FILES.length} files)`, true);
  psqlOn(DB_PRE, `update menu_items set name='Authority Shake' where id='mi_va'`);

  const after = runAs(DB_PRE, 'stranger', `update menu_items_public set name = 'BYPASSED AGAIN' where id='mi_va';`);
  check('AFTER upgrading that same database: the identical write is refused',
    !after.ok && /permission denied/i.test(after.err), after.ok ? 'STILL LANDS' : after.err.split('\n')[0]);
  check('…and the row is intact',
    rowsOn(DB_PRE, `select name from menu_items where id='mi_va'`)[0] === 'Authority Shake');

  /* The root cause, on the UPGRADED database rather than a fresh one: an
     existing estate must also stop arming the next relation it creates. */
  const ambientAfter = rowsOn(DB_PRE, `
    select coalesce(string_agg(coalesce(n.nspname,'all-schemas'), ', '), 'none')
      from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
     where d.defaclobjtype = 'r'
       and exists (select 1 from aclexplode(d.defaclacl) a
                    where a.grantee = 0 or a.grantee = 'anon'::regrole
                       or a.grantee = 'authenticated'::regrole)`)[0];
  check('AFTER: the upgraded database no longer arms browser roles by default',
    ambientAfter === 'none', ambientAfter);

  psqlOn(DB_PRE, `create table mp_upgraded_t (id int primary key)`);
  psqlOn(DB_PRE, `create view mp_upgraded_v as select id from mp_upgraded_t`);
  const leaked = rowsOn(DB_PRE, `
    select coalesce(string_agg(x.s, ', '), 'none') from (
      select rel || '/' || r || '/' || p as s
        from unnest(array['mp_upgraded_t', 'mp_upgraded_v']) rel
        cross join unnest(array['anon', 'authenticated']) r
        cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
       where has_table_privilege(r, rel, p)) x`)[0];
  check('AFTER: a relation created on the UPGRADED database receives no browser privilege',
    leaked === 'none', leaked);
  psqlOn(DB_PRE, `drop view mp_upgraded_v`);
  psqlOn(DB_PRE, `drop table mp_upgraded_t`);

  const anonFnAfter = rowsOn(DB_PRE, `
    select has_function_privilege('anon', 'public.launch_blocking_reasons()', 'EXECUTE')::text`)[0];
  check('AFTER: the anonymous function surface is closed on the upgraded database too',
    anonFnAfter === 'false');

  const colsAfter = rowsOn(DB_PRE, `
    select coalesce(string_agg(c.relname || '.' || a.attname || '/' || x.privilege_type, ', '), 'none')
      from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      cross join lateral aclexplode(a.attacl) x
     where c.relkind in ('v', 'm') and a.attacl is not null
       and x.privilege_type in ('INSERT', 'UPDATE', 'REFERENCES')
       and (x.grantee = 0 or x.grantee = 'anon'::regrole or x.grantee = 'authenticated'::regrole)`)[0];
  check('AFTER: the historical COLUMN-level grant was REPAIRED by the upgrade, not merely reported',
    colsAfter === 'none', colsAfter);
}

function s5_production_install_path() {
  console.log('\n\u00a75  Production install path — the canonical baseline, not the dev chain');
  execFileSync('su', ['postgres', '-c',
    `psql -q -X -c "drop database if exists ${DB_BASE}" -c "create database ${DB_BASE}"`], { encoding: 'utf8' });
  fileOn(DB_BASE, SHIM);
  fileOn(DB_BASE, path.join(ROOT, 'supabase/launch-baseline-v1.sql'));
  seedFixtures(DB_BASE);
  check('a fresh install from launch-baseline-v1.sql builds', true);

  const grants = rowsOn(DB_BASE, `
    select coalesce(string_agg(distinct table_name||'/'||privilege_type, ', '), 'none')
      from information_schema.role_table_grants
     where table_schema='public' and grantee in ('anon','authenticated')
       and privilege_type in ('INSERT','UPDATE','DELETE')
       and table_name in (${VIEWS.map((v) => `'${v}'`).join(',')})`)[0];
  check('the snapshot carries NO view write privileges', grants === 'none', grants);

  const r = runAs(DB_BASE, 'stranger', `update menu_items_public set name = 'BYPASSED' where id='mi_va';`);
  check('a production-shaped install refuses the bypass too',
    !r.ok && /permission denied/i.test(r.err), r.ok ? 'THE WRITE LANDED' : r.err.split('\n')[0]);
}

function s6_reads(db) {
  console.log('\n\u00a76  The reads the projections exist for are untouched');
  const anonRead = runAs(db, 'anon', `select count(*) from menu_items_public;`);
  check('anonymous visitors still read the public menu', anonRead.ok, anonRead.err);
  check('…and the published news projection still returns its row',
    rowsOn(db, `select count(*)::text from news_posts_public where id='np_va'`)[0] === '1');
}

function main() {
  console.log('EXTERNAL AUDIT FINDING — PUBLIC-VIEW WRITE-AUTHORITY BYPASS');
  console.log('===========================================================');
  const n = buildChain(DB);
  seedFixtures(DB);
  console.log(`\n\u00a70  Fresh database from the full chain (${n} files)`);
  s1_privileges(DB);
  s2_behaviour(DB);
  s3_defence_in_depth(DB);
  s4_upgrade_path();
  s5_production_install_path();
  s6_reads(DB);

  console.log('');
  if (failed === 0) console.log(`\u2714 VIEW WRITE-AUTHORITY \u2014 ${passed} passed, 0 failed`);
  else {
    console.log(`\u2716 VIEW WRITE-AUTHORITY \u2014 ${passed} passed, ${failed} FAILED`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  for (const d of [DB, DB_PRE, DB_BASE]) {
    try { execFileSync('su', ['postgres', '-c', `psql -q -X -c "drop database if exists ${d}"`], { encoding: 'utf8' }); } catch { /* keep */ }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
