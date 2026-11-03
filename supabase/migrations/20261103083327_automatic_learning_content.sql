-- User-requested workflow: validated content is usable immediately. Never
-- change item IDs, prior results, archived content or an explicitly disabled row.
create or replace function public.activate_validated_study_content()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.review_status='needs_review'
  and new.data->>'archived' is distinct from 'true'
  and nullif(btrim(new.data->>'prompt'),'') is not null
  and nullif(btrim(new.data->>'answer'),'') is not null
  and exists(select 1 from public.concepts c where c.user_id=new.user_id and c.id=new.concept_id)
 then
  new.review_status='approved';
  new.data=new.data||jsonb_build_object('active',true,'reviewStatus','approved','autoActivated',true);
 end if;
 return new;
end $$;
revoke all on function public.activate_validated_study_content() from public,anon,authenticated;
create trigger activate_validated_study_content before insert or update on public.concept_questions
for each row execute function public.activate_validated_study_content();

create or replace function public.finish_automatic_study_preparation()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_table_name='content_jobs' and new.status='review_needed' then new.status='ready';end if;
 if tg_table_name='documents' and new.status='needs_review'
  and new.data->>'progress'='100' and nullif(new.data->>'error','')is null
 then new.status='ready';new.data=new.data||jsonb_build_object('autoAccepted',true);end if;
 return new;
end $$;
revoke all on function public.finish_automatic_study_preparation() from public,anon,authenticated;
create trigger finish_automatic_study_preparation before insert or update on public.content_jobs
for each row execute function public.finish_automatic_study_preparation();
create trigger finish_automatic_study_preparation before insert or update on public.documents
for each row execute function public.finish_automatic_study_preparation();

-- Re-enable already validated pending items, retaining every ID and history.
update public.concept_questions set data=data where review_status='needs_review' and data->>'archived' is distinct from 'true';
update public.content_jobs set status=status where status='review_needed';
update public.documents set status=status where status='needs_review' and data->>'progress'='100';
