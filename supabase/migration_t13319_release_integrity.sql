-- ============================================================================
-- MILK POP — T13.3.19 RELEASE INTEGRITY CLOSURE
-- Append-only and idempotent. Closes the bounded trust-boundary defects found
-- after T13.3.18 without changing stable public or financial architecture.
-- ============================================================================

-- 1. TIMESHEETS: immutable factual rows and server-owned decisions.
drop policy if exists clock_update_mgr on public.clock_history;
revoke insert, update, delete on public.clock_history from authenticated;
grant select on public.clock_history to authenticated;

create or replace function public.protect_clock_history_facts()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if row(new.employee_id,new.employee_name,new.date,new.clock_in,new.clock_out,
         new.break_duration_minutes,new.total_decimal_hours,new.notes,new.created_at)
     is distinct from
     row(old.employee_id,old.employee_name,old.date,old.clock_in,old.clock_out,
         old.break_duration_minutes,old.total_decimal_hours,old.notes,old.created_at) then
    raise exception 'clock_facts_are_immutable' using errcode='42501';
  end if;
  if coalesce(new.approved,false) and coalesce(new.rejected,false) then
    raise exception 'timesheet_decision_conflict' using errcode='check_violation';
  end if;
  if (coalesce(new.approved,false) or coalesce(new.rejected,false))
     and (nullif(trim(coalesce(new.approved_by,'')),'') is null or new.approved_at is null) then
    raise exception 'timesheet_decision_missing_actor' using errcode='check_violation';
  end if;
  if not coalesce(new.approved,false) and not coalesce(new.rejected,false)
     and (new.approved_by is not null or new.approved_at is not null) then
    raise exception 'pending_timesheet_has_decision_facts' using errcode='check_violation';
  end if;
  if (coalesce(old.approved,false) or coalesce(old.rejected,false))
     and row(new.approved,new.rejected,new.approved_by,new.approved_at)
         is distinct from row(old.approved,old.rejected,old.approved_by,old.approved_at) then
    raise exception 'timesheet_decision_is_terminal' using errcode='42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_clock_history_facts_immutable on public.clock_history;
create trigger trg_clock_history_facts_immutable before update on public.clock_history
for each row execute function public.protect_clock_history_facts();

alter table public.clock_history drop constraint if exists clock_history_decision_exclusive;
alter table public.clock_history add constraint clock_history_decision_exclusive
  check (not (coalesce(approved,false) and coalesce(rejected,false))) not valid;
alter table public.clock_history drop constraint if exists clock_history_decision_actor_complete;
alter table public.clock_history add constraint clock_history_decision_actor_complete check (
  (not coalesce(approved,false) and not coalesce(rejected,false) and approved_by is null and approved_at is null)
  or ((coalesce(approved,false) or coalesce(rejected,false))
      and nullif(trim(coalesce(approved_by,'')),'') is not null and approved_at is not null)
) not valid;

