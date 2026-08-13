#!/usr/bin/env node
/**
 * Live public-form boundary proof.
 *
 * 1. Direct anonymous writes to the three protected form tables stay denied.
 * 2. The deployed public-form function accepts/gates a CURRENT valid contact
 *    payload, including the privacy notice evidence required by the API today.
 *
 * A successful synthetic insert is deleted immediately with the protected
 * service-role key so production is not left with test submissions.
 */
import {
  buildContactProbe,
  deleteSyntheticContact,
  getCurrentPrivacyNotice,
} from './lib/public-form-live-fixture.mjs';

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!URL_BASE || !ANON || (!SERVICE && process.env.SKIP_FUNCTION_CHECK !== '1')) {
  console.error('SUPABASE_URL, SUPABASE_ANON_KEY and (for the function probe) SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

let passed = 0;
let failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) { passed += 1; console.log(`✔ ${name}`); }
  else { failed += 1; console.error(`✘ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const TABLES = [
  ['job_applications', { id: `probe_${Date.now()}_a`, full_name: 'Probe', email: 'probe@example.invalid' }],
  ['franchise_inquiries', { id: `probe_${Date.now()}_f`, full_name: 'Probe', email: 'probe@example.invalid' }],
  ['contact_messages', { id: `probe_${Date.now()}_c`, full_name: 'Probe', email: 'probe@example.invalid', message: 'probe' }],
];

for (const [table, row] of TABLES) {
  const res = await fetch(`${URL_BASE}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify([row]),
  }).catch((error) => ({ status: 0, text: async () => String(error) }));
  check(
    `direct anon INSERT into ${table} is rejected`,
    res.status === 401 || res.status === 403,
    `got HTTP ${res.status}`,
  );
}

for (const [table] of TABLES) {
  const res = await fetch(`${URL_BASE}/rest/v1/${table}?id=eq.__none__`, {
    method: 'DELETE',
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  }).catch(() => ({ status: 0 }));
  check(`direct anon DELETE on ${table} is rejected`, res.status === 401 || res.status === 403, `got HTTP ${res.status}`);
}

if (process.env.SKIP_FUNCTION_CHECK === '1') {
  console.log('… SKIP_FUNCTION_CHECK=1 — Edge Function acceptance probe skipped.');
} else {
  try {
    const notice = await getCurrentPrivacyNotice(URL_BASE, ANON, 'contact');
    const probe = buildContactProbe(notice, 'public-form rejection/live gate probe');
    const res = await fetch(`${URL_BASE}/functions/v1/public-form`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify(probe),
    });
    const text = await res.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }

    const captchaMissing = res.status === 400 && body?.code === 'captcha_missing';
    const rateLimited = res.status === 429;
    const accepted = res.status === 200 && body?.ok === true && typeof body?.submissionId === 'string';
    check(
      'the public-form Edge Function accepts or correctly gates a current valid submission',
      accepted || captchaMissing || rateLimited,
      `got HTTP ${res.status}${body?.code ? ` (${body.code})` : ''}`,
    );

    if (accepted) {
      try {
        await deleteSyntheticContact(URL_BASE, SERVICE, body.submissionId);
        check('synthetic accepted contact probe is deleted immediately', true);
      } catch (error) {
        check('synthetic accepted contact probe is deleted immediately', false, error.message);
      }
    }
  } catch (error) {
    check('current contact privacy notice is available for the live function probe', false, error.message);
  }
}

console.log(`\n${failed === 0 ? '✔' : '✘'} PUBLIC-FORM REJECTION PROBES — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
