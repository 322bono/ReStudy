-- Proposed additive migration. Apply through the repository migration process.
-- Service-only, SECURITY INVOKER, no Auth/credential/control writes, no remapping.
-- A single RPC runs in one PostgREST transaction. Any exception rolls it back.
create or replace function public.restore_restudy_backup(p_user_id uuid,p_package jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 contract jsonb='{
 "subjects":["id","user_id","name","data"],
 "documents":["id","user_id","title","subject","kind","content_hash","status","data","created_at","updated_at"],
 "document_pages":["id","user_id","document_id","number","image_path","data","updated_at"],
 "problems":["id","user_id","document_id","number","page","data","created_at","updated_at"],
 "problem_regions":["id","user_id","problem_id","page","part","image_path","data"],
 "concepts":["id","user_id","subject","major","minor","name","canonical_key","data","created_at","updated_at"],
 "problem_concepts":["user_id","problem_id","concept_id"],
 "concept_questions":["id","user_id","concept_id","type","difficulty","review_status","data","created_at","updated_at"],
 "question_options":["id","user_id","question_id","position","data"],
 "wrong_answers":["id","user_id","problem_id","data","created_at","updated_at"],
 "study_sessions":["id","user_id","data","created_at","updated_at"],
 "solve_sessions":["id","user_id","data","created_at","updated_at"],
 "study_results":["id","user_id","session_id","item_id","concept_id","result","data","created_at"],
 "review_schedules":["id","user_id","problem_id","concept_id","due_at","data"],
 "document_chapters":["id","user_id","document_id","title","start_page","end_page","canonical_key","data","updated_at"],
 "chapter_concepts":["user_id","chapter_id","concept_id"],
 "bank_question_concepts":["user_id","question_id","concept_id"],
 "bank_question_origins":["id","user_id","question_id","document_id","chapter_id","purpose","data"],
 "question_fingerprints":["user_id","fingerprint","question_id"],
 "imported_problem_analyses":["id","user_id","document_id","chapter_id","q_number","pdf_page","problem_id","data"],
 "problem_similarities":["id","user_id","document_id","a","b","score","reason","content_hash"]
 }';
 table_order text[]=array['subjects','documents','document_pages','problems','problem_regions','concepts','problem_concepts','concept_questions','question_options','wrong_answers','study_sessions','solve_sessions','study_results','review_schedules','document_chapters','chapter_concepts','bank_question_concepts','bank_question_origins','question_fingerprints','imported_problem_analyses','problem_similarities'];
 t text;k text;v jsonb;r jsonb;node record;path jsonb;paths jsonb;columns_sql text;pk text[];predicate text;optional text[];duplicates boolean;
 total int=0;inserted int=0;skipped int=0;affected int;exists_row boolean;stats jsonb='{}';table_inserted int;table_skipped int;nodes int=0;
