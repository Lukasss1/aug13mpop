#!/usr/bin/env node
/* ============================================================================
 * MILK POP — STAGING INTEGRATION TEST (Stage 12b)
 *
 * Runs the brief's live-behaviour scenarios over REAL HTTP against a REAL
 * Supabase project (PostgREST + Auth + Edge Functions) — the layer the local
 * matrix (scripts/rls-matrix.local.mjs) deliberately does not simulate.
 *
 * WHAT IT NEEDS (environment):
 *   SUPABASE_URL           https://<project>.supabase.co
 *   SUPABASE_ANON_KEY      the anon key
 *   MP_OWNER_EMAIL / MP_OWNER_PASSWORD / MP_OWNER_TOTP_SECRET
 *                                             a linked MFA-enrolled owner account
 *   MP_MGR_A_EMAIL / MP_MGR_A_PASSWORD / MP_MGR_A_TOTP_SECRET
 *                                             store-A manager (linked)
 *   MP_MGR_B_EMAIL / MP_MGR_B_PASSWORD / MP_MGR_B_TOTP_SECRET
 *                                             store-B manager (linked, optional)
 *   MP_STAFF_A_EMAIL / MP_STAFF_A_PASSWORD / MP_STAFF_A_TOTP_SECRET
 *                                             store-A team member (linked)
 *   MP_STAFF_B_EMAIL / MP_STAFF_B_PASSWORD / MP_STAFF_B_TOTP_SECRET
 *                                             store-B team member (linked, optional)
 *
 * Prepare the accounts once with the staff-invite flow (Admin → Team →
 * Invite), sign each in once, then run:
 *   SUPABASE_URL=… SUPABASE_ANON_KEY=… MP_OWNER_EMAIL=… … npm run test:staging
 *
 * Run this only against the protected staging project. The journey is
 * intentionally stateful: it creates temporary `stg_` rows, changes one
 * dedicated staging checklist item, and appends an immutable audit event.
 * Temporary deletable objects are cleaned up and cleanup failures fail the run.
 * Optional second-store identities are skipped with a note, never failed.
 * ==========================================================================*/

import { totpWindow } from './lib/totp.mjs';

const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
if (!URL_ || !ANON) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required. See the header of this file.');
  process.exit(2);
}

let passed = 0, failed = 0, skipped = 0;
const failures = [];
const ok = (n) => { passed++; console.log(`✔ ${n}`); };
const bad = (n, d) => { failed++; failures.push(n); console.log(`✖ ${n}\n    ${d}`); };
const skip = (n, why) => { skipped++; console.log(`— skipped: ${n} (${why})`); };

async function signIn(email, password, totpSecret = '') {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`sign-in failed for ${email}: ${r.status}`);
  const session = await r.json();
  const factor = (session.user?.factors || []).find((item) => item.factor_type === 'totp' && item.status === 'verified');
  if (!factor) return session.access_token;
  if (!totpSecret) throw new Error(`TOTP is enrolled for ${email}, but its protected MP_*_TOTP_SECRET is missing.`);

  const challengeRes = await fetch(`${URL_}/auth/v1/factors/${encodeURIComponent(factor.id)}/challenge`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!challengeRes.ok) throw new Error(`MFA challenge failed for ${email}: ${challengeRes.status}`);
  const challenge = await challengeRes.json();
  for (const code of totpWindow(totpSecret)) {
    const verifyRes = await fetch(`${URL_}/auth/v1/factors/${encodeURIComponent(factor.id)}/verify`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_id: challenge.id, code }),
    });
    if (verifyRes.ok) return (await verifyRes.json()).access_token;
  }
  throw new Error(`MFA verification failed for ${email}. Check the protected TOTP secret and runner clock.`);
}

