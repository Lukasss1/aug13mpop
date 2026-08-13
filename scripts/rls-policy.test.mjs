#!/usr/bin/env node
/**
 * rls-policy.test.mjs — STATIC checks on the per-role RLS migration (A1/A2).
 *
 * Runs offline, zero-dependency, in CI — the same style as
 * security-regression.test.mjs. It does NOT connect to a database; it proves
 * the migration SQL still encodes the invariants we care about, so a careless
 * edit can't quietly loosen them. The LIVE proof (real logins, real cross-store
 * denial) is rls-live.test.mjs, run against a Supabase instance by a human.
 *
 * Run: node scripts/rls-policy.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

let passed = 0, failed = 0;
const ok   = (n) => { passed++; console.log(`\u2714 ${n}`); };
const fail = (n, d) => { failed++; console.error(`\u2716 ${n}\n    ${d}`); };
const check = (n, cond, d = '') => (cond ? ok(n) : fail(n, d));

const A1 = 'supabase/migration_rls_per_role.sql';
const A2 = 'supabase/migration_auth_onboarding.sql';
for (const f of [A1, A2]) {
  if (!existsSync(f)) { fail(`${f} exists`, 'file missing'); }
}
const a1 = existsSync(A1) ? readFileSync(A1, 'utf8') : '';
const a2 = existsSync(A2) ? readFileSync(A2, 'utf8') : '';
// Strip SQL comments so we test executable statements, not documentation.
const strip = (s) => s.replace(/--[^\n]*/g, '');
const a1code = strip(a1);
const a2code = strip(a2);

/* 1. anon must never be granted anything by these migrations ------------- */
check('A1 grants anon nothing',
  !/\bto\s+anon\b/i.test(a1code),
  'a "to anon" clause appears in the per-role migration');
check('A2 grants anon nothing',
  !/\bto\s+anon\b/i.test(a2code) && /revoke\s+all\s+on\s+function\s+bootstrap_owner[\s\S]*from\s+anon/i.test(a2code),
  'bootstrap_owner not revoked from anon, or a "to anon" grant present');

/* 2. no blanket using(true)/with check(true) for authenticated on a private
 *    table. Public-content read policies legitimately use (true); we allow
 *    that ONLY where the policy is a SELECT named content_read_auth.        */
{
  const policyRe = /create policy\s+(\w+)\s+on\s+(\w+)\s+for\s+(\w+)[\s\S]*?(?=create policy|do \$\$|$)/gi;
  const offenders = [];
  let m;
  while ((m = policyRe.exec(a1code))) {
    const [, name, table, verb] = m;
    const body = m[0];
    const truthy = /using\s*\(\s*true\s*\)|with check\s*\(\s*true\s*\)/i.test(body);
    const isContentRead = name === 'content_read_auth' && /select/i.test(verb);
    if (truthy && !isContentRead) offenders.push(`${name} on ${table} (${verb})`);
  }
  check('no unrestricted using(true) on private authenticated policies',
    offenders.length === 0, offenders.join('; '));
}

/* 3. the security-critical invariants are present ------------------------ */
check('helper functions are SECURITY DEFINER with pinned search_path',
  (a1code.match(/security definer/gi) || []).length >= 5 &&
  (a1code.match(/set search_path\s*=\s*public,\s*pg_temp/gi) || []).length >= 5,
  'a helper is missing SECURITY DEFINER or a pinned search_path');

check('payslip writes are owner-only',
  /create policy payslips_write_owner[\s\S]*?using\s*\(\s*is_owner\(\)\s*\)/i.test(a1code),
  'payslips write policy is not gated on is_owner()');

check('audit log reads are owner-only',
  /create policy audit_select_owner[\s\S]*?using\s*\(\s*is_owner\(\)\s*\)/i.test(a1code),
  'audit_logs select policy is not owner-only');

check('a staff member cannot approve their own timesheet',
  /clock_update_self_open[\s\S]*?coalesce\(approved,false\)\s*=\s*false[\s\S]*?with check/i.test(a1code),
  'self clock-out policy does not forbid self-approval');

