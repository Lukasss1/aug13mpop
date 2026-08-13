-- ============================================================================
--  MILK POP — INC11 : IMMUTABLE PRIVACY NOTICES + POINT-OF-COLLECTION EVIDENCE
--
--  WHAT THE CODE-LEVEL REVIEW PROVED (verified in-session before this file):
--    • privacy_owner_all let the owner UPDATE and DELETE *published* notice
--      versions — the "evidence" a submission pointed at could be rewritten
--      or removed after the fact.
--    • Submissions stored only `notice_version` — a text LABEL with no key,
--      no hash, no foreign key. Two versions could share a label; nothing
--      proved WHICH TEXT the submitter saw.
--    • The public forms rendered site_content legal keys, not the versioned
--      notice rows — the thing displayed and the thing recorded were
--      different objects, so the record proved nothing about the display.
--
--  THE MODEL THIS FILE INSTALLS
--  ----------------------------
--  1. PUBLISH FREEZES. Publishing a notice version stamps content_sha256 +
--     frozen_at; from that moment the row is IMMUTABLE (update refused) and
--     UNDELETABLE (delete refused). Corrections are NEW versions. Draft
--     versions stay editable and deletable.
--  2. ONE CURRENT NOTICE PER AUDIENCE, derived not pointed: the
--     privacy_notice_current view = the latest published version per
--     audience. Views cannot race their own pointer updates.
--  3. SUBMISSIONS CARRY EVIDENCE: notice_id (FK, ON DELETE RESTRICT — the
--     freeze makes deletion impossible anyway; the FK makes it structurally
--     impossible), notice_sha256, and the existing human-readable label. The
--     transactional gate verifies the CLIENT-ECHOED id + hash against the
--     CURRENT frozen notice — a mismatch refuses as notice_version_changed,
--     which is exactly the display/record race the review described: if the
--     notice changed between render and submit, the submitter did NOT see
--     the current text, and recording otherwise would be fabricated
--     evidence.
--  4. STAFF PROVISION EVIDENCE: staff_notice_acknowledgements — who
--     acknowledged which frozen staff-facing notice, when. Append-only.
--
--  The anonymous surface gains exactly ONE relation: the current-notice
--  view (audience, id, version, sha, text, url) — the forms must RENDER the
--  notice they will record, so anonymous visitors must be able to read it.
--  The underlying table stays staff-only.
--
--  APPEND-ONLY: no previously applied migration file is edited.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Freeze columns.
-- ----------------------------------------------------------------------------
alter table privacy_notice_versions
  add column if not exists content_sha256 text,
  add column if not exists frozen_at timestamptz;

comment on column privacy_notice_versions.content_sha256 is
  'INC11: sha256 of notice_text, stamped at publish. A published notice is '
  'frozen — this hash is what submissions echo and store as evidence.';

-- ----------------------------------------------------------------------------
-- 2. Publish stamps the freeze; frozen rows are immutable and undeletable.
--    Superuser exempt (seed/harness/migration repair), like every INC11
--    guard; API roles have no way around it.
-- ----------------------------------------------------------------------------
create or replace function assert_notice_immutability()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  /* ORDER MATTERS (found by the freeze-stamp smoke): the sha/frozen STAMP is
     bookkeeping and runs for EVERY role — including the superuser paths that
     seed and arrange fixtures — while the immutability REFUSALS are guards
     and exempt the superuser like every INC11 guard. An exemption placed
     before the stamp produced published-but-unstamped rows. */

  if TG_OP = 'UPDATE' then
    -- The publishing write itself: stamp server-side from the text being
    -- published; the client can never supply the hash.
    if old.published_at is null and new.published_at is not null then
      new.content_sha256 := encode(digest(coalesce(new.notice_text, ''), 'sha256'), 'hex');
      new.frozen_at := now();
      return new;
    end if;
    if current_setting('is_superuser') = 'on' then return new; end if;
    if old.published_at is not null then
      raise exception
        'notice_frozen: "%" (%) was published — a published notice version is '
        'immutable; corrections are NEW versions', old.version_label, old.audience
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- DELETE path.
  if current_setting('is_superuser') = 'on' then return old; end if;
  if old.published_at is not null then
    raise exception
      'notice_frozen: "%" (%) was published — a published notice version is '
      'evidence and can never be deleted; supersede it with a new version',
      old.version_label, old.audience
      using errcode = 'check_violation';
  end if;
  return old;
