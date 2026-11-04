create function public.archive_wrong_answers(p_user_id uuid,p_ids uuid[])
returns uuid[] language sql security invoker set search_path='' as $$
  with archived as (
    update public.wrong_answers
    set data=data||'{"archived":true}'::jsonb
    where user_id=p_user_id and id=any(p_ids)
    returning id
  )
  select coalesce(array_agg(id),'{}'::uuid[]) from archived;
$$;
revoke all on function public.archive_wrong_answers(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.archive_wrong_answers(uuid,uuid[]) to service_role;

create or replace function public.save_learning_session(p_user_id uuid,p_kind text,p_id uuid,p_version int,p_data jsonb,p_attempt jsonb default null,p_mistakes jsonb default '[]')
returns jsonb language plpgsql security definer set search_path='' as $$
declare saved jsonb; m jsonb;
begin
  if p_kind='solve' then
    update public.solve_sessions set data=p_data||jsonb_build_object('version',p_version+1)
    where id=p_id and user_id=p_user_id and coalesce((data->>'version')::int,0)=p_version returning data into saved;
  elsif p_kind='study' then
    update public.study_sessions set data=p_data||jsonb_build_object('version',p_version+1)
    where id=p_id and user_id=p_user_id and coalesce((data->>'version')::int,0)=p_version returning data into saved;
  else
    raise exception 'Invalid session kind';
  end if;
  if not found then return null; end if;
  if p_kind='study' and p_attempt is not null then
    insert into public.study_results(user_id,session_id,item_id,concept_id,result,data)
    values(p_user_id,p_id,p_attempt->>'itemId',p_attempt->>'conceptId',p_attempt->>'result',p_attempt)
    on conflict(user_id,session_id,item_id) do nothing;
  end if;
  for m in select value from jsonb_array_elements(p_mistakes) loop
    -- A learning session may have read the record before its registration changed.
    update public.wrong_answers
    set data=(m-'archived')||case when data ? 'archived' then jsonb_build_object('archived',data->'archived') else '{}'::jsonb end
    where id=(m->>'id')::uuid and user_id=p_user_id;
  end loop;
  return saved;
end;
$$;