check('self profile update blocks role/store escalation',
  /staff_profiles_update_self[\s\S]*?role\s*=\s*current_staff_role\(\)[\s\S]*?store_id is not distinct from current_staff_store\(\)/i.test(a1code),
  'self-update policy does not pin role and store to current DB values');

check('role/store come from the DB, not the client (no jwt role claims used)',
  !/auth\.jwt\(\)\s*->>\s*'role'/i.test(a1code),
  'a policy trusts a role claim from the JWT instead of staff_profiles');

check('onboarding link trusts only the verified JWT email',
  /link_staff_profile[\s\S]*?auth\.jwt\(\)\s*->>\s*'email'/i.test(a2code) &&
  !/create or replace function link_staff_profile\s*\(\s*\w/i.test(a2code),
  'link_staff_profile takes an email argument or does not use the JWT email');

check('bootstrap_owner refuses if an owner already exists',
  /bootstrap_owner[\s\S]*?where role = 'owner'[\s\S]*?raise exception/i.test(a2code),
  'bootstrap_owner does not guard against a second owner');

/* summary ---------------------------------------------------------------- */
/* ======================================================================== */
/* POS sync migration (Gate 5 / Gate 10 posture)                            */
/* ======================================================================== */
const POS = 'supabase/migration_pos_sync.sql';
if (!existsSync(POS)) { fail(`${POS} exists`, 'file missing'); }
const posRaw = existsSync(POS) ? readFileSync(POS, 'utf8') : '';
const pos = strip(posRaw);
const POS_TABLES = [
  'pos_devices','pos_pairing_codes','pos_pair_attempts','pos_events',
  'pos_orders','pos_order_items','pos_order_item_modifiers','pos_shifts',
  'pos_cash_movements','pos_refunds','pos_refund_items','pos_voids',
  'pos_corrections','pos_approvals','pos_audit_events',
];

/* P1. RLS enabled + anon fully revoked on EVERY pos table (via the loop) */
check('POS: RLS enable/revoke loop covers every pos table',
  POS_TABLES.every((t) => pos.includes(`'${t}'`)) &&
  /enable row level security/i.test(pos) &&
  /revoke all on table %I from anon/i.test(pos) &&
  /revoke all on table %I from authenticated/i.test(pos),
  'a pos table is missing from the RLS/revoke loop');

/* P2. nothing is ever granted to anon */
check('POS: grants anon nothing', !/\bto\s+anon\b/i.test(pos),
  'a "to anon" clause appears in the POS migration');

/* P3. browsers are read-only: the only table grants to authenticated are SELECT */
{
  const grants = pos.match(/grant\s+[^;]*to\s+authenticated/gi) || [];
  const bad = grants.filter((g) => /\b(insert|update|delete|all)\b/i.test(g) && !/grant execute/i.test(g));
  check('POS: authenticated table grants are SELECT-only', bad.length === 0, bad.join(' | '));
}

/* P4. token hashes are not even grantable to browsers */
{
  const m = pos.match(/grant select \(([^)]*)\)\s*(?:\n\s*)?on pos_devices to authenticated/i);
  check('POS: pos_devices browser grant is column-scoped and excludes token hashes',
    !!m && !/token_hash/i.test(m[1]) && !/pending_token_hash/i.test(m[1]),
    m ? 'token column present in the grant list' : 'column-scoped grant missing');
  check('POS: pairing codes / attempts have no browser grants at all',
    !/grant[^;]*on pos_pairing_codes[^;]*to authenticated/i.test(pos) &&
    !/grant[^;]*on pos_pair_attempts[^;]*to authenticated/i.test(pos),
    'a browser grant exists on the pairing tables');
}

/* P5. write path is unreachable from browser roles: the ingest/auth/pairing
 *    RPCs are revoked from public+anon+authenticated and never re-granted.
 *    (The Edge Functions keep execute via Supabase's default privileges for
 *    the service key; naming that role here is itself forbidden by the
 *    security suite's token scan.) */
