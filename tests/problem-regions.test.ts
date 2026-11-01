import{test,expect}from'vitest';
import{mergeRegions,splitRegions}from'../src/domain/problem-regions';
const shared={page:1,x:.1,y:.1,w:.8,h:.2},body={page:2,x:.1,y:.1,w:.8,h:.7};
test('merge keeps separate page crops and deduplicates a shared passage',()=>{
 expect(mergeRegions([shared,body],[shared,{...body,page:3}])).toEqual([shared,body,{...body,page:3}]);
});
test('split preserves shared passage in both questions and retains page geometry',()=>{
 const result=splitRegions([shared,body],1,'y',.5,1);
 expect(result.first).toEqual([shared,{...body,h:.35}]);expect(result.second[0]).toEqual(shared);expect(result.second[1].y).toBeCloseTo(.45);expect(result.second[1].h).toBeCloseTo(.35);
 expect(()=>splitRegions([shared,body],0,'y',.5,1)).toThrow();expect(()=>splitRegions([body],0,'x',1,0)).toThrow();
});
