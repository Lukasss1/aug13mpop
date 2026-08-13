#!/usr/bin/env bash
# ============================================================================
# stage3-ws7-concurrency.test.sh — REAL two-session concurrency
# ============================================================================
# The behavioural matrix runs one statement at a time, so it proves the state
# machine and the FOR UPDATE contract but never actual interleaving. This
# harness runs two database sessions whose transactions genuinely overlap.
#
# Technique: session A opens a transaction, takes the row lock the RPC takes,
# and then sleeps INSIDE the transaction. Session B starts while A still holds
# the lock, so B blocks on the lock rather than racing past it, and only
# proceeds once A commits — which is exactly the window a production race
# would occupy. Each case asserts the FINAL state, so the outcome must be:
# one valid winner, one deterministic rejection or idempotent result, and no
# impossible final state.
#
#   Run: npm run test:ws7-concurrency
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

PGBIN="/usr/lib/postgresql/17/bin"
[ -x "$PGBIN/psql" ] || { echo "PostgreSQL 17 binaries required at $PGBIN" >&2; exit 1; }
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres "$(pwd)" 2>/dev/null || true
  exec su postgres -s /bin/bash -c "cd '$(pwd)' && bash scripts/stage3-ws7-concurrency.test.sh"
fi
PGDATA="/tmp/milkpop-ws7c-pg"; PGSOCK="/tmp/milkpop-ws7c-sock"; DB=milkpop_ws7c
export PGHOST="$PGSOCK"
LOCKOPTS="set lock_timeout = '8s'; set statement_timeout = '20s';"
Q() { "$PGBIN/psql" -tA -X -q -h "$PGSOCK" -U postgres -d "$DB" -c "$LOCKOPTS $1" 2>&1; }
RUN() { "$PGBIN/psql" -tA -X -q -h "$PGSOCK" -U postgres -d "$DB" -f "$1" 2>&1; }
# A deadlock or timeout means the lock ORDER is wrong; it must never be scored
# as a deterministic rejection.
no_deadlock() { # $1 = label, $2.. = captured outputs
  local label="$1"; shift
  if echo "$*" | grep -qiE 'deadlock detected|canceling statement due to (lock|statement) timeout'; then
    FAIL=$((FAIL+1)); echo "  ✖ $label — DEADLOCK OR TIMEOUT (lock order violation)"
  else
    PASS=$((PASS+1)); echo "  ✔ $label — no deadlock or timeout"
  fi
}

cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT
PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✔ $1";
        else FAIL=$((FAIL+1)); echo "  ✖ $1"; echo "      got:  $2"; echo "      want: $3"; fi; }

cleanup; rm -rf "$PGDATA" "$PGSOCK"; mkdir -p "$PGDATA" "$PGSOCK"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -c listen_addresses='' -c fsync=off" -w start >/dev/null
"$PGBIN/psql" -q -X -h "$PGSOCK" -U postgres -d postgres -c "create database $DB" >/dev/null

# R4.10 Increment 4: shim body replaced by the ONE shared file so every
# database harness starts from the same posture as production.
"$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" < "$(dirname "${BASH_SOURCE[0]}")/lib/supabase-local-privileges.sql" >/dev/null

echo "— building the chain —"
"$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" -f supabase/schema.FRESH-INSTALL-ONLY.sql >/dev/null 2>&1
# shellcheck source=launch/migration-manifest.sh
source launch/migration-manifest.sh
for m in "${MP_MIGRATIONS[@]}"; do
  "$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" -f "$m" >/dev/null 2>&1 || {
    echo "  ✖ chain failed at $m"; exit 1; }
done
echo "  ✔ applied ${#MP_MIGRATIONS[@]} migrations"

