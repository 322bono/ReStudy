import {AppError} from '../context.ts';
import {gradingContext,material,mistake,publicQuestion,put,row,rows,pageRows,signed,state,value,type Ctx} from './repository.ts';
import {importContent,validate} from './content.ts';
import {exportData,restoreData} from './backup.ts';
import{saveOutline,documentIndex}from'./pdf-index.ts';
import {answerSolve,answerStudy,createBankStudy,createReview,createSolve,createStudy,publicStudy,repeatWeak,revealStudy,relatedOriginalIds,originalReview} from '../../../../src/domain/learning.ts';
import { wrongReviewIssues } from '../../../../src/domain/answer-quality.ts';

function registrationOptions(input: unknown, selected: Set<string>) {
 const options = new Map<string, { answer?: string; analyze?: boolean }>();
 if (input === undefined) return options;
 if (!Array.isArray(input) || input.length > 200)
  throw new AppError('문항별 오답 등록 옵션을 확인해 주세요.');
 for (const option of input) {
  if (!option || !selected.has(option.questionId) || options.has(option.questionId) ||
      (option.analyze !== undefined && typeof option.analyze !== 'boolean') ||
      (option.answer !== undefined && (typeof option.answer !== 'string' || option.answer.length > 1000))) {
   throw new AppError('문항별 AI 분석 여부와 정답(1000자 이하)을 확인해 주세요.');
  }
  options.set(option.questionId, { analyze: option.analyze, answer: option.answer?.trim() });
 }
 return options;
}

