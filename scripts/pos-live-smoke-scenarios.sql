-- pos-live-smoke-scenarios.sql — LIVE execution of the POS sync layer
-- against a real Postgres. Every block RAISES on failure (psql runs with
-- ON_ERROR_STOP=1), so a clean exit IS the pass. Covers the server halves of
-- mandatory integration tests #2, #4, #5, #6, #10, #11, #12 plus the
-- Gate 10 RLS posture (anon nothing, browser read-only + store-scoped,
-- token columns unreadable).

\set ON_ERROR_STOP 1
set client_min_messages = warning;

-- --------------------------------------------------------------------------
-- S1. Owner gate + pairing code shape
-- --------------------------------------------------------------------------
set smoke.role = 'staff';
do $$ begin
  begin
    perform * from create_pos_pairing_code('ST1', 'Milk Pop Birmingham', 'Front till');
    raise exception 'SMOKE: staff generated a pairing code';
  exception when others then
    if sqlerrm like 'SMOKE:%' then raise; end if;   -- expected refusal
  end;
end $$;

set smoke.role = 'owner';
set smoke.staff = 'emp_owner1';
create temporary table smoke (k text primary key, v text);
insert into smoke select 'code1', code from create_pos_pairing_code('ST1', 'Milk Pop Birmingham', 'Front till');
do $$
declare c text := (select v from smoke where k = 'code1');
begin
  if c !~ '^[A-HJ-KM-NP-Z2-9]{8}$' then raise exception 'SMOKE: code shape wrong: %', c; end if;
  if exists (select 1 from pos_pairing_codes where code_hash = encode(digest(c,'sha256'),'hex') and used_at is not null) then
    raise exception 'SMOKE: fresh code already marked used';
  end if;
  if exists (select 1 from pos_pairing_codes where code_hash = c) then
    raise exception 'SMOKE: plaintext code stored';
  end if;
end $$;

