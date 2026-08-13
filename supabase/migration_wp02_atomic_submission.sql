-- ============================================================================
--  MIGRATION — WP-02: atomic public-form submission
--  (MilkPop Production Remediation Technical Pack v1, Work Package 02)
--
--  WHAT THIS FIXES (P0-02 family / concurrency):
--    The Edge Function previously ran the per-IP rate check (HEAD count) and
--    the row insert as SEPARATE requests, so N concurrent submissions from one
--    IP could all pass the count and exceed the nominal limit; the accepted
--    audit row was a third, best-effort write. This RPC makes the whole
--    decision ONE transaction: idempotency resolution, rate-limit reservation,
--    row insert and the accepted/rejected audit row commit or fail together.
--
--  DESIGN:
--    • pg_advisory_xact_lock on the caller's ip_hash serialises concurrent
--      submissions PER IP (different IPs never contend), so the accepted-count
--      read is exact. The lock releases automatically at commit/rollback.
--    • Idempotency: the WP-01 unique index remains the arbiter. A key that
--      already exists returns the ORIGINAL row id with duplicate=true and is
--      logged as 'rejected'/'duplicate_replay' so it never consumes budget.
--    • Explicit per-form column mapping — no dynamic SQL, no EXECUTE. Unknown
--      jsonb keys are simply never read (allow-list by construction). Required
--      fields and enum values are re-enforced here as the last line of
--      defence; the Edge Function performs the same checks first for honest
--      per-field UX, so hitting these RAISEs means a bypassed client.
--    • SECURITY DEFINER with a pinned search_path; EXECUTE is revoked from
--      public/anon/authenticated (house pattern — see pos_ingest_batch), so
--      only the Edge Function's service-role connection can call it and the
--      CAPTCHA + validation gate cannot be skipped via a direct RPC request.
--    • Timestamps and status are stamped from the DATABASE clock (now()),
--      replacing the Edge runtime's Date — one authority fewer.
--
--  Forward-only and idempotent (create or replace). Run AFTER
--  migration_wp01_public_form_identity.sql; listed in launch.sh before Phase B.
-- ============================================================================

create or replace function public.submit_public_form(
  p_kind             text,
  p_row              jsonb,
  p_idempotency_key  uuid,
  p_ip_hash          text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rate_limit constant int := 8;          -- accepted submissions / IP / rolling hour (all forms)
  v_recent   int;
  v_id       text;
  v_existing text;
begin
  if p_kind not in ('careers','franchise','contact') then
    raise exception 'unknown_form_kind';
  end if;
  if p_ip_hash is null or length(p_ip_hash) <> 64 then
    raise exception 'bad_ip_hash';         -- must be the sha-256 hex the function computes
  end if;

  -- Serialise per IP: the count below is exact for the duration of this txn.
  perform pg_advisory_xact_lock(hashtextextended('milkpop_public_form:' || p_ip_hash, 0));

  -- ---- 1. Idempotency: same attempt key → the ORIGINAL row, no budget used
  if p_idempotency_key is not null then
    if p_kind = 'careers' then
      select id into v_existing from job_applications  where idempotency_key = p_idempotency_key;
    elsif p_kind = 'franchise' then
      select id into v_existing from franchise_inquiries where idempotency_key = p_idempotency_key;
    else
      select id into v_existing from contact_messages  where idempotency_key = p_idempotency_key;
    end if;
    if v_existing is not null then
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
       status, applied_at, idempotency_key)
    values
      (v_id,
       trim(p_row->>'full_name'), lower(trim(p_row->>'email')), trim(p_row->>'phone'),
       coalesce(trim(p_row->>'applied_for'),''),  coalesce(trim(p_row->>'applied_store'),''),
       coalesce(trim(p_row->>'availability'),''), coalesce(trim(p_row->>'experience'),''),
       coalesce(trim(p_row->>'message'),''),
       'pending', now(), p_idempotency_key);

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
       status, submitted_at, idempotency_key)
    values
      (v_id,
       trim(p_row->>'full_name'), lower(trim(p_row->>'email')), coalesce(trim(p_row->>'phone'),''),
       coalesce(trim(p_row->>'country'),''), trim(p_row->>'city'),
       p_row->>'budget', p_row->>'experience', coalesce(trim(p_row->>'message'),''),
       'pending', now(), p_idempotency_key);

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
      (id, full_name, email, reason, message, submitted_at, idempotency_key)
    values
      (v_id,
       trim(p_row->>'full_name'), lower(trim(p_row->>'email')),
       p_row->>'reason', trim(p_row->>'message'),
       now(), p_idempotency_key);
  end if;

  -- ---- 4. Accepted audit row — SAME transaction as the insert -------------
  insert into form_submission_log (ip_hash, form_kind, status)
  values (p_ip_hash, p_kind, 'accepted');

  return jsonb_build_object('ok', true, 'submission_id', v_id, 'duplicate', false);

exception
  when unique_violation then
    -- Cross-connection idempotency race (two IPs, same key): the index won;
    -- return the row that got there first.
    if p_idempotency_key is not null then
      if p_kind = 'careers' then
        select id into v_existing from job_applications  where idempotency_key = p_idempotency_key;
      elsif p_kind = 'franchise' then
        select id into v_existing from franchise_inquiries where idempotency_key = p_idempotency_key;
      else
        select id into v_existing from contact_messages  where idempotency_key = p_idempotency_key;
      end if;
      if v_existing is not null then
        return jsonb_build_object('ok', true, 'submission_id', v_existing, 'duplicate', true);
      end if;
    end if;
    raise;
end;
$$;

-- Lock the function down (house pattern, as pos_ingest_batch): revoke the
-- browser-reachable roles; the platform's default execute privilege for the
-- Edge Functions' service-role connection remains, making it the ONLY caller.
revoke all on function public.submit_public_form(text, jsonb, uuid, text) from public, anon, authenticated;

comment on function public.submit_public_form(text, jsonb, uuid, text) is
  'WP-02: atomic public-form submission — idempotency resolution, per-IP rate reservation (advisory lock), allow-listed insert and audit row in one transaction. Edge Function (service role) only; CAPTCHA + UX validation happen in public-form before this is called.';

-- ---------------------------------------------------------------------------
-- Verification (run manually after applying):
--   select proname, prosecdef from pg_proc where proname = 'submit_public_form';
--   select grantee, privilege_type from information_schema.routine_privileges
--    where routine_name = 'submit_public_form';
--   -- expect: NO anon, NO authenticated, NO PUBLIC in the grantee list
-- ---------------------------------------------------------------------------
