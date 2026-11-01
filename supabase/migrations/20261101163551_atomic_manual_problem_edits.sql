create function public.save_manual_problem_group(p_saves jsonb,p_retire jsonb default '[]')returns jsonb
language plpgsql security invoker set search_path='' as $$
declare uid uuid=(select auth.uid());v jsonb;r jsonb;old public.problems;did uuid;target uuid;saved jsonb='[]';result jsonb;begin
 if jsonb_typeof(p_saves)<>'array'or jsonb_array_length(p_saves)not between 1 and 2 or jsonb_typeof(p_retire)<>'array'or jsonb_array_length(p_retire)>1 then raise exception '합치기·분리 요청을 확인하세요.';end if;
 did=(p_saves->0->'p_problem'->>'document_id')::uuid;target=(p_saves->0->'p_problem'->>'id')::uuid;
 perform 1 from public.documents where id=did and user_id=uid for update;if not found then raise exception '자료를 찾을 수 없습니다.';end if;
 for r in select value from jsonb_array_elements(p_retire)loop
  select * into old from public.problems where id=(r->>'id')::uuid and document_id=did and user_id=uid for update;
  if not found or old.id=target or old.data->>'revision'is distinct from r->>'revision'then raise exception '합칠 문항이 다른 화면에서 변경됐습니다.';end if;
 end loop;
 for v in select value from jsonb_array_elements(p_saves)loop
  if (v->'p_problem'->>'document_id')::uuid<>did then raise exception '다른 자료의 문항은 합칠 수 없습니다.';end if;
  result=public.save_problem_regions(v->'p_problem',v->'p_regions',v->>'p_expected_revision');saved=saved||jsonb_build_array(result);
 end loop;
 for r in select value from jsonb_array_elements(p_retire)loop
  insert into public.problem_concepts(user_id,problem_id,concept_id)select uid,target,concept_id from public.problem_concepts where user_id=uid and problem_id=(r->>'id')::uuid on conflict do nothing;
  update public.problems set data=data||jsonb_build_object('mergedInto',target,'source','manual')where id=(r->>'id')::uuid and user_id=uid;
 end loop;
 return jsonb_build_object('saved',saved);
end$$;
revoke all on function public.save_manual_problem_group(jsonb,jsonb)from public,anon;
grant execute on function public.save_manual_problem_group(jsonb,jsonb)to authenticated;
