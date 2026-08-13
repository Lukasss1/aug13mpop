#!/usr/bin/env bash
# ============================================================================
#  r49-recovery.test.sh — R4.9 G6 RECOVERY AUTHORISATION AND ATOMIC CLAIMING
# ============================================================================
#  The r48 recovery suites are regex source-scans: they assert that a rule is
#  written down. These assertions run the rules against PostgreSQL 17 as real
#  identities, including a genuine concurrency race on one intent.
#
#  Covered:
#    §1 who may act on whom  — the cross-store gap the audit found (item 5)
#    §2 action preconditions — ban_leaver on a current employee, empty reasons
#    §3 claiming             — binding, expiry, double-claim (item 6)
#    §4 RE-authorisation     — a requester demoted between request and claim
#    §5 the race             — N parallel claimers, exactly one winner
#
#    Run: npm run test:r49-recovery
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN="/usr/lib/postgresql/17/bin"
[ -x "$PGBIN/psql" ] || { echo "PostgreSQL 17 binaries required at $PGBIN" >&2; exit 1; }
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres "$(pwd)" 2>/dev/null || true
  exec su postgres -s /bin/bash -c "cd '$(pwd)' && bash scripts/r49-recovery.test.sh"
fi
PGDATA="/tmp/milkpop-r49rec-pg"; PGSOCK="/tmp/milkpop-r49rec-sock"; DB=milkpop_r49rec
cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup
rm -rf "$PGDATA" "$PGSOCK"; mkdir -p "$PGDATA" "$PGSOCK"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -c listen_addresses='' -c fsync=off" -w start >/dev/null
"$PGBIN/psql" -q -X -h "$PGSOCK" -U postgres -d postgres -c "create database $DB" >/dev/null

PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✔ $1";
        else FAIL=$((FAIL+1)); echo "  ✖ $1"; echo "      got:  $2"; echo "      want: $3"; fi; }
chk_has() { case "$2" in *"$3"*) PASS=$((PASS+1)); echo "  ✔ $1";;
            *) FAIL=$((FAIL+1)); echo "  ✖ $1"; echo "      got:  $2"; echo "      want to contain: $3";; esac; }
