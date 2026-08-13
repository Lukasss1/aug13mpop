#!/usr/bin/env node
/**
 * ============================================================================
 *  R4.10 INCREMENT 1 — PUBLIC CONTRACT RECONCILIATION
 * ============================================================================
 *
 *  WHY THIS SUITE EXISTS
 *  ---------------------
 *  The deployment audit found that the production build could not complete: the
 *  loader asked stores_public for `updated_at`, the view had no such column,
 *  PostgREST answered 400, and the loader — correctly — failed closed. What
 *  matters is not the missing column but WHY 1,606 passing assertions never saw
 *  it: every test of that code path runs against scripts/fixtures/
 *  seo-content.fixture.json, and the fixture carries whatever columns it was
 *  written with. A fixture cannot disagree with the schema, so it can never
 *  report that the schema moved.
 *
 *  That is a stand-in with no reconciliation, and it was not the only one. This
 *  suite closes the class for the public read path by making the DATABASE the
 *  authority and checking every stand-in against it:
 *
 *    §1  the migration chain applies, and the declared contract matches reality
 *    §2  every column the loader REQUESTS exists on the real relation
 *    §3  no forbidden/administrative column is on a public surface
 *    §4  every field in the SEO FIXTURE exists on the real relation
 *    §5  the anonymous grant surface has not widened (a ratchet, like lint)
 *    §6  END-TO-END: the production loader completes against a PostgREST facade
 *        whose column knowledge is read out of the real database
 *
 *  §6 is the one that would have caught the original defect on the day it landed,
 *  because it is the only check that puts the real schema and the real loader in
 *  the same room.
 *
 *  REQUIREMENTS
 *    PostgreSQL available locally (the harness creates and drops its own database).
 *    Run:  npm run test:r410-contract
 *
 *  NOTE ON SCOPE. §5 is a RATCHET, not a target. The audit measured a wide
 *  ambient anonymous grant surface inherited from Supabase's default privileges;
 *  closing it is R4.10 Increment 3. Until then this suite refuses to let it grow,
 *  and Increment 3 lowers the ceiling to the allow-list.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.MP_CONTRACT_DB || 'mp_r410_contract';
const CONTRACT_PATH = path.join(ROOT, 'scripts/contracts/public-contract.json');
const FIXTURE_PATH = path.join(ROOT, 'scripts/fixtures/seo-content.fixture.json');
const SHIM_PATH = path.join(ROOT, 'scripts/lib/supabase-local-privileges.sql');

let passed = 0;
let failed = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  \u2714 ${label}`);
  } else {
    failed += 1;
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.log(`  \u2716 ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ */
/*  psql helpers — run as the postgres superuser via su, like the      */
/*  other database harnesses in this repo.                             */
/* ------------------------------------------------------------------ */

function psql(sql, { db = DB } = {}) {
  // The statement travels through `su -c`, so it is quoted twice. Collapse it to
  // one line first: JSON.stringify would otherwise emit a literal \n escape that
  // reaches psql as a backslash and fails to parse.
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return execFileSync('su', ['postgres', '-c', `psql -tA -v ON_ERROR_STOP=1 -d ${db} -c ${JSON.stringify(oneLine)}`], {
    encoding: 'utf8',
  });
}