STAFF='00000000-0000-4000-8000-0000000000f1'
"$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" <<SEED >/dev/null
-- R4.9 G2: R4.8 added assert_store_open_allowed(), and stores.status DEFAULTS
-- to 'open', so this bare insert became a nothing→open transition that the gate
-- refuses until the launch identity is recorded. This suite tests PAYMENT
-- CONCURRENCY, not launch gating; completing the identity first is the
-- realistic order of events and leaves every race below unchanged.
update launch_settings set
  legal_business_name  = 'Harness Ltd',
  registered_address   = '1 Race Way',
  public_contact_email = 'harness@example.invalid',
  privacy_contact_email= 'harness@example.invalid',
  public_telephone     = '+44 0000 000000',
  vat_state_confirmed  = true
where id;
insert into stores (id, name, address, postcode, opening_hours, vat_status, vat_config_confirmed_at,
                    setup_status, timezone, currency_code, payment_methods)
  values ('s_c', 'Concurrency', '1 Race Way', 'C1 1AA', 'Mon-Sun 09:00-21:00', 'NOT_REGISTERED', now(),
          'ACTIVE', 'Europe/London', 'GBP', '["cash","card"]'::jsonb);
insert into staff_profiles (id, name, email, role, store_id, store_name, auth_id)
  values ('emp_c', 'Cass Concurrent', 'cc@test.local', 'team_member', 's_c', 'Concurrency', '$STAFF');
insert into menu_items (id, name, category, price, image) values ('mp_c', 'Race Shake', 'milkshakes', 6, '');
insert into web_till_devices (id, store_id, label, credential_hash)
  values ('dev_c', 's_c', 'Race till', encode(sha256(convert_to('race-secret','utf8')),'hex'));
insert into payment_terminals (id, store_id, provider, merchant_id, terminal_id)
  values ('term_c', 's_c', 'stripe_terminal', 'acct_mp', 'T_c');
insert into web_till_sessions (id, store_id, device_id, opened_by_staff_id, opening_float)
  values ('sess_c', 's_c', 'dev_c', 'emp_c', 0);
SEED

# Every session runs as the till operator.
AS_STAFF="do \$mp\$ begin perform set_config('request.jwt.claims', '{\"sub\":\"$STAFF\",\"aal\":\"aal1\"}', false); perform set_config('request.jwt.claim.sub', '$STAFF', false); end \$mp\$; set role authenticated;"

quote() {  # $1 = quote id
  Q "$AS_STAFF select create_order_quote('{\"id\":\"$1\",\"items\":[{\"menuItemId\":\"mp_c\",\"quantity\":1}]}'::jsonb) is not null;"
}
reserve() { # $1 quote, $2 reservation, $3 method
  # ws7b routing: a card/online reservation names NEITHER a device nor a session
  # (the store's single ACTIVE terminal / registered online account auto-binds);
  # a cash reservation names the enrolled device and the open drawer, nothing else.
  if [ "$3" = "cash" ]; then
    Q "$AS_STAFF select begin_quote_payment('{\"quoteId\":\"$1\",\"reservationId\":\"$2\",\"method\":\"cash\",\"deviceId\":\"dev_c\",\"deviceSecret\":\"race-secret\",\"cashSessionId\":\"sess_c\"}'::jsonb) is not null;" >/dev/null
  else
    Q "$AS_STAFF select begin_quote_payment('{\"quoteId\":\"$1\",\"reservationId\":\"$2\",\"method\":\"$3\"}'::jsonb) is not null;" >/dev/null
  fi
}

# A transaction that HOLDS the quote row lock for a while, then acts.
hold_then() {  # $1 = quote id, $2 = sql to run while holding, $3 = out file
  cat > /tmp/ws7c_a.sql <<SQL
set lock_timeout = '8s'; set statement_timeout = '20s';
begin;
select 1 from order_quotes where id = '$1' for update;
select pg_sleep(2);
$AS_STAFF
$2
commit;
SQL
  RUN /tmp/ws7c_a.sql > "$3" 2>&1
}

echo "DEBUG: $(Q "$AS_STAFF select create_order_quote('{\"id\":\"q_debug_001\",\"items\":[{\"menuItemId\":\"mp_c\",\"quantity\":1}]}'::jsonb) is not null;")"

