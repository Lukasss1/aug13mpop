#!/usr/bin/env node
/**
 * security-regression.test.mjs — pins every vulnerability removed in the
 * July 2026 lockdown so it cannot quietly return. Source-level, zero
 * dependencies, runs before `npm install` and in minimal CI images.
 *
 * Run: npm run test:security
 *
 * Companion checks:
 *   - scripts/verify-no-secrets.mjs proves the built dist/ bundle is clean.
 *   - .gitleaks.toml (CI) scans the repo + history for secret patterns.
 *
 * Scope note: historic credential VALUES are allowed to appear in the
 * security documentation (README.md security section) and in the scanner
 * configs themselves — they are detection patterns / incident records for
 * accounts that no longer exist. They are forbidden everywhere in code,
 * SQL, HTML and seeds, which is what these tests enforce.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

let passed = 0;
let failed = 0;
const fail = (name, detail) => {
  failed++;
  console.error(`✖ ${name}\n    ${detail}`);
};
const ok = (name) => {
  passed++;
  console.log(`✔ ${name}`);
};
const check = (name, cond, detail) => (cond ? ok(name) : fail(name, detail));
const read = (p) => readFileSync(p, 'utf8');
/** Strip // line comments and /* block comments *\/ so tests inspect code,
 *  not the security annotations that intentionally name what was removed. */
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/* ------------------------------------------------------------------ */
/* 1. No credentials or forbidden tokens anywhere in code scope         */
/* ------------------------------------------------------------------ */
const CODE_ROOTS = ['src', 'supabase', 'public'];
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.sql', '.html', '.css', '.json', '.svg']);
const codeFiles = ['index.html', 'package.json', 'vite.config.ts', 'metadata.json'].filter(existsSync);
for (const root of CODE_ROOTS) {
  if (!existsSync(root)) continue;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (CODE_EXT.has(extname(full))) codeFiles.push(full);
    }
  }
}

