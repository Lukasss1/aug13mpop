/**
 * till-payments.test.ts — WS7 CLIENT ROUND behavioural suite (static; runs in
 * `npm run verify`, no database and no browser).
 *
 * WHAT IT PROVES, per the audit brief ("client retry and recovery handling;
 * test cash/card failure cases"):
 *   1. DURABILITY ORDER — the payment attempt is in localStorage BEFORE the
 *      first byte of network I/O, and survives a "reload".
 *   2. IDEMPOTENT RETRY — an ambiguous outcome (network drop / 5xx) replays
 *      BYTE-IDENTICAL facts until the server answers; a refusal (4xx) is
 *      never retried.
 *   3. SECRET HYGIENE — the device pairing secret is sent on the wire for
 *      cash custody but NEVER appears in any persisted attempt.
 *   4. REFUSAL MAPPING — named server refusals surface as controlled codes,
 *      including ones PostgREST wraps in 401/403; a bare auth failure stays
 *      'unauthenticated'.
 *   5. RELEASE + RECOVERY — declined/abandoned release paths, the
 *      already-finalised signal, and the manager recovery payload shapes.
 *
 * Runner: npm exec --offline -- tsx scripts/till-payments.test.ts
 */

/* ---------- browser shims (BEFORE importing the module under test) ---------- */

const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

type MockCall = { url: string; body: string };
type MockStep =
  | { kind: 'ok'; status?: number; json: unknown }
  | { kind: 'http'; status: number; json: unknown }
  | { kind: 'throw' };

let calls: MockCall[] = [];
let script: MockStep[] = [];
/** Assertions to run INSIDE the fetch mock (proves ordering vs storage). */
let onCall: ((call: MockCall) => void) | null = null;

