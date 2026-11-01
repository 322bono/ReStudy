type Region={page:number;x:number;y:number;w:number;h:number};
export function mergeRegions(a:Region[],b:Region[]):Region[]{
 const seen=new Set<string>();return[...a,...b].filter(r=>{const key=JSON.stringify(r);if(seen.has(key))return false;seen.add(key);return true;}).map(r=>({...r}));
}
export function splitRegions(regions:Region[],index:number,axis:'x'|'y',ratio:number,sharedCount=0){
 if(!Number.isInteger(index)||index<sharedCount||index>=regions.length||!['x','y'].includes(axis)||!Number.isFinite(ratio)||ratio<.1||ratio>.9)throw new Error('분리할 본문 영역과 10~90% 사이의 위치를 선택하세요.');
 const region=regions[index],first={...region},second={...region};
 if(axis==='y'){first.h=region.h*ratio;second.y=region.y+first.h;second.h=region.h-first.h;}else{first.w=region.w*ratio;second.x=region.x+first.w;second.w=region.w-first.w;}
 return{first:[...regions.slice(0,index),first],second:[...regions.slice(0,sharedCount),second,...regions.slice(index+1)]};
}
