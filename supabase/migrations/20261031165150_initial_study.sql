-- Every public row is owned. Composite foreign keys preserve ownership even in privileged writes.
create table public.profiles(id uuid primary key references auth.users on delete cascade,user_id uuid not null unique references auth.users on delete cascade,username text unique,data jsonb not null default '{}',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),check(id=user_id));
create table public.subjects(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users on delete cascade,name text not null,data jsonb not null default '{}',unique(user_id,name),unique(id,user_id));
create table public.documents(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users on delete cascade,title text not null,subject text not null,kind text not null,content_hash text,status text not null default 'uploaded',data jsonb not null default '{}',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(id,user_id),unique(user_id,content_hash));
create table public.document_pages(id uuid primary key default gen_random_uuid(),user_id uuid not null,document_id uuid not null,number int not null check(number>0),image_path text,data jsonb not null default '{}',updated_at timestamptz not null default now(),foreign key(document_id,user_id) references public.documents(id,user_id) on delete cascade,unique(document_id,number),unique(id,user_id));
create table public.problems(id uuid primary key default gen_random_uuid(),user_id uuid not null,document_id uuid not null,number int not null check(number>0),page int not null check(page>0),data jsonb not null default '{}',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),foreign key(document_id,user_id) references public.documents(id,user_id) on delete cascade,unique(id,user_id));
create table public.problem_regions(id uuid primary key default gen_random_uuid(),user_id uuid not null,problem_id uuid not null,page int not null,part int not null,image_path text not null,data jsonb not null default '{}',foreign key(problem_id,user_id) references public.problems(id,user_id) on delete cascade,unique(problem_id,part));
create table public.concepts(id text not null default gen_random_uuid()::text,user_id uuid not null references auth.users on delete cascade,subject text not null,major text not null default '',minor text not null default '',name text not null,canonical_key text not null,data jsonb not null default '{}',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(id,user_id),unique(user_id,canonical_key));
create table public.problem_concepts(user_id uuid not null,problem_id uuid not null,concept_id text not null,primary key(user_id,problem_id,concept_id),foreign key(problem_id,user_id) references public.problems(id,user_id) on delete cascade,foreign key(concept_id,user_id) references public.concepts(id,user_id) on delete cascade);
create table public.concept_questions(id text not null default gen_random_uuid()::text,user_id uuid not null,concept_id text not null,type text not null,difficulty text not null default '기본',review_status text not null default 'needs_review',data jsonb not null default '{}',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(id,user_id),foreign key(concept_id,user_id) references public.concepts(id,user_id) on delete cascade);
create table public.question_options(id uuid primary key default gen_random_uuid(),user_id uuid not null,question_id text not null,position int not null,data jsonb not null default '{}',foreign key(question_id,user_id) references public.concept_questions(id,user_id) on delete cascade,unique(user_id,question_id,position));
create table public.wrong_answers(id uuid primary key default gen_random_uuid(),user_id uuid not null,problem_id uuid not null,data jsonb not null default '{}',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),foreign key(problem_id,user_id) references public.problems(id,user_id) on delete cascade,unique(user_id,problem_id));
create table public.study_sessions(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users on delete cascade,data jsonb not null default '{}',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(id,user_id));
create table public.solve_sessions(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users on delete cascade,data jsonb not null default '{}',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(id,user_id));
create table public.study_results(id uuid primary key default gen_random_uuid(),user_id uuid not null,session_id uuid not null,item_id text not null,concept_id text,result text not null,data jsonb not null default '{}',created_at timestamptz not null default now(),foreign key(session_id,user_id) references public.study_sessions(id,user_id) on delete cascade,unique(user_id,session_id,item_id));
create table public.review_schedules(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users on delete cascade,problem_id uuid,concept_id text,due_at timestamptz not null,data jsonb not null default '{}',foreign key(problem_id,user_id) references public.problems(id,user_id) on delete cascade,foreign key(concept_id,user_id) references public.concepts(id,user_id) on delete cascade);
create table public.ai_providers(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users on delete cascade,provider text not null check(provider in ('nvidia','gemini')),data jsonb not null default '{}',unique(user_id,provider));
create table public.ai_credentials(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users on delete cascade,provider text not null check(provider in ('nvidia','gemini')),ciphertext text not null,iv text not null,key_version int not null default 1,data jsonb not null default '{}',updated_at timestamptz not null default now(),unique(user_id,provider));
create table public.ai_jobs(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users on delete cascade,document_id uuid,problem_id uuid,concept_id text,kind text not null,status text not null default 'waiting' check(status in ('waiting','running','completed','failed','paused','retry_wait')),cache_key text not null,attempts int not null default 0,available_at timestamptz not null default now(),lease_until timestamptz,lease_token uuid,data jsonb not null default '{}',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(user_id,cache_key),foreign key(document_id,user_id) references public.documents(id,user_id) on delete cascade,foreign key(problem_id,user_id) references public.problems(id,user_id) on delete cascade,foreign key(concept_id,user_id) references public.concepts(id,user_id) on delete cascade);
create table public.ai_usage_logs(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users on delete cascade,job_id uuid references public.ai_jobs on delete set null,data jsonb not null default '{}',created_at timestamptz not null default now());
create table public.ai_rotation_state(user_id uuid primary key references auth.users on delete cascade,counter bigint not null default 0);
create table public.ai_daily_budgets(user_id uuid not null references auth.users on delete cascade,day date not null,count int not null default 0,primary key(user_id,day));
create table public.login_aliases(username text primary key,user_id uuid not null unique references auth.users on delete cascade,email text not null);
create table public.login_attempts(fingerprint text primary key,window_start timestamptz not null default now(),attempts int not null default 0);
create table public.setup_tokens(token_hash text primary key,expires_at timestamptz not null,consumed_at timestamptz,lease_token uuid,lease_until timestamptz);