(globalThis as Record<string, unknown>).fetch = async (url: string, init?: { body?: string }) => {
  const call = { url: String(url), body: String(init?.body ?? '') };
  calls.push(call);
  if (onCall) onCall(call);
  const step = script.shift();
  if (!step) throw new Error(`fetch mock exhausted for ${call.url}`);
  if (step.kind === 'throw') throw new TypeError('network down');
  const status = step.kind === 'ok' ? (step.status ?? 200) : step.status;
  return new Response(JSON.stringify(step.json), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};

const tp = await import('../src/lib/tillPayments');
tp._setTestConfig({ url: 'https://till.test', anonKey: 'anon-test-key' });

/* ---------- harness ---------- */

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `  — ${detail}`}`);
  if (ok) passed += 1; else failed += 1;
};

const deps: import('../src/lib/tillPayments').FlowDeps = {
  getAccessToken: async () => 'jwt-test-token',
};
const noAuthDeps: import('../src/lib/tillPayments').FlowDeps = {
  getAccessToken: async () => null,
};

const SECRET = 'pair-secret-VERY-PRIVATE-9911';
function reset(withCustody = true): void {
  store.clear(); calls = []; script = []; onCall = null;
  if (withCustody) {
    tp.storePairedDevice({ deviceId: 'dev_test_01', label: 'Test till', secret: SECRET, pairedAt: new Date().toISOString() });
    tp.storeLocalTillSession({ sessionId: 'sess_test_01', deviceId: 'dev_test_01', openedAt: new Date().toISOString() });
  }
}
const quote = (id = 'q_test000001', total = 6.5): import('../src/lib/tillPayments').QuoteRow => ({
  id, status: 'OPEN', total, expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
});
const rawAttempts = () => store.get('milkpop_payment_attempts_v1') ?? '';
const named = (msg: string, status = 400) => ({ kind: 'http', status, json: { message: `P0001: ${msg}` } }) as MockStep;

/* ================================================================== */
/*  1 · durability order: persisted BEFORE the first network byte      */
/* ================================================================== */
{
  reset();
  let persistedAtCallTime = false;
  let sawSecretOnWire = false;
  let sawSession = false;
  onCall = (c) => {
    persistedAtCallTime = rawAttempts().includes('"q_test000001"');
    sawSecretOnWire = c.body.includes(SECRET);
    sawSession = c.body.includes('"cashSessionId":"sess_test_01"');
  };
  script = [{ kind: 'ok', json: { state: 'reserved' } }];
  const res = await tp.reservePayment(deps, quote(), 'cash', {
    sessionId: 'sess_test_01', deviceId: 'dev_test_01', secret: SECRET,
  });
  check('cash reserve: attempt persisted BEFORE the network call', persistedAtCallTime);
  check('cash reserve: succeeds and returns the stored attempt', res.status === 'reserved');
  check('cash reserve: device secret + session travel on the wire', sawSecretOnWire && sawSession);
  check('cash reserve: the URL is the bare begin_quote_payment literal',
    calls[0]!.url === 'https://till.test/rest/v1/rpc/begin_quote_payment');
  check('SECRET HYGIENE: the pairing secret is NOT in the persisted attempt',
    !rawAttempts().includes(SECRET) && rawAttempts().length > 0);
}

/* ================================================================== */
/*  2 · idempotent retry: byte-identical facts, confirmed exactly once */
/* ================================================================== */
{
  reset();
  script = [{ kind: 'ok', json: { state: 'reserved' } }];
  const r = await tp.reservePayment(deps, quote(), 'cash', {
    sessionId: 'sess_test_01', deviceId: 'dev_test_01', secret: SECRET,
  });
  if (r.status !== 'reserved') throw new Error('setup failed');
  calls = [];
  script = [{ kind: 'throw' }, { kind: 'http', status: 503, json: { message: 'upstream' } },
            { kind: 'ok', json: { order: { id: 'ord_1', order_number: 101, total: 6.5 }, duplicate: true, paymentStatus: 'CASH_RECORDED' } }];
  onCall = () => {
    // mid-retry the attempt must already be replayable from storage
    if (!rawAttempts().includes('"stage":"finalising"')) throw new Error('facts not persisted before finalise I/O');
  };
  const f = await tp.finaliseCash(deps, r.attempt, '10.00', 'Robin');
  check('cash finalise: network-drop then 5xx then duplicate:true → confirmed once',
    f.status === 'confirmed' && f.duplicate === true && f.paymentStatus === 'CASH_RECORDED');
  check('cash finalise: exactly three wire attempts for one logical payment', calls.length === 3, `got ${calls.length}`);
  check('cash finalise: every retry is BYTE-IDENTICAL to the first',
    calls.every((c) => c.body === calls[0]!.body));
  check('cash finalise: cashReceived crosses as the exact string "10.00"', calls[0]!.body.includes('"cashReceived":"10.00"'));
  check('cash finalise: change is NOT sent — the server computes it', !calls[0]!.body.includes('"change"'));
  check('cash finalise: paidAt is NOT sent on the ordinary path', !calls[0]!.body.includes('"paidAt"'));
  check('cash finalise: confirmed attempt leaves the durable store', tp.pendingAttempts().length === 0);
  check('SECRET HYGIENE: secret went on the wire for cash custody', calls[0]!.body.includes(SECRET));
}

/* ================================================================== */
/*  3 · reload survival: resume replays the EXACT persisted facts      */
/* ================================================================== */
{
  reset();
  script = [{ kind: 'ok', json: { state: 'reserved' } }];
  const r = await tp.reservePayment(deps, quote('q_reload0001'), 'cash', {
    sessionId: 'sess_test_01', deviceId: 'dev_test_01', secret: SECRET,
  });
  if (r.status !== 'reserved') throw new Error('setup failed');
  calls = [];
  script = [{ kind: 'throw' }, { kind: 'throw' }, { kind: 'throw' }];
  const f = await tp.finaliseCash(deps, r.attempt, '7.00');
  check('reload: an exhausted finalise stays UNCONFIRMED (never failed)', f.status === 'unconfirmed');
  const firstBody = calls[0]!.body;
  check('reload: the attempt survives with stage finalising + facts',
    tp.pendingAttempts().length === 1 && tp.pendingAttempts()[0]!.stage === 'finalising' && !!tp.pendingAttempts()[0]!.facts);
  check('SECRET HYGIENE: still absent from storage after an ambiguous finalise', !rawAttempts().includes(SECRET));
  // "reload": a fresh read of the durable store, then resume
  const revived = tp.pendingAttempts()[0]!;
  calls = []; script = [{ kind: 'ok', json: { order: { id: 'ord_2' }, duplicate: true } }];
  const g = await tp.resumeFinalise(deps, revived);
  check('reload: resume confirms from the server replay', g.status === 'confirmed' && g.duplicate === true);
  check('reload: the resumed request is BYTE-IDENTICAL to the pre-reload one', calls[0]!.body === firstBody);
  check('reload: the store is empty after confirmation', tp.pendingAttempts().length === 0);
}

/* ================================================================== */
/*  4 · cash failure cases: refusal mapping + state discipline         */
/* ================================================================== */
{
  reset();
  script = [{ kind: 'ok', json: { state: 'reserved' } }];
  const r = await tp.reservePayment(deps, quote('q_cashfail01'), 'cash', {
    sessionId: 'sess_test_01', deviceId: 'dev_test_01', secret: SECRET,
  });
  if (r.status !== 'reserved') throw new Error('setup failed');
  calls = []; script = [named('insufficient_cash — Cash received is less than the total')];
  const f = await tp.finaliseCash(deps, r.attempt, '1.00');
  check('cash refusal: insufficient_cash maps to its controlled code',
    f.status === 'refused' && f.reason === 'insufficient_cash');
  check('cash refusal: exactly one wire attempt — refusals never retry', calls.length === 1);
  const after = tp.pendingAttempts()[0];
  check('cash refusal: attempt drops back to reserved with facts cleared',
    !!after && after.stage === 'reserved' && after.facts === undefined);
  // idempotency_conflict must stay visible as 'finalising' — the truth is contested
  calls = []; script = [named('idempotency_conflict — those facts differ from the recorded payment')];
  const g = await tp.finaliseCash(deps, after!, '9.00');
  check('cash conflict: idempotency_conflict surfaces as its own code',
    g.status === 'refused' && g.reason === 'idempotency_conflict');
  check('cash conflict: the attempt stays visible for the operator',
    tp.pendingAttempts().length === 1 && tp.pendingAttempts()[0]!.stage === 'finalising');
}

/* ================================================================== */
/*  5 · card path: reference + pinned approved amount + status surface */
/* ================================================================== */
{
  reset();
  script = [{ kind: 'ok', json: { state: 'reserved' } }];
  const r = await tp.reservePayment(deps, quote('q_card000001', 12), 'card');
  if (r.status !== 'reserved') throw new Error('setup failed');
  calls = []; script = [{ kind: 'ok', json: { order: { id: 'ord_3' }, duplicate: false, paymentStatus: 'OPERATOR_RECORDED_UNRECONCILED' } }];
  const f = await tp.finaliseCardOrOnline(deps, r.attempt, 'TRX-778812');
  check('card finalise: confirmed with the operator-recorded status surfaced',
    f.status === 'confirmed' && f.paymentStatus === 'OPERATOR_RECORDED_UNRECONCILED');
  check('card finalise: approvedAmount is pinned to the quoted total string', calls[0]!.body.includes('"approvedAmount":"12.00"'));
  check('card finalise: the provider reference travels', calls[0]!.body.includes('"providerReference":"TRX-778812"'));
  check('card finalise: no cash keys leak into a card payload',
    !calls[0]!.body.includes('cashReceived') && !calls[0]!.body.includes('deviceSecret'));
}

/* ================================================================== */
/*  6 · PostgREST 401/403 discipline                                   */
/* ================================================================== */
{
  reset();
  calls = []; script = [named('permission denied: device_credential_invalid', 401)];
  const r = await tp.reservePayment(deps, quote('q_auth000001'), 'cash', {
    sessionId: 'sess_test_01', deviceId: 'dev_test_01', secret: 'WRONG' });
  check('401 with a NAMED refusal maps to the refusal, not to auth',
    r.status === 'refused' && r.reason === 'device_credential_invalid');
  check('a refused reservation is dropped from the durable store', tp.pendingAttempts().length === 0);

  script = [{ kind: 'ok', json: { state: 'reserved' } }];
  const ok = await tp.reservePayment(deps, quote('q_auth000002'), 'card');
  if (ok.status !== 'reserved') throw new Error('setup failed');
  calls = []; script = [{ kind: 'http', status: 401, json: { message: 'JWT expired' } }];
  const f = await tp.finaliseCardOrOnline(deps, ok.attempt, 'TRX-1');
  check('a bare expired-JWT 401 stays unconfirmed:auth (attempt kept)',
    f.status === 'unconfirmed' && f.reason === 'auth' && tp.pendingAttempts().length === 1);
  const g = await tp.finaliseCardOrOnline(noAuthDeps, tp.pendingAttempts()[0]!, 'TRX-1');
  check('no token at all: unconfirmed:auth without touching the network',
    g.status === 'unconfirmed' && g.reason === 'auth');
}

/* ================================================================== */
/*  7 · reserve-time failures: expiry + already-pending stop retrying  */
/* ================================================================== */
{
  reset();
  calls = []; script = [named('quote_expired — re-price the basket', 403)];
  const a = await tp.reservePayment(deps, quote('q_exp0000001'), 'card');
  check('reserve: quote_expired surfaces as its code (403-wrapped)',
    a.status === 'refused' && a.reason === 'quote_expired');
  calls = []; script = [{ kind: 'http', status: 500, json: { message: 'oops' } }, named('payment_already_pending')];
  const b = await tp.reservePayment(deps, quote('q_pend000001'), 'card');
  check('reserve: a 5xx retries, then the refusal stops the loop at 2 calls',
    b.status === 'refused' && b.reason === 'payment_already_pending' && calls.length === 2, `calls=${calls.length}`);
}

/* ================================================================== */
/*  8 · release paths                                                  */
/* ================================================================== */
{
  reset();
  script = [{ kind: 'ok', json: { state: 'reserved' } }];
  const r = await tp.reservePayment(deps, quote('q_rel0000001'), 'card');
  if (r.status !== 'reserved') throw new Error('setup failed');
  calls = []; script = [{ kind: 'ok', json: { state: 'DECLINED' } }];
  const rel = await tp.releaseAttempt(deps, r.attempt, 'declined');
  check('release: declined outcome releases and clears the attempt',
    rel.status === 'released' && tp.pendingAttempts().length === 0);
  check('release: the wire payload carries quote, reservation and outcome',
    calls[0]!.body.includes('"outcome":"declined"') && calls[0]!.body.includes('"quoteId":"q_rel0000001"'));

  script = [{ kind: 'ok', json: { state: 'reserved' } }];
  const r2 = await tp.reservePayment(deps, quote('q_rel0000002'), 'card');
  if (r2.status !== 'reserved') throw new Error('setup failed');
  script = [named('quote_already_consumed — this sale was recorded')];
  const rel2 = await tp.releaseAttempt(deps, r2.attempt, 'abandoned');
  check('release: quote_already_consumed signals ALREADY FINALISED (attempt kept)',
    rel2.status === 'already_finalised' && tp.pendingAttempts().length === 1);
  script = [named('reservation_released')];
  const rel3 = await tp.releaseAttempt(deps, tp.pendingAttempts()[0]!, 'abandoned');
  check('release: an already-released reservation reads as released (cleared)',
    rel3.status === 'released' && tp.pendingAttempts().length === 0);
}

/* ================================================================== */
/*  9 · manager recovery payload shapes (resolve + evidence match)     */
/* ================================================================== */
{
  reset(false);
  calls = []; script = [{ kind: 'http', status: 500, json: { message: 'blip' } }, { kind: 'ok', json: { resolved: true } }];
  const res = await tp.resolveReconciliation(deps, {
    quoteId: 'q_stuck00001', reservationId: 'res_stuck001', action: 'record_order',
    reason: 'card receipt found in the drawer; money was taken', resolutionId: 'resol_abc12345',
  });
  check('resolve: retries a 5xx with the SAME payload and succeeds',
    res.status === 'ok' && calls.length === 2 && calls[0]!.body === calls[1]!.body);
  check('resolve: exact key surface {quoteId,reservationId,action,reason,resolutionId}',
    ['"quoteId":"q_stuck00001"', '"reservationId":"res_stuck001"', '"action":"record_order"', '"resolutionId":"resol_abc12345"']
      .every((k) => calls[0]!.body.includes(k)));
  check('resolve: posts the bare resolve_payment_reconciliation literal',
    calls[0]!.url.endsWith('/rest/v1/rpc/resolve_payment_reconciliation'));

  calls = []; script = [{ kind: 'ok', json: { reconciled: true } }];
  const rec = await tp.reconcileCardPayment(deps, {
    orderId: 'ord_777', evidenceType: 'terminal_receipt', externalReference: 'STL-42',
    currency: 'GBP', matchedAmount: '12.00', paymentEventAt: '2026-07-23T10:00:00.000Z',
    reason: 'terminal receipt matches the order exactly', idempotencyKey: 'idem_k1k2k3k4',
  });
  check('reconcile: succeeds with the full evidence key surface',
    rec.status === 'ok' &&
    ['"orderId":"ord_777"', '"evidenceType":"terminal_receipt"', '"externalReference":"STL-42"',
     '"matchedAmount":"12.00"', '"idempotencyKey":"idem_k1k2k3k4"'].every((k) => calls[0]!.body.includes(k)));
  check('reconcile: posts the bare reconcile_card_payment literal',
    calls[0]!.url.endsWith('/rest/v1/rpc/reconcile_card_payment'));
}

/* ================================================================== */
/*  10 · id + wording invariants                                       */
/* ================================================================== */
{
  const ids = [tp.newQuoteId(), tp.newReservationId(), tp.newResolutionId(), tp.newIdempotencyKey()];
  check('generated identities respect the ≥6-char server rule and prefixes',
    ids.every((x) => x.length >= 6) && ids[0]!.startsWith('q_') && ids[1]!.startsWith('res_')
    && ids[2]!.startsWith('resol_') && ids[3]!.startsWith('idem_'));
  check('poundsString is byte-stable money', tp.poundsString(6.5) === '6.50' && tp.poundsString(10) === '10.00');
  check('refusalText: every named refusal yields a cashier sentence',
    (['insufficient_cash', 'quote_expired', 'till_device_revoked', 'recovery_window_elapsed', 'reconciliation_denied'] as const)
      .every((c) => tp.refusalText(c).length > 10));
  check('refusalText: unknown codes fall back to the safe default',
    tp.refusalText('rejected').includes('nothing was recorded'));
}

console.log(`\n${failed === 0 ? '✔' : '✖'} TILL PAYMENT FLOW — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