-- --------------------------------------------------------------------------
-- S2. Pairing: one-time, expiry, token hash only
-- --------------------------------------------------------------------------
insert into smoke
select 'pair1', pos_complete_pairing(
  encode(digest((select v from smoke where k='code1'),'sha256'),'hex'),
  'inst-AAA',
  '{"deviceName":"iPhone Till 1","deviceCode":"IP01","storeCode":"BHM01","appVersion":"0.2.0","schemaVersion":5}'::jsonb
)::text;
do $$
declare p jsonb := (select v from smoke where k='pair1')::jsonb;
begin
  if p is null or p->>'deviceToken' is null then raise exception 'SMOKE: pairing returned no token'; end if;
  if length(p->>'deviceToken') < 40 then raise exception 'SMOKE: token too short'; end if;
  if (p#>>'{store,id}') <> 'ST1' then raise exception 'SMOKE: wrong store on pairing'; end if;
  if exists (select 1 from pos_devices where token_hash = p->>'deviceToken') then
    raise exception 'SMOKE: plaintext token stored';
  end if;
  if not exists (select 1 from pos_devices
      where token_hash = encode(digest(p->>'deviceToken','sha256'),'hex')) then
    raise exception 'SMOKE: token hash not stored';
  end if;
end $$;
insert into smoke select 'dev1', (select v from smoke where k='pair1')::jsonb->>'deviceId';
insert into smoke select 'tok1', (select v from smoke where k='pair1')::jsonb->>'deviceToken';

do $$ begin  -- the same code a second time: refused
  if pos_complete_pairing(
       encode(digest((select v from smoke where k='code1'),'sha256'),'hex'),
       'inst-BBB', '{}'::jsonb) is not null then
    raise exception 'SMOKE: one-time code accepted twice';
  end if;
end $$;

insert into smoke select 'code2', code from create_pos_pairing_code('ST1', 'Milk Pop Birmingham', 'Expired till');
update pos_pairing_codes set expires_at = now() - interval '1 minute'
 where code_hash = encode(digest((select v from smoke where k='code2'),'sha256'),'hex');
do $$ begin
  if pos_complete_pairing(
       encode(digest((select v from smoke where k='code2'),'sha256'),'hex'),
       'inst-CCC', '{}'::jsonb) is not null then
    raise exception 'SMOKE: expired code accepted';
  end if;
end $$;

-- Second device (other store) for the scope tests.
insert into smoke select 'code3', code from create_pos_pairing_code('ST2', 'Milk Pop Camden', 'Camden till');
insert into smoke
select 'pair2', pos_complete_pairing(
  encode(digest((select v from smoke where k='code3'),'sha256'),'hex'),
  'inst-DDD',
  '{"deviceName":"iPad Till","deviceCode":"IP02","storeCode":"CAM01","appVersion":"0.2.0","schemaVersion":5}'::jsonb
)::text;
insert into smoke select 'dev2', (select v from smoke where k='pair2')::jsonb->>'deviceId';

-- --------------------------------------------------------------------------
-- S3. Token authentication
-- --------------------------------------------------------------------------
do $$
declare tok text := (select v from smoke where k='tok1');
        auth jsonb;
begin
  auth := pos_authenticate_device(encode(digest(tok,'sha256'),'hex'));
  if auth is null or auth->>'id' <> (select v from smoke where k='dev1') then
    raise exception 'SMOKE: token auth failed';
  end if;
  if (auth->>'revoked')::boolean then raise exception 'SMOKE: fresh device revoked'; end if;
  if pos_authenticate_device(encode(digest('wrong-token','sha256'),'hex')) is not null then
    raise exception 'SMOKE: bad token authenticated';
  end if;
end $$;

-- --------------------------------------------------------------------------
-- S4. Happy-path ingest: full day, every event type, device stamping
-- --------------------------------------------------------------------------
create temporary view dev1 as select (select v from smoke where k='dev1')::uuid as id;
do $$
declare ack jsonb;
begin
  ack := pos_ingest_batch((select id from dev1), $j$[
    {"id":"e-shift-open","eventType":"shift_opened","entityId":"sh1",
     "createdAt":"2026-07-08T08:00:00Z",
     "payload":{"eventVersion":1,"shift":{"id":"sh1","openedAt":"2026-07-08T08:00:00Z",
       "openedByUserId":"u1","openedByName":"Priya","openingCashPence":5000,"openingNote":null}}},
    {"id":"e-order-1","eventType":"order_created","entityId":"o1",
     "createdAt":"2026-07-08T10:00:00Z",
     "payload":{"eventVersion":1,"order":{"id":"o1","clientReference":"ref-1",
       "visibleOrderNumber":"BHM01-IP01-1001","orderSequence":1001,
       "storeCode":"BHM01","deviceCode":"IP01","status":"completed",
       "subtotalPence":500,"discountPence":0,"vatPence":83,"totalPence":500,
       "appliedDeals":[],"paymentMethod":"cash","cashReceivedPence":1000,
       "changeGivenPence":500,"manualCardConfirmation":false,
       "createdAt":"2026-07-08T10:00:00Z","completedAt":"2026-07-08T10:00:00Z",
       "shiftId":"sh1","soldByUserId":"u1","soldByName":"Priya"},
      "items":[{"id":"i1","productId":"p1","name":"Oreo Shake","category":"milkshakes",
        "size":"large","quantity":1,"unitPricePence":500,"lineTotalPence":500,
        "discountAllocationPence":0,"vatRateBp":2000,"vatPence":83,
        "modifiers":[{"id":"im1","modifierId":"e2","name":"Whipped Cream","pricePence":100}]}]}},
    {"id":"e-move-1","eventType":"cash_movement_recorded","entityId":"cm1",
     "createdAt":"2026-07-08T11:00:00Z",
     "payload":{"eventVersion":1,"movement":{"id":"cm1","shiftId":"sh1","direction":"paid_out",
       "amountPence":300,"reason":"Milk run","userId":"u1","userName":"Priya",
       "approvedByUserId":"u1","approvedByName":"Priya","createdAt":"2026-07-08T11:00:00Z"},
      "approval":{"id":"ap-cm1","actionType":"cash_movement","entityType":"cash_movement",
       "entityId":"cm1","approverUserId":"u1","approverName":"Priya",
       "requestedByUserId":"u1","requestedByName":"Priya","reason":"Milk run",
       "createdAt":"2026-07-08T11:00:00Z"}}},
    {"id":"e-void-1","eventType":"void_created","entityId":"v1",
     "createdAt":"2026-07-08T12:00:00Z",
     "payload":{"eventVersion":1,"void":{"id":"v1","orderId":"o1",
       "visibleOrderNumber":"BHM01-IP01-1001","orderTotalPence":500,"method":"cash",
       "cardTerminalConfirmed":false,"shiftId":"sh1","reason":"Rung twice",
       "userId":"u1","userName":"Priya","approvedByUserId":"u1","approvedByName":"Priya",
       "createdAt":"2026-07-08T12:00:00Z"},
      "approval":{"id":"ap-v1","actionType":"void","entityType":"void","entityId":"v1",
       "approverUserId":"u1","approverName":"Priya","requestedByUserId":"u1",
       "requestedByName":"Priya","reason":"Rung twice","createdAt":"2026-07-08T12:00:00Z"}}},
    {"id":"e-corr-1","eventType":"correction_created","entityId":"c1",
     "createdAt":"2026-07-08T12:30:00Z",
     "payload":{"eventVersion":1,"correction":{"id":"c1","orderId":"o1",
       "visibleOrderNumber":"BHM01-IP01-1001","shiftId":"sh1","kind":"payment_method",
       "before":{"paymentMethod":"cash"},"after":{"paymentMethod":"card"},
       "reason":"Tapped actually","userId":"u1","userName":"Priya",
       "approvedByUserId":"u1","approvedByName":"Priya","createdAt":"2026-07-08T12:30:00Z"},
      "approval":{"id":"ap-c1","actionType":"correction","entityType":"correction",
       "entityId":"c1","approverUserId":"u1","approverName":"Priya",
       "requestedByUserId":"u1","requestedByName":"Priya","reason":"Tapped actually",
       "createdAt":"2026-07-08T12:30:00Z"}}},
    {"id":"e-audit-1","eventType":"user_created","entityId":"u2",
     "createdAt":"2026-07-08T13:00:00Z",
     "payload":{"eventVersion":1,"name":"Sam","role":"staff"}},
    {"id":"e-shift-close","eventType":"shift_closed","entityId":"sh1",
     "createdAt":"2026-07-08T17:00:00Z",
     "payload":{"eventVersion":1,"shift":{"id":"sh1","openedAt":"2026-07-08T08:00:00Z",
       "openedByUserId":"u1","openedByName":"Priya","closedAt":"2026-07-08T17:00:00Z",
       "closedByUserId":"u1","closedByName":"Priya","openingCashPence":5000,
       "countedCashPence":4700,"reportedCardPence":0,"expectedCashPence":4700,
       "cashVariancePence":0,"expectedCardPence":0,"cardVariancePence":0,
       "varianceReason":null,"closingNote":null},
      "summary":{"shiftId":"sh1","countedCashPence":4700,"orderCount":0,"netSalesPence":0,
        "grossSalesPence":0,"expectedCashPence":4700,"expectedCardPence":0,
        "reportedCardPence":0,"cashVariancePence":0,"cardVariancePence":0,
        "openingCashPence":5000,"closedAt":"2026-07-08T17:00:00Z"},
      "approval":null}}
  ]$j$::jsonb);

  if jsonb_array_length(ack->'acknowledgedIds') <> 7 or jsonb_array_length(ack->'rejectedIds') <> 0 then
    raise exception 'SMOKE: happy batch not fully acknowledged: %', ack;
  end if;
end $$;

do $$
declare d uuid := (select id from dev1);
begin
  if (select count(*) from pos_orders where id='o1' and device_id=d and store_id='ST1') <> 1
     then raise exception 'SMOKE: order not stamped with device/store'; end if;
  if (select count(*) from pos_order_items where order_id='o1') <> 1
     then raise exception 'SMOKE: order items missing'; end if;
  if (select count(*) from pos_order_item_modifiers) <> 1
     then raise exception 'SMOKE: modifiers missing'; end if;
  if (select status from pos_shifts where id='sh1') <> 'closed'
     then raise exception 'SMOKE: shift did not converge to closed'; end if;
  if (select close_summary->>'countedCashPence' from pos_shifts where id='sh1') <> '4700'
     then raise exception 'SMOKE: stored Z-report summary missing'; end if;
  if (select count(*) from pos_approvals) <> 3
     then raise exception 'SMOKE: embedded approvals not landed'; end if;
  if (select count(*) from pos_audit_events where event_id='e-audit-1') <> 1
     then raise exception 'SMOKE: audit-class event not landed'; end if;
end $$;

-- --------------------------------------------------------------------------
-- S5. Idempotency (#2) and duplicate_conflict (#12)
-- --------------------------------------------------------------------------
do $$
declare ack jsonb;
begin
  -- Byte-identical replay of e-order-1 (different key order on purpose:
  -- jsonb normalizes, so the payload hash must match).
  ack := pos_ingest_batch((select id from dev1), $j$[
    {"id":"e-order-1","eventType":"order_created","entityId":"o1",
     "createdAt":"2026-07-08T10:00:00Z",
     "payload":{"order":{"clientReference":"ref-1","id":"o1",
       "visibleOrderNumber":"BHM01-IP01-1001","orderSequence":1001,
       "storeCode":"BHM01","deviceCode":"IP01","status":"completed",
       "subtotalPence":500,"discountPence":0,"vatPence":83,"totalPence":500,
       "appliedDeals":[],"paymentMethod":"cash","cashReceivedPence":1000,
       "changeGivenPence":500,"manualCardConfirmation":false,
       "createdAt":"2026-07-08T10:00:00Z","completedAt":"2026-07-08T10:00:00Z",
       "shiftId":"sh1","soldByUserId":"u1","soldByName":"Priya"},
      "items":[{"id":"i1","productId":"p1","name":"Oreo Shake","category":"milkshakes",
        "size":"large","quantity":1,"unitPricePence":500,"lineTotalPence":500,
        "discountAllocationPence":0,"vatRateBp":2000,"vatPence":83,
        "modifiers":[{"id":"im1","modifierId":"e2","name":"Whipped Cream","pricePence":100}]}],
      "eventVersion":1}}
  ]$j$::jsonb);
  if ack->'acknowledgedIds' <> '["e-order-1"]'::jsonb then
    raise exception 'SMOKE: identical replay not acknowledged: %', ack;
  end if;
  if (select count(*) from pos_orders where id='o1') <> 1 then
    raise exception 'SMOKE: replay duplicated the order';
  end if;

  -- Same id, DIFFERENT payload → duplicate_conflict, nothing changed.
  ack := pos_ingest_batch((select id from dev1), $j$[
    {"id":"e-order-1","eventType":"order_created","entityId":"o1",
     "createdAt":"2026-07-08T10:00:00Z",
     "payload":{"eventVersion":1,"order":{"id":"o1","totalPence":999999}}}
  ]$j$::jsonb);
  if ack #>> '{rejections,0,reason}' <> 'duplicate_conflict' then
    raise exception 'SMOKE: changed payload not flagged as duplicate_conflict: %', ack;
  end if;
  if (select total_pence from pos_orders where id='o1') <> 500 then
    raise exception 'SMOKE: conflict mutated the stored order';
  end if;
end $$;

-- --------------------------------------------------------------------------
-- S6. Partial batch (#4): rejection never drags batch-mates down
-- --------------------------------------------------------------------------
do $$
declare ack jsonb;
begin
  ack := pos_ingest_batch((select id from dev1), $j$[
    {"id":"e-order-2","eventType":"order_created","entityId":"o2",
     "createdAt":"2026-07-08T18:00:00Z",
     "payload":{"eventVersion":1,"order":{"id":"o2","clientReference":"ref-2",
       "visibleOrderNumber":"BHM01-IP01-1002","orderSequence":1002,
       "storeCode":"BHM01","deviceCode":"IP01","status":"completed",
       "subtotalPence":500,"discountPence":0,"vatPence":83,"totalPence":500,
       "appliedDeals":[],"paymentMethod":"card","cashReceivedPence":null,
       "changeGivenPence":null,"manualCardConfirmation":true,
       "createdAt":"2026-07-08T18:00:00Z","completedAt":"2026-07-08T18:00:00Z",
       "shiftId":"sh1","soldByUserId":"u1","soldByName":"Priya"},"items":[]}},
    {"id":"e-bad-money","eventType":"order_created","entityId":"o-bad",
     "createdAt":"2026-07-08T18:01:00Z",
     "payload":{"eventVersion":1,"order":{"id":"o-bad","clientReference":"ref-x",
       "visibleOrderNumber":"BHM01-IP01-1003","storeCode":"BHM01","deviceCode":"IP01",
       "status":"completed","subtotalPence":500,"discountPence":0,"vatPence":83,
       "totalPence":-5,"appliedDeals":[],"paymentMethod":"cash",
       "createdAt":"2026-07-08T18:01:00Z","completedAt":"2026-07-08T18:01:00Z"},"items":[]}},
    {"id":"e-order-3","eventType":"order_created","entityId":"o3",
     "createdAt":"2026-07-08T18:02:00Z",
     "payload":{"eventVersion":1,"order":{"id":"o3","clientReference":"ref-3",
       "visibleOrderNumber":"BHM01-IP01-1004","orderSequence":1004,
       "storeCode":"BHM01","deviceCode":"IP01","status":"completed",
       "subtotalPence":500,"discountPence":0,"vatPence":83,"totalPence":500,
       "appliedDeals":[],"paymentMethod":"cash","cashReceivedPence":500,
       "changeGivenPence":0,"manualCardConfirmation":false,
       "createdAt":"2026-07-08T18:02:00Z","completedAt":"2026-07-08T18:02:00Z",
       "shiftId":"sh1","soldByUserId":"u1","soldByName":"Priya"},"items":[]}}
  ]$j$::jsonb);
  if jsonb_array_length(ack->'acknowledgedIds') <> 2
     or ack->'rejectedIds' <> '["e-bad-money"]'::jsonb
     or ack #>> '{rejections,0,reason}' <> 'invalid_money' then
    raise exception 'SMOKE: partial batch mis-partitioned (#4/#11): %', ack;
  end if;
  if (select count(*) from pos_orders where id in ('o2','o3')) <> 2 then
    raise exception 'SMOKE: good batch-mates were lost';
  end if;
  if exists (select 1 from pos_events where event_id='e-bad-money') then
    raise exception 'SMOKE: rejected event left a ledger row (savepoint leak)';
  end if;
end $$;

-- --------------------------------------------------------------------------
-- S7. Forbidden field + unknown event type
-- --------------------------------------------------------------------------
do $$
declare ack jsonb;
begin
  ack := pos_ingest_batch((select id from dev1), $j$[
    {"id":"e-forbidden","eventType":"user_created","entityId":"u9",
     "createdAt":"2026-07-08T19:00:00Z",
     "payload":{"eventVersion":1,"name":"Eve","nested":{"staffPinHash":"deadbeef"}}},
    {"id":"e-unknown","eventType":"sale_completed","entityId":"oX",
     "createdAt":"2026-07-08T19:01:00Z","payload":{"eventVersion":1}}
  ]$j$::jsonb);
  if ack #>> '{rejections,0,reason}' <> 'forbidden_field'
     or ack #>> '{rejections,1,reason}' <> 'unknown_event_type' then
    raise exception 'SMOKE: forbidden/unknown rejection reasons wrong: %', ack;
  end if;
end $$;

-- --------------------------------------------------------------------------
-- S8. Device scope (#6): wrong codes, foreign orders, foreign event ids
-- --------------------------------------------------------------------------
do $$
declare d2 uuid := (select v from smoke where k='dev2')::uuid;
        ack jsonb;
begin
  ack := pos_ingest_batch(d2, $j$[
    {"id":"e-scope-order","eventType":"order_created","entityId":"oS",
     "createdAt":"2026-07-08T19:10:00Z",
     "payload":{"eventVersion":1,"order":{"id":"oS","clientReference":"ref-s",
       "visibleOrderNumber":"BHM01-IP01-2001","storeCode":"BHM01","deviceCode":"IP01",
       "status":"completed","subtotalPence":100,"discountPence":0,"vatPence":17,
       "totalPence":100,"appliedDeals":[],"paymentMethod":"cash",
       "createdAt":"2026-07-08T19:10:00Z","completedAt":"2026-07-08T19:10:00Z"},"items":[]}},
    {"id":"e-scope-refund","eventType":"refund_created","entityId":"rS",
     "createdAt":"2026-07-08T19:11:00Z",
     "payload":{"eventVersion":1,"refund":{"id":"rS","orderId":"o2",
       "visibleOrderNumber":"BHM01-IP01-1002","shiftId":"shX","kind":"custom",
       "method":"cash","amountPence":50,"reason":"scope test",
       "createdAt":"2026-07-08T19:11:00Z"},"items":[],"approval":null}},
    {"id":"e-order-1","eventType":"order_created","entityId":"oT",
     "createdAt":"2026-07-08T19:12:00Z","payload":{"eventVersion":1}}
  ]$j$::jsonb);
  if ack #>> '{rejections,0,reason}' <> 'device_scope_violation'
     or ack #>> '{rejections,1,reason}' <> 'device_scope_violation'
     or ack #>> '{rejections,2,reason}' <> 'device_scope_violation' then
    raise exception 'SMOKE: device scope not enforced (#6): %', ack;
  end if;
end $$;

-- --------------------------------------------------------------------------
-- S9. Refund cap across DISTINCT refunds (#10)
-- --------------------------------------------------------------------------
do $$
declare ack jsonb;
begin
  ack := pos_ingest_batch((select id from dev1), $j$[
    {"id":"e-refund-1","eventType":"refund_created","entityId":"r1",
     "createdAt":"2026-07-08T19:20:00Z",
     "payload":{"eventVersion":1,"refund":{"id":"r1","orderId":"o2",
       "visibleOrderNumber":"BHM01-IP01-1002","shiftId":"sh1","kind":"custom",
       "method":"card","amountPence":300,"reason":"Melted","userId":"u1","userName":"Priya",
       "approvedByUserId":"u1","approvedByName":"Priya","cardTerminalConfirmed":true,
       "createdAt":"2026-07-08T19:20:00Z"},
      "items":[],"approval":{"id":"ap-r1","actionType":"refund","entityType":"refund",
       "entityId":"r1","approverUserId":"u1","approverName":"Priya",
       "requestedByUserId":"u1","requestedByName":"Priya","reason":"Melted",
       "createdAt":"2026-07-08T19:20:00Z"}}},
    {"id":"e-refund-2","eventType":"refund_created","entityId":"r2",
     "createdAt":"2026-07-08T19:21:00Z",
     "payload":{"eventVersion":1,"refund":{"id":"r2","orderId":"o2",
       "visibleOrderNumber":"BHM01-IP01-1002","shiftId":"sh1","kind":"custom",
       "method":"card","amountPence":300,"reason":"Again","userId":"u1","userName":"Priya",
       "approvedByUserId":"u1","approvedByName":"Priya","cardTerminalConfirmed":true,
       "createdAt":"2026-07-08T19:21:00Z"},"items":[],"approval":null}}
  ]$j$::jsonb);
  if ack->'acknowledgedIds' <> '["e-refund-1"]'::jsonb
     or ack #>> '{rejections,0,reason}' <> 'invalid_money'
     or ack #>> '{rejections,0,detail}' not like '%exceed%' then
    raise exception 'SMOKE: refund cap failed across distinct refunds (#10): %', ack;
  end if;
  if (select coalesce(sum(amount_pence),0) from pos_refunds where order_id='o2') <> 300 then
    raise exception 'SMOKE: refund ledger wrong after cap';
  end if;
end $$;

-- --------------------------------------------------------------------------
-- S10. Rotation overlap, promotion, then revocation (#5 server half)
-- --------------------------------------------------------------------------
set smoke.role = 'owner';
insert into smoke select 'tok1b', rotate_pos_device_token((select id from dev1));
do $$
declare oldh text := encode(digest((select v from smoke where k='tok1'),'sha256'),'hex');
        newh text := encode(digest((select v from smoke where k='tok1b'),'sha256'),'hex');
        auth jsonb;
begin
  auth := pos_authenticate_device(oldh);   -- overlap: old still works pre-confirmation
  if auth is null then raise exception 'SMOKE: rotation bricked the old token (no overlap)'; end if;
  auth := pos_authenticate_device(newh);   -- till confirms the new token → promote
  if auth is null then raise exception 'SMOKE: new token refused'; end if;
  if pos_authenticate_device(oldh) is not null then
    raise exception 'SMOKE: old token survived promotion';
  end if;
  if exists (select 1 from pos_devices where pending_token_hash is not null) then
    raise exception 'SMOKE: pending hash not cleared after promotion';
  end if;
end $$;

set smoke.role = 'staff';
do $$ begin
  begin
    perform revoke_pos_device((select v from smoke where k='dev1')::uuid);
    raise exception 'SMOKE: staff revoked a device';
  exception when others then
    if sqlerrm like 'SMOKE:%' then raise; end if;
  end;
end $$;
set smoke.role = 'owner';
select revoke_pos_device((select v from smoke where k='dev1')::uuid);
do $$
declare newh text := encode(digest((select v from smoke where k='tok1b'),'sha256'),'hex');
        auth jsonb;
begin
  auth := pos_authenticate_device(newh);
  if auth is null or not (auth->>'revoked')::boolean then
    raise exception 'SMOKE: revoked device not reported as revoked';
  end if;
  begin
    perform pos_ingest_batch((select id from dev1), '[]'::jsonb);
    raise exception 'SMOKE: revoked device ingested';
  exception when others then
    if sqlerrm like 'SMOKE:%' then raise; end if;
  end;
end $$;

-- --------------------------------------------------------------------------
-- S11. RLS posture: anon nothing, browsers read-only + store-scoped,
--      token columns unreadable (Gate 10)
-- --------------------------------------------------------------------------
do $$ begin
  set local role anon;
  begin
    perform count(*) from pos_orders;
    raise exception 'SMOKE: anon read pos_orders';
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;

do $$
declare n bigint;
begin
  set local role authenticated;
  set local smoke.role = 'store_manager';
  set local smoke.store = 'ST2';
  select count(*) into n from pos_orders;          -- all test orders are ST1
  if n <> 0 then raise exception 'SMOKE: manager saw another store''s orders (%)', n; end if;
  set local smoke.role = 'owner';
  select count(*) into n from pos_orders;
  if n < 3 then raise exception 'SMOKE: owner cannot see all stores'; end if;
  begin
    insert into pos_orders (id, device_id, store_id, client_reference, visible_order_number,
      store_code, device_code, status, subtotal_pence, discount_pence, vat_pence, total_pence,
      payment_method, occurred_at, completed_at)
    values ('hack', (select v from smoke where k='dev1')::uuid, 'ST1', 'x', 'x',
      'BHM01','IP01','completed',0,0,0,0,'cash', now(), now());
    raise exception 'SMOKE: browser wrote a POS finance row';
  exception when insufficient_privilege then null;
  end;
  begin
    perform token_hash from pos_devices limit 1;
    raise exception 'SMOKE: browser read a token hash';
  exception when insufficient_privilege then null;
  end;
  perform id, device_name, revoked from pos_devices limit 1;   -- metadata IS readable
  reset role;
end $$;

-- --------------------------------------------------------------------------
-- S13. Catalogue publish → advertise → pull (Gate 9)
-- --------------------------------------------------------------------------
set smoke.role = 'staff';
do $$ begin
  begin
    perform publish_pos_catalog('{"categories":[],"products":[]}'::jsonb);
    raise exception 'SMOKE: staff published a catalogue';
  exception when others then
    if sqlerrm like 'SMOKE:%' then raise; end if;
  end;
end $$;

set smoke.role = 'owner';
do $$ begin
  begin
    perform publish_pos_catalog('{"products":[{"id":"p1","categoryId":"c1","name":"X","basePricePence":100,"vatRateBp":2000}]}'::jsonb);
    raise exception 'SMOKE: products published without categories';
  exception when others then
    if sqlerrm like 'SMOKE:%' then raise; end if;
  end;
  begin
    perform publish_pos_catalog('{"categories":[{"id":"c1","name":"Shakes"}],"products":[{"id":"p1","categoryId":"c1","name":"X","basePricePence":6.5,"vatRateBp":2000}]}'::jsonb);
    raise exception 'SMOKE: a fractional price was published';
  exception when others then
    if sqlerrm like 'SMOKE:%' then raise; end if;
  end;
end $$;

do $$
declare v1 integer; v2 integer; cur jsonb; ack jsonb;
        d2 uuid := (select v from smoke where k='dev2')::uuid;
begin
  v1 := publish_pos_catalog($j${"categories":[{"id":"milkshakes","name":"Milkshakes","sortOrder":0,"active":true}],
    "products":[{"id":"web-p1","categoryId":"milkshakes","name":"Biscoff Storm","description":"",
      "basePricePence":650,"largePricePence":750,"vatRateBp":2000,"allergens":["gluten"],"active":true,"sortOrder":0}],
    "deals":[{"id":"web-d1","name":"Happy Hour","type":"percent_off_category","active":true,
      "category":"milkshakes","percentOff":20}]}$j$::jsonb);
  if v1 <> 1 then raise exception 'SMOKE: first catalogue version is %, not 1', v1; end if;
  if pos_catalog_version() <> 1 then raise exception 'SMOKE: version getter disagrees'; end if;

  -- The ingest acknowledgement now advertises it (empty batch is enough).
  ack := pos_ingest_batch(d2, '[]'::jsonb);
  if (ack->>'catalogVersion')::integer <> 1 then
    raise exception 'SMOKE: ingest ack does not advertise the catalogue: %', ack;
  end if;

  -- The Edge Function's read path returns the whole snapshot.
  cur := pos_catalog_current();
  if (cur->>'catalogVersion')::integer <> 1
     or (cur#>>'{catalog,products,0,basePricePence}') <> '650' then
    raise exception 'SMOKE: current catalogue roundtrip failed: %', cur;
  end if;

  v2 := publish_pos_catalog('{"deals":[]}'::jsonb);
  if v2 <> 2 or (pos_catalog_current()->>'catalogVersion')::integer <> 2 then
    raise exception 'SMOKE: versions do not advance';
  end if;
end $$;

-- --------------------------------------------------------------------------
-- S12. Grant surface: browser roles cannot touch the device-write RPCs
-- --------------------------------------------------------------------------
do $$ begin
  set local role authenticated;
  begin
    perform pos_ingest_batch(gen_random_uuid(), '[]'::jsonb);
    raise exception 'SMOKE: authenticated executed pos_ingest_batch';
  exception when insufficient_privilege then null;
  end;
  begin
    perform pos_authenticate_device('deadbeef');
    raise exception 'SMOKE: authenticated executed pos_authenticate_device';
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;
do $$ begin
  set local role anon;
  begin
    perform pos_complete_pairing('deadbeef', 'x', '{}'::jsonb);
    raise exception 'SMOKE: anon executed pos_complete_pairing';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from create_pos_pairing_code('S','S','S');
    raise exception 'SMOKE: anon executed create_pos_pairing_code';
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;
do $$ begin
  set local role authenticated;
  begin
    perform pos_catalog_current();
    raise exception 'SMOKE: authenticated read the raw catalogue RPC';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from pos_catalog;
    raise exception 'SMOKE: authenticated selected pos_catalog';
  exception when insufficient_privilege then null;
  end;
  set local smoke.role = 'owner';
  if pos_catalog_version() < 1 then raise exception 'SMOKE: version fn not callable by staff browsers'; end if;
  reset role;
end $$;

select 'POS LIVE SMOKE: ALL SCENARIOS PASSED' as result;
