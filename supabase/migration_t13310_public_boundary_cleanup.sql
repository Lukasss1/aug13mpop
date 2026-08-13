-- ============================================================================
-- Milk Pop T13.3.10 — canonical public-settings and opening-fact boundary
--
-- Public website and build-time consumers read public_site_configuration.
-- Keeping anon SELECT on the site_settings base table created a second public
-- source of truth and exposed columns outside the deliberately narrow view.
-- This append-only migration closes that obsolete compatibility grant and
-- makes launch contact facts complete only when their saved shape is usable.
-- ============================================================================

revoke select on table public.site_settings from anon;

comment on view public.public_site_configuration is
  'Canonical anonymous website-configuration source. Legal/contact facts use launch_settings with per-field site_settings fallback; presentation settings come from site_settings. The site_settings base table is not anon-readable.';

do $acceptance$
begin
  if has_table_privilege('anon', 'public.site_settings'::regclass, 'SELECT') then
    raise exception 't13310_public_boundary_cleanup: anon still reads site_settings';
  end if;
  if not has_table_privilege('anon', 'public.public_site_configuration'::regclass, 'SELECT') then
    raise exception 't13310_public_boundary_cleanup: canonical public configuration is dark';
  end if;
end
$acceptance$;

-- ----------------------------------------------------------------------------
-- Opening-fact shape validation
--
-- Launch readiness previously considered any non-empty e-mail, phone or URL
-- complete. That is not enough for an opening gate: malformed values are no
-- more usable than missing ones. These immutable helpers are private database
-- implementation details; the trigger and the single readiness definition use
-- them, while clients receive only the existing guarded RPCs.
-- ----------------------------------------------------------------------------
create or replace function public.launch_fact_email_valid(p_value text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(length(trim(p_value)) between 3 and 320
    and trim(p_value) !~ '[[:space:]?&=#;,%<>"''\\]'
    and trim(p_value) ~ '^[^@]+@[^@]+\.[^@]{2,}$', false);
$$;

create or replace function public.launch_fact_phone_valid(p_value text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(length(trim(p_value)) between 5 and 25
    and trim(p_value) ~ '^\+?[0-9 ()\.-]+$', false);
$$;

create or replace function public.launch_fact_https_valid(p_value text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(length(trim(p_value)) between 10 and 500
    and trim(p_value) ~ '^https://(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?/?$'
    and trim(p_value) !~ '^https://(?:0|10|127)\.'
    and trim(p_value) !~ '^https://169\.254\.'
    and trim(p_value) !~ '^https://192\.168\.'
    and trim(p_value) !~ '^https://172\.(?:1[6-9]|2[0-9]|3[01])\.', false);
$$;

revoke all on function public.launch_fact_email_valid(text) from public, anon, authenticated;
revoke all on function public.launch_fact_phone_valid(text) from public, anon, authenticated;
revoke all on function public.launch_fact_https_valid(text) from public, anon, authenticated;

create or replace function public.assert_launch_fact_shapes()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if length(coalesce(new.legal_business_name, '')) > 200
     or length(coalesce(new.company_number, '')) > 50
     or length(coalesce(new.registered_address, '')) > 500
     or length(coalesce(new.receipt_identity_footer, '')) > 500 then
    raise exception 'launch_settings_invalid: a launch fact exceeds its length limit'
      using errcode = 'check_violation';
  end if;

  if coalesce(trim(new.public_contact_email), '') <> ''
     and not public.launch_fact_email_valid(new.public_contact_email) then
    raise exception 'launch_settings_invalid: public_contact_email'
      using errcode = 'check_violation';
  end if;
  if coalesce(trim(new.privacy_contact_email), '') <> ''
     and not public.launch_fact_email_valid(new.privacy_contact_email) then
    raise exception 'launch_settings_invalid: privacy_contact_email'
      using errcode = 'check_violation';
  end if;
  if coalesce(trim(new.notification_recipient), '') <> ''
     and not public.launch_fact_email_valid(new.notification_recipient) then
    raise exception 'launch_settings_invalid: notification_recipient'
      using errcode = 'check_violation';
  end if;
  if coalesce(trim(new.public_telephone), '') <> ''
     and not public.launch_fact_phone_valid(new.public_telephone) then
    raise exception 'launch_settings_invalid: public_telephone'
      using errcode = 'check_violation';
  end if;
  if coalesce(trim(new.canonical_url), '') <> ''
     and not public.launch_fact_https_valid(new.canonical_url) then
    raise exception 'launch_settings_invalid: canonical_url'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

revoke all on function public.assert_launch_fact_shapes() from public, anon, authenticated;

drop trigger if exists trg_launch_settings_validate_shape on public.launch_settings;
create trigger trg_launch_settings_validate_shape
before insert or update on public.launch_settings
for each row execute function public.assert_launch_fact_shapes();

-- Final, candidate-aware launch-readiness definition. It preserves the R4.10
-- single-definition architecture, but a fact is complete only when it is both
-- present and usable.
create or replace function public.launch_blocking_reasons(p public.launch_settings)
returns table (key text, state text, detail text, fix text, blocks text[])
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from (values
    ('legal_business_name',
       case when coalesce(trim(p.legal_business_name),'') <> '' then 'complete' else 'incomplete' end,
       'The registered name the business trades under.', '/admin/settings/',
       array['arm_gates','store_open']),
    ('company_number',
       case when coalesce(trim(p.company_number),'') <> '' then 'complete' else 'warning' end,
       'Required on the website of a limited company (Companies Act 2006). Advisory here because a sole trader has none.',
       '/admin/settings/', array[]::text[]),
    ('registered_address',
       case when coalesce(trim(p.registered_address),'') <> '' then 'complete' else 'incomplete' end,
       'Statutory business address.', '/admin/settings/', array['arm_gates','store_open']),
    ('public_contact_email',
       case when public.launch_fact_email_valid(p.public_contact_email) then 'complete' else 'incomplete' end,
       'A valid address customers can reach.', '/admin/settings/', array['arm_gates','store_open']),
    ('privacy_contact_email',
       case when public.launch_fact_email_valid(p.privacy_contact_email) then 'complete' else 'incomplete' end,
       'A valid address for data-protection requests.', '/admin/settings/', array['arm_gates','store_open']),
    ('public_telephone',
       case when public.launch_fact_phone_valid(p.public_telephone)
                  or coalesce(p.telephone_alternative_ok, false)
            then 'complete' else 'incomplete' end,
       'A valid telephone number, or an explicit decision that another channel serves instead.',
       '/admin/settings/', array['arm_gates','store_open']),
    ('canonical_url',
       case when public.launch_fact_https_valid(p.canonical_url) then 'complete' else 'incomplete' end,
       'A valid HTTPS address for canonical links and receipts.', '/admin/settings/',
       array['arm_gates','store_open']),
    ('vat_state_confirmed',
       case when coalesce(p.vat_state_confirmed, false) then 'complete' else 'incomplete' end,
       'The VAT position has been stated deliberately rather than left unset.', '/admin/settings/',
       array['arm_gates','store_open']),
    ('receipt_identity_footer',
       case when coalesce(trim(p.receipt_identity_footer),'') <> '' then 'complete' else 'incomplete' end,
       'The identity line printed on every receipt.', '/admin/settings/', array['arm_gates','store_open']),
    ('notification_recipient',
       case when public.launch_fact_email_valid(p.notification_recipient) then 'complete' else 'incomplete' end,
       'A valid address where public form submissions are delivered. Blocks form acceptance only.',
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

revoke all on function public.launch_blocking_reasons(public.launch_settings) from public, anon;
grant execute on function public.launch_blocking_reasons(public.launch_settings) to authenticated;

comment on function public.launch_blocking_reasons(public.launch_settings) is
  'T13.3.10: the single candidate-aware launch-readiness definition. Contact facts count as complete only when their format is usable; malformed non-empty values fail closed.';

-- Extend the structural acceptance proof for this migration.
do $shape_acceptance$
begin
  if public.launch_fact_email_valid('not-an-email') then
    raise exception 't13310_public_boundary_cleanup: malformed e-mail accepted';
  end if;
  if public.launch_fact_https_valid('http://example.com')
     or public.launch_fact_https_valid('https://localhost/')
     or public.launch_fact_https_valid('https://192.168.1.5/')
     or public.launch_fact_https_valid('https://milkpop.uk/admin/')
     or not public.launch_fact_https_valid('https://milkpop.uk/') then
    raise exception 't13310_public_boundary_cleanup: canonical URL shape validation failed';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.launch_settings'::regclass
       and tgname = 'trg_launch_settings_validate_shape'
       and not tgisinternal
  ) then
    raise exception 't13310_public_boundary_cleanup: launch-fact validation trigger absent';
  end if;
end
$shape_acceptance$;
