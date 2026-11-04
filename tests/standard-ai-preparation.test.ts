import {expect,test,vi}from'vitest';
const fixture=vi.hoisted(()=>({tables:{}as Record<string,any[]>}));
vi.mock('../supabase/functions/_shared/app/repository',()=>({row:async(_ctx:any,table:string,id:string)=>fixture.tables[table]?.find(r=>r.id===id),rows:async(_ctx:any,table:string)=>fixture.tables[table]??[],preparationPageRows:async(_ctx:any,id:string,numbers:number[])=>fixture.tables.document_pages?.filter(p=>p.document_id===id&&numbers.includes(p.number))??[],preparationChapters:async(_ctx:any,id:string,part:number)=>fixture.tables.content_parts?.filter(p=>p.job_id===id&&p.part<part).flatMap(p=>p.raw.chapters??[])??[]}));
import {prepareStandardPart}from'../supabase/functions/_shared/standard/ai';
import {expandCompactPreparation}from'../supabase/functions/_shared/standard/compact';
import {compileRestudy}from'../src/domain/restudy-compile';
import {validateRestudyParts}from'../src/domain/restudy';
import {runTask}from'../supabase/functions/_shared/ai/router';
import {toCommitResult}from'../supabase/functions/_shared/ai/jobs';

function largeBank(partCounts=[2,2,2,2]){
 const concepts=Array.from({length:37},(_,i)=>({id:`concept-${String(i+1).padStart(2,'0')}`,name:`개념 ${i+1}`,subject:'수학',major:'단원',minor:'',canonical_key:`saved-${i+1}`,updated_at:`concept-v${i+1}`,data:{definition:`고유 근거 ${i+1}: ${'저장된 개념 설명 '.repeat(100)}`,sources:[{materialId:'d',page:1+i%3},{materialId:'another',page:99}]}}));
 fixture.tables={documents:[{id:'d',status:'ready',updated_at:'doc-v1'}],document_chapters:[1,2,3].map(n=>({id:`chapter-${n}`,document_id:'d',title:`단원 ${n}`,start_page:n,end_page:n,updated_at:`chapter-v${n}`})),concepts:[...concepts].reverse(),chapter_concepts:concepts.map((c,i)=>({chapter_id:`chapter-${1+Math.floor(i/2)%3}`,concept_id:c.id})).reverse(),content_parts:[{job_id:'j',part:1,raw:{chapters:[{id:'previous-chapter'}],concepts:[{id:'previous-concept',chapter_id:'previous-chapter',name:'다른 분할의 큰 개념'}]}}]};
 return {id:'j',document_id:'d',data:{method:'api',taskType:'bank',title:'자료',subject:'수학',selectedPages:[1,2,3],tocPages:[],questionCount:partCounts.reduce((a,b)=>a+b,0),totalParts:partCounts.length,partCounts,partSize:Math.max(...partCounts),chapters:[{id:'unused-manifest-chapter'}],knownChapters:[{id:'unused-known-chapter'}],knownConcepts:[{id:'unused-known-concept'}],targetQuestions:[],questionTypes:['short'],difficultyDistribution:{easy:20,medium:50,hard:30}}};
}
const sourceOf=(result:Awaited<ReturnType<typeof prepareStandardPart>>)=>JSON.parse(result.input.prompt.split('\n근거: ')[1]);
const bindings=(result:Awaited<ReturnType<typeof prepareStandardPart>>)=>result.input.compactPreparation!;
const short=(prompt='문제')=>({prompt,answer:'정답',explanation:'근거'});

