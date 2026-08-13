-- ============================================================================
--  MILK POP — POS sync (integration plan Gates 5 + 10 posture)
--
--  Cloud side of the till↔website contract (docs/SYNC-CONTRACT.md v1):
--
--   • pos_devices / pos_pairing_codes — pairing with one-time hashed codes
--     (15-minute TTL), 256-bit device tokens stored ONLY as SHA-256 hex,
--     revocation, and rotation with an overlap window (the old token stays
--     valid until the till first authenticates with the new one).
--   • pos_events — the idempotency ledger: event_id UNIQUE + payload hash.
--     A replayed identical event is acknowledged; the same id with a
--     DIFFERENT payload is a duplicate_conflict, never silently applied.
--   • pos_orders/items/modifiers, pos_shifts, pos_refunds(+items),
--     pos_voids, pos_corrections, pos_cash_movements, pos_approvals,
--     pos_audit_events — full entity snapshots, integer pence, actor
--     display names carried alongside till-local ids.
--   • pos_ingest_batch(...) — the ONLY write path, called by the pos-ingest
--     Edge Function with the service role. Each event applies inside its own
--     savepoint: a rejected event never rolls back its batch-mates
--     (mandatory test #4), and the ack/reject partition always accounts for
--     every event exactly once.
--
--  RLS posture (Gate 10, deny by default from day one):
--   • anon: NOTHING on any pos_ table.
--   • authenticated browsers: SELECT only, scoped by is_owner() /
--     is_manager_or_owner() + current_staff_store() (helpers from
--     migration_rls_per_role.sql — run that first). No INSERT/UPDATE/DELETE.
--   • pos_devices SELECT is COLUMN-scoped: token hashes are never
--     grantable to browser clients.
--   • Device writes reach the tables only through pos_ingest_batch
--     (service role); pairing/rotation/revocation are Owner-only RPCs.
--
--  Requires: pgcrypto (digest/gen_random_bytes), migration_rls_per_role.sql.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Devices, pairing codes, pairing rate-limit log
-- ---------------------------------------------------------------------------

create table if not exists pos_devices (
  id                       uuid primary key default gen_random_uuid(),
  store_id                 text not null,
  store_name               text not null,
  installation_id          text not null,
  device_name              text not null,
  device_code              text not null,
  store_code               text not null,
  app_version              text,
  schema_version           integer,
  token_hash               text not null unique,          -- sha-256 hex; NEVER the token
  pending_token_hash       text unique,                   -- rotation overlap window
  pending_token_created_at timestamptz,
  revoked                  boolean not null default false,
  paired_at                timestamptz not null default now(),
  last_seen_at             timestamptz,
  last_sync_at             timestamptz
);
create index if not exists idx_pos_devices_store on pos_devices (store_id);

create table if not exists pos_pairing_codes (
  id             uuid primary key default gen_random_uuid(),
  code_hash      text not null unique,                    -- sha-256 hex; NEVER the code
  store_id       text not null,
  store_name     text not null,
  device_label   text not null,
  created_by     text,                                    -- staff_profiles.id of the owner
  expires_at     timestamptz not null,
  used_at        timestamptz,
  used_by_device uuid references pos_devices (id),
  created_at     timestamptz not null default now()
);

-- Pairing attempts per hashed IP (the public-form limiter pattern; that log's
-- form_kind CHECK is closed, so pairing gets its own table).
create table if not exists pos_pair_attempts (
  id         uuid primary key default gen_random_uuid(),
  ip_hash    text not null,
  status     text not null check (status in ('accepted','rejected')),
  created_at timestamptz not null default now()
);
create index if not exists idx_pos_pair_attempts_ip_time
  on pos_pair_attempts (ip_hash, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. The idempotency ledger
-- ---------------------------------------------------------------------------

create table if not exists pos_events (
  event_id          text primary key,                     -- till sync_outbox.id
  device_id         uuid not null references pos_devices (id),
  event_type        text not null,
  entity_id         text not null,
  payload           jsonb not null,
  payload_hash      text not null,                        -- sha-256 of payload::text (jsonb-normalized)
  device_created_at timestamptz not null,                 -- occurred_at: the till's clock
  received_at       timestamptz not null default now()    -- the server's clock
);
create index if not exists idx_pos_events_device_received on pos_events (device_id, received_at);
create index if not exists idx_pos_events_type on pos_events (event_type, received_at);

-- ---------------------------------------------------------------------------
-- 3. Entity tables (integer pence everywhere; occurred_at = till clock)
-- ---------------------------------------------------------------------------

create table if not exists pos_orders (
  id                       text primary key,
  device_id                uuid not null references pos_devices (id),
  store_id                 text not null,
  client_reference         text not null,
  visible_order_number     text not null,
  order_sequence           bigint,
  store_code               text not null,
  device_code              text not null,
  status                   text not null check (status = 'completed'),
  subtotal_pence           bigint not null check (subtotal_pence >= 0),
  discount_pence           bigint not null check (discount_pence >= 0),
  vat_pence                bigint not null check (vat_pence >= 0),
  total_pence              bigint not null check (total_pence >= 0),
  applied_deals            jsonb not null default '[]'::jsonb,
  payment_method           text not null check (payment_method in ('cash','card')),
  cash_received_pence      bigint check (cash_received_pence is null or cash_received_pence >= 0),
  change_given_pence       bigint check (change_given_pence is null or change_given_pence >= 0),
  manual_card_confirmation boolean not null default false,
  shift_id                 text,
  sold_by_user_id          text,
  sold_by_name             text,
  occurred_at              timestamptz not null,
  completed_at             timestamptz not null,
  received_at              timestamptz not null default now(),
  unique (device_id, visible_order_number)                -- per-device numbering (amendment)
);
create index if not exists idx_pos_orders_store_time on pos_orders (store_id, occurred_at);
create index if not exists idx_pos_orders_shift on pos_orders (shift_id);

create table if not exists pos_order_items (
  id                        text primary key,
  order_id                  text not null references pos_orders (id),
  product_id                text not null,
  name                      text not null,
  category                  text not null,
  size                      text not null check (size in ('regular','large','one_size')),
  quantity                  integer not null check (quantity > 0),
  unit_price_pence          bigint not null check (unit_price_pence >= 0),
  line_total_pence          bigint not null check (line_total_pence >= 0),
  discount_allocation_pence bigint not null check (discount_allocation_pence >= 0),
  vat_rate_bp               integer not null check (vat_rate_bp between 0 and 10000),
  vat_pence                 bigint not null check (vat_pence >= 0)
);
create index if not exists idx_pos_order_items_order on pos_order_items (order_id);

create table if not exists pos_order_item_modifiers (
  id            text primary key,
  order_item_id text not null references pos_order_items (id),
  modifier_id   text not null,
  name          text not null,
  price_pence   bigint not null check (price_pence >= 0)
);
create index if not exists idx_pos_item_mods_item on pos_order_item_modifiers (order_item_id);

create table if not exists pos_shifts (
  id                  text primary key,
  device_id           uuid not null references pos_devices (id),
  store_id            text not null,
  status              text not null check (status in ('open','closed')),
  opened_at           timestamptz,
  opened_by_user_id   text,
  opened_by_name      text,
  opening_cash_pence  bigint check (opening_cash_pence is null or opening_cash_pence >= 0),
  closed_at           timestamptz,
  closed_by_user_id   text,
  closed_by_name      text,
  counted_cash_pence  bigint,
  reported_card_pence bigint,
  expected_cash_pence bigint,
  cash_variance_pence bigint,
  expected_card_pence bigint,
  card_variance_pence bigint,
  variance_reason     text,
  closing_note        text,
  close_summary       jsonb,                              -- the till's STORED Z-report, verbatim
  received_at         timestamptz not null default now()
);
create index if not exists idx_pos_shifts_store on pos_shifts (store_id, opened_at);

create table if not exists pos_cash_movements (
  id                  text primary key,
  device_id           uuid not null references pos_devices (id),
  store_id            text not null,
  shift_id            text not null,
  direction           text not null check (direction in ('paid_in','paid_out')),
  amount_pence        bigint not null check (amount_pence > 0),
  reason              text not null,
  user_id             text,
  user_name           text,
  approved_by_user_id text,
  approved_by_name    text,
  occurred_at         timestamptz not null,
  received_at         timestamptz not null default now()
);
create index if not exists idx_pos_cash_movements_shift on pos_cash_movements (shift_id);

create table if not exists pos_refunds (
  id                      text primary key,
  device_id               uuid not null references pos_devices (id),
  store_id                text not null,
  order_id                text not null references pos_orders (id),
  shift_id                text not null,
  kind                    text not null check (kind in ('full','items','custom')),
  method                  text not null check (method in ('cash','card')),
  amount_pence            bigint not null check (amount_pence > 0),
  reason                  text not null,
  user_id                 text,
  user_name               text,
  approved_by_user_id     text,
  approved_by_name        text,
  card_terminal_confirmed boolean not null default false,
  occurred_at             timestamptz not null,
  received_at             timestamptz not null default now()
);
create index if not exists idx_pos_refunds_order on pos_refunds (order_id);
create index if not exists idx_pos_refunds_shift on pos_refunds (shift_id);

create table if not exists pos_refund_items (
  id            text primary key,
  refund_id     text not null references pos_refunds (id),
  order_item_id text not null,
  name          text,
  size          text,
  quantity      integer not null check (quantity > 0),
  amount_pence  bigint not null check (amount_pence >= 0)
);
create index if not exists idx_pos_refund_items_refund on pos_refund_items (refund_id);

create table if not exists pos_voids (
  id                      text primary key,
  device_id               uuid not null references pos_devices (id),
  store_id                text not null,
  order_id                text not null unique references pos_orders (id),
  shift_id                text not null,
  order_total_pence       bigint not null check (order_total_pence >= 0),
  method                  text not null check (method in ('cash','card')),
  card_terminal_confirmed boolean not null default false,
  reason                  text not null,
  user_id                 text,
  user_name               text,
  approved_by_user_id     text,
  approved_by_name        text,
  occurred_at             timestamptz not null,
  received_at             timestamptz not null default now()
);
create index if not exists idx_pos_voids_shift on pos_voids (shift_id);

create table if not exists pos_corrections (
  id                  text primary key,
  device_id           uuid not null references pos_devices (id),
  store_id            text not null,
  order_id            text references pos_orders (id),
  shift_id            text not null,
  kind                text not null check (kind in ('payment_method','operational')),
  before_payload      jsonb not null default '{}'::jsonb,
  after_payload       jsonb not null default '{}'::jsonb,
  reason              text not null,
  user_id             text,
  user_name           text,
  approved_by_user_id text,
  approved_by_name    text,
  occurred_at         timestamptz not null,
  received_at         timestamptz not null default now()
);
create index if not exists idx_pos_corrections_order on pos_corrections (order_id);

create table if not exists pos_approvals (
  id                   text primary key,
  device_id            uuid not null references pos_devices (id),
  store_id             text not null,
  action_type          text not null check (action_type in ('refund','void','correction','variance','cash_movement')),
  entity_type          text not null,
  entity_id            text not null,
  approver_user_id     text,
  approver_name        text,
  requested_by_user_id text,
  requested_by_name    text,
  reason               text,
  occurred_at          timestamptz not null,
  received_at          timestamptz not null default now()
);
create index if not exists idx_pos_approvals_entity on pos_approvals (entity_type, entity_id);

create table if not exists pos_audit_events (
  event_id    text primary key references pos_events (event_id),
  device_id   uuid not null references pos_devices (id),
  store_id    text not null,
  event_type  text not null,
  entity_id   text not null,
  payload     jsonb not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now()
);
create index if not exists idx_pos_audit_store_time on pos_audit_events (store_id, occurred_at);

-- ---------------------------------------------------------------------------
-- 4. RLS + grants: deny by default, column-scoped device reads
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'pos_devices','pos_pairing_codes','pos_pair_attempts','pos_events',
    'pos_orders','pos_order_items','pos_order_item_modifiers','pos_shifts',
    'pos_cash_movements','pos_refunds','pos_refund_items','pos_voids',
    'pos_corrections','pos_approvals','pos_audit_events'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon', t);
    execute format('revoke all on table %I from authenticated', t);
  end loop;
end $$;

-- Browser reads: SELECT only, store-scoped, manager/owner only. The store
-- scope lives in the POLICY; the verb scope lives in the GRANT.
do $$
declare t text;
begin
  foreach t in array array[
    'pos_events','pos_orders','pos_order_items','pos_order_item_modifiers',
    'pos_shifts','pos_cash_movements','pos_refunds','pos_refund_items',
    'pos_voids','pos_corrections','pos_approvals','pos_audit_events'
  ] loop
    execute format('drop policy if exists pos_read_scoped on %I', t);
  end loop;
end $$;

-- Row scope: owners see every store; managers only their own. Child tables
-- without a store_id column scope through their parent.
create policy pos_read_scoped on pos_events for select to authenticated
  using (is_owner() or (is_manager_or_owner()
    and exists (select 1 from pos_devices d where d.id = device_id and d.store_id = current_staff_store())));
create policy pos_read_scoped on pos_orders for select to authenticated
  using (is_owner() or (is_manager_or_owner() and store_id = current_staff_store()));
create policy pos_read_scoped on pos_order_items for select to authenticated
  using (exists (select 1 from pos_orders o where o.id = order_id
    and (is_owner() or (is_manager_or_owner() and o.store_id = current_staff_store()))));
create policy pos_read_scoped on pos_order_item_modifiers for select to authenticated
  using (exists (select 1 from pos_order_items i join pos_orders o on o.id = i.order_id
    where i.id = order_item_id
    and (is_owner() or (is_manager_or_owner() and o.store_id = current_staff_store()))));
create policy pos_read_scoped on pos_shifts for select to authenticated
  using (is_owner() or (is_manager_or_owner() and store_id = current_staff_store()));
create policy pos_read_scoped on pos_cash_movements for select to authenticated
  using (is_owner() or (is_manager_or_owner() and store_id = current_staff_store()));
create policy pos_read_scoped on pos_refunds for select to authenticated
  using (is_owner() or (is_manager_or_owner() and store_id = current_staff_store()));
create policy pos_read_scoped on pos_refund_items for select to authenticated
  using (exists (select 1 from pos_refunds r where r.id = refund_id
    and (is_owner() or (is_manager_or_owner() and r.store_id = current_staff_store()))));
create policy pos_read_scoped on pos_voids for select to authenticated
  using (is_owner() or (is_manager_or_owner() and store_id = current_staff_store()));
create policy pos_read_scoped on pos_corrections for select to authenticated
  using (is_owner() or (is_manager_or_owner() and store_id = current_staff_store()));
create policy pos_read_scoped on pos_approvals for select to authenticated
  using (is_owner() or (is_manager_or_owner() and store_id = current_staff_store()));
create policy pos_read_scoped on pos_audit_events for select to authenticated
  using (is_owner() or (is_manager_or_owner() and store_id = current_staff_store()));

grant select on pos_events, pos_orders, pos_order_items, pos_order_item_modifiers,
  pos_shifts, pos_cash_movements, pos_refunds, pos_refund_items, pos_voids,
  pos_corrections, pos_approvals, pos_audit_events to authenticated;

-- pos_devices: browsers may see device METADATA (Gate 8 dashboard) but the
-- token hash columns are not even grantable. Owner sees all; manager their store.
drop policy if exists pos_devices_read_scoped on pos_devices;
create policy pos_devices_read_scoped on pos_devices for select to authenticated
  using (is_owner() or (is_manager_or_owner() and store_id = current_staff_store()));
grant select (id, store_id, store_name, installation_id, device_name, device_code,
  store_code, app_version, schema_version, revoked, paired_at, last_seen_at, last_sync_at)
  on pos_devices to authenticated;

-- pos_pairing_codes / pos_pair_attempts: no browser access at all (hashes
-- inside). Owners act through the SECURITY DEFINER RPCs below.

-- ---------------------------------------------------------------------------
-- 5. Owner RPCs: pairing codes, revoke, rotate (overlap window)
-- ---------------------------------------------------------------------------

-- Unambiguous pairing alphabet: no 0/O, 1/I/L.
create or replace function pos_random_code(p_length integer)
returns text
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  bytes bytea := gen_random_bytes(p_length);
  out_code text := '';
  i integer;
begin
  for i in 0 .. p_length - 1 loop
    out_code := out_code || substr(alphabet, (get_byte(bytes, i) % length(alphabet)) + 1, 1);
  end loop;
  return out_code;
end;
$$;

-- Owner generates a one-time pairing code for a store. The PLAINTEXT code is
-- returned exactly once; only its hash is stored. 15-minute TTL (contract §9).
create or replace function create_pos_pairing_code(
  p_store_id text, p_store_name text, p_device_label text
)
returns table (code text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
begin
  if not is_owner() then
    raise exception 'Only the owner can generate till pairing codes.';
  end if;
  if coalesce(trim(p_store_id), '') = '' or coalesce(trim(p_device_label), '') = '' then
    raise exception 'A store and a device label are required.';
  end if;
  v_code := pos_random_code(8);
  return query
    insert into pos_pairing_codes (code_hash, store_id, store_name, device_label, created_by, expires_at)
    values (encode(digest(v_code, 'sha256'), 'hex'),
            trim(p_store_id), coalesce(trim(p_store_name), trim(p_store_id)),
            trim(p_device_label), current_staff_id(), now() + interval '15 minutes')
    returning v_code, pos_pairing_codes.expires_at;
end;
$$;

-- Revocation is IMMEDIATE and one-way from the browser side (a fresh pairing
-- creates a fresh device row). Clears any pending rotation too.
create or replace function revoke_pos_device(p_device_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if not is_owner() then
    raise exception 'Only the owner can revoke a till.';
  end if;
  update pos_devices
     set revoked = true, pending_token_hash = null, pending_token_created_at = null
   where id = p_device_id;
  if not found then
    raise exception 'Unknown device.';
  end if;
end;
$$;

-- Rotation with an OVERLAP window (amendment): the new token's hash goes to
-- pending_*; the OLD token keeps working until the till first authenticates
-- with the new one (pos_authenticate_device promotes it). Rotating never
-- bricks an offline iPad. The plaintext is returned exactly once.
create or replace function rotate_pos_device_token(p_device_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text;
begin
  if not is_owner() then
    raise exception 'Only the owner can rotate a till token.';
  end if;
  v_token := translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');
  update pos_devices
     set pending_token_hash = encode(digest(v_token, 'sha256'), 'hex'),
         pending_token_created_at = now()
   where id = p_device_id and revoked = false;
  if not found then
    raise exception 'Unknown or revoked device.';
  end if;
  return v_token;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Service-role RPCs used by the Edge Functions
-- ---------------------------------------------------------------------------

-- Authenticate a device by TOKEN HASH (the raw token never enters SQL).
-- Accepts the current hash OR the pending one; presenting the pending hash
-- PROMOTES it (rotation completes, old token dies). Bumps last_seen_at.
-- Returns NULL when nothing matches; the caller answers 401. A revoked
-- device is returned WITH revoked=true so the caller can refuse explicitly
-- (mandatory test #5).
create or replace function pos_authenticate_device(p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  d pos_devices%rowtype;
begin
  select * into d from pos_devices where token_hash = p_token_hash;
  if not found then
    select * into d from pos_devices where pending_token_hash = p_token_hash;
    if not found then
      return null;
    end if;
    if not d.revoked then
      update pos_devices
         set token_hash = p_token_hash, pending_token_hash = null,
             pending_token_created_at = null, last_seen_at = now()
       where id = d.id;
    end if;
  else
    update pos_devices set last_seen_at = now() where id = d.id;
  end if;
  return jsonb_build_object(
    'id', d.id, 'storeId', d.store_id, 'storeName', d.store_name,
    'storeCode', d.store_code, 'deviceCode', d.device_code,
    'installationId', d.installation_id, 'revoked', d.revoked);
end;
$$;

-- Complete a pairing: consume an unused, unexpired code (row-locked so a
-- raced double-use loses), create the device, return the PLAINTEXT token
-- exactly once. Store/device codes from the till are cached on the device
-- row (D-07).
create or replace function pos_complete_pairing(
  p_code_hash text, p_installation_id text, p_device jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  c pos_pairing_codes%rowtype;
  v_token text;
  v_device_id uuid;
begin
  select * into c from pos_pairing_codes
   where code_hash = p_code_hash for update;
  if not found or c.used_at is not null or c.expires_at < now() then
    return null;   -- caller answers 400, one coarse message for all three
  end if;

  v_token := translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');
  insert into pos_devices (store_id, store_name, installation_id, device_name,
    device_code, store_code, app_version, schema_version, token_hash)
  values (c.store_id, c.store_name,
    coalesce(nullif(trim(p_installation_id), ''), 'unknown'),
    coalesce(nullif(trim(p_device->>'deviceName'), ''), c.device_label),
    coalesce(nullif(trim(p_device->>'deviceCode'), ''), 'TILL'),
    coalesce(nullif(trim(p_device->>'storeCode'), ''), c.store_id),
    p_device->>'appVersion',
    nullif(p_device->>'schemaVersion', '')::integer,
    encode(digest(v_token, 'sha256'), 'hex'))
  returning id into v_device_id;

  update pos_pairing_codes
     set used_at = now(), used_by_device = v_device_id
   where id = c.id;

  return jsonb_build_object(
    'deviceId', v_device_id, 'deviceToken', v_token,
    'store', jsonb_build_object('id', c.store_id, 'name', c.store_name));
end;
$$;

-- Forbidden-field defence (contract §2): any KEY matching pin|password|secret
-- at ANY depth rejects the event. Case-insensitive.
create or replace function pos_payload_has_forbidden_key(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  k text;
  v jsonb;
begin
  if p is null then return false; end if;
  if jsonb_typeof(p) = 'object' then
    for k, v in select * from jsonb_each(p) loop
      if k ~* 'pin|password|secret' then return true; end if;
      if pos_payload_has_forbidden_key(v) then return true; end if;
    end loop;
  elsif jsonb_typeof(p) = 'array' then
    for v in select * from jsonb_array_elements(p) loop
      if pos_payload_has_forbidden_key(v) then return true; end if;
    end loop;
  end if;
  return false;
end;
$$;

-- Integer-pence extraction: a money field must be a JSON number with an
-- integral, non-negative value. Anything else raises invalid_money.
create or replace function pos_pence(p jsonb, p_path text[], p_required boolean default true)
returns bigint
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v jsonb := p #> p_path;
  n numeric;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    if p_required then
      raise exception using errcode = 'P0001',
        message = 'MPREJ:invalid_money:' || array_to_string(p_path, '.') || ' missing';
    end if;
    return null;
  end if;
  if jsonb_typeof(v) <> 'number' then
    raise exception using errcode = 'P0001',
      message = 'MPREJ:invalid_money:' || array_to_string(p_path, '.') || ' not a number';
  end if;
  n := (v #>> '{}')::numeric;
  if n <> trunc(n) or n < 0 then
    raise exception using errcode = 'P0001',
      message = 'MPREJ:invalid_money:' || array_to_string(p_path, '.') || ' must be a non-negative integer';
  end if;
  return n::bigint;
end;
$$;

create or replace function pos_text(p jsonb, p_path text[], p_field text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v text := p #>> p_path;
begin
  if v is null or trim(v) = '' then
    raise exception using errcode = 'P0001',
      message = 'MPREJ:malformed_payload:' || p_field || ' missing';
  end if;
  return v;
end;
$$;

create or replace function pos_ts(p jsonb, p_path text[], p_field text)
returns timestamptz
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  return (pos_text(p, p_path, p_field))::timestamptz;
exception when others then
  raise exception using errcode = 'P0001',
    message = 'MPREJ:malformed_payload:' || p_field || ' is not a timestamp';
end;
$$;

-- Embedded approval snapshot → pos_approvals (idempotent by id).
create or replace function pos_apply_approval(
  p_device_id uuid, p_store_id text, p jsonb
)
returns void
language plpgsql
volatile
set search_path = public, pg_temp
as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then return; end if;
  insert into pos_approvals (id, device_id, store_id, action_type, entity_type,
    entity_id, approver_user_id, approver_name, requested_by_user_id,
    requested_by_name, reason, occurred_at)
  values (
    pos_text(p, '{id}', 'approval.id'),
    p_device_id, p_store_id,
    pos_text(p, '{actionType}', 'approval.actionType'),
    pos_text(p, '{entityType}', 'approval.entityType'),
    pos_text(p, '{entityId}', 'approval.entityId'),
    p ->> 'approverUserId', p ->> 'approverName',
    p ->> 'requestedByUserId', p ->> 'requestedByName',
    p ->> 'reason',
    pos_ts(p, '{createdAt}', 'approval.createdAt'))
  on conflict (id) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. THE ingest: one call = one transaction; one savepoint per event
-- ---------------------------------------------------------------------------
--
-- Rejection reasons are raised as 'MPREJ:<reason>:<detail>' and caught by the
-- per-event handler; anything else becomes malformed_payload with the SQL
-- error as detail. The ack ∪ reject partition covers every event exactly
-- once — the Edge Function (and the till) both verify it independently.

create or replace function pos_ingest_batch(p_device_id uuid, p_events jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  d pos_devices%rowtype;
  ev jsonb;
  v_id text;
  v_type text;
  v_entity text;
  v_created timestamptz;
  v_payload jsonb;
  v_hash text;
  v_existing record;
  v_paid bigint;
  v_refunded bigint;
  v_order record;
  it jsonb;
  m jsonb;
  acked jsonb := '[]'::jsonb;
  rejected jsonb := '[]'::jsonb;
  rejections jsonb := '[]'::jsonb;
  v_reason text;
  v_detail text;
  msg text;
  v_catalog integer := 0;
begin
  select * into d from pos_devices where id = p_device_id;
  if not found or d.revoked then
    raise exception 'pos_ingest_batch called for an unknown or revoked device';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'pos_ingest_batch expects a JSON array of events';
  end if;

  for ev in select * from jsonb_array_elements(p_events) loop
    begin  -- ============ one savepoint per event ============
      v_id := pos_text(ev, '{id}', 'id');
      v_type := pos_text(ev, '{eventType}', 'eventType');
      v_entity := pos_text(ev, '{entityId}', 'entityId');
      v_created := pos_ts(ev, '{createdAt}', 'createdAt');
      v_payload := ev -> 'payload';
      if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
        raise exception using errcode = 'P0001', message = 'MPREJ:malformed_payload:payload must be an object';
      end if;
      if pos_payload_has_forbidden_key(v_payload) then
        raise exception using errcode = 'P0001', message = 'MPREJ:forbidden_field:payload contains a forbidden key';
      end if;
      v_hash := encode(digest(v_payload::text, 'sha256'), 'hex');

      -- Idempotency gate. jsonb normalizes key order, so byte-identical
      -- semantics hash identically regardless of client key ordering.
      select event_id, device_id, payload_hash into v_existing
        from pos_events where event_id = v_id;
      if found then
        if v_existing.device_id <> p_device_id then
          raise exception using errcode = 'P0001', message = 'MPREJ:device_scope_violation:event id belongs to another device';
        elsif v_existing.payload_hash = v_hash then
          acked := acked || to_jsonb(v_id);   -- true duplicate: converge
          continue;
        else
          raise exception using errcode = 'P0001', message = 'MPREJ:duplicate_conflict:same event id, different payload';
        end if;
      end if;

      insert into pos_events (event_id, device_id, event_type, entity_id, payload, payload_hash, device_created_at)
      values (v_id, p_device_id, v_type, v_entity, v_payload, v_hash, v_created);

      case v_type
        when 'order_created' then
          if (v_payload #>> '{order,storeCode}') is distinct from d.store_code
             or (v_payload #>> '{order,deviceCode}') is distinct from d.device_code then
            raise exception using errcode = 'P0001', message = 'MPREJ:device_scope_violation:order store/device code does not match this device';
          end if;
          insert into pos_orders (id, device_id, store_id, client_reference,
            visible_order_number, order_sequence, store_code, device_code, status,
            subtotal_pence, discount_pence, vat_pence, total_pence, applied_deals,
            payment_method, cash_received_pence, change_given_pence,
            manual_card_confirmation, shift_id, sold_by_user_id, sold_by_name,
            occurred_at, completed_at)
          values (
            pos_text(v_payload, '{order,id}', 'order.id'),
            p_device_id, d.store_id,
            pos_text(v_payload, '{order,clientReference}', 'order.clientReference'),
            pos_text(v_payload, '{order,visibleOrderNumber}', 'order.visibleOrderNumber'),
            nullif(v_payload #>> '{order,orderSequence}', '')::bigint,
            d.store_code, d.device_code, 'completed',
            pos_pence(v_payload, '{order,subtotalPence}'),
            pos_pence(v_payload, '{order,discountPence}'),
            pos_pence(v_payload, '{order,vatPence}'),
            pos_pence(v_payload, '{order,totalPence}'),
            coalesce(v_payload #> '{order,appliedDeals}', '[]'::jsonb),
            pos_text(v_payload, '{order,paymentMethod}', 'order.paymentMethod'),
            pos_pence(v_payload, '{order,cashReceivedPence}', false),
            pos_pence(v_payload, '{order,changeGivenPence}', false),
            coalesce((v_payload #>> '{order,manualCardConfirmation}')::boolean, false),
            v_payload #>> '{order,shiftId}',
            v_payload #>> '{order,soldByUserId}', v_payload #>> '{order,soldByName}',
            pos_ts(v_payload, '{order,createdAt}', 'order.createdAt'),
            pos_ts(v_payload, '{order,completedAt}', 'order.completedAt'));
          for it in select * from jsonb_array_elements(coalesce(v_payload -> 'items', '[]'::jsonb)) loop
            insert into pos_order_items (id, order_id, product_id, name, category,
              size, quantity, unit_price_pence, line_total_pence,
              discount_allocation_pence, vat_rate_bp, vat_pence)
            values (
              pos_text(it, '{id}', 'item.id'),
              pos_text(v_payload, '{order,id}', 'order.id'),
              pos_text(it, '{productId}', 'item.productId'),
              pos_text(it, '{name}', 'item.name'),
              coalesce(it ->> 'category', ''),
              pos_text(it, '{size}', 'item.size'),
              (pos_pence(it, '{quantity}'))::integer,
              pos_pence(it, '{unitPricePence}'),
              pos_pence(it, '{lineTotalPence}'),
              coalesce(pos_pence(it, '{discountAllocationPence}', false), 0),
              (pos_pence(it, '{vatRateBp}'))::integer,
              pos_pence(it, '{vatPence}'));
            for m in select * from jsonb_array_elements(coalesce(it -> 'modifiers', '[]'::jsonb)) loop
              insert into pos_order_item_modifiers (id, order_item_id, modifier_id, name, price_pence)
              values (pos_text(m, '{id}', 'modifier.id'), pos_text(it, '{id}', 'item.id'),
                pos_text(m, '{modifierId}', 'modifier.modifierId'),
                pos_text(m, '{name}', 'modifier.name'),
                pos_pence(m, '{pricePence}'));
            end loop;
          end loop;

        when 'shift_opened' then
          insert into pos_shifts (id, device_id, store_id, status, opened_at,
            opened_by_user_id, opened_by_name, opening_cash_pence)
          values (
            pos_text(v_payload, '{shift,id}', 'shift.id'), p_device_id, d.store_id, 'open',
            pos_ts(v_payload, '{shift,openedAt}', 'shift.openedAt'),
            v_payload #>> '{shift,openedByUserId}', v_payload #>> '{shift,openedByName}',
            pos_pence(v_payload, '{shift,openingCashPence}'))
          on conflict (id) do nothing;   -- close may have converged it first

        when 'shift_closed' then
          -- Converges whether or not shift_opened arrived: the close payload
          -- carries the whole shift.
          insert into pos_shifts (id, device_id, store_id, status, opened_at,
            opened_by_user_id, opened_by_name, opening_cash_pence,
            closed_at, closed_by_user_id, closed_by_name,
            counted_cash_pence, reported_card_pence, expected_cash_pence,
            cash_variance_pence, expected_card_pence, card_variance_pence,
            variance_reason, closing_note, close_summary)
          values (
            pos_text(v_payload, '{shift,id}', 'shift.id'), p_device_id, d.store_id, 'closed',
            pos_ts(v_payload, '{shift,openedAt}', 'shift.openedAt'),
            v_payload #>> '{shift,openedByUserId}', v_payload #>> '{shift,openedByName}',
            pos_pence(v_payload, '{shift,openingCashPence}'),
            pos_ts(v_payload, '{shift,closedAt}', 'shift.closedAt'),
            v_payload #>> '{shift,closedByUserId}', v_payload #>> '{shift,closedByName}',
            pos_pence(v_payload, '{shift,countedCashPence}'),
            pos_pence(v_payload, '{shift,reportedCardPence}'),
            (v_payload #>> '{shift,expectedCashPence}')::bigint,
            (v_payload #>> '{shift,cashVariancePence}')::bigint,
            (v_payload #>> '{shift,expectedCardPence}')::bigint,
            (v_payload #>> '{shift,cardVariancePence}')::bigint,
            v_payload #>> '{shift,varianceReason}', v_payload #>> '{shift,closingNote}',
            v_payload -> 'summary')
          on conflict (id) do update set
            status = 'closed',
            closed_at = excluded.closed_at,
            closed_by_user_id = excluded.closed_by_user_id,
            closed_by_name = excluded.closed_by_name,
            counted_cash_pence = excluded.counted_cash_pence,
            reported_card_pence = excluded.reported_card_pence,
            expected_cash_pence = excluded.expected_cash_pence,
            cash_variance_pence = excluded.cash_variance_pence,
            expected_card_pence = excluded.expected_card_pence,
            card_variance_pence = excluded.card_variance_pence,
            variance_reason = excluded.variance_reason,
            closing_note = excluded.closing_note,
            close_summary = excluded.close_summary
          where pos_shifts.status = 'open';   -- a CLOSED cloud shift is immutable
          perform pos_apply_approval(p_device_id, d.store_id, v_payload -> 'approval');

        when 'cash_movement_recorded' then
          insert into pos_cash_movements (id, device_id, store_id, shift_id,
            direction, amount_pence, reason, user_id, user_name,
            approved_by_user_id, approved_by_name, occurred_at)
          values (
            pos_text(v_payload, '{movement,id}', 'movement.id'), p_device_id, d.store_id,
            pos_text(v_payload, '{movement,shiftId}', 'movement.shiftId'),
            pos_text(v_payload, '{movement,direction}', 'movement.direction'),
            pos_pence(v_payload, '{movement,amountPence}'),
            pos_text(v_payload, '{movement,reason}', 'movement.reason'),
            v_payload #>> '{movement,userId}', v_payload #>> '{movement,userName}',
            v_payload #>> '{movement,approvedByUserId}', v_payload #>> '{movement,approvedByName}',
            pos_ts(v_payload, '{movement,createdAt}', 'movement.createdAt'));
          perform pos_apply_approval(p_device_id, d.store_id, v_payload -> 'approval');

        when 'refund_created' then
          select id, device_id, total_pence into v_order
            from pos_orders
           where id = pos_text(v_payload, '{refund,orderId}', 'refund.orderId')
           for update;                        -- refund-cap race lock (amendment)
          if not found then
            raise exception using errcode = 'P0001', message = 'MPREJ:malformed_payload:refund references an order the server has not received';
          end if;
          if v_order.device_id <> p_device_id then
            raise exception using errcode = 'P0001', message = 'MPREJ:device_scope_violation:refund references another device''s order';
          end if;
          v_paid := v_order.total_pence;
          select coalesce(sum(amount_pence), 0) into v_refunded
            from pos_refunds where order_id = v_order.id;
          if v_refunded + pos_pence(v_payload, '{refund,amountPence}') > v_paid then
            raise exception using errcode = 'P0001', message = 'MPREJ:invalid_money:refunds would exceed the amount paid';
          end if;
          insert into pos_refunds (id, device_id, store_id, order_id, shift_id,
            kind, method, amount_pence, reason, user_id, user_name,
            approved_by_user_id, approved_by_name, card_terminal_confirmed, occurred_at)
          values (
            pos_text(v_payload, '{refund,id}', 'refund.id'), p_device_id, d.store_id,
            v_order.id,
            pos_text(v_payload, '{refund,shiftId}', 'refund.shiftId'),
            pos_text(v_payload, '{refund,kind}', 'refund.kind'),
            pos_text(v_payload, '{refund,method}', 'refund.method'),
            pos_pence(v_payload, '{refund,amountPence}'),
            pos_text(v_payload, '{refund,reason}', 'refund.reason'),
            v_payload #>> '{refund,userId}', v_payload #>> '{refund,userName}',
            v_payload #>> '{refund,approvedByUserId}', v_payload #>> '{refund,approvedByName}',
            coalesce((v_payload #>> '{refund,cardTerminalConfirmed}')::boolean, false),
            pos_ts(v_payload, '{refund,createdAt}', 'refund.createdAt'));
          for it in select * from jsonb_array_elements(coalesce(v_payload -> 'items', '[]'::jsonb)) loop
            insert into pos_refund_items (id, refund_id, order_item_id, name, size, quantity, amount_pence)
            values (pos_text(it, '{id}', 'refundItem.id'),
              pos_text(v_payload, '{refund,id}', 'refund.id'),
              pos_text(it, '{orderItemId}', 'refundItem.orderItemId'),
              it ->> 'name', it ->> 'size',
              (pos_pence(it, '{quantity}'))::integer,
              pos_pence(it, '{amountPence}'));
          end loop;
          perform pos_apply_approval(p_device_id, d.store_id, v_payload -> 'approval');

        when 'void_created' then
          select id, device_id, total_pence into v_order
            from pos_orders
           where id = pos_text(v_payload, '{void,orderId}', 'void.orderId');
          if not found then
            raise exception using errcode = 'P0001', message = 'MPREJ:malformed_payload:void references an order the server has not received';
          end if;
          if v_order.device_id <> p_device_id then
            raise exception using errcode = 'P0001', message = 'MPREJ:device_scope_violation:void references another device''s order';
          end if;
          insert into pos_voids (id, device_id, store_id, order_id, shift_id,
            order_total_pence, method, card_terminal_confirmed, reason,
            user_id, user_name, approved_by_user_id, approved_by_name, occurred_at)
          values (
            pos_text(v_payload, '{void,id}', 'void.id'), p_device_id, d.store_id,
            v_order.id,
            pos_text(v_payload, '{void,shiftId}', 'void.shiftId'),
            coalesce(pos_pence(v_payload, '{void,orderTotalPence}', false), v_order.total_pence),
            pos_text(v_payload, '{void,method}', 'void.method'),
            coalesce((v_payload #>> '{void,cardTerminalConfirmed}')::boolean, false),
            pos_text(v_payload, '{void,reason}', 'void.reason'),
            v_payload #>> '{void,userId}', v_payload #>> '{void,userName}',
            v_payload #>> '{void,approvedByUserId}', v_payload #>> '{void,approvedByName}',
            pos_ts(v_payload, '{void,createdAt}', 'void.createdAt'));
          perform pos_apply_approval(p_device_id, d.store_id, v_payload -> 'approval');

        when 'correction_created' then
          insert into pos_corrections (id, device_id, store_id, order_id, shift_id,
            kind, before_payload, after_payload, reason, user_id, user_name,
            approved_by_user_id, approved_by_name, occurred_at)
          values (
            pos_text(v_payload, '{correction,id}', 'correction.id'), p_device_id, d.store_id,
            nullif(v_payload #>> '{correction,orderId}', ''),
            pos_text(v_payload, '{correction,shiftId}', 'correction.shiftId'),
            pos_text(v_payload, '{correction,kind}', 'correction.kind'),
            coalesce(v_payload #> '{correction,before}', '{}'::jsonb),
            coalesce(v_payload #> '{correction,after}', '{}'::jsonb),
            pos_text(v_payload, '{correction,reason}', 'correction.reason'),
            v_payload #>> '{correction,userId}', v_payload #>> '{correction,userName}',
            v_payload #>> '{correction,approvedByUserId}', v_payload #>> '{correction,approvedByName}',
            pos_ts(v_payload, '{correction,createdAt}', 'correction.createdAt'));
          perform pos_apply_approval(p_device_id, d.store_id, v_payload -> 'approval');

        when 'user_created', 'user_updated', 'user_deactivated',
             'user_reactivated', 'pin_reset', 'settings_changed' then
          insert into pos_audit_events (event_id, device_id, store_id, event_type,
            entity_id, payload, occurred_at)
          values (v_id, p_device_id, d.store_id, v_type, v_entity, v_payload, v_created);

        else
          raise exception using errcode = 'P0001', message = 'MPREJ:unknown_event_type:' || v_type;
      end case;

      acked := acked || to_jsonb(v_id);

    exception when others then
      msg := sqlerrm;
      if msg like 'MPREJ:%' then
        v_reason := split_part(msg, ':', 2);
        v_detail := substr(msg, length('MPREJ:' || v_reason || ':') + 1);
      else
        v_reason := 'malformed_payload';
        v_detail := left(msg, 200);
      end if;
      -- The event id may itself have been unreadable.
      if v_id is null or v_id = '' then v_id := coalesce(ev #>> '{id}', '?'); end if;
      rejected := rejected || to_jsonb(v_id);
      rejections := rejections || jsonb_build_object('id', v_id, 'reason', v_reason, 'detail', v_detail);
    end;
    v_id := null;   -- never bleed into the next event's error path
  end loop;

  update pos_devices set last_sync_at = now() where id = p_device_id;

  -- Gate 9: advertise the newest published catalogue version so tills can
  -- pull on drift. Guarded so this migration still runs standalone before
  -- migration_pos_catalog.sql exists.
  if to_regclass('public.pos_catalog') is not null then
    execute 'select coalesce(max(version), 0) from pos_catalog' into v_catalog;
  end if;

  return jsonb_build_object(
    'acknowledgedIds', acked,
    'rejectedIds', rejected,
    'rejections', rejections,
    'catalogVersion', v_catalog);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Function grants. Supabase's default privileges grant EXECUTE on new
--    functions to anon, authenticated and the service role — so the job here
--    is REVOCATION. The Edge Functions call the ingest/auth/pairing RPCs with
--    the service key, which keeps its execute via those defaults; browsers
--    keep only the three Owner RPCs (each of which re-checks is_owner()
--    itself). The internal helpers are unreachable from any API role.
-- ---------------------------------------------------------------------------

do $$
declare fn text;
begin
  foreach fn in array array[
    'pos_random_code(integer)',
    'pos_authenticate_device(text)',
    'pos_complete_pairing(text, text, jsonb)',
    'pos_ingest_batch(uuid, jsonb)',
    'pos_payload_has_forbidden_key(jsonb)',
    'pos_pence(jsonb, text[], boolean)',
    'pos_text(jsonb, text[], text)',
    'pos_ts(jsonb, text[], text)',
    'pos_apply_approval(uuid, text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
  end loop;
end $$;

revoke all on function create_pos_pairing_code(text, text, text) from public, anon;
revoke all on function revoke_pos_device(uuid)                   from public, anon;
revoke all on function rotate_pos_device_token(uuid)             from public, anon;
grant execute on function create_pos_pairing_code(text, text, text) to authenticated;
grant execute on function revoke_pos_device(uuid)                   to authenticated;
grant execute on function rotate_pos_device_token(uuid)             to authenticated;
