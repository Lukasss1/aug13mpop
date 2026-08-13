#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: verify-supabase-secrets.mjs <supabase-secrets.json>'); process.exit(2); }
let parsed;
try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
catch (e) { console.error(`invalid secrets JSON: ${e.message}`); process.exit(2); }
const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.secrets) ? parsed.secrets : [];
const names = new Set(rows.map((row) => String(row?.name || row?.key || '')).filter(Boolean));
const required = [
  'APP_ENV', 'SITE_URL',
  'FORM_ALLOWED_ORIGINS', 'CV_ALLOWED_ORIGINS', 'EMAIL_ALLOWED_ORIGINS',
  'TURNSTILE_SERVER_ENABLED',
  'RESEND_API_KEY', 'EMAIL_FROM', 'ABUSE_HMAC_SECRET',
];
if (process.env.MP_EXPECT_TURNSTILE === 'true') required.push('TURNSTILE_SECRET');
const missing = required.filter((name) => !names.has(name));
const forbidden = ['MEDIA_CLEANUP_ENABLED'].filter((name) => names.has(name));
if (missing.length || forbidden.length) {
  if (missing.length) console.error(`missing required production secrets: ${missing.join(', ')}`);
  if (forbidden.length) console.error(`forbidden launch secrets must be absent: ${forbidden.join(', ')}`);
  process.exit(1);
}
console.log(`SUPABASE SECRET INVENTORY PASS — ${required.length} required present; unsafe cleanup flag absent`);