const FORBIDDEN = [
  ['historic owner password "123123"', /123123/],
  ['historic temp PIN "temp1234"', /temp1234/i],
  ['JWT literal', /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\./],
  ['Resend API key', /\bre_[A-Za-z0-9]{16,}\b/],
  ['Stripe secret key', /\bsk_(live|test)_[A-Za-z0-9]{8,}\b/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
// The schema/migrations legitimately DROP the old policy and explain history;
// what must never appear is a statement that CREATES it (checked in §4).
const SQL_CREATE_DEMO = /create\s+policy\s+(")?demo_full_access/i;

{
  const hits = [];
  for (const f of codeFiles) {
    const content = read(f);
    for (const [name, re] of FORBIDDEN) {
      if (re.test(content)) hits.push(`${name} in ${relative('.', f)}`);
    }
  }
  check(
    'code scope contains no known credentials or secret-shaped tokens',
    hits.length === 0,
    hits.join('; ')
  );

  // `service_role` is a PostgreSQL role identifier, not a credential. SQL
  // migrations must be able to grant/revoke it explicitly. What must never
  // ship to the browser is the service-role KEY, its environment variable, or
  // a client-side value pretending to hold it.
  const browserFiles = codeFiles.filter((f) => f === 'index.html' || f.startsWith('src/') || f.startsWith('public/'));
  const serviceKeyHits = browserFiles.filter((f) => /SUPABASE_SERVICE_ROLE_KEY|service[_-]?role[_-]?key|serviceRoleKey/.test(stripComments(read(f))));
  check(
    'browser code contains no service-role credential reference',
    serviceKeyHits.length === 0,
    serviceKeyHits.join(', ')
  );
}

/* ------------------------------------------------------------------ */
/* 2. Client credential model is gone                                    */
/* ------------------------------------------------------------------ */
{
  const types = stripComments(read('src/types.ts'));
  const empBlock = types.slice(types.indexOf('interface EmployeeProfile'), types.indexOf('}', types.indexOf('interface EmployeeProfile')));
  check('EmployeeProfile has no password field', !/password\??\s*:/.test(empBlock), 'password field present in src/types.ts');
  check('EmployeeProfile has no mustChangePassword field', !/mustChangePassword/.test(empBlock), 'mustChangePassword present in src/types.ts');

  const data = read('src/data.ts');
  check('no seeded employees ship with the client', /INITIAL_EMPLOYEES:\s*EmployeeProfile\[\]\s*=\s*\[\s*\]/.test(data), 'INITIAL_EMPLOYEES is not empty in src/data.ts');
  check('src/data.ts contains no password literals', !/password\s*:/.test(data), 'password key found in src/data.ts');
}

/* ------------------------------------------------------------------ */
/* 3. No client-trusted auth / localStorage owner sessions               */
/* ------------------------------------------------------------------ */
{
  // The forgeable session key must never be READ or WRITTEN anywhere in src/
  // (removeItem — the scrub — is the single allowed operation). Scanning the
  // whole tree, not just App.tsx: an earlier draft of this test only checked
  // App.tsx and missed two usages in StaffPortal.tsx.
  const srcCode = codeFiles
    .filter((f) => f.startsWith('src') && ['.ts', '.tsx'].includes(extname(f)))
    .map((f) => [f, stripComments(read(f))]);
  const sessionReads = srcCode.filter(([, c]) => /getItem\(\s*[`'"]milkpop_session[`'"]/.test(c)).map(([f]) => f);
  const sessionWrites = srcCode.filter(([, c]) => /(setItem|saveToStorage)\(\s*[`'"]milkpop_session[`'"]/.test(c)).map(([f]) => f);
  check('sessions are never restored from localStorage (all of src/)', sessionReads.length === 0, 'reads in: ' + sessionReads.join(', '));
  check('session objects are never written to localStorage (all of src/)', sessionWrites.length === 0, 'writes in: ' + sessionWrites.join(', '));

  const app = read('src/App.tsx');
  check(
    'boot scrubs the legacy session key',
    /removeItem\(\s*['"]milkpop_session['"]\s*\)/.test(app),
    'legacy session scrub missing from src/App.tsx'
  );
  check(
    'no client-side password comparison in App.tsx (Block B: auth is server-side)',
    // The empty-password bypass and any in-browser credential check must stay
    // gone. Block B added a sign-in HANDLER that forwards to Supabase Auth
    // (handleStaffSignIn -> signIn), which is allowed; what must never return
    // is a client-side comparison against an employee record's password.
    !/foundEmp\.password/.test(app) &&
      !/\.password\s*===/.test(stripComments(app)) &&
      !/password\s*===\s*.*(emp|employee|found)/i.test(stripComments(app)),
    'client-side password comparison present in src/App.tsx'
  );
  check(
    'staff sign-in delegates to Supabase Auth',
    /handleStaffSignIn/.test(app) && /signIn\(/.test(app),
    'App.tsx does not route sign-in through the Supabase Auth hook'
  );
  check(
    'admin panel is role-gated in the router',
    /admin_panel.*(!employee|employee\s*\|\|)/s.test(app) && app.includes("['owner', 'store_manager'].includes(employee.role)"),
    'admin panel role gate missing in src/App.tsx'
  );

  const portal = read('src/components/StaffPortal.tsx');
  const authPanel = read('src/components/staff/StaffAuthPanel.tsx');
  const portalCode = stripComments(`${portal}\n${authPanel}`);
  // Block B: a sign-in form is now allowed, but it MUST delegate to onSignIn
  // (Supabase Auth) and MUST NOT compare a password client-side, and MUST NOT
  // read the forgeable milkpop_session key.
  check(
    'staff portal sign-in delegates to onSignIn (no client credential check)',
    /onSignIn\s*\(/.test(portalCode) && !/\.password\s*===/.test(portalCode),
    'StaffPortal performs a client-side password check instead of delegating'
  );
  check(
    'staff portal never reads a stored session/profile to authenticate',
    !/getItem\(\s*[`'"]milkpop_session[`'"]/.test(portalCode),
    'StaffPortal reads the forgeable milkpop_session key'
  );
  check(
    'staff portal keeps an honest fail-closed notice when unconfigured',
    authPanel.includes('Sign-in unavailable'),
    'fail-closed notice missing in StaffAuthPanel.tsx'
  );

  const admin = stripComments(read('src/components/AdminPanel.tsx'));
  check('admin panel sets no passwords', !/password\s*:\s*staffFormState|mustChangePassword\s*:\s*true/.test(admin), 'credential-setting code in AdminPanel.tsx');
  check('no fabricated admin identities', !/Administrator Override|HQ OWNER/.test(admin), 'fabricated identity fallback in AdminPanel.tsx');
}

/* ------------------------------------------------------------------ */
/* 4. Database policies: deny-by-default, no wide-open access            */
/* ------------------------------------------------------------------ */
{
  const sqlFiles = ['supabase/schema.FRESH-INSTALL-ONLY.sql', 'supabase/migration_payroll_cv.sql', 'supabase/migration_security_lockdown.sql'];
  for (const f of sqlFiles) {
    const sql = read(f);
    check(`${f}: never creates demo_full_access`, !SQL_CREATE_DEMO.test(sql), 'create policy demo_full_access found');
    check(
      `${f}: no broad FOR ALL using(true) policy`,
      !/create\s+policy[^;]*for\s+all[^;]*using\s*\(\s*true\s*\)/is.test(sql),
      'a FOR ALL … using(true) policy exists'
    );
  }
  const schema = read('supabase/schema.FRESH-INSTALL-ONLY.sql');
  check(
    'schema: the only anon policies are select-on-public (Phase B: no form insert)',
    /public_read on %I for select to anon/.test(schema) && !/create policy public_insert/.test(schema),
    'expected select-only anon policy set missing from schema.FRESH-INSTALL-ONLY.sql'
  );
  const staffBlock = schema.slice(schema.indexOf('create table if not exists staff_profiles'), schema.indexOf(');', schema.indexOf('create table if not exists staff_profiles')));
  check('schema: staff_profiles has no password column', !/^\s*password\s+text/m.test(staffBlock), 'password column still defined');
  check('schema: cvs bucket is private', /\('cvs',\s*'cvs',\s*false\)/.test(schema), 'cvs bucket not created private');
  check('schema: no anonymous CV read policy', !/create policy\s+"cvs_public_read"/.test(schema), 'cvs_public_read policy created');

  const lock = read('supabase/migration_security_lockdown.sql');
  check('lockdown migration nulls then drops plaintext passwords', /set password = null/.test(lock) && /drop column password/.test(lock), 'password destruction steps missing');
  check('lockdown migration privatises the cvs bucket', /set public = false where id = 'cvs'/.test(lock), 'bucket privatisation missing');

  const seed = read('supabase/seed.sql');
  check('seed inserts no staff accounts or passwords', !/insert into staff_profiles/i.test(seed) && !/password/i.test(seed.replace(/--.*$/gm, '')), 'staff/password seed present in seed.sql');
}

/* ------------------------------------------------------------------ */
/* 5. PHASE A — the localStorage mirror is REMOVED, not just disabled.   */
/*    Internal writes exist only as per-domain, authenticated,           */
/*    server-confirmed operations (src/lib/registries.ts).               */
/* ------------------------------------------------------------------ */
{
  const sync = read('src/lib/cloudSync.ts');
  const syncCode = stripComments(sync);
  // (a) The push/deletion-diff engine is gone from the sync layer entirely.
  check('cloudSync contains no push machinery (schedulePush/flushKey)', !/schedulePush|flushKey/.test(syncCode), 'push machinery present in cloudSync');
  check('cloudSync performs no writes (no sbUpsert/sbDeleteByIds imports)', !/sbUpsert|sbDeleteByIds/.test(syncCode), 'write helpers imported by cloudSync');
  check('cloudSync has no deletion diff', !/deletion diff|toDelete/.test(syncCode), 'deletion-diff logic present');
  // (b) Nothing anywhere in src/ schedules a background mirror push.
  const allSrcFiles = codeFiles.filter((f) => f.startsWith('src'));
  const pushCallers = allSrcFiles.filter((f) => /schedulePush\s*\(/.test(stripComments(read(f)))).map((f) => relative('.', f));
  check('no file in src/ calls schedulePush', pushCallers.length === 0, 'callers: ' + pushCallers.join(', '));
  check('the useLocalStorageState mirror hook is deleted', !codeFiles.some((f) => f.endsWith('hooks/useLocalStorageState.ts')), 'hook file still exists');
  // (c) The replacement write path exists, is authenticated, and is confirmed.
  const reg = read('src/lib/registries.ts');
  const regCode = stripComments(reg);
  check('registries.ts sends the caller JWT on every operation', /Authorization: `Bearer \$\{token\}`/.test(reg), 'user-JWT header missing in registries');
  check('registries.ts verifies writes via return=representation', /return=representation/.test(reg) && /did not confirm/.test(reg), 'server confirmation missing');
  check('registries.ts never touches browser storage', !/localStorage|sessionStorage|indexedDB/i.test(regCode), 'browser storage referenced in registries');
  // (d) App state for internal registries is in-memory (hydrated from Supabase).
  const appCode = stripComments(read('src/App.tsx'));
  check('internal registries are plain useState (no storage hook)', !/useLocalStorageState/.test(appCode), 'useLocalStorageState still used in App');
  check('App.tsx has no saveToStorage helper', !/saveToStorage/.test(appCode), 'saveToStorage still present');
  const perfWriters = allSrcFiles.filter((f) => /milkpop_perf_reviews/.test(stripComments(read(f)))).map((f) => relative('.', f));
  check('the local-only performance-review sink is gone', perfWriters.length === 0, 'writers: ' + perfWriters.join(', '));

  // STAGE 2 — every server-mutation handler call site is explicitly awaited
  // (gated success) or explicitly fire-and-forget (`void …`, errors still
  // toast centrally). A bare call that could race a success toast fails here.
  {
    const HANDLERS = [
      'onAddEmployee', 'onUpdateEmployee', 'onDeleteEmployee', 'onAddShift', 'onDeleteShift',
      'onApproveDocument', 'onResolveSIFRReport', 'onUpdateApplicationStatus', 'onUpdateFranchiseStatus',
      'onUpdateOrderStatus', 'onAddDocument', 'onAddSIFRReport', 'onAddSIFRReply', 'onAddCertificate',
      'onCertificateEmailed', 'onUpdateCourse', 'onUpdateAssignment', 'onSaveContent',
      'publishMenuItems', 'publishStores', 'publishVacancies', 'publishNewsPosts', 'publishMediaItems',
      'publishDeals', 'publishChecklistTemplates', 'publishRolePermissions', 'publishClockHistory',
      'publishPayslips', 'publishAssessments', 'publishAssignments', 'publishTrainingAssignments',
      'saveSiteSettings', 'saveEmailSettings', 'saveAppState',
      'onCompleteTraining', 'onUploadDocument', 'onAppendClockHistory', 'onStaffInvite', 'onDeleteDocument',
    ];
    const componentFiles = allSrcFiles.filter((f) => f.includes('components/'));
    const bare = [];
    for (const f of componentFiles) {
      const c = stripComments(read(f));
      for (const name of HANDLERS) {
        const rx = new RegExp(name + String.raw`\??\.?\(`, 'g');
        let m;
        while ((m = rx.exec(c))) {
          const before = c.slice(Math.max(0, m.index - 12), m.index);
          const wide = c.slice(Math.max(0, m.index - 220), m.index);
          const ok = /await\s$/.test(before) || /void\s$/.test(before) || /await\s\($/.test(before) || /\(await\s$/.test(before)
            || /Promise\.all\(\[[^\]]*$/.test(wide); // awaited together via Promise.all([...])
          // Declaration/props/destructuring lines are not calls: `name(...)` in a
          // type position is preceded by ': ' or starts a line with indentation
          // followed by the name and ':' — filter by checking the char right
          // before is not part of a type annotation `: (`.
          const lineStart = c.lastIndexOf('\n', m.index) + 1;
          const line = c.slice(lineStart, c.indexOf('\n', m.index));
          const isTypeOrProp = /:\s*\(/.test(line.split(name)[1] || '') || new RegExp(name + String.raw`\s*[:=]`).test(line) || new RegExp(name + String.raw`=\{`).test(line);
          if (!ok && !isTypeOrProp) bare.push(`${relative('.', f)}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
    check('every mutation-handler call site is awaited or explicit void (Stage 2)', bare.length === 0, '\n    bare: ' + bare.join('\n    bare: '));
  }
  // (e) The mapping metadata still marks staff data private for the anon pull.
  check('staff registry is marked private in the sync map', /table:\s*'staff_profiles',\s*access:\s*'private'/.test(sync), 'staff_profiles not private in SYNC_MAP');
  for (const t of ['payslips', 'clock_history', 'orders', 'staff_documents', 'sifr_reports', 'audit_logs', 'work_shifts']) {
    check(`sync map keeps ${t} private`, new RegExp(`table:\\s*'${t}',\\s*access:\\s*'private'`).test(sync), `${t} not private`);
  }
  check('pull only touches public_read tables', /SYNC_MAP\.filter\(\(m\) => m\.access === 'public_read'\)/.test(sync), 'pull filter missing');
}

/* ------------------------------------------------------------------ */
/* 5c. STAGE 3 — staff documents live in PRIVATE Storage, never base64  */
/* ------------------------------------------------------------------ */
{
  const mig = read('supabase/migration_staff_documents_storage.sql');
  check('staff-documents bucket is created PRIVATE', /\('staff-documents', 'staff-documents', false\)/.test(mig) && /do update set public = false/.test(mig), 'bucket not forced private');
  check('the base64 url column is dropped', /drop column if exists url/.test(mig), 'url column survives');
  check('client INSERT/DELETE on staff_documents are revoked', /revoke insert, update, delete on staff_documents from authenticated/.test(mig), 'grants not revoked');
  check('manager update is column-limited to verification fields', /grant\s+update \(status, approved_by, verified_by, verified_at, expiry_date\)/.test(mig), 'column grant missing');
  check('document SELECT is self / manager-store / owner scoped', /docs_select_self_or_mgr/.test(mig) && /employee_id = current_staff_id\(\)/.test(mig) && /current_staff_store\(\)/.test(mig), 'scoped select policy missing');

  const up = read('supabase/functions/staff-doc-upload/index.ts');
  check('doc upload sniffs magic bytes and ignores client MIME/extension', /SIG_PDF/.test(up) && /SIG_JPG/.test(up) && /SIG_PNG/.test(up) && /sniffDocType\(buf\)/.test(up), 'magic-byte sniffing missing');
  check('doc upload builds the controlled storage path server-side', /stores\/\$\{target\.store_id[^}]*\}\/employees\/\$\{target\.id\}/.test(up), 'controlled path missing');
  check('doc upload enforces self / manager-store / owner ownership', /isSelf/.test(up) && /isMgrSameStore/.test(up) && /store_id/.test(up), 'ownership check missing');
  check('doc upload rolls the object back if metadata fails', /metadata_failed/.test(up) && /method: 'DELETE'/.test(up), 'orphan rollback missing');
  check('doc upload never trusts a client path or upserts', /'x-upsert': 'false'/.test(up) && !/form\.get\('path'\)/.test(up), 'path trust / upsert issue');

  const urlFn = read('supabase/functions/staff-doc-url/index.ts');
  check('signed URLs are short-lived and access-checked', /SIGNED_URL_TTL_SECONDS = 60/.test(urlFn) && /not_authorised/.test(urlFn), 'signed-url controls missing');

  // The app never builds base64 documents or persists a signed URL.
  const sp = stripComments(read('src/components/StaffPortal.tsx'));
  check('StaffPortal no longer base64-encodes documents', !/readAsDataURL/.test(sp), 'FileReader base64 path still present');
  const typ = read('src/types.ts');
  check('StaffDocument has no url field', !/^\s*url: string;/m.test(typ.slice(typ.indexOf('interface StaffDocument'), typ.indexOf('}', typ.indexOf('interface StaffDocument')))), 'url field still on StaffDocument');
}

/* ------------------------------------------------------------------ */
/* 5d. STAGE 4 — per-employee training, server-side rewards            */
/* ------------------------------------------------------------------ */
{
  const mig = read('supabase/migration_stage4_training.sql');
  check('per-employee training_progress table exists with self-pinned writes',
    /create table if not exists training_progress/.test(mig) && /id = current_staff_id\(\) \|\| ':' \|\| course_id/.test(mig),
    'training_progress table/policies missing');
  check('training_results are server-written only (no client insert grant)',
    /create table if not exists training_results/.test(mig) && /revoke insert, update, delete on training_results from authenticated/.test(mig),
    'training_results write lock missing');
  check('complete_training RPC is SECURITY DEFINER, idempotent, authenticated-only',
    /create or replace function complete_training/.test(mig) && /security definer/.test(mig)
      && /submission_id = p_submission_id/.test(mig) && /return v_existing.response/.test(mig)
      && /grant execute on function complete_training\(text, int, text, text\) to authenticated/.test(mig),
    'RPC contract incomplete');
  check('reward columns are trigger-locked outside the RPC',
    /staff_profiles_protect/.test(mig) && /protected_reward_columns/.test(mig) && /reward_grant_active\(\)/.test(mig),
    'staff_profiles protection trigger missing');
  check('assignments are trigger-locked (self may only start, never re-point/complete)',
    /training_assignments_protect/.test(mig) && /assignment_status_locked/.test(mig),
    'assignment protection trigger missing');
  check('certificates cannot be inserted by the browser',
    /revoke insert, delete on training_certificates from authenticated/.test(mig),
    'certificate insert not revoked');
  check('one certificate per (employee, assessment) is enforced by a unique index',
    /uq_tcert_emp_assess/.test(mig) && /on conflict \(employee_id, assessment_id\) do nothing/.test(mig),
    'certificate uniqueness missing');

  const appSrc = stripComments(read('src/App.tsx'));
  check('the app no longer writes points/badges on quiz completion',
    !/handleAddCertificate/.test(appSrc) && /callRpc<[^>]*>\('complete_training'/.test(appSrc),
    'client-side reward path still present');
  const spSrc = stripComments(read('src/components/staff/StaffAcademyPanel.tsx'));
  check('StaffPortal quiz completion is one server transaction with a stable submission id',
    /onCompleteTraining\(\{/.test(spSrc) && /submissionId/.test(spSrc) && !/onAddCertificate/.test(spSrc),
    'quiz flow not routed through the RPC');
}

/* ------------------------------------------------------------------ */
/* 5e. STAGE 5 — app_state is scoped; the RPC is the only write path   */
/* ------------------------------------------------------------------ */
{
  const mig = read('supabase/migration_stage5_app_state.sql');
  check('app_state gains scope/owner/store columns with backfill',
    /add column if not exists scope/.test(mig) && /owner_staff_id/.test(mig) && /like 'milkpop_clock_status_%'/.test(mig),
    'scope columns/backfill missing');
  check('direct client writes to app_state are revoked',
    /revoke insert, update, delete on app_state from authenticated/.test(mig),
    'direct write grant survives');
  check('set_app_state allow-lists keys and pins clock keys to the caller',
    /function set_app_state/.test(mig) && /not_your_clock_key/.test(mig) && /key_not_allowed/.test(mig) && /owner_only_key/.test(mig),
    'RPC allow-list incomplete');
  check('app_state reads are scope-aware (user/store/global)',
    /appstate_select_scope/.test(mig) && /scope = 'store'/.test(mig),
    'scoped select policy missing');
  const reg = stripComments(read('src/lib/registries.ts'));
  check('the client writes app_state ONLY via the RPC',
    /rpc\/set_app_state/.test(reg) && !/app_state\?on_conflict=key/.test(reg),
    'direct app_state upsert still in the client');
}

/* ------------------------------------------------------------------ */
/* 5f. STAGE 6 — financial adjustments are not client operations       */
/* ------------------------------------------------------------------ */
{
  const appSrc = stripComments(read('src/App.tsx'));
  check('deferred order mutation controllers are absent from the public app',
    !/handleUpdateOrderStatus|handleOrderConfirmed|ordersRepo\.upsert/.test(appSrc),
    'public app still mounts a deferred order controller');
  const adm = stripComments(read('src/components/AdminPanel.tsx'));
  const salesPanel = stripComments(read('src/components/admin/SalesPanel.tsx'));
  check('deferred POS sales tooling is not routed and has no refund/void mutation buttons',
    !/<SalesPanel\b/.test(adm)
    && !/onUpdateOrderStatus|onRefund|onVoid/.test(salesPanel)
    && /Refund — on the till only/.test(salesPanel)
    && /Void — on the till only/.test(salesPanel),
    'deferred sales tooling is routed or refund/void buttons are wired');
  check('signed-in hydration does not fetch deferred order data',
    !/bundle\.orders|orderOutbox|INITIAL_ORDERS/.test(appSrc),
    'public-web app still hydrates deferred POS/order state');
}

/* ------------------------------------------------------------------ */
/* 5g. STAGE 7 — collection publishing is one transaction              */
/* ------------------------------------------------------------------ */
{
  const mig = read('supabase/migration_stage7_replace_collection.sql');
  check('replace_collection is SECURITY INVOKER (RLS authorises every step)',
    /function replace_collection/.test(mig) && /security invoker/.test(mig),
    'RPC missing or definer-rights');
  check('replace_collection allow-lists publishable tables only',
    /table_not_allowed/.test(mig) && /when 'role_permissions'\s+then 'role'/.test(mig) && !/when 'staff_profiles'/.test(mig),
    'allow-list wrong');
  check('replace_collection verifies the final state (undeletable rows abort)',
    /stale_rows_not_deletable/.test(mig),
    'contract check missing');
  const appSrc = stripComments(read('src/App.tsx'));
  // R4.10: the pinned call gained a REQUIRED fourth argument — the snapshot
  // total (`current.length`, the server-hydrated copy's count). The property
  // this assertion protects is unchanged and now stronger: publishers use the
  // atomic RPC, STATE what they hydrated so a stale snapshot is refused
  // server-side, and commit only the collection the server returned.
  // INC11: the pin strengthens again — the publisher now states the snapshot
  // TOTAL and the collection REVISION it hydrated, and commits the server's
  // returned rows (the {revision, rows} contract). Same protected property,
  // third ratchet turn.
  check('publishers call the atomic RPC and commit the SERVER collection',
    /replaceCollection<T>\(storageKey, resolved, token, current\.length,\s*collectionRevisions\[table\] \?\? null\)/.test(appSrc) && /commit\(saved\.rows\)/.test(appSrc) && !/for \(const r of removed\) await repo\.remove/.test(appSrc),
    'delete-then-upsert sequence still present');
  const spSrc = stripComments(read('src/components/staff/StaffDashboardPanel.tsx'));
  // FIX-10 (audit OPS-001): strictly stronger than the old append-one-row
  // check — clock-out now runs entirely server-side via staff_clock_action()
  // (server timestamps + atomic history insert). The portal must call the
  // RPC wrapper, never replace the collection, and never write clock status
  // keys through saveAppState (the server rejects them anyway).
  check('staff clock-out appends ONE row (no collection replacement)',
    /onClockAction\('clock_out'/.test(spSrc)
      && !/publishClockHistory/.test(spSrc)
      && !/saveAppState\(`milkpop_clock_status_/.test(spSrc),
    'clock-out still replaces the collection or writes clock keys client-side');
}

/* ------------------------------------------------------------------ */
/* 5h. STAGE 8 — empty server collections are authoritative            */
/* ------------------------------------------------------------------ */
{
  const appSrc = read('src/App.tsx');
  const hydStart = appSrc.indexOf('if (bundle.employees)');
  const hydEnd = appSrc.indexOf('bundle.failures.length');
  const hyd = appSrc.slice(hydStart, hydEnd);
  check('sign-in hydration has NO non-empty guards (server empty replaces defaults)',
    hyd.length > 0 && !/&&\s*bundle\.[A-Za-z]+\.length/.test(hyd),
    'a .length guard survives in the hydration block');
  check('public pull applies EMPTY arrays (only failures keep the seeds)',
    !/Array\.isArray\(data\[key\]\) \|\| data\[key\]\.length > 0/.test(appSrc),
    'empty-array skip survives in applyCloudData');
  const seedMig = read('supabase/migration_stage8_permission_seed.sql');
  check('the default permission matrix is guaranteed by an idempotent migration',
    /insert into role_permissions/.test(seedMig) && /on conflict \(role\) do nothing/.test(seedMig),
    'permission seed migration missing');
}

/* ------------------------------------------------------------------ */
/* 5i. STAGE 9 — onboarding is a protected server pipeline             */
/* ------------------------------------------------------------------ */
{
  const fn = read('supabase/functions/staff-invite/index.ts');
  check('staff-invite verifies the caller and scopes managers to their store',
    /auth\/v1\/user/.test(fn) && /other_store/.test(fn) && /peer_or_higher_target/.test(fn),
    'caller/store checks missing');
  const lifecycleFn = read('supabase/functions/employee-access-revoke/index.ts');
  const lifecycleClient = read('src/lib/staffInvite.ts');
  const lifecycleMigration = read('supabase/migration_t13319_release_integrity.sql');
  check('disable/enable use owner-authorised recovery intents and confirmed Auth changes',
    /request_recovery_action/.test(lifecycleClient) && /employee-access-revoke/.test(lifecycleClient)
      && /disable_account/.test(lifecycleFn) && /enable_account/.test(lifecycleFn)
      && /p_action in\('disable_account','enable_account'\)[\s\S]{0,180}is_owner/.test(lifecycleMigration),
    'owner-only recovery lifecycle controls missing');
  check('existing e-mail handling distinguishes active and unconfirmed Auth users truthfully',
    /findByEmail/.test(fn) && /existing_active_account_linked/.test(fn)
      && /admin\/generate_link/.test(fn) && /auth_truth_unavailable/.test(fn),
    'truthful existing-user handling missing');
  check('no shared temporary passwords are created',
    !/password/i.test(fn.replace(/service_role_key/gi, '')),
    'a password path exists in staff-invite');
  const mig = read('supabase/migration_stage9_staff_onboarding.sql');
  check('lifecycle columns exist and helpers are disabled-aware',
    /add column if not exists onboarding/.test(mig) && /status, 'active'\) <> 'disabled'/.test(mig),
    'lifecycle columns/helpers missing');
  const adm = stripComments(read('src/components/AdminPanel.tsx'));
  check('the directory shows honest lifecycle labels (no "fully onboarded" claims)',
    /onboardingLabel/.test(adm) && !/fully onboarded/i.test(adm),
    'honest lifecycle labels missing');
  const appSrc = stripComments(read('src/App.tsx'));
  check('the browser never assigns roles or touches admin auth endpoints',
    !/auth\/v1\/admin/.test(appSrc) && !/auth\/v1\/invite/.test(appSrc),
    'admin auth endpoint referenced in the client');
}

/* ------------------------------------------------------------------ */
/* 5j. STAGES 10–11 — incident identity + authoritative audit          */
/* ------------------------------------------------------------------ */
{
  const m10 = read('supabase/migration_stage10_rls_hardening.sql');
  check('incident reporter identity is pinned to the verified session',
    /sifr_reports_stamp/.test(m10) && /new\.reporter_id\s+:= v_id/.test(m10) && /reporter_id = current_staff_id\(\)/.test(m10),
    'reporter pinning missing');
  check('manager incident access is store-scoped (owner spans stores)',
    /sifr_report_store\(sifr_reports\) = current_staff_store\(\)/.test(m10),
    'store scoping missing');
  const m11 = read('supabase/migration_stage11_server_audit.sql');
  check('audit actor identity is server-derived (client values discarded)',
    /audit_logs_stamp/.test(m11) && /new\.operator_name := coalesce\(v_name, v_id\)/.test(m11),
    'audit stamping trigger missing');
  check('audit rows are append-only for browser clients',
    /revoke update, delete on audit_logs from authenticated/.test(m11),
    'audit update/delete grants survive');
  check('the Edge-Function activity log is owner-readable, server-written only',
    /activity_select_owner/.test(m11) && /revoke insert, update, delete on activity_log from authenticated/.test(m11),
    'activity_log exposure wrong');
  const m7 = read('supabase/migration_stage7_replace_collection.sql');
  check('collection publication writes a server-derived audit row',
    /Published collection/.test(m7),
    'publication audit missing');
}

/* ------------------------------------------------------------------ */
/* 5k. POST-STAGE-12 FIXES 1–5                                         */
/* ------------------------------------------------------------------ */
{
  // #1 — manager staff writes: store-scoped policy; no self-award; pay stays owner-only.
  const m1 = read('supabase/migration_manager_staff_writes.sql');
  check('managers get a store-scoped staff_profiles update policy (never owners/self)',
    /staff_profiles_update_mgr/.test(m1) && /role <> 'owner'/.test(m1) && /id <> current_staff_id\(\)/.test(m1),
    'manager write policy wrong');
  const m4 = read('supabase/migration_stage4_training.sql');
  check('reward columns move for managers only on SOMEONE ELSE’S row',
    (m4.match(/old\.id is distinct from current_staff_id\(\)/g) || []).length >= 2,
    'no-self-award clause missing');
  const adm = stripComments(read('src/components/AdminPanel.tsx'));
  const auditPanel = stripComments(read('src/components/admin/AuditPanel.tsx'));
  check('pay controls render for owners only (honest UI)',
    /Contract pay is owner-only/.test(adm),
    'pay controls not owner-gated');

  // #2 — server-side grading.
  const g = read('supabase/migration_server_grading.sql');
  check('the old 4-arg complete_training overload is dropped',
    /drop function if exists complete_training\(text, int, text, text\);/.test(g),
    'old overload survives');
  check('answers are graded server-side (choice + drag, order-pinned)',
    /grade_training_answers/.test(g) && /order by m\.ord/.test(g) && /order by e\.ord/.test(g) && /'serverGraded', v_graded/.test(g),
    'grading function incomplete');
  const spSrc = stripComments(read('src/components/staff/StaffAcademyPanel.tsx'));
  check('the quiz sends the ANSWERS; the local score is advisory',
    /answers,\n/.test(spSrc) && /dragPlacedWords\(q, academyDragAnswers\[i\]/.test(spSrc),
    'answers not sent to the RPC');
  const appSrc = stripComments(read('src/App.tsx'));
  check('the app forwards p_answers to the RPC',
    /p_answers: args\.answers \?\? null/.test(appSrc),
    'p_answers not forwarded');

  // #3 — owner-only controlled deletion.
  const df = read('supabase/functions/staff-doc-delete/index.ts');
  check('document deletion is owner-only, object-first and tombstone-finalised',
    /String\(caller\.role\) !== 'owner'/.test(df) && /doc_delete/.test(df)
      && /!deletion\.ok && deletion\.status !== 404/.test(df)
      && df.indexOf('/storage/v1/object/') < df.indexOf('rpc/finalize_staff_document_deletion'),
    'delete function contract wrong');
  check('the vault delete button is owner-gated with a hard confirm',
    /Permanently remove/.test(adm) && /audit tombstone retained/.test(adm) && /onDeleteDocument/.test(adm),
    'vault delete UI missing');

  // #4 — the server access log is visible to the owner.
  check('the access-log panel exists, owner-gated, load-on-demand',
    /Server access log/.test(auditPanel) && /currentRole === 'owner'/.test(auditPanel) && /listActivityLog/.test(auditPanel),
    'access log panel missing');

  // #5 — per-staff upload rate limit.
  const up = read('supabase/functions/staff-doc-upload/index.ts');
  check('document uploads are rate-limited per staff member',
    /RATE_PER_STAFF_PER_HOUR/.test(up) && /rate_limited/.test(up) && /rpc\/reserve_anonymous_rate/.test(up) && /staff_doc_upload/.test(up),
    'upload rate limit missing');
}

/* ------------------------------------------------------------------ */
/* 5b. PHASE B — the public-form direct-insert path is closed on BOTH   */
/*     sides: no client fallback (asserted in 9b) and no database        */
/*     policy/grant for a handcrafted anonymous REST INSERT.             */
/* ------------------------------------------------------------------ */
{
  const mig = read('supabase/migration_phase_b_public_forms.sql');
  check('phase B migration drops the public_insert policy on all three form tables',
    /drop policy if exists public_insert/.test(mig) && /'job_applications','franchise_inquiries','contact_messages'/.test(mig),
    'policy drop missing');
  check('phase B migration revokes INSERT from anon and authenticated',
    /revoke insert on %I from anon/.test(mig) && /revoke insert on %I from authenticated/.test(mig),
    'grant revocation missing');
  check('phase B migration never (re)creates an insert policy',
    !/create policy [^\n]*for insert/i.test(mig),
    'an insert policy is created in the phase B migration');
  const live = read('scripts/public-form-rejection.live.mjs');
  // Stage 1 — deployment path: fresh installs end secure, and every
  // deployment source carries the Phase B migration.
  const schemaSql = read('supabase/schema.FRESH-INSTALL-ONLY.sql');
  check('fresh schema creates NO public_insert policy',
    !/create policy public_insert/.test(schemaSql),
    'schema.FRESH-INSTALL-ONLY.sql still creates the direct-insert policy');
  check('fresh schema revokes form INSERT from anon and authenticated',
    /revoke insert on %I from anon/.test(schemaSql) && /revoke insert on %I from authenticated/.test(schemaSql),
    'schema.FRESH-INSTALL-ONLY.sql grant revocation missing');
  // OPT-01.1: the migration order now lives in the authoritative manifest
  // (launch/migration-manifest.sh); launch.sh sources it and keeps no copy.
  const manifestSh = read('launch/migration-manifest.sh');
  check('migration manifest lists the Phase B migration LAST',
    /migration_phase_b_public_forms\.sql"\s*\n\s*\)/.test(manifestSh),
    'phase B migration missing from or not last in MP_MIGRATIONS');
  check('migration manifest includes the POS migrations',
    /migration_pos_sync\.sql/.test(manifestSh) && /migration_pos_catalog\.sql/.test(manifestSh),
    'POS migrations missing from the migration manifest');
  for (const doc of ['README.md', 'OWNERS-GUIDE.md', 'docs/GATE10-RUNBOOK.md']) {
    check(`${doc} documents the Phase B migration`, /migration_phase_b_public_forms/.test(read(doc)), `phase B not documented in ${doc}`);
  }
    check('a live rejection probe exists for Phase C',
    /rest\/v1\/\$\{table\}/.test(live)
      && /'job_applications'/.test(live) && /'franchise_inquiries'/.test(live) && /'contact_messages'/.test(live)
      && /401/.test(live) && /403/.test(live),
    'live probe script missing or incomplete');
}

/* ------------------------------------------------------------------ */
/* 6. E-mail is rebuilt to the secure spec (Block C)                     */
/*    The relay is gone; these pin every control that replaced it so the */
/*    open-relay shape cannot quietly return.                            */
/* ------------------------------------------------------------------ */
{
  const fn = read('supabase/functions/send-email/index.ts');
  const tpl = read('supabase/functions/send-email/templates.ts');
  const notify = read('src/lib/notify.ts');

  // (a) Caller authentication — verified staff USER token, anon key rejected.
  check(
    'send-email requires a verified user JWT and rejects the anon key',
    /\/auth\/v1\/user/.test(fn) && /token === ANON/.test(fn) && /Authentication required/.test(fn),
    'no user-token verification / anon key not rejected',
  );
  // (b) Role comes from the DB, never the client, and gates each template.
  check(
    'send-email derives the caller role from the database and gates by role',
    /staff_profiles\?auth_id=eq\./.test(fn) && /roleAtLeast/.test(fn),
    'caller role not looked up server-side / no role gate',
  );
  // (c) Recipient allow-listing — resolved from a DB row, never a client address.
  check(
    'send-email resolves recipients from DB rows (no client-supplied address)',
    /RECIPIENT_SOURCES/.test(fn) && !/\binput\.to\b|\bpayload\.to\b|\bbody\.to\b/.test(fn),
    'a client-supplied recipient-address path exists',
  );
  // (d) Server-side templates — the client never provides HTML.
  check(
    'send-email renders server-side templates and never reads client HTML',
    /tpl\.render/.test(fn) && !/\binput\.html\b|\bpayload\.html\b|\bbody\.html\b/.test(fn),
    'client HTML is read by the function',
  );
  // (e) Per-caller AND per-recipient rate limits.
  check(
    'send-email enforces per-caller and per-recipient rate limits',
    /RATE_CALLER_PER_HOUR/.test(fn) && /RATE_RECIPIENT_PER_HOUR/.test(fn) &&
      /rate_limited_caller/.test(fn) && /rate_limited_recipient/.test(fn),
    'rate-limit checks missing',
  );
  // (f) An audit row per send.
  check(
    'send-email durably reserves and finalises one email_log row per provider attempt',
    /rpc\/reserve_email_send/.test(fn) && /patchLog/.test(fn)
      && /status: 'sent'/.test(fn) && /status: 'provider_error'/.test(fn),
    'durable audit reservation/finalisation missing',
  );
  // (g) Templates escape every interpolated value (no HTML injection via params).
  check(
    'server-side templates HTML-escape interpolated values',
    /&amp;/.test(tpl) && /&lt;/.test(tpl) && /&gt;/.test(tpl) && /export const esc/.test(tpl),
    'template escaper missing/incomplete',
  );
  // (h) The client sends template ids + params only — no HTML builders remain.
  check(
    'client sends template ids, not HTML, and the kill-switch is lifted correctly',
    /EMAIL_SENDING_DISABLED = false/.test(notify) &&
      /templateId/.test(notify) &&
      !/payslipEmailHtml|newShiftEmailHtml|genericEmailHtml/.test(notify) &&
      !/\bhtml:\s*/.test(notify),
    'client still builds HTML, or kill-switch not lifted',
  );

  // (i) The audit table migration exists, is owner-read-only, and is not
  //     writable/alterable from any browser role (append-only from the client).
  const mig = existsSync('supabase/migration_email_log.sql') ? read('supabase/migration_email_log.sql') : '';
  check(
    'email_log migration exists and is owner-read only',
    /create table if not exists email_log/.test(mig) && /email_log_select_owner/.test(mig) &&
      /is_owner\(\)/.test(mig),
    'email_log migration missing or not owner-gated',
  );
  check(
    'email_log cannot be written or altered by anon/authenticated (client) roles',
    /revoke all on email_log from anon/i.test(mig) &&
      /revoke insert, update, delete on email_log from authenticated/i.test(mig) &&
      !/for insert to (anon|authenticated)/i.test(mig) &&
      !/for (update|delete) to (anon|authenticated)/i.test(mig),
    'a client role can write/alter email_log',
  );
}

/* ------------------------------------------------------------------ */
/* 7. Unsupported claims and false success states removed                */
/* ------------------------------------------------------------------ */
{
  const CLAIMS = [
    ['"GDPR Verified" badge', /GDPR Verified/],
    ['"All GDPR checks" claim', /All GDPR checks/],
    ['"purged under UK GDPR" toast', /purged under UK GDPR/i],
    ['absolute "strict accordance" compliance claim', /operates in strict accordance/i],
    ['fake franchise "legal assessment generating" toast', /guidelines are now generating/i],
  ];
  const srcFiles = codeFiles.filter((f) => f.startsWith('src'));
  const hits = [];
  for (const f of srcFiles) {
    const c = read(f);
    for (const [name, re] of CLAIMS) if (re.test(c)) hits.push(`${name} in ${relative('.', f)}`);
  }
  check('no unsupported compliance claims or fake-success copy in src/', hits.length === 0, hits.join('; '));
  check(
    'README no longer claims the repo was scanned clean',
    !/no hardcoded API keys or secrets/i.test(read('README.md')),
    'false scan claim still in README.md'
  );
}

/* ------------------------------------------------------------------ */
/* 8. Guard-rail files exist                                             */
/* ------------------------------------------------------------------ */
{
  for (const f of ['.env.example', '.gitignore', '.gitleaks.toml', 'README.md', 'OWNERS-GUIDE.md', '.github/workflows/security.yml', 'supabase/seed.dev.sql', 'supabase/functions/tsconfig.json', 'supabase/functions/deno.d.ts', 'src/vite-env.d.ts', 'scripts/runtime-allowlist.test.ts']) {
    check(`${f} exists`, existsSync(f), 'missing');
  }
  const env = read('.env.example');
  // OPT-01.1 §2: .env.example now carries the OPT-01 contract — the flag/mode
  // defaults (false/development/…) are REQUIRED, but no real secret may appear.
  // Credential-bearing variables stay blank; nothing assigns a secret-like value.
  const blankRequired = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_TURNSTILE_SITE_KEY'];
  check('.env.example leaves credential-bearing vars blank (URL / anon key / site key)',
    blankRequired.every((k) => new RegExp(`^${k}=\\s*$`, 'm').test(env)),
    'a credential-bearing variable carries a value in .env.example');
  const ALLOWED = new Set(['false', 'true', 'development', 'preview', 'production']);
  const secretish = env.split('\n')
    .map((l) => l.match(/^([A-Z0-9_]+)=(.+?)\s*$/))
    .filter(Boolean)
    .filter((m) => !ALLOWED.has(m[2].trim()) && /[A-Za-z0-9]{12,}/.test(m[2]));
  check('.env.example contains no secret-like values (only blanks or controlled defaults)',
    secretish.length === 0, `secret-like value(s): ${secretish.map((m) => m[1]).join(', ')}`);
  const gi = read('.gitignore');
  check('.gitignore blocks env files but keeps the example', /^\.env$/m.test(gi) && /^\.env\.\*$/m.test(gi) && /^!\.env\.example$/m.test(gi), 'env ignore rules incomplete');
}


/* ------------------------------------------------------------------ */
/* 9. Phase 1 REVIEW remediation — public forms, config, CV, seeds      */
/* ------------------------------------------------------------------ */
{
  const app = stripComments(read('src/App.tsx'));
  const pub = stripComments(read('src/components/PublicPages.tsx'));
  const sb = stripComments(read('src/lib/supabase.ts'));
  const sbRaw = read('src/lib/supabase.ts');
  const adminRaw = read('src/components/AdminPanel.tsx');
  const typesSrc = stripComments(read('src/types.ts'));
  const allSrc = codeFiles
    .filter((f) => f.startsWith('src'))
    .map((f) => [f, stripComments(read(f))]);

  /* 9a. Public forms & CVs never touch browser storage ---------------- */
  const FORM_KEYS = ['milkpop_apps', 'milkpop_fran', 'milkpop_contacts'];
  {
    const persistHits = [];
    for (const [f, c] of allSrc) {
      for (const k of FORM_KEYS) {
        if (new RegExp(`(setItem|saveToStorage|useLocalStorageState[^\\n]*)\\(\\s*['"\`]${k}`).test(c)) {
          persistHits.push(`${k} persisted in ${relative('.', f)}`);
        }
      }
    }
    check('public-form registries are never persisted to browser storage', persistHits.length === 0, persistHits.join('; '));
    for (const k of FORM_KEYS) {
      check(`boot scrub purges legacy ${k}`, new RegExp(`removeItem\\(\\s*['"]${k}['"]\\s*\\)`).test(app), `removeItem('${k}') missing from App.tsx`);
    }
    check('applications/franchise/contacts state is plain in-memory useState', /useState<JobApplication\[\]>\(\[\]\)/.test(app) && /useState<FranchiseInquiry\[\]>\(\[\]\)/.test(app) && /useState<ContactMessage\[\]>\(\[\]\)/.test(app), 'in-memory state declarations missing');
    const otherStores = allSrc.filter(([, c]) => /sessionStorage|indexedDB/i.test(c)).map(([f]) => relative('.', f));
    check('no sessionStorage/IndexedDB usage anywhere in src/', otherStores.length === 0, otherStores.join(', '));
    check('JobApplication type carries no CV file fields', !/cv(Name|Url|Data)\s*\??:/.test(typesSrc), 'cvName/cvUrl/cvData present in src/types.ts');
    // Scope: the review forbids base64/file capture for PUBLIC-FORM data (CVs,
    // applications, enquiries, messages). The CMS image picker and the staff
    // document upload (behind the fail-closed auth wall) are separate features
    // and are asserted not to produce cv fields instead.
    check('no FileReader/base64 encoding in the public-form path', !/FileReader|readAsDataURL/.test(pub) && !/FileReader|readAsDataURL/.test(app), 'file encoding present in PublicPages/App');
    const cvBuilders = allSrc.filter(([, c]) => /cv(Data|Url)\s*[:=]/.test(c)).map(([f]) => relative('.', f));
    check('nothing constructs cvData/cvUrl fields anywhere in src/', cvBuilders.length === 0, cvBuilders.join(', '));
  }

  /* 9b. Success only after a confirmed database insert ---------------- */
  {
    const fnStart = sb.indexOf('async function submitPublicForm');
    const fnBody = fnStart >= 0 ? sb.slice(fnStart, sb.indexOf('\n}', fnStart)) : '';
    check('submitPublicForm exists and is NOT exported', fnStart >= 0 && !/export\s+(async\s+)?function submitPublicForm/.test(sb), 'missing or exported');
    check('submitPublicForm returns not_configured before any network call', /if \(!isCloudConfigured\(\)\) return \{ status: 'not_configured' \}/.test(fnBody), 'not_configured branch missing');
    // PHASE B: the direct anonymous INSERT fallback is REMOVED. `submitted`
    // exists exactly once, gated on the Edge Function's ok response; nothing
    // in the function POSTs to a table via the REST helper any more.
    check('submitPublicForm never performs a direct table INSERT', !/await rest</.test(fnBody), 'direct REST insert present in submitPublicForm');
    const submittedCount = (fnBody.match(/status: 'submitted'/g) || []).length;
    // WP-01: the gate is now STRONGER than the old `res.ok` shape — `submitted`
    // additionally requires ok:true in the body AND a validated server UUID.
    check("`submitted` is produced exactly once (Edge Function ok path)", submittedCount === 1 && /data\?\.ok === true && SERVER_UUID_RX\.test\(sid\)/.test(fnBody) && /return \{ status: 'submitted', submissionId: sid \};/.test(fnBody), 'submitted not solely gated on the validated Edge Function response');
    check('public form submits route through the public-form Edge Function', /functions\/v1\/public-form/.test(fnBody), 'public-form edge function path missing');
    check('an undeployed Edge Function fails CLOSED (404/501 -> controlled error)', /res\.status === 404 \|\| res\.status === 501/.test(fnBody) && !/fall through/.test(fnBody), '404/501 handling missing or falls back');
    for (const setter of ['setApplications', 'setFranchiseInquiries', 'setContactMessages']) {
      // WP-01: the setter moved inside a gated block so the session row can
      // adopt the SERVER-minted id. Both the old single-line and the gated
      // block shape satisfy the invariant: the setter fires ONLY on submitted.
      check(`${setter} only fires on status === 'submitted'`, new RegExp(`if \\(result\\.status === 'submitted'\\) \\{?\\s*${setter}`).test(app), `ungated ${setter} in App.tsx submission handler`);
    }
    check('form success toast is gated on submitted', /result\.status === 'submitted'/.test(pub), 'reportSubmission not gated in PublicPages');
  }

  /* 9c. No-backend mode states that nothing was submitted or stored ---- */
  check('not_configured message says nothing was submitted or stored', /nothing was submitted or stored/.test(pub), 'honest not_configured copy missing from PublicPages');

  /* 9d. Production Supabase config cannot come from localStorage ------- */
  {
    check('no saveSupabaseConfig anywhere in src/', allSrc.every(([, c]) => !/saveSupabaseConfig/.test(c)), 'a config writer still exists');
    const cfgWriters = allSrc.filter(([, c]) => /setItem\(\s*['"`]milkpop_supabase_config/.test(c)).map(([f]) => relative('.', f));
    check('nothing writes milkpop_supabase_config', cfgWriters.length === 0, cfgWriters.join(', '));
    // The single read of the dev override key must sit inside the if (env.DEV) block.
    const readers = allSrc.filter(([, c]) => /localStorage\.getItem\(DEV_CONFIG_KEY\)|localStorage\.getItem\(\s*['"`]milkpop_supabase_config/.test(c)).map(([f]) => relative('.', f));
    check('only lib/supabase.ts reads the dev override key', readers.length === 1 && readers[0] === 'src/lib/supabase.ts', 'unexpected readers: ' + readers.join(', '));
    const devIdx = sb.indexOf('if (env.DEV) {');
    const getIdx = sb.indexOf('localStorage.getItem(DEV_CONFIG_KEY)');
    let devEnd = -1;
    if (devIdx >= 0) {
      let depth = 0;
      for (let i = sb.indexOf('{', devIdx); i < sb.length; i++) {
        if (sb[i] === '{') depth++;
        else if (sb[i] === '}') { depth--; if (depth === 0) { devEnd = i; break; } }
      }
    }
    check('the localStorage override is guarded by import.meta.env.DEV', devIdx >= 0 && getIdx > devIdx && getIdx < devEnd, 'dev override not inside the DEV guard');
    check('env vars are the production config source', /env\.VITE_SUPABASE_URL && env\.VITE_SUPABASE_ANON_KEY/.test(sb), 'env-var branch missing');
    check('Admin UI no longer offers browser database configuration', !/saveSupabaseConfig|sbHealthCheck|placeholder="https:\/\/xxxx\.supabase\.co"|Save & test connection/.test(adminRaw), 'browser config UI remnants in AdminPanel.tsx');
  }

  /* 9e. Public insert helpers cannot target internal tables ------------ */
  {
    check('generic sbInsertPublic is gone', allSrc.every(([, c]) => !/sbInsertPublic\s*\(/.test(c)), 'a call/definition of sbInsertPublic remains');
    const listMatch = sbRaw.match(/PUBLIC_INSERT_TABLES = \[([\s\S]*?)\] as const/);
    const tables = listMatch ? [...listMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
    check('allowlist is exactly the three public form tables', tables.length === 3 && tables.includes('job_applications') && tables.includes('franchise_inquiries') && tables.includes('contact_messages'), 'allowlist is ' + JSON.stringify(tables));
    check('runtime guard throws for non-allowlisted tables', /assertPublicInsertTable[\s\S]*?throw new Error\(`Refused public insert/.test(sb), 'runtime allowlist guard missing');
    check("wrappers pass literal allowlisted table names", /submitPublicForm\('job_applications'/.test(sb) && /submitPublicForm\('franchise_inquiries'/.test(sb) && /submitPublicForm\('contact_messages'/.test(sb), 'typed wrappers missing');
    check('raw rest() helper is not exported', !/export\s+(async\s+)?function rest\b/.test(sb), 'rest() exported — bypasses the allowlist');
  }

  /* 9f. CV upload goes through the cv-upload Edge Function ONLY ---------- */
  {
    // The critical invariant is UNCHANGED: the client never writes to storage
    // directly. It hands the file to the cv-upload Edge Function, which does all
    // validation server-side. So there must still be NO direct storage-object
    // write anywhere in src/ (a raw fetch to the function's endpoint is fine and
    // is not a storage path).
    // Writes go through Edge Functions only. Building a PUBLIC read URL
    // (storage/v1/object/public/…) is display plumbing, not a write — WP04R's
    // resolveMediaUrl renders bare storage paths that way. Signed-URL reads
    // were already exempt; uploads/deletes from the browser remain forbidden.
    const directStorage = allSrc.filter(([, c]) => /storage\/v1\/object\/(?!sign|public)/.test(c) || /sbUploadFile/.test(c)).map(([f]) => relative('.', f));
    check('no direct client storage-object write exists', directStorage.length === 0, directStorage.join(', '));

    // The client upload helper must post to the cv-upload function, never store bytes.
    check('client uploads CVs via the cv-upload Edge Function', /functions\/v1\/cv-upload/.test(sb), 'cv-upload client path missing');
    check('careers form has a CV file input wired to the upload helper', /type="file"/.test(read('src/components/PublicPages.tsx')) && /uploadCv\(/.test(read('src/components/PublicPages.tsx')), 'careers file input or uploadCv call missing');
    check('no base64 CV encoding survives in the client', allSrc.every(([, c]) => !/cvData|readAsDataURL\([^)]*cv/i.test(c)), 'a base64 CV path reappeared');

    // The cv-upload Edge Function must enforce its server-side controls.
    const cvFn = read('supabase/functions/cv-upload/index.ts');
    check('cv-upload sniffs MIME by magic bytes', /sniffDocType|SIG_PDF|magic/.test(cvFn), 'magic-byte sniffing missing');
    check('cv-upload ignores client-declared type (uses sniffed contentType)', /sniffed\.contentType/.test(cvFn), 'sniffed content-type not used');
    check('cv-upload uses a random UUID object key', /crypto\.randomUUID\(\)/.test(cvFn), 'random object key missing');
    check('cv-upload sets upsert=false (overwrite guard)', /'x-upsert':\s*'false'/.test(cvFn), 'overwrite guard missing');
    check('cv-upload enforces a size limit', /MAX_BYTES/.test(cvFn) && /file\.size > MAX_BYTES/.test(cvFn), 'size limit missing');
    check('cv-upload rate-limits per IP', /cv_upload_ip_log/.test(cvFn) && /RATE_IP_PER_HOUR/.test(cvFn), 'per-IP rate limit missing');
    check('cv-upload verifies CAPTCHA when a secret is set', /TURNSTILE_SECRET/.test(cvFn) && /siteverify/.test(cvFn), 'optional CAPTCHA missing');
    check('cv-upload confirms the application row before storing', /job_applications\?id=eq/.test(cvFn) && /no_application/.test(cvFn), 'orphan check missing');
    // WP01.1 §6.4: ambiguity is RECONCILED (row re-read) before any verdict;
    // unwanted objects are QUEUED for confirmed-status deletion by the worker.
    // A direct storage DELETE reappearing in this function is the regression.
    check('cv-upload re-reads the row before judging an ambiguous link', /readCvPath/.test(cvFn) && /cv_link_ambiguous_unverified/.test(cvFn), 'reconciliation read missing');
    check('cv-upload queues losers instead of fire-and-forget deletes', /storage_cleanup_jobs/.test(cvFn) && /cv_link_lost_race/.test(cvFn), 'cleanup enqueue missing');
    check('cv-upload contains no direct storage DELETE', !/storage\/v1\/object[\s\S]{0,120}?method:\s*'DELETE'|method:\s*'DELETE'[\s\S]{0,120}?storage\/v1\/object/.test(cvFn), 'a direct storage delete reappeared');

    // The cv-signed-url function must be staff-only, managers/owners only, audited.
    const signFn = read('supabase/functions/cv-signed-url/index.ts');
    check('cv-signed-url rejects the anon key', /token === ANON/.test(signFn), 'anon-key rejection missing');
    check('cv-signed-url is managers/owners only', /store_manager.*owner|role !== 'store_manager'/.test(signFn), 'role gate missing');
    check('cv-signed-url resolves the path server-side from the row', /select=id,cv_path/.test(signFn), 'server-side path resolution missing');
    check('cv-signed-url returns a short-lived signed URL', /object\/sign\//.test(signFn) && /URL_TTL_SECONDS/.test(signFn), 'signed URL minting missing');
    check('cv-signed-url audits every access', /activity_log/.test(signFn) && /audit\(/.test(signFn), 'access audit missing');
    for (const f of ['supabase/schema.FRESH-INSTALL-ONLY.sql', 'supabase/migration_payroll_cv.sql', 'supabase/migration_security_lockdown.sql']) {
      check(`${f}: creates no cvs storage policy`, !/create\s+policy\s+"cvs/i.test(read(f)), 'a cvs policy is created');
    }
    const schema = read('supabase/schema.FRESH-INSTALL-ONLY.sql');
    const appBlock = schema.slice(schema.indexOf('create table if not exists job_applications'), schema.indexOf(');', schema.indexOf('create table if not exists job_applications')));
    check('schema: job_applications has no CV columns', !/cv_(name|url|data)/.test(appBlock), 'cv columns still defined');
    const lock = read('supabase/migration_security_lockdown.sql');
    check('lockdown migration destroys then drops legacy CV columns', /set cv_data = ''/.test(lock) && /drop column cv_data/.test(lock) && /drop column cv_url/.test(lock), 'CV column destruction missing');
  }

  /* 9g. Raw backend errors are never rendered ---------------------------- */
  {
    check('PublicPages never renders result.reason / raw messages', !/result\.reason|e\?\.message|\.slice\(0, 140\)/.test(pub), 'raw error interpolation in PublicPages');
    const hStart = app.indexOf('const handleAddApplication');
    const hEnd = app.indexOf('const handleUploadDocument');
    const handlerBlock = hStart >= 0 && hEnd > hStart ? app.slice(hStart, hEnd) : '';
    check('App submission handlers never stringify raw errors', handlerBlock.length > 0 && !/String\(e|e\?\.message|\.reason/.test(handlerBlock), 'raw error passthrough in submission handlers');
    const lastErrRenders = allSrc.filter(([f, c]) => f.includes('components/') && /lastError/.test(c)).map(([f]) => relative('.', f));
    check('internal cloud lastError is never rendered to users', lastErrRenders.length === 0, 'rendered in: ' + lastErrRenders.join(', '));
    const cfStart = sb.indexOf('async function submitPublicForm');
    const classifyBody = sb.slice(cfStart, sb.indexOf('\n}', cfStart));
    const codes = [...classifyBody.matchAll(/errorCode: '([a-z_]+)'/g)].map((m) => m[1]);
    // WP-01 adds 'invalid_response': a 2xx whose body lacks the server UUID
    // (stale function deployment). Fixed and coarse like the rest — nothing
    // from the backend is interpolated into it.
    // INC11 ratchet: 'notice_changed' joins the fixed set — the privacy
    // notice was republished between display and submit (HTTP 412 from the
    // public-form function). Fixed and coarse like the rest; the UI copy it
    // drives says only "reload, review, send again".
    const allowed = ['permission_denied', 'rejected', 'rate_limited', 'server_error', 'request_failed', 'network_error', 'invalid_response', 'idempotency_conflict', 'notice_changed', 'vacancy_not_open', 'section_closed', 'verification_failed'];
    check('failure classifier emits only fixed, coarse error codes', codes.length > 0 && codes.every((c) => allowed.includes(c)) && !/errorCode: `/.test(classifyBody), 'classifier codes: ' + JSON.stringify(codes));
  }

  /* 9h. Production seed carries no demo operational data ------------------ */
  {
    const seed = read('supabase/seed.sql');
    const OPERATIONAL = ['staff_profiles', 'work_shifts', 'payslips', 'clock_history', 'orders', 'order_items', 'order_item_modifiers', 'customers', 'loyalty_transactions', 'sifr_reports', 'audit_logs', 'job_applications', 'franchise_inquiries', 'contact_messages', 'staff_documents', 'stock_movements'];
    const seedHits = OPERATIONAL.filter((t) => new RegExp(`insert\\s+into\\s+${t}\\b`, 'i').test(seed));
    check('production seed inserts no operational/demo records', seedHits.length === 0, 'operational inserts: ' + seedHits.join(', '));
    const dev = read('supabase/seed.dev.sql');
    check('dev fixtures are execution-guarded', /app\.environment/.test(dev) && /raise exception/.test(dev), 'environment guard missing from seed.dev.sql');
    const badEmails = [...dev.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)].map((m) => m[0]).filter((e) => !e.endsWith('@example.invalid'));
    check('dev fixtures use only example.invalid e-mail addresses', badEmails.length === 0, 'non-synthetic emails: ' + badEmails.join(', '));
    check('dev fixtures use synthetic demo_ identifiers', /'demo_app_1'/.test(dev) && /'demo_ord_1'/.test(dev) && /'demo_sifr_1'/.test(dev), 'demo_* ids missing');
  }
}

/* ------------------------------------------------------------------ */
console.log(`\n${failed === 0 ? '✔ ALL SECURITY REGRESSION TESTS PASSED' : '✖ SECURITY REGRESSIONS DETECTED'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
