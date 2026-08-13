#!/usr/bin/env node
/**
 * Production RLS smoke for the real small-business topology.
 *
 * This is deliberately NOT the exhaustive cross-store matrix. Cross-store
 * adversarial coverage remains in PostgreSQL/staging. Production needs only a
 * real AAL2 owner plus one real low-role acceptance user in the first store.
 * No fake second shop or fake manager is required merely to commission CI.
 */
import { totpWindow } from './lib/totp.mjs';

const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
const required = ['OWNER_EMAIL', 'OWNER_PW', 'OWNER_TOTP_SECRET', 'STAFF_EMAIL', 'STAFF_PW'];
const missing = required.filter((name) => !(process.env[name] || '').trim());
if (!URL || !ANON || missing.length) {
  console.error(`Missing production RLS smoke configuration: ${[
    ...(!URL ? ['SUPABASE_URL'] : []), ...(!ANON ? ['SUPABASE_ANON_KEY'] : []), ...missing,
  ].join(', ')}`);
  process.exit(2);
}

let passed = 0, failed = 0;
const expect = (name, condition, detail = '') => {
  if (condition) { passed++; console.log(`✔ ${name}`); }
  else { failed++; console.error(`✖ ${name}${detail ? `\n    ${detail}` : ''}`); }
};

function jwtPayload(token) {
  try {
    const part = token.split('.')[1];
    return part ? JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) : {};
  } catch { return {}; }
}

async function signIn(email, password, totpSecret = '', requireAal2 = false) {
  const res = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`sign-in failed: HTTP ${res.status}`);
  const session = await res.json();
  if (!requireAal2) return session.access_token;

  const factor = (session.user?.factors || []).find((item) => item?.factor_type === 'totp' && item?.status === 'verified');
  if (!factor) throw new Error('owner has no verified TOTP factor');
  const challengeRes = await fetch(`${URL}/auth/v1/factors/${encodeURIComponent(factor.id)}/challenge`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!challengeRes.ok) throw new Error(`owner MFA challenge failed: HTTP ${challengeRes.status}`);
  const challenge = await challengeRes.json();
  for (const code of totpWindow(totpSecret.replace(/\s+/g, '').toUpperCase())) {
    const verifyRes = await fetch(`${URL}/auth/v1/factors/${encodeURIComponent(factor.id)}/verify`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_id: challenge.id, code }),
    });
    if (!verifyRes.ok) continue;
    const verified = await verifyRes.json();
    if (jwtPayload(verified.access_token).aal !== 'aal2') throw new Error('owner MFA did not issue an aal2 token');
    return verified.access_token;
  }
  throw new Error('owner MFA verification failed');
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
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}
const rows = (result) => Array.isArray(result.body) ? result.body : [];
const rpc = (token, fn, body = {}) => rest(token, `rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) });

async function myProfile(token, label) {
  const result = await rpc(token, 'get_my_staff_profile');
  if (result.status !== 200 || rows(result).length !== 1 || !rows(result)[0]?.id) {
    throw new Error(`${label} get_my_staff_profile failed: HTTP ${result.status}`);
  }
  return rows(result)[0];
}

try {
  const owner = await signIn(process.env.OWNER_EMAIL, process.env.OWNER_PW, process.env.OWNER_TOTP_SECRET, true);
  const staff = await signIn(process.env.STAFF_EMAIL, process.env.STAFF_PW);
  expect('owner session is AAL2', jwtPayload(owner).aal === 'aal2');

  for (const token of [owner, staff]) {
    const linked = await rpc(token, 'link_staff_profile');
    if (linked.status >= 400) throw new Error(`link_staff_profile failed with HTTP ${linked.status}`);
  }
  const ownerProfile = await myProfile(owner, 'owner');
  const staffProfile = await myProfile(staff, 'staff');
  expect('owner identity is linked to owner role', ownerProfile.role === 'owner', `role=${ownerProfile.role}`);
  expect('low-role identity is team_member/supervisor', ['team_member', 'supervisor'].includes(staffProfile.role), `role=${staffProfile.role}`);
  expect('low-role identity belongs to a real store', Boolean(staffProfile.store_id), `store_id=${staffProfile.store_id}`);

  const anonPayslips = await fetch(`${URL}/rest/v1/payslips?select=id,employee_id`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  });
  const anonBody = await anonPayslips.json().catch(() => null);
  expect('anonymous callers see no payslip data',
    anonPayslips.status === 401 || anonPayslips.status === 403 ||
      (anonPayslips.status === 200 && Array.isArray(anonBody) && anonBody.length === 0),
    `HTTP ${anonPayslips.status}`);

  expect('AAL2 owner can read staff directory', (await rest(owner, 'staff_profiles?select=id,role,store_id&limit=10')).status === 200);
  expect('AAL2 owner can read audit logs', (await rest(owner, 'audit_logs?select=id&limit=1')).status === 200);

  const staffPayslips = await rest(staff, 'payslips?select=employee_id');
  expect('low-role user can query own payslips', staffPayslips.status === 200, `HTTP ${staffPayslips.status}`);
  expect('every visible payslip belongs to the signed-in low-role user',
    rows(staffPayslips).every((row) => row.employee_id === staffProfile.id),
    `staff=${staffProfile.id}; returned=${[...new Set(rows(staffPayslips).map((row) => row.employee_id))].join(',')}`);

  const escalate = await rest(staff, `staff_profiles?id=eq.${encodeURIComponent(staffProfile.id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ role: 'owner' }),
  });
  expect('low-role user cannot self-promote', escalate.status >= 400 || rows(escalate).length === 0, `HTTP ${escalate.status}`);

  const raisePay = await rest(staff, `staff_profiles?id=eq.${encodeURIComponent(staffProfile.id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ pay_rate: 999 }),
  });
  expect('low-role user cannot alter own pay rate', raisePay.status >= 400 || rows(raisePay).length === 0, `HTTP ${raisePay.status}`);

  const bucket = await fetch(`${URL}/storage/v1/object/list/cvs`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: '', limit: 10 }),
  });
  expect('anonymous callers cannot list the private cvs bucket', bucket.status >= 400, `HTTP ${bucket.status}`);

  const fnBase = `${URL}/functions/v1`;
  const anonSigned = await fetch(`${fnBase}/cv-signed-url`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ applicationId: 'x' }),
  });
  expect('cv-signed-url refuses the anon key', anonSigned.status === 401, `HTTP ${anonSigned.status}`);

  const staffSigned = await fetch(`${fnBase}/cv-signed-url`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${staff}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ applicationId: 'x' }),
  });
  expect('cv-signed-url refuses low-role staff', staffSigned.status === 403, `HTTP ${staffSigned.status}`);

  console.log(`\nPRODUCTION RLS SMOKE — ${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
} catch (error) {
  console.error(`PRODUCTION RLS SMOKE ERROR — ${error.message}`);
  console.error('Bootstrap one AAL2 owner and one real low-role acceptance user in the first store before running this gate. No second store is required.');
  process.exit(2);
}