echo ""
echo "— case 1: release versus finalise, genuinely overlapping —"
quote q_case_001; reserve q_case_001 res_c1 card
hold_then q_case_001 "select release_quote_payment('{\"quoteId\":\"q_case_001\",\"reservationId\":\"res_c1\",\"outcome\":\"declined\"}'::jsonb) is not null;" /tmp/ws7c_a1.out &
sleep 0.7
B1="$(Q "$AS_STAFF select finalise_order_payment('{\"quoteId\":\"q_case_001\",\"reservationId\":\"res_c1\",\"method\":\"card\",\"providerReference\":\"T-C1\",\"approvedAmount\":\"6.00\"}'::jsonb) is not null;")"
wait
A1="$(cat /tmp/ws7c_a1.out 2>/dev/null)"
ORD1="$(Q "select count(*) from orders where quote_id = 'q_case_001';")"
ST1="$(Q "select state from quote_payment_attempts where reservation_id='res_c1';")"
# Whichever transaction reached the row first must win outright, and the loser
# must be rejected deterministically. Both orderings are legitimate; a
# DECLINED attempt with a completed order, or two orders, would not be.
if [ "$ORD1" = "0" ] && [ "$ST1" = "DECLINED" ] && echo "$B1" | grep -q 'reservation_released'; then
  PASS=$((PASS+1)); echo "  ✔ release won; finalisation deterministically rejected (reservation_released)"
elif [ "$ORD1" = "1" ] && [ "$ST1" = "CONSUMED" ] && echo "$A1" | grep -q 'quote_already_consumed'; then
  PASS=$((PASS+1)); echo "  ✔ finalisation won; release deterministically rejected (quote_already_consumed)"
else
  FAIL=$((FAIL+1)); echo "  ✖ incoherent race outcome (orders=$ORD1, attempt=$ST1)"
fi
no_deadlock "case 1 (release vs finalise)" "$A1" "$B1"
chk "no completed order is left attached to a released attempt" \
    "$(Q "select count(*) from orders o join quote_payment_attempts a on a.quote_id = o.quote_id where a.state in ('DECLINED','ABANDONED') and a.completed_order_id is not null;")" "0"

echo ""
echo "— case 2: two concurrent finalisations of one attempt —"
quote q_case_002; reserve q_case_002 res_c2 card
hold_then q_case_002 "select finalise_order_payment('{\"quoteId\":\"q_case_002\",\"reservationId\":\"res_c2\",\"method\":\"card\",\"providerReference\":\"T-C2\",\"approvedAmount\":\"6.00\"}'::jsonb) is not null;" /tmp/ws7c_a2.out &
sleep 0.7
B2="$(Q "$AS_STAFF select (finalise_order_payment('{\"quoteId\":\"q_case_002\",\"reservationId\":\"res_c2\",\"method\":\"card\",\"providerReference\":\"T-C2\",\"approvedAmount\":\"6.00\"}'::jsonb)) ->> 'duplicate';")"
wait
chk "one real payment produced exactly ONE completed order" \
    "$(Q "select count(*) from orders where quote_id = 'q_case_002';")" "1"
A2="$(cat /tmp/ws7c_a2.out 2>/dev/null)"
if echo "$A2$B2" | grep -q 'true' || [ "$(echo "$B2" | tail -1)" = "t" ]; then
  PASS=$((PASS+1)); echo "  ✔ the losing finalisation returned the SAME order idempotently"
else
  FAIL=$((FAIL+1)); echo "  ✖ the second finalisation was not idempotent"; echo "      A=$A2"; echo "      B=$B2"
fi
no_deadlock "case 2 (two finalisations)" "$A2" "$B2"
chk "neither session was rejected as a conflict (same facts, same attempt)" \
    "$(echo "$A2$B2" | grep -c 'idempotency_conflict')" "0"

