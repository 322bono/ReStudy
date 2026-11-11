import{describe,it,expect}from'vitest';
import{studyInventory}from'../src/domain/study-inventory';
describe('stored study inventory',()=>{
 it('distinguishes existing pending content from missing content and counts multi-concept items only once',()=>{
  const a={id:'a',active:true,type:'OX',difficulty:'기본',modes:['quiz'],conceptIds:['c1','c2'],sources:[{materialId:'d',page:3},{materialId:'d2',page:8}]};
  const b={...a,id:'b',active:false,reviewStatus:'needs_review'};
  const items=[a,a,b,{...b,id:'archived',archived:true},{...a,id:'card',modes:['memory']}];
  expect(studyInventory(items,{materials:[{id:'d',pages:[3]}],mode:'quiz',type:'전체',difficulty:'전체'})).toEqual({available:1,completed:0,pending:1,stored:2});
  expect(studyInventory(items,{materials:[{id:'d',pages:[2]}],mode:'quiz'})).toEqual({available:0,completed:0,pending:0,stored:0});
  expect(studyInventory(items.map(item=>({...item,attempted:true})),{materials:[{id:'d',pages:[3]}],mode:'quiz'})).toMatchObject({available:0,completed:1});
  expect(studyInventory(items,{materials:[{id:'d',pages:[3]}],mode:'memory'}).available).toBe(1);
 });
});
