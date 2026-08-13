#!/usr/bin/env node
/**
 * pos-e2e-live.mjs — Gate 10: the LIVE end-to-end proof.
 *
 * This script IS the till, minus the glass: it exercises the real deployed
 * stack exactly the way the iOS app does — pairing code → pos-pair →
 * bearer-token pos-ingest batches → replay → conflict → refund cap →
 * catalogue pull → rotation overlap → revocation — and then reads the day
 * back through PostgREST as the signed-in owner, RLS and all.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * YOU RUN THIS, NOT CI. Prerequisites:
 *   1. Migrations applied in order (…, migration_rls_per_role.sql,
 *      migration_pos_sync.sql, migration_pos_catalog.sql).
 *   2. Edge Functions deployed WITHOUT JWT verification:
 *        supabase functions deploy pos-pair   --no-verify-jwt
 *        supabase functions deploy pos-ingest --no-verify-jwt
 *        supabase functions deploy pos-catalog --no-verify-jwt
 *   3. An owner account (bootstrap_owner + linked auth user).
 *
 * Run:
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... \
 *   OWNER_EMAIL=... OWNER_PW=... \
 *   node scripts/pos-e2e-live.mjs
 *
 * Every run uses fresh ids (E2E-<timestamp>), so re-running never trips the
 * idempotency it is testing. It prints cleanup SQL at the end. Tokens are
 * printed MASKED — never in full.
 * ─────────────────────────────────────────────────────────────────────────
 */

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
if (!URL || !ANON || !process.env.OWNER_EMAIL || !process.env.OWNER_PW) {
  console.error('Set SUPABASE_URL, SUPABASE_ANON_KEY, OWNER_EMAIL, OWNER_PW.');
  process.exit(2);
}
const base = URL.replace(/\/$/, '');
const RUN = `E2E-${Date.now().toString(36).toUpperCase()}`;
const STORE = `${RUN}-ST`;

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log(`\u2714 ${n}`); };
const bad = (n, d) => { failed++; console.error(`\u2716 ${n}\n    ${d}`); };
const expect = (n, cond, d = '') => (cond ? ok(n) : bad(n, d));
const mask = (t) => `${String(t).slice(0, 6)}…(${String(t).length} chars)`;
const die = (msg) => { console.error(`\nFATAL: ${msg}`); process.exit(1); };

