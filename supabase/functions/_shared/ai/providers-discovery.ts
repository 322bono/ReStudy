import {models,type ModelDefinition} from './catalog.ts';
import type {Provider} from './crypto.ts';

export class ModelDiscoveryError extends Error {
 constructor(public code:'auth_error'|'rate_limited'|'provider_error'|'network_error'|'invalid_response',public status?:number,public retryAt?:number){super(code)}
}
/** Metadata only: intersect provider-returned IDs with reviewed capabilities.
 * Never infer image/JSON support, billing eligibility or quota from an ID. */
export function filterDiscoveredModels(provider:Provider,raw:unknown):ModelDefinition[]{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ModelDiscoveryError('invalid_response');
 const body=raw as Record<string,any>,list=provider==='nvidia'?body.data:body.models;
 if(!Array.isArray(list))throw new ModelDiscoveryError('invalid_response');
 const ids=new Set<string>();
 for(const item of list){
  if(!item||typeof item!=='object'||Array.isArray(item))throw new ModelDiscoveryError('invalid_response');
  if(provider==='nvidia'){if(typeof item.id!=='string')throw new ModelDiscoveryError('invalid_response');ids.add(item.id)}
  else {if(typeof item.name!=='string'||!Array.isArray(item.supportedGenerationMethods))throw new ModelDiscoveryError('invalid_response');if(item.name.startsWith('models/')&&item.supportedGenerationMethods.includes('generateContent'))ids.add(item.name.slice(7))}
 }
 return models.filter(model=>model.provider===provider&&ids.has(model.id));
}
async function readMetadata(response:Response):Promise<any>{
 if(!response.body)throw new ModelDiscoveryError('invalid_response');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1024*1024){await reader.cancel();throw new ModelDiscoveryError('invalid_response')}chunks.push(value)}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
 try{return JSON.parse(new TextDecoder().decode(bytes))}catch{throw new ModelDiscoveryError('invalid_response')}
}
export async function discoverProviderModels(provider:Provider,key:string,transport:typeof fetch=fetch):Promise<{models:ModelDefinition[],listedAt:string,metadataOnly:true,authenticationVerified:boolean}>{
 if(provider!=='nvidia'&&provider!=='gemini')throw new ModelDiscoveryError('invalid_response');
 if(provider==='gemini'&&(!key?.trim()||key.length>4096||/[\r\n]/.test(key)))throw new ModelDiscoveryError('auth_error');
 const discovered=new Map<string,ModelDefinition>(),seen=new Set<string>();let pageToken='';
 for(let page=0;page<10;page++){
  const url=new URL(provider==='nvidia'?'https://integrate.api.nvidia.com/v1/models':'https://generativelanguage.googleapis.com/v1beta/models');
  if(provider==='gemini'){url.searchParams.set('pageSize','1000');if(pageToken)url.searchParams.set('pageToken',pageToken)}
  let response:Response;
  try{response=await transport(url.toString(),{headers:provider==='gemini'?{'x-goog-api-key':key}:undefined,signal:AbortSignal.timeout(15000),redirect:'error'})}catch{throw new ModelDiscoveryError('network_error')}
  if(!response.ok){
   const now=Date.now(),retry=response.headers.get('retry-after'),retryAt=retry&&/^\d+(?:\.\d+)?$/.test(retry.trim())?now+Number(retry)*1000:retry?Date.parse(retry):NaN;
   throw new ModelDiscoveryError([401,403].includes(response.status)?'auth_error':response.status===429?'rate_limited':'provider_error',response.status,response.status===429?(Number.isFinite(retryAt)&&retryAt>now?retryAt:now+60000):undefined);
  }
  const raw=await readMetadata(response);for(const model of filterDiscoveredModels(provider,raw))discovered.set(model.id,model);
  if(provider==='nvidia'||raw.nextPageToken===undefined||raw.nextPageToken==='')return {models:models.filter(m=>discovered.has(m.id)&&m.provider===provider),listedAt:new Date().toISOString(),metadataOnly:true,authenticationVerified:provider==='gemini'};
  if(typeof raw.nextPageToken!=='string'||raw.nextPageToken.length>4000||seen.has(raw.nextPageToken))throw new ModelDiscoveryError('invalid_response');
  pageToken=raw.nextPageToken;seen.add(pageToken);
 }
 throw new ModelDiscoveryError('invalid_response');
}
