import {expect,test} from 'vitest';
import {requestDiagnostic,generate,ProviderError,geminiSchema} from '../supabase/functions/_shared/ai/providers';
import {RestudySchema,RestudyJSONSchema}from'../src/domain/restudy';
test('standard generation sends one contract in JSON mode without duplicate tool schema',async()=>{
 const transport=(async(_url,init)=>{
  const body=JSON.parse(String(init?.body));expect(body.response_format).toEqual({type:'json_object'});expect(body.tools).toBeUndefined();expect(body.messages[1].content).toBe('one-contract');
  return new Response(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}]}));
 })as typeof fetch;
 expect((await generate('nvidia','nvidia/nemotron-3-super-120b-a12b','test-only',{kind:'restudy_v1',prompt:'one-contract'},transport,Date.now())).raw).toEqual({});
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
