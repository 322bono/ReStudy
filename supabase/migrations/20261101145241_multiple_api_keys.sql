-- Key slots preserve the existing AES-GCM associated data (owner + provider).
create table public.ai_key_slots(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles(user_id) on delete cascade,
 provider text not null check(provider in ('nvidia','gemini')),ciphertext text not null,iv text not null,key_version int not null,
 fingerprint text,data jsonb not null default '{}',updated_at timestamptz not null default now(),unique(id,user_id),unique(user_id,provider,fingerprint)
);
create table public.ai_key_model_states(
 user_id uuid not null,credential_id uuid not null,model text not null,data jsonb not null default '{}',updated_at timestamptz not null default now(),
 primary key(credential_id,model),foreign key(credential_id,user_id)references public.ai_key_slots(id,user_id)on delete cascade
);
create table public.ai_quota_cooldowns(
 user_id uuid not null references public.profiles(user_id)on delete cascade,provider text not null,quota_group text not null,model text not null default '',
 cooldown_until timestamptz not null,primary key(user_id,provider,quota_group,model)
);
insert into public.ai_key_slots(id,user_id,provider,ciphertext,iv,key_version,data)
 select c.id,c.user_id,c.provider,c.ciphertext,c.iv,c.key_version,
 coalesce(p.data,'{}')||jsonb_build_object('label',case c.provider when 'gemini'then 'Gemini 기존 키'else 'NVIDIA 기존 키'end,'quotaGroup','shared','legacy',true,'selectedModels',jsonb_build_array(coalesce(p.data->>'model',case c.provider when 'gemini'then 'gemini-3.8-flash'else 'meta/llama-3.3-70b-instruct'end)),'modelIds',jsonb_build_array(coalesce(p.data->>'model',case c.provider when 'gemini'then 'gemini-3.8-flash'else 'meta/llama-3.3-70b-instruct'end)))
 from public.ai_credentials c left join public.ai_providers p on p.user_id=c.user_id and p.provider=c.provider;
alter table public.ai_key_slots enable row level security;
alter table public.ai_key_model_states enable row level security;
alter table public.ai_quota_cooldowns enable row level security;
revoke all on public.ai_key_slots,public.ai_key_model_states,public.ai_quota_cooldowns from public,anon,authenticated;
grant all on public.ai_key_slots,public.ai_key_model_states,public.ai_quota_cooldowns to service_role;
create trigger touch_ai_key_slots before update on public.ai_key_slots for each row execute function public.touch_updated_at();
create trigger touch_ai_key_model_states before update on public.ai_key_model_states for each row execute function public.touch_updated_at();
create index ai_key_slots_owner on public.ai_key_slots(user_id,provider);
create index ai_key_model_owner on public.ai_key_model_states(user_id,credential_id);
create function public.set_ai_quota_cooldown(p_user_id uuid,p_provider text,p_group text,p_model text,p_until timestamptz)returns void
 language sql security invoker set search_path='' as $$
 insert into public.ai_quota_cooldowns(user_id,provider,quota_group,model,cooldown_until)values(p_user_id,p_provider,p_group,p_model,p_until)
 on conflict(user_id,provider,quota_group,model)do update set cooldown_until=greatest(public.ai_quota_cooldowns.cooldown_until,excluded.cooldown_until);
$$;
revoke all on function public.set_ai_quota_cooldown(uuid,text,text,text,timestamptz)from public,anon,authenticated;
grant execute on function public.set_ai_quota_cooldown(uuid,text,text,text,timestamptz)to service_role;
