import {expect,test,vi}from'vitest';
const fixture=vi.hoisted(()=>({tables:{}as Record<string,any[]>}));
vi.mock('../supabase/functions/_shared/app/repository',()=>({row:async(_ctx:any,table:string,id:string)=>fixture.tables[table]?.find(r=>r.id===id),rows:async(_ctx:any,table:string)=>fixture.tables[table]??[]}));
import {prepareStandardPart}from'../supabase/functions/_shared/standard/ai';

function largeBank(partCounts=[2,2,2,2]){
 const concepts=Array.from({length:37},(_,i)=>({id:`concept-${String(i+1).padStart(2,'0')}`,name:`개념 ${i+1}`,subject:'수학',major:'단원',minor:'',canonical_key:`saved-${i+1}`,updated_at:`concept-v${i+1}`,data:{definition:`고유 근거 ${i+1}: ${'저장된 개념 설명 '.repeat(100)}`,sources:[{materialId:'d',page:1+i%3},{materialId:'another',page:99}]}}));
 fixture.tables={documents:[{id:'d',status:'ready',updated_at:'doc-v1'}],document_chapters:[1,2,3].map(n=>({id:`chapter-${n}`,document_id:'d',title:`단원 ${n}`,start_page:n,end_page:n,updated_at:`chapter-v${n}`})),concepts:[...concepts].reverse(),chapter_concepts:concepts.map((c,i)=>({chapter_id:`chapter-${1+Math.floor(i/2)%3}`,concept_id:c.id})).reverse(),content_parts:[{job_id:'j',part:1,raw:{chapters:[{id:'previous-chapter'}],concepts:[{id:'previous-concept',chapter_id:'previous-chapter',name:'다른 분할의 큰 개념'}]}}]};
 return {id:'j',document_id:'d',data:{method:'api',taskType:'bank',title:'자료',subject:'수학',selectedPages:[1,2,3],tocPages:[],questionCount:partCounts.reduce((a,b)=>a+b,0),totalParts:partCounts.length,partCounts,partSize:Math.max(...partCounts),chapters:[{id:'unused-manifest-chapter'}],knownChapters:[{id:'unused-known-chapter'}],knownConcepts:[{id:'unused-known-concept'}],targetQuestions:[],questionTypes:['short'],difficultyDistribution:{easy:20,medium:50,hard:30}}};
}
const sourceOf=(result:Awaited<ReturnType<typeof prepareStandardPart>>)=>JSON.parse(result.input.prompt.split('\n근거: ')[1].split('\n출력 스키마: ')[0]);

test('bank parts bound saved concept context and use the next deterministic native references',async()=>{
 const master=largeBank();
 const first=await prepareStandardPart({}as any,master,1),second=await prepareStandardPart({}as any,master,2);
 const one=sourceOf(first),two=sourceOf(second);
 expect(one.concepts.map((c:any)=>c.id)).toEqual(['concept-01','concept-02']);
 expect(two.concepts.map((c:any)=>c.id)).toEqual(['concept-03','concept-04']);
 expect(one.saved_references.concepts.map((c:any)=>[c.id,c.chapter_id])).toEqual([['concept-01','chapter-1'],['concept-02','chapter-1']]);
 expect(two.saved_references.concepts.map((c:any)=>[c.id,c.chapter_id])).toEqual([['concept-03','chapter-2'],['concept-04','chapter-2']]);
 expect(one.saved_references.chapters.map((c:any)=>c.id)).toEqual(['chapter-1']);
 expect(two.saved_references.chapters.map((c:any)=>c.id)).toEqual(['chapter-2']);
 expect(first.source_versions).toEqual([{table:'documents',id:'d',updated_at:'doc-v1'},{table:'concepts',id:'concept-01',updated_at:'concept-v1'},{table:'concepts',id:'concept-02',updated_at:'concept-v2'},{table:'document_chapters',id:'chapter-1',updated_at:'chapter-v1'}]);
 expect(JSON.stringify(one).length).toBeLessThan(4000);
 expect(first.input.allowedPages).toEqual([1,2,3]);expect(second.input.allowedPages).toEqual([1,2,3]);
 expect(second.input.prompt).not.toMatch(/unused-manifest-chapter|unused-known|previous-chapter|previous-concept/);
 expect(second.input.prompt).toContain('chapters=[], concepts=[], flashcards=[], problem_analyses=[], similarities=[]');
 expect(second.input.prompt).not.toContain('개념 최대 3개');
 expect(second.inputVersion).toBe('small-api-v5');
});

