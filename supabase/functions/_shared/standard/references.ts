import {rows,type Ctx}from'../app/repository.ts';
import type{StandardJob,RestudyPackage}from'../../../../src/domain/restudy.ts';
import type{ConceptBindings}from'../../../../src/domain/restudy-compile.ts';

/** Native IDs and canonical keys survive the restudy.v1 import boundary. */
export async function bankReferences(ctx:Ctx,job:StandardJob){
 const chapters=(await rows(ctx,'document_chapters')).filter((c:any)=>c.document_id===job.documentId&&job.selectedPages.some(p=>p>=c.start_page&&p<=c.end_page));
 const chapterIds=new Set(chapters.map((c:any)=>c.id)),links=(await rows(ctx,'chapter_concepts')).filter((l:any)=>chapterIds.has(l.chapter_id));
 const concepts:RestudyPackage['concepts']=[],bindings:ConceptBindings={};
 for(const c of await rows(ctx,'concepts')){
  const link=links.find((l:any)=>l.concept_id===c.id);if(!link)continue;
  concepts.push({id:c.id,chapter_id:link.chapter_id,name:c.name,summary:c.data.definition??'',formulas:c.data.formulas??[],memorize:c.data.memorize??[],pitfalls:c.data.pitfalls??[]});
  bindings[c.id]={key:c.canonical_key,subject:c.subject,major:c.major,minor:c.minor??''};
 }
 return{chapters:chapters.map((c:any)=>({id:c.id,title:c.title,start_page:c.start_page,end_page:c.end_page})),concepts,bindings};
}
