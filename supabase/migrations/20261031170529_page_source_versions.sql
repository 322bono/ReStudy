-- Check textbook page snapshots before applying AI output.
create or replace function public.commit_ai_result(p_user_id uuid,p_job_id uuid,p_lease_token uuid,p_result jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;c jsonb;i jsonb;m jsonb;v jsonb;key text;cid text;itemid text;keys jsonb='{}';ids jsonb='[]';stored_at timestamptz;sourceid text;n int;begin
 select * into j from public.ai_jobs where id=p_job_id and user_id=p_user_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_until<now() then return null;end if;
 for v in select value from jsonb_array_elements(coalesce(j.data->'source_versions','[]')) loop
   stored_at=null;sourceid=v->>'id';
   if v->>'table'='problems' then select updated_at into stored_at from public.problems where id=sourceid::uuid and user_id=p_user_id;
   elsif v->>'table'='concepts' then select updated_at into stored_at from public.concepts where id=sourceid and user_id=p_user_id;
   elsif v->>'table'='document_pages' then select updated_at into stored_at from public.document_pages where id=sourceid::uuid and user_id=p_user_id;
   elsif v->>'table'='documents' then select updated_at into stored_at from public.documents where id=sourceid::uuid and user_id=p_user_id;end if;
   if stored_at is null or stored_at is distinct from (v->>'updated_at')::timestamptz then
     update public.ai_jobs set status='paused',lease_token=null,lease_until=null,data=data||jsonb_build_object('last_error','원본이 수정되어 결과를 적용하지 않았습니다. 새 분석을 시작하세요.') where id=p_job_id;return null;
   end if;
 end loop;
 for c in select value from jsonb_array_elements(coalesce(p_result->'concepts','[]')) loop
   key=coalesce(c->>'key',lower(regexp_replace(concat_ws('|',c->>'subject',c->>'major',c->>'minor',c->>'name'),'\s+',' ','g')));
   cid=coalesce(nullif(c->>'id',''),gen_random_uuid()::text);
   insert into public.concepts(id,user_id,subject,major,minor,name,canonical_key,data)values(cid,p_user_id,c->>'subject',coalesce(c->>'major',''),coalesce(c->>'minor',''),c->>'name',key,c||jsonb_build_object('reviewStatus','needs_review')) on conflict(user_id,canonical_key)do nothing;
   select id into cid from public.concepts where user_id=p_user_id and canonical_key=key;
   keys=keys||jsonb_build_object(key,cid);ids=ids||jsonb_build_array(cid);
 end loop;
 for i in select value from jsonb_array_elements(coalesce(p_result->'items','[]')) loop
   cid=coalesce(i->>'conceptId',keys->>(i->>'conceptKey'));
   if not exists(select 1 from public.concepts where id=cid and user_id=p_user_id) then raise exception 'Invalid concept owner';end if;
   itemid=gen_random_uuid()::text;
   insert into public.concept_questions(id,user_id,concept_id,type,difficulty,review_status,data)values(itemid,p_user_id,cid,i->>'type',coalesce(i->>'difficulty','기본'),'needs_review',i||jsonb_build_object('id',itemid,'conceptId',cid,'active',false,'reviewStatus','needs_review','generatedJobId',p_job_id));
   n=0;for c in select value from jsonb_array_elements(coalesce(i->'choices','[]')) loop
     insert into public.question_options(user_id,question_id,position,data)values(p_user_id,itemid,n,jsonb_build_object('text',c,'feedback',i->'choiceFeedback'->(c#>>'{}')));n=n+1;
   end loop;
 end loop;
 for m in select value from jsonb_array_elements(coalesce(p_result->'mappings','[]')) loop
   if not exists(select 1 from public.problems where id=(m->>'questionId')::uuid and user_id=p_user_id)then raise exception 'Invalid problem owner';end if;
   for c in select value from jsonb_array_elements(coalesce(m->'conceptKeys','[]')) loop
     cid=keys->>(c#>>'{}');
     if cid is null then raise exception 'Unknown concept key';end if;
     insert into public.problem_concepts(user_id,problem_id,concept_id)values(p_user_id,(m->>'questionId')::uuid,cid) on conflict do nothing;
   end loop;
   for c in select value from jsonb_array_elements(coalesce(m->'conceptIds','[]')) loop
     insert into public.problem_concepts(user_id,problem_id,concept_id)values(p_user_id,(m->>'questionId')::uuid,c#>>'{}') on conflict do nothing;
   end loop;
 end loop;
 update public.ai_jobs set status='completed',lease_token=null,lease_until=null,data=data||jsonb_build_object('result',p_result,'conceptIds',ids) where id=p_job_id;
 return jsonb_build_object('committed',true,'conceptIds',ids,'jobId',p_job_id);
end$$;
