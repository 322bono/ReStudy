type Scope={materials:{id:string,pages:number[]}[],mode:string,type?:string,difficulty?:string};
/** Count actual stored items once, including the separate review queue. */
export function studyInventory(items:any[],scope:Scope){
 const unique=[...new Map(items.map(item=>[item.id,item])).values()];
 const scoped=unique.filter(item=>!item.archived&&(item.modes??[]).includes(scope.mode)&&
  (!scope.type||scope.type==='전체'||scope.mode==='memory'||item.type===scope.type)&&
  (!scope.difficulty||scope.difficulty==='전체'||item.difficulty===scope.difficulty)&&
  (item.sources??[]).some((source:any)=>scope.materials.some(m=>m.id===source.materialId&&m.pages.includes(source.page))));
 return{available:scoped.filter(i=>i.active).length,pending:scoped.filter(i=>!i.active&&(i.reviewStatus??i.review_status)==='needs_review').length,stored:scoped.length};
}
