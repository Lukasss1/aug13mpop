-- FIX-7 ACCEPTANCE PROOF — run AFTER `npm run test:rls-local` against the
-- persisted milkpop_rls_matrix DB (the matrix leaves it in place):
--   su postgres -c "psql -d milkpop_rls_matrix -f scripts/proofs/fix7-acceptance.proof.sql"
-- Uses the matrix's seeded identities. Expected: TEST2/3/5 succeed;
-- TEST4/TEST6 abort with requested_rows_not_deletable; concurrent row survives.
-- (Identity uuids below are the matrix seed's fixed test uuids.)
\set ON_ERROR_STOP off
-- Seed as staff (own rows; insert policy = clock_insert_self).
do $mp$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","email":"a1@test.local"}', false); end $mp$;
set role authenticated;
insert into clock_history (id, employee_id, employee_name, date, clock_in, clock_out, break_duration_minutes, total_decimal_hours, notes)
values ('clk_seed_1', 'emp_a1', 'Anna Staff', current_date::text, '09:00', '17:00', 30, 7.5, 'seed shift');
-- === Admin A "hydrates" here: snapshot = {clk_seed_1} ===
-- Concurrent writer appends AFTER the snapshot:
insert into clock_history (id, employee_id, employee_name, date, clock_in, clock_out, break_duration_minutes, total_decimal_hours, notes)
values ('clk_concurrent_2', 'emp_a1', 'Anna Staff', current_date::text, '17:30', '21:30', 0, 4.0, 'row added after admin hydrated');
reset role;

-- Owner approves ONLY the stale-snapshot row through the new RPC.
do $mp$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated","email":"owner@test.local"}', false); end $mp$;
set role authenticated;
select 'TEST2_owner_approves_from_stale_snapshot' as test;
select apply_collection_changes('clock_history',
  '[{"id":"clk_seed_1","approved":true,"approved_by":"Olive Owner"}]'::jsonb,
  '{}'::text[]) is not null as rpc_returned;

select 'TEST3_concurrent_row_survives_and_approval_landed' as test;
select id, coalesce(approved,false) as approved from clock_history where id in ('clk_seed_1','clk_concurrent_2') order by id;

select 'TEST4_clock_history_delete_rejected_even_for_owner' as test;
select apply_collection_changes('clock_history', '[]'::jsonb, array['clk_seed_1']);
select 'TEST4b_row_still_there' as t; select count(*) from clock_history where id='clk_seed_1';

insert into payslips (id, employee_id, employee_name, email, period_key, period_label, hours_total, hourly_rate, gross, deductions, net)
values ('ps_keep', 'emp_a1', 'Anna Staff', 'a1@test.local', '2026-06', 'June 2026', 100, 10, 1000, 100, 900),
       ('ps_kill', 'emp_a1', 'Anna Staff', 'a1@test.local', '2026-05', 'May 2026', 100, 10, 1000, 100, 900);
select 'TEST5_owner_explicit_payslip_delete' as test;
select apply_collection_changes('payslips', '[]'::jsonb, array['ps_kill']) is not null as rpc_returned;
select id from payslips where id in ('ps_keep','ps_kill') order by id;
reset role;

do $mp$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","email":"a1@test.local"}', false); end $mp$;
set role authenticated;
select 'TEST6_staff_cannot_delete_payslips' as test;
select apply_collection_changes('payslips', '[]'::jsonb, array['ps_keep']);
reset role;

do $mp$ begin perform set_config('request.jwt.claims', '{"role":"service_role"}', false); end $mp$;
set role service_role;
select 'CLEANUP' as t;
delete from clock_history where id in ('clk_seed_1','clk_concurrent_2');
delete from payslips where id in ('ps_keep','ps_kill');
reset role;
