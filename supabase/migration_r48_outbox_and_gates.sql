-- ============================================================================
--  MILK POP — R4.8 LAUNCH CLOSURE 2/4: durable notifications & launch gates
--  (Workstream C notification outbox · F launch settings, privacy versioning,
--   publication gates · commissioning gate consumed by submit_public_form v3)
--
--  Append-only. submit_public_form is REPLACED here (same 5-arg wire
--  signature the WP-02.1 contract pins — the Edge Function caller is
--  untouched) with three additions, all inside the SAME transaction:
--    1. an owner-notification outbox event per accepted submission,
--    2. the current privacy-notice version stamped onto the stored row,
--    3. a fail-closed commissioning gate (enforce_public_gates).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. LAUNCH SETTINGS (F1) — one owner-managed row of mandatory launch facts.
--    Values are NEVER seeded with invented business identity: everything
--    defaults empty and the readiness panel reports each gap honestly.
-- ----------------------------------------------------------------------------
create table if not exists launch_settings (
  id                       boolean primary key default true check (id), -- singleton
  legal_business_name      text not null default '',
  company_number           text not null default '',
  registered_address       text not null default '',
  public_contact_email     text not null default '',
  privacy_contact_email    text not null default '',
  public_telephone         text not null default '',
  telephone_alternative_ok boolean not null default false,
  canonical_url            text not null default '',
  receipt_identity_footer  text not null default '',
  vat_state_confirmed      boolean not null default false,
  notification_recipient   text not null default '',   -- server-resolved outbox target
  customer_ack_enabled     boolean not null default false,
  enforce_public_gates     boolean not null default false, -- set true at commissioning
  updated_at               timestamptz not null default now(),
  updated_by               text not null default ''
);
insert into launch_settings (id) values (true) on conflict (id) do nothing;

alter table launch_settings enable row level security;
drop policy if exists launch_settings_owner_all on launch_settings;
create policy launch_settings_owner_all on launch_settings
  for all to authenticated using (is_owner()) with check (is_owner());

-- ----------------------------------------------------------------------------
-- 2. PRIVACY NOTICE VERSIONS (F4) — the text shown at each collection point,
--    versioned; submissions record the version in force when collected.
--    Acknowledgement wording, not a consent checkbox, for non-consent bases.
-- ----------------------------------------------------------------------------
create table if not exists privacy_notice_versions (
  id            text primary key default gen_random_uuid()::text,
  audience      text not null check (audience in ('careers','franchise','contact','staff')),
  version_label text not null,
  notice_text   text not null,
  policy_url    text not null default '',
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (audience, version_label)
);
alter table privacy_notice_versions enable row level security;
drop policy if exists privacy_public_read on privacy_notice_versions;
create policy privacy_public_read on privacy_notice_versions
  for select to anon, authenticated using (published_at is not null);
drop policy if exists privacy_owner_all on privacy_notice_versions;
create policy privacy_owner_all on privacy_notice_versions
  for all to authenticated using (is_owner()) with check (is_owner());

create or replace function current_privacy_version(p_audience text)
returns text
language sql stable
set search_path = public, pg_temp
as $$
  select version_label from privacy_notice_versions
   where audience = p_audience and published_at is not null
   order by published_at desc limit 1;
$$;

alter table job_applications   add column if not exists notice_version text;
alter table franchise_inquiries add column if not exists notice_version text;
alter table contact_messages    add column if not exists notice_version text;
alter table job_applications    add column if not exists marketing_opt_in boolean not null default false;