const now=()=>new Date().toISOString(),uuid=()=>crypto.randomUUID();
const publicMistake=({registeredAnswer,...record}:any)=>record;
function numbers(text:string,max=1000){if(!text?.trim())return [];const out:number[]=[];for(const part of text.trim().split(/[\s,]+/)){const m=part.match(/^(\d{1,5})(?:[-~](\d{1,5}))?$/);if(!m)throw new AppError('번호 또는 범위를 확인하세요.');const a=+m[1],b=+(m[2]||m[1]);if(a<1||b<a||b-a>=max)throw new AppError('번호 범위를 확인하세요.');for(let n=a;n<=b;n++)out.push(n);if(out.length>max)throw new AppError('선택한 번호가 너무 많습니다.')}return [...new Set(out)];}
const content=(s:any)=>({schemaVersion:1,concepts:s.concepts,items:s.bank,mappings:s.questions.map((q:any)=>({questionId:q.id,materialId:q.materialId,number:q.number,page:q.page,conceptIds:q.conceptIds,answer:q.answer||'',explanation:q.explanation||''})),materials:s.materials.map((m:any)=>({id:m.id,title:m.title,hash:m.hash}))});
const solvePublic=(s:any)=>{const {questionSnapshots,...safe}=s;return {...safe,questions:(questionSnapshots||s.questions||[]).map((q:any)=>{const {analysis,memorize,...original}=publicQuestion(q);return original;})}};
const learnState=(s:any)=>({...s,questions:s.questions.filter((q:any)=>q.regions.every((r:any)=>s.pages.find((p:any)=>p.materialId===q.materialId&&p.number===r.page)?.kind!=='answers'))});
async function saveStudy(ctx:Ctx,session:any){await put(ctx,'study_sessions',session.id,session);return publicStudy(session)}
async function learningMutation(ctx:Ctx,kind:'study'|'solve',id:string,body:any,reveal=false){
 for(let attempt=0;attempt<4;attempt++){
  const current=value(await row(ctx,kind==='study'?'study_sessions':'solve_sessions',id));
  let result:any;
  if(reveal)result={...revealStudy(current,body.itemId),mistakes:[]};
  else if(kind==='solve'){
   const {questionId,result:grade,drawingOnly}=body;
   const needsMistake=!drawingOnly&&['correct','wrong'].includes(grade)&&current.questionIds?.includes(questionId)&&!Object.hasOwn(current.answers,questionId);
   const mistakes=needsMistake?(await rows(ctx,'wrong_answers',{problem_id:questionId})).map(mistake).filter(m=>!m.archived):[];
   result=answerSolve(current,body,{mistakes});
  }else if(current.mode==='memory'&&!current.originQuestionIds?.length){
   result=answerStudy(current,body,{questions:[],results:[],mistakes:[]});
  }else{
   result=answerStudy(current,body,await gradingContext(ctx,current.originQuestionIds??[]));
  }
  const {data,error}=await ctx.admin.rpc('save_learning_session',{p_user_id:ctx.user.id,p_kind:kind,p_id:id,p_version:current.version||0,p_data:result.session,p_attempt:result.attempt||null,p_mistakes:result.mistakes||[]});
  if(error)throw new AppError('학습 기록을 저장하지 못했습니다. 다시 시도하세요.',500);
  if(data){
   if(reveal)return {answer:result.answer,explanation:result.explanation,session:publicStudy(data)};
   if(kind==='solve')return body.minimal===true?(body.drawingOnly?{saved:true}:{id:data.id,answers:data.answers,status:data.status,version:data.version}):solvePublic(data);
   return publicStudy(data);
  }
 }
 throw new AppError('다른 화면에서 기록이 변경됐습니다. 다시 열어 주세요.',409);
}
async function asset(ctx:Ctx,path:string){
 const p=path.replace(/^\/api\//,'').split('?')[0].split('/'),query=new URLSearchParams(path.split('?')[1]||'');let storagePath='';
 if(p[0]==='materials'){
  if(p[2]==='file')storagePath=(await row(ctx,'documents',p[1],'originalPath:data->>originalPath')).originalPath;
  else if(p[2]==='page'){const [page]=await rows(ctx,'document_pages',{document_id:p[1],number:Number(p[3])},'image_path');if(!page)throw new AppError('페이지를 찾을 수 없습니다.',404);storagePath=page.image_path;}
 }else if(p[0]==='questions'&&p[2]==='image'){
  let data:any,documentId:string,paths:string[]=[];const sessionId=query.get('session');
  if(sessionId){
   const index=query.get('snapshot');let snapshot:any;
   if(index!==null){
    if(!/^(?:0|[1-9]\d{0,3})$/.test(index))throw new AppError('이 풀이의 원본 문항이 아닙니다.',403);
    if(!/^(?:0|[1-9]\d{0,3})$/.test(p[3]))throw new AppError('준비된 원본 영역이 없습니다.',404);
    const prefix=`data->questionSnapshots->${index}`;
    const image=await row(ctx,'solve_sessions',sessionId,`snapshotId:${prefix}->>id,materialId:${prefix}->>materialId,region:${prefix}->regions->${p[3]},imagePath:${prefix}->imagePaths->>${p[3]}`);
    snapshot={id:image.snapshotId,materialId:image.materialId,regions:{[p[3]]:image.region},imagePaths:{[p[3]]:image.imagePath}};
   }else snapshot=(await row(ctx,'solve_sessions',sessionId,'snapshots:data->questionSnapshots')).snapshots?.find((q:any)=>q.id===p[1]);
   if(!snapshot||snapshot.id!==p[1])throw new AppError('이 풀이의 원본 문항이 아닙니다.',403);
   data=snapshot;documentId=snapshot.materialId;paths=snapshot.imagePaths||[];
  }else{
   const q=await row(ctx,'problems',p[1],'id,document_id,regions:data->regions');
   data=q;documentId=q.document_id;
   paths=(await rows(ctx,'problem_regions',{problem_id:q.id},'part,image_path')).sort((a:any,b:any)=>a.part-b.part).map((r:any)=>r.image_path);
  }
  const region=data.regions?.[Number(p[3])];if(!region)throw new AppError('준비된 원본 영역이 없습니다.',404);
  const [page]=await rows(ctx,'document_pages',{document_id:documentId,number:region.page},'kind:data->>kind');if(page?.kind==='answers')throw new AppError('정답·해설 페이지는 문제로 제공하지 않습니다.',409);
  storagePath=paths[Number(p[3])];
 }
 if(!storagePath)throw new AppError('준비된 원본 이미지가 없습니다.',404);return {url:await signed(ctx,storagePath),storagePath};
}
export async function handle(ctx:Ctx,input:any):Promise<any>{
 const path=String(input.path||'').replace(/^\//,''),method=String(input.method||'GET').toUpperCase(),b=input.body||{},url=new URL('https://app.invalid/'+path),p=url.pathname.slice(1).split('/'),route=p[0],id=p[1],action=p[2];
 if(route==='asset')return asset(ctx,String(b.path||url.searchParams.get('path')||''));
 if(route==='data'&&method==='POST'){if(id==='export')return exportData(ctx,b);if(id==='restore')return restoreData(ctx,b);}
 if(route==='state'||route==='overview'){
  const overview=route==='overview';
  const s=await state(ctx,false,overview);return {materials:s.materials,chapters:s.chapters,questions:s.questions.map(publicQuestion),concepts:s.concepts,mistakes:s.mistakes.map(publicMistake),sessions:overview?s.sessions:s.sessions.map(solvePublic),studies:overview?s.studies:s.studies.map(publicStudy),bankStats:s.concepts.map((c:any)=>({conceptId:c.id,count:s.bank.filter((i:any)=>i.active&&i.conceptIds.includes(c.id)).length,modes:[...new Set(s.bank.filter((i:any)=>i.active&&i.conceptIds.includes(c.id)).flatMap((i:any)=>i.modes||[]))]}))};
 }
 if(route==='bank'){
  const s=learnState(await state(ctx,true));
  if(id==='study')return saveStudy(ctx,createBankStudy(b,s));
  if(id==='inspect')return s.bank.find((i:any)=>i.id===p[2])||Promise.reject(new AppError('문항을 찾을 수 없습니다.',404));
  if(id==='review'){
   if(!Array.isArray(b.ids)||!b.ids.length||b.ids.length>1000)throw new AppError('검토한 문항을 선택하세요.');
   for(const qid of [...new Set<string>(b.ids)]){const q=await row(ctx,'concept_questions',qid);const result=await ctx.admin.from('concept_questions').update({review_status:'approved',data:{...q.data,active:true,reviewStatus:'approved',reviewedAt:now(),reviewedBy:ctx.user.id}}).eq('id',qid).eq('user_id',ctx.user.id);if(result.error)throw new AppError('검토 결과를 저장하지 못했습니다.');}return {reviewed:b.ids.length};
  }
  if(id==='list')return {items:s.bank.map((i:any)=>{const {answer,explanation,acceptedAnswers,choiceFeedback,correction,standardQuestion,...safe}=i;return {...safe,relatedQuestionIds:relatedOriginalIds(i,s.questions)}}),originals:s.questions.map((q:any)=>({id:q.id,conceptIds:q.conceptIds})),concepts:s.concepts,chapters:s.chapters,materials:s.materials,results:s.results};
 }
 if(route==='chapters'&&method==='PATCH'){
  const c=await row(ctx,'document_chapters',id),doc=await row(ctx,'documents',c.document_id);if(!b.title?.trim()||!Number.isInteger(b.startPage)||!Number.isInteger(b.endPage)||b.startPage<1||b.endPage<b.startPage||b.endPage>doc.data.pageCount)throw new AppError('단원 이름과 실제 PDF 페이지 범위를 확인하세요.');
  const {error}=await ctx.admin.from('document_chapters').update({title:b.title.trim().slice(0,300),start_page:b.startPage,end_page:b.endPage,data:{...c.data,userEdited:true}}).eq('id',id).eq('user_id',ctx.user.id);if(error)throw new AppError('목차를 저장하지 못했습니다.');return {saved:true};
 }
 if(route==='materials'&&id){
  const r=await row(ctx,'documents',id);
  if(action==='outline'&&method==='POST')return saveOutline(ctx,id,b);
  if(action==='index'&&method==='GET')return documentIndex(ctx,id);
  if(action==='metadata'&&method==='GET')return {material:material(r)};
  if(action==='pages'&&method==='GET'){
   const pages=await pageRows(ctx,id);
   return {material:material(r),pages:pages.map(pg=>({...pg.data,number:pg.number,materialId:pg.document_id,imagePath:pg.image_path}))};
  }
  if(method==='DELETE'){await put(ctx,'documents',id,{...r.data,archived:true},{title:r.title,subject:r.subject,kind:r.kind,status:r.status,content_hash:r.content_hash});return {archived:true};}
  if(action==='page-kind'){
   if(!['content','answers','uncertain'].includes(b.kind)||['processing','uploaded'].includes(r.status))throw new AppError('사전 처리 완료 후 페이지 종류를 변경하세요.');
   const [page]=await rows(ctx,'document_pages',{document_id:id,number:b.page});if(!page)throw new AppError('페이지를 찾을 수 없습니다.');
   const {error}=await ctx.db.from('document_pages').update({data:{...page.data,kind:b.kind,manualKind:true}}).eq('id',page.id).eq('user_id',ctx.user.id);if(error)throw new AppError('페이지 종류를 저장하지 못했습니다.');return {ok:true};
  }
  const [s,pages]=await Promise.all([state(ctx),pageRows(ctx,id,undefined,true)]);return {material:material(r),pages:pages.map(pg=>({...pg.data,number:pg.number,materialId:pg.document_id,imagePath:pg.image_path})),questions:s.questions.filter((q:any)=>q.materialId===id&&!q.mergedInto).map(publicQuestion)};
 }
 if(route==='content'){
  const s=await state(ctx,true),pkg=content(s);
  if(action==='unused')throw new AppError('지원하지 않는 요청입니다.');
  if(id==='validate')return validate(ctx,b.package);
  if(id==='import')return importContent(ctx,b.package);
  if(id==='check'){const checked=await validate(ctx,pkg);return {...checked,package:undefined,warnings:[...checked.warnings,...s.questions.filter((q:any)=>!q.confirmed).map((q:any)=>`${q.number}번 원본 영역 확인 필요`),...s.questions.filter((q:any)=>!q.conceptIds.length).map((q:any)=>`${q.number}번 개념 미등록`),...s.bank.filter((i:any)=>!i.active).map((i:any)=>`${i.id} 문항 검토 필요`)],counts:{concepts:s.concepts.length,items:s.bank.length,mappings:s.questions.filter((q:any)=>q.conceptIds.length).length}};}
  if(id==='export'||id==='template'){const empty={schemaVersion:1,concepts:[],items:[],mappings:[],materials:pkg.materials};return {filename:id==='template'?'restudy-content-template.json':'restudy-content.json',mimeType:'application/json',content:JSON.stringify(id==='template'?empty:pkg,null,2)};}
  return {...pkg,issues:{errors:[],warnings:s.bank.some((i:any)=>!i.active)?['AI 생성 문항은 내용을 검토한 뒤 사용으로 저장하세요.']:[]},counts:{concepts:s.concepts.length,items:s.bank.length,mappings:s.questions.filter((q:any)=>q.conceptIds.length).length}};
 }
 if(route==='concepts'&&method==='PUT'){const result=await importContent(ctx,{concepts:[{...b,id,userEdited:true}],items:[],mappings:[]});if(!result.valid)throw new AppError(result.errors.join('\n'));return result;}
 if(route==='bank-items'&&method==='PUT'){const result=await importContent(ctx,{concepts:[],items:[{...b,id,userEdited:true}],mappings:[]});if(!result.valid)throw new AppError(result.errors.join('\n'));return result;}
 if(route==='bank-items'&&method==='DELETE'){const q=await row(ctx,'concept_questions',id);await put(ctx,'concept_questions',id,{...q.data,active:false,archived:true},{concept_id:q.concept_id,type:q.type,difficulty:q.difficulty,review_status:'archived'});return {archived:true};}
 if(route==='questions'&&action==='mapping'&&method==='PATCH')return importContent(ctx,{concepts:[],items:[],mappings:[{questionId:id,...b}]});
 if(route==='questions'&&action==='review'&&method==='GET'){
  const s=learnState(await state(ctx,true,false,[id]));
  const q=s.questions.find((q:any)=>q.id===id);
  if(!q)throw new AppError('원본 문항을 찾을 수 없습니다.',404);
  const record=s.mistakes.find((m:any)=>m.questionId===id);
  return {
   ...originalReview({...q,registeredAnswer:record?.registeredAnswer},s,await rows(ctx,'problem_similarities')),
   allowAutomaticAnalysis: record?.autoAnalyze !== false,
  };
 }
 if(route==='mistakes'){
  if((id==='archive'&&method==='POST')||(id&&method==='DELETE')){
   const ids:unknown=method==='DELETE'?[id]:b.ids;
   if(!Array.isArray(ids)||!ids.length||ids.some(value=>typeof value!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)))throw new AppError('제외할 오답을 선택하세요.');
   const {data,error}=await ctx.admin.rpc('archive_wrong_answers',{p_user_id:ctx.user.id,p_ids:[...new Set(ids)]});
   if(error)throw new AppError('오답을 제외하지 못했습니다. 다시 시도해 주세요.',500);
   if(method==='DELETE'&&!data?.length)throw new AppError('오답 기록을 찾을 수 없습니다.',404);
   return {archived:true,archivedIds:data};
  }
  const s=await state(ctx);
  if(id){const m=await row(ctx,'wrong_answers',id);return {mistake:{...value(m),questionId:m.problem_id,resolved:m.data.resolved??m.data.lastResult==='correct'},attempts:s.sessions.filter((ss:any)=>ss.answers?.[m.problem_id]).map((ss:any)=>({sessionId:ss.id,...ss.answers[m.problem_id],strokes:ss.drawings?.[m.problem_id]||[]}))};}
  if(method!=='POST')return s.mistakes.map(publicMistake);
  const selected:any[]=[],ambiguous:number[]=[],missing:number[]=[];
  if(b.questionIds!==undefined&&(!Array.isArray(b.questionIds)||b.questionIds.length>200||b.questionIds.some((id:unknown)=>typeof id!=='string')))throw new AppError('한 번에 원본 문항을 200개까지 등록할 수 있습니다.');
  for(const qid of b.questionIds||[]){const q=s.questions.find((q:any)=>q.id===qid);if(!q)throw new AppError('선택한 원본 문항을 찾을 수 없습니다.');selected.push(q)}
  for(const num of numbers(String(b.numbers||''),200)){const found=s.questions.filter((q:any)=>q.materialId===b.materialId&&q.number===num);if(found.length>1)ambiguous.push(num);else if(!found.length)missing.push(num);else selected.push(found[0]);}
  const unique=[...new Map(selected.map(q=>[q.id,q])).values()];
  const questionIds=unique.map(q=>q.id);
  const options=registrationOptions(b.reviewOptions,new Set(questionIds));
  const autoAnalyzeQuestionIds:string[]=[];
  let added=0;
  for(const q of unique){
   const exists=s.tables.wrong_answers.find((m:any)=>m.problem_id===q.id);
   const option=options.get(q.id);
   const changes={
    ...(option?.answer ? {registeredAnswer:option.answer} : {}),
    ...(option?.analyze !== undefined ? {autoAnalyze:option.analyze} : {}),
   };
   const active=exists&&!exists.data.archived&&!(exists.data.resolved??exists.data.lastResult==='correct');
   if(active){
    if(Object.keys(changes).length)await put(ctx,'wrong_answers',exists.id,{...exists.data,...changes},{problem_id:q.id});
   }else{
    const mid=exists?.id||uuid();
    const data={
     ...exists?.data,...changes,id:mid,questionId:q.id,
     autoAnalyze:option?.analyze??exists?.data.autoAnalyze??false,
     cause:String(b.cause||'').slice(0,500),createdAt:exists?.created_at||now(),
     dueAt:now(),reviewCount:exists?.data.reviewCount||0,correctCount:exists?.data.correctCount||0,
     streak:0,conceptState:q.conceptIds.length?'reviewing':'unregistered',
     archived:false,resolved:false,resolvedAt:null,
    };
    await put(ctx,'wrong_answers',mid,data,{problem_id:q.id});
    added++;
   }
   const missingAnalysis=!q.wrongReview&&!q.analysis&&!q.answer&&!q.explanation;
   if(option?.analyze&&(missingAnalysis||wrongReviewIssues(q.wrongReview).length))autoAnalyzeQuestionIds.push(q.id);
  }
  return {added,ambiguous,missing,unregistered:unique.filter(q=>!q.hasContent).length,questionIds,autoAnalyzeQuestionIds};
 }
 if(route==='lessons'){const s=learnState(await state(ctx,true));return saveStudy(ctx,createReview([b.questionId],s));}
 if(route==='study'){
  if(id==='weak'||id==='repeat'){const s=learnState(await state(ctx,true));try{const session=repeatWeak(s);return id==='weak'?{count:session.items.length}:saveStudy(ctx,session)}catch{if(id==='weak')return {count:0};throw new AppError('복습할 등록 문항이 없습니다.');}}
  if(id){if(action==='answer')return learningMutation(ctx,'study',id,b);if(action==='reveal')return learningMutation(ctx,'study',id,b,true);return publicStudy(value(await row(ctx,'study_sessions',id)));}
  return saveStudy(ctx,createStudy(b,learnState(await state(ctx,true))));
 }
 if(route==='solve'){
  if(!id){
   if(!Array.isArray(b.questionIds)||!b.questionIds.length||b.questionIds.length>200||b.questionIds.some((id:any)=>typeof id!=='string'))
    throw new AppError('1~200개의 문제를 선택해 주세요.');
   const s=learnState(await state(ctx,true,false,b.questionIds));
   const questions=b.questionIds.map((id:string)=>{
    const q=s.questions.find((item:any)=>item.id===id);
    if(!q?.imagePaths?.length)throw new AppError('저장된 원본 크롭이 있는 문항을 선택하세요.');
    const record=s.mistakes.find((m:any)=>m.questionId===id);
    return record?.registeredAnswer ? {...q,registeredAnswer:record.registeredAnswer} : q;
   });
   const session=createSolve(questions);
   await put(ctx,'solve_sessions',session.id,session);
   return solvePublic(session);
  }
  if(action==='answer'||action==='drawing')return learningMutation(ctx,'solve',id,{...b,drawingOnly:action==='drawing'});
  const ss=action==='answer-keys'||action==='answer-key'?await row(ctx,'solve_sessions',id,'id,questionSnapshots:data->questionSnapshots'):value(await row(ctx,'solve_sessions',id));
  if(action==='answer-keys'){
   // One owner-authorized read prepares the selected session's saved reviews.
   // It never reveals UI, grades an answer, or writes a learning record.
   const s=learnState(await state(ctx,true,false,[])),relations=await rows(ctx,'problem_similarities');
   const answerKeys=Object.fromEntries((ss.questionSnapshots??[]).map((q:any)=>{
    const review=originalReview(q,s,relations);
    return[q.id,{available:!!review.answer,answer:review.answer,explanation:review.explanation,review}];
   }));
   return{answerKeys};
  }
  if(action==='answer-key'){const q=ss.questionSnapshots.find((q:any)=>q.id===p[3]);if(!q)throw new AppError('이 풀이의 문항이 아닙니다.');const s=learnState(await state(ctx,true,false,[])),relations=await rows(ctx,'problem_similarities'),review=originalReview(q,s,relations);return {available:!!review.answer,answer:review.answer,explanation:review.explanation,review};}
  return solvePublic(ss);
 }
 throw new AppError('지원하지 않는 요청입니다.',404);
}