end $$;

drop trigger if exists trg_notice_immutability on privacy_notice_versions;
create trigger trg_notice_immutability
  before update or delete on privacy_notice_versions
  for each row execute function assert_notice_immutability();

-- INSERT born-published also freezes (harness convenience; the Admin path
-- publishes with a second step, but a one-step insert must not dodge the
-- stamp).
create or replace function stamp_notice_on_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.published_at is not null then
    new.content_sha256 := encode(digest(coalesce(new.notice_text, ''), 'sha256'), 'hex');
    new.frozen_at := coalesce(new.frozen_at, now());
  end if;
  return new;
end $$;

drop trigger if exists trg_notice_stamp_insert on privacy_notice_versions;
create trigger trg_notice_stamp_insert
  before insert on privacy_notice_versions
  for each row execute function stamp_notice_on_insert();

-- Backfill: freeze-stamp every ALREADY-published version so the evidence
-- chain starts now (their text is taken as-is; that is the point of a
-- backfill — record what is, invent nothing).
update privacy_notice_versions
   set content_sha256 = encode(digest(coalesce(notice_text, ''), 'sha256'), 'hex'),
       frozen_at = coalesce(frozen_at, published_at)
 where published_at is not null and content_sha256 is null;

-- ----------------------------------------------------------------------------
-- 3. The current notice per audience — derived, anon-readable (the form
--    must SHOW what it records).
-- ----------------------------------------------------------------------------
create or replace view privacy_notice_current as
  select distinct on (audience)
         audience, id, version_label, content_sha256, notice_text, policy_url,
         published_at
    from privacy_notice_versions
   where published_at is not null
   order by audience, published_at desc, id desc;

grant select on privacy_notice_current to anon, authenticated;

-- The view SUPERSEDES the base table as the anonymous display surface: one
-- relation, already shaped as "the current notice per audience". The R4.8
-- published-read policy let anon browse the whole version ARCHIVE; the
-- archive is staff material (and evidence), so anon loses it. Staff keep a
-- published-read policy (acknowledgement flows read what they sign).
drop policy if exists privacy_public_read on privacy_notice_versions;
create policy privacy_staff_read on privacy_notice_versions
  for select to authenticated
  using (published_at is not null);
revoke select on privacy_notice_versions from anon;

comment on view privacy_notice_current is
  'INC11: THE notice each public form renders and each submission records — '
  'latest published version per audience, frozen text + sha. Anon-readable '
  'by design: evidence starts with display.';

-- ----------------------------------------------------------------------------
-- 4. Submission evidence columns (FK restricted; label kept for humans).
-- ----------------------------------------------------------------------------
alter table contact_messages
  add column if not exists notice_id text references privacy_notice_versions(id) on delete restrict,
  add column if not exists notice_sha256 text;
alter table job_applications
  add column if not exists notice_id text references privacy_notice_versions(id) on delete restrict,
  add column if not exists notice_sha256 text;
alter table franchise_inquiries
  add column if not exists notice_id text references privacy_notice_versions(id) on delete restrict,
  add column if not exists notice_sha256 text;

