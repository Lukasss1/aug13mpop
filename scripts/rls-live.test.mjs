#!/usr/bin/env node
/**
 * rls-live.test.mjs — live production proof for the public website/staff
 * release. Run only after the one-time owner/store/test-user bootstrap.
 *
 * The test signs owner and manager accounts through their real TOTP second
 * factor so privileged assertions exercise the current AAL2 policy model.
 * It proves exact self/store ownership instead of approximate row counts.
 * POS behaviour is intentionally outside this public-web commissioning suite;
 * the launch contract proves those three functions remain undeployed.
 */
import { totpWindow } from './lib/totp.mjs';

const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
const REQUIRED = [
  'OWNER_EMAIL', 'OWNER_PW', 'OWNER_TOTP_SECRET',
  'MGR_A_EMAIL', 'MGR_A_PW', 'MGR_A_TOTP_SECRET',
  'STAFF_B_EMAIL', 'STAFF_B_PW',
];
const missing = REQUIRED.filter((name) => !(process.env[name] || '').trim());
if (!URL || !ANON || missing.length) {
  console.error(`Missing live RLS configuration: ${[...(!URL ? ['SUPABASE_URL'] : []), ...(!ANON ? ['SUPABASE_ANON_KEY'] : []), ...missing].join(', ')}`);
  process.exit(2);
}

let passed = 0;
let failed = 0;
const ok = (name) => { passed += 1; console.log(`✔ ${name}`); };
const fail = (name, detail) => { failed += 1; console.error(`✖ ${name}\n    ${detail}`); };
const expect = (name, condition, detail = '') => (condition ? ok(name) : fail(name, detail));

function jwtPayload(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch { return {}; }
}

async function signIn(email, password, totpSecret = '', requireAal2 = false) {
  const res = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${res.status} ${await res.text()}`);
  const session = await res.json();
  if (!requireAal2) return session.access_token;

  const factor = (session.user?.factors || []).find((item) => item?.factor_type === 'totp' && item?.status === 'verified');
  if (!factor) throw new Error(`AAL2 is required for ${email}, but no verified TOTP factor is enrolled.`);
  if (!totpSecret) throw new Error(`AAL2 is required for ${email}, but the protected TOTP secret is missing.`);

  const challengeRes = await fetch(`${URL}/auth/v1/factors/${encodeURIComponent(factor.id)}/challenge`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!challengeRes.ok) throw new Error(`MFA challenge failed for ${email}: ${challengeRes.status}`);
  const challenge = await challengeRes.json();

  for (const code of totpWindow(totpSecret.replace(/\s+/g, '').toUpperCase())) {
    const verifyRes = await fetch(`${URL}/auth/v1/factors/${encodeURIComponent(factor.id)}/verify`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_id: challenge.id, code }),
    });
    if (!verifyRes.ok) continue;
    const verified = await verifyRes.json();
    const token = verified.access_token;
    if (jwtPayload(token).aal !== 'aal2') throw new Error(`MFA verification for ${email} did not issue an aal2 token.`);
    return token;
  }
  throw new Error(`MFA verification failed for ${email}. Check the protected TOTP secret and runner clock.`);
}

async function rest(token, path, init = {}) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text().catch(() => '');
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

const rowCount = (result) => Array.isArray(result.body) ? result.body.length : 0;
const rpc = (token, fn, body = {}) => rest(token, `rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) });

async function myProfile(token, label) {
  const result = await rpc(token, 'get_my_staff_profile');
  if (result.status !== 200 || !Array.isArray(result.body) || result.body.length !== 1) {
    throw new Error(`${label} get_my_staff_profile failed: HTTP ${result.status}`);
  }
  const profile = result.body[0];
  if (!profile?.id) throw new Error(`${label} profile has no id`);
  return profile;
}

