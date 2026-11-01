-- Creating an Auth identity through an accidentally enabled external signup must
-- not provision an application account or grant any content/storage permission.
revoke insert,delete on public.profiles from authenticated;
create function public.is_provisioned() returns boolean language sql stable security invoker set search_path='' as $$select exists(select 1 from public.profiles where user_id=(select auth.uid()))$$;
revoke all on function public.is_provisioned() from public,anon;
grant execute on function public.is_provisioned() to authenticated,service_role;
do $$declare t text;begin
 foreach t in array array['subjects','documents','document_pages','problems','problem_regions','concepts','problem_concepts','concept_questions','question_options','wrong_answers','study_sessions','solve_sessions','study_results','review_schedules']loop
 execute format('alter policy owner_access on public.%I using ((select auth.uid())=user_id and (select public.is_provisioned())) with check ((select auth.uid())=user_id and (select public.is_provisioned()))',t);
 end loop;end$$;
alter policy study_files_read on storage.objects using(bucket_id='study-files' and (storage.foldername(name))[1]=(select auth.uid())::text and (select public.is_provisioned()));
alter policy study_files_insert on storage.objects with check(bucket_id='study-files' and (storage.foldername(name))[1]=(select auth.uid())::text and (select public.is_provisioned()));
alter policy study_files_update on storage.objects using(bucket_id='study-files' and (storage.foldername(name))[1]=(select auth.uid())::text and (select public.is_provisioned())) with check(bucket_id='study-files' and (storage.foldername(name))[1]=(select auth.uid())::text and (select public.is_provisioned()));
alter policy study_files_delete on storage.objects using(bucket_id='study-files' and (storage.foldername(name))[1]=(select auth.uid())::text and (select public.is_provisioned()));

create or replace function public.finish_ai_job(p_user_id uuid,p_job_id uuid,p_lease_token uuid,p_status text,p_data jsonb,p_available_at timestamptz) returns boolean language plpgsql security definer set search_path='' as $$
begin
 update public.ai_jobs set status=p_status,data=data||p_data,available_at=coalesce(p_available_at,now()),lease_until=null,lease_token=null where id=p_job_id and user_id=p_user_id and status='running' and lease_token=p_lease_token;
 return found;
end$$;

create function public.save_learning_session(p_user_id uuid,p_kind text,p_id uuid,p_version int,p_data jsonb,p_attempt jsonb default null,p_mistakes jsonb default '[]')returns jsonb language plpgsql security definer set search_path='' as $$
declare saved jsonb;m jsonb;begin
 if p_kind='solve' then
   update public.solve_sessions set data=p_data||jsonb_build_object('version',p_version+1) where id=p_id and user_id=p_user_id and coalesce((data->>'version')::int,0)=p_version returning data into saved;
 elsif p_kind='study' then
   update public.study_sessions set data=p_data||jsonb_build_object('version',p_version+1) where id=p_id and user_id=p_user_id and coalesce((data->>'version')::int,0)=p_version returning data into saved;
 else raise exception 'Invalid session kind';end if;
 if not found then return null;end if;
 if p_kind='study' and p_attempt is not null then
   insert into public.study_results(user_id,session_id,item_id,concept_id,result,data)values(p_user_id,p_id,p_attempt->>'itemId',p_attempt->>'conceptId',p_attempt->>'result',p_attempt)on conflict(user_id,session_id,item_id)do nothing;
 end if;
 for m in select value from jsonb_array_elements(p_mistakes)loop
   update public.wrong_answers set data=m where id=(m->>'id')::uuid and user_id=p_user_id;
 end loop;
 return saved;
end$$;
revoke all on function public.save_learning_session(uuid,text,uuid,int,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.save_learning_session(uuid,text,uuid,int,jsonb,jsonb,jsonb) to service_role;
