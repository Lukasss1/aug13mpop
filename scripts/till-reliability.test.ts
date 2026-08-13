/**
 * till-reliability.test.ts — R4.1 CLIENT RELIABILITY suite (static; runs in
 * `npm run verify`, no database and no browser).
 *
 * Implements the auditor's REQUIRED ACCEPTANCE SCENARIOS for the R4.1 round:
 *   1. STORAGE FAIL-CLOSED — if the browser cannot durably record a payment
 *      identity (verified read-back), ZERO RPC calls are made.
 *   2. RESERVATION AMBIGUITY — a lost begin response leaves the attempt at
 *      'reserving'; payment capabilities stay OFF; the retry replays the
 *      byte-identical request and only a positive answer promotes it.
 *   3. QUOTE IDENTITY — the quote id and payload are built once; every retry
 *      body is byte-identical (a lost response can never mint a second quote).
 *   4. ENROLMENT — parses the REAL flat response (top-level deviceId), makes
 *      exactly ONE attempt (a credential mint is not idempotent), and an
 *      ambiguous outcome leaves a durable review marker.
 *   5. FORGET / RE-PAIR — revoked-device refusals guide to re-pair; forgetting
 *      is local-only (zero network).
 *   6. REFRESH RECOVERY — the capability matrix per stage, from the durable
 *      store, so a reloaded till can only offer safe actions.
 *   7. RESPONSE CONTRACTS — representative payloads pinned VERBATIM from the
 *      migration sources for every envelope the client reads.
 *   8. RETRY AUDIT — a source scan proving no identity/timestamp is generated
 *      inside any withRetry callback.
 *   9-16. R4.2 CLIENT-STATE INTEGRITY — corruption fails closed with zero
 *      RPCs and zero overwrites; a single till-tab lease gates every money
 *      path; held recovery writes cannot be replaced; enrolment is
 *      single-flight and marker-gated; stage promotions and drawer sessions
 *      are verified before success is reported; forget is custody-aware;
 *      the UI never claims provider reconciliation.
 *   18-20. R4.3 — the RECOVERY PAGE acquires the lease itself (fresh direct
 *      load blocked-then-permitted; secondary admin tab zero-RPC; failover
 *      replays the held write); lease-mechanism honesty (locks vs degraded
 *      heartbeat); custody-marker clearing uses verified deletion.
 *
 * Runner: npm exec --offline -- tsx scripts/till-reliability.test.ts
 */

import { readFileSync } from 'node:fs';

/* ---------- shims (BEFORE importing the module under test) ---------- */

type StorageMode = 'ok' | 'throw-set' | 'null-get' | 'tamper-get';
let storageMode: StorageMode = 'ok';
/** R4.2: fail exactly the Nth setItem after arming — for testing a durable
 *  write that fails PART-WAY through a flow (e.g. the promotion write). */
let failSetWrites = new Set<number>();
let setSeq = 0;
function armFailSet(...idx: number[]): void { failSetWrites = new Set(idx); setSeq = 0; }
/** R4.3: simulate a browser where removeItem silently fails (verified-deletion tests). */
let blockRemove = false;
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => {
    if (storageMode === 'null-get') return null;
    if (storageMode === 'tamper-get') return store.has(k) ? `${store.get(k)!}X` : null;
    return store.has(k) ? store.get(k)! : null;
  },
  setItem: (k: string, v: string) => {
    if (storageMode === 'throw-set') throw new Error('QuotaExceededError (simulated)');
    setSeq += 1;
    if (failSetWrites.has(setSeq)) throw new Error('QuotaExceededError (simulated, targeted)');
    store.set(k, String(v));
  },
  removeItem: (k: string) => { if (blockRemove) return; store.delete(k); },
  clear: () => { store.clear(); },
};

type MockCall = { url: string; body: string };
type MockStep =
  | { kind: 'ok'; status?: number; json: unknown }
  | { kind: 'http'; status: number; json: unknown }
  | { kind: 'throw' };
let calls: MockCall[] = [];
let script: MockStep[] = [];
(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { body?: string }) => {
  const call = { url: String(url), body: String(init?.body ?? '') };
  calls.push(call);
  const step = script.shift();
  if (!step) throw new Error(`fetch mock exhausted for ${call.url}`);
  if (step.kind === 'throw') throw new TypeError('network down');
  const status = step.kind === 'ok' ? (step.status ?? 200) : step.status;
  return new Response(JSON.stringify(step.json), { status, headers: { 'Content-Type': 'application/json' } });
};

const tp = await import('../src/lib/tillPayments');
const tillLease = await import('../src/lib/tillLease');
tp._setTestConfig({ url: 'https://till.test', anonKey: 'anon-test-key' });

