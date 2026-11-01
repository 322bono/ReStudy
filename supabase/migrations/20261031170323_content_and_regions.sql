create function public.save_problem_regions(p_problem jsonb,p_regions jsonb,p_expected_revision text default null)returns jsonb language plpgsql security invoker set search_path='' as $$
declare uid uuid=(select auth.uid());qid uuid=(p_problem->>'id')::uuid;did uuid=(p_problem->>'document_id')::uuid;existing public.problems;r jsonb;rg jsonb;doc public.documents;start_page int=(p_problem->>'page')::int;begin
 if uid is null or not public.is_provisioned() then raise exception 'Authentication required';end if;
 select * into doc from public.documents where id=did and user_id=uid for update;
 if not found or coalesce((doc.data->>'archived')::boolean,false)then raise exception 'Invalid document';end if;
 select * into existing from public.problems where id=qid and user_id=uid for update;
 if found and (existing.document_id<>did or existing.data->>'revision' is distinct from p_expected_revision)then raise exception '문항 영역이 다른 화면에서 수정됐습니다. 다시 열어 저장하세요.';end if;
 if jsonb_array_length(p_regions)=0 or jsonb_array_length(p_regions)>30 or not exists(select 1 from jsonb_array_elements(p_regions)x where (x->>'page')::int=start_page) then raise exception 'Invalid regions or start page';end if;
 for r in select value from jsonb_array_elements(p_regions)loop
  rg=r->'data';
  if (rg->>'x')::numeric<0 or (rg->>'y')::numeric<0 or (rg->>'w')::numeric<=0 or (rg->>'h')::numeric<=0 or (rg->>'x')::numeric+(rg->>'w')::numeric>1.00001 or (rg->>'y')::numeric+(rg->>'h')::numeric>1.00001 then raise exception 'Invalid crop coordinates';end if;
  if (r->>'page')::int<>(rg->>'page')::int or (r->>'image_path') not like uid::text||'/'||did::text||'/%' or (r->>'image_path')like '%..%' then raise exception 'Invalid crop source';end if;
  if not exists(select 1 from public.document_pages where document_id=did and user_id=uid and number=(r->>'page')::int and data->>'kind'<>'answers')then raise exception '정답·해설 페이지를 문제로 저장할 수 없습니다.';end if;
 end loop;
 if (p_problem->>'number')::int<1 then raise exception 'Invalid number';end if;
 insert into public.problems(id,user_id,document_id,number,page,data)values(qid,uid,did,(p_problem->>'number')::int,start_page,coalesce(existing.data,'{}')||(p_problem->'data'-'answer'-'explanation'))on conflict(id)do update set number=excluded.number,page=excluded.page,data=public.problems.data||(excluded.data-'answer'-'explanation') where public.problems.user_id=uid;
 delete from public.problem_regions where problem_id=qid and user_id=uid;
 for r in select value from jsonb_array_elements(p_regions)loop
  insert into public.problem_regions(user_id,problem_id,part,page,image_path,data)values(uid,qid,(r->>'part')::int,(r->>'page')::int,r->>'image_path',r->'data');
 end loop;
 return (select to_jsonb(q)from public.problems q where id=qid and user_id=uid);
end$$;
revoke all on function public.save_problem_regions(jsonb,jsonb,text) from public,anon;
grant execute on function public.save_problem_regions(jsonb,jsonb,text) to authenticated;

create function public.import_content_package(p_user_id uuid,p_package jsonb)returns jsonb language plpgsql security definer set search_path='' as $$
declare c jsonb;i jsonb;m jsonb;v jsonb;q public.problems;cid text;key text;counter int=0;pos int;begin
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
   select * into q from public.problems where id=(m->>'questionId')::uuid and user_id=p_user_id for update;if not found then raise exception 'Invalid question owner';end if;
   if (select coalesce(jsonb_agg(concept_id order by concept_id),'[]')from public.problem_concepts where problem_id=q.id and user_id=p_user_id) is distinct from (select coalesce(jsonb_agg(value order by value),'[]')from jsonb_array_elements_text(m->'conceptIds'))then
     update public.wrong_answers set data=(data-'conceptAccuracy')||jsonb_build_object('conceptState',case when jsonb_array_length(m->'conceptIds')>0 then 'reviewing'else 'unregistered'end)where problem_id=q.id and user_id=p_user_id;
   end if;
   delete from public.problem_concepts where problem_id=q.id and user_id=p_user_id;
   for cid in select jsonb_array_elements_text(m->'conceptIds')loop
     insert into public.problem_concepts(user_id,problem_id,concept_id)values(p_user_id,q.id,cid);
   end loop;
   update public.problems set data=data||jsonb_strip_nulls(jsonb_build_object('answer',m->'answer','explanation',m->'explanation'))where id=q.id and user_id=p_user_id;
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