test('bank limits the source pool and attaches native references without sending them to the model',async()=>{
 const master=largeBank();
 const first=await prepareStandardPart({}as any,master,1),second=await prepareStandardPart({}as any,master,2);
 expect(sourceOf(first).map((c:any)=>c.name)).toEqual(['개념 1','개념 2']);
 expect(sourceOf(second).map((c:any)=>c.name)).toEqual(['개념 3','개념 4']);
 expect(first.input.prompt).not.toMatch(/concept-01|chapter-1|concept_ids|source_pages|restudy\.v1/);
 expect(first.input.prompt.length).toBeLessThan(3500);
 expect(second.input.prompt).not.toMatch(/unused-manifest-chapter|unused-known|previous-chapter|previous-concept/);
 expect(second.inputVersion).toBe('small-api-v6');
 const parsed=expandCompactPreparation(bindings(first),{questions:[short('첫 문제'),short('둘째 문제')]});
 expect(parsed.questions.map(q=>[q.concept_ids[0],q.chapter_id,q.source_pages])).toEqual([['concept-01','chapter-1',[1]],['concept-02','chapter-1',[2]]]);
 expect(parsed.chapters).toEqual([]);
 expect(parsed.concepts).toEqual([]);
 expect(first.source_versions.map(v=>v.id)).toEqual(['d','concept-01','concept-02','chapter-1']);
});
test('bank keeps the native concept order, including on a shorter final part',async()=>{
 const master=largeBank([2,2,2,1]);
 fixture.tables.concepts=fixture.tables.concepts.filter(c=>Number(c.id.slice(-2))<=7);
 const ids:string[][]=[];
 for(const part of [1,2,3,4])ids.push(bindings(await prepareStandardPart({}as any,master,part)).bank.map(c=>c.id));
 expect(ids).toEqual([['concept-01','concept-02'],['concept-03','concept-04'],['concept-05','concept-06'],['concept-07']]);
 const wrapping={...master,data:{...master.data,questionCount:8,partCounts:[2,2,2,2]}};
 expect(bindings(await prepareStandardPart({}as any,wrapping,4)).bank.map(c=>c.id)).toEqual(['concept-07','concept-01']);
});
test('bank respects selected concepts and uses a selected chapter page if its citation is chapter-level',async()=>{
 const base=largeBank(),master={...base,data:{...base.data,conceptIds:['concept-11','concept-05','concept-29']}};
 const first=await prepareStandardPart({}as any,master,1),next=await prepareStandardPart({}as any,master,2);
 expect(bindings(first).bank.map(c=>c.id)).toEqual(['concept-05','concept-11']);
 expect(bindings(next).bank.map(c=>c.id)).toEqual(['concept-29','concept-05']);
 expect(bindings(first).bank.every(c=>c.pages.length&&c.pages.every(p=>[1,2,3].includes(p)))).toBe(true);
});
function material(taskType: 'initial'|'concepts'){
 const chapter={id:'p1-ch',title:'기존 단원',start_page:1,end_page:6};
 fixture.tables={documents:[{id:'d',title:'자료',status:'ready',updated_at:'v1'}],document_pages:[4,5,6].map(number=>({id:`page-${number}`,document_id:'d',number,updated_at:'v1',data:{checkpointComplete:true,text:`${number}쪽 본문`}})),content_parts:[{job_id:'j',part:1,raw:{chapters:[chapter],concepts:[{id:'p1-c',chapter_id:'p1-ch',name:'기존 개념'}]}},{job_id:'another',part:1,raw:{chapters:[{id:'unrelated-secret'}]}}]};
 return {id:'j',document_id:'d',data:{method:'api',taskType,title:'자료',subject:'수학',pageCount:6,selectedPages:[1,2,3,4,5,6],tocPages:[],questionCount:taskType==='initial'?2:0,totalParts:2,partCounts:taskType==='initial'?[0,2]:[0,0],partSize:5,chapters:[],targetQuestions:[],questionTypes:['mcq','ox'],questionTypeCounts:taskType==='initial'?{mcq:1,ox:1}:{},purposeCounts:taskType==='initial'?{concept:1,practice:1}:{},difficultyDistribution:{easy:50,medium:50,hard:0}}};
}
const concepts=[{page:4,name:'핵심 개념',summary:'정의',formulas:['x+y'],memorize:['조건'],pitfalls:['혼동'],card:{front:'정의는?',back:'설명'}}];
test('concepts reuse earlier chapters without echoing any saved identifiers or requiring empty question arrays',async()=>{
 const master=material('concepts'),result=await prepareStandardPart({}as any,master,2);
 expect(result.input).toMatchObject({kind:'restudy_v1',count:0,allowedPages:[4,5,6]});
 expect(sourceOf(result).map((p:any)=>p.page)).toEqual([4,5,6]);
 expect(result.input.prompt).not.toMatch(/p1-c|p1-ch|unrelated-secret|questions 배열|flashcards/);
 const converted=expandCompactPreparation(bindings(result),{concepts});
 expect(converted.concepts[0]).toMatchObject({id:'p2-compact-concept-1',chapter_id:'p1-ch',formulas:['x+y']});
 expect(converted.flashcards[0]).toMatchObject({concept_id:converted.concepts[0].id,front:'정의는?'});
 expect(()=>expandCompactPreparation(bindings(result),{concepts:[{...concepts[0],page:1}]})).toThrow();
});
test('initial restores source, purpose, difficulty and per-choice explanations before compiling the import',async()=>{
 const master=material('initial'),result=await prepareStandardPart({}as any,master,2);
 const choices=['첫째','둘째','셋째','넷째'].map(text=>({text,why:`${text} 해설`}));
 const raw={concepts,questions:[{...short('객관식'),answer:2,choices},{...short('OX'),answer:'○'}]};
 const converted=expandCompactPreparation(bindings(result),raw);
 expect(converted.questions[0]).toMatchObject({kind:'mcq',purpose:'concept',level:'easy',answer:'B',source_pages:[4],option_explanations:{B:'둘째 해설'}});
 expect(converted.questions[1]).toMatchObject({kind:'ox',purpose:'practice',level:'medium',answer:'O'});
 const job={...master.data,id:'j',documentId:'d'} as any;
 const earlier=fixture.tables.content_parts[0].raw.chapters;
 const merged=validateRestudyParts([converted],job,{chapters:earlier});
 expect(merged.valid&&merged.ready).toBe(true);
 const compiled=await compileRestudy(merged,job);
 expect(compiled.questions[0].data).toMatchObject({answer:'둘째',modes:['check','quiz'],sources:[{materialId:'d',page:4}]});
 expect(compiled.flashcards).toHaveLength(1);
 expect(()=>expandCompactPreparation(bindings(result),{...raw,questions:[{...raw.questions[0],concept:2},raw.questions[1]]})).toThrow();
 expect(()=>expandCompactPreparation(bindings(result),{...raw,questions:[raw.questions[0]]})).toThrow();
});

