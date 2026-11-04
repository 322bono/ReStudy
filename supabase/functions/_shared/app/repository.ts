import {AppError} from '../context.ts';
import{preparedBankLinks}from'../../../../src/domain/learning.ts';
export type Ctx={user:{id:string},db:any,admin:any};
export async function rows(ctx:Ctx,table:string,filters:Record<string,string|number>={},columns='*'){const all:any[]=[];for(let offset=0;;offset+=1000){let query=ctx.db.from(table).select(columns).eq('user_id',ctx.user.id);for(const [column,value]of Object.entries(filters))query=query.eq(column,value);const {data,error}=await query.range(offset,offset+999);if(error)throw new AppError('저장된 자료를 읽지 못했습니다.',500);all.push(...data);if(data.length<1000)return all;}}
/** OCR text is fetched only for the material view that returns it. */
export async function pageRows(ctx:Ctx,documentId?:string,number?:number,withText=false){
 const all:any[]=[];
 for(let offset=0;;offset+=1000){
  const fields='id,document_id,number,image_path,kind:data->>kind,width:data->width,height:data->height,source:data->>source,manualKind:data->manualKind';
  let query=ctx.db.from('document_pages').select(withText?`${fields},text:data->>text`:fields).eq('user_id',ctx.user.id);
  if(documentId!==undefined)query=query.eq('document_id',documentId);
  if(number!==undefined)query=query.eq('number',number);
  const {data,error}=await query.range(offset,offset+999);
  if(error)throw new AppError('저장된 페이지 정보를 읽지 못했습니다.',500);
  all.push(...data.map((r:any)=>({id:r.id,document_id:r.document_id,number:r.number,image_path:r.image_path,data:{kind:r.kind,width:r.width,height:r.height,text:r.text??'',source:r.source,manualKind:r.manualKind}})));
  if(data.length<1000)return all;
 }
}
export async function row(ctx:Ctx,table:string,id:string,columns='*'){const {data,error}=await ctx.db.from(table).select(columns).eq('user_id',ctx.user.id).eq('id',id).maybeSingle();if(error||!data)throw new AppError('자료 또는 학습 기록을 찾을 수 없습니다.',404);return data;}
export async function preparationPageRows(ctx: Ctx, documentId: string, numbers: number[]) {
 const { data, error } = await ctx.db.from('document_pages')
  .select('id,number,updated_at,text:data->>text,kind:data->>kind,checkpoint:data->checkpointComplete')
  .eq('user_id', ctx.user.id).eq('document_id', documentId).in('number', numbers);
 if (error) throw new AppError('저장된 페이지 본문을 읽지 못했습니다.', 500);
 return data.map((p: any) => ({ ...p, data: { text: p.text ?? '', kind: p.kind, checkpointComplete: p.checkpoint } }));
}
export async function preparationChapters(ctx: Ctx, jobId: string, beforePart: number) {
 if (beforePart <= 1) return [];
 const { data, error } = await ctx.db.from('content_parts')
  .select('chapters:raw->chapters')
  .eq('user_id', ctx.user.id).eq('job_id', jobId).lt('part', beforePart).order('part');
 if (error) throw new AppError('이전 분할의 단원을 읽지 못했습니다.', 500);
 return data.flatMap((part: any) => part.chapters ?? []);
}
export function value(r:any){return {...r.data,id:r.id,createdAt:r.data?.createdAt||r.created_at,updatedAt:r.updated_at};}
export async function put(ctx:Ctx,table:string,id:string,data:any,columns:Record<string,unknown>={}){const result=await ctx.db.from(table).upsert({id,user_id:ctx.user.id,...columns,data},{onConflict:table==='concepts'||table==='concept_questions'?'id,user_id':'id'}).select().single();if(result.error)throw new AppError('자료 저장 중 참조 또는 형식을 확인하지 못했습니다.',400);return result.data;}
export const material=(r:any)=>({...value(r),title:r.title,subject:r.subject,kind:r.kind,status:r.status,hash:r.content_hash});
export const mistake=(r:any)=>({...value(r),questionId:r.problem_id,resolved:r.data.resolved??r.data.lastResult==='correct'});
export async function state(ctx:Ctx,withPages=false){
 const names=['documents','problems','problem_regions','problem_concepts','concepts','concept_questions','wrong_answers','study_sessions','solve_sessions','study_results','document_chapters','chapter_concepts','bank_question_concepts','bank_question_origins',...(withPages?['document_pages']:[])];
 const lists=await Promise.all(names.map(t=>t==='document_pages'?pageRows(ctx):rows(ctx,t))),tables=Object.fromEntries(names.map((n,i)=>[n,lists[i]]));
 const projection=async(table:string,columns:string)=>{const result:any[]=[];for(let offset=0;;offset+=1000){const page=await ctx.db.from(table).select(columns).eq('user_id',ctx.user.id).range(offset,offset+999);if(page.error)throw new AppError('준비한 문항 연결을 읽지 못했습니다.',500);result.push(...page.data);if(page.data.length<1000)return result;}};
 const [preparedJobs,preparedRefs]=await Promise.all([projection('content_jobs','id,document_id,task_type:data->>taskType,first_target:data->targetQuestions->0->>id,second_target:data->targetQuestions->1->>id'),projection('content_refs','job_id,kind,actual_id')]);
 const preparedLinks=preparedBankLinks(preparedJobs,preparedRefs,tables.problems.map((q:any)=>({id:q.id,materialId:q.document_id})));
 const bank=tables.concept_questions.map((r:any)=>({...value(r),preparedQuestionIds:preparedLinks.get(r.id)??[],conceptId:r.concept_id,conceptIds:[...new Set([r.concept_id,...(r.data.conceptIds||[]),...tables.bank_question_concepts.filter((v:any)=>v.question_id===r.id).map((v:any)=>v.concept_id)])],chapterIds:[...new Set([r.data.chapterId,...tables.bank_question_origins.filter((v:any)=>v.question_id===r.id).map((v:any)=>v.chapter_id)].filter(Boolean))],purposes:[...new Set([r.data.purpose,...tables.bank_question_origins.filter((v:any)=>v.question_id===r.id).map((v:any)=>v.purpose)].filter(Boolean))],origins:tables.bank_question_origins.filter((v:any)=>v.question_id===r.id),active:r.review_status==='approved'&&r.data.active!==false&&r.data.archived!==true,reviewStatus:r.review_status}));
 const materials=tables.documents.map(material).filter((m:any)=>!m.archived);
 const active=new Set(materials.map((m:any)=>m.id));
 const questions=tables.problems.filter((r:any)=>active.has(r.document_id)&&r.data.autoRetired!==true).map((r:any)=>{
 const parts=tables.problem_regions.filter((p:any)=>p.problem_id===r.id).sort((a:any,b:any)=>a.part-b.part),ids=tables.problem_concepts.filter((m:any)=>m.problem_id===r.id).map((m:any)=>m.concept_id);
 return {...value(r),materialId:r.document_id,number:r.number,page:r.page,regions:parts.length?parts.map((p:any)=>p.data):r.data.regions||[],imagePaths:parts.map((p:any)=>p.image_path),conceptIds:ids,hasContent:ids.length>0&&ids.every((cid:string)=>bank.some((i:any)=>i.conceptIds.includes(cid)&&i.active&&i.modes?.some((m:string)=>['quiz','check'].includes(m))))};
 });
 return {materials,questions,chapters:tables.document_chapters.map((r:any)=>({...value(r),materialId:r.document_id,title:r.title,startPage:r.start_page,endPage:r.end_page})),concepts:tables.concepts.map((r:any)=>({...value(r),subject:r.subject,major:r.major,minor:r.minor,name:r.name,chapterIds:tables.chapter_concepts.filter((v:any)=>v.concept_id===r.id).map((v:any)=>v.chapter_id)})),bank,mistakes:tables.wrong_answers.map(mistake).filter((m:any)=>!m.archived),studies:tables.study_sessions.map(value),sessions:tables.solve_sessions.map(value),results:tables.study_results.map(value),pages:withPages?tables.document_pages.map((r:any)=>({...r.data,number:r.number,materialId:r.document_id,imagePath:r.image_path})):[],tables};
}
export function publicQuestion(q:any){const {answer,explanation,wrongReview,...safe}=q;return safe;}
export async function signed(ctx:Ctx,path:string){if(!path?.startsWith(ctx.user.id+'/')||path.includes('..'))throw new AppError('원본 접근 권한이 없습니다.',403);const {data,error}=await ctx.db.storage.from('study-files').createSignedUrl(path,180);if(error||!data?.signedUrl)throw new AppError('원본 파일을 열 수 없습니다.',404);return data.signedUrl;}
