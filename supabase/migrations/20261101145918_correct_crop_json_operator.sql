-- Parenthesize JSON extraction before key removal; retain atomic crop revision and answers.
create or replace function public.save_problem_regions(p_problem jsonb,p_regions jsonb,p_expected_revision text default null)returns jsonb language plpgsql security invoker set search_path='' as $$
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
 insert into public.problems(id,user_id,document_id,number,page,data)values(qid,uid,did,(p_problem->>'number')::int,start_page,coalesce(existing.data,'{}')||((p_problem->'data')-'answer'-'explanation'))on conflict(id)do update set number=excluded.number,page=excluded.page,data=public.problems.data||(excluded.data-'answer'-'explanation') where public.problems.user_id=uid;
 delete from public.problem_regions where problem_id=qid and user_id=uid;
 for r in select value from jsonb_array_elements(p_regions)loop
  insert into public.problem_regions(user_id,problem_id,part,page,image_path,data)values(uid,qid,(r->>'part')::int,(r->>'page')::int,r->>'image_path',r->'data');
 end loop;
 return (select to_jsonb(q)from public.problems q where id=qid and user_id=uid);
end$$;
revoke all on function public.save_problem_regions(jsonb,jsonb,text) from public,anon;
grant execute on function public.save_problem_regions(jsonb,jsonb,text) to authenticated;

