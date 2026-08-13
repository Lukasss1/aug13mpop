-- ============================================================================
--  MIGRATION — WP02.1: hash-bound idempotency + pre-captcha resolution
--  (MilkPop WP01–04 Remediation Patch Specification v1, §6.3 / §7.1)
--
--  WHAT THIS FIXES:
--    P1-R2 — submit_public_form now takes p_request_hash and binds it to the
--    idempotency key: same key + same hash → the ORIGINAL row (duplicate),
--    same key + DIFFERENT hash → idempotency_conflict, never a silent wrong
--    resolution.
--    P1-R3 — Turnstile tokens are single-use, so a retry cannot replay its
--    token. resolve_public_submission() lets the Edge Function answer a
--    known (key, hash) BEFORE spending a captcha verification: a lost-
--    response retry resolves without needing a token at all, and a fresh
--    token is only required for genuinely NEW inserts.
--    House convention — both functions pin search_path = public, pg_temp
--    (the pos_sync pattern; the WP-02 originals pinned public only).
--
--  The 4-argument submit_public_form from WP-02 is DROPPED (an overload
--  would make PostgREST rpc-by-name ambiguous). Forward-only: if it was
--  never applied, the drop is a no-op; if it was, the 5-arg version is a
--  strict behavioural superset (null hash = legacy keyless behaviour).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. resolve_public_submission — READ-ONLY idempotency lookup, pre-captcha.
--    Safe to call before CAPTCHA because it can only echo the id of a row
--    whose exact key AND payload hash the caller already possesses (both are
--    unguessable client-side values), and it never inserts, never consumes
--    rate budget, and is not callable by browser roles.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_public_submission(
  p_kind             text,
  p_idempotency_key  uuid,
  p_request_hash     text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id   text;
  v_hash text;
begin
  if p_kind not in ('careers','franchise','contact') then
    raise exception 'unknown_form_kind';
  end if;
  if p_idempotency_key is null then
    return jsonb_build_object('found', false, 'conflict', false);
  end if;

  if p_kind = 'careers' then
    select id, request_hash into v_id, v_hash from job_applications   where idempotency_key = p_idempotency_key;
  elsif p_kind = 'franchise' then
    select id, request_hash into v_id, v_hash from franchise_inquiries where idempotency_key = p_idempotency_key;
  else
    select id, request_hash into v_id, v_hash from contact_messages   where idempotency_key = p_idempotency_key;
  end if;

  if v_id is null then
    return jsonb_build_object('found', false, 'conflict', false);
  end if;
  -- Key exists. Rows written before WP01.1 (or by keyless legacy clients that
  -- somehow carried a key without a hash) have request_hash NULL — treat a
  -- null stored hash as matching, since there is nothing to contradict.
  if v_hash is not null and p_request_hash is not null and v_hash <> p_request_hash then
    return jsonb_build_object('found', false, 'conflict', true);
  end if;
  return jsonb_build_object('found', true, 'submission_id', v_id, 'conflict', false);
end;
$$;

revoke all on function public.resolve_public_submission(text, uuid, text) from public, anon, authenticated;

comment on function public.resolve_public_submission(text, uuid, text) is
  'WP02.1: pre-captcha idempotency lookup. found=true echoes the original submission id when key AND payload hash match; conflict=true when the key exists with different data. Read-only; Edge Function (service role) only.';

-- ---------------------------------------------------------------------------
-- 2. submit_public_form — the WP-02 atomic path, now hash-bound (5 args).
-- ---------------------------------------------------------------------------
drop function if exists public.submit_public_form(text, jsonb, uuid, text);

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
  v_rate_limit constant int := 8;          -- accepted submissions / IP / rolling hour (all forms)
  v_recent   int;
  v_id       text;
  v_existing text;
  v_hash     text;
begin
  if p_kind not in ('careers','franchise','contact') then
    raise exception 'unknown_form_kind';
  end if;
  if p_ip_hash is null or length(p_ip_hash) <> 64 then
    raise exception 'bad_ip_hash';         -- must be the sha-256 hex the function computes
  end if;
  if p_idempotency_key is not null and (p_request_hash is null or length(p_request_hash) <> 64) then
    raise exception 'bad_request_hash';    -- a keyed submission must carry its canonical hash
  end if;

  -- Serialise per IP: the count below is exact for the duration of this txn.
  perform pg_advisory_xact_lock(hashtextextended('milkpop_public_form:' || p_ip_hash, 0));

  -- ---- 1. Idempotency: same key → same hash returns the ORIGINAL row (no
  --         budget use); different hash is an explicit conflict, never a
  --         silent wrong resolution (P1-R2).
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

  -- ---- 2. Rate-limit reservation (exact under the advisory lock) ----------
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

  -- ---- 3. Insert (explicit columns; server owns id/status/chronology) -----
  v_id := gen_random_uuid()::text;

  if p_kind = 'careers' then
    if coalesce(trim(p_row->>'full_name'),'') = '' or coalesce(trim(p_row->>'email'),'') = ''
       or coalesce(trim(p_row->>'phone'),'') = '' then
      raise exception 'missing_required_field';
    end if;
    insert into job_applications
      (id, full_name, email, phone, applied_for, applied_store, availability, experience, message,
       status, applied_at, idempotency_key, request_hash)
    values
      (v_id,
       trim(p_row->>'full_name'), lower(trim(p_row->>'email')), trim(p_row->>'phone'),
       coalesce(trim(p_row->>'applied_for'),''),  coalesce(trim(p_row->>'applied_store'),''),
       coalesce(trim(p_row->>'availability'),''), coalesce(trim(p_row->>'experience'),''),
       coalesce(trim(p_row->>'message'),''),
       'pending', now(), p_idempotency_key, p_request_hash);

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
       status, submitted_at, idempotency_key, request_hash)
    values
      (v_id,
       trim(p_row->>'full_name'), lower(trim(p_row->>'email')), coalesce(trim(p_row->>'phone'),''),
       coalesce(trim(p_row->>'country'),''), trim(p_row->>'city'),
       p_row->>'budget', p_row->>'experience', coalesce(trim(p_row->>'message'),''),
       'pending', now(), p_idempotency_key, p_request_hash);

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
      (id, full_name, email, reason, message, submitted_at, idempotency_key, request_hash)
    values
      (v_id,
       trim(p_row->>'full_name'), lower(trim(p_row->>'email')),
       p_row->>'reason', trim(p_row->>'message'),
       now(), p_idempotency_key, p_request_hash);
  end if;

  -- ---- 4. Accepted audit row — SAME transaction as the insert -------------
  insert into form_submission_log (ip_hash, form_kind, status)
  values (p_ip_hash, p_kind, 'accepted');

  return jsonb_build_object('ok', true, 'submission_id', v_id, 'duplicate', false);

