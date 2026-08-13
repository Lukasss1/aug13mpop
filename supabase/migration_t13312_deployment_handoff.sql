-- ============================================================================
-- Milk Pop T13.3.12 — deployment-handoff defaults
--
-- Fresh and upgraded installations must not invent a registered legal entity.
-- The public website URL is a real HTTPS root URL; the registered legal name
-- remains blank until the owner enters verified business information.
-- ============================================================================

begin;

alter table public.site_settings
  alter column legal_name set default '',
  alter column website_url set default 'https://milkpop.uk';

comment on column public.site_settings.legal_name is
  'Registered legal entity, if applicable. Blank until verified by the owner; never inferred from the public brand.';
comment on column public.site_settings.website_url is
  'Canonical public HTTPS root URL used for display and generated public content.';

-- Acceptance: bind the intended defaults without rewriting owner-entered rows.
do $$
declare
  v_legal text;
  v_website text;
begin
  select pg_get_expr(d.adbin, d.adrelid)
    into v_legal
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.site_settings'::regclass
     and a.attname = 'legal_name';

  select pg_get_expr(d.adbin, d.adrelid)
    into v_website
    from pg_attrdef d
    join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.site_settings'::regclass
     and a.attname = 'website_url';

  if v_legal is distinct from quote_literal('') || '::text' then
    raise exception 'T13.3.12 acceptance failed: legal_name default is %', v_legal;
  end if;
  if v_website is distinct from quote_literal('https://milkpop.uk') || '::text' then
    raise exception 'T13.3.12 acceptance failed: website_url default is %', v_website;
  end if;
end $$;

commit;
