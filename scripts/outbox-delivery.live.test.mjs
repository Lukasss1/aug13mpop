#!/usr/bin/env node
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

let delivered = false;
let outboxDeleted = false;
let contactDeleted = false;
const outboxId = 'probe-outbox-id';

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  const send = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.headers.apikey !== 'test-service-secret' || req.headers.authorization !== 'Bearer test-service-secret') return send(401, { error: 'bad_auth' });
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/rest/v1/contact_messages') {
    const row = JSON.parse(body); return send(201, [row]);
  }
  if (req.method === 'POST' && url.pathname === '/rest/v1/notification_outbox') {
    return send(201, [{ id: outboxId }]);
  }
  if (req.method === 'POST' && url.pathname === '/functions/v1/outbox-dispatch') {
    delivered = true; return send(200, { ok: true, claimed: 1, results: { [outboxId]: 'delivered' } });
  }
  if (req.method === 'GET' && url.pathname === '/rest/v1/notification_outbox') {
    return send(200, [{
      status: delivered ? 'delivered' : 'pending',
      provider_message_id: delivered ? 'provider-123' : null,
      last_error_code: null,
      last_error_message: null,
      attempt_count: delivered ? 1 : 0,
    }]);
  }
  if (req.method === 'DELETE' && url.pathname === '/rest/v1/notification_outbox') {
    outboxDeleted = true; res.writeHead(204); return res.end();
  }
  if (req.method === 'DELETE' && url.pathname === '/rest/v1/contact_messages') {
    contactDeleted = true; res.writeHead(204); return res.end();
  }
  send(404, { error: 'not_found', path: url.pathname });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const child = spawn(process.execPath, ['scripts/outbox-delivery.live.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SUPABASE_URL: `http://127.0.0.1:${address.port}`,
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-secret',
    OUTBOX_TEST_RECIPIENT_EMAIL: 'commissioning@example.test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '';
child.stdout.on('data', (d) => { stdout += d; });
child.stderr.on('data', (d) => { stderr += d; });
const code = await new Promise((resolve) => child.on('close', resolve));
server.close();

let passed = 0;
const check = (name, condition) => {
  assert.equal(condition, true, name);
  passed += 1;
  console.log(`PASS ${name}`);
};
check('probe exits successfully', code === 0);
check('probe requires delivered status and emits PASS marker', /OUTBOX DELIVERY LIVE PASS/.test(stdout));
check('probe masks recipient address', /c\*\*\*@example\.test/.test(stdout) && !stdout.includes('commissioning@example.test'));
check('probe never prints the service-role secret', !stdout.includes('test-service-secret') && !stderr.includes('test-service-secret'));
check('probe deletes its synthetic outbox row', outboxDeleted);
check('probe deletes its synthetic contact row', contactDeleted);
console.log(`OUTBOX DELIVERY LIVE CONTRACT — ${passed}/${passed} passed`);
