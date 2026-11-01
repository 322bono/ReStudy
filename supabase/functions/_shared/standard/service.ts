import {AppError,sha256} from '../context.ts';
import {row,rows,type Ctx} from '../app/repository.ts';
import {compileRestudy} from '../../../../src/domain/restudy-compile.ts';
import {createExternalPrompt,parseRestudy,splitCount,validateRestudyParts,type StandardJob} from '../../../../src/domain/restudy.ts';
import {selectPages,tocPages} from '../../../../src/domain/pages.ts';

export const standardJob=(r:any):StandardJob=>({...r.data,id:r.id,documentId:r.document_id});
function dbError(error:any,message:string){if(error)throw new AppError(message);}
export async function jobView(ctx:Ctx,id:string){const job=await row(ctx,'content_jobs',id),parts=(await rows(ctx,'content_parts')).filter((p:any)=>p.job_id===id);return {...standardJob(job),status:job.status,parts:parts.map((p:any)=>({part:p.part,totalParts:p.total_parts,questions:p.raw.questions?.length||0,applied:p.applied})),createdAt:job.created_at};}
export async function createJob(ctx:Ctx,body:any){
 const document=await row(ctx,'documents',String(body.documentId||''));if(document.data.archived)throw new AppError('보관된 자료를 먼저 복원하세요.');
 const pageCount=Number(document.data.pageCount);if(!pageCount)throw new AppError('PDF 페이지 수를 확인할 수 없습니다.');
 const selectedPages=Array.isArray(body.selectedPages)?selectPages(body.selectedPages.join(','),pageCount):selectPages(String(body.pages??document.data.analysisRange??''),pageCount,String(body.excludedPages??document.data.excludedPages??''));
 const toc=Array.isArray(body.tocPages)?tocPages(body.tocPages.join(','),pageCount):tocPages(String(body.tocRange??document.data.tocRange??''),pageCount);
 const taskType=String(body.taskType||'bank');if(!['initial','bank','problem','toc'].includes(taskType))throw new AppError('요청 작업을 확인하세요.');
 const conceptCount=Number(body.conceptQuestionCount??5),practiceCount=Number(body.practiceQuestionCount??5);
 const questionCount=taskType==='toc'?0:taskType==='initial'?conceptCount+practiceCount:Number(body.questionCount??100);
 if(!Number.isInteger(questionCount)||questionCount<0||questionCount>1000||taskType!=='toc'&&questionCount<1)throw new AppError('문제 수를 1~1000개로 입력하세요.');
 const questionTypes=body.questionTypes||['mcq','ox','short','blank'];if(!Array.isArray(questionTypes)||!questionTypes.length||questionTypes.some((t:string)=>!['mcq','ox','short','blank'].includes(t)))throw new AppError('문제 유형을 선택하세요.');
 const difficultyDistribution=body.difficultyDistribution||{easy:20,medium:50,hard:30};if(Object.keys(difficultyDistribution).some(k=>!['easy','medium','hard'].includes(k))||Object.values(difficultyDistribution).some(v=>typeof v!=='number'||v<0)||Object.values(difficultyDistribution).reduce((a:any,b:any)=>a+b,0)!==100)throw new AppError('난이도 비율의 합은 100%여야 합니다.');
 if(body.questionTypeCounts&&(Object.keys(body.questionTypeCounts).some(k=>!questionTypes.includes(k))||Object.values(body.questionTypeCounts).some(v=>!Number.isInteger(v)||Number(v)<0)||Object.values(body.questionTypeCounts).reduce((a:any,b:any)=>a+b,0)!==questionCount))throw new AppError('유형별 문제 수의 합을 전체 문제 수와 맞추세요.');
 const method=String(body.method||'external');if(!['external','api'].includes(method))throw new AppError('분석 방식을 선택하세요.');
 const purposeCounts=taskType==='initial'?{concept:conceptCount,practice:practiceCount,similar:0}:body.purposeCounts||{concept:0,practice:questionCount,similar:0};
 if(!purposeCounts||typeof purposeCounts!=='object'||Array.isArray(purposeCounts)||Object.keys(purposeCounts).some(k=>!['concept','practice','similar'].includes(k))||Object.values(purposeCounts).some(v=>!Number.isInteger(v)||Number(v)<0)||Object.values(purposeCounts).reduce((a:any,b:any)=>a+b,0)!==questionCount)throw new AppError('개념 퀴즈·연습·유사문제 수의 합을 전체 문제 수와 맞추세요.');
 const targetQuestions:any[]=[];
 if(body.questionIds){if(!Array.isArray(body.questionIds)||body.questionIds.length>100)throw new AppError('분석할 원본 문제를 확인하세요.');for(const id of [...new Set(body.questionIds)]){const q=await row(ctx,'problems',String(id));if(q.document_id!==document.id||!selectedPages.includes(q.page))throw new AppError('분석할 원본 문제와 자료·페이지가 다릅니다.');targetQuestions.push({id:q.id,q_number:String(q.number),pdf_page:q.page,text:q.data.text||'',chapter_id:q.data.chapterId||null})}}
 if(taskType==='problem'&&method==='api'&&!targetQuestions.length)throw new AppError('API 분석에는 저장된 원본 문제 영역을 선택하세요. 인덱스가 없으면 PDF와 함께 외부 AI 분석을 이용할 수 있습니다.');
 const allChapters=(await rows(ctx,'document_chapters')).filter((c:any)=>c.document_id===document.id&&selectedPages.some(p=>p>=c.start_page&&p<=c.end_page));
 const requestedChapters=Array.isArray(body.chapterIds)?new Set(body.chapterIds):null;
 if(requestedChapters&&[...requestedChapters].some(id=>!allChapters.some((c:any)=>c.id===id)))throw new AppError('현재 자료의 단원을 선택하세요.');
 const chapters=allChapters.filter((c:any)=>!requestedChapters||requestedChapters.has(c.id)).map((c:any)=>({id:c.id,title:c.title,start_page:c.start_page,end_page:c.end_page}));
 const partSize=20;let totalParts=splitCount(questionCount,partSize).length;
 if(method==='api'&&taskType!=='bank')totalParts=Math.max(totalParts,Math.ceil((taskType==='problem'?targetQuestions.length:taskType==='toc'&&toc.length?toc.length:selectedPages.length)/(taskType==='problem'?3:6)));
 const partCounts=method==='api'&&taskType!=='bank'?Array.from({length:totalParts},(_,i)=>Math.floor(questionCount/totalParts)+(i<questionCount%totalParts?1:0)):splitCount(questionCount,partSize);
 const data={pageCount,selectedPages,tocPages:toc,title:document.title,subject:document.subject,printedPageOffset:document.data.printedPageOffset??null,questionCount,totalParts,partSize,partCounts,taskType,questionTypes,difficultyDistribution,targetQuestions,chapters,knownChapters:chapters,knownConcepts:[],questionTypeCounts:body.questionTypeCounts||{},purposeCounts,method,evidence:selectedPages.every(p=>toc.includes(p))?'toc_only':'selected_pages',receivedParts:0,importedQuestions:0};
 let deterministicId:string|undefined;
 if(body.auto===true){const hex=await sha256(JSON.stringify([ctx.user.id,document.id,selectedPages,toc,taskType,questionCount,document.data.engineVersion]));deterministicId=`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;const {data:existing}=await ctx.admin.from('content_jobs').select('id').eq('id',deterministicId).eq('user_id',ctx.user.id).maybeSingle();if(existing)return jobView(ctx,existing.id);}
 const {data:saved,error}=await ctx.admin.from('content_jobs').insert({...(deterministicId?{id:deterministicId}:{}),user_id:ctx.user.id,document_id:document.id,data,status:'draft'}).select('*').single();
 if(error?.code==='23505'&&deterministicId)return jobView(ctx,deterministicId);dbError(error,'작업을 만들지 못했습니다.');
 if(body.auto===true)await ctx.admin.from('documents').update({data:{...document.data,initialContentJobId:saved.id}}).eq('id',document.id).eq('user_id',ctx.user.id).eq('updated_at',document.updated_at);
 return jobView(ctx,saved.id);
}
export async function previewPart(ctx:Ctx,jobId:string,input:unknown){
 const rowJob=await row(ctx,'content_jobs',jobId),job=standardJob(rowJob);let incoming;
 try{incoming=parseRestudy(input)}catch(error){throw new AppError((error as Error).message)}
 const {data:parts,error}=await ctx.db.from('content_parts').select('*').eq('user_id',ctx.user.id).eq('job_id',jobId).order('part');dbError(error,'이전 분할을 읽지 못했습니다.');
 const merged=validateRestudyParts([...parts.map((p:any)=>p.raw),incoming],job,{chapters:rowJob.data.knownChapters||[],concepts:rowJob.data.knownConcepts||[]});
 const perPart=job.partCounts?.[incoming.part-1]??splitCount(job.questionCount,job.partSize)[incoming.part-1];if(incoming.questions.length>perPart)merged.errors.push(`이번 분할은 ${perPart}문제 이하로 입력하세요.`);
 if(job.taskType==='toc'&&incoming.questions.length)merged.errors.push('목차 작업에는 문제를 가져오지 않습니다. 문제 은행 작업을 따로 만드세요.');
 if(job.targetQuestions.length){const target=new Set(job.targetQuestions.map((q:any)=>`${q.q_number}:${q.pdf_page}`));for(const a of incoming.problem_analyses)if(!target.has(`${a.q_number}:${a.pdf_page}`))merged.errors.push('요청한 원본 문제 번호·페이지와 분석 결과가 다릅니다.');}
 const index=(await rows(ctx,'problems')).filter((q:any)=>q.document_id===job.documentId);
 for(const a of incoming.problem_analyses){const matches=index.filter((q:any)=>String(q.number)===String(Number(a.q_number))&&q.page===a.pdf_page);if(matches.length!==1)merged.warnings.push(`${a.q_number}번(${a.pdf_page}쪽)은 원본 영역을 지정하거나 중복 번호를 구분해야 합니다. 분석 데이터는 보존합니다.`)}
 merged.valid=!merged.errors.length;merged.ready=merged.valid&&!merged.unresolved.length;
 const hash=await sha256(JSON.stringify(incoming));
 return {job,rowJob,incoming,existingCount:parts.length,hash,merged,preview:{valid:merged.valid,ready:merged.ready,complete:merged.complete,errors:merged.errors,warnings:merged.warnings,unresolved:merged.unresolved,duplicates:merged.duplicates,counts:merged.counts,part:incoming.part,totalParts:incoming.total_parts,hash,review:{chapters:merged.chapters,concepts:merged.concepts,questions:merged.questions,flashcards:merged.flashcards,problemAnalyses:merged.problemAnalyses}}};
}
export async function commitPart(ctx:Ctx,jobId:string,input:unknown,reviewed=false,child?:{id:string,lease:string}){
 const checked=await previewPart(ctx,jobId,input);if(!checked.merged.valid)throw new AppError(checked.merged.errors.join('\n'));
 const compiled=await compileRestudy(checked.merged,checked.job);
 const {data,error}=await ctx.admin.rpc('commit_restudy_part',{p_user_id:ctx.user.id,p_job_id:jobId,p_part:checked.incoming,p_hash:checked.hash,p_existing_count:checked.existingCount,p_compiled:compiled,p_reviewed:reviewed===true,p_ai_job_id:child?.id||null,p_ai_lease:child?.lease||null});
 dbError(error,'분할을 저장하지 못했습니다. 다른 화면의 변경 여부를 확인하고 다시 검사하세요.');
 if(!data)throw new AppError('원본이나 작업 상태가 변경되어 결과를 보류했습니다.',409);
 return {...data,job:await jobView(ctx,jobId),warnings:checked.merged.warnings};
}
export async function handleStandard(ctx:Ctx,input:any){const action=input.action||'list';
 if(action==='create')return createJob(ctx,input);
 if(action==='list'){const jobs=await rows(ctx,'content_jobs');return {jobs:jobs.filter((j:any)=>!input.documentId||j.document_id===input.documentId).map((j:any)=>({...standardJob(j),status:j.status})).sort((a:any,b:any)=>b.id.localeCompare(a.id))};}
 if(action==='get')return jobView(ctx,input.jobId);
 if(action==='prompt'){const r=await row(ctx,'content_jobs',input.jobId);return {prompt:createExternalPrompt(standardJob(r),Number(input.part||1)),job:standardJob(r)};}
 if(action==='preview')return (await previewPart(ctx,input.jobId,input.raw)).preview;
 if(action==='import'){if(typeof input.previewHash!=='string')throw new AppError('미리보기를 먼저 확인하세요.');const current=await previewPart(ctx,input.jobId,input.raw);if(current.hash!==input.previewHash)throw new AppError('내용이 바뀌었습니다. 다시 검사하세요.');return commitPart(ctx,input.jobId,input.raw,input.reviewed===true);}
 throw new AppError('지원하지 않는 콘텐츠 작업입니다.');
}
