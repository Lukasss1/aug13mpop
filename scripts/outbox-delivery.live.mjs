#!/usr/bin/env node
/**
 * Production-only outbox delivery probe.
 *
 * Creates one synthetic Contact row and one customer-ack outbox job with the
 * service role, invokes the real outbox-dispatch Edge Function, waits for the
 * job to reach `delivered` with a provider message id, and removes both probe
 * rows. No credential or full recipient address is printed.
 */
import { randomUUID } from 'node:crypto';

const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const recipient = (process.env.OUTBOX_TEST_RECIPIENT_EMAIL || process.env.PRODUCTION_OWNER_EMAIL || '').trim();

if (!base || !serviceRole || !recipient) {
  console.error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and OUTBOX_TEST_RECIPIENT_EMAIL (or PRODUCTION_OWNER_EMAIL) are required.');
  process.exit(2);
}

const maskEmail = (value) => value.replace(/(^.).*(@.*$)/, '$1***$2');
const probe = randomUUID();
const contactId = `commissioning-contact-${probe}`;
let outboxId = '';
let contactCreated = false;
let outboxCreated = false;

const headers = {
  apikey: serviceRole,
  Authorization: `Bearer ${serviceRole}`,
  'Content-Type': 'application/json',
};

async function rest(path, init = {}) {
  return fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
}

async function expectJson(response, label) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status} ${String(text).slice(0, 240)}`);
  return body;
}

async function createProbe() {
  const contact = await expectJson(await rest('contact_messages', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      id: contactId,
      full_name: 'Milk Pop Commissioning Probe',
      email: recipient,
      reason: 'commissioning_probe',
      message: 'Synthetic delivery probe; safe to delete.',
      submitted_at: new Date().toISOString(),
    }),
  }), 'contact probe insert');
  if (!Array.isArray(contact) || contact[0]?.id !== contactId) throw new Error('contact probe insert returned an unexpected row');
  contactCreated = true;

  const rows = await expectJson(await rest('notification_outbox', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      event_type: 'commissioning.probe',
      entity_type: 'contact',
      entity_id: contactId,
      recipient_kind: 'customer_ack',
      template_id: 'customer-ack',
      payload: { kind: 'contact', commissioning_probe: true },
      status: 'pending',
      // Put the probe first without changing any real queue row.
      next_attempt_at: '1970-01-01T00:00:00.000Z',
    }),
  }), 'outbox probe insert');
  outboxId = Array.isArray(rows) ? String(rows[0]?.id || '') : '';
  if (!outboxId) throw new Error('outbox probe insert did not return an id');
  outboxCreated = true;
}

async function dispatch() {
  return expectJson(await fetch(`${base}/functions/v1/outbox-dispatch`, {
    method: 'POST',
    headers,
    body: '{}',
  }), 'outbox-dispatch');
}

async function readOutbox() {
  const select = 'status,provider_message_id,last_error_code,last_error_message,attempt_count';
  const rows = await expectJson(await rest(`notification_outbox?id=eq.${encodeURIComponent(outboxId)}&select=${select}`), 'outbox probe read');
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('outbox probe row disappeared before verification');
  return rows[0];
}

async function waitForDelivery() {
  const deadline = Date.now() + 60_000;
  let last = null;
  let dispatches = 0;
  while (Date.now() < deadline) {
    if (dispatches < 3 && (!last || ['pending', 'retry'].includes(last.status))) {
      await dispatch();
      dispatches += 1;
    }
    last = await readOutbox();
    if (last.status === 'delivered') {
      if (!String(last.provider_message_id || '').trim()) throw new Error('outbox job says delivered but has no provider message id');
      return last;
    }
    if (['dead_letter', 'blocked_config', 'failed'].includes(last.status)) {
      throw new Error(`outbox probe ended as ${last.status} (${last.last_error_code || 'no_code'})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`outbox probe timed out in status ${last?.status || 'unknown'} (${last?.last_error_code || 'no_code'})`);
}

async function cleanup() {
  const errors = [];
  if (outboxCreated && outboxId) {
    const r = await rest(`notification_outbox?id=eq.${encodeURIComponent(outboxId)}`, { method: 'DELETE' }).catch((e) => ({ ok: false, status: 0, _error: e }));
    if (!r.ok) errors.push(`outbox cleanup HTTP ${r.status}`);
  }
  if (contactCreated) {
    const r = await rest(`contact_messages?id=eq.${encodeURIComponent(contactId)}`, { method: 'DELETE' }).catch((e) => ({ ok: false, status: 0, _error: e }));
    if (!r.ok) errors.push(`contact cleanup HTTP ${r.status}`);
  }
  if (errors.length) throw new Error(errors.join('; '));
}

let primaryError = null;
try {
  await createProbe();
  const delivered = await waitForDelivery();
  console.log(`OUTBOX DELIVERY LIVE PASS — delivered synthetic acknowledgement to ${maskEmail(recipient)} (attempts=${delivered.attempt_count})`);
} catch (error) {
  primaryError = error;
} finally {
  try { await cleanup(); }
  catch (cleanupError) {
    primaryError = primaryError
      ? new Error(`${primaryError.message}; cleanup failed: ${cleanupError.message}`)
      : cleanupError;
  }
}

if (primaryError) {
  console.error(`OUTBOX DELIVERY LIVE FAIL — ${primaryError.message}`);
  process.exit(1);
}
