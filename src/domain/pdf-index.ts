type Item={text:string;x:number;y:number;width:number;height:number;confidence?:number;fontSize?:number;fontName?:string};
type Page={number:number;width:number;height:number;source:string;items:Item[];words?:Item[];numberMarkers?:Item[];text:string;warnings:string[]};
export type OutlineEntry={id:string;title:string;level:number;parentId:string|null;printedPage:number;pdfPage:number|null;endPage:number|null;sourcePage:number;bbox:number[];confidence:number;needsReview:boolean};
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
const bbox=(i:Item)=>[clamp(i.x),clamp(i.y),clamp(i.x+i.width),clamp(i.y+i.height)];
export function pageOcrIndex(documentId:string,page:Page){
 const sizes=page.items.map(i=>i.height).sort((a,b)=>a-b),median=sizes[Math.floor(sizes.length/2)]??.02;
 const block=(i:Item,index:number,level:'line'|'word',source=page.source==='text'?'pdf_text':'ocr')=>({id:`p${page.number}-${level}-${index}`,text:i.text,bbox:bbox(i),confidence:source==='pdf_text'?1:clamp(i.confidence??0),confidence_kind:source==='pdf_text'?'source_text':'ocr_engine',source,level,...(i.fontName?{font_name:i.fontName}:{}),role:i.y>.91||i.y<.035?'margin_candidate':i.height>median*1.4&&!/^\d/.test(i.text)?'heading_candidate':'text'});
 return{schema_version:'re.pdf-index.v1',document_id:documentId,pdf_page:page.number,page_width:page.width,page_height:page.height,ocr_status:'completed',source:page.source==='text'?'pdf_text':'ocr',text_blocks:page.items.map((i,n)=>block(i,n,'line')),words:(page.words??[]).map((i,n)=>block(i,n,'word')),number_markers:(page.numberMarkers??[]).map((i,n)=>block(i,n,'line','ocr_number')),needs_review:page.warnings.length>0};
}
export function extractLocalOutline(pages:Page[],tocPages:number[],pageCount:number,offset:number|null|undefined){
 const entries:OutlineEntry[]=[];
 for(const page of pages.filter(p=>tocPages.includes(p.number))){
  const lines:Item[]=[];
  for(const item of [...page.items].sort((a,b)=>a.y-b.y||a.x-b.x)){
   const prior=lines.findLast(l=>Math.abs(l.y-item.y)<Math.max(.004,Math.min(l.height,item.height)*.5)&&item.x>=l.x+l.width-.002&&item.x-(l.x+l.width)<.18);
   if(prior){prior.text+=' '+item.text;prior.width=Math.max(prior.x+prior.width,item.x+item.width)-prior.x;prior.height=Math.max(prior.height,item.height);prior.confidence=Math.min(prior.confidence??1,item.confidence??1);}else lines.push({...item});
  }
  for(const line of lines){
   const match=/^(.+?)[\s.·ㆍ…⋯─\-]+(\d{1,4})\s*$/.exec(line.text.trim());if(!match)continue;
   const title=match[1].replace(/[.·ㆍ…⋯─\-\s]+$/g,'').trim(),printedPage=Number(match[2]);if(title.length<2||/^\d+$/.test(title)||printedPage<1)continue;
   const roman=/^(?:[Ⅰ-ⅫIVX]+[.．\s]|제\s*\d+\s*(?:부|단원))/.test(title),level=roman?1:/^\d+[.．\s]/.test(title)?2:Math.min(3,Math.max(1,1+Math.round((line.x-.1)/.04)));
   const physical=typeof offset==='number'?printedPage-offset:null,pdfPage=physical!==null&&physical>=1&&physical<=pageCount?physical:null;
   const parent=[...entries].reverse().find(e=>e.level<level);
   entries.push({id:`toc:${page.number}:${entries.length}`,title,level,parentId:parent?.id??null,printedPage,pdfPage,endPage:null,sourcePage:page.number,bbox:bbox(line),confidence:page.source==='text'?.85:Math.min(.75,line.confidence??0),needsReview:true});
  }
 }
 for(let i=0;i<entries.length;i++){const e=entries[i];if(e.pdfPage!==null){const next=entries.slice(i+1).find(n=>n.level<=e.level&&n.pdfPage!==null&&n.pdfPage>e.pdfPage!);e.endPage=next?next.pdfPage!-1:pageCount;}}
 return{schema_version:'re.pdf-outline.v1',entries,printedPageOffset:typeof offset==='number'?offset:null,source:'local_rules',needsReview:true};
}