/* ---------- harness ---------- */

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `  — ${detail}`}`);
  if (ok) passed += 1; else failed += 1;
};
const deps: import('../src/lib/tillPayments').FlowDeps = { getAccessToken: async () => 'jwt-test-token' };
const SECRET = 'pair-secret-VERY-PRIVATE-9911';
const custody = { sessionId: 'sess_test_01', deviceId: 'dev_test_01', secret: SECRET };
function reset(withCustody = true): void {
  storageMode = 'ok'; store.clear(); calls = []; script = [];
  if (withCustody) {
    tp.storePairedDevice({ deviceId: 'dev_test_01', label: 'Test till', secret: SECRET, pairedAt: new Date().toISOString() });
    tp.storeLocalTillSession({ sessionId: 'sess_test_01', deviceId: 'dev_test_01', openedAt: new Date().toISOString() });
  }
}
const quote = (id: string, total = 6.5): import('../src/lib/tillPayments').QuoteRow => ({
  id, status: 'OPEN', total, expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
});
const named = (msg: string, status = 400) => ({ kind: 'http', status, json: { message: `P0001: ${msg}` } }) as MockStep;

/* ================================================================== */
/*  1 · STORAGE FAIL-CLOSED before reservation — three failure modes   */
/* ================================================================== */
for (const mode of ['throw-set', 'null-get', 'tamper-get'] as StorageMode[]) {
  reset();
  storageMode = mode;
  const res = await tp.reservePayment(deps, quote(`q_stg_${mode}`), 'cash', custody);
  check(`storage gate (${mode}): reservation refused as a STORAGE failure`,
    res.status === 'unavailable' && res.reason === 'storage');
  check(`storage gate (${mode}): ZERO RPC calls were made`, calls.length === 0, `calls=${calls.length}`);
}

/* ================================================================== */
/*  2 · STORAGE FAIL-CLOSED before finalisation                        */
/* ================================================================== */
{
  reset();
  script = [{ kind: 'ok', json: { quote: {}, state: 'reserved', duplicate: false } }];
  const r = await tp.reservePayment(deps, quote('q_stg_fin'), 'cash', custody);
  if (r.status !== 'reserved') throw new Error('setup failed');
  storageMode = 'throw-set';
  const before = calls.length;
  const f = await tp.finaliseCash(deps, r.attempt, '10.00');
  check('storage gate: finalisation without verified facts is STORAGE_FAILED',
    f.status === 'storage_failed');
  check('storage gate: the finalise RPC was NEVER sent', calls.length === before, `calls=${calls.length}`);
}

/* ================================================================== */
/*  3 · RESERVATION AMBIGUITY — reserving stage, byte-identical resume */
/* ================================================================== */
{
  reset();
  script = [{ kind: 'throw' }, { kind: 'throw' }, { kind: 'throw' }];
  const r = await tp.reservePayment(deps, quote('q_ambig_001'), 'cash', custody);
  check('ambiguity: a lost begin response returns UNCONFIRMED', r.status === 'unconfirmed');
  const firstBody = calls[0]!.body;
  check('ambiguity: every send in the loop was byte-identical', calls.every((c) => c.body === firstBody));
  const held = tp.pendingAttempts()[0];
  check('ambiguity: the durable attempt is at stage RESERVING', !!held && held.stage === 'reserving');
  const caps = held ? tp.attemptCapabilities(held) : null;
  check('ambiguity: payment capability is OFF; resume-reserve is ON',
    !!caps && !caps.canTakePayment && caps.canResumeReserve && !caps.canRetryFinalise && caps.canRelease);
  calls = [];
  // Server truth (ws7b begin, replay path): same reservationId → positive
  // confirmation with duplicate:true.
  script = [{ kind: 'ok', json: { quote: {}, state: 'reserved', duplicate: true } }];
  const g = await tp.resumeReserve(deps, held!);
  check('ambiguity: resume gets the positive answer and promotes to RESERVED',
    g.status === 'reserved' && tp.pendingAttempts()[0]!.stage === 'reserved');
  check('ambiguity: the resumed request is BYTE-IDENTICAL to the first send',
    calls[0]!.body === firstBody);
  const caps2 = tp.attemptCapabilities(tp.pendingAttempts()[0]!);
  check('ambiguity: payment capability turns ON only after confirmation',
    caps2.canTakePayment && !caps2.canResumeReserve);
}

/* ================================================================== */
/*  4 · QUOTE IDENTITY — one id, byte-identical retry bodies           */
/* ================================================================== */
{
  reset();
  script = [{ kind: 'throw' }, { kind: 'http', status: 503, json: { message: 'upstream' } },
            { kind: 'ok', json: { quote: { id: 'q_server_01', status: 'OPEN', total: 6.5, expires_at: new Date(Date.now() + 900_000).toISOString() }, duplicate: false } }];
  const res = await tp.priceQuote(deps, { items: [{ menuItemId: 'm1', quantity: 1 }] });
  check('quote identity: three sends for one logical quote, then priced',
    res.status === 'priced' && calls.length === 3, `calls=${calls.length}`);
  check('quote identity: all three bodies are BYTE-IDENTICAL',
    calls.every((c) => c.body === calls[0]!.body));
  const idMatch = calls[0]!.body.match(/"id":"(q_[0-9a-f]+)"/);
  check('quote identity: a single client id rode every retry',
    !!idMatch && calls.every((c) => c.body.includes(idMatch![1]!)));
  check('quote identity: the request slot is cleared once the call resolves',
    store.get('milkpop_quote_request_v1') === undefined);
}

/* ================================================================== */
/*  5 · ENROLMENT — real flat contract, exactly one attempt            */
/* ================================================================== */
{
  reset(false);
  // VERBATIM shape from migration_stage3_ws7b_payment_authority.sql,
  // enrol_till_device(): a FLAT object, deviceId at the top level.
  script = [{ kind: 'ok', json: {
    deviceId: 'dev_ab12', storeId: 'store_1', label: 'Front till',
    pairingSecret: 'ps_issued_once_777',
    note: 'The pairing secret is shown once. The server stores only its hash.',
  } }];
  const res = await tp.enrolThisDevice(deps, 'Front till');
  check('enrol contract: the REAL flat payload pairs successfully',
    res.status === 'paired' && res.status === 'paired' && res.device.deviceId === 'dev_ab12');
  check('enrol contract: the one-time secret is verified into the device store',
    tp.getPairedDevice()?.secret === 'ps_issued_once_777');
  check('enrol contract: exactly ONE wire attempt', calls.length === 1, `calls=${calls.length}`);
  check('enrol contract: the custody marker is cleared on success', tp.getCustodyMarker() === null);
}

/* ================================================================== */
/*  6 · ENROLMENT NETWORK LOSS — no auto-retry, durable review marker  */
/* ================================================================== */
{
  reset(false);
  script = [{ kind: 'throw' }];
  const res = await tp.enrolThisDevice(deps, 'Front till');
  check('enrol ambiguity: the outcome is UNKNOWN (never silently retried)',
    res.status === 'unknown');
  check('enrol ambiguity: exactly ONE wire attempt — a credential mint is not idempotent',
    calls.length === 1, `calls=${calls.length}`);
  const m = tp.getCustodyMarker();
  check('enrol ambiguity: a durable review marker is held for the manager',
    !!m && m.kind === 'enrol' && m.outcome === 'unknown');
  check('enrol ambiguity: no phantom pairing was stored', tp.getPairedDevice() === null);
}

/* ================================================================== */
/*  7 · REVOKED DEVICE — guidance + local-only forget                  */
/* ================================================================== */
{
  reset();
  script = [named('permission denied: till_device_revoked', 401)];
  const res = await tp.openDrawer(deps);
  check('revoked: the named 401 maps to till_device_revoked',
    res.status === 'refused' && res.reason === 'till_device_revoked');
  check('revoked: the cashier wording points at re-pairing',
    tp.refusalText('till_device_revoked').includes('re-pair'));
  const before = calls.length;
  tp.clearLocalTillSession();   // R4.2: forget is BLOCKED while a drawer session exists (proven in §15)
  const fg = tp.forgetPairedDevice();
  check('forget: succeeds once no custody is live', fg.status === 'forgotten');
  check('forget: local pairing is cleared', tp.getPairedDevice() === null);
  check('forget: ZERO network calls — the server device is untouched', calls.length === before);
}

/* ================================================================== */
/*  8 · REFRESH RECOVERY — the capability matrix per durable stage     */
/* ================================================================== */
{
  reset();
  // finalising: reserve ok, then finalise into ambiguity.
  script = [{ kind: 'ok', json: { quote: {}, state: 'reserved', duplicate: false } }];
  const r = await tp.reservePayment(deps, quote('q_caps_0001'), 'card');
  if (r.status !== 'reserved') throw new Error('setup failed');
  script = [{ kind: 'throw' }, { kind: 'throw' }, { kind: 'throw' }];
  await tp.finaliseCardOrOnline(deps, r.attempt, 'TRX-1');
  const fin = tp.pendingAttempts()[0]!;
  const caps = tp.attemptCapabilities(fin);
  check('capabilities (finalising): ONLY retry-finalise is offered',
    fin.stage === 'finalising' && caps.canRetryFinalise && !caps.canTakePayment && !caps.canResumeReserve && !caps.canRelease);
  const table = [
    { stage: 'reserving' as const,  expect: { canTakePayment: false, canResumeReserve: true,  canRetryFinalise: false, canRelease: true } },
    { stage: 'reserved' as const,   expect: { canTakePayment: true,  canResumeReserve: false, canRetryFinalise: false, canRelease: true } },
    { stage: 'finalising' as const, expect: { canTakePayment: false, canResumeReserve: false, canRetryFinalise: true,  canRelease: false } },
  ];
  check('capabilities: the full stage matrix holds', table.every((row) => {
    const c = tp.attemptCapabilities({ ...fin, stage: row.stage });
    return (Object.keys(row.expect) as (keyof typeof row.expect)[]).every((k) => c[k] === row.expect[k]);
  }));
}

/* ================================================================== */
/*  9 · RESPONSE CONTRACTS — representative payloads pinned from SQL   */
/* ================================================================== */
{
  reset();
  // finalise_order_payment (ws7c): fresh path carries paymentStatus …
  script = [{ kind: 'ok', json: { quote: {}, state: 'reserved', duplicate: false } }];
  const r = await tp.reservePayment(deps, quote('q_ctr_00001'), 'cash', custody);
  if (r.status !== 'reserved') throw new Error('setup failed');
  script = [{ kind: 'ok', json: { order: { id: 'ord_ctr1' }, duplicate: false, paymentStatus: 'CASH_RECORDED' } }];
  const f1 = await tp.finaliseCash(deps, r.attempt, '10.00');
  check('contract (finalise, fresh): order + duplicate:false + paymentStatus read',
    f1.status === 'confirmed' && f1.duplicate === false && f1.paymentStatus === 'CASH_RECORDED');
  // … and the DUPLICATE replay path returns NO paymentStatus (ws7c source).
  script = [{ kind: 'ok', json: { quote: {}, state: 'reserved', duplicate: false } }];
  const r2 = await tp.reservePayment(deps, quote('q_ctr_00002'), 'cash', custody);
  if (r2.status !== 'reserved') throw new Error('setup failed');
  script = [{ kind: 'ok', json: { order: { id: 'ord_ctr2' }, duplicate: true } }];
  const f2 = await tp.finaliseCash(deps, r2.attempt, '10.00');
  check('contract (finalise, replay): duplicate:true with NO paymentStatus still confirms',
    f2.status === 'confirmed' && f2.duplicate === true && f2.paymentStatus === undefined);
  // release_quote_payment: {quote, state, duplicate}
  script = [{ kind: 'ok', json: { quote: {}, state: 'reserved', duplicate: false } }];
  const r3 = await tp.reservePayment(deps, quote('q_ctr_00003'), 'card');
  if (r3.status !== 'reserved') throw new Error('setup failed');
  script = [{ kind: 'ok', json: { quote: { id: 'q_ctr_00003', status: 'OPEN' }, state: 'OPEN', duplicate: false } }];
  const rel = await tp.releaseAttempt(deps, r3.attempt, 'declined');
  check('contract (release): {quote, state, duplicate} reads as released', rel.status === 'released');
  // open/close till session: {session, duplicate}
  reset();
  script = [{ kind: 'ok', json: { session: { id: 'sess_ctr_1', status: 'OPEN' }, duplicate: false } }];
  const op = await tp.openDrawer(deps, '50.00');
  check('contract (open session): session.id lands in the local drawer record',
    op.status === 'open' && tp.getLocalTillSession()?.sessionId === 'sess_ctr_1');
  script = [{ kind: 'ok', json: { session: { id: 'sess_ctr_1', status: 'CLOSED' }, duplicate: false } }];
  const cl = await tp.closeDrawer(deps, 'sess_ctr_1', { kind: 'device' });
  check('contract (close session): the local drawer record clears',
    cl.status === 'closed' && tp.getLocalTillSession() === null);
  // resolve: {quote, resolution} / reconcile: {reconciliation, orderPaymentStatus, duplicate}
  reset(false);
  script = [{ kind: 'ok', json: { quote: {}, resolution: 'void' } }];
  const rv = await tp.resolveReconciliation(deps, { quoteId: 'q_x', reservationId: 'res_x', action: 'void', reason: 'terminal declined; customer left without paying', resolutionId: 'resol_ctr01' });
  check('contract (resolve): {quote, resolution} reads as ok', rv.status === 'ok');
  // orderPaymentStatus pinned VERBATIM from supabase/launch-baseline-v1.sql:4235
  // (reconcile_card_payment envelope) — the launch DB has no provider link, so
  // the only post-evidence status is MANUAL_EVIDENCE_MATCHED.
  script = [{ kind: 'ok', json: { reconciliation: {}, orderPaymentStatus: 'MANUAL_EVIDENCE_MATCHED', duplicate: false } }];
  const rc = await tp.reconcileCardPayment(deps, { orderId: 'ord_x', evidenceType: 'terminal_receipt', externalReference: 'STL-1', currency: 'GBP', matchedAmount: '6.50', paymentEventAt: new Date().toISOString(), reason: 'receipt matches the order exactly', idempotencyKey: 'idem_ctr01' });
  check('contract (reconcile): {reconciliation, orderPaymentStatus, duplicate} reads as ok', rc.status === 'ok');
}

/* ================================================================== */
/*  10 · RETRY AUDIT — no identity or clock inside any retry callback  */
/* ================================================================== */
{
  const src = readFileSync(new URL('../src/lib/tillPayments.ts', import.meta.url), 'utf8');
  // Every call site is a single-line arrow (`withRetry(() => rpcX(payload, t))`),
  // so the callback is fully contained in the first line after the split —
  // a wider window would false-positive on code AFTER the callback closes.
  const chunks = src.split('withRetry(').slice(1).map((c) => c.split('\n')[0]!);
  const banned = /newQuoteId|newReservationId|newResolutionId|newIdempotencyKey|randomHex\(|Date\.now\(|new Date\(/;
  const dirty = chunks.filter((c) => banned.test(c));
  check('retry audit: no identity/timestamp is generated inside any withRetry callback',
    chunks.length >= 8 && dirty.length === 0, `dirty=${dirty.length}/${chunks.length}`);
  check('retry audit: enrolThisDevice does NOT use withRetry (single attempt by design)',
    !/enrolThisDevice[\s\S]{0,700}withRetry/.test(src));
}


/* ================================================================== */
/*  9 · CORRUPT PAYMENT STORE — FAIL CLOSED, ZERO RPC, NO OVERWRITE    */
/* ================================================================== */
{
  const ATT = 'milkpop_payment_attempts_v1';
  const validAtt = (q: string, stage: 'reserving' | 'reserved' | 'finalising' = 'reserved'): Record<string, unknown> => ({
    quoteId: q, reservationId: `res_${q}`, stage, method: 'cash', quoteTotal: '6.50',
    quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 0,
    ...(stage === 'finalising' ? { facts: { quoteId: q, reservationId: `res_${q}`, method: 'cash', cashTendered: '10.00' } } : {}),
  });
  const shapes: Array<[string, string]> = [
    ['malformed JSON', 'not json {{{'],
    ['valid JSON, wrong top-level type', '{"attempts":[]}'],
    ['one malformed record inside a valid array', JSON.stringify([validAtt('q_cor_a'), { bad: true }])],
    ['unsupported old-version record shape', JSON.stringify([{ id: 'q_old', state: 'queued' }])],
  ];
  for (const [label, raw] of shapes) {
    reset();
    store.set(ATT, raw);
    check(`corruption (${label}): store health is corrupt`, tp.attemptsStoreHealth() === 'corrupt');
    const before = calls.length;
    const r = await tp.reservePayment(deps, quote('q_cor_new'), 'cash', custody);
    check(`corruption (${label}): reservation refused locally as corrupt`,
      r.status === 'unavailable' && r.reason === 'corrupt');
    const rel = await tp.releaseAttempt(deps, validAtt('q_cor_rel') as never, 'abandoned');
    check(`corruption (${label}): release refused locally as corrupt`,
      rel.status === 'unavailable' && rel.reason === 'corrupt');
    const rf = await tp.resumeFinalise(deps, validAtt('q_cor_fin', 'finalising') as never);
    check(`corruption (${label}): finalise-resume refused as store_corrupt`, rf.status === 'store_corrupt');
    check(`corruption (${label}): ZERO RPCs were made`, calls.length === before, `calls=${calls.length - before}`);
    check(`corruption (${label}): the damaged value was NOT overwritten`, store.get(ATT) === raw);
  }
}

/* ================================================================== */
/* 10 · TILL-TAB LEASE — a non-primary tab moves zero money            */
/* ================================================================== */
{
  reset();
  const secondaryCore = {
    state: () => 'secondary' as const, acquire: async () => 'secondary' as const,
    subscribe: () => () => {}, moneyAllowed: () => false, storageAvailable: () => true, release: () => {},
    mechanism: () => 'locks' as const,
  };
  tillLease._replaceCoreForTests(secondaryCore);
  const before = calls.length;
  const r1 = await tp.reservePayment(deps, quote('q_lease_1'), 'cash', custody);
  const r2 = await tp.resumeFinalise(deps, {
    quoteId: 'q_lease_f', reservationId: 'res_lease_f', stage: 'finalising', method: 'cash', quoteTotal: '6.50',
    quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), attempts: 0,
    facts: { quoteId: 'q_lease_f', reservationId: 'res_lease_f', method: 'cash', cashTendered: '10.00' },
  } as never);
  const r3 = await tp.openDrawer(deps);
  const r4 = await tp.enrolThisDevice(deps, 'Lease test');
  const r5 = await tp.resolveReconciliation(deps, { quoteId: 'q_l', reservationId: 'r_l', action: 'void', reason: 'lease test reason text', resolutionId: 'resol_l1' });
  const r6 = await tp.priceQuote(deps, { storeId: 'store_1', channel: 'TILL', lines: [{ productId: 'p1', quantity: 1 }] } as never);
  check('lease: a secondary tab cannot reserve', r1.status === 'unavailable' && r1.reason === 'lease');
  check('lease: a secondary tab cannot finalise', r2.status === 'lease_blocked');
  check('lease: a secondary tab cannot open the drawer', r3.status === 'unavailable' && r3.reason === 'lease');
  check('lease: a secondary tab cannot enrol', r4.status === 'unavailable' && r4.reason === 'lease');
  check('lease: a secondary tab cannot write recovery', r5.status === 'lease_blocked');
  check('lease: a secondary tab cannot even price', r6.status === 'unavailable' && r6.reason === 'lease');
  check('lease: ZERO RPCs from the secondary tab', calls.length === before, `calls=${calls.length - before}`);
  tillLease._replaceCoreForTests(tillLease.createLeaseCore({ hasWindow: false, locks: null, storage: null, now: Date.now, tabId: 'restore', sleep: async () => {} }));
  check('lease: a single-context runtime is solo and money-allowed', tillLease.moneyAllowed());
}

/* ================================================================== */
/* 11 · LEASE CORE — exactly one primary per shared storage / lock     */
/* ================================================================== */
{
  const shared = new Map<string, string>();
  const st = {
    getItem: (k: string) => shared.get(k) ?? null,
    setItem: (k: string, v: string) => { shared.set(k, v); },
    removeItem: (k: string) => { shared.delete(k); },
  };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const mk = (id: string) => tillLease.createLeaseCore({ hasWindow: true, locks: null, storage: st, now: () => Date.now(), tabId: id, sleep: async () => {}, heartbeatMs: 10, staleMs: 40 });
  const A = mk('tabA'); const B = mk('tabB');
  check('lease core: a browser tab starts unknown and fail-closed', A.state() === 'unknown' && !A.moneyAllowed());
  const ra = await A.acquire(); const rb = await B.acquire();
  check('lease core (heartbeat): exactly one tab becomes primary', ra === 'primary' && rb === 'secondary');
  /* R4.4 / F-02: the heartbeat path can no longer carry money AT ALL — the
   * fallback cannot guarantee exclusivity under timer throttling, so a
   * heartbeat primary is presence/diagnostics only. */
  check('lease core (heartbeat): a heartbeat primary is NEVER money-capable', !A.moneyAllowed() && !B.moneyAllowed());
  /* R4.4 / F-02: ownership loss DEMOTES — a primary that finds a fresh
   * foreign claim steps down instead of stealing the claim back (the R4.3
   * bug: every tick stomped the key and discarded the read-back). */
  st.setItem('milkpop_till_lease_v1', JSON.stringify({ tabId: 'usurper', ts: Date.now() }));
  await sleep(60);
  check('lease core (heartbeat): a primary that lost the claim demotes itself', A.state() === 'secondary');
  const claimAfter = JSON.parse(st.getItem('milkpop_till_lease_v1') ?? '{}') as { tabId?: string };
  check('lease core (heartbeat): the demoted tab never stomps the new claim', claimAfter.tabId === 'usurper');
  st.removeItem('milkpop_till_lease_v1');
  A.release(); B.release();
  const C = mk('tabC');
  /* A STALE foreign claim is still taken over — demotion is about FRESH
   * ownership elsewhere, not about surrendering to dead tabs. */
  st.setItem('milkpop_till_lease_v1', JSON.stringify({ tabId: 'ghost', ts: Date.now() - 10_000 }));
  check('lease core (heartbeat): a stale foreign claim is taken over', (await C.acquire()) === 'primary');
  C.release();
  const D = mk('tabD');
  const rd = await D.acquire();
  check('lease core (heartbeat): the secondary takes over after release', rd === 'primary');
  D.release();
  let grants = 0;
  const fakeLocks = {
    request: (_n: string, _o: { ifAvailable: boolean }, cb: (l: unknown) => unknown) => {
      const first = grants === 0; grants += 1;
      const r = cb(first ? { name: _n } : null);
      return Promise.resolve(r);
    },
  };
  const L1 = tillLease.createLeaseCore({ hasWindow: true, locks: fakeLocks, storage: localStorage, now: Date.now, tabId: 'L1', sleep: async () => {} });
  const L2 = tillLease.createLeaseCore({ hasWindow: true, locks: fakeLocks, storage: localStorage, now: Date.now, tabId: 'L2', sleep: async () => {} });
  check('lease core (Web Locks): first tab primary, second secondary',
    (await L1.acquire()) === 'primary' && (await L2.acquire()) === 'secondary');
  /* R4.4 / F-02: the authoritative path DOES carry money — the gate is
   * mechanism-aware, not a blanket ban. */
  check('lease core (Web Locks): a locks primary IS money-capable; its secondary is not',
    L1.moneyAllowed() && !L2.moneyAllowed());
}

/* ================================================================== */
/* 11b · R4.4 / F-01 — sweep bridge + in-window visibility             */
/* ================================================================== */
{
  reset(false);
  script = [{ kind: 'ok', json: { expired: 1, movedToReconciliation: 2 } }];
  const s1 = await tp.runRecoverySweep(deps);
  check('sweep (F-01): calls the expire_stale_quotes RPC and reads the counts',
    s1.status === 'ok' && s1.expired === 1 && s1.movedToReconciliation === 2
      && calls.length === 1 && (calls[0]?.url ?? '').endsWith('/rest/v1/rpc/expire_stale_quotes'));
  script = [{ kind: 'http', status: 500, json: { message: 'server exploded' } }];
  const s2 = await tp.runRecoverySweep(deps);
  check('sweep (F-01): a server failure degrades to error — it never throws or hides the lists', s2.status === 'error');
  const beforeNoTok = calls.length;
  const s3 = await tp.runRecoverySweep({ getAccessToken: async () => null });
  check('sweep (F-01): no token → unauthenticated with ZERO RPCs',
    s3.status === 'unauthenticated' && calls.length === beforeNoTok);
  reset(false);
  script = [{ kind: 'ok', json: [{ id: 'q_pend_1', channel: 'till', total: '4.50', payment_started_at: new Date().toISOString(), reservation_id: 'res_p1', created_at: new Date().toISOString() }] }];
  const p1 = await tp.fetchPaymentPendingQuotes(deps);
  check('pending list (F-01): in-window quotes are read from status=eq.PAYMENT_PENDING',
    p1.status === 'ok' && p1.rows.length === 1 && (calls[0]?.url ?? '').includes('status=eq.PAYMENT_PENDING'));
  check('pending list (F-01): the row carries what a manager needs to recognise the payment',
    p1.status === 'ok' && p1.rows[0]?.id === 'q_pend_1' && p1.rows[0]?.reservation_id === 'res_p1');
}

/* ================================================================== */
/* 12 · HELD RECOVERY WRITE — never replaced, only replayed/discarded  */
/* ================================================================== */
{
  reset(false);
  const REC = 'milkpop_recovery_request_v1';
  const pay = { quoteId: 'q_held_1', reservationId: 'res_held_1', action: 'void' as const, reason: 'card declined and customer left', resolutionId: 'resol_h1' };
  script = [{ kind: 'throw' }, { kind: 'throw' }, { kind: 'throw' }];
  const first = await tp.resolveReconciliation(deps, pay);
  check('held recovery: an unanswered resolution is HELD durably', first.status === 'unconfirmed' && store.has(REC));
  const rawHeld = store.get(REC)!;
  const before = calls.length;
  const other = await tp.resolveReconciliation(deps, { ...pay, quoteId: 'q_held_2', reservationId: 'res_held_2', resolutionId: 'resol_h2' });
  check('held recovery: a DIFFERENT resolution is refused locally', other.status === 'held_recovery_exists');
  const cross = await tp.reconcileCardPayment(deps, { orderId: 'o1', evidenceType: 'terminal_receipt', externalReference: 'S-1', currency: 'GBP', matchedAmount: '5.00', paymentEventAt: new Date().toISOString(), reason: 'evidence matches exactly', idempotencyKey: 'idem_h1' });
  check('held recovery: a cross-kind write is refused too', cross.status === 'held_recovery_exists');
  check('held recovery: ZERO RPCs for both refusals', calls.length === before, `calls=${calls.length - before}`);
  check('held recovery: the held marker is byte-unchanged', store.get(REC) === rawHeld);
  script = [{ kind: 'ok', json: { quote: {}, resolution: 'void' } }];
  const replay = await tp.resolveReconciliation(deps, pay);
  check('held recovery: the IDENTICAL payload replays and clears the hold', replay.status === 'ok' && !store.has(REC));
}

/* ================================================================== */
/* 13 · ENROLMENT — single-flight and review-marker gated              */
/* ================================================================== */
{
  reset(false);
  script = [{ kind: 'ok', json: { deviceId: 'dev_c1', storeId: 'store_1', label: 'Counter', pairingSecret: 'sec_c1', note: 'flat contract' } }];
  const before = calls.length;
  const [e1, e2] = await Promise.all([tp.enrolThisDevice(deps, 'Counter'), tp.enrolThisDevice(deps, 'Counter')]);
  check('enrol: two concurrent calls make exactly ONE server request', calls.length === before + 1, `calls=${calls.length - before}`);
  check('enrol: one wins, the other reports pairing_in_progress',
    [e1.status, e2.status].sort().join('+') === 'paired+pairing_in_progress');
  reset(false);
  store.set('milkpop_custody_request_v1', JSON.stringify({ kind: 'enrol', facts: { label: 'x' }, at: new Date().toISOString(), outcome: 'unknown' }));
  const b2 = calls.length;
  const g = await tp.enrolThisDevice(deps, 'Again');
  check('enrol: an UNKNOWN prior outcome refuses locally with zero RPCs',
    g.status === 'pairing_review_required' && calls.length === b2);
}

/* ================================================================== */
/* 14 · RESERVED PROMOTION — verified before success is reported       */
/* ================================================================== */
{
  reset();
  script = [{ kind: 'ok', json: { quote: {}, state: 'reserved', duplicate: false } }];
  armFailSet(2);   // write 1 = the reserving identity; write 2 = the promotion
  const r = await tp.reservePayment(deps, quote('q_promo_1'), 'cash', custody);
  armFailSet();
  check('promotion: server-confirmed but unsaved returns confirmed_unsaved', r.status === 'confirmed_unsaved');
  const held = tp.pendingAttempts().find((a) => a.quoteId === 'q_promo_1');
  check('promotion: the durable stage remains reserving', held?.stage === 'reserving');
  check('promotion: payment controls stay hidden for the held attempt',
    held ? tp.attemptCapabilities(held).canTakePayment === false : false);
}

/* ================================================================== */
/* 15 · DRAWER open_unsaved — server open, no durable local session    */
/* ================================================================== */
{
  reset(false);
  tp.storePairedDevice({ deviceId: 'dev_test_01', label: 'Test till', secret: SECRET, pairedAt: new Date().toISOString() });
  script = [{ kind: 'ok', json: { session: { id: 'sess_u1', store_id: 'store_1', device_id: 'dev_test_01', status: 'OPEN' } } }];
  armFailSet(2);   // write 1 = the custody marker; write 2 = the local session
  const r = await tp.openDrawer(deps);
  armFailSet();
  check('drawer: server-open with unsaved session returns open_unsaved', r.status === 'open_unsaved');
  check('drawer: no local session exists — cash stays disabled', tp.getLocalTillSession() === null);
  const m = tp.getCustodyMarker();
  check('drawer: the custody marker is KEPT and marked unsaved', m?.kind === 'open_drawer' && m.outcome === 'unsaved');
}

/* ================================================================== */
/* 16 · FORGET PAIRING — custody-aware, with verified deletion         */
/* ================================================================== */
{
  reset();   // seeds a paired device AND an open local session
  let f = tp.forgetPairedDevice();
  check('forget: blocked while the drawer session is live', f.status === 'blocked' && f.reason === 'drawer_open');
  tp.clearLocalTillSession();
  store.set('milkpop_payment_attempts_v1', JSON.stringify([{
    quoteId: 'q_fg_1', reservationId: 'res_fg_1', stage: 'reserved', method: 'cash', quoteTotal: '6.50',
    quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), attempts: 0,
  }]));
  f = tp.forgetPairedDevice();
  check('forget: blocked while a cash attempt is held', f.status === 'blocked' && f.reason === 'cash_attempt');
  store.set('milkpop_payment_attempts_v1', '[]');
  f = tp.forgetPairedDevice();
  check('forget: allowed once custody is clear — verified deletion', f.status === 'forgotten' && tp.getPairedDevice() === null);
}

/* ================================================================== */
/* 17 · LANGUAGE — the UI never claims provider reconciliation         */
/* ================================================================== */
{
  const till = readFileSync('src/components/admin/TillOrders.tsx', 'utf8');
  check('language: TillOrders never says provider-reconciled',
    !till.includes('provider-reconciled') && !till.includes('PROVIDER_RECONCILED'));
  check('language: manual-evidence wording is what the manager reads',
    till.includes('manually matched') && till.includes('manual settlement evidence'));
}


/* ================================================================== */
/* 18 · RECOVERY-PAGE LEASE — acquired on the page, failover replay    */
/* ================================================================== */
{
  // (a) A fresh admin tab loaded DIRECTLY into Till orders: fail-closed
  //     until the page's own acquire resolves, then the write proceeds.
  reset(false);
  let grants18 = 0;
  const locks18 = { request: (_n: string, _o: { ifAvailable: boolean }, cb: (l: unknown) => unknown) => { const first = grants18 === 0; grants18 += 1; return Promise.resolve(cb(first ? { name: _n } : null)); } };
  const adminCore = tillLease.createLeaseCore({ hasWindow: true, locks: locks18, storage: localStorage, now: Date.now, tabId: 'admin', sleep: async () => {} });
  tillLease._replaceCoreForTests(adminCore);
  const pay = { quoteId: 'q_adm_1', reservationId: 'res_adm_1', action: 'void' as const, reason: 'admin direct-load acceptance check', resolutionId: 'resol_adm1' };
  const before = calls.length;
  const blocked = await tp.resolveReconciliation(deps, pay);
  check('recovery lease: a fresh unacquired admin tab is fail-closed with zero RPCs',
    blocked.status === 'lease_blocked' && calls.length === before);
  const st = await tillLease.acquireTillLease();
  script = [{ kind: 'ok', json: { quote: {}, resolution: 'void' } }];
  const okr = await tp.resolveReconciliation(deps, pay);
  check('recovery lease: after the on-page acquire the write proceeds', st === 'primary' && okr.status === 'ok');

  // (b) Failover under the AUTHORITATIVE mechanism (R4.4 / F-02: the
  //     heartbeat fallback can no longer carry recovery writes): the
  //     cashier tab holds the WEB LOCK and an unconfirmed recovery write;
  //     the admin tab is read-only until the cashier closes (the browser
  //     frees the lock — simulated by clearing the fake holder), then
  //     takes over and replays the HELD request.
  reset(false);
  let lockHolder18: string | null = null;
  const mkLocks18 = (id: string) => ({
    request: (_n: string, _o: { ifAvailable: boolean }, cb: (l: unknown) => unknown) => {
      if (lockHolder18 === null || lockHolder18 === id) { lockHolder18 = id; return Promise.resolve(cb({ name: _n })); }
      return Promise.resolve(cb(null));
    },
  });
  const mk18 = (id: string) => tillLease.createLeaseCore({ hasWindow: true, locks: mkLocks18(id), storage: localStorage, now: () => Date.now(), tabId: id, sleep: async () => {} });
  const cashier = mk18('cashier'); const admin = mk18('admin2');
  tillLease._replaceCoreForTests(cashier);
  await tillLease.acquireTillLease();
  script = [{ kind: 'throw' }, { kind: 'throw' }, { kind: 'throw' }];
  const held = await tp.resolveReconciliation(deps, pay);
  check('recovery lease: the cashier tab durably holds an unconfirmed recovery write',
    held.status === 'unconfirmed' && store.has('milkpop_recovery_request_v1'));
  tillLease._replaceCoreForTests(admin);
  const b2 = calls.length;
  const asSecondary = await admin.acquire();
  const rep2 = await tp.resolveReconciliation(deps, pay);
  check('recovery lease: while the cashier lives, the admin tab is secondary — zero RPCs',
    asSecondary === 'secondary' && rep2.status === 'lease_blocked' && calls.length === b2);
  lockHolder18 = null;   // the cashier tab closes — the browser frees its lock
  cashier.release();
  const takeover = await admin.acquire();
  script = [{ kind: 'ok', json: { quote: {}, resolution: 'void' } }];
  const rep3 = await tp.resolveReconciliation(deps, pay);
  check('recovery lease: after takeover the HELD write replays and clears',
    takeover === 'primary' && rep3.status === 'ok' && !store.has('milkpop_recovery_request_v1'));
  admin.release();
  tillLease._replaceCoreForTests(tillLease.createLeaseCore({ hasWindow: false, locks: null, storage: null, now: Date.now, tabId: 'restore18', sleep: async () => {} }));
  check('recovery lease: the runtime is restored to solo for the remaining suites', tillLease.moneyAllowed());
}

/* ================================================================== */
/* 19 · LEASE MECHANISM — locks is production; heartbeat is degraded   */
/* ================================================================== */
{
  const locksCore = tillLease.createLeaseCore({ hasWindow: true, locks: { request: (_n: string, _o: { ifAvailable: boolean }, cb: (l: unknown) => unknown) => Promise.resolve(cb({ name: _n })) }, storage: localStorage, now: Date.now, tabId: 'm1', sleep: async () => {} });
  const hbStore = new Map<string, string>();
  const hbCore = tillLease.createLeaseCore({ hasWindow: true, locks: null, storage: { getItem: (k: string) => hbStore.get(k) ?? null, setItem: (k: string, v: string) => { hbStore.set(k, v); }, removeItem: (k: string) => { hbStore.delete(k); } }, now: () => Date.now(), tabId: 'm2', sleep: async () => {} });
  const soloCore = tillLease.createLeaseCore({ hasWindow: false, locks: null, storage: null, now: Date.now, tabId: 'm3', sleep: async () => {} });
  check('mechanism: Web Locks is reported as the production path', locksCore.mechanism() === 'locks');
  check('mechanism: the heartbeat fallback is reported as degraded', hbCore.mechanism() === 'heartbeat');
  check('mechanism: solo runtimes report none and stay money-allowed', soloCore.mechanism() === 'none' && soloCore.moneyAllowed());
  const hbP = await hbCore.acquire();
  check('mechanism: the degraded path still yields exactly one primary', hbP === 'primary');
  hbCore.release();
}

/* ================================================================== */
/* 20 · CUSTODY-MARKER CLEARING — verified deletion, fail-safe report  */
/* ================================================================== */
{
  reset(false);
  store.set('milkpop_custody_request_v1', JSON.stringify({ kind: 'enrol', facts: { label: 'x' }, at: new Date().toISOString(), outcome: 'unknown' }));
  blockRemove = true;
  const bad = tp.clearCustodyMarker();
  check('custody clear: a failed deletion reports false and the lock REMAINS',
    bad === false && tp.getCustodyMarker() !== null);
  blockRemove = false;
  const good = tp.clearCustodyMarker();
  check('custody clear: verified deletion reports true once provably gone',
    good === true && tp.getCustodyMarker() === null);
}

console.log(`\n${failed === 0 ? '✔' : '✖'} TILL RELIABILITY — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