-- Update timestamps are server-owned; source revisions can reliably guard late AI work.
create function public.touch_updated_at() returns trigger language plpgsql set search_path='' as $$begin new.updated_at=now();return new;end$$;
do $$declare t text;begin
 foreach t in array array['profiles','documents','document_pages','problems','concepts','concept_questions','wrong_answers','study_sessions','solve_sessions','ai_credentials','ai_jobs'] loop
 execute format('create trigger touch_%I before update on public.%I for each row execute function public.touch_updated_at()',t,t);
 end loop;end$$;

-- Browser has owner RLS on ordinary content; secret/control tables are server-only.
do $$declare t text;begin
 foreach t in array array['profiles','subjects','documents','document_pages','problems','problem_regions','concepts','problem_concepts','concept_questions','question_options','wrong_answers','study_sessions','solve_sessions','study_results','review_schedules'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon',t);
 execute format('grant select,insert,update,delete on public.%I to authenticated',t);
 execute format('create policy owner_access on public.%I for all to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id)',t);
 end loop;
 foreach t in array array['ai_providers','ai_credentials','ai_jobs','ai_usage_logs','ai_rotation_state','ai_daily_budgets','login_aliases','login_attempts','setup_tokens'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon,authenticated',t);
 end loop;
end$$;
grant usage on schema public to authenticated,service_role;
grant all on all tables in schema public to service_role;

create index document_pages_owner on public.document_pages(user_id,document_id);
create index problems_owner_document on public.problems(user_id,document_id,page,number);
create index regions_owner_problem on public.problem_regions(user_id,problem_id);
create index concept_questions_owner on public.concept_questions(user_id,concept_id);
create index wrong_answers_owner on public.wrong_answers(user_id,problem_id);
create index study_results_owner on public.study_results(user_id,session_id);
create index review_due on public.review_schedules(user_id,due_at);
create index ai_jobs_ready on public.ai_jobs(user_id,status,available_at);
create index ai_usage_owner on public.ai_usage_logs(user_id,created_at desc);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)values('study-files','study-files',false,52428800,array['application/pdf','image/png','image/jpeg','image/webp','application/json']) on conflict(id) do nothing;
create policy study_files_read on storage.objects for select to authenticated using(bucket_id='study-files' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy study_files_insert on storage.objects for insert to authenticated with check(bucket_id='study-files' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy study_files_update on storage.objects for update to authenticated using(bucket_id='study-files' and (storage.foldername(name))[1]=(select auth.uid())::text) with check(bucket_id='study-files' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy study_files_delete on storage.objects for delete to authenticated using(bucket_id='study-files' and (storage.foldername(name))[1]=(select auth.uid())::text);

-- These functions are called only by authenticated Edge handlers using service credentials.
create function public.claim_ai_job(p_user_id uuid,p_job_id uuid,p_daily_limit int,p_max_attempts int) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs; rotation bigint; used int;begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
 select * into j from public.ai_jobs where id=p_job_id and user_id=p_user_id for update;
 if not found or j.status in ('completed','paused') or (j.status='running' and j.lease_until>now()) or j.available_at>now() or j.attempts>=p_max_attempts then return null;end if;
 insert into public.ai_daily_budgets(user_id,day)values(p_user_id,(now() at time zone 'Asia/Seoul')::date) on conflict do nothing;
 select count into used from public.ai_daily_budgets where user_id=p_user_id and day=(now() at time zone 'Asia/Seoul')::date for update;
 if used>=greatest(0,p_daily_limit) then return null;end if;
 update public.ai_daily_budgets set count=count+1 where user_id=p_user_id and day=(now() at time zone 'Asia/Seoul')::date;
 insert into public.ai_rotation_state(user_id,counter)values(p_user_id,1) on conflict(user_id) do update set counter=public.ai_rotation_state.counter+1 returning counter-1 into rotation;
 update public.ai_jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '120 seconds' where id=p_job_id and user_id=p_user_id returning * into j;
 return jsonb_build_object('job',to_jsonb(j),'rotation_index',rotation);
end$$;
create function public.finish_ai_job(p_user_id uuid,p_job_id uuid,p_lease_token uuid,p_status text,p_data jsonb,p_available_at timestamptz) returns boolean language plpgsql security definer set search_path='' as $$
begin
 update public.ai_jobs set status=p_status,data=p_data,available_at=coalesce(p_available_at,now()),lease_until=null,lease_token=null where id=p_job_id and user_id=p_user_id and status='running' and lease_token=p_lease_token;
 return found;
end$$;

create function public.commit_ai_result(p_user_id uuid,p_job_id uuid,p_lease_token uuid,p_result jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;c jsonb;i jsonb;m jsonb;v jsonb;key text;cid text;itemid text;keys jsonb='{}';ids jsonb='[]';stored_at timestamptz;sourceid text;n int;begin
 select * into j from public.ai_jobs where id=p_job_id and user_id=p_user_id for update;
 if not found or j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_until<now() then return null;end if;
 for v in select value from jsonb_array_elements(coalesce(j.data->'source_versions','[]')) loop
   stored_at=null;sourceid=v->>'id';
   if v->>'table'='problems' then select updated_at into stored_at from public.problems where id=sourceid::uuid and user_id=p_user_id;
   elsif v->>'table'='concepts' then select updated_at into stored_at from public.concepts where id=sourceid and user_id=p_user_id;
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

create function public.begin_login_attempt(p_fingerprint text)returns boolean language plpgsql security definer set search_path='' as $$
declare a public.login_attempts;begin
 insert into public.login_attempts(fingerprint,attempts)values(p_fingerprint,1)on conflict(fingerprint)do update set attempts=case when public.login_attempts.window_start<now()-interval '15 minutes' then 1 else public.login_attempts.attempts+1 end,window_start=case when public.login_attempts.window_start<now()-interval '15 minutes' then now()else public.login_attempts.window_start end returning * into a;
 return a.attempts<=10;
end$$;
create function public.claim_setup_token(p_hash text,p_lease uuid)returns boolean language plpgsql security definer set search_path='' as $$
begin
 update public.setup_tokens set lease_token=p_lease,lease_until=now()+interval '90 seconds' where token_hash=p_hash and expires_at>now() and consumed_at is null and (lease_until is null or lease_until<now());return found;
end$$;
do $$declare f record;begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('claim_ai_job','finish_ai_job','commit_ai_result','begin_login_attempt','claim_setup_token')loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;end$$;