test('bank cycling covers the pool before wrapping and a short last part keeps its place',async()=>{
 const master=largeBank([2,2,2,1]);
 fixture.tables.concepts=fixture.tables.concepts.filter(c=>Number(c.id.slice(-2))<=7);
 const ids:string[][]=[];
 for(const part of [1,2,3,4])ids.push(sourceOf(await prepareStandardPart({}as any,master,part)).concepts.map((c:any)=>c.id));
 expect(ids).toEqual([['concept-01','concept-02'],['concept-03','concept-04'],['concept-05','concept-06'],['concept-07']]);
 const wrapping={...master,data:{...master.data,questionCount:8,partCounts:[2,2,2,2]}};
 expect(sourceOf(await prepareStandardPart({}as any,wrapping,4)).concepts.map((c:any)=>c.id)).toEqual(['concept-07','concept-01']);
});

test('bank batches respect explicitly requested concept IDs without sending excluded definitions',async()=>{
 const base=largeBank(),master={...base,data:{...base.data,conceptIds:['concept-11','concept-05','concept-29']}};
 const first=sourceOf(await prepareStandardPart({}as any,master,1)),next=sourceOf(await prepareStandardPart({}as any,master,2));
 expect(first.concepts.map((c:any)=>c.id)).toEqual(['concept-05','concept-11']);
 expect(next.concepts.map((c:any)=>c.id)).toEqual(['concept-29','concept-05']);
 expect(first.concepts.flatMap((c:any)=>c.source_pages)).not.toContain(99);
 expect(first.saved_references.concepts.map((c:any)=>c.id)).toEqual(['concept-05','concept-11']);
});
test('bank prompts supply native concept and chapter IDs as resolvable saved references',async()=>{
 fixture.tables={documents:[{id:'d',status:'ready'}],document_chapters:[{id:'chapter-db',document_id:'d',title:'단원',start_page:1,end_page:2}],concepts:[{id:'concept-db',name:'개념',subject:'수학',major:'단원',minor:'',canonical_key:'saved-key',data:{definition:'기존 설명',sources:[{materialId:'d',page:1}]}}],chapter_concepts:[{chapter_id:'chapter-db',concept_id:'concept-db'}]};
 const master={id:'j',document_id:'d',data:{method:'api',taskType:'bank',title:'자료',subject:'수학',selectedPages:[1,2],tocPages:[],questionCount:2,totalParts:1,partCounts:[2],partSize:5,chapters:[],targetQuestions:[],questionTypes:['short'],difficultyDistribution:{easy:20,medium:50,hard:30}}};
 const result=await prepareStandardPart({}as any,master,1);
 const source=JSON.parse(result.input.prompt.split('\n근거: ')[1].split('\n출력 스키마: ')[0]);
 expect(source.saved_references.concepts).toContainEqual(expect.objectContaining({id:'concept-db',chapter_id:'chapter-db'}));
 expect(source.saved_references.chapters).toContainEqual(expect.objectContaining({id:'chapter-db'}));
});
test('later concept-only parts receive exact references from earlier committed parts and no invented source pages',async()=>{
 fixture.tables={documents:[{id:'d',title:'자료',status:'ready',updated_at:'v1'}],document_pages:[4,5,6].map(number=>({id:`page-${number}`,document_id:'d',number,updated_at:'v1',data:{checkpointComplete:true,text:`${number}쪽 본문`}})),content_parts:[{job_id:'j',part:1,raw:{chapters:[{id:'p1-ch',name:'단원',start_page:1,end_page:6}],concepts:[{id:'p1-c',chapter_id:'p1-ch',name:'기존 개념',source_pages:[1]}]}},{job_id:'another',part:1,raw:{concepts:[{id:'unrelated-secret'}]}}]};
 const master={id:'j',document_id:'d',data:{method:'api',taskType:'concepts',title:'자료',subject:'수학',selectedPages:[1,2,3,4,5,6],tocPages:[],questionCount:0,totalParts:2,partCounts:[0,0],partSize:5,chapters:[],targetQuestions:[],questionTypes:['mcq'],difficultyDistribution:{easy:20,medium:50,hard:30}}};
 const result=await prepareStandardPart({}as any,master,2);
 expect(result.input).toMatchObject({kind:'restudy_v1',count:0,allowedPages:[4,5,6]});
 expect(result.input.prompt).toContain('"id":"p1-c","chapter_id":"p1-ch"');
 expect(result.input.prompt).toContain('questions=[], problem_analyses=[]');
 expect(result.input.prompt).not.toContain('unrelated-secret');
 const serializedSource=result.input.prompt.split('\n근거: ')[1].split('\n출력 스키마: ')[0];
 expect(JSON.parse(serializedSource).pages.map((p:any)=>p.pdf_page)).toEqual([4,5,6]);
});
