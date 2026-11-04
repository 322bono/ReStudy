create function public.commit_wrong_review(
  p_user_id uuid, p_job_id uuid, p_lease_token uuid, p_result jsonb
) returns text language plpgsql set search_path = '' as $$
declare
  j public.ai_jobs;
begin
  select * into j from public.ai_jobs
  where id = p_job_id and user_id = p_user_id and kind = 'wrong_review'
  for update;
  if not found or j.status <> 'running' or j.lease_token is distinct from p_lease_token or j.lease_until <= now() then
    return null;
  end if;

  update public.problems
  set data = data || jsonb_build_object('wrongReview', p_result)
  where id = j.problem_id and user_id = p_user_id and document_id = j.document_id
    and updated_at = (j.data->>'problemVersion')::timestamptz
    and coalesce(data->>'autoRetired', 'false') <> 'true' and data->>'mergedInto' is null;

  if not found then
    update public.ai_jobs
    set status = 'paused', lease_token = null, lease_until = null,
        data = (data - 'input' - 'pending_result') || jsonb_build_object('last_error', 'source_changed', 'last_provider_error', null)
    where id = j.id;
    return 'paused';
  end if;

  update public.ai_jobs
  set status = 'completed', lease_token = null, lease_until = null,
      data = data - 'input' - 'pending_result' - 'last_error' - 'last_provider_error'
  where id = j.id;
  return 'completed';
end;
$$;

revoke all on function public.commit_wrong_review(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.commit_wrong_review(uuid, uuid, uuid, jsonb) to service_role;
