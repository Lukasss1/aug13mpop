-- ============================================================================
-- MILK POP — T13.3.4 SHIFT-COVER REASON HONESTY
--
-- The browser already requires a genuine reason before posting cover, but the
-- server RPC still replaced a blank value with an invented "schedule clash".
-- Direct callers could therefore create an operational statement the employee
-- never made. Re-issue the atomic row-locked RPC and fail closed on blank text.
-- ============================================================================

create or replace function request_shift_cover(p_shift_id text, p_message text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff text := current_staff_id();
  v_store text := current_staff_store();
  v_me staff_profiles%rowtype;
  v_shift work_shifts%rowtype;
  v_key text;
  v_covers jsonb;
  v_message text;
begin
  if v_staff is null then raise exception 'not_staff' using errcode = '42501'; end if;
  if v_store is null or btrim(v_store) = '' then raise exception 'store_assignment_required' using errcode = '42501'; end if;

  v_message := btrim(coalesce(p_message, ''));
  if length(v_message) < 3 then
    raise exception 'shift_cover_reason_required';
  end if;
  v_message := left(v_message, 500);

  select * into v_me from staff_profiles where id = v_staff;
  if v_me.id is null then raise exception 'not_staff' using errcode = '42501'; end if;

  select * into v_shift from work_shifts where id = p_shift_id for update;
  if v_shift.id is null then raise exception 'shift_not_found'; end if;
  if v_shift.store_id is distinct from v_store then raise exception 'wrong_store' using errcode = '42501'; end if;
  if v_shift.employee_id is distinct from v_staff then raise exception 'not_your_shift' using errcode = '42501'; end if;

  v_key := 'milkpop_shift_covers:' || v_store;
  insert into app_state (key, value, scope, owner_staff_id, store_id, updated_at)
  values (v_key, '{}'::jsonb, 'store', null, v_store, now())
  on conflict (key) do nothing;

  select value into v_covers from app_state where key = v_key for update;
  if v_covers is null or jsonb_typeof(v_covers) <> 'object' then v_covers := '{}'::jsonb; end if;

  v_covers := jsonb_set(
    v_covers,
    array[p_shift_id],
    jsonb_build_object(
      'requestedBy', coalesce(nullif(btrim(v_me.name), ''), v_staff),
      'requestedById', v_staff,
      'message', v_message,
      'date', clock_timestamp()
    ),
    true
  );

  update app_state set value = v_covers, updated_at = now() where key = v_key;
  return jsonb_build_object('ok', true, 'covers', v_covers, 'storeId', v_store);
end $$;

revoke all on function request_shift_cover(text, text) from public, anon;
grant execute on function request_shift_cover(text, text) to authenticated;

comment on function request_shift_cover(text, text) is
  'T13.3.4: atomically posts the caller own same-store shift cover request and requires the caller actual reason.';

do $$
begin
  if to_regprocedure('public.request_shift_cover(text,text)') is null then
    raise exception 't1334_cover_reason_honesty: function missing';
  end if;
end $$;
