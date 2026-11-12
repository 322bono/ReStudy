import { generationModels,catalogVersion,generationContractVersion,isGenerationModel,requiresFreeProject } from "./catalog.ts";
import { verifyGoogleFreeProject } from "./google-free-project.ts";
import { decryptKey, encryptKey, type Provider } from "./crypto.ts";
import { ProviderError } from "./providers.ts";
import { discoverProviderModels, ModelDiscoveryError } from "./providers-discovery.ts";
import { providerState, sanitizeSettings } from "./settings.ts";
import type { Json } from "./schemas.ts";
import type { AccessContext } from "../access.ts";
export type AuthContext = { user: { id: string }; db: any; admin: any } & AccessContext;
export class AiError extends Error { constructor(public code: string, public status = 400) { super(code); } }
export function checked(result: { data: any; error: any }): any { if (result.error) throw new AiError("database_error", 500); return result.data; }
export async function readProfile(ctx: AuthContext): Promise<Json> { return checked(await ctx.admin.from("profiles").select("data").eq("user_id", ctx.user.id).maybeSingle())?.data ?? {}; }
export async function loadProviders(ctx: AuthContext): Promise<any[]> { return checked(await ctx.admin.from("ai_providers").select("provider,data").eq("user_id", ctx.user.id)) ?? []; }
export async function loadSlots(ctx: AuthContext): Promise<Json[]> { return checked(await ctx.admin.from("ai_key_slots").select("*").eq("user_id", ctx.user.id).order("id")) ?? []; }
const availableModels = (verifierConfigured: boolean) =>
  generationModels.filter(m => verifierConfigured || !requiresFreeProject(m.provider, m.id));
