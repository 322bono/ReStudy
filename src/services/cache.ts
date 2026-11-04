type Entry = {
  key: string;
  owner: string;
  value: unknown;
  bytes: number;
  usedAt: number;
  encoding?: 'blob-bytes-v1';
  mime?: string;
};
const LIMIT = 150 * 1024 * 1024;
let pending: Promise<IDBDatabase> | undefined;
function database() {
  if (typeof indexedDB === "undefined")
    return Promise.reject(new Error("IndexedDB unavailable"));
  return (pending ||= new Promise((resolve, reject) => {
    const request = indexedDB.open("restudy-private-cache-v1", 2);
    request.onupgradeneeded = ({ oldVersion }) => {
      const store = oldVersion === 0
        ? request.result.createObjectStore("entries", { keyPath: "key" })
        : request.transaction!.objectStore("entries");
      if (oldVersion === 0) store.createIndex("owner", "owner");
      else store.deleteIndex("usedAt");
      store.createIndex("eviction", ["usedAt", "bytes"]);
    };
    request.onblocked = () => reject(new Error("Cache upgrade is blocked"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        pending = undefined;
      };
      // A tab using the old schema may have blocked the first request.
      // Resume using the cache when the browser completes that upgrade.
      pending = Promise.resolve(db);
      resolve(db);
    };
    request.onerror = () => {
      pending = undefined;
      reject(request.error);
    };
  }));
}
const key = (owner: string, name: string) => `${owner}:${name}`;
export async function cacheGet<T>(
  owner: string,
  name: string,
): Promise<T | null> {
  try {
    const db = await database();
    const entry=await new Promise<Entry|null>((resolve, reject) => {
      const tx = db.transaction("entries", "readwrite"),
        store = tx.objectStore("entries"),
        request = store.get(key(owner, name));
      let result: Entry | null = null;
      request.onsuccess = () => {
        const entry = request.result as Entry | undefined;
        if (entry?.owner === owner) {
          result = entry;
          // Rewriting a legacy browser Blob handle can invalidate the handle
          // that is about to be consumed. Migrate only after reading its bytes.
          if(!(entry.value instanceof Blob))store.put({ ...entry, usedAt: Date.now() });
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    if(!entry)return null;
    if(entry.encoding==='blob-bytes-v1'){
      if(!(entry.value instanceof ArrayBuffer)||entry.value.byteLength!==entry.bytes){await cacheRemove(owner,name);return null;}
      return new Blob([entry.value],{type:entry.mime||''})as T;
    }
    if(entry.value instanceof Blob){
      try{
        const blob=new Blob([await entry.value.arrayBuffer()],{type:entry.value.type});
        await cachePut(owner,name,blob);
        return blob as T;
      }catch{
        await cacheRemove(owner,name);
        return null;
      }
    }
    return entry.value as T;
  } catch {
    return null;
  }
}
async function cacheRemove(owner:string,name:string){
 try{const db=await database();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('entries','readwrite');tx.objectStore('entries').delete(key(owner,name));tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}catch{/* Durable originals are separate from this disposable cache. */}
}
export async function cachePut(
  owner: string,
  name: string,
  value: unknown,
  canWrite = () => true,
) {
  try {
    const db = await database(),
      bytes =
        value instanceof Blob
          ? value.size
          : new TextEncoder().encode(JSON.stringify(value)).length;
    if (bytes > 50 * 1024 * 1024) return;
    // Keep durable bytes in IndexedDB, not OS-backed Blob references. This also
    // makes cache eviction safe while an exported/viewed Blob is still in use.
    const binary=value instanceof Blob;
    const stored=binary?await value.arrayBuffer():value;
    if (!canWrite()) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("entries", "readwrite"),
        store = tx.objectStore("entries");
      store.put({
        key: key(owner, name),
        owner,
        value:stored,
        ...(binary?{encoding:'blob-bytes-v1' as const,mime:(value as Blob).type}:{}),
        bytes,
        usedAt: Date.now(),
      } satisfies Entry);
      // Enumerate keys and sizes only. getAll() would clone every cached
      // PDF and image into memory for each crop written by the viewer.
      const entryKeys: [IDBValidKey, number][] = [];
      let total = 0;
      const request = store.index("eviction").openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const [, size] = cursor.key as [number, number];
          entryKeys.push([cursor.primaryKey, size]);
          total += size;
          cursor.continue();
          return;
        }
        for (const [entryKey, size] of entryKeys) {
          if (total <= LIMIT) break;
          store.delete(entryKey);
          total -= size;
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    /* Cache denial never discards the durable cloud data. */
  }
}
export async function clearOwnerCache(owner: string) {
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("entries", "readwrite"),
        store = tx.objectStore("entries"),
        req = store.index("owner").openCursor(IDBKeyRange.only(owner));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}
