-- FIX-2 IDEMPOTENT-REPLAY PROOF — run AFTER `npm run test:rls-local`:
--   su postgres -c "psql -d milkpop_rls_matrix -f scripts/proofs/fix2-idempotency.proof.sql"
-- Expected: first INSERT succeeds as team_member; the replay (same id,
-- ON CONFLICT DO NOTHING — the exact SQL PostgREST derives from
-- on_conflict=id + Prefer: resolution=ignore-duplicates) is a silent no-op
-- with NO RLS error; exactly one orders row and one order_items row remain.
\set ON_ERROR_STOP off
do $mp$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","email":"a1@test.local"}', false); end $mp$;
set role authenticated;
select 'FIX2_first_write' as test;
insert into orders (id, order_number, store_id, staff_id, staff_name, channel, items, subtotal, discount_total, tax_rate, tax_amount, total, payment_method, status, placed_at, completed_at)
values ('ord_replay_test', 1001, 's1', 'emp_a1', 'Anna Staff', 'walk_in',
        '[{"id":"i1","menuItemId":"m1","name":"Vanilla Shake","size":"regular","quantity":1,"unitPrice":4.5,"lineTotal":4.5}]'::jsonb,
        4.5, 0, 20, 0.75, 4.5, 'cash', 'completed', now(), now())
on conflict (id) do nothing;
select 'FIX2_replay_as_team_member (must be silent no-op, no 403)' as test;
insert into orders (id, order_number, store_id, staff_id, staff_name, channel, items, subtotal, discount_total, tax_rate, tax_amount, total, payment_method, status, placed_at, completed_at)
values ('ord_replay_test', 1001, 's1', 'emp_a1', 'Anna Staff', 'walk_in',
        '[{"id":"i1","menuItemId":"m1","name":"Vanilla Shake","size":"regular","quantity":1,"unitPrice":4.5,"lineTotal":4.5}]'::jsonb,
        4.5, 0, 20, 0.75, 4.5, 'cash', 'completed', now(), now())
on conflict (id) do nothing;
select 'FIX2_exactly_one_order' as test; select count(*) from orders where id='ord_replay_test';
select 'FIX2_order_items_not_duplicated' as test; select count(*) from order_items where order_id='ord_replay_test';
reset role;
do $mp$ begin perform set_config('request.jwt.claims', '{"role":"service_role"}', false); end $mp$;
set role service_role;
delete from order_items where order_id='ord_replay_test'; delete from orders where id='ord_replay_test';
reset role;
