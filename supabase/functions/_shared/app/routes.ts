import {AppError} from '../context.ts';
import {material,publicQuestion,put,row,rows,signed,state,value,type Ctx} from './repository.ts';
import {importContent,validate} from './content.ts';
import {exportData,restoreData} from './backup.ts';
import{saveOutline,documentIndex}from'./pdf-index.ts';
import {answerSolve,answerStudy,createBankStudy,createReview,createSolve,createStudy,publicStudy,repeatWeak,revealStudy,relatedOriginalIds,originalReview} from '../../../../src/domain/learning.ts';

const now=()=>new Date().toISOString(),uuid=()=>crypto.randomUUID();
function numbers(text:string,max=1000){if(!text?.trim())return [];const out:number[]=[];for(const part of text.trim().split(/[\s,]+/)){const m=part.match(/^(\d{1,5})(?:[-~](\d{1,5}))?$/);if(!m)throw new AppError('번호 또는 범위를 확인하세요.');const a=+m[1],b=+(m[2]||m[1]);if(a<1||b<a||b-a>=max)throw new AppError('번호 범위를 확인하세요.');for(let n=a;n<=b;n++)out.push(n);if(out.length>max)throw new AppError('선택한 번호가 너무 많습니다.')}return [...new Set(out)];}
const content=(s:any)=>({schemaVersion:1,concepts:s.concepts,items:s.bank,mappings:s.questions.map((q:any)=>({questionId:q.id,materialId:q.materialId,number:q.number,page:q.page,conceptIds:q.conceptIds,answer:q.answer||'',explanation:q.explanation||''})),materials:s.materials.map((m:any)=>({id:m.id,title:m.title,hash:m.hash}))});
const solvePublic=(s:any)=>{const {questionSnapshots,...safe}=s;return {...safe,questions:(questionSnapshots||s.questions||[]).map(publicQuestion)}};
const learnState=(s:any)=>({...s,questions:s.questions.filter((q:any)=>q.regions.every((r:any)=>s.pages.find((p:any)=>p.materialId===q.materialId&&p.number===r.page)?.kind!=='answers'))});
async function saveStudy(ctx:Ctx,session:any){await put(ctx,'study_sessions',session.id,session);return publicStudy(session)}
async function learningMutation(ctx:Ctx,kind:'study'|'solve',id:string,body:any,reveal=false){
 for(let attempt=0;attempt<4;attempt++){
  const r=await row(ctx,kind==='study'?'study_sessions':'solve_sessions',id),current=value(r),s=learnState(await state(ctx,true));
  const result:any=kind==='solve'?answerSolve(current,body,s):reveal?{...revealStudy(current,body.itemId),mistakes:[]}:answerStudy(current,body,s);
  const {data,error}=await ctx.admin.rpc('save_learning_session',{p_user_id:ctx.user.id,p_kind:kind,p_id:id,p_version:current.version||0,p_data:result.session,p_attempt:result.attempt||null,p_mistakes:result.mistakes||[]});
  if(error)throw new AppError('학습 기록을 저장하지 못했습니다. 다시 시도하세요.',500);
  if(data)return reveal?{answer:result.answer,explanation:result.explanation,session:publicStudy(data)}:kind==='solve'?solvePublic(data):publicStudy(data);
 }
 throw new AppError('다른 화면에서 기록이 변경됐습니다. 다시 열어 주세요.',409);
}
async function asset(ctx:Ctx,path:string){
 const p=path.replace(/^\/api\//,'').split('?')[0].split('/'),query=new URLSearchParams(path.split('?')[1]||'');let storagePath='';
 if(p[0]==='materials'){
  const m=await row(ctx,'documents',p[1]);if(p[2]==='file')storagePath=m.data.originalPath;
  else if(p[2]==='page'){const pages=await rows(ctx,'document_pages');const page=pages.find((r:any)=>r.document_id===m.id&&r.number===Number(p[3]));if(!page)throw new AppError('페이지를 찾을 수 없습니다.',404);storagePath=page.image_path;}
 }else if(p[0]==='questions'&&p[2]==='image'){
  const q=await row(ctx,'problems',p[1]);const pages=await rows(ctx,'document_pages');
  let data=q.data,paths:string[]=[];const sessionId=query.get('session');
  if(sessionId){const session=value(await row(ctx,'solve_sessions',sessionId)),snapshot=session.questionSnapshots?.find((q:any)=>q.id===p[1]);if(!snapshot)throw new AppError('이 풀이의 원본 문항이 아닙니다.',403);data=snapshot;paths=snapshot.imagePaths||[];}
  else paths=(await rows(ctx,'problem_regions')).filter((r:any)=>r.problem_id===q.id).sort((a:any,b:any)=>a.part-b.part).map((r:any)=>r.image_path);
  const region=data.regions?.[Number(p[3])];if(!region||pages.find((r:any)=>r.document_id===q.document_id&&r.number===region.page)?.data.kind==='answers')throw new AppError('정답·해설 페이지는 문제로 제공하지 않습니다.',409);
  storagePath=paths[Number(p[3])];
 }
 if(!storagePath)throw new AppError('준비된 원본 이미지가 없습니다.',404);return {url:await signed(ctx,storagePath)};
}
export async function handle(ctx:Ctx,input:any):Promise<any>{
 const path=String(input.path||'').replace(/^\//,''),method=String(input.method||'GET').toUpperCase(),b=input.body||{},url=new URL('https://app.invalid/'+path),p=url.pathname.slice(1).split('/'),route=p[0],id=p[1],action=p[2];
 if(route==='asset')return asset(ctx,String(b.path||url.searchParams.get('path')||''));
 if(route==='data'&&method==='POST'){if(id==='export')return exportData(ctx,b);if(id==='restore')return restoreData(ctx,b);}
 if(route==='state'){
  const s=await state(ctx);return {materials:s.materials,chapters:s.chapters,questions:s.questions.map(publicQuestion),concepts:s.concepts,mistakes:s.mistakes,sessions:s.sessions.map(solvePublic),studies:s.studies.map(publicStudy),bankStats:s.concepts.map((c:any)=>({conceptId:c.id,count:s.bank.filter((i:any)=>i.active&&i.conceptIds.includes(c.id)).length,modes:[...new Set(s.bank.filter((i:any)=>i.active&&i.conceptIds.includes(c.id)).flatMap((i:any)=>i.modes||[]))]}))};
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
  if(method==='DELETE'){await put(ctx,'documents',id,{...r.data,archived:true},{title:r.title,subject:r.subject,kind:r.kind,status:r.status,content_hash:r.content_hash});return {archived:true};}
  if(action==='page-kind'){
   if(!['content','answers','uncertain'].includes(b.kind)||['processing','uploaded'].includes(r.status))throw new AppError('사전 처리 완료 후 페이지 종류를 변경하세요.');
   const pages=await rows(ctx,'document_pages'),page=pages.find((pg:any)=>pg.document_id===id&&pg.number===b.page);if(!page)throw new AppError('페이지를 찾을 수 없습니다.');
   const {error}=await ctx.db.from('document_pages').update({data:{...page.data,kind:b.kind,manualKind:true}}).eq('id',page.id).eq('user_id',ctx.user.id);if(error)throw new AppError('페이지 종류를 저장하지 못했습니다.');return {ok:true};
  }
  const s=await state(ctx,true);return {material:material(r),pages:s.pages.filter((pg:any)=>pg.materialId===id),questions:s.questions.filter((q:any)=>q.materialId===id&&!q.mergedInto).map(publicQuestion)};
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
 if(route==='mistakes'){
  const s=await state(ctx,true);
  if(id){const m=await row(ctx,'wrong_answers',id);if(method==='DELETE'){await put(ctx,'wrong_answers',id,{...m.data,archived:true},{problem_id:m.problem_id});return {archived:true};}return {mistake:{...value(m),questionId:m.problem_id},attempts:s.sessions.filter((ss:any)=>ss.answers?.[m.problem_id]).map((ss:any)=>({sessionId:ss.id,...ss.answers[m.problem_id],strokes:ss.drawings?.[m.problem_id]||[]}))};}
  if(method!=='POST')return s.mistakes;
  const selected:any[]=[],ambiguous:number[]=[],missing:number[]=[];
  for(const qid of b.questionIds||[]){const q=s.questions.find((q:any)=>q.id===qid);if(!q)throw new AppError('선택한 원본 문항을 찾을 수 없습니다.');selected.push(q)}
  for(const num of numbers(String(b.numbers||''),200)){const found=s.questions.filter((q:any)=>q.materialId===b.materialId&&q.number===num);if(found.length>1)ambiguous.push(num);else if(!found.length)missing.push(num);else selected.push(found[0]);}
  let added=0;const unique=[...new Map(selected.map(q=>[q.id,q])).values()];
  for(const q of unique){const exists=s.tables.wrong_answers.find((m:any)=>m.problem_id===q.id);if(exists&&!exists.data.archived)continue;const mid=exists?.id||uuid(),data={...(exists?.data||{}),id:mid,questionId:q.id,cause:String(b.cause||'').slice(0,500),createdAt:exists?.created_at||now(),dueAt:now(),reviewCount:exists?.data.reviewCount||0,correctCount:exists?.data.correctCount||0,streak:0,conceptState:q.conceptIds.length?'reviewing':'unregistered',archived:false};await put(ctx,'wrong_answers',mid,data,{problem_id:q.id});added++;}
  const ready=unique.filter(q=>q.hasContent&&q.confirmed),unregistered=unique.length-ready.length;let reviewSessionId;
  if(ready.length){const session=createReview(ready.map(q=>q.id),learnState(s));await saveStudy(ctx,session);reviewSessionId=session.id;}
  return {added,ambiguous,missing,unregistered,reviewSessionId};
 }
 if(route==='lessons'){const s=learnState(await state(ctx,true));return saveStudy(ctx,createReview([b.questionId],s));}
 if(route==='study'){
  if(id==='weak'||id==='repeat'){const s=learnState(await state(ctx,true));try{const session=repeatWeak(s);return id==='weak'?{count:session.items.length}:saveStudy(ctx,session)}catch{if(id==='weak')return {count:0};throw new AppError('복습할 등록 문항이 없습니다.');}}
  if(id){if(action==='answer')return learningMutation(ctx,'study',id,b);if(action==='reveal')return learningMutation(ctx,'study',id,b,true);return publicStudy(value(await row(ctx,'study_sessions',id)));}
  return saveStudy(ctx,createStudy(b,learnState(await state(ctx,true))));
 }
 if(route==='solve'){
  if(!id){const s=learnState(await state(ctx,true)),qs=(b.questionIds||[]).map((id:string)=>s.questions.find((q:any)=>q.id===id));if(!qs.length||qs.some((q:any)=>!q||!q.imagePaths?.length))throw new AppError('저장된 원본 크롭이 있는 문항을 선택하세요.');const session=createSolve(qs);await put(ctx,'solve_sessions',session.id,session);return solvePublic(session);}
  const ss=value(await row(ctx,'solve_sessions',id));
  if(action==='answer-key'){const q=ss.questionSnapshots.find((q:any)=>q.id===p[3]);if(!q)throw new AppError('이 풀이의 문항이 아닙니다.');const s=learnState(await state(ctx,true)),relations=await rows(ctx,'problem_similarities');return {available:!!q.answer,answer:q.answer||'',explanation:q.explanation||'',review:originalReview(q,s,relations)};}
  if(action==='answer'||action==='drawing')return learningMutation(ctx,'solve',id,{...b,drawingOnly:action==='drawing'});
  return solvePublic(ss);
 }
 throw new AppError('지원하지 않는 요청입니다.',404);
}
