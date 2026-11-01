-- Additive migration: existing sources, credentials, IDs and histories stay intact.
create table public.content_jobs(id uuid primary key default gen_random_uuid(),user_id uuid not null,document_id uuid not null,status text not null default 'draft',data jsonb not null default '{}',created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(id,user_id),foreign key(document_id,user_id)references public.documents(id,user_id)on delete cascade);
create table public.content_parts(id uuid primary key default gen_random_uuid(),user_id uuid not null,job_id uuid not null,part int not null check(part>0),total_parts int not null check(total_parts>=part),content_hash text not null,raw jsonb not null,applied boolean not null default false,created_at timestamptz not null default now(),unique(job_id,part),foreign key(job_id,user_id)references public.content_jobs(id,user_id)on delete cascade);
create table public.document_chapters(id uuid primary key default gen_random_uuid(),user_id uuid not null,document_id uuid not null,title text not null,start_page int not null check(start_page>0),end_page int not null check(end_page>=start_page),canonical_key text not null,data jsonb not null default '{}',updated_at timestamptz not null default now(),unique(id,user_id),unique(user_id,document_id,canonical_key),foreign key(document_id,user_id)references public.documents(id,user_id)on delete cascade);
create table public.content_refs(user_id uuid not null,job_id uuid not null,kind text not null check(kind in('chapter','concept','question','flashcard')),external_id text not null,actual_id text not null,primary key(user_id,job_id,kind,external_id),foreign key(job_id,user_id)references public.content_jobs(id,user_id)on delete cascade);
create table public.chapter_concepts(user_id uuid not null,chapter_id uuid not null,concept_id text not null,primary key(user_id,chapter_id,concept_id),foreign key(chapter_id,user_id)references public.document_chapters(id,user_id)on delete cascade,foreign key(concept_id,user_id)references public.concepts(id,user_id)on delete cascade);
create table public.bank_question_concepts(user_id uuid not null,question_id text not null,concept_id text not null,primary key(user_id,question_id,concept_id),foreign key(question_id,user_id)references public.concept_questions(id,user_id)on delete cascade,foreign key(concept_id,user_id)references public.concepts(id,user_id)on delete cascade);
create table public.bank_question_origins(id uuid primary key default gen_random_uuid(),user_id uuid not null,question_id text not null,document_id uuid not null,chapter_id uuid not null,purpose text not null check(purpose in('concept','practice','similar')),data jsonb not null default '{}',unique(user_id,question_id,document_id,chapter_id,purpose),foreign key(question_id,user_id)references public.concept_questions(id,user_id)on delete cascade,foreign key(document_id,user_id)references public.documents(id,user_id)on delete cascade,foreign key(chapter_id,user_id)references public.document_chapters(id,user_id)on delete cascade);
create table public.question_fingerprints(user_id uuid not null,fingerprint text not null,question_id text not null,primary key(user_id,fingerprint),foreign key(question_id,user_id)references public.concept_questions(id,user_id)on delete cascade);
create table public.imported_problem_analyses(id uuid primary key default gen_random_uuid(),user_id uuid not null,document_id uuid not null,chapter_id uuid not null,q_number text not null,pdf_page int not null check(pdf_page>0),problem_id uuid,data jsonb not null default '{}',unique(user_id,document_id,chapter_id,q_number,pdf_page),foreign key(document_id,user_id)references public.documents(id,user_id)on delete cascade,foreign key(chapter_id,user_id)references public.document_chapters(id,user_id)on delete cascade,foreign key(problem_id,user_id)references public.problems(id,user_id)on delete set null(problem_id));
create table public.problem_similarities(id uuid primary key default gen_random_uuid(),user_id uuid not null,document_id uuid not null,a jsonb not null,b jsonb not null,score numeric not null check(score>=0 and score<=1),reason text not null,content_hash text not null,unique(user_id,document_id,content_hash),foreign key(document_id,user_id)references public.documents(id,user_id)on delete cascade);
create trigger touch_content_jobs before update on public.content_jobs for each row execute function public.touch_updated_at();
create trigger touch_document_chapters before update on public.document_chapters for each row execute function public.touch_updated_at();
do $$declare t text;begin
 foreach t in array array['content_jobs','content_parts','content_refs','document_chapters','chapter_concepts','bank_question_concepts','bank_question_origins','question_fingerprints','imported_problem_analyses','problem_similarities']loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 execute format('create policy owner_read on public.%I for select to authenticated using ((select auth.uid())=user_id and (select public.is_provisioned()))',t);
 execute format('create index on public.%I(user_id)',t);
 end loop;end$$;
