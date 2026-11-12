import {AppError,requireFeature,sha256} from '../context.ts';
import {row,rows,type Ctx} from '../app/repository.ts';
import {compileRestudy} from '../../../../src/domain/restudy-compile.ts';
import {createExternalPrompt,parseRestudy,splitCount,validateRestudyParts,canonicalJson,type StandardJob} from '../../../../src/domain/restudy.ts';
import {selectPages,tocPages} from '../../../../src/domain/pages.ts';
import{apiProgress}from'../../../../src/domain/ai-status.ts';
import{readProfile}from'../ai/credentials.ts';
import{sanitizeSettings}from'../ai/settings.ts';
import{bankReferences}from'./references.ts';

export const standardJob=(r:any):StandardJob=>({...r.data,id:r.id,documentId:r.document_id});
function dbError(error:any,message:string){if(error)throw new AppError(message);}
export async function jobView(ctx:Ctx,id:string,knownPartsVersion?:string){
 const partFields='part,total_parts,applied,content_hash';
 const readParts=(withRaw:boolean)=>rows(ctx,'content_parts',{job_id:id},withRaw?`${partFields},raw`:partFields);
 const versionOf=(records:any[])=>sha256(JSON.stringify(records.map(part=>[part.part,part.content_hash,part.applied])));
 const [job,parts]=await Promise.all([
  row(ctx,'content_jobs',id),
  readParts(!knownPartsVersion),
 ]);
 parts.sort((a,b)=>a.part-b.part);
 let partsVersion=await versionOf(parts);
 const partsChanged=partsVersion!==knownPartsVersion;
 const day=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
 const [profile,budget,saved]=await Promise.all([readProfile(ctx),ctx.admin.from('ai_daily_budgets').select('count').eq('user_id',ctx.user.id).eq('day',day).maybeSingle(),knownPartsVersion&&partsChanged?readParts(true):parts]);dbError(budget.error,'API 일일 사용량을 읽지 못했습니다.');
 const limit=sanitizeSettings(profile.ai_settings).daily_limit,used=budget.data?.count??0,apiBudget={used,limit,remaining:Math.max(0,limit-used)};
 const {data:apiJobs,error}=await ctx.admin.from('ai_jobs').select('id,status,attempts,max_attempts:data->settings->max_attempts,available_at,lease_until,updated_at,part:data->standardPart,label:data->label,last_error:data->last_error,provider_error:data->last_provider_error,detail:data->last_error_detail').eq('user_id',ctx.user.id).eq('data->>standardJobId',id).order('created_at').limit(1000);dbError(error,'API 진행 상황을 읽지 못했습니다.');
 let attempts:any[]=[];
 if(apiJobs?.length){const logs=await ctx.admin.from('ai_usage_logs').select('job_id,created_at,data').eq('user_id',ctx.user.id).in('job_id',apiJobs.map((j:any)=>j.id)).order('created_at',{ascending:false}).limit(8);dbError(logs.error,'API 시도 내역을 읽지 못했습니다.');attempts=(logs.data??[]).map((r:any)=>({jobId:r.job_id,at:r.created_at,...Object.fromEntries(['provider','model','key_label','success','error','http_status','duration_ms','diagnostic','response_metadata'].filter(k=>r.data?.[k]!==undefined).map(k=>[k,r.data[k]]))}));}
 let preparationFailure=job.data.apiFailure;
 // A previous attempt may have waited for OCR. Once the source is durable,
 // that historical precondition must not still look like current processing.
 if(preparationFailure?.code==='preparation_failed'&&preparationFailure.message==='PDF 자체 인식·크롭 저장이 진행 중입니다. 완료 후 API 준비를 실행하세요.'){
  const source=await row(ctx,'documents',job.document_id);
  if(['ready','needs_review'].includes(source.status))preparationFailure=null;
 }
 const progress=apiProgress(apiJobs??[],job.data.totalParts,job.data.importedQuestions??0,preparationFailure);
 if(apiBudget.remaining===0&&progress.pending>0&&progress.state!=='running')Object.assign(progress,{state:'paused',errorCode:'daily_limit',message:`앱에 설정된 하루 ${limit}회 작업을 모두 사용했습니다. AI 설정에서 하루 제한을 확인하거나 내일 이어서 준비하세요. 제공자 오류가 아닙니다.`});
 const view={...standardJob(job),apiBudget,status:job.status,createdAt:job.created_at,apiJobs:apiJobs??[],apiStatus:progress,apiAttempts:attempts,partsVersion};
 if(!partsChanged)return view;
 saved.sort((a,b)=>a.part-b.part);
 if(knownPartsVersion)partsVersion=await versionOf(saved);
 return {...view,partsVersion,parts:saved.map((p:any)=>({part:p.part,totalParts:p.total_parts,questions:p.raw.questions?.length||0,applied:p.applied})),preparedConcepts:new Set(saved.flatMap((p:any)=>(p.raw.concepts??[]).map((c:any)=>c.id))).size,preparedFlashcards:new Set(saved.flatMap((p:any)=>(p.raw.flashcards??[]).map((c:any)=>c.id))).size,preparedQuestions:saved.reduce((sum:number,p:any)=>sum+(p.raw.questions?.length??0),0),preparedPreview:saved.filter((p:any)=>p.raw.questions?.length).slice(-1).flatMap((p:any)=>(p.raw.questions??[]).slice(0,5).map((q:any)=>({part:p.part,prompt:q.prompt,answer:q.answer,options:q.options,source_pages:q.source_pages,explanation:q.explanation})))};
}
export async function createJob(ctx:Ctx,body:any){
 const document=await row(ctx,'documents',String(body.documentId||''));if(document.data.archived)throw new AppError('보관된 자료를 먼저 복원하세요.');
 const pageCount=Number(document.data.pageCount);if(!pageCount)throw new AppError('PDF 페이지 수를 확인할 수 없습니다.');
 const selectedPages=Array.isArray(body.selectedPages)?selectPages(body.selectedPages.join(','),pageCount):selectPages(String(body.pages??document.data.analysisRange??''),pageCount,String(body.excludedPages??document.data.excludedPages??''));
 const toc=Array.isArray(body.tocPages)?tocPages(body.tocPages.join(','),pageCount):tocPages(String(body.tocRange??document.data.tocRange??''),pageCount);
 const taskType=String(body.taskType||'initial');if(!['concepts','initial','bank','problem','toc','complete'].includes(taskType))throw new AppError('요청 작업을 확인하세요.');
 const conceptCount=Number(body.conceptQuestionCount??5),practiceCount=Number(body.practiceQuestionCount??5);
 const conceptOnly=['toc','concepts'].includes(taskType);
 const questionCount=conceptOnly?0:taskType==='initial'?conceptCount+practiceCount:Number(body.questionCount??100);
 if(!Number.isInteger(questionCount)||questionCount<0||questionCount>1000||!conceptOnly&&questionCount<1)throw new AppError('문제 수를 1~1000개로 입력하세요.');
 const questionTypes=body.questionTypes||['mcq','ox','short','blank'];if(!Array.isArray(questionTypes)||!questionTypes.length||questionTypes.some((t:string)=>!['mcq','ox','short','blank'].includes(t)))throw new AppError('문제 유형을 선택하세요.');
 const difficultyDistribution=body.difficultyDistribution||{easy:20,medium:50,hard:30};if(Object.keys(difficultyDistribution).some(k=>!['easy','medium','hard'].includes(k))||Object.values(difficultyDistribution).some(v=>typeof v!=='number'||v<0)||Object.values(difficultyDistribution).reduce((a:any,b:any)=>a+b,0)!==100)throw new AppError('난이도 비율의 합은 100%여야 합니다.');
 if(body.questionTypeCounts&&(Object.keys(body.questionTypeCounts).some(k=>!questionTypes.includes(k))||Object.values(body.questionTypeCounts).some(v=>!Number.isInteger(v)||Number(v)<0)||Object.values(body.questionTypeCounts).reduce((a:any,b:any)=>a+b,0)!==questionCount))throw new AppError('유형별 문제 수의 합을 전체 문제 수와 맞추세요.');
 const method=String(body.method||'external');if(!['external','api'].includes(method))throw new AppError('분석 방식을 선택하세요.');
 if(method==='api')requireFeature(ctx,'ai');
 const purposeCounts=conceptOnly?{concept:0,practice:0,similar:0}:taskType==='initial'?{concept:conceptCount,practice:practiceCount,similar:0}:body.purposeCounts||{concept:0,practice:questionCount,similar:0};
 if(!purposeCounts||typeof purposeCounts!=='object'||Array.isArray(purposeCounts)||Object.keys(purposeCounts).some(k=>!['concept','practice','similar'].includes(k))||Object.values(purposeCounts).some(v=>!Number.isInteger(v)||Number(v)<0)||Object.values(purposeCounts).reduce((a:any,b:any)=>a+b,0)!==questionCount)throw new AppError('개념 퀴즈·연습·유사문제 수의 합을 전체 문제 수와 맞추세요.');
 const targetQuestions:any[]=[];
 if(body.questionIds){if(!Array.isArray(body.questionIds)||body.questionIds.length>100)throw new AppError('분석할 원본 문제를 확인하세요.');for(const id of [...new Set(body.questionIds)]){const q=await row(ctx,'problems',String(id));if(q.document_id!==document.id||!selectedPages.includes(q.page))throw new AppError('분석할 원본 문제와 자료·페이지가 다릅니다.');targetQuestions.push({id:q.id,q_number:String(q.number),pdf_page:q.page,text:q.data.text||'',chapter_id:q.data.chapterId||null})}}
 if(taskType==='problem'&&method==='api'&&!targetQuestions.length)throw new AppError('API 분석에는 저장된 원본 문제 영역을 선택하세요. 인덱스가 없으면 PDF와 함께 외부 AI 분석을 이용할 수 있습니다.');
 const allChapters=(await rows(ctx,'document_chapters')).filter((c:any)=>c.document_id===document.id&&selectedPages.some(p=>p>=c.start_page&&p<=c.end_page));
 const requestedChapters=Array.isArray(body.chapterIds)?new Set(body.chapterIds):null;
 if(requestedChapters&&[...requestedChapters].some(id=>!allChapters.some((c:any)=>c.id===id)))throw new AppError('현재 자료의 단원을 선택하세요.');
 const chapters=allChapters.filter((c:any)=>!requestedChapters||requestedChapters.has(c.id)).map((c:any)=>({id:c.id,title:c.title,start_page:c.start_page,end_page:c.end_page}));
 const partSize=method==='api'?5:Math.max(1,questionCount);let totalParts=method==='external'?1:splitCount(questionCount,partSize).length;
 if(method==='api'&&taskType!=='bank')totalParts=Math.max(totalParts,Math.ceil((taskType==='problem'?targetQuestions.length:taskType==='toc'&&toc.length?toc.length:selectedPages.length)/3));
 const partCounts=method==='external'?[questionCount]:taskType!=='bank'?Array.from({length:totalParts},(_,i)=>Math.floor(questionCount/totalParts)+(i<questionCount%totalParts?1:0)):splitCount(questionCount,partSize);
 const data={pageCount,selectedPages,tocPages:toc,title:document.title,subject:document.subject,printedPageOffset:document.data.printedPageOffset??null,questionCount,totalParts,partSize,partCounts,taskType,questionTypes,difficultyDistribution,targetQuestions,chapters,knownChapters:chapters,knownConcepts:[],questionTypeCounts:body.questionTypeCounts||{},purposeCounts,method,evidence:selectedPages.every(p=>toc.includes(p))?'toc_only':'selected_pages',receivedParts:0,importedQuestions:0};
 let deterministicId:string|undefined;
 if(body.auto===true||body.continuationOf){const hex=await sha256(JSON.stringify([ctx.user.id,document.id,selectedPages,toc,taskType,questionCount,document.data.engineVersion,body.continuationOf??null,body.completedPartsHash??null]));deterministicId=`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;const {data:existing}=await ctx.admin.from('content_jobs').select('id').eq('id',deterministicId).eq('user_id',ctx.user.id).maybeSingle();if(existing)return jobView(ctx,existing.id);}
 const {data:saved,error}=await ctx.admin.from('content_jobs').insert({...(deterministicId?{id:deterministicId}:{}),user_id:ctx.user.id,document_id:document.id,data,status:'draft'}).select('*').single();
 if(error?.code==='23505'&&deterministicId)return jobView(ctx,deterministicId);dbError(error,'작업을 만들지 못했습니다.');
 if(body.auto===true)await ctx.admin.from('documents').update({data:{...document.data,initialContentJobId:saved.id}}).eq('id',document.id).eq('user_id',ctx.user.id).eq('updated_at',document.updated_at);
 return jobView(ctx,saved.id);
}
export async function apiContinuation(ctx:Ctx,id:string){
 const master=await row(ctx,'content_jobs',id),job=standardJob(master);
 if(job.method==='api'&&job.partSize<=5)return jobView(ctx,id);
 const parts=await rows(ctx,'content_parts',{job_id:id}),merged=validateRestudyParts(parts.map((p:any)=>p.raw),job,{chapters:master.data.knownChapters??[],concepts:master.data.knownConcepts??[]});
 const done=merged.questions??[],remaining=Math.max(0,job.questionCount-done.length);
 if(!remaining&&!['toc','concepts'].includes(job.taskType))return jobView(ctx,id);
 const counts=Object.fromEntries(Object.entries(job.purposeCounts??{practice:job.questionCount}).map(([purpose,count])=>[purpose,Math.max(0,Number(count)-done.filter((q:any)=>q.purpose===purpose).length)]));
 const body={documentId:job.documentId,method:'api',taskType:job.taskType,selectedPages:job.selectedPages,tocPages:job.tocPages,questionCount:remaining,conceptQuestionCount:counts.concept??0,practiceQuestionCount:counts.practice??remaining,purposeCounts:counts,questionTypes:job.questionTypes,difficultyDistribution:job.difficultyDistribution,continuationOf:id,completedPartsHash:await sha256(JSON.stringify(parts.map((p:any)=>[p.part,p.content_hash]))),...(job.taskType==='problem'?{questionIds:job.targetQuestions.map((q:any)=>q.id)}:{})};
 return createJob(ctx,body);
}
export async function previewPart(ctx:Ctx,jobId:string,input:unknown){
 const rowJob=await row(ctx,'content_jobs',jobId),job=standardJob(rowJob);let incoming;
 try{incoming=parseRestudy(input)}catch(error){throw new AppError((error as Error).message)}
 const {data:parts,error}=await ctx.db.from('content_parts').select('*').eq('user_id',ctx.user.id).eq('job_id',jobId).order('part');dbError(error,'이전 분할을 읽지 못했습니다.');
 const saved=job.taskType==='bank'?await bankReferences(ctx,job):null;
 const merged=validateRestudyParts([...parts.map((p:any)=>p.raw),incoming],job,{chapters:[...new Map([...(saved?.chapters??[]),...(rowJob.data.knownChapters??[])].map(c=>[c.id,c])).values()],concepts:[...new Map([...(saved?.concepts??[]),...(rowJob.data.knownConcepts??[])].map(c=>[c.id,c])).values()]});
 const perPart=job.partCounts?.[incoming.part-1]??splitCount(job.questionCount,job.partSize)[incoming.part-1];if(incoming.questions.length>perPart)merged.errors.push(`이번 분할은 ${perPart}문제 이하로 입력하세요.`);
 if(['toc','concepts'].includes(job.taskType)&&incoming.questions.length)merged.errors.push('개념·목차 작업에는 문제를 가져오지 않습니다. 기본 문제 또는 문제 은행을 선택하세요.');
 if(job.taskType==='concepts'&&incoming.problem_analyses.length)merged.errors.push('개념 정리에는 원본 문제 분석을 가져오지 않습니다.');
 if(job.targetQuestions.length){const target=new Set(job.targetQuestions.map((q:any)=>`${q.q_number}:${q.pdf_page}`));for(const a of incoming.problem_analyses)if(!target.has(`${a.q_number}:${a.pdf_page}`))merged.errors.push('요청한 원본 문제 번호·페이지와 분석 결과가 다릅니다.');}
 const index=incoming.problem_analyses.length?await rows(ctx,'problems',{document_id:job.documentId}):[];
 for(const a of incoming.problem_analyses){const matches=index.filter((q:any)=>String(q.number)===String(Number(a.q_number))&&q.page===a.pdf_page);if(matches.length!==1)merged.warnings.push(`${a.q_number}번(${a.pdf_page}쪽)은 원본 영역을 지정하거나 중복 번호를 구분해야 합니다. 분석 데이터는 보존합니다.`)}
 merged.valid=!merged.errors.length;merged.ready=merged.valid&&!merged.unresolved.length;
 const samePart=parts.find((p:any)=>p.part===incoming.part&&canonicalJson(p.raw)===canonicalJson(incoming));
 // Preserve legacy hashes when an unchanged existing part is reimported.
 const hash=samePart?.content_hash??await sha256(canonicalJson(incoming));
 return {job,rowJob,incoming,existingCount:parts.length,hash,merged,bindings:saved?.bindings??{},preview:{valid:merged.valid,ready:merged.ready,complete:merged.complete,errors:merged.errors,warnings:merged.warnings,unresolved:merged.unresolved,duplicates:merged.duplicates,counts:merged.counts,part:incoming.part,totalParts:incoming.total_parts,hash,review:{chapters:merged.chapters,concepts:merged.concepts,questions:merged.questions,flashcards:merged.flashcards,problemAnalyses:merged.problemAnalyses}}};
}
export async function commitPart(ctx:Ctx,jobId:string,input:unknown,reviewed=false,child?:{id:string,lease:string}){
 const checked=await previewPart(ctx,jobId,input);if(!checked.merged.valid)throw new AppError(checked.merged.errors.join('\n'));
 const compiled=await compileRestudy(checked.merged,checked.job,checked.bindings);
 const {data,error}=await ctx.admin.rpc('commit_restudy_part',{p_user_id:ctx.user.id,p_job_id:jobId,p_part:checked.incoming,p_hash:checked.hash,p_existing_count:checked.existingCount,p_compiled:compiled,p_reviewed:true,p_ai_job_id:child?.id||null,p_ai_lease:child?.lease||null});
 dbError(error,'분할을 저장하지 못했습니다. 다른 화면의 변경 여부를 확인하고 다시 검사하세요.');
 if(!data)throw new AppError('원본이나 작업 상태가 변경되어 결과를 보류했습니다.',409);
 return {...data,job:await jobView(ctx,jobId),warnings:checked.merged.warnings};
}
export async function handleStandard(ctx:Ctx,input:any){const action=input.action||'list';
 if(action==='api_continuation'){requireFeature(ctx,'ai');return apiContinuation(ctx,input.jobId);}
 if(action==='create')return createJob(ctx,input);
 if(action==='list'){const jobs=await rows(ctx,'content_jobs',input.documentId?{document_id:input.documentId}:{});return {jobs:jobs.map((j:any)=>({...standardJob(j),status:j.status,createdAt:j.created_at})).sort((a:any,b:any)=>String(b.createdAt??'').localeCompare(String(a.createdAt??'')))};}
 if(action==='get')return jobView(ctx,input.jobId,typeof input.partsVersion==='string'&&/^[a-f0-9]{64}$/.test(input.partsVersion)?input.partsVersion:undefined);
 if(action==='prompt'){const r=await row(ctx,'content_jobs',input.jobId);return {prompt:createExternalPrompt(standardJob(r),Number(input.part||1)),job:standardJob(r)};}
 if(action==='preview')return (await previewPart(ctx,input.jobId,input.raw)).preview;
 if(action==='import'){if(typeof input.previewHash!=='string')throw new AppError('미리보기를 먼저 확인하세요.');const current=await previewPart(ctx,input.jobId,input.raw);if(current.hash!==input.previewHash)throw new AppError('내용이 바뀌었습니다. 다시 검사하세요.');return commitPart(ctx,input.jobId,input.raw,input.reviewed===true);}
 throw new AppError('지원하지 않는 콘텐츠 작업입니다.');
}
