/* ============================================================================
 * permission-closure.test.mjs — Stage 2.1.x static invariants (deep audit).
 *
 * The full-flow audit showed table-policy tests are necessary but not
 * sufficient: data also leaks through client hydration, broad select=*, and
 * service-role Edge Functions. This suite pins the NON-RLS surfaces (Edge
 * Function authorisation, the client CV projection, the honest UI) plus the
 * final definitions of the Stage-2.1 policies, so none can silently regress.
 *
 * Migration layering under test (append-only; applied files are frozen):
 *   stage2_1_permission_closure      the ORIGINAL Stage-2.1 content (history)
 *   stage2_1_1_reaudit_closure       the 2.1.1 delta re-issued append-only
 *                                    (CF1 grant restore, CF2 views, CF3 scoping)
 *   stage2_1_2_salary_confidentiality server-enforced pay/identity privacy:
 *                                    base-table SELECT withdrawn, minimal
 *                                    (id,name,role,store_id) grant, reads via
 *                                    deliberate RPCs. THE gate below FAILS
 *                                    unless the database itself refuses a
 *                                    manager's direct pay query.
 * Behavioural RLS proof lives in scripts/rls-matrix.local.mjs.
 * ==========================================================================*/
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let passed = 0, failed = 0;
const check = (n, cond, d = '') => {
  console.log(`${cond ? '✔' : '✖'} ${n}${cond ? '' : `\n    ${d}`}`);
  if (cond) passed++; else failed++;
};
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

