-- One shared request clock per provider/project group; adding keys does not
-- bypass a provider's project quota. Private service-only coordination data.
create table public.ai_provider_request_slots(
 user_id uuid not null references auth.users(id) on delete cascade,
 provider text not null check(provider in ('nvidia','gemini')),
 quota_group text not null,
 next_at timestamptz not null default now(),
 primary key(user_id,provider,quota_group)
);
alter table public.ai_provider_request_slots enable row level security;
revoke all on public.ai_provider_request_slots from public,anon,authenticated;
grant all on public.ai_provider_request_slots to service_role;
create or replace function public.reserve_ai_provider_request(p_user_id uuid,p_provider text,p_group text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare due timestamptz;moment timestamptz;grp text=coalesce(nullif(p_group,''),'shared');begin
 if p_provider not in ('nvidia','gemini') or length(grp)>200 then raise exception 'Invalid request group';end if;
 insert into public.ai_provider_request_slots(user_id,provider,quota_group)values(p_user_id,p_provider,grp)on conflict do nothing;
 select next_at into due from public.ai_provider_request_slots where user_id=p_user_id and provider=p_provider and quota_group=grp for update;
 moment=clock_timestamp();
 if due>moment then return jsonb_build_object('granted',false,'retry_at',due);end if;
 update public.ai_provider_request_slots set next_at=moment+interval '1500 milliseconds' where user_id=p_user_id and provider=p_provider and quota_group=grp;
 return jsonb_build_object('granted',true,'retry_at',moment);
end$$;
revoke all on function public.reserve_ai_provider_request(uuid,text,text) from public,anon,authenticated;
grant execute on function public.reserve_ai_provider_request(uuid,text,text) to service_role;

-- Leave enough time for an actual inference and durable commit. Lease tokens
-- still fence stale workers; client/network timeouts cannot grant a second run.
create or replace function public.claim_ai_job(p_user_id uuid,p_job_id uuid,p_daily_limit int,p_max_attempts int) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs; rotation bigint; used int;begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
 select * into j from public.ai_jobs where id=p_job_id and user_id=p_user_id for update;
 if not found or j.status in ('completed','paused') or (j.status='running' and j.lease_until>now()) or j.available_at>now() or j.attempts>=p_max_attempts then return null;end if;
 insert into public.ai_daily_budgets(user_id,day)values(p_user_id,(now() at time zone 'Asia/Seoul')::date) on conflict do nothing;
 select count into used from public.ai_daily_budgets where user_id=p_user_id and day=(now() at time zone 'Asia/Seoul')::date for update;
 if used>=greatest(0,p_daily_limit) then return null;end if;
 update public.ai_daily_budgets set count=count+1 where user_id=p_user_id and day=(now() at time zone 'Asia/Seoul')::date;
 insert into public.ai_rotation_state(user_id,counter)values(p_user_id,1) on conflict(user_id) do update set counter=public.ai_rotation_state.counter+1 returning counter-1 into rotation;
 update public.ai_jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '180 seconds' where id=p_job_id and user_id=p_user_id returning * into j;
 return jsonb_build_object('job',to_jsonb(j),'rotation_index',rotation);
end$$;
revoke all on function public.claim_ai_job(uuid,uuid,int,int) from public,anon,authenticated;
grant execute on function public.claim_ai_job(uuid,uuid,int,int) to service_role;
