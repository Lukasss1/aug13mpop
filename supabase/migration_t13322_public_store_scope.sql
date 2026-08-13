-- T13.3.22 — public website scope: store listing is independent from POS/trading setup.
--
-- A real store may be announced as `coming_soon` before tills, payment methods
-- or VAT configuration are commissioned. `setup_status` remains the fail-closed
-- trading gate; it is no longer the customer-locator publication gate.
-- APPEND-ONLY: no historical migration is edited.

begin;

create or replace view public.stores_public as
  select id, name, address, postcode, opening_hours, status, delivery_links,
         phone, email, image, coordinates, created_at, updated_at
    from public.stores
   where nullif(btrim(name), '') is not null
     and nullif(btrim(address), '') is not null
     and nullif(btrim(postcode), '') is not null
     and upper(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) not in
       ('N/A','NA','NONE','NULL','TBC','TBD','TO BE CONFIRMED','TO BE ANNOUNCED','COMING SOON','PLACEHOLDER','TEST','UNKNOWN','-','—')
     and upper(regexp_replace(btrim(address), '[[:space:]]+', ' ', 'g')) not in
       ('N/A','NA','NONE','NULL','TBC','TBD','TO BE CONFIRMED','TO BE ANNOUNCED','COMING SOON','PLACEHOLDER','TEST','UNKNOWN','-','—')
     and upper(regexp_replace(btrim(postcode), '[[:space:]]+', ' ', 'g')) not in
       ('N/A','NA','NONE','NULL','TBC','TBD','TO BE CONFIRMED','TO BE ANNOUNCED','COMING SOON','PLACEHOLDER','TEST','UNKNOWN','-','—');

revoke all on public.stores_public from public;
grant select on public.stores_public to anon, authenticated;
revoke select on table public.stores from anon;

comment on view public.stores_public is
  'Customer store locator: rows with a genuine name, address and postcode. Public open/closed/coming_soon status is independent from internal setup_status, which remains the POS/trading commissioning gate and is not exposed.';

do $acceptance$
declare
  v_cols text[];
  v_def text;
begin
  select array_agg(column_name order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'stores_public';

  if v_cols is distinct from array[
    'id','name','address','postcode','opening_hours','status','delivery_links',
    'phone','email','image','coordinates','created_at','updated_at'
  ]::text[] then
    raise exception 'T13.3.22 stores_public column contract mismatch: %', v_cols;
  end if;

  select pg_get_viewdef('public.stores_public'::regclass, true) into v_def;
  if position('setup_status' in lower(v_def)) > 0 then
    raise exception 'T13.3.22 stores_public still depends on setup_status';
  end if;
  -- PostgreSQL may qualify columns in pg_get_viewdef (for example
  -- btrim(stores.name)), so assert the filter ingredients rather than an
  -- unstable exact rendering of the expression.
  if position('btrim' in lower(v_def)) = 0
     or position('name' in lower(v_def)) = 0
     or position('address' in lower(v_def)) = 0
     or position('postcode' in lower(v_def)) = 0
     or position('regexp_replace' in lower(v_def)) = 0 then
    raise exception 'T13.3.22 stores_public is missing genuine-identity filters';
  end if;
  if has_table_privilege('anon', 'public.stores', 'select') then
    raise exception 'T13.3.22 base stores table is anonymously readable';
  end if;
  if not has_table_privilege('anon', 'public.stores_public', 'select') then
    raise exception 'T13.3.22 stores_public is not anonymously readable';
  end if;
end
$acceptance$;

commit;