echo ""
echo "— case 3: two reservations for one quote —"
quote q_case_003
cat > /tmp/ws7c_a3.sql <<SQL
begin;
select 1 from order_quotes where id = 'q_case_003' for update;
select pg_sleep(2);
$AS_STAFF
select begin_quote_payment('{"quoteId":"q_case_003","reservationId":"res_c3a","method":"card"}'::jsonb) is not null;
commit;
SQL
RUN /tmp/ws7c_a3.sql > /tmp/ws7c_a3.out 2>&1 &
sleep 0.7
B3="$(Q "$AS_STAFF select begin_quote_payment('{\"quoteId\":\"q_case_003\",\"reservationId\":\"res_c3b\",\"method\":\"card\"}'::jsonb) is not null;")"
wait
chk "only ONE attempt was created for the quote" \
    "$(Q "select count(*) from quote_payment_attempts where quote_id = 'q_case_003';")" "1"
A3="$(cat /tmp/ws7c_a3.out 2>/dev/null)"
no_deadlock "case 3 (two reservations)" "$A3" "$B3"
chk "the losing device was refused exactly once (payment_already_pending)" \
    "$(echo "$A3$B3" | grep -c 'payment_already_pending')" "1"

echo ""
echo "— case 4: cash-session closure versus cash finalisation —"
quote q_case_004; reserve q_case_004 res_c4 cash
cat > /tmp/ws7c_a4.sql <<SQL
begin;
select 1 from web_till_sessions where id = 'sess_c' for update;
select pg_sleep(2);
$AS_STAFF
select close_till_session('{"id":"sess_c","deviceSecret":"race-secret"}'::jsonb) is not null;
commit;
SQL
RUN /tmp/ws7c_a4.sql > /tmp/ws7c_a4.out 2>&1 &
sleep 0.7
B4="$(Q "$AS_STAFF select finalise_order_payment('{\"quoteId\":\"q_case_004\",\"reservationId\":\"res_c4\",\"method\":\"cash\",\"cashReceived\":\"10.00\",\"change\":\"4.00\",\"tillSessionId\":\"sess_c\",\"deviceId\":\"dev_c\",\"deviceSecret\":\"race-secret\"}'::jsonb) is not null;")"
wait
CLOSED="$(Q "select status from web_till_sessions where id = 'sess_c';")"
PAID="$(Q "select count(*) from orders where quote_id = 'q_case_004';")"
# Either the drawer closed and the cash sale was refused, or the sale completed
# and the close was blocked. Both are coherent; a closed drawer holding an
# unresolved cash payment is not.
if { [ "$CLOSED" = "CLOSED" ] && [ "$PAID" = "0" ]; } || { [ "$CLOSED" = "OPEN" ] && [ "$PAID" = "1" ]; }; then
  PASS=$((PASS+1)); echo "  ✔ drawer and cash sale reached a coherent pair (session=$CLOSED, orders=$PAID)"
else
  FAIL=$((FAIL+1)); echo "  ✖ incoherent final state (session=$CLOSED, orders=$PAID)"
fi
no_deadlock "case 4 (drawer vs cash finalisation)" "$(cat /tmp/ws7c_a4.out 2>/dev/null)" "$B4"
chk "no cash attempt is left PENDING against a closed drawer" \
    "$(Q "select count(*) from quote_payment_attempts a join web_till_sessions s on s.id = a.cash_session_id where a.state='PENDING' and s.status='CLOSED';")" "0"

