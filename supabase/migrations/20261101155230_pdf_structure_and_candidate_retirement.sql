-- Retain old rows/images. Only unused, unconfirmed automatic candidates can
-- leave the current index; manual/confirmed/mapped/history-linked IDs survive.
create function public.retire_unmatched_pdf_candidates(p_document uuid,p_keep uuid[],p_token text,p_layout_version text)returns jsonb
language plpgsql security invoker set search_path='' as $$
declare uid uuid=(select auth.uid());doc public.documents;n int;begin
 select * into doc from public.documents where id=p_document and user_id=uid for update;
 if not found or doc.data->>'processingToken' is distinct from p_token then raise exception '분석 작업이 다른 화면에서 변경됐습니다.';end if;
 if cardinality(p_keep)>20000 then raise exception '후보 범위가 너무 큽니다.';end if;
 update public.problems p set data=p.data||jsonb_build_object('autoRetired',true,'retiredByLayout',p_layout_version)
 where p.document_id=p_document and p.user_id=uid and not(p.id=any(p_keep))
 and coalesce((p.data->>'confirmed')::boolean,false)=false and coalesce(p.data->>'source','')<>'manual'
 and not exists(select 1 from public.wrong_answers w where w.problem_id=p.id and w.user_id=uid)
 and not exists(select 1 from public.problem_concepts m where m.problem_id=p.id and m.user_id=uid)
 and not exists(select 1 from public.imported_problem_analyses a where a.problem_id=p.id and a.user_id=uid)
 and not exists(select 1 from public.solve_sessions s where s.user_id=uid and s.data::text like '%'||p.id::text||'%')
 and not exists(select 1 from public.study_sessions s where s.user_id=uid and s.data::text like '%'||p.id::text||'%');
 get diagnostics n=row_count;return jsonb_build_object('retired',n);
end$$;
revoke all on function public.retire_unmatched_pdf_candidates(uuid,uuid[],text,text)from public,anon;
grant execute on function public.retire_unmatched_pdf_candidates(uuid,uuid[],text,text)to authenticated;

create function public.save_local_pdf_outline(p_user_id uuid,p_document uuid,p_outline jsonb,p_token text default null)returns jsonb
language plpgsql security invoker set search_path='' as $$
declare doc public.documents;e jsonb;cid uuid;parent uuid;n int=0;begin
 select * into doc from public.documents where id=p_document and user_id=p_user_id for update;
 if not found or (p_token is not null and doc.data->>'processingToken' is distinct from p_token)then raise exception '원본 또는 분석 작업이 변경됐습니다.';end if;
 if p_outline->>'schema_version'<>'re.pdf-outline.v1' or jsonb_typeof(p_outline->'entries')<>'array' or jsonb_array_length(p_outline->'entries')>1000 then raise exception '목차 형식을 확인하세요.';end if;
 for e in select value from jsonb_array_elements(p_outline->'entries')loop
  if length(e->>'title')not between 1 and 300 or length(e->>'id')not between 1 and 100 then raise exception '목차 이름과 ID를 확인하세요.';end if;
  if e->>'pdfPage'is null then continue;end if;
  if (e->>'pdfPage')::int<1 or (e->>'endPage')::int<(e->>'pdfPage')::int or (e->>'endPage')::int>(doc.data->>'pageCount')::int then raise exception '실제 PDF 목차 범위를 확인하세요.';end if;
  cid=null;select id into cid from public.document_chapters where user_id=p_user_id and document_id=p_document and canonical_key=e->>'canonicalKey';
  if cid is null then select id into cid from public.document_chapters where user_id=p_user_id and document_id=p_document and data->>'localOutlineId'=e->>'id'and data->>'source'='local_toc'and (coalesce((data->>'userEdited')::boolean,false)=false or p_outline->>'manual'='true');end if;
  if cid is null then
   insert into public.document_chapters(user_id,document_id,title,start_page,end_page,canonical_key,data)values(p_user_id,p_document,e->>'title',(e->>'pdfPage')::int,(e->>'endPage')::int,e->>'canonicalKey',jsonb_build_object('source','local_toc','localOutlineId',e->>'id','level',e->'level','parentLocalId',e->'parentId','printedPage',e->'printedPage','sourcePage',e->'sourcePage','bbox',e->'bbox','needsReview',coalesce((p_outline->>'manual')::boolean,false)=false,'userEdited',coalesce((p_outline->>'manual')::boolean,false)))returning id into cid;
  else
   update public.document_chapters set title=e->>'title',start_page=(e->>'pdfPage')::int,end_page=(e->>'endPage')::int,canonical_key=e->>'canonicalKey',data=data||jsonb_build_object('level',e->'level','parentLocalId',e->'parentId','printedPage',e->'printedPage','sourcePage',e->'sourcePage','bbox',e->'bbox')||case when p_outline->>'manual'='true' then '{"userEdited":true,"needsReview":false}'::jsonb else '{}'::jsonb end where id=cid and user_id=p_user_id and data->>'source'='local_toc'and (coalesce((data->>'userEdited')::boolean,false)=false or p_outline->>'manual'='true');
  end if;n=n+1;
 end loop;
 update public.document_chapters c set data=c.data||jsonb_build_object('parentId',p.id)from public.document_chapters p where c.user_id=p_user_id and c.document_id=p_document and p.user_id=c.user_id and p.document_id=c.document_id and p.data->>'localOutlineId'=c.data->>'parentLocalId'and c.data->>'source'='local_toc'and (coalesce((c.data->>'userEdited')::boolean,false)=false or p_outline->>'manual'='true');
 update public.documents set data=data||jsonb_build_object('localOutline',p_outline)where id=p_document and user_id=p_user_id;
 return jsonb_build_object('saved',n);
end$$;
revoke all on function public.save_local_pdf_outline(uuid,uuid,jsonb,text)from public,anon,authenticated;
grant execute on function public.save_local_pdf_outline(uuid,uuid,jsonb,text)to service_role;
