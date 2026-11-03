import {expect,test} from 'vitest';
import {defaultModel,modelFor} from '../supabase/functions/_shared/ai/catalog.ts';
import {discoverProviderModels,filterDiscoveredModels} from '../supabase/functions/_shared/ai/providers-discovery.ts';
import {publicSlot}from'../supabase/functions/_shared/ai/key-slots.ts';

test('current documented NVIDIA default has a bounded hosted output budget',()=>{
 expect(defaultModel('nvidia')).toBe('nvidia/nemotron-3-super-120b-a12b');
 expect(modelFor('nvidia',defaultModel('nvidia'))?.maxOutputTokens).toBe(32768);
 expect(modelFor('nvidia','openai/gpt-oss-20b')?.maxOutputTokens).toBe(4096);
});
test('public NVIDIA discovery intersects returned IDs without authenticating a key or admitting unknown capabilities',async()=>{
 const calls:any[]=[];
 const result=await discoverProviderModels('nvidia','never-send-this-key',async(url,options)=>{
  calls.push({url,options});
  return new Response(JSON.stringify({data:[{id:'nvidia/nemotron-3-super-120b-a12b'},{id:'openai/gpt-oss-20b'},{id:'unknown/model'},{id:'nvidia/nemotron-3-super-120b-a12b'}]}));
 });
 expect(result.models.map(m=>m.id)).toEqual(['nvidia/nemotron-3-super-120b-a12b','openai/gpt-oss-20b']);
 expect(result).toMatchObject({metadataOnly:true,authenticationVerified:false});
 expect(JSON.stringify(calls)).not.toContain('never-send-this-key');
 expect(result.models.some(m=>m.id==='meta/llama-3.3-70b-instruct')).toBe(false);
});
test('pure Gemini filter requires generateContent, real known IDs and complete metadata shape',()=>{
 expect(filterDiscoveredModels('gemini',{models:[{name:'models/gemini-3.8-flash',supportedGenerationMethods:['generateContent']},{name:'models/gemini-3.6-flash',supportedGenerationMethods:['embedContent']},{name:'models/new-unknown',supportedGenerationMethods:['generateContent']}]}).map(m=>m.id)).toEqual(['gemini-3.8-flash']);
 expect(()=>filterDiscoveredModels('nvidia',{models:[]})).toThrow();
});
test('new documented models are offered only when the provider actually lists their exact logical IDs',()=>{
 const nim=filterDiscoveredModels('nvidia',{data:[{id:'nvidia/nemotron-3.5-bolt-e4b'},{id:'nvidia/nemotron-3.5-super-vl-120b-a12b'},{id:'invented-latest/model'}]});
 expect(nim.map(m=>m.id)).toEqual(['nvidia/nemotron-3.5-bolt-e4b','nvidia/nemotron-3.5-super-vl-120b-a12b']);
 expect(nim[0].requestModel).toBe('stg/nvidia/nemotron-3.5-bolt-e4b');
 const gemma=filterDiscoveredModels('gemini',{models:[{name:'models/gemma-4-26b-a4b-it',supportedGenerationMethods:['generateContent']},{name:'models/gemma-4-31b-it',supportedGenerationMethods:['generateContent']}]});
 expect(gemma.map(m=>m.id)).toEqual(['gemma-4-26b-a4b-it','gemma-4-31b-it']);expect(gemma.every(m=>m.freeEligible===true)).toBe(true);
});
test('historic NVIDIA verification never advertises current allowed generation',()=>{
 const slot={provider:'nvidia',id:'slot',data:{generation_verified:true,connection_verified:true,modelIds:['nvidia/nemotron-3.5-lightning-30b-a3b'],selectedModels:['nvidia/nemotron-3.5-lightning-30b-a3b'],access:'free_confirmed'}};
 expect(publicSlot(slot)).toMatchObject({connection_verified:true,generation_verified:false});
 expect(publicSlot({...slot,data:{...slot.data,generation_contract_version:'validated-json-v2-gemma4'}})).toMatchObject({enabled:false,generation_verified:false});
 const gemma={...slot,provider:'gemini',data:{...slot.data,generation_contract_version:'validated-json-v2-gemma4',modelIds:['gemma-4-26b-a4b-it'],selectedModels:['gemma-4-26b-a4b-it']}};
 expect(publicSlot(gemma)).toMatchObject({generation_verified:true});
});
test('Gemini discovery follows page tokens and sends the key only in its header',async()=>{
 const calls:any[]=[];
 const result=await discoverProviderModels('gemini','test-only-key',async(url,options)=>{
  calls.push({url:String(url),options});
  return new Response(JSON.stringify(calls.length===1?{models:[{name:'models/gemini-3.8-flash',supportedGenerationMethods:['generateContent']}],nextPageToken:'next/page'}:{models:[{name:'models/gemini-3.5-flash-lite',supportedGenerationMethods:['generateContent']}]}));
 });
 expect(result.models.map(m=>m.id)).toEqual(['gemini-3.8-flash','gemini-3.5-flash-lite']);
 expect(result).toMatchObject({metadataOnly:true,authenticationVerified:true});
 expect(calls[1].url).toContain('pageToken=next%2Fpage');
 expect(calls.every(call=>!call.url.includes('test-only-key')&&call.options.headers['x-goog-api-key']==='test-only-key')).toBe(true);
});
test('discovery fails closed on provider denial and retains Retry-After without upstream bodies',async()=>{
 const error=await discoverProviderModels('gemini','test-only-key',async()=>new Response('upstream-secret',{status:429,headers:{'Retry-After':'90'}})).catch(e=>e);
 expect(error).toMatchObject({code:'rate_limited',status:429});
 expect(error.retryAt).toBeGreaterThan(Date.now()+85000);
 expect(String(error)).not.toContain('upstream-secret');
});