/* ---- final policy definitions (manifest order; DO-blocks expanded) ------- */
const files = execFileSync('bash', ['launch/migration-manifest.sh', 'fresh'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
const finals = new Map();
const keyOf = (tbl, pol) => `${tbl.replace(/^public\./, '')}.${pol}`;
for (const f of files) {
  if (!existsSync(f)) continue;
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/create policy\s+(\w+)\s+on\s+([\w.]+)[\s\S]*?;/g)) finals.set(keyOf(m[2], m[1]), m[0]);
  // DO-block loops that build policies with execute format(...). Handle BOTH
  // single-quoted format strings and $tag$-dollar-quoted format bodies, over
  // a `foreach t in array [...]` list OR a `for spec in (values ...)` list.
  for (const blk of src.matchAll(/(?:foreach\s+\w+\s+in\s+array\s+array\[([\s\S]*?)\]|for\s+\w+\s+in[\s\S]*?values([\s\S]*?)\))[\s\S]*?end loop;/g)) {
    const listSrc = blk[1] || blk[2] || '';
    const tuples = [...listSrc.matchAll(/\(([^)]*)\)/g)].map((t) => [...t[1].matchAll(/'([^']*)'/g)].map((x) => x[1]));
    const flat = [...listSrc.matchAll(/'([^']*)'/g)].map((x) => x[1]);
    const rows = tuples.length ? tuples : flat.map((v) => [v]);
    // gather every format(...) template in the block, single- or dollar-quoted
    const templates = [];
    for (const fmt of blk[0].matchAll(/format\(\s*((?:'[^']*'\s*)+)/g)) {
      templates.push([...fmt[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).join(''));
    }
    for (const fmt of blk[0].matchAll(/format\(\s*\$(\w+)\$([\s\S]*?)\$\1\$/g)) templates.push(fmt[2]);
    for (const tmpl of templates) {
      for (const row of rows) {
        // substitute %I placeholders positionally with the row's captured values
        let i = 0;
        const inst = tmpl.replace(/%I/g, () => row[Math.min(i++, row.length - 1)] ?? '');
        const c = inst.match(/create policy\s+(\w+)\s+on\s+([\w.]+)/);
        if (c) finals.set(keyOf(c[2], c[1]), inst);
      }
    }
  }
}
const fin = (k) => finals.get(k) || '';

/* ---- F1: orders — employees see only their own ---------------------------- */
check('F1: orders_select_store scopes ordinary staff to their OWN orders',
  /staff_id = current_staff_id\(\)/.test(fin('orders.orders_select_store'))
    && /is_store_manager\(\)/.test(fin('orders.orders_select_store')),
  'orders read policy is not own-orders-for-staff / store-for-manager');

/* ---- F2 → S (Stage 2.1.2): pay/identity privacy is SERVER-enforced -------- */
const s21 = read('supabase/migration_stage2_1_permission_closure.sql');
const s211 = read('supabase/migration_stage2_1_1_reaudit_closure.sql');
const s212 = read('supabase/migration_stage2_1_2_salary_confidentiality.sql');
const sup = read('src/lib/supabase.ts');
const sup2 = read('src/lib/registries.ts');
const auth2 = read('src/lib/auth.ts');

// The re-audit's core finding: a client projection is data MINIMISATION, not
// access CONTROL. These checks fail unless the DATABASE refuses direct pay
// and identity reads — the previous "no partial column-grant" assertion (which
// protected the insecure design) is retired and inverted here.
check('S1: 2.1.2 clears EVERY per-column SELECT grant dynamically (pg_attribute loop)',
  /pg_attribute/.test(s212)
    && /revoke select \(%I\) on public\.staff_profiles from authenticated, anon/.test(s212),
  'without the dynamic loop, original-2.1 column grants survive a table revoke');
check('S2: 2.1.2 withdraws table-level SELECT on staff_profiles from the browser roles',
  /revoke select on public\.staff_profiles from authenticated, anon;/.test(s212),
  'general SELECT on the base table remains granted');
const retained = [...s212.matchAll(/grant select \(([^)]*)\)\s+on public\.staff_profiles/g)]
  .map((m) => m[1].replace(/\s+/g, ' ').trim());
check('S3: the ONLY retained column grant is exactly (id, name, role, store_id, store_name)',
  retained.length === 1 && retained[0] === 'id, name, role, store_id, store_name',
  `retained grants: ${JSON.stringify(retained)}`);
const myProf = (s212.match(/create or replace function get_my_staff_profile\(\)[\s\S]*?\$\$;/) || [''])[0];
check('S4: get_my_staff_profile() — definer, search_path pinned, own row only, own pay included',
  /security definer/.test(myProf) && /set search_path = public, pg_temp/.test(myProf)
    && /where sp\.auth_id = auth\.uid\(\)/.test(myProf) && /pay_rate/.test(myProf)
    && /revoke all on function get_my_staff_profile\(\) from public, anon;/.test(s212)
    && /grant execute on function get_my_staff_profile\(\) to authenticated;/.test(s212),
  'self-profile RPC missing, ungated, or pay-free');
const dirFn = (s212.match(/create or replace function get_staff_directory\(\)[\s\S]*?\$\$;/) || [''])[0];
const dirCols = (dirFn.match(/returns table \(([\s\S]*?)\)\s*language/) || ['', ''])[1];
check('S5: get_staff_directory() — definer, Stage-2.1 row scope, and NO pay / NO auth_id in its columns',
  /security definer/.test(dirFn) && /set search_path = public, pg_temp/.test(dirFn)
    && /is_owner\(\)/.test(dirFn) && /is_store_manager\(\) and sp\.store_id = current_staff_store\(\)/.test(dirFn)
    && /sp\.auth_id = auth\.uid\(\)/.test(dirFn)
    && dirCols.length > 0 && !/pay_rate|pay_type|auth_id/.test(dirCols)
    && /revoke all on function get_staff_directory\(\) from public, anon;/.test(s212)
    && /grant execute on function get_staff_directory\(\) to authenticated;/.test(s212),
  'directory RPC missing, mis-scoped, or leaking pay/auth_id columns');
check('S6: owner_staff_pay() is is_owner-gated at origin (2.1) AND re-asserted in 2.1.2',
  /create or replace function owner_staff_pay\(\)/.test(s21) && /where is_owner\(\)/.test(s21)
    && /create or replace function owner_staff_pay\(\)/.test(s212) && /where is_owner\(\)/.test(s212),
  'owner pay RPC missing or ungated in one of its definitions');
check('S7: the login self-read calls rpc/get_my_staff_profile (no base-table URL)',
  /rest\/v1\/rpc\/get_my_staff_profile/.test(auth2)
    && !/staff_profiles\?select=/.test(auth2),
  'self-profile path still reads the base table');
const dirConst = (sup2.match(/const STAFF_DIRECTORY_COLS = \[([\s\S]*?)\]/) || ['', ''])[1];
check('S8: the directory hydrates via rpc/get_staff_directory with a pay-free pinned contract',
  /fetchStaffDirectory/.test(sup2) && /rpc\/get_staff_directory/.test(sup2)
    && dirConst.length > 0 && !/pay_rate|pay_type|auth_id/.test(dirConst),
  'directory hydration missing, or the pinned contract carries pay');
let tableReadHits = '';
try {
  tableReadHits = execFileSync('grep', ['-rl', 'staff_profiles?select=', 'src'], { encoding: 'utf8' }).trim();
} catch { /* grep exits 1 on zero matches — the desired outcome */ }
check('S9: NO source file reads the staff_profiles base table by URL',
  tableReadHits === '',
  `base-table reads remain in: ${tableReadHits}`);
check('S10: the owner directory enriches pay via the owner_staff_pay RPC',
  /rpc\/owner_staff_pay/.test(sup2) && /person\.payRate = p\.pay_rate/.test(sup2),
  'owner pay merge not wired');
check('S11: 2.1.1 re-issues the CF1 grant restoration append-only (both tables)',
  /grant select on staff_profiles\s+to authenticated;/.test(s211)
    && /grant select on job_applications to authenticated;/.test(s211),
  'the 2.1.1 delta migration is missing the CF1 restoration');
check('S12: manifest replays history in order: 2.1 → 2.1.1 → 2.1.2',
  files.indexOf('supabase/migration_stage2_1_permission_closure.sql')
      < files.indexOf('supabase/migration_stage2_1_1_reaudit_closure.sql')
    && files.indexOf('supabase/migration_stage2_1_1_reaudit_closure.sql')
      < files.indexOf('supabase/migration_stage2_1_2_salary_confidentiality.sql'),
  'migration chain order is wrong or a file is missing from the manifest');

/* ---- F4: training reads store-scoped through the employee ----------------- */
// The three training select policies are rebuilt inside one DO-block via a
// dollar-quoted format() template; rather than re-emulate Postgres arg-binding,
// assert the block names all three policies AND carries the store-scoped join.
const f4names = ['tassign_select_self_or_mgr', 'tprog_select_self_or_mgr', 'tcert_select_self_or_mgr'];
const f4block = (s21.match(/Supersede the REAL select policies[\s\S]*?end loop;/) || [''])[0];
check('F4: all three training select policies are rebuilt store-scoped for managers',
  f4names.every((n) => f4block.includes(n))
    && /is_store_manager\(\)/.test(f4block)
    && /sp\.store_id = current_staff_store\(\)/.test(f4block)
    && /employee_id = current_staff_id\(\)/.test(f4block),
  'training store-scoping block missing a policy or the store join');

/* ---- F6: lifecycle-field trigger ----------------------------------------- */
check('F6: a staff-profile lifecycle guard trigger exists',
  /create trigger trg_guard_staff_profile_write/.test(s21)
    && /identity and lifecycle fields are system-controlled/.test(s21)
    && /team members and supervisors/.test(s21),
  'lifecycle guard trigger missing');

/* ---- F8: the client CV projection never carries cv_path ------------------- */
check('F8: fetchApplicationsAuthed selects an explicit column set WITHOUT cv_path',
  /fetchApplicationsAuthed/.test(sup)
    && /cv_present/.test(sup)
    && !/select=\*[^;]*job_applications/.test(sup)
    && !/applied_store,availability,experience,message,status,created_at,cv_present[^']*cv_path/.test(sup),
  'application projection missing or still includes cv_path');
check('F8: cv_present is a generated column; the 2.1 partial grant is reversed by 2.1.1',
  /add column if not exists cv_present boolean/.test(s21)
    && /grant select on job_applications to authenticated;/.test(s211),
  'cv_present missing, or the crash-prone job_applications partial grant is not reversed');
const app = read('src/App.tsx');
check('F8: App maps hasCv (presence) and no longer reads cvPath',
  /hasCv: r\.cvPresent === true/.test(app) && !/cvPath:/.test(app),
  'client still handles cvPath');

/* ---- F11: media metadata scoped ------------------------------------------ */
check('F11: media_objects reads are owner-all / manager-menu-only',
  /is_owner\(\)/.test(fin('media_objects.media_objects_select_staff'))
    && /entity_type = 'menu_item'/.test(fin('media_objects.media_objects_select_staff')),
  'media_objects read not scoped');

/* ---- F13: media-upload role name + menu-only manager attach --------------- */
const mu = read('supabase/functions/media-upload/index.ts');
check('F13: media-upload checks the REAL role name (store_manager, not manager)',
  /role !== 'owner' && role !== 'store_manager'/.test(mu) && !/role !== 'manager'/.test(mu),
  'media-upload still checks the wrong role name');
check('F13: a manager may only attach media to menu_item entities',
  /managerMayAttachTo/.test(mu) && /entityType === 'menu_item'/.test(mu),
  'manager media attach is not menu-scoped');

/* ---- F3: cv-signed-url + send-email harden -------------------------------- */
const cv = read('supabase/functions/cv-signed-url/index.ts');
check('F3: cv-signed-url requires active status AND store-scopes managers',
  /account_disabled/.test(cv) && /applied_store/.test(cv) && /out_of_store/.test(cv),
  'cv-signed-url missing status/store checks');
const em = read('supabase/functions/send-email/index.ts');
const tpl = read('supabase/functions/send-email/templates.ts');
check('F3: send-email requires MFA for non-self templates and blocks disabled staff',
  /callerAal2/.test(em) && /recipientKind !== 'self' && !callerAal2/.test(em)
    && /status[^\n]*=== 'disabled'/.test(em),
  'send-email missing aal2/status gates');
check('F3: contact & franchise reply templates are owner-only',
  /recipientKind: 'contact',\s*\n\s*minRole: 'owner'/.test(tpl)
    && /recipientKind: 'franchise',\s*\n\s*minRole: 'owner'/.test(tpl),
  'contact/franchise still manager-allowed');
check('F3: send-email store-scopes application recipients for managers',
  /applied_store/.test(em) && /not authorised to e-mail this applicant/.test(em),
  'application recipients not store-scoped');

/* ---- F7: staff-invite manager target restriction -------------------------- */
const inv = read('supabase/functions/staff-invite/index.ts');
check('F7: a manager may only invite/refresh team_member or supervisor',
  /\['team_member', 'supervisor'\]\.includes\(String\(target\.role(?: \|\| '')?\)\)/.test(inv)
    && /administer manager accounts/.test(inv),
  'staff-invite allows peer-manager administration');

/* ---- F14: SEO rebuild manager restriction + MFA --------------------------- */
const seo = read('supabase/functions/request-seo-rebuild/core.ts');
check('F14: SEO rebuild limits managers to the menu area and requires MFA',
  /Managers may only rebuild the menu/.test(seo) && /callerAal2/.test(seo),
  'SEO rebuild not restricted for managers');

/* ---- F5: the Permissions screen is an honest read-only reference ---------- */
const adm = read('src/components/AdminPanel.tsx');
const adminNavigation = read('src/components/admin/adminNavigation.ts');
const permissionsPanel = read('src/components/admin/PermissionsPanel.tsx');
check('F5: the Permissions screen is a read-only reference (no fake auto-save toggles)',
  /<PermissionsPanel \/>/.test(adm)
    && /Permissions Reference/.test(permissionsPanel)
    && /PERMISSION_REFERENCE/.test(permissionsPanel)
    && !/Saves automatically/.test(permissionsPanel),
  'permissions screen still presents non-functional toggles');

/* ---- F12: mixed-role pages hide owner-only controls ----------------------- */
const careersPanel = read('src/components/admin/CareersPanel.tsx');
check('F12: vacancy create/edit/delete controls are owner-gated in the Careers page',
  /\{isOwner && \([\s\S]{0,500}Create Opportunity/.test(careersPanel)
    && /\{isOwner && \([\s\S]*?aria-label="Edit vacancy"[\s\S]*?aria-label="Delete vacancy"[\s\S]*?\)\}/.test(careersPanel)
    && /isOwner=\{currentRole === 'owner'\}/.test(adm)
    && /stores:\s*\{[^}]*allowedRoles:\s*\['owner'\]/.test(adminNavigation),
  'vacancy mutations or the Stores route are not explicitly owner-gated');

/* ---- CF2: analytics views are security_invoker; stock_levels revoked ------ */
check('CF2: sales views are flipped to security_invoker (2.1.1 delta migration)',
  /security_invoker = true/.test(s211) && /daily_sales/.test(s211) && /sales_by_channel/.test(s211),
  'analytics views not set to security_invoker');
check('CF2: stock_levels (reserved) is revoked from the browser',
  /revoke all on stock_levels from authenticated, anon/.test(s211),
  'stock_levels still browser-readable');

/* ---- CF3: all manager training writes store-scoped ----------------------- */
check('CF3: manager training write policies are store-scoped (insert/update/delete/results)',
  ['tassign_insert_mgr', 'tassign_update_mgr', 'tassign_delete_mgr', 'tcert_update_mgr', 'tres_select_self_or_mgr']
    .every((n) => s211.includes(n))
    && /is_store_manager\(\) and exists/.test(s211)
    && /sp\.store_id = current_staff_store\(\)/.test(s211),
  'a global manager training path remains');

/* ---- CF4: send-email staff recipients store/role/status-scoped ----------- */
check('CF4: send-email scopes staff recipients (store + lower role + active)',
  /not authorised to e-mail this staff member/.test(em)
    && /\['team_member', 'supervisor'\]\.includes\(tRole\)/.test(em),
  'staff recipient scoping missing');

/* ---- CF5: training-media rejects disabled callers ------------------------ */
const tm = read('supabase/functions/training-media/index.ts');
check('CF5: training-media loads status and rejects disabled callers',
  /select=id,name,role,status/.test(tm) && /This account is disabled/.test(tm),
  'training-media missing status gate');

/* ==========================================================================
   INC11 (audit sweep, APPLICATION TIER). The database tier now proves its own
   invariants: no view or function hands the browser authority that row-level
   security does not stand behind. Edge Functions are where that guarantee
   ends — each one holds the service-role key, which bypasses RLS by
   construction, so the scope a caller's own session would have has to be
   RE-ENFORCED IN CODE. Today every function does it, and cv-signed-url even
   says so out loud ("the service role bypasses RLS, so re-enforce the store
   scope the caller's own session would have"). What was missing is any check
   that the NEXT function will. These three ratchets enumerate the directory,
   so a new function cannot join quietly.
   ========================================================================== */
const FN_ROOT = 'supabase/functions';
const fnNames = existsSync(FN_ROOT)
  ? readdirSync(FN_ROOT).filter((d) => existsSync(`${FN_ROOT}/${d}/index.ts`)).sort()
  : [];
const fnSource = (n) => read(`${FN_ROOT}/${n}/index.ts`) + read(`${FN_ROOT}/${n}/core.ts`);

check('CF6: the Edge Function directory is non-empty (the scan has something to scan)',
  fnNames.length >= 10, `found ${fnNames.length}`);

/* CF6a. Deployment posture is DECLARED, never defaulted. `supabase functions
   deploy` reads verify_jwt from config.toml; a function with no entry inherits
   whatever the platform default happens to be, which is exactly the kind of
   silent inheritance this whole audit round was about. */
{
  const cfg = read('supabase/config.toml');
  const undeclared = fnNames.filter((n) => !new RegExp(`\\[functions\\.${n.replace(/-/g, '\\-')}\\]`).test(cfg));
  check('CF6a: every Edge Function declares its verify_jwt posture in config.toml',
    undeclared.length === 0, `undeclared: ${undeclared.join(', ')}`);
}

/* CF6b. Any function holding the service-role key must derive the caller's
   authority from the DATABASE — never from claims the client supplied. The
   declared exceptions are functions with no user identity to resolve; each
   carries the reason it needs none. */
{
  const NO_USER_IDENTITY = {
    'public-form': 'anonymous submitters by design; Turnstile + idempotency + per-IP reservation + the DB accept-gate',
    'cv-upload': 'anonymous candidates by design; magic-byte sniffing, existence check, upsert=false',
    'pos-pair': 'device pairing bootstrap; the pairing CODE is the credential',
    'pos-ingest': 'till device-token auth (SYNC-CONTRACT), not a user JWT',
    'pos-catalog': 'till device-token auth (SYNC-CONTRACT), not a user JWT',
    'outbox-dispatch': 'invoked by the scheduler; it authenticates the service role itself and has no caller',
  };
  const DB_AUTHORITY = /staff_profiles\?auth_id=eq\.|claim_recovery_intent|current_staff_id\(\)/;
  const unscoped = fnNames.filter((n) => {
    const src = fnSource(n);
    if (!/SUPABASE_SERVICE_ROLE_KEY/.test(src)) return false;
    if (NO_USER_IDENTITY[n]) return false;
    return !DB_AUTHORITY.test(src);
  });
  check('CF6b: every service-role Edge Function resolves caller authority from the database',
    unscoped.length === 0, `no DB-side authority check: ${unscoped.join(', ')}`);
}

/* CF6c. A function that mints a signed URL must never take a storage path
   from the request body — that would let any authorised caller reach any
   object in the bucket. There are two sound ways to avoid it, and the first
   run of this ratchet flagged the difference:

     • PER-SUBJECT data (a CV, a staff document) carries its scope on a ROW,
       so the client sends an ID and the function resolves storage_path /
       cv_path server-side. Anything else is an IDOR.
     • SHARED staff-internal content (training videos) has no per-row owner —
       every linked staff member may watch. There the protection is the KEY
       ITSELF: a server-minted random UUID, and a signing reference pinned by
       an anchored regex to this bucket, so nothing traversable or guessable
       can be presented.

   The second form is allowed only where DECLARED below, and only if the
   pinning regex is actually present and anchored — so a future CV-shaped
   function cannot claim the exemption. */
{
  const KEY_SHAPE_PINNED = {
    'training-media': 'lesson videos are staff-internal with no per-row owner; keys are server-minted UUIDs and the sign reference is pinned by an anchored bucket regex',
  };
  const signers = fnNames.filter((n) => /object\/sign/.test(fnSource(n)));
  check('CF6c: at least one signer exists to check', signers.length >= 2, signers.join(', '));
  const clientPath = signers.filter((n) => {
    const src = fnSource(n);
    if (/(input|body|payload)\s*[?.]?\.\s*(path|storagePath|storage_path)\b/.test(src)) return true;
    if (/select=[^`'"]*(storage_path|cv_path)/.test(src)) return false;      // row-resolved
    if (!KEY_SHAPE_PINNED[n]) return true;                                    // undeclared
    const anchored = new RegExp(`= /\\^storage:[^\n]*${n}`).test(src);      // pinned to THIS bucket
    const fromMatch = /\bconst objectKey = m\[1\]/.test(src);                 // key comes from the match
    return !(anchored && fromMatch);
  });
  check('CF6c: every signed-URL function resolves the key from a row, or from a declared bucket-pinned reference',
    clientPath.length === 0, `client-supplied path risk: ${clientPath.join(', ')}`);
}

/* ==========================================================================
   CF7 — CONFIGURATION SINGLETONS ARE RPC-WRITE-ONLY FROM THE CLIENT.
   The original defect: the singleton repo upserted `id: 'singleton'` against
   tables whose primary keys are INTEGER 1 (site_settings, site_content) and
   BOOLEAN true (launch_settings) — a type error on every real cloud save, and
   a direct write that bypassed the revision guard entirely. The repo's save()
   is gone and the writes go through save_website_studio /
   save_launch_settings. These checks stop it coming back.
   ========================================================================== */
{
  const reg = read('src/lib/registries.ts');
  check('CF7: the singleton repo exposes no direct save/upsert',
    !/save\s*\(value: T/.test(reg) && !/on_conflict=id/.test(reg),
    'a direct singleton write path is back in registries.ts');
  check('CF7: no id literal is passed to defineSingleton',
    !/defineSingleton<[^>]*>\([^)]*,/.test(reg),
    'defineSingleton still takes an id argument');

  const srcFiles = execFileSync('bash', ['-c',
    "grep -rl \"\" src --include='*.ts' --include='*.tsx' || true"], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const SINGLETONS = /(site_settings|site_content|launch_settings)/;
  const offenders = [];
  for (const f of srcFiles) {
    const body = read(f);
    for (const m of body.matchAll(/authedRest[^;]{0,400}?;/gs)) {
      const call = m[0];
      if (!SINGLETONS.test(call)) continue;
      if (/rpc\//.test(call)) continue;                       // the sanctioned path
      if (/method:\s*'(POST|PATCH|PUT|DELETE)'/.test(call)) offenders.push(`${f}: ${call.slice(0, 70)}…`);
    }
  }
  check('CF7: no client code writes a configuration singleton table directly',
    offenders.length === 0, offenders.slice(0, 2).join(' | '));

  check('CF7: the sanctioned RPC write paths are the ones actually wired',
    /rpc\/save_launch_settings/.test(read('src/lib/launchSettings.ts'))
      && /'save_website_studio'/.test(reg),
    'a singleton save RPC is not referenced by the client');
}

console.log(`\nPERMISSION CLOSURE (Stage 2.1.x) — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