(async () => {
  try {
    const owner = await signIn(process.env.OWNER_EMAIL, process.env.OWNER_PW, process.env.OWNER_TOTP_SECRET, true);
    const mgrA = await signIn(process.env.MGR_A_EMAIL, process.env.MGR_A_PW, process.env.MGR_A_TOTP_SECRET, true);
    const staffB = await signIn(process.env.STAFF_B_EMAIL, process.env.STAFF_B_PW);

    expect('owner session is AAL2', jwtPayload(owner).aal === 'aal2');
    expect('manager A session is AAL2', jwtPayload(mgrA).aal === 'aal2');

    for (const token of [owner, mgrA, staffB]) {
      const linked = await rpc(token, 'link_staff_profile');
      if (linked.status >= 400) throw new Error(`link_staff_profile failed with HTTP ${linked.status}`);
    }

    const ownerProfile = await myProfile(owner, 'owner');
    const managerProfile = await myProfile(mgrA, 'manager A');
    const staffProfile = await myProfile(staffB, 'staff B');

    expect('owner test identity is linked to the owner role', ownerProfile.role === 'owner', `role=${ownerProfile.role}`);
    expect('manager A test identity is linked to store_manager', managerProfile.role === 'store_manager', `role=${managerProfile.role}`);
    expect('manager A has a store', !!managerProfile.store_id, `store_id=${managerProfile.store_id}`);
    expect('staff B has a store', !!staffProfile.store_id, `store_id=${staffProfile.store_id}`);
    expect('manager A and staff B belong to different stores', managerProfile.store_id !== staffProfile.store_id,
      `both are linked to ${managerProfile.store_id}; use two dedicated acceptance stores`);

    // Anonymous users may receive a hard denial or an RLS-filtered empty set;
    // either is acceptable, but data must never be visible.
    {
      const res = await fetch(`${URL}/rest/v1/payslips?select=id,employee_id`, {
        headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
      });
      const body = await res.json().catch(() => null);
      const safe = res.status === 401 || res.status === 403 || (res.status === 200 && Array.isArray(body) && body.length === 0);
      expect('anon sees no payslip data', safe, `HTTP ${res.status}`);
    }

    // OWNER: AAL2 owner can cross store boundaries where designed.
    const ownerStaff = await rest(owner, 'staff_profiles?select=id,store_id');
    expect('owner can read the acceptance staff directory', ownerStaff.status === 200 && rowCount(ownerStaff) >= 3,
      `HTTP ${ownerStaff.status}; rows=${rowCount(ownerStaff)}`);
    expect('owner reads payslips', (await rest(owner, 'payslips?select=id&limit=1')).status === 200);
    expect('owner reads audit logs', (await rest(owner, 'audit_logs?select=id&limit=1')).status === 200);

    // MANAGER A: every scoped staff/order row must be exactly their store.
    const mgrStaff = await rest(mgrA, 'staff_profiles?select=id,store_id');
    const mgrStaffRows = Array.isArray(mgrStaff.body) ? mgrStaff.body : [];
    expect('manager A can query their staff directory', mgrStaff.status === 200 && mgrStaffRows.length >= 1,
      `HTTP ${mgrStaff.status}`);
    expect('manager A sees only their own store staff',
      mgrStaffRows.every((row) => row.store_id === managerProfile.store_id),
      `expected store ${managerProfile.store_id}; saw ${[...new Set(mgrStaffRows.map((row) => row.store_id))].join(',')}`);
    expect('manager A cannot see staff B from the other store', !mgrStaffRows.some((row) => row.id === staffProfile.id),
      `staff B (${staffProfile.id}) was visible`);
    expect('manager A cannot read owner-only audit rows', rowCount(await rest(mgrA, 'audit_logs?select=id')) === 0);

    const mgrOrders = await rest(mgrA, 'orders?select=id,store_id');
    const mgrOrderRows = Array.isArray(mgrOrders.body) ? mgrOrders.body : [];
    expect('manager A can query orders', mgrOrders.status === 200, `HTTP ${mgrOrders.status}`);
    expect('manager A sees only orders from their own store',
      mgrOrderRows.every((row) => row.store_id === managerProfile.store_id),
      `foreign stores visible: ${[...new Set(mgrOrderRows.filter((row) => row.store_id !== managerProfile.store_id).map((row) => row.store_id))].join(',')}`);
    expect('manager A sees zero Store B orders', !mgrOrderRows.some((row) => row.store_id === staffProfile.store_id),
      `Store B ${staffProfile.store_id} was visible`);

    // STAFF B: prove exact self ownership, not merely a successful query.
    const bPayslips = await rest(staffB, 'payslips?select=employee_id');
    const bPayslipRows = Array.isArray(bPayslips.body) ? bPayslips.body : [];
    expect('staff B can query their payslips', bPayslips.status === 200, `HTTP ${bPayslips.status}`);
    expect('every payslip visible to staff B belongs to staff B',
      bPayslipRows.every((row) => row.employee_id === staffProfile.id),
      `staff B id=${staffProfile.id}; returned employee ids=${[...new Set(bPayslipRows.map((row) => row.employee_id))].join(',')}`);

    const esc = await rest(staffB, 'staff_profiles?id=eq.' + encodeURIComponent(staffProfile.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ role: 'owner' }),
    });
    expect('staff B cannot self-promote to owner', esc.status >= 400 || rowCount(esc) === 0,
      `escalation update returned ${esc.status}`);

    const pay = await rest(staffB, 'staff_profiles?id=eq.' + encodeURIComponent(staffProfile.id), {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ pay_rate: 999 }),
    });
    expect('staff B cannot raise their own pay_rate', pay.status >= 400 || rowCount(pay) === 0,
      `pay-rate update returned ${pay.status}`);

    // CV pipeline: retained because it is part of the public Careers/staff web
    // product. CV upload itself remains feature-gated at launch.
    {
      const res = await fetch(`${URL}/storage/v1/object/list/cvs`, {
        method: 'POST',
        headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: '', limit: 100 }),
      });
      expect('anon cannot list/read the private cvs bucket', res.status >= 400, `bucket list returned ${res.status}`);
    }

    const fnBase = `${URL}/functions/v1`;
    if (process.env.TEST_APPLICATION_ID) {
      const form = new FormData();
      form.append('applicationId', process.env.TEST_APPLICATION_ID);
      form.append('file', new Blob(['this is definitely not a pdf'], { type: 'application/pdf' }), 'resume.pdf');
      const res = await fetch(`${fnBase}/cv-upload`, { method: 'POST', headers: { apikey: ANON }, body: form });
      expect('cv-upload rejects a spoofed content-type', res.status === 415, `spoofed upload returned ${res.status}`);
    } else {
      console.log('  (skipped spoofed-upload test — set TEST_APPLICATION_ID to enable)');
    }

    {
      const res = await fetch(`${fnBase}/cv-signed-url`, {
        method: 'POST',
        headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId: process.env.TEST_APPLICATION_ID || 'x' }),
      });
      expect('cv-signed-url refuses the anon key', res.status === 401, `anon signed-url returned ${res.status}`);
    }
    {
      const res = await fetch(`${fnBase}/cv-signed-url`, {
        method: 'POST',
        headers: { apikey: ANON, Authorization: `Bearer ${staffB}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationId: process.env.TEST_APPLICATION_ID || 'x' }),
      });
      expect('cv-signed-url refuses a team member', res.status === 403, `team-member signed-url returned ${res.status}`);
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  } catch (error) {
    console.error('LIVE TEST ERROR:', error.message);
    console.error('Bootstrap the dedicated owner/manager/staff acceptance users, two stores, and owner/manager MFA before running this gate.');
    process.exit(2);
  }
})();
