import {afterEach,beforeEach,expect,test,vi} from 'vitest';
const fixture=vi.hoisted(()=>({calls:[]as any[],views:[]as any[],run:[]as any[]}));
vi.mock('../src/services/supabase',()=>({edgeCall:async(name:string,body:any)=>{fixture.calls.push({name,...body});return name==='ai-request'?fixture.run.shift():fixture.views.shift();}}));
import {runPreparedJob} from '../src/services/content-runner';
const job=(extra:any={})=>({id:'master',method:'api',totalParts:2,parts:[],apiJobs:[],...extra});
beforeEach(()=>{vi.useFakeTimers();fixture.calls=[];fixture.views=[];fixture.run=[];});
afterEach(()=>vi.useRealTimers());
test('polls a running part to its durable result before dispatching the next part',async()=>{
 fixture.run.push({result:{status:'running'}},{result:{status:'running'}});
 fixture.views.push(job({partsVersion:'initial',apiJobs:[{part:1,status:'running',lease_until:new Date(Date.now()+180000).toISOString()}]}),job({parts:[{part:1}],partsVersion:'saved',apiJobs:[{part:1,status:'completed'}]}),job({parts:[{part:1},{part:2}],apiJobs:[{part:1,status:'completed'},{part:2,status:'completed'}]}));
 const promise=runPreparedJob(job());await vi.runAllTimersAsync();expect((await promise).parts).toHaveLength(2);
 expect(fixture.calls.filter(c=>c.name==='ai-request').map(c=>c.part)).toEqual([1,2]);
 expect(fixture.calls.map(c=>c.name)).toEqual(['ai-request','content-jobs','content-jobs','ai-request','content-jobs']);
 expect(fixture.calls.filter(c=>c.name==='content-jobs').map(c=>c.partsVersion)).toEqual([undefined,'initial','saved']);
});
test('honors the provider retry timestamp and keeps graceful stop within the current part',async()=>{
 let stop=false;const retryAt=Date.now()+10000;
 fixture.run.push({result:{status:'running'}},{result:{status:'running'}});
 fixture.views.push(job({apiJobs:[{part:1,status:'paused',provider_error:'rate_limited',available_at:new Date(retryAt).toISOString()}]}),job({parts:[{part:1}],apiJobs:[{part:1,status:'completed'}]}));
 const promise=runPreparedJob(job(),{onUpdate:current=>{if(current.parts?.length)stop=true;},shouldStop:()=>stop});
 await vi.advanceTimersByTimeAsync(9999);expect(fixture.calls.filter(c=>c.name==='ai-request')).toHaveLength(1);
 await vi.runAllTimersAsync();expect((await promise).parts).toHaveLength(1);
 expect(fixture.calls.filter(c=>c.name==='ai-request').map(c=>c.part)).toEqual([1,1]);
});
test('does not rerun completed content and stops on authentication failure',async()=>{
 expect(await runPreparedJob(job({parts:[{part:1},{part:2}]}))).toMatchObject({parts:[{part:1},{part:2}]});expect(fixture.calls).toHaveLength(0);
 fixture.run.push({result:{status:'paused'}});fixture.views.push(job({apiJobs:[{part:1,status:'paused',provider_error:'auth_error'}]}));
 await runPreparedJob(job());expect(fixture.calls.filter(c=>c.name==='ai-request')).toHaveLength(1);
});
test('respects the saved retry limit instead of retrying transient failures indefinitely',async()=>{
 fixture.run.push({result:{status:'paused'}});
 fixture.views.push(job({apiJobs:[{part:1,status:'paused',provider_error:'timeout',max_attempts:1,attempts:1,available_at:new Date(Date.now()+5000).toISOString()}]}));
 const promise=runPreparedJob(job());await vi.runAllTimersAsync();await promise;
 expect(fixture.calls.filter(c=>c.name==='ai-request')).toHaveLength(1);
});
