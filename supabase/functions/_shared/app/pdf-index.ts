import{AppError}from'../context.ts';
import{row,rows,type Ctx}from'./repository.ts';
export async function saveOutline(ctx:Ctx,id:string,body:any){
 const doc=await row(ctx,'documents',id),raw=body.outline;
 if(!raw||raw.schema_version!=='re.pdf-outline.v1'||!Array.isArray(raw.entries)||raw.entries.length>1000)throw new AppError('목차 형식을 확인하세요.');
 const ids=new Set<string>();const entries=raw.entries.map((e:any)=>{
  if(!e||typeof e.id!=='string'||e.id.length<1||e.id.length>100||ids.has(e.id)||typeof e.title!=='string'||!e.title.trim()||e.title.length>300||!Number.isInteger(e.level)||e.level<1||e.level>3||!Number.isInteger(e.sourcePage)||e.sourcePage<1||e.sourcePage>doc.data.pageCount||!Array.isArray(e.bbox)||e.bbox.length!==4||e.bbox.some((n:any)=>!Number.isFinite(n)||n<0||n>1))throw new AppError('목차의 이름·위치·계층을 확인하세요.');
  ids.add(e.id);const start=e.pdfPage,end=e.endPage;
  if(start!==null&&(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>doc.data.pageCount))throw new AppError('목차의 실제 PDF 페이지 범위를 확인하세요.');
  const title=e.title.trim();return{id:e.id,title,level:e.level,parentId:typeof e.parentId==='string'?e.parentId:null,printedPage:Number.isInteger(e.printedPage)?e.printedPage:null,pdfPage:start,endPage:end,sourcePage:e.sourcePage,bbox:e.bbox,confidence:Math.max(0,Math.min(1,Number(e.confidence)||0)),needsReview:true,canonicalKey:`${title}|${start}|${end}`.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ')};
 });
 if(entries.some((e:any)=>e.parentId!==null&&!ids.has(e.parentId)))throw new AppError('목차의 상위 항목을 확인하세요.');
 const outline={schema_version:'re.pdf-outline.v1',entries,source:'local_rules',printedPageOffset:Number.isInteger(raw.printedPageOffset)?raw.printedPageOffset:null,needsReview:body.manual!==true,manual:body.manual===true};
 const {data,error}=await ctx.admin.rpc('save_local_pdf_outline',{p_user_id:ctx.user.id,p_document:id,p_outline:outline,p_token:typeof body.processingToken==='string'?body.processingToken:null});
 if(error)throw new AppError('목차 저장 중 원본이나 분석 상태가 변경됐습니다. 다시 불러와 주세요.',409);return data;
}
export async function documentIndex(ctx:Ctx,id:string){
 const doc=await row(ctx,'documents',id),pages=(await rows(ctx,'document_pages')).filter((p:any)=>p.document_id===id),problems=(await rows(ctx,'problems')).filter((p:any)=>p.document_id===id&&!p.data.autoRetired&&!p.data.mergedInto),regions=await rows(ctx,'problem_regions');
 return{schema_version:'re.pdf-index.v1',document_id:id,outline:doc.data.localOutline??null,pages:pages.map((p:any)=>({...p.data.ocrIndex,document_id:id,pdf_page:p.number,problems:problems.filter((q:any)=>q.page===p.number).map((q:any)=>({id:q.id,q_number:String(q.number),chapter_id:q.data.chapterId??null,regions:regions.filter((r:any)=>r.problem_id===q.id).map((r:any)=>({page:r.page,bbox:[r.data.x,r.data.y,r.data.x+r.data.w,r.data.y+r.data.h]})),confidence:q.data.confidence??0,needs_review:!q.data.confirmed}))}))};
}
