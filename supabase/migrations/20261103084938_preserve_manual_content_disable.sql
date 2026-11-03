-- Preserve intentional manual disable while removing generated-content approval.
create or replace function public.activate_validated_study_content()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.review_status='needs_review'
  and new.data->>'archived' is distinct from 'true'
  and not(coalesce(new.data->>'userEdited','false')='true' and coalesce(new.data->>'active','true')='false')
  and nullif(btrim(new.data->>'prompt'),'') is not null
  and nullif(btrim(new.data->>'answer'),'') is not null
  and exists(select 1 from public.concepts c where c.user_id=new.user_id and c.id=new.concept_id)
 then new.review_status='approved';new.data=new.data||jsonb_build_object('active',true,'reviewStatus','approved','autoActivated',true);end if;
 return new;
end $$;
revoke all on function public.activate_validated_study_content() from public,anon,authenticated;
-- Repair the preceding migration's potential activation of explicitly disabled
-- edited content. This does not affect approved or untouched generated content.
update public.concept_questions set review_status='needs_review',data=(data-'autoActivated')||jsonb_build_object('active',false,'reviewStatus','needs_review')
where data->>'autoActivated'='true' and data->>'userEdited'='true' and data->>'reviewedBy' is null;

-- Rename the PL/pgSQL row variable so it cannot shadow the bank SQL alias.
create or replace function public.import_content_package(p_user_id uuid,p_package jsonb)returns jsonb language plpgsql security definer set search_path='' as $$
declare c jsonb;i jsonb;m jsonb;v jsonb;original_problem public.problems;cid text;key text;counter int=0;pos int;begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,1));
 for c in select value from jsonb_array_elements(coalesce(p_package->'concepts','[]'))loop
   key=lower(regexp_replace(concat_ws('|',c->>'subject',c->>'major',c->>'minor',c->>'name'),'\s+',' ','g'));
   insert into public.concepts(id,user_id,subject,major,minor,name,canonical_key,data)values(c->>'id',p_user_id,c->>'subject',coalesce(c->>'major',''),coalesce(c->>'minor',''),c->>'name',key,c)on conflict(id,user_id)do update set subject=excluded.subject,major=excluded.major,minor=excluded.minor,name=excluded.name,canonical_key=excluded.canonical_key,data=excluded.data;
 end loop;
 for i in select value from jsonb_array_elements(coalesce(p_package->'items','[]'))loop
   insert into public.concept_questions(id,user_id,concept_id,type,difficulty,review_status,data)values(i->>'id',p_user_id,i->>'conceptId',i->>'type',i->>'difficulty',case when coalesce((i->>'active')::boolean,true)then 'approved'else 'needs_review'end,i)on conflict(id,user_id)do update set concept_id=excluded.concept_id,type=excluded.type,difficulty=excluded.difficulty,review_status=excluded.review_status,data=excluded.data;
   delete from public.question_options where user_id=p_user_id and question_id=i->>'id';pos=0;
   for c in select value from jsonb_array_elements(coalesce(i->'choices','[]'))loop
     insert into public.question_options(user_id,question_id,position,data)values(p_user_id,i->>'id',pos,jsonb_build_object('text',c,'feedback',i->'choiceFeedback'->(c#>>'{}')));pos=pos+1;
   end loop;
 end loop;
 for m in select value from jsonb_array_elements(coalesce(p_package->'mappings','[]'))loop
   select * into original_problem from public.problems where id=(m->>'questionId')::uuid and user_id=p_user_id for update;if not found then raise exception 'Invalid question owner';end if;
   if (select coalesce(jsonb_agg(concept_id order by concept_id),'[]')from public.problem_concepts where problem_id=original_problem.id and user_id=p_user_id) is distinct from (select coalesce(jsonb_agg(value order by value),'[]')from jsonb_array_elements_text(m->'conceptIds'))then
     update public.wrong_answers set data=(data-'conceptAccuracy')||jsonb_build_object('conceptState',case when jsonb_array_length(m->'conceptIds')>0 then 'reviewing'else 'unregistered'end)where problem_id=original_problem.id and user_id=p_user_id;
   end if;
   delete from public.problem_concepts where problem_id=original_problem.id and user_id=p_user_id;
   for cid in select jsonb_array_elements_text(m->'conceptIds')loop
     insert into public.problem_concepts(user_id,problem_id,concept_id)values(p_user_id,original_problem.id,cid);
   end loop;
   update public.problems set data=data||jsonb_strip_nulls(jsonb_build_object('answer',m->'answer','explanation',m->'explanation'))where id=original_problem.id and user_id=p_user_id;
 end loop;
 if exists(select 1 from public.problem_concepts pc join public.problems p on p.id=pc.problem_id and p.user_id=pc.user_id join public.documents d on d.id=p.document_id and d.user_id=p.user_id join public.concepts c on c.id=pc.concept_id and c.user_id=pc.user_id where pc.user_id=p_user_id and c.subject<>d.subject)then raise exception '개념과 원본 과목이 다릅니다.';end if;
 -- Validate all dependent source references after partial edits, inside the same transaction.
 for c in select data||jsonb_build_object('subject',subject) from public.concepts where user_id=p_user_id loop
  for v in select value from jsonb_array_elements(coalesce(c->'sources','[]'))loop
   if not exists(select 1 from public.documents d join public.document_pages p on p.document_id=d.id and p.user_id=d.user_id where d.id=(v->>'materialId')::uuid and d.user_id=p_user_id and d.subject=c->>'subject' and p.number=(v->>'page')::int and p.data->>'kind'<>'answers')then raise exception 'Invalid concept source';end if;
  end loop;
 end loop;
 for i in select q.data||jsonb_build_object('subject',c.subject)from public.concept_questions q join public.concepts c on c.id=q.concept_id and c.user_id=q.user_id where q.user_id=p_user_id loop
  for v in select value from jsonb_array_elements(coalesce(i->'sources','[]'))loop
   if not exists(select 1 from public.documents d join public.document_pages p on p.document_id=d.id and p.user_id=d.user_id where d.id=(v->>'materialId')::uuid and d.user_id=p_user_id and d.subject=i->>'subject' and p.number=(v->>'page')::int and p.data->>'kind'<>'answers')then raise exception 'Invalid bank source';end if;
  end loop;
 end loop;
 return jsonb_build_object('concepts',jsonb_array_length(coalesce(p_package->'concepts','[]')),'items',jsonb_array_length(coalesce(p_package->'items','[]')),'mappings',jsonb_array_length(coalesce(p_package->'mappings','[]')));
end$$;
revoke all on function public.import_content_package(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.import_content_package(uuid,jsonb) to service_role;