exception
  when unique_violation then
    -- Cross-connection idempotency race (advisory lock is per-IP): the index
    -- won; re-resolve WITH the hash rule so a conflicting payload still
    -- surfaces as a conflict rather than the wrong row.
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

-- Lock the function down (house pattern, as pos_ingest_batch): revoke the
-- browser-reachable roles; the platform's default execute privilege for the
-- Edge Functions' service-role connection remains, making it the ONLY caller.
revoke all on function public.submit_public_form(text, jsonb, uuid, text, text) from public, anon, authenticated;

comment on function public.submit_public_form(text, jsonb, uuid, text, text) is
  'WP02.1: atomic public-form submission — hash-bound idempotency, per-IP rate reservation (advisory lock), allow-listed insert and audit row in one transaction. Edge Function (service role) only; CAPTCHA + UX validation happen in public-form before this is called.';

-- ---------------------------------------------------------------------------
-- Verification (run manually after applying):
--   select proname, pg_get_function_identity_arguments(oid)
--     from pg_proc where proname in ('submit_public_form','resolve_public_submission');
--   -- expect exactly ONE submit_public_form, with 5 arguments
--   set role anon;
--   select resolve_public_submission('contact', gen_random_uuid(), repeat('a',64));
--   -- must fail: permission denied
--   reset role;
-- ---------------------------------------------------------------------------
