-- ============================================================================
--  migration-baseline.assert.sql — executed by migration-baseline.test.sh
--  against a FRESH database built from schema.FRESH-INSTALL-ONLY.sql + every migration in
--  launch order. Three layers (spec §18): structure, privilege, behaviour.
--  Every failure raises, which fails the harness.
-- ============================================================================
\set ON_ERROR_STOP on

-- ═══ 1. STRUCTURE ═══════════════════════════════════════════════════════════

-- 1a. The legacy Media Library table is EXACTLY as schema.FRESH-INSTALL-ONLY.sql defines it —
--     the P0-R1 regression test. Any migration that mutated or redefined it
--     changes this fingerprint and fails here.
do $$
declare v text;
begin
  select string_agg(column_name, ',' order by ordinal_position) into v
    from information_schema.columns where table_schema='public' and table_name='media_assets';
  -- R4.10 Increment 5a added `is_public`: an explicit publication flag,
  -- default false, so an asset is published deliberately rather than by
  -- existing. This assertion is a DRIFT DETECTOR, not a freeze — the
  -- expected list is updated deliberately alongside the migration that
  -- changes it, so an UNDECLARED change still fails here.
  if v <> 'id,name,folder,size,type,uploaded_at,url,created_at,is_public' then
    raise exception 'ASSERT legacy media_assets columns changed: %', v;
  end if;
end $$;

-- 1b. The technical registry + reference table exist with the spec shape.
do $$
begin
  perform 1 from information_schema.columns where table_name='media_objects'    and column_name in
    ('id','bucket','storage_path','public_url','mime_type','size_bytes','width','height','alt_text',
     'status','uploaded_by','created_at','attached_at','cleanup_after','cleanup_attempts','last_cleanup_error')
  having count(*) = 16;
  if not found then raise exception 'ASSERT media_objects columns incomplete'; end if;
  perform 1 from information_schema.table_constraints
   where table_name='media_references' and constraint_type='UNIQUE';
  if not found then raise exception 'ASSERT media_references unique(entity,entity_id,field_path) missing'; end if;
end $$;

-- 1c. WP01.1 columns + queue.
do $$
begin
  perform 1 from information_schema.columns where column_name='request_hash'
    and table_name in ('job_applications','franchise_inquiries','contact_messages')
  having count(*) = 3;
  if not found then raise exception 'ASSERT request_hash columns missing'; end if;
  perform 1 from information_schema.tables where table_name='storage_cleanup_jobs';
  if not found then raise exception 'ASSERT storage_cleanup_jobs missing'; end if;
end $$;