-- ----------------------------------------------------------------------------
-- 5. submit_public_form v2: the client ECHOES the notice it displayed
--    (id + sha); the transaction verifies both against the CURRENT frozen
--    notice for the form's audience and stamps the evidence. The old
--    5-argument form is DROPPED — a submission without display evidence is
--    exactly the unproven record this file exists to end.
--    (The gate below WRAPS the previous transactional body, which survives
--    verbatim as submit_public_form_core in §5b. Kinds and audiences are the
--    SAME vocabulary — contact | careers | franchise — verified against the
--    baseline's own behavioural probes. Evidence is stamped by a post-insert
--    UPDATE inside the transaction, because the core builds its INSERTs from
--    explicit column lists and ignores extra p_row keys.)
-- ----------------------------------------------------------------------------
do $mig$
begin
  -- Idempotent precondition: on FIRST apply the 5-argument gate must exist
  -- (it is about to be wrapped and renamed); on RE-apply the rename already
  -- happened, which the presence of the core proves.
  if to_regprocedure('public.submit_public_form(text, jsonb, uuid, text, text)') is null
     and to_regprocedure('public.submit_public_form_core(text, jsonb, uuid, text, text)') is null then
    raise exception 'inc11_notices: neither the 5-argument gate nor the renamed core exists';
  end if;
end $mig$;