create or replace function public.decide_timesheets(p_ids text[], p_decision text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor_id text := public.current_staff_id();
  v_actor_name text; v_actor_role text; v_ids text[]; v_expected integer; v_locked integer; v_changed jsonb;
begin
  if not public.is_manager_or_owner() then raise exception 'not_permitted' using errcode='42501'; end if;
  if p_decision not in ('approve','reject') then raise exception 'invalid_timesheet_decision' using errcode='invalid_parameter_value'; end if;
  select coalesce(array_agg(distinct trim(x)),'{}') into v_ids
    from unnest(coalesce(p_ids,'{}')) x where nullif(trim(x),'') is not null;
  v_expected := coalesce(array_length(v_ids,1),0);
  if v_expected=0 or v_expected>500 then raise exception 'invalid_timesheet_selection' using errcode='invalid_parameter_value'; end if;
  select sp.name,sp.role::text into v_actor_name,v_actor_role from public.staff_profiles sp where sp.id=v_actor_id;
  if not found then raise exception 'not_staff' using errcode='42501'; end if;
  perform 1 from public.clock_history ch
   where ch.id=any(v_ids) and not coalesce(ch.approved,false) and not coalesce(ch.rejected,false)
     and ch.employee_id is distinct from v_actor_id
     and (public.is_owner() or exists(select 1 from public.staff_profiles target
          where target.id=ch.employee_id and target.store_id=public.current_staff_store()))
   for update;
  get diagnostics v_locked=row_count;
  if v_locked<>v_expected then raise exception 'timesheet_stale_or_out_of_scope' using errcode='40001'; end if;
  with changed as (
    update public.clock_history ch set approved=(p_decision='approve'), rejected=(p_decision='reject'),
      approved_by=coalesce(nullif(trim(v_actor_name),''),v_actor_id), approved_at=clock_timestamp(), updated_at=clock_timestamp()
    where ch.id=any(v_ids) returning ch.*
  ) select coalesce(jsonb_agg(to_jsonb(changed) order by changed.date,changed.clock_in),'[]'::jsonb) into v_changed from changed;
  insert into public.activity_log(actor_auth_id,actor_staff_id,actor_name,actor_role,action,target_kind,target_ref,outcome,detail)
  values(auth.uid(),v_actor_id,coalesce(v_actor_name,''),coalesce(v_actor_role,''),'timesheet.'||p_decision,
         'clock_history',array_to_string(v_ids,','),'ok',format('%s timesheet(s)',v_expected));
  return jsonb_build_object('ok',true,'decision',p_decision,'rows',v_changed);
end $$;
revoke all on function public.decide_timesheets(text[],text) from public,anon;
grant execute on function public.decide_timesheets(text[],text) to authenticated;

-- Generic publication remains available for payslips only.
create or replace function public.apply_collection_changes(p_table text,p_upserts jsonb,p_delete_ids text[])
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v_pk text; v_row jsonb; v_cols text; v_sets text; v_del text[]; v_final jsonb; v_count int; v_hit int;
begin
  v_pk:=case p_table when 'payslips' then 'id' else null end;
  if v_pk is null then raise exception 'table_not_allowed'; end if;
  if p_upserts is null or jsonb_typeof(p_upserts)<>'array' then raise exception 'rows_must_be_array'; end if;
  if jsonb_array_length(p_upserts)>2000 or coalesce(array_length(p_delete_ids,1),0)>2000 then raise exception 'too_many_rows'; end if;
  v_count:=jsonb_array_length(p_upserts);
  select coalesce(array_agg(x),'{}') into v_del from unnest(coalesce(p_delete_ids,'{}')) x where nullif(x,'') is not null;
  if exists(select 1 from jsonb_array_elements(p_upserts) e where not(e.value?v_pk) or coalesce(e.value->>v_pk,'')='') then raise exception 'row_missing_primary_key'; end if;
  if exists(select 1 from jsonb_array_elements(p_upserts) e where (e.value->>v_pk)=any(v_del)) then raise exception 'row_both_upserted_and_deleted'; end if;
  if array_length(v_del,1) is not null then execute format('delete from %I where %I = any($1)',p_table,v_pk) using v_del; end if;
  for v_row in select value from jsonb_array_elements(p_upserts) loop
    select string_agg(format('%I',k),', '),string_agg(case when k=v_pk then null else format('%I = src.%I',k,k) end,', ')
      into v_cols,v_sets from jsonb_object_keys(v_row) k;
    v_hit:=0;
    if v_sets is not null then
      execute format('update %I t set %s from jsonb_populate_record(null::%I,$1) src where t.%I=src.%I',p_table,v_sets,p_table,v_pk,v_pk) using v_row;
      get diagnostics v_hit=row_count;
    else execute format('select count(*) from %I where %I=$1',p_table,v_pk) into v_hit using(v_row->>v_pk); end if;
    if v_hit=0 then execute format('insert into %I (%s) select %s from jsonb_populate_record(null::%I,$1)',p_table,v_cols,v_cols,p_table) using v_row; end if;
  end loop;
  insert into public.audit_logs(id,operator_name,role,action,timestamp,module)
  select 'aud_'||replace(gen_random_uuid()::text,'-',''),coalesce(sp.name,public.current_staff_id()),coalesce(sp.role::text,''),
    'Applied changes to "payslips" ('||v_count||' upserted, '||coalesce(array_length(v_del,1),0)||' deleted)',now()::text,'Publishing (server)'
  from public.staff_profiles sp where sp.id=public.current_staff_id();
  if array_length(v_del,1) is not null then execute format('select count(*) from %I where %I=any($1)',p_table,v_pk) into v_hit using v_del;
    if v_hit>0 then raise exception 'requested_rows_not_deletable' using errcode='42501'; end if; end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(t)),''[]''::jsonb) from %I t',p_table) into v_final;
  return v_final;
