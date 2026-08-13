-- ============================================================================
--  SMALL-BIZ CLOSURE — PUBLIC SITE CONFIGURATION (chain 90)           [P0-11]
-- ============================================================================
--
--  THE DEFECT (production-closure task, P0-11). The business's public
--  identity is split across TWO singletons with overlapping fields:
--
--      launch_settings  — legal_business_name, company_number,
--                         registered_address, public_contact_email,
--                         privacy_contact_email, public_telephone,
--                         canonical_url  (owner-only; Launch Facts editor)
--      site_settings    — legal_name, company_number, hq_address, email,
--                         gdpr_email, phone, website_url + brand/social/
--                         presentation  (anon-readable; Website Studio)
--
--  The public footer, contact surfaces and legal pages read site_settings,
--  while launch readiness verifies launch_settings — so readiness can be
--  green while the footer displays different (or empty) values. Two editable
--  copies of the same legal fact is the whole defect.
--
--  THE CORRECTION. One SAFE, READ-ONLY projection combining:
--    • authoritative legal/contact facts from launch_settings, falling back
--      per-field to site_settings while a launch fact is still blank
--      (coalesce(nullif(launch,''), site)) — so a site that has not completed
--      Launch Facts keeps working, and each fact flips to the authoritative
--      value the moment it is entered;
--    • brand, design, social and presentation values from site_settings.
--
--  OWNERSHIP STAYS SPLIT AND CLEAR: Launch Facts edits legal/operational
--  facts; Website Studio edits branding, visual content and social links.
--  Public consumers read THIS projection only.
--
--  COLUMN NAMES deliberately MATCH site_settings (legal_name, company_number,
--  hq_address, email, gdpr_email, phone, website_url) so the projection is a
--  DROP-IN read replacement: the browser repoints its site_settings singleton
--  pull via the established readTable mechanism (the WS6f stores pattern) and
--  the build-time SEO loader repoints its relation — no field remapping
--  anywhere, no second settings object for a consumer to pick wrongly.
--
--  DELIBERATELY NOT EXPOSED (private launch controls / notification config):
--  enforce_public_gates, notification_recipient, vat_state_confirmed,
--  customer_ack_enabled, telephone_alternative_ok, receipt_identity_footer,
--  updated_by. The acceptance block pins their absence by name.
--
--  SECURITY SHAPE (post chains 84–88): the view is a definer-side projection
--  like every *_public view — anon holds no read on launch_settings and never
--  gains one; the JOIN makes the view structurally non-auto-updatable, so the
--  chain-84 refusal trigger is not required (pg_relation_is_updatable = 0 is
--  asserted below); chain 87 stripped ambient default privileges, so the
--  explicit revoke+grant here is the complete privilege story.
-- ============================================================================

create or replace view public_site_configuration as
select
  s.id,
  coalesce(nullif(l.legal_business_name, ''), s.legal_name)    as legal_name,
  coalesce(nullif(l.company_number, ''),     s.company_number) as company_number,
  coalesce(nullif(l.registered_address, ''), s.hq_address)     as hq_address,
  coalesce(nullif(l.public_contact_email,''),s.email)          as email,
  coalesce(nullif(l.privacy_contact_email,''), s.gdpr_email)   as gdpr_email,
  coalesce(nullif(l.public_telephone, ''),   s.phone)          as phone,
  coalesce(nullif(l.canonical_url, ''),      s.website_url)    as website_url,
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
from site_settings s
left join launch_settings l on l.id = true
where s.id = 1;

comment on view public_site_configuration is
  'P0-11: the ONE public source of legal/contact truth. Legal facts come from launch_settings (per-field fallback to site_settings while blank); brand/social/presentation from site_settings. Read-only; private launch controls are never projected.';