create or replace function submit_public_form(
  p_kind text,
  p_row jsonb,
  p_idempotency_key uuid,
  p_request_hash text,
  p_ip_hash text,
  p_notice_id text,
  p_notice_sha256 text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_audience text;
  v_current  privacy_notice_current%rowtype;
  v_result   jsonb;
begin
  -- Kind vocabulary verified against the baseline's own behavioural probes:
  -- 'contact' | 'careers' | 'franchise' — audiences equal kinds.
  v_audience := case p_kind
    when 'contact'   then 'contact'
    when 'careers'   then 'careers'
    when 'franchise' then 'franchise'
    else null end;
  if v_audience is null then
    raise exception 'form_kind_unknown: %', p_kind using errcode = 'check_violation';
  end if;

  select * into v_current from privacy_notice_current where audience = v_audience;
  if not found then
    raise exception
      'form_notice_missing: no published % privacy notice exists — the form is closed',
      v_audience using errcode = 'check_violation';
  end if;
  if p_notice_id is null or p_notice_sha256 is null
     or p_notice_id <> v_current.id or p_notice_sha256 <> v_current.content_sha256 then
    raise exception
      'notice_version_changed: the % privacy notice changed since this form was '
      'displayed — reload the page so the current notice is shown before submitting',
      v_audience using errcode = 'check_violation';
  end if;

  v_result := submit_public_form_core(p_kind, p_row, p_idempotency_key, p_request_hash, p_ip_hash);

  -- Stamp the evidence into the row the core just inserted. The core builds
  -- its INSERTs from EXPLICIT column lists (found in test: extra p_row keys
  -- are silently ignored), so the stamp is a post-insert UPDATE inside this
  -- same transaction. Guard: a duplicate replay returns the ORIGINAL row —
  -- its evidence records what THAT submitter saw and is never overwritten.
  if (v_result->>'ok') = 'true' and coalesce(v_result->>'duplicate', 'false') <> 'true' then
    if p_kind = 'careers' then
      update job_applications set notice_id = v_current.id, notice_sha256 = v_current.content_sha256
       where id = (v_result->>'submission_id');
    elsif p_kind = 'franchise' then
      update franchise_inquiries set notice_id = v_current.id, notice_sha256 = v_current.content_sha256
       where id = (v_result->>'submission_id');
    else
      update contact_messages set notice_id = v_current.id, notice_sha256 = v_current.content_sha256
       where id = (v_result->>'submission_id');
    end if;
  end if;
  return v_result;
end $$;

-- House pattern (WP-02): revoke from every browser-reachable role; the
-- platform's default execute privilege for the Edge Functions' service-role
-- connection remains, making it the ONLY caller. No explicit grant — the
-- security suite forbids the role identifier appearing in code.
revoke all on function submit_public_form(text, jsonb, uuid, text, text, text, text)
  from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 5b. The previous 5-argument body becomes the CORE (rename-by-recreate: the
--     old public name is dropped so no caller can skip the evidence step).
--     Its source is preserved verbatim under the new name.
-- ----------------------------------------------------------------------------
do $core$
declare
  v_def  text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'submit_public_form'
     and pg_get_function_identity_arguments(p.oid)
         = 'p_kind text, p_row jsonb, p_idempotency_key uuid, p_request_hash text, p_ip_hash text';
  if v_def is null then
    -- Re-apply: the rename already happened (guarded above); nothing to do.
    return;
  end if;
  v_def := replace(v_def,
    'FUNCTION public.submit_public_form(p_kind text',
    'FUNCTION public.submit_public_form_core(p_kind text');
  execute v_def;
  execute 'drop function public.submit_public_form(text, jsonb, uuid, text, text)';
  -- Same house pattern as the gate above: browser roles revoked, the
  -- service-role default execute privilege is what remains.
  execute 'revoke all on function public.submit_public_form_core(text, jsonb, uuid, text, text) from public, anon, authenticated';
end $core$;

comment on function submit_public_form_core(text, jsonb, uuid, text, text) is
  'INC11: the pre-evidence transactional gate, callable ONLY through '
  'submit_public_form v2 (which verifies + stamps notice evidence first). '
  'Not independently exposed.';

-- ----------------------------------------------------------------------------
-- 6. Staff provision evidence — append-only acknowledgements.
-- ----------------------------------------------------------------------------
create table if not exists staff_notice_acknowledgements (
  id         text primary key default ('sna_' || replace(gen_random_uuid()::text, '-', '')),
  staff_id   text not null references staff_profiles(id),
  notice_id  text not null references privacy_notice_versions(id) on delete restrict,
  acknowledged_at timestamptz not null default now()
);
alter table staff_notice_acknowledgements enable row level security;

drop policy if exists sna_self_insert on staff_notice_acknowledgements;
create policy sna_self_insert on staff_notice_acknowledgements
  for insert to authenticated
  with check (staff_id = current_staff_id());
drop policy if exists sna_read on staff_notice_acknowledgements;
create policy sna_read on staff_notice_acknowledgements
  for select to authenticated
  -- M4 choke point: owner-wide read goes through the AAL2-aware helper,
  -- never raw current_staff_role().
  using (staff_id = current_staff_id() or is_owner());

revoke all on staff_notice_acknowledgements from anon;
grant select, insert on staff_notice_acknowledgements to authenticated;

create or replace function assert_ack_append_only()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_setting('is_superuser') = 'on' then
    if TG_OP = 'DELETE' then return old; end if; return new;
  end if;
  raise exception 'notice_ack_append_only: acknowledgements are evidence — they are never edited or deleted'
    using errcode = 'check_violation';
end $$;
drop trigger if exists trg_ack_append_only on staff_notice_acknowledgements;
create trigger trg_ack_append_only
  before update or delete on staff_notice_acknowledgements
  for each row execute function assert_ack_append_only();

-- ----------------------------------------------------------------------------
-- ACCEPTANCE — structural + what a superuser transaction can prove.
-- Role behaviour (frozen-refusals as owner, the notice_version_changed race,
-- anon view read) lives in scripts/inc11-notice-evidence.test.mjs.
-- ----------------------------------------------------------------------------
do $acceptance$
begin
  if to_regclass('public.privacy_notice_current') is null then
    raise exception 'inc11_notices: the current-notice view is absent';
  end if;
  if to_regprocedure('public.submit_public_form(text, jsonb, uuid, text, text)') is not null then
    raise exception 'inc11_notices: the evidence-free 5-argument form gate still exists';
  end if;
  if to_regprocedure('public.submit_public_form(text, jsonb, uuid, text, text, text, text)') is null then
    raise exception 'inc11_notices: the 7-argument evidence gate is absent';
  end if;
  if to_regprocedure('public.submit_public_form_core(text, jsonb, uuid, text, text)') is null then
    raise exception 'inc11_notices: the renamed core is absent';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_name = 'contact_messages' and column_name = 'notice_id') then
    raise exception 'inc11_notices: contact_messages.notice_id is absent';
  end if;
end $acceptance$;
