-- ============================================================================
-- MILKPOP DATABASE LAUNCH BASELINE v1  (byte-reproducible: identity = chain fingerprint below)
-- Built REPRODUCIBLY by scripts/stage3-build-baseline.sh from the effective
-- state of the 90-migration development chain.
-- Dev-chain provenance fingerprint (sha256 of chain checksums): 631c620efe8e371d5a59a5b349e2d12950494c51a855058e88f8c49dd836d185
-- COVENANT: once applied to production this file is IMMUTABLE; every later
-- database change is an append-only migration. Contains NO business data.
-- ============================================================================
-- EMPTY-DATABASE GUARD: refuses any target already carrying business schema.
do $guard$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'public') then
    raise exception 'launch_baseline_refused: target public schema is NOT empty';
  end if;
end $guard$;
-- Direct database dependency (re-audit finding 3): the schema uses
-- digest()/gen_random_*; the platform usually pre-installs this, but the
-- baseline must not silently depend on it.
create extension if not exists pgcrypto;
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- (public schema pre-exists on every PostgreSQL/Supabase target)


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'Milk Pop application schema. R4.10 Increment 3: anonymous access is an EXPLICIT ALLOW-LIST — everything is revoked from anon by default (including default privileges for future relations) and only the relations declared in scripts/contracts/anon-surface.json are granted back. Adding a table does NOT make it public; it must be added to the contract deliberately.';


--
-- Name: compliance_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.compliance_status AS ENUM (
    'not_recorded',
    'pending_verification',
    'verified',
    'expiring',
    'expired',
    'rejected',
    'revoked',
    'not_applicable'
);


--
-- Name: deal_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.deal_type AS ENUM (
    'bundle_price',
    'buy_x_get_y_free',
    'percent_off_category',
    'fixed_off_order'
);


--
-- Name: employee_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.employee_role AS ENUM (
    'team_member',
    'supervisor',
    'store_manager',
    'owner'
);


--
-- Name: item_size; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.item_size AS ENUM (
    'regular',
    'large',
    'one_size'
);


--
-- Name: menu_category; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.menu_category AS ENUM (
    'milkshakes',
    'smoothies',
    'soft_serve',
    'slush',
    'extras'
);


--
-- Name: order_channel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_channel AS ENUM (
    'walk_in',
    'phone',
    'website',
    'deliveroo',
    'uber_eats',
    'just_eat'
);


--
-- Name: order_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.order_status AS ENUM (
    'open',
    'completed',
    'refunded',
    'voided'
);


--
-- Name: payment_method; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_method AS ENUM (
    'cash',
    'card',
    'online',
    'gift_card'
);


--
-- Name: store_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.store_status AS ENUM (
    'open',
    'closed',
    'coming_soon'
);


--
-- Name: allergen_declaration_approve(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.allergen_declaration_approve(p_declaration_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare d product_allergen_declarations; v_actor text := current_staff_id();
begin
  if not is_manager_or_owner() then raise exception 'not_permitted'; end if;
  select * into d from product_allergen_declarations where id = p_declaration_id;
  if not found then raise exception 'not_found'; end if;
  if d.state not in ('awaiting_approval','draft','awaiting_evidence') then
    raise exception 'not_approvable_state';
  end if;
  -- every referenced code must exist in the regulated catalogue; detail is
  -- mandatory where the category requires it (no bare "tree_nuts").
  if exists (
    select 1 from jsonb_array_elements(d.contains || d.may_contain) e
    left join allergen_catalogue c on c.code = e->>'code'
    where c.code is null
       or (c.requires_detail and coalesce(trim(e->>'detail'),'') = ''))
  then raise exception 'invalid_allergen_entries'; end if;

  update product_allergen_declarations
     set state='approved', approved_by_staff_id=v_actor, approved_at=now(), updated_at=now()
   where id = p_declaration_id;
  update product_allergen_declarations
     set state='superseded', superseded_reason='replaced by '||p_declaration_id, updated_at=now()
   where menu_item_id = d.menu_item_id and id <> p_declaration_id and state='approved';
  insert into audit_logs (id, operator_name, role, action, timestamp, module, new_value)
  values (gen_random_uuid()::text, v_actor, current_staff_role()::text,
          'allergen.declaration_approved', now()::text, 'Menu', d.menu_item_id);
  return jsonb_build_object('ok', true);
end $$;


--
-- Name: FUNCTION allergen_declaration_approve(p_declaration_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.allergen_declaration_approve(p_declaration_id text) IS 'R4.8 G3/G4: the only path to an approved declaration — audited, validated against the catalogue, detail mandatory for gluten cereals and tree nuts.';


--
-- Name: apply_collection_changes(text, jsonb, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_collection_changes(p_table text, p_upserts jsonb, p_delete_ids text[]) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
declare
  v_pk       text;
  v_row      jsonb;
  v_cols     text;
  v_sets     text;
  v_del      text[];
  v_final    jsonb;
  v_upserts  int;
  v_hit      int;
begin
  -- 1. Allow-list: ONLY the sensitive collections that replace-all must
  --    never touch again. Both are keyed by `id`.
  v_pk := case p_table
    when 'clock_history' then 'id'
    when 'payslips'      then 'id'
    else null
  end;
  if v_pk is null then
    raise exception 'table_not_allowed';
  end if;
  if p_upserts is null or jsonb_typeof(p_upserts) <> 'array' then
    raise exception 'rows_must_be_array';
  end if;
  if jsonb_array_length(p_upserts) > 2000
     or coalesce(array_length(p_delete_ids, 1), 0) > 2000 then
    raise exception 'too_many_rows';
  end if;
  v_upserts := jsonb_array_length(p_upserts);
  v_del := (select coalesce(array_agg(x), '{}') from unnest(coalesce(p_delete_ids, '{}')) as x
             where coalesce(x, '') <> '');

  -- 2. Every upsert row must carry the primary key, and no row may be both
  --    upserted and deleted in the same call (ambiguous intent → reject).
  if exists (select 1 from jsonb_array_elements(p_upserts) e
              where not (e.value ? v_pk) or coalesce(e.value->>v_pk, '') = '') then
    raise exception 'row_missing_primary_key';
  end if;
  if exists (select 1 from jsonb_array_elements(p_upserts) e
              where (e.value->>v_pk) = any(v_del)) then
    raise exception 'row_both_upserted_and_deleted';
  end if;

  -- 3. DELETE exactly the named ids — nothing implicit, ever. RLS delete
  --    policies scope this (clock_history exposes none to browser clients;
  --    payslips deletes are owner-only).
  if array_length(v_del, 1) is not null then
    execute format('delete from %I where %I = any($1)', p_table, v_pk) using v_del;
  end if;

  -- 4. UPSERT exactly the submitted rows — UPDATE-FIRST, insert only when the
  --    row does not exist. This is deliberate and load-bearing: Postgres
  --    evaluates INSERT policies' WITH CHECK on every row proposed to
  --    `insert ... on conflict do update`, even when the update path would be
  --    taken — so a manager/owner (who may UPDATE a staff clock row via
  --    clock_update_mgr but holds no INSERT right over it, clock_insert_self
  --    being self-only) can never "upsert" it. Updating first routes the
  --    common case (amending an existing row) through the UPDATE policies
  --    that actually authorise it; only a genuinely new row takes the INSERT
  --    path and faces the INSERT policy. A row the caller cannot SEE updates
  --    0 rows, falls to INSERT, and aborts on the primary key / RLS — the
  --    whole transaction rolls back, fail-closed.
  --    As in stage 7, each row writes ONLY the columns it provides; absent
  --    keys keep stored values, and jsonb_populate_record applies the
  --    table-declared type conversions.
  for v_row in select value from jsonb_array_elements(p_upserts) loop
    select string_agg(format('%I', k), ', '),
           string_agg(case when k = v_pk then null
                           else format('%I = src.%I', k, k) end, ', ')
      into v_cols, v_sets
      from jsonb_object_keys(v_row) as k;
    v_hit := 0;
    if v_sets is not null then
      execute format(
        'update %I t set %s from jsonb_populate_record(null::%I, $1) src where t.%I = src.%I',
        p_table, v_sets, p_table, v_pk, v_pk
      ) using v_row;
      get diagnostics v_hit = row_count;
    else
      -- pk-only payload: nothing to change; treat "caller can see it" as done.
      execute format('select count(*) from %I where %I = $1', p_table, v_pk)
        into v_hit using (v_row->>v_pk);
    end if;
    if v_hit = 0 then
      execute format(
        'insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1)',
        p_table, v_cols, v_cols, p_table
      ) using v_row;
    end if;
  end loop;

  -- 5. Server-side audit row (actor derived here; stage-11 trigger stamps it).
  insert into audit_logs (id, operator_name, role, action, timestamp, module)
  select 'aud_' || replace(gen_random_uuid()::text, '-', ''),
         coalesce(sp.name, current_staff_id()),
         coalesce(sp.role::text, ''),
         'Applied changes to "' || p_table || '" (' || v_upserts || ' upserted, '
           || coalesce(array_length(v_del, 1), 0) || ' deleted)',
         now()::text,
         'Publishing (server)'
    from staff_profiles sp where sp.id = current_staff_id();

  -- 6. Contract check: every explicitly named delete must actually be gone
  --    (a delete RLS silently filtered → 42501, whole transaction rolls
  --    back), then return the collection AS THE CALLER SEES IT.
  if array_length(v_del, 1) is not null then
    execute format('select count(*) from %I where %I = any($1)', p_table, v_pk)
      into v_upserts using v_del;  -- reuse int var
    if v_upserts > 0 then
      raise exception 'requested_rows_not_deletable' using errcode = '42501';
    end if;
  end if;

  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from %I t', p_table)
    into v_final;
  return v_final;
end $_$;


--
-- Name: assert_ack_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_ack_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if current_setting('is_superuser') = 'on' then
    if TG_OP = 'DELETE' then return old; end if; return new;
  end if;
  raise exception 'notice_ack_append_only: acknowledgements are evidence — they are never edited or deleted'
    using errcode = 'check_violation';
end $$;


--
-- Name: assert_application_transition_sanctioned(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_application_transition_sanctioned() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if new.status is distinct from old.status then
    if current_setting('is_superuser') = 'on' then return new; end if;
    if current_setting('milkpop.application_rpc', true) = '1' then return new; end if;
    raise exception
      'application_transition_refused: candidacy status changes go through transition_application, which locks the row, verifies the expected status and records the audit + candidate notification in one transaction'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;


--
-- Name: assert_full_collection_snapshot(text, jsonb, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_full_collection_snapshot(p_table text, p_rows jsonb, p_expected_total integer) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare
  v_visible integer;
begin
  if p_expected_total is null then
    raise exception
      'collection_snapshot_total_required: state how many % rows the snapshot was taken '
      'over. A publisher that cannot say what it loaded must not replace the collection.',
      p_table
      using errcode = 'check_violation';
  end if;

  execute format('select count(*) from %I', p_table) into v_visible;

  if p_expected_total <> v_visible then
    raise exception
      'collection_snapshot_stale: % holds % row(s) but the publisher believed it held %. '
      'The snapshot was taken before the table changed, or it came from a filtered '
      'projection. Re-hydrate from the authenticated collection and publish again.',
      p_table, v_visible, p_expected_total
      using errcode = 'check_violation';
  end if;
end
$$;


--
-- Name: FUNCTION assert_full_collection_snapshot(p_table text, p_rows jsonb, p_expected_total integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.assert_full_collection_snapshot(p_table text, p_rows jsonb, p_expected_total integer) IS 'R4.10 Increment 5: refuses a whole-collection publish whose payload is smaller than the caller-visible table, or whose expected total disagrees with it. SECURITY INVOKER, so the count is measured through the caller''s own RLS.';


--
-- Name: assert_launch_ready(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_launch_ready(p_context text, p_error text DEFAULT 'launch_blocked'::text) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare v_missing text;
begin
  select string_agg(key, ', ' order by key) into v_missing
    from launch_blocking_reasons()
   where state = 'incomplete' and p_context = any(blocks);
  if v_missing is not null then
    raise exception '%: missing %', p_error, v_missing;
  end if;
end $$;


--
-- Name: FUNCTION assert_launch_ready(p_context text, p_error text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.assert_launch_ready(p_context text, p_error text) IS 'R4.9 G5: raises when any condition in launch_blocking_reasons() that gates p_context is incomplete. Warnings never block.';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: launch_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.launch_settings (
    id boolean DEFAULT true NOT NULL,
    legal_business_name text DEFAULT ''::text NOT NULL,
    company_number text DEFAULT ''::text NOT NULL,
    registered_address text DEFAULT ''::text NOT NULL,
    public_contact_email text DEFAULT ''::text NOT NULL,
    privacy_contact_email text DEFAULT ''::text NOT NULL,
    public_telephone text DEFAULT ''::text NOT NULL,
    telephone_alternative_ok boolean DEFAULT false NOT NULL,
    canonical_url text DEFAULT ''::text NOT NULL,
    receipt_identity_footer text DEFAULT ''::text NOT NULL,
    vat_state_confirmed boolean DEFAULT false NOT NULL,
    notification_recipient text DEFAULT ''::text NOT NULL,
    customer_ack_enabled boolean DEFAULT false NOT NULL,
    enforce_public_gates boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text DEFAULT ''::text NOT NULL,
    allergen_disclosure_mode text DEFAULT 'in_store_only'::text NOT NULL,
    CONSTRAINT launch_settings_allergen_mode_chk CHECK ((allergen_disclosure_mode = 'in_store_only'::text)),
    CONSTRAINT launch_settings_id_check CHECK (id)
);


--
-- Name: COLUMN launch_settings.allergen_disclosure_mode; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.launch_settings.allergen_disclosure_mode IS 'R4.10 Increment 8: constrained to in_store_only for this release. `declared` published menu_items.allergens while the gate checked product_allergen_declarations — two sources, so the gate could not see what the site claimed. Re-open it only when one approved-declaration system feeds the public projection directly.';


--
-- Name: assert_launch_ready(text, text, public.launch_settings); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_launch_ready(p_context text, p_error text, p_candidate public.launch_settings) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare v_missing text;
begin
  select string_agg(key, ', ' order by key) into v_missing
    from launch_blocking_reasons(p_candidate)
   where state = 'incomplete' and p_context = any(blocks);
  if v_missing is not null then
    raise exception '%: missing %', p_error, v_missing;
  end if;
end $$;


--
-- Name: assert_launch_settings_transition(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_launch_settings_transition() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if new.enforce_public_gates then
    perform assert_launch_ready(
      'arm_gates',
      case when old.enforce_public_gates then 'launch_degrade_blocked' else 'launch_arm_blocked' end,
      new);
  end if;
  if old.enforce_public_gates and not new.enforce_public_gates
     and exists (select 1 from stores where status = 'open') then
    raise exception 'launch_disarm_blocked: a storefront is open';
  end if;
  return new;
end $$;


--
-- Name: assert_lifecycle_change_sanctioned(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_lifecycle_change_sanctioned() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_col   text;
  v_draft text;
  v_old   text;
  v_new   text;
begin
  if current_setting('is_superuser') = 'on' then return new; end if;
  if current_setting('milkpop.publication_rpc', true) = '1' then return new; end if;

  select col, draft into v_col, v_draft from (values
    ('menu_items',    'available', 'false'),
    ('deals',         'active',    'false'),
    ('news_posts',    'status',    'draft'),
    ('job_vacancies', 'status',    'draft')
  ) as t(tbl, col, draft) where t.tbl = TG_TABLE_NAME;

  v_new := row_to_json(new)::jsonb ->> v_col;
  if TG_OP = 'INSERT' then
    if v_new is distinct from v_draft then
      raise exception
        'lifecycle_change_refused: a new % row must be born a draft — % moves only '
        'through publish_record%', TG_TABLE_NAME, v_col,
        case when TG_TABLE_NAME = 'job_vacancies' then ' or close_vacancy' else '' end
        using errcode = 'insufficient_privilege';
    end if;
  else
    v_old := row_to_json(old)::jsonb ->> v_col;
    if v_new is distinct from v_old then
      raise exception
        'lifecycle_change_refused: %.% moves only through publish_record%',
        TG_TABLE_NAME, v_col,
        case when TG_TABLE_NAME = 'job_vacancies' then ' or close_vacancy' else '' end
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;


--
-- Name: assert_menu_publish_allowed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_menu_publish_allowed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if new.available and (tg_op = 'INSERT' or not old.available) then
    perform assert_launch_ready('menu_publish', 'menu_publish_blocked');
  end if;
  return new;
end $$;


--
-- Name: assert_news_slug_discipline(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_news_slug_discipline() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_base text;
  v_candidate text;
begin
  -- Immutability: once a slug exists it never changes and never empties.
  if TG_OP = 'UPDATE' and old.slug is not null
     and new.slug is distinct from old.slug then
    raise exception
      'news_slug_immutable: the address of a published post is frozen — edit the title, not the slug (post %)',
      old.id
      using errcode = 'check_violation';
  end if;

  -- Stamp exactly once: the row is becoming (or arriving) published with no
  -- slug yet. Everything else passes through untouched.
  if new.status = 'published' and new.slug is null then
    v_base := news_slugify(new.title);
    if v_base = '' then v_base := news_slugify(new.id); end if;
    v_candidate := v_base;
    if exists (select 1 from news_posts where slug = v_candidate and id <> new.id) then
      v_candidate := left(v_base, 75) || '-' || right(new.id, 4);
    end if;
    if exists (select 1 from news_posts where slug = v_candidate and id <> new.id) then
      raise exception
        'news_slug_collision: % is already the address of another post — retitle one of them',
        v_candidate
        using errcode = 'unique_violation';
    end if;
    new.slug := v_candidate;
  end if;

  return new;
end $$;


--
-- Name: assert_notice_immutability(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_notice_immutability() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: assert_public_form_accept_allowed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_public_form_accept_allowed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_kind       text;
  v_irrelevant text[];
  v_blocking   text[];
begin
  -- 1. Which form is this? Derived from the table the trigger fired on, so a new
  --    form table cannot silently inherit another form's notice requirement.
  v_kind := case TG_TABLE_NAME
              when 'job_applications'    then 'careers'
              when 'franchise_inquiries' then 'franchise'
              when 'contact_messages'    then 'contact'
            end;

  if v_kind is null then
    raise exception
      'form_accept_unknown_form: % is not a recognised public form table. Add it to '
      'assert_public_form_accept_allowed() with its notice kind before accepting '
      'submissions.', TG_TABLE_NAME
      using errcode = 'raise_exception';
  end if;

  -- 2. The OTHER two notices are irrelevant to this submission.
  v_irrelevant := array(
    select 'privacy_notice_' || k
      from unnest(array['careers', 'franchise', 'contact']) as k
     where k <> v_kind);

  -- 3. Ask the ONE definition, then subtract only what does not apply. Every
  --    other form_accept blocker is still enforced.
  select array_agg(r.key order by r.key)
    into v_blocking
    from launch_blocking_reasons() r
   where r.state = 'incomplete'
     and 'form_accept' = any(r.blocks)
     and r.key <> all(v_irrelevant);

  if v_blocking is not null then
    raise exception 'form_accept_blocked: %', array_to_string(v_blocking, ', ')
      using errcode = 'check_violation';
  end if;

  return new;
end $$;


--
-- Name: FUNCTION assert_public_form_accept_allowed(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.assert_public_form_accept_allowed() IS 'R4.10: each public form requires only its OWN privacy notice. The form kind comes from TG_TABLE_NAME; the readiness rules still come from launch_blocking_reasons(), filtered rather than restated, so notification_recipient and every other shared blocker still apply.';


--
-- Name: assert_public_record_valid(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_public_record_valid() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_public  boolean;
  v_errors  text[];
begin
  if current_setting('is_superuser') = 'on' then return new; end if;

  -- Field access via jsonb, NOT static record references: a plpgsql CASE is
  -- compiled as ONE SQL expression, so `new.active` in an untaken branch
  -- still fails to parse against a menu_items row. (Found by the real-role
  -- matrix on first contact — the lifecycle guard below already used the
  -- json form for the same reason.)
  v_public := case TG_TABLE_NAME
    when 'menu_items'    then (to_jsonb(new)->>'available')::boolean
    when 'deals'         then (to_jsonb(new)->>'active')::boolean
    when 'news_posts'    then (to_jsonb(new)->>'status') = 'published'
    when 'job_vacancies' then (to_jsonb(new)->>'status') = 'published'
  end;

  if coalesce(v_public, false) then
    v_errors := publication_candidate_errors(TG_TABLE_NAME, to_jsonb(new));
    if coalesce(array_length(v_errors, 1), 0) > 0 then
      raise exception 'publish_blocked_incomplete: % % — %',
        TG_TABLE_NAME, new.id, array_to_string(v_errors, '; ')
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;


--
-- Name: assert_published_delete_refused(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_published_delete_refused() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare v_public boolean;
begin
  if current_setting('is_superuser') = 'on' then return old; end if;
  v_public := case TG_TABLE_NAME
    when 'menu_items'    then (to_jsonb(old)->>'available')::boolean
    when 'deals'         then (to_jsonb(old)->>'active')::boolean
    when 'news_posts'    then (to_jsonb(old)->>'status') = 'published'
    when 'job_vacancies' then (to_jsonb(old)->>'status') = 'published'
  end;
  if coalesce(v_public, false) then
    raise exception
      'published_delete_refused: "%" is live on the public site — unpublish it first, '
      'then delete the draft', old.id
      using errcode = 'check_violation';
  end if;
  return old;
end $$;


--
-- Name: assert_singleton_write_sanctioned(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_singleton_write_sanctioned() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if current_setting('is_superuser') = 'on' then
    if TG_OP = 'DELETE' then return old; end if;
    return new;
  end if;

  if TG_OP = 'DELETE' then
    raise exception
      'singleton_delete_refused: % is a configuration singleton — it is never deleted',
      TG_TABLE_NAME
      using errcode = 'check_violation';
  end if;

  if current_setting('milkpop.singleton_rpc', true) = '1' then
    if TG_OP = 'DELETE' then return old; end if;
    return new;
  end if;

  raise exception
    'singleton_write_refused: % is written only through its save RPC '
    '(save_website_studio / save_launch_settings), which verifies the '
    'expected revision and records the audit row in the same transaction',
    TG_TABLE_NAME
    using errcode = 'check_violation';
end $$;


--
-- Name: assert_store_open_allowed(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_store_open_allowed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare v_missing text[] := '{}';
begin
  if new.status = 'open' then
    if coalesce(trim(new.address),'') = '' then v_missing := v_missing || 'store_address'::text; end if;
    if coalesce(trim(new.opening_hours),'') = '' then v_missing := v_missing || 'opening_hours'::text; end if;
    if array_length(v_missing,1) is not null then
      raise exception 'store_open_blocked: missing %', array_to_string(v_missing, ', ');
    end if;
    perform assert_launch_ready('store_open', 'store_open_blocked');
  end if;
  return new;
end $$;


--
-- Name: FUNCTION assert_store_open_allowed(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.assert_store_open_allowed() IS 'R4.10: an open storefront must be valid on EVERY write whose final state is open — address, opening hours, and the global store_open context. The transition-only check let an already-open store degrade through updates that never mentioned status.';


--
-- Name: audit_logs_stamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.audit_logs_stamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_id   text;
  v_name text;
  v_role text;
begin
  -- Byte-faithful to the Stage-11 original except the final assignment:
  -- the timestamp column is now timestamptz, so now() is assigned directly.
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;  -- server-written rows carry their own derived actor
  end if;
  v_id := current_staff_id();
  if v_id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  select name, role::text into v_name, v_role from staff_profiles where id = v_id;
  new.operator_name := coalesce(v_name, v_id);
  new.role          := coalesce(v_role, '');
  new."timestamp"   := now();
  return new;
end $$;


--
-- Name: begin_quote_payment(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.begin_quote_payment(p_payment jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff    text := current_staff_id();
  v_me       staff_profiles%rowtype;
  v_quote_id text := p_payment ->> 'quoteId';
  v_res_id   text := p_payment ->> 'reservationId';
  v_method   text := p_payment ->> 'method';
  v_device   text := nullif(trim(coalesce(p_payment ->> 'deviceId','')), '');
  v_secret   text := nullif(p_payment ->> 'deviceSecret', '');
  v_session  text := nullif(trim(coalesce(p_payment ->> 'cashSessionId','')), '');
  v_term_in  text := nullif(trim(coalesce(p_payment ->> 'terminalConfigId','')), '');
  v_acct_in  text := nullif(trim(coalesce(p_payment ->> 'onlineAccountId','')), '');
  v_override text := nullif(trim(coalesce(p_payment ->> 'overrideReason','')), '');
  v_hash     text;
  v_q        order_quotes%rowtype;
  v_o        orders%rowtype;
  v_store    stores%rowtype;
  v_dev      web_till_devices%rowtype;
  v_sess     web_till_sessions%rowtype;
  v_term     payment_terminals%rowtype;
  v_acct     online_payment_accounts%rowtype;
  v_today    date;
  v_created_day date;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if v_res_id is null or length(v_res_id) < 6 then
    raise exception 'invalid_reservation';
  end if;

  select * into v_q from order_quotes where id = v_quote_id for update;
  if v_q.id is null then raise exception 'unknown_quote'; end if;
  if v_q.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;

  -- The CANONICAL reservation identity: SHA-256 over the canonical JSON of
  -- the SUPPLIED request. The operator is derived server-side, never accepted
  -- from the payload; replaying the identity with any different fact is a
  -- different claim and conflicts.
  v_hash := canonical_request_hash(jsonb_build_object(
    'op', 'begin_quote_payment', 'quoteId', v_quote_id, 'reservationId', v_res_id,
    'method', v_method, 'deviceId', v_device, 'cashSessionId', v_session,
    'terminalConfigId', v_term_in, 'onlineAccountId', v_acct_in,
    'operatorStaffId', v_staff));

  -- A reservation identity is global and permanent: it can never be recycled,
  -- and a released attempt can never be reopened.
  if exists (select 1 from quote_payment_attempts a where a.reservation_id = v_res_id) then
    declare v_a quote_payment_attempts%rowtype;
    begin
      select * into v_a from quote_payment_attempts where reservation_id = v_res_id;
      if v_a.quote_id is distinct from v_q.id then
        raise exception 'idempotency_conflict' using errcode = '42501',
          detail = 'That reservation identity belongs to another quote.';
      end if;
      if v_a.request_hash is distinct from v_hash then
        raise exception 'idempotency_conflict' using errcode = '42501',
          detail = 'The same reservation was replayed with different payment facts.';
      end if;
      if v_a.state in ('DECLINED','ABANDONED') then
        raise exception 'reservation_released' using errcode = '42501',
          detail = 'That attempt was released; a new attempt needs a new reservation id.';
      end if;
      if v_a.state = 'CONSUMED' then
        -- The completed order is returned only to the operator who took the
        -- payment, or to an audited manager/owner override (correction 8).
        if v_a.operator_staff_id is distinct from v_staff then
          if v_override is null or not is_manager_or_owner() then
            raise exception 'operator_scope_denied' using errcode = '42501',
              detail = 'Another operator''s payment; a manager/owner override with a reason is required.';
          end if;
          perform log_payment_authority_event('payment_override:begin_replay', jsonb_build_object(
            'quoteId', v_q.id, 'reservationId', v_res_id, 'operator', v_a.operator_staff_id,
            'overriddenBy', v_staff, 'reason', v_override));
        end if;
        select * into v_o from orders where quote_id = v_q.id;
        return jsonb_build_object('quote', to_jsonb(v_q), 'order', to_jsonb(v_o),
                                  'state', 'already_consumed');
      end if;
      return jsonb_build_object('quote', to_jsonb(v_q), 'state', 'reserved', 'duplicate', true);
    end;
  end if;

  if v_q.status = 'CONSUMED' then
    -- EXACT-ATTEMPT REPLAY (finding 1/2): reaching here means NO attempt carries
    -- the supplied reservation — the matching-attempt branch above already
    -- returned the real order. A wrong reservation is refused; a reservation
    -- that matches the quote's own field but has NO consumed attempt behind it
    -- is an inconsistent ledger. We FAIL CLOSED and NEVER hand back an order
    -- from the quote's reservation field alone.
    if v_res_id is distinct from v_q.reservation_id then
      raise exception 'invalid_reservation' using errcode = '42501',
        detail = 'That reservation is not the one this order was paid under.';
    end if;
    raise exception 'payment_state_inconsistent' using errcode = '42501',
      detail = 'This consumed quote has no matching consumed payment attempt.';
  end if;
  if v_q.status in ('EXPIRED','CANCELLED') then
    raise exception 'quote_not_open';
  end if;
  if v_q.status = 'NEEDS_RECONCILIATION' then
    raise exception 'quote_needs_reconciliation'
      using detail = 'This quote is awaiting privileged payment reconciliation.';
  end if;
  if v_q.status = 'PAYMENT_PENDING' then
    -- A second tab or device must not take over a payment that may already
    -- be in progress on the first. (An identity replay was handled above.)
    raise exception 'payment_already_pending' using errcode = '42501',
      detail = 'This quote already has an active payment reservation.';
  end if;

  -- Only the operator who priced the basket reserves it; anyone else needs
  -- an audited manager/owner override (correction 3).
  if v_q.staff_id is distinct from v_staff then
    if v_override is null or not is_manager_or_owner() then
      raise exception 'operator_scope_denied' using errcode = '42501',
        detail = 'Another operator''s quote; a manager/owner override with a reason is required.';
    end if;
    perform log_payment_authority_event('payment_override:begin', jsonb_build_object(
      'quoteId', v_q.id, 'creator', v_q.staff_id, 'overriddenBy', v_staff, 'reason', v_override));
  end if;

  -- Expiry is DERIVED and refused here; the persisted EXPIRED status is
  -- bookkeeping written by expire_stale_quotes() in its own transaction.
  if now() > v_q.expires_at then
    raise exception 'quote_expired'
      using detail = 'Re-price the basket before taking payment.';
  end if;

  -- Config/VAT revalidation (correction 2): the store must still be in
  -- EXACTLY the configuration the quote priced under, and the VAT charging
  -- boundary must not have been crossed since pricing.
  select * into v_store from stores where id = v_q.store_id;
  if store_config_fingerprint(v_store) is distinct from v_q.config_version then
    raise exception 'quote_config_stale'
      using detail = 'The store configuration changed after quoting; re-price the basket.';
  end if;
  v_today       := (now() at time zone v_store.timezone)::date;
  v_created_day := (v_q.created_at at time zone v_store.timezone)::date;
  if v_q.store_vat_status = 'REGISTERED'
     and v_q.vat_effective_date is not null
     and v_q.vat_effective_date > v_created_day
     and v_q.vat_effective_date <= v_today then
    raise exception 'quote_config_stale'
      using detail = 'The VAT charging boundary was crossed after quoting; re-price the basket.';
  end if;

  -- The payment ROUTE is validated and bound HERE, before any money moves.
  if v_method is null or v_method not in ('cash','card','online')
     or not (v_q.allowed_payment_methods ? v_method) then
    raise exception 'payment_method_not_accepted';
  end if;

  if v_method = 'cash' then
    if v_term_in is not null or v_acct_in is not null then
      raise exception 'payment_route_invalid'
        using detail = 'A cash reservation names a device and session, nothing else.';
    end if;
    if v_device is null or v_session is null then
      raise exception 'till_session_required'
        using detail = 'Cash may only be reserved against an open till session on an enrolled device.';
    end if;
    select * into v_dev from web_till_devices where id = v_device;
    if v_dev.id is null or v_dev.credential_hash is null then
      raise exception 'device_not_enrolled' using errcode = '42501',
        detail = 'Cash custody requires a device enrolled by a manager or owner.';
    end if;
    if v_dev.revoked then
      raise exception 'till_device_revoked' using errcode = '42501';
    end if;
    if v_dev.store_id is distinct from v_q.store_id then
      raise exception 'device_store_mismatch' using errcode = '42501';
    end if;
    -- DEVICE CREDENTIAL ON THE CASH OP (finding 1): the enrolled device pairing
    -- secret must be re-presented for this reservation, not only at session
    -- open, so a captured session/device id alone cannot move cash.
    if v_secret is null
       or encode(sha256(convert_to(v_secret, 'utf8')), 'hex') is distinct from v_dev.credential_hash then
      raise exception 'device_credential_invalid' using errcode = '42501',
        detail = 'The device pairing secret is required to reserve cash on this device.';
    end if;
    -- LOCKING the session here closes the close-vs-begin race (correction 1 /
    -- finding 12): a concurrent close_till_session() serialises against this
    -- row lock, so a new cash attempt can never slip under a closing drawer.
    select * into v_sess from web_till_sessions where id = v_session for update;
    if v_sess.id is null or v_sess.status <> 'OPEN' then
      raise exception 'till_session_not_open';
    end if;
    if v_sess.store_id is distinct from v_q.store_id then
      raise exception 'till_session_store_mismatch' using errcode = '42501';
    end if;
    if v_sess.device_id is distinct from v_device then
      raise exception 'till_session_device_mismatch' using errcode = '42501';
    end if;

  elsif v_method = 'card' then
    if v_device is not null or v_session is not null or v_acct_in is not null then
      raise exception 'payment_route_invalid'
        using detail = 'A card-present reservation names a registered terminal, nothing else.';
    end if;
    if v_term_in is not null then
      select * into v_term from payment_terminals where id = v_term_in;
      if v_term.id is null then
        raise exception 'unknown_terminal';
      end if;
    else
      select * into v_term from payment_terminals
       where store_id = v_q.store_id and status = 'ACTIVE';
      if v_term.id is null then
        raise exception 'unknown_terminal'
          using detail = 'No registered card terminal for this store.';
      end if;
      if (select count(*) from payment_terminals
           where store_id = v_q.store_id and status = 'ACTIVE') > 1 then
        raise exception 'terminal_ambiguous'
          using detail = 'This store has several terminals; the till must name the one that will take the payment.';
      end if;
    end if;
    if v_term.status <> 'ACTIVE' then
      raise exception 'terminal_not_active';
    end if;
    if v_term.store_id is distinct from v_q.store_id then
      raise exception 'terminal_store_mismatch' using errcode = '42501',
        detail = 'That terminal belongs to another store.';
    end if;

  else -- online
    if v_device is not null or v_session is not null or v_term_in is not null then
      raise exception 'payment_route_invalid'
        using detail = 'An online reservation names a registered provider account, nothing else.';
    end if;
    if v_acct_in is not null then
      select * into v_acct from online_payment_accounts where id = v_acct_in;
      if v_acct.id is null then
        raise exception 'unknown_online_account';
      end if;
    else
      select * into v_acct from online_payment_accounts
       where store_id = v_q.store_id and status = 'ACTIVE';
      if v_acct.id is null then
        raise exception 'unknown_online_account'
          using detail = 'No registered online payment account for this store.';
      end if;
      if (select count(*) from online_payment_accounts
           where store_id = v_q.store_id and status = 'ACTIVE') > 1 then
        raise exception 'online_account_ambiguous';
      end if;
    end if;
    if v_acct.status <> 'ACTIVE' then
      raise exception 'online_account_not_active';
    end if;
    if v_acct.store_id is distinct from v_q.store_id then
      raise exception 'online_account_store_mismatch' using errcode = '42501';
    end if;
  end if;

  -- A previous decline stays on the record: released_at / release_reason are
  -- deliberately NOT cleared when a new attempt begins.
  insert into quote_payment_attempts
    (reservation_id, quote_id, store_id, payment_method, device_id,
     cash_session_id, terminal_config_id, online_account_id,
     operator_staff_id, request_hash, state)
  values (v_res_id, v_q.id, v_q.store_id, v_method, v_device,
          v_session, v_term.id, v_acct.id, v_staff, v_hash, 'PENDING');

  update order_quotes
     set status = 'PAYMENT_PENDING', payment_started_at = now(),
         reservation_id = v_res_id, reservation_hash = v_hash
   where id = v_q.id
  returning * into v_q;

  return jsonb_build_object(
    'quote', to_jsonb(v_q), 'state', 'reserved', 'duplicate', false,
    'binding', jsonb_strip_nulls(jsonb_build_object(
      'method', v_method, 'deviceId', v_device, 'cashSessionId', v_session,
      'terminalConfigId', v_term.id, 'onlineAccountId', v_acct.id)));
end $$;


--
-- Name: staff_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_profiles (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    role public.employee_role DEFAULT 'team_member'::public.employee_role NOT NULL,
    store_id text,
    store_name text DEFAULT ''::text NOT NULL,
    next_shift text DEFAULT ''::text NOT NULL,
    holiday_balance numeric(5,1) DEFAULT 28 NOT NULL,
    points integer DEFAULT 0 NOT NULL,
    level integer DEFAULT 1 NOT NULL,
    badges jsonb DEFAULT '[]'::jsonb NOT NULL,
    avatar text DEFAULT ''::text NOT NULL,
    pay_rate numeric(10,2),
    pay_type text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    onboarding text DEFAULT 'profile_created'::text NOT NULL,
    invited_at timestamp with time zone,
    employment_end_date date,
    employment_end_reason text,
    employment_end_notes text,
    ended_at timestamp with time zone,
    ended_by_staff_id text,
    payroll_export_note text,
    CONSTRAINT staff_active_requires_store CHECK (((role = 'owner'::public.employee_role) OR (status IS DISTINCT FROM 'active'::text) OR (store_id IS NOT NULL))),
    CONSTRAINT staff_profiles_onboarding_check CHECK ((onboarding = ANY (ARRAY['profile_created'::text, 'invited'::text, 'active'::text]))),
    CONSTRAINT staff_profiles_pay_type_check CHECK ((pay_type = ANY (ARRAY['hourly'::text, 'salary'::text]))),
    CONSTRAINT staff_profiles_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);


--
-- Name: COLUMN staff_profiles.auth_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staff_profiles.auth_id IS 'Links this profile to a Supabase Auth user (auth.users.id). Null until the staff member completes sign-in onboarding. Set by the Block B auth flow, never by the client directly (see the self-update policy in section 4).';


--
-- Name: bootstrap_owner(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bootstrap_owner(target_email text, target_name text DEFAULT 'Owner'::text) RETURNS public.staff_profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  result staff_profiles;
begin
  if exists (select 1 from staff_profiles where role = 'owner') then
    raise exception 'an owner already exists; refusing to create another via bootstrap';
  end if;

  insert into staff_profiles (id, name, email, role, store_name)
  values ('owner_' || substr(md5(random()::text), 1, 8),
          target_name, lower(target_email), 'owner', 'HQ')
  returning * into result;

  return result;
end $$;


--
-- Name: FUNCTION bootstrap_owner(target_email text, target_name text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.bootstrap_owner(target_email text, target_name text) IS 'ONE-TIME first-owner creation, run from the SQL editor. Refuses if any owner already exists. Not callable by anon or authenticated roles.';


--
-- Name: bump_collection_revision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_collection_revision() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  insert into collection_revisions as cr (table_key, revision, updated_at)
  values (TG_TABLE_NAME, 1, now())
  on conflict (table_key) do update
    set revision = cr.revision + 1, updated_at = now();
  return null;  -- AFTER trigger; the row itself is untouched
end $$;


--
-- Name: cancel_order_quote(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_order_quote(p_quote jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff    text := current_staff_id();
  v_me       staff_profiles%rowtype;
  v_q        order_quotes%rowtype;
  v_override text := nullif(trim(coalesce(p_quote ->> 'overrideReason','')), '');
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_q from order_quotes where id = p_quote ->> 'quoteId' for update;
  if v_q.id is null then raise exception 'unknown_quote'; end if;
  if v_q.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;
  if v_q.staff_id is distinct from v_staff then
    if v_override is null or not is_manager_or_owner() then
      raise exception 'operator_scope_denied' using errcode = '42501',
        detail = 'Another operator''s quote; a manager/owner override with a reason is required.';
    end if;
    perform log_payment_authority_event('payment_override:cancel', jsonb_build_object(
      'quoteId', v_q.id, 'creator', v_q.staff_id, 'overriddenBy', v_staff, 'reason', v_override));
  end if;
  if v_q.status = 'CONSUMED' then raise exception 'quote_already_consumed'; end if;
  if v_q.status = 'CANCELLED' then
    -- Idempotent replay (correction 9): the historical cancellation time is
    -- never rewritten by a repeated request.
    return jsonb_build_object('quote', to_jsonb(v_q), 'duplicate', true);
  end if;
  -- Cancellation is restricted to OPEN (correction 4). A PAYMENT_PENDING
  -- quote may already have taken the customer's money: it must be finalised,
  -- definitely released, or moved into reconciliation — never destroyed.
  if v_q.status = 'PAYMENT_PENDING' then
    raise exception 'quote_payment_pending' using errcode = '42501',
      detail = 'An active payment reservation must be finalised, released, or reconciled — it cannot be cancelled away.';
  end if;
  if v_q.status = 'NEEDS_RECONCILIATION' then
    raise exception 'quote_needs_reconciliation'
      using detail = 'This quote is awaiting privileged payment reconciliation.';
  end if;
  if v_q.status <> 'OPEN' then
    raise exception 'quote_not_open';
  end if;
  update order_quotes set status = 'CANCELLED', cancelled_at = now()
   where id = v_q.id returning * into v_q;
  return jsonb_build_object('quote', to_jsonb(v_q), 'duplicate', false);
end $$;


--
-- Name: canonical_request_hash(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.canonical_request_hash(p jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select encode(sha256(convert_to(jsonb_strip_nulls(p)::text, 'utf8')), 'hex');
$$;


--
-- Name: cert_requires_pass(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cert_requires_pass() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (
    select 1 from training_results r
    where r.employee_id = new.employee_id
      and r.assessment_id = new.assessment_id
      and r.passed
  ) then
    raise exception 'certificate_without_passing_result';
  end if;
  return new;
end $$;


--
-- Name: media_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bucket text NOT NULL,
    storage_path text NOT NULL,
    public_url text,
    mime_type text NOT NULL,
    size_bytes integer NOT NULL,
    width integer,
    height integer,
    alt_text text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    uploaded_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attached_at timestamp with time zone,
    cleanup_after timestamp with time zone,
    cleanup_attempts integer DEFAULT 0 NOT NULL,
    last_cleanup_error text,
    CONSTRAINT media_objects_size_bytes_check CHECK (((size_bytes > 0) AND (size_bytes <= 512000))),
    CONSTRAINT media_objects_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'attached'::text, 'cleanup_pending'::text, 'cleanup_failed'::text, 'deleted'::text])))
);


--
-- Name: TABLE media_objects; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.media_objects IS 'WP04R: technical Storage registry (NOT the Media Library — that is the legacy media_assets table). Lifecycle: pending → attached → cleanup_pending → deleted, with cleanup_failed as the retry state. Written only via Edge Functions / SECURITY DEFINER RPCs.';


--
-- Name: claim_media_cleanup_batch(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_media_cleanup_batch(p_limit integer DEFAULT 20) RETURNS SETOF public.media_objects
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  r media_objects%rowtype;
begin
  for r in
    select * from media_objects
     where status in ('cleanup_pending','cleanup_failed')
       and coalesce(cleanup_after, now()) <= now()
     order by cleanup_after nulls first
     limit greatest(p_limit, 1)
     for update skip locked
  loop
    if media_path_is_referenced(r.storage_path, r.public_url) then
      update media_objects set status = 'attached', cleanup_after = null where id = r.id;
      continue;
    end if;
    return next r;
  end loop;
end;
$$;


--
-- Name: claim_recovery_intent(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_recovery_intent(p_intent_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor  text := current_staff_id();
  v_intent admin_recovery_intents;
  v_target staff_profiles;
  v_deny   text;
begin
  if v_actor is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;

  -- The lock is the whole point: a second caller waits here and then sees the
  -- consumed row, instead of both reading an unconsumed one and both acting.
  select * into v_intent from admin_recovery_intents
   where id = p_intent_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'intent_not_found'); end if;
  if v_intent.consumed_at is not null then
    return jsonb_build_object('ok', false, 'error', 'intent_already_consumed');
  end if;
  if now() - v_intent.created_at > interval '10 minutes' then
    update admin_recovery_intents set consumed_at = now(), result = 'expired' where id = p_intent_id;
    return jsonb_build_object('ok', false, 'error', 'intent_expired');
  end if;

  -- Only the person who requested it may execute it.
  if v_intent.requested_by is distinct from v_actor then
    return jsonb_build_object('ok', false, 'error', 'not_requester');
  end if;

  -- RE-AUTHORISATION. Same predicate, evaluated now: still employed, still the
  -- right role, still AAL2, still the same store, target still eligible.
  v_deny := recovery_action_permitted(v_intent.target_staff_id, v_intent.action, v_intent.reason);
  if v_deny is not null then
    update admin_recovery_intents set consumed_at = now(), result = 'refused:' || v_deny
     where id = p_intent_id;
    return jsonb_build_object('ok', false, 'error', v_deny);
  end if;

  select * into v_target from staff_profiles where id = v_intent.target_staff_id;
  if v_target.auth_id is null then
    update admin_recovery_intents set consumed_at = now(), result = 'no_auth_account' where id = p_intent_id;
    return jsonb_build_object('ok', false, 'error', 'target_has_no_auth_account');
  end if;

  update admin_recovery_intents
     set consumed_at = now(), result = 'claimed'
   where id = p_intent_id;

  return jsonb_build_object('ok', true, 'action', v_intent.action,
                            'target_staff_id', v_intent.target_staff_id,
                            'target_auth_id', v_target.auth_id,
                            'requested_by', v_intent.requested_by);
end $$;


--
-- Name: FUNCTION claim_recovery_intent(p_intent_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.claim_recovery_intent(p_intent_id text) IS 'R4.9 G6: locks the intent, re-evaluates recovery_action_permitted() at execution time and consumes it atomically. The Edge Function performs no Auth Admin call unless this returns ok:true.';


--
-- Name: claim_shift(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_shift(p_shift_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff   text := current_staff_id();
  v_me      staff_profiles%rowtype;
  v_shift   work_shifts%rowtype;
  v_covers  jsonb;
  v_new_id  text := 'shift_' || replace(gen_random_uuid()::text, '-', '');
  v_new     work_shifts%rowtype;
begin
  if v_staff is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  select * into v_me from staff_profiles where id = v_staff;

  -- Lock the covers document FIRST (stable lock order: covers → shift), then
  -- the shift row. Everything below is one serialised critical section.
  select value into v_covers
    from app_state where key = 'milkpop_shift_covers' for update;
  if v_covers is null or not (v_covers ? p_shift_id) then
    raise exception 'not_open_for_cover';
  end if;

  select * into v_shift from work_shifts where id = p_shift_id for update;
  if v_shift.id is null then
    -- Advertised but already gone: tidy the stale advert and report cleanly.
    update app_state set value = v_covers - p_shift_id, updated_at = now()
     where key = 'milkpop_shift_covers';
    raise exception 'not_open_for_cover';
  end if;

  if v_shift.employee_id = v_staff then
    raise exception 'own_shift';
  end if;
  -- Store scope: you can only cover shifts at your own store (a shift with no
  -- store set is claimable by anyone — matches the rota's behaviour).
  if v_shift.store_id is not null
     and coalesce(v_me.store_id, '') <> v_shift.store_id then
    raise exception 'wrong_store' using errcode = '42501';
  end if;
  -- Schedule overlap: HH:MM strings compare correctly as text.
  if exists (select 1 from work_shifts w
              where w.employee_id = v_staff
                and w.date = v_shift.date
                and w.start_time < v_shift.end_time
                and w.end_time   > v_shift.start_time) then
    raise exception 'schedule_conflict';
  end if;

  insert into work_shifts
    (id, employee_id, employee_name, role, store_id, store_name,
     date, start_time, end_time, type, notes)
  values
    (v_new_id, v_staff, coalesce(v_me.name, ''), v_me.role,
     v_shift.store_id, v_shift.store_name,
     v_shift.date, v_shift.start_time, v_shift.end_time, v_shift.type,
     'Shift coverage claimed by ' || coalesce(v_me.name, v_staff))
  returning * into v_new;

  delete from work_shifts where id = p_shift_id;

  v_covers := v_covers - p_shift_id;
  update app_state set value = v_covers, updated_at = now()
   where key = 'milkpop_shift_covers';

  return jsonb_build_object(
    'newShift', to_jsonb(v_new),
    'removedShiftId', p_shift_id,
    'covers', v_covers);
end $$;


--
-- Name: storage_cleanup_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_cleanup_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bucket text NOT NULL,
    storage_path text NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storage_cleanup_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'failed'::text, 'done'::text, 'reconciled'::text])))
);


--
-- Name: TABLE storage_cleanup_jobs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.storage_cleanup_jobs IS 'WP01.1/WS9: durable deletion queue. An object listed here is awaiting a CONFIRMED Storage delete (2xx/404). Rows are written by Edge Functions and the WS9 retention sweeps only. claim_storage_cleanup_batch re-checks job_applications.cv_path at claim time: a referenced CV is closed as status=reconciled and is NEVER deleted; done = object confirmed gone.';


--
-- Name: claim_storage_cleanup_batch(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_storage_cleanup_batch(p_limit integer DEFAULT 20) RETURNS SETOF public.storage_cleanup_jobs
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  -- (a) Reconcile first: any due CV job whose object is REFERENCED right now
  --     is closed without deletion. This is the race-loser resolution the
  --     invariant requires — the upload's DB link won; the delete stands down.
  update storage_cleanup_jobs j
     set status = 'reconciled',
         last_error = 'referenced: job_applications.cv_path matches at claim time; object retained',
         updated_at = now()
   where j.bucket = 'cvs'
     and j.status in ('pending','failed')
     and j.next_attempt_at <= now()
     and exists (select 1 from job_applications a where a.cv_path = j.storage_path);

  -- (b) Claim only what is provably unreferenced AT THIS MOMENT. The guard is
  --     repeated inside the locked selection so a job re-referenced between
  --     (a) and (b) still cannot be handed out.
  return query
    update storage_cleanup_jobs j
       set status = 'processing', attempts = attempts + 1, updated_at = now()
     where j.id in (
       select s.id from storage_cleanup_jobs s
        where s.status in ('pending','failed')
          and s.next_attempt_at <= now()
          and not (
            s.bucket = 'cvs'
            and exists (select 1 from job_applications a where a.cv_path = s.storage_path)
          )
        order by s.next_attempt_at
        limit greatest(p_limit, 1)
        for update skip locked
     )
    returning j.*;
end;
$$;


--
-- Name: FUNCTION claim_storage_cleanup_batch(p_limit integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.claim_storage_cleanup_batch(p_limit integer) IS 'WS9: skip-locked claim for the cleanup worker WITH the claim-time CV reference re-check. A job whose cvs object is referenced by any job_applications.cv_path is closed as reconciled (never deleted); a reference-verification failure aborts the claim (nothing is deleted on uncertainty). Not client-callable.';


--
-- Name: classify_products(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.classify_products(p jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  e      jsonb;
  v_id   text;
  v_code text;
  v_n    int := 0;
begin
  if not is_owner() then
    raise exception 'owner_aal2_required' using errcode = '42501';
  end if;
  if p is null or jsonb_typeof(p) <> 'array'
     or jsonb_array_length(p) = 0 or jsonb_array_length(p) > 500 then
    raise exception 'invalid_classifications';
  end if;
  -- WS6i (finding 3): serialise against store registration. configure_store_setup
  -- counts unclassified products and then registers; without a shared lock the
  -- two checks run in separate transactions and could interleave. Both take
  -- this transaction-scoped lock, so completeness cannot be validated by one
  -- session while the other changes it.
  perform pg_advisory_xact_lock(hashtext('milkpop.vat_classification'));
  perform set_config('milkpop.tax_classify_rpc', '1', true);
  for e in select * from jsonb_array_elements(p) loop
    v_id   := e ->> 'id';
    v_code := e ->> 'taxCode';   -- json null = explicit unclassify
    if v_id is null then
      raise exception 'invalid_classifications';
    end if;
    if v_code is not null and not exists (select 1 from tax_codes where code = v_code) then
      raise exception 'invalid_tax_code';
    end if;
    -- WS6i (Round-9f findings 1/2/5): a classification, once set, is
    -- PERMANENT HISTORICAL METADATA. It may be changed to another controlled
    -- code, but never removed. The previous rule keyed on "currently
    -- charging", which let a product be unclassified under a FUTURE-dated
    -- registration and then broke by itself when the date arrived — no
    -- transaction exists at midnight to revalidate. Time can no longer move
    -- this database from a valid state to an invalid one.
    if v_code is null
       and exists (select 1 from menu_items where id = v_id and tax_code is not null)
    then
      raise exception 'tax_code_withdrawal_forbidden'
        using detail = 'A product''s VAT classification is permanent once set: change it to another code, or delete the product. It cannot be returned to unclassified.';
    end if;
    update menu_items set tax_code = v_code where id = v_id;
    if not found then
      raise exception 'unknown_menu_item';
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;


--
-- Name: close_till_session(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.close_till_session(p_session jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff    text := current_staff_id();
  v_me       staff_profiles%rowtype;
  v_row      web_till_sessions%rowtype;
  v_dev      web_till_devices%rowtype;
  v_secret   text := nullif(p_session ->> 'deviceSecret', '');
  v_override text := nullif(trim(coalesce(p_session ->> 'overrideReason','')), '');
  v_dev_ok   boolean;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  select * into v_row from web_till_sessions where id = p_session ->> 'id' for update;
  if v_row.id is null then raise exception 'unknown_session'; end if;
  if v_row.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;

  -- AUTHENTICATION FIRST (R3.1 audit correction). This DEFINER function
  -- bypasses the scoped read policy on till sessions, so NOTHING — including
  -- the idempotent CLOSED replay — may be returned before the caller proves
  -- authority. The device path accepts only an ENROLLED, UNREVOKED device of
  -- THIS session's store presenting the exact pairing secret (matching the
  -- reserve and finalise paths); the audited manager/owner + AAL2 +
  -- written-reason override remains the one alternative, and deliberately
  -- still works for a revoked or lost device.
  select * into v_dev from web_till_devices where id = v_row.device_id;
  v_dev_ok := v_secret is not null
          and v_dev.id is not null
          and v_dev.credential_hash is not null
          and not coalesce(v_dev.revoked, false)
          and v_dev.store_id = v_row.store_id
          and encode(sha256(convert_to(v_secret, 'utf8')), 'hex') = v_dev.credential_hash;
  if v_dev_ok then
    null;  -- the device proved itself
  elsif v_override is not null and length(v_override) >= 10
        and is_manager_or_owner() and is_aal2() then
    -- sessionStatus is recorded because, with authentication first, an
    -- override may legitimately fire on an already-CLOSED session (a
    -- privileged idempotent replay) without closing anything.
    perform log_payment_authority_event('till_session:close_override', jsonb_build_object(
      'sessionId', v_row.id, 'deviceId', v_row.device_id, 'sessionStatus', v_row.status,
      'closedBy', v_staff, 'reason', v_override));
  elsif v_secret is not null and v_dev.id is not null
        and v_dev.credential_hash is not null
        and coalesce(v_dev.revoked, false)
        and encode(sha256(convert_to(v_secret, 'utf8')), 'hex') = v_dev.credential_hash then
    -- The RIGHT secret for a REVOKED device: name the real reason, exactly
    -- as begin_quote_payment and finalise_order_payment_core do.
    raise exception 'till_device_revoked' using errcode = '42501',
      detail = 'This till device is revoked; a manager or owner override is required to close its drawer.';
  else
    raise exception 'device_credential_invalid' using errcode = '42501',
      detail = 'Closing a drawer requires the device pairing secret, or a manager/owner override with a written reason.';
  end if;

  -- Only now may session state be disclosed or changed.
  if v_row.status = 'CLOSED' then
    return jsonb_build_object('session', to_jsonb(v_row), 'duplicate', true);
  end if;
  -- A drawer must not close while a cash payment's outcome is unknown: the
  -- cashier may already hold the customer's money.
  if exists (select 1 from quote_payment_attempts a
              where a.cash_session_id = v_row.id and a.state = 'PENDING') then
    raise exception 'session_has_unresolved_payments' using errcode = '42501',
      detail = 'Resolve the outstanding cash payment before closing this drawer.';
  end if;

  update web_till_sessions
     set status = 'CLOSED', closed_by_staff_id = v_staff, closed_at = now()
   where id = v_row.id returning * into v_row;
  return jsonb_build_object('session', to_jsonb(v_row), 'duplicate', false);
end $$;


--
-- Name: close_vacancy(text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.close_vacancy(p_id text, p_expected_revision bigint) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare
  v_role   text;
  v_status text;
  v_rev    bigint;
begin
  v_role := current_staff_role();
  if v_role is null then
    raise exception 'close_vacancy: an active staff account is required'
      using errcode = 'insufficient_privilege';
  end if;
  if v_role <> 'owner' then
    raise exception 'close_vacancy: closing a vacancy requires the owner'
      using errcode = 'insufficient_privilege';
  end if;
  if not is_aal2() then
    raise exception 'close_vacancy: a verified second factor (AAL2) is required'
      using errcode = 'insufficient_privilege';
  end if;

  v_rev := collection_revision_checkpoint('job_vacancies');
  if p_expected_revision is null then
    raise exception 'collection_revision_required: state the revision your careers view was hydrated at'
      using errcode = 'check_violation';
  end if;
  if p_expected_revision <> v_rev then
    raise exception
      'collection_snapshot_stale: job_vacancies is at revision % but you hydrated %. '
      'Re-load the careers list and close from the current state.', v_rev, p_expected_revision
      using errcode = 'check_violation';
  end if;

  select status into v_status from job_vacancies where id = p_id for update;
  if not found then
    raise exception 'close_vacancy: no vacancy with id %', p_id using errcode = 'no_data_found';
  end if;
  if v_status = 'closed' then
    return jsonb_build_object('id', p_id, 'status', 'closed', 'revision', v_rev, 'idempotent', true);
  end if;
  if v_status <> 'published' then
    raise exception
      'close_vacancy: "%" is a draft — closing records that a LIVE vacancy ended; '
      'a draft is simply deleted', p_id
      using errcode = 'check_violation';
  end if;

  perform set_config('milkpop.publication_rpc', '1', true);
  update job_vacancies set status = 'closed' where id = p_id;

  insert into audit_logs (id, operator_name, role, action, timestamp, module,
                          previous_value, new_value)
  values ('aud_' || replace(gen_random_uuid()::text, '-', ''),
          coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', 'unknown'),
          v_role, 'close', now(), 'job_vacancies', 'published', 'closed');

  select revision into v_rev from collection_revisions where table_key = 'job_vacancies';
  return jsonb_build_object('id', p_id, 'status', 'closed', 'revision', v_rev);
end $$;


--
-- Name: collection_revision_checkpoint(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.collection_revision_checkpoint(p_table text) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare v_rev bigint;
begin
  insert into collection_revisions (table_key) values (p_table)
  on conflict (table_key) do nothing;
  select revision into v_rev
    from collection_revisions where table_key = p_table
    for update;
  return v_rev;
end $$;


--
-- Name: complete_training(text, integer, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_training(p_assessment_id text, p_score integer, p_submission_id text, p_assignment_id text DEFAULT NULL::text, p_answers jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff_id   text := current_staff_id();
  v_staff      staff_profiles%rowtype;
  v_assess     training_assessments%rowtype;
  v_assign     training_assignments%rowtype;
  v_course     training_courses%rowtype;
  v_existing   training_results%rowtype;
  v_cert       training_certificates%rowtype;
  v_new_cert   boolean := false;
  v_passed     boolean;
  v_points     int := 0;
  v_badge      text := '';
  v_score      int;
  v_response   jsonb;
begin
  -- 1. Authenticate: a LINKED, active staff member.
  if v_staff_id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  select * into v_staff from staff_profiles where id = v_staff_id;

  -- 2. Validate inputs.
  if coalesce(trim(p_submission_id), '') = '' or length(p_submission_id) > 120 then
    raise exception 'invalid_submission_id';
  end if;

  -- 3. Idempotency: the same submission returns the SAME confirmed result.
  select * into v_existing from training_results where submission_id = p_submission_id;
  if found then
    if v_existing.employee_id <> v_staff_id then
      raise exception 'not_your_submission' using errcode = '42501';
    end if;
    return v_existing.response;
  end if;

  -- 4. The assessment must exist; the assignment (when given) must be the
  --    caller's own and must point at this assessment.
  select * into v_assess from training_assessments where id = p_assessment_id;
  if v_assess.id is null then
    raise exception 'unknown_assessment';
  end if;
  if p_assignment_id is not null then
    select * into v_assign from training_assignments where id = p_assignment_id;
    if v_assign.id is null or v_assign.employee_id <> v_staff_id then
      raise exception 'not_your_assignment' using errcode = '42501';
    end if;
    if v_assign.assessment_id <> p_assessment_id then
      raise exception 'assignment_assessment_mismatch';
    end if;
  end if;

  -- 5. THE SCORE — FIX-9: graded HERE, always. The legacy client-score path
  --    is gone: null/malformed/short/long answer arrays are all rejected, and
  --    p_score is never read. The client cannot be the grading boundary.
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then
    raise exception 'answers_required';
  end if;
  if jsonb_array_length(p_answers) <> coalesce(jsonb_array_length(v_assess.questions), 0) then
    raise exception 'answers_count_mismatch';
  end if;
  v_score := grade_training_answers(v_assess.questions, p_answers);

  v_passed := v_score >= coalesce(v_assess.passing_score, 80);
  select * into v_course from training_courses
    where assessment_id = p_assessment_id or id = p_assessment_id
    limit 1;

  -- 6. Lift the reward lock for THIS transaction's own protected writes.
  perform set_config('milkpop.reward_grant', '1', true);

  -- 7. Attempt record (also the idempotency anchor via its unique key).
  insert into training_results (submission_id, employee_id, assessment_id, assignment_id, course_id, score, passed)
  values (p_submission_id, v_staff_id, p_assessment_id, p_assignment_id, v_course.id, v_score, v_passed);

  -- 8. Assignment completion (this employee's rows for this assessment only).
  if v_passed then
    update training_assignments
       set status = 'completed',
           completed_at = now(),
           score = greatest(coalesce(score, 0), v_score)
     where employee_id = v_staff_id
       and assessment_id = p_assessment_id
       and status <> 'completed';
  elsif p_assignment_id is not null and v_assign.status = 'assigned' then
    update training_assignments set status = 'in_progress' where id = p_assignment_id;
  end if;

  -- 9. Per-employee course progress.
  if v_course.id is not null and v_passed then
    insert into training_progress (id, employee_id, course_id, progress)
    values (v_staff_id || ':' || v_course.id, v_staff_id, v_course.id, 100)
    on conflict (id) do update set progress = 100, updated_at = now();
  end if;

  -- 10. Certificate — at most one per (employee, assessment), ever.
  if v_passed then
    insert into training_certificates (id, employee_id, employee_name, assessment_id, assessment_title, category, score)
    values (
      'MP-' || upper(substr(regexp_replace(p_assessment_id, '[^a-zA-Z0-9]', '', 'g') || 'MODULE', 1, 6))
            || '-' || upper(substr(md5(v_staff_id || ':' || p_assessment_id), 1, 8)),
      v_staff_id, coalesce(v_staff.name, ''), p_assessment_id,
      coalesce(v_assess.title, ''), coalesce(v_assess.category, ''), v_score
    )
    on conflict (employee_id, assessment_id) do nothing;
    v_new_cert := found;
    select * into v_cert from training_certificates
      where employee_id = v_staff_id and assessment_id = p_assessment_id;

    -- 11. Reward exactly once — the first time the certificate is issued.
    if v_new_cert then
      v_points := coalesce(v_assess.points, 0);
      v_badge  := coalesce(v_assess.badge, '');
      update staff_profiles
         set points = points + v_points,
             level  = floor((points + v_points) / 500.0) + 1,
             badges = case
                        when v_badge = '' or badges @> to_jsonb(array[v_badge]) then badges
                        else badges || to_jsonb(array[v_badge])
                      end
       where id = v_staff_id;
      select * into v_staff from staff_profiles where id = v_staff_id;
    end if;
  end if;

  -- 12. Server-side audit row (actor derived here, never from the client).
  insert into audit_logs (id, operator_name, role, action, timestamp, module, previous_value, new_value)
  values (
    'aud_' || replace(gen_random_uuid()::text, '-', ''),
    coalesce(v_staff.name, v_staff_id),
    coalesce(v_staff.role::text, ''),
    case when v_passed then 'Completed training assessment "' || coalesce(v_assess.title, p_assessment_id) || '" (' || v_score || '%, server-graded)'
         else 'Attempted training assessment "' || coalesce(v_assess.title, p_assessment_id) || '" (' || v_score || '%, server-graded, below pass mark)' end,
    now()::text,
    'Training Academy (server)',
    null,
    case when v_new_cert then 'certificate ' || v_cert.id || ', +' || v_points || ' pts' else null end
  );

  -- 13. The confirmed result — stored so a retry replays it verbatim.
  v_response := jsonb_build_object(
    'ok', true,
    'passed', v_passed,
    'score', v_score,
    'serverGraded', true,
    'passingScore', coalesce(v_assess.passing_score, 80),
    'newCertificate', v_new_cert,
    'certificate', case when v_cert.id is not null then to_jsonb(v_cert) end,
    'pointsAwarded', case when v_new_cert then v_points else 0 end,
    'badgeAwarded', case when v_new_cert and v_badge <> '' then v_badge end,
    'profilePoints', v_staff.points,
    'profileLevel', v_staff.level,
    'profileBadges', v_staff.badges,
    'courseId', v_course.id
  );
  update training_results set response = v_response where submission_id = p_submission_id;
  return v_response;
end $$;


--
-- Name: staff_compliance_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_compliance_records (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    employee_id text NOT NULL,
    compliance_type text NOT NULL,
    status public.compliance_status DEFAULT 'pending_verification'::public.compliance_status NOT NULL,
    issued_at date,
    verified_at timestamp with time zone,
    expires_at date,
    verified_by_staff_id text,
    document_id text,
    notes text DEFAULT ''::text NOT NULL,
    supersedes_id text,
    revoked_at timestamp with time zone,
    revoked_by_staff_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT compliance_no_self_verify CHECK (((verified_by_staff_id IS NULL) OR (verified_by_staff_id <> employee_id)))
);


--
-- Name: TABLE staff_compliance_records; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.staff_compliance_records IS 'R4.8 A1: authoritative compliance. UI labels derive from these rows only; a file upload alone never becomes verified.';


--
-- Name: compliance_effective_status(public.staff_compliance_records); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compliance_effective_status(rec public.staff_compliance_records) RETURNS public.compliance_status
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select case
    when rec.revoked_at is not null                       then 'revoked'::compliance_status
    when rec.status in ('rejected','not_applicable',
                        'pending_verification',
                        'not_recorded')                   then rec.status
    when rec.expires_at is not null
         and rec.expires_at < current_date               then 'expired'::compliance_status
    when rec.expires_at is not null
         and rec.expires_at < current_date + 42          then 'expiring'::compliance_status
    else rec.status
  end;
$$;


--
-- Name: compliance_record_revoke(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compliance_record_revoke(p_record_id text, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare v_actor text := current_staff_id();
begin
  if v_actor is null or not is_manager_or_owner() then raise exception 'not_permitted'; end if;
  update staff_compliance_records
     set status = 'revoked', revoked_at = now(), revoked_by_staff_id = v_actor,
         notes = trim(notes || E'\nRevoked: ' || coalesce(p_reason,'')), updated_at = now()
   where id = p_record_id
     and (is_owner() or exists (select 1 from staff_profiles sp
            where sp.id = staff_compliance_records.employee_id
              and sp.store_id = current_staff_store()));
  if not found then raise exception 'not_permitted'; end if;
  insert into audit_logs (id, operator_name, role, action, timestamp, module, new_value)
  values (gen_random_uuid()::text, v_actor, current_staff_role()::text,
          'compliance.revoked', now()::text, 'Compliance', p_record_id);
  return jsonb_build_object('ok', true);
end $$;


--
-- Name: compliance_record_upsert(text, text, date, date, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compliance_record_upsert(p_employee_id text, p_type text, p_issued date, p_expires date, p_document_id text, p_notes text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare v_id text; v_actor text := current_staff_id();
begin
  if v_actor is null or not is_manager_or_owner() then
    raise exception 'not_permitted';
  end if;
  if not is_owner() then
    -- managers only within their own store
    if not exists (select 1 from staff_profiles
                    where id = p_employee_id and store_id = current_staff_store()) then
      raise exception 'not_permitted';
    end if;
  end if;
  v_id := gen_random_uuid()::text;
  insert into staff_compliance_records
    (id, employee_id, compliance_type, status, issued_at, expires_at, document_id, notes)
  values
    (v_id, p_employee_id, p_type, 'pending_verification', p_issued, p_expires,
     nullif(p_document_id,''), coalesce(p_notes,''));
  insert into audit_logs (id, operator_name, role, action, timestamp, module, new_value)
  values (gen_random_uuid()::text, v_actor, current_staff_role()::text,
          'compliance.record_created', now()::text, 'Compliance',
          p_employee_id || ':' || p_type);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;


--
-- Name: compliance_record_verify(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compliance_record_verify(p_record_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare r staff_compliance_records; v_actor text := current_staff_id();
begin
  select * into r from staff_compliance_records where id = p_record_id;
  if not found then raise exception 'not_found'; end if;
  if v_actor is null or not is_manager_or_owner() then raise exception 'not_permitted'; end if;
  if r.employee_id = v_actor then raise exception 'self_verification_forbidden'; end if;
  if not is_owner() and not exists (select 1 from staff_profiles
        where id = r.employee_id and store_id = current_staff_store()) then
    raise exception 'not_permitted';
  end if;
  update staff_compliance_records
     set status = 'verified', verified_at = now(),
         verified_by_staff_id = v_actor, updated_at = now()
   where id = p_record_id;
  insert into audit_logs (id, operator_name, role, action, timestamp, module, new_value)
  values (gen_random_uuid()::text, v_actor, current_staff_role()::text,
          'compliance.verified', now()::text, 'Compliance', p_record_id);
  return jsonb_build_object('ok', true);
end $$;


--
-- Name: configure_store_setup(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.configure_store_setup(p_config jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_store_id  text := p_config ->> 'storeId';
  v_tz        text := p_config ->> 'timezone';
  v_cur       text := p_config ->> 'currencyCode';
  v_methods   jsonb := p_config -> 'paymentMethods';
  v_footer    text := coalesce(p_config ->> 'receiptFooter', '');
  v_vat       jsonb := p_config -> 'vat';
  v_vstatus   text;
  v_vnumber   text;
  v_veff      date;
  v_uncls     int;
  v_row       stores%rowtype;
begin
  -- WS6i (finding 3): the SAME lock classify_products takes, so a registration
  -- and a classification change can never validate against each other's
  -- pre-state and both commit.
  perform pg_advisory_xact_lock(hashtext('milkpop.vat_classification'));
  -- Owner + MFA: is_owner() bakes aal2 in (FIX-8).
  if not is_owner() then
    raise exception 'owner_aal2_required' using errcode = '42501';
  end if;

  select * into v_row from stores where id = v_store_id;
  if v_row.id is null then
    raise exception 'unknown_store';
  end if;

  -- Timezone: must be a real IANA name — proven by asking PostgreSQL to use it.
  if v_tz is null or length(v_tz) < 1 or length(v_tz) > 64 then
    raise exception 'invalid_timezone';
  end if;
  -- WS6f (auditor F10): the LAUNCH-SUPPORTED vocabulary rules FIRST — the
  -- operator's actionable answer for any non-launch value is "unsupported",
  -- whether or not it happens to be a real IANA zone. Reporting/business-day
  -- logic is Europe/London and money display is GBP; widening either is a
  -- deliberate future migration (the CHECK constraints mirror this at the
  -- database).
  if v_tz <> 'Europe/London' then
    raise exception 'unsupported_timezone';
  end if;
  begin
    perform now() at time zone v_tz;   -- defense for the day the vocabulary widens
  exception when others then
    raise exception 'invalid_timezone';
  end;

  if v_cur is null or v_cur !~ '^[A-Z]{3}$' then
    raise exception 'invalid_currency';
  end if;
  if v_cur <> 'GBP' then
    raise exception 'unsupported_currency';
  end if;
  if not valid_payment_methods(v_methods) then
    raise exception 'invalid_payment_methods';
  end if;
  -- WS6g (Round-9e item 2): gift_card is OUT of the launch vocabulary. The
  -- till would record a gift-card payment with no balance validation and no
  -- redemption — an unverified money movement. Structurally shaped methods
  -- outside the supported launch set are refused here and by the CHECK.
  if v_methods ? 'gift_card' then
    raise exception 'unsupported_payment_method'
      using detail = 'gift_card is not available at launch: balance validation and redemption are not implemented.';
  end if;
  if length(v_footer) > 500 then
    raise exception 'invalid_receipt_footer';
  end if;

  -- VAT: the same two coherent shapes stores_vat_coherent enforces; the RPC
  -- validates FIRST so the operator gets a named error, then the constraint
  -- still guarantees it at the database.
  v_vstatus := v_vat ->> 'status';
  if v_vstatus not in ('NOT_REGISTERED','REGISTERED') then
    raise exception 'invalid_vat_config';
  end if;
  if v_vstatus = 'REGISTERED' then
    v_vnumber := v_vat ->> 'vatNumber';
    if v_vnumber is null or v_vnumber !~ '^GB[0-9]{9}([0-9]{3})?$' then
      raise exception 'invalid_vat_config';
    end if;
    begin
      v_veff := (v_vat ->> 'effectiveDate')::date;
    exception when others then
      raise exception 'invalid_vat_config';
    end;
    if v_veff is null then
      raise exception 'invalid_vat_config';
    end if;
    -- WS6f (auditor F3): a store cannot become REGISTERED while ANY product
    -- (or extra) lacks a controlled classification — its sales would then
    -- fail one by one at the till. Classification precedes registration.
    select count(*) into v_uncls from menu_items where tax_code is null;
    if v_uncls > 0 then
      raise exception 'products_unclassified'
        using detail = v_uncls || ' menu item(s) have no VAT classification.';
    end if;
  else
    v_vnumber := null;
    v_veff := null;
  end if;

  -- Mark this transaction as the wizard so the column guard admits the write.
  perform set_config('milkpop.store_setup_rpc', '1', true);

  update stores
     set timezone        = v_tz,
         currency_code   = v_cur,
         payment_methods = v_methods,
         receipt_footer  = v_footer,
         vat_status      = v_vstatus,
         vat_number      = v_vnumber,
         vat_registration_effective_date = v_veff,
         vat_config_confirmed_at = now(),
         setup_status    = 'ACTIVE'
   where id = v_store_id
  returning * into v_row;

  return to_jsonb(v_row);
end $_$;


--
-- Name: create_order_quote(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_order_quote(p_quote jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff      text := current_staff_id();
  v_me         staff_profiles%rowtype;
  v_store_id   text;
  v_store      stores%rowtype;
  v_id         text := p_quote ->> 'id';
  v_channel    text := coalesce(p_quote ->> 'channel', 'walk_in');
  v_items_in   jsonb := p_quote -> 'items';
  v_deal_ids   jsonb := coalesce(p_quote -> 'dealIds', '[]'::jsonb);
  v_charging   boolean;
  v_status_reg boolean;
  v_today      date;
  v_priced     jsonb;
  v_row        order_quotes%rowtype;
  v_ttl        interval := interval '20 minutes';
  v_expires    timestamptz;
  v_boundary   timestamptz;
  v_req_hash   text;
begin
  if v_staff is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if v_id is null or length(v_id) < 6 then
    raise exception 'invalid_quote_id';
  end if;
  if v_items_in is null or jsonb_typeof(v_items_in) <> 'array'
     or jsonb_array_length(v_items_in) = 0 then
    raise exception 'empty_basket';
  end if;
  if v_channel not in ('walk_in','phone','website','deliveroo','uber_eats','just_eat') then
    raise exception 'invalid_channel';
  end if;

  v_store_id := v_me.store_id;
  if v_store_id is null then
    raise exception 'store_vat_unconfigured'
      using detail = 'The caller has no home store; sales must belong to a VAT-configured store.';
  end if;
  select * into v_store from stores where id = v_store_id;
  if v_store.id is null or v_store.vat_config_confirmed_at is null then
    raise exception 'store_vat_unconfigured';
  end if;
  if v_store.setup_status is distinct from 'ACTIVE' then
    raise exception 'store_setup_incomplete';
  end if;

  v_status_reg := (v_store.vat_status = 'REGISTERED');
  v_today      := (now() at time zone v_store.timezone)::date;
  v_charging   := v_status_reg
                  and v_store.vat_registration_effective_date <= v_today;

  -- The CANONICAL quote request. Same id + same request = one quote; same id
  -- + a DIFFERENT basket is a conflict, never a silent substitution.
  v_req_hash := canonical_request_hash(jsonb_build_object(
    'op', 'create_order_quote', 'quoteId', v_id, 'storeId', v_store_id,
    'staffId', v_staff, 'channel', v_channel,
    'items', v_items_in, 'dealIds', v_deal_ids));

  select * into v_row from order_quotes where id = v_id;
  if v_row.id is not null then
    if v_row.store_id is distinct from v_store_id then
      raise exception 'quote_id_conflict' using errcode = '42501';
    end if;
    if v_row.quote_request_hash is distinct from v_req_hash then
      raise exception 'idempotency_conflict' using errcode = '42501',
        detail = 'That quote id was replayed with a different basket or request.';
    end if;
    return jsonb_build_object('quote', to_jsonb(v_row), 'duplicate', true);
  end if;

  -- A quote may never straddle a scheduled VAT boundary (correction 2): if
  -- charging begins at the next London midnight, the quote dies first. With
  -- this cap, an OPEN quote priced under one VAT regime cannot survive into
  -- the other; begin_quote_payment() revalidates as belt and braces.
  v_expires := now() + v_ttl;
  if v_status_reg and v_store.vat_registration_effective_date > v_today then
    v_boundary := (v_store.vat_registration_effective_date::timestamp)
                    at time zone v_store.timezone;
    v_expires := least(v_expires, v_boundary);
  end if;

  v_priced := price_basket_internal(v_store, v_items_in, v_deal_ids, v_charging);

  begin
    insert into order_quotes
      (id, store_id, staff_id, channel, status, items, applied_deals,
       subtotal, discount_total, tax_rate, tax_amount, total,
       store_vat_status, vat_effective_date, allowed_payment_methods,
       config_version, quote_request_hash, expires_at)
    values
      (v_id, v_store_id, v_staff, v_channel::order_channel, 'OPEN',
       v_priced -> 'items', v_priced -> 'deals',
       (v_priced ->> 'subtotalP')::bigint / 100.0,
       (v_priced ->> 'discountTotalP')::bigint / 100.0,
       case when (v_priced ->> 'uniform')::boolean
            then nullif(v_priced ->> 'headRate','')::numeric else null end,
       (v_priced ->> 'taxAmountP')::bigint / 100.0,
       (v_priced ->> 'totalP')::bigint / 100.0,
       v_store.vat_status,
       case when v_status_reg then v_store.vat_registration_effective_date else null end,
       v_store.payment_methods,
       store_config_fingerprint(v_store),
       v_req_hash,
       v_expires)
    returning * into v_row;
  exception when unique_violation then
    -- ATOMIC IDEMPOTENCY (finding 6): a concurrent caller won the race between
    -- the pre-check and this insert. Its row is now visible, so answer with the
    -- SAME contract the pre-check would have applied.
    select * into v_row from order_quotes where id = v_id;
    if v_row.id is null then raise; end if;
    if v_row.store_id is distinct from v_store_id then
      raise exception 'quote_id_conflict' using errcode = '42501';
    end if;
    if v_row.quote_request_hash is distinct from v_req_hash then
      raise exception 'idempotency_conflict' using errcode = '42501',
        detail = 'That quote id was replayed with a different basket or request.';
    end if;
    return jsonb_build_object('quote', to_jsonb(v_row), 'duplicate', true);
  end;

  return jsonb_build_object('quote', to_jsonb(v_row), 'duplicate', false);
end $$;


--
-- Name: create_pos_pairing_code(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_pos_pairing_code(p_store_id text, p_store_name text, p_device_label text) RETURNS TABLE(code text, expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: current_privacy_version(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_privacy_version(p_audience text) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select version_label from privacy_notice_versions
   where audience = p_audience and published_at is not null
   order by published_at desc limit 1;
$$;


--
-- Name: current_staff_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_staff_id() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select id from staff_profiles
   where auth_id = auth.uid() and coalesce(status, 'active') <> 'disabled'
   limit 1;
$$;


--
-- Name: current_staff_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_staff_role() RETURNS public.employee_role
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select role from staff_profiles
   where auth_id = auth.uid() and coalesce(status, 'active') <> 'disabled'
   limit 1;
$$;


--
-- Name: current_staff_store(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_staff_store() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select store_id from staff_profiles
   where auth_id = auth.uid() and coalesce(status, 'active') <> 'disabled'
   limit 1;
$$;


--
-- Name: employment_sweep_due(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.employment_sweep_due() RETURNS integer
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  with due as (
    update staff_profiles
       set status = 'disabled', ended_at = now(), updated_at = now()
     where employment_end_date is not null
       and employment_end_date <= current_date
       and coalesce(status,'active') <> 'disabled'
     returning 1)
  select count(*)::int from due;
$$;


--
-- Name: end_employment(text, date, text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.end_employment(p_employee_id text, p_end_date date, p_reason text, p_notes text, p_immediate boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare v_actor text := current_staff_id(); v_flagged int := 0;
begin
  if v_actor is null or not is_manager_or_owner() then raise exception 'not_permitted'; end if;
  if p_employee_id = v_actor then raise exception 'cannot_end_own_employment'; end if;
  if not is_owner() then
    if exists (select 1 from staff_profiles where id = p_employee_id and role in ('store_manager','owner')) then
      raise exception 'not_permitted';                  -- managers cannot end managers/owners
    end if;
    if not exists (select 1 from staff_profiles
                    where id = p_employee_id and store_id = current_staff_store()) then
      raise exception 'not_permitted';
    end if;
  end if;

  update staff_profiles
     set employment_end_date = p_end_date,
         employment_end_reason = coalesce(p_reason,''),
         employment_end_notes  = coalesce(p_notes,''),
         ended_by_staff_id = v_actor,
         ended_at = case when p_immediate or p_end_date <= current_date then now() end,
         status   = case when p_immediate or p_end_date <= current_date
                         then 'disabled' else status end,
         updated_at = now()
   where id = p_employee_id;
  if not found then raise exception 'not_found'; end if;

  -- Future shifts after the end date are flagged, never silently deleted.
  update work_shifts
     set lifecycle_status = 'cancelled_leaver'
   where employee_id = p_employee_id
     and date > p_end_date
     and coalesce(lifecycle_status,'scheduled') <> 'completed';
  get diagnostics v_flagged = row_count;

  insert into audit_logs (id, operator_name, role, action, timestamp, module, new_value)
  values (gen_random_uuid()::text, v_actor, current_staff_role()::text,
          'employment.ended', now()::text, 'Team',
          p_employee_id || ' end=' || p_end_date::text || ' reason=' || coalesce(p_reason,''));
  return jsonb_build_object('ok', true, 'future_shifts_flagged', v_flagged,
                            'access_disabled', p_immediate or p_end_date <= current_date);
end $$;


--
-- Name: enforce_attempt_identity_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_attempt_identity_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if old.state <> 'PENDING' then
    if to_jsonb(new) is distinct from to_jsonb(old) then
      raise exception 'attempt_already_resolved' using errcode = '42501',
        detail = 'A resolved payment attempt is final: no column of it can ever change.';
    end if;
    return new;
  end if;
  if new.reservation_id is distinct from old.reservation_id
     or new.quote_id is distinct from old.quote_id
     or new.store_id is distinct from old.store_id
     or new.request_hash is distinct from old.request_hash
     or new.operator_staff_id is distinct from old.operator_staff_id
     or new.payment_method is distinct from old.payment_method
     or new.device_id is distinct from old.device_id
     or new.cash_session_id is distinct from old.cash_session_id
     or new.terminal_config_id is distinct from old.terminal_config_id
     or new.online_account_id is distinct from old.online_account_id
     or new.started_at is distinct from old.started_at
     or new.created_at is distinct from old.created_at then
    raise exception 'attempt_is_immutable' using errcode = '42501',
      detail = 'A payment attempt records what happened; its identity and bound route cannot be rewritten.';
  end if;
  return new;
end $$;


--
-- Name: enforce_menu_tax_code_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_menu_tax_code_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if tg_op = 'UPDATE' and new.tax_code is not distinct from old.tax_code then
    return new;
  end if;

  -- THE INVARIANT, ahead of every authority branch: a classification, once
  -- set, cannot be removed by ANY API writer — owner, classify RPC or
  -- service role. Non-API sessions (claims unset: migrations, DBA repair)
  -- remain the single documented escape.
  if tg_op = 'UPDATE'
     and old.tax_code is not null
     and new.tax_code is null
     and nullif(current_setting('request.jwt.claims', true), '') is not null
  then
    raise exception 'tax_code_withdrawal_forbidden' using errcode = '42501',
      detail = 'A product''s VAT classification is permanent once set: change it to another code, or delete the product.';
  end if;

  if tg_op = 'INSERT' and new.tax_code is null then
    return new;
  end if;
  if current_setting('milkpop.tax_classify_rpc', true) = '1' then
    return new;
  end if;
  if nullif(current_setting('request.jwt.claims', true), '') is null then
    return new;
  end if;
  if exists (select 1 from pg_roles r where r.rolname = current_user and r.rolbypassrls) then
    return new;
  end if;
  if is_owner() then
    return new;
  end if;
  raise exception 'tax_code_is_owner_only' using errcode = '42501',
    detail = 'Product VAT classification is an owner decision (classify_products or an owner session).';
end $$;


--
-- Name: enforce_order_ledger_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_order_ledger_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  -- Nothing but payment_status may ever change on a completed order.
  if (to_jsonb(new) - 'payment_status') is distinct from (to_jsonb(old) - 'payment_status') then
    raise exception 'order_ledger_immutable' using errcode = '42501',
      detail = 'A completed order is a financial record; it cannot be edited.';
  end if;
  if new.payment_status is distinct from old.payment_status then
    -- The only permitted transition, and only towards honest evidence.
    if not (old.payment_status = 'OPERATOR_RECORDED_UNRECONCILED'
            and new.payment_status = 'MANUAL_EVIDENCE_MATCHED') then
      raise exception 'order_ledger_immutable' using errcode = '42501',
        detail = 'payment_status may only move OPERATOR_RECORDED_UNRECONCILED -> MANUAL_EVIDENCE_MATCHED, via reconcile_card_payment().';
    end if;
    -- EVIDENCE BEFORE STATUS: a COMPLETE, matching immutable reconciliation
    -- record must already exist (inserted earlier in this same transaction by
    -- the RPC). "A row exists" is not enough, and neither are non-null columns:
    -- the row must carry a real written reason, an external evidence reference,
    -- GBP, an amount equal to THIS order's total, a usable idempotency key and a
    -- plausible payment-event time, and must belong to a CONSUMED payment
    -- attempt of THIS order. A privileged path that inserts a thin row and flips
    -- the status is refused here. ('legacy_unspecified' is deliberately absent:
    -- a pre-R3 row can never authorise a NEW reconciliation.)
    if not exists (
      select 1 from payment_reconciliations pr
       where pr.order_id = new.id
         and pr.attempt_reservation_id is not null
         and pr.evidence_type in ('terminal_receipt','z_report','merchant_portal','settlement_statement')
         and pr.reason is not null and length(trim(pr.reason)) >= 10
         and pr.settlement_reference is not null
         and length(trim(pr.settlement_reference)) > 0
         and upper(pr.matched_currency) = 'GBP'
         and round(pr.settled_amount * 100)::bigint = round(new.total * 100)::bigint
         and pr.idempotency_key is not null and length(pr.idempotency_key) >= 8
         and pr.payment_event_at is not null
         and pr.payment_event_at <= now() + interval '1 hour'
         and pr.payment_event_at >= new.created_at - interval '2 days'
         and exists (
           select 1 from quote_payment_attempts a
            where a.reservation_id     = pr.attempt_reservation_id
              and a.completed_order_id = new.id
              and a.state              = 'CONSUMED')
    ) then
      raise exception 'reconciliation_evidence_required' using errcode = '42501',
        detail = 'An order may only be marked MANUAL_EVIDENCE_MATCHED when a complete, matching reconciliation record for its consumed attempt exists.';
    end if;
  end if;
  return new;
end $$;


--
-- Name: enforce_order_ledger_no_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_order_ledger_no_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  raise exception 'order_ledger_immutable' using errcode = '42501',
    detail = 'A completed order is a financial record; it cannot be deleted.';
end $$;


--
-- Name: enforce_order_line_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_order_line_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception 'order_line_immutable' using errcode = '42501',
      detail = 'A completed order line is a financial record; it cannot be deleted.';
  end if;
  -- UPDATE: the priced snapshot is frozen. The ONLY permitted change is the
  -- SOFT catalog link being CLEARED when its menu item is deleted
  -- (order_items.menu_item_id / order_item_modifiers.menu_item_id are ON DELETE
  -- SET NULL). Everything financial — name, size, unit_price, quantity,
  -- line_total, price — is preserved, and the link may only be nulled, never
  -- repointed at a different item.
  if (to_jsonb(new) - 'menu_item_id') is distinct from (to_jsonb(old) - 'menu_item_id') then
    raise exception 'order_line_immutable' using errcode = '42501',
      detail = 'A completed order line is a financial record; its priced snapshot cannot be edited.';
  end if;
  if new.menu_item_id is distinct from old.menu_item_id and new.menu_item_id is not null then
    raise exception 'order_line_immutable' using errcode = '42501',
      detail = 'The catalog link on a completed order line may only be cleared, not repointed.';
  end if;
  return new;
end $$;


--
-- Name: enforce_quote_snapshot_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_quote_snapshot_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if new.items is distinct from old.items
     or new.applied_deals is distinct from old.applied_deals
     or new.subtotal is distinct from old.subtotal
     or new.discount_total is distinct from old.discount_total
     or new.tax_rate is distinct from old.tax_rate
     or new.tax_amount is distinct from old.tax_amount
     or new.total is distinct from old.total
     or new.store_id is distinct from old.store_id
     or new.staff_id is distinct from old.staff_id
     or new.channel is distinct from old.channel
     or new.store_vat_status is distinct from old.store_vat_status
     or new.vat_effective_date is distinct from old.vat_effective_date
     or new.allowed_payment_methods is distinct from old.allowed_payment_methods
     or new.config_version is distinct from old.config_version
     or new.quote_request_hash is distinct from old.quote_request_hash
     or new.created_at is distinct from old.created_at
  then
    raise exception 'quote_snapshot_immutable' using errcode = '42501',
      detail = 'A quote''s priced snapshot is frozen at creation.';
  end if;
  -- A reservation, once recorded, is immutable for that attempt: a second
  -- device cannot silently take over an active reservation by rewriting it.
  if old.reservation_id is not null and old.status = 'PAYMENT_PENDING'
     and new.reservation_id is distinct from old.reservation_id
     and new.status = 'PAYMENT_PENDING' then
    raise exception 'quote_snapshot_immutable' using errcode = '42501',
      detail = 'An active reservation cannot be replaced in place.';
  end if;
  if old.status = 'CONSUMED' and new.status is distinct from 'CONSUMED' then
    raise exception 'quote_snapshot_immutable' using errcode = '42501',
      detail = 'A consumed quote is final.';
  end if;
  if new.status is distinct from old.status then
    if not (   (old.status = 'OPEN'
                and new.status in ('PAYMENT_PENDING','EXPIRED','CANCELLED'))
            or (old.status = 'PAYMENT_PENDING'
                and new.status in ('OPEN','EXPIRED','CONSUMED','NEEDS_RECONCILIATION'))
            or (old.status = 'NEEDS_RECONCILIATION'
                and new.status in ('CONSUMED','CANCELLED'))) then
      raise exception 'quote_status_transition_invalid' using errcode = '42501',
        detail = format('A quote cannot move %s → %s.', old.status, new.status);
    end if;
  end if;
  return new;
end $$;


--
-- Name: enforce_reconciliation_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_reconciliation_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  raise exception 'reconciliation_immutable' using errcode = '42501',
    detail = 'Settlement evidence is append-only.';
end $$;


--
-- Name: enforce_staff_self_update_lock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_staff_self_update_lock() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;  -- service role / server contexts are not browser requests
  end if;
  if is_owner() then
    return new;
  end if;
  -- Contract/identity columns: locked for every non-owner, always.
  if (new.pay_rate      is distinct from old.pay_rate)
     or (new.pay_type   is distinct from old.pay_type)
     or (new.role       is distinct from old.role)
     or (new.store_id   is distinct from old.store_id)
     or (new.store_name is distinct from old.store_name)
  then
    raise exception 'field is not self-editable (protected column changed by non-owner)'
      using errcode = 'insufficient_privilege';
  end if;
  -- Reward/HR columns: the complete_training transaction, or a manager/owner
  -- acting on someone ELSE's row (recognition, holiday) — never self-award.
  if not (reward_grant_active()
          or (is_manager_or_owner() and old.id is distinct from current_staff_id()))
     and (
       (new.points          is distinct from old.points)
    or (new.level           is distinct from old.level)
    or (new.holiday_balance is distinct from old.holiday_balance)
    or (new.badges          is distinct from old.badges)
  ) then
    raise exception 'field is not self-editable (protected column changed by non-owner)'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;


--
-- Name: FUNCTION enforce_staff_self_update_lock(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.enforce_staff_self_update_lock() IS 'Blocks non-owner staff from changing protected staff_profiles columns (pay_rate, pay_type, role, store, points, level, holiday_balance, badges) on any row — including their own. Owners may change anything. Complements the A1 self-update RLS policy with a per-field lock. Editable self-service fields (e.g. avatar, name, next_shift) remain updatable.';


--
-- Name: enforce_store_config_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_store_config_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
begin
  if current_setting('milkpop.store_setup_rpc', true) = '1' then
    return new;                                  -- the wizard RPC itself
  end if;
  if v_claims is null then
    return new;                                  -- non-API session (migration/DBA)
  end if;
  -- Trusted privileged context: the RLS-bypass role the API's service key
  -- runs as. Detected STRUCTURALLY (pg_roles.rolbypassrls on current_user)
  -- rather than by name — no role-name literal ships in code (the security
  -- tripwire forbids it) and the check survives a role rename.
  if exists (select 1 from pg_roles r where r.rolname = current_user and r.rolbypassrls) then
    return new;
  end if;
  if (new.setup_status    is distinct from old.setup_status)
     or (new.timezone        is distinct from old.timezone)
     or (new.currency_code   is distinct from old.currency_code)
     or (new.payment_methods is distinct from old.payment_methods)
     or (new.receipt_footer  is distinct from old.receipt_footer)
     or (new.vat_status      is distinct from old.vat_status)
     or (new.vat_number      is distinct from old.vat_number)
     or (new.vat_registration_effective_date is distinct from old.vat_registration_effective_date)
     or (new.vat_config_confirmed_at         is distinct from old.vat_config_confirmed_at)
  then
    raise exception 'store_config_is_rpc_only' using errcode = '42501',
      detail = 'Store setup and VAT configuration change only through configure_store_setup().';
  end if;
  return new;
end $$;


--
-- Name: enforce_store_id_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_store_id_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.id is distinct from old.id then
    raise exception 'store_id_immutable' using errcode = '42501',
      detail = 'A store''s ID is permanent; history (orders, shifts, POS) is keyed to it.';
  end if;
  return new;
end $$;


--
-- Name: enrol_till_device(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enrol_till_device(p_device jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff  text := current_staff_id();
  v_me     staff_profiles%rowtype;
  v_label  text := nullif(trim(coalesce(p_device ->> 'label','')), '');
  v_store_id text;
  v_store  stores%rowtype;
  v_id     text := 'wtd_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20);
  v_secret text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_row    web_till_devices%rowtype;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;
  -- is_manager_or_owner() REQUIRES an aal2 (MFA-verified) session since FIX-8.
  if not is_manager_or_owner() then
    raise exception 'device_enrolment_denied' using errcode = '42501',
      detail = 'Only a manager or owner with an MFA-verified session may enrol a till device.';
  end if;
  if v_label is null then
    raise exception 'invalid_device_label';
  end if;

  v_store_id := case when is_owner() and nullif(p_device ->> 'storeId','') is not null
                     then p_device ->> 'storeId' else v_me.store_id end;
  if v_store_id is null then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;
  select * into v_store from stores where id = v_store_id;
  if v_store.id is null then raise exception 'unknown_store'; end if;
  if not is_owner() and v_store.id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;
  if v_store.setup_status is distinct from 'ACTIVE' then
    raise exception 'store_setup_incomplete';
  end if;

  insert into web_till_devices (id, store_id, label, registered_by, credential_hash)
  values (v_id, v_store_id, v_label, v_staff,
          encode(sha256(convert_to(v_secret, 'utf8')), 'hex'))
  returning * into v_row;

  perform log_payment_authority_event('device_enrolled', jsonb_build_object(
    'deviceId', v_id, 'storeId', v_store_id, 'label', v_label, 'enrolledBy', v_staff));

  -- The pairing secret is returned ONCE and never stored in clear.
  return jsonb_build_object(
    'deviceId', v_id, 'storeId', v_store_id, 'label', v_label,
    'pairingSecret', v_secret,
    'note', 'The pairing secret is shown once. The server stores only its hash.');
end $$;


--
-- Name: expire_stale_quotes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.expire_stale_quotes() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff text := current_staff_id();
  v_store text := current_staff_store();
  v_exp int;
  v_rec int;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if not is_owner() and v_store is null then
    raise exception 'store_scope_denied' using errcode = '42501',
      detail = 'Quote expiry acts on your own store.';
  end if;
  update order_quotes set status = 'EXPIRED'
   where status = 'OPEN' and expires_at < now()
     and (is_owner() or store_id = v_store);
  get diagnostics v_exp = row_count;
  update order_quotes set status = 'NEEDS_RECONCILIATION'
   where status = 'PAYMENT_PENDING'
     and payment_started_at + interval '24 hours' < now()
     and (is_owner() or store_id = v_store);
  get diagnostics v_rec = row_count;
  return jsonb_build_object('expired', v_exp, 'movedToReconciliation', v_rec);
end $$;


--
-- Name: explode_order_items(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.explode_order_items() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  item jsonb;
  mod  jsonb;
  new_item_row uuid;
begin
  delete from order_items where order_id = new.id;  -- cascades to modifiers
  for item in select * from jsonb_array_elements(coalesce(new.items, '[]'::jsonb))
  loop
    insert into order_items (id, order_id, menu_item_id, name, category, size,
                             unit_price, quantity, line_total, notes,
                             tax_code, tax_rate, taxable_amount, tax_amount)
    values (
      coalesce(item->>'id', gen_random_uuid()::text),
      new.id,
      item->>'menuItemId',
      coalesce(item->>'name',''),
      coalesce((item->>'category')::menu_category, 'milkshakes'),
      coalesce((item->>'size')::item_size, 'one_size'),
      coalesce((item->>'unitPrice')::numeric, 0),
      greatest(coalesce((item->>'quantity')::int, 1), 1),
      coalesce((item->>'lineTotal')::numeric, 0),
      item->>'notes',
      nullif(item->>'taxCode', ''),
      (item->>'taxRate')::numeric,
      (item->>'taxableAmount')::numeric,
      (item->>'taxAmount')::numeric
    )
    returning row_id into new_item_row;

    for mod in select * from jsonb_array_elements(coalesce(item->'modifiers', '[]'::jsonb))
    loop
      insert into order_item_modifiers (id, order_item_id, order_id, menu_item_id, name, price,
                                        tax_code, tax_rate, taxable_amount, tax_amount)
      values (
        coalesce(mod->>'id', gen_random_uuid()::text),
        new_item_row,
        new.id,
        mod->>'menuItemId',
        coalesce(mod->>'name',''),
        coalesce((mod->>'price')::numeric, 0),
        nullif(mod->>'taxCode', ''),
        (mod->>'taxRate')::numeric,
        (mod->>'taxableAmount')::numeric,
        (mod->>'taxAmount')::numeric
      );
    end loop;
  end loop;
  return new;
end $$;


--
-- Name: finalise_media_reference(uuid, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalise_media_reference(p_object_id uuid, p_entity_type text, p_entity_id text, p_field_path text, p_actor text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_obj        record;
  v_old_object uuid;
  v_grace      constant interval := interval '24 hours';
begin
  if p_entity_type not in ('menu_item','site_content','app_state','news_post','cms_page','media_library') then
    raise exception 'unknown_entity_type';
  end if;

  select * into v_obj from media_objects where id = p_object_id for update;
  if v_obj.id is null then
    return jsonb_build_object('status','failed','error','object_not_found');
  end if;
  if v_obj.status not in ('pending','attached') then
    return jsonb_build_object('status','failed','error','object_not_attachable');
  end if;

  -- Previous holder of this exact field, if any.
  select media_object_id into v_old_object
    from media_references
   where entity_type = p_entity_type and entity_id = p_entity_id and field_path = p_field_path
   for update;

  if v_old_object is not null and v_old_object = p_object_id then
    -- Idempotent re-attach of the same object to the same field.
    update media_objects set status = 'attached', attached_at = coalesce(attached_at, now())
     where id = p_object_id;
    return jsonb_build_object('status','attached','object_id',p_object_id,'url',v_obj.public_url,
                              'previous_object_cleanup','not_needed');
  end if;

  -- Parent column update — atomic here for the plain-column entity.
  if p_entity_type = 'menu_item' then
    update menu_items set image = coalesce(v_obj.public_url, v_obj.storage_path)
     where id = p_entity_id;
    if not found then
      return jsonb_build_object('status','failed','error','parent_not_found');
    end if;
  end if;

  insert into media_references (media_object_id, entity_type, entity_id, field_path)
  values (p_object_id, p_entity_type, p_entity_id, p_field_path)
  on conflict (entity_type, entity_id, field_path)
    do update set media_object_id = excluded.media_object_id, created_at = now();

  update media_objects set status = 'attached', attached_at = coalesce(attached_at, now())
   where id = p_object_id;

  -- Old object: zero remaining references → cleanup CANDIDATE after grace.
  if v_old_object is not null
     and not exists (select 1 from media_references where media_object_id = v_old_object) then
    update media_objects
       set status = 'cleanup_pending', cleanup_after = now() + v_grace
     where id = v_old_object and status in ('pending','attached');
    return jsonb_build_object('status','attached','object_id',p_object_id,'url',v_obj.public_url,
                              'previous_object_cleanup','scheduled');
  end if;

  return jsonb_build_object('status','attached','object_id',p_object_id,'url',v_obj.public_url,
                            'previous_object_cleanup','not_needed');
end;
$$;


--
-- Name: FUNCTION finalise_media_reference(p_object_id uuid, p_entity_type text, p_entity_id text, p_field_path text, p_actor text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.finalise_media_reference(p_object_id uuid, p_entity_type text, p_entity_id text, p_field_path text, p_actor text) IS 'WP04R §10.2: transactional attach — records the (entity, field) → object reference, promotes the object, moves the previous reference and schedules the displaced object for GRACE-PERIOD cleanup only when nothing references it. menu_item also updates menu_items.image in the same transaction. Edge Function (service role) only.';


--
-- Name: finalise_order_payment(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalise_order_payment(p_payment jsonb) RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select finalise_order_payment_core(p_payment, false, null);
$$;


--
-- Name: finalise_order_payment_core(jsonb, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalise_order_payment_core(p_payment jsonb, p_recovery boolean, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff     text := current_staff_id();
  v_me        staff_profiles%rowtype;
  v_op        staff_profiles%rowtype;
  v_quote_id  text := p_payment ->> 'quoteId';
  v_res_in    text := p_payment ->> 'reservationId';
  v_method    text := p_payment ->> 'method';
  v_ref       text := nullif(trim(coalesce(p_payment ->> 'providerReference','')), '');
  v_term_in   text := nullif(trim(coalesce(p_payment ->> 'terminalConfigId','')), '');
  v_acct_in   text := nullif(trim(coalesce(p_payment ->> 'onlineAccountId','')), '');
  v_sess_in   text := nullif(trim(coalesce(p_payment ->> 'tillSessionId','')), '');
  v_dev_in    text := nullif(trim(coalesce(p_payment ->> 'deviceId','')), '');
  v_secret    text := nullif(p_payment ->> 'deviceSecret', '');
  v_override  text := nullif(trim(coalesce(p_payment ->> 'overrideReason','')), '');
  v_customer  text := nullif(trim(coalesce(p_payment ->> 'customerName','')), '');
  v_paid_raw  text := nullif(p_payment ->> 'paidAt','');
  v_claimed   timestamptz;
  v_recorded  timestamptz;
  v_paid_at   timestamptz;
  v_cash_p    bigint := case when nullif(p_payment ->> 'cashReceived','') is not null
                        then round((p_payment ->> 'cashReceived')::numeric * 100)::bigint end;
  v_appr_p    bigint := case when nullif(p_payment ->> 'approvedAmount','') is not null
                        then round((p_payment ->> 'approvedAmount')::numeric * 100)::bigint end;
  v_change_p  bigint;
  v_q         order_quotes%rowtype;
  v_att       quote_payment_attempts%rowtype;
  v_s         web_till_sessions%rowtype;
  v_dev       web_till_devices%rowtype;
  v_term      payment_terminals%rowtype;
  v_acct      online_payment_accounts%rowtype;
  v_provider  text;
  v_merchant  text;
  v_terminal  text;
  v_total_p   bigint;
  v_hash      text;
  v_order_no  bigint;
  v_order_id  text := 'ord_' || replace(gen_random_uuid()::text, '-', '');
  v_row       orders%rowtype;
  v_recovery  interval := interval '24 hours';
  v_via       text;
  v_pay_status text;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  -- Finalisation must name and consume ONE exact attempt — ALWAYS, including
  -- for a consumed replay (correction 8: the replay path can no longer omit
  -- the reservation).
  if v_res_in is null then
    raise exception 'invalid_reservation'
      using detail = 'Finalisation must present the reservation that took the payment.';
  end if;

  select * into v_q from order_quotes where id = v_quote_id for update;
  if v_q.id is null then raise exception 'unknown_quote'; end if;
  if v_q.store_id is distinct from v_me.store_id
     and not (p_recovery and is_owner()) then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;

  select * into v_att from quote_payment_attempts
   where reservation_id = v_res_in for update;
  if v_att.reservation_id is null then
    raise exception 'invalid_reservation'
      using detail = 'No such payment reservation.';
  end if;
  if v_att.quote_id is distinct from v_q.id then
    raise exception 'idempotency_conflict' using errcode = '42501',
      detail = 'That reservation does not belong to this quote.';
  end if;

  -- Only the operator who took the payment may finalise it; anyone else
  -- needs an audited manager/owner override, and the reconciliation path is
  -- privileged by construction (correction 3).
  if v_att.operator_staff_id is distinct from v_staff and not p_recovery then
    if v_override is null or not is_manager_or_owner() then
      raise exception 'operator_scope_denied' using errcode = '42501',
        detail = 'Another operator''s payment; a manager/owner override with a reason is required.';
    end if;
    perform log_payment_authority_event('payment_override:finalise', jsonb_build_object(
      'quoteId', v_q.id, 'reservationId', v_res_in, 'operator', v_att.operator_staff_id,
      'overriddenBy', v_staff, 'reason', v_override));
  end if;

  -- The method and route were BOUND at reservation. Finalisation may repeat
  -- them, but it can never substitute any part of them (correction 1).
  if v_method is distinct from v_att.payment_method then
    raise exception 'payment_method_mismatch'
      using detail = 'Finalisation must use the payment method that was reserved.';
  end if;
  if v_term_in is not null and v_term_in is distinct from v_att.terminal_config_id then
    raise exception 'payment_binding_mismatch' using errcode = '42501',
      detail = 'The reserved terminal is the one that must finalise.';
  end if;
  if v_acct_in is not null and v_acct_in is distinct from v_att.online_account_id then
    raise exception 'payment_binding_mismatch' using errcode = '42501',
      detail = 'The reserved online account is the one that must finalise.';
  end if;
  if v_sess_in is not null and v_sess_in is distinct from v_att.cash_session_id then
    raise exception 'payment_binding_mismatch' using errcode = '42501',
      detail = 'The reserved till session is the one that must finalise.';
  end if;
  if v_dev_in is not null and v_dev_in is distinct from v_att.device_id then
    raise exception 'payment_binding_mismatch' using errcode = '42501',
      detail = 'The reserved device is the one that must finalise.';
  end if;

  v_total_p := round(v_q.total * 100)::bigint;

  -- BOUNDED, ATTRIBUTABLE TIME (finding 3). Three different facts stop being
  -- one field: what the client CLAIMED, what the server RECORDED, and the
  -- captured time the ledger shows. The claim is bounds-checked, never trusted
  -- outright — it can no longer sit in the future or before the basket existed.
  v_recorded := now();
  v_claimed  := v_paid_raw::timestamptz;   -- null when the client claimed none
  if v_claimed is not null then
    if v_claimed > v_recorded + interval '5 minutes' then
      raise exception 'payment_time_in_future' using errcode = '42501',
        detail = 'The claimed payment time is in the future.';
    end if;
    if v_claimed < v_q.created_at - interval '5 minutes' then
      raise exception 'payment_time_implausible' using errcode = '42501',
        detail = 'The claimed payment time precedes the priced basket.';
    end if;
    -- The payment cannot predate the ATTEMPT it settles — on the ordinary path
    -- and in recovery alike. An older-but-legitimate time (a delayed recovery
    -- of a real payment) passes, because the attempt itself is that old; a time
    -- from before this attempt began does not, so a timestamp belonging to some
    -- other payment cannot be grafted onto this one.
    if v_att.started_at is not null
       and v_claimed < v_att.started_at - interval '5 minutes' then
      raise exception 'payment_time_implausible' using errcode = '42501',
        detail = 'The claimed payment time precedes this payment attempt.';
    end if;
  end if;
  v_paid_at := coalesce(v_claimed, v_recorded);

  -- The CANONICAL finalisation identity (correction 8): every fact whose
  -- change is a different claim about the payment — including the exact
  -- reservation and its bound route. Same claim replayed = same order;
  -- anything different conflicts.
  v_hash := canonical_request_hash(jsonb_build_object(
    'op', 'finalise_order_payment', 'quoteId', v_quote_id,
    'reservationId', v_res_in, 'method', v_method,
    'cashReceivedP', v_cash_p, 'approvedAmountP', v_appr_p,
    'providerReference', v_ref, 'paidAt', v_paid_raw, 'customerName', v_customer,
    'cashSessionId', v_att.cash_session_id, 'deviceId', v_att.device_id,
    'terminalConfigId', v_att.terminal_config_id,
    'onlineAccountId', v_att.online_account_id));

  if v_att.state in ('DECLINED','ABANDONED') then
    raise exception 'reservation_released' using errcode = '42501',
      detail = 'That attempt was released; it cannot be finalised.';
  end if;
  if v_att.state = 'CONSUMED' then
    if v_q.payment_hash = v_hash then
      -- The retry anchor is the QUOTE, not the order id: the order carries
      -- its own identity and is found through the unique quote link.
      select * into v_row from orders where quote_id = v_q.id;
      return jsonb_build_object('order', to_jsonb(v_row), 'duplicate', true);
    end if;
    raise exception 'idempotency_conflict' using errcode = '42501',
      detail = 'This quote was already finalised with different payment facts.';
  end if;

  if p_recovery then
    if v_q.status <> 'NEEDS_RECONCILIATION' then
      raise exception 'quote_not_reserved'
        using detail = 'Reconciliation applies to a quote in NEEDS_RECONCILIATION.';
    end if;
  else
    if v_q.status <> 'PAYMENT_PENDING' then
      raise exception 'quote_not_reserved'
        using detail = 'Reserve the quote with begin_quote_payment() before taking payment.';
    end if;
    -- A paid transaction is NEVER permanently unrecordable (correction 5):
    -- past the window, the path is resolve_payment_reconciliation(), not a
    -- dead end.
    if now() > v_q.payment_started_at + v_recovery then
      raise exception 'recovery_window_elapsed'
        using detail = 'The ordinary recovery window has passed; a manager or owner must resolve this payment through resolve_payment_reconciliation().';
    end if;
  end if;
  if v_q.reservation_id is distinct from v_res_in then
    raise exception 'idempotency_conflict' using errcode = '42501',
      detail = 'A superseded attempt cannot finalise this quote.';
  end if;

  if v_method = 'cash' then
    -- CASH CUSTODY: the BOUND session, locked, still open, still this store's
    -- drawer on this device.
    select * into v_s from web_till_sessions where id = v_att.cash_session_id for update;
    if v_s.id is null or v_s.status <> 'OPEN' then
      raise exception 'till_session_not_open';
    end if;
    if v_s.store_id is distinct from v_q.store_id then
      raise exception 'till_session_store_mismatch' using errcode = '42501';
    end if;
    if v_s.device_id is distinct from v_att.device_id then
      raise exception 'till_session_device_mismatch' using errcode = '42501';
    end if;
    -- DEVICE CREDENTIAL ON THE CASH FINALISE (finding 1). The ordinary path
    -- must re-present the enrolled pairing secret: taking money into the drawer
    -- is a custody act, not merely a call naming an open session. The PRIVILEGED
    -- RECOVERY path is deliberately exempt — it exists precisely for when the
    -- till is gone, and it is already manager/owner-gated, reasoned and audited;
    -- demanding a secret nobody can produce would make a real payment
    -- permanently unrecordable, which WS7b correction 5 forbids.
    if not p_recovery then
      select * into v_dev from web_till_devices where id = v_att.device_id;
      if v_dev.id is null or v_dev.credential_hash is null then
        raise exception 'device_not_enrolled' using errcode = '42501',
          detail = 'Cash custody requires a device enrolled by a manager or owner.';
      end if;
      if v_dev.revoked then
        raise exception 'till_device_revoked' using errcode = '42501';
      end if;
      if v_secret is null
         or encode(sha256(convert_to(v_secret, 'utf8')), 'hex') is distinct from v_dev.credential_hash then
        raise exception 'device_credential_invalid' using errcode = '42501',
          detail = 'The device pairing secret is required to record cash on this device.';
      end if;
    end if;
    if v_cash_p is null or v_cash_p < v_total_p then
      raise exception 'insufficient_cash';
    end if;
    v_change_p := v_cash_p - v_total_p;
    if p_payment ? 'change'
       and round(coalesce(nullif(p_payment ->> 'change','')::numeric, -1) * 100)::bigint
           is distinct from v_change_p then
      raise exception 'change_mismatch'
        using detail = 'Change must equal cash received minus the quoted total.';
    end if;
    v_pay_status := 'CASH_RECORDED';
  else
    -- CARD / ONLINE. This system has no provider integration, so what the
    -- database can honestly record is that a STAFF BROWSER asserted this
    -- result. The order therefore says OPERATOR_RECORDED_UNRECONCILED, and
    -- only reconcile_card_payment() — against manager-attested external
    -- evidence — may upgrade it (correction 6).
    if v_ref is null then
      raise exception 'payment_reference_required'
        using detail = 'A card or online payment must carry the reference the operator observed.';
    end if;
    if v_appr_p is distinct from v_total_p then
      raise exception 'approved_amount_mismatch'
        using detail = 'The approved amount must equal the quoted total.';
    end if;
    if v_method = 'card' then
      -- The namespace is RESOLVED from the terminal BOUND at reservation —
      -- never accepted from the payload, never re-chosen at finalisation.
      select * into v_term from payment_terminals where id = v_att.terminal_config_id;
      if v_term.id is null then
        raise exception 'unknown_terminal';
      end if;
      v_provider := btrim(v_term.provider);
      v_merchant := btrim(v_term.merchant_id);
      v_terminal := btrim(v_term.terminal_id);
    else
      select * into v_acct from online_payment_accounts where id = v_att.online_account_id;
      if v_acct.id is null then
        raise exception 'unknown_online_account';
      end if;
      v_provider := btrim(v_acct.provider);
      v_merchant := btrim(v_acct.account_id);
      v_terminal := 'ONLINE';
    end if;
    v_cash_p := null;
    v_change_p := null;
    v_pay_status := 'OPERATOR_RECORDED_UNRECONCILED';
  end if;

  perform pg_advisory_xact_lock(hashtext('milkpop_order_no_' || coalesce(v_q.store_id, 'hq')));
  select coalesce(max(order_number), 0) + 1 into v_order_no
    from orders where coalesce(store_id, 'hq') = coalesce(v_q.store_id, 'hq');

  -- PRESERVE THE PAYMENT OPERATOR (finding 4): the sale belongs to the cashier
  -- who actually took the money, even when a manager finalises or recovers it.
  -- Who WROTE the record is recorded separately, never on top of the operator.
  select * into v_op from staff_profiles where id = v_att.operator_staff_id;

  -- The sale is written FROM THE SNAPSHOT. Nothing is re-derived from the
  -- current catalogue, so the record matches the money that was collected.
  insert into orders
    (id, order_number, store_id, store_name, channel, items, applied_deals,
     subtotal, discount_total, tax_rate, tax_amount, total,
     store_vat_status, vat_effective_date,
     payment_method, cash_received, change_given, status,
     customer_name, staff_id, staff_name, placed_at, completed_at,
     quote_id, till_session_id, payment_status, payment_reference,
     payment_captured_at, cash_change,
     payment_claimed_at, payment_recorded_at, payment_operator_staff_id,
     finalised_by_staff_id, finalisation_reason)
  values
    (v_order_id, v_order_no, v_q.store_id,
     coalesce((select name from stores where id = v_q.store_id), ''),
     v_q.channel, v_q.items, v_q.applied_deals,
     v_q.subtotal, v_q.discount_total, v_q.tax_rate, v_q.tax_amount, v_q.total,
     v_q.store_vat_status, v_q.vat_effective_date,
     v_method::payment_method,
     case when v_cash_p is null then null else v_cash_p / 100.0 end,
     case when v_change_p is null then null else v_change_p / 100.0 end,
     'completed', v_customer,
     coalesce(v_att.operator_staff_id, v_staff),
     coalesce(v_op.name, v_me.name, ''),
     v_q.created_at,                       -- placed: when the basket was priced
     v_paid_at,                            -- completed: when the money moved
     v_q.id, case when v_method = 'cash' then v_att.cash_session_id else null end,
     v_pay_status, v_ref, v_paid_at,
     case when v_change_p is null then null else v_change_p / 100.0 end,
     v_claimed, v_recorded, v_att.operator_staff_id,
     v_staff, coalesce(p_reason, v_override))
  returning * into v_row;

  -- The attempt's terminal evidence is written ONCE, atomically, in the
  -- resolving statement; the trigger freezes every column afterwards
  -- (correction 7).
  v_via := case when p_recovery then 'reconciliation'
                when v_att.operator_staff_id is distinct from v_staff then 'override_finalise'
                else 'finalise' end;
  update quote_payment_attempts
     set state = 'CONSUMED', completed_order_id = v_row.id,
         provider_reference = v_ref, payment_provider = v_provider,
         provider_merchant_id = v_merchant, provider_terminal_id = v_terminal,
         resolved_by_staff_id = v_staff, resolved_via = v_via, resolved_at = now()
   where reservation_id = v_res_in;

  update order_quotes
     set status = 'CONSUMED', consumed_at = now(),
         order_id = v_row.id, payment_hash = v_hash
   where id = v_q.id;

  return jsonb_build_object('order', to_jsonb(v_row), 'duplicate', false,
                            'paymentStatus', v_pay_status);
end $$;


--
-- Name: get_my_staff_profile(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_staff_profile() RETURNS TABLE(id text, name text, email text, role public.employee_role, store_id text, store_name text, next_shift text, holiday_balance numeric, points integer, level integer, badges jsonb, avatar text, status text, onboarding text, invited_at timestamp with time zone, pay_rate numeric, pay_type text, created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select sp.id, sp.name, sp.email, sp.role, sp.store_id,
         sp.store_name, sp.next_shift, sp.holiday_balance, sp.points,
         sp.level, sp.badges, sp.avatar, sp.status, sp.onboarding,
         sp.invited_at, sp.pay_rate, sp.pay_type,
         sp.created_at, sp.updated_at
  from staff_profiles sp
  where sp.auth_id = auth.uid();
$$;


--
-- Name: get_staff_assessments(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_staff_assessments() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_rows jsonb;
begin
  if current_staff_id() is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if is_manager_or_owner() then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at), '[]'::jsonb)
      into v_rows from training_assessments t;
  else
    select coalesce(jsonb_agg(redact_assessment_row(to_jsonb(t)) order by t.created_at), '[]'::jsonb)
      into v_rows from training_assessments t;
  end if;
  return v_rows;
end $$;


--
-- Name: get_staff_directory(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_staff_directory() RETURNS TABLE(id text, name text, email text, role public.employee_role, store_id text, store_name text, next_shift text, holiday_balance numeric, points integer, level integer, badges jsonb, avatar text, status text, onboarding text, invited_at timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select sp.id, sp.name, sp.email, sp.role, sp.store_id,
         sp.store_name, sp.next_shift, sp.holiday_balance, sp.points,
         sp.level, sp.badges, sp.avatar, sp.status, sp.onboarding,
         sp.invited_at, sp.created_at, sp.updated_at
  from staff_profiles sp
  where is_owner()
     or (is_store_manager() and sp.store_id = current_staff_store())
     or sp.auth_id = auth.uid();
$$;


--
-- Name: grade_training_answers(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.grade_training_answers(p_questions jsonb, p_answers jsonb) RETURNS integer
    LANGUAGE plpgsql IMMUTABLE
    AS $$
declare
  v_total   int := coalesce(jsonb_array_length(p_questions), 0);
  v_correct int := 0;
  i         int;
  q         jsonb;
  a         jsonb;
  v_tpl     text;
  v_gaps    text[];
  v_words   text[];
  ok        boolean;
begin
  if v_total = 0 then
    return 0;
  end if;
  for i in 0 .. v_total - 1 loop
    q := p_questions -> i;
    a := case when p_answers is not null and jsonb_typeof(p_answers) = 'array'
              then p_answers -> i else null end;
    ok := false;
    if coalesce(q ->> 'type', '') = 'drag_drop'
       and coalesce(q ->> 'dragTemplate', '') <> '' then
      v_tpl := q ->> 'dragTemplate';
      select coalesce(array_agg(lower(trim(m.match[1])) order by m.ord), '{}')
        into v_gaps
        from regexp_matches(v_tpl, '\[\[(.+?)\]\]', 'g') with ordinality as m(match, ord);
      if array_length(v_gaps, 1) is not null
         and a is not null and jsonb_typeof(a) = 'array'
         and jsonb_array_length(a) = array_length(v_gaps, 1) then
        select coalesce(array_agg(lower(trim(e.value)) order by e.ord), '{}')
          into v_words
          from jsonb_array_elements_text(a) with ordinality as e(value, ord);
        ok := (v_words = v_gaps);
      end if;
    else
      ok := a is not null
            and jsonb_typeof(a) = 'string'
            and (a #>> '{}') = coalesce(q ->> 'correctAnswer', '');
    end if;
    if ok then v_correct := v_correct + 1; end if;
  end loop;
  return round(v_correct * 100.0 / v_total);
end $$;


--
-- Name: guard_staff_profile_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_staff_profile_write() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  caller_role text := current_staff_role();
  caller_id   text := current_staff_id();
begin
  if is_owner() then
    return new;                                    -- owner: unrestricted
  end if;

  -- Identity/lifecycle fields are system-controlled for every non-owner,
  -- whether editing self or (as a manager) someone else.
  if new.email      is distinct from old.email
     or new.onboarding is distinct from old.onboarding
     or new.invited_at is distinct from old.invited_at
     or new.auth_id    is distinct from old.auth_id
     or new.status     is distinct from old.status then
    raise exception 'identity and lifecycle fields are system-controlled'
      using errcode = 'insufficient_privilege';
  end if;

  -- A manager acting on ANOTHER person's row may only manage lower roles.
  if caller_role = 'store_manager' and new.id <> caller_id
     and old.role not in ('team_member','supervisor') then
    raise exception 'managers may only manage team members and supervisors'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end $$;


--
-- Name: is_aal2(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_aal2() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  select jwt_aal() = 'aal2';
$$;


--
-- Name: is_manager_or_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_manager_or_owner() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select coalesce(current_staff_role() in ('store_manager','owner'), false)
         and is_aal2();
$$;


--
-- Name: is_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_owner() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select coalesce(current_staff_role() = 'owner', false) and is_aal2();
$$;


--
-- Name: is_store_manager(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_store_manager() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select coalesce(current_staff_role() = 'store_manager', false)
         and is_aal2();
$$;


--
-- Name: jwt_aal(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.jwt_aal() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select coalesce(nullif(auth.jwt() ->> 'aal', ''), 'aal1');
$$;


--
-- Name: launch_blocking_reasons(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.launch_blocking_reasons() RETURNS TABLE(key text, state text, detail text, fix text, blocks text[])
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select * from launch_blocking_reasons((select l from launch_settings l where id limit 1));
$$;


--
-- Name: FUNCTION launch_blocking_reasons(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.launch_blocking_reasons() IS 'R4.9 G5: THE definition of launch readiness. launch_readiness() renders it; assert_launch_ready() raises from it. Nothing else may hold a second opinion.';


--
-- Name: launch_blocking_reasons(public.launch_settings); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.launch_blocking_reasons(p public.launch_settings) RETURNS TABLE(key text, state text, detail text, fix text, blocks text[])
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select * from (values
    ('legal_business_name',
       case when coalesce(p.legal_business_name,'') <> '' then 'complete' else 'incomplete' end,
       'The registered name the business trades under.', '/admin/settings/',
       array['arm_gates','store_open']),
    ('company_number',
       case when coalesce(p.company_number,'') <> '' then 'complete' else 'warning' end,
       'Required on the website of a limited company (Companies Act 2006). Advisory here because a sole trader has none.',
       '/admin/settings/', array[]::text[]),
    ('registered_address',
       case when coalesce(p.registered_address,'') <> '' then 'complete' else 'incomplete' end,
       'Statutory business address.', '/admin/settings/', array['arm_gates','store_open']),
    ('public_contact_email',
       case when coalesce(p.public_contact_email,'') <> '' then 'complete' else 'incomplete' end,
       'The address customers can reach.', '/admin/settings/', array['arm_gates','store_open']),
    ('privacy_contact_email',
       case when coalesce(p.privacy_contact_email,'') <> '' then 'complete' else 'incomplete' end,
       'Where data-protection requests go.', '/admin/settings/', array['arm_gates','store_open']),
    ('public_telephone',
       case when coalesce(p.public_telephone,'') <> '' or coalesce(p.telephone_alternative_ok, false)
            then 'complete' else 'incomplete' end,
       'A telephone number, or an explicit decision that another channel serves instead.',
       '/admin/settings/', array['arm_gates','store_open']),
    ('canonical_url',
       case when coalesce(p.canonical_url,'') <> '' then 'complete' else 'incomplete' end,
       'The site''s own address, used for canonical links and receipts.', '/admin/settings/',
       array['arm_gates','store_open']),
    ('vat_state_confirmed',
       case when coalesce(p.vat_state_confirmed, false) then 'complete' else 'incomplete' end,
       'The VAT position has been stated deliberately rather than left unset.', '/admin/settings/',
       array['arm_gates','store_open']),
    ('receipt_identity_footer',
       case when coalesce(p.receipt_identity_footer,'') <> '' then 'complete' else 'incomplete' end,
       'The identity line printed on every receipt.', '/admin/settings/', array['arm_gates','store_open']),
    ('notification_recipient',
       case when coalesce(p.notification_recipient,'') <> '' then 'complete' else 'incomplete' end,
       'Where public form submissions are delivered. Blocks form acceptance only.',
       '/admin/settings/', array['form_accept']),
    ('privacy_notice_careers',
       case when current_privacy_version('careers') is not null then 'complete' else 'incomplete' end,
       'A published careers privacy notice to stamp on each submission.', '/admin/settings/',
       array['form_accept']),
    ('privacy_notice_franchise',
       case when current_privacy_version('franchise') is not null then 'complete' else 'incomplete' end,
       'A published franchise privacy notice to stamp on each submission.', '/admin/settings/',
       array['form_accept']),
    ('privacy_notice_contact',
       case when current_privacy_version('contact') is not null then 'complete' else 'incomplete' end,
       'A published contact privacy notice to stamp on each submission.', '/admin/settings/',
       array['form_accept']),
    ('open_store_facts',
       case
         when not exists (select 1 from stores where status = 'open') then 'not_applicable'
         when exists (select 1 from stores where status = 'open'
                        and (coalesce(trim(address),'') = '' or coalesce(trim(opening_hours),'') = ''))
           then 'incomplete'
         else 'complete' end,
       'Every open storefront carries an address and opening hours.', '/admin/stores/',
       array['arm_gates']),
    ('allergen_declarations',
       case
         when coalesce(p.allergen_disclosure_mode, 'in_store_only') <> 'declared' then 'not_applicable'
         when not exists (select 1 from menu_items where available) then 'not_applicable'
         when exists (select 1 from menu_items mi where mi.available and not exists
                (select 1 from product_allergen_declarations d
                  where d.menu_item_id = mi.id and d.state = 'approved')) then 'incomplete'
         else 'complete' end,
       'Publishing allergen data requires an approved declaration on every available product.',
       '/admin/menu/', array['arm_gates','menu_publish']),
    ('public_form_gates_armed',
       case when coalesce(p.enforce_public_gates, false) then 'complete' else 'incomplete' end,
       'The public gates are armed. A storefront may not open before they are.',
       '/admin/settings/', array['store_open'])
  ) as t(key, state, detail, fix, blocks);
$$;


--
-- Name: FUNCTION launch_blocking_reasons(p public.launch_settings); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.launch_blocking_reasons(p public.launch_settings) IS 'R4.10: THE definition of launch readiness, evaluated against a CANDIDATE launch_settings value. The zero-argument form delegates here with the stored row. Triggers validate NEW through this, so a statement is judged by the state it proposes, never the state it replaces.';


--
-- Name: launch_readiness(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.launch_readiness() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select case when not is_owner() then jsonb_build_object('ok', false, 'error', 'not_permitted')
  else jsonb_build_object('ok', true, 'items', coalesce((
    select jsonb_agg(jsonb_build_object('key', key, 'state', state, 'fix', fix,
                                        'detail', detail, 'blocks', to_jsonb(blocks))
                     order by key)
      from launch_blocking_reasons()
  ), '[]'::jsonb)) end;
$$;


--
-- Name: launch_settings_is_permanent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.launch_settings_is_permanent() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if TG_OP = 'DELETE' then
    raise exception
      'launch_settings_undeletable: the launch settings row cannot be deleted. '
      'Deleting it made every identity condition report a blank state instead of '
      '"incomplete", and assert_launch_ready() then passed. Edit the row instead; '
      'to start over, blank the fields you want to clear.'
      using errcode = 'restrict_violation';
  end if;

  -- UPDATE: the identity of the singleton may not move.
  if NEW.id is distinct from OLD.id then
    raise exception 'launch_settings_immutable_id: the singleton id cannot be changed'
      using errcode = 'restrict_violation';
  end if;

  return NEW;
end
$$;


--
-- Name: launch_settings_never_empty(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.launch_settings_never_empty() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare v_count bigint;
begin
  select count(*) into v_count from launch_settings;
  if v_count <> 1 then
    raise exception
      'launch_settings_singleton_violated: expected exactly 1 launch settings row, found %. '
      'A missing row silently disarms the launch gate.', v_count
      using errcode = 'restrict_violation';
  end if;
  return null;
end
$$;


--
-- Name: link_staff_profile(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.link_staff_profile() RETURNS public.staff_profiles
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  claimed staff_profiles;
  jwt_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if jwt_email = '' then
    raise exception 'no verified email on token';
  end if;

  -- Already linked? Return the existing profile (idempotent, no error).
  select * into claimed from staff_profiles where auth_id = auth.uid() limit 1;
  if found then
    return claimed;
  end if;

  -- Claim the unclaimed profile whose email matches the verified JWT email.
  update staff_profiles
     set auth_id = auth.uid()
   where auth_id is null
     and lower(email) = jwt_email
  returning * into claimed;

  if not found then
    raise exception 'no unclaimed staff profile matches this account';
  end if;

  return claimed;
end $$;


--
-- Name: FUNCTION link_staff_profile(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.link_staff_profile() IS 'Called once after first sign-in. Links auth.uid() to the unclaimed staff_profiles row whose email equals the verified JWT email. Cannot hijack an already-linked profile and cannot choose a role.';


--
-- Name: log_payment_authority_event(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_payment_authority_event(p_action text, p_payload jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  insert into audit_logs (id, action, module, new_value)
  values ('aud_' || replace(gen_random_uuid()::text, '-', ''),
          p_action, 'ws7_payments', jsonb_strip_nulls(p_payload)::text);
end $$;


--
-- Name: mark_media_cleanup_candidates(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_media_cleanup_candidates(p_grace_hours integer DEFAULT 24) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_marked int := 0;
  r record;
begin
  for r in
    select id, storage_path, public_url from media_objects
     where (status = 'pending'  and created_at < now() - make_interval(hours => greatest(p_grace_hours, 1)))
        or (status = 'attached' and not exists
             (select 1 from media_references mr where mr.media_object_id = media_objects.id))
  loop
    if not media_path_is_referenced(r.storage_path, r.public_url) then
      update media_objects
         set status = 'cleanup_pending',
             cleanup_after = coalesce(cleanup_after, now())
       where id = r.id;
      v_marked := v_marked + 1;
    end if;
  end loop;
  return v_marked;
end;
$$;


--
-- Name: media_path_is_referenced(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.media_path_is_referenced(p_storage_path text, p_public_url text) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_needle_path text := coalesce(p_storage_path, '');
  v_needle_url  text := coalesce(p_public_url, '');
begin
  if v_needle_path = '' and v_needle_url = '' then
    return true; -- fail SAFE: an unidentifiable object is never eligible
  end if;
  -- Either the storage path or the public URL appearing anywhere counts.
  return exists (select 1 from menu_items  where image like '%' || v_needle_path || '%' or (v_needle_url <> '' and image like '%' || v_needle_url || '%'))
      or exists (select 1 from stores      where image like '%' || v_needle_path || '%' or (v_needle_url <> '' and image like '%' || v_needle_url || '%'))
      or exists (select 1 from news_posts  where image like '%' || v_needle_path || '%' or (v_needle_url <> '' and image like '%' || v_needle_url || '%'))
      or exists (select 1 from cms_pages   where hero_image  like '%' || v_needle_path || '%' or coalesce(about_image1,'') like '%' || v_needle_path || '%' or coalesce(about_image2,'') like '%' || v_needle_path || '%'
                                              or (v_needle_url <> '' and (hero_image like '%' || v_needle_url || '%' or coalesce(about_image1,'') like '%' || v_needle_url || '%' or coalesce(about_image2,'') like '%' || v_needle_url || '%')))
      or exists (select 1 from media_assets where url like '%' || v_needle_path || '%' or (v_needle_url <> '' and url like '%' || v_needle_url || '%'))
      or exists (select 1 from site_content sc where sc::text like '%' || v_needle_path || '%' or (v_needle_url <> '' and sc::text like '%' || v_needle_url || '%'))
      or exists (select 1 from app_state a  where a::text  like '%' || v_needle_path || '%' or (v_needle_url <> '' and a::text  like '%' || v_needle_url || '%'));
end;
$$;


--
-- Name: news_slugify(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.news_slugify(p_input text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select left(
           trim(both '-' from
             regexp_replace(
               lower(translate(coalesce(p_input, ''),
                 'ÀÁÂÃÄÅàáâãäåĀāĂăĄąÇçĆćČčÈÉÊËèéêëĒēĖėĘęĚěÌÍÎÏìíîïĪīĮįÑñŃńŇňÒÓÔÕÖØòóôõöøŌōŒœŚśŠšÙÚÛÜùúûüŪūŮůŸÿÝýŹźŻżŽžÐðÞþßŁł',
                 'AAAAAAaaaaaaAaAaAaCcCcCcEEEEeeeeEeEeEeEeIIIIiiiiIiIiNnNnNnOOOOOOooooooOoOoSsSsUUUUuuuuUuUuYyYyZzZzZzDdTtsLl')),
               '[^a-z0-9]+', '-', 'g')),
           80);
$$;


--
-- Name: open_till_session(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.open_till_session(p_session jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff  text := current_staff_id();
  v_me     staff_profiles%rowtype;
  v_device text := nullif(trim(coalesce(p_session ->> 'deviceId','')), '');
  v_secret text := nullif(p_session ->> 'deviceSecret', '');
  v_float  numeric := coalesce(nullif(p_session ->> 'openingFloat','')::numeric, 0);
  v_dev    web_till_devices%rowtype;
  v_row    web_till_sessions%rowtype;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if v_me.store_id is null then raise exception 'store_scope_denied' using errcode = '42501'; end if;
  if p_session ? 'id' then
    raise exception 'invalid_session'
      using detail = 'Session ids are server-generated; the client no longer supplies one.';
  end if;
  if v_device is null then raise exception 'invalid_session'; end if;
  if v_float < 0 then raise exception 'invalid_opening_float'; end if;

  -- A till device is a CUSTODY IDENTITY, not a self-declared label
  -- (correction 10): it must have been enrolled by a manager or owner, and
  -- the caller must hold its server-issued pairing secret.
  select * into v_dev from web_till_devices where id = v_device;
  if v_dev.id is null or v_dev.credential_hash is null then
    raise exception 'device_not_enrolled' using errcode = '42501',
      detail = 'This device has not been enrolled by a manager or owner.';
  end if;
  if v_dev.revoked then
    raise exception 'till_device_revoked' using errcode = '42501';
  end if;
  if v_dev.store_id is distinct from v_me.store_id then
    raise exception 'device_store_mismatch' using errcode = '42501';
  end if;
  if v_secret is null
     or encode(sha256(convert_to(v_secret, 'utf8')), 'hex') is distinct from v_dev.credential_hash then
    raise exception 'device_credential_invalid' using errcode = '42501',
      detail = 'The pairing secret does not match this device.';
  end if;

  select * into v_row from web_till_sessions
   where device_id = v_device and status = 'OPEN';
  if v_row.id is not null then
    return jsonb_build_object('session', to_jsonb(v_row), 'duplicate', true);
  end if;

  begin
    insert into web_till_sessions
      (id, store_id, device_id, status, opened_by_staff_id, opening_float)
    values ('wts_' || replace(gen_random_uuid()::text, '-', ''),
            v_me.store_id, v_device, 'OPEN', v_staff, v_float)
    returning * into v_row;
  exception when unique_violation then
    -- Two concurrent opens on one device: custody is exclusive, so the loser
    -- receives the winner's session idempotently.
    select * into v_row from web_till_sessions
     where device_id = v_device and status = 'OPEN';
    return jsonb_build_object('session', to_jsonb(v_row), 'duplicate', true);
  end;
  return jsonb_build_object('session', to_jsonb(v_row), 'duplicate', false);
end $$;


--
-- Name: ops_health(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ops_health() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v jsonb := '[]'::jsonb;
  n bigint;
  hb ops_heartbeats;
begin
  if not is_owner() then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;

  -- Notification outbox
  select count(*) into n from notification_outbox where status in ('pending','retry','processing');
  v := v || jsonb_build_object('key','outbox_pending','value',n,
        'state', case when n = 0 then 'healthy' when n < 25 then 'warning' else 'failed' end);
  select count(*) into n from notification_outbox where status in ('dead_letter','blocked_config');
  v := v || jsonb_build_object('key','outbox_dead_or_blocked','value',n,
        'state', case when n = 0 then 'healthy' else 'failed' end);

  -- Unresolved till payments (recovery backlog). Table names guarded.
  if to_regclass('public.pos_payment_recovery') is not null then
    execute 'select count(*) from pos_payment_recovery where resolved_at is null' into n;
    v := v || jsonb_build_object('key','payment_recovery_backlog','value',n,
          'state', case when n = 0 then 'healthy' else 'warning' end);
  elsif to_regclass('public.payment_recovery_records') is not null then
    execute 'select count(*) from payment_recovery_records where resolved_at is null' into n;
    v := v || jsonb_build_object('key','payment_recovery_backlog','value',n,
          'state', case when n = 0 then 'healthy' else 'warning' end);
  else
    v := v || jsonb_build_object('key','payment_recovery_backlog','value',null,'state','unknown');
  end if;

  -- Reserved quotes older than expected (30 min), if the quotes table exists.
  if to_regclass('public.pos_quotes') is not null then
    execute $q$select count(*) from pos_quotes
               where status = 'reserved' and created_at < now() - interval '30 minutes'$q$ into n;
    v := v || jsonb_build_object('key','stale_reserved_quotes','value',n,
          'state', case when n = 0 then 'healthy' else 'warning' end);
  else
    v := v || jsonb_build_object('key','stale_reserved_quotes','value',null,'state','unknown');
  end if;

  -- Disabled-user access attempts (last 24 h), from the server audit if present.
  if to_regclass('public.server_audit_events') is not null then
    execute $q$select count(*) from server_audit_events
               where event = 'disabled_user_attempt' and created_at > now() - interval '24 hours'$q$ into n;
    v := v || jsonb_build_object('key','disabled_access_attempts_24h','value',n,
          'state', case when n = 0 then 'healthy' else 'warning' end);
  else
    v := v || jsonb_build_object('key','disabled_access_attempts_24h','value',null,'state','unknown');
  end if;

  -- Scheduled-job heartbeats: outbox dispatcher, retention sweep, media cleanup,
  -- employment sweep. Missing row ⇒ unknown/not-configured, stale ⇒ failed.
  for hb in select * from ops_heartbeats loop
    v := v || jsonb_build_object('key','job:'||hb.job_name,
          'value', hb.last_run_at,
          'state', case when hb.last_status='failed' then 'failed'
                        when hb.last_run_at < now() - interval '26 hours' then 'failed'
                        else 'healthy' end);
  end loop;
  if not exists (select 1 from ops_heartbeats where job_name='outbox-dispatch') then
    v := v || jsonb_build_object('key','job:outbox-dispatch','value',null,'state','unknown');
  end if;
  if not exists (select 1 from ops_heartbeats where job_name='retention-sweep') then
    v := v || jsonb_build_object('key','job:retention-sweep','value',null,'state','unknown');
  end if;

  -- Native till integration: external channel, honest states only.
  if to_regclass('public.pos_devices') is not null then
    execute 'select count(*) from pos_devices where revoked_at is null' into n;
    v := v || jsonb_build_object('key','native_till_devices','value',n,
          'state', case when n = 0 then 'unknown' else 'healthy' end,
          'note', case when n = 0 then 'not_commissioned' else 'paired' end);
  end if;

  return jsonb_build_object('ok', true, 'generated_at', now(), 'signals', v);
end $_$;


--
-- Name: notification_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_outbox (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    event_type text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    recipient_kind text NOT NULL,
    template_id text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_attempt_at timestamp with time zone,
    provider_message_id text,
    last_error_code text,
    last_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    dead_lettered_at timestamp with time zone,
    CONSTRAINT notification_outbox_recipient_kind_check CHECK ((recipient_kind = ANY (ARRAY['owner_notification'::text, 'customer_ack'::text]))),
    CONSTRAINT notification_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'delivered'::text, 'retry'::text, 'failed'::text, 'dead_letter'::text, 'blocked_config'::text])))
);


--
-- Name: TABLE notification_outbox; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notification_outbox IS 'R4.8 C1: durable notification jobs. Written only by submit_public_form (same txn as the submission); claimed only via outbox_claim_batch (SKIP LOCKED). Browser can neither write rows nor choose recipients.';


--
-- Name: outbox_claim_batch(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.outbox_claim_batch(p_limit integer DEFAULT 10) RETURNS SETOF public.notification_outbox
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: outbox_mark(text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.outbox_mark(p_id text, p_outcome text, p_provider_id text, p_code text, p_message text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: outbox_recent(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.outbox_recent(p_limit integer DEFAULT 50) RETURNS SETOF public.notification_outbox
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select * from notification_outbox
   where is_owner()
   order by created_at desc
   limit greatest(1, least(p_limit, 200));
$$;


--
-- Name: outbox_retry_now(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.outbox_retry_now(p_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if not is_owner() then raise exception 'not_permitted'; end if;
  update notification_outbox
     set status='retry', next_attempt_at=now(), dead_lettered_at=null
   where id = p_id and status in ('failed','dead_letter','retry','blocked_config');
  if not found then return jsonb_build_object('ok', false, 'error', 'not_retryable'); end if;
  return jsonb_build_object('ok', true);
end $$;


--
-- Name: owner_staff_pay(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.owner_staff_pay() RETURNS TABLE(id text, pay_rate numeric, pay_type text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select sp.id, sp.pay_rate, sp.pay_type
  from staff_profiles sp
  where is_owner();
$$;


--
-- Name: pos_apply_approval(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pos_apply_approval(p_device_id uuid, p_store_id text, p jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: pos_authenticate_device(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pos_authenticate_device(p_token_hash text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: pos_catalog_current(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pos_catalog_current() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select jsonb_build_object('catalogVersion', version, 'catalog', snapshot)
    from pos_catalog order by version desc limit 1;
$$;


--
-- Name: pos_catalog_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pos_catalog_version() RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select coalesce((select max(version) from pos_catalog), 0);
$$;


--
-- Name: pos_complete_pairing(text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pos_complete_pairing(p_code_hash text, p_installation_id text, p_device jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: pos_ingest_batch(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pos_ingest_batch(p_device_id uuid, p_events jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: pos_payload_has_forbidden_key(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pos_payload_has_forbidden_key(p jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: pos_pence(jsonb, text[], boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pos_pence(p jsonb, p_path text[], p_required boolean DEFAULT true) RETURNS bigint
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: pos_random_code(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pos_random_code(p_length integer) RETURNS text
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: pos_shift_seal(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pos_shift_seal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.status = 'closed' then
    raise exception 'shift_already_closed';
  end if;
  return new;
end $$;


--
-- Name: pos_text(jsonb, text[], text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pos_text(p jsonb, p_path text[], p_field text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: pos_ts(jsonb, text[], text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pos_ts(p jsonb, p_path text[], p_field text) RETURNS timestamp with time zone
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  return (pos_text(p, p_path, p_field))::timestamptz;
exception when others then
  raise exception using errcode = 'P0001',
    message = 'MPREJ:malformed_payload:' || p_field || ' is not a timestamp';
end;
$$;


--
-- Name: valid_payment_methods(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.valid_payment_methods(p jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  select p is not null
     and jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) between 1 and 4
     and not exists (
       select 1 from jsonb_array_elements_text(p) e
        where e not in ('cash','card','online','gift_card'))
     and (select count(distinct e) = count(e)
            from jsonb_array_elements_text(p) e);
$$;


--
-- Name: stores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stores (
    id text NOT NULL,
    name text NOT NULL,
    address text NOT NULL,
    postcode text NOT NULL,
    opening_hours text DEFAULT ''::text NOT NULL,
    status public.store_status DEFAULT 'coming_soon'::public.store_status NOT NULL,
    delivery_links jsonb DEFAULT '{}'::jsonb NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    image text DEFAULT ''::text NOT NULL,
    coordinates jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    vat_status text DEFAULT 'NOT_REGISTERED'::text NOT NULL,
    vat_number text,
    vat_registration_effective_date date,
    vat_config_confirmed_at timestamp with time zone,
    setup_status text DEFAULT 'DRAFT'::text NOT NULL,
    timezone text,
    currency_code text,
    payment_methods jsonb,
    receipt_footer text DEFAULT ''::text NOT NULL,
    CONSTRAINT stores_currency_supported CHECK (((currency_code IS NULL) OR (currency_code = 'GBP'::text))),
    CONSTRAINT stores_payment_methods_supported CHECK (((payment_methods IS NULL) OR (NOT (payment_methods ? 'gift_card'::text)))),
    CONSTRAINT stores_setup_coherent CHECK (((setup_status = 'DRAFT'::text) OR ((timezone IS NOT NULL) AND ((length(timezone) >= 1) AND (length(timezone) <= 64)) AND (currency_code ~ '^[A-Z]{3}$'::text) AND public.valid_payment_methods(payment_methods) AND (vat_config_confirmed_at IS NOT NULL)))),
    CONSTRAINT stores_setup_status_controlled CHECK ((setup_status = ANY (ARRAY['DRAFT'::text, 'ACTIVE'::text]))),
    CONSTRAINT stores_timezone_supported CHECK (((timezone IS NULL) OR (timezone = 'Europe/London'::text))),
    CONSTRAINT stores_vat_coherent CHECK ((((vat_status = 'NOT_REGISTERED'::text) AND (vat_number IS NULL) AND (vat_registration_effective_date IS NULL)) OR ((vat_status = 'REGISTERED'::text) AND (vat_number ~ '^GB[0-9]{9}([0-9]{3})?$'::text) AND (vat_registration_effective_date IS NOT NULL)))),
    CONSTRAINT stores_vat_status_controlled CHECK ((vat_status = ANY (ARRAY['NOT_REGISTERED'::text, 'REGISTERED'::text])))
);


--
-- Name: COLUMN stores.vat_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.stores.vat_status IS 'NOT_REGISTERED | REGISTERED. Fail-closed default: a new store charges no VAT and cannot trade until vat_config_confirmed_at is set.';


--
-- Name: COLUMN stores.vat_config_confirmed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.stores.vat_config_confirmed_at IS 'Trading gate (closure brief §1): submit_web_order() refuses to trade for a store whose VAT configuration has not been explicitly confirmed. Becomes a Store Setup Wizard completion fact in the setup-lifecycle round.';


--
-- Name: COLUMN stores.setup_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.stores.setup_status IS 'DRAFT (fail-closed default) | ACTIVE. A DRAFT store cannot trade; the owner Setup Wizard (configure_store_setup) is the only client path to ACTIVE. Distinct from stores.status, the public open/closed display state.';


--
-- Name: COLUMN stores.timezone; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.stores.timezone IS 'IANA timezone. The store''s business day derives from local midnight in this zone (the WS2 reporting contract, stated per store).';


--
-- Name: COLUMN stores.payment_methods; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.stores.payment_methods IS 'jsonb array — the ACCEPTED subset of {cash,card,online,gift_card}. submit_web_order refuses methods outside this set.';


--
-- Name: price_basket_internal(public.stores, jsonb, jsonb, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.price_basket_internal(p_store public.stores, p_items jsonb, p_deals jsonb, p_charging boolean) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_items_in jsonb := p_items;
  v_deal_ids jsonb := coalesce(p_deals, '[]'::jsonb);
  v_charging boolean := p_charging;
  it          jsonb;
  md          jsonb;
  m           menu_items%rowtype;
  x           menu_items%rowtype;
  v_size      text;
  v_qty       int;
  v_unit_p    bigint;
  v_mods_p    bigint;
  v_mods      jsonb;
  v_line_p    bigint;
  v_items     jsonb := '[]'::jsonb;
  v_sub_p     bigint := 0;
  -- per-line tax state
  v_line_ps   bigint[]  := '{}';
  v_codes     text[]    := '{}';
  v_rates     numeric[] := '{}';
  v_rate      numeric;
  v_alloc_p   bigint;
  v_taxable_p bigint;
  v_ltax_p    bigint;
  v_cum_prev  bigint;
  v_cum_here  bigint;
  v_tax_sum_p bigint := 0;
  v_uniform   boolean := true;
  v_head_rate numeric := null;
  -- WS6f: effective-date charging + per-line COMPONENT tax model
  v_mod_rate  numeric;
  v_comps     jsonb := '[]'::jsonb;
  v_lcomp     jsonb;
  v_lc        jsonb;
  v_mods2     jsonb;
  v_line_rate numeric;
  v_line_uniform boolean;
  v_ccum_prev bigint;
  v_ccum_here bigint;
  v_cp        bigint;
  v_crate     numeric;
  v_calloc    bigint;
  v_ctaxable  bigint;
  v_ctax      bigint;
  v_mi        int;
  v_uncls_mod text;
  k           int;
  v_items_tx  jsonb := '[]'::jsonb;
  elem        jsonb;
  -- deal engine state
  d           deals%rowtype;
  v_units     bigint[];
  v_group_sum bigint;
  v_disc_p    bigint;
  v_best_p    bigint := 0;
  v_best_deal deals%rowtype;
  v_deals     jsonb := '[]'::jsonb;
  v_disc_tot  bigint := 0;
  v_total_p   bigint;
  g           int;
  i           int;
  j           int;
begin
  -- 5. Price every line from the catalogue (integer pence) and capture its
  --    tax classification. REGISTERED trading refuses unclassified products.
  for i in 0 .. jsonb_array_length(v_items_in) - 1 loop
    it := v_items_in -> i;
    select * into m from menu_items where id = it ->> 'menuItemId';
    if m.id is null then
      raise exception 'unknown_menu_item';
    end if;
    if v_charging and m.tax_code is null then
      raise exception 'product_tax_unclassified'
        using detail = 'Product "' || m.id || '" has no VAT classification; a VAT-charging store cannot sell it.';
    end if;
    if v_charging then
      select rate_percent into v_rate from tax_codes where code = m.tax_code;
    else
      v_rate := 0;
    end if;
    v_qty := coalesce(nullif(it ->> 'quantity', '')::int, 0);
    if v_qty < 1 or v_qty > 99 then
      raise exception 'invalid_quantity';
    end if;
    v_size := case when it ->> 'size' = 'large' then 'large' else 'regular' end;
    v_unit_p := round((case when v_size = 'large' and m.price_large is not null
                            then m.price_large else m.price end) * 100)::bigint;

    v_mods_p := 0;
    v_mods := '[]'::jsonb;
    -- Base component (the product portion of the line) — modifiers append
    -- their own components in payload order inside the loop below.
    v_lcomp := jsonb_build_array(jsonb_build_object(
      'p', v_unit_p * v_qty, 'rate', v_rate, 'code', m.tax_code, 'mi', -1));
    if jsonb_typeof(it -> 'modifiers') = 'array' then
      if jsonb_array_length(it -> 'modifiers') > 20 then
        raise exception 'invalid_modifiers';
      end if;
      for j in 0 .. jsonb_array_length(it -> 'modifiers') - 1 loop
        md := it -> 'modifiers' -> j;
        select * into x from menu_items
          where id = md ->> 'menuItemId' and category = 'extras';
        if x.id is null then
          raise exception 'unknown_extra';
        end if;
        -- WS6f (auditor F5): an extra is taxed by ITS OWN classification,
        -- never by the base product's. A charging store refuses an
        -- unclassified extra exactly as it refuses an unclassified product.
        if v_charging and x.tax_code is null then
          raise exception 'product_tax_unclassified'
            using detail = 'Extra "' || x.id || '" has no VAT classification; a VAT-charging store cannot sell it.';
        end if;
        if v_charging then
          select rate_percent into v_mod_rate from tax_codes where code = x.tax_code;
        else
          v_mod_rate := 0;
        end if;
        v_mods_p := v_mods_p + round(x.price * 100)::bigint;
        v_lcomp := v_lcomp || jsonb_build_array(jsonb_build_object(
          'p', round(x.price * 100)::bigint * v_qty,
          'rate', v_mod_rate, 'code', x.tax_code, 'mi', j));
        v_mods := v_mods || jsonb_build_array(jsonb_build_object(
          'id', 'mod_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10),
          'menuItemId', x.id, 'name', x.name, 'price', round(x.price * 100) / 100.0));
      end loop;
    end if;

    v_line_p := (v_unit_p + v_mods_p) * v_qty;
    v_sub_p  := v_sub_p + v_line_p;
    v_line_ps := v_line_ps || v_line_p;
    v_comps   := v_comps || jsonb_build_array(v_lcomp);
    v_codes   := v_codes   || m.tax_code;
    v_rates   := v_rates   || v_rate;
    v_items  := v_items || jsonb_build_array(jsonb_build_object(
      'id', 'li_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
      'menuItemId', m.id, 'name', m.name, 'category', m.category,
      'size', v_size, 'unitPrice', v_unit_p / 100.0, 'quantity', v_qty,
      'modifiers', v_mods, 'lineTotal', v_line_p / 100.0,
      'notes', nullif(trim(coalesce(it ->> 'notes', '')), '')));
  end loop;

  -- 6. Deals — recomputed HERE with the client engine's semantics: units are
  --    the BASE prices (extras stay charged), sorted dearest-first; only the
  --    single best-scoring claimed deal applies; a claim that computes to
  --    zero is dropped.
  if jsonb_typeof(v_deal_ids) = 'array' and jsonb_array_length(v_deal_ids) > 0 then
    for i in 0 .. least(jsonb_array_length(v_deal_ids), 10) - 1 loop
      select * into d from deals
        where id = v_deal_ids ->> i and active = true;
      if d.id is null then continue; end if;
      v_disc_p := 0;

      if d.type in ('bundle_price', 'buy_x_get_y_free', 'percent_off_category')
         and d.category is not null then
        select coalesce(array_agg(u order by u desc), '{}')
          into v_units
          from (select round((q ->> 'unitPrice')::numeric * 100)::bigint as u
                  from jsonb_array_elements(v_items) q,
                       generate_series(1, (q ->> 'quantity')::int)
                 where q ->> 'category' = d.category::text) s;
      end if;

      if d.type = 'bundle_price'
         and d.buy_qty is not null and d.buy_qty > 0 and d.bundle_price is not null then
        for g in 0 .. (coalesce(array_length(v_units, 1), 0) / d.buy_qty) - 1 loop
          v_group_sum := 0;
          for j in 1 .. d.buy_qty loop
            v_group_sum := v_group_sum + v_units[g * d.buy_qty + j];
          end loop;
          if v_group_sum > round(d.bundle_price * 100)::bigint then
            v_disc_p := v_disc_p + v_group_sum - round(d.bundle_price * 100)::bigint;
          end if;
        end loop;

      elsif d.type = 'buy_x_get_y_free'
         and d.buy_qty is not null and d.buy_qty > 0
         and d.free_qty is not null and d.free_qty > 0 then
        for g in 0 .. (coalesce(array_length(v_units, 1), 0) / (d.buy_qty + d.free_qty)) - 1 loop
          -- within each dearest-first group, the trailing free_qty units are
          -- the cheapest — those go free.
          for j in d.buy_qty + 1 .. d.buy_qty + d.free_qty loop
            v_disc_p := v_disc_p + v_units[g * (d.buy_qty + d.free_qty) + j];
          end loop;
        end loop;

      elsif d.type = 'percent_off_category' and d.percent_off is not null then
        select coalesce(sum(u), 0) into v_group_sum from unnest(v_units) u;
        v_disc_p := round(v_group_sum * d.percent_off / 100);

      elsif d.type = 'fixed_off_order' and d.amount_off is not null then
        if d.min_order_value is null
           or v_sub_p >= round(d.min_order_value * 100)::bigint then
          v_disc_p := least(round(d.amount_off * 100)::bigint, v_sub_p);
        end if;
      end if;

      if v_disc_p > v_best_p then
        v_best_p := v_disc_p;
        v_best_deal := d;
      end if;
    end loop;

    if v_best_p > 0 then
      v_best_p := least(v_best_p, v_sub_p);
      v_disc_tot := v_best_p;
      v_deals := jsonb_build_array(jsonb_build_object(
        'dealId', v_best_deal.id, 'dealName', v_best_deal.name,
        'discount', v_best_p / 100.0));
    end if;
  end if;

  -- 7. Totals — VAT-inclusive UK pricing; payment facts validated.
  v_total_p := greatest(v_sub_p - v_disc_tot, 0);

  -- 7a. Per-line tax snapshots (WS6f component model). The order discount is
  --     allocated over the LINES by cumulative largest-exact shares, then the
  --     SAME method splits each line's share across its COMPONENTS (base
  --     portion first, then each modifier in payload order). Every component
  --     is taxed at ITS OWN rate with the single rounding step
  --     round(taxable_pence × rate / (100 + rate)); the line's tax is the sum
  --     of its component taxes, the order's tax is the sum of the line taxes
  --     — no re-rounding anywhere. A line whose components carry mixed rates
  --     snapshots a NULL line rate (the modifier rows are the authority),
  --     exactly as a mixed-rate ORDER snapshots a NULL headline rate.
  v_cum_prev := 0;
  for i in 1 .. coalesce(array_length(v_line_ps, 1), 0) loop
    v_cum_here := v_cum_prev + v_line_ps[i];
    if v_sub_p > 0 then
      v_alloc_p := (v_disc_tot * v_cum_here / v_sub_p)
                 - (v_disc_tot * v_cum_prev / v_sub_p);
    else
      v_alloc_p := 0;
    end if;
    v_cum_prev  := v_cum_here;
    v_taxable_p := v_line_ps[i] - v_alloc_p;

    v_lc := v_comps -> (i - 1);
    v_ltax_p := 0;
    v_line_rate := null;
    v_line_uniform := true;
    v_ccum_prev := 0;
    v_mods2 := (v_items -> (i - 1)) -> 'modifiers';
    for k in 0 .. jsonb_array_length(v_lc) - 1 loop
      v_cp    := ((v_lc -> k) ->> 'p')::bigint;
      v_crate := ((v_lc -> k) ->> 'rate')::numeric;
      v_ccum_here := v_ccum_prev + v_cp;
      if v_line_ps[i] > 0 then
        v_calloc := (v_alloc_p * v_ccum_here / v_line_ps[i])
                  - (v_alloc_p * v_ccum_prev / v_line_ps[i]);
      else
        v_calloc := 0;
      end if;
      v_ccum_prev := v_ccum_here;
      v_ctaxable := v_cp - v_calloc;
      v_ctax     := round(v_ctaxable * v_crate / (100 + v_crate));
      v_ltax_p   := v_ltax_p + v_ctax;
      if v_line_rate is null then v_line_rate := v_crate;
      elsif v_line_rate <> v_crate then v_line_uniform := false;
      end if;
      if v_head_rate is null then v_head_rate := v_crate;
      elsif v_head_rate <> v_crate then v_uniform := false;
      end if;
      v_mi := ((v_lc -> k) ->> 'mi')::int;
      if v_mi >= 0 then
        v_mods2 := jsonb_set(v_mods2, array[v_mi::text], (v_mods2 -> v_mi) || jsonb_build_object(
          'taxCode', (v_lc -> k) -> 'code',
          'taxRate', v_crate,
          'taxableAmount', v_ctaxable / 100.0,
          'taxAmount', v_ctax / 100.0));
      end if;
    end loop;
    v_tax_sum_p := v_tax_sum_p + v_ltax_p;
    elem := (v_items -> (i - 1)) || jsonb_build_object(
      'modifiers', v_mods2,
      'taxCode', v_codes[i],
      'taxRate', case when v_line_uniform then v_line_rate else null end,
      'taxableAmount', v_taxable_p / 100.0,
      'taxAmount', v_ltax_p / 100.0);
    v_items_tx := v_items_tx || jsonb_build_array(elem);
  end loop;
  v_items := v_items_tx;

  return jsonb_build_object(
    'items',          v_items,
    'deals',          v_deals,
    'subtotalP',      v_sub_p,
    'discountTotalP', v_disc_tot,
    'taxAmountP',     v_tax_sum_p,
    'totalP',         v_total_p,
    'uniform',        v_uniform,
    'headRate',       v_head_rate
  );
end $$;


--
-- Name: publication_candidate_errors(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publication_candidate_errors(p_table text, p_candidate jsonb) RETURNS text[]
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $$
declare
  v text[] := '{}';
begin
  if p_table = 'menu_items' then
    if coalesce(trim(p_candidate->>'name'), '') = '' then v := v || 'name is blank'::text; end if;
    if (p_candidate->>'price') is null or (p_candidate->>'price')::numeric < 0 then
      v := v || 'price must be zero or more'::text; end if;
    if (p_candidate->>'price_large') is not null and (p_candidate->>'price_large')::numeric < 0 then
      v := v || 'large price must be zero or more'::text; end if;
    if coalesce(trim(p_candidate->>'image'), '') = '' then v := v || 'image is missing'::text;
    elsif trim(p_candidate->>'image') = 'placeholder' then
      v := v || 'image is the ''placeholder'' default — attach a real approved image'::text; end if;

  elsif p_table = 'deals' then
    if coalesce(trim(p_candidate->>'name'), '') = '' then v := v || 'name is blank'::text; end if;
    if p_candidate->>'type' = 'bundle_price' then
      if coalesce((p_candidate->>'buy_qty')::int, 0) < 1 then v := v || 'bundle_price needs buy_qty of at least 1'::text; end if;
      if (p_candidate->>'bundle_price') is null or (p_candidate->>'bundle_price')::numeric <= 0 then
        v := v || 'bundle_price needs a positive bundle price'::text; end if;
      if (p_candidate->>'category') is null then v := v || 'bundle_price needs a category'::text; end if;
    elsif p_candidate->>'type' = 'buy_x_get_y_free' then
      if coalesce((p_candidate->>'buy_qty')::int, 0) < 1 then v := v || 'buy_x_get_y_free needs buy_qty of at least 1'::text; end if;
      if coalesce((p_candidate->>'free_qty')::int, 0) < 1 then v := v || 'buy_x_get_y_free needs free_qty of at least 1'::text; end if;
      if (p_candidate->>'category') is null then v := v || 'buy_x_get_y_free needs a category'::text; end if;
    elsif p_candidate->>'type' = 'percent_off_category' then
      if (p_candidate->>'percent_off') is null
         or (p_candidate->>'percent_off')::numeric <= 0
         or (p_candidate->>'percent_off')::numeric > 100 then
        v := v || 'percent_off must be between 0 and 100'::text; end if;
      if (p_candidate->>'category') is null then v := v || 'percent_off_category needs a category'::text; end if;
    elsif p_candidate->>'type' = 'fixed_off_order' then
      if (p_candidate->>'amount_off') is null or (p_candidate->>'amount_off')::numeric <= 0 then
        v := v || 'fixed_off_order needs a positive amount off'::text; end if;
      if (p_candidate->>'min_order_value') is not null and (p_candidate->>'min_order_value')::numeric < 0 then
        v := v || 'minimum order value cannot be negative'::text; end if;
    end if;

  elsif p_table = 'news_posts' then
    if coalesce(trim(p_candidate->>'title'), '') = '' then
      v := v || 'title is blank (the public slug derives from it)'::text; end if;
    if coalesce(trim(p_candidate->>'content'), '') = '' then v := v || 'content is blank'::text; end if;
    if coalesce(trim(p_candidate->>'date'), '') = '' then v := v || 'date is blank'::text; end if;

  elsif p_table = 'job_vacancies' then
    if coalesce(trim(p_candidate->>'title'), '') = '' then v := v || 'title is blank'::text; end if;
    if coalesce(trim(p_candidate->>'location'), '') = '' then v := v || 'location is blank'::text; end if;
    if coalesce(trim(p_candidate->>'salary'), '') = '' then v := v || 'salary wording is blank'::text; end if;
    if coalesce(trim(p_candidate->>'role_description'), '') = '' then v := v || 'role description is blank'::text; end if;

  else
    return array[p_table || ' has no publication contract'];
  end if;

  return v;
end $$;


--
-- Name: FUNCTION publication_candidate_errors(p_table text, p_candidate jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.publication_candidate_errors(p_table text, p_candidate jsonb) IS 'INC11: THE publication contract, evaluated against a CANDIDATE row as JSON. Never reloads the stored row — inside BEFORE UPDATE that would be the OLD row (the chain-76 lesson). Called by publish_record, the final-state trigger, and every future sanctioned save path.';


--
-- Name: publication_completeness_errors(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publication_completeness_errors(p_table text, p_id text) RETURNS text[]
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
declare
  v text[] := '{}';
  r record;
begin
  if p_table = 'menu_items' then
    select * into r from menu_items where id = p_id;
    if not found then return array['record not found']; end if;
    if coalesce(trim(r.name), '') = '' then v := v || 'name is blank'::text; end if;
    if r.price is null or r.price < 0 then v := v || 'price must be zero or more'::text; end if;
    if r.price_large is not null and r.price_large < 0 then v := v || 'large price must be zero or more'::text; end if;
    if coalesce(trim(r.image), '') = '' then v := v || 'image is missing'::text; end if;

  elsif p_table = 'deals' then
    select * into r from deals where id = p_id;
    if not found then return array['record not found']; end if;
    if coalesce(trim(r.name), '') = '' then v := v || 'name is blank'::text; end if;
    if r.type = 'bundle_price' then
      if coalesce(r.buy_qty, 0) < 1 then v := v || 'bundle_price needs buy_qty of at least 1'::text; end if;
      if r.bundle_price is null or r.bundle_price <= 0 then v := v || 'bundle_price needs a positive bundle price'::text; end if;
      if r.category is null then v := v || 'bundle_price needs a category'::text; end if;
    elsif r.type = 'buy_x_get_y_free' then
      if coalesce(r.buy_qty, 0) < 1 then v := v || 'buy_x_get_y_free needs buy_qty of at least 1'::text; end if;
      if coalesce(r.free_qty, 0) < 1 then v := v || 'buy_x_get_y_free needs free_qty of at least 1'::text; end if;
      if r.category is null then v := v || 'buy_x_get_y_free needs a category'::text; end if;
    elsif r.type = 'percent_off_category' then
      if r.percent_off is null or r.percent_off <= 0 or r.percent_off > 100 then
        v := v || 'percent_off must be between 0 and 100'::text; end if;
      if r.category is null then v := v || 'percent_off_category needs a category'::text; end if;
    elsif r.type = 'fixed_off_order' then
      if r.amount_off is null or r.amount_off <= 0 then v := v || 'fixed_off_order needs a positive amount off'::text; end if;
      if r.min_order_value is not null and r.min_order_value < 0 then v := v || 'minimum order value cannot be negative'::text; end if;
    end if;

  elsif p_table = 'job_vacancies' then
    select * into r from job_vacancies where id = p_id;
    if not found then return array['record not found']; end if;
    if coalesce(trim(r.title), '') = '' then v := v || 'title is blank'::text; end if;
    if coalesce(trim(r.location), '') = '' then v := v || 'location is blank'::text; end if;
    if coalesce(trim(r.salary), '') = '' then v := v || 'salary wording is blank'::text; end if;
    if coalesce(trim(r.role_description), '') = '' then v := v || 'role description is blank'::text; end if;

  elsif p_table = 'news_posts' then
    select * into r from news_posts where id = p_id;
    if not found then return array['record not found']; end if;
    if coalesce(trim(r.title), '') = '' then v := v || 'title is blank (the public slug derives from it)'::text; end if;
    if coalesce(trim(r.content), '') = '' then v := v || 'content is blank'::text; end if;
    if coalesce(trim(r.date), '') = '' then v := v || 'date is blank'::text; end if;

  elsif p_table = 'cms_pages' then
    select * into r from cms_pages where id = p_id;
    if not found then return array['record not found']; end if;
    if coalesce(trim(r.page_name), '') = '' then v := v || 'page name is blank'::text; end if;
    if coalesce(trim(r.title), '') = '' then v := v || 'title is blank'::text; end if;
    if coalesce(trim(r.hero_headline), '') = '' and coalesce(trim(r.section_content), '') = '' then
      v := v || 'page has neither a hero headline nor section content'::text; end if;
    if coalesce(trim(r.seo_title), '') = '' then v := v || 'SEO title is blank'::text; end if;

  elsif p_table = 'media_assets' then
    select * into r from media_assets where id = p_id;
    if not found then return array['record not found']; end if;
    if coalesce(trim(r.url), '') = '' then v := v || 'asset URL is blank'::text; end if;
    if coalesce(trim(r.type), '') = '' then v := v || 'asset type is blank'::text; end if;

  else
    return array[p_table || ' has no completeness rule'];
  end if;

  return v;
end $$;


--
-- Name: FUNCTION publication_completeness_errors(p_table text, p_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.publication_completeness_errors(p_table text, p_id text) IS 'R4.10: the database-level floor a record must meet before publish_record may make it public. Empty array = publishable. UI validation can be stricter; it can never be the only line, because RPCs are callable without the UI.';


--
-- Name: publish_pos_catalog(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publish_pos_catalog(p_snapshot jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_version integer;
  section text;
  arr jsonb;
  it jsonb;
begin
  if not is_owner() then
    raise exception 'Only the owner can publish the till catalogue.';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'The catalogue snapshot must be a JSON object.';
  end if;
  if pos_payload_has_forbidden_key(p_snapshot) then
    raise exception 'The catalogue snapshot contains a forbidden key.';
  end if;

  foreach section in array array['categories','products','modifiers','deals'] loop
    arr := p_snapshot -> section;
    if arr is not null and jsonb_typeof(arr) <> 'array' then
      raise exception 'Catalogue section % must be an array.', section;
    end if;
  end loop;
  if (p_snapshot ? 'products') and not (p_snapshot ? 'categories') then
    raise exception 'Products may only be published together with categories.';
  end if;

  -- Money and identity spot-checks (the till re-validates on apply).
  for it in select * from jsonb_array_elements(coalesce(p_snapshot -> 'products', '[]'::jsonb)) loop
    perform pos_text(it, '{id}', 'product.id');
    perform pos_text(it, '{categoryId}', 'product.categoryId');
    perform pos_text(it, '{name}', 'product.name');
    perform pos_pence(it, '{basePricePence}');
    perform pos_pence(it, '{largePricePence}', false);
    perform pos_pence(it, '{vatRateBp}');
  end loop;
  for it in select * from jsonb_array_elements(coalesce(p_snapshot -> 'modifiers', '[]'::jsonb)) loop
    perform pos_text(it, '{id}', 'modifier.id');
    perform pos_pence(it, '{pricePence}');
  end loop;
  for it in select * from jsonb_array_elements(coalesce(p_snapshot -> 'categories', '[]'::jsonb)) loop
    perform pos_text(it, '{id}', 'category.id');
    perform pos_text(it, '{name}', 'category.name');
  end loop;

  insert into pos_catalog (version, snapshot, published_by)
  values (coalesce((select max(version) from pos_catalog), 0) + 1,
          p_snapshot, current_staff_id())
  returning version into v_version;
  return v_version;
end;
$$;


--
-- Name: publish_record(text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publish_record(p_table text, p_id text, p_publish boolean) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
declare
  v_col     text;
  v_on      text;
  v_off     text;
  v_type    text;
  v_role    text;
  v_before  text;
  v_after   text;
  v_exists  bigint;
  v_rows    integer;
  v_rev     bigint;
begin
  select c, onv, offv, ty into v_col, v_on, v_off, v_type from (values
    ('menu_items',    'available', 'true',      'false', 'boolean'),
    ('deals',         'active',    'true',      'false', 'boolean'),
    ('news_posts',    'status',    'published', 'draft', 'text'),
    ('job_vacancies', 'status',    'published', 'draft', 'text')
  ) as t(tbl, c, onv, offv, ty) where t.tbl = p_table;

  if v_col is null then
    if p_table in ('media_assets', 'cms_pages') then
      raise exception
        'publish_record: % left the publication scope in INC11 — media byte visibility '
        'is governed by the records that reference an asset (the bucket is public), and '
        'cms_pages drives no public route. See the supersession note in '
        'migration_inc11_publication_scope.sql.', p_table
        using errcode = 'check_violation';
    end if;
    raise exception 'publish_record: % is not a publishable collection', p_table
      using errcode = 'check_violation';
  end if;

  v_role := current_staff_role();
  if v_role is null then
    raise exception 'publish_record: publishing requires an active staff account '
      '(anonymous and disabled sessions are refused)'
      using errcode = 'insufficient_privilege';
  end if;
  if not is_aal2() then
    raise exception 'publish_record: publishing requires a verified second factor (AAL2). '
      'Complete the TOTP step and try again.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_role = 'owner' then
    null;
  elsif v_role = 'store_manager' then
    if p_table <> 'menu_items' then
      raise exception 'publish_record: a store manager may publish menu items only — % requires the owner', p_table
        using errcode = 'insufficient_privilege';
    end if;
  else
    raise exception 'publish_record: role % may not publish', v_role
      using errcode = 'insufficient_privilege';
  end if;

  execute format('select count(*) from %I where id = $1', p_table) into v_exists using p_id;
  if v_exists <> 1 then
    raise exception 'publish_record: expected exactly 1 % row with id %, found %',
      p_table, p_id, v_exists using errcode = 'no_data_found';
  end if;

  -- Sanction the lifecycle write for THIS transaction only. The final-state
  -- trigger still validates the candidate; the launch-context gates
  -- (armed-gates, allergen posture) still fire on the same write.
  perform set_config('milkpop.publication_rpc', '1', true);

  execute format('select %I::text from %I where id = $1', v_col, p_table)
    into v_before using p_id;
  execute format('update %I set %I = $1::%s where id = $2', p_table, v_col, v_type)
    using (case when p_publish then v_on else v_off end), p_id;
  get diagnostics v_rows = ROW_COUNT;
  if v_rows <> 1 then
    raise exception 'publish_record: expected to update exactly 1 row, updated %', v_rows
      using errcode = 'check_violation';
  end if;
  execute format('select %I::text from %I where id = $1', v_col, p_table)
    into v_after using p_id;

  insert into audit_logs (id, operator_name, role, action, timestamp, module,
                          previous_value, new_value)
  values ('aud_' || replace(gen_random_uuid()::text, '-', ''),
          coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', 'unknown'),
          v_role,
          case when p_publish then 'publish' else 'unpublish' end,
          now(), p_table, v_before, v_after);

  select revision into v_rev from collection_revisions where table_key = p_table;
  return jsonb_build_object(
    'table', p_table, 'id', p_id, 'column', v_col,
    'previous', v_before, 'current', v_after, 'revision', v_rev);
end
$_$;


--
-- Name: FUNCTION publish_record(p_table text, p_id text, p_publish boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.publish_record(p_table text, p_id text, p_publish boolean) IS 'INC11: the sanctioned publication path for the FOUR public collections. Explicit matrix + AAL2 + audit; sets the transaction-local sanction the lifecycle guard requires; completeness is enforced by the final-state trigger on the same write. Returns the new collection revision so editors know their snapshot aged.';


--
-- Name: purge_employee(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_employee(p_employee_id text, p_typed_name text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare v_name text; v_deps text[] := '{}';
begin
  if not is_owner() then raise exception 'not_permitted'; end if;
  select name into v_name from staff_profiles where id = p_employee_id;
  if not found then raise exception 'not_found'; end if;
  if p_typed_name is distinct from v_name then raise exception 'confirmation_mismatch'; end if;

  if exists (select 1 from work_shifts    where employee_id = p_employee_id) then v_deps := v_deps || 'shifts'::text; end if;
  if exists (select 1 from clock_history  where employee_id = p_employee_id) then v_deps := v_deps || 'clock_history'::text; end if;
  if exists (select 1 from payslips       where employee_id = p_employee_id) then v_deps := v_deps || 'payroll'::text; end if;
  if exists (select 1 from staff_documents where employee_id = p_employee_id) then v_deps := v_deps || 'documents'::text; end if;
  if exists (select 1 from staff_compliance_records where employee_id = p_employee_id) then v_deps := v_deps || 'compliance'::text; end if;
  if exists (select 1 from training_results where employee_id = p_employee_id) then v_deps := v_deps || 'training'::text; end if;
  if exists (select 1 from sifr_reports  where reporter_id = p_employee_id) then v_deps := v_deps || 'sifr'::text; end if;
  if array_length(v_deps,1) is not null then
    return jsonb_build_object('ok', false, 'error', 'has_dependent_history', 'dependencies', to_jsonb(v_deps));
  end if;

  delete from staff_profiles where id = p_employee_id;
  insert into audit_logs (id, operator_name, role, action, timestamp, module, previous_value)
  values (gen_random_uuid()::text, current_staff_id(), 'owner',
          'employment.purged_duplicate', now()::text, 'Team', p_employee_id || ' ' || v_name);
  return jsonb_build_object('ok', true);
end $$;


--
-- Name: FUNCTION purge_employee(p_employee_id text, p_typed_name text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.purge_employee(p_employee_id text, p_typed_name text) IS 'R4.8 B guarded duplicate purge, R4.9 G2 correction: array appends cast to ::text so has_dependent_history can be returned (the R4.8 form raised SQLSTATE 22P02 instead).';


--
-- Name: purge_expired_cvs(interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_expired_cvs(retain interval) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_cutoff   timestamptz := now() - retain;
  v_purged   integer := 0;
  v_enqueued integer := 0;
begin
  with expired as (
    select id, cv_path
      from job_applications
     where status = 'declined'
       and cv_path is not null and cv_path <> ''
       and updated_at < v_cutoff
  ),
  enqueue as (
    insert into storage_cleanup_jobs (bucket, storage_path, reason)
    select 'cvs', e.cv_path, 'ws9_retention: cv link purged (purge_expired_cvs)'
      from expired e
    on conflict (bucket, storage_path) do nothing
    returning 1
  ),
  cleared as (
    update job_applications a
       set cv_path = null
      from expired e
     where a.id = e.id
    returning 1
  )
  select coalesce((select count(*) from cleared), 0),
         coalesce((select count(*) from enqueue), 0)
    into v_purged, v_enqueued;

  -- v_enqueued can be lower than v_purged only when a job for that object
  -- already exists — the queue's (bucket, storage_path) uniqueness at work.
  insert into retention_runs (entity, cutoff, rows_deleted, jobs_enqueued, details)
  values ('cv_links', v_cutoff, v_purged, v_enqueued,
          jsonb_build_object('function', 'purge_expired_cvs'));
  return v_purged;
end;
$$;


--
-- Name: FUNCTION purge_expired_cvs(retain interval); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.purge_expired_cvs(retain interval) IS 'Clears cv_path and enqueues a CONFIRMED Storage delete for DECLINED applications older than the given interval (metadata row retained — use retention_purge_job_applications to delete the row as well). Idempotent; logged in retention_runs. Schedule via pg_cron. Not client-callable.';


--
-- Name: reconcile_card_payment(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reconcile_card_payment(p_settlement jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff    text := current_staff_id();
  v_me       staff_profiles%rowtype;
  v_res_id   text := p_settlement ->> 'reservationId';
  v_order_in text := p_settlement ->> 'orderId';
  v_a        quote_payment_attempts%rowtype;
  v_o        orders%rowtype;
  v_etype    text := nullif(trim(coalesce(p_settlement ->> 'evidenceType','')), '');
  v_extref   text := nullif(trim(coalesce(p_settlement ->> 'externalReference','')), '');
  v_ccy      text := nullif(trim(coalesce(p_settlement ->> 'currency','')), '');
  v_amt_raw  text := nullif(p_settlement ->> 'matchedAmount','');
  v_evt_raw  text := nullif(p_settlement ->> 'paymentEventAt','');
  v_reason   text := nullif(trim(coalesce(p_settlement ->> 'reason','')), '');
  v_idem     text := nullif(trim(coalesce(p_settlement ->> 'idempotencyKey','')), '');
  v_amt_p    bigint;
  v_hash     text;
  v_existing payment_reconciliations%rowtype;
  v_row      payment_reconciliations%rowtype;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;
  -- manager/owner AND an MFA-verified session (explicit, per the R3 contract).
  if not is_manager_or_owner() or not is_aal2() then
    raise exception 'reconciliation_denied' using errcode = '42501',
      detail = 'Manual reconciliation requires a manager or owner with an MFA-verified session.';
  end if;

  -- Required manual-evidence fields.
  if v_reason is null or length(v_reason) < 10 then
    raise exception 'reason_required'
      using detail = 'A written reason (at least 10 characters) is required.';
  end if;
  if v_etype is null then
    raise exception 'evidence_type_required'
      using detail = 'An evidence type is required (terminal_receipt, z_report, merchant_portal or settlement_statement).';
  end if;
  if v_etype not in ('terminal_receipt','z_report','merchant_portal','settlement_statement') then
    raise exception 'invalid_evidence_type';
  end if;
  if v_extref is null then
    raise exception 'external_reference_required'
      using detail = 'An external evidence reference is required.';
  end if;
  if v_ccy is null then raise exception 'currency_required'; end if;
  if v_amt_raw is null or v_evt_raw is null then
    raise exception 'settlement_evidence_required'
      using detail = 'A matched amount and payment-event timestamp are required.';
  end if;
  if v_idem is null or length(v_idem) < 8 then
    raise exception 'idempotency_key_required'
      using detail = 'An idempotency key (at least 8 characters) is required.';
  end if;
  -- Currency bound (finding 4): MilkPop sells in GBP; a mismatched currency is
  -- not something manual reconciliation may assert away.
  if upper(v_ccy) <> 'GBP' then
    raise exception 'currency_not_supported' using errcode = '42501',
      detail = 'Manual reconciliation currency must be GBP.';
  end if;
  v_amt_p := round(v_amt_raw::numeric * 100)::bigint;

  -- Locate the consumed attempt (by reservation, or by completed order).
  if v_res_id is null and v_order_in is not null then
    select * into v_a from quote_payment_attempts
     where completed_order_id = v_order_in for update;
  else
    select * into v_a from quote_payment_attempts
     where reservation_id = v_res_id for update;
  end if;
  if v_a.reservation_id is null then
    raise exception 'invalid_reservation' using detail = 'No such consumed payment attempt.';
  end if;
  -- Identity coherence (finding 5): when BOTH ids are supplied they must resolve
  -- to the SAME payment, never a reservation of order A with the id of order B.
  if v_res_id is not null and v_order_in is not null
     and v_a.completed_order_id is distinct from v_order_in then
    raise exception 'payment_identity_mismatch' using errcode = '42501',
      detail = 'The reservation and order do not identify the same payment.';
  end if;
  if not is_owner() and v_a.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;
  if v_a.state <> 'CONSUMED' then
    raise exception 'attempt_not_consumed'
      using detail = 'Only a completed payment can be reconciled against evidence.';
  end if;
  if v_a.payment_method = 'cash' then
    raise exception 'cash_not_provider_reconciled'
      using detail = 'Cash is reconciled through drawer counts, not external card/online evidence.';
  end if;

  -- CANONICAL request hash, built only AFTER the payment identity is resolved.
  -- It names the RESOLVED reservation and order — never the supplied variant —
  -- so an equivalent retry sent by reservation, by order, or by both hashes
  -- identically and replays cleanly instead of conflicting. The payment-event
  -- time is normalised to epoch milliseconds so equivalent timestamp spellings
  -- (offsets, trailing zeros) are the same claim, and the written reason is part
  -- of the claim, so a changed reason is a DIFFERENT claim, not a silent replay.
  v_hash := canonical_request_hash(jsonb_build_object(
    'op', 'reconcile_card_payment',
    'reservationId', v_a.reservation_id,
    'orderId', v_a.completed_order_id,
    'evidenceType', v_etype, 'externalReference', v_extref, 'currency', upper(v_ccy),
    'matchedAmountP', v_amt_p,
    'paymentEventAtMs', (extract(epoch from v_evt_raw::timestamptz) * 1000)::bigint,
    'idempotencyKey', v_idem, 'reason', v_reason));

  -- Idempotent replay: same idempotency key.
  select * into v_existing from payment_reconciliations
   where store_id = v_a.store_id and idempotency_key = v_idem;
  if v_existing.id is not null then
    if v_existing.evidence_hash = v_hash then
      return jsonb_build_object('reconciliation', to_jsonb(v_existing), 'duplicate', true);
    end if;
    raise exception 'idempotency_conflict' using errcode = '42501',
      detail = 'That idempotency key was already used with different evidence.';
  end if;
  -- One evidence row per attempt (unchanged invariant).
  if exists (select 1 from payment_reconciliations where attempt_reservation_id = v_a.reservation_id) then
    raise exception 'already_reconciled' using errcode = '42501',
      detail = 'This payment already has a reconciliation record.';
  end if;

  select * into v_o from orders where id = v_a.completed_order_id for update;
  -- Payment-event time must be plausible (finding 4): not materially in the
  -- future, and not materially before the recorded sale.
  if v_evt_raw::timestamptz > now() + interval '1 hour' then
    raise exception 'payment_time_in_future' using errcode = '42501',
      detail = 'The payment-event time cannot be in the future.';
  end if;
  if v_evt_raw::timestamptz < v_o.created_at - interval '2 days' then
    raise exception 'payment_time_implausible' using errcode = '42501',
      detail = 'The payment-event time predates the recorded sale.';
  end if;
  -- Matched amount must equal the recorded order total; discrepancies are a
  -- Round-10A financial-actions concern, not something reconciliation invents.
  if v_amt_p is distinct from round(v_o.total * 100)::bigint then
    raise exception 'settlement_amount_mismatch'
      using detail = 'The matched amount must equal the recorded order total.';
  end if;

  -- Immutable evidence row FIRST (the ledger trigger requires it to exist).
  -- Concurrency-safe idempotency (finding 3): if a simultaneous call won the
  -- race, catch the unique violation and resolve it as a proper replay/conflict
  -- rather than surfacing a raw constraint error.
  begin
    insert into payment_reconciliations
      (id, attempt_reservation_id, order_id, store_id, provider, provider_reference,
       settlement_source, settled_amount, settled_at, settlement_reference,
       evidence_hash, reason, recorded_by_staff_id,
       evidence_type, matched_currency, idempotency_key, payment_event_at)
    values
      ('rec_' || replace(gen_random_uuid()::text, '-', ''),
       v_a.reservation_id, v_o.id, v_a.store_id, coalesce(v_a.payment_provider, 'manual'),
       v_a.provider_reference, v_etype, v_amt_p / 100.0, v_evt_raw::timestamptz, v_extref,
       v_hash, v_reason, v_staff,
       v_etype, upper(v_ccy), v_idem, v_evt_raw::timestamptz)
    returning * into v_row;
  exception when unique_violation then
    -- The winner has committed (our insert blocked on its lock, then failed), so
    -- its row is now visible. Same key + same hash is a no-op; different hash is
    -- a genuine conflict; otherwise the one-per-attempt guard fired.
    select * into v_existing from payment_reconciliations
     where store_id = v_a.store_id and idempotency_key = v_idem;
    if v_existing.id is not null then
      if v_existing.evidence_hash = v_hash then
        return jsonb_build_object('reconciliation', to_jsonb(v_existing), 'duplicate', true);
      end if;
      raise exception 'idempotency_conflict' using errcode = '42501',
        detail = 'That idempotency key was already used with different evidence.';
    end if;
    if exists (select 1 from payment_reconciliations where attempt_reservation_id = v_a.reservation_id) then
      raise exception 'already_reconciled' using errcode = '42501',
        detail = 'This payment already has a reconciliation record.';
    end if;
    raise;
  end;

  -- Now the status may move (trigger sees the row above).
  update orders set payment_status = 'MANUAL_EVIDENCE_MATCHED' where id = v_o.id;

  perform log_payment_authority_event('payment_reconciliation:manual_evidence_matched',
    jsonb_build_object('orderId', v_o.id, 'reservationId', v_a.reservation_id,
                       'evidenceType', v_etype, 'externalReference', v_extref,
                       'recordedBy', v_staff));

  return jsonb_build_object('reconciliation', to_jsonb(v_row),
                            'orderPaymentStatus', 'MANUAL_EVIDENCE_MATCHED',
                            'duplicate', false);
end $$;


--
-- Name: record_heartbeat(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_heartbeat(p_job text, p_status text, p_detail text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  insert into ops_heartbeats (job_name, last_run_at, last_status, detail)
  values (p_job, now(), case when p_status='ok' then 'ok' else 'failed' end, coalesce(p_detail,''))
  on conflict (job_name) do update
    set last_run_at = excluded.last_run_at,
        last_status = excluded.last_status,
        detail      = excluded.detail;
$$;


--
-- Name: record_media_cleanup_result(uuid, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_media_cleanup_result(p_id uuid, p_ok boolean, p_error text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if p_ok then
    update media_objects
       set status = 'deleted', cleanup_after = null, last_cleanup_error = null
     where id = p_id;
  else
    update media_objects
       set status = 'cleanup_failed',
           cleanup_attempts = cleanup_attempts + 1,
           last_cleanup_error = left(coalesce(p_error,'unknown'), 500),
           cleanup_after = now() + (interval '5 minutes') * power(2, least(cleanup_attempts, 6))
     where id = p_id;
  end if;
end;
$$;


--
-- Name: record_storage_cleanup_result(uuid, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_storage_cleanup_result(p_id uuid, p_ok boolean, p_error text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if p_ok then
    update storage_cleanup_jobs
       set status = 'done', last_error = null
     where id = p_id;
  else
    update storage_cleanup_jobs
       set status = 'failed',
           last_error = left(coalesce(p_error,'unknown'), 500),
           next_attempt_at = now() + (interval '5 minutes') * power(2, least(attempts, 6))
     where id = p_id;
  end if;
end;
$$;


--
-- Name: recovery_action_permitted(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recovery_action_permitted(p_target text, p_action text, p_reason text DEFAULT ''::text) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor  text := current_staff_id();
  v_target staff_profiles;
begin
  if p_action not in ('reset_mfa','revoke_sessions','ban_leaver') then
    return 'unknown_action';
  end if;
  if v_actor is null then return 'not_staff'; end if;

  select * into v_target from staff_profiles where id = p_target;
  if not found then return 'target_not_found'; end if;

  if p_action = 'reset_mfa' then
    -- Owner only, never self-service.
    if not is_owner() then return 'not_permitted'; end if;
    if p_target = v_actor then return 'self_reset_forbidden'; end if;
  else
    if not is_manager_or_owner() then return 'not_permitted'; end if;
    if not is_owner() then
      -- A manager may act on their OWN store's ordinary employees only.
      if v_target.role in ('store_manager','owner') then return 'not_permitted'; end if;
      -- DEFECT 1. Absent this, a manager could reach across storefronts.
      if v_target.store_id is distinct from current_staff_store() then
        return 'target_other_store';
      end if;
    end if;
  end if;

  -- ban_leaver is a LEAVER action: it must not be usable on a current employee.
  if p_action = 'ban_leaver' and v_target.ended_at is null then
    return 'target_still_employed';
  end if;

  -- revoke_sessions is destructive and auditable; it must say why.
  if p_action = 'revoke_sessions' and coalesce(trim(p_reason),'') = '' then
    return 'reason_required';
  end if;

  return null;
end $$;


--
-- Name: FUNCTION recovery_action_permitted(p_target text, p_action text, p_reason text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.recovery_action_permitted(p_target text, p_action text, p_reason text) IS 'R4.9 G6: THE definition of who may perform a recovery action on whom. Evaluated when the intent is created AND again inside the row lock before it executes.';


--
-- Name: redact_assessment_row(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.redact_assessment_row(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
declare
  v_qs    jsonb := coalesce(p -> 'questions', '[]'::jsonb);
  v_out   jsonb := '[]'::jsonb;
  v_n     int   := coalesce(jsonb_array_length(p -> 'questions'), 0);
  q       jsonb;
  v_tpl   text;
  v_words jsonb;
  i       int;
begin
  for i in 0 .. v_n - 1 loop
    q := (v_qs -> i) - 'correctAnswer' - 'explanation';
    if coalesce(q ->> 'type', '') = 'drag_drop'
       and coalesce(q ->> 'dragTemplate', '') <> '' then
      v_tpl := q ->> 'dragTemplate';
      select coalesce(jsonb_agg(w order by lower(w)), '[]'::jsonb)
        into v_words
        from (select trim(m.match[1]) as w
                from regexp_matches(v_tpl, '\[\[(.+?)\]\]', 'g') as m(match)) s;
      q := jsonb_set(q, '{dragWords}', v_words);
      q := jsonb_set(q, '{dragTemplate}',
                     to_jsonb(regexp_replace(v_tpl, '\[\[[^\]]*\]\]', '[[⋯]]', 'g')));
    end if;
    v_out := v_out || jsonb_build_array(q);
  end loop;
  return jsonb_set(p, '{questions}', v_out);
end $$;


--
-- Name: refuse_public_view_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refuse_public_view_write() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  raise exception
    'public_view_read_only: % is a read-only projection — write to the base table through its own guarded path (publish_record, the save RPCs, or the collection publisher), where row-level security and the ownership boundary apply',
    TG_TABLE_NAME
    using errcode = 'insufficient_privilege';
end $$;


--
-- Name: release_quote_payment(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_quote_payment(p_release jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff    text := current_staff_id();
  v_me       staff_profiles%rowtype;
  v_q        order_quotes%rowtype;
  v_a        quote_payment_attempts%rowtype;
  v_res_id   text := p_release ->> 'reservationId';
  v_outcome  text := p_release ->> 'outcome';
  v_override text := nullif(trim(coalesce(p_release ->> 'overrideReason','')), '');
  v_target   text;
  v_via      text := 'release';
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if v_outcome not in ('declined','abandoned') then
    raise exception 'invalid_release_outcome'
      using detail = 'Only a DEFINITE decline or an abandonment before money moved may release a reservation.';
  end if;
  v_target := case when v_outcome = 'declined' then 'DECLINED' else 'ABANDONED' end;

  select * into v_q from order_quotes where id = p_release ->> 'quoteId' for update;
  if v_q.id is null then raise exception 'unknown_quote'; end if;
  if v_q.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;

  select * into v_a from quote_payment_attempts
   where reservation_id = v_res_id for update;
  if v_a.reservation_id is null or v_a.quote_id is distinct from v_q.id then
    raise exception 'idempotency_conflict' using errcode = '42501',
      detail = 'A reservation may only be released by the attempt that created it.';
  end if;

  -- Only the operator who reserved the payment may release it; anyone else
  -- needs an audited manager/owner override (correction 3).
  if v_a.operator_staff_id is distinct from v_staff then
    if v_override is null or not is_manager_or_owner() then
      raise exception 'operator_scope_denied' using errcode = '42501',
        detail = 'Another operator''s attempt; a manager/owner override with a reason is required.';
    end if;
    v_via := 'override_release';
    perform log_payment_authority_event('payment_override:release', jsonb_build_object(
      'quoteId', v_q.id, 'reservationId', v_res_id, 'operator', v_a.operator_staff_id,
      'overriddenBy', v_staff, 'reason', v_override, 'outcome', v_outcome));
  end if;

  if v_a.state = 'CONSUMED' then
    raise exception 'quote_already_consumed'
      using detail = 'This sale was completed; a completed payment cannot be released.';
  end if;
  if v_a.state in ('DECLINED','ABANDONED') then
    -- Idempotent replay (correction 9): the SAME release, repeated after a
    -- lost response, succeeds again. A DIFFERENT outcome is a different
    -- claim about what happened to the money, and conflicts.
    if v_a.state = v_target then
      return jsonb_build_object('quote', to_jsonb(v_q), 'state', v_q.status, 'duplicate', true);
    end if;
    raise exception 'release_outcome_conflict' using errcode = '42501',
      detail = 'That attempt was already released with a different outcome.';
  end if;

  if v_q.status <> 'PAYMENT_PENDING' or v_q.reservation_id is distinct from v_res_id then
    raise exception 'quote_not_reserved';
  end if;

  -- The attempt is resolved permanently — outcome, actor and mechanism in one
  -- atomic statement; the quote merely stops pointing at it.
  update quote_payment_attempts
     set state = v_target,
         released_at = now(), release_outcome = v_outcome,
         resolved_by_staff_id = v_staff, resolved_via = v_via, resolved_at = now()
   where reservation_id = v_res_id and state = 'PENDING';
  if not found then
    raise exception 'attempt_already_resolved' using errcode = '42501';
  end if;

  update order_quotes
     set status = case when now() > expires_at then 'EXPIRED' else 'OPEN' end,
         reservation_id = null, reservation_hash = null,
         payment_started_at = null,
         released_at = now(), release_reason = v_outcome
   where id = v_q.id
  returning * into v_q;

  return jsonb_build_object('quote', to_jsonb(v_q), 'state', v_q.status, 'duplicate', false);
end $$;


--
-- Name: replace_collection(text, jsonb, integer, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.replace_collection(p_table text, p_rows jsonb, p_expected_total integer, p_expected_revision bigint) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
declare
  v_pk       text;
  v_life     text;
  v_row      jsonb;
  v_cols     text;
  v_sets     text;
  v_ids      text[];
  v_final    jsonb;
  v_rev      bigint;
begin
  -- 3a. Allow-list (unchanged from Increment 10, lifecycle columns included).
  select pk, life into v_pk, v_life from (values
    ('menu_items',           'id',   'available'),
    ('stores',               'id',   null),
    ('job_vacancies',        'id',   'status'),
    ('kb_articles',          'id',   null),
    ('news_posts',           'id',   'status'),
    ('media_assets',         'id',   'is_public'),
    ('deals',                'id',   'active'),
    ('checklist_templates',  'id',   null),
    ('training_courses',     'id',   null),
    ('training_assessments', 'id',   null),
    ('training_assignments', 'id',   null),
    ('role_permissions',     'role', null)
  ) as t(tbl, pk, life) where t.tbl = p_table;
  if v_pk is null then
    raise exception 'table_not_allowed';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows_must_be_array';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'too_many_rows';
  end if;

  -- 3b. THE REVISION CHECK, before anything else touches data. The lazy
  --     insert makes the ledger row exist on first contact; FOR UPDATE
  --     serialises concurrent replaces and blocks row-trigger bumps from
  --     other transactions until this one decides.
  v_rev := collection_revision_checkpoint(p_table);
  if p_expected_revision is null then
    raise exception
      'collection_revision_required: state the revision your snapshot of % was '
      'hydrated at. A publisher that cannot say what it loaded must not replace '
      'the collection.', p_table
      using errcode = 'check_violation';
  end if;
  if p_expected_revision <> v_rev then
    raise exception
      'collection_snapshot_stale: % is at revision % but the publisher hydrated '
      'revision %. Someone changed the collection since — re-hydrate and apply '
      'your edit to the current state.',
      p_table, v_rev, p_expected_revision
      using errcode = 'check_violation';
  end if;

  -- 3c. The total stays as the secondary defence (Increment 10 semantics,
  --     message unchanged).
  perform assert_full_collection_snapshot(p_table, p_rows, p_expected_total);

  -- 3d. Primary keys present on every row.
  if exists (select 1 from jsonb_array_elements(p_rows) e
              where not (e.value ? v_pk) or coalesce(e.value->>v_pk, '') = '') then
    raise exception 'row_missing_primary_key';
  end if;
  select coalesce(array_agg(value->>v_pk), '{}') into v_ids
    from jsonb_array_elements(p_rows);

  -- 3e. Delete what the caller can see that is not in the payload.
  if v_ids is null or array_length(v_ids, 1) is null then
    execute format('delete from %I', p_table);
  else
    execute format('delete from %I where %I <> all($1)', p_table, v_pk) using v_ids;
  end if;

  -- 3f. Upsert each row from ONLY its provided columns, lifecycle stripped
  --     first (existing rows keep server truth; new rows land as drafts).
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if v_life is not null then
      v_row := v_row - v_life;
    end if;
    select string_agg(format('%I', k), ', '),
           string_agg(case when k = v_pk then null
                           else format('%I = excluded.%I', k, k) end, ', ')
      into v_cols, v_sets
      from jsonb_object_keys(v_row) as k;
    execute format(
      'insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1)
       on conflict (%I) do update set %s',
      p_table, v_cols, v_cols, p_table, v_pk,
      coalesce(v_sets, format('%I = excluded.%I', v_pk, v_pk))
    ) using v_row;
  end loop;

  -- 3g. Audit (unchanged).
  insert into audit_logs (id, operator_name, role, action, timestamp, module)
  select 'aud_' || replace(gen_random_uuid()::text, '-', ''),
         coalesce(sp.name, current_staff_id()),
         coalesce(sp.role::text, ''),
         'Replaced collection "' || p_table || '" (' || jsonb_array_length(p_rows) ||
           ' rows; publication state preserved server-side)',
         now()::text,
         'Publishing (server)'
    from staff_profiles sp where sp.id = current_staff_id();

  -- 3h. Contract check + the caller's view of the result, WITH the new
  --     revision (this transaction's own bumps are visible here).
  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from %I t', p_table)
    into v_final;
  if (select count(*) from jsonb_array_elements(v_final) e
       where not (e.value->>v_pk = any(coalesce(v_ids, '{}')))) > 0 then
    raise exception 'stale_rows_not_deletable' using errcode = '42501';
  end if;

  select revision into v_rev from collection_revisions where table_key = p_table;
  return jsonb_build_object('revision', v_rev, 'rows', v_final);
end $_$;


--
-- Name: FUNCTION replace_collection(p_table text, p_rows jsonb, p_expected_total integer, p_expected_revision bigint); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.replace_collection(p_table text, p_rows jsonb, p_expected_total integer, p_expected_revision bigint) IS 'INC11: whole-collection CONTENT replacement. The caller states BOTH the row total and the collection revision it hydrated; a mismatch of either refuses the call as stale before any delete. Lifecycle columns are stripped (only publish_record/close_vacancy change them). Returns {revision, rows}.';


--
-- Name: request_recovery_action(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_recovery_action(p_action text, p_target text, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare v_actor text := current_staff_id(); v_id text; v_deny text;
begin
  v_deny := recovery_action_permitted(p_target, p_action, coalesce(p_reason,''));
  if v_deny is not null then raise exception '%', v_deny; end if;

  v_id := gen_random_uuid()::text;
  insert into admin_recovery_intents (id, action, target_staff_id, requested_by, reason)
  values (v_id, p_action, p_target, v_actor, coalesce(p_reason,''));
  insert into audit_logs (id, operator_name, role, action, timestamp, module, new_value)
  values (gen_random_uuid()::text, v_actor, current_staff_role()::text,
          'recovery.' || p_action || '.requested', now()::text, 'Security', p_target);
  return jsonb_build_object('ok', true, 'intent_id', v_id);
end $$;


--
-- Name: resolve_payment_reconciliation(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_payment_reconciliation(p_resolution jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff    text := current_staff_id();
  v_me       staff_profiles%rowtype;
  v_action   text := p_resolution ->> 'action';
  v_reason   text := nullif(trim(coalesce(p_resolution ->> 'reason','')), '');
  v_res_id   text := p_resolution ->> 'reservationId';
  v_resol_id text := nullif(trim(coalesce(p_resolution ->> 'resolutionId','')), '');
  v_hash     text;
  v_q        order_quotes%rowtype;
  v_a        quote_payment_attempts%rowtype;
  v_o        orders%rowtype;
  v_result   jsonb;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if not is_manager_or_owner() or not is_aal2() then
    raise exception 'reconciliation_denied' using errcode = '42501',
      detail = 'Payment reconciliation requires a manager or owner with an MFA-verified session.';
  end if;
  if v_reason is null or length(v_reason) < 10 then
    raise exception 'reason_required'
      using detail = 'A written reason (at least 10 characters) is required for payment reconciliation.';
  end if;
  if v_action not in ('record_order','void') then
    raise exception 'invalid_reconciliation_action';
  end if;
  if v_res_id is null then raise exception 'invalid_reservation'; end if;
  if v_resol_id is null or length(v_resol_id) < 8 then
    raise exception 'resolution_id_required'
      using detail = 'A resolution id (at least 8 characters) is required so a lost response can be retried safely.';
  end if;

  select * into v_q from order_quotes
   where id = p_resolution ->> 'quoteId' for update;
  if v_q.id is null then raise exception 'unknown_quote'; end if;
  if not is_owner() and v_q.store_id is distinct from v_me.store_id then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;

  -- The canonical recovery claim. The nested payment object is included whole,
  -- so a retry that alters the recorded payment — its reference, its amount or
  -- its claimed time — is a DIFFERENT claim, never a silent replay.
  v_hash := canonical_request_hash(jsonb_build_object(
    'op', 'resolve_payment_reconciliation', 'quoteId', v_q.id,
    'reservationId', v_res_id, 'action', v_action, 'reason', v_reason,
    'resolutionId', v_resol_id,
    'payment', coalesce(p_resolution -> 'payment', '{}'::jsonb)));

  -- IDEMPOTENT REPLAY (finding 5), checked BEFORE the state guards that would
  -- otherwise answer a lost-response retry with quote_already_consumed or
  -- reservation_released.
  if v_q.resolution_id is not null and v_q.resolution_id = v_resol_id then
    if v_q.resolution_hash is distinct from v_hash then
      raise exception 'idempotency_conflict' using errcode = '42501',
        detail = 'That resolution id was already used with a different claim.';
    end if;
    if v_action = 'void' then
      return jsonb_build_object('quote', to_jsonb(v_q), 'resolution', 'void',
                                'duplicate', true);
    end if;
    select * into v_o from orders where quote_id = v_q.id;
    return jsonb_build_object('order', to_jsonb(v_o), 'resolution', 'record_order',
                              'duplicate', true);
  end if;

  select * into v_a from quote_payment_attempts
   where reservation_id = v_res_id for update;
  if v_a.reservation_id is null or v_a.quote_id is distinct from v_q.id then
    raise exception 'invalid_reservation'
      using detail = 'That reservation does not belong to this quote.';
  end if;
  if v_a.state = 'CONSUMED' then raise exception 'quote_already_consumed'; end if;
  if v_a.state in ('DECLINED','ABANDONED') then
    raise exception 'reservation_released' using errcode = '42501';
  end if;

  if v_q.status = 'PAYMENT_PENDING' then
    if now() <= v_q.payment_started_at + interval '24 hours' then
      raise exception 'reconciliation_not_required'
        using detail = 'The ordinary recovery window is still open; finalise or release the payment normally.';
    end if;
    update order_quotes set status = 'NEEDS_RECONCILIATION'
     where id = v_q.id returning * into v_q;
  elsif v_q.status <> 'NEEDS_RECONCILIATION' then
    raise exception 'quote_not_reserved';
  end if;

  if v_action = 'void' then
    -- The payment definitively did NOT happen: the attempt is closed and the
    -- quote is cancelled — never silently reopened for fresh payment.
    update quote_payment_attempts
       set state = 'ABANDONED', released_at = now(), release_outcome = 'abandoned',
           resolved_by_staff_id = v_staff, resolved_via = 'reconciliation',
           resolved_at = now()
     where reservation_id = v_res_id and state = 'PENDING';
    if not found then
      raise exception 'attempt_already_resolved' using errcode = '42501';
    end if;
    update order_quotes
       set status = 'CANCELLED', cancelled_at = now(),
           released_at = now(), release_reason = 'reconciled_void',
           resolution_id = v_resol_id, resolution_hash = v_hash
     where id = v_q.id returning * into v_q;
    perform log_payment_authority_event('payment_reconciliation:void', jsonb_build_object(
      'quoteId', v_q.id, 'reservationId', v_res_id, 'reason', v_reason,
      'resolutionId', v_resol_id, 'resolvedBy', v_staff));
    return jsonb_build_object('quote', to_jsonb(v_q), 'resolution', 'void');
  end if;

  -- The payment DID happen: record the sale through the one finalisation
  -- core, from the stored snapshot, with the bound route.
  v_result := finalise_order_payment_core(
    coalesce(p_resolution -> 'payment', '{}'::jsonb)
      || jsonb_build_object('quoteId', v_q.id, 'reservationId', v_res_id),
    true, v_reason);
  -- Stamp the resolution identity on the (now CONSUMED) quote. The snapshot
  -- trigger permits this: the priced facts and the status are unchanged.
  update order_quotes
     set resolution_id = v_resol_id, resolution_hash = v_hash
   where id = v_q.id;
  perform log_payment_authority_event('payment_reconciliation:record_order', jsonb_build_object(
    'quoteId', v_q.id, 'reservationId', v_res_id, 'reason', v_reason,
    'resolutionId', v_resol_id, 'resolvedBy', v_staff,
    'orderId', v_result -> 'order' ->> 'id'));
  return v_result || jsonb_build_object('resolution', 'record_order');
end $$;


--
-- Name: resolve_public_submission(text, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_public_submission(p_kind text, p_idempotency_key uuid, p_request_hash text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: FUNCTION resolve_public_submission(p_kind text, p_idempotency_key uuid, p_request_hash text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.resolve_public_submission(p_kind text, p_idempotency_key uuid, p_request_hash text) IS 'WP02.1: pre-captcha idempotency lookup. found=true echoes the original submission id when key AND payload hash match; conflict=true when the key exists with different data. Read-only; Edge Function (service role) only.';


--
-- Name: retention_enqueue_orphan_cvs(interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.retention_enqueue_orphan_cvs(grace interval DEFAULT '48:00:00'::interval) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'storage', 'pg_temp'
    AS $$
declare
  v_cutoff   timestamptz := now() - grace;
  v_enqueued integer := 0;
begin
  with orphans as (
    select o.name
      from storage.objects o
     where o.bucket_id = 'cvs'
       and o.created_at < v_cutoff
       and not exists (select 1 from job_applications a where a.cv_path = o.name)
  ),
  enqueue as (
    insert into storage_cleanup_jobs (bucket, storage_path, reason)
    select 'cvs', orphans.name, 'ws9_retention: orphaned storage object'
      from orphans
    on conflict (bucket, storage_path) do nothing
    returning 1
  )
  select coalesce((select count(*) from enqueue), 0) into v_enqueued;

  insert into retention_runs (entity, cutoff, jobs_enqueued)
  values ('cv_orphans', v_cutoff, v_enqueued);
  return v_enqueued;
end;
$$;


--
-- Name: retention_purge_contact_messages(interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.retention_purge_contact_messages(retain interval) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_cutoff  timestamptz := now() - retain;
  v_deleted integer;
begin
  delete from contact_messages where created_at < v_cutoff;
  get diagnostics v_deleted = row_count;
  insert into retention_runs (entity, cutoff, rows_deleted)
  values ('contact_messages', v_cutoff, v_deleted);
  return v_deleted;
end;
$$;


--
-- Name: retention_purge_franchise_inquiries(interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.retention_purge_franchise_inquiries(retain interval) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_cutoff  timestamptz := now() - retain;
  v_deleted integer;
begin
  delete from franchise_inquiries where created_at < v_cutoff;
  get diagnostics v_deleted = row_count;
  insert into retention_runs (entity, cutoff, rows_deleted)
  values ('franchise_inquiries', v_cutoff, v_deleted);
  return v_deleted;
end;
$$;


--
-- Name: retention_purge_job_applications(interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.retention_purge_job_applications(retain interval) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_cutoff   timestamptz := now() - retain;
  v_deleted  integer := 0;
  v_enqueued integer := 0;
begin
  with expired as (
    select id, cv_path
      from job_applications
     where status = 'declined'
       and updated_at < v_cutoff
  ),
  enqueue as (
    insert into storage_cleanup_jobs (bucket, storage_path, reason)
    select 'cvs', e.cv_path, 'ws9_retention: declined application purged'
      from expired e
     where e.cv_path is not null and e.cv_path <> ''
    on conflict (bucket, storage_path) do nothing
    returning 1
  ),
  removed as (
    delete from job_applications a
     using expired e
     where a.id = e.id
    returning 1
  )
  select coalesce((select count(*) from removed), 0),
         coalesce((select count(*) from enqueue), 0)
    into v_deleted, v_enqueued;

  insert into retention_runs (entity, cutoff, rows_deleted, jobs_enqueued)
  values ('job_applications', v_cutoff, v_deleted, v_enqueued);
  return jsonb_build_object('deleted', v_deleted, 'cvJobsEnqueued', v_enqueued);
end;
$$;


--
-- Name: revoke_pos_device(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revoke_pos_device(p_device_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: reward_grant_active(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reward_grant_active() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  select coalesce(nullif(current_setting('milkpop.reward_grant', true), ''), '0') = '1'
$$;


--
-- Name: rotate_pos_device_token(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rotate_pos_device_token(p_device_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: run_retention_sweep(interval, interval, interval, interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.run_retention_sweep(p_contact_retain interval DEFAULT '2 years'::interval, p_franchise_retain interval DEFAULT '2 years'::interval, p_applications_retain interval DEFAULT '6 mons'::interval, p_orphan_grace interval DEFAULT '48:00:00'::interval) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_contact   integer;
  v_franchise integer;
  v_apps      jsonb;
  v_orphans   integer;
begin
  v_contact   := retention_purge_contact_messages(p_contact_retain);
  v_franchise := retention_purge_franchise_inquiries(p_franchise_retain);
  v_apps      := retention_purge_job_applications(p_applications_retain);
  v_orphans   := retention_enqueue_orphan_cvs(p_orphan_grace);
  return jsonb_build_object(
    'contactMessagesDeleted',   v_contact,
    'franchiseInquiriesDeleted', v_franchise,
    'jobApplications',          v_apps,
    'orphanCvJobsEnqueued',     v_orphans
  );
end;
$$;


--
-- Name: FUNCTION run_retention_sweep(p_contact_retain interval, p_franchise_retain interval, p_applications_retain interval, p_orphan_grace interval); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.run_retention_sweep(p_contact_retain interval, p_franchise_retain interval, p_applications_retain interval, p_orphan_grace interval) IS 'WS9: the one scheduled retention entry point — purges contact messages, franchise enquiries and declined job applications past their periods (metadata + a confirmed-delete job for the CV object together), and queues orphaned cvs objects. Idempotent; every run is logged in retention_runs. Not client-callable.';


--
-- Name: save_launch_settings(jsonb, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_launch_settings(p_patch jsonb, p_expected_revision bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor_name text;
  v_actor_role text;
  v_rev bigint;
begin
  if not is_owner() then
    raise exception 'launch_settings_owner_only: launch facts are recorded by the owner with MFA'
      using errcode = 'insufficient_privilege';
  end if;
  if p_patch is null or p_patch = '{}'::jsonb then
    raise exception 'launch_settings_empty_patch: nothing to save' using errcode = 'check_violation';
  end if;

  select name, role into v_actor_name, v_actor_role
    from staff_profiles where auth_id = auth.uid() limit 1;

  v_rev := collection_revision_checkpoint('launch_settings');
  if p_expected_revision is null then
    raise exception 'collection_revision_required: launch_settings — re-hydrate and retry'
      using errcode = 'check_violation';
  end if;
  if v_rev <> p_expected_revision then
    raise exception
      'collection_snapshot_stale: launch_settings changed (revision % vs expected %) — re-hydrate, review, save again',
      v_rev, p_expected_revision using errcode = 'check_violation';
  end if;

  perform set_config('milkpop.singleton_rpc', '1', true);
  perform singleton_apply_payload('launch_settings', p_patch, coalesce(v_actor_name, 'owner'));

  insert into audit_logs (id, operator_name, role, action, module, new_value)
  values ('aud_' || replace(gen_random_uuid()::text, '-', ''),
          coalesce(v_actor_name, 'owner'), coalesce(v_actor_role, 'owner'),
          'Updated launch facts', 'Launch settings',
          jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k)));

  select revision into v_rev from collection_revisions where table_key = 'launch_settings';
  return jsonb_build_object('revision', v_rev);
end $$;


--
-- Name: save_website_studio(jsonb, jsonb, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_website_studio(p_site_settings jsonb, p_site_content jsonb, p_expected_settings_revision bigint, p_expected_content_revision bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_actor_name text;
  v_actor_role text;
  v_rev bigint;
  v_settings_rev bigint;
  v_content_rev bigint;
  v_parts text := '';
begin
  if not is_owner() then
    raise exception 'studio_owner_only: Website Studio publishes require the owner with MFA'
      using errcode = 'insufficient_privilege';
  end if;
  if p_site_settings is null and p_site_content is null then
    raise exception 'studio_empty_save: nothing to publish' using errcode = 'check_violation';
  end if;

  select name, role into v_actor_name, v_actor_role
    from staff_profiles where auth_id = auth.uid() limit 1;

  perform set_config('milkpop.singleton_rpc', '1', true);

  if p_site_settings is not null then
    v_rev := collection_revision_checkpoint('site_settings');
    if p_expected_settings_revision is null then
      raise exception 'collection_revision_required: site_settings — re-hydrate and retry'
        using errcode = 'check_violation';
    end if;
    if v_rev <> p_expected_settings_revision then
      raise exception
        'collection_snapshot_stale: site_settings changed (revision % vs expected %) — re-hydrate, review, publish again',
        v_rev, p_expected_settings_revision using errcode = 'check_violation';
    end if;
    perform singleton_apply_payload('site_settings', p_site_settings);
    v_parts := v_parts || 'settings ';
  end if;

  if p_site_content is not null then
    v_rev := collection_revision_checkpoint('site_content');
    if p_expected_content_revision is null then
      raise exception 'collection_revision_required: site_content — re-hydrate and retry'
        using errcode = 'check_violation';
    end if;
    if v_rev <> p_expected_content_revision then
      raise exception
        'collection_snapshot_stale: site_content changed (revision % vs expected %) — re-hydrate, review, publish again',
        v_rev, p_expected_content_revision using errcode = 'check_violation';
    end if;
    perform singleton_apply_payload('site_content', p_site_content);
    v_parts := v_parts || 'content ';
  end if;

  -- Server-side audit — same transaction as the writes it describes.
  insert into audit_logs (id, operator_name, role, action, module, new_value)
  values ('aud_' || replace(gen_random_uuid()::text, '-', ''),
          coalesce(v_actor_name, 'owner'), coalesce(v_actor_role, 'owner'),
          'Published Website Studio changes (' || trim(v_parts) || ')',
          'Website Studio',
          jsonb_build_object('parts', trim(v_parts)));

  select revision into v_settings_rev from collection_revisions where table_key = 'site_settings';
  select revision into v_content_rev  from collection_revisions where table_key = 'site_content';
  return jsonb_build_object(
    'settings_revision', v_settings_rev,
    'content_revision',  v_content_rev
  );
end $$;


--
-- Name: set_app_state(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_app_state(p_key text, p_value jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff_id text := current_staff_id();
  v_store    text := current_staff_store();
  v_scope    text;
  v_owner    text := null;
  v_store_id text := null;
begin
  if v_staff_id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if p_key is null or length(p_key) > 120 then
    raise exception 'invalid_key';
  end if;

  if p_key like 'milkpop_clock_status_%' then
    -- FIX-10: clock state is server-derived. The ONLY writer is
    -- staff_clock_action(); a direct client write here would let the browser
    -- forge clock-in times again.
    raise exception 'clock_keys_are_rpc_only' using errcode = '42501';
  elsif p_key in ('milkpop_checklist_tasks','milkpop_checklist_audits','milkpop_shift_covers') then
    -- STORE scope: stamped with the CALLER's store, never a client value.
    v_scope := 'store';
    v_store_id := v_store;
  elsif p_key = 'milkpop_email_settings' then
    -- GLOBAL scope: owner only.
    if not is_owner() then
      raise exception 'owner_only_key' using errcode = '42501';
    end if;
    v_scope := 'global';
  else
    raise exception 'key_not_allowed';
  end if;

  insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
  values (p_key, p_value, v_scope, v_owner, v_store_id, now())
  on conflict (key) do update
     set value = excluded.value,
         scope = excluded.scope,
         owner_staff_id = excluded.owner_staff_id,
         store_id = excluded.store_id,
         updated_at = now();

  return jsonb_build_object('ok', true, 'key', p_key, 'scope', v_scope);
end $$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end $$;


--
-- Name: sifr_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sifr_reports (
    id text NOT NULL,
    title text NOT NULL,
    category text NOT NULL,
    date text DEFAULT ''::text NOT NULL,
    involved_people text DEFAULT ''::text NOT NULL,
    store_id text,
    store_name text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    impact text DEFAULT ''::text NOT NULL,
    suggested_action text DEFAULT ''::text NOT NULL,
    confidentiality text DEFAULT 'standard'::text NOT NULL,
    status text DEFAULT 'submitted'::text NOT NULL,
    reporter_name text DEFAULT ''::text NOT NULL,
    reporter_id text,
    submitted_at text DEFAULT ''::text NOT NULL,
    replies jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sifr_reports_confidentiality_check CHECK ((confidentiality = ANY (ARRAY['confidential'::text, 'standard'::text]))),
    CONSTRAINT sifr_reports_status_check CHECK ((status = ANY (ARRAY['submitted'::text, 'under_review'::text, 'escalated'::text, 'action_required'::text, 'resolved'::text, 'closed'::text])))
);


--
-- Name: sifr_report_store(public.sifr_reports); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sifr_report_store(r public.sifr_reports) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select coalesce(
    nullif(r.store_id, ''),
    (select sp.store_id from staff_profiles sp where sp.id = r.reporter_id limit 1)
  );
$$;


--
-- Name: sifr_reports_stamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sifr_reports_stamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_id    text;
  v_name  text;
  v_store text;
  v_store_name text;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;  -- server contexts (service role) are not browser requests
  end if;
  v_id := current_staff_id();
  if v_id is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  select name, store_id, store_name into v_name, v_store, v_store_name
    from staff_profiles where id = v_id;
  new.reporter_id   := v_id;
  new.reporter_name := coalesce(v_name, '');
  new.store_id      := coalesce(nullif(new.store_id, ''), v_store);
  new.store_name    := case when new.store_id = v_store then coalesce(v_store_name, new.store_name) else new.store_name end;
  return new;
end $$;


--
-- Name: singleton_apply_payload(text, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.singleton_apply_payload(p_table text, p_payload jsonb, p_updated_by text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  v_pk_sql   text;
  v_exists   boolean;
  v_sets     text := '';
  v_cols     text := '';
  v_vals     text := '';
  r          record;
  v_expr     text;
begin
  -- Whitelist + per-table primary key. Anything else is refused.
  if p_table = 'site_settings' then      v_pk_sql := 'id = 1';
  elsif p_table = 'site_content' then    v_pk_sql := 'id = 1';
  elsif p_table = 'launch_settings' then v_pk_sql := 'id = true';
  else
    raise exception 'singleton_unknown_table: %', p_table using errcode = 'check_violation';
  end if;

  execute format('select exists (select 1 from %I where %s)', p_table, v_pk_sql) into v_exists;

  for r in
    select c.column_name, c.data_type
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = p_table
       and c.column_name not in ('id', 'created_at', 'updated_at', 'updated_by')
       and p_payload ? c.column_name
  loop
    if r.data_type = 'jsonb' then
      v_expr := format('($1 -> %L)', r.column_name);
    elsif r.data_type = 'boolean' then
      v_expr := format('(($1 ->> %L))::boolean', r.column_name);
    elsif r.data_type in ('integer', 'bigint', 'numeric') then
      v_expr := format('(($1 ->> %L))::%s', r.column_name, r.data_type);
    elsif r.data_type = 'timestamp with time zone' then
      v_expr := format('(($1 ->> %L))::timestamptz', r.column_name);
    else
      v_expr := format('($1 ->> %L)', r.column_name);
    end if;
    v_sets := v_sets || case when v_sets = '' then '' else ', ' end
              || format('%I = %s', r.column_name, v_expr);
    v_cols := v_cols || case when v_cols = '' then '' else ', ' end || quote_ident(r.column_name);
    v_vals := v_vals || case when v_vals = '' then '' else ', ' end || v_expr;
  end loop;

  if v_sets = '' then
    raise exception 'singleton_empty_payload: no known columns for %', p_table
      using errcode = 'check_violation';
  end if;

  if v_exists then
    -- updated_at / updated_by are server truth wherever the table has them —
    -- folded into this ONE statement so one logical save is exactly one
    -- revision bump (a second UPDATE would double-count on the ledger).
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = p_table
                  and column_name = 'updated_at') then
      v_sets := v_sets || ', updated_at = now()';
    end if;
    if p_updated_by is not null and exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = p_table
                  and column_name = 'updated_by') then
      v_sets := v_sets || format(', updated_by = %L', p_updated_by);
    end if;
    execute format('update %I set %s where %s', p_table, v_sets, v_pk_sql) using p_payload;
  else
    execute format('insert into %I (%s, id) values (%s, %s)',
                   p_table, v_cols, v_vals,
                   case when p_table = 'launch_settings' then 'true' else '1' end)
      using p_payload;
  end if;
end $_$;


--
-- Name: staff_clock_action(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.staff_clock_action(p_action text, p_notes text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_staff    text := current_staff_id();
  v_name     text;
  v_key      text;
  v_cur      jsonb;
  v_status   text;
  v_now      timestamptz := now();
  v_iso      text := to_char(v_now at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_acc_ms   bigint;
  v_break_ms bigint;
  v_work_ms  bigint;
  v_in_ts    timestamptz;
  v_new      jsonb;
  v_hist     jsonb := null;
  v_hist_id  text;
begin
  if v_staff is null then
    raise exception 'not_staff' using errcode = '42501';
  end if;
  if p_notes is not null and length(p_notes) > 500 then
    raise exception 'notes_too_long';
  end if;
  select name into v_name from staff_profiles where id = v_staff;

  v_key := 'milkpop_clock_status_' || v_staff;
  -- Serialise per employee: two devices racing the same clock see a queue,
  -- not interleaved half-states.
  select value into v_cur from app_state where key = v_key for update;
  v_status := coalesce(v_cur ->> 'status', 'clocked_out');
  v_acc_ms := coalesce(nullif(v_cur ->> 'accumulatedBreakMs', '')::bigint, 0);

  if p_action = 'clock_in' then
    if v_status <> 'clocked_out' then
      raise exception 'already_clocked_in';
    end if;
    v_new := jsonb_build_object(
      'employeeId', v_staff, 'status', 'clocked_in',
      'lastActivity', v_iso, 'clockInTime', v_iso, 'accumulatedBreakMs', 0);

  elsif p_action = 'start_break' then
    if v_status <> 'clocked_in' then
      raise exception 'not_clocked_in';
    end if;
    v_new := v_cur || jsonb_build_object(
      'status', 'on_break', 'lastActivity', v_iso, 'breakStartTime', v_iso);

  elsif p_action = 'end_break' then
    if v_status <> 'on_break' or coalesce(v_cur ->> 'breakStartTime', '') = '' then
      raise exception 'not_on_break';
    end if;
    v_acc_ms := v_acc_ms + greatest(0,
      (extract(epoch from (v_now - (v_cur ->> 'breakStartTime')::timestamptz)) * 1000)::bigint);
    v_new := (v_cur - 'breakStartTime') || jsonb_build_object(
      'status', 'clocked_in', 'lastActivity', v_iso, 'accumulatedBreakMs', v_acc_ms);

  elsif p_action = 'clock_out' then
    if v_status not in ('clocked_in', 'on_break')
       or coalesce(v_cur ->> 'clockInTime', '') = '' then
      raise exception 'not_clocked_in';
    end if;
    v_break_ms := v_acc_ms;
    if v_status = 'on_break' and coalesce(v_cur ->> 'breakStartTime', '') <> '' then
      v_break_ms := v_break_ms + greatest(0,
        (extract(epoch from (v_now - (v_cur ->> 'breakStartTime')::timestamptz)) * 1000)::bigint);
    end if;
    v_in_ts   := (v_cur ->> 'clockInTime')::timestamptz;
    v_work_ms := greatest(0,
      (extract(epoch from (v_now - v_in_ts)) * 1000)::bigint - v_break_ms);

    v_hist_id := 'clock_' || replace(gen_random_uuid()::text, '-', '');
    insert into clock_history
      (id, employee_id, employee_name, date, clock_in, clock_out,
       break_duration_minutes, total_decimal_hours, approved, rejected, notes)
    values
      (v_hist_id, v_staff, coalesce(v_name, ''),
       -- Business date: the LONDON calendar day of the clock-out, DST-correct.
       to_char(v_now at time zone 'Europe/London', 'YYYY-MM-DD'),
       v_cur ->> 'clockInTime', v_iso,
       round(v_break_ms / 60000.0)::int,
       round(v_work_ms / 3600000.0, 2),
       false, false, nullif(trim(coalesce(p_notes, '')), ''));

    v_hist := jsonb_build_object(
      'id', v_hist_id, 'employeeId', v_staff, 'employeeName', coalesce(v_name, ''),
      'date', to_char(v_now at time zone 'Europe/London', 'YYYY-MM-DD'),
      'clockIn', v_cur ->> 'clockInTime', 'clockOut', v_iso,
      'breakDurationMinutes', round(v_break_ms / 60000.0)::int,
      'totalDecimalHours', round(v_work_ms / 3600000.0, 2),
      'approved', false,
      'notes', nullif(trim(coalesce(p_notes, '')), ''));

    v_new := jsonb_build_object(
      'employeeId', v_staff, 'status', 'clocked_out', 'lastActivity', v_iso);

  else
    raise exception 'unknown_action';
  end if;

  insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
  values (v_key, v_new, 'user', v_staff, null, now())
  on conflict (key) do update
     set value = excluded.value, scope = 'user',
         owner_staff_id = excluded.owner_staff_id, updated_at = now();

  return jsonb_build_object('status', v_new, 'history', v_hist);
end $$;


--
-- Name: staff_compliance_overview(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.staff_compliance_overview(p_employee_id text DEFAULT NULL::text) RETURNS TABLE(id text, employee_id text, compliance_type text, effective_status public.compliance_status, issued_at date, expires_at date, verified_at timestamp with time zone, notes text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select r.id, r.employee_id, r.compliance_type,
         compliance_effective_status(r), r.issued_at, r.expires_at,
         r.verified_at, r.notes
    from staff_compliance_records r
   where r.supersedes_id is null or not exists
         (select 1 from staff_compliance_records n where n.supersedes_id = r.id)
     and (
       r.employee_id = coalesce(nullif(p_employee_id,''), current_staff_id())
       and (r.employee_id = current_staff_id()
            or is_owner()
            or (is_manager_or_owner() and exists (
                  select 1 from staff_profiles sp
                   where sp.id = r.employee_id and sp.store_id = current_staff_store())))
     )
   order by r.compliance_type, r.created_at desc;
$$;


--
-- Name: staff_profiles_protect(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.staff_profiles_protect() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  -- Server contexts (service role, definer helpers) are not browser requests:
  -- only 'authenticated' JWTs are subject to these locks.
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;
  end if;
  if not is_owner() then
    -- Carve-out: a signed-in user claiming their OWN unlinked profile on
    -- first sign-in (link_staff_profile) — auth_id may go null → auth.uid().
    if new.auth_id is distinct from old.auth_id
       and not (old.auth_id is null and new.auth_id = auth.uid()) then
      raise exception 'protected_profile_columns' using errcode = '42501';
    end if;
    if new.role         is distinct from old.role
    or new.store_id     is distinct from old.store_id
    or new.store_name   is distinct from old.store_name
    or new.pay_type     is distinct from old.pay_type
    or new.pay_rate     is distinct from old.pay_rate
    or new.status       is distinct from old.status then
      raise exception 'protected_profile_columns' using errcode = '42501';
    end if;
  end if;
  if not (reward_grant_active()
          or (is_manager_or_owner() and old.id is distinct from current_staff_id())) then
    if new.points          is distinct from old.points
    or new.level           is distinct from old.level
    or new.badges          is distinct from old.badges
    or new.holiday_balance is distinct from old.holiday_balance then
      raise exception 'protected_reward_columns' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;


--
-- Name: stamp_notice_on_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stamp_notice_on_insert() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if new.published_at is not null then
    new.content_sha256 := encode(digest(coalesce(new.notice_text, ''), 'sha256'), 'hex');
    new.frozen_at := coalesce(new.frozen_at, now());
  end if;
  return new;
end $$;


--
-- Name: store_config_fingerprint(public.stores); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.store_config_fingerprint(p_store public.stores) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select canonical_request_hash(jsonb_build_object(
    'setupStatus',      p_store.setup_status,
    'vatStatus',        p_store.vat_status,
    'vatEffectiveDate', p_store.vat_registration_effective_date,
    'paymentMethods',   p_store.payment_methods,
    'menuDigest',       encode(sha256(convert_to(coalesce(
        (select string_agg(id || '=' || coalesce(tax_code, '∅') || '=' || price::text,
                           ',' order by id)
           from menu_items), ''), 'utf8')), 'hex')
  ));
$$;


--
-- Name: store_trading_state(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.store_trading_state(p_store_id text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_s      stores%rowtype;
  v_today  date;
  v_uncls  int;
begin
  select * into v_s from stores where id = p_store_id;
  if v_s.id is null then
    raise exception 'unknown_store';
  end if;
  if not (is_owner() or p_store_id = current_staff_store()) then
    raise exception 'store_scope_denied' using errcode = '42501';
  end if;

  v_today := (now() at time zone coalesce(v_s.timezone, 'Europe/London'))::date;
  select count(*) into v_uncls from menu_items where tax_code is null;

  return jsonb_build_object(
    'storeId',           v_s.id,
    'businessDate',      v_today,
    'vatChargingNow',    (v_s.vat_status = 'REGISTERED'
                          and v_s.vat_registration_effective_date <= v_today),
    'vatStatus',         v_s.vat_status,
    'vatEffectiveDate',  v_s.vat_registration_effective_date,
    'setupStatus',       v_s.setup_status,
    'paymentMethods',    v_s.payment_methods,
    'unclassifiedCount', v_uncls,
    -- Cheap change detector: any edit to the store's configuration or to the
    -- catalogue's classifications changes this string, so the till can tell
    -- that VAT-relevant state moved without diffing everything.
    'configVersion',     md5(coalesce(v_s.setup_status,'') || '|' || coalesce(v_s.vat_status,'') || '|'
                          || coalesce(v_s.vat_registration_effective_date::text,'') || '|'
                          || coalesce(v_s.payment_methods::text,'') || '|'
                          || coalesce(v_s.timezone,'') || '|' || coalesce(v_s.currency_code,'') || '|'
                          || coalesce((select string_agg(id || '=' || coalesce(tax_code,'∅'), ',' order by id)
                                         from menu_items), ''))
  );
end $$;


--
-- Name: submit_public_form(text, jsonb, uuid, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.submit_public_form(p_kind text, p_row jsonb, p_idempotency_key uuid, p_request_hash text, p_ip_hash text, p_notice_id text, p_notice_sha256 text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: submit_public_form_core(text, jsonb, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.submit_public_form_core(p_kind text, p_row jsonb, p_idempotency_key uuid, p_request_hash text, p_ip_hash text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: FUNCTION submit_public_form_core(p_kind text, p_row jsonb, p_idempotency_key uuid, p_request_hash text, p_ip_hash text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.submit_public_form_core(p_kind text, p_row jsonb, p_idempotency_key uuid, p_request_hash text, p_ip_hash text) IS 'INC11: the pre-evidence transactional gate, callable ONLY through submit_public_form v2 (which verifies + stamps notice evidence first). Not independently exposed.';


--
-- Name: supersede_declarations_on_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.supersede_declarations_on_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if tg_table_name = 'menu_item_recipes' then
    update product_allergen_declarations
       set state='superseded', superseded_reason='recipe changed', updated_at=now()
     where menu_item_id = new.menu_item_id and state='approved'
       and (tg_op='UPDATE' and (old.lines is distinct from new.lines));
  elsif tg_table_name = 'ingredient_specifications' then
    update product_allergen_declarations d
       set state='superseded', superseded_reason='ingredient specification changed', updated_at=now()
      from menu_item_recipes r
     where d.state='approved' and d.recipe_id = r.id
       and r.lines @> jsonb_build_array(jsonb_build_object('ingredient_id', new.ingredient_id));
  end if;
  return new;
end $$;


--
-- Name: training_assignments_protect(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.training_assignments_protect() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;
  end if;
  if is_manager_or_owner() or reward_grant_active() then
    return new;
  end if;
  if new.employee_id      is distinct from old.employee_id
  or new.employee_name    is distinct from old.employee_name
  or new.assessment_id    is distinct from old.assessment_id
  or new.assessment_title is distinct from old.assessment_title
  or new.assigned_by      is distinct from old.assigned_by
  or new.assigned_at      is distinct from old.assigned_at
  or new.due_date         is distinct from old.due_date
  or new.score            is distinct from old.score
  or new.completed_at     is distinct from old.completed_at then
    raise exception 'protected_assignment_columns' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'assigned' and new.status = 'in_progress') then
    raise exception 'assignment_status_locked' using errcode = '42501';
  end if;
  return new;
end $$;


--
-- Name: training_certificates_protect(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.training_certificates_protect() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;
  end if;
  if is_manager_or_owner() or reward_grant_active() then
    return new;
  end if;
  if new.id               is distinct from old.id
  or new.employee_id      is distinct from old.employee_id
  or new.employee_name    is distinct from old.employee_name
  or new.assessment_id    is distinct from old.assessment_id
  or new.assessment_title is distinct from old.assessment_title
  or new.category         is distinct from old.category
  or new.score            is distinct from old.score
  or new.issued_at        is distinct from old.issued_at then
    raise exception 'protected_certificate_columns' using errcode = '42501';
  end if;
  return new;
end $$;


--
-- Name: transition_application(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transition_application(p_id text, p_from_status text, p_to_status text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_row job_applications%rowtype;
  v_actor_name text;
  v_actor_role text;
  v_ack boolean;
begin
  if p_to_status not in ('pending', 'reviewing', 'interview', 'offer', 'declined') then
    raise exception 'application_bad_status: % is not a candidacy status', p_to_status
      using errcode = 'check_violation';
  end if;
  if p_from_status = p_to_status then
    raise exception 'application_transition_noop: the application is already %', p_to_status
      using errcode = 'check_violation';
  end if;

  select * into v_row from job_applications where id = p_id for update;
  if not found then
    raise exception 'application_not_found: %', p_id using errcode = 'no_data_found';
  end if;

  -- Authority: the SAME predicate as the RLS update policy (owner, or an
  -- MFA-verified store manager whose store the application names).
  if not (is_owner() or (is_store_manager() and v_row.applied_store <> ''
          and v_row.applied_store = (select s.name from stores s
                                       where s.id = current_staff_store()))) then
    raise exception
      'application_forbidden: candidacy transitions require the owner or the named store''s manager (two-step verified)'
      using errcode = 'insufficient_privilege';
  end if;

  -- Compare-and-swap: the expected FROM status is the optimistic version.
  if v_row.status <> p_from_status then
    raise exception
      'application_status_stale: the application is now % (you expected %) — refresh, review, decide again',
      v_row.status, p_from_status
      using errcode = 'check_violation';
  end if;

  select name, role into v_actor_name, v_actor_role
    from staff_profiles where auth_id = auth.uid() limit 1;

  perform set_config('milkpop.application_rpc', '1', true);
  update job_applications
     set status = p_to_status, updated_at = now()
   where id = p_id;

  insert into audit_logs (id, operator_name, role, action, module, new_value)
  values ('aud_' || replace(gen_random_uuid()::text, '-', ''),
          coalesce(v_actor_name, 'staff'), coalesce(v_actor_role, 'staff'),
          'Moved application ' || p_id || ' from ' || p_from_status || ' to ' || p_to_status,
          'Careers Desk',
          jsonb_build_object('application_id', p_id,
                             'from', p_from_status, 'to', p_to_status));

  -- Candidate-visible outcomes notify IN THIS TRANSACTION — the same outbox,
  -- posture gate and server-side recipient resolution as every other
  -- candidate-facing mail (dispatch reads the address from the application
  -- row itself; the browser never chooses one).
  if p_to_status in ('offer', 'declined') then
    select coalesce(customer_ack_enabled, false) into v_ack
      from launch_settings where id = true;
    if v_ack and coalesce(trim(v_row.email), '') <> '' then
      insert into notification_outbox
        (event_type, entity_type, entity_id, recipient_kind, template_id, payload)
      values ('application.' || p_to_status, 'careers', p_id, 'customer_ack',
              'application-' || p_to_status,
              jsonb_build_object('application_id', p_id,
                                 'applied_for', v_row.applied_for,
                                 'to_status', p_to_status));
    end if;
  end if;

  return jsonb_build_object('ok', true, 'status', p_to_status);
end $$;


--
-- Name: activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_auth_id uuid,
    actor_staff_id text,
    actor_name text DEFAULT ''::text NOT NULL,
    actor_role text DEFAULT ''::text NOT NULL,
    action text NOT NULL,
    target_kind text,
    target_ref text,
    outcome text DEFAULT 'ok'::text NOT NULL,
    detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT activity_log_outcome_check CHECK ((outcome = ANY (ARRAY['ok'::text, 'granted'::text, 'denied'::text, 'error'::text])))
);


--
-- Name: TABLE activity_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.activity_log IS 'Append-only audit of privileged actions (payroll, permissions, settings, CV access). Written only by trusted server code via the SERVICE-ROLE key; owner-only reads; no client INSERT/UPDATE/DELETE. Extends the email_log pattern to satisfy the security notes in README.md and lets the client "Purge Registry" capability be removed.';


--
-- Name: admin_recovery_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_recovery_intents (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    action text NOT NULL,
    target_staff_id text NOT NULL,
    requested_by text NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    result text,
    CONSTRAINT admin_recovery_intents_action_check CHECK ((action = ANY (ARRAY['reset_mfa'::text, 'revoke_sessions'::text, 'ban_leaver'::text])))
);


--
-- Name: allergen_catalogue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.allergen_catalogue (
    code text NOT NULL,
    label text NOT NULL,
    requires_detail boolean DEFAULT false NOT NULL,
    sort_order integer NOT NULL
);


--
-- Name: TABLE allergen_catalogue; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.allergen_catalogue IS 'R4.8 G1: the 14 regulated categories as fixed reference codes. Business facts (which product contains what) are never seeded — they enter only via recorded, approved declarations.';


--
-- Name: app_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_state (
    key text NOT NULL,
    value jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    scope text DEFAULT 'user'::text NOT NULL,
    owner_staff_id text,
    store_id text,
    CONSTRAINT app_state_scope_check CHECK ((scope = ANY (ARRAY['user'::text, 'store'::text, 'global'::text])))
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id text NOT NULL,
    operator_name text DEFAULT ''::text NOT NULL,
    role text DEFAULT ''::text NOT NULL,
    action text DEFAULT ''::text NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    module text DEFAULT ''::text NOT NULL,
    previous_value text,
    new_value text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: checklist_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checklist_templates (
    id text NOT NULL,
    label text NOT NULL,
    category text NOT NULL,
    critical boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT checklist_templates_category_check CHECK ((category = ANY (ARRAY['opening'::text, 'midday'::text, 'closing'::text])))
);


--
-- Name: clock_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clock_history (
    id text NOT NULL,
    employee_id text,
    employee_name text DEFAULT ''::text NOT NULL,
    date date NOT NULL,
    clock_in timestamp with time zone NOT NULL,
    clock_out timestamp with time zone,
    break_duration_minutes integer DEFAULT 0,
    total_decimal_hours numeric(7,2) DEFAULT 0,
    approved boolean DEFAULT false,
    rejected boolean DEFAULT false,
    approved_by text,
    approved_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT clock_history_numbers_nonneg CHECK ((((break_duration_minutes IS NULL) OR (break_duration_minutes >= 0)) AND ((total_decimal_hours IS NULL) OR (total_decimal_hours >= (0)::numeric)))),
    CONSTRAINT clock_history_out_after_in CHECK (((clock_out IS NULL) OR (clock_out > clock_in)))
);


--
-- Name: cms_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cms_pages (
    id text NOT NULL,
    page_name text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    hero_headline text DEFAULT ''::text NOT NULL,
    hero_subheadline text DEFAULT ''::text NOT NULL,
    hero_image text DEFAULT ''::text NOT NULL,
    about_image1 text,
    about_image2 text,
    cta_text text DEFAULT ''::text NOT NULL,
    section_content text DEFAULT ''::text NOT NULL,
    seo_title text DEFAULT ''::text NOT NULL,
    seo_description text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    last_edited_by text DEFAULT ''::text NOT NULL,
    last_edited_date text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cms_pages_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))
);


--
-- Name: cms_pages_public; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.cms_pages_public AS
 SELECT id,
    page_name,
    title,
    hero_headline,
    hero_subheadline,
    hero_image,
    about_image1,
    about_image2,
    cta_text,
    section_content,
    seo_title,
    seo_description
   FROM public.cms_pages
  WHERE (status = 'published'::text);


--
-- Name: VIEW cms_pages_public; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.cms_pages_public IS 'R4.10 Increment 5: published pages only. NOT yet granted to anon — see 5b.';


--
-- Name: collection_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection_revisions (
    table_key text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE collection_revisions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.collection_revisions IS 'INC11: one monotonic revision per replaceable collection. Bumped by row triggers on every write; read at hydration; checked (FOR UPDATE) by replace_collection so a stale tab cannot overwrite a same-count edit.';


--
-- Name: contact_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_messages (
    id text NOT NULL,
    full_name text NOT NULL,
    email text NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    message text DEFAULT ''::text NOT NULL,
    submitted_at text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key uuid,
    request_hash text,
    notice_version text,
    notice_id text,
    notice_sha256 text
);


--
-- Name: COLUMN contact_messages.idempotency_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contact_messages.idempotency_key IS 'WP-01: client-generated per-attempt UUID. Unique when present; duplicate submits resolve to the original row.';


--
-- Name: COLUMN contact_messages.request_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contact_messages.request_hash IS 'WP01.1: SHA-256 hex of the canonical normalised payload (see job_applications.request_hash).';


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    full_name text NOT NULL,
    email text,
    phone text,
    marketing_ok boolean DEFAULT false NOT NULL,
    loyalty_points integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cv_upload_ip_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cv_upload_ip_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ip_hash text NOT NULL,
    application_id text,
    object_key text,
    status text NOT NULL,
    reject_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cv_upload_ip_log_status_check CHECK ((status = ANY (ARRAY['accepted'::text, 'rejected'::text])))
);


--
-- Name: TABLE cv_upload_ip_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cv_upload_ip_log IS 'Append-only per-IP record of cv-upload attempts (accepted or rejected). Written only by the cv-upload Edge Function via the service-role key; owner-only reads; also the data source for the per-IP upload rate limit. Stores a hash of the IP, never the raw address.';


--
-- Name: daily_closes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_closes (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    store_id text NOT NULL,
    business_date date NOT NULL,
    gross_sales numeric(12,2) DEFAULT 0 NOT NULL,
    discounts numeric(12,2) DEFAULT 0 NOT NULL,
    refunds numeric(12,2) DEFAULT 0 NOT NULL,
    net_sales numeric(12,2) DEFAULT 0 NOT NULL,
    cash_expected numeric(12,2) DEFAULT 0 NOT NULL,
    cash_counted numeric(12,2) DEFAULT 0 NOT NULL,
    cash_variance numeric(12,2) GENERATED ALWAYS AS ((cash_counted - cash_expected)) STORED,
    card_total numeric(12,2) DEFAULT 0 NOT NULL,
    card_settlement_ref text DEFAULT ''::text NOT NULL,
    paid_outs numeric(12,2) DEFAULT 0 NOT NULL,
    closed_by_staff_id text,
    approved_by_staff_id text,
    closed_at timestamp with time zone DEFAULT now() NOT NULL,
    corrects_close_id text,
    correction_reason text
);


--
-- Name: TABLE daily_closes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.daily_closes IS 'R4.8 O: daily reconciliation. Posted closes are immutable (no update/delete policy); corrections append with an audited reason and reference.';


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id text NOT NULL,
    order_number bigint NOT NULL,
    store_id text,
    store_name text DEFAULT ''::text NOT NULL,
    channel public.order_channel DEFAULT 'walk_in'::public.order_channel NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    applied_deals jsonb DEFAULT '[]'::jsonb NOT NULL,
    subtotal numeric(10,2) DEFAULT 0 NOT NULL,
    discount_total numeric(10,2) DEFAULT 0 NOT NULL,
    tax_rate numeric(5,2),
    tax_amount numeric(10,2) DEFAULT 0 NOT NULL,
    total numeric(10,2) DEFAULT 0 NOT NULL,
    payment_method public.payment_method DEFAULT 'card'::public.payment_method NOT NULL,
    cash_received numeric(10,2),
    change_given numeric(10,2),
    status public.order_status DEFAULT 'completed'::public.order_status NOT NULL,
    customer_name text,
    staff_id text,
    staff_name text DEFAULT ''::text NOT NULL,
    placed_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    refund_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    store_vat_status text,
    vat_effective_date date,
    quote_id text,
    till_session_id text,
    payment_status text,
    payment_reference text,
    payment_captured_at timestamp with time zone,
    cash_change numeric(10,2),
    payment_claimed_at timestamp with time zone,
    payment_recorded_at timestamp with time zone,
    payment_operator_staff_id text,
    finalised_by_staff_id text,
    finalisation_reason text,
    CONSTRAINT orders_cash_arithmetic CHECK (
CASE
    WHEN (payment_method = 'cash'::public.payment_method) THEN ((cash_received IS NOT NULL) AND (change_given IS NOT NULL) AND (cash_received >= total) AND (round(change_given, 2) = round((cash_received - total), 2)))
    ELSE ((cash_received IS NULL) AND (change_given IS NULL))
END),
    CONSTRAINT orders_completed_has_timestamp CHECK (((status <> 'completed'::public.order_status) OR (completed_at IS NOT NULL))),
    CONSTRAINT orders_discount_le_subtotal CHECK ((discount_total <= subtotal)),
    CONSTRAINT orders_money_nonneg CHECK (((subtotal >= (0)::numeric) AND (discount_total >= (0)::numeric) AND (tax_amount >= (0)::numeric) AND (tax_rate >= (0)::numeric) AND (total >= (0)::numeric) AND ((cash_received IS NULL) OR (cash_received >= (0)::numeric)) AND ((change_given IS NULL) OR (change_given >= (0)::numeric)))),
    CONSTRAINT orders_payment_status_controlled CHECK (((payment_status IS NULL) OR (payment_status = ANY (ARRAY['CASH_RECORDED'::text, 'OPERATOR_RECORDED_UNRECONCILED'::text, 'MANUAL_EVIDENCE_MATCHED'::text])))),
    CONSTRAINT orders_refund_has_reason CHECK (((status <> 'refunded'::public.order_status) OR ((refund_reason IS NOT NULL) AND (refund_reason <> ''::text)))),
    CONSTRAINT orders_store_vat_status_controlled CHECK (((store_vat_status IS NULL) OR (store_vat_status = ANY (ARRAY['NOT_REGISTERED'::text, 'REGISTERED'::text])))),
    CONSTRAINT orders_tax_le_total CHECK ((tax_amount <= total)),
    CONSTRAINT orders_tax_rate_bounds CHECK (((tax_rate >= (0)::numeric) AND (tax_rate <= (100)::numeric))),
    CONSTRAINT orders_total_equation CHECK ((round(total, 2) = round((subtotal - discount_total), 2))),
    CONSTRAINT orders_vat_effective_scope CHECK (((vat_effective_date IS NULL) OR (store_vat_status = 'REGISTERED'::text))),
    CONSTRAINT orders_vat_registered_has_effective CHECK (((store_vat_status IS DISTINCT FROM 'REGISTERED'::text) OR (vat_effective_date IS NOT NULL))),
    CONSTRAINT orders_vat_snapshot_coherent CHECK (((store_vat_status IS DISTINCT FROM 'NOT_REGISTERED'::text) OR ((COALESCE(tax_rate, ('-1'::integer)::numeric) = (0)::numeric) AND (tax_amount = (0)::numeric))))
);


--
-- Name: COLUMN orders.tax_rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.tax_rate IS 'Headline applied rate SNAPSHOT: 0 under NOT_REGISTERED; the uniform per-line rate when REGISTERED lines share one rate; NULL for a mixed-rate order (the per-line snapshots on order_items are the authority). Never defaulted.';


--
-- Name: COLUMN orders.store_vat_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.store_vat_status IS 'Immutable snapshot of the store''s VAT status at the moment of sale. NULL only on rows that predate the VAT lifecycle.';


--
-- Name: COLUMN orders.payment_claimed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.payment_claimed_at IS 'The payment time ASSERTED by the client, after server bounds-checking. NULL when the client asserted none.';


--
-- Name: COLUMN orders.payment_recorded_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.payment_recorded_at IS 'The SERVER clock when the sale was written. Always server-generated; never accepted from a caller.';


--
-- Name: COLUMN orders.payment_operator_staff_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.payment_operator_staff_id IS 'The operator who actually took the payment (from the reservation). Preserved even when a manager finalises or recovers.';


--
-- Name: COLUMN orders.finalised_by_staff_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.finalised_by_staff_id IS 'Who wrote this record — the same as the operator on an ordinary sale, a manager/owner on an override or recovery.';


--
-- Name: daily_sales; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.daily_sales WITH (security_invoker='true') AS
 SELECT (date_trunc('day'::text, placed_at))::date AS sales_date,
    store_name,
    count(*) AS orders_count,
    sum(total) AS gross_revenue,
    sum(tax_amount) AS vat_collected,
    sum(discount_total) AS discounts_given,
    round(avg(total), 2) AS average_ticket
   FROM public.orders
  WHERE (status = 'completed'::public.order_status)
  GROUP BY ((date_trunc('day'::text, placed_at))::date), store_name
  ORDER BY ((date_trunc('day'::text, placed_at))::date) DESC;


--
-- Name: deals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deals (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    type public.deal_type NOT NULL,
    active boolean DEFAULT false NOT NULL,
    category public.menu_category,
    buy_qty integer,
    bundle_price numeric(10,2),
    free_qty integer,
    percent_off numeric(5,2),
    amount_off numeric(10,2),
    min_order_value numeric(10,2),
    badge text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: COLUMN deals.active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.deals.active IS 'R4.10 Increment 7: defaults to FALSE. A new offer is created paused.';


--
-- Name: deals_public; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.deals_public AS
 SELECT id,
    name,
    description,
    type,
    category,
    badge,
    buy_qty,
    free_qty,
    percent_off,
    amount_off,
    bundle_price,
    min_order_value
   FROM public.deals
  WHERE (active = true);


--
-- Name: VIEW deals_public; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.deals_public IS 'R4.10 Increment 5: active deals only. NOT yet granted to anon — see 5b.';


--
-- Name: email_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sent_by_auth_id uuid NOT NULL,
    sent_by_staff_id text,
    sent_by_name text DEFAULT ''::text NOT NULL,
    sent_by_role text DEFAULT ''::text NOT NULL,
    template_id text NOT NULL,
    recipient_kind text NOT NULL,
    recipient_ref text,
    recipient_email text DEFAULT ''::text NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    status text NOT NULL,
    reject_reason text,
    provider_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_log_status_check CHECK ((status = ANY (ARRAY['sending'::text, 'sent'::text, 'provider_error'::text, 'rejected'::text])))
);


--
-- Name: TABLE email_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.email_log IS 'Append-only audit of every send-email Edge Function attempt (sent, failed or rejected). Written only by the function via the SERVICE-ROLE key; owner-only reads; also the data source for the per-caller and per-recipient hourly rate limits.';


--
-- Name: form_submission_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_submission_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ip_hash text NOT NULL,
    form_kind text NOT NULL,
    status text NOT NULL,
    reject_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT form_submission_log_form_kind_check CHECK ((form_kind = ANY (ARRAY['careers'::text, 'franchise'::text, 'contact'::text]))),
    CONSTRAINT form_submission_log_status_check CHECK ((status = ANY (ARRAY['accepted'::text, 'rejected'::text])))
);


--
-- Name: TABLE form_submission_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.form_submission_log IS 'Append-only per-IP record of public-form submissions (careers/franchise/contact), written only by the public-form Edge Function via the service role. Owner-only reads; also the data source for the per-IP form rate limit. Stores a hash of the IP, never the raw address.';


--
-- Name: franchise_inquiries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.franchise_inquiries (
    id text NOT NULL,
    full_name text NOT NULL,
    email text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    country text DEFAULT ''::text NOT NULL,
    city text DEFAULT ''::text NOT NULL,
    budget text DEFAULT ''::text NOT NULL,
    experience text DEFAULT ''::text NOT NULL,
    message text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    submitted_at text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    idempotency_key uuid,
    request_hash text,
    notice_version text,
    notice_id text,
    notice_sha256 text,
    CONSTRAINT franchise_inquiries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'reviewed'::text, 'contacted'::text, 'approved'::text, 'declined'::text])))
);


--
-- Name: COLUMN franchise_inquiries.idempotency_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.franchise_inquiries.idempotency_key IS 'WP-01: client-generated per-attempt UUID. Unique when present; duplicate submits resolve to the original row.';


--
-- Name: COLUMN franchise_inquiries.request_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.franchise_inquiries.request_hash IS 'WP01.1: SHA-256 hex of the canonical normalised payload (see job_applications.request_hash).';


--
-- Name: ingredient_specifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingredient_specifications (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    ingredient_id text NOT NULL,
    supplier_name text DEFAULT ''::text NOT NULL,
    supplier_ref text DEFAULT ''::text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    effective_date date,
    contains jsonb DEFAULT '[]'::jsonb NOT NULL,
    may_contain jsonb DEFAULT '[]'::jsonb NOT NULL,
    cross_contact_notes text DEFAULT ''::text NOT NULL,
    evidence_document_id text,
    reviewed_by_staff_id text,
    reviewed_at timestamp with time zone,
    superseded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ingredients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingredients (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    name text NOT NULL,
    unit text DEFAULT 'unit'::text NOT NULL,
    par_level numeric(12,2) DEFAULT 0 NOT NULL,
    cost_per_unit numeric(12,4) DEFAULT 0 NOT NULL,
    supplier text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: job_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_applications (
    id text NOT NULL,
    full_name text NOT NULL,
    email text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    applied_for text DEFAULT ''::text NOT NULL,
    applied_store text DEFAULT ''::text NOT NULL,
    availability text DEFAULT ''::text NOT NULL,
    experience text DEFAULT ''::text NOT NULL,
    message text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    applied_at text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cv_path text,
    idempotency_key uuid,
    request_hash text,
    cv_present boolean GENERATED ALWAYS AS (((cv_path IS NOT NULL) AND (cv_path <> ''::text))) STORED,
    notice_version text,
    marketing_opt_in boolean DEFAULT false NOT NULL,
    notice_id text,
    notice_sha256 text,
    CONSTRAINT job_applications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'reviewing'::text, 'interview'::text, 'offer'::text, 'declined'::text])))
);


--
-- Name: COLUMN job_applications.cv_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.job_applications.cv_path IS 'Storage object key of the uploaded CV in the private `cvs` bucket (random UUID, set ONLY by the cv-upload Edge Function via the service-role key). Never a URL and never file bytes. Managers/owners fetch a short-lived signed URL through the cv-signed-url function, which resolves this key server-side — the client never names a storage path.';


--
-- Name: COLUMN job_applications.idempotency_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.job_applications.idempotency_key IS 'WP-01: client-generated per-attempt UUID. Unique when present; the public-form Edge Function resolves a duplicate insert (network retry) to the original row id.';


--
-- Name: COLUMN job_applications.request_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.job_applications.request_hash IS 'WP01.1: SHA-256 hex of the canonical normalised payload. Same idempotency_key + same hash → original row; same key + different hash → idempotency_conflict.';


--
-- Name: job_vacancies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_vacancies (
    id text NOT NULL,
    title text NOT NULL,
    department text DEFAULT ''::text NOT NULL,
    location text DEFAULT ''::text NOT NULL,
    salary text DEFAULT ''::text NOT NULL,
    type text DEFAULT 'Part-time'::text NOT NULL,
    role_description text DEFAULT ''::text NOT NULL,
    requirements jsonb DEFAULT '[]'::jsonb NOT NULL,
    responsibilities jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    CONSTRAINT job_vacancies_status_chk CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'closed'::text]))),
    CONSTRAINT job_vacancies_type_check CHECK ((type = ANY (ARRAY['Full-time'::text, 'Part-time'::text])))
);


--
-- Name: COLUMN job_vacancies.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.job_vacancies.status IS 'draft | published | closed. R4.10: new vacancies default to draft; existing rows were backfilled to published so an upgrade does not silently unpublish a live listing.';


--
-- Name: job_vacancies_public; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.job_vacancies_public AS
 SELECT id,
    title,
    department,
    location,
    salary,
    type,
    role_description,
    requirements,
    responsibilities,
    created_at,
    updated_at
   FROM public.job_vacancies
  WHERE (status = 'published'::text);


--
-- Name: VIEW job_vacancies_public; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.job_vacancies_public IS 'R4.10 Increment 5: published vacancies only. NOT yet granted to anon — see 5b.';


--
-- Name: kb_articles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_articles (
    id text NOT NULL,
    title text NOT NULL,
    category text DEFAULT 'recipes'::text NOT NULL,
    last_updated text DEFAULT ''::text NOT NULL,
    author text DEFAULT ''::text NOT NULL,
    reading_time text DEFAULT ''::text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: loyalty_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.loyalty_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id text NOT NULL,
    order_id text,
    points integer NOT NULL,
    reason text DEFAULT 'purchase'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: media_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_assets (
    id text NOT NULL,
    name text NOT NULL,
    folder text DEFAULT 'brand'::text NOT NULL,
    size text DEFAULT ''::text NOT NULL,
    type text DEFAULT ''::text NOT NULL,
    uploaded_at text DEFAULT ''::text NOT NULL,
    url text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_public boolean DEFAULT false NOT NULL,
    CONSTRAINT media_assets_folder_check CHECK ((folder = ANY (ARRAY['products'::text, 'stores'::text, 'banners'::text, 'documents'::text, 'brand'::text])))
);


--
-- Name: COLUMN media_assets.is_public; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.media_assets.is_public IS 'R4.10: explicit public-delivery flag, default false. An asset is published deliberately, never by existing.';


--
-- Name: media_assets_public; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.media_assets_public AS
 SELECT id,
    name,
    folder,
    type,
    url
   FROM public.media_assets
  WHERE (is_public = true);


--
-- Name: VIEW media_assets_public; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.media_assets_public IS 'R4.10 Increment 5: explicitly public assets only. NOT yet granted to anon — see 5b.';


--
-- Name: media_references; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_references (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_object_id uuid NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    field_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE media_references; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.media_references IS 'WP04R: which entity field uses which object — one row per (entity, field). Replacing a field''s image moves this row to the new object; the OLD object is only a cleanup CANDIDATE if it then has zero rows here AND the content scan cannot find its path anywhere.';


--
-- Name: menu_item_recipes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menu_item_recipes (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    menu_item_id text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    lines jsonb DEFAULT '[]'::jsonb NOT NULL,
    state text DEFAULT 'draft'::text NOT NULL,
    approved_by_staff_id text,
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT menu_item_recipes_state_check CHECK ((state = ANY (ARRAY['draft'::text, 'awaiting_evidence'::text, 'awaiting_approval'::text, 'approved'::text, 'superseded'::text, 'suspended'::text])))
);


--
-- Name: menu_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menu_items (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    category public.menu_category NOT NULL,
    price numeric(10,2) NOT NULL,
    price_large numeric(10,2),
    calories integer DEFAULT 0 NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    allergens jsonb DEFAULT '[]'::jsonb NOT NULL,
    image text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tax_code text,
    available boolean DEFAULT false NOT NULL,
    CONSTRAINT menu_items_price_check CHECK ((price >= (0)::numeric)),
    CONSTRAINT menu_items_price_large_check CHECK (((price_large IS NULL) OR (price_large >= (0)::numeric)))
);


--
-- Name: COLUMN menu_items.tax_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.menu_items.tax_code IS 'Controlled VAT classification (tax_codes). NULL = not yet classified. Classification is an explicit owner act; REGISTERED trading refuses unclassified products; NOT_REGISTERED trading records rate 0 regardless.';


--
-- Name: COLUMN menu_items.available; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.menu_items.available IS 'R4.10 Increment 7: defaults to FALSE. A new product is created hidden and published deliberately through publish_record(). Existing rows were left untouched by the change.';


--
-- Name: menu_items_public; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.menu_items_public AS
 SELECT id,
    name,
    description,
    category,
    price,
    price_large,
    calories,
    tags,
        CASE
            WHEN (( SELECT ls.allergen_disclosure_mode
               FROM public.launch_settings ls
              WHERE ls.id) = 'declared'::text) THEN allergens
            ELSE '[]'::jsonb
        END AS allergens,
    image,
    available,
    created_at,
    updated_at
   FROM public.menu_items mi
  WHERE available;


--
-- Name: VIEW menu_items_public; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.menu_items_public IS 'R4.9 G4: the anonymous menu surface. Available products only, customer-facing columns only; tax_code and the internal timestamps of unavailable rows are unreachable because the base table is not anon-readable. Mirrors stores_public.';


--
-- Name: news_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.news_posts (
    id text NOT NULL,
    title text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    category text DEFAULT 'Announcement'::text NOT NULL,
    date text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    image text,
    tag_color text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    slug text,
    CONSTRAINT news_posts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))
);


--
-- Name: news_posts_public; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.news_posts_public AS
 SELECT id,
    title,
    content,
    category,
    date,
    image,
    tag_color,
    status,
    created_at,
    updated_at,
    slug
   FROM public.news_posts
  WHERE (status = 'published'::text);


--
-- Name: VIEW news_posts_public; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.news_posts_public IS 'R4.10 Increment 5: published posts only. NOT yet granted to anon — see 5b.';


--
-- Name: online_payment_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.online_payment_accounts (
    id text NOT NULL,
    store_id text NOT NULL,
    provider text NOT NULL,
    account_id text NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT opa_identity_present CHECK (((length(btrim(provider)) > 0) AND (length(btrim(account_id)) > 0))),
    CONSTRAINT opa_status_controlled CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'RETIRED'::text])))
);


--
-- Name: TABLE online_payment_accounts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.online_payment_accounts IS 'Registered online (card-not-present) provider accounts. finalise_order_payment DERIVES the online namespace from this table; the client never supplies it. Admin-registered like payment_terminals.';


--
-- Name: ops_heartbeats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ops_heartbeats (
    job_name text NOT NULL,
    last_run_at timestamp with time zone DEFAULT now() NOT NULL,
    last_status text DEFAULT 'ok'::text NOT NULL,
    detail text DEFAULT ''::text NOT NULL,
    CONSTRAINT ops_heartbeats_last_status_check CHECK ((last_status = ANY (ARRAY['ok'::text, 'failed'::text])))
);


--
-- Name: order_item_modifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_item_modifiers (
    row_id uuid DEFAULT gen_random_uuid() NOT NULL,
    id text NOT NULL,
    order_item_id uuid NOT NULL,
    order_id text NOT NULL,
    menu_item_id text,
    name text NOT NULL,
    price numeric(10,2) DEFAULT 0 NOT NULL,
    tax_code text,
    tax_rate numeric(5,2),
    taxable_amount numeric(10,2),
    tax_amount numeric(10,2),
    CONSTRAINT oim_tax_le_taxable CHECK (((tax_amount IS NULL) OR (taxable_amount IS NULL) OR (tax_amount <= taxable_amount))),
    CONSTRAINT oim_tax_nonneg CHECK ((((taxable_amount IS NULL) OR (taxable_amount >= (0)::numeric)) AND ((tax_amount IS NULL) OR (tax_amount >= (0)::numeric)))),
    CONSTRAINT oim_tax_rate_bounds CHECK (((tax_rate IS NULL) OR ((tax_rate >= (0)::numeric) AND (tax_rate <= (100)::numeric)))),
    CONSTRAINT order_item_modifiers_price_nonneg CHECK ((price >= (0)::numeric))
);


--
-- Name: order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_items (
    row_id uuid DEFAULT gen_random_uuid() NOT NULL,
    id text NOT NULL,
    order_id text NOT NULL,
    menu_item_id text,
    name text NOT NULL,
    category public.menu_category NOT NULL,
    size public.item_size DEFAULT 'one_size'::public.item_size NOT NULL,
    unit_price numeric(10,2) NOT NULL,
    quantity integer NOT NULL,
    line_total numeric(10,2) NOT NULL,
    notes text,
    tax_code text,
    tax_rate numeric(5,2),
    taxable_amount numeric(10,2),
    tax_amount numeric(10,2),
    CONSTRAINT order_items_money_nonneg CHECK (((unit_price >= (0)::numeric) AND (line_total >= (0)::numeric))),
    CONSTRAINT order_items_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT order_items_tax_le_taxable CHECK (((tax_amount IS NULL) OR (taxable_amount IS NULL) OR (tax_amount <= taxable_amount))),
    CONSTRAINT order_items_tax_nonneg CHECK ((((taxable_amount IS NULL) OR (taxable_amount >= (0)::numeric)) AND ((tax_amount IS NULL) OR (tax_amount >= (0)::numeric)))),
    CONSTRAINT order_items_tax_rate_bounds CHECK (((tax_rate IS NULL) OR ((tax_rate >= (0)::numeric) AND (tax_rate <= (100)::numeric))))
);


--
-- Name: order_quotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_quotes (
    id text NOT NULL,
    store_id text NOT NULL,
    staff_id text,
    channel public.order_channel NOT NULL,
    status text DEFAULT 'OPEN'::text NOT NULL,
    items jsonb NOT NULL,
    applied_deals jsonb DEFAULT '[]'::jsonb NOT NULL,
    subtotal numeric(10,2) NOT NULL,
    discount_total numeric(10,2) NOT NULL,
    tax_rate numeric(5,2),
    tax_amount numeric(10,2) NOT NULL,
    total numeric(10,2) NOT NULL,
    store_vat_status text NOT NULL,
    vat_effective_date date,
    allowed_payment_methods jsonb NOT NULL,
    config_version text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    payment_started_at timestamp with time zone,
    reservation_id text,
    reservation_hash text,
    released_at timestamp with time zone,
    release_reason text,
    payment_hash text,
    consumed_at timestamp with time zone,
    order_id text,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    quote_request_hash text,
    resolution_id text,
    resolution_hash text,
    CONSTRAINT oq_consumed_coherent CHECK ((((status = 'CONSUMED'::text) AND (consumed_at IS NOT NULL) AND (order_id IS NOT NULL) AND (payment_hash IS NOT NULL)) OR ((status <> 'CONSUMED'::text) AND (consumed_at IS NULL) AND (order_id IS NULL)))),
    CONSTRAINT oq_money_nonneg CHECK (((subtotal >= (0)::numeric) AND (discount_total >= (0)::numeric) AND (tax_amount >= (0)::numeric) AND (total >= (0)::numeric) AND (tax_amount <= total))),
    CONSTRAINT oq_status_controlled CHECK ((status = ANY (ARRAY['OPEN'::text, 'PAYMENT_PENDING'::text, 'NEEDS_RECONCILIATION'::text, 'CONSUMED'::text, 'EXPIRED'::text, 'CANCELLED'::text])))
);


--
-- Name: TABLE order_quotes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.order_quotes IS 'An immutable priced snapshot. Finalisation copies from it and never reprices; the financial columns cannot be rewritten after creation.';


--
-- Name: COLUMN order_quotes.quote_request_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.order_quotes.quote_request_hash IS 'Canonical SHA-256 of the quote REQUEST (store, staff, channel, raw items, deals, id). A replayed quote id with a different basket is an idempotency_conflict, never a silent substitution.';


--
-- Name: COLUMN order_quotes.resolution_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.order_quotes.resolution_id IS 'Caller-supplied identity of the privileged recovery that resolved this payment. Replaying it with the same claim returns the original outcome; replaying it with a changed claim conflicts.';


--
-- Name: payment_reconciliations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_reconciliations (
    id text NOT NULL,
    attempt_reservation_id text NOT NULL,
    order_id text NOT NULL,
    store_id text NOT NULL,
    provider text NOT NULL,
    provider_reference text NOT NULL,
    settlement_source text NOT NULL,
    settled_amount numeric(10,2) NOT NULL,
    settled_at timestamp with time zone NOT NULL,
    settlement_reference text,
    evidence_hash text NOT NULL,
    reason text,
    recorded_by_staff_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    evidence_type text,
    matched_currency text,
    idempotency_key text,
    payment_event_at timestamp with time zone,
    CONSTRAINT preconc_evidence_type_controlled CHECK (((evidence_type IS NULL) OR (evidence_type = ANY (ARRAY['terminal_receipt'::text, 'z_report'::text, 'merchant_portal'::text, 'settlement_statement'::text, 'legacy_unspecified'::text])))),
    CONSTRAINT preconc_manual_evidence_complete CHECK (((evidence_type IS NOT NULL) AND (matched_currency IS NOT NULL) AND (idempotency_key IS NOT NULL) AND (payment_event_at IS NOT NULL)))
);


--
-- Name: TABLE payment_reconciliations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payment_reconciliations IS 'Append-only manager/owner-attested MANUAL_EVIDENCE_MATCHED record: a card/online payment matched against external evidence (terminal receipt, Z-report, merchant portal or settlement statement). Recording one is the only thing that may move an order to MANUAL_EVIDENCE_MATCHED. NOT independent provider settlement; PROVIDER_RECONCILED is reserved for a future authenticated integration.';


--
-- Name: payment_terminals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_terminals (
    id text NOT NULL,
    store_id text NOT NULL,
    provider text NOT NULL,
    merchant_id text NOT NULL,
    terminal_id text NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_terminals_identity_present CHECK (((length(btrim(provider)) > 0) AND (length(btrim(merchant_id)) > 0) AND (length(btrim(terminal_id)) > 0))),
    CONSTRAINT payment_terminals_status_controlled CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'RETIRED'::text])))
);


--
-- Name: TABLE payment_terminals; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payment_terminals IS 'Registered card terminals. finalise_order_payment DERIVES the provider namespace from this table; the client never supplies provider, merchant or terminal identifiers.';


--
-- Name: payroll_export_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_export_batches (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    period_key text NOT NULL,
    provider_name text DEFAULT ''::text NOT NULL,
    employee_count integer DEFAULT 0 NOT NULL,
    approved_hours_total numeric(10,2) DEFAULT 0 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    exported_at timestamp with time zone,
    exported_by_staff_id text,
    provider_run_ref text,
    notes text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payroll_export_batches_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'exported'::text, 'provider_confirmed'::text, 'superseded'::text])))
);


--
-- Name: payslips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payslips (
    id text NOT NULL,
    employee_id text,
    employee_name text DEFAULT ''::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    period_key text NOT NULL,
    period_label text DEFAULT ''::text NOT NULL,
    hours_total numeric(8,2) DEFAULT 0 NOT NULL,
    hourly_rate numeric(10,2) DEFAULT 0 NOT NULL,
    gross numeric(10,2) DEFAULT 0 NOT NULL,
    deductions numeric(10,2) DEFAULT 0 NOT NULL,
    net numeric(10,2) DEFAULT 0 NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    generated_at timestamp with time zone NOT NULL,
    generated_by text DEFAULT ''::text NOT NULL,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'estimate'::text NOT NULL,
    provider_run_ref text,
    official_document_id text,
    payment_status text DEFAULT 'not_recorded'::text NOT NULL,
    CONSTRAINT payslips_kind_check CHECK ((kind = ANY (ARRAY['estimate'::text, 'official_reference'::text]))),
    CONSTRAINT payslips_money_nonneg CHECK (((gross >= (0)::numeric) AND (net >= (0)::numeric) AND (deductions >= (0)::numeric) AND (hourly_rate >= (0)::numeric) AND (hours_total >= (0)::numeric))),
    CONSTRAINT payslips_net_equation CHECK (((deductions <= gross) AND (round(net, 2) = round((gross - deductions), 2)))),
    CONSTRAINT payslips_payment_status_check CHECK ((payment_status = ANY (ARRAY['not_recorded'::text, 'exported'::text, 'paid_confirmed'::text]))),
    CONSTRAINT payslips_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'sent'::text])))
);


--
-- Name: COLUMN payslips.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payslips.kind IS 'R4.8 O: estimate until an official provider result is attached; the UI must present estimates as "Earnings estimate", never as a statutory payslip.';


--
-- Name: popular_modifiers; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.popular_modifiers WITH (security_invoker='true') AS
 SELECT m.name,
    count(*) AS times_added,
    sum(m.price) AS revenue
   FROM (public.order_item_modifiers m
     JOIN public.orders o ON (((o.id = m.order_id) AND (o.status = 'completed'::public.order_status))))
  GROUP BY m.name
  ORDER BY (count(*)) DESC;


--
-- Name: pos_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_approvals (
    id text NOT NULL,
    device_id uuid NOT NULL,
    store_id text NOT NULL,
    action_type text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    approver_user_id text,
    approver_name text,
    requested_by_user_id text,
    requested_by_name text,
    reason text,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pos_approvals_action_type_check CHECK ((action_type = ANY (ARRAY['refund'::text, 'void'::text, 'correction'::text, 'variance'::text, 'cash_movement'::text])))
);


--
-- Name: pos_audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_audit_events (
    event_id text NOT NULL,
    device_id uuid NOT NULL,
    store_id text NOT NULL,
    event_type text NOT NULL,
    entity_id text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pos_cash_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_cash_movements (
    id text NOT NULL,
    device_id uuid NOT NULL,
    store_id text NOT NULL,
    shift_id text NOT NULL,
    direction text NOT NULL,
    amount_pence bigint NOT NULL,
    reason text NOT NULL,
    user_id text,
    user_name text,
    approved_by_user_id text,
    approved_by_name text,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pos_cash_movements_amount_pence_check CHECK ((amount_pence > 0)),
    CONSTRAINT pos_cash_movements_direction_check CHECK ((direction = ANY (ARRAY['paid_in'::text, 'paid_out'::text])))
);


--
-- Name: pos_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_catalog (
    version integer NOT NULL,
    snapshot jsonb NOT NULL,
    published_by text,
    published_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pos_corrections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_corrections (
    id text NOT NULL,
    device_id uuid NOT NULL,
    store_id text NOT NULL,
    order_id text,
    shift_id text NOT NULL,
    kind text NOT NULL,
    before_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    after_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    reason text NOT NULL,
    user_id text,
    user_name text,
    approved_by_user_id text,
    approved_by_name text,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pos_corrections_kind_check CHECK ((kind = ANY (ARRAY['payment_method'::text, 'operational'::text])))
);


--
-- Name: pos_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    store_id text NOT NULL,
    store_name text NOT NULL,
    installation_id text NOT NULL,
    device_name text NOT NULL,
    device_code text NOT NULL,
    store_code text NOT NULL,
    app_version text,
    schema_version integer,
    token_hash text NOT NULL,
    pending_token_hash text,
    pending_token_created_at timestamp with time zone,
    revoked boolean DEFAULT false NOT NULL,
    paired_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    last_sync_at timestamp with time zone
);


--
-- Name: pos_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_events (
    event_id text NOT NULL,
    device_id uuid NOT NULL,
    event_type text NOT NULL,
    entity_id text NOT NULL,
    payload jsonb NOT NULL,
    payload_hash text NOT NULL,
    device_created_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pos_order_item_modifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_order_item_modifiers (
    id text NOT NULL,
    order_item_id text NOT NULL,
    modifier_id text NOT NULL,
    name text NOT NULL,
    price_pence bigint NOT NULL,
    CONSTRAINT pos_order_item_modifiers_price_pence_check CHECK ((price_pence >= 0))
);


--
-- Name: pos_order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_order_items (
    id text NOT NULL,
    order_id text NOT NULL,
    product_id text NOT NULL,
    name text NOT NULL,
    category text NOT NULL,
    size text NOT NULL,
    quantity integer NOT NULL,
    unit_price_pence bigint NOT NULL,
    line_total_pence bigint NOT NULL,
    discount_allocation_pence bigint NOT NULL,
    vat_rate_bp integer NOT NULL,
    vat_pence bigint NOT NULL,
    CONSTRAINT pos_order_items_discount_allocation_pence_check CHECK ((discount_allocation_pence >= 0)),
    CONSTRAINT pos_order_items_line_total_pence_check CHECK ((line_total_pence >= 0)),
    CONSTRAINT pos_order_items_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT pos_order_items_size_check CHECK ((size = ANY (ARRAY['regular'::text, 'large'::text, 'one_size'::text]))),
    CONSTRAINT pos_order_items_unit_price_pence_check CHECK ((unit_price_pence >= 0)),
    CONSTRAINT pos_order_items_vat_pence_check CHECK ((vat_pence >= 0)),
    CONSTRAINT pos_order_items_vat_rate_bp_check CHECK (((vat_rate_bp >= 0) AND (vat_rate_bp <= 10000)))
);


--
-- Name: pos_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_orders (
    id text NOT NULL,
    device_id uuid NOT NULL,
    store_id text NOT NULL,
    client_reference text NOT NULL,
    visible_order_number text NOT NULL,
    order_sequence bigint,
    store_code text NOT NULL,
    device_code text NOT NULL,
    status text NOT NULL,
    subtotal_pence bigint NOT NULL,
    discount_pence bigint NOT NULL,
    vat_pence bigint NOT NULL,
    total_pence bigint NOT NULL,
    applied_deals jsonb DEFAULT '[]'::jsonb NOT NULL,
    payment_method text NOT NULL,
    cash_received_pence bigint,
    change_given_pence bigint,
    manual_card_confirmation boolean DEFAULT false NOT NULL,
    shift_id text,
    sold_by_user_id text,
    sold_by_name text,
    occurred_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pos_orders_cash_received_pence_check CHECK (((cash_received_pence IS NULL) OR (cash_received_pence >= 0))),
    CONSTRAINT pos_orders_change_given_pence_check CHECK (((change_given_pence IS NULL) OR (change_given_pence >= 0))),
    CONSTRAINT pos_orders_discount_pence_check CHECK ((discount_pence >= 0)),
    CONSTRAINT pos_orders_payment_method_check CHECK ((payment_method = ANY (ARRAY['cash'::text, 'card'::text]))),
    CONSTRAINT pos_orders_status_check CHECK ((status = 'completed'::text)),
    CONSTRAINT pos_orders_subtotal_pence_check CHECK ((subtotal_pence >= 0)),
    CONSTRAINT pos_orders_total_pence_check CHECK ((total_pence >= 0)),
    CONSTRAINT pos_orders_vat_pence_check CHECK ((vat_pence >= 0))
);


--
-- Name: pos_pair_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_pair_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ip_hash text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pos_pair_attempts_status_check CHECK ((status = ANY (ARRAY['accepted'::text, 'rejected'::text])))
);


--
-- Name: pos_pairing_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_pairing_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code_hash text NOT NULL,
    store_id text NOT NULL,
    store_name text NOT NULL,
    device_label text NOT NULL,
    created_by text,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    used_by_device uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pos_refund_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_refund_items (
    id text NOT NULL,
    refund_id text NOT NULL,
    order_item_id text NOT NULL,
    name text,
    size text,
    quantity integer NOT NULL,
    amount_pence bigint NOT NULL,
    CONSTRAINT pos_refund_items_amount_pence_check CHECK ((amount_pence >= 0)),
    CONSTRAINT pos_refund_items_quantity_check CHECK ((quantity > 0))
);


--
-- Name: pos_refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_refunds (
    id text NOT NULL,
    device_id uuid NOT NULL,
    store_id text NOT NULL,
    order_id text NOT NULL,
    shift_id text NOT NULL,
    kind text NOT NULL,
    method text NOT NULL,
    amount_pence bigint NOT NULL,
    reason text NOT NULL,
    user_id text,
    user_name text,
    approved_by_user_id text,
    approved_by_name text,
    card_terminal_confirmed boolean DEFAULT false NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pos_refunds_amount_pence_check CHECK ((amount_pence > 0)),
    CONSTRAINT pos_refunds_kind_check CHECK ((kind = ANY (ARRAY['full'::text, 'items'::text, 'custom'::text]))),
    CONSTRAINT pos_refunds_method_check CHECK ((method = ANY (ARRAY['cash'::text, 'card'::text])))
);


--
-- Name: pos_shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_shifts (
    id text NOT NULL,
    device_id uuid NOT NULL,
    store_id text NOT NULL,
    status text NOT NULL,
    opened_at timestamp with time zone,
    opened_by_user_id text,
    opened_by_name text,
    opening_cash_pence bigint,
    closed_at timestamp with time zone,
    closed_by_user_id text,
    closed_by_name text,
    counted_cash_pence bigint,
    reported_card_pence bigint,
    expected_cash_pence bigint,
    cash_variance_pence bigint,
    expected_card_pence bigint,
    card_variance_pence bigint,
    variance_reason text,
    closing_note text,
    close_summary jsonb,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pos_shifts_closed_has_facts CHECK (((status <> 'closed'::text) OR ((closed_at IS NOT NULL) AND (closed_by_user_id IS NOT NULL)))),
    CONSTRAINT pos_shifts_opening_cash_pence_check CHECK (((opening_cash_pence IS NULL) OR (opening_cash_pence >= 0))),
    CONSTRAINT pos_shifts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text])))
);


--
-- Name: pos_voids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pos_voids (
    id text NOT NULL,
    device_id uuid NOT NULL,
    store_id text NOT NULL,
    order_id text NOT NULL,
    shift_id text NOT NULL,
    order_total_pence bigint NOT NULL,
    method text NOT NULL,
    card_terminal_confirmed boolean DEFAULT false NOT NULL,
    reason text NOT NULL,
    user_id text,
    user_name text,
    approved_by_user_id text,
    approved_by_name text,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pos_voids_method_check CHECK ((method = ANY (ARRAY['cash'::text, 'card'::text]))),
    CONSTRAINT pos_voids_order_total_pence_check CHECK ((order_total_pence >= 0))
);


--
-- Name: privacy_notice_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.privacy_notice_versions (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    audience text NOT NULL,
    version_label text NOT NULL,
    notice_text text NOT NULL,
    policy_url text DEFAULT ''::text NOT NULL,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    content_sha256 text,
    frozen_at timestamp with time zone,
    CONSTRAINT privacy_notice_versions_audience_check CHECK ((audience = ANY (ARRAY['careers'::text, 'franchise'::text, 'contact'::text, 'staff'::text])))
);


--
-- Name: COLUMN privacy_notice_versions.content_sha256; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.privacy_notice_versions.content_sha256 IS 'INC11: sha256 of notice_text, stamped at publish. A published notice is frozen — this hash is what submissions echo and store as evidence.';


--
-- Name: privacy_notice_current; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.privacy_notice_current AS
 SELECT DISTINCT ON (audience) audience,
    id,
    version_label,
    content_sha256,
    notice_text,
    policy_url,
    published_at
   FROM public.privacy_notice_versions
  WHERE (published_at IS NOT NULL)
  ORDER BY audience, published_at DESC, id DESC;


--
-- Name: VIEW privacy_notice_current; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.privacy_notice_current IS 'INC11: THE notice each public form renders and each submission records — latest published version per audience, frozen text + sha. Anon-readable by design: evidence starts with display.';


--
-- Name: product_allergen_declarations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_allergen_declarations (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    menu_item_id text NOT NULL,
    recipe_id text,
    contains jsonb DEFAULT '[]'::jsonb NOT NULL,
    may_contain jsonb DEFAULT '[]'::jsonb NOT NULL,
    cross_contact_statement text DEFAULT ''::text NOT NULL,
    state text DEFAULT 'draft'::text NOT NULL,
    approved_by_staff_id text,
    approved_at timestamp with time zone,
    superseded_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_allergen_declarations_state_check CHECK ((state = ANY (ARRAY['draft'::text, 'awaiting_evidence'::text, 'awaiting_approval'::text, 'approved'::text, 'superseded'::text, 'suspended'::text])))
);


--
-- Name: site_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.site_settings (
    id integer DEFAULT 1 NOT NULL,
    brand_name text DEFAULT 'MILK POP'::text NOT NULL,
    legal_name text DEFAULT 'Milk Pop'::text NOT NULL,
    company_number text DEFAULT ''::text NOT NULL,
    website_url text DEFAULT 'milkpop.uk'::text NOT NULL,
    instagram_handle text DEFAULT ''::text NOT NULL,
    instagram_url text DEFAULT ''::text NOT NULL,
    facebook_url text DEFAULT ''::text NOT NULL,
    twitter_url text DEFAULT ''::text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    gdpr_email text DEFAULT ''::text NOT NULL,
    hq_address text DEFAULT ''::text NOT NULL,
    footer_tagline text DEFAULT ''::text NOT NULL,
    allergen_notice text DEFAULT ''::text NOT NULL,
    announcement_enabled boolean DEFAULT false NOT NULL,
    announcement_text text DEFAULT ''::text NOT NULL,
    currency_symbol text DEFAULT '£'::text NOT NULL,
    default_opening_hours text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_settings_id_check CHECK ((id = 1))
);


--
-- Name: public_site_configuration; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.public_site_configuration AS
 SELECT s.id,
    COALESCE(NULLIF(l.legal_business_name, ''::text), s.legal_name) AS legal_name,
    COALESCE(NULLIF(l.company_number, ''::text), s.company_number) AS company_number,
    COALESCE(NULLIF(l.registered_address, ''::text), s.hq_address) AS hq_address,
    COALESCE(NULLIF(l.public_contact_email, ''::text), s.email) AS email,
    COALESCE(NULLIF(l.privacy_contact_email, ''::text), s.gdpr_email) AS gdpr_email,
    COALESCE(NULLIF(l.public_telephone, ''::text), s.phone) AS phone,
    COALESCE(NULLIF(l.canonical_url, ''::text), s.website_url) AS website_url,
    s.brand_name,
    s.instagram_handle,
    s.instagram_url,
    s.facebook_url,
    s.twitter_url,
    s.footer_tagline,
    s.allergen_notice,
    s.announcement_enabled,
    s.announcement_text,
    s.currency_symbol,
    s.default_opening_hours,
    s.updated_at
   FROM (public.site_settings s
     LEFT JOIN public.launch_settings l ON ((l.id = true)))
  WHERE (s.id = 1);


--
-- Name: VIEW public_site_configuration; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.public_site_configuration IS 'P0-11: the ONE public source of legal/contact truth. Legal facts come from launch_settings (per-field fallback to site_settings while blank); brand/social/presentation from site_settings. Read-only; private launch controls are never projected.';


--
-- Name: quote_payment_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quote_payment_attempts (
    reservation_id text NOT NULL,
    quote_id text NOT NULL,
    store_id text NOT NULL,
    payment_method text,
    device_id text,
    cash_session_id text,
    operator_staff_id text NOT NULL,
    request_hash text NOT NULL,
    state text DEFAULT 'PENDING'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    released_at timestamp with time zone,
    release_outcome text,
    payment_provider text,
    provider_merchant_id text,
    provider_terminal_id text,
    provider_reference text,
    completed_order_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    terminal_config_id text,
    online_account_id text,
    resolved_by_staff_id text,
    resolved_via text,
    resolved_at timestamp with time zone,
    CONSTRAINT qpa_consumed_coherent CHECK ((((state = 'CONSUMED'::text) AND (completed_order_id IS NOT NULL)) OR ((state <> 'CONSUMED'::text) AND (completed_order_id IS NULL)))),
    CONSTRAINT qpa_release_coherent CHECK ((((state = ANY (ARRAY['DECLINED'::text, 'ABANDONED'::text])) AND (released_at IS NOT NULL) AND (release_outcome IS NOT NULL)) OR ((state <> ALL (ARRAY['DECLINED'::text, 'ABANDONED'::text])) AND (released_at IS NULL) AND (release_outcome IS NULL)))),
    CONSTRAINT qpa_resolved_coherent CHECK ((((state <> 'PENDING'::text) AND (resolved_by_staff_id IS NOT NULL) AND (resolved_via IS NOT NULL) AND (resolved_at IS NOT NULL)) OR ((state = 'PENDING'::text) AND (resolved_by_staff_id IS NULL) AND (resolved_via IS NULL) AND (resolved_at IS NULL)))),
    CONSTRAINT qpa_resolved_via_controlled CHECK (((resolved_via IS NULL) OR (resolved_via = ANY (ARRAY['finalise'::text, 'override_finalise'::text, 'release'::text, 'override_release'::text, 'reconciliation'::text])))),
    CONSTRAINT qpa_state_controlled CHECK ((state = ANY (ARRAY['PENDING'::text, 'DECLINED'::text, 'ABANDONED'::text, 'CONSUMED'::text])))
);


--
-- Name: TABLE quote_payment_attempts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.quote_payment_attempts IS 'One immutable-identity row per payment attempt: PENDING resolves once to DECLINED, ABANDONED or CONSUMED and can never change again. Reservation ids are never recycled. The quote points at its active attempt; it is not the history.';


--
-- Name: COLUMN quote_payment_attempts.terminal_config_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quote_payment_attempts.terminal_config_id IS 'CARD attempts: the registered terminal BOUND at reservation. Finalisation must use exactly this terminal.';


--
-- Name: COLUMN quote_payment_attempts.online_account_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quote_payment_attempts.online_account_id IS 'ONLINE attempts: the registered provider account BOUND at reservation.';


--
-- Name: COLUMN quote_payment_attempts.resolved_by_staff_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.quote_payment_attempts.resolved_by_staff_id IS 'Who resolved the attempt (finalised, released, or reconciled it). The reservation operator is recorded separately in operator_staff_id.';


--
-- Name: retention_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.retention_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity text NOT NULL,
    cutoff timestamp with time zone,
    rows_deleted integer DEFAULT 0 NOT NULL,
    jobs_enqueued integer DEFAULT 0 NOT NULL,
    details jsonb,
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT retention_runs_entity_ck CHECK ((entity = ANY (ARRAY['contact_messages'::text, 'franchise_inquiries'::text, 'job_applications'::text, 'cv_orphans'::text, 'cv_links'::text])))
);


--
-- Name: TABLE retention_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.retention_runs IS 'WS9 retention log: one row per sweep per entity — the cutoff applied, rows deleted and cleanup jobs enqueued. Written only by the retention functions (SECURITY DEFINER); RLS on with zero policies and all API-role grants revoked, so the browser roles can neither read nor forge it. Not application data.';


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    role public.employee_role NOT NULL,
    view boolean DEFAULT true NOT NULL,
    "create" boolean DEFAULT false NOT NULL,
    edit boolean DEFAULT false NOT NULL,
    delete boolean DEFAULT false NOT NULL,
    approve boolean DEFAULT false NOT NULL,
    publish boolean DEFAULT false NOT NULL
);


--
-- Name: sales_by_channel; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.sales_by_channel WITH (security_invoker='true') AS
 SELECT channel,
    count(*) AS orders_count,
    sum(total) AS gross_revenue,
    round(avg(total), 2) AS average_ticket
   FROM public.orders
  WHERE (status = 'completed'::public.order_status)
  GROUP BY channel
  ORDER BY (sum(total)) DESC;


--
-- Name: site_content; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.site_content (
    id integer DEFAULT 1 NOT NULL,
    nav jsonb DEFAULT '{}'::jsonb NOT NULL,
    home jsonb DEFAULT '{}'::jsonb NOT NULL,
    menu_page jsonb DEFAULT '{}'::jsonb NOT NULL,
    stores_page jsonb DEFAULT '{}'::jsonb NOT NULL,
    careers_page jsonb DEFAULT '{}'::jsonb NOT NULL,
    franchise_page jsonb DEFAULT '{}'::jsonb NOT NULL,
    about_page jsonb DEFAULT '{}'::jsonb NOT NULL,
    contact_page jsonb DEFAULT '{}'::jsonb NOT NULL,
    news_page jsonb DEFAULT '{}'::jsonb NOT NULL,
    footer jsonb DEFAULT '{}'::jsonb NOT NULL,
    legal jsonb DEFAULT '{}'::jsonb NOT NULL,
    seo jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_content_id_check CHECK ((id = 1))
);


--
-- Name: TABLE site_content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.site_content IS 'The single row of editable public copy. R4.10 guarantees the row EXISTS from install so a never-configured project can still produce a production build; every column starts empty and the application hydrates defaults for anything unset. Creating the row asserts nothing about the business.';


--
-- Name: staff_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_documents (
    id text NOT NULL,
    name text NOT NULL,
    type text DEFAULT ''::text NOT NULL,
    category text NOT NULL,
    upload_date text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    approved_by text,
    employee_id text,
    employee_name text DEFAULT ''::text NOT NULL,
    expiry_date text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    store_id text,
    store_name text DEFAULT ''::text NOT NULL,
    storage_bucket text,
    storage_path text,
    original_filename text DEFAULT ''::text NOT NULL,
    mime_type text DEFAULT ''::text NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    checksum text DEFAULT ''::text NOT NULL,
    uploaded_by text,
    verified_by text,
    verified_at text,
    CONSTRAINT staff_documents_category_check CHECK ((category = ANY (ARRAY['contracts'::text, 'compliance'::text, 'payslips'::text, 'performance'::text, 'id_verification'::text]))),
    CONSTRAINT staff_documents_status_check CHECK ((status = ANY (ARRAY['approved'::text, 'pending'::text, 'action_required'::text])))
);


--
-- Name: staff_notice_acknowledgements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_notice_acknowledgements (
    id text DEFAULT ('sna_'::text || replace((gen_random_uuid())::text, '-'::text, ''::text)) NOT NULL,
    staff_id text NOT NULL,
    notice_id text NOT NULL,
    acknowledged_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stock_levels; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.stock_levels AS
SELECT
    NULL::text AS id,
    NULL::text AS name,
    NULL::text AS unit,
    NULL::numeric(12,2) AS par_level,
    NULL::numeric AS on_hand,
    NULL::boolean AS below_par;


--
-- Name: stock_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ingredient_id text NOT NULL,
    store_id text,
    quantity numeric(12,2) NOT NULL,
    movement_type text DEFAULT 'delivery'::text NOT NULL,
    note text,
    recorded_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stock_movements_movement_type_check CHECK ((movement_type = ANY (ARRAY['delivery'::text, 'usage'::text, 'waste'::text, 'stocktake_adjustment'::text])))
);


--
-- Name: stores_public; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.stores_public AS
 SELECT id,
    name,
    address,
    postcode,
    opening_hours,
    status,
    delivery_links,
    phone,
    email,
    image,
    coordinates,
    created_at,
    updated_at
   FROM public.stores
  WHERE (setup_status = 'ACTIVE'::text);


--
-- Name: VIEW stores_public; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.stores_public IS 'The anonymous locator surface: setup-ACTIVE stores only, locator columns plus row timestamps. created_at/updated_at were removed by WS6g and reinstated by R4.10 because the production SEO loader requires updated_at for the snapshot/manifest contract — without it a production build cannot complete. Internal setup/VAT and all other administrative columns remain absent, and the base table is not anon-readable.';


--
-- Name: tax_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tax_codes (
    code text NOT NULL,
    rate_percent numeric(5,2) NOT NULL,
    vat_charged boolean NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tax_codes_code_controlled CHECK ((code = ANY (ARRAY['ZERO_RATED'::text, 'STANDARD_RATE'::text, 'REDUCED_RATE'::text, 'OUTSIDE_SCOPE'::text]))),
    CONSTRAINT tax_codes_rate_bounds CHECK (((rate_percent >= (0)::numeric) AND (rate_percent <= (100)::numeric))),
    CONSTRAINT tax_codes_uncharged_is_zero CHECK ((vat_charged OR (rate_percent = (0)::numeric)))
);


--
-- Name: top_products; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.top_products WITH (security_invoker='true') AS
 SELECT oi.menu_item_id,
    oi.name,
    oi.category,
    sum(oi.quantity) AS units_sold,
    sum(oi.line_total) AS revenue
   FROM (public.order_items oi
     JOIN public.orders o ON (((o.id = oi.order_id) AND (o.status = 'completed'::public.order_status))))
  GROUP BY oi.menu_item_id, oi.name, oi.category
  ORDER BY (sum(oi.quantity)) DESC;


--
-- Name: training_assessments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_assessments (
    id text NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    learning_objectives jsonb DEFAULT '[]'::jsonb NOT NULL,
    passing_score integer DEFAULT 80 NOT NULL,
    slides jsonb DEFAULT '[]'::jsonb NOT NULL,
    questions jsonb DEFAULT '[]'::jsonb NOT NULL,
    category text DEFAULT 'brand'::text NOT NULL,
    points integer DEFAULT 0 NOT NULL,
    badge text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    due_days integer DEFAULT 7 NOT NULL,
    mandatory boolean DEFAULT false NOT NULL
);


--
-- Name: COLUMN training_assessments.due_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.training_assessments.due_days IS 'Default deadline (days after assignment) pre-filled when this module is assigned.';


--
-- Name: COLUMN training_assessments.mandatory; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.training_assessments.mandatory IS 'Mandatory modules are flagged prominently in the staff Academy.';


--
-- Name: training_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_assignments (
    id text NOT NULL,
    assessment_id text NOT NULL,
    assessment_title text DEFAULT ''::text NOT NULL,
    employee_id text NOT NULL,
    employee_name text DEFAULT ''::text NOT NULL,
    assigned_by text DEFAULT ''::text NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    due_date date NOT NULL,
    status text DEFAULT 'assigned'::text NOT NULL,
    completed_at timestamp with time zone,
    score integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT training_assignments_status_check CHECK ((status = ANY (ARRAY['assigned'::text, 'in_progress'::text, 'completed'::text])))
);


--
-- Name: training_certificates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_certificates (
    id text NOT NULL,
    employee_id text NOT NULL,
    employee_name text DEFAULT ''::text NOT NULL,
    assessment_id text NOT NULL,
    assessment_title text DEFAULT ''::text NOT NULL,
    category text DEFAULT ''::text NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    emailed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: training_courses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_courses (
    id text NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    category text DEFAULT 'induction'::text NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    points integer DEFAULT 0 NOT NULL,
    estimated_time text DEFAULT ''::text NOT NULL,
    badge text DEFAULT ''::text NOT NULL,
    assessment_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: training_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_progress (
    id text NOT NULL,
    employee_id text NOT NULL,
    course_id text NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT training_progress_progress_check CHECK (((progress >= 0) AND (progress <= 100)))
);


--
-- Name: training_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    submission_id text NOT NULL,
    employee_id text NOT NULL,
    assessment_id text NOT NULL,
    assignment_id text,
    course_id text,
    score integer NOT NULL,
    passed boolean NOT NULL,
    response jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: web_till_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.web_till_devices (
    id text NOT NULL,
    store_id text NOT NULL,
    label text NOT NULL,
    registered_by text,
    registered_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    credential_hash text
);


--
-- Name: COLUMN web_till_devices.credential_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.web_till_devices.credential_hash IS 'SHA-256 of the server-issued pairing secret. NULL means the device pre-dates enrolment and can no longer open a session.';


--
-- Name: web_till_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.web_till_sessions (
    id text NOT NULL,
    store_id text NOT NULL,
    device_id text NOT NULL,
    status text DEFAULT 'OPEN'::text NOT NULL,
    opened_by_staff_id text NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    opening_float numeric(10,2) DEFAULT 0 NOT NULL,
    closed_by_staff_id text,
    closed_at timestamp with time zone,
    CONSTRAINT wts_close_coherent CHECK ((((status = 'OPEN'::text) AND (closed_at IS NULL) AND (closed_by_staff_id IS NULL)) OR ((status = 'CLOSED'::text) AND (closed_at IS NOT NULL) AND (closed_by_staff_id IS NOT NULL)))),
    CONSTRAINT wts_float_nonneg CHECK ((opening_float >= (0)::numeric)),
    CONSTRAINT wts_status_controlled CHECK ((status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text])))
);


--
-- Name: TABLE web_till_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.web_till_sessions IS 'Cash custody anchor for the browser till. No drawer balance is stored: expected cash is derived from immutable financial events.';


--
-- Name: work_shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.work_shifts (
    id text NOT NULL,
    employee_id text,
    employee_name text DEFAULT ''::text NOT NULL,
    role public.employee_role DEFAULT 'team_member'::public.employee_role NOT NULL,
    store_id text,
    store_name text DEFAULT ''::text NOT NULL,
    date date NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    type text DEFAULT 'mid'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    starts_at timestamp with time zone GENERATED ALWAYS AS (timezone('Europe/London'::text, (date + start_time))) STORED,
    ends_at timestamp with time zone GENERATED ALWAYS AS (timezone('Europe/London'::text, ((date + end_time) +
CASE
    WHEN (end_time <= start_time) THEN '1 day'::interval
    ELSE '00:00:00'::interval
END))) STORED,
    lifecycle_status text DEFAULT 'scheduled'::text NOT NULL,
    CONSTRAINT work_shifts_ends_after_starts CHECK ((ends_at > starts_at)),
    CONSTRAINT work_shifts_lifecycle_status_check CHECK ((lifecycle_status = ANY (ARRAY['scheduled'::text, 'completed'::text, 'cancelled_leaver'::text]))),
    CONSTRAINT work_shifts_times_distinct CHECK ((start_time <> end_time)),
    CONSTRAINT work_shifts_type_check CHECK ((type = ANY (ARRAY['opening'::text, 'mid'::text, 'closing'::text, 'delivery'::text, 'training'::text])))
);


--
-- Name: activity_log activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_log
    ADD CONSTRAINT activity_log_pkey PRIMARY KEY (id);


--
-- Name: admin_recovery_intents admin_recovery_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_recovery_intents
    ADD CONSTRAINT admin_recovery_intents_pkey PRIMARY KEY (id);


--
-- Name: allergen_catalogue allergen_catalogue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allergen_catalogue
    ADD CONSTRAINT allergen_catalogue_pkey PRIMARY KEY (code);


--
-- Name: app_state app_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_state
    ADD CONSTRAINT app_state_pkey PRIMARY KEY (key);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: checklist_templates checklist_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checklist_templates
    ADD CONSTRAINT checklist_templates_pkey PRIMARY KEY (id);


--
-- Name: clock_history clock_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clock_history
    ADD CONSTRAINT clock_history_pkey PRIMARY KEY (id);


--
-- Name: cms_pages cms_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cms_pages
    ADD CONSTRAINT cms_pages_pkey PRIMARY KEY (id);


--
-- Name: collection_revisions collection_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_revisions
    ADD CONSTRAINT collection_revisions_pkey PRIMARY KEY (table_key);


--
-- Name: contact_messages contact_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_messages
    ADD CONSTRAINT contact_messages_pkey PRIMARY KEY (id);


--
-- Name: customers customers_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_email_key UNIQUE (email);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: cv_upload_ip_log cv_upload_ip_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cv_upload_ip_log
    ADD CONSTRAINT cv_upload_ip_log_pkey PRIMARY KEY (id);


--
-- Name: daily_closes daily_closes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_closes
    ADD CONSTRAINT daily_closes_pkey PRIMARY KEY (id);


--
-- Name: deals deals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_pkey PRIMARY KEY (id);


--
-- Name: email_log email_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_log
    ADD CONSTRAINT email_log_pkey PRIMARY KEY (id);


--
-- Name: form_submission_log form_submission_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_submission_log
    ADD CONSTRAINT form_submission_log_pkey PRIMARY KEY (id);


--
-- Name: franchise_inquiries franchise_inquiries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.franchise_inquiries
    ADD CONSTRAINT franchise_inquiries_pkey PRIMARY KEY (id);


--
-- Name: ingredient_specifications ingredient_specifications_ingredient_id_revision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_specifications
    ADD CONSTRAINT ingredient_specifications_ingredient_id_revision_key UNIQUE (ingredient_id, revision);


--
-- Name: ingredient_specifications ingredient_specifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_specifications
    ADD CONSTRAINT ingredient_specifications_pkey PRIMARY KEY (id);


--
-- Name: ingredients ingredients_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredients
    ADD CONSTRAINT ingredients_name_key UNIQUE (name);


--
-- Name: ingredients ingredients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredients
    ADD CONSTRAINT ingredients_pkey PRIMARY KEY (id);


--
-- Name: job_applications job_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_applications
    ADD CONSTRAINT job_applications_pkey PRIMARY KEY (id);


--
-- Name: job_vacancies job_vacancies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_vacancies
    ADD CONSTRAINT job_vacancies_pkey PRIMARY KEY (id);


--
-- Name: kb_articles kb_articles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_articles
    ADD CONSTRAINT kb_articles_pkey PRIMARY KEY (id);


--
-- Name: launch_settings launch_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.launch_settings
    ADD CONSTRAINT launch_settings_pkey PRIMARY KEY (id);


--
-- Name: loyalty_transactions loyalty_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_transactions
    ADD CONSTRAINT loyalty_transactions_pkey PRIMARY KEY (id);


--
-- Name: media_assets media_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_pkey PRIMARY KEY (id);


--
-- Name: media_objects media_objects_bucket_storage_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_objects
    ADD CONSTRAINT media_objects_bucket_storage_path_key UNIQUE (bucket, storage_path);


--
-- Name: media_objects media_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_objects
    ADD CONSTRAINT media_objects_pkey PRIMARY KEY (id);


--
-- Name: media_references media_references_entity_type_entity_id_field_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_references
    ADD CONSTRAINT media_references_entity_type_entity_id_field_path_key UNIQUE (entity_type, entity_id, field_path);


--
-- Name: media_references media_references_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_references
    ADD CONSTRAINT media_references_pkey PRIMARY KEY (id);


--
-- Name: menu_item_recipes menu_item_recipes_menu_item_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_item_recipes
    ADD CONSTRAINT menu_item_recipes_menu_item_id_version_key UNIQUE (menu_item_id, version);


--
-- Name: menu_item_recipes menu_item_recipes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_item_recipes
    ADD CONSTRAINT menu_item_recipes_pkey PRIMARY KEY (id);


--
-- Name: menu_items menu_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT menu_items_pkey PRIMARY KEY (id);


--
-- Name: news_posts news_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_posts
    ADD CONSTRAINT news_posts_pkey PRIMARY KEY (id);


--
-- Name: notification_outbox notification_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_pkey PRIMARY KEY (id);


--
-- Name: online_payment_accounts online_payment_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.online_payment_accounts
    ADD CONSTRAINT online_payment_accounts_pkey PRIMARY KEY (id);


--
-- Name: ops_heartbeats ops_heartbeats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_heartbeats
    ADD CONSTRAINT ops_heartbeats_pkey PRIMARY KEY (job_name);


--
-- Name: order_item_modifiers order_item_modifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT order_item_modifiers_pkey PRIMARY KEY (row_id);


--
-- Name: order_items order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (row_id);


--
-- Name: order_quotes order_quotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_quotes
    ADD CONSTRAINT order_quotes_pkey PRIMARY KEY (id);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: payment_reconciliations payment_reconciliations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_reconciliations
    ADD CONSTRAINT payment_reconciliations_pkey PRIMARY KEY (id);


--
-- Name: payment_terminals payment_terminals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_terminals
    ADD CONSTRAINT payment_terminals_pkey PRIMARY KEY (id);


--
-- Name: payroll_export_batches payroll_export_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_export_batches
    ADD CONSTRAINT payroll_export_batches_pkey PRIMARY KEY (id);


--
-- Name: payslips payslips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT payslips_pkey PRIMARY KEY (id);


--
-- Name: pos_approvals pos_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_approvals
    ADD CONSTRAINT pos_approvals_pkey PRIMARY KEY (id);


--
-- Name: pos_audit_events pos_audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_audit_events
    ADD CONSTRAINT pos_audit_events_pkey PRIMARY KEY (event_id);


--
-- Name: pos_cash_movements pos_cash_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_cash_movements
    ADD CONSTRAINT pos_cash_movements_pkey PRIMARY KEY (id);


--
-- Name: pos_catalog pos_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_catalog
    ADD CONSTRAINT pos_catalog_pkey PRIMARY KEY (version);


--
-- Name: pos_corrections pos_corrections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_corrections
    ADD CONSTRAINT pos_corrections_pkey PRIMARY KEY (id);


--
-- Name: pos_devices pos_devices_pending_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_devices
    ADD CONSTRAINT pos_devices_pending_token_hash_key UNIQUE (pending_token_hash);


--
-- Name: pos_devices pos_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_devices
    ADD CONSTRAINT pos_devices_pkey PRIMARY KEY (id);


--
-- Name: pos_devices pos_devices_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_devices
    ADD CONSTRAINT pos_devices_token_hash_key UNIQUE (token_hash);


--
-- Name: pos_events pos_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_events
    ADD CONSTRAINT pos_events_pkey PRIMARY KEY (event_id);


--
-- Name: pos_order_item_modifiers pos_order_item_modifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_order_item_modifiers
    ADD CONSTRAINT pos_order_item_modifiers_pkey PRIMARY KEY (id);


--
-- Name: pos_order_items pos_order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_order_items
    ADD CONSTRAINT pos_order_items_pkey PRIMARY KEY (id);


--
-- Name: pos_orders pos_orders_device_id_visible_order_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_orders
    ADD CONSTRAINT pos_orders_device_id_visible_order_number_key UNIQUE (device_id, visible_order_number);


--
-- Name: pos_orders pos_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_orders
    ADD CONSTRAINT pos_orders_pkey PRIMARY KEY (id);


--
-- Name: pos_pair_attempts pos_pair_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_pair_attempts
    ADD CONSTRAINT pos_pair_attempts_pkey PRIMARY KEY (id);


--
-- Name: pos_pairing_codes pos_pairing_codes_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_pairing_codes
    ADD CONSTRAINT pos_pairing_codes_code_hash_key UNIQUE (code_hash);


--
-- Name: pos_pairing_codes pos_pairing_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_pairing_codes
    ADD CONSTRAINT pos_pairing_codes_pkey PRIMARY KEY (id);


--
-- Name: pos_refund_items pos_refund_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_refund_items
    ADD CONSTRAINT pos_refund_items_pkey PRIMARY KEY (id);


--
-- Name: pos_refunds pos_refunds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_refunds
    ADD CONSTRAINT pos_refunds_pkey PRIMARY KEY (id);


--
-- Name: pos_shifts pos_shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_shifts
    ADD CONSTRAINT pos_shifts_pkey PRIMARY KEY (id);


--
-- Name: pos_voids pos_voids_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_voids
    ADD CONSTRAINT pos_voids_order_id_key UNIQUE (order_id);


--
-- Name: pos_voids pos_voids_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_voids
    ADD CONSTRAINT pos_voids_pkey PRIMARY KEY (id);


--
-- Name: privacy_notice_versions privacy_notice_versions_audience_version_label_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.privacy_notice_versions
    ADD CONSTRAINT privacy_notice_versions_audience_version_label_key UNIQUE (audience, version_label);


--
-- Name: privacy_notice_versions privacy_notice_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.privacy_notice_versions
    ADD CONSTRAINT privacy_notice_versions_pkey PRIMARY KEY (id);


--
-- Name: product_allergen_declarations product_allergen_declarations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_allergen_declarations
    ADD CONSTRAINT product_allergen_declarations_pkey PRIMARY KEY (id);


--
-- Name: quote_payment_attempts quote_payment_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_payment_attempts
    ADD CONSTRAINT quote_payment_attempts_pkey PRIMARY KEY (reservation_id);


--
-- Name: retention_runs retention_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retention_runs
    ADD CONSTRAINT retention_runs_pkey PRIMARY KEY (id);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role);


--
-- Name: sifr_reports sifr_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sifr_reports
    ADD CONSTRAINT sifr_reports_pkey PRIMARY KEY (id);


--
-- Name: site_content site_content_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_content
    ADD CONSTRAINT site_content_pkey PRIMARY KEY (id);


--
-- Name: site_settings site_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.site_settings
    ADD CONSTRAINT site_settings_pkey PRIMARY KEY (id);


--
-- Name: staff_compliance_records staff_compliance_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_compliance_records
    ADD CONSTRAINT staff_compliance_records_pkey PRIMARY KEY (id);


--
-- Name: staff_documents staff_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_documents
    ADD CONSTRAINT staff_documents_pkey PRIMARY KEY (id);


--
-- Name: staff_notice_acknowledgements staff_notice_acknowledgements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_notice_acknowledgements
    ADD CONSTRAINT staff_notice_acknowledgements_pkey PRIMARY KEY (id);


--
-- Name: staff_profiles staff_profiles_auth_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_profiles
    ADD CONSTRAINT staff_profiles_auth_id_key UNIQUE (auth_id);


--
-- Name: staff_profiles staff_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_profiles
    ADD CONSTRAINT staff_profiles_pkey PRIMARY KEY (id);


--
-- Name: stock_movements stock_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_pkey PRIMARY KEY (id);


--
-- Name: storage_cleanup_jobs storage_cleanup_jobs_bucket_storage_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_cleanup_jobs
    ADD CONSTRAINT storage_cleanup_jobs_bucket_storage_path_key UNIQUE (bucket, storage_path);


--
-- Name: storage_cleanup_jobs storage_cleanup_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_cleanup_jobs
    ADD CONSTRAINT storage_cleanup_jobs_pkey PRIMARY KEY (id);


--
-- Name: stores stores_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_name_key UNIQUE (name);


--
-- Name: stores stores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stores
    ADD CONSTRAINT stores_pkey PRIMARY KEY (id);


--
-- Name: tax_codes tax_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tax_codes
    ADD CONSTRAINT tax_codes_pkey PRIMARY KEY (code);


--
-- Name: training_assessments training_assessments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_assessments
    ADD CONSTRAINT training_assessments_pkey PRIMARY KEY (id);


--
-- Name: training_assignments training_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_assignments
    ADD CONSTRAINT training_assignments_pkey PRIMARY KEY (id);


--
-- Name: training_certificates training_certificates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_certificates
    ADD CONSTRAINT training_certificates_pkey PRIMARY KEY (id);


--
-- Name: training_courses training_courses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_courses
    ADD CONSTRAINT training_courses_pkey PRIMARY KEY (id);


--
-- Name: training_progress training_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_progress
    ADD CONSTRAINT training_progress_pkey PRIMARY KEY (id);


--
-- Name: training_results training_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_results
    ADD CONSTRAINT training_results_pkey PRIMARY KEY (id);


--
-- Name: training_results training_results_submission_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_results
    ADD CONSTRAINT training_results_submission_id_key UNIQUE (submission_id);


--
-- Name: web_till_devices web_till_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_till_devices
    ADD CONSTRAINT web_till_devices_pkey PRIMARY KEY (id);


--
-- Name: web_till_sessions web_till_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_till_sessions
    ADD CONSTRAINT web_till_sessions_pkey PRIMARY KEY (id);


--
-- Name: work_shifts work_shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_shifts
    ADD CONSTRAINT work_shifts_pkey PRIMARY KEY (id);


--
-- Name: app_state_scope_store_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_state_scope_store_idx ON public.app_state USING btree (scope, store_id) WHERE (scope = 'store'::text);


--
-- Name: contact_messages_idempotency_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contact_messages_idempotency_key_uq ON public.contact_messages USING btree (idempotency_key);


--
-- Name: franchise_inquiries_idempotency_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX franchise_inquiries_idempotency_key_uq ON public.franchise_inquiries USING btree (idempotency_key);


--
-- Name: idx_activity_log_action_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activity_log_action_time ON public.activity_log USING btree (action, created_at DESC);


--
-- Name: idx_activity_log_actor_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activity_log_actor_time ON public.activity_log USING btree (actor_auth_id, created_at DESC);


--
-- Name: idx_activity_log_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activity_log_target ON public.activity_log USING btree (target_kind, target_ref);


--
-- Name: idx_audit_module; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_module ON public.audit_logs USING btree (module);


--
-- Name: idx_clock_history_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clock_history_date ON public.clock_history USING btree (date);


--
-- Name: idx_clock_history_emp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clock_history_emp ON public.clock_history USING btree (employee_id);


--
-- Name: idx_compliance_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compliance_employee ON public.staff_compliance_records USING btree (employee_id);


--
-- Name: idx_compliance_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compliance_expiry ON public.staff_compliance_records USING btree (expires_at) WHERE (status = ANY (ARRAY['verified'::public.compliance_status, 'expiring'::public.compliance_status]));


--
-- Name: idx_cv_upload_ip_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cv_upload_ip_time ON public.cv_upload_ip_log USING btree (ip_hash, created_at DESC);


--
-- Name: idx_daily_close_once; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_daily_close_once ON public.daily_closes USING btree (store_id, business_date) WHERE (corrects_close_id IS NULL);


--
-- Name: idx_email_log_caller_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_log_caller_time ON public.email_log USING btree (sent_by_auth_id, created_at DESC);


--
-- Name: idx_email_log_recipient_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_log_recipient_time ON public.email_log USING btree (recipient_email, created_at DESC);


--
-- Name: idx_form_submission_ip_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_form_submission_ip_time ON public.form_submission_log USING btree (ip_hash, created_at DESC);


--
-- Name: idx_loyalty_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_loyalty_customer ON public.loyalty_transactions USING btree (customer_id);


--
-- Name: idx_menu_items_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menu_items_category ON public.menu_items USING btree (category);


--
-- Name: idx_oim_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oim_order ON public.order_item_modifiers USING btree (order_id);


--
-- Name: idx_order_items_menu_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_menu_item ON public.order_items USING btree (menu_item_id);


--
-- Name: idx_order_items_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_order ON public.order_items USING btree (order_id);


--
-- Name: idx_orders_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_channel ON public.orders USING btree (channel);


--
-- Name: idx_orders_placed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_placed_at ON public.orders USING btree (placed_at DESC);


--
-- Name: idx_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_status ON public.orders USING btree (status);


--
-- Name: idx_orders_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_store ON public.orders USING btree (store_id);


--
-- Name: idx_outbox_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_claim ON public.notification_outbox USING btree (status, next_attempt_at);


--
-- Name: idx_outbox_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_entity ON public.notification_outbox USING btree (entity_type, entity_id);


--
-- Name: idx_pad_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pad_item ON public.product_allergen_declarations USING btree (menu_item_id, state);


--
-- Name: idx_payslips_emp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payslips_emp ON public.payslips USING btree (employee_id);


--
-- Name: idx_payslips_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payslips_period ON public.payslips USING btree (period_key);


--
-- Name: idx_pos_approvals_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_approvals_entity ON public.pos_approvals USING btree (entity_type, entity_id);


--
-- Name: idx_pos_audit_store_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_audit_store_time ON public.pos_audit_events USING btree (store_id, occurred_at);


--
-- Name: idx_pos_cash_movements_shift; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_cash_movements_shift ON public.pos_cash_movements USING btree (shift_id);


--
-- Name: idx_pos_corrections_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_corrections_order ON public.pos_corrections USING btree (order_id);


--
-- Name: idx_pos_devices_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_devices_store ON public.pos_devices USING btree (store_id);


--
-- Name: idx_pos_events_device_received; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_events_device_received ON public.pos_events USING btree (device_id, received_at);


--
-- Name: idx_pos_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_events_type ON public.pos_events USING btree (event_type, received_at);


--
-- Name: idx_pos_item_mods_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_item_mods_item ON public.pos_order_item_modifiers USING btree (order_item_id);


--
-- Name: idx_pos_order_items_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_order_items_order ON public.pos_order_items USING btree (order_id);


--
-- Name: idx_pos_orders_shift; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_orders_shift ON public.pos_orders USING btree (shift_id);


--
-- Name: idx_pos_orders_store_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_orders_store_time ON public.pos_orders USING btree (store_id, occurred_at);


--
-- Name: idx_pos_pair_attempts_ip_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_pair_attempts_ip_time ON public.pos_pair_attempts USING btree (ip_hash, created_at DESC);


--
-- Name: idx_pos_refund_items_refund; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_refund_items_refund ON public.pos_refund_items USING btree (refund_id);


--
-- Name: idx_pos_refunds_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_refunds_order ON public.pos_refunds USING btree (order_id);


--
-- Name: idx_pos_refunds_shift; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_refunds_shift ON public.pos_refunds USING btree (shift_id);


--
-- Name: idx_pos_shifts_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_shifts_store ON public.pos_shifts USING btree (store_id, opened_at);


--
-- Name: idx_pos_voids_shift; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pos_voids_shift ON public.pos_voids USING btree (shift_id);


--
-- Name: idx_shifts_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_date ON public.work_shifts USING btree (date);


--
-- Name: idx_staff_documents_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_documents_employee ON public.staff_documents USING btree (employee_id);


--
-- Name: idx_staff_documents_store; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_documents_store ON public.staff_documents USING btree (store_id);


--
-- Name: idx_staff_profiles_auth_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_profiles_auth_id ON public.staff_profiles USING btree (auth_id);


--
-- Name: idx_staff_profiles_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_profiles_status ON public.staff_profiles USING btree (status);


--
-- Name: idx_stock_ingredient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_ingredient ON public.stock_movements USING btree (ingredient_id);


--
-- Name: idx_training_assignments_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_training_assignments_employee ON public.training_assignments USING btree (employee_id, status);


--
-- Name: idx_training_certificates_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_training_certificates_employee ON public.training_certificates USING btree (employee_id);


--
-- Name: idx_training_progress_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_training_progress_employee ON public.training_progress USING btree (employee_id);


--
-- Name: idx_training_results_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_training_results_employee ON public.training_results USING btree (employee_id, assessment_id);


--
-- Name: job_applications_cv_path_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_applications_cv_path_idx ON public.job_applications USING btree (cv_path) WHERE (cv_path IS NOT NULL);


--
-- Name: job_applications_idempotency_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX job_applications_idempotency_key_uq ON public.job_applications USING btree (idempotency_key);


--
-- Name: media_objects_cleanup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_objects_cleanup_idx ON public.media_objects USING btree (status, cleanup_after);


--
-- Name: media_references_object_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_references_object_idx ON public.media_references USING btree (media_object_id);


--
-- Name: news_posts_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX news_posts_slug_key ON public.news_posts USING btree (slug) WHERE (slug IS NOT NULL);


--
-- Name: opa_namespace_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX opa_namespace_unique ON public.online_payment_accounts USING btree (provider, account_id);


--
-- Name: order_quotes_resolution_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX order_quotes_resolution_unique ON public.order_quotes USING btree (store_id, resolution_id) WHERE (resolution_id IS NOT NULL);


--
-- Name: orders_one_per_quote; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX orders_one_per_quote ON public.orders USING btree (quote_id) WHERE (quote_id IS NOT NULL);


--
-- Name: payment_reconciliations_idem_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_reconciliations_idem_unique ON public.payment_reconciliations USING btree (store_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: payment_reconciliations_one_per_attempt; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_reconciliations_one_per_attempt ON public.payment_reconciliations USING btree (attempt_reservation_id);


--
-- Name: payment_terminals_namespace_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_terminals_namespace_unique ON public.payment_terminals USING btree (provider, merchant_id, terminal_id);


--
-- Name: qpa_one_pending_per_quote; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX qpa_one_pending_per_quote ON public.quote_payment_attempts USING btree (quote_id) WHERE (state = 'PENDING'::text);


--
-- Name: qpa_provider_reference_namespace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX qpa_provider_reference_namespace ON public.quote_payment_attempts USING btree (payment_provider, provider_merchant_id, provider_terminal_id, provider_reference) WHERE (provider_reference IS NOT NULL);


--
-- Name: storage_cleanup_jobs_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX storage_cleanup_jobs_due_idx ON public.storage_cleanup_jobs USING btree (status, next_attempt_at);


--
-- Name: uq_staff_documents_storage_path; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_staff_documents_storage_path ON public.staff_documents USING btree (storage_path) WHERE (storage_path IS NOT NULL);


--
-- Name: uq_tcert_emp_assess; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_tcert_emp_assess ON public.training_certificates USING btree (employee_id, assessment_id);


--
-- Name: uq_training_progress_emp_course; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_training_progress_emp_course ON public.training_progress USING btree (employee_id, course_id);


--
-- Name: ux_clock_history_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_clock_history_one_active ON public.clock_history USING btree (employee_id) WHERE ((clock_out IS NULL) AND (employee_id IS NOT NULL));


--
-- Name: ux_orders_store_order_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_orders_store_order_number ON public.orders USING btree (COALESCE(store_id, 'hq'::text), order_number);


--
-- Name: ux_payslips_employee_period; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_payslips_employee_period ON public.payslips USING btree (employee_id, period_key) WHERE (employee_id IS NOT NULL);


--
-- Name: ux_pos_shifts_one_open_per_device; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_pos_shifts_one_open_per_device ON public.pos_shifts USING btree (device_id) WHERE (status = 'open'::text);


--
-- Name: wts_one_open_per_device; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wts_one_open_per_device ON public.web_till_sessions USING btree (device_id) WHERE (status = 'OPEN'::text);


--
-- Name: stock_levels _RETURN; Type: RULE; Schema: public; Owner: -
--

CREATE OR REPLACE VIEW public.stock_levels WITH (security_invoker='true') AS
 SELECT i.id,
    i.name,
    i.unit,
    i.par_level,
    COALESCE(sum(m.quantity), (0)::numeric) AS on_hand,
    (COALESCE(sum(m.quantity), (0)::numeric) < i.par_level) AS below_par
   FROM (public.ingredients i
     LEFT JOIN public.stock_movements m ON ((m.ingredient_id = i.id)))
  GROUP BY i.id;


--
-- Name: deals trg_a1_lifecycle_sanctioned; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_a1_lifecycle_sanctioned BEFORE INSERT OR UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION public.assert_lifecycle_change_sanctioned();


--
-- Name: job_vacancies trg_a1_lifecycle_sanctioned; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_a1_lifecycle_sanctioned BEFORE INSERT OR UPDATE ON public.job_vacancies FOR EACH ROW EXECUTE FUNCTION public.assert_lifecycle_change_sanctioned();


--
-- Name: menu_items trg_a1_lifecycle_sanctioned; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_a1_lifecycle_sanctioned BEFORE INSERT OR UPDATE ON public.menu_items FOR EACH ROW EXECUTE FUNCTION public.assert_lifecycle_change_sanctioned();


--
-- Name: news_posts trg_a1_lifecycle_sanctioned; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_a1_lifecycle_sanctioned BEFORE INSERT OR UPDATE ON public.news_posts FOR EACH ROW EXECUTE FUNCTION public.assert_lifecycle_change_sanctioned();


--
-- Name: deals trg_a2_public_record_valid; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_a2_public_record_valid BEFORE INSERT OR UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION public.assert_public_record_valid();


--
-- Name: job_vacancies trg_a2_public_record_valid; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_a2_public_record_valid BEFORE INSERT OR UPDATE ON public.job_vacancies FOR EACH ROW EXECUTE FUNCTION public.assert_public_record_valid();


--
-- Name: menu_items trg_a2_public_record_valid; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_a2_public_record_valid BEFORE INSERT OR UPDATE ON public.menu_items FOR EACH ROW EXECUTE FUNCTION public.assert_public_record_valid();


--
-- Name: news_posts trg_a2_public_record_valid; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_a2_public_record_valid BEFORE INSERT OR UPDATE ON public.news_posts FOR EACH ROW EXECUTE FUNCTION public.assert_public_record_valid();


--
-- Name: staff_notice_acknowledgements trg_ack_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ack_append_only BEFORE DELETE OR UPDATE ON public.staff_notice_acknowledgements FOR EACH ROW EXECUTE FUNCTION public.assert_ack_append_only();


--
-- Name: app_state trg_app_state_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_app_state_updated BEFORE UPDATE ON public.app_state FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: job_applications trg_application_transition_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_application_transition_guard BEFORE UPDATE ON public.job_applications FOR EACH ROW EXECUTE FUNCTION public.assert_application_transition_sanctioned();


--
-- Name: job_applications trg_applications_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_applications_updated BEFORE UPDATE ON public.job_applications FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: training_assessments trg_assessments_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_assessments_updated BEFORE UPDATE ON public.training_assessments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: quote_payment_attempts trg_attempt_identity_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_attempt_identity_immutable BEFORE UPDATE ON public.quote_payment_attempts FOR EACH ROW EXECUTE FUNCTION public.enforce_attempt_identity_immutable();


--
-- Name: audit_logs trg_audit_logs_stamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_audit_logs_stamp BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.audit_logs_stamp();


--
-- Name: training_certificates trg_cert_requires_pass; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cert_requires_pass BEFORE INSERT OR UPDATE OF employee_id, assessment_id ON public.training_certificates FOR EACH ROW EXECUTE FUNCTION public.cert_requires_pass();


--
-- Name: checklist_templates trg_checklists_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_checklists_updated BEFORE UPDATE ON public.checklist_templates FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: clock_history trg_clock_history_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_clock_history_updated BEFORE UPDATE ON public.clock_history FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: cms_pages trg_cms_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cms_updated BEFORE UPDATE ON public.cms_pages FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: training_courses trg_courses_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_courses_updated BEFORE UPDATE ON public.training_courses FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: customers trg_customers_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: deals trg_deals_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_deals_updated BEFORE UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: staff_documents trg_docs_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_docs_updated BEFORE UPDATE ON public.staff_documents FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: contact_messages trg_form_accept_gate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_form_accept_gate BEFORE INSERT ON public.contact_messages FOR EACH ROW EXECUTE FUNCTION public.assert_public_form_accept_allowed();


--
-- Name: franchise_inquiries trg_form_accept_gate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_form_accept_gate BEFORE INSERT ON public.franchise_inquiries FOR EACH ROW EXECUTE FUNCTION public.assert_public_form_accept_allowed();


--
-- Name: job_applications trg_form_accept_gate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_form_accept_gate BEFORE INSERT ON public.job_applications FOR EACH ROW EXECUTE FUNCTION public.assert_public_form_accept_allowed();


--
-- Name: franchise_inquiries trg_franchise_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_franchise_updated BEFORE UPDATE ON public.franchise_inquiries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: staff_profiles trg_guard_staff_profile_write; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guard_staff_profile_write BEFORE UPDATE ON public.staff_profiles FOR EACH ROW EXECUTE FUNCTION public.guard_staff_profile_write();


--
-- Name: ingredients trg_ingredients_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ingredients_updated BEFORE UPDATE ON public.ingredients FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: kb_articles trg_kb_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_kb_updated BEFORE UPDATE ON public.kb_articles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: launch_settings trg_launch_settings_never_empty; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER trg_launch_settings_never_empty AFTER INSERT OR DELETE OR UPDATE ON public.launch_settings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.launch_settings_never_empty();


--
-- Name: launch_settings trg_launch_settings_permanent; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_launch_settings_permanent BEFORE DELETE OR UPDATE ON public.launch_settings FOR EACH ROW EXECUTE FUNCTION public.launch_settings_is_permanent();


--
-- Name: launch_settings trg_launch_settings_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_launch_settings_transition BEFORE UPDATE ON public.launch_settings FOR EACH ROW EXECUTE FUNCTION public.assert_launch_settings_transition();


--
-- Name: menu_items trg_menu_items_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_menu_items_updated BEFORE UPDATE ON public.menu_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: menu_items trg_menu_publish_gate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_menu_publish_gate BEFORE INSERT OR UPDATE OF available ON public.menu_items FOR EACH ROW EXECUTE FUNCTION public.assert_menu_publish_allowed();


--
-- Name: menu_items trg_menu_tax_code_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_menu_tax_code_guard BEFORE INSERT OR UPDATE OF tax_code ON public.menu_items FOR EACH ROW EXECUTE FUNCTION public.enforce_menu_tax_code_guard();


--
-- Name: news_posts trg_news_slug_discipline; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_news_slug_discipline BEFORE INSERT OR UPDATE ON public.news_posts FOR EACH ROW EXECUTE FUNCTION public.assert_news_slug_discipline();


--
-- Name: news_posts trg_news_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_news_updated BEFORE UPDATE ON public.news_posts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: privacy_notice_versions trg_notice_immutability; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notice_immutability BEFORE DELETE OR UPDATE ON public.privacy_notice_versions FOR EACH ROW EXECUTE FUNCTION public.assert_notice_immutability();


--
-- Name: privacy_notice_versions trg_notice_stamp_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_notice_stamp_insert BEFORE INSERT ON public.privacy_notice_versions FOR EACH ROW EXECUTE FUNCTION public.stamp_notice_on_insert();


--
-- Name: order_item_modifiers trg_order_item_modifiers_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_order_item_modifiers_immutable BEFORE DELETE OR UPDATE ON public.order_item_modifiers FOR EACH ROW EXECUTE FUNCTION public.enforce_order_line_immutable();


--
-- Name: order_items trg_order_items_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_order_items_immutable BEFORE DELETE OR UPDATE ON public.order_items FOR EACH ROW EXECUTE FUNCTION public.enforce_order_line_immutable();


--
-- Name: orders trg_order_ledger_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_order_ledger_immutable BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.enforce_order_ledger_immutable();


--
-- Name: orders trg_order_ledger_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_order_ledger_no_delete BEFORE DELETE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.enforce_order_ledger_no_delete();


--
-- Name: orders trg_orders_explode; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_orders_explode AFTER INSERT OR UPDATE OF items ON public.orders FOR EACH ROW EXECUTE FUNCTION public.explode_order_items();


--
-- Name: orders trg_orders_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: payslips trg_payslips_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payslips_updated BEFORE UPDATE ON public.payslips FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: pos_shifts trg_pos_shift_seal; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pos_shift_seal BEFORE UPDATE ON public.pos_shifts FOR EACH ROW EXECUTE FUNCTION public.pos_shift_seal();


--
-- Name: deals trg_published_delete_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_published_delete_guard BEFORE DELETE ON public.deals FOR EACH ROW EXECUTE FUNCTION public.assert_published_delete_refused();


--
-- Name: job_vacancies trg_published_delete_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_published_delete_guard BEFORE DELETE ON public.job_vacancies FOR EACH ROW EXECUTE FUNCTION public.assert_published_delete_refused();


--
-- Name: menu_items trg_published_delete_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_published_delete_guard BEFORE DELETE ON public.menu_items FOR EACH ROW EXECUTE FUNCTION public.assert_published_delete_refused();


--
-- Name: news_posts trg_published_delete_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_published_delete_guard BEFORE DELETE ON public.news_posts FOR EACH ROW EXECUTE FUNCTION public.assert_published_delete_refused();


--
-- Name: order_quotes trg_quote_snapshot_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_quote_snapshot_immutable BEFORE UPDATE ON public.order_quotes FOR EACH ROW EXECUTE FUNCTION public.enforce_quote_snapshot_immutable();


--
-- Name: menu_item_recipes trg_recipe_change_control; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_recipe_change_control AFTER UPDATE ON public.menu_item_recipes FOR EACH ROW EXECUTE FUNCTION public.supersede_declarations_on_change();


--
-- Name: payment_reconciliations trg_reconciliation_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_reconciliation_immutable BEFORE DELETE OR UPDATE ON public.payment_reconciliations FOR EACH ROW EXECUTE FUNCTION public.enforce_reconciliation_immutable();


--
-- Name: work_shifts trg_shifts_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_shifts_updated BEFORE UPDATE ON public.work_shifts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: sifr_reports trg_sifr_reports_stamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sifr_reports_stamp BEFORE INSERT ON public.sifr_reports FOR EACH ROW EXECUTE FUNCTION public.sifr_reports_stamp();


--
-- Name: sifr_reports trg_sifr_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sifr_updated BEFORE UPDATE ON public.sifr_reports FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: launch_settings trg_singleton_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_singleton_guard BEFORE INSERT OR DELETE OR UPDATE ON public.launch_settings FOR EACH ROW EXECUTE FUNCTION public.assert_singleton_write_sanctioned();


--
-- Name: site_content trg_singleton_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_singleton_guard BEFORE INSERT OR DELETE OR UPDATE ON public.site_content FOR EACH ROW EXECUTE FUNCTION public.assert_singleton_write_sanctioned();


--
-- Name: site_settings trg_singleton_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_singleton_guard BEFORE INSERT OR DELETE OR UPDATE ON public.site_settings FOR EACH ROW EXECUTE FUNCTION public.assert_singleton_write_sanctioned();


--
-- Name: site_content trg_site_content_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_site_content_updated BEFORE UPDATE ON public.site_content FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: site_settings trg_site_settings_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_site_settings_updated BEFORE UPDATE ON public.site_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ingredient_specifications trg_spec_change_control; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_spec_change_control AFTER INSERT OR UPDATE ON public.ingredient_specifications FOR EACH ROW EXECUTE FUNCTION public.supersede_declarations_on_change();


--
-- Name: staff_profiles trg_staff_profiles_protect; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_staff_profiles_protect BEFORE UPDATE ON public.staff_profiles FOR EACH ROW EXECUTE FUNCTION public.staff_profiles_protect();


--
-- Name: staff_profiles trg_staff_self_update_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_staff_self_update_lock BEFORE UPDATE ON public.staff_profiles FOR EACH ROW EXECUTE FUNCTION public.enforce_staff_self_update_lock();


--
-- Name: staff_profiles trg_staff_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_staff_updated BEFORE UPDATE ON public.staff_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: storage_cleanup_jobs trg_storage_cleanup_jobs_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_storage_cleanup_jobs_updated BEFORE UPDATE ON public.storage_cleanup_jobs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: stores trg_store_open_gate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_store_open_gate BEFORE INSERT OR UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION public.assert_store_open_allowed();


--
-- Name: stores trg_stores_config_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_stores_config_guard BEFORE UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION public.enforce_store_config_guard();


--
-- Name: stores trg_stores_id_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_stores_id_immutable BEFORE UPDATE OF id ON public.stores FOR EACH ROW EXECUTE FUNCTION public.enforce_store_id_immutable();


--
-- Name: stores trg_stores_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_stores_updated BEFORE UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: tax_codes trg_tax_codes_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_tax_codes_updated BEFORE UPDATE ON public.tax_codes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: training_assignments trg_training_assignments_protect; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_training_assignments_protect BEFORE UPDATE ON public.training_assignments FOR EACH ROW EXECUTE FUNCTION public.training_assignments_protect();


--
-- Name: training_assignments trg_training_assignments_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_training_assignments_updated BEFORE UPDATE ON public.training_assignments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: training_certificates trg_training_certificates_protect; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_training_certificates_protect BEFORE UPDATE ON public.training_certificates FOR EACH ROW EXECUTE FUNCTION public.training_certificates_protect();


--
-- Name: training_certificates trg_training_certificates_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_training_certificates_updated BEFORE UPDATE ON public.training_certificates FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: training_progress trg_training_progress_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_training_progress_updated BEFORE UPDATE ON public.training_progress FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: job_vacancies trg_vacancies_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_vacancies_updated BEFORE UPDATE ON public.job_vacancies FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: cms_pages_public trg_view_read_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_view_read_only INSTEAD OF INSERT OR DELETE OR UPDATE ON public.cms_pages_public FOR EACH ROW EXECUTE FUNCTION public.refuse_public_view_write();


--
-- Name: deals_public trg_view_read_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_view_read_only INSTEAD OF INSERT OR DELETE OR UPDATE ON public.deals_public FOR EACH ROW EXECUTE FUNCTION public.refuse_public_view_write();


--
-- Name: job_vacancies_public trg_view_read_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_view_read_only INSTEAD OF INSERT OR DELETE OR UPDATE ON public.job_vacancies_public FOR EACH ROW EXECUTE FUNCTION public.refuse_public_view_write();


--
-- Name: media_assets_public trg_view_read_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_view_read_only INSTEAD OF INSERT OR DELETE OR UPDATE ON public.media_assets_public FOR EACH ROW EXECUTE FUNCTION public.refuse_public_view_write();


--
-- Name: menu_items_public trg_view_read_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_view_read_only INSTEAD OF INSERT OR DELETE OR UPDATE ON public.menu_items_public FOR EACH ROW EXECUTE FUNCTION public.refuse_public_view_write();


--
-- Name: news_posts_public trg_view_read_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_view_read_only INSTEAD OF INSERT OR DELETE OR UPDATE ON public.news_posts_public FOR EACH ROW EXECUTE FUNCTION public.refuse_public_view_write();


--
-- Name: stores_public trg_view_read_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_view_read_only INSTEAD OF INSERT OR DELETE OR UPDATE ON public.stores_public FOR EACH ROW EXECUTE FUNCTION public.refuse_public_view_write();


--
-- Name: checklist_templates trg_zz_collection_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zz_collection_revision AFTER INSERT OR DELETE OR UPDATE ON public.checklist_templates FOR EACH ROW EXECUTE FUNCTION public.bump_collection_revision();


--
-- Name: deals trg_zz_collection_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zz_collection_revision AFTER INSERT OR DELETE OR UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION public.bump_collection_revision();


--
-- Name: job_vacancies trg_zz_collection_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zz_collection_revision AFTER INSERT OR DELETE OR UPDATE ON public.job_vacancies FOR EACH ROW EXECUTE FUNCTION public.bump_collection_revision();


--
-- Name: kb_articles trg_zz_collection_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zz_collection_revision AFTER INSERT OR DELETE OR UPDATE ON public.kb_articles FOR EACH ROW EXECUTE FUNCTION public.bump_collection_revision();


--
-- Name: launch_settings trg_zz_collection_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zz_collection_revision AFTER INSERT OR DELETE OR UPDATE ON public.launch_settings FOR EACH ROW EXECUTE FUNCTION public.bump_collection_revision();


--
-- Name: media_assets trg_zz_collection_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zz_collection_revision AFTER INSERT OR DELETE OR UPDATE ON public.media_assets FOR EACH ROW EXECUTE FUNCTION public.bump_collection_revision();


--
-- Name: menu_items trg_zz_collection_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zz_collection_revision AFTER INSERT OR DELETE OR UPDATE ON public.menu_items FOR EACH ROW EXECUTE FUNCTION public.bump_collection_revision();


--
-- Name: news_posts trg_zz_collection_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zz_collection_revision AFTER INSERT OR DELETE OR UPDATE ON public.news_posts FOR EACH ROW EXECUTE FUNCTION public.bump_collection_revision();


--
-- Name: role_permissions trg_zz_collection_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zz_collection_revision AFTER INSERT OR DELETE OR UPDATE ON public.role_permissions FOR EACH ROW EXECUTE FUNCTION public.bump_collection_revision();


--
-- Name: site_content trg_zz_collection_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zz_collection_revision AFTER INSERT OR DELETE OR UPDATE ON public.site_content FOR EACH ROW EXECUTE FUNCTION public.bump_collection_revision();


--
-- Name: site_settings trg_zz_collection_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zz_collection_revision AFTER INSERT OR DELETE OR UPDATE ON public.site_settings FOR EACH ROW EXECUTE FUNCTION public.bump_collection_revision();


--
-- Name: stores trg_zz_collection_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zz_collection_revision AFTER INSERT OR DELETE OR UPDATE ON public.stores FOR EACH ROW EXECUTE FUNCTION public.bump_collection_revision();


--
-- Name: training_assessments trg_zz_collection_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zz_collection_revision AFTER INSERT OR DELETE OR UPDATE ON public.training_assessments FOR EACH ROW EXECUTE FUNCTION public.bump_collection_revision();


--
-- Name: training_assignments trg_zz_collection_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zz_collection_revision AFTER INSERT OR DELETE OR UPDATE ON public.training_assignments FOR EACH ROW EXECUTE FUNCTION public.bump_collection_revision();


--
-- Name: training_courses trg_zz_collection_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_zz_collection_revision AFTER INSERT OR DELETE OR UPDATE ON public.training_courses FOR EACH ROW EXECUTE FUNCTION public.bump_collection_revision();


--
-- Name: admin_recovery_intents admin_recovery_intents_target_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_recovery_intents
    ADD CONSTRAINT admin_recovery_intents_target_staff_id_fkey FOREIGN KEY (target_staff_id) REFERENCES public.staff_profiles(id) ON DELETE CASCADE;


--
-- Name: contact_messages contact_messages_notice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_messages
    ADD CONSTRAINT contact_messages_notice_id_fkey FOREIGN KEY (notice_id) REFERENCES public.privacy_notice_versions(id) ON DELETE RESTRICT;


--
-- Name: daily_closes daily_closes_approved_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_closes
    ADD CONSTRAINT daily_closes_approved_by_staff_id_fkey FOREIGN KEY (approved_by_staff_id) REFERENCES public.staff_profiles(id);


--
-- Name: daily_closes daily_closes_closed_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_closes
    ADD CONSTRAINT daily_closes_closed_by_staff_id_fkey FOREIGN KEY (closed_by_staff_id) REFERENCES public.staff_profiles(id);


--
-- Name: daily_closes daily_closes_corrects_close_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_closes
    ADD CONSTRAINT daily_closes_corrects_close_id_fkey FOREIGN KEY (corrects_close_id) REFERENCES public.daily_closes(id);


--
-- Name: app_state fk_app_state_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_state
    ADD CONSTRAINT fk_app_state_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: clock_history fk_clock_history_employee_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clock_history
    ADD CONSTRAINT fk_clock_history_employee_id FOREIGN KEY (employee_id) REFERENCES public.staff_profiles(id) ON DELETE RESTRICT;


--
-- Name: order_item_modifiers fk_order_item_modifiers_menu_item_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT fk_order_item_modifiers_menu_item_id FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id) ON DELETE SET NULL;


--
-- Name: order_items fk_order_items_menu_item_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT fk_order_items_menu_item_id FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id) ON DELETE SET NULL;


--
-- Name: orders fk_orders_staff_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT fk_orders_staff_id FOREIGN KEY (staff_id) REFERENCES public.staff_profiles(id) ON DELETE RESTRICT;


--
-- Name: orders fk_orders_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT fk_orders_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: payslips fk_payslips_employee_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT fk_payslips_employee_id FOREIGN KEY (employee_id) REFERENCES public.staff_profiles(id) ON DELETE RESTRICT;


--
-- Name: pos_approvals fk_pos_approvals_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_approvals
    ADD CONSTRAINT fk_pos_approvals_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: pos_audit_events fk_pos_audit_events_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_audit_events
    ADD CONSTRAINT fk_pos_audit_events_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: pos_cash_movements fk_pos_cash_movements_shift_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_cash_movements
    ADD CONSTRAINT fk_pos_cash_movements_shift_id FOREIGN KEY (shift_id) REFERENCES public.pos_shifts(id) ON DELETE RESTRICT;


--
-- Name: pos_cash_movements fk_pos_cash_movements_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_cash_movements
    ADD CONSTRAINT fk_pos_cash_movements_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: pos_corrections fk_pos_corrections_shift_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_corrections
    ADD CONSTRAINT fk_pos_corrections_shift_id FOREIGN KEY (shift_id) REFERENCES public.pos_shifts(id) ON DELETE RESTRICT;


--
-- Name: pos_corrections fk_pos_corrections_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_corrections
    ADD CONSTRAINT fk_pos_corrections_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: pos_devices fk_pos_devices_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_devices
    ADD CONSTRAINT fk_pos_devices_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: pos_orders fk_pos_orders_shift_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_orders
    ADD CONSTRAINT fk_pos_orders_shift_id FOREIGN KEY (shift_id) REFERENCES public.pos_shifts(id) ON DELETE RESTRICT;


--
-- Name: pos_orders fk_pos_orders_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_orders
    ADD CONSTRAINT fk_pos_orders_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: pos_pairing_codes fk_pos_pairing_codes_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_pairing_codes
    ADD CONSTRAINT fk_pos_pairing_codes_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: pos_refund_items fk_pos_refund_items_order_item_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_refund_items
    ADD CONSTRAINT fk_pos_refund_items_order_item_id FOREIGN KEY (order_item_id) REFERENCES public.pos_order_items(id) ON DELETE RESTRICT;


--
-- Name: pos_refunds fk_pos_refunds_shift_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_refunds
    ADD CONSTRAINT fk_pos_refunds_shift_id FOREIGN KEY (shift_id) REFERENCES public.pos_shifts(id) ON DELETE RESTRICT;


--
-- Name: pos_refunds fk_pos_refunds_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_refunds
    ADD CONSTRAINT fk_pos_refunds_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: pos_shifts fk_pos_shifts_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_shifts
    ADD CONSTRAINT fk_pos_shifts_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: pos_voids fk_pos_voids_shift_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_voids
    ADD CONSTRAINT fk_pos_voids_shift_id FOREIGN KEY (shift_id) REFERENCES public.pos_shifts(id) ON DELETE RESTRICT;


--
-- Name: pos_voids fk_pos_voids_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_voids
    ADD CONSTRAINT fk_pos_voids_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: sifr_reports fk_sifr_reports_reporter_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sifr_reports
    ADD CONSTRAINT fk_sifr_reports_reporter_id FOREIGN KEY (reporter_id) REFERENCES public.staff_profiles(id) ON DELETE RESTRICT;


--
-- Name: sifr_reports fk_sifr_reports_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sifr_reports
    ADD CONSTRAINT fk_sifr_reports_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: staff_documents fk_staff_documents_employee_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_documents
    ADD CONSTRAINT fk_staff_documents_employee_id FOREIGN KEY (employee_id) REFERENCES public.staff_profiles(id) ON DELETE RESTRICT;


--
-- Name: staff_documents fk_staff_documents_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_documents
    ADD CONSTRAINT fk_staff_documents_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: staff_profiles fk_staff_profiles_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_profiles
    ADD CONSTRAINT fk_staff_profiles_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: training_assignments fk_training_assignments_employee_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_assignments
    ADD CONSTRAINT fk_training_assignments_employee_id FOREIGN KEY (employee_id) REFERENCES public.staff_profiles(id) ON DELETE RESTRICT;


--
-- Name: training_certificates fk_training_certificates_employee_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_certificates
    ADD CONSTRAINT fk_training_certificates_employee_id FOREIGN KEY (employee_id) REFERENCES public.staff_profiles(id) ON DELETE RESTRICT;


--
-- Name: training_progress fk_training_progress_course_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_progress
    ADD CONSTRAINT fk_training_progress_course_id FOREIGN KEY (course_id) REFERENCES public.training_courses(id) ON DELETE RESTRICT;


--
-- Name: training_progress fk_training_progress_employee_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_progress
    ADD CONSTRAINT fk_training_progress_employee_id FOREIGN KEY (employee_id) REFERENCES public.staff_profiles(id) ON DELETE RESTRICT;


--
-- Name: training_results fk_training_results_assignment_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_results
    ADD CONSTRAINT fk_training_results_assignment_id FOREIGN KEY (assignment_id) REFERENCES public.training_assignments(id) ON DELETE RESTRICT;


--
-- Name: training_results fk_training_results_employee_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_results
    ADD CONSTRAINT fk_training_results_employee_id FOREIGN KEY (employee_id) REFERENCES public.staff_profiles(id) ON DELETE RESTRICT;


--
-- Name: work_shifts fk_work_shifts_employee_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_shifts
    ADD CONSTRAINT fk_work_shifts_employee_id FOREIGN KEY (employee_id) REFERENCES public.staff_profiles(id) ON DELETE RESTRICT;


--
-- Name: work_shifts fk_work_shifts_store_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.work_shifts
    ADD CONSTRAINT fk_work_shifts_store_id FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE RESTRICT;


--
-- Name: franchise_inquiries franchise_inquiries_notice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.franchise_inquiries
    ADD CONSTRAINT franchise_inquiries_notice_id_fkey FOREIGN KEY (notice_id) REFERENCES public.privacy_notice_versions(id) ON DELETE RESTRICT;


--
-- Name: ingredient_specifications ingredient_specifications_ingredient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_specifications
    ADD CONSTRAINT ingredient_specifications_ingredient_id_fkey FOREIGN KEY (ingredient_id) REFERENCES public.ingredients(id) ON DELETE CASCADE;


--
-- Name: ingredient_specifications ingredient_specifications_reviewed_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingredient_specifications
    ADD CONSTRAINT ingredient_specifications_reviewed_by_staff_id_fkey FOREIGN KEY (reviewed_by_staff_id) REFERENCES public.staff_profiles(id);


--
-- Name: job_applications job_applications_notice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_applications
    ADD CONSTRAINT job_applications_notice_id_fkey FOREIGN KEY (notice_id) REFERENCES public.privacy_notice_versions(id) ON DELETE RESTRICT;


--
-- Name: loyalty_transactions loyalty_transactions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_transactions
    ADD CONSTRAINT loyalty_transactions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: loyalty_transactions loyalty_transactions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loyalty_transactions
    ADD CONSTRAINT loyalty_transactions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: media_references media_references_media_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_references
    ADD CONSTRAINT media_references_media_object_id_fkey FOREIGN KEY (media_object_id) REFERENCES public.media_objects(id) ON DELETE RESTRICT;


--
-- Name: menu_item_recipes menu_item_recipes_approved_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_item_recipes
    ADD CONSTRAINT menu_item_recipes_approved_by_staff_id_fkey FOREIGN KEY (approved_by_staff_id) REFERENCES public.staff_profiles(id);


--
-- Name: menu_item_recipes menu_item_recipes_menu_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_item_recipes
    ADD CONSTRAINT menu_item_recipes_menu_item_id_fkey FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id) ON DELETE CASCADE;


--
-- Name: menu_items menu_items_tax_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menu_items
    ADD CONSTRAINT menu_items_tax_code_fkey FOREIGN KEY (tax_code) REFERENCES public.tax_codes(code);


--
-- Name: order_item_modifiers oim_tax_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT oim_tax_code_fkey FOREIGN KEY (tax_code) REFERENCES public.tax_codes(code);


--
-- Name: online_payment_accounts online_payment_accounts_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.online_payment_accounts
    ADD CONSTRAINT online_payment_accounts_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);


--
-- Name: order_item_modifiers order_item_modifiers_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT order_item_modifiers_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_item_modifiers order_item_modifiers_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_modifiers
    ADD CONSTRAINT order_item_modifiers_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.order_items(row_id) ON DELETE CASCADE;


--
-- Name: order_items order_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_tax_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_tax_code_fkey FOREIGN KEY (tax_code) REFERENCES public.tax_codes(code);


--
-- Name: order_quotes order_quotes_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_quotes
    ADD CONSTRAINT order_quotes_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);


--
-- Name: orders orders_quote_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_quote_fkey FOREIGN KEY (quote_id) REFERENCES public.order_quotes(id) ON DELETE RESTRICT;


--
-- Name: orders orders_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE SET NULL;


--
-- Name: orders orders_till_session_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_till_session_fkey FOREIGN KEY (till_session_id) REFERENCES public.web_till_sessions(id);


--
-- Name: payment_reconciliations payment_reconciliations_attempt_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_reconciliations
    ADD CONSTRAINT payment_reconciliations_attempt_reservation_id_fkey FOREIGN KEY (attempt_reservation_id) REFERENCES public.quote_payment_attempts(reservation_id);


--
-- Name: payment_reconciliations payment_reconciliations_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_reconciliations
    ADD CONSTRAINT payment_reconciliations_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);


--
-- Name: payment_reconciliations payment_reconciliations_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_reconciliations
    ADD CONSTRAINT payment_reconciliations_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);


--
-- Name: payment_terminals payment_terminals_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_terminals
    ADD CONSTRAINT payment_terminals_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);


--
-- Name: payroll_export_batches payroll_export_batches_exported_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_export_batches
    ADD CONSTRAINT payroll_export_batches_exported_by_staff_id_fkey FOREIGN KEY (exported_by_staff_id) REFERENCES public.staff_profiles(id);


--
-- Name: pos_approvals pos_approvals_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_approvals
    ADD CONSTRAINT pos_approvals_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.pos_devices(id);


--
-- Name: pos_audit_events pos_audit_events_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_audit_events
    ADD CONSTRAINT pos_audit_events_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.pos_devices(id);


--
-- Name: pos_audit_events pos_audit_events_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_audit_events
    ADD CONSTRAINT pos_audit_events_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.pos_events(event_id);


--
-- Name: pos_cash_movements pos_cash_movements_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_cash_movements
    ADD CONSTRAINT pos_cash_movements_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.pos_devices(id);


--
-- Name: pos_corrections pos_corrections_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_corrections
    ADD CONSTRAINT pos_corrections_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.pos_devices(id);


--
-- Name: pos_corrections pos_corrections_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_corrections
    ADD CONSTRAINT pos_corrections_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.pos_orders(id);


--
-- Name: pos_events pos_events_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_events
    ADD CONSTRAINT pos_events_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.pos_devices(id);


--
-- Name: pos_order_item_modifiers pos_order_item_modifiers_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_order_item_modifiers
    ADD CONSTRAINT pos_order_item_modifiers_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.pos_order_items(id);


--
-- Name: pos_order_items pos_order_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_order_items
    ADD CONSTRAINT pos_order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.pos_orders(id);


--
-- Name: pos_orders pos_orders_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_orders
    ADD CONSTRAINT pos_orders_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.pos_devices(id);


--
-- Name: pos_pairing_codes pos_pairing_codes_used_by_device_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_pairing_codes
    ADD CONSTRAINT pos_pairing_codes_used_by_device_fkey FOREIGN KEY (used_by_device) REFERENCES public.pos_devices(id);


--
-- Name: pos_refund_items pos_refund_items_refund_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_refund_items
    ADD CONSTRAINT pos_refund_items_refund_id_fkey FOREIGN KEY (refund_id) REFERENCES public.pos_refunds(id);


--
-- Name: pos_refunds pos_refunds_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_refunds
    ADD CONSTRAINT pos_refunds_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.pos_devices(id);


--
-- Name: pos_refunds pos_refunds_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_refunds
    ADD CONSTRAINT pos_refunds_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.pos_orders(id);


--
-- Name: pos_shifts pos_shifts_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_shifts
    ADD CONSTRAINT pos_shifts_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.pos_devices(id);


--
-- Name: pos_voids pos_voids_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_voids
    ADD CONSTRAINT pos_voids_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.pos_devices(id);


--
-- Name: pos_voids pos_voids_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pos_voids
    ADD CONSTRAINT pos_voids_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.pos_orders(id);


--
-- Name: product_allergen_declarations product_allergen_declarations_approved_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_allergen_declarations
    ADD CONSTRAINT product_allergen_declarations_approved_by_staff_id_fkey FOREIGN KEY (approved_by_staff_id) REFERENCES public.staff_profiles(id);


--
-- Name: product_allergen_declarations product_allergen_declarations_menu_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_allergen_declarations
    ADD CONSTRAINT product_allergen_declarations_menu_item_id_fkey FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id) ON DELETE CASCADE;


--
-- Name: product_allergen_declarations product_allergen_declarations_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_allergen_declarations
    ADD CONSTRAINT product_allergen_declarations_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.menu_item_recipes(id);


--
-- Name: quote_payment_attempts qpa_cash_session_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_payment_attempts
    ADD CONSTRAINT qpa_cash_session_fkey FOREIGN KEY (cash_session_id) REFERENCES public.web_till_sessions(id);


--
-- Name: quote_payment_attempts qpa_completed_order_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_payment_attempts
    ADD CONSTRAINT qpa_completed_order_fkey FOREIGN KEY (completed_order_id) REFERENCES public.orders(id);


--
-- Name: quote_payment_attempts qpa_device_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_payment_attempts
    ADD CONSTRAINT qpa_device_fkey FOREIGN KEY (device_id) REFERENCES public.web_till_devices(id);


--
-- Name: quote_payment_attempts qpa_online_account_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_payment_attempts
    ADD CONSTRAINT qpa_online_account_fkey FOREIGN KEY (online_account_id) REFERENCES public.online_payment_accounts(id);


--
-- Name: quote_payment_attempts qpa_store_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_payment_attempts
    ADD CONSTRAINT qpa_store_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);


--
-- Name: quote_payment_attempts qpa_terminal_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_payment_attempts
    ADD CONSTRAINT qpa_terminal_fkey FOREIGN KEY (terminal_config_id) REFERENCES public.payment_terminals(id);


--
-- Name: quote_payment_attempts quote_payment_attempts_quote_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quote_payment_attempts
    ADD CONSTRAINT quote_payment_attempts_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES public.order_quotes(id);


--
-- Name: staff_compliance_records staff_compliance_records_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_compliance_records
    ADD CONSTRAINT staff_compliance_records_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.staff_profiles(id) ON DELETE CASCADE;


--
-- Name: staff_compliance_records staff_compliance_records_revoked_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_compliance_records
    ADD CONSTRAINT staff_compliance_records_revoked_by_staff_id_fkey FOREIGN KEY (revoked_by_staff_id) REFERENCES public.staff_profiles(id);


--
-- Name: staff_compliance_records staff_compliance_records_supersedes_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_compliance_records
    ADD CONSTRAINT staff_compliance_records_supersedes_id_fkey FOREIGN KEY (supersedes_id) REFERENCES public.staff_compliance_records(id);


--
-- Name: staff_compliance_records staff_compliance_records_verified_by_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_compliance_records
    ADD CONSTRAINT staff_compliance_records_verified_by_staff_id_fkey FOREIGN KEY (verified_by_staff_id) REFERENCES public.staff_profiles(id);


--
-- Name: staff_notice_acknowledgements staff_notice_acknowledgements_notice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_notice_acknowledgements
    ADD CONSTRAINT staff_notice_acknowledgements_notice_id_fkey FOREIGN KEY (notice_id) REFERENCES public.privacy_notice_versions(id) ON DELETE RESTRICT;


--
-- Name: staff_notice_acknowledgements staff_notice_acknowledgements_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_notice_acknowledgements
    ADD CONSTRAINT staff_notice_acknowledgements_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff_profiles(id);


--
-- Name: stock_movements stock_movements_ingredient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_ingredient_id_fkey FOREIGN KEY (ingredient_id) REFERENCES public.ingredients(id) ON DELETE CASCADE;


--
-- Name: stock_movements stock_movements_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_movements
    ADD CONSTRAINT stock_movements_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id) ON DELETE SET NULL;


--
-- Name: web_till_devices web_till_devices_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_till_devices
    ADD CONSTRAINT web_till_devices_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);


--
-- Name: web_till_sessions web_till_sessions_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_till_sessions
    ADD CONSTRAINT web_till_sessions_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.web_till_devices(id);


--
-- Name: web_till_sessions web_till_sessions_store_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_till_sessions
    ADD CONSTRAINT web_till_sessions_store_id_fkey FOREIGN KEY (store_id) REFERENCES public.stores(id);


--
-- Name: activity_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

--
-- Name: activity_log activity_log_select_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activity_log_select_owner ON public.activity_log FOR SELECT TO authenticated USING (public.is_owner());


--
-- Name: activity_log activity_select_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activity_select_owner ON public.activity_log FOR SELECT TO authenticated USING (public.is_owner());


--
-- Name: admin_recovery_intents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_recovery_intents ENABLE ROW LEVEL SECURITY;

--
-- Name: allergen_catalogue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.allergen_catalogue ENABLE ROW LEVEL SECURITY;

--
-- Name: allergen_catalogue allergen_catalogue_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY allergen_catalogue_read ON public.allergen_catalogue FOR SELECT TO anon, authenticated USING (true);


--
-- Name: app_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_state ENABLE ROW LEVEL SECURITY;

--
-- Name: job_applications applications_select_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY applications_select_mgr ON public.job_applications FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_store_manager() AND (applied_store <> ''::text) AND (applied_store = ( SELECT s.name
   FROM public.stores s
  WHERE (s.id = public.current_staff_store()))))));


--
-- Name: job_applications applications_update_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY applications_update_mgr ON public.job_applications FOR UPDATE TO authenticated USING ((public.is_owner() OR (public.is_store_manager() AND (applied_store <> ''::text) AND (applied_store = ( SELECT s.name
   FROM public.stores s
  WHERE (s.id = public.current_staff_store())))))) WITH CHECK ((public.is_owner() OR (public.is_store_manager() AND (applied_store <> ''::text) AND (applied_store = ( SELECT s.name
   FROM public.stores s
  WHERE (s.id = public.current_staff_store()))))));


--
-- Name: app_state appstate_select_scope; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY appstate_select_scope ON public.app_state FOR SELECT TO authenticated USING ((public.is_owner() OR ((scope = 'user'::text) AND ((owner_staff_id = public.current_staff_id()) OR (public.is_manager_or_owner() AND (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = app_state.owner_staff_id) AND (sp.store_id = public.current_staff_store()))))))) OR ((scope = 'store'::text) AND (NOT (store_id IS DISTINCT FROM public.current_staff_store())) AND (public.current_staff_id() IS NOT NULL))));


--
-- Name: audit_logs audit_insert_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_insert_staff ON public.audit_logs FOR INSERT TO authenticated WITH CHECK ((public.current_staff_id() IS NOT NULL));


--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_logs audit_select_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_select_owner ON public.audit_logs FOR SELECT TO authenticated USING (public.is_owner());


--
-- Name: checklist_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.checklist_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: checklist_templates checklist_templates_read_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY checklist_templates_read_staff ON public.checklist_templates FOR SELECT TO authenticated USING ((public.current_staff_id() IS NOT NULL));


--
-- Name: checklist_templates checklist_templates_write_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY checklist_templates_write_mgr ON public.checklist_templates TO authenticated USING (public.is_manager_or_owner()) WITH CHECK (public.is_manager_or_owner());


--
-- Name: clock_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clock_history ENABLE ROW LEVEL SECURITY;

--
-- Name: clock_history clock_select_self_or_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clock_select_self_or_mgr ON public.clock_history FOR SELECT TO authenticated USING (((employee_id = public.current_staff_id()) OR public.is_owner() OR (public.is_manager_or_owner() AND (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = clock_history.employee_id) AND (sp.store_id = public.current_staff_store())))))));


--
-- Name: clock_history clock_update_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clock_update_mgr ON public.clock_history FOR UPDATE TO authenticated USING ((public.is_manager_or_owner() AND (public.is_owner() OR (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = clock_history.employee_id) AND (sp.store_id = public.current_staff_store()))))))) WITH CHECK ((public.is_manager_or_owner() AND (public.is_owner() OR (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = clock_history.employee_id) AND (sp.store_id = public.current_staff_store())))))));


--
-- Name: cms_pages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cms_pages ENABLE ROW LEVEL SECURITY;

--
-- Name: collection_revisions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.collection_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: collection_revisions collection_revisions_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY collection_revisions_read ON public.collection_revisions FOR SELECT TO authenticated USING (true);


--
-- Name: staff_compliance_records compliance_read_managed; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY compliance_read_managed ON public.staff_compliance_records FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_manager_or_owner() AND (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = staff_compliance_records.employee_id) AND (sp.store_id = public.current_staff_store())))))));


--
-- Name: staff_compliance_records compliance_read_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY compliance_read_own ON public.staff_compliance_records FOR SELECT TO authenticated USING ((employee_id = public.current_staff_id()));


--
-- Name: contact_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: contact_messages contact_select_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY contact_select_owner ON public.contact_messages FOR SELECT TO authenticated USING (public.is_owner());


--
-- Name: cms_pages content_read_auth; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_read_auth ON public.cms_pages FOR SELECT TO authenticated USING (true);


--
-- Name: deals content_read_auth; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_read_auth ON public.deals FOR SELECT TO authenticated USING (true);


--
-- Name: job_vacancies content_read_auth; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_read_auth ON public.job_vacancies FOR SELECT TO authenticated USING (true);


--
-- Name: media_assets content_read_auth; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_read_auth ON public.media_assets FOR SELECT TO authenticated USING (true);


--
-- Name: menu_items content_read_auth; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_read_auth ON public.menu_items FOR SELECT TO authenticated USING (true);


--
-- Name: news_posts content_read_auth; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_read_auth ON public.news_posts FOR SELECT TO authenticated USING (true);


--
-- Name: site_content content_read_auth; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_read_auth ON public.site_content FOR SELECT TO authenticated USING (true);


--
-- Name: site_settings content_read_auth; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_read_auth ON public.site_settings FOR SELECT TO authenticated USING (true);


--
-- Name: stores content_read_auth; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_read_auth ON public.stores FOR SELECT TO authenticated USING (true);


--
-- Name: cms_pages content_write_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_write_owner ON public.cms_pages TO authenticated USING (public.is_owner()) WITH CHECK (public.is_owner());


--
-- Name: deals content_write_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_write_owner ON public.deals TO authenticated USING (public.is_owner()) WITH CHECK (public.is_owner());


--
-- Name: job_vacancies content_write_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_write_owner ON public.job_vacancies TO authenticated USING (public.is_owner()) WITH CHECK (public.is_owner());


--
-- Name: media_assets content_write_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_write_owner ON public.media_assets TO authenticated USING (public.is_owner()) WITH CHECK (public.is_owner());


--
-- Name: news_posts content_write_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_write_owner ON public.news_posts TO authenticated USING (public.is_owner()) WITH CHECK (public.is_owner());


--
-- Name: site_content content_write_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_write_owner ON public.site_content TO authenticated USING (public.is_owner()) WITH CHECK (public.is_owner());


--
-- Name: site_settings content_write_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_write_owner ON public.site_settings TO authenticated USING (public.is_owner()) WITH CHECK (public.is_owner());


--
-- Name: stores content_write_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY content_write_owner ON public.stores TO authenticated USING (public.is_owner()) WITH CHECK (public.is_owner());


--
-- Name: customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

--
-- Name: cv_upload_ip_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cv_upload_ip_log ENABLE ROW LEVEL SECURITY;

--
-- Name: cv_upload_ip_log cv_upload_ip_log_select_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cv_upload_ip_log_select_owner ON public.cv_upload_ip_log FOR SELECT TO authenticated USING (public.is_owner());


--
-- Name: daily_closes daily_close_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY daily_close_insert ON public.daily_closes FOR INSERT TO authenticated WITH CHECK ((public.is_manager_or_owner() AND (public.is_owner() OR (store_id = public.current_staff_store())) AND (closed_by_staff_id = public.current_staff_id())));


--
-- Name: daily_closes daily_close_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY daily_close_read ON public.daily_closes FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_manager_or_owner() AND (store_id = public.current_staff_store()))));


--
-- Name: daily_closes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.daily_closes ENABLE ROW LEVEL SECURITY;

--
-- Name: deals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_documents docs_select_self_or_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY docs_select_self_or_mgr ON public.staff_documents FOR SELECT TO authenticated USING (((employee_id = public.current_staff_id()) OR public.is_owner() OR (public.is_manager_or_owner() AND (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = staff_documents.employee_id) AND (sp.store_id = public.current_staff_store())))))));


--
-- Name: staff_documents docs_update_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY docs_update_mgr ON public.staff_documents FOR UPDATE TO authenticated USING ((public.is_manager_or_owner() AND (public.is_owner() OR (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = staff_documents.employee_id) AND (sp.store_id = public.current_staff_store()))))))) WITH CHECK ((public.is_manager_or_owner() AND (public.is_owner() OR (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = staff_documents.employee_id) AND (sp.store_id = public.current_staff_store())))))));


--
-- Name: email_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;

--
-- Name: email_log email_log_select_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY email_log_select_owner ON public.email_log FOR SELECT TO authenticated USING (public.is_owner());


--
-- Name: form_submission_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.form_submission_log ENABLE ROW LEVEL SECURITY;

--
-- Name: form_submission_log form_submission_log_select_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY form_submission_log_select_owner ON public.form_submission_log FOR SELECT TO authenticated USING (public.is_owner());


--
-- Name: franchise_inquiries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.franchise_inquiries ENABLE ROW LEVEL SECURITY;

--
-- Name: franchise_inquiries franchise_select_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY franchise_select_owner ON public.franchise_inquiries FOR SELECT TO authenticated USING (public.is_owner());


--
-- Name: franchise_inquiries franchise_update_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY franchise_update_owner ON public.franchise_inquiries FOR UPDATE TO authenticated USING (public.is_owner()) WITH CHECK (public.is_owner());


--
-- Name: ops_heartbeats heartbeats_owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY heartbeats_owner_read ON public.ops_heartbeats FOR SELECT TO authenticated USING (public.is_owner());


--
-- Name: ingredient_specifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ingredient_specifications ENABLE ROW LEVEL SECURITY;

--
-- Name: ingredient_specifications ingredient_specs_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ingredient_specs_manage ON public.ingredient_specifications TO authenticated USING (public.is_manager_or_owner()) WITH CHECK (public.is_manager_or_owner());


--
-- Name: ingredient_specifications ingredient_specs_staff_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ingredient_specs_staff_read ON public.ingredient_specifications FOR SELECT TO authenticated USING ((public.current_staff_id() IS NOT NULL));


--
-- Name: ingredients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ingredients ENABLE ROW LEVEL SECURITY;

--
-- Name: job_applications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_applications ENABLE ROW LEVEL SECURITY;

--
-- Name: job_vacancies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_vacancies ENABLE ROW LEVEL SECURITY;

--
-- Name: kb_articles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kb_articles ENABLE ROW LEVEL SECURITY;

--
-- Name: kb_articles kb_articles_read_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kb_articles_read_staff ON public.kb_articles FOR SELECT TO authenticated USING ((public.current_staff_id() IS NOT NULL));


--
-- Name: kb_articles kb_articles_write_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kb_articles_write_mgr ON public.kb_articles TO authenticated USING (public.is_manager_or_owner()) WITH CHECK (public.is_manager_or_owner());


--
-- Name: launch_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.launch_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: launch_settings launch_settings_owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY launch_settings_owner_all ON public.launch_settings TO authenticated USING (public.is_owner()) WITH CHECK (public.is_owner());


--
-- Name: loyalty_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.loyalty_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: media_assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

--
-- Name: media_objects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_objects ENABLE ROW LEVEL SECURITY;

--
-- Name: media_objects media_objects_select_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY media_objects_select_staff ON public.media_objects FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_store_manager() AND (EXISTS ( SELECT 1
   FROM public.media_references mr
  WHERE ((mr.media_object_id = media_objects.id) AND (mr.entity_type = 'menu_item'::text)))))));


--
-- Name: media_references; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_references ENABLE ROW LEVEL SECURITY;

--
-- Name: media_references media_references_select_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY media_references_select_staff ON public.media_references FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_store_manager() AND (entity_type = 'menu_item'::text))));


--
-- Name: menu_item_recipes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.menu_item_recipes ENABLE ROW LEVEL SECURITY;

--
-- Name: menu_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;

--
-- Name: menu_items menu_write_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY menu_write_mgr ON public.menu_items TO authenticated USING (public.is_manager_or_owner()) WITH CHECK (public.is_manager_or_owner());


--
-- Name: news_posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.news_posts ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_outbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: online_payment_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.online_payment_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: online_payment_accounts online_payment_accounts_select_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY online_payment_accounts_select_mgr ON public.online_payment_accounts FOR SELECT TO authenticated USING ((public.is_manager_or_owner() AND (public.is_owner() OR (store_id = public.current_staff_store()))));


--
-- Name: ops_heartbeats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ops_heartbeats ENABLE ROW LEVEL SECURITY;

--
-- Name: order_item_modifiers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_item_modifiers ENABLE ROW LEVEL SECURITY;

--
-- Name: order_item_modifiers order_item_modifiers_select_store; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY order_item_modifiers_select_store ON public.order_item_modifiers FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = order_item_modifiers.order_id) AND (public.is_owner() OR (o.store_id = public.current_staff_store()))))));


--
-- Name: order_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

--
-- Name: order_items order_items_select_store; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY order_items_select_store ON public.order_items FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.orders o
  WHERE ((o.id = order_items.order_id) AND (public.is_owner() OR (o.store_id = public.current_staff_store()))))));


--
-- Name: order_quotes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_quotes ENABLE ROW LEVEL SECURITY;

--
-- Name: order_quotes order_quotes_select_store; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY order_quotes_select_store ON public.order_quotes FOR SELECT TO authenticated USING ((public.is_owner() OR (store_id = public.current_staff_store())));


--
-- Name: orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

--
-- Name: orders orders_select_store; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orders_select_store ON public.orders FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_store_manager() AND (store_id = public.current_staff_store())) OR (staff_id = public.current_staff_id())));


--
-- Name: notification_outbox outbox_owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY outbox_owner_read ON public.notification_outbox FOR SELECT TO authenticated USING (public.is_owner());


--
-- Name: product_allergen_declarations pad_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pad_manage ON public.product_allergen_declarations TO authenticated USING (public.is_manager_or_owner()) WITH CHECK (public.is_manager_or_owner());


--
-- Name: product_allergen_declarations pad_public_read_approved; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pad_public_read_approved ON public.product_allergen_declarations FOR SELECT TO anon, authenticated USING ((state = 'approved'::text));


--
-- Name: product_allergen_declarations pad_staff_read_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pad_staff_read_all ON public.product_allergen_declarations FOR SELECT TO authenticated USING ((public.current_staff_id() IS NOT NULL));


--
-- Name: payment_reconciliations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_reconciliations ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_reconciliations payment_reconciliations_select_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payment_reconciliations_select_mgr ON public.payment_reconciliations FOR SELECT TO authenticated USING ((public.is_manager_or_owner() AND (public.is_owner() OR (store_id = public.current_staff_store()))));


--
-- Name: payment_terminals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_terminals ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_terminals payment_terminals_select_store; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payment_terminals_select_store ON public.payment_terminals FOR SELECT TO authenticated USING ((public.is_owner() OR (store_id = public.current_staff_store())));


--
-- Name: payroll_export_batches payroll_batches_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payroll_batches_owner ON public.payroll_export_batches TO authenticated USING (public.is_owner()) WITH CHECK (public.is_owner());


--
-- Name: payroll_export_batches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payroll_export_batches ENABLE ROW LEVEL SECURITY;

--
-- Name: payslips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payslips ENABLE ROW LEVEL SECURITY;

--
-- Name: payslips payslips_select_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payslips_select_self ON public.payslips FOR SELECT TO authenticated USING (((employee_id = public.current_staff_id()) OR public.is_owner()));


--
-- Name: payslips payslips_write_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payslips_write_owner ON public.payslips TO authenticated USING (public.is_owner()) WITH CHECK (public.is_owner());


--
-- Name: pos_approvals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_approvals ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_audit_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_audit_events ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_cash_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_cash_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_catalog; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_catalog ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_corrections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_corrections ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_devices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_devices ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_devices pos_devices_read_scoped; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_devices_read_scoped ON public.pos_devices FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_manager_or_owner() AND (store_id = public.current_staff_store()))));


--
-- Name: pos_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_events ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_order_item_modifiers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_order_item_modifiers ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_order_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_order_items ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_pair_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_pair_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_pairing_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_pairing_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_approvals pos_read_scoped; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_read_scoped ON public.pos_approvals FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_manager_or_owner() AND (store_id = public.current_staff_store()))));


--
-- Name: pos_audit_events pos_read_scoped; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_read_scoped ON public.pos_audit_events FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_manager_or_owner() AND (store_id = public.current_staff_store()))));


--
-- Name: pos_cash_movements pos_read_scoped; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_read_scoped ON public.pos_cash_movements FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_manager_or_owner() AND (store_id = public.current_staff_store()))));


--
-- Name: pos_corrections pos_read_scoped; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_read_scoped ON public.pos_corrections FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_manager_or_owner() AND (store_id = public.current_staff_store()))));


--
-- Name: pos_events pos_read_scoped; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_read_scoped ON public.pos_events FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_manager_or_owner() AND (EXISTS ( SELECT 1
   FROM public.pos_devices d
  WHERE ((d.id = pos_events.device_id) AND (d.store_id = public.current_staff_store())))))));


--
-- Name: pos_order_item_modifiers pos_read_scoped; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_read_scoped ON public.pos_order_item_modifiers FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.pos_order_items i
     JOIN public.pos_orders o ON ((o.id = i.order_id)))
  WHERE ((i.id = pos_order_item_modifiers.order_item_id) AND (public.is_owner() OR (public.is_manager_or_owner() AND (o.store_id = public.current_staff_store())))))));


--
-- Name: pos_order_items pos_read_scoped; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_read_scoped ON public.pos_order_items FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.pos_orders o
  WHERE ((o.id = pos_order_items.order_id) AND (public.is_owner() OR (public.is_manager_or_owner() AND (o.store_id = public.current_staff_store())))))));


--
-- Name: pos_orders pos_read_scoped; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_read_scoped ON public.pos_orders FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_manager_or_owner() AND (store_id = public.current_staff_store()))));


--
-- Name: pos_refund_items pos_read_scoped; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_read_scoped ON public.pos_refund_items FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.pos_refunds r
  WHERE ((r.id = pos_refund_items.refund_id) AND (public.is_owner() OR (public.is_manager_or_owner() AND (r.store_id = public.current_staff_store())))))));


--
-- Name: pos_refunds pos_read_scoped; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_read_scoped ON public.pos_refunds FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_manager_or_owner() AND (store_id = public.current_staff_store()))));


--
-- Name: pos_shifts pos_read_scoped; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_read_scoped ON public.pos_shifts FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_manager_or_owner() AND (store_id = public.current_staff_store()))));


--
-- Name: pos_voids pos_read_scoped; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pos_read_scoped ON public.pos_voids FOR SELECT TO authenticated USING ((public.is_owner() OR (public.is_manager_or_owner() AND (store_id = public.current_staff_store()))));


--
-- Name: pos_refund_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_refund_items ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_refunds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_refunds ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_shifts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_shifts ENABLE ROW LEVEL SECURITY;

--
-- Name: pos_voids; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pos_voids ENABLE ROW LEVEL SECURITY;

--
-- Name: privacy_notice_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.privacy_notice_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: privacy_notice_versions privacy_owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY privacy_owner_all ON public.privacy_notice_versions TO authenticated USING (public.is_owner()) WITH CHECK (public.is_owner());


--
-- Name: privacy_notice_versions privacy_staff_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY privacy_staff_read ON public.privacy_notice_versions FOR SELECT TO authenticated USING ((published_at IS NOT NULL));


--
-- Name: product_allergen_declarations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.product_allergen_declarations ENABLE ROW LEVEL SECURITY;

--
-- Name: cms_pages public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read ON public.cms_pages FOR SELECT TO anon, authenticated USING (true);


--
-- Name: deals public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read ON public.deals FOR SELECT TO anon, authenticated USING (true);


--
-- Name: job_vacancies public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read ON public.job_vacancies FOR SELECT TO anon, authenticated USING (true);


--
-- Name: media_assets public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read ON public.media_assets FOR SELECT TO anon, authenticated USING (true);


--
-- Name: menu_items public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read ON public.menu_items FOR SELECT TO anon, authenticated USING (true);


--
-- Name: news_posts public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read ON public.news_posts FOR SELECT TO anon, authenticated USING (true);


--
-- Name: site_content public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read ON public.site_content FOR SELECT TO anon, authenticated USING (true);


--
-- Name: site_settings public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read ON public.site_settings FOR SELECT TO anon, authenticated USING (true);


--
-- Name: stores public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read ON public.stores FOR SELECT TO anon, authenticated USING (true);


--
-- Name: quote_payment_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quote_payment_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: quote_payment_attempts quote_payment_attempts_select_scoped; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY quote_payment_attempts_select_scoped ON public.quote_payment_attempts FOR SELECT TO authenticated USING (((public.is_owner() OR (store_id = public.current_staff_store())) AND (public.is_manager_or_owner() OR (operator_staff_id = public.current_staff_id()))));


--
-- Name: menu_item_recipes recipes_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recipes_manage ON public.menu_item_recipes TO authenticated USING (public.is_manager_or_owner()) WITH CHECK (public.is_manager_or_owner());


--
-- Name: menu_item_recipes recipes_staff_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recipes_staff_read ON public.menu_item_recipes FOR SELECT TO authenticated USING ((public.current_staff_id() IS NOT NULL));


--
-- Name: admin_recovery_intents recovery_intents_owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY recovery_intents_owner_read ON public.admin_recovery_intents FOR SELECT TO authenticated USING (public.is_owner());


--
-- Name: retention_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.retention_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: role_permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: role_permissions roleperms_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY roleperms_owner ON public.role_permissions TO authenticated USING (public.is_owner()) WITH CHECK (public.is_owner());


--
-- Name: work_shifts shifts_select_store; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shifts_select_store ON public.work_shifts FOR SELECT TO authenticated USING ((public.is_owner() OR (store_id = public.current_staff_store())));


--
-- Name: work_shifts shifts_write_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY shifts_write_mgr ON public.work_shifts TO authenticated USING ((public.is_manager_or_owner() AND (public.is_owner() OR (store_id = public.current_staff_store())))) WITH CHECK ((public.is_manager_or_owner() AND (public.is_owner() OR (store_id = public.current_staff_store()))));


--
-- Name: sifr_reports sifr_insert_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sifr_insert_staff ON public.sifr_reports FOR INSERT TO authenticated WITH CHECK (((public.current_staff_id() IS NOT NULL) AND (reporter_id = public.current_staff_id())));


--
-- Name: sifr_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sifr_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: sifr_reports sifr_select_self_or_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sifr_select_self_or_mgr ON public.sifr_reports FOR SELECT TO authenticated USING (((reporter_id = public.current_staff_id()) OR public.is_owner() OR (public.is_manager_or_owner() AND (public.sifr_report_store(sifr_reports.*) = public.current_staff_store()))));


--
-- Name: sifr_reports sifr_update_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sifr_update_mgr ON public.sifr_reports FOR UPDATE TO authenticated USING ((public.is_owner() OR (public.is_manager_or_owner() AND (public.sifr_report_store(sifr_reports.*) = public.current_staff_store())))) WITH CHECK ((public.is_owner() OR (public.is_manager_or_owner() AND (public.sifr_report_store(sifr_reports.*) = public.current_staff_store()))));


--
-- Name: site_content; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.site_content ENABLE ROW LEVEL SECURITY;

--
-- Name: site_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_notice_acknowledgements sna_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sna_read ON public.staff_notice_acknowledgements FOR SELECT TO authenticated USING (((staff_id = public.current_staff_id()) OR public.is_owner()));


--
-- Name: staff_notice_acknowledgements sna_self_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sna_self_insert ON public.staff_notice_acknowledgements FOR INSERT TO authenticated WITH CHECK ((staff_id = public.current_staff_id()));


--
-- Name: staff_compliance_records; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_compliance_records ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_notice_acknowledgements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_notice_acknowledgements ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staff_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_profiles staff_profiles_select_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY staff_profiles_select_self ON public.staff_profiles FOR SELECT TO authenticated USING ((auth_id = auth.uid()));


--
-- Name: staff_profiles staff_profiles_select_store; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY staff_profiles_select_store ON public.staff_profiles FOR SELECT TO authenticated USING ((public.is_manager_or_owner() AND (public.is_owner() OR (store_id = public.current_staff_store()))));


--
-- Name: staff_profiles staff_profiles_update_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY staff_profiles_update_mgr ON public.staff_profiles FOR UPDATE TO authenticated USING ((public.is_store_manager() AND (NOT (store_id IS DISTINCT FROM public.current_staff_store())) AND (role <> 'owner'::public.employee_role) AND (id <> public.current_staff_id()))) WITH CHECK ((public.is_store_manager() AND (NOT (store_id IS DISTINCT FROM public.current_staff_store())) AND (role <> 'owner'::public.employee_role) AND (id <> public.current_staff_id())));


--
-- Name: staff_profiles staff_profiles_update_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY staff_profiles_update_self ON public.staff_profiles FOR UPDATE TO authenticated USING ((auth_id = auth.uid())) WITH CHECK (((auth_id = auth.uid()) AND (role = public.current_staff_role()) AND (NOT (store_id IS DISTINCT FROM public.current_staff_store()))));


--
-- Name: staff_profiles staff_profiles_write_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY staff_profiles_write_owner ON public.staff_profiles TO authenticated USING (public.is_owner()) WITH CHECK (public.is_owner());


--
-- Name: stock_movements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;

--
-- Name: storage_cleanup_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.storage_cleanup_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: stores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;

--
-- Name: training_assignments tassign_delete_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tassign_delete_mgr ON public.training_assignments FOR DELETE TO authenticated USING ((public.is_owner() OR (public.is_store_manager() AND (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = training_assignments.employee_id) AND (sp.store_id = public.current_staff_store())))))));


--
-- Name: training_assignments tassign_insert_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tassign_insert_mgr ON public.training_assignments FOR INSERT TO authenticated WITH CHECK ((public.is_owner() OR (public.is_store_manager() AND (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = training_assignments.employee_id) AND (sp.store_id = public.current_staff_store())))))));


--
-- Name: training_assignments tassign_select_self_or_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tassign_select_self_or_mgr ON public.training_assignments FOR SELECT TO authenticated USING (((employee_id = public.current_staff_id()) OR public.is_owner() OR (public.is_store_manager() AND (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = training_assignments.employee_id) AND (sp.store_id = public.current_staff_store())))))));


--
-- Name: training_assignments tassign_update_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tassign_update_mgr ON public.training_assignments FOR UPDATE TO authenticated USING ((public.is_owner() OR (public.is_store_manager() AND (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = training_assignments.employee_id) AND (sp.store_id = public.current_staff_store()))))))) WITH CHECK ((public.is_owner() OR (public.is_store_manager() AND (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = training_assignments.employee_id) AND (sp.store_id = public.current_staff_store())))))));


--
-- Name: training_assignments tassign_update_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tassign_update_self ON public.training_assignments FOR UPDATE TO authenticated USING ((employee_id = public.current_staff_id())) WITH CHECK ((employee_id = public.current_staff_id()));


--
-- Name: tax_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tax_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: tax_codes tax_codes_read_authed; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tax_codes_read_authed ON public.tax_codes FOR SELECT TO authenticated USING (true);


--
-- Name: training_certificates tcert_delete_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tcert_delete_owner ON public.training_certificates FOR DELETE TO authenticated USING (public.is_owner());


--
-- Name: training_certificates tcert_insert_self_or_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tcert_insert_self_or_mgr ON public.training_certificates FOR INSERT TO authenticated WITH CHECK (((employee_id = public.current_staff_id()) OR public.is_manager_or_owner()));


--
-- Name: training_certificates tcert_select_self_or_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tcert_select_self_or_mgr ON public.training_certificates FOR SELECT TO authenticated USING (((employee_id = public.current_staff_id()) OR public.is_owner() OR (public.is_store_manager() AND (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = training_certificates.employee_id) AND (sp.store_id = public.current_staff_store())))))));


--
-- Name: training_certificates tcert_update_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tcert_update_mgr ON public.training_certificates FOR UPDATE TO authenticated USING ((public.is_owner() OR (public.is_store_manager() AND (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = training_certificates.employee_id) AND (sp.store_id = public.current_staff_store()))))))) WITH CHECK ((public.is_owner() OR (public.is_store_manager() AND (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = training_certificates.employee_id) AND (sp.store_id = public.current_staff_store())))))));


--
-- Name: training_certificates tcert_update_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tcert_update_self ON public.training_certificates FOR UPDATE TO authenticated USING ((employee_id = public.current_staff_id())) WITH CHECK ((employee_id = public.current_staff_id()));


--
-- Name: training_certificates tcert_update_self_emailed; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tcert_update_self_emailed ON public.training_certificates FOR UPDATE TO authenticated USING (((employee_id = public.current_staff_id()) OR public.is_manager_or_owner())) WITH CHECK (((employee_id = public.current_staff_id()) OR public.is_manager_or_owner()));


--
-- Name: training_progress tprog_select_self_or_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tprog_select_self_or_mgr ON public.training_progress FOR SELECT TO authenticated USING (((employee_id = public.current_staff_id()) OR public.is_owner() OR (public.is_store_manager() AND (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = training_progress.employee_id) AND (sp.store_id = public.current_staff_store())))))));


--
-- Name: training_progress tprog_update_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tprog_update_self ON public.training_progress FOR UPDATE TO authenticated USING ((employee_id = public.current_staff_id())) WITH CHECK (((employee_id = public.current_staff_id()) AND (id = ((public.current_staff_id() || ':'::text) || course_id))));


--
-- Name: training_progress tprog_upsert_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tprog_upsert_self ON public.training_progress FOR INSERT TO authenticated WITH CHECK (((employee_id = public.current_staff_id()) AND (id = ((public.current_staff_id() || ':'::text) || course_id))));


--
-- Name: training_assessments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.training_assessments ENABLE ROW LEVEL SECURITY;

--
-- Name: training_assessments training_assessments_read_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY training_assessments_read_mgr ON public.training_assessments FOR SELECT TO authenticated USING (public.is_manager_or_owner());


--
-- Name: training_assessments training_assessments_write_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY training_assessments_write_mgr ON public.training_assessments TO authenticated USING (public.is_manager_or_owner()) WITH CHECK (public.is_manager_or_owner());


--
-- Name: training_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.training_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: training_certificates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.training_certificates ENABLE ROW LEVEL SECURITY;

--
-- Name: training_courses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.training_courses ENABLE ROW LEVEL SECURITY;

--
-- Name: training_courses training_courses_read_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY training_courses_read_staff ON public.training_courses FOR SELECT TO authenticated USING ((public.current_staff_id() IS NOT NULL));


--
-- Name: training_courses training_courses_write_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY training_courses_write_mgr ON public.training_courses TO authenticated USING (public.is_manager_or_owner()) WITH CHECK (public.is_manager_or_owner());


--
-- Name: training_progress; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.training_progress ENABLE ROW LEVEL SECURITY;

--
-- Name: training_results; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.training_results ENABLE ROW LEVEL SECURITY;

--
-- Name: training_results tres_select_self_or_mgr; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tres_select_self_or_mgr ON public.training_results FOR SELECT TO authenticated USING (((employee_id = public.current_staff_id()) OR public.is_owner() OR (public.is_store_manager() AND (EXISTS ( SELECT 1
   FROM public.staff_profiles sp
  WHERE ((sp.id = training_results.employee_id) AND (sp.store_id = public.current_staff_store())))))));


--
-- Name: web_till_devices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.web_till_devices ENABLE ROW LEVEL SECURITY;

--
-- Name: web_till_devices web_till_devices_select_store; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY web_till_devices_select_store ON public.web_till_devices FOR SELECT TO authenticated USING ((public.is_owner() OR (store_id = public.current_staff_store())));


--
-- Name: web_till_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.web_till_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: web_till_sessions web_till_sessions_select_scoped; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY web_till_sessions_select_scoped ON public.web_till_sessions FOR SELECT TO authenticated USING (((public.is_owner() OR (store_id = public.current_staff_store())) AND (public.is_manager_or_owner() OR (opened_by_staff_id = public.current_staff_id()))));


--
-- Name: work_shifts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.work_shifts ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;


--
-- Name: FUNCTION allergen_declaration_approve(p_declaration_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.allergen_declaration_approve(p_declaration_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.allergen_declaration_approve(p_declaration_id text) TO authenticated;


--
-- Name: FUNCTION apply_collection_changes(p_table text, p_upserts jsonb, p_delete_ids text[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_collection_changes(p_table text, p_upserts jsonb, p_delete_ids text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_collection_changes(p_table text, p_upserts jsonb, p_delete_ids text[]) TO authenticated;


--
-- Name: FUNCTION assert_ack_append_only(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_ack_append_only() FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_ack_append_only() TO authenticated;


--
-- Name: FUNCTION assert_application_transition_sanctioned(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_application_transition_sanctioned() FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_application_transition_sanctioned() TO authenticated;


--
-- Name: FUNCTION assert_full_collection_snapshot(p_table text, p_rows jsonb, p_expected_total integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_full_collection_snapshot(p_table text, p_rows jsonb, p_expected_total integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_full_collection_snapshot(p_table text, p_rows jsonb, p_expected_total integer) TO authenticated;


--
-- Name: FUNCTION assert_launch_ready(p_context text, p_error text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_launch_ready(p_context text, p_error text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_launch_ready(p_context text, p_error text) TO authenticated;


--
-- Name: TABLE launch_settings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.launch_settings TO authenticated;


--
-- Name: FUNCTION assert_launch_ready(p_context text, p_error text, p_candidate public.launch_settings); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_launch_ready(p_context text, p_error text, p_candidate public.launch_settings) FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_launch_ready(p_context text, p_error text, p_candidate public.launch_settings) TO authenticated;


--
-- Name: FUNCTION assert_launch_settings_transition(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_launch_settings_transition() FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_launch_settings_transition() TO authenticated;


--
-- Name: FUNCTION assert_lifecycle_change_sanctioned(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_lifecycle_change_sanctioned() FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_lifecycle_change_sanctioned() TO authenticated;


--
-- Name: FUNCTION assert_menu_publish_allowed(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_menu_publish_allowed() FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_menu_publish_allowed() TO authenticated;


--
-- Name: FUNCTION assert_news_slug_discipline(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_news_slug_discipline() FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_news_slug_discipline() TO authenticated;


--
-- Name: FUNCTION assert_notice_immutability(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_notice_immutability() FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_notice_immutability() TO authenticated;


--
-- Name: FUNCTION assert_public_form_accept_allowed(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_public_form_accept_allowed() FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_public_form_accept_allowed() TO authenticated;


--
-- Name: FUNCTION assert_public_record_valid(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_public_record_valid() FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_public_record_valid() TO authenticated;


--
-- Name: FUNCTION assert_published_delete_refused(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_published_delete_refused() FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_published_delete_refused() TO authenticated;


--
-- Name: FUNCTION assert_singleton_write_sanctioned(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_singleton_write_sanctioned() FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_singleton_write_sanctioned() TO authenticated;


--
-- Name: FUNCTION assert_store_open_allowed(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.assert_store_open_allowed() FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_store_open_allowed() TO authenticated;


--
-- Name: FUNCTION audit_logs_stamp(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.audit_logs_stamp() FROM PUBLIC;
GRANT ALL ON FUNCTION public.audit_logs_stamp() TO authenticated;


--
-- Name: FUNCTION begin_quote_payment(p_payment jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.begin_quote_payment(p_payment jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.begin_quote_payment(p_payment jsonb) TO authenticated;


--
-- Name: TABLE staff_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT,DELETE,UPDATE ON TABLE public.staff_profiles TO authenticated;


--
-- Name: COLUMN staff_profiles.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.staff_profiles TO authenticated;


--
-- Name: COLUMN staff_profiles.name; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(name) ON TABLE public.staff_profiles TO authenticated;


--
-- Name: COLUMN staff_profiles.role; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(role) ON TABLE public.staff_profiles TO authenticated;


--
-- Name: COLUMN staff_profiles.store_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(store_id) ON TABLE public.staff_profiles TO authenticated;


--
-- Name: COLUMN staff_profiles.store_name; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(store_name) ON TABLE public.staff_profiles TO authenticated;


--
-- Name: FUNCTION bootstrap_owner(target_email text, target_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bootstrap_owner(target_email text, target_name text) FROM PUBLIC;


--
-- Name: FUNCTION bump_collection_revision(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bump_collection_revision() FROM PUBLIC;


--
-- Name: FUNCTION cancel_order_quote(p_quote jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cancel_order_quote(p_quote jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cancel_order_quote(p_quote jsonb) TO authenticated;


--
-- Name: FUNCTION canonical_request_hash(p jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.canonical_request_hash(p jsonb) FROM PUBLIC;


--
-- Name: FUNCTION cert_requires_pass(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cert_requires_pass() FROM PUBLIC;
GRANT ALL ON FUNCTION public.cert_requires_pass() TO authenticated;


--
-- Name: TABLE media_objects; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.media_objects TO authenticated;


--
-- Name: FUNCTION claim_media_cleanup_batch(p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_media_cleanup_batch(p_limit integer) FROM PUBLIC;


--
-- Name: FUNCTION claim_recovery_intent(p_intent_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_recovery_intent(p_intent_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_recovery_intent(p_intent_id text) TO authenticated;


--
-- Name: FUNCTION claim_shift(p_shift_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_shift(p_shift_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_shift(p_shift_id text) TO authenticated;


--
-- Name: TABLE storage_cleanup_jobs; Type: ACL; Schema: public; Owner: -
--



--
-- Name: FUNCTION claim_storage_cleanup_batch(p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_storage_cleanup_batch(p_limit integer) FROM PUBLIC;


--
-- Name: FUNCTION classify_products(p jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.classify_products(p jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.classify_products(p jsonb) TO authenticated;


--
-- Name: FUNCTION close_till_session(p_session jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.close_till_session(p_session jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.close_till_session(p_session jsonb) TO authenticated;


--
-- Name: FUNCTION close_vacancy(p_id text, p_expected_revision bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.close_vacancy(p_id text, p_expected_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.close_vacancy(p_id text, p_expected_revision bigint) TO authenticated;


--
-- Name: FUNCTION collection_revision_checkpoint(p_table text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.collection_revision_checkpoint(p_table text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.collection_revision_checkpoint(p_table text) TO authenticated;


--
-- Name: FUNCTION complete_training(p_assessment_id text, p_score integer, p_submission_id text, p_assignment_id text, p_answers jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.complete_training(p_assessment_id text, p_score integer, p_submission_id text, p_assignment_id text, p_answers jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.complete_training(p_assessment_id text, p_score integer, p_submission_id text, p_assignment_id text, p_answers jsonb) TO authenticated;


--
-- Name: TABLE staff_compliance_records; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.staff_compliance_records TO authenticated;


--
-- Name: FUNCTION compliance_effective_status(rec public.staff_compliance_records); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.compliance_effective_status(rec public.staff_compliance_records) FROM PUBLIC;
GRANT ALL ON FUNCTION public.compliance_effective_status(rec public.staff_compliance_records) TO authenticated;


--
-- Name: FUNCTION compliance_record_revoke(p_record_id text, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.compliance_record_revoke(p_record_id text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.compliance_record_revoke(p_record_id text, p_reason text) TO authenticated;


--
-- Name: FUNCTION compliance_record_upsert(p_employee_id text, p_type text, p_issued date, p_expires date, p_document_id text, p_notes text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.compliance_record_upsert(p_employee_id text, p_type text, p_issued date, p_expires date, p_document_id text, p_notes text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.compliance_record_upsert(p_employee_id text, p_type text, p_issued date, p_expires date, p_document_id text, p_notes text) TO authenticated;


--
-- Name: FUNCTION compliance_record_verify(p_record_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.compliance_record_verify(p_record_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.compliance_record_verify(p_record_id text) TO authenticated;


--
-- Name: FUNCTION configure_store_setup(p_config jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.configure_store_setup(p_config jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.configure_store_setup(p_config jsonb) TO authenticated;


--
-- Name: FUNCTION create_order_quote(p_quote jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_order_quote(p_quote jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_order_quote(p_quote jsonb) TO authenticated;


--
-- Name: FUNCTION create_pos_pairing_code(p_store_id text, p_store_name text, p_device_label text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_pos_pairing_code(p_store_id text, p_store_name text, p_device_label text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_pos_pairing_code(p_store_id text, p_store_name text, p_device_label text) TO authenticated;


--
-- Name: FUNCTION current_privacy_version(p_audience text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.current_privacy_version(p_audience text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.current_privacy_version(p_audience text) TO authenticated;


--
-- Name: FUNCTION current_staff_id(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.current_staff_id() FROM PUBLIC;
GRANT ALL ON FUNCTION public.current_staff_id() TO authenticated;


--
-- Name: FUNCTION current_staff_role(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.current_staff_role() FROM PUBLIC;
GRANT ALL ON FUNCTION public.current_staff_role() TO authenticated;


--
-- Name: FUNCTION current_staff_store(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.current_staff_store() FROM PUBLIC;
GRANT ALL ON FUNCTION public.current_staff_store() TO authenticated;


--
-- Name: FUNCTION employment_sweep_due(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.employment_sweep_due() FROM PUBLIC;


--
-- Name: FUNCTION end_employment(p_employee_id text, p_end_date date, p_reason text, p_notes text, p_immediate boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.end_employment(p_employee_id text, p_end_date date, p_reason text, p_notes text, p_immediate boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.end_employment(p_employee_id text, p_end_date date, p_reason text, p_notes text, p_immediate boolean) TO authenticated;


--
-- Name: FUNCTION enforce_attempt_identity_immutable(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_attempt_identity_immutable() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_attempt_identity_immutable() TO authenticated;


--
-- Name: FUNCTION enforce_menu_tax_code_guard(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_menu_tax_code_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_menu_tax_code_guard() TO authenticated;


--
-- Name: FUNCTION enforce_order_ledger_immutable(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_order_ledger_immutable() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_order_ledger_immutable() TO authenticated;


--
-- Name: FUNCTION enforce_order_ledger_no_delete(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_order_ledger_no_delete() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_order_ledger_no_delete() TO authenticated;


--
-- Name: FUNCTION enforce_order_line_immutable(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_order_line_immutable() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_order_line_immutable() TO authenticated;


--
-- Name: FUNCTION enforce_quote_snapshot_immutable(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_quote_snapshot_immutable() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_quote_snapshot_immutable() TO authenticated;


--
-- Name: FUNCTION enforce_reconciliation_immutable(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_reconciliation_immutable() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_reconciliation_immutable() TO authenticated;


--
-- Name: FUNCTION enforce_staff_self_update_lock(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_staff_self_update_lock() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_staff_self_update_lock() TO authenticated;


--
-- Name: FUNCTION enforce_store_config_guard(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_store_config_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_store_config_guard() TO authenticated;


--
-- Name: FUNCTION enforce_store_id_immutable(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_store_id_immutable() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_store_id_immutable() TO authenticated;


--
-- Name: FUNCTION enrol_till_device(p_device jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enrol_till_device(p_device jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.enrol_till_device(p_device jsonb) TO authenticated;


--
-- Name: FUNCTION expire_stale_quotes(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.expire_stale_quotes() FROM PUBLIC;
GRANT ALL ON FUNCTION public.expire_stale_quotes() TO authenticated;


--
-- Name: FUNCTION explode_order_items(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.explode_order_items() FROM PUBLIC;


--
-- Name: FUNCTION finalise_media_reference(p_object_id uuid, p_entity_type text, p_entity_id text, p_field_path text, p_actor text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalise_media_reference(p_object_id uuid, p_entity_type text, p_entity_id text, p_field_path text, p_actor text) FROM PUBLIC;


--
-- Name: FUNCTION finalise_order_payment(p_payment jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalise_order_payment(p_payment jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finalise_order_payment(p_payment jsonb) TO authenticated;


--
-- Name: FUNCTION finalise_order_payment_core(p_payment jsonb, p_recovery boolean, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finalise_order_payment_core(p_payment jsonb, p_recovery boolean, p_reason text) FROM PUBLIC;


--
-- Name: FUNCTION get_my_staff_profile(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_my_staff_profile() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_my_staff_profile() TO authenticated;


--
-- Name: FUNCTION get_staff_assessments(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_staff_assessments() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_staff_assessments() TO authenticated;


--
-- Name: FUNCTION get_staff_directory(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_staff_directory() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_staff_directory() TO authenticated;


--
-- Name: FUNCTION grade_training_answers(p_questions jsonb, p_answers jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.grade_training_answers(p_questions jsonb, p_answers jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.grade_training_answers(p_questions jsonb, p_answers jsonb) TO authenticated;


--
-- Name: FUNCTION guard_staff_profile_write(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.guard_staff_profile_write() FROM PUBLIC;
GRANT ALL ON FUNCTION public.guard_staff_profile_write() TO authenticated;


--
-- Name: FUNCTION is_aal2(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_aal2() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_aal2() TO authenticated;


--
-- Name: FUNCTION is_manager_or_owner(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_manager_or_owner() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_manager_or_owner() TO authenticated;


--
-- Name: FUNCTION is_owner(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_owner() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_owner() TO authenticated;


--
-- Name: FUNCTION is_store_manager(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_store_manager() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_store_manager() TO authenticated;


--
-- Name: FUNCTION jwt_aal(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.jwt_aal() FROM PUBLIC;
GRANT ALL ON FUNCTION public.jwt_aal() TO authenticated;


--
-- Name: FUNCTION launch_blocking_reasons(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.launch_blocking_reasons() FROM PUBLIC;


--
-- Name: FUNCTION launch_blocking_reasons(p public.launch_settings); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.launch_blocking_reasons(p public.launch_settings) FROM PUBLIC;


--
-- Name: FUNCTION launch_readiness(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.launch_readiness() FROM PUBLIC;
GRANT ALL ON FUNCTION public.launch_readiness() TO authenticated;


--
-- Name: FUNCTION launch_settings_is_permanent(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.launch_settings_is_permanent() FROM PUBLIC;
GRANT ALL ON FUNCTION public.launch_settings_is_permanent() TO authenticated;


--
-- Name: FUNCTION launch_settings_never_empty(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.launch_settings_never_empty() FROM PUBLIC;
GRANT ALL ON FUNCTION public.launch_settings_never_empty() TO authenticated;


--
-- Name: FUNCTION link_staff_profile(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.link_staff_profile() FROM PUBLIC;
GRANT ALL ON FUNCTION public.link_staff_profile() TO authenticated;


--
-- Name: FUNCTION log_payment_authority_event(p_action text, p_payload jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.log_payment_authority_event(p_action text, p_payload jsonb) FROM PUBLIC;


--
-- Name: FUNCTION mark_media_cleanup_candidates(p_grace_hours integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.mark_media_cleanup_candidates(p_grace_hours integer) FROM PUBLIC;


--
-- Name: FUNCTION media_path_is_referenced(p_storage_path text, p_public_url text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.media_path_is_referenced(p_storage_path text, p_public_url text) FROM PUBLIC;


--
-- Name: FUNCTION news_slugify(p_input text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.news_slugify(p_input text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.news_slugify(p_input text) TO authenticated;


--
-- Name: FUNCTION open_till_session(p_session jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.open_till_session(p_session jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.open_till_session(p_session jsonb) TO authenticated;


--
-- Name: FUNCTION ops_health(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ops_health() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ops_health() TO authenticated;


--
-- Name: TABLE notification_outbox; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notification_outbox TO authenticated;


--
-- Name: FUNCTION outbox_claim_batch(p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.outbox_claim_batch(p_limit integer) FROM PUBLIC;


--
-- Name: FUNCTION outbox_mark(p_id text, p_outcome text, p_provider_id text, p_code text, p_message text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.outbox_mark(p_id text, p_outcome text, p_provider_id text, p_code text, p_message text) FROM PUBLIC;


--
-- Name: FUNCTION outbox_recent(p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.outbox_recent(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.outbox_recent(p_limit integer) TO authenticated;


--
-- Name: FUNCTION outbox_retry_now(p_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.outbox_retry_now(p_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.outbox_retry_now(p_id text) TO authenticated;


--
-- Name: FUNCTION owner_staff_pay(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.owner_staff_pay() FROM PUBLIC;
GRANT ALL ON FUNCTION public.owner_staff_pay() TO authenticated;


--
-- Name: FUNCTION pos_apply_approval(p_device_id uuid, p_store_id text, p jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pos_apply_approval(p_device_id uuid, p_store_id text, p jsonb) FROM PUBLIC;


--
-- Name: FUNCTION pos_authenticate_device(p_token_hash text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pos_authenticate_device(p_token_hash text) FROM PUBLIC;


--
-- Name: FUNCTION pos_catalog_current(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pos_catalog_current() FROM PUBLIC;


--
-- Name: FUNCTION pos_catalog_version(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pos_catalog_version() FROM PUBLIC;
GRANT ALL ON FUNCTION public.pos_catalog_version() TO authenticated;


--
-- Name: FUNCTION pos_complete_pairing(p_code_hash text, p_installation_id text, p_device jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pos_complete_pairing(p_code_hash text, p_installation_id text, p_device jsonb) FROM PUBLIC;


--
-- Name: FUNCTION pos_ingest_batch(p_device_id uuid, p_events jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pos_ingest_batch(p_device_id uuid, p_events jsonb) FROM PUBLIC;


--
-- Name: FUNCTION pos_payload_has_forbidden_key(p jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pos_payload_has_forbidden_key(p jsonb) FROM PUBLIC;


--
-- Name: FUNCTION pos_pence(p jsonb, p_path text[], p_required boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pos_pence(p jsonb, p_path text[], p_required boolean) FROM PUBLIC;


--
-- Name: FUNCTION pos_random_code(p_length integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pos_random_code(p_length integer) FROM PUBLIC;


--
-- Name: FUNCTION pos_shift_seal(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pos_shift_seal() FROM PUBLIC;
GRANT ALL ON FUNCTION public.pos_shift_seal() TO authenticated;


--
-- Name: FUNCTION pos_text(p jsonb, p_path text[], p_field text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pos_text(p jsonb, p_path text[], p_field text) FROM PUBLIC;


--
-- Name: FUNCTION pos_ts(p jsonb, p_path text[], p_field text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.pos_ts(p jsonb, p_path text[], p_field text) FROM PUBLIC;


--
-- Name: FUNCTION valid_payment_methods(p jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.valid_payment_methods(p jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.valid_payment_methods(p jsonb) TO authenticated;


--
-- Name: TABLE stores; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.stores TO authenticated;


--
-- Name: FUNCTION price_basket_internal(p_store public.stores, p_items jsonb, p_deals jsonb, p_charging boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.price_basket_internal(p_store public.stores, p_items jsonb, p_deals jsonb, p_charging boolean) FROM PUBLIC;


--
-- Name: FUNCTION publication_candidate_errors(p_table text, p_candidate jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.publication_candidate_errors(p_table text, p_candidate jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.publication_candidate_errors(p_table text, p_candidate jsonb) TO authenticated;


--
-- Name: FUNCTION publication_completeness_errors(p_table text, p_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.publication_completeness_errors(p_table text, p_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.publication_completeness_errors(p_table text, p_id text) TO authenticated;


--
-- Name: FUNCTION publish_pos_catalog(p_snapshot jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.publish_pos_catalog(p_snapshot jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.publish_pos_catalog(p_snapshot jsonb) TO authenticated;


--
-- Name: FUNCTION publish_record(p_table text, p_id text, p_publish boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.publish_record(p_table text, p_id text, p_publish boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.publish_record(p_table text, p_id text, p_publish boolean) TO authenticated;


--
-- Name: FUNCTION purge_employee(p_employee_id text, p_typed_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.purge_employee(p_employee_id text, p_typed_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.purge_employee(p_employee_id text, p_typed_name text) TO authenticated;


--
-- Name: FUNCTION purge_expired_cvs(retain interval); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.purge_expired_cvs(retain interval) FROM PUBLIC;


--
-- Name: FUNCTION reconcile_card_payment(p_settlement jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reconcile_card_payment(p_settlement jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reconcile_card_payment(p_settlement jsonb) TO authenticated;


--
-- Name: FUNCTION record_heartbeat(p_job text, p_status text, p_detail text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_heartbeat(p_job text, p_status text, p_detail text) FROM PUBLIC;


--
-- Name: FUNCTION record_media_cleanup_result(p_id uuid, p_ok boolean, p_error text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_media_cleanup_result(p_id uuid, p_ok boolean, p_error text) FROM PUBLIC;


--
-- Name: FUNCTION record_storage_cleanup_result(p_id uuid, p_ok boolean, p_error text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_storage_cleanup_result(p_id uuid, p_ok boolean, p_error text) FROM PUBLIC;


--
-- Name: FUNCTION recovery_action_permitted(p_target text, p_action text, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.recovery_action_permitted(p_target text, p_action text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.recovery_action_permitted(p_target text, p_action text, p_reason text) TO authenticated;


--
-- Name: FUNCTION redact_assessment_row(p jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.redact_assessment_row(p jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.redact_assessment_row(p jsonb) TO authenticated;


--
-- Name: FUNCTION refuse_public_view_write(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.refuse_public_view_write() FROM PUBLIC;
GRANT ALL ON FUNCTION public.refuse_public_view_write() TO authenticated;


--
-- Name: FUNCTION release_quote_payment(p_release jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_quote_payment(p_release jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_quote_payment(p_release jsonb) TO authenticated;


--
-- Name: FUNCTION replace_collection(p_table text, p_rows jsonb, p_expected_total integer, p_expected_revision bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.replace_collection(p_table text, p_rows jsonb, p_expected_total integer, p_expected_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.replace_collection(p_table text, p_rows jsonb, p_expected_total integer, p_expected_revision bigint) TO authenticated;


--
-- Name: FUNCTION request_recovery_action(p_action text, p_target text, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.request_recovery_action(p_action text, p_target text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_recovery_action(p_action text, p_target text, p_reason text) TO authenticated;


--
-- Name: FUNCTION resolve_payment_reconciliation(p_resolution jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.resolve_payment_reconciliation(p_resolution jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.resolve_payment_reconciliation(p_resolution jsonb) TO authenticated;


--
-- Name: FUNCTION resolve_public_submission(p_kind text, p_idempotency_key uuid, p_request_hash text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.resolve_public_submission(p_kind text, p_idempotency_key uuid, p_request_hash text) FROM PUBLIC;


--
-- Name: FUNCTION retention_enqueue_orphan_cvs(grace interval); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.retention_enqueue_orphan_cvs(grace interval) FROM PUBLIC;


--
-- Name: FUNCTION retention_purge_contact_messages(retain interval); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.retention_purge_contact_messages(retain interval) FROM PUBLIC;


--
-- Name: FUNCTION retention_purge_franchise_inquiries(retain interval); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.retention_purge_franchise_inquiries(retain interval) FROM PUBLIC;


--
-- Name: FUNCTION retention_purge_job_applications(retain interval); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.retention_purge_job_applications(retain interval) FROM PUBLIC;


--
-- Name: FUNCTION revoke_pos_device(p_device_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.revoke_pos_device(p_device_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.revoke_pos_device(p_device_id uuid) TO authenticated;


--
-- Name: FUNCTION reward_grant_active(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reward_grant_active() FROM PUBLIC;
GRANT ALL ON FUNCTION public.reward_grant_active() TO authenticated;


--
-- Name: FUNCTION rotate_pos_device_token(p_device_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rotate_pos_device_token(p_device_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rotate_pos_device_token(p_device_id uuid) TO authenticated;


--
-- Name: FUNCTION run_retention_sweep(p_contact_retain interval, p_franchise_retain interval, p_applications_retain interval, p_orphan_grace interval); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.run_retention_sweep(p_contact_retain interval, p_franchise_retain interval, p_applications_retain interval, p_orphan_grace interval) FROM PUBLIC;


--
-- Name: FUNCTION save_launch_settings(p_patch jsonb, p_expected_revision bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.save_launch_settings(p_patch jsonb, p_expected_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.save_launch_settings(p_patch jsonb, p_expected_revision bigint) TO authenticated;


--
-- Name: FUNCTION save_website_studio(p_site_settings jsonb, p_site_content jsonb, p_expected_settings_revision bigint, p_expected_content_revision bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.save_website_studio(p_site_settings jsonb, p_site_content jsonb, p_expected_settings_revision bigint, p_expected_content_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.save_website_studio(p_site_settings jsonb, p_site_content jsonb, p_expected_settings_revision bigint, p_expected_content_revision bigint) TO authenticated;


--
-- Name: FUNCTION set_app_state(p_key text, p_value jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_app_state(p_key text, p_value jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_app_state(p_key text, p_value jsonb) TO authenticated;


--
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_updated_at() TO authenticated;


--
-- Name: TABLE sifr_reports; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sifr_reports TO authenticated;


--
-- Name: FUNCTION sifr_report_store(r public.sifr_reports); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sifr_report_store(r public.sifr_reports) FROM PUBLIC;
GRANT ALL ON FUNCTION public.sifr_report_store(r public.sifr_reports) TO authenticated;


--
-- Name: FUNCTION sifr_reports_stamp(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.sifr_reports_stamp() FROM PUBLIC;
GRANT ALL ON FUNCTION public.sifr_reports_stamp() TO authenticated;


--
-- Name: FUNCTION singleton_apply_payload(p_table text, p_payload jsonb, p_updated_by text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.singleton_apply_payload(p_table text, p_payload jsonb, p_updated_by text) FROM PUBLIC;


--
-- Name: FUNCTION staff_clock_action(p_action text, p_notes text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.staff_clock_action(p_action text, p_notes text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_clock_action(p_action text, p_notes text) TO authenticated;


--
-- Name: FUNCTION staff_compliance_overview(p_employee_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.staff_compliance_overview(p_employee_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_compliance_overview(p_employee_id text) TO authenticated;


--
-- Name: FUNCTION staff_profiles_protect(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.staff_profiles_protect() FROM PUBLIC;
GRANT ALL ON FUNCTION public.staff_profiles_protect() TO authenticated;


--
-- Name: FUNCTION stamp_notice_on_insert(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.stamp_notice_on_insert() FROM PUBLIC;
GRANT ALL ON FUNCTION public.stamp_notice_on_insert() TO authenticated;


--
-- Name: FUNCTION store_config_fingerprint(p_store public.stores); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.store_config_fingerprint(p_store public.stores) FROM PUBLIC;


--
-- Name: FUNCTION store_trading_state(p_store_id text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.store_trading_state(p_store_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.store_trading_state(p_store_id text) TO authenticated;


--
-- Name: FUNCTION submit_public_form(p_kind text, p_row jsonb, p_idempotency_key uuid, p_request_hash text, p_ip_hash text, p_notice_id text, p_notice_sha256 text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.submit_public_form(p_kind text, p_row jsonb, p_idempotency_key uuid, p_request_hash text, p_ip_hash text, p_notice_id text, p_notice_sha256 text) FROM PUBLIC;


--
-- Name: FUNCTION submit_public_form_core(p_kind text, p_row jsonb, p_idempotency_key uuid, p_request_hash text, p_ip_hash text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.submit_public_form_core(p_kind text, p_row jsonb, p_idempotency_key uuid, p_request_hash text, p_ip_hash text) FROM PUBLIC;


--
-- Name: FUNCTION supersede_declarations_on_change(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.supersede_declarations_on_change() FROM PUBLIC;
GRANT ALL ON FUNCTION public.supersede_declarations_on_change() TO authenticated;


--
-- Name: FUNCTION training_assignments_protect(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.training_assignments_protect() FROM PUBLIC;
GRANT ALL ON FUNCTION public.training_assignments_protect() TO authenticated;


--
-- Name: FUNCTION training_certificates_protect(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.training_certificates_protect() FROM PUBLIC;
GRANT ALL ON FUNCTION public.training_certificates_protect() TO authenticated;


--
-- Name: FUNCTION transition_application(p_id text, p_from_status text, p_to_status text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.transition_application(p_id text, p_from_status text, p_to_status text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.transition_application(p_id text, p_from_status text, p_to_status text) TO authenticated;


--
-- Name: TABLE activity_log; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.activity_log TO authenticated;


--
-- Name: TABLE admin_recovery_intents; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.admin_recovery_intents TO authenticated;


--
-- Name: TABLE allergen_catalogue; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.allergen_catalogue TO authenticated;
GRANT SELECT ON TABLE public.allergen_catalogue TO anon;


--
-- Name: TABLE app_state; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.app_state TO authenticated;


--
-- Name: TABLE audit_logs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.audit_logs TO authenticated;


--
-- Name: TABLE checklist_templates; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.checklist_templates TO authenticated;


--
-- Name: TABLE clock_history; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.clock_history TO authenticated;


--
-- Name: TABLE cms_pages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cms_pages TO authenticated;


--
-- Name: TABLE cms_pages_public; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.cms_pages_public TO authenticated;


--
-- Name: TABLE collection_revisions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.collection_revisions TO authenticated;


--
-- Name: TABLE contact_messages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,DELETE,UPDATE ON TABLE public.contact_messages TO authenticated;


--
-- Name: TABLE customers; Type: ACL; Schema: public; Owner: -
--



--
-- Name: TABLE cv_upload_ip_log; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.cv_upload_ip_log TO authenticated;


--
-- Name: TABLE daily_closes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.daily_closes TO authenticated;


--
-- Name: TABLE orders; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.orders TO authenticated;


--
-- Name: TABLE daily_sales; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.daily_sales TO authenticated;


--
-- Name: TABLE deals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.deals TO authenticated;


--
-- Name: TABLE deals_public; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.deals_public TO authenticated;
GRANT SELECT ON TABLE public.deals_public TO anon;


--
-- Name: TABLE email_log; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.email_log TO authenticated;


--
-- Name: TABLE form_submission_log; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.form_submission_log TO authenticated;


--
-- Name: TABLE franchise_inquiries; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,DELETE,UPDATE ON TABLE public.franchise_inquiries TO authenticated;


--
-- Name: COLUMN franchise_inquiries.status; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(status) ON TABLE public.franchise_inquiries TO authenticated;


--
-- Name: TABLE ingredient_specifications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ingredient_specifications TO authenticated;


--
-- Name: TABLE ingredients; Type: ACL; Schema: public; Owner: -
--



--
-- Name: TABLE job_applications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,DELETE,UPDATE ON TABLE public.job_applications TO authenticated;


--
-- Name: COLUMN job_applications.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.job_applications TO authenticated;


--
-- Name: COLUMN job_applications.full_name; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(full_name) ON TABLE public.job_applications TO authenticated;


--
-- Name: COLUMN job_applications.email; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(email) ON TABLE public.job_applications TO authenticated;


--
-- Name: COLUMN job_applications.phone; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(phone) ON TABLE public.job_applications TO authenticated;


--
-- Name: COLUMN job_applications.applied_for; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(applied_for) ON TABLE public.job_applications TO authenticated;


--
-- Name: COLUMN job_applications.applied_store; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(applied_store) ON TABLE public.job_applications TO authenticated;


--
-- Name: COLUMN job_applications.availability; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(availability) ON TABLE public.job_applications TO authenticated;


--
-- Name: COLUMN job_applications.experience; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(experience) ON TABLE public.job_applications TO authenticated;


--
-- Name: COLUMN job_applications.message; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(message) ON TABLE public.job_applications TO authenticated;


--
-- Name: COLUMN job_applications.status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(status),UPDATE(status) ON TABLE public.job_applications TO authenticated;


--
-- Name: COLUMN job_applications.applied_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(applied_at) ON TABLE public.job_applications TO authenticated;


--
-- Name: COLUMN job_applications.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(created_at) ON TABLE public.job_applications TO authenticated;


--
-- Name: COLUMN job_applications.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(updated_at) ON TABLE public.job_applications TO authenticated;


--
-- Name: COLUMN job_applications.cv_present; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(cv_present) ON TABLE public.job_applications TO authenticated;


--
-- Name: TABLE job_vacancies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.job_vacancies TO authenticated;


--
-- Name: TABLE job_vacancies_public; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.job_vacancies_public TO authenticated;
GRANT SELECT ON TABLE public.job_vacancies_public TO anon;


--
-- Name: TABLE kb_articles; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.kb_articles TO authenticated;


--
-- Name: TABLE loyalty_transactions; Type: ACL; Schema: public; Owner: -
--



--
-- Name: TABLE media_assets; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.media_assets TO authenticated;


--
-- Name: TABLE media_assets_public; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.media_assets_public TO authenticated;


--
-- Name: TABLE media_references; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.media_references TO authenticated;


--
-- Name: TABLE menu_item_recipes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.menu_item_recipes TO authenticated;


--
-- Name: TABLE menu_items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.menu_items TO authenticated;


--
-- Name: TABLE menu_items_public; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.menu_items_public TO authenticated;
GRANT SELECT ON TABLE public.menu_items_public TO anon;


--
-- Name: TABLE news_posts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.news_posts TO authenticated;


--
-- Name: TABLE news_posts_public; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.news_posts_public TO authenticated;
GRANT SELECT ON TABLE public.news_posts_public TO anon;


--
-- Name: TABLE online_payment_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.online_payment_accounts TO authenticated;


--
-- Name: TABLE ops_heartbeats; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ops_heartbeats TO authenticated;


--
-- Name: TABLE order_item_modifiers; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.order_item_modifiers TO authenticated;


--
-- Name: TABLE order_items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.order_items TO authenticated;


--
-- Name: TABLE order_quotes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.order_quotes TO authenticated;


--
-- Name: TABLE payment_reconciliations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.payment_reconciliations TO authenticated;


--
-- Name: TABLE payment_terminals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.payment_terminals TO authenticated;


--
-- Name: TABLE payroll_export_batches; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payroll_export_batches TO authenticated;


--
-- Name: TABLE payslips; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.payslips TO authenticated;


--
-- Name: TABLE popular_modifiers; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.popular_modifiers TO authenticated;


--
-- Name: TABLE pos_approvals; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.pos_approvals TO authenticated;


--
-- Name: TABLE pos_audit_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.pos_audit_events TO authenticated;


--
-- Name: TABLE pos_cash_movements; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.pos_cash_movements TO authenticated;


--
-- Name: TABLE pos_catalog; Type: ACL; Schema: public; Owner: -
--



--
-- Name: TABLE pos_corrections; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.pos_corrections TO authenticated;


--
-- Name: TABLE pos_devices; Type: ACL; Schema: public; Owner: -
--



--
-- Name: COLUMN pos_devices.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.pos_devices TO authenticated;


--
-- Name: COLUMN pos_devices.store_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(store_id) ON TABLE public.pos_devices TO authenticated;


--
-- Name: COLUMN pos_devices.store_name; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(store_name) ON TABLE public.pos_devices TO authenticated;


--
-- Name: COLUMN pos_devices.installation_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(installation_id) ON TABLE public.pos_devices TO authenticated;


--
-- Name: COLUMN pos_devices.device_name; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(device_name) ON TABLE public.pos_devices TO authenticated;


--
-- Name: COLUMN pos_devices.device_code; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(device_code) ON TABLE public.pos_devices TO authenticated;


--
-- Name: COLUMN pos_devices.store_code; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(store_code) ON TABLE public.pos_devices TO authenticated;


--
-- Name: COLUMN pos_devices.app_version; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(app_version) ON TABLE public.pos_devices TO authenticated;


--
-- Name: COLUMN pos_devices.schema_version; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(schema_version) ON TABLE public.pos_devices TO authenticated;


--
-- Name: COLUMN pos_devices.revoked; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(revoked) ON TABLE public.pos_devices TO authenticated;


--
-- Name: COLUMN pos_devices.paired_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(paired_at) ON TABLE public.pos_devices TO authenticated;


--
-- Name: COLUMN pos_devices.last_seen_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(last_seen_at) ON TABLE public.pos_devices TO authenticated;


--
-- Name: COLUMN pos_devices.last_sync_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(last_sync_at) ON TABLE public.pos_devices TO authenticated;


--
-- Name: TABLE pos_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.pos_events TO authenticated;


--
-- Name: TABLE pos_order_item_modifiers; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.pos_order_item_modifiers TO authenticated;


--
-- Name: TABLE pos_order_items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.pos_order_items TO authenticated;


--
-- Name: TABLE pos_orders; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.pos_orders TO authenticated;


--
-- Name: TABLE pos_pair_attempts; Type: ACL; Schema: public; Owner: -
--



--
-- Name: TABLE pos_pairing_codes; Type: ACL; Schema: public; Owner: -
--



--
-- Name: TABLE pos_refund_items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.pos_refund_items TO authenticated;


--
-- Name: TABLE pos_refunds; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.pos_refunds TO authenticated;


--
-- Name: TABLE pos_shifts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.pos_shifts TO authenticated;


--
-- Name: TABLE pos_voids; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.pos_voids TO authenticated;


--
-- Name: TABLE privacy_notice_versions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.privacy_notice_versions TO authenticated;


--
-- Name: TABLE privacy_notice_current; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.privacy_notice_current TO authenticated;
GRANT SELECT ON TABLE public.privacy_notice_current TO anon;


--
-- Name: TABLE product_allergen_declarations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.product_allergen_declarations TO authenticated;
GRANT SELECT ON TABLE public.product_allergen_declarations TO anon;


--
-- Name: TABLE site_settings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.site_settings TO authenticated;
GRANT SELECT ON TABLE public.site_settings TO anon;


--
-- Name: TABLE public_site_configuration; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.public_site_configuration TO anon;
GRANT SELECT ON TABLE public.public_site_configuration TO authenticated;


--
-- Name: TABLE quote_payment_attempts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.quote_payment_attempts TO authenticated;


--
-- Name: TABLE retention_runs; Type: ACL; Schema: public; Owner: -
--



--
-- Name: TABLE role_permissions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.role_permissions TO authenticated;


--
-- Name: TABLE sales_by_channel; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.sales_by_channel TO authenticated;


--
-- Name: TABLE site_content; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.site_content TO authenticated;
GRANT SELECT ON TABLE public.site_content TO anon;


--
-- Name: TABLE staff_documents; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.staff_documents TO authenticated;


--
-- Name: COLUMN staff_documents.status; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(status) ON TABLE public.staff_documents TO authenticated;


--
-- Name: COLUMN staff_documents.approved_by; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(approved_by) ON TABLE public.staff_documents TO authenticated;


--
-- Name: COLUMN staff_documents.expiry_date; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(expiry_date) ON TABLE public.staff_documents TO authenticated;


--
-- Name: COLUMN staff_documents.verified_by; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(verified_by) ON TABLE public.staff_documents TO authenticated;


--
-- Name: COLUMN staff_documents.verified_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(verified_at) ON TABLE public.staff_documents TO authenticated;


--
-- Name: TABLE staff_notice_acknowledgements; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.staff_notice_acknowledgements TO authenticated;


--
-- Name: TABLE stock_levels; Type: ACL; Schema: public; Owner: -
--



--
-- Name: TABLE stock_movements; Type: ACL; Schema: public; Owner: -
--



--
-- Name: TABLE stores_public; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.stores_public TO authenticated;
GRANT SELECT ON TABLE public.stores_public TO anon;


--
-- Name: TABLE tax_codes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.tax_codes TO authenticated;


--
-- Name: TABLE top_products; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.top_products TO authenticated;


--
-- Name: TABLE training_assessments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.training_assessments TO authenticated;


--
-- Name: TABLE training_assignments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.training_assignments TO authenticated;


--
-- Name: TABLE training_certificates; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,UPDATE ON TABLE public.training_certificates TO authenticated;


--
-- Name: TABLE training_courses; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.training_courses TO authenticated;


--
-- Name: TABLE training_progress; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.training_progress TO authenticated;


--
-- Name: TABLE training_results; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.training_results TO authenticated;


--
-- Name: TABLE web_till_devices; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.web_till_devices TO authenticated;


--
-- Name: TABLE web_till_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.web_till_sessions TO authenticated;


--
-- Name: TABLE work_shifts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.work_shifts TO authenticated;


--
-- Name: COLUMN work_shifts.starts_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(starts_at) ON TABLE public.work_shifts TO authenticated;


--
-- Name: COLUMN work_shifts.ends_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(ends_at) ON TABLE public.work_shifts TO authenticated;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO authenticated;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- PostgreSQL database dump complete
--



-- ---- ACL AUTHORITY: the baseline OWNS the final grant state ----
-- On any target with Supabase's ALTER DEFAULT PRIVILEGES, a grant-only
-- dump would RESURRECT rights the chain revoked (default grants fill the
-- gaps). So: revoke everything from the API roles, then re-grant EXACTLY
-- the chain's effective table, column and function privileges.
select pg_catalog.set_config('search_path', 'public', false);
revoke all on table public.activity_log from anon, authenticated;
revoke all on table public.admin_recovery_intents from anon, authenticated;
revoke all on table public.allergen_catalogue from anon, authenticated;
revoke all on table public.app_state from anon, authenticated;
revoke all on table public.audit_logs from anon, authenticated;
revoke all on table public.checklist_templates from anon, authenticated;
revoke all on table public.clock_history from anon, authenticated;
revoke all on table public.cms_pages from anon, authenticated;
revoke all on table public.cms_pages_public from anon, authenticated;
revoke all on table public.collection_revisions from anon, authenticated;
revoke all on table public.contact_messages from anon, authenticated;
revoke all on table public.customers from anon, authenticated;
revoke all on table public.cv_upload_ip_log from anon, authenticated;
revoke all on table public.daily_closes from anon, authenticated;
revoke all on table public.daily_sales from anon, authenticated;
revoke all on table public.deals from anon, authenticated;
revoke all on table public.deals_public from anon, authenticated;
revoke all on table public.email_log from anon, authenticated;
revoke all on table public.form_submission_log from anon, authenticated;
revoke all on table public.franchise_inquiries from anon, authenticated;
revoke all on table public.ingredient_specifications from anon, authenticated;
revoke all on table public.ingredients from anon, authenticated;
revoke all on table public.job_applications from anon, authenticated;
revoke all on table public.job_vacancies from anon, authenticated;
revoke all on table public.job_vacancies_public from anon, authenticated;
revoke all on table public.kb_articles from anon, authenticated;
revoke all on table public.launch_settings from anon, authenticated;
revoke all on table public.loyalty_transactions from anon, authenticated;
revoke all on table public.media_assets from anon, authenticated;
revoke all on table public.media_assets_public from anon, authenticated;
revoke all on table public.media_objects from anon, authenticated;
revoke all on table public.media_references from anon, authenticated;
revoke all on table public.menu_item_recipes from anon, authenticated;
revoke all on table public.menu_items from anon, authenticated;
revoke all on table public.menu_items_public from anon, authenticated;
revoke all on table public.news_posts from anon, authenticated;
revoke all on table public.news_posts_public from anon, authenticated;
revoke all on table public.notification_outbox from anon, authenticated;
revoke all on table public.online_payment_accounts from anon, authenticated;
revoke all on table public.ops_heartbeats from anon, authenticated;
revoke all on table public.order_item_modifiers from anon, authenticated;
revoke all on table public.order_items from anon, authenticated;
revoke all on table public.order_quotes from anon, authenticated;
revoke all on table public.orders from anon, authenticated;
revoke all on table public.payment_reconciliations from anon, authenticated;
revoke all on table public.payment_terminals from anon, authenticated;
revoke all on table public.payroll_export_batches from anon, authenticated;
revoke all on table public.payslips from anon, authenticated;
revoke all on table public.popular_modifiers from anon, authenticated;
revoke all on table public.pos_approvals from anon, authenticated;
revoke all on table public.pos_audit_events from anon, authenticated;
revoke all on table public.pos_cash_movements from anon, authenticated;
revoke all on table public.pos_catalog from anon, authenticated;
revoke all on table public.pos_corrections from anon, authenticated;
revoke all on table public.pos_devices from anon, authenticated;
revoke all on table public.pos_events from anon, authenticated;
revoke all on table public.pos_order_item_modifiers from anon, authenticated;
revoke all on table public.pos_order_items from anon, authenticated;
revoke all on table public.pos_orders from anon, authenticated;
revoke all on table public.pos_pair_attempts from anon, authenticated;
revoke all on table public.pos_pairing_codes from anon, authenticated;
revoke all on table public.pos_refund_items from anon, authenticated;
revoke all on table public.pos_refunds from anon, authenticated;
revoke all on table public.pos_shifts from anon, authenticated;
revoke all on table public.pos_voids from anon, authenticated;
revoke all on table public.privacy_notice_current from anon, authenticated;
revoke all on table public.privacy_notice_versions from anon, authenticated;
revoke all on table public.product_allergen_declarations from anon, authenticated;
revoke all on table public.public_site_configuration from anon, authenticated;
revoke all on table public.quote_payment_attempts from anon, authenticated;
revoke all on table public.retention_runs from anon, authenticated;
revoke all on table public.role_permissions from anon, authenticated;
revoke all on table public.sales_by_channel from anon, authenticated;
revoke all on table public.sifr_reports from anon, authenticated;
revoke all on table public.site_content from anon, authenticated;
revoke all on table public.site_settings from anon, authenticated;
revoke all on table public.staff_compliance_records from anon, authenticated;
revoke all on table public.staff_documents from anon, authenticated;
revoke all on table public.staff_notice_acknowledgements from anon, authenticated;
revoke all on table public.staff_profiles from anon, authenticated;
revoke all on table public.stock_levels from anon, authenticated;
revoke all on table public.stock_movements from anon, authenticated;
revoke all on table public.storage_cleanup_jobs from anon, authenticated;
revoke all on table public.stores from anon, authenticated;
revoke all on table public.stores_public from anon, authenticated;
revoke all on table public.tax_codes from anon, authenticated;
revoke all on table public.top_products from anon, authenticated;
revoke all on table public.training_assessments from anon, authenticated;
revoke all on table public.training_assignments from anon, authenticated;
revoke all on table public.training_certificates from anon, authenticated;
revoke all on table public.training_courses from anon, authenticated;
revoke all on table public.training_progress from anon, authenticated;
revoke all on table public.training_results from anon, authenticated;
revoke all on table public.web_till_devices from anon, authenticated;
revoke all on table public.web_till_sessions from anon, authenticated;
revoke all on table public.work_shifts from anon, authenticated;
revoke all on function public.allergen_declaration_approve(p_declaration_id text) from anon, authenticated;
revoke all on function public.apply_collection_changes(p_table text, p_upserts jsonb, p_delete_ids text[]) from anon, authenticated;
revoke all on function public.armor(bytea) from anon, authenticated;
revoke all on function public.armor(bytea, text[], text[]) from anon, authenticated;
revoke all on function public.assert_ack_append_only() from anon, authenticated;
revoke all on function public.assert_application_transition_sanctioned() from anon, authenticated;
revoke all on function public.assert_full_collection_snapshot(p_table text, p_rows jsonb, p_expected_total integer) from anon, authenticated;
revoke all on function public.assert_launch_ready(p_context text, p_error text) from anon, authenticated;
revoke all on function public.assert_launch_ready(p_context text, p_error text, p_candidate launch_settings) from anon, authenticated;
revoke all on function public.assert_launch_settings_transition() from anon, authenticated;
revoke all on function public.assert_lifecycle_change_sanctioned() from anon, authenticated;
revoke all on function public.assert_menu_publish_allowed() from anon, authenticated;
revoke all on function public.assert_news_slug_discipline() from anon, authenticated;
revoke all on function public.assert_notice_immutability() from anon, authenticated;
revoke all on function public.assert_public_form_accept_allowed() from anon, authenticated;
revoke all on function public.assert_public_record_valid() from anon, authenticated;
revoke all on function public.assert_published_delete_refused() from anon, authenticated;
revoke all on function public.assert_singleton_write_sanctioned() from anon, authenticated;
revoke all on function public.assert_store_open_allowed() from anon, authenticated;
revoke all on function public.audit_logs_stamp() from anon, authenticated;
revoke all on function public.begin_quote_payment(p_payment jsonb) from anon, authenticated;
revoke all on function public.bootstrap_owner(target_email text, target_name text) from anon, authenticated;
revoke all on function public.bump_collection_revision() from anon, authenticated;
revoke all on function public.cancel_order_quote(p_quote jsonb) from anon, authenticated;
revoke all on function public.canonical_request_hash(p jsonb) from anon, authenticated;
revoke all on function public.cert_requires_pass() from anon, authenticated;
revoke all on function public.claim_media_cleanup_batch(p_limit integer) from anon, authenticated;
revoke all on function public.claim_recovery_intent(p_intent_id text) from anon, authenticated;
revoke all on function public.claim_shift(p_shift_id text) from anon, authenticated;
revoke all on function public.claim_storage_cleanup_batch(p_limit integer) from anon, authenticated;
revoke all on function public.classify_products(p jsonb) from anon, authenticated;
revoke all on function public.close_till_session(p_session jsonb) from anon, authenticated;
revoke all on function public.close_vacancy(p_id text, p_expected_revision bigint) from anon, authenticated;
revoke all on function public.collection_revision_checkpoint(p_table text) from anon, authenticated;
revoke all on function public.complete_training(p_assessment_id text, p_score integer, p_submission_id text, p_assignment_id text, p_answers jsonb) from anon, authenticated;
revoke all on function public.compliance_effective_status(rec staff_compliance_records) from anon, authenticated;
revoke all on function public.compliance_record_revoke(p_record_id text, p_reason text) from anon, authenticated;
revoke all on function public.compliance_record_upsert(p_employee_id text, p_type text, p_issued date, p_expires date, p_document_id text, p_notes text) from anon, authenticated;
revoke all on function public.compliance_record_verify(p_record_id text) from anon, authenticated;
revoke all on function public.configure_store_setup(p_config jsonb) from anon, authenticated;
revoke all on function public.create_order_quote(p_quote jsonb) from anon, authenticated;
revoke all on function public.create_pos_pairing_code(p_store_id text, p_store_name text, p_device_label text) from anon, authenticated;
revoke all on function public.crypt(text, text) from anon, authenticated;
revoke all on function public.current_privacy_version(p_audience text) from anon, authenticated;
revoke all on function public.current_staff_id() from anon, authenticated;
revoke all on function public.current_staff_role() from anon, authenticated;
revoke all on function public.current_staff_store() from anon, authenticated;
revoke all on function public.dearmor(text) from anon, authenticated;
revoke all on function public.decrypt(bytea, bytea, text) from anon, authenticated;
revoke all on function public.decrypt_iv(bytea, bytea, bytea, text) from anon, authenticated;
revoke all on function public.digest(bytea, text) from anon, authenticated;
revoke all on function public.digest(text, text) from anon, authenticated;
revoke all on function public.employment_sweep_due() from anon, authenticated;
revoke all on function public.encrypt(bytea, bytea, text) from anon, authenticated;
revoke all on function public.encrypt_iv(bytea, bytea, bytea, text) from anon, authenticated;
revoke all on function public.end_employment(p_employee_id text, p_end_date date, p_reason text, p_notes text, p_immediate boolean) from anon, authenticated;
revoke all on function public.enforce_attempt_identity_immutable() from anon, authenticated;
revoke all on function public.enforce_menu_tax_code_guard() from anon, authenticated;
revoke all on function public.enforce_order_ledger_immutable() from anon, authenticated;
revoke all on function public.enforce_order_ledger_no_delete() from anon, authenticated;
revoke all on function public.enforce_order_line_immutable() from anon, authenticated;
revoke all on function public.enforce_quote_snapshot_immutable() from anon, authenticated;
revoke all on function public.enforce_reconciliation_immutable() from anon, authenticated;
revoke all on function public.enforce_staff_self_update_lock() from anon, authenticated;
revoke all on function public.enforce_store_config_guard() from anon, authenticated;
revoke all on function public.enforce_store_id_immutable() from anon, authenticated;
revoke all on function public.enrol_till_device(p_device jsonb) from anon, authenticated;
revoke all on function public.expire_stale_quotes() from anon, authenticated;
revoke all on function public.explode_order_items() from anon, authenticated;
revoke all on function public.finalise_media_reference(p_object_id uuid, p_entity_type text, p_entity_id text, p_field_path text, p_actor text) from anon, authenticated;
revoke all on function public.finalise_order_payment(p_payment jsonb) from anon, authenticated;
revoke all on function public.finalise_order_payment_core(p_payment jsonb, p_recovery boolean, p_reason text) from anon, authenticated;
revoke all on function public.gen_random_bytes(integer) from anon, authenticated;
revoke all on function public.gen_random_uuid() from anon, authenticated;
revoke all on function public.gen_salt(text) from anon, authenticated;
revoke all on function public.gen_salt(text, integer) from anon, authenticated;
revoke all on function public.get_my_staff_profile() from anon, authenticated;
revoke all on function public.get_staff_assessments() from anon, authenticated;
revoke all on function public.get_staff_directory() from anon, authenticated;
revoke all on function public.grade_training_answers(p_questions jsonb, p_answers jsonb) from anon, authenticated;
revoke all on function public.guard_staff_profile_write() from anon, authenticated;
revoke all on function public.hmac(bytea, bytea, text) from anon, authenticated;
revoke all on function public.hmac(text, text, text) from anon, authenticated;
revoke all on function public.is_aal2() from anon, authenticated;
revoke all on function public.is_manager_or_owner() from anon, authenticated;
revoke all on function public.is_owner() from anon, authenticated;
revoke all on function public.is_store_manager() from anon, authenticated;
revoke all on function public.jwt_aal() from anon, authenticated;
revoke all on function public.launch_blocking_reasons() from anon, authenticated;
revoke all on function public.launch_blocking_reasons(p launch_settings) from anon, authenticated;
revoke all on function public.launch_readiness() from anon, authenticated;
revoke all on function public.launch_settings_is_permanent() from anon, authenticated;
revoke all on function public.launch_settings_never_empty() from anon, authenticated;
revoke all on function public.link_staff_profile() from anon, authenticated;
revoke all on function public.log_payment_authority_event(p_action text, p_payload jsonb) from anon, authenticated;
revoke all on function public.mark_media_cleanup_candidates(p_grace_hours integer) from anon, authenticated;
revoke all on function public.media_path_is_referenced(p_storage_path text, p_public_url text) from anon, authenticated;
revoke all on function public.news_slugify(p_input text) from anon, authenticated;
revoke all on function public.open_till_session(p_session jsonb) from anon, authenticated;
revoke all on function public.ops_health() from anon, authenticated;
revoke all on function public.outbox_claim_batch(p_limit integer) from anon, authenticated;
revoke all on function public.outbox_mark(p_id text, p_outcome text, p_provider_id text, p_code text, p_message text) from anon, authenticated;
revoke all on function public.outbox_recent(p_limit integer) from anon, authenticated;
revoke all on function public.outbox_retry_now(p_id text) from anon, authenticated;
revoke all on function public.owner_staff_pay() from anon, authenticated;
revoke all on function public.pgp_armor_headers(text, OUT key text, OUT value text) from anon, authenticated;
revoke all on function public.pgp_key_id(bytea) from anon, authenticated;
revoke all on function public.pgp_pub_decrypt(bytea, bytea) from anon, authenticated;
revoke all on function public.pgp_pub_decrypt(bytea, bytea, text) from anon, authenticated;
revoke all on function public.pgp_pub_decrypt(bytea, bytea, text, text) from anon, authenticated;
revoke all on function public.pgp_pub_decrypt_bytea(bytea, bytea) from anon, authenticated;
revoke all on function public.pgp_pub_decrypt_bytea(bytea, bytea, text) from anon, authenticated;
revoke all on function public.pgp_pub_decrypt_bytea(bytea, bytea, text, text) from anon, authenticated;
revoke all on function public.pgp_pub_encrypt(text, bytea) from anon, authenticated;
revoke all on function public.pgp_pub_encrypt(text, bytea, text) from anon, authenticated;
revoke all on function public.pgp_pub_encrypt_bytea(bytea, bytea) from anon, authenticated;
revoke all on function public.pgp_pub_encrypt_bytea(bytea, bytea, text) from anon, authenticated;
revoke all on function public.pgp_sym_decrypt(bytea, text) from anon, authenticated;
revoke all on function public.pgp_sym_decrypt(bytea, text, text) from anon, authenticated;
revoke all on function public.pgp_sym_decrypt_bytea(bytea, text) from anon, authenticated;
revoke all on function public.pgp_sym_decrypt_bytea(bytea, text, text) from anon, authenticated;
revoke all on function public.pgp_sym_encrypt(text, text) from anon, authenticated;
revoke all on function public.pgp_sym_encrypt(text, text, text) from anon, authenticated;
revoke all on function public.pgp_sym_encrypt_bytea(bytea, text) from anon, authenticated;
revoke all on function public.pgp_sym_encrypt_bytea(bytea, text, text) from anon, authenticated;
revoke all on function public.pos_apply_approval(p_device_id uuid, p_store_id text, p jsonb) from anon, authenticated;
revoke all on function public.pos_authenticate_device(p_token_hash text) from anon, authenticated;
revoke all on function public.pos_catalog_current() from anon, authenticated;
revoke all on function public.pos_catalog_version() from anon, authenticated;
revoke all on function public.pos_complete_pairing(p_code_hash text, p_installation_id text, p_device jsonb) from anon, authenticated;
revoke all on function public.pos_ingest_batch(p_device_id uuid, p_events jsonb) from anon, authenticated;
revoke all on function public.pos_payload_has_forbidden_key(p jsonb) from anon, authenticated;
revoke all on function public.pos_pence(p jsonb, p_path text[], p_required boolean) from anon, authenticated;
revoke all on function public.pos_random_code(p_length integer) from anon, authenticated;
revoke all on function public.pos_shift_seal() from anon, authenticated;
revoke all on function public.pos_text(p jsonb, p_path text[], p_field text) from anon, authenticated;
revoke all on function public.pos_ts(p jsonb, p_path text[], p_field text) from anon, authenticated;
revoke all on function public.price_basket_internal(p_store stores, p_items jsonb, p_deals jsonb, p_charging boolean) from anon, authenticated;
revoke all on function public.publication_candidate_errors(p_table text, p_candidate jsonb) from anon, authenticated;
revoke all on function public.publication_completeness_errors(p_table text, p_id text) from anon, authenticated;
revoke all on function public.publish_pos_catalog(p_snapshot jsonb) from anon, authenticated;
revoke all on function public.publish_record(p_table text, p_id text, p_publish boolean) from anon, authenticated;
revoke all on function public.purge_employee(p_employee_id text, p_typed_name text) from anon, authenticated;
revoke all on function public.purge_expired_cvs(retain interval) from anon, authenticated;
revoke all on function public.reconcile_card_payment(p_settlement jsonb) from anon, authenticated;
revoke all on function public.record_heartbeat(p_job text, p_status text, p_detail text) from anon, authenticated;
revoke all on function public.record_media_cleanup_result(p_id uuid, p_ok boolean, p_error text) from anon, authenticated;
revoke all on function public.record_storage_cleanup_result(p_id uuid, p_ok boolean, p_error text) from anon, authenticated;
revoke all on function public.recovery_action_permitted(p_target text, p_action text, p_reason text) from anon, authenticated;
revoke all on function public.redact_assessment_row(p jsonb) from anon, authenticated;
revoke all on function public.refuse_public_view_write() from anon, authenticated;
revoke all on function public.release_quote_payment(p_release jsonb) from anon, authenticated;
revoke all on function public.replace_collection(p_table text, p_rows jsonb, p_expected_total integer, p_expected_revision bigint) from anon, authenticated;
revoke all on function public.request_recovery_action(p_action text, p_target text, p_reason text) from anon, authenticated;
revoke all on function public.resolve_payment_reconciliation(p_resolution jsonb) from anon, authenticated;
revoke all on function public.resolve_public_submission(p_kind text, p_idempotency_key uuid, p_request_hash text) from anon, authenticated;
revoke all on function public.retention_enqueue_orphan_cvs(grace interval) from anon, authenticated;
revoke all on function public.retention_purge_contact_messages(retain interval) from anon, authenticated;
revoke all on function public.retention_purge_franchise_inquiries(retain interval) from anon, authenticated;
revoke all on function public.retention_purge_job_applications(retain interval) from anon, authenticated;
revoke all on function public.revoke_pos_device(p_device_id uuid) from anon, authenticated;
revoke all on function public.reward_grant_active() from anon, authenticated;
revoke all on function public.rotate_pos_device_token(p_device_id uuid) from anon, authenticated;
revoke all on function public.run_retention_sweep(p_contact_retain interval, p_franchise_retain interval, p_applications_retain interval, p_orphan_grace interval) from anon, authenticated;
revoke all on function public.save_launch_settings(p_patch jsonb, p_expected_revision bigint) from anon, authenticated;
revoke all on function public.save_website_studio(p_site_settings jsonb, p_site_content jsonb, p_expected_settings_revision bigint, p_expected_content_revision bigint) from anon, authenticated;
revoke all on function public.set_app_state(p_key text, p_value jsonb) from anon, authenticated;
revoke all on function public.set_updated_at() from anon, authenticated;
revoke all on function public.sifr_report_store(r sifr_reports) from anon, authenticated;
revoke all on function public.sifr_reports_stamp() from anon, authenticated;
revoke all on function public.singleton_apply_payload(p_table text, p_payload jsonb, p_updated_by text) from anon, authenticated;
revoke all on function public.staff_clock_action(p_action text, p_notes text) from anon, authenticated;
revoke all on function public.staff_compliance_overview(p_employee_id text) from anon, authenticated;
revoke all on function public.staff_profiles_protect() from anon, authenticated;
revoke all on function public.stamp_notice_on_insert() from anon, authenticated;
revoke all on function public.store_config_fingerprint(p_store stores) from anon, authenticated;
revoke all on function public.store_trading_state(p_store_id text) from anon, authenticated;
revoke all on function public.submit_public_form(p_kind text, p_row jsonb, p_idempotency_key uuid, p_request_hash text, p_ip_hash text, p_notice_id text, p_notice_sha256 text) from anon, authenticated;
revoke all on function public.submit_public_form_core(p_kind text, p_row jsonb, p_idempotency_key uuid, p_request_hash text, p_ip_hash text) from anon, authenticated;
revoke all on function public.supersede_declarations_on_change() from anon, authenticated;
revoke all on function public.training_assignments_protect() from anon, authenticated;
revoke all on function public.training_certificates_protect() from anon, authenticated;
revoke all on function public.transition_application(p_id text, p_from_status text, p_to_status text) from anon, authenticated;
revoke all on function public.valid_payment_methods(p jsonb) from anon, authenticated;
grant SELECT on table public.activity_log to authenticated;
grant DELETE on table public.admin_recovery_intents to authenticated;
grant INSERT on table public.admin_recovery_intents to authenticated;
grant SELECT on table public.admin_recovery_intents to authenticated;
grant UPDATE on table public.admin_recovery_intents to authenticated;
grant SELECT on table public.allergen_catalogue to anon;
grant DELETE on table public.allergen_catalogue to authenticated;
grant INSERT on table public.allergen_catalogue to authenticated;
grant SELECT on table public.allergen_catalogue to authenticated;
grant UPDATE on table public.allergen_catalogue to authenticated;
grant SELECT on table public.app_state to authenticated;
grant INSERT on table public.audit_logs to authenticated;
grant SELECT on table public.audit_logs to authenticated;
grant DELETE on table public.checklist_templates to authenticated;
grant INSERT on table public.checklist_templates to authenticated;
grant SELECT on table public.checklist_templates to authenticated;
grant UPDATE on table public.checklist_templates to authenticated;
grant DELETE on table public.clock_history to authenticated;
grant INSERT on table public.clock_history to authenticated;
grant SELECT on table public.clock_history to authenticated;
grant UPDATE on table public.clock_history to authenticated;
grant DELETE on table public.cms_pages to authenticated;
grant INSERT on table public.cms_pages to authenticated;
grant SELECT on table public.cms_pages to authenticated;
grant UPDATE on table public.cms_pages to authenticated;
grant SELECT on table public.cms_pages_public to authenticated;
grant DELETE on table public.collection_revisions to authenticated;
grant INSERT on table public.collection_revisions to authenticated;
grant SELECT on table public.collection_revisions to authenticated;
grant UPDATE on table public.collection_revisions to authenticated;
grant DELETE on table public.contact_messages to authenticated;
grant SELECT on table public.contact_messages to authenticated;
grant UPDATE on table public.contact_messages to authenticated;
grant SELECT on table public.cv_upload_ip_log to authenticated;
grant DELETE on table public.daily_closes to authenticated;
grant INSERT on table public.daily_closes to authenticated;
grant SELECT on table public.daily_closes to authenticated;
grant UPDATE on table public.daily_closes to authenticated;
grant SELECT on table public.daily_sales to authenticated;
grant DELETE on table public.deals to authenticated;
grant INSERT on table public.deals to authenticated;
grant SELECT on table public.deals to authenticated;
grant UPDATE on table public.deals to authenticated;
grant SELECT on table public.deals_public to anon;
grant SELECT on table public.deals_public to authenticated;
grant SELECT on table public.email_log to authenticated;
grant SELECT on table public.form_submission_log to authenticated;
grant DELETE on table public.franchise_inquiries to authenticated;
grant SELECT on table public.franchise_inquiries to authenticated;
grant UPDATE on table public.franchise_inquiries to authenticated;
grant DELETE on table public.ingredient_specifications to authenticated;
grant INSERT on table public.ingredient_specifications to authenticated;
grant SELECT on table public.ingredient_specifications to authenticated;
grant UPDATE on table public.ingredient_specifications to authenticated;
grant DELETE on table public.job_applications to authenticated;
grant SELECT on table public.job_applications to authenticated;
grant UPDATE on table public.job_applications to authenticated;
grant DELETE on table public.job_vacancies to authenticated;
grant INSERT on table public.job_vacancies to authenticated;
grant SELECT on table public.job_vacancies to authenticated;
grant UPDATE on table public.job_vacancies to authenticated;
grant SELECT on table public.job_vacancies_public to anon;
grant SELECT on table public.job_vacancies_public to authenticated;
grant DELETE on table public.kb_articles to authenticated;
grant INSERT on table public.kb_articles to authenticated;
grant SELECT on table public.kb_articles to authenticated;
grant UPDATE on table public.kb_articles to authenticated;
grant DELETE on table public.launch_settings to authenticated;
grant INSERT on table public.launch_settings to authenticated;
grant SELECT on table public.launch_settings to authenticated;
grant UPDATE on table public.launch_settings to authenticated;
grant DELETE on table public.media_assets to authenticated;
grant INSERT on table public.media_assets to authenticated;
grant SELECT on table public.media_assets to authenticated;
grant UPDATE on table public.media_assets to authenticated;
grant SELECT on table public.media_assets_public to authenticated;
grant SELECT on table public.media_objects to authenticated;
grant SELECT on table public.media_references to authenticated;
grant DELETE on table public.menu_item_recipes to authenticated;
grant INSERT on table public.menu_item_recipes to authenticated;
grant SELECT on table public.menu_item_recipes to authenticated;
grant UPDATE on table public.menu_item_recipes to authenticated;
grant DELETE on table public.menu_items to authenticated;
grant INSERT on table public.menu_items to authenticated;
grant SELECT on table public.menu_items to authenticated;
grant UPDATE on table public.menu_items to authenticated;
grant SELECT on table public.menu_items_public to anon;
grant SELECT on table public.menu_items_public to authenticated;
grant DELETE on table public.news_posts to authenticated;
grant INSERT on table public.news_posts to authenticated;
grant SELECT on table public.news_posts to authenticated;
grant UPDATE on table public.news_posts to authenticated;
grant SELECT on table public.news_posts_public to anon;
grant SELECT on table public.news_posts_public to authenticated;
grant DELETE on table public.notification_outbox to authenticated;
grant INSERT on table public.notification_outbox to authenticated;
grant SELECT on table public.notification_outbox to authenticated;
grant UPDATE on table public.notification_outbox to authenticated;
grant SELECT on table public.online_payment_accounts to authenticated;
grant DELETE on table public.ops_heartbeats to authenticated;
grant INSERT on table public.ops_heartbeats to authenticated;
grant SELECT on table public.ops_heartbeats to authenticated;
grant UPDATE on table public.ops_heartbeats to authenticated;
grant SELECT on table public.order_item_modifiers to authenticated;
grant SELECT on table public.order_items to authenticated;
grant SELECT on table public.order_quotes to authenticated;
grant SELECT on table public.orders to authenticated;
grant SELECT on table public.payment_reconciliations to authenticated;
grant SELECT on table public.payment_terminals to authenticated;
grant DELETE on table public.payroll_export_batches to authenticated;
grant INSERT on table public.payroll_export_batches to authenticated;
grant SELECT on table public.payroll_export_batches to authenticated;
grant UPDATE on table public.payroll_export_batches to authenticated;
grant DELETE on table public.payslips to authenticated;
grant INSERT on table public.payslips to authenticated;
grant SELECT on table public.payslips to authenticated;
grant UPDATE on table public.payslips to authenticated;
grant SELECT on table public.popular_modifiers to authenticated;
grant SELECT on table public.pos_approvals to authenticated;
grant SELECT on table public.pos_audit_events to authenticated;
grant SELECT on table public.pos_cash_movements to authenticated;
grant SELECT on table public.pos_corrections to authenticated;
grant SELECT on table public.pos_events to authenticated;
grant SELECT on table public.pos_order_item_modifiers to authenticated;
grant SELECT on table public.pos_order_items to authenticated;
grant SELECT on table public.pos_orders to authenticated;
grant SELECT on table public.pos_refund_items to authenticated;
grant SELECT on table public.pos_refunds to authenticated;
grant SELECT on table public.pos_shifts to authenticated;
grant SELECT on table public.pos_voids to authenticated;
grant SELECT on table public.privacy_notice_current to anon;
grant SELECT on table public.privacy_notice_current to authenticated;
grant DELETE on table public.privacy_notice_versions to authenticated;
grant INSERT on table public.privacy_notice_versions to authenticated;
grant SELECT on table public.privacy_notice_versions to authenticated;
grant UPDATE on table public.privacy_notice_versions to authenticated;
grant SELECT on table public.product_allergen_declarations to anon;
grant DELETE on table public.product_allergen_declarations to authenticated;
grant INSERT on table public.product_allergen_declarations to authenticated;
grant SELECT on table public.product_allergen_declarations to authenticated;
grant UPDATE on table public.product_allergen_declarations to authenticated;
grant SELECT on table public.public_site_configuration to anon;
grant SELECT on table public.public_site_configuration to authenticated;
grant SELECT on table public.quote_payment_attempts to authenticated;
grant DELETE on table public.role_permissions to authenticated;
grant INSERT on table public.role_permissions to authenticated;
grant SELECT on table public.role_permissions to authenticated;
grant UPDATE on table public.role_permissions to authenticated;
grant SELECT on table public.sales_by_channel to authenticated;
grant DELETE on table public.sifr_reports to authenticated;
grant INSERT on table public.sifr_reports to authenticated;
grant SELECT on table public.sifr_reports to authenticated;
grant UPDATE on table public.sifr_reports to authenticated;
grant SELECT on table public.site_content to anon;
grant DELETE on table public.site_content to authenticated;
grant INSERT on table public.site_content to authenticated;
grant SELECT on table public.site_content to authenticated;
grant UPDATE on table public.site_content to authenticated;
grant SELECT on table public.site_settings to anon;
grant DELETE on table public.site_settings to authenticated;
grant INSERT on table public.site_settings to authenticated;
grant SELECT on table public.site_settings to authenticated;
grant UPDATE on table public.site_settings to authenticated;
grant DELETE on table public.staff_compliance_records to authenticated;
grant INSERT on table public.staff_compliance_records to authenticated;
grant SELECT on table public.staff_compliance_records to authenticated;
grant UPDATE on table public.staff_compliance_records to authenticated;
grant SELECT on table public.staff_documents to authenticated;
grant DELETE on table public.staff_notice_acknowledgements to authenticated;
grant INSERT on table public.staff_notice_acknowledgements to authenticated;
grant SELECT on table public.staff_notice_acknowledgements to authenticated;
grant UPDATE on table public.staff_notice_acknowledgements to authenticated;
grant DELETE on table public.staff_profiles to authenticated;
grant INSERT on table public.staff_profiles to authenticated;
grant UPDATE on table public.staff_profiles to authenticated;
grant DELETE on table public.stores to authenticated;
grant INSERT on table public.stores to authenticated;
grant SELECT on table public.stores to authenticated;
grant UPDATE on table public.stores to authenticated;
grant SELECT on table public.stores_public to anon;
grant SELECT on table public.stores_public to authenticated;
grant SELECT on table public.tax_codes to authenticated;
grant SELECT on table public.top_products to authenticated;
grant DELETE on table public.training_assessments to authenticated;
grant INSERT on table public.training_assessments to authenticated;
grant SELECT on table public.training_assessments to authenticated;
grant UPDATE on table public.training_assessments to authenticated;
grant DELETE on table public.training_assignments to authenticated;
grant INSERT on table public.training_assignments to authenticated;
grant SELECT on table public.training_assignments to authenticated;
grant UPDATE on table public.training_assignments to authenticated;
grant SELECT on table public.training_certificates to authenticated;
grant UPDATE on table public.training_certificates to authenticated;
grant DELETE on table public.training_courses to authenticated;
grant INSERT on table public.training_courses to authenticated;
grant SELECT on table public.training_courses to authenticated;
grant UPDATE on table public.training_courses to authenticated;
grant INSERT on table public.training_progress to authenticated;
grant SELECT on table public.training_progress to authenticated;
grant UPDATE on table public.training_progress to authenticated;
grant SELECT on table public.training_results to authenticated;
grant SELECT on table public.web_till_devices to authenticated;
grant SELECT on table public.web_till_sessions to authenticated;
grant DELETE on table public.work_shifts to authenticated;
grant INSERT on table public.work_shifts to authenticated;
grant SELECT on table public.work_shifts to authenticated;
grant UPDATE on table public.work_shifts to authenticated;
grant SELECT (app_version) on public.pos_devices to authenticated;
grant SELECT (device_code) on public.pos_devices to authenticated;
grant SELECT (device_name) on public.pos_devices to authenticated;
grant SELECT (id) on public.pos_devices to authenticated;
grant SELECT (installation_id) on public.pos_devices to authenticated;
grant SELECT (last_seen_at) on public.pos_devices to authenticated;
grant SELECT (last_sync_at) on public.pos_devices to authenticated;
grant SELECT (paired_at) on public.pos_devices to authenticated;
grant SELECT (revoked) on public.pos_devices to authenticated;
grant SELECT (schema_version) on public.pos_devices to authenticated;
grant SELECT (store_code) on public.pos_devices to authenticated;
grant SELECT (store_id) on public.pos_devices to authenticated;
grant SELECT (store_name) on public.pos_devices to authenticated;
grant UPDATE (approved_by) on public.staff_documents to authenticated;
grant UPDATE (expiry_date) on public.staff_documents to authenticated;
grant UPDATE (status) on public.staff_documents to authenticated;
grant UPDATE (verified_at) on public.staff_documents to authenticated;
grant UPDATE (verified_by) on public.staff_documents to authenticated;
grant SELECT (id) on public.staff_profiles to authenticated;
grant SELECT (name) on public.staff_profiles to authenticated;
grant SELECT (role) on public.staff_profiles to authenticated;
grant SELECT (store_id) on public.staff_profiles to authenticated;
grant SELECT (store_name) on public.staff_profiles to authenticated;
grant execute on function public.allergen_declaration_approve(p_declaration_id text) to authenticated;
grant execute on function public.apply_collection_changes(p_table text, p_upserts jsonb, p_delete_ids text[]) to authenticated;
grant execute on function public.assert_ack_append_only() to authenticated;
grant execute on function public.assert_application_transition_sanctioned() to authenticated;
grant execute on function public.assert_full_collection_snapshot(p_table text, p_rows jsonb, p_expected_total integer) to authenticated;
grant execute on function public.assert_launch_ready(p_context text, p_error text) to authenticated;
grant execute on function public.assert_launch_ready(p_context text, p_error text, p_candidate launch_settings) to authenticated;
grant execute on function public.assert_launch_settings_transition() to authenticated;
grant execute on function public.assert_lifecycle_change_sanctioned() to authenticated;
grant execute on function public.assert_menu_publish_allowed() to authenticated;
grant execute on function public.assert_news_slug_discipline() to authenticated;
grant execute on function public.assert_notice_immutability() to authenticated;
grant execute on function public.assert_public_form_accept_allowed() to authenticated;
grant execute on function public.assert_public_record_valid() to authenticated;
grant execute on function public.assert_published_delete_refused() to authenticated;
grant execute on function public.assert_singleton_write_sanctioned() to authenticated;
grant execute on function public.assert_store_open_allowed() to authenticated;
grant execute on function public.audit_logs_stamp() to authenticated;
grant execute on function public.begin_quote_payment(p_payment jsonb) to authenticated;
grant execute on function public.cancel_order_quote(p_quote jsonb) to authenticated;
grant execute on function public.cert_requires_pass() to authenticated;
grant execute on function public.claim_recovery_intent(p_intent_id text) to authenticated;
grant execute on function public.claim_shift(p_shift_id text) to authenticated;
grant execute on function public.classify_products(p jsonb) to authenticated;
grant execute on function public.close_till_session(p_session jsonb) to authenticated;
grant execute on function public.close_vacancy(p_id text, p_expected_revision bigint) to authenticated;
grant execute on function public.collection_revision_checkpoint(p_table text) to authenticated;
grant execute on function public.complete_training(p_assessment_id text, p_score integer, p_submission_id text, p_assignment_id text, p_answers jsonb) to authenticated;
grant execute on function public.compliance_effective_status(rec staff_compliance_records) to authenticated;
grant execute on function public.compliance_record_revoke(p_record_id text, p_reason text) to authenticated;
grant execute on function public.compliance_record_upsert(p_employee_id text, p_type text, p_issued date, p_expires date, p_document_id text, p_notes text) to authenticated;
grant execute on function public.compliance_record_verify(p_record_id text) to authenticated;
grant execute on function public.configure_store_setup(p_config jsonb) to authenticated;
grant execute on function public.create_order_quote(p_quote jsonb) to authenticated;
grant execute on function public.create_pos_pairing_code(p_store_id text, p_store_name text, p_device_label text) to authenticated;
grant execute on function public.current_privacy_version(p_audience text) to authenticated;
grant execute on function public.current_staff_id() to authenticated;
grant execute on function public.current_staff_role() to authenticated;
grant execute on function public.current_staff_store() to authenticated;
grant execute on function public.end_employment(p_employee_id text, p_end_date date, p_reason text, p_notes text, p_immediate boolean) to authenticated;
grant execute on function public.enforce_attempt_identity_immutable() to authenticated;
grant execute on function public.enforce_menu_tax_code_guard() to authenticated;
grant execute on function public.enforce_order_ledger_immutable() to authenticated;
grant execute on function public.enforce_order_ledger_no_delete() to authenticated;
grant execute on function public.enforce_order_line_immutable() to authenticated;
grant execute on function public.enforce_quote_snapshot_immutable() to authenticated;
grant execute on function public.enforce_reconciliation_immutable() to authenticated;
grant execute on function public.enforce_staff_self_update_lock() to authenticated;
grant execute on function public.enforce_store_config_guard() to authenticated;
grant execute on function public.enforce_store_id_immutable() to authenticated;
grant execute on function public.enrol_till_device(p_device jsonb) to authenticated;
grant execute on function public.expire_stale_quotes() to authenticated;
grant execute on function public.finalise_order_payment(p_payment jsonb) to authenticated;
grant execute on function public.get_my_staff_profile() to authenticated;
grant execute on function public.get_staff_assessments() to authenticated;
grant execute on function public.get_staff_directory() to authenticated;
grant execute on function public.grade_training_answers(p_questions jsonb, p_answers jsonb) to authenticated;
grant execute on function public.guard_staff_profile_write() to authenticated;
grant execute on function public.is_aal2() to authenticated;
grant execute on function public.is_manager_or_owner() to authenticated;
grant execute on function public.is_owner() to authenticated;
grant execute on function public.is_store_manager() to authenticated;
grant execute on function public.jwt_aal() to authenticated;
grant execute on function public.launch_readiness() to authenticated;
grant execute on function public.launch_settings_is_permanent() to authenticated;
grant execute on function public.launch_settings_never_empty() to authenticated;
grant execute on function public.link_staff_profile() to authenticated;
grant execute on function public.news_slugify(p_input text) to authenticated;
grant execute on function public.open_till_session(p_session jsonb) to authenticated;
grant execute on function public.ops_health() to authenticated;
grant execute on function public.outbox_recent(p_limit integer) to authenticated;
grant execute on function public.outbox_retry_now(p_id text) to authenticated;
grant execute on function public.owner_staff_pay() to authenticated;
grant execute on function public.pos_catalog_version() to authenticated;
grant execute on function public.pos_shift_seal() to authenticated;
grant execute on function public.publication_candidate_errors(p_table text, p_candidate jsonb) to authenticated;
grant execute on function public.publication_completeness_errors(p_table text, p_id text) to authenticated;
grant execute on function public.publish_pos_catalog(p_snapshot jsonb) to authenticated;
grant execute on function public.publish_record(p_table text, p_id text, p_publish boolean) to authenticated;
grant execute on function public.purge_employee(p_employee_id text, p_typed_name text) to authenticated;
grant execute on function public.reconcile_card_payment(p_settlement jsonb) to authenticated;
grant execute on function public.recovery_action_permitted(p_target text, p_action text, p_reason text) to authenticated;
grant execute on function public.redact_assessment_row(p jsonb) to authenticated;
grant execute on function public.refuse_public_view_write() to authenticated;
grant execute on function public.release_quote_payment(p_release jsonb) to authenticated;
grant execute on function public.replace_collection(p_table text, p_rows jsonb, p_expected_total integer, p_expected_revision bigint) to authenticated;
grant execute on function public.request_recovery_action(p_action text, p_target text, p_reason text) to authenticated;
grant execute on function public.resolve_payment_reconciliation(p_resolution jsonb) to authenticated;
grant execute on function public.revoke_pos_device(p_device_id uuid) to authenticated;
grant execute on function public.reward_grant_active() to authenticated;
grant execute on function public.rotate_pos_device_token(p_device_id uuid) to authenticated;
grant execute on function public.save_launch_settings(p_patch jsonb, p_expected_revision bigint) to authenticated;
grant execute on function public.save_website_studio(p_site_settings jsonb, p_site_content jsonb, p_expected_settings_revision bigint, p_expected_content_revision bigint) to authenticated;
grant execute on function public.set_app_state(p_key text, p_value jsonb) to authenticated;
grant execute on function public.set_updated_at() to authenticated;
grant execute on function public.sifr_report_store(r sifr_reports) to authenticated;
grant execute on function public.sifr_reports_stamp() to authenticated;
grant execute on function public.staff_clock_action(p_action text, p_notes text) to authenticated;
grant execute on function public.staff_compliance_overview(p_employee_id text) to authenticated;
grant execute on function public.staff_profiles_protect() to authenticated;
grant execute on function public.stamp_notice_on_insert() to authenticated;
grant execute on function public.store_trading_state(p_store_id text) to authenticated;
grant execute on function public.supersede_declarations_on_change() to authenticated;
grant execute on function public.training_assignments_protect() to authenticated;
grant execute on function public.training_certificates_protect() to authenticated;
grant execute on function public.transition_application(p_id text, p_from_status text, p_to_status text) to authenticated;
grant execute on function public.valid_payment_methods(p jsonb) to authenticated;
-- ---- user-defined casts (pg_dump omits CREATE CAST entirely) ----
-- The Stage-3 WS2 text->timestamptz/date assignment bridge: without it,
-- every text-era server writer breaks on a baseline-installed database.
do $c$ begin if not exists (select 1 from pg_cast c join pg_type s on s.oid=c.castsource join pg_type t on t.oid=c.casttarget where s.typname='text' and t.typname='date') then create cast (text as date) with inout as assignment; end if; end $c$;
do $c$ begin if not exists (select 1 from pg_cast c join pg_type s on s.oid=c.castsource join pg_type t on t.oid=c.casttarget where s.typname='text' and t.typname='timestamptz') then create cast (text as timestamptz) with inout as assignment; end if; end $c$;
-- ---- storage policies (captured from the live chain state) ----
-- ---- storage bucket reference rows (system data, not business data) ----
insert into storage.buckets (id, name, public) values ('cvs', 'cvs', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('menu-media', 'menu-media', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('staff-documents', 'staff-documents', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('training-media', 'training-media', false) on conflict (id) do nothing;
-- ---- collection revision bootstrap rows (P0-3: system data, not business data) ----
-- The revision guard's authoritative key set. Without these a baseline-
-- installed database dead-ends every first save: the client hydrates no
-- revision, sends null, and the null refusal rolls back the checkpoint's
-- lazy insert — forever. The server installs every authoritative row
-- BEFORE any client hydrates it. Captured from the chain state (like the
-- bucket rows above); updated_at is left to its install-time default.
insert into collection_revisions (table_key, revision) values ('checklist_templates', 0) on conflict (table_key) do nothing;
insert into collection_revisions (table_key, revision) values ('deals', 0) on conflict (table_key) do nothing;
insert into collection_revisions (table_key, revision) values ('job_vacancies', 0) on conflict (table_key) do nothing;
insert into collection_revisions (table_key, revision) values ('kb_articles', 0) on conflict (table_key) do nothing;
insert into collection_revisions (table_key, revision) values ('launch_settings', 0) on conflict (table_key) do nothing;
insert into collection_revisions (table_key, revision) values ('media_assets', 0) on conflict (table_key) do nothing;
insert into collection_revisions (table_key, revision) values ('menu_items', 0) on conflict (table_key) do nothing;
insert into collection_revisions (table_key, revision) values ('news_posts', 0) on conflict (table_key) do nothing;
insert into collection_revisions (table_key, revision) values ('role_permissions', 0) on conflict (table_key) do nothing;
insert into collection_revisions (table_key, revision) values ('site_content', 0) on conflict (table_key) do nothing;
insert into collection_revisions (table_key, revision) values ('site_settings', 0) on conflict (table_key) do nothing;
insert into collection_revisions (table_key, revision) values ('stores', 0) on conflict (table_key) do nothing;
insert into collection_revisions (table_key, revision) values ('training_assessments', 0) on conflict (table_key) do nothing;
insert into collection_revisions (table_key, revision) values ('training_assignments', 0) on conflict (table_key) do nothing;
insert into collection_revisions (table_key, revision) values ('training_courses', 0) on conflict (table_key) do nothing;
