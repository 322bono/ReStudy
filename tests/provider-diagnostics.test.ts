import {expect,test} from 'vitest';
import {requestDiagnostic,generate,checkConnection,ProviderError,geminiSchema} from '../supabase/functions/_shared/ai/providers';
import {RestudySchema,RestudyJSONSchema}from'../src/domain/restudy';
test('standard generation sends one contract in JSON mode without duplicate tool schema',async()=>{
 const transport=(async(_url,init)=>{
  const body=JSON.parse(String(init?.body));expect(body.response_format).toEqual({type:'json_object'});expect(body.tools).toBeUndefined();expect(body.messages[1].content).toBe('one-contract');
  expect(body.messages[0].content).toContain('restudy.v1');expect(body.messages[0].content).not.toMatch(/concept_keys|multiple_choice|option id|submit_result/);
  return new Response(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}]}));
 })as typeof fetch;
 expect((await generate('nvidia','nvidia/nemotron-3-super-120b-a12b','test-only',{kind:'restudy_v1',prompt:'one-contract'},transport,Date.now())).raw).toEqual({});
});
test('Nemotron requests explicitly disable chat-template thinking while GPT OSS uses only its documented effort parameter',async()=>{
 const requests:any[]=[];
 const transport=(async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}]}));})as typeof fetch;
 for(const model of ['nvidia/nemotron-3.5-lightning-30b-a3b','nvidia/nemotron-3-super-120b-a12b','nvidia/nemotron-3-ultra-550b-a55b','nvidia/nemotron-3.5-super-vl-120b-a12b','nvidia/nemotron-3.5-bolt-e4b'])await generate('nvidia',model,'test-only',{kind:'restudy_v1',prompt:'fixture'},transport,Date.now());
 expect(requests.every(request=>request.chat_template_kwargs?.enable_thinking===false)).toBe(true);
 expect(requests.at(-1).model).toBe('stg/nvidia/nemotron-3.5-bolt-e4b');
 await generate('nvidia','openai/gpt-oss-20b','test-only',{kind:'restudy_v1',prompt:'fixture'},transport,Date.now());
 expect(requests.at(-1)).toMatchObject({reasoning_effort:'low'});expect(requests.at(-1).chat_template_kwargs).toBeUndefined();
});
test('NVIDIA key verification requires a completed minimal JSON inference rather than merely a choices array',async()=>{
 const transport=(async(_url,init)=>{const request=JSON.parse(String(init?.body));expect(request.chat_template_kwargs).toEqual({enable_thinking:false});expect(request.max_tokens).toBeGreaterThanOrEqual(64);return new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}]}));})as typeof fetch;
 await expect(checkConnection('nvidia','nvidia/nemotron-3.5-lightning-30b-a3b','test-only',transport)).resolves.toBeUndefined();
 await expect(checkConnection('nvidia','nvidia/nemotron-3.5-lightning-30b-a3b','test-only',(async()=>new Response(JSON.stringify({choices:[{message:{content:null,reasoning:'private'},finish_reason:'length'}]})))as typeof fetch)).rejects.toMatchObject({code:'invalid_response'});
});
test('response diagnostics retain bounded counts and finish categories without private content or reasoning',async()=>{
 const transport=(async()=>new Response(JSON.stringify({choices:[{message:{content:null,reasoning_content:'private-reasoning'},finish_reason:'length'}],usage:{completion_tokens:8192,completion_tokens_details:{reasoning_tokens:8192}}})))as typeof fetch;
 const error=await generate('nvidia','nvidia/nemotron-3.5-lightning-30b-a3b','private-key',{kind:'restudy_v1',prompt:'private-prompt'},transport,Date.now()).catch(e=>e);
 expect(error.responseMetadata).toMatchObject({finish_reason:'length',content_chars:0,reasoning_chars:17,usage:{completion_tokens:8192,reasoning_tokens:8192}});
 expect(JSON.stringify(error)).not.toMatch(/private/);
});
test('Gemma 4 uses its documented MINIMAL thinking level and NVIDIA images use standard base64 content parts',async()=>{
 const image={mimeType:'image/png',data:'dGVzdA=='};
 const transport=(async(url,init)=>{const request=JSON.parse(String(init?.body));
  if(String(url).includes('googleapis')){expect(request.generationConfig.thinkingConfig.thinkingLevel).toBe('MINIMAL');return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'{}'}]},finishReason:'STOP'}]}));}
  expect(request.messages[1].content).toEqual([{type:'image_url',image_url:{url:'data:image/png;base64,dGVzdA=='}},{type:'text',text:'fixture'}]);
  return new Response(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}]}));
 })as typeof fetch;
 await generate('gemini','gemma-4-26b-a4b-it','test-only',{kind:'restudy_v1',prompt:'fixture'},transport,Date.now());
 await generate('nvidia','nvidia/nemotron-3.5-super-vl-120b-a12b','test-only',{kind:'restudy_v1',prompt:'fixture',images:[image]},transport,Date.now());
});
test('provider schema uses supported constraints while application validation retains conditional answer rules',()=>{
 const schema=geminiSchema(RestudyJSONSchema);
 expect(schema.properties.schema_version.enum).toEqual(['restudy.v1']);
 expect(schema.properties.questions.items.allOf).toBeUndefined();
 expect(JSON.stringify(schema)).not.toMatch(/allOf|propertyNames|exclusiveMinimum|\$schema/);
 const bad={schema_version:'restudy.v1',document_id:'d',job_id:'j',part:1,total_parts:1,chapters:[],concepts:[],problem_analyses:[],flashcards:[],similarities:[],questions:[{id:'q',chapter_id:'c',concept_ids:['x'],kind:'mcq',purpose:'concept',level:'easy',source_problem:null,prompt:'질문',options:['1','2','3','4'],answer:'E',accepted_answers:[],explanation:'설명',option_explanations:{A:'설명',B:'설명',C:'설명',D:'설명'},source_pages:[1]}]};
 expect(RestudySchema.safeParse(bad).success).toBe(false);
});
test('request failure diagnostics expose fixed categories without provider messages or secret values',async()=>{
 const payload={error:{message:'Invalid schema allOf; key=private-value and source=private-text'}};
 expect(requestDiagnostic(payload)).toBe('schema_rejected');
 const transport=(async()=>new Response(JSON.stringify(payload),{status:400}))as typeof fetch;
 try{await generate('gemini','gemini-3.6-flash','private-key',{kind:'restudy_v1',prompt:'private-source'},transport,Date.now());throw Error('expected rejection');}
 catch(error){expect(error).toBeInstanceOf(ProviderError);expect(error).toMatchObject({code:'request_invalid',diagnostic:'schema_rejected',status:400});expect(JSON.stringify(error)).not.toMatch(/private/);}
 expect(requestDiagnostic({error:{message:'Unknown name "store"'}})).toBe('store_rejected');
 expect(requestDiagnostic({error:{message:'private arbitrary message'}})).toBe('invalid_argument');
});
test('only removes a complete JSON code fence or BOM without repairing incomplete or ambiguous output',async()=>{
 const transport=(content:string)=>(async()=>new Response(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]})))as typeof fetch;
 const input={kind:'restudy_v1' as const,prompt:'fixture'};
 expect((await generate('nvidia','nvidia/nemotron-3-super-120b-a12b','test-only',input,transport('\uFEFF```json\n{"chapters":[]}\n```'),Date.now())).raw).toEqual({chapters:[]});
 await expect(generate('nvidia','nvidia/nemotron-3-super-120b-a12b','test-only',input,transport('Result: {"chapters":[]}'),Date.now())).rejects.toMatchObject({code:'invalid_response',diagnostic:'json_invalid'});
});
test('classifies a response body timeout as a timeout rather than invalid JSON',async()=>{
 const transport=(async()=>new Response(new ReadableStream({start(controller){controller.error(new DOMException('private upstream message','TimeoutError'));}})))as typeof fetch;
 await expect(generate('gemini','gemini-3.6-flash','test-only',{kind:'restudy_v1',prompt:'fixture'},transport,Date.now())).rejects.toMatchObject({code:'timeout'});
});
test('standard Gemini content uses the established compact JSON mode while legacy structured tasks retain schemas',async()=>{
 let calls=0;
 const transport=(async(_url,init)=>{
  const config=JSON.parse(String(init?.body)).generationConfig;
  expect(config.responseFormat.text.mimeType).toBe('APPLICATION_JSON');
  if(calls++===0)expect(config.responseFormat.text.schema).toBeUndefined();
  else expect(config.responseFormat.text.schema.properties.questions).toBeDefined();
  expect(config.temperature).toBeUndefined();
  return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'{}'}]},finishReason:'STOP'}]}));
 })as typeof fetch;
 expect((await generate('gemini','gemini-3.6-flash','test-only',{kind:'restudy_v1',prompt:'fixture'},transport,Date.now())).raw).toEqual({});
 await generate('gemini','gemini-3.6-flash','test-only',{kind:'generate_questions',prompt:'fixture'},transport,Date.now());
});