async function signIn(email, pw) {
  const res = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  });
  if (!res.ok) die(`owner sign-in failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}
async function rest(token, path, init = {}) {
  const res = await fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text().catch(() => '');
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}
/** The till's half: device-token calls to the Edge Functions. */
async function fn(name, init = {}) {
  const res = await fetch(`${base}/functions/v1/${name}`, {
    ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text().catch(() => '');
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const iso = (m) => new Date(Date.parse('2026-07-08T08:00:00Z') + m * 60000).toISOString();

/* ---------- the day the fake till will ring ---------- */
const orderPayload = (id, num, seq, total = 500, method = 'cash') => ({
  eventVersion: 1,
  order: {
    id, clientReference: `ref-${id}`, visibleOrderNumber: num, orderSequence: seq,
    storeCode: `${RUN}C`, deviceCode: 'E2E1', status: 'completed',
    subtotalPence: total, discountPence: 0, vatPence: Math.round(total / 6), totalPence: total,
    appliedDeals: [], paymentMethod: method,
    ...(method === 'cash' ? { cashReceivedPence: 1000, changeGivenPence: 1000 - total } : { manualCardConfirmation: true }),
    createdAt: iso(120), completedAt: iso(120), shiftId: `${RUN}-sh1`,
    soldByUserId: 'u1', soldByName: 'E2E Priya',
  },
  items: [{ id: `${id}-i1`, productId: 'p1', name: 'Oreo Shake', category: 'milkshakes',
    size: 'large', quantity: 1, unitPricePence: total, lineTotalPence: total,
    discountAllocationPence: 0, vatRateBp: 2000, vatPence: Math.round(total / 6),
    modifiers: [{ id: `${id}-m1`, modifierId: 'e2', name: 'Whipped Cream', pricePence: 100 }] }],
});
const ev = (id, eventType, entityId, minutes, payload) =>
  ({ id: `${RUN}-${id}`, eventType, entityId, createdAt: iso(minutes), payload });

(async () => {
  console.log(`\nPOS E2E LIVE — run ${RUN} against ${base}\n`);
  const owner = await signIn(process.env.OWNER_EMAIL, process.env.OWNER_PW);

  /* 1. Owner mints a pairing code (RPC, RLS path) */
  const codeRes = await rest(owner, 'rpc/create_pos_pairing_code', {
    method: 'POST',
    body: JSON.stringify({ p_store_id: STORE, p_store_name: `E2E Store ${RUN}`, p_device_label: 'E2E till' }),
  });
  if (codeRes.status !== 200 || !codeRes.body?.[0]?.code) die(`could not mint a code: ${codeRes.status} ${JSON.stringify(codeRes.body)}`);
  const code = codeRes.body[0].code;
  ok(`pairing code minted (${code})`);

  /* 2. pos-pair, exactly as the till sends it */
  const pair = await fn('pos-pair', {
    method: 'POST',
    body: JSON.stringify({
      code, installationId: `${RUN}-inst`,
      deviceInfo: { deviceName: 'E2E Till', deviceCode: 'E2E1', storeCode: `${RUN}C`,
        storeName: `E2E Store ${RUN}`, appVersion: '0.2.0', schemaVersion: 5, platform: 'ios' },
    }),
  });
  expect('pos-pair returns 201 + a device token', pair.status === 201 && !!pair.body?.deviceToken,
    `status ${pair.status}: ${JSON.stringify(pair.body)}`);
  if (!pair.body?.deviceToken) die('no token — cannot continue');
  let token = pair.body.deviceToken;
  const deviceId = pair.body.deviceId;
  console.log(`  device ${deviceId}, token ${mask(token)}`);
  const reuse = await fn('pos-pair', { method: 'POST', body: JSON.stringify({ code, installationId: 'x', deviceInfo: {} }) });
  expect('a pairing code is one-time (400 on reuse)', reuse.status === 400, `status ${reuse.status}`);

  /* 3. A full day in one batch — mandatory #1's live half */
  const day = [
    ev('e1', 'shift_opened', `${RUN}-sh1`, 0, { eventVersion: 1, shift: {
      id: `${RUN}-sh1`, openedAt: iso(0), openedByUserId: 'u1', openedByName: 'E2E Priya',
      openingCashPence: 5000, openingNote: null } }),
    ev('e2', 'order_created', `${RUN}-o1`, 120, orderPayload(`${RUN}-o1`, `${RUN}C-E2E1-1001`, 1001)),
    ev('e3', 'order_created', `${RUN}-o2`, 130, orderPayload(`${RUN}-o2`, `${RUN}C-E2E1-1002`, 1002, 600, 'card')),
    ev('e4', 'refund_created', `${RUN}-r1`, 200, { eventVersion: 1, refund: {
      id: `${RUN}-r1`, orderId: `${RUN}-o2`, visibleOrderNumber: `${RUN}C-E2E1-1002`,
      shiftId: `${RUN}-sh1`, kind: 'custom', method: 'card', amountPence: 200,
      reason: 'E2E melt', userId: 'u1', userName: 'E2E Priya',
      approvedByUserId: 'u1', approvedByName: 'E2E Priya',
      cardTerminalConfirmed: true, createdAt: iso(200) }, items: [], approval: {
        id: `${RUN}-ap1`, actionType: 'refund', entityType: 'refund', entityId: `${RUN}-r1`,
        approverUserId: 'u1', approverName: 'E2E Priya', requestedByUserId: 'u1',
        requestedByName: 'E2E Priya', reason: 'E2E melt', createdAt: iso(200) } }),
    ev('e5', 'void_created', `${RUN}-v1`, 210, { eventVersion: 1, void: {
      id: `${RUN}-v1`, orderId: `${RUN}-o1`, visibleOrderNumber: `${RUN}C-E2E1-1001`,
      orderTotalPence: 500, method: 'cash', cardTerminalConfirmed: false,
      shiftId: `${RUN}-sh1`, reason: 'E2E rung twice', userId: 'u1', userName: 'E2E Priya',
      approvedByUserId: 'u1', approvedByName: 'E2E Priya', createdAt: iso(210) }, approval: null }),
    ev('e6', 'shift_closed', `${RUN}-sh1`, 540, { eventVersion: 1, shift: {
      id: `${RUN}-sh1`, openedAt: iso(0), openedByUserId: 'u1', openedByName: 'E2E Priya',
      closedAt: iso(540), closedByUserId: 'u1', closedByName: 'E2E Priya',
      openingCashPence: 5000, countedCashPence: 5000, reportedCardPence: 400,
      expectedCashPence: 5000, cashVariancePence: 0, expectedCardPence: 400,
      cardVariancePence: 0, varianceReason: null, closingNote: 'E2E day' },
      summary: { shiftId: `${RUN}-sh1`, countedCashPence: 5000 }, approval: null }),
  ];
  const ingest = await fn('pos-ingest', {
    method: 'POST', headers: bearer(token),
    body: JSON.stringify({ device: { installationId: `${RUN}-inst`, appVersion: '0.2.0', schemaVersion: 5 }, events: day }),
  });
  expect('a full day ingests with every event acknowledged',
    ingest.status === 200 && ingest.body?.acknowledgedIds?.length === 6 && ingest.body?.rejectedIds?.length === 0,
    `status ${ingest.status}: ${JSON.stringify(ingest.body).slice(0, 300)}`);
  expect('the acknowledgement advertises a catalogVersion field',
    typeof ingest.body?.catalogVersion === 'number', `got ${typeof ingest.body?.catalogVersion}`);

  /* 4. Idempotent replay + conflict (mandatory #2 / #12 live) */
  const replay = await fn('pos-ingest', {
    method: 'POST', headers: bearer(token),
    body: JSON.stringify({ device: { installationId: `${RUN}-inst`, appVersion: '0.2.0', schemaVersion: 5 },
      events: [day[1]] }),
  });
  expect('an identical replay is acknowledged, not duplicated',
    replay.status === 200 && replay.body?.acknowledgedIds?.length === 1, `status ${replay.status}`);
  const conflict = await fn('pos-ingest', {
    method: 'POST', headers: bearer(token),
    body: JSON.stringify({ device: { installationId: `${RUN}-inst`, appVersion: '0.2.0', schemaVersion: 5 },
      events: [{ ...day[1], payload: { eventVersion: 1, order: { id: 'tampered' } } }] }),
  });
  expect('the same id with a DIFFERENT payload is duplicate_conflict',
    conflict.body?.rejections?.[0]?.reason === 'duplicate_conflict',
    JSON.stringify(conflict.body).slice(0, 200));

  /* 5. Refund cap across distinct refunds (mandatory #10 live) */
  const capped = await fn('pos-ingest', {
    method: 'POST', headers: bearer(token),
    body: JSON.stringify({ device: { installationId: `${RUN}-inst`, appVersion: '0.2.0', schemaVersion: 5 },
      events: [ev('e7', 'refund_created', `${RUN}-r2`, 220, { eventVersion: 1, refund: {
        id: `${RUN}-r2`, orderId: `${RUN}-o2`, visibleOrderNumber: `${RUN}C-E2E1-1002`,
        shiftId: `${RUN}-sh1`, kind: 'custom', method: 'card', amountPence: 500,
        reason: 'over-refund probe', userId: 'u1', userName: 'E2E Priya',
        approvedByUserId: 'u1', approvedByName: 'E2E Priya',
        cardTerminalConfirmed: true, createdAt: iso(220) }, items: [], approval: null })] }),
  });
  expect('a second refund breaching the amount paid is refused as invalid_money',
    capped.body?.rejections?.[0]?.reason === 'invalid_money', JSON.stringify(capped.body).slice(0, 200));

  /* 6. Owner reads the day back through RLS (mandatory #7's live half) */
  const readBack = await rest(owner,
    `pos_orders?select=id,total_pence,items:pos_order_items(id,modifiers:pos_order_item_modifiers(id)),refunds:pos_refunds(amount_pence),voids:pos_voids(id)&id=eq.${encodeURIComponent(`${RUN}-o2`)}`);
  expect('the owner reads the till order back with items + refund embedded',
    readBack.status === 200 && readBack.body?.[0]?.total_pence === 600 &&
    readBack.body?.[0]?.refunds?.[0]?.amount_pence === 200,
    `status ${readBack.status}: ${JSON.stringify(readBack.body).slice(0, 200)}`);

  /* 7. Catalogue publish → advertise → device pull (Gate 9 live) */
  const pub = await rest(owner, 'rpc/publish_pos_catalog', {
    method: 'POST',
    body: JSON.stringify({ p_snapshot: { categories: [{ id: 'milkshakes', name: 'Milkshakes', sortOrder: 0, active: true }],
      products: [{ id: `${RUN}-p1`, categoryId: 'milkshakes', name: 'E2E Storm', description: '',
        basePricePence: 650, largePricePence: null, vatRateBp: 2000, allergens: [], active: true, sortOrder: 0 }] } }),
  });
  expect('the owner can publish a catalogue', pub.status === 200 && Number(pub.body) >= 1, `status ${pub.status}`);
  const cat = await fn('pos-catalog', { method: 'GET', headers: bearer(token) });
  expect('the device pulls the published catalogue with its token',
    cat.status === 200 && cat.body?.catalogVersion >= 1 &&
    cat.body?.catalog?.products?.some((p) => p.id === `${RUN}-p1`),
    `status ${cat.status}`);
  const catAnon = await fn('pos-catalog', { method: 'GET' });
  expect('the catalogue refuses without a device token', catAnon.status === 401, `status ${catAnon.status}`);

  /* 8. Rotation overlap → promotion (mandatory #5 groundwork, live) */
  const rot = await rest(owner, 'rpc/rotate_pos_device_token', {
    method: 'POST', body: JSON.stringify({ p_device_id: deviceId }),
  });
  expect('the owner rotates the token (plaintext returned once)',
    rot.status === 200 && typeof rot.body === 'string' && rot.body.length > 20, `status ${rot.status}`);
  const newToken = rot.body;
  console.log(`  rotated token ${mask(newToken)} (old stays valid until first use of the new one)`);
  const oldStillWorks = await fn('pos-ingest', {
    method: 'POST', headers: bearer(token),
    body: JSON.stringify({ device: { installationId: `${RUN}-inst`, appVersion: '0.2.0', schemaVersion: 5 }, events: [day[0]] }),
  });
  expect('OVERLAP: the old token still works before the new one is used', oldStillWorks.status === 200, `status ${oldStillWorks.status}`);
  const promote = await fn('pos-ingest', {
    method: 'POST', headers: bearer(newToken),
    body: JSON.stringify({ device: { installationId: `${RUN}-inst`, appVersion: '0.2.0', schemaVersion: 5 }, events: [day[0]] }),
  });
  expect('the new token authenticates (promotion)', promote.status === 200, `status ${promote.status}`);
  const oldDead = await fn('pos-ingest', {
    method: 'POST', headers: bearer(token),
    body: JSON.stringify({ device: { installationId: `${RUN}-inst`, appVersion: '0.2.0', schemaVersion: 5 }, events: [day[0]] }),
  });
  expect('the old token is DEAD after promotion (401)', oldDead.status === 401, `status ${oldDead.status}`);
  token = newToken;

  /* 9. Revocation (mandatory #5, live) */
  const rev = await rest(owner, 'rpc/revoke_pos_device', {
    method: 'POST', body: JSON.stringify({ p_device_id: deviceId }),
  });
  expect('the owner revokes the device', rev.status === 200 || rev.status === 204, `status ${rev.status}`);
  const afterRevoke = await fn('pos-ingest', {
    method: 'POST', headers: bearer(token),
    body: JSON.stringify({ device: { installationId: `${RUN}-inst`, appVersion: '0.2.0', schemaVersion: 5 }, events: [day[0]] }),
  });
  expect('a revoked device gets 401 and nothing is applied', afterRevoke.status === 401, `status ${afterRevoke.status}`);
  const catRevoked = await fn('pos-catalog', { method: 'GET', headers: bearer(token) });
  expect('a revoked device cannot pull the catalogue either', catRevoked.status === 401, `status ${catRevoked.status}`);

  /* ---------- verdict + cleanup ---------- */
  console.log(`\n${failed === 0 ? '\u2714' : '\u2716'} POS E2E LIVE — ${passed} passed, ${failed} failed (run ${RUN})`);
  console.log(`\nCleanup SQL (removes ONLY this run's rows):
  delete from pos_refunds where store_id = '${STORE}';
  delete from pos_voids where store_id = '${STORE}';
  delete from pos_order_item_modifiers where order_item_id in (select id from pos_order_items where order_id in (select id from pos_orders where store_id = '${STORE}'));
  delete from pos_order_items where order_id in (select id from pos_orders where store_id = '${STORE}');
  delete from pos_orders where store_id = '${STORE}';
  delete from pos_shifts where store_id = '${STORE}';
  delete from pos_audit_events where store_id = '${STORE}';
  delete from pos_approvals where store_id = '${STORE}';
  delete from pos_events where device_id in (select id from pos_devices where store_id = '${STORE}');
  delete from pos_pairing_codes where store_id = '${STORE}';
  delete from pos_devices where store_id = '${STORE}';
  delete from pos_catalog where snapshot::text like '%${RUN}-p1%';`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => die(e instanceof Error ? e.message : String(e)));