end $$;
revoke all on function public.apply_collection_changes(text,jsonb,text[]) from public;
grant execute on function public.apply_collection_changes(text,jsonb,text[]) to authenticated;

-- 2. Bounded anonymous rate buckets and atomic POS pairing.
create table if not exists public.anonymous_rate_buckets(
 scope text not null,ip_hash text not null,window_started_at timestamptz not null default now(),
 attempt_count integer not null default 0 check(attempt_count>=0),blocked_count integer not null default 0 check(blocked_count>=0),
 updated_at timestamptz not null default now(),primary key(scope,ip_hash),check(length(scope) between 1 and 64),check(ip_hash~'^[0-9a-f]{64}$'));
alter table public.anonymous_rate_buckets enable row level security;
revoke all on public.anonymous_rate_buckets from public,anon,authenticated;

create or replace function public.reserve_anonymous_rate(p_scope text,p_ip_hash text,p_limit integer,p_window_seconds integer default 3600)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_row public.anonymous_rate_buckets; v_now timestamptz:=clock_timestamp();
begin
 if nullif(trim(coalesce(p_scope,'')),'') is null or length(coalesce(p_scope,''))>64 or coalesce(p_ip_hash,'')!~'^[0-9a-f]{64}$' or p_limit<1 or p_limit>1000 or p_window_seconds<60 or p_window_seconds>86400 then
  raise exception 'invalid_rate_reservation' using errcode='invalid_parameter_value'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_scope||':'||p_ip_hash,0));
 select * into v_row from public.anonymous_rate_buckets where scope=p_scope and ip_hash=p_ip_hash for update;
 if not found then insert into public.anonymous_rate_buckets(scope,ip_hash,window_started_at,attempt_count,updated_at) values(p_scope,p_ip_hash,v_now,1,v_now) returning * into v_row;
  return jsonb_build_object('ok',true,'remaining',p_limit-1,'resetAt',v_now+make_interval(secs=>p_window_seconds)); end if;
 if v_row.window_started_at+make_interval(secs=>p_window_seconds)<=v_now then
  update public.anonymous_rate_buckets set window_started_at=v_now,attempt_count=1,blocked_count=0,updated_at=v_now where scope=p_scope and ip_hash=p_ip_hash returning * into v_row;
  return jsonb_build_object('ok',true,'remaining',p_limit-1,'resetAt',v_now+make_interval(secs=>p_window_seconds)); end if;
 if v_row.attempt_count>=p_limit then update public.anonymous_rate_buckets set blocked_count=least(blocked_count::bigint+1,2147483647)::integer,updated_at=v_now where scope=p_scope and ip_hash=p_ip_hash;
  return jsonb_build_object('ok',false,'error','rate_limited','remaining',0,'resetAt',v_row.window_started_at+make_interval(secs=>p_window_seconds)); end if;
 update public.anonymous_rate_buckets set attempt_count=attempt_count+1,updated_at=v_now where scope=p_scope and ip_hash=p_ip_hash returning * into v_row;
 return jsonb_build_object('ok',true,'remaining',greatest(0,p_limit-v_row.attempt_count),'resetAt',v_row.window_started_at+make_interval(secs=>p_window_seconds));