echo ""
echo "— case 5: an ALREADY-EXPIRED quote refuses BOTH overlapping reservations —"
quote q_case_005
# Determinism by construction. The earlier version set expiry one second out and
# raced the wall clock, so a reservation could occasionally beat expiry and the
# verdict flipped on timing. Expiry is a property of the QUOTE, not of who wins a
# row lock: we put the quote firmly past its expiry BEFORE either session runs, so
# the derived-expiry guard must refuse both callers whatever the interleaving.
Q "update order_quotes set expires_at = now() - interval '1 minute' where id='q_case_005';" >/dev/null
cat > /tmp/ws7c_a5.sql <<SQL
set lock_timeout = '8s'; set statement_timeout = '20s';
begin;
select 1 from order_quotes where id = 'q_case_005' for update;
select pg_sleep(2);
$AS_STAFF
select begin_quote_payment('{"quoteId":"q_case_005","reservationId":"res_c5a","method":"card"}'::jsonb) is not null;
commit;
SQL
RUN /tmp/ws7c_a5.sql > /tmp/ws7c_a5.out 2>&1 &
sleep 0.7
B5="$(Q "$AS_STAFF select begin_quote_payment('{\"quoteId\":\"q_case_005\",\"reservationId\":\"res_c5b\",\"method\":\"card\"}'::jsonb) is not null;")"
wait
A5="$(cat /tmp/ws7c_a5.out 2>/dev/null)"
ST="$(Q "select status from order_quotes where id='q_case_005';")"
NA="$(Q "select count(*) from quote_payment_attempts where quote_id='q_case_005';")"
chk "session A refused the expired quote (quote_expired)"  "$(echo "$A5" | grep -c 'quote_expired')" "1"
chk "session B refused the expired quote (quote_expired)"  "$(echo "$B5" | grep -c 'quote_expired')" "1"
chk "neither overlapping caller created an attempt"        "$NA" "0"
chk "the quote is still OPEN (derived expiry is not yet swept to durable state)" "$ST" "OPEN"
no_deadlock "case 5 (two reservations on an expired quote)" "$A5" "$B5"
# The sweeper — not the reservation path — is what makes expiry durable.
Q "$AS_STAFF select expire_stale_quotes() is not null;" >/dev/null
chk "expire_stale_quotes then persists the quote as EXPIRED" \
    "$(Q "select status from order_quotes where id='q_case_005';")" "EXPIRED"
chk "the sweep created no attempt either" \
    "$(Q "select count(*) from quote_payment_attempts where quote_id='q_case_005';")" "0"

echo ""
echo "— case 6: duplicate provider reference across concurrent finalisations —"
quote q_case_006a; reserve q_case_006a res_c6a card
quote q_case_006b; reserve q_case_006b res_c6b card
cat > /tmp/ws7c_a6.sql <<SQL
begin;
select 1 from order_quotes where id = 'q_case_006a' for update;
select pg_sleep(2);
$AS_STAFF
select finalise_order_payment('{"quoteId":"q_case_006a","reservationId":"res_c6a","method":"card","providerReference":"T-DUP","approvedAmount":"6.00"}'::jsonb) is not null;
commit;
SQL
RUN /tmp/ws7c_a6.sql > /tmp/ws7c_a6.out 2>&1 &
sleep 0.7
B6="$(Q "$AS_STAFF select finalise_order_payment('{\"quoteId\":\"q_case_006b\",\"reservationId\":\"res_c6b\",\"method\":\"card\",\"providerReference\":\"T-DUP\",\"approvedAmount\":\"6.00\"}'::jsonb) is not null;")"
wait
no_deadlock "case 6 (duplicate reference)" "$(cat /tmp/ws7c_a6.out 2>/dev/null)" "$B6"
chk "the same terminal reference produced exactly ONE completed order" \
    "$(Q "select count(*) from quote_payment_attempts where provider_reference = 'T-DUP' and state='CONSUMED';")" "1"

echo ""
echo "— case 7: drawer closure versus a NEW cash reservation —"
# Correction 1 / finding 12 in the interleaved form. Session A holds the drawer's
# row lock and closes it; session B tries to OPEN a fresh cash payment on that same
# drawer. begin_quote_payment's cash branch takes `... for update` on the session
# row, so the two serialise on it. Either the drawer closes and the new reservation
# is refused, or the reservation is taken and the close is blocked — but a new
# PENDING cash attempt can never appear under a drawer that has already closed.
quote q_case_007
cat > /tmp/ws7c_a7.sql <<SQL
set lock_timeout = '8s'; set statement_timeout = '20s';
begin;
select 1 from web_till_sessions where id = 'sess_c' for update;
select pg_sleep(2);
$AS_STAFF
select close_till_session('{"id":"sess_c","deviceSecret":"race-secret"}'::jsonb) is not null;
commit;
SQL
RUN /tmp/ws7c_a7.sql > /tmp/ws7c_a7.out 2>&1 &
sleep 0.7
B7="$(Q "$AS_STAFF select begin_quote_payment('{\"quoteId\":\"q_case_007\",\"reservationId\":\"res_c7\",\"method\":\"cash\",\"deviceId\":\"dev_c\",\"deviceSecret\":\"race-secret\",\"cashSessionId\":\"sess_c\"}'::jsonb) is not null;")"
wait
A7="$(cat /tmp/ws7c_a7.out 2>/dev/null)"
SESS7="$(Q "select status from web_till_sessions where id='sess_c';")"
NA7="$(Q "select count(*) from quote_payment_attempts where quote_id='q_case_007';")"
if { [ "$SESS7" = "CLOSED" ] && [ "$NA7" = "0" ] && echo "$B7" | grep -q 'till_session_not_open'; } || \
   { [ "$SESS7" = "OPEN" ] && [ "$NA7" = "1" ] && echo "$A7" | grep -q 'session_has_unresolved_payments'; }; then
  PASS=$((PASS+1)); echo "  ✔ drawer close and new cash reservation reached a coherent pair (session=$SESS7, attempts=$NA7)"