Q()  { "$PGBIN/psql" -tA -X -h "$PGSOCK" -U postgres -d "$DB" -c "$1"; }
QF() { { "$PGBIN/psql" -tA -X -h "$PGSOCK" -U postgres -d "$DB" -c "$1" 2>&1 || true; } | tr '\n' ' '; }
# AS <auth_uuid> <sql> — run as that person, authenticated and AAL2.
AS() { QF "select set_config('request.jwt.claims','{\"sub\":\"$1\",\"role\":\"authenticated\",\"aal\":\"aal2\"}',false);
           set role authenticated; $2"; }

# R4.10 Increment 4: the Supabase privilege/surface shim is no longer written
# out here. Every database harness executes ONE shared file so they all start
# from the same posture as production — see scripts/lib/supabase-local-privileges.sql
# for why that matters (a harness that starts MORE locked down than production
# can prove a REVOKE worked but can never see a relation left readable).
"$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" >/dev/null -f "$(dirname "${BASH_SOURCE[0]}")/lib/supabase-local-privileges.sql"

"$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" -f supabase/schema.FRESH-INSTALL-ONLY.sql >/dev/null
# shellcheck source=launch/migration-manifest.sh
source launch/migration-manifest.sh
for m in "${MP_MIGRATIONS[@]}"; do
  "$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" -f "$m" >/dev/null
done
echo "chain: ${#MP_MIGRATIONS[@]} migrations applied"

# --- identities: two storefronts, a manager in each, employees, an owner ------
OWNER=00000000-0000-4000-8000-0000000000a1
MGR_A=00000000-0000-4000-8000-0000000000a2
MGR_B=00000000-0000-4000-8000-0000000000a3
EMP_A=00000000-0000-4000-8000-0000000000a4
EMP_B=00000000-0000-4000-8000-0000000000a5
LEAVER=00000000-0000-4000-8000-0000000000a6
"$PGBIN/psql" -q -X -v ON_ERROR_STOP=1 -h "$PGSOCK" -U postgres -d "$DB" >/dev/null <<SEED
-- ACTIVE requires a coherent trading configuration (stores_setup_coherent).
insert into stores (id,name,address,postcode,opening_hours,status,setup_status,
                    timezone,currency_code,payment_methods,vat_config_confirmed_at)
values ('sa','Store A','1 A Way','A1 1AA','Mon-Sun 09:00-21:00','coming_soon','ACTIVE',
        'Europe/London','GBP','["cash","card"]'::jsonb,now()),
       ('sb','Store B','1 B Way','B1 1BB','Mon-Sun 09:00-21:00','coming_soon','ACTIVE',
        'Europe/London','GBP','["cash","card"]'::jsonb,now());
insert into staff_profiles (id,name,email,role,store_id,store_name,auth_id) values
  ('p_owner','Olive Owner','o@t.local','owner','sa','Store A','$OWNER'),
  ('p_mgr_a','Mia Manager','ma@t.local','store_manager','sa','Store A','$MGR_A'),
  ('p_mgr_b','Ben Manager','mb@t.local','store_manager','sb','Store B','$MGR_B'),
  ('p_emp_a','Ann Employee','ea@t.local','team_member','sa','Store A','$EMP_A'),
  ('p_emp_b','Bob Employee','eb@t.local','team_member','sb','Store B','$EMP_B'),
  ('p_leaver','Lee Leaver','lv@t.local','team_member','sa','Store A','$LEAVER');
update staff_profiles set ended_at = now() where id = 'p_leaver';
SEED

echo; echo "— §1 who may act on whom —"
chk_has "same-store employee: a manager MAY act"    "$(AS $MGR_A "select coalesce(recovery_action_permitted('p_emp_a','revoke_sessions','left the team'),'VERDICT_OK');")" "VERDICT_OK"
chk_has "OTHER-store employee: refused (the cross-store gap)" "$(AS $MGR_A "select recovery_action_permitted('p_emp_b','revoke_sessions','x');")" "target_other_store"
chk_has "another MANAGER: refused"                  "$(AS $MGR_A "select recovery_action_permitted('p_mgr_b','revoke_sessions','x');")" "not_permitted"
chk_has "the OWNER: refused"                        "$(AS $MGR_A "select recovery_action_permitted('p_owner','revoke_sessions','x');")" "not_permitted"
chk_has "the OWNER may act across storefronts"      "$(AS $OWNER "select coalesce(recovery_action_permitted('p_emp_b','revoke_sessions','x'),'VERDICT_OK');")" "VERDICT_OK"
chk_has "reset_mfa by a manager: refused"           "$(AS $MGR_A "select recovery_action_permitted('p_emp_a','reset_mfa');")" "not_permitted"
chk_has "reset_mfa on SELF: refused"                "$(AS $OWNER "select recovery_action_permitted('p_owner','reset_mfa');")" "self_reset_forbidden"

echo; echo "— §2 action preconditions —"
chk_has "ban_leaver on a CURRENT employee: refused" "$(AS $OWNER "select recovery_action_permitted('p_emp_a','ban_leaver');")" "target_still_employed"
chk_has "ban_leaver on an ended employment: permitted" "$(AS $OWNER "select coalesce(recovery_action_permitted('p_leaver','ban_leaver'),'VERDICT_OK');")" "VERDICT_OK"
chk_has "revoke_sessions with no reason: refused"   "$(AS $OWNER "select recovery_action_permitted('p_emp_a','revoke_sessions','');")" "reason_required"
chk_has "request_recovery_action enforces the SAME predicate" "$(AS $MGR_A "select request_recovery_action('revoke_sessions','p_emp_b','x');")" "target_other_store"

echo; echo "— §3 claiming —"
INTENT="$(AS $MGR_A "select request_recovery_action('revoke_sessions','p_emp_a','left the team')->>'intent_id';" | awk '{print $NF}')"
chk "an intent was created" "$(Q "select count(*) from admin_recovery_intents where id='$INTENT'")" "1"
chk_has "a DIFFERENT person cannot claim it"        "$(AS $MGR_B "select claim_recovery_intent('$INTENT');")" "not_requester"
chk_has "the requester claims it"                   "$(AS $MGR_A "select claim_recovery_intent('$INTENT');")" '"ok": true'
chk_has "…and a second claim is refused"            "$(AS $MGR_A "select claim_recovery_intent('$INTENT');")" "intent_already_consumed"
chk "…and the intent is recorded as claimed"        "$(Q "select result from admin_recovery_intents where id='$INTENT'")" "claimed"

INTENT_OLD="$(AS $MGR_A "select request_recovery_action('revoke_sessions','p_emp_a','again')->>'intent_id';" | awk '{print $NF}')"
Q "update admin_recovery_intents set created_at = now() - interval '11 minutes' where id='$INTENT_OLD';" >/dev/null
chk_has "an intent older than ten minutes is refused" "$(AS $MGR_A "select claim_recovery_intent('$INTENT_OLD');")" "intent_expired"

echo; echo "— §4 re-authorisation at execution time —"
INTENT_DEMO="$(AS $MGR_A "select request_recovery_action('revoke_sessions','p_emp_a','third')->>'intent_id';" | awk '{print $NF}')"
Q "update staff_profiles set role='team_member' where id='p_mgr_a';" >/dev/null
chk_has "a requester DEMOTED after requesting cannot execute" "$(AS $MGR_A "select claim_recovery_intent('$INTENT_DEMO');")" "not_permitted"
chk "…and the refusal is recorded on the intent"    "$(Q "select result from admin_recovery_intents where id='$INTENT_DEMO'")" "refused:not_permitted"
Q "update staff_profiles set role='store_manager' where id='p_mgr_a';" >/dev/null

INTENT_MOVE="$(AS $MGR_A "select request_recovery_action('revoke_sessions','p_emp_a','fourth')->>'intent_id';" | awk '{print $NF}')"
Q "update staff_profiles set store_id='sb', store_name='Store B' where id='p_mgr_a';" >/dev/null
chk_has "a requester MOVED to another store cannot execute" "$(AS $MGR_A "select claim_recovery_intent('$INTENT_MOVE');")" "target_other_store"
Q "update staff_profiles set store_id='sa', store_name='Store A' where id='p_mgr_a';" >/dev/null

echo; echo "— §5 the race: N parallel claimers, one intent —"
RACE="$(AS $MGR_A "select request_recovery_action('revoke_sessions','p_emp_a','race')->>'intent_id';" | awk '{print $NF}')"
RD=/tmp/r49-race; rm -rf "$RD"; mkdir -p "$RD"
for i in $(seq 1 8); do
  ( "$PGBIN/psql" -tA -X -h "$PGSOCK" -U postgres -d "$DB" -c \
      "select set_config('request.jwt.claims','{\"sub\":\"$MGR_A\",\"role\":\"authenticated\",\"aal\":\"aal2\"}',false);
       set role authenticated;
       select claim_recovery_intent('$RACE');" > "$RD/$i.out" 2>&1 ) &
done
wait
WINNERS=$(grep -l '"ok": true' "$RD"/*.out 2>/dev/null | wc -l | tr -d ' ')
LOSERS=$(grep -l 'intent_already_consumed' "$RD"/*.out 2>/dev/null | wc -l | tr -d ' ')
chk "exactly ONE of eight concurrent claimers wins" "$WINNERS" "1"
chk "…and the other seven are told it is already consumed" "$LOSERS" "7"
chk "…and the intent was consumed exactly once" \
    "$(Q "select count(*) from admin_recovery_intents where id='$RACE' and consumed_at is not null")" "1"

echo
if [ "$FAIL" = "0" ]; then echo "✔ R49 RECOVERY — $PASS passed, 0 failed";
else echo "✖ R49 RECOVERY — $PASS passed, $FAIL failed"; fi
exit "$([ "$FAIL" = "0" ] && echo 0 || echo 1)"