-- 1d. Exactly ONE exposed submit_public_form — INC11: the 7-argument
--     EVIDENCE gate (the client echoes the displayed notice's id + sha).
--     The old 5-argument form must be GONE (a submission without display
--     evidence was the unproven record the notice model ends), its verbatim
--     body surviving only as submit_public_form_core, callable by nothing
--     but the gate. Resolver still present.
do $$
declare n int; a int;
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public' and p.proname='submit_public_form';
  if n <> 1 then raise exception 'ASSERT submit_public_form overloads: %', n; end if;
  select pronargs into a from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public' and p.proname='submit_public_form';
  if a <> 7 then raise exception 'ASSERT submit_public_form arg count: %', a; end if;
  perform 1 from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname='public' and p.proname='submit_public_form_core' and p.pronargs = 5;
  if not found then raise exception 'ASSERT submit_public_form_core (5 args) missing'; end if;
  perform 1 from pg_proc where proname='resolve_public_submission';
  if not found then raise exception 'ASSERT resolve_public_submission missing'; end if;
end $$;

-- ═══ 2. PRIVILEGE (executable, not regex) ═══════════════════════════════════

set role anon;
do $$
begin
  begin
    perform public.submit_public_form('contact','{}'::jsonb, null, null, repeat('a',64), 'x', 'y');
    raise exception 'ASSERT anon could execute submit_public_form';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.resolve_public_submission('contact', gen_random_uuid(), repeat('b',64));
    raise exception 'ASSERT anon could execute resolve_public_submission';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.finalise_media_reference(gen_random_uuid(),'menu_item','x','image');
    raise exception 'ASSERT anon could execute finalise_media_reference';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.mark_media_cleanup_candidates(24);
    raise exception 'ASSERT anon could execute mark_media_cleanup_candidates';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.storage_cleanup_jobs;
    raise exception 'ASSERT anon could read storage_cleanup_jobs';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.media_objects;
    raise exception 'ASSERT anon could read media_objects';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role authenticated;
do $$
declare n int;
begin
  -- Staff SELECT policy exists; with no staff row this returns zero rows but
  -- must NOT be a permission error.
  select count(*) into n from public.media_objects;
  if n <> 0 then raise exception 'ASSERT unexpected media_objects rows: %', n; end if;
  begin
    -- INC11: the gate is the 7-argument evidence form; the privilege
    -- property under test (authenticated may NOT execute it) is unchanged.
    perform public.submit_public_form('contact','{}'::jsonb, null, null, repeat('a',64), 'x', 'y');
    raise exception 'ASSERT authenticated could execute submit_public_form';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ═══ 3. BEHAVIOUR ═══════════════════════════════════════════════════════════

-- 3a. Forms: happy path, hash-bound replay, conflict, rate limit — all three
--     kinds insert (this doubles as the column-shape proof for each table,
--     since plpgsql resolves columns at execution).
do $$
declare
  k1 uuid := gen_random_uuid();
  h1 text := repeat('1',64);
  h2 text := repeat('2',64);
  ip text := repeat('c',64);
  r  jsonb; id1 text; n int; i int;
begin
  -- R4.9 G5: a public form is no longer accepted unless there is a published
  -- privacy notice to stamp and a recipient to deliver to. Assert the GATE
  -- first — a submission with nothing published must be refused — then
  -- commission the surface and continue exercising the lifecycle below.
  begin
    r := public.submit_public_form('contact',
          '{"full_name":"Gate","email":"g@x.cc","reason":"Other","message":"m"}',
          gen_random_uuid(), repeat('9',64), repeat('9',64), null, null);
    raise exception 'ASSERT form gate: an uncommissioned surface accepted a submission';
  exception when others then
    -- INC11: with no notice published, the EVIDENCE gate refuses first
    -- (form_notice_missing) — same property, the surface is closed.
    if sqlerrm not like 'form_accept_blocked%' and sqlerrm not like 'form_notice_missing%' then raise; end if;
  end;
  update launch_settings set notification_recipient = 'harness@example.invalid' where id;
  insert into privacy_notice_versions (audience, version_label, notice_text, published_at)
    values ('careers', 'v1-harness', 'harness notice', now()),
           ('franchise', 'v1-harness', 'harness notice', now()),
           ('contact', 'v1-harness', 'harness notice', now())
    on conflict (audience, version_label) do nothing;

  r := public.submit_public_form('careers',
        '{"full_name":"Test A","email":"A@X.CC","phone":"07 000","applied_for":"Team Member","applied_store":"Solihull","availability":"Weekends","experience":"","message":""}',
        k1, h1, ip,
        (select id from privacy_notice_current where audience='careers'),
        (select content_sha256 from privacy_notice_current where audience='careers'));
  if (r->>'ok') <> 'true' or (r->>'duplicate') <> 'false' then
    raise exception 'ASSERT careers happy path: %', r; end if;
  id1 := r->>'submission_id';
  select count(*) into n from job_applications where idempotency_key = k1 and request_hash = h1 and email = 'a@x.cc';
  if n <> 1 then raise exception 'ASSERT careers row/hash/email-normalisation missing'; end if;

  -- Same key + same hash → ORIGINAL id, duplicate, still one row.
  r := public.submit_public_form('careers',
        '{"full_name":"Test A","email":"a@x.cc","phone":"07 000"}', k1, h1, ip,
        (select id from privacy_notice_current where audience='careers'),
        (select content_sha256 from privacy_notice_current where audience='careers'));
  if (r->>'ok') <> 'true' or (r->>'duplicate') <> 'true' or (r->>'submission_id') <> id1 then
    raise exception 'ASSERT replay did not return original: %', r; end if;
  select count(*) into n from job_applications where idempotency_key = k1;
  if n <> 1 then raise exception 'ASSERT replay created a second row'; end if;

  -- Same key + DIFFERENT hash → explicit conflict, no insert.
  r := public.submit_public_form('careers',
        '{"full_name":"Test A EDITED","email":"a@x.cc","phone":"07 000"}', k1, h2, ip,
        (select id from privacy_notice_current where audience='careers'),
        (select content_sha256 from privacy_notice_current where audience='careers'));
  if (r->>'ok') <> 'false' or (r->>'error') <> 'idempotency_conflict' then
    raise exception 'ASSERT conflict not raised: %', r; end if;

  -- resolve_public_submission mirrors the three outcomes.
  r := public.resolve_public_submission('careers', k1, h1);
  if (r->>'found') <> 'true' or (r->>'submission_id') <> id1 then
    raise exception 'ASSERT resolve found-path: %', r; end if;
  r := public.resolve_public_submission('careers', k1, h2);
  if (r->>'conflict') <> 'true' then raise exception 'ASSERT resolve conflict-path: %', r; end if;
  r := public.resolve_public_submission('careers', gen_random_uuid(), h1);
  if (r->>'found') <> 'false' or (r->>'conflict') <> 'false' then
    raise exception 'ASSERT resolve notfound-path: %', r; end if;

  -- Franchise + contact happy paths (column/enum shape proof).
  r := public.submit_public_form('franchise',
        '{"full_name":"F","email":"f@x.cc","city":"Birmingham","budget":"£100,000 - £150,000","experience":"Single coffee unit"}',
        gen_random_uuid(), h1, ip,
        (select id from privacy_notice_current where audience='franchise'),
        (select content_sha256 from privacy_notice_current where audience='franchise'));
  if (r->>'ok') <> 'true' then raise exception 'ASSERT franchise happy path: %', r; end if;
  r := public.submit_public_form('contact',
        '{"full_name":"C","email":"c@x.cc","reason":"Other","message":"hello"}',
        gen_random_uuid(), h1, ip,
        (select id from privacy_notice_current where audience='contact'),
        (select content_sha256 from privacy_notice_current where audience='contact'));
  if (r->>'ok') <> 'true' then raise exception 'ASSERT contact happy path: %', r; end if;

  -- Rate limit: 3 accepted so far on this ip; 5 more fills the window of 8,
  -- the 9th is rejected as rate_limited (and is not inserted).
  for i in 1..5 loop
    r := public.submit_public_form('contact',
          format('{"full_name":"C%s","email":"c%s@x.cc","reason":"Other","message":"m"}', i, i)::jsonb,
          gen_random_uuid(), h1, ip,
        (select id from privacy_notice_current where audience='contact'),
        (select content_sha256 from privacy_notice_current where audience='contact'));
    if (r->>'ok') <> 'true' then raise exception 'ASSERT fill % failed: %', i, r; end if;
  end loop;
  r := public.submit_public_form('contact',
        '{"full_name":"C9","email":"c9@x.cc","reason":"Other","message":"m"}',
        gen_random_uuid(), h1, ip,
        (select id from privacy_notice_current where audience='contact'),
        (select content_sha256 from privacy_notice_current where audience='contact'));
  if (r->>'error') <> 'rate_limited' then raise exception 'ASSERT 9th not rate_limited: %', r; end if;
end $$;

-- 3b. Media lifecycle: two-phase attach, displacement, scan-guarded cleanup,
--     failure backoff, storage-jobs state machine.
do $$
declare
  o1 uuid; o2 uuid; o3 uuid; r jsonb; v text; st text; att int; ca timestamptz; n int;
  j uuid;
begin
  insert into menu_items (id, name, category, price, image)
  values ('mi_test', 'Test Shake', (select enum_range(null::menu_category))[1], 4.50, '');

  insert into media_objects (bucket, storage_path, public_url, mime_type, size_bytes, uploaded_by)
  values ('menu-media','aaaa.webp','https://cdn.example/menu-media/aaaa.webp','image/webp',1000,'test') returning id into o1;
  insert into media_objects (bucket, storage_path, public_url, mime_type, size_bytes, uploaded_by)
  values ('menu-media','bbbb.webp','https://cdn.example/menu-media/bbbb.webp','image/webp',1000,'test') returning id into o2;

  -- Attach o1 → parent column + reference + status move atomically.
  r := public.finalise_media_reference(o1, 'menu_item', 'mi_test', 'image');
  if (r->>'status') <> 'attached' or (r->>'previous_object_cleanup') <> 'not_needed' then
    raise exception 'ASSERT first attach: %', r; end if;
  select image into v from menu_items where id='mi_test';
  if v <> 'https://cdn.example/menu-media/aaaa.webp' then raise exception 'ASSERT parent column not updated: %', v; end if;
  select status into st from media_objects where id=o1;
  if st <> 'attached' then raise exception 'ASSERT o1 status: %', st; end if;

  -- Attach o2 to the SAME field → o1 displaced, scheduled with future grace.
  r := public.finalise_media_reference(o2, 'menu_item', 'mi_test', 'image');
  if (r->>'previous_object_cleanup') <> 'scheduled' then raise exception 'ASSERT displacement: %', r; end if;
  select status, cleanup_after into st, ca from media_objects where id=o1;
  if st <> 'cleanup_pending' or ca <= now() then raise exception 'ASSERT o1 not grace-scheduled: % %', st, ca; end if;
  select count(*) into n from media_references where entity_id='mi_test' and media_object_id=o2;
  if n <> 1 then raise exception 'ASSERT reference did not move'; end if;

  -- Scan guard: an object whose path IS in live content must be demoted at
  -- claim time, not returned. Point the column back at o1's URL and try.
  update media_objects set cleanup_after = now() - interval '1 minute' where id=o1;
  update menu_items set image = 'https://cdn.example/menu-media/aaaa.webp' where id='mi_test';
  perform * from public.claim_media_cleanup_batch(10);
  select status into st from media_objects where id=o1;
  if st <> 'attached' then raise exception 'ASSERT scan guard failed — referenced object was claimable: %', st; end if;

  -- Genuine orphan: o3 pending, old, unreferenced → marked, claimed, then the
  -- failure and success paths of the recorder.
  insert into media_objects (bucket, storage_path, public_url, mime_type, size_bytes, uploaded_by, created_at)
  values ('menu-media','cccc.webp','https://cdn.example/menu-media/cccc.webp','image/webp',1000,'test', now() - interval '2 days')
  returning id into o3;
  if public.mark_media_cleanup_candidates(24) < 1 then raise exception 'ASSERT orphan not marked'; end if;
  select count(*) into n from public.claim_media_cleanup_batch(10) where id = o3;
  if n <> 1 then raise exception 'ASSERT orphan not claimed'; end if;
  perform public.record_media_cleanup_result(o3, false, 'storage 500');
  select status, cleanup_attempts, cleanup_after into st, att, ca from media_objects where id=o3;
  if st <> 'cleanup_failed' or att <> 1 or ca <= now() then
    raise exception 'ASSERT failure backoff: % % %', st, att, ca; end if;
  perform public.record_media_cleanup_result(o3, true, null);
  select status into st from media_objects where id=o3;
  if st <> 'deleted' then raise exception 'ASSERT confirmed delete: %', st; end if;

  -- Storage job queue: claim moves to processing+attempts, fail backs off,
  -- ok completes.
  insert into storage_cleanup_jobs (bucket, storage_path, reason)
  values ('cvs','dead.pdf','cv_link_lost_race') returning id into j;
  select count(*) into n from public.claim_storage_cleanup_batch(10) where id = j;
  if n <> 1 then raise exception 'ASSERT job not claimed'; end if;
  select status, attempts into st, att from storage_cleanup_jobs where id=j;
  if st <> 'processing' or att <> 1 then raise exception 'ASSERT job claim state: % %', st, att; end if;
  perform public.record_storage_cleanup_result(j, false, 'timeout');
  select status into st from storage_cleanup_jobs where id=j;
  if st <> 'failed' then raise exception 'ASSERT job failure state: %', st; end if;
  update storage_cleanup_jobs set next_attempt_at = now() where id=j;
  perform * from public.claim_storage_cleanup_batch(10);
  perform public.record_storage_cleanup_result(j, true, null);
  select status into st from storage_cleanup_jobs where id=j;
  if st <> 'done' then raise exception 'ASSERT job done state: %', st; end if;
end $$;

select 'STRUCTURE + PRIVILEGE + BEHAVIOUR assertions passed' as ok;
