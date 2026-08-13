-- ============================================================================
-- MILK POP — T13.3.20 FINAL AUDIT CLOSURE
-- Append-only and idempotent. Adds two small database invariants found during
-- the final whole-tree audit without changing the public site or staff UX.
-- ============================================================================

begin;

-- 1. Concurrent document-deletion retries are idempotent.
-- A second worker may pass the first tombstone check, wait on the document row,
-- then find that the first worker has deleted it. Re-check the tombstone after
-- the lock wait before reporting a false document_not_found outcome.
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
 if not found then
   select * into v_existing from public.staff_document_tombstones where document_id=p_document_id;
   if found then return jsonb_build_object('ok',true,'alreadyFinalized',true,'deletedAt',v_existing.deleted_at); end if;
   raise exception 'document_not_found';
 end if;
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

-- 2. Ended employment is terminal until a deliberate re-hire clears ended_at.
-- This closes the narrow race where an enable request is claimed immediately
-- before an owner ends employment and the executor later attempts status=active.
-- Existing inconsistent rows are normalised once under the migration owner's
-- lock. User triggers are disabled only for this bounded status correction;
-- the transaction restores them automatically if any statement fails.
alter table public.staff_profiles disable trigger user;
update public.staff_profiles
   set status='disabled', updated_at=clock_timestamp()
 where ended_at is not null and coalesce(status,'active') <> 'disabled';
alter table public.staff_profiles enable trigger user;

create or replace function public.enforce_ended_staff_disabled()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.ended_at is not null and coalesce(new.status,'active') <> 'disabled' then
    raise exception 'ended_staff_must_remain_disabled' using errcode='check_violation';
  end if;
  return new;
end $$;
revoke all on function public.enforce_ended_staff_disabled() from public,anon,authenticated;

drop trigger if exists trg_staff_profiles_ended_disabled on public.staff_profiles;
create trigger trg_staff_profiles_ended_disabled
before insert or update of ended_at,status on public.staff_profiles
for each row execute function public.enforce_ended_staff_disabled();

-- Executable migration self-checks.
do $acceptance$ begin
 if to_regprocedure('public.finalize_staff_document_deletion(text,uuid,text,text)') is null then
   raise exception 't13320: document finalizer absent';
 end if;
 if position('staff_document_tombstones' in pg_get_functiondef('public.finalize_staff_document_deletion(text,uuid,text,text)'::regprocedure))=0 then
   raise exception 't13320: document finalizer lacks tombstone recheck';
 end if;
 if to_regprocedure('public.enforce_ended_staff_disabled()') is null then
   raise exception 't13320: ended-staff invariant absent';
 end if;
 if not exists(
   select 1 from pg_trigger
   where tgrelid='public.staff_profiles'::regclass
     and tgname='trg_staff_profiles_ended_disabled'
     and not tgisinternal
 ) then
   raise exception 't13320: ended-staff trigger absent';
 end if;
 if exists(select 1 from public.staff_profiles where ended_at is not null and coalesce(status,'active') <> 'disabled') then
   raise exception 't13320: existing ended staff remain enabled';
 end if;
end $acceptance$;

commit;