function rest(token) {
  return async (path, init = {}) => {
    const r = await fetch(`${URL_}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${token || ANON}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    const text = await r.text();
    let body; try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
    return { status: r.status, ok: r.ok, body };
  };
}
function fn(token) {
  return async (name, init = {}) => {
    const r = await fetch(`${URL_}/functions/v1/${name}`, {
      ...init,
      headers: { apikey: ANON, Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    const text = await r.text();
    let body; try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
    return { status: r.status, ok: r.ok, body };
  };
}

const env = (k) => process.env[k] || '';
const need = {
  owner: ['MP_OWNER_EMAIL', 'MP_OWNER_PASSWORD', 'MP_OWNER_TOTP_SECRET'],
  mgrA: ['MP_MGR_A_EMAIL', 'MP_MGR_A_PASSWORD', 'MP_MGR_A_TOTP_SECRET'],
  staffA: ['MP_STAFF_A_EMAIL', 'MP_STAFF_A_PASSWORD', 'MP_STAFF_A_TOTP_SECRET'],
};
const opt = {
  mgrB: ['MP_MGR_B_EMAIL', 'MP_MGR_B_PASSWORD', 'MP_MGR_B_TOTP_SECRET'],
  staffB: ['MP_STAFF_B_EMAIL', 'MP_STAFF_B_PASSWORD', 'MP_STAFF_B_TOTP_SECRET'],
};

(async () => {
  const T = {};
  for (const [who, [e, p, t]] of Object.entries(need)) {
    if (!env(e) || !env(p)) { console.error(`Missing ${e}/${p}`); process.exit(2); }
    T[who] = await signIn(env(e), env(p), env(t));
  }
  for (const [who, [e, p, t]] of Object.entries(opt)) {
    if (env(e) && env(p)) T[who] = await signIn(env(e), env(p), env(t));
  }
  const anon = rest('');
  const R = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, rest(v)]));
  const F = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, fn(v)]));

  // Profiles of each identity — everything else derives from these.
  const me = {};
  for (const who of Object.keys(T)) {
    const r = await R[who]('rpc/link_staff_profile', { method: 'POST', body: '{}' });
    if (!r.ok || !r.body?.id) { console.error(`Could not resolve the staff profile for ${who} (${r.status}). Is the account linked?`); process.exit(2); }
    me[who] = r.body;
  }
  console.log(`identities: owner=${me.owner.id} mgrA=${me.mgrA.id} staffA=${me.staffA.id}${me.staffB ? ` staffB=${me.staffB.id}` : ''}\n`);
  const cleanup = [];
  const registerCleanup = (label, action) => cleanup.push({ label, action });

  /* 1. Public surface -------------------------------------------------- */
  {
    const r = await anon('menu_items?select=id&limit=1');
    r.ok ? ok('anon reads public menu over HTTP') : bad('anon reads public menu over HTTP', `status ${r.status}`);
    const w = await anon('contact_messages', { method: 'POST', body: JSON.stringify([{ id: 'stg_cm', full_name: 'X', email: 'x@x.com', subject: 's', message: 'm' }]) });
    !w.ok ? ok('anon direct INSERT into contact_messages is rejected') : bad('anon direct INSERT into contact_messages is rejected', 'insert succeeded');
  }

  /* 2. Profile visibility + protected columns -------------------------- */
  {
    const r = await R.staffA(`staff_profiles?id=eq.${me.staffA.id}&select=id`);
    (r.ok && r.body?.length === 1) ? ok('staff read their own profile') : bad('staff read their own profile', JSON.stringify(r.body).slice(0, 120));
    const raise = await R.staffA(`staff_profiles?id=eq.${me.staffA.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ pay_rate: 99 }) });
    !raise.ok ? ok('self pay-rise PATCH is rejected') : bad('self pay-rise PATCH is rejected', 'patch succeeded');
    const pts = await R.staffA(`staff_profiles?id=eq.${me.staffA.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ points: 99999 }) });
    !pts.ok ? ok('self points PATCH is rejected') : bad('self points PATCH is rejected', 'patch succeeded');
  }

  /* 3. Training completion transaction --------------------------------- */
  {
    // The owner authors a disposable assessment + assignment for staffA.
    const assessId = 'stg_assess_' + Date.now().toString(36);
    const asnId = 'stg_asn_' + Date.now().toString(36);
    let r = await R.owner('training_assessments', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ id: assessId, title: 'Staging Module', passing_score: 80, points: 0, badge: '', category: 'brand', questions: [{ id: 'q1', text: 'Pick B', type: 'multiple_choice', options: ['A', 'B'], correctAnswer: 'B', explanation: '', difficulty: 'easy', categoryTag: '' }] }]) });
    if (!r.ok) bad('owner authors a staging assessment', `status ${r.status}`);
    else {
      ok('owner authors a staging assessment');
      registerCleanup('delete staging assessment', () => R.owner(`training_assessments?id=eq.${assessId}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }));
      r = await R.owner('training_assignments', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ id: asnId, assessment_id: assessId, assessment_title: 'Staging Module', employee_id: me.staffA.id, employee_name: me.staffA.name, assigned_by: me.owner.id, due_date: new Date(Date.now() + 86400e3 * 30).toISOString().slice(0, 10), status: 'assigned' }]) });
      if (!r.ok) bad('owner assigns it to staff A', `status ${r.status}`);
      else {
        ok('owner assigns it to staff A');
        registerCleanup('delete staging assignment', () => R.owner(`training_assignments?id=eq.${asnId}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }));
        const sub = 'stg_sub_' + Date.now().toString(36);
        const spoof = await R.staffA('rpc/complete_training', { method: 'POST', body: JSON.stringify({ p_assessment_id: assessId, p_score: 100, p_submission_id: sub + '_wrong', p_assignment_id: null, p_answers: ['A'] }) });
        (spoof.ok && spoof.body?.passed === false && spoof.body?.score === 0 && spoof.body?.serverGraded === true)
          ? ok('a spoofed 100% with WRONG answers is server-graded to 0% (fails)')
          : bad('a spoofed 100% with WRONG answers is server-graded to 0% (fails)', JSON.stringify(spoof.body).slice(0, 160));
        const c1 = await R.staffA('rpc/complete_training', { method: 'POST', body: JSON.stringify({ p_assessment_id: assessId, p_score: 0, p_submission_id: sub, p_assignment_id: asnId, p_answers: ['B'] }) });
        (c1.ok && c1.body?.passed === true && c1.body?.newCertificate === true && c1.body?.serverGraded === true && c1.body?.score === 100)
          ? ok('complete_training passes and certifies over HTTP without changing staging reward balances')
          : bad('complete_training passes and certifies over HTTP without changing staging reward balances', JSON.stringify(c1.body).slice(0, 160));
        const c2 = await R.staffA('rpc/complete_training', { method: 'POST', body: JSON.stringify({ p_assessment_id: assessId, p_score: 0, p_submission_id: sub, p_assignment_id: asnId, p_answers: ['B'] }) });
        (c2.ok && c2.body?.newCertificate === true && c2.body?.pointsAwarded === c1.body?.pointsAwarded)
          ? ok('the same submission replays identically (idempotent)')
          : bad('the same submission replays identically (idempotent)', JSON.stringify(c2.body).slice(0, 160));
        if (c1.ok && c1.body?.certificate?.id) registerCleanup('delete staging certificate', () => R.owner(`training_certificates?id=eq.${encodeURIComponent(c1.body.certificate.id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }));
        const direct = await R.staffA('training_certificates', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ id: 'stg_fake_cert', employee_id: me.staffA.id, assessment_id: assessId }]) });
        !direct.ok ? ok('direct certificate INSERT is rejected') : bad('direct certificate INSERT is rejected', 'insert succeeded');
      }
    }
  }

  /* 4. Incidents: T13.3.13 identity + atomic management RPCs ------------ */
  {
    const created = await R.staffA('rpc/create_sifr_report', {
      method: 'POST',
      body: JSON.stringify({
        p_title: 'Staging incident', p_category: 'health_safety', p_involved_people: '',
        p_description: 'A staging spill was found', p_impact: 'Slip risk',
        p_suggested_action: 'Clean and display a warning sign', p_confidentiality: 'standard',
      }),
    });
    const sid = created.body?.id;
    if (!created.ok || !sid) bad('staff file an incident through the narrow RPC', `status ${created.status}`);
    else {
      registerCleanup('delete staging incident', () => R.owner(`sifr_reports?id=eq.${encodeURIComponent(sid)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }));
      (created.body?.reporter_id === me.staffA.id && created.body?.store_id === me.staffA.store_id)
        ? ok('incident identity and store are server-derived')
        : bad('incident identity and store are server-derived', JSON.stringify(created.body).slice(0, 180));
      const bypass = await R.mgrA(`sifr_reports?id=eq.${encodeURIComponent(sid)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'resolved' }),
      });
      !bypass.ok
        ? ok('manager whole-row incident updates are rejected')
        : bad('manager whole-row incident updates are rejected', 'patch succeeded');
      const reply = await R.mgrA('rpc/append_sifr_reply', {
        method: 'POST', body: JSON.stringify({ p_report_id: sid, p_message: 'Floor secured' }),
      });
      (reply.ok && Array.isArray(reply.body?.replies) && reply.body.replies.length === 1)
        ? ok('manager reply is appended atomically and server-attributed')
        : bad('manager reply is appended atomically and server-attributed', JSON.stringify(reply.body).slice(0, 180));
      if (R.mgrB) {
        const other = await R.mgrB(`sifr_reports?id=eq.${encodeURIComponent(sid)}&select=id`);
        (other.ok && other.body?.length === 0)
          ? ok('the other store’s manager cannot see it')
          : bad('the other store’s manager cannot see it', JSON.stringify(other.body).slice(0, 120));
        const cross = await R.mgrB('rpc/set_sifr_status', {
          method: 'POST', body: JSON.stringify({ p_report_id: sid, p_status: 'resolved' }),
        });
        !cross.ok
          ? ok('the other store’s manager cannot change it through the RPC')
          : bad('the other store’s manager cannot change it through the RPC', 'status change succeeded');
      } else skip('cross-store incident visibility and mutation', 'MP_MGR_B_* not provided');
    }
  }

  /* 5. app_state scoping -------------------------------------------------- */
  {
    const storeA = me.staffA.store_id;
    const operationalKey = `milkpop_checklist_tasks:${storeA}`;
    const templates = await R.staffA('checklist_templates?select=id&order=sort_order.asc&limit=1');
    const taskId = templates.ok ? templates.body?.[0]?.id : null;
    if (!taskId) {
      bad('a configured checklist task is available for the staging probe', JSON.stringify(templates.body).slice(0, 120));
    } else {
      const storeRows = await R.staffA(`stores?id=eq.${encodeURIComponent(storeA)}&select=timezone`);
      const timezone = storeRows.ok ? storeRows.body?.[0]?.timezone || 'Europe/London' : 'Europe/London';
      const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((part) => [part.type, part.value]));
      const businessDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
      const good = await R.staffA('rpc/update_checklist_task', {
        method: 'POST',
        body: JSON.stringify({ p_business_date: businessDate, p_task_id: taskId, p_completed: true, p_comment: 'Staging probe', p_clear_comment: false }),
      });
      (good.ok && good.body?.ok === true && good.body?.storeId === storeA)
        ? ok('staff atomically update one checklist task in their real store')
        : bad('staff atomically update one checklist task in their real store', JSON.stringify(good.body).slice(0, 120));
    }

    const generic = await R.staffA('rpc/set_app_state', {
      method: 'POST',
      body: JSON.stringify({ p_key: operationalKey, p_value: {} }),
    });
    !generic.ok ? ok('staff cannot replace a checklist envelope through generic app_state') : bad('staff cannot replace a checklist envelope through generic app_state', 'call succeeded');

    const wrongStore = me.staffB?.store_id || me.mgrB?.store_id;
    if (wrongStore && wrongStore !== storeA) {
      const spoof = await R.staffA('rpc/set_app_state', {
        method: 'POST',
        body: JSON.stringify({ p_key: `milkpop_checklist_tasks:${wrongStore}`, p_value: {} }),
      });
      !spoof.ok ? ok('staff cannot forge another store operational key') : bad('staff cannot forge another store operational key', 'call succeeded');
      if (R.staffB) {
        const read = await R.staffB(`app_state?key=eq.${encodeURIComponent(operationalKey)}&select=key`);
        (read.ok && read.body?.length === 0)
          ? ok('another store cannot read the operational document')
          : bad('another store cannot read the operational document', JSON.stringify(read.body).slice(0, 120));
      }
    } else skip('cross-store operational key probe', 'MP_STAFF_B_* or MP_MGR_B_* not provided');

    const mail = await R.staffA('rpc/set_app_state', { method: 'POST', body: JSON.stringify({ p_key: 'milkpop_email_settings', p_value: {} }) });
    !mail.ok ? ok('staff cannot write global e-mail settings') : bad('staff cannot write global e-mail settings', 'call succeeded');
    const direct = await R.staffA('app_state', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ key: operationalKey, value: {} }]) });
    !direct.ok ? ok('direct app_state INSERT is revoked') : bad('direct app_state INSERT is revoked', 'insert succeeded');
  }

  /* 6. Documents: upload pipeline + signed URLs --------------------------- */
  {
    // A 1x1 PNG (sniffable magic bytes).
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.set('file', new Blob([png], { type: 'image/png' }), 'staging-probe.png');
    form.set('name', 'Staging probe document');
    form.set('category', 'compliance');
    const up = await fetch(`${URL_}/functions/v1/staff-doc-upload`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${T.staffA}` }, body: form });
    const upBody = await up.json().catch(() => null);
    if (!up.ok || !upBody?.document?.id) bad('staff upload a document through the pipeline', `status ${up.status} ${JSON.stringify(upBody).slice(0, 140)}`);
    else {
      ok('staff upload a document through the pipeline');
      const docId = upBody.document.id;
      registerCleanup('delete staging document and storage object', () => F.owner('staff-doc-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: docId }) }));
      const urlRes = await F.staffA('staff-doc-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: docId }) });
      if (!urlRes.ok || !urlRes.body?.url) bad('the owner of the document gets a signed URL', JSON.stringify(urlRes.body).slice(0, 140));
      else {
        ok('the owner of the document gets a signed URL');
        const fetched = await fetch(urlRes.body.url);
        fetched.ok ? ok('the signed URL serves the object') : bad('the signed URL serves the object', `status ${fetched.status}`);
        await new Promise((r) => setTimeout(r, 65_000));
        const expired = await fetch(urlRes.body.url);
        !expired.ok ? ok('the signed URL EXPIRES (~60s)') : bad('the signed URL EXPIRES (~60s)', 'still serving after 65s');
      }
      if (R.staffB) {
        const other = await F.staffB('staff-doc-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: docId }) });
        !other.ok ? ok('another employee is refused a signed URL for it') : bad('another employee is refused a signed URL for it', 'granted');
      } else skip('cross-employee signed-URL refusal', 'MP_STAFF_B_* not provided');
      const meta = await R.staffA(`staff_documents?id=eq.${encodeURIComponent(docId)}&select=id`);
      (meta.ok && meta.body?.length === 1) ? ok('the uploader reads the metadata row') : bad('the uploader reads the metadata row', JSON.stringify(meta.body).slice(0, 120));
    }
  }

  /* 7. Atomic publication -------------------------------------------------- */
  {
    const list = await R.mgrA('menu_items?select=*');
    if (!list.ok) bad('manager reads the menu for publication', `status ${list.status}`);
    else {
      const current = list.body;
      const probeId = 'stg_menu_probe_' + Date.now().toString(36);
      const badProbeId = 'stg_menu_bad_' + Date.now().toString(36);
      const probe = { id: probeId, name: 'Staging Probe Shake', description: 'temporary', price: 1.0, category: 'milkshakes' };
      let menuNeedsRestore = false;
      // INC11: the caller states the revision it hydrated alongside the total.
      const revRow = await R.mgrA('collection_revisions?table_key=eq.menu_items&select=revision', { method: 'GET' });
      const rev0 = revRow.ok && Array.isArray(revRow.body) && Number.isFinite(Number(revRow.body[0]?.revision))
        ? Number(revRow.body[0].revision)
        : null;
      if (rev0 === null) {
        bad('manager reads the current menu publication revision', JSON.stringify(revRow.body).slice(0, 140));
      } else {
        ok('manager reads the current menu publication revision');
        const pub = await R.mgrA('rpc/replace_collection', { method: 'POST', body: JSON.stringify({ p_table: 'menu_items', p_rows: [...current, probe], p_expected_total: current.length, p_expected_revision: rev0 }) });
        const publishedRows = pub.body?.rows;
        const rev1 = Number(pub.body?.revision);
        (pub.ok && Array.isArray(publishedRows) && Number.isFinite(rev1) && publishedRows.some((r) => r.id === probeId))
          ? ok('a manager publishes the menu atomically over HTTP')
          : bad('a manager publishes the menu atomically over HTTP', JSON.stringify(pub.body).slice(0, 180));
        if (pub.ok && Number.isFinite(rev1)) {
          menuNeedsRestore = true;
          registerCleanup('restore the original staging menu', async () => {
            if (!menuNeedsRestore) return { ok: true, status: 200, body: { alreadyRestored: true } };
            // Retry only against the exact revision created by this test. If a
            // person or another job published afterwards, fail closed rather
            // than overwriting their newer staging menu.
            const result = await R.mgrA('rpc/replace_collection', { method: 'POST', body: JSON.stringify({ p_table: 'menu_items', p_rows: current, p_expected_total: current.length + 1, p_expected_revision: rev1 }) });
            if (result.ok) menuNeedsRestore = false;
            return result;
          });
          const badPub = await R.mgrA('rpc/replace_collection', { method: 'POST', body: JSON.stringify({ p_table: 'menu_items', p_rows: [...current, { ...probe, id: badProbeId, price: 'NaN-text' }], p_expected_total: current.length + 1, p_expected_revision: rev1 }) });
          !badPub.ok ? ok('a broken payload aborts the whole publication') : bad('a broken payload aborts the whole publication', 'succeeded');
          const restore = await R.mgrA('rpc/replace_collection', { method: 'POST', body: JSON.stringify({ p_table: 'menu_items', p_rows: current, p_expected_total: current.length + 1, p_expected_revision: rev1 }) });
          const restoreConfirmed = restore.ok && Array.isArray(restore.body?.rows)
            && Number.isFinite(Number(restore.body?.revision)) && !restore.body.rows.some((r) => r.id === probeId);
          if (restoreConfirmed) menuNeedsRestore = false;
          restoreConfirmed
            ? ok('the original menu is restored (probe removed)')
            : bad('the original menu is restored (probe removed)', JSON.stringify(restore.body).slice(0, 180));
        } else {
          skip('broken-payload rollback and menu restoration', 'initial publication did not return a confirmed revision');
        }
      }
    }
  }

  /* 8. Audit stream ---------------------------------------------------------- */
  {
    const aid = 'stg_aud_' + Date.now().toString(36);
    const ins = await R.staffA('audit_logs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ id: aid, operator_name: 'Spoofed Owner', role: 'owner', action: 'staging probe', timestamp: 'fake', module: 'Staging' }]) });
    if (!ins.ok) bad('staff append an audit row (minimal)', `status ${ins.status}`);
    else {
      const row = await R.owner(`audit_logs?id=eq.${aid}&select=operator_name,role`);
      (row.ok && row.body?.[0]?.operator_name === me.staffA.name)
        ? ok('the audit actor was derived on the server (spoof discarded)')
        : bad('the audit actor was derived on the server (spoof discarded)', JSON.stringify(row.body).slice(0, 120));
      const upd = await R.owner(`audit_logs?id=eq.${aid}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ action: 'tampered' }) });
      !upd.ok ? ok('audit rows cannot be updated (append-only)') : bad('audit rows cannot be updated (append-only)', 'patch succeeded');
    }
  }

  /* Cleanup ------------------------------------------------------------------ */
  for (const item of cleanup.reverse()) {
    try {
      const result = await item.action();
      if (result && result.ok === false) bad(`cleanup: ${item.label}`, `status ${result.status} ${JSON.stringify(result.body).slice(0, 140)}`);
      else ok(`cleanup: ${item.label}`);
    } catch (error) {
      bad(`cleanup: ${item.label}`, error instanceof Error ? error.message : String(error));
    }
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} STAGING INTEGRATION — ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed) { console.log('failed: ' + failures.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(2); });