end $$;
revoke all on function public.reserve_anonymous_rate(text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.reserve_anonymous_rate(text,text,integer,integer) to service_role;

create or replace function public.pos_pair_attempt(p_ip_hash text,p_code_hash text,p_installation_id text,p_device jsonb,p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_rate jsonb; v_pair jsonb;
begin
 if coalesce(p_ip_hash,'')!~'^[0-9a-f]{64}$' or coalesce(p_code_hash,'')!~'^[0-9a-f]{64}$' or length(trim(coalesce(p_installation_id,''))) not between 1 and 128
  or jsonb_typeof(coalesce(p_device,'{}'::jsonb))<>'object' or length(coalesce(p_device->>'deviceName',''))>120
  or length(coalesce(p_device->>'deviceCode',''))>64 or length(coalesce(p_device->>'storeCode',''))>64
  or length(coalesce(p_device->>'appVersion',''))>64 or coalesce(nullif(p_device->>'schemaVersion','')::integer,0) not between 0 and 100000
 then return jsonb_build_object('ok',false,'error','invalid_request'); end if;
 v_rate:=public.reserve_anonymous_rate('pos_pair',p_ip_hash,p_limit,3600);
 if coalesce((v_rate->>'ok')::boolean,false) is not true then return jsonb_build_object('ok',false,'error','rate_limited','resetAt',v_rate->>'resetAt'); end if;
 v_pair:=public.pos_complete_pairing(p_code_hash,trim(p_installation_id),p_device);
 if v_pair is null then return jsonb_build_object('ok',false,'error','code_not_accepted'); end if;
 return jsonb_build_object('ok',true,'pairing',v_pair);
exception when invalid_text_representation or numeric_value_out_of_range then return jsonb_build_object('ok',false,'error','invalid_request');
end $$;
revoke all on function public.pos_pair_attempt(text,text,text,jsonb,integer) from public,anon,authenticated;
grant execute on function public.pos_pair_attempt(text,text,text,jsonb,integer) to service_role;

-- 3. E-mail reservation and actor truth.
drop function if exists public.reserve_email_send(text,text,text,text,text,integer,integer);
drop function if exists public.reserve_email_send(text,text,text,text,text,text,integer,integer);
create or replace function public.reserve_email_send(
 p_actor_auth_id uuid,p_template_id text,p_recipient_kind text,p_recipient_ref text,p_recipient_email text,p_subject text,p_caller_limit integer default 20,p_recipient_limit integer default 10)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_staff public.staff_profiles; v_email text:=lower(trim(coalesce(p_recipient_email,'')));
 v_caller_count integer;v_recipient_count integer;v_id uuid;v_lock_a bigint;v_lock_b bigint;
begin
 if p_actor_auth_id is null then raise exception 'invalid_email_actor' using errcode='invalid_parameter_value'; end if;
 select * into v_staff from public.staff_profiles where auth_id=p_actor_auth_id and status='active' and ended_at is null;
 if not found then raise exception 'not_active_staff' using errcode='42501'; end if;
 if nullif(trim(coalesce(p_template_id,'')),'') is null or length(p_template_id)>120 or nullif(v_email,'') is null or length(v_email)>320
  or length(coalesce(p_recipient_kind,''))>40 or length(coalesce(p_recipient_ref,''))>160 or length(coalesce(p_subject,''))>300
  or p_caller_limit not between 1 and 500 or p_recipient_limit not between 1 and 500 then raise exception 'invalid_email_reservation' using errcode='invalid_parameter_value'; end if;
 v_lock_a:=hashtextextended('email:caller:'||p_actor_auth_id::text,0);v_lock_b:=hashtextextended('email:recipient:'||v_email,0);
 perform pg_advisory_xact_lock(least(v_lock_a,v_lock_b)); if v_lock_b<>v_lock_a then perform pg_advisory_xact_lock(greatest(v_lock_a,v_lock_b)); end if;
 select count(*) into v_caller_count from public.email_log where sent_by_auth_id=p_actor_auth_id and created_at>=now()-interval '1 hour' and status in('sending','sent','provider_error');
 if v_caller_count>=p_caller_limit then return jsonb_build_object('ok',false,'error','rate_limited_caller'); end if;
 select count(*) into v_recipient_count from public.email_log where recipient_email=v_email and created_at>=now()-interval '1 hour' and status in('sending','sent','provider_error');
 if v_recipient_count>=p_recipient_limit then return jsonb_build_object('ok',false,'error','rate_limited_recipient'); end if;
 insert into public.email_log(sent_by_auth_id,sent_by_staff_id,sent_by_name,sent_by_role,template_id,recipient_kind,recipient_ref,recipient_email,subject,status)
 values(p_actor_auth_id,v_staff.id,coalesce(v_staff.name,''),coalesce(v_staff.role::text,''),trim(p_template_id),trim(coalesce(p_recipient_kind,'')),nullif(trim(coalesce(p_recipient_ref,'')),''),v_email,left(coalesce(p_subject,''),300),'sending') returning id into v_id;
 return jsonb_build_object('ok',true,'logId',v_id);
end $$;
revoke all on function public.reserve_email_send(uuid,text,text,text,text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.reserve_email_send(uuid,text,text,text,text,text,integer,integer) to service_role;

-- 4. Staff-document deletion is reconciled through an atomic metadata
-- tombstone. Active application rows are never deleted unless the private
-- Storage object is confirmed absent first.
alter table public.staff_documents add column if not exists file_state text not null default 'active';
alter table public.staff_documents add column if not exists deletion_error text;
alter table public.staff_documents drop constraint if exists staff_documents_file_state_check;
alter table public.staff_documents add constraint staff_documents_file_state_check
  check(file_state in('active','deletion_pending','missing'));
create index if not exists staff_documents_file_state_idx on public.staff_documents(file_state,updated_at);

create table if not exists public.staff_document_tombstones(
 document_id text primary key,
 employee_id text,
 store_id text,
 name text not null default '',
 category text not null default '',
 deleted_by_auth_id uuid,
 deleted_by_staff_id text not null,
 deleted_by_name text not null default '',
 deleted_at timestamptz not null default now(),
 source_snapshot jsonb not null
);
alter table public.staff_document_tombstones enable row level security;
revoke all on public.staff_document_tombstones from public,anon,authenticated;

-- Owners can see a rare pending/missing reconciliation row and retry deletion;
-- managers and employees only see live documents.
drop policy if exists docs_select_self_or_mgr on public.staff_documents;
create policy docs_select_self_or_mgr on public.staff_documents for select to authenticated using(
 is_owner() or (file_state='active' and (
   employee_id=current_staff_id()
   or (is_manager_or_owner() and exists(
     select 1 from public.staff_profiles sp
      where sp.id=staff_documents.employee_id and sp.store_id=current_staff_store()
   ))
 ))
);
drop policy if exists docs_update_mgr on public.staff_documents;
create policy docs_update_mgr on public.staff_documents for update to authenticated using(
 file_state='active' and is_manager_or_owner()
 and (is_owner() or exists(select 1 from public.staff_profiles sp
   where sp.id=staff_documents.employee_id and sp.store_id=current_staff_store()))
) with check(
 file_state='active' and is_manager_or_owner()
 and (is_owner() or exists(select 1 from public.staff_profiles sp
   where sp.id=staff_documents.employee_id and sp.store_id=current_staff_store()))
);

create or replace function public.finalize_staff_document_deletion(
 p_document_id text,p_actor_auth_id uuid,p_actor_staff_id text,p_actor_name text
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_doc public.staff_documents;v_existing public.staff_document_tombstones;
begin
 if nullif(trim(coalesce(p_document_id,'')),'') is null
    or nullif(trim(coalesce(p_actor_staff_id,'')),'') is null then
   raise exception 'invalid_document_deletion' using errcode='invalid_parameter_value';
 end if;
 select * into v_existing from public.staff_document_tombstones where document_id=p_document_id;
 if found then return jsonb_build_object('ok',true,'alreadyFinalized',true,'deletedAt',v_existing.deleted_at); end if;
 select * into v_doc from public.staff_documents where id=p_document_id for update;
 if not found then raise exception 'document_not_found'; end if;
 if v_doc.file_state not in('deletion_pending','missing') then raise exception 'document_not_claimed' using errcode='object_not_in_prerequisite_state'; end if;
 insert into public.staff_document_tombstones(
   document_id,employee_id,store_id,name,category,deleted_by_auth_id,
   deleted_by_staff_id,deleted_by_name,source_snapshot
 ) values(
   v_doc.id,v_doc.employee_id,v_doc.store_id,coalesce(v_doc.name,''),coalesce(v_doc.category,''),p_actor_auth_id,
   p_actor_staff_id,coalesce(p_actor_name,''),to_jsonb(v_doc)
 );
 insert into public.activity_log(
   actor_auth_id,actor_staff_id,actor_name,actor_role,action,target_kind,target_ref,outcome,detail
 ) values(
   p_actor_auth_id,p_actor_staff_id,coalesce(p_actor_name,''),'owner','doc_delete',
   'staff_document',v_doc.id,'granted','private object confirmed absent; metadata tombstone retained'
 );
 delete from public.staff_documents where id=v_doc.id;
 return jsonb_build_object('ok',true,'alreadyFinalized',false,'deletedAt',clock_timestamp());
end $$;
revoke all on function public.finalize_staff_document_deletion(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.finalize_staff_document_deletion(text,uuid,text,text) to service_role;

-- 5. Account lifecycle actions use the existing claimed recovery model.
alter table public.admin_recovery_intents drop constraint if exists admin_recovery_intents_action_check;
alter table public.admin_recovery_intents add constraint admin_recovery_intents_action_check
  check (action in ('reset_mfa','revoke_sessions','ban_leaver','disable_account','enable_account'));

create or replace function public.recovery_action_permitted(p_target text,p_action text,p_reason text default '')
returns text language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_actor text:=public.current_staff_id();v_target public.staff_profiles;
begin
 if p_action not in('reset_mfa','revoke_sessions','ban_leaver','disable_account','enable_account') then return 'unknown_action'; end if;
 if v_actor is null then return 'not_staff'; end if;
 select * into v_target from public.staff_profiles where id=p_target; if not found then return 'target_not_found'; end if;
 if p_action in('disable_account','enable_account') then
  if not public.is_owner() then return 'not_permitted'; end if; if p_target=v_actor then return 'self_action_forbidden'; end if;
 elsif p_action='reset_mfa' then if not public.is_owner() then return 'not_permitted'; end if; if p_target=v_actor then return 'self_reset_forbidden'; end if;
 else
  if not public.is_manager_or_owner() then return 'not_permitted'; end if;
  if not public.is_owner() then if v_target.role in('store_manager','owner') then return 'not_permitted'; end if;
   if v_target.store_id is distinct from public.current_staff_store() then return 'target_other_store'; end if; end if;
 end if;
 if p_action='ban_leaver' and v_target.ended_at is null then return 'target_still_employed'; end if;
 if p_action='enable_account' and v_target.ended_at is not null then return 'target_employment_ended'; end if;
 if p_action='revoke_sessions' and coalesce(trim(p_reason),'')='' then return 'reason_required'; end if;
 return null;
end $$;
revoke all on function public.recovery_action_permitted(text,text,text) from public,anon;
grant execute on function public.recovery_action_permitted(text,text,text) to authenticated;

-- Claim remains atomic and re-authorised. Profile-only disable/enable is a
-- valid truthful outcome when the employee has no Auth account yet; destructive
-- Auth-only actions still require a linked account.
create or replace function public.claim_recovery_intent(p_intent_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor text:=public.current_staff_id();v_intent public.admin_recovery_intents;v_target public.staff_profiles;v_deny text;
begin
 if v_actor is null then return jsonb_build_object('ok',false,'error','not_staff'); end if;
 select * into v_intent from public.admin_recovery_intents where id=p_intent_id for update;
 if not found then return jsonb_build_object('ok',false,'error','intent_not_found'); end if;
 if v_intent.consumed_at is not null then return jsonb_build_object('ok',false,'error','intent_already_consumed'); end if;
 if now()-v_intent.created_at>interval '10 minutes' then
  update public.admin_recovery_intents set consumed_at=now(),result='expired' where id=p_intent_id;
  return jsonb_build_object('ok',false,'error','intent_expired');
 end if;
 if v_intent.requested_by is distinct from v_actor then return jsonb_build_object('ok',false,'error','not_requester'); end if;
 v_deny:=public.recovery_action_permitted(v_intent.target_staff_id,v_intent.action,v_intent.reason);
 if v_deny is not null then
  update public.admin_recovery_intents set consumed_at=now(),result='refused:'||v_deny where id=p_intent_id;
  return jsonb_build_object('ok',false,'error',v_deny);
 end if;
 select * into v_target from public.staff_profiles where id=v_intent.target_staff_id;
 if v_target.auth_id is null and v_intent.action not in('disable_account','enable_account') then
  update public.admin_recovery_intents set consumed_at=now(),result='no_auth_account' where id=p_intent_id;
  return jsonb_build_object('ok',false,'error','target_has_no_auth_account');
 end if;
 update public.admin_recovery_intents set consumed_at=now(),result='claimed' where id=p_intent_id;
 return jsonb_build_object('ok',true,'action',v_intent.action,'target_staff_id',v_intent.target_staff_id,
   'target_auth_id',v_target.auth_id,'requested_by',v_intent.requested_by);
end $$;
revoke all on function public.claim_recovery_intent(text) from public,anon;
grant execute on function public.claim_recovery_intent(text) to authenticated;

-- 6. Public-form rejections are response-only; only accepted submissions
-- consume the durable form evidence budget.
create or replace function public.submit_public_form_core(p_kind text, p_row jsonb, p_idempotency_key uuid, p_request_hash text, p_ip_hash text) RETURNS jsonb
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
        return jsonb_build_object('ok', false, 'error', 'idempotency_conflict');
      end if;
      return jsonb_build_object('ok', true, 'submission_id', v_existing, 'duplicate', true);
    end if;
  end if;

  select count(*) into v_recent
    from form_submission_log
   where ip_hash = p_ip_hash
     and status = 'accepted'
     and created_at >= now() - interval '1 hour';
  if v_recent >= v_rate_limit then
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


revoke all on function public.submit_public_form_core(text,jsonb,uuid,text,text) from public,anon,authenticated;

-- 7. Operational retention joins the existing scheduled heartbeat sweep.
create index if not exists pos_pair_attempts_created_at_idx on public.pos_pair_attempts(created_at);
create index if not exists cv_upload_ip_log_created_at_idx on public.cv_upload_ip_log(created_at);
do $retention_entity$ begin
 if exists(select 1 from pg_constraint where conrelid='public.retention_runs'::regclass and conname='retention_runs_entity_ck') then alter table public.retention_runs drop constraint retention_runs_entity_ck; end if;
 alter table public.retention_runs add constraint retention_runs_entity_ck check(entity in('contact_messages','franchise_inquiries','job_applications','cv_orphans','cv_links','form_submission_log','pos_pair_attempts','cv_upload_ip_log','anonymous_rate_buckets'));
end $retention_entity$;
create or replace function public.retention_purge_release_integrity(retain interval default interval '30 days') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_cutoff timestamptz:=now()-retain;v_bucket_cutoff timestamptz:=now()-interval '7 days';v_pos integer;v_cv integer;v_buckets integer;
begin
 if retain is null or retain<interval '24 hours' then raise exception 'operational retention must be at least 24 hours' using errcode='invalid_parameter_value'; end if;
 delete from public.pos_pair_attempts where created_at<v_cutoff;get diagnostics v_pos=row_count;insert into public.retention_runs(entity,cutoff,rows_deleted) values('pos_pair_attempts',v_cutoff,v_pos);
 delete from public.cv_upload_ip_log where created_at<v_cutoff;get diagnostics v_cv=row_count;insert into public.retention_runs(entity,cutoff,rows_deleted) values('cv_upload_ip_log',v_cutoff,v_cv);
 delete from public.anonymous_rate_buckets where updated_at<v_bucket_cutoff;get diagnostics v_buckets=row_count;insert into public.retention_runs(entity,cutoff,rows_deleted) values('anonymous_rate_buckets',v_bucket_cutoff,v_buckets);
 return jsonb_build_object('posPairAttemptsDeleted',v_pos,'cvUploadLogsDeleted',v_cv,'rateBucketsDeleted',v_buckets);
end $$;
revoke all on function public.retention_purge_release_integrity(interval) from public,anon,authenticated,service_role;
create or replace function public.run_retention_sweep(
 p_contact_retain interval default interval '24 months',p_franchise_retain interval default interval '24 months',
 p_applications_retain interval default interval '6 months',p_orphan_grace interval default interval '48 hours') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_contact integer;v_franchise integer;v_apps jsonb;v_orphans integer;v_form_log integer;v_integrity jsonb;v_result jsonb;
begin
 v_contact:=retention_purge_contact_messages(p_contact_retain);v_franchise:=retention_purge_franchise_inquiries(p_franchise_retain);
 v_apps:=retention_purge_job_applications(p_applications_retain);v_orphans:=retention_enqueue_orphan_cvs(p_orphan_grace);
 v_form_log:=retention_purge_form_submission_log(interval '30 days');v_integrity:=retention_purge_release_integrity(interval '30 days');
 v_result:=jsonb_build_object('ok',true,'contactMessagesDeleted',v_contact,'franchiseInquiriesDeleted',v_franchise,'jobApplications',v_apps,'orphanCvJobsEnqueued',v_orphans,'formSubmissionLogDeleted',v_form_log,'releaseIntegrity',v_integrity);
 perform record_heartbeat('retention-sweep','ok',left(v_result::text,500));return v_result;
exception when others then begin perform record_heartbeat('retention-sweep','failed',left(sqlstate||': '||sqlerrm,500));exception when others then null;end;
 return jsonb_build_object('ok',false,'errorCode',sqlstate,'error',left(sqlerrm,300));
end $$;
revoke all on function public.run_retention_sweep(interval,interval,interval,interval) from public,anon,authenticated,service_role;
comment on function public.run_retention_sweep(interval,interval,interval,interval) is 'T13.3.19 scheduled retention including bounded release-integrity evidence; heartbeat preserved.';

do $acceptance$ begin
 if to_regprocedure('public.decide_timesheets(text[],text)') is null then raise exception 't13319: decide_timesheets absent'; end if;
 if to_regprocedure('public.pos_pair_attempt(text,text,text,jsonb,integer)') is null then raise exception 't13319: atomic pos pairing absent'; end if;
 if to_regprocedure('public.reserve_email_send(uuid,text,text,text,text,text,integer,integer)') is null then raise exception 't13319: email reservation absent'; end if;
 if has_function_privilege('authenticated','public.reserve_email_send(uuid,text,text,text,text,text,integer,integer)','EXECUTE') then raise exception 't13319: authenticated can forge email reservations'; end if;
 if not has_function_privilege('service_role','public.reserve_email_send(uuid,text,text,text,text,text,integer,integer)','EXECUTE') then raise exception 't13319: service email reservation grant absent'; end if;
 if to_regprocedure('public.finalize_staff_document_deletion(text,uuid,text,text)') is null then raise exception 't13319: document tombstone finalizer absent'; end if;
 if exists(select 1 from pg_policy where polrelid='public.clock_history'::regclass and polname='clock_update_mgr') then raise exception 't13319: broad clock update remains'; end if;
 if has_table_privilege('authenticated','public.clock_history','UPDATE') then raise exception 't13319: clock history update grant remains'; end if;
 if not exists(select 1 from pg_trigger where tgrelid='public.clock_history'::regclass and tgname='trg_clock_history_facts_immutable' and not tgisinternal) then raise exception 't13319: clock immutability trigger absent'; end if;
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='staff_documents' and column_name='file_state') then raise exception 't13319: document reconciliation state absent'; end if;
end $acceptance$;
