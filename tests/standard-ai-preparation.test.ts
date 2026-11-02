import {expect,test,vi}from'vitest';
const fixture=vi.hoisted(()=>({tables:{}as Record<string,any[]>}));
vi.mock('../supabase/functions/_shared/app/repository',()=>({row:async(_ctx:any,table:string,id:string)=>fixture.tables[table]?.find(r=>r.id===id),rows:async(_ctx:any,table:string)=>fixture.tables[table]??[]}));
import {prepareStandardPart}from'../supabase/functions/_shared/standard/ai';
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
