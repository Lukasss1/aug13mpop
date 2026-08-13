#!/usr/bin/env bash
# ============================================================================
# stage3-backup-restore.test.sh — WS15 environment D: install the launch
# baseline, create realistic test data, take a real pg_dump backup, restore
# it into a SECOND clean database, and re-prove integrity AND permissions on
# the restored copy. (Environment E — failure testing — maps to existing
# gates: failed-migration rollback = upgrade-replay S6; checksum drift = S5 +
# scenario P5; baseline refuses non-empty = stage3-build-baseline guard.)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN="/usr/lib/postgresql/17/bin"
[ -x "$PGBIN/psql" ] || { echo "PostgreSQL 17 binaries required at $PGBIN" >&2; exit 1; }
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres "$(pwd)" 2>/dev/null || true
  exec su postgres -s /bin/bash -c "cd '$(pwd)' && bash scripts/stage3-backup-restore.test.sh"
fi
PGDATA="/tmp/milkpop-br-pg"; PGPORT=54334
cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup; rm -rf "$PGDATA"; mkdir -p "$PGDATA"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-c listen_addresses='127.0.0.1' -c port=$PGPORT -c fsync=off" -w start >/dev/null
PS() { "$PGBIN/psql" -v ON_ERROR_STOP=1 -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$1" "${@:2}"; }
PR() { "$PGBIN/psql" -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$1" "${@:2}"; }  # no stop — denial probes
# SMALL-BIZ CLOSURE repair: the shim used to be EXTRACTED from a heredoc in
# stage3-inventory.build.sh; that heredoc was refactored away, so the
# extraction silently produced an EMPTY file and the baseline apply failed on
# its first role reference ('role "authenticated" does not exist') — on the
# SHIPPED T11 tree, before any closure change (reproduced on the pristine
# archive). The canonical shim every other database suite applies is the
# maintained home of the same content; use it directly, and fail LOUDLY if it
# is ever empty rather than discovering that thirteen lines later.
cp scripts/lib/supabase-local-privileges.sql /tmp/mp-shim.sql
[ -s /tmp/mp-shim.sql ] || { echo "✖ role/auth shim is empty — cannot build the drill cluster"; exit 1; }
PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "✔ $1"; else FAIL=$((FAIL+1)); echo "✖ $1 (got '$2', want '$3')"; fi; }

"$PGBIN/psql" -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres -c "create database db_live" >/dev/null
PS db_live -f /tmp/mp-shim.sql
PS db_live -f supabase/launch-baseline-v1.sql >/dev/null
echo "db_live: launch-baseline-v1 installed"

U_MGR='00000000-0000-4000-8000-0000000000f2'
PS db_live <<'SEED'
insert into stores (id, name, address, postcode) values ('s1', 'Solihull', '1 Way', 'B90');
insert into staff_profiles (id, name, email, role, store_id, store_name, auth_id, points, level, badges, pay_rate, pay_type) values
 ('emp_owner', 'Olive', 'o@x.local', 'owner', 's1', 'Solihull', '00000000-0000-4000-8000-0000000000f1', 0, 1, '[]', 0, 'salary'),
 ('emp_mgr', 'Mia', 'm@x.local', 'store_manager', 's1', 'Solihull', '00000000-0000-4000-8000-0000000000f2', 0, 1, '[]', 14.25, 'hourly'),
 ('emp_a', 'Anna', 'a@x.local', 'team_member', 's1', 'Solihull', '00000000-0000-4000-8000-0000000000f3', 0, 1, '[]', 12.50, 'hourly');
insert into orders (id, order_number, store_id, store_name, subtotal, total, completed_at, payment_method, cash_received, change_given, staff_id, staff_name)
 values ('ord_1', 1, 's1', 'Solihull', 5.00, 5.00, now(), 'cash', 10.00, 5.00, 'emp_a', 'Anna');
insert into clock_history (id, employee_id, employee_name, date, clock_in, clock_out, total_decimal_hours)
 values ('ch_1', 'emp_a', 'Anna', current_date, now() - interval '8 hours', now(), 8.0);
SEED
LIVE_SUM="$(PS db_live -tA -c "select (select count(*) from staff_profiles)||'/'||(select count(*) from orders)||'/'||(select count(*) from clock_history)||'/'||(select sum(total) from orders)")"
chk "D1 realistic data seeded on the baseline install" "$LIVE_SUM" "3/1/1/5.00"

BK=/tmp/milkpop-backup.dump
"$PGBIN/pg_dump" -h 127.0.0.1 -p "$PGPORT" -U postgres -d db_live -Fc -f "$BK"
chk "D2 backup created (custom format, non-empty)" "$([ -s "$BK" ] && echo yes)" "yes"

"$PGBIN/psql" -q -X -h 127.0.0.1 -p "$PGPORT" -U postgres -d postgres -c "create database db_restored" >/dev/null
# NO shim: a restore target is a truly clean database (roles are cluster-wide;
# the backup itself carries auth/storage/public wholesale — as a real full
# backup must). Any restore error is therefore a genuine failure.
if ! "$PGBIN/pg_restore" -h 127.0.0.1 -p "$PGPORT" -U postgres -d db_restored --no-owner "$BK" >/dev/null 2>/tmp/mp-restore.log; then
  echo "✖ pg_restore reported errors:"; head -6 /tmp/mp-restore.log; exit 1
fi
REST_SUM="$(PS db_restored -tA -c "select (select count(*) from staff_profiles)||'/'||(select count(*) from orders)||'/'||(select count(*) from clock_history)||'/'||(select sum(total) from orders)")"
chk "D3 restore reproduces the data byte-for-value" "$REST_SUM" "$LIVE_SUM"

# Permissions survive the restore: the manager's direct pay query stays denied.
DENY="$(PR db_restored -tA 2>&1 <<EOF | grep -c 'permission denied' || true
do \$mp\$ begin
  perform set_config('request.jwt.claim.sub', '$U_MGR', false);
  perform set_config('request.jwt.claims', '{"sub":"$U_MGR","role":"authenticated","aal":"aal2"}', false);
end \$mp\$;
set role authenticated;
select pay_rate from staff_profiles;
EOF
)"
chk "D4 RLS/column privileges survive restore (manager pay query DENIED)" "$DENY" "1"
CONS="$(PR db_restored -tA -c "insert into orders (id, order_number, subtotal, total, completed_at) values ('bad', 99, -1, -1, now());" 2>&1 | grep -c 'violates check' || true)"
chk "D5 financial invariants survive restore (negative total rejected)" "$CONS" "1"
FKD="$(PR db_restored -tA -c "delete from staff_profiles where id = 'emp_a';" 2>&1 | grep -c 'foreign key' || true)"
chk "D6 relationship RESTRICT survives restore (history keeps people)" "$FKD" "1"
TRG="$(PR db_restored -tA -c "insert into training_certificates (id, employee_id, employee_name, assessment_id, assessment_title, category, issued_at, score) values ('c1', 'emp_a', 'Anna', 'x', 'X', 'h', now()::text, 100);" 2>&1 | grep -c 'certificate_without_passing_result' || true)"
chk "D7 impossible-state triggers survive restore (cert-without-pass rejected)" "$TRG" "1"

echo
echo "BACKUP/RESTORE — $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
