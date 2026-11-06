import { edgeCall } from './supabase';

type PreparedJob = { id:string; totalParts:number; method?:string; parts?:{part:number}[]; partsVersion?:string };
type ChildJob = {part:number;status:string;attempts?:number;max_attempts?:number;available_at?:string;lease_until?:string;provider_error?:string;last_error?:string};
export type ContentRunOptions<T> = {onUpdate?:(job:T)=>void|Promise<void>;shouldStop?:()=>boolean};
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const transient=new Set(['timeout','network_error','provider_error','rate_limited','invalid_response','all_providers_failed','processing_failed']);

/** One durable part at a time. A tab may stop polling without cancelling the
 * leased worker; another visit resumes from the saved parts and lease. */
export async function runPreparedJob<T extends PreparedJob>(initial:T,options:ContentRunOptions<T>={}):Promise<T>{
  let job=initial;
  if(job.method&&job.method!=='api')return job;
  const refresh=async()=>{
    const update=await edgeCall('content-jobs',{action:'get',jobId:job.id,partsVersion:job.partsVersion});
    job={...job,...update};
    await options.onUpdate?.(job);
  };
  const children=()=>((job as T&{apiJobs?:ChildJob[]}).apiJobs??[]);
  const finished=(part:number)=>job.parts?.some(p=>p.part===part)||children().some(c=>Number(c.part)===part&&c.status==='completed');
  const retries=new Map<number,number>();
  for(let part=1;part<=job.totalParts;part++){
    if(finished(part))continue;
    if(options.shouldStop?.())return job;
    let dispatched=false,observedRunningAt=Date.now();
    while(!finished(part)){
      const child=children().find(c=>Number(c.part)===part);
      const maxAttempts=Math.max(1,Math.min(10,Number(child?.max_attempts)||3));
      if(child?.status==='running'){
        const lease=Date.parse(child.lease_until??'')||observedRunningAt+180000;
        if(lease>Date.now()){
          await pause(2000);await refresh();continue;
        }
        // A worker can be stopped at the Edge wall-clock limit. Its expired
        // lease can be claimed again; an active lease is never duplicated.
        dispatched=false;
      }
      if(options.shouldStop?.())return job;
      if(child&&['paused','failed','retry_wait'].includes(child.status)){
        const code=child.provider_error??child.last_error;
        const retryAt=Date.parse(child.available_at??'');
        if(!transient.has(code??'')&&!(code==='no_available_provider'&&retryAt>Date.now()))return job;
        if((retries.get(part)??0)>=maxAttempts)return job;
        if(retryAt>Date.now()){
          await pause(Math.min(2000,retryAt-Date.now()));continue;
        }
        dispatched=false;
      }
      if(!dispatched){
        if((retries.get(part)??0)>=maxAttempts)return job;
        retries.set(part,(retries.get(part)??0)+1);
        let requestError:unknown;
        try{await edgeCall('ai-request',{action:'run_standard',standardJobId:job.id,part});}
        catch(error){requestError=error;}
        dispatched=true;observedRunningAt=Date.now();
        // Even if the HTTP response was lost, inspect the lease before deciding
        // whether retrying can issue another upstream request.
        await refresh();
        if(requestError&&!finished(part)&&children().find(c=>Number(c.part)===part)?.status!=='running')throw requestError;
        if(!finished(part)&&!children().some(c=>Number(c.part)===part))return job;
      }else{
        // Waiting can mean a daily budget/attempt limit prevented a claim. Do
        // not spin on the same waiting row or bypass that budget.
        return job;
      }
    }
  }
  return job;
}
