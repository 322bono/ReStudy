create table public.restudy_account_access (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  administrator boolean not null default false,
  active boolean not null default true,
  ai boolean not null default false,
  personal_keys boolean not null default false,
  shared_keys boolean not null default false,
  mistakes boolean not null default true,
  study boolean not null default true
);
alter table public.restudy_account_access enable row level security;
revoke all on public.restudy_account_access from public, anon, authenticated;
grant select, insert, update on public.restudy_account_access to service_role;
create unique index restudy_single_administrator
  on public.restudy_account_access (administrator) where administrator;

insert into public.restudy_account_access (user_id, administrator, ai, personal_keys)
select p.user_id, exists (
  select 1 from public.login_aliases a
  where a.user_id = p.user_id and a.username = 'bono' and p.username = 'bono'
), true, true
from public.profiles p;

create or replace function public.is_provisioned()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    left join public.restudy_account_access a using (user_id)
    where p.user_id = (select auth.uid()) and coalesce(a.active, true)
  )
$$;
revoke all on function public.is_provisioned() from public, anon;
grant execute on function public.is_provisioned() to authenticated, service_role;

create function public.restudy_feature(p_feature text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    left join public.restudy_account_access a using (user_id)
    where p.user_id = (select auth.uid()) and coalesce(a.active, true)
    and case p_feature
      when 'mistakes' then coalesce(a.mistakes, true)
      when 'study' then coalesce(a.study, true)
      else false
    end
  )
$$;
revoke all on function public.restudy_feature(text) from public, anon;
grant execute on function public.restudy_feature(text) to authenticated;

do $$
declare
  name text;
  feature text;
begin
  foreach name in array array['wrong_answers','solve_sessions','study_sessions','study_results','review_schedules'] loop
    feature := case when name in ('wrong_answers','solve_sessions') then 'mistakes' else 'study' end;
    execute format(
      'create policy feature_access on public.%I as restrictive for all to authenticated using ((select public.restudy_feature(%L))) with check ((select public.restudy_feature(%L)))',
      name, feature, feature
    );
  end loop;
end $$;

create function public.provision_restudy_member(
  p_id uuid, p_username text, p_email text, p_access jsonb
) returns void language plpgsql set search_path = '' as $$
begin
  insert into public.profiles (id, user_id, username) values (p_id, p_id, p_username);
  insert into public.login_aliases (username, user_id, email) values (p_username, p_id, p_email);
  insert into public.restudy_account_access (user_id, active, ai, personal_keys, shared_keys, mistakes, study)
  values (p_id, (p_access->>'active')::boolean, (p_access->>'ai')::boolean,
    (p_access->>'personalKeys')::boolean, (p_access->>'sharedKeys')::boolean,
    (p_access->>'mistakes')::boolean, (p_access->>'study')::boolean);
end $$;
revoke all on function public.provision_restudy_member(uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.provision_restudy_member(uuid,text,text,jsonb) to service_role;

create index restudy_documents_owner_time on public.documents (user_id, created_at desc, id desc);
create index restudy_mistakes_owner_time on public.wrong_answers (user_id, created_at desc, id desc);
create index restudy_solve_owner_time on public.solve_sessions (user_id, updated_at desc);
create index restudy_study_owner_time on public.study_sessions (user_id, updated_at desc);
create index restudy_ai_owner_time on public.ai_usage_logs (user_id, created_at desc);

create function public.restudy_member_activity(p_id uuid, p_offset integer)
returns table (kind text, at timestamptz) language sql stable security definer set search_path = '' as $$
  select events.kind, events.at
  from (
    (select 'login'::text as kind, last_sign_in_at as at
      from auth.users where id = p_id)
    union all (select 'upload', created_at from public.documents
      where user_id = p_id order by created_at desc limit p_offset + 21)
    union all (select 'mistake', created_at from public.wrong_answers
      where user_id = p_id order by created_at desc limit p_offset + 21)
    union all (select 'solve', updated_at from public.solve_sessions
      where user_id = p_id order by updated_at desc limit p_offset + 21)
    union all (select 'study', updated_at from public.study_sessions
      where user_id = p_id order by updated_at desc limit p_offset + 21)
    union all (select 'ai', created_at from public.ai_usage_logs
      where user_id = p_id order by created_at desc limit p_offset + 21)
  ) events
  where events.at >= now() - interval '90 days'
  order by events.at desc, events.kind
  offset p_offset limit 21
$$;
revoke all on function public.restudy_member_activity(uuid,integer) from public, anon, authenticated;
grant execute on function public.restudy_member_activity(uuid,integer) to service_role;

create function public.restudy_solved_today()
returns integer language sql stable set search_path = '' as $$
  with day_start as (
    select date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul' as at
  )
  select count(distinct answer.key)::integer
  from public.solve_sessions s
  cross join day_start d
  cross join lateral jsonb_each(
    case when jsonb_typeof(s.data->'answers') = 'object' then s.data->'answers' else '{}'::jsonb end
  ) answer
  where s.user_id = (select auth.uid()) and s.updated_at >= d.at
    and answer.value->>'at' >= to_char(d.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    and answer.value->>'result' in ('correct', 'wrong')
$$;
revoke all on function public.restudy_solved_today() from public, anon;
grant execute on function public.restudy_solved_today() to authenticated;