-- Privilege story (explicit and complete — chain 87 removed ambient defaults,
-- so nothing arrives by inheritance; this is belt-and-braces symmetry with
-- chain 84's posture on the other projections).
revoke all on public_site_configuration from public;
revoke all on public_site_configuration from anon;
revoke all on public_site_configuration from authenticated;
grant select on public_site_configuration to anon, authenticated;

-- ============================================================================
--  ACCEPTANCE
-- ============================================================================
do $acceptance$
declare
  v_bad     text[];
  v_updatable int;
  v_priv    text;
  v_pairs   int;
begin
  /* 1. The view exists. */
  if to_regclass('public.public_site_configuration') is null then
    raise exception 'closure_public_config: view missing';
  end if;

  /* 2. Structurally read-only: a two-table join is not auto-updatable, so no
        INSTEAD OF refusal trigger is required (the chain-84 rule "a writable
        view must carry the refusing trigger, the rest are structurally
        unwritable" holds for this view by construction). */
  select pg_relation_is_updatable('public.public_site_configuration'::regclass, false)
    into v_updatable;
  if v_updatable <> 0 then
    raise exception
      'closure_public_config: view is auto-updatable (%) — it must be structurally read-only',
      v_updatable;
  end if;

  /* 3. Browser roles hold SELECT and nothing else. */
  foreach v_priv in array array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
    if has_table_privilege('anon', 'public.public_site_configuration', v_priv)
       or has_table_privilege('authenticated', 'public.public_site_configuration', v_priv) then
      raise exception 'closure_public_config: browser role holds % on the projection', v_priv;
    end if;
  end loop;
  if not has_table_privilege('anon', 'public.public_site_configuration', 'SELECT')
     or not has_table_privilege('authenticated', 'public.public_site_configuration', 'SELECT') then
    raise exception 'closure_public_config: browser SELECT grant missing';
  end if;

  /* 4. Private launch controls are NOT projected — pinned by name. */
  select array_agg(a.attname order by a.attname)
    into v_bad
  from pg_attribute a
  where a.attrelid = 'public.public_site_configuration'::regclass
    and a.attnum > 0 and not a.attisdropped
    and a.attname in ('enforce_public_gates','notification_recipient',
                      'vat_state_confirmed','customer_ack_enabled',
                      'telephone_alternative_ok','receipt_identity_footer',
                      'updated_by');
  if coalesce(array_length(v_bad, 1), 0) > 0 then
    raise exception
      'closure_public_config: private launch controls leaked into the projection: %',
      array_to_string(v_bad, ', ');
  end if;

  /* 5+6. MERGE-LOGIC PARITY, proven against the CURRENT data without
        mutating anything — but ONLY when a site_settings row exists. The
        baseline harness applies the chain WITHOUT the fresh-only seed (the
        Increment-1 rule: a chain-level migration must never assert seeded
        content), so an empty site_settings is a legitimate harness state and
        the view then legitimately returns zero rows. Wherever a settings row
        DOES exist (every seeded install and every live database), all seven
        legal/contact fields must equal coalesce(nullif(launch,''), site) —
        the exact rule the public footer displays — and the projection must
        be exactly one row. */
  select count(*) into v_pairs from site_settings where id = 1;
  if v_pairs = 1 then
    select count(*) into v_pairs
    from public_site_configuration v
    cross join site_settings s
    left join launch_settings l on l.id = true
    where s.id = 1
      and v.legal_name     = coalesce(nullif(l.legal_business_name, ''), s.legal_name)
      and v.company_number = coalesce(nullif(l.company_number, ''),     s.company_number)
      and v.hq_address     = coalesce(nullif(l.registered_address, ''), s.hq_address)
      and v.email          = coalesce(nullif(l.public_contact_email,''),s.email)
      and v.gdpr_email     = coalesce(nullif(l.privacy_contact_email,''), s.gdpr_email)
      and v.phone          = coalesce(nullif(l.public_telephone, ''),   s.phone)
      and v.website_url    = coalesce(nullif(l.canonical_url, ''),      s.website_url);
    if v_pairs <> 1 then
      raise exception
        'closure_public_config: merge parity failed — the projection does not equal coalesce(launch, site) for all seven fields (matching rows: %)',
        v_pairs;
    end if;
    select count(*) into v_pairs from public_site_configuration;
    if v_pairs <> 1 then
      raise exception 'closure_public_config: expected exactly one row, found %', v_pairs;
    end if;
  end if;

  /* 7. Anon still cannot read launch_settings itself — the projection is the
        only anonymous window onto those facts. */
  if has_table_privilege('anon', 'public.launch_settings', 'SELECT') then
    raise exception 'closure_public_config: anon gained SELECT on launch_settings';
  end if;
end
$acceptance$;
