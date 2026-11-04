import{afterEach,beforeEach,describe,it,expect,vi}from'vitest';

function cacheDatabase(initial:any){
 const entries=new Map<string,any>(initial?[[initial.key,initial]]:[]),writes:any[]=[];
 const db={transaction:()=>{const tx:any={};const finish=()=>queueMicrotask(()=>tx.oncomplete?.());const store={
  get:(key:string)=>{const req:any={};queueMicrotask(()=>{req.result=entries.get(key);req.onsuccess?.();finish()});return req;},
  put:(value:any)=>{writes.push(value);entries.set(value.key,value);finish();},
  delete:(key:string)=>{entries.delete(key);finish();},
  index:()=>({openKeyCursor:()=>{const req:any={},all=[...entries.values()].sort((a,b)=>a.usedAt-b.usedAt);let i=0;const advance=()=>queueMicrotask(()=>{const entry=all[i++];req.result=entry?{key:[entry.usedAt,entry.bytes],primaryKey:entry.key,continue:advance}:null;req.onsuccess?.();if(!entry)finish();});advance();return req;}}),
 };tx.objectStore=()=>store;return tx;}};
 vi.stubGlobal('indexedDB',{open:()=>{const req:any={result:db};queueMicrotask(()=>req.onsuccess?.());return req;}});
 return{entries,writes};
}
beforeEach(()=>vi.resetModules());afterEach(()=>vi.unstubAllGlobals());
describe('durable binary cache compatibility',()=>{
 it('evicts an unreadable legacy Blob and lets callers fetch the durable original again',async()=>{
  const blob=new Blob(['pdf']);vi.spyOn(blob,'arrayBuffer').mockRejectedValue(new DOMException('The object can not be found here.','NotFoundError'));
  const{entries}=cacheDatabase({key:'owner:pdf:d',owner:'owner',value:blob,bytes:3,usedAt:0});
  const{cacheGet}=await import('../src/services/cache');
  expect(await cacheGet('owner','pdf:d')).toBeNull();expect(entries.has('owner:pdf:d')).toBe(false);
 });
 it('stores bytes instead of a browser-managed Blob handle and recreates an independent Blob on every read',async()=>{
  const{entries}=cacheDatabase(null);const{cachePut,cacheGet}=await import('../src/services/cache');
  await cachePut('owner','pdf:d',new Blob(['%PDF-binary'],{type:'application/pdf'}));
  const saved=entries.get('owner:pdf:d');expect(saved.value).toBeInstanceOf(ArrayBuffer);expect(saved.encoding).toBe('blob-bytes-v1');
  const blob=await cacheGet<Blob>('owner','pdf:d');expect(blob).toBeInstanceOf(Blob);expect(await blob!.text()).toBe('%PDF-binary');expect(blob!.type).toBe('application/pdf');
  expect(await cacheGet('other-owner','pdf:d')).toBeNull();
 });
 it('materializes and migrates a readable legacy Blob without changing the caller contract',async()=>{
  const original=new Blob(['legacy'],{type:'application/pdf'});const{entries}=cacheDatabase({key:'owner:pdf:d',owner:'owner',value:original,bytes:6,usedAt:0});
  const{cacheGet}=await import('../src/services/cache');const result=await cacheGet<Blob>('owner','pdf:d');expect(result).not.toBe(original);expect(await result!.text()).toBe('legacy');expect(entries.get('owner:pdf:d').value).toBeInstanceOf(ArrayBuffer);
 });
});