-- ----------------------------------------------------------------------------
-- 3. NOTIFICATION OUTBOX (C1) — durable, server-owned. The browser can never
--    write a row or choose a recipient: rows are created only inside
--    submit_public_form (service-role) and claimed only by the dispatch
--    worker (service-role). Owners get read + manual-retry.
-- ----------------------------------------------------------------------------
create table if not exists notification_outbox (
  id                  text primary key default gen_random_uuid()::text,
  event_type          text not null,            -- e.g. public_form.careers
  entity_type         text not null,
  entity_id           text not null,
  recipient_kind      text not null check (recipient_kind in
                        ('owner_notification','customer_ack')),
  template_id         text not null,
  payload             jsonb not null default '{}'::jsonb,
  status              text not null default 'pending' check (status in
                        ('pending','processing','delivered','retry','failed','dead_letter','blocked_config')),
  attempt_count       int not null default 0,
  next_attempt_at     timestamptz not null default now(),
  last_attempt_at     timestamptz,
  provider_message_id text,
  last_error_code     text,
  last_error_message  text,
  created_at          timestamptz not null default now(),
  delivered_at        timestamptz,
  dead_lettered_at    timestamptz
);
create index if not exists idx_outbox_claim on notification_outbox (status, next_attempt_at);
create index if not exists idx_outbox_entity on notification_outbox (entity_type, entity_id);

alter table notification_outbox enable row level security;
drop policy if exists outbox_owner_read on notification_outbox;
create policy outbox_owner_read on notification_outbox
  for select to authenticated using (is_owner());
-- no insert/update/delete policies: service-role and the RPCs below only.

-- Concurrency-safe claim: two workers can never take the same job
-- (FOR UPDATE SKIP LOCKED), and a claimed job is visibly 'processing'.
create or replace function outbox_claim_batch(p_limit int default 10)
returns setof notification_outbox
language sql security definer
set search_path = public, pg_temp
as $$
  with claimable as (
    select id from notification_outbox
     where status in ('pending','retry') and next_attempt_at <= now()
     order by next_attempt_at
     for update skip locked
     limit greatest(1, least(p_limit, 50)))
  update notification_outbox o
     set status = 'processing', last_attempt_at = now(),
         attempt_count = o.attempt_count + 1
    from claimable c where o.id = c.id
  returning o.*;
$$;

-- Worker verdicts. Bounded retries with exponential backoff; permanent
-- failures and exhausted retries land in dead_letter, never silently vanish.
create or replace function outbox_mark(
  p_id text, p_outcome text, p_provider_id text, p_code text, p_message text
) returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_attempts int; v_max constant int := 6;
begin
  select attempt_count into v_attempts from notification_outbox where id = p_id;
  if not found then return; end if;
  if p_outcome = 'delivered' then
    update notification_outbox
       set status='delivered', delivered_at=now(), provider_message_id=p_provider_id,
           last_error_code=null, last_error_message=null
     where id = p_id;
  elsif p_outcome = 'blocked_config' then
    update notification_outbox
       set status='blocked_config', last_error_code=coalesce(p_code,'provider_unconfigured'),
           last_error_message=coalesce(p_message,'e-mail provider not configured')
     where id = p_id;
  elsif p_outcome = 'permanent' or v_attempts >= v_max then
    update notification_outbox
       set status='dead_letter', dead_lettered_at=now(),
           last_error_code=p_code, last_error_message=p_message
     where id = p_id;
  else
    update notification_outbox
       set status='retry',
           next_attempt_at = now() + (interval '1 minute' * power(2, least(v_attempts, 8))),
           last_error_code=p_code, last_error_message=p_message
     where id = p_id;
  end if;
end $$;