function psqlFile(file, { db = DB } = {}) {
  return execFileSync('su', ['postgres', '-c', `psql -q -X -v ON_ERROR_STOP=1 -d ${db} -f ${JSON.stringify(file)}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function rows(sql, opts) {
  return psql(sql, opts).split('\n').map((s) => s.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/*  Build a fresh database from the AUTHORITATIVE manifest.            */
/* ------------------------------------------------------------------ */

function buildDatabase() {
  section('\u00a70  Fresh database from launch/migration-manifest.sh');

  const files = execFileSync('bash', [path.join(ROOT, 'launch/migration-manifest.sh'), 'all'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);

  execFileSync('su', ['postgres', '-c',
    `psql -q -X -c "drop database if exists ${DB}" -c "create database ${DB}"`], { encoding: 'utf8' });

  psqlFile(SHIM_PATH);

  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) throw new Error(`manifest names a file that does not exist: ${rel}`);
    try {
      psqlFile(abs);
    } catch (e) {
      const out = `${e.stdout || ''}${e.stderr || ''}`.split('\n').filter((l) => /ERROR/.test(l))[0] || e.message;
      check(`chain applies: ${rel}`, false, out);
      throw new Error(`chain failed at ${rel}`);
    }
  }
  check(`chain applies clean (${files.length} files)`, true);
  return files;
}

/* ------------------------------------------------------------------ */
/*  Read the REAL schema.                                              */
/* ------------------------------------------------------------------ */

function realColumns(relation) {
  return rows(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='${relation}' order by ordinal_position`,
  );
}

function relationExists(relation) {
  return rows(
    `select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname='${relation}' and c.relkind in ('r','v','m')`,
  ).length > 0;
}

function anonCanSelect(relation) {
  return rows(
    `select has_table_privilege('anon','public.${relation}'::regclass,'SELECT')`,
  )[0] === 't';
}

/* ------------------------------------------------------------------ */
/*  MAIN                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('R4.10 PUBLIC CONTRACT RECONCILIATION');
  console.log('====================================');

  const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

  // The loader's OWN definitions — imported, never re-typed here.
  const loader = await import(path.join(ROOT, 'scripts/load-public-content.ts'));
  const SELECTS = loader.SELECTS;
  const PUBLIC_RELATIONS = loader.PUBLIC_RELATIONS;

  buildDatabase();

  /* ---------------- §1 contract vs loader ---------------- */
  section('\u00a71  The declared contract and the loader agree about which relations exist');

  const contractLive = contract.relations.filter((r) => r.status === 'live').map((r) => r.relation);
  const contractPlanned = contract.relations.filter((r) => r.status === 'planned').map((r) => r.relation);
  const contractBuilt = contract.relations.filter((r) => r.status === 'built').map((r) => r.relation);
  const loaderRelations = PUBLIC_RELATIONS.map((r) => r.relation);

  check('every relation the loader reads is declared in the contract', 
    loaderRelations.every((r) => contractLive.includes(r)),
    `loader reads [${loaderRelations.filter((r) => !contractLive.includes(r)).join(', ')}] which the contract does not declare live`);

  // Only the relations declared `read_by: seo-loader` belong in the loader's
  // list. The rest are read by the RUNTIME client through SYNC_MAP, which is a
  // different consumer with a different contract — conflating them made this
  // check demand that deals_public be fetched at build time.
  const seoDeclared = contract.relations
    .filter((r) => r.status === 'live' && r.read_by === 'seo-loader').map((r) => r.relation);
  check('every SEO-loader relation is actually read by the loader',
    seoDeclared.every((r) => loaderRelations.includes(r)),
    `declared but unread: [${seoDeclared.filter((r) => !loaderRelations.includes(r)).join(', ')}]`);

  check('SELECTS covers exactly the relations the loader fetches',
    loaderRelations.every((r) => typeof SELECTS[r] === 'string') &&
      Object.keys(SELECTS).every((r) => loaderRelations.includes(r)),
    `SELECTS keys [${Object.keys(SELECTS).join(', ')}] vs fetched [${loaderRelations.join(', ')}]`);

  for (const rel of contractLive) {
    check(`live relation exists in the database: ${rel}`, relationExists(rel));
  }

  // A planned relation must not exist yet. If it does, Increment 5 landed
  // without updating this contract — which is exactly the drift this file exists
  // to prevent.
  for (const rel of contractPlanned) {
    check(`planned relation is not yet present (contract not stale): ${rel}`, !relationExists(rel),
      'the view now exists — promote it to status "built" and declare its forbidden columns');
  }

  // A "built" view exists and is proven, but must NOT be on the anonymous surface
  // yet: the client still reads the base table, so granting the view early would
  // widen the public surface without the hydration parity that makes the later
  // narrowing safe. Both halves are asserted, because either one alone is wrong.
  for (const rel of contractBuilt) {
    check(`built relation exists: ${rel}`, relationExists(rel),
      'declared built but absent — the migration did not land');
    check(`built relation is NOT yet anon-readable: ${rel}`, !anonCanSelect(rel),
      'granted to anon before its client read was repointed — this is the P0-2 shape');
  }

  /* ---------------- §2 requested columns exist ---------------- */
  section('\u00a72  Every column the production loader REQUESTS exists on the real relation');

  for (const rel of loaderRelations) {
    const requested = String(SELECTS[rel] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const actual = realColumns(rel);
    const missing = requested.filter((c) => !actual.includes(c));
    check(`${rel}: all ${requested.length} requested columns present`, missing.length === 0,
      missing.length ? `missing ${missing.join(', ')} — PostgREST would answer 400 (42703) and the production build would fail closed` : '');

    const contractEntry = contract.relations.find((entry) => entry.relation === rel);
    if (contractEntry?.loader_columns_must_match_view === true) {
      const omitted = actual.filter((c) => !requested.includes(c));
      const unexpected = requested.filter((c) => !actual.includes(c));
      check(`${rel}: loader requests the COMPLETE public projection`, omitted.length === 0 && unexpected.length === 0,
        [
          omitted.length ? `omitted from loader: ${omitted.join(', ')}` : '',
          unexpected.length ? `not present on view: ${unexpected.join(', ')}` : '',
        ].filter(Boolean).join('; '));
    }
  }

  /* ---------------- §3 no forbidden column is public ---------------- */
  section('\u00a73  No administrative column is exposed on a public surface');

  for (const entry of contract.relations.filter((r) => r.status === 'live')) {
    const actual = realColumns(entry.relation);
    const leaked = (entry.forbidden_columns || []).filter((c) => actual.includes(c));
    check(`${entry.relation}: no forbidden column present`, leaked.length === 0,
      leaked.length ? `EXPOSED: ${leaked.join(', ')}` : '');
  }

  section('\u00a73b  Base tables that must never be anonymously readable');
  const staleAnonPolicies = [];
  for (const t of contract.base_tables_that_must_never_be_anon_readable) {
    if (!relationExists(t)) { check(`${t}: present to check`, false, 'relation not found'); continue; }
    // "Readable" means a permissive SELECT policy admits anon. A bare table
    // GRANT with no matching policy is denied by RLS default-deny; that residue
    // is tracked by the ratchet in §5 and closed by Increment 3.
    // A row reaches an anonymous caller only when BOTH the table grant and a
    // permissive RLS policy allow it. Checking either alone gives a wrong answer:
    // stores and menu_items still carry a policy naming anon, and are closed only
    // because R4.9 revoked the grant.
    const policyAdmitsAnon = rows(
      `select 1 from pg_policies where schemaname='public' and tablename='${t}'
         and cmd in ('SELECT','ALL') and permissive='PERMISSIVE'
         and ('anon' = any(roles) or 'public' = any(roles))`,
    ).length > 0;
    const granted = anonCanSelect(t);
    const rlsOn = rows(`select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
                         where n.nspname='public' and c.relname='${t}'`)[0] === 't';
    check(`${t}: not anonymously readable`, !(granted && policyAdmitsAnon),
      granted && policyAdmitsAnon ? 'the anon grant AND a permissive policy both allow it' : '');
    check(`${t}: row level security enabled`, rlsOn, rlsOn ? '' : 'RLS is OFF — the grant is the only gate');
    if (policyAdmitsAnon && !granted) staleAnonPolicies.push(t);
  }

  // Single-layer defences, recorded rather than tolerated silently: a table whose
  // policy still names anon is one accidental re-grant away from being public.
  // Increment 3 removes these policies when it installs the explicit allow-list.
  const expectedStale = contract.stale_anon_policies_expected || [];
  check('no NEW single-layer table appeared (policy admits anon, grant revoked)',
    staleAnonPolicies.every((t) => expectedStale.includes(t)),
    `unexpected: ${staleAnonPolicies.filter((t) => !expectedStale.includes(t)).join(', ')}`);
  check('the declared single-layer list is not stale',
    expectedStale.every((t) => staleAnonPolicies.includes(t)),
    `declared but no longer true: ${expectedStale.filter((t) => !staleAnonPolicies.includes(t)).join(', ')} — remove from the contract`);

  /* ---------------- §4 fixture vs real schema ---------------- */
  section('\u00a74  The SEO fixture describes relations that actually look like that');

  const fixtureFieldToRelation = new Map(
    contract.relations.filter((r) => r.status === 'live' && r.fixture_field).map((r) => [r.fixture_field, r.relation]),
  );

  for (const [field, value] of Object.entries(fixture)) {
    if (field.startsWith('__')) continue;
    const rel = fixtureFieldToRelation.get(field);
    check(`fixture field "${field}" maps to a declared relation`, Boolean(rel),
      rel ? '' : 'the fixture carries a key no live contract relation claims');
    if (!rel) continue;
    const actual = realColumns(rel);
    const bogus = new Set();
    for (const row of Array.isArray(value) ? value : []) {
      for (const key of Object.keys(row)) if (!actual.includes(key)) bogus.add(key);
    }
    check(`fixture "${field}" has no field absent from ${rel}`, bogus.size === 0,
      bogus.size ? `${[...bogus].join(', ')} — the mock would answer 200 for columns the real relation does not have` : '');
  }

  /* ---------------- §5 anon grant ratchet ---------------- */
  section('\u00a75  The anonymous grant surface has not widened');

  const granted = rows(
    `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','v','m')
        and has_table_privilege('anon', c.oid, 'SELECT') order by 1`,
  );
  const ceiling = contract.anon_select_grant_ceiling;
  console.log(`     measured: ${granted.length} relations carry an anonymous SELECT grant`);
  check(`anon SELECT grant count <= declared ceiling (${ceiling})`, granted.length <= ceiling,
    `measured ${granted.length} > ceiling ${ceiling} — a relation became anon-granted; add the revoke or raise the ceiling deliberately`);

  for (const t of contract.base_tables_that_must_never_be_anon_readable) {
    if (!relationExists(t)) continue;
    if (['stores', 'menu_items'].includes(t)) {
      check(`${t}: anonymous SELECT grant is revoked`, !anonCanSelect(t));
    }
  }

  /* ---------------- §6 end-to-end production load ---------------- */
  section('\u00a76  The production loader completes against a PostgREST facade built from the real schema');

  const columnsByRelation = Object.fromEntries(loaderRelations.map((r) => [r, realColumns(r)]));
  const seen = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const relation = url.pathname.replace('/rest/v1/', '');
    const asked = (url.searchParams.get('select') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const known = columnsByRelation[relation];
    if (!known) {
      seen.push({ relation, status: 404 });
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 'PGRST205', message: `Could not find the table 'public.${relation}'` }));
    }
    const missing = asked.filter((c) => !known.includes(c));
    if (missing.length) {
      seen.push({ relation, status: 400, missing });
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: '42703', message: `column ${relation}.${missing[0]} does not exist` }));
    }
    seen.push({ relation, status: 200 });
    res.writeHead(200, { 'content-type': 'application/json' });
    // Serve the REAL rows for the REAL requested columns. A facade that always
    // answers [] would be another fixture — and would hide that the loader
    // requires the site_settings / site_content singletons to exist.
    const limit = url.searchParams.get('limit') ? ` limit ${Number(url.searchParams.get('limit')) || 1}` : '';
    const json = psql(
      `select coalesce(json_agg(t), '[]'::json)::text from (select ${asked.join(',')} from ${relation}${limit}) t`,
    ).trim();
    res.end(json || '[]');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const env = {
    ...process.env,
    VITE_SUPABASE_URL: `http://127.0.0.1:${port}`,
    VITE_SUPABASE_ANON_KEY: 'reconciliation-anon-key-not-a-secret',
    VITE_DEPLOYMENT_MODE: 'production',
  };

  let loadError = null;
  let metadata = null;
  try {
    ({ metadata } = await loader.loadPublicContent({ mode: 'production', env }));
  } catch (e) {
    loadError = e;
  }
  server.close();

  const rejected = seen.filter((s) => s.status !== 200);
  check('every relation the loader fetched was answerable from the real schema',
    rejected.length === 0,
    rejected.map((r) => `${r.relation} -> ${r.status}${r.missing ? ` missing ${r.missing.join(',')}` : ''}`).join('; '));

  check('production content load completed (an empty database is not an error)',
    loadError === null, loadError ? String(loadError.message).split('\n')[0] : '');

  check('the completed load is stamped source=supabase, never a seed fallback',
    metadata !== null && metadata.source === 'supabase',
    metadata ? `source=${metadata.source}` : 'no metadata (load failed)');

  if (metadata) {
    console.log(`     counts on a freshly installed database: ${JSON.stringify(metadata.counts)}`);
  }

  /* ---------------- §7 the EMPTY-LAUNCH condition ---------------- */
  section('\u00a77  THE EXIT CRITERION — a zero-business-content database still loads');

  // The launch definition is "zero menu items, zero stores, zero offers, zero
  // vacancies, no completed company information" — business rows, not the
  // configuration singletons a fresh install creates. Empty the business tables
  // and prove the production load still completes rather than failing closed.
  psql(`truncate menu_items, stores, deals, news_posts, job_vacancies restart identity cascade`);

  const server2 = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const relation = url.pathname.replace('/rest/v1/', '');
    const asked = (url.searchParams.get('select') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const known = columnsByRelation[relation];
    if (!known || asked.some((c) => !known.includes(c))) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: '42703', message: 'column does not exist' }));
    }
    const limit = url.searchParams.get('limit') ? ` limit ${Number(url.searchParams.get('limit')) || 1}` : '';
    const json = psql(
      `select coalesce(json_agg(t), '[]'::json)::text from (select ${asked.join(',')} from ${relation}${limit}) t`,
    ).trim();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(json || '[]');
  });
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
  const env2 = { ...env, VITE_SUPABASE_URL: `http://127.0.0.1:${server2.address().port}` };

  let emptyError = null;
  let emptyMeta = null;
  try {
    ({ metadata: emptyMeta } = await loader.loadPublicContent({ mode: 'production', env: env2 }));
  } catch (e) {
    emptyError = e;
  }
  server2.close();

  check('production load completes with zero business content',
    emptyError === null, emptyError ? String(emptyError.message).split('\n').slice(0, 2).join(' / ') : '');
  check('the zero-content load is still stamped source=supabase',
    emptyMeta !== null && emptyMeta.source === 'supabase',
    emptyMeta ? `source=${emptyMeta.source}` : 'no metadata');
  if (emptyMeta) {
    const c = emptyMeta.counts || {};
    console.log(`     counts with the business tables emptied: ${JSON.stringify(c)}`);
    check('zero menu items, stores, vacancies and news in the snapshot',
      c.menuItems === 0 && c.stores === 0 && c.vacancies === 0 && c.publishedNewsPosts === 0,
      JSON.stringify(c));
  }

  section('\u00a77b  The whole-collection publish guard exists and refuses a truncated snapshot');
  const guardExists = rows(
    `select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='assert_full_collection_snapshot'`).length > 0;
  check('assert_full_collection_snapshot is present', guardExists);
  if (guardExists) {
    let refused = false;
    try {
      psql(`select assert_full_collection_snapshot('news_posts', '[]'::jsonb, 999)`);
    } catch { refused = true; }
    check('it refuses a snapshot whose expected total disagrees with the table', refused,
      'a truncated or stale publish would be applied silently');
  }

  /* ---------------- §8 the declared anonymous surface ---------------- */
  section('\u00a78  The anonymous surface matches scripts/contracts/anon-surface.json exactly');

  const anonContract = JSON.parse(readFileSync(path.join(ROOT, 'scripts/contracts/anon-surface.json'), 'utf8'));
  const allowed = anonContract.anon_select_allowed.map((r) => r.relation);
  const never = anonContract.must_never_be_anon_selectable;

  const actuallyGranted = rows(
    `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','v','m','p')
        and has_table_privilege('anon', c.oid, 'SELECT') order by 1`,
  );

  // Both directions. An allow-list that only catches additions lets the public
  // site go dark unnoticed; one that only catches removals is not a security
  // control at all.
  const undeclared = actuallyGranted.filter((r) => !allowed.includes(r));
  check('nothing outside the allow-list is anon-selectable', undeclared.length === 0,
    `undeclared: ${undeclared.join(', ')}`);

  const dark = allowed.filter((r) => relationExists(r) && !actuallyGranted.includes(r));
  check('every allow-listed relation is actually readable by anon', dark.length === 0,
    `declared but not granted: ${dark.join(', ')} — the public site would be dark`);

  const leaked = never.filter((t) => relationExists(t) && anonCanSelect(t));
  check('every relation on the never-list is denied at the GRANT layer', leaked.length === 0,
    `LEAKED: ${leaked.join(', ')}`);

  // Defence in depth is the point: RLS is no longer the only gate.
  for (const t of ['payslips', 'clock_history', 'work_shifts', 'job_applications', 'contact_messages']) {
    if (relationExists(t)) check(`${t}: closed by grant, not only by RLS`, !anonCanSelect(t));
  }

  // The public form tables must carry NO anonymous privilege. Phase B routes
  // submission through the public-form Edge Function; a direct anon INSERT would
  // bypass Turnstile, rate limiting and the privacy-notice gate.
  for (const rel of anonContract.anon_write_forbidden.relations) {
    if (!relationExists(rel)) continue;
    const canInsert = rows(
      `select has_table_privilege('anon','public.${rel}'::regclass,'INSERT')`)[0] === 't';
    check(`${rel}: anon holds NO direct privilege (Phase B uses the Edge Function)`,
      !canInsert && !anonCanSelect(rel), `insert=${canInsert} select=${anonCanSelect(rel)}`);
  }

  // Temporary entries are visible, not forgotten.
  const temporary = anonContract.anon_select_allowed.filter((r) => r.status === 'TEMPORARY');
  console.log(`     ${temporary.length} TEMPORARY base tables remain on the allow-list, ` +
    `to be replaced in Increment ${temporary[0] ? temporary[0].increment : 5}: ` +
    temporary.map((t) => `${t.relation} -> ${t.replaced_by}`).join(', '));

  /* ---------------- summary ---------------- */
  console.log('');
  if (failed === 0) {
    console.log(`\u2714 R4.10 PUBLIC CONTRACT RECONCILIATION — ${passed} passed, 0 failed`);
  } else {
    console.log(`\u2716 R4.10 PUBLIC CONTRACT RECONCILIATION — ${passed} passed, ${failed} FAILED`);
    for (const f of failures) console.log(`    - ${f}`);
  }
  try {
    execFileSync('su', ['postgres', '-c', `psql -q -X -c "drop database if exists ${DB}"`], { encoding: 'utf8' });
  } catch { /* leave the database for inspection if the drop fails */ }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\u2716 reconciliation harness error: ${e.message}`);
  process.exit(1);
});