test('the wire request omits full schema and the worker hands a restudy.v1 part to durable storage',async()=>{
 const master=largeBank([2]),prepared=await prepareStandardPart({}as any,master,1);
 const transport=vi.fn(async (_url:unknown,request?:RequestInit)=>{
  const wire=JSON.parse(String(request?.body));
  expect(wire.systemInstruction.parts[0].text).not.toContain('restudy.v1');
  expect(wire.contents[0].parts[0].text).not.toMatch(/concept-01|chapter-1|document_id|option_explanations/);
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({questions:[short('첫째'),short('둘째')]})}]}}]});
 });
 const result=await runTask(prepared.input,{
  providers:[{provider:'gemini',model:'gemma-4-26b-a4b-it',enabled:true,access:'free_confirmed',status:'connected'}],mode:'gemini_only',allowPaid:false,rotationIndex:0,
  getKey:async()=> 'test-key',log:async()=>{},updateProvider:async()=>{},fetch:transport as typeof fetch,
 });
 expect(result.status).toBe('succeeded');
 if(result.status==='succeeded'){
  const commit=toCommitResult({id:'child',user_id:'owner',kind:'restudy_v1',status:'running',attempts:1,data:prepared},result);
  expect(commit.standard).toMatchObject({schema_version:'restudy.v1',job_id:'j',part:1,questions:[{concept_ids:['concept-01']},{concept_ids:['concept-02']}]});
 }
});
