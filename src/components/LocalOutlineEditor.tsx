import {useEffect,useState}from'react';
import{Button}from'../../components/ui';
export default function LocalOutlineEditor({outline,pageCount,sourcePage,busy,onSave}:{outline:any;pageCount:number;sourcePage:number;busy:boolean;onSave:(value:any)=>Promise<void>}){
 const serialized=JSON.stringify(outline??{entries:[]}),[entries,setEntries]=useState<any[]>([]),[offset,setOffset]=useState('');
 useEffect(()=>{const value=JSON.parse(serialized);setEntries(value.entries??[]);setOffset(typeof value.printedPageOffset==='number'?String(value.printedPageOffset):'');},[serialized]);
 const update=(id:string,changes:any)=>setEntries(all=>all.map(e=>e.id===id?{...e,...changes}:e));
 const applyOffset=()=>{const value=Number(offset);if(offset===''||!Number.isInteger(value))return;setEntries(all=>all.map((e,i)=>{const start=e.printedPage-value,next=all.slice(i+1).find(n=>n.level<=e.level&&n.printedPage>e.printedPage);return{...e,pdfPage:start>=1&&start<=pageCount?start:null,endPage:next?next.printedPage-value-1:pageCount};}));};
 const valid=entries.length>0&&entries.every(e=>e.title?.trim()&&Number.isInteger(e.pdfPage)&&Number.isInteger(e.endPage)&&e.pdfPage>=1&&e.endPage>=e.pdfPage&&e.endPage<=pageCount);
 return <details className="panel" style={{padding:16,marginBottom:16}}><summary>자체 목차 인식·편집 · {entries.length}개 항목</summary>
  <p className="field-help">목차 페이지의 글자와 좌표에서 읽은 후보입니다. 인쇄 쪽수와 실제 PDF 쪽수를 확인해 저장하세요.</p>
  {!!entries.length&&<div className="row"><label>인쇄 쪽수 − PDF 쪽수<input aria-label="인쇄와 PDF 쪽수 차이" type="number" value={offset} onChange={e=>setOffset(e.target.value)} placeholder="예: 인쇄 10쪽 = PDF 13쪽이면 -3"/></label><Button variant="secondary" disabled={busy||offset===''} onClick={applyOffset}>쪽수 대응 적용</Button></div>}
  {entries.map(e=><div key={e.id} className="form-grid" style={{borderTop:'1px solid #e8ebf1',paddingTop:12,marginTop:12}}>
   <label>단원 이름<input aria-label={`목차 ${e.id} 이름`} value={e.title} maxLength={300} onChange={event=>update(e.id,{title:event.target.value})}/></label>
   <label>계층<select aria-label={`목차 ${e.id} 계층`} value={e.level} onChange={event=>update(e.id,{level:Number(event.target.value)})}><option value={1}>대단원</option><option value={2}>중단원</option><option value={3}>소단원</option></select></label>
   <label>시작 PDF 쪽<input aria-label={`목차 ${e.id} 시작 PDF 쪽`} type="number" min={1} max={pageCount} value={e.pdfPage??''} onChange={event=>update(e.id,{pdfPage:event.target.value===''?null:Number(event.target.value)})}/></label>
   <label>마지막 PDF 쪽<input aria-label={`목차 ${e.id} 마지막 PDF 쪽`} type="number" min={1} max={pageCount} value={e.endPage??''} onChange={event=>update(e.id,{endPage:event.target.value===''?null:Number(event.target.value)})}/></label>
   <small>출처 PDF {e.sourcePage}쪽{e.printedPage?` · 목차에 적힌 쪽수 ${e.printedPage}`:''}</small>
  </div>)}
  <div className="row" style={{marginTop:16}}><Button variant="secondary" disabled={busy||entries.length>=1000} onClick={()=>setEntries(all=>[...all,{id:`manual:${crypto.randomUUID()}`,title:'',level:1,parentId:null,printedPage:1,pdfPage:1,endPage:pageCount,sourcePage,bbox:[0,0,1,1],confidence:1,needsReview:false}])}>목차 항목 추가</Button><Button busy={busy} disabled={busy||!valid} onClick={async()=>{const stack:any[]=[];const data=entries.map(e=>{while(stack.length&&stack.at(-1).level>=e.level)stack.pop();const result={...e,parentId:stack.at(-1)?.id??null};stack.push(result);return result;});await onSave({schema_version:'re.pdf-outline.v1',entries:data,printedPageOffset:offset===''?null:Number(offset),source:'local_rules'});}}>확인한 목차 저장</Button></div>
 </details>;
}