begin
 if p_user_id is null or not exists(select 1 from public.profiles where user_id=p_user_id)
  or jsonb_typeof(p_package) is distinct from 'object'
  or p_package->'schemaVersion' is distinct from '1'::jsonb
  or p_package->>'type' is distinct from 'restudy-backup'
  or p_package->>'ownerId' is distinct from p_user_id::text
  or p_package->'originalsIncluded' is distinct from 'false'::jsonb
  or p_package->'sameAccountOnly' is distinct from 'true'::jsonb
  or jsonb_typeof(p_package->'createdAt') is distinct from 'string'
  or jsonb_typeof(p_package->'tables') is distinct from 'object'
  or octet_length(p_package::text)>20971520 then raise exception 'Invalid same-account data backup';end if;
 perform (p_package->>'createdAt')::timestamptz;
 if exists(select 1 from jsonb_object_keys(p_package) key where key<>all(array['schemaVersion','type','ownerId','createdAt','originalsIncluded','sameAccountOnly','tables']))then raise exception 'Unknown backup field';end if;
 if not exists(select 1 from jsonb_object_keys(p_package->'tables'))then raise exception 'Missing backup tables';end if;
 -- Validate everything, including nested historical snapshots, before inserting.
 for t,v in select key,value from jsonb_each(p_package->'tables')loop
  if not contract?t or jsonb_typeof(v)<>'array' then raise exception 'Unsupported backup table';end if;
  total=total+jsonb_array_length(v);
  if jsonb_array_length(v)>15000 or total>50000 then raise exception 'Backup row limit exceeded';end if;
  pk=case t when 'problem_concepts'then array['user_id','problem_id','concept_id'] when 'chapter_concepts'then array['user_id','chapter_id','concept_id'] when 'bank_question_concepts'then array['user_id','question_id','concept_id'] when 'question_fingerprints'then array['user_id','fingerprint']else array['id']end;
  -- A set-based identity check avoids quadratic array scans on large backups.
  select count(*)<>count(distinct(select jsonb_object_agg(field_name,field_value)from jsonb_each(entry)fields(field_name,field_value)where field_name=any(pk)))into duplicates from jsonb_array_elements(v)entries(entry);
  if duplicates then raise exception 'Duplicate backup identity';end if;
  for r in select value from jsonb_array_elements(v)loop
   if jsonb_typeof(r)<>'object' or r->>'user_id' is distinct from p_user_id::text then raise exception 'Invalid backup row owner';end if;
   optional=case t when 'documents'then array['content_hash']when 'document_pages'then array['image_path']when 'study_results'then array['concept_id']when 'review_schedules'then array['concept_id','problem_id']when 'imported_problem_analyses'then array['problem_id']else '{}'::text[]end;
   for k in select jsonb_array_elements_text(contract->t)loop
    if k<>all(optional||array['created_at','updated_at'])and(not r?k or r->k='null'::jsonb)then raise exception 'Missing required backup column';end if;
   end loop;
   for k in select jsonb_object_keys(r)loop
    if not (contract->t)?k then raise exception 'Unsupported backup column';end if;
    if r->k='null'::jsonb and k<>all(optional)then raise exception 'Invalid null backup column';end if;
    if k=any(array['data','a','b']) and jsonb_typeof(r->k)<>'object' then raise exception 'Invalid JSON data';end if;
    if k=any(array['number','page','part','position','start_page','end_page','pdf_page','score'])then
     if jsonb_typeof(r->k)<>'number' or (k<>'score' and ((r->>k)::numeric<>trunc((r->>k)::numeric)or(r->>k)::numeric<case when k in('part','position')then 0 else 1 end))or(k='score'and((r->>k)::numeric<0 or(r->>k)::numeric>1))then raise exception 'Invalid numeric field';end if;
    end if;
   end loop;
   foreach k in array pk loop
    if not r?k or r->k='null'::jsonb or r->>k='' then raise exception 'Missing backup identity';end if;
   end loop;
  end loop;
 end loop;
 for node in
  with recursive tree(value,key,depth)as(
   select p_package,null::text,0
   union all
   select children.value,children.key,tree.depth+1 from tree cross join lateral(
    select value,key from jsonb_each(case when jsonb_typeof(tree.value)='object'then tree.value else '{}'::jsonb end)
    union all select value,null::text from jsonb_array_elements(case when jsonb_typeof(tree.value)='array'then tree.value else '[]'::jsonb end)
   )children where tree.depth<=32
  )select * from tree
 loop
  nodes=nodes+1;if node.depth>32 or nodes>300000 then raise exception 'Backup nesting limit exceeded';end if;
  if node.key is not null then
   k=lower(replace(replace(node.key,'_',''),'-',''));
   if length(node.key)>200 or k=any(array['apikey','password','accesstoken','refreshtoken','authorization','servicerole','servicerolekey','masterkey','credentials','aicredentials','ciphertext','privatekey','secretkey','supabasesecretkey','supabaseservicerolekey','signedurl','signedurls','url','originalurl','imageurl','fileurl','downloadurl','publicurl','proto','prototype','constructor'])then raise exception 'Secrets and temporary URLs are excluded';end if;
   if node.key=any(array['user_id','userId','ownerId'])and node.value is distinct from to_jsonb(p_user_id::text)then raise exception 'Foreign nested owner';end if;
   if k=any(array['originalpath','pdfpath','imagepath','imagepaths','storagepath','sourcefile','cropfiles','filepath','path'])and node.value<>'null'::jsonb and node.value<>'""'::jsonb then
    paths=case when jsonb_typeof(node.value)='array'then node.value else jsonb_build_array(node.value)end;
    for path in select value from jsonb_array_elements(paths)loop
     if jsonb_typeof(path)<>'string' or length(path#>>'{}')>1000 or left(path#>>'{}',37)<>p_user_id::text||'/'
      or (path#>>'{}')~'[\\%?#[:cntrl:]]' or exists(select 1 from unnest(string_to_array(path#>>'{}','/'))segment where segment in('','.','..'))then raise exception 'Invalid private file reference';end if;
    end loop;
   end if;
  end if;
  if jsonb_typeof(node.value)='string'and length(node.value#>>'{}')>2097152 then raise exception 'Backup string too large';end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,1));
 foreach t in array table_order loop
  table_inserted=0;table_skipped=0;
  for r in select value from jsonb_array_elements(coalesce(p_package->'tables'->t,'[]'))loop
   select string_agg(format('%I',key),',')into columns_sql from jsonb_object_keys(r)key;
   -- Columns are allowlisted and quoted. Values remain bound parameters.
   execute format('insert into public.%1$I(%2$s) select %2$s from jsonb_populate_record(null::public.%1$I,$1) on conflict do nothing',t,columns_sql)using r;
   get diagnostics affected=row_count;
   if affected=1 then table_inserted=table_inserted+1;
   else
    pk=case t when 'problem_concepts'then array['user_id','problem_id','concept_id']when 'chapter_concepts'then array['user_id','chapter_id','concept_id']when 'bank_question_concepts'then array['user_id','question_id','concept_id']when 'question_fingerprints'then array['user_id','fingerprint']else array['id']end;
    select string_agg(format('existing.%1$I is not distinct from incoming.%1$I',column_name),' and ')into predicate from unnest(pk)column_name;
    execute format('select exists(select 1 from public.%1$I existing cross join jsonb_populate_record(null::public.%1$I,$1)incoming where existing.user_id=$2 and %2$s)',t,predicate)into exists_row using r,p_user_id;
    if not exists_row then raise exception 'Backup ID conflicts with an existing record; IDs will not be remapped';end if;
    table_skipped=table_skipped+1;
   end if;
  end loop;
  inserted=inserted+table_inserted;skipped=skipped+table_skipped;
  if p_package->'tables'?t then stats=stats||jsonb_build_object(t,jsonb_build_object('inserted',table_inserted,'skipped',table_skipped));end if;
 end loop;
 return jsonb_build_object('restored',true,'inserted',inserted,'skipped',skipped,'tables',stats,'originalsIncluded',false,'sameAccountOnly',true);
end$$;
revoke all on function public.restore_restudy_backup(uuid,jsonb)from public,anon,authenticated;
grant execute on function public.restore_restudy_backup(uuid,jsonb)to service_role;
