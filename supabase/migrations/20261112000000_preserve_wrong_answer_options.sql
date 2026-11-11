create or replace function public.save_learning_session(
  p_user_id uuid, p_kind text, p_id uuid, p_version int, p_data jsonb,
  p_attempt jsonb default null, p_mistakes jsonb default '[]'
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  saved jsonb;
  m jsonb;
  registration_keys constant text[] := array['archived', 'registeredAnswer', 'autoAnalyze'];
begin
  if p_kind = 'solve' then
    update public.solve_sessions set data = p_data || jsonb_build_object('version', p_version + 1)
    where id = p_id and user_id = p_user_id and coalesce((data->>'version')::int, 0) = p_version
    returning data into saved;
  elsif p_kind = 'study' then
    update public.study_sessions set data = p_data || jsonb_build_object('version', p_version + 1)
    where id = p_id and user_id = p_user_id and coalesce((data->>'version')::int, 0) = p_version
    returning data into saved;
  else
    raise exception 'Invalid session kind';
  end if;
  if not found then return null; end if;

  if p_kind = 'study' and p_attempt is not null then
    insert into public.study_results(user_id, session_id, item_id, concept_id, result, data)
    values(p_user_id, p_id, p_attempt->>'itemId', p_attempt->>'conceptId', p_attempt->>'result', p_attempt)
    on conflict(user_id, session_id, item_id) do nothing;
  end if;

  for m in select value from jsonb_array_elements(p_mistakes) loop
    -- Registration can change independently while a grade is being saved.
    update public.wrong_answers
    set data = (m - registration_keys) || (
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
      from jsonb_each(data)
      where key = any(registration_keys)
    )
    where id = (m->>'id')::uuid and user_id = p_user_id;
  end loop;
  return saved;
end;
$$;
