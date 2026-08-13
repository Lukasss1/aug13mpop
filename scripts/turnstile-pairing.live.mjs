#!/usr/bin/env node
/**
 * Live Turnstile pairing gate.
 *
 * The probe now uses a genuinely valid CURRENT contact payload (including the
 * published privacy notice) and varies only the CAPTCHA token. That keeps the
 * result about Turnstile instead of accidentally testing an older form shape.
 */
import {
  buildContactProbe,
  deleteSyntheticContact,
  getCurrentPrivacyNotice,
} from './lib/public-form-live-fixture.mjs';

const url = (process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const anon = process.env.VITE_TURNSTILE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const service = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const siteKey = (process.env.VITE_TURNSTILE_SITE_KEY || '').trim();

if (!url || !anon || !service) {
  console.error('✖ VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

let notice;
try {
  notice = await getCurrentPrivacyNotice(url, anon, 'contact');
} catch (error) {
  console.error(`✖ ${error.message}`);
  process.exit(1);
}

const probe = buildContactProbe(notice, 'Turnstile pairing probe');
const res = await fetch(`${url}/functions/v1/public-form`, {
  method: 'POST',
  headers: { apikey: anon, 'Content-Type': 'application/json' },
  body: JSON.stringify(probe),
}).catch((error) => {
  console.error('✖ Could not reach public-form:', error?.message || error);
  process.exit(1);
});

const text = await res.text().catch(() => '');
let body = null;
try { body = text ? JSON.parse(text) : null; } catch { body = null; }

const serverEnforcesCaptcha = res.status === 400 && body?.code === 'captcha_missing';
const serverRunsWithoutCaptcha = (res.status === 200 && body?.ok === true) || res.status === 429;
const clientHasSiteKey = siteKey.length > 0;

if (res.status === 200 && body?.ok === true && typeof body?.submissionId === 'string') {
  try {
    await deleteSyntheticContact(url, service, body.submissionId);
  } catch (error) {
    console.error(`✖ ${error.message}`);
    process.exit(1);
  }
}

if (!serverEnforcesCaptcha && !serverRunsWithoutCaptcha) {
  console.error(`✖ Turnstile server state could not be established: HTTP ${res.status}${body?.code ? ` (${body.code})` : ''}`);
  process.exit(1);
}

console.log(`server TURNSTILE_SECRET : ${serverEnforcesCaptcha ? 'SET (token required)' : 'not set (no token required)'}`);
console.log(`client SITE_KEY         : ${clientHasSiteKey ? 'SET' : 'not set'}`);

if (serverEnforcesCaptcha === clientHasSiteKey) {
  console.log(`\n✔ Turnstile pairing OK — ${clientHasSiteKey ? 'CAPTCHA pairing configured; browser E2E still required' : 'test mode (rate limits only)'}`);
  process.exit(0);
}
console.error(
  serverEnforcesCaptcha
    ? '\n✖ PAIRING FAILURE: the server requires a token but this build has no VITE_TURNSTILE_SITE_KEY — every public form would be offline. Do NOT deploy.'
    : '\n✖ PAIRING FAILURE: this build renders a Turnstile widget but the server does not require a token — set TURNSTILE_SECRET or unset the site key.',
);
process.exit(1);