create index content_parts_job on public.content_parts(user_id,job_id,part);
create index chapters_document on public.document_chapters(user_id,document_id,start_page);
create index bank_origins_document on public.bank_question_origins(user_id,document_id,chapter_id,purpose);
create index analyses_document on public.imported_problem_analyses(user_id,document_id,pdf_page,q_number);

create function public.commit_restudy_part(p_user_id uuid,p_job_id uuid,p_part jsonb,p_hash text,p_existing_count int,p_compiled jsonb,p_reviewed boolean default false,p_ai_job_id uuid default null,p_ai_lease uuid default null)returns jsonb language plpgsql security definer set search_path='' as $$
declare job public.content_jobs;child public.ai_jobs;v jsonb;c jsonb;q jsonb;a jsonb;old_hash text;cid text;chapter uuid;qid text;concept_ids jsonb;src jsonb;new_data jsonb;n int;received int;question_total int;card_total int;problem_id uuid;analysis_id uuid;stamped timestamptz;inserted boolean;begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,1));
 select * into job from public.content_jobs where id=p_job_id and user_id=p_user_id for update;if not found then raise exception '작업을 찾을 수 없습니다.';end if;
 if p_part->>'document_id'<>job.document_id::text or p_part->>'job_id'<>job.id::text or p_part->>'schema_version'<>'restudy.v1' or (p_part->>'total_parts')::int<>(job.data->>'totalParts')::int then raise exception '문서·작업·분할 정보가 다릅니다.';end if;
 if p_ai_job_id is not null then
  select * into child from public.ai_jobs where id=p_ai_job_id and user_id=p_user_id for update;
  if not found or child.status<>'running' or child.lease_token is distinct from p_ai_lease or child.lease_until<now()or child.data->>'standardJobId'<>job.id::text then return null;end if;
  for v in select value from jsonb_array_elements(coalesce(child.data->'source_versions','[]'))loop
   stamped=null;
   if v->>'table'='document_pages' then select updated_at into stamped from public.document_pages where id=(v->>'id')::uuid and user_id=p_user_id;
   elsif v->>'table'='documents' then select updated_at into stamped from public.documents where id=(v->>'id')::uuid and user_id=p_user_id;
   elsif v->>'table'='problems' then select updated_at into stamped from public.problems where id=(v->>'id')::uuid and user_id=p_user_id;end if;
   if stamped is null or stamped is distinct from (v->>'updated_at')::timestamptz then
    update public.ai_jobs set status='paused',lease_token=null,lease_until=null,data=data||jsonb_build_object('last_error','출처가 수정되어 결과를 보류했습니다.')where id=p_ai_job_id;return null;
   end if;
  end loop;
 end if;
 select count(*)into received from public.content_parts where job_id=p_job_id and user_id=p_user_id;
 if received<>p_existing_count then raise exception '분할이 다른 화면에서 추가됐습니다. 다시 검사하세요.';end if;
 select content_hash into old_hash from public.content_parts where job_id=p_job_id and part=(p_part->>'part')::int and user_id=p_user_id;
 if found and old_hash<>p_hash then raise exception '이미 등록된 분할의 내용이 다릅니다. 새 작업으로 가져오세요.';end if;
 insert into public.content_parts(user_id,job_id,part,total_parts,content_hash,raw)values(p_user_id,p_job_id,(p_part->>'part')::int,(p_part->>'total_parts')::int,p_hash,p_part)on conflict(job_id,part)do nothing;
 if coalesce((p_compiled->>'ready')::boolean,false)then
  for c in select value from jsonb_array_elements(p_compiled->'chapters')loop
   chapter=null;
   select actual_id::uuid into chapter from public.content_refs where user_id=p_user_id and job_id=p_job_id and kind='chapter'and external_id=c->>'externalId';
   if chapter is null then
    insert into public.document_chapters(user_id,document_id,title,start_page,end_page,canonical_key,data)values(p_user_id,job.document_id,c->>'title',(c->>'start_page')::int,(c->>'end_page')::int,c->>'key',c->'data')on conflict(user_id,document_id,canonical_key)do nothing;
    select id into chapter from public.document_chapters where user_id=p_user_id and document_id=job.document_id and canonical_key=c->>'key';
    insert into public.content_refs values(p_user_id,p_job_id,'chapter',c->>'externalId',chapter::text)on conflict do nothing;
   end if;
  end loop;
  for c in select value from jsonb_array_elements(p_compiled->'concepts')loop
   select actual_id::uuid into chapter from public.content_refs where user_id=p_user_id and job_id=p_job_id and kind='chapter'and external_id=c->>'chapter_id';
   if chapter is null then raise exception '미해결 단원 참조';end if;
   insert into public.concepts(user_id,subject,major,minor,name,canonical_key,data)values(p_user_id,c->>'subject',c->>'major',coalesce(c->>'minor',''),c->>'name',c->>'key',(c->'data')||jsonb_build_object('chapterId',chapter))on conflict(user_id,canonical_key)do nothing;
   select id into cid from public.concepts where user_id=p_user_id and canonical_key=c->>'key';
   insert into public.content_refs values(p_user_id,p_job_id,'concept',c->>'externalId',cid)on conflict do nothing;
   insert into public.chapter_concepts values(p_user_id,chapter,cid)on conflict do nothing;
  end loop;
  for q in select value from jsonb_array_elements(p_compiled->'questions')loop
   select actual_id::uuid into chapter from public.content_refs where user_id=p_user_id and job_id=p_job_id and kind='chapter'and external_id=q->>'chapter_id';
   concept_ids='[]';for v in select value from jsonb_array_elements(q->'concept_ids')loop
    select actual_id into cid from public.content_refs where user_id=p_user_id and job_id=p_job_id and kind='concept'and external_id=v#>>'{}';
    if cid is null then raise exception '미해결 개념 참조';end if;concept_ids=concept_ids||jsonb_build_array(cid);
   end loop;
   if jsonb_array_length(concept_ids)=0 then raise exception '개념이 없는 문항';end if;
   select question_id into qid from public.question_fingerprints where user_id=p_user_id and fingerprint=q->>'fingerprint';inserted=qid is null;
   if inserted then
    qid=gen_random_uuid()::text;new_data=(q->'data')||jsonb_build_object('id',qid,'conceptId',concept_ids->>0,'conceptIds',concept_ids,'chapterId',chapter,'active',p_reviewed,'reviewStatus',case when p_reviewed then 'approved'else 'needs_review'end);
    insert into public.concept_questions(id,user_id,concept_id,type,difficulty,review_status,data)values(qid,p_user_id,concept_ids->>0,new_data->>'type',new_data->>'difficulty',case when p_reviewed then 'approved'else 'needs_review'end,new_data);
    insert into public.question_fingerprints values(p_user_id,q->>'fingerprint',qid);
    n=0;for v in select value from jsonb_array_elements(new_data->'choices')loop
     insert into public.question_options(user_id,question_id,position,data)values(p_user_id,qid,n,jsonb_build_object('text',v,'feedback',new_data->'choiceFeedback'->(v#>>'{}')));n=n+1;
    end loop;
   else
    update public.concept_questions set data=data||jsonb_build_object('sources',(select coalesce(jsonb_agg(distinct x),'[]')from jsonb_array_elements(coalesce(data->'sources','[]')||coalesce(q->'data'->'sources','[]'))x))||case when p_reviewed then jsonb_build_object('active',true,'reviewStatus','approved')else '{}'::jsonb end,review_status=case when p_reviewed then 'approved'else review_status end where id=qid and user_id=p_user_id;
   end if;
   insert into public.content_refs values(p_user_id,p_job_id,'question',q->>'externalId',qid)on conflict do nothing;
   for cid in select jsonb_array_elements_text(concept_ids)loop insert into public.bank_question_concepts values(p_user_id,qid,cid)on conflict do nothing;end loop;
   insert into public.bank_question_origins(user_id,question_id,document_id,chapter_id,purpose,data)values(p_user_id,qid,job.document_id,chapter,q->>'purpose',jsonb_build_object('source_problem',q->'source_problem'))on conflict do nothing;
  end loop;
  for c in select value from jsonb_array_elements(p_compiled->'flashcards')loop
   select actual_id into cid from public.content_refs where user_id=p_user_id and job_id=p_job_id and kind='concept'and external_id=c->>'concept_id';
   select question_id into qid from public.question_fingerprints where user_id=p_user_id and fingerprint=c->>'fingerprint';
   if qid is null then
    qid=gen_random_uuid()::text;new_data=(c->'data')||jsonb_build_object('id',qid,'conceptId',cid,'conceptIds',jsonb_build_array(cid),'active',p_reviewed,'reviewStatus',case when p_reviewed then 'approved'else 'needs_review'end);
    insert into public.concept_questions(id,user_id,concept_id,type,difficulty,review_status,data)values(qid,p_user_id,cid,'플래시카드','기본',case when p_reviewed then 'approved'else 'needs_review'end,new_data);
    insert into public.question_fingerprints values(p_user_id,c->>'fingerprint',qid);
   end if;
   insert into public.content_refs values(p_user_id,p_job_id,'flashcard',c->>'externalId',qid)on conflict do nothing;
   insert into public.bank_question_concepts values(p_user_id,qid,cid)on conflict do nothing;
  end loop;
  for a in select value from jsonb_array_elements(p_compiled->'analyses')loop
   select actual_id::uuid into chapter from public.content_refs where user_id=p_user_id and job_id=p_job_id and kind='chapter'and external_id=a->>'chapter_id';
   concept_ids='[]';for v in select value from jsonb_array_elements(a->'concept_ids')loop select actual_id into cid from public.content_refs where user_id=p_user_id and job_id=p_job_id and kind='concept'and external_id=v#>>'{}';concept_ids=concept_ids||jsonb_build_array(cid);end loop;
   select case when count(*)=1 then min(id::text)::uuid else null end into problem_id from public.problems where user_id=p_user_id and document_id=job.document_id and number::text=ltrim(a->>'q_number','0')and page=(a->>'pdf_page')::int;
   analysis_id=null;insert into public.imported_problem_analyses(user_id,document_id,chapter_id,q_number,pdf_page,problem_id,data)values(p_user_id,job.document_id,chapter,a->>'q_number',(a->>'pdf_page')::int,problem_id,a||jsonb_build_object('conceptIds',concept_ids,'jobId',p_job_id))on conflict(user_id,document_id,chapter_id,q_number,pdf_page)do nothing returning id into analysis_id;
   if analysis_id is not null and problem_id is not null then
    for cid in select jsonb_array_elements_text(concept_ids)loop insert into public.problem_concepts values(p_user_id,problem_id,cid)on conflict do nothing;end loop;
    update public.problems set data=case when data?'analysis' then data else data||jsonb_build_object('analysis',a,'memorize',a->'memorize','chapterId',chapter)end where id=problem_id and user_id=p_user_id;
   end if;
  end loop;
  for a in select value from jsonb_array_elements(p_compiled->'similarities')loop
   insert into public.problem_similarities(user_id,document_id,a,b,score,reason,content_hash)values(p_user_id,job.document_id,a->'a',a->'b',(a->>'score')::numeric,a->>'reason',a->>'fingerprint')on conflict do nothing;
  end loop;
  update public.content_parts set applied=true where job_id=p_job_id and user_id=p_user_id;
 end if;
 select count(*)into received from public.content_parts where job_id=p_job_id and user_id=p_user_id;
 select count(distinct actual_id)into question_total from public.content_refs where job_id=p_job_id and user_id=p_user_id and kind='question';
 select count(distinct actual_id)into card_total from public.content_refs where job_id=p_job_id and user_id=p_user_id and kind='flashcard';
 update public.content_jobs set status=case when not coalesce((p_compiled->>'ready')::boolean,false)then 'pending_refs'when received<(data->>'totalParts')::int then 'partial'when question_total<(data->>'questionCount')::int then 'needs_more'when p_reviewed then 'ready'else 'review_needed'end,data=data||jsonb_build_object('receivedParts',received,'importedQuestions',question_total,'importedFlashcards',card_total)where id=p_job_id and user_id=p_user_id;
 if p_ai_job_id is not null then update public.ai_jobs set status='completed',lease_token=null,lease_until=null,data=data||jsonb_build_object('standardResult',p_part)where id=p_ai_job_id and user_id=p_user_id;end if;
 return jsonb_build_object('jobId',p_job_id,'receivedParts',received,'questions',question_total,'flashcards',card_total,'ready',coalesce((p_compiled->>'ready')::boolean,false),'status',(select status from public.content_jobs where id=p_job_id));
end$$;
revoke all on function public.commit_restudy_part(uuid,uuid,jsonb,text,int,jsonb,boolean,uuid,uuid)from public,anon,authenticated;
grant execute on function public.commit_restudy_part(uuid,uuid,jsonb,text,int,jsonb,boolean,uuid,uuid)to service_role;