check('POS: ingest/auth/pairing RPCs are revoked from all browser roles',
  ["pos_ingest_batch(uuid, jsonb)","pos_authenticate_device(text)","pos_complete_pairing(text, text, jsonb)"]
    .every((f) => pos.includes(`'${f}'`)) &&
  /revoke all on function %s from anon/i.test(pos) &&
  /revoke all on function %s from authenticated/i.test(pos) &&
  !/grant execute on function pos_(ingest_batch|authenticate_device|complete_pairing)[^;]*to (authenticated|anon)/i.test(pos),
  'a device-write RPC is reachable from a browser role');

/* P6. owner RPCs enforce is_owner() themselves */
check('POS: pairing-code / revoke / rotate RPCs check is_owner()',
  (pos.match(/if not is_owner\(\) then/gi) || []).length >= 3,
  'an owner RPC is missing its is_owner() guard');

/* P7. definer functions pin search_path */
check('POS: SECURITY DEFINER functions pin search_path',
  (pos.match(/security definer/gi) || []).length >= 5 &&
  (pos.match(/set search_path = public, pg_temp/gi) || []).length >= 10,
  'a POS function is missing SECURITY DEFINER or the pinned search_path');

/* P8. no unrestricted policies */
check('POS: no using(true)/with check(true) policies',
  !/using\s*\(\s*true\s*\)|with check\s*\(\s*true\s*\)/i.test(pos),
  'an unrestricted policy appears in the POS migration');

/* P9. financial invariants live in the ingest function */
check('POS: refund cap is enforced with a row lock',
  /for update/i.test(pos) && /refunds would exceed the amount paid/i.test(pos),
  'refund cap or FOR UPDATE lock missing');
check('POS: forbidden-field scan covers pin|password|secret',
  /pin\|password\|secret/i.test(pos),
  'forbidden key regex missing');
check('POS: contract rejection reasons are all raised',
  ['duplicate_conflict','device_scope_violation','invalid_money',
   'unknown_event_type','forbidden_field','malformed_payload']
    .every((r) => pos.includes(`MPREJ:${r}`)),
  'a contract rejection reason is never raised');
check('POS: token rotation keeps an overlap window',
  /pending_token_hash/i.test(pos) && /pos_authenticate_device/i.test(pos),
  'pending-token overlap plumbing missing');




/* ==========================================================================
 * STAGE-2 PERMISSION HARDENING — final-definition invariants (audit M4)
 *
 * The migration chain supersedes-in-place (earlier files stay byte-identical
 * for the adoption ledger), so the invariant is on the FINAL definition of
 * every policy in manifest order — never on any single file's text.
 * ========================================================================== */