-- Owner-only manual retry from the Notification Health panel.
create or replace function outbox_retry_now(p_id text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not is_owner() then raise exception 'not_permitted'; end if;
  update notification_outbox
     set status='retry', next_attempt_at=now(), dead_lettered_at=null
   where id = p_id and status in ('failed','dead_letter','retry','blocked_config');
  if not found then return jsonb_build_object('ok', false, 'error', 'not_retryable'); end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function outbox_claim_batch(int) from public, anon, authenticated;
revoke all on function outbox_mark(text,text,text,text,text) from public, anon, authenticated;
revoke all on function outbox_retry_now(text) from public, anon;
grant execute on function outbox_retry_now(text) to authenticated;

-- ----------------------------------------------------------------------------
-- 4. STORE OPEN GATE (F3) — a store cannot flip to 'open' while mandatory
--    launch facts are missing. Existing rows keep their state; only the
--    TRANSITION to open is gated, so historic data never breaks an upgrade.
-- ----------------------------------------------------------------------------
create or replace function assert_store_open_allowed()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare ls launch_settings; v_missing text[] := '{}';
begin
  if new.status = 'open' and (old.status is distinct from 'open') then
    select * into ls from launch_settings where id;
    if coalesce(ls.legal_business_name,'') = '' then v_missing := v_missing || 'legal_business_name'; end if;
    if coalesce(ls.registered_address,'')  = '' then v_missing := v_missing || 'registered_address'; end if;
    if coalesce(ls.public_contact_email,'') = '' then v_missing := v_missing || 'public_contact_email'; end if;
    if coalesce(ls.privacy_contact_email,'') = '' then v_missing := v_missing || 'privacy_contact_email'; end if;
    if coalesce(ls.public_telephone,'') = '' and not ls.telephone_alternative_ok then v_missing := v_missing || 'public_telephone'; end if;
    if not ls.vat_state_confirmed then v_missing := v_missing || 'vat_state_confirmed'; end if;
    if coalesce(trim(new.address),'') = '' then v_missing := v_missing || 'store_address'; end if;
    if coalesce(trim(new.opening_hours),'') = '' then v_missing := v_missing || 'opening_hours'; end if;
    if array_length(v_missing,1) is not null then
      raise exception 'store_open_blocked: missing %', array_to_string(v_missing, ', ');
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_store_open_gate on stores;
create trigger trg_store_open_gate
  before insert or update of status on stores
  for each row execute function assert_store_open_allowed();

-- (Section 5, launch_readiness(), moved to migration_r48_allergens.sql — it
--  reads product_allergen_declarations, which is created there.)

-- ----------------------------------------------------------------------------
-- 6. submit_public_form v3 — WP-02.1 behaviour preserved verbatim (same
--    signature, same idempotency, hash-conflict, advisory-lock rate limit,
--    same log rows) PLUS commissioning gate + notice stamping + atomic
--    outbox enqueue. Replay of a keyed duplicate returns the ORIGINAL row and
--    enqueues NOTHING (the outbox insert sits after the duplicate return),
--    so one accepted submission ⇒ exactly one owner event, ever.
-- ----------------------------------------------------------------------------
create or replace function public.submit_public_form(
  p_kind             text,
  p_row              jsonb,
  p_idempotency_key  uuid,
  p_request_hash     text,
  p_ip_hash          text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rate_limit constant int := 8;
  v_recent   int;
  v_id       text;
  v_existing text;
  v_hash     text;
  v_gates    launch_settings;
  v_notice   text;
begin
  if p_kind not in ('careers','franchise','contact') then
    raise exception 'unknown_form_kind';
  end if;
  if p_ip_hash is null or length(p_ip_hash) <> 64 then
    raise exception 'bad_ip_hash';
  end if;
  if p_idempotency_key is not null and (p_request_hash is null or length(p_request_hash) <> 64) then
    raise exception 'bad_request_hash';
  end if;

  -- R4.8 commissioning gate (F3): once armed, forms fail closed when the
  -- launch prerequisites are missing — typed error, honest UI state.
  select * into v_gates from launch_settings where id;
  v_notice := current_privacy_version(p_kind);
  if coalesce(v_gates.enforce_public_gates, false) then
    if coalesce(v_gates.notification_recipient,'') = '' or v_notice is null then
      insert into form_submission_log (ip_hash, form_kind, status, reject_reason)
      values (p_ip_hash, p_kind, 'rejected', 'forms_not_commissioned');
      return jsonb_build_object('ok', false, 'error', 'forms_not_commissioned');
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('milkpop_public_form:' || p_ip_hash, 0));

  if p_idempotency_key is not null then
    if p_kind = 'careers' then
      select id, request_hash into v_existing, v_hash from job_applications   where idempotency_key = p_idempotency_key;
    elsif p_kind = 'franchise' then
      select id, request_hash into v_existing, v_hash from franchise_inquiries where idempotency_key = p_idempotency_key;
    else
      select id, request_hash into v_existing, v_hash from contact_messages   where idempotency_key = p_idempotency_key;
    end if;
    if v_existing is not null then
      if v_hash is not null and v_hash <> p_request_hash then
        insert into form_submission_log (ip_hash, form_kind, status, reject_reason)
        values (p_ip_hash, p_kind, 'rejected', 'idempotency_conflict');
        return jsonb_build_object('ok', false, 'error', 'idempotency_conflict');
      end if;
      insert into form_submission_log (ip_hash, form_kind, status, reject_reason)
      values (p_ip_hash, p_kind, 'rejected', 'duplicate_replay');
      return jsonb_build_object('ok', true, 'submission_id', v_existing, 'duplicate', true);
    end if;
  end if;

  select count(*) into v_recent
    from form_submission_log
   where ip_hash = p_ip_hash
     and status = 'accepted'
     and created_at >= now() - interval '1 hour';
  if v_recent >= v_rate_limit then
    insert into form_submission_log (ip_hash, form_kind, status, reject_reason)
    values (p_ip_hash, p_kind, 'rejected', 'rate_limited');
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  v_id := gen_random_uuid()::text;

  if p_kind = 'careers' then
    if coalesce(trim(p_row->>'full_name'),'') = '' or coalesce(trim(p_row->>'email'),'') = ''
       or coalesce(trim(p_row->>'phone'),'') = '' then
      raise exception 'missing_required_field';
    end if;
    insert into job_applications
      (id, full_name, email, phone, applied_for, applied_store, availability, experience, message,
       status, applied_at, idempotency_key, request_hash, notice_version, marketing_opt_in)
    values
      (v_id,
       trim(p_row->>'full_name'), lower(trim(p_row->>'email')), trim(p_row->>'phone'),
       coalesce(trim(p_row->>'applied_for'),''),  coalesce(trim(p_row->>'applied_store'),''),
       coalesce(trim(p_row->>'availability'),''), coalesce(trim(p_row->>'experience'),''),
       coalesce(trim(p_row->>'message'),''),
       'pending', now(), p_idempotency_key, p_request_hash, v_notice,
       coalesce((p_row->>'marketing_opt_in')::boolean, false));

  elsif p_kind = 'franchise' then
    if coalesce(trim(p_row->>'full_name'),'') = '' or coalesce(trim(p_row->>'email'),'') = ''
       or coalesce(trim(p_row->>'city'),'') = '' then
      raise exception 'missing_required_field';
    end if;
    if coalesce(p_row->>'budget','') not in
       ('£50,000 - £100,000','£100,000 - £150,000','£150,000 - £300,000','£300,000+') then
      raise exception 'invalid_option';
    end if;
    if coalesce(p_row->>'experience','') not in
       ('Yes, multi-site retail','Single coffee unit','Corporate background') then
      raise exception 'invalid_option';
    end if;
    insert into franchise_inquiries
      (id, full_name, email, phone, country, city, budget, experience, message,
       status, submitted_at, idempotency_key, request_hash, notice_version)
    values
      (v_id,
       trim(p_row->>'full_name'), lower(trim(p_row->>'email')), coalesce(trim(p_row->>'phone'),''),
       coalesce(trim(p_row->>'country'),''), trim(p_row->>'city'),
       p_row->>'budget', p_row->>'experience', coalesce(trim(p_row->>'message'),''),
       'pending', now(), p_idempotency_key, p_request_hash, v_notice);

  else -- contact
    if coalesce(trim(p_row->>'full_name'),'') = '' or coalesce(trim(p_row->>'email'),'') = ''
       or coalesce(trim(p_row->>'message'),'') = '' then
      raise exception 'missing_required_field';
    end if;
    if coalesce(p_row->>'reason','') not in
       ('General feedback','Career queries','Partnerships','Other') then
      raise exception 'invalid_option';
    end if;
    insert into contact_messages
      (id, full_name, email, reason, message, submitted_at, idempotency_key, request_hash, notice_version)
    values
      (v_id,
       trim(p_row->>'full_name'), lower(trim(p_row->>'email')),
       p_row->>'reason', trim(p_row->>'message'),
       now(), p_idempotency_key, p_request_hash, v_notice);
  end if;

  insert into form_submission_log (ip_hash, form_kind, status)
  values (p_ip_hash, p_kind, 'accepted');

  -- R4.8 C2: durable owner notification — SAME transaction as the insert.
  -- Recipient is a KIND, resolved server-side at dispatch from
  -- launch_settings.notification_recipient; the browser payload never
  -- chooses an address.
  insert into notification_outbox (event_type, entity_type, entity_id, recipient_kind, template_id, payload)
  values ('public_form.' || p_kind, p_kind, v_id, 'owner_notification',
          'owner-form-notice',
          jsonb_build_object('kind', p_kind, 'submission_id', v_id,
                             'summary', left(coalesce(p_row->>'full_name',''), 120)));
  if coalesce(v_gates.customer_ack_enabled, false) and coalesce(trim(p_row->>'email'),'') <> '' then
    insert into notification_outbox (event_type, entity_type, entity_id, recipient_kind, template_id, payload)
    values ('public_form.' || p_kind, p_kind, v_id, 'customer_ack', 'customer-ack',
            jsonb_build_object('kind', p_kind, 'submission_id', v_id));
  end if;

  return jsonb_build_object('ok', true, 'submission_id', v_id, 'duplicate', false);

exception
  when unique_violation then
    if p_idempotency_key is not null then
      if p_kind = 'careers' then
        select id, request_hash into v_existing, v_hash from job_applications   where idempotency_key = p_idempotency_key;
      elsif p_kind = 'franchise' then
        select id, request_hash into v_existing, v_hash from franchise_inquiries where idempotency_key = p_idempotency_key;
      else
        select id, request_hash into v_existing, v_hash from contact_messages   where idempotency_key = p_idempotency_key;
      end if;
      if v_existing is not null then
        if v_hash is not null and v_hash <> p_request_hash then
          return jsonb_build_object('ok', false, 'error', 'idempotency_conflict');
        end if;
        return jsonb_build_object('ok', true, 'submission_id', v_existing, 'duplicate', true);
      end if;
    end if;
    raise;
end;
$$;

revoke all on function public.submit_public_form(text, jsonb, uuid, text, text) from public, anon, authenticated;

comment on function public.submit_public_form(text, jsonb, uuid, text, text) is
  'R4.8 v3: WP-02.1 atomic hash-bound submission + commissioning gate + notice-version stamp + atomic outbox enqueue. Service-role (public-form Edge Function) is the only caller.';
comment on table notification_outbox is
  'R4.8 C1: durable notification jobs. Written only by submit_public_form (same txn as the submission); claimed only via outbox_claim_batch (SKIP LOCKED). Browser can neither write rows nor choose recipients.';

-- Owner read model for the Notification Health panel (browser reads via RPC —
-- the table itself stays closed to authed table reads except owner SELECT).
create or replace function outbox_recent(p_limit int default 50)
returns setof notification_outbox
language sql stable security definer
set search_path = public, pg_temp
as $$
  select * from notification_outbox
   where is_owner()
   order by created_at desc
   limit greatest(1, least(p_limit, 200));
$$;
revoke all on function outbox_recent(int) from public, anon;
grant execute on function outbox_recent(int) to authenticated;
