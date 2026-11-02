import{expect,test,vi}from'vitest';
const fixture=vi.hoisted(()=>({master:{id:'j',document_id:'d',data:{method:'api',partSize:5,totalParts:2}},reads:0}));
vi.mock('../supabase/functions/_shared/app/repository',()=>({row:async(_c:any,table:string)=>{if(table==='content_jobs')return structuredClone(fixture.master);throw Error('Unrelated source pages must not be prepared');},rows:async()=>{throw Error('No source read for a cached requested part');}}));
vi.mock('../supabase/functions/_shared/ai/credentials',()=>({readProfile:async()=>({ai_settings:{}}),checked:(r:any)=>{if(r.error)throw Error('database');return r.data;}}));
import{runStandard}from'../supabase/functions/_shared/standard/ai';
import{cacheKey}from'../supabase/functions/_shared/ai/jobs';
test('resuming a completed requested part does not load missing source pages for other parts',async()=>{
 const key=await cacheKey({schema:'restudy.v1',jobId:'j',part:2});
 const admin={from:(table:string)=>{
  let cache='';const query:any={select:()=>query,update:()=>query,eq:(k:string,v:string)=>{if(k==='cache_key')cache=v;return query;},maybeSingle:async()=>{fixture.reads++;return{data:cache===key?{id:'a',status:'completed',data:{standardPart:2}}:null,error:null};},then:(resolve:any)=>Promise.resolve({data:[],error:null}).then(resolve)};return query;
 }};
 const result=await runStandard({user:{id:'owner'},db:admin,admin},'j',2,'unused');
 expect(fixture.reads).toBe(1);expect(result.jobs).toEqual([{id:'a',part:2,status:'completed',label:undefined}]);
});