import { execFileSync } from 'node:child_process';
{
  const files = execFileSync('bash', ['launch/migration-manifest.sh', 'fresh'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  const finals = new Map();
  for (const f of files) {
    if (!existsSync(f)) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/create policy\s+(\w+)\s+on\s+(\w+)[\s\S]*?;/g)) {
      finals.set(`${m[2]}.${m[1]}`, m[0]);
    }
    // Expand DO-block loops (policies created via execute format(...%I...)).
    for (const blk of src.matchAll(/foreach t in array array\[([\s\S]*?)\][\s\S]*?end loop;/g)) {
      const tables = [...blk[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
      for (const fmt of blk[0].matchAll(/format\(\s*((?:'[^']*'\s*)+)/g)) {
        const sql = [...fmt[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).join('');
        for (const tbl of tables) {
          const inst = sql.replace(/%I/g, tbl);
          const c = inst.match(/create policy\s+(\w+)\s+on\s+(\w+)/);
          if (c) finals.set(`${c[2]}.${c[1]}`, inst);
          const dnp = inst.match(/drop policy if exists\s+(\w+)\s+on\s+(\w+)/);
          if (dnp && !inst.includes('create policy')) finals.delete(`${dnp[2]}.${dnp[1]}`);
        }
      }
    }
    for (const d of src.matchAll(/drop policy if exists\s+(\w+)\s+on\s+(\w+)/g)) {
      // a drop NOT followed (in this same file, later) by a re-create removes the final
      const key = `${d[2]}.${d[1]}`;
      const recreated = src.slice(d.index).match(new RegExp(`create policy\\s+${d[1]}\\s+on\\s+${d[2]}`));
      if (!recreated) finals.delete(key);
    }
  }
  // The audited rule is about ELEVATION: a policy must never grant manager/
  // owner power by comparing the raw role itself (that path skips is_aal2()).
  // The self-update INVARIANCE clause `role = current_staff_role()` is the
  // opposite — it PINS the caller's role so nobody can promote themselves —
  // and stays legitimately raw (an aal1 employee may edit their safe fields).
  const elevation = /current_staff_role\(\)\s*(=\s*'(store_manager|owner)'|in\s*\()/;
  const rawRole = [...finals.entries()].filter(([, body]) => elevation.test(body));
  check('M4: NO final policy grants privilege via raw current_staff_role() (MFA choke point holds)',
    rawRole.length === 0, `raw-role elevation finals: ${rawRole.map(([k]) => k).join(', ')}`);
  check('F1: staff_profiles_update_mgr FINAL uses the AAL2-aware helper',
    /is_store_manager\(\)/.test(finals.get('staff_profiles.staff_profiles_update_mgr') || ''),
    'manager staff-write helper missing');
  const s2 = readFileSync('supabase/migration_stage2_role_hardening.sql', 'utf8');
  check('F1: is_store_manager() exists and REQUIRES aal2',
    /create or replace function is_store_manager\(\)/.test(s2) && /and is_aal2\(\);/.test(s2),
    'helper missing or not MFA-aware');
  const ownerOnly = ['site_settings', 'stores', 'deals', 'job_vacancies', 'news_posts', 'cms_pages', 'media_assets'];
  check('F2: public content writes are OWNER-ONLY in the final chain (menu excepted)',
    ownerOnly.every((tbl) => !finals.has(`${tbl}.content_write_mgr`)
      && /is_owner\(\)/.test(finals.get(`${tbl}.content_write_owner`) || '')),
    'a manager-writable public-content final survives (or the owner policy is missing)');
  check('F2-exception: the MENU keeps an MFA-gated manager write (shipped feature parity)',
    /menu_write_mgr/.test(finals.get('menu_items.menu_write_mgr') || '')
      && /is_manager_or_owner\(\)/.test(finals.get('menu_items.menu_write_mgr') || '')
      && !finals.has('menu_items.content_write_mgr') && !finals.has('menu_items.content_write_owner'),
    'menu policy shape wrong');
  const reserved = ['customers', 'loyalty_transactions', 'ingredients', 'stock_movements'];
  check('F3: reserved domains have NO final browser policies AND privileges revoked',
    reserved.every((tbl) => ![...finals.keys()].some((k) => k.startsWith(`${tbl}.`)))
      && reserved.every((tbl) => new RegExp(`revoke all on ${tbl}\\s+from authenticated, anon;`).test(s2)),
    'reserved-domain lockdown incomplete');
  check('F4: applications are store-scoped through the MFA-aware helper',
    /applied_store <> ''/.test(finals.get('job_applications.applications_select_mgr') || '')
      && /is_store_manager\(\)/.test(finals.get('job_applications.applications_select_mgr') || '')
      && /applied_store <> ''/.test(finals.get('job_applications.applications_update_mgr') || ''),
    'application scoping missing');
  check('F4: the contact inbox is OWNER-ONLY in the final chain',
    !finals.has('contact_messages.contact_select_mgr')
      && /is_owner\(\)/.test(finals.get('contact_messages.contact_select_owner') || ''),
    'contact inbox not owner-only');
}

console.log(`\n${passed} passed, ${failed} failed`);

process.exit(failed ? 1 : 0);