else
  FAIL=$((FAIL+1)); echo "  ✖ incoherent close/begin pair (session=$SESS7, attempts=$NA7)"; echo "      A=$A7"; echo "      B=$B7"
fi
no_deadlock "case 7 (drawer close vs new cash reservation)" "$A7" "$B7"
chk "no PENDING cash attempt exists against a CLOSED drawer" \
    "$(Q "select count(*) from quote_payment_attempts a join web_till_sessions s on s.id = a.cash_session_id where a.state='PENDING' and s.status='CLOSED';")" "0"

# ============================================================================
# R3 races — idempotent quote creation, idempotent recovery, evidence idempotency
# ============================================================================
MGR='00000000-0000-4000-8000-0000000000f2'
"$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" <<SEED2 >/dev/null
insert into staff_profiles (id, name, email, role, store_id, store_name, auth_id)
  values ('emp_cm', 'Mara Manager', 'mm@test.local', 'store_manager', 's_c', 'Concurrency', '$MGR');
SEED2
AS_MGR2="do \$mp\$ begin perform set_config('request.jwt.claims', '{\"sub\":\"$MGR\",\"aal\":\"aal2\"}', false); perform set_config('request.jwt.claim.sub', '$MGR', false); end \$mp\$; set role authenticated;"

echo ""
echo "— case 8 (R3): two concurrent quote creations, SAME id + SAME basket —"
cat > /tmp/ws7c_a8.sql <<SQL
set lock_timeout = '8s'; set statement_timeout = '20s';
begin;
$AS_STAFF
select (create_order_quote('{"id":"q_race_08","items":[{"menuItemId":"mp_c","quantity":1}]}'::jsonb)) ->> 'duplicate';
select pg_sleep(2);
commit;
SQL
RUN /tmp/ws7c_a8.sql > /tmp/ws7c_a8.out 2>&1 &
sleep 0.7
B8="$(Q "$AS_STAFF select (create_order_quote('{\"id\":\"q_race_08\",\"items\":[{\"menuItemId\":\"mp_c\",\"quantity\":1}]}'::jsonb)) ->> 'duplicate';")"
wait
A8="$(cat /tmp/ws7c_a8.out 2>/dev/null)"
chk "exactly ONE quote row exists" "$(Q "select count(*) from order_quotes where id='q_race_08';")" "1"
chk "the winner created it (duplicate=false)" "$(echo "$A8" | grep -c 'false')" "1"
chk "the blocked caller got the SAME quote idempotently (duplicate=true)" "$(echo "$B8" | grep -c 'true')" "1"
chk "no caller was rejected as a conflict (same facts)" "$(echo "$A8$B8" | grep -c 'idempotency_conflict')" "0"
no_deadlock "case 8 (concurrent same-claim quote creation)" "$A8" "$B8"