export function slotModels(slot: Json, verifierConfigured = !!verifyGoogleFreeProject): typeof generationModels {
  const ids = Array.isArray(slot.data?.modelIds) ? slot.data.modelIds : [];
  return availableModels(verifierConfigured).filter(m => m.provider === slot.provider && ids.includes(m.id));
}
export function publicSlot(slot: Json, verifierConfigured = !!verifyGoogleFreeProject): Json {
  const d=slot.data??{},state=providerState(slot.provider,d,true);
  if(slot.provider!=='gemini'||![generationContractVersion,'validated-json-v2-gemma4'].includes(d.generation_contract_version))state.generation_verified=false;
  const available=slotModels(slot,verifierConfigured),saved=Array.isArray(d.selectedModels)?d.selectedModels:undefined;
  const selected=saved?.filter((id:string)=>available.some(model=>model.id===id))??[];
  // Adapt historic nonempty Gemini selections without rewriting stored IDs.
  // An explicitly empty configured pool remains disabled.
  const selectedModels=d.poolConfigured!==true ? available.map(model=>model.id) :
    saved?.length===0 ? [] : selected.length ? selected : available.map(model=>model.id);
  return {...state,enabled:state.enabled&&slot.provider==='gemini',id:slot.id,label:d.label??'API 키',legacy:d.legacy===true,quotaGroup:d.quotaGroup??'shared',models:available,selectedModels,notice:slot.provider==='nvidia'?'기존 키는 보존됩니다. 과금 없는 모델 전용 정책으로 NVIDIA 생성은 중지되어 있습니다.':undefined};
}
function group(value: unknown): string {
  if (value===undefined) return 'shared';
  if(typeof value!=='string'||!value.trim()||value.length>64||! /^[\w.:-]+$/.test(value.trim()))throw new AiError('invalid_quota_group');
  return value.trim();
}
function targetSlot(body:Json,slots:Json[]):Json {
  const candidates=slots.filter(s=>s.provider===body.provider);
  const slot=body.credentialId?candidates.find(s=>s.id===body.credentialId):candidates.length===1?candidates[0]:undefined;
  if(!slot)throw new AiError(body.credentialId||!candidates.length?'credential_not_found':'credential_id_required',404);
  return slot;
}
export async function patchSlot(ctx:AuthContext,slot:Json,changes:Json):Promise<void> {
  const fresh=checked(await ctx.admin.from('ai_key_slots').select('data').eq('id',slot.id).eq('user_id',ctx.user.id).maybeSingle());
  if(!fresh)throw new AiError('credential_not_found',404);
  const saved=checked(await ctx.admin.from('ai_key_slots').update({data:{...fresh.data,...changes}}).eq('id',slot.id).eq('user_id',ctx.user.id).eq('ciphertext',slot.ciphertext).select('id').maybeSingle());
  if(!saved)throw new AiError('credential_changed',409);
}
export async function credentialAction(body: Json, ctx: AuthContext, master: string, transport: typeof fetch = fetch): Promise<Json> {
  const action=body.action??'status';
  if(action==='settings'){
    const profile=await readProfile(ctx),settings=sanitizeSettings({...profile.ai_settings,...(body.settings??body)});
    checked(await ctx.admin.from('profiles').update({data:{...profile,ai_settings:settings}}).eq('user_id',ctx.user.id));return{settings};
  }
  const slots=ctx.access?.personalKeys===false||ctx.access?.ai===false?[]:await loadSlots(ctx);
  if(action==='status'){
    const [profile,jobs,usage]=await Promise.all([readProfile(ctx),ctx.admin.from('ai_jobs').select('id,kind,status,attempts,available_at,created_at,updated_at,data').eq('user_id',ctx.user.id).order('created_at',{ascending:false}).limit(30).then(checked),ctx.admin.from('ai_usage_logs').select('id,job_id,data,created_at').eq('user_id',ctx.user.id).order('created_at',{ascending:false}).limit(50).then(checked)]);
    return{providers: (['nvidia','gemini'] as Provider[]).map(provider=>{const credentials=slots.filter(s=>s.provider===provider).map(slot=>publicSlot(slot));return{...providerState(provider,credentials[0]??{},credentials.length>0),provider,credentials};}),models:availableModels(!!verifyGoogleFreeProject),settings:sanitizeSettings(profile.ai_settings),encryption_configured:!!master,free_project_verification_configured:!!verifyGoogleFreeProject,
      jobs:jobs.map((r:Json)=>({id:r.id,kind:r.kind,status:r.status,attempts:r.attempts,available_at:r.available_at,created_at:r.created_at,updated_at:r.updated_at,last_error:r.data?.last_error??null})),
      usage:usage.map((r:Json)=>({id:r.id,job_id:r.job_id,created_at:r.created_at,...Object.fromEntries(['provider','credential_id','key_label','model','kind','success','attempt','duration_ms','error','diagnostic','response_metadata','http_status','usage'].filter(k=>r.data?.[k]!==undefined).map(k=>[k,r.data[k]]))}))};
  }
  if(!['nvidia','gemini'].includes(body.provider))throw new AiError('invalid_provider');
  const provider=body.provider as Provider;
  if(action==='delete'){
    const slot=targetSlot(body,slots);
    checked(await ctx.admin.from('ai_key_slots').delete().eq('user_id',ctx.user.id).eq('id',slot.id));
    if(slot.data.legacy)checked(await ctx.admin.from('ai_credentials').delete().eq('user_id',ctx.user.id).eq('provider',provider));
    return{provider,credentialId:slot.id,configured:false};
  }
  if(action==='toggle'){
    const slot=targetSlot(body,slots);if(typeof body.enabled!=='boolean')throw new AiError('invalid_request');
    if(provider==='nvidia'&&body.enabled)throw new AiError('free_only_policy');
    const changes:Json={enabled:body.enabled,quotaGroup:group(body.quotaGroup??slot.data.quotaGroup)};
    if(body.selectedModels!==undefined){const allowed=slotModels(slot).map(m=>m.id);if(!Array.isArray(body.selectedModels)||body.selectedModels.length>50||body.selectedModels.some((id:unknown)=>typeof id!=='string'||!allowed.includes(id)))throw new AiError('invalid_model');changes.selectedModels=[...new Set(body.selectedModels)];changes.poolConfigured=true;}
    if(body.autoModels===true)changes.poolConfigured=false;
    await patchSlot(ctx,slot,changes);return{ok:true};
  }
  if(!['save','check','discover'].includes(action))throw new AiError('invalid_action');
  if(provider==='nvidia'&&action!=='discover')throw new AiError('free_only_policy');
  if(!master)throw new AiError('encryption_not_configured',503);
  const slot=action==='save'&&!body.credentialId?undefined:targetSlot(body,slots);
  const access=action==='save'?body.access??'unknown':slot!.data.access??'unknown';
  const label=body.label===undefined?slot?.data.label??`${provider==='nvidia'?'NVIDIA':'Gemini'} 키 ${slots.filter(s=>s.provider===provider).length+1}`:body.label;
  if(typeof label!=='string'||!label.trim()||label.length>60)throw new AiError('invalid_request');
  const quotaGroup=group(body.quotaGroup??slot?.data.quotaGroup);
  if(!['unknown','free_confirmed','paid'].includes(access))throw new AiError('invalid_credential');
  if(slot?.data.checked_at&&Date.now()-Date.parse(slot.data.checked_at)<3000)throw new AiError('check_rate_limited',429);
  let key:string,encrypted:Json|undefined,fingerprint:string|undefined;
  if(action==='save'){
    if(typeof body.key!=='string'||!body.key.trim()||body.key.length>4096||/[\r\n]/.test(body.key))throw new AiError('invalid_credential');
    if(!slot&&slots.filter(s=>s.provider===provider).length>=20)throw new AiError('credential_limit');
    key=body.key.trim();encrypted=await encryptKey(key,ctx.user.id,provider,master);
    fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${ctx.user.id}:${provider}:${key}`))),v=>v.toString(16).padStart(2,'0')).join('');
    for(const other of slots.filter(s=>s.provider===provider&&s.id!==slot?.id)){
      let same=other.fingerprint===fingerprint;
      if(!other.fingerprint){try{same=await decryptKey({ciphertext:other.ciphertext,iv:other.iv,key_version:other.key_version},ctx.user.id,provider,master)===key;}catch{/* An unreadable old slot must not prevent adding a working key. */}}
      if(same)throw new AiError('credential_duplicate');
    }
  }else key=await decryptKey({ciphertext:slot!.ciphertext,iv:slot!.iv,key_version:slot!.key_version},ctx.user.id,provider,master);
  let found:Awaited<ReturnType<typeof discoverProviderModels>>,verified=false;
  try{
    found=await discoverProviderModels(provider,key,transport);
    if(!found.models.length||provider==='gemini'&&!found.models.some(m=>isGenerationModel(m.provider,m.id)))throw new AiError('no_compatible_models');
  }catch(error){
    const code=error instanceof ProviderError||error instanceof ModelDiscoveryError||error instanceof AiError?error.code:'connection_failed';
    if(slot&&action!=='save')await patchSlot(ctx,slot,{status:code==='auth_error'?'auth_error':'error',last_error:code,checked_at:new Date().toISOString()});
    throw new AiError(code,422);
  }
  const ids=found.models.map(m=>m.id),defaultSelected=found.models.filter(m=>isGenerationModel(m.provider,m.id)).map(m=>m.id);
  const data:Json={...slot?.data,label:label.trim(),quotaGroup,access,modelIds:ids,selectedModels:Array.isArray(slot?.data.selectedModels)?slot!.data.selectedModels:defaultSelected,catalog_version:catalogVersion,...(verified?{generation_contract_version:generationContractVersion}:{}),listed_at:found.listedAt,checked_at:new Date().toISOString(),
    ...(action==='discover'?{connection_verified:found.authenticationVerified||slot?.data.connection_verified===true}:{enabled:true,status:'connected',connection_verified:true,generation_verified:verified,last_error:null,cooldown_until:null})};
  const id=slot?.id??crypto.randomUUID();
  if(action==='save'){
    const values={id,user_id:ctx.user.id,provider,...encrypted,fingerprint,data};
    if(slot){const saved=checked(await ctx.admin.from('ai_key_slots').update(values).eq('user_id',ctx.user.id).eq('id',id).eq('ciphertext',slot.ciphertext).select('id').maybeSingle());if(!saved)throw new AiError('credential_changed',409);}
    else checked(await ctx.admin.from('ai_key_slots').insert(values));
    if(slot)checked(await ctx.admin.from('ai_key_model_states').delete().eq('user_id',ctx.user.id).eq('credential_id',id));
  }else await patchSlot(ctx,slot!,data);
  return{provider,credentialId:id,configured:true,status:data.status??'unverified',connection_verified:data.connection_verified===true,generation_verified:publicSlot({id,provider,data}).generation_verified};
}
