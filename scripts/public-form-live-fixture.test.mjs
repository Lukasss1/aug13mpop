#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  buildContactProbe,
  deleteSyntheticContact,
  getCurrentPrivacyNotice,
} from './lib/public-form-live-fixture.mjs';

const requests = [];
const serviceKey = 'fixture-service-key';
const anonKey = 'fixture-anon-key';
const noticeId = 'notice-contact-v1';
const noticeSha = 'a'.repeat(64);
const submissionId = 'contact-probe-123';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  requests.push({
    method: req.method,
    path: url.pathname,
    search: url.search,
    apikey: req.headers.apikey || '',
    authorization: req.headers.authorization || '',
  });

  if (req.method === 'GET' && url.pathname === '/rest/v1/privacy_notice_current') {
    assert.equal(req.headers.apikey, anonKey);
    assert.equal(req.headers.authorization, `Bearer ${anonKey}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ id: noticeId, content_sha256: noticeSha }]));
    return;
  }

  if (req.method === 'DELETE' && (url.pathname === '/rest/v1/notification_outbox' || url.pathname === '/rest/v1/contact_messages')) {
    assert.equal(req.headers.apikey, serviceKey);
    assert.equal(req.headers.authorization, `Bearer ${serviceKey}`);
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

let passed = 0;
const check = (name, condition) => {
  assert.equal(Boolean(condition), true, name);
  passed += 1;
  console.log(`PASS ${name}`);
};

try {
  const notice = await getCurrentPrivacyNotice(baseUrl, anonKey, 'contact');
  check('current notice fixture returns the published notice id/hash', notice.id === noticeId && notice.sha256 === noticeSha);

  const probe = buildContactProbe(notice, 'fixture contract');
  check('contact fixture carries the current privacy notice evidence', probe.noticeId === noticeId && probe.noticeSha256 === noticeSha);
  check('contact fixture uses a unique idempotency key and valid synthetic address', typeof probe.idempotencyKey === 'string' && probe.idempotencyKey.length > 10 && /@example\.invalid$/.test(probe.row.email));

  await deleteSyntheticContact(baseUrl, serviceKey, submissionId);

  const deletes = requests.filter((r) => r.method === 'DELETE');
  check('cleanup removes synthetic outbox jobs before the contact row', deletes.length === 2 && deletes[0].path === '/rest/v1/notification_outbox' && deletes[1].path === '/rest/v1/contact_messages');

  const outboxParams = new URLSearchParams(deletes[0].search);
  check('outbox cleanup is narrowly scoped to contact + submission id', outboxParams.get('entity_type') === 'eq.contact' && outboxParams.get('entity_id') === `eq.${submissionId}`);

  const contactParams = new URLSearchParams(deletes[1].search);
  check('contact cleanup is narrowly scoped to the synthetic submission id', contactParams.get('id') === `eq.${submissionId}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log(`PUBLIC-FORM LIVE FIXTURE CONTRACT — ${passed}/${passed} passed`);