echo ""
echo "— case 9 (R3): two concurrent quote creations, SAME id + DIFFERENT basket —"
cat > /tmp/ws7c_a9.sql <<SQL
set lock_timeout = '8s'; set statement_timeout = '20s';
begin;
$AS_STAFF
select (create_order_quote('{"id":"q_race_09","items":[{"menuItemId":"mp_c","quantity":1}]}'::jsonb)) ->> 'duplicate';
select pg_sleep(2);
commit;
SQL
RUN /tmp/ws7c_a9.sql > /tmp/ws7c_a9.out 2>&1 &
sleep 0.7
B9="$(Q "$AS_STAFF select create_order_quote('{\"id\":\"q_race_09\",\"items\":[{\"menuItemId\":\"mp_c\",\"quantity\":2}]}'::jsonb) is not null;")"
wait
A9="$(cat /tmp/ws7c_a9.out 2>/dev/null)"
chk "exactly ONE quote row exists" "$(Q "select count(*) from order_quotes where id='q_race_09';")" "1"
chk "…and it is the WINNER'S basket (quantity 1)" "$(Q "select items -> 0 ->> 'quantity' from order_quotes where id='q_race_09';")" "1"
chk "the DIFFERENT concurrent basket was rejected as a conflict" "$(echo "$B9" | grep -c 'idempotency_conflict')" "1"
no_deadlock "case 9 (concurrent different-claim quote creation)" "$A9" "$B9"

echo ""
echo "— case 10 (R3): two concurrent recoveries, SAME resolutionId + SAME claim —"
quote q_race_10; reserve q_race_10 res_r10 card
Q "update order_quotes set payment_started_at = now() - interval '25 hours' where id='q_race_10';" >/dev/null
cat > /tmp/ws7c_a10.sql <<SQL
set lock_timeout = '8s'; set statement_timeout = '20s';
begin;
select 1 from order_quotes where id = 'q_race_10' for update;
select pg_sleep(2);
$AS_MGR2
select resolve_payment_reconciliation('{"quoteId":"q_race_10","reservationId":"res_r10","action":"void","reason":"no settlement arrived for this attempt","resolutionId":"rsl_r10_x1"}'::jsonb)::text;
commit;
SQL
RUN /tmp/ws7c_a10.sql > /tmp/ws7c_a10.out 2>&1 &
sleep 0.7
B10="$(Q "$AS_MGR2 select resolve_payment_reconciliation('{\"quoteId\":\"q_race_10\",\"reservationId\":\"res_r10\",\"action\":\"void\",\"reason\":\"no settlement arrived for this attempt\",\"resolutionId\":\"rsl_r10_x1\"}'::jsonb)::text;")"
wait
A10="$(cat /tmp/ws7c_a10.out 2>/dev/null)"
chk "the quote is CANCELLED exactly once" "$(Q "select status from order_quotes where id='q_race_10';")" "CANCELLED"
chk "the attempt is ABANDONED" "$(Q "select state from quote_payment_attempts where reservation_id='res_r10';")" "ABANDONED"
chk "BOTH callers received the void outcome" "$(echo "$A10$B10" | grep -o '"resolution": *"void"' | wc -l | tr -d ' ')" "2"
chk "the blocked caller's reply was the idempotent REPLAY (duplicate=true)" "$(echo "$B10" | grep -c '"duplicate": *true')" "1"
chk "no caller was rejected as a conflict (same claim)" "$(echo "$A10$B10" | grep -c 'idempotency_conflict')" "0"
no_deadlock "case 10 (concurrent same-claim recovery)" "$A10" "$B10"

echo ""
echo "— case 11 (R3): two concurrent recoveries, SAME resolutionId + DIFFERENT claim —"
quote q_race_11; reserve q_race_11 res_r11 card
Q "update order_quotes set payment_started_at = now() - interval '25 hours' where id='q_race_11';" >/dev/null
cat > /tmp/ws7c_a11.sql <<SQL
set lock_timeout = '8s'; set statement_timeout = '20s';
begin;
select 1 from order_quotes where id = 'q_race_11' for update;
select pg_sleep(2);
$AS_MGR2
select resolve_payment_reconciliation('{"quoteId":"q_race_11","reservationId":"res_r11","action":"void","reason":"no settlement arrived for this attempt","resolutionId":"rsl_r11_x1"}'::jsonb)::text;
commit;
SQL
RUN /tmp/ws7c_a11.sql > /tmp/ws7c_a11.out 2>&1 &
sleep 0.7
B11="$(Q "$AS_MGR2 select resolve_payment_reconciliation('{\"quoteId\":\"q_race_11\",\"reservationId\":\"res_r11\",\"action\":\"void\",\"reason\":\"a completely different account of events\",\"resolutionId\":\"rsl_r11_x1\"}'::jsonb)::text;")"
wait
A11="$(cat /tmp/ws7c_a11.out 2>/dev/null)"
chk "the quote is CANCELLED exactly once (the winner's claim)" "$(Q "select status from order_quotes where id='q_race_11';")" "CANCELLED"
chk "the winner's void succeeded" "$(echo "$A11" | grep -o '"resolution": *"void"' | wc -l | tr -d ' ')" "1"
chk "the DIFFERENT concurrent claim was rejected as a conflict" "$(echo "$B11" | grep -c 'idempotency_conflict')" "1"
no_deadlock "case 11 (concurrent different-claim recovery)" "$A11" "$B11"

echo ""
echo "— case 12 (R3): two concurrent evidence matches, SAME idempotency key —"
quote q_race_12; reserve q_race_12 res_r12 card
Q "$AS_STAFF select finalise_order_payment('{\"quoteId\":\"q_race_12\",\"reservationId\":\"res_r12\",\"method\":\"card\",\"providerReference\":\"T-R12\",\"approvedAmount\":\"6.00\"}'::jsonb) is not null;" >/dev/null
EVT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > /tmp/ws7c_a12.sql <<SQL
set lock_timeout = '8s'; set statement_timeout = '20s';
begin;
select 1 from quote_payment_attempts where reservation_id = 'res_r12' for update;
select pg_sleep(2);
$AS_MGR2
select (reconcile_card_payment('{"reservationId":"res_r12","evidenceType":"terminal_receipt","externalReference":"TRX-R12","currency":"GBP","matchedAmount":"6.00","paymentEventAt":"$EVT","reason":"matched to the terminal receipt","idempotencyKey":"idem_r12_key1"}'::jsonb)) ->> 'duplicate';
commit;
SQL
RUN /tmp/ws7c_a12.sql > /tmp/ws7c_a12.out 2>&1 &
sleep 0.7
B12="$(Q "$AS_MGR2 select (reconcile_card_payment('{\"reservationId\":\"res_r12\",\"evidenceType\":\"terminal_receipt\",\"externalReference\":\"TRX-R12\",\"currency\":\"GBP\",\"matchedAmount\":\"6.00\",\"paymentEventAt\":\"$EVT\",\"reason\":\"matched to the terminal receipt\",\"idempotencyKey\":\"idem_r12_key1\"}'::jsonb)) ->> 'duplicate';")"
wait
A12="$(cat /tmp/ws7c_a12.out 2>/dev/null)"
chk "exactly ONE immutable evidence row exists" "$(Q "select count(*) from payment_reconciliations where idempotency_key='idem_r12_key1';")" "1"
chk "the order is MANUAL_EVIDENCE_MATCHED" "$(Q "select payment_status from orders where quote_id='q_race_12';")" "MANUAL_EVIDENCE_MATCHED"
chk "the winner recorded it (duplicate=false)" "$(echo "$A12" | grep -c 'false')" "1"
chk "the blocked caller got the SAME evidence idempotently (duplicate=true)" "$(echo "$B12" | grep -c 'true')" "1"
chk "no caller was rejected as a conflict (same key, same evidence)" "$(echo "$A12$B12" | grep -c 'idempotency_conflict')" "0"
no_deadlock "case 12 (concurrent same-key evidence match)" "$A12" "$B12"

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "✔ WS7 CONCURRENCY — $PASS passed, 0 failed (two overlapping sessions per case)"
else
  echo "✖ WS7 CONCURRENCY — $PASS passed, $FAIL failed"
  exit 1
fi
