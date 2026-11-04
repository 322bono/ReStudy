import { edgeCall, getSupabase } from "./supabase";
import type { Material } from "../../lib/types";

type MaterialProgress = Pick<Material, "id" | "status" | "paused" | "progress" | "message" | "error" | "failedPage" | "completedPages">;

export async function materialProgress(ids: string[], signal: AbortSignal): Promise<MaterialProgress[]> {
  const db = getSupabase();
  const { data: { session } } = await db.auth.getSession();
  if (!session) throw new Error("다시 로그인해 주세요.");
  const { data, error } = await db.from("documents")
    .select("id,status,paused:data->paused,progress:data->progress,message:data->>message,error:data->>error,failedPage:data->failedPage,completedPages:data->completedPages")
    .eq("user_id", session.user.id)
    .in("id", ids)
    .abortSignal(signal);
  if (error) throw new Error("자료 진행 상태를 읽지 못했습니다.");
  return data as MaterialProgress[];
}

export async function cloudApi<T = any>(
  path: string,
  method = "GET",
  body?: any,
): Promise<T> {
  if (path === "materials" && method === "POST")
    return (await (await import("./documents")).uploadMaterials(body)) as T;
  const part = path.split("/");
  if (
    part[0] === "questions" &&
    ["merge", "split"].includes(part[2]) &&
    method === "POST"
  ) {
    const result = await (
      await import("./documents")
    ).editProblemGroup(part[1], part[2] as "merge" | "split", body);
    invalidateAssetCache("questions/");
    return result as T;
  }
  if (part[0] === "materials" && part[2] === "reindex") {
    await (
      await import("./documents")
    ).resumeMaterial(part[1], false, { reindex: true });
    invalidateAssetCache();
    return { ok: true } as T;
  }
  if (part[0] === "materials" && part[2] === "retry") {
    await (
      await import("./documents")
    ).resumeMaterial(part[1], body?.force === true, { retryPage: body?.page });
    invalidateAssetCache();
    return { ok: true } as T;
  }
  if (part[0] === "materials" && part[2] === "pause") {
    await (await import("./documents")).pauseMaterial(part[1]);
    return { ok: true } as T;
  }
  if (part[0] === "materials" && part[2] === "resume") {
    await (await import("./documents")).resumeMaterial(part[1]);
    invalidateAssetCache();
    return { ok: true } as T;
  }
  if (
    part[0] === "questions" &&
    (method === "POST" || method === "PATCH") &&
    part.length < 3
  ) {
    const result = await (
      await import("./documents")
    ).saveQuestion(part[1], body);
    invalidateAssetCache(part[1] ? `questions/${part[1]}/` : "questions/");
    return result as T;
  }
  if (path === "content/validate-file" || path === "content/import-file") {
    const file = body?.get("file");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".json"))
      throw new Error("JSON 콘텐츠 파일을 선택하세요.");
    let pkg;
    try {
      pkg = JSON.parse(await file.text());
    } catch {
      throw new Error("JSON 파일 형식을 확인하세요.");
    }
    return edgeCall("app", {
      path: path.includes("validate") ? "content/validate" : "content/import",
      method: "POST",
      body: { package: pkg },
    });
  }
  const result = await edgeCall("app", { path, method, body });
  if (
    method !== "GET" &&
    (["questions", "materials"].includes(part[0]) || path === "data/restore")
  )
    invalidateAssetCache();
  return result;
}

export type AssetLease = { url: string; release: () => void };
type AssetEntry = {
  key: string;
  path: string;
  url: string;
  until: number;
  bytes: number;
  users: number;
  retired: boolean;
};
const assetCache = new Map<string, AssetEntry>();
const retiredAssets = new Set<AssetEntry>();
const assetPending = new Map<string, Promise<AssetEntry>>();
const assetListeners = new Set<() => void>();
const watchedAssetClients = new WeakSet<object>();
const MAX_ASSET_BYTES = 64 * 1024 * 1024,
  MAX_ASSET_ENTRIES = 96;
let assetGeneration = 0;
let assetOwner: string | null | undefined;
const changedAsset = () =>
  new Error("로그인 상태나 원본이 변경되어 원본 열기를 중단했습니다.");
const normalizeAssetPath = (path: string) => path.replace(/^\/?(?:api\/)?/, "");
function revokeAsset(entry: AssetEntry) {
  if (entry.url.startsWith("blob:")) URL.revokeObjectURL(entry.url);
  retiredAssets.delete(entry);
}
function retireAsset(entry: AssetEntry, force = false) {
  if (assetCache.get(entry.key) === entry) assetCache.delete(entry.key);
  entry.retired = true;
  if (force || entry.users === 0) revokeAsset(entry);
  else retiredAssets.add(entry);
}
function notifyAssets() {
  for (const listener of assetListeners) listener();
}
/** Owner changes revoke private URLs; token refresh preserves live browser blobs. */
async function assetContext() {
  const db = getSupabase();
  if (!watchedAssetClients.has(db)) {
    watchedAssetClients.add(db);
    db.auth.onAuthStateChange((_event, session) => {
      const nextOwner = session?.user.id || null;
      if (assetOwner !== undefined && assetOwner !== nextOwner)
        clearAssetCache();
      assetOwner = nextOwner;
    });
  }
  const generation = assetGeneration;
  // Identity only partitions this memory cache. Authorization remains on the
  // private asset endpoint; getUser would add an HTTP round trip per image.
  const {
    data: { session },
    error,
  } = await db.auth.getSession();
  if (generation !== assetGeneration) throw changedAsset();
  if (error || !session?.user) throw new Error("다시 로그인해 주세요.");
  const owner = session.user.id;
  if (assetOwner !== undefined && assetOwner !== owner) clearAssetCache();
  assetOwner = owner;
  return { owner, generation: assetGeneration };
}
function pruneAssets(protectedEntry?: AssetEntry) {
  let bytes = [...assetCache.values()].reduce(
    (sum, entry) => sum + entry.bytes,
    0,
  );
  for (const entry of assetCache.values()) {
    if (bytes <= MAX_ASSET_BYTES && assetCache.size <= MAX_ASSET_ENTRIES) break;
    if (entry.users || entry === protectedEntry) continue;
    bytes -= entry.bytes;
    retireAsset(entry);
  }
}
function touchAsset(entry: AssetEntry) {
  assetCache.delete(entry.key);
  assetCache.set(entry.key, entry);
}
async function loadAsset(
  path: string,
  image: boolean,
  owner: string,
  generation: number,
): Promise<AssetEntry> {
  if (generation !== assetGeneration || assetOwner !== owner)
    throw changedAsset();
  const key = `${owner}:${image ? "image" : "url"}:${path}`;
  const cached = assetCache.get(key);
  if (cached && cached.until > Date.now()) {
    touchAsset(cached);
    return cached;
  }
  if (cached) retireAsset(cached);
  const pending = assetPending.get(key);
  if (pending) return pending;
  const loading = (async () => {
    let blob: Blob | undefined,
      signedUrl = "";
    if (image) {
      const signed = await loadAsset(path, false, owner, generation);
      const response = await fetch(signed.url);
      if (!response.ok)
        throw new Error("저장된 원본 이미지를 내려받지 못했습니다.");
      blob = await response.blob();
    } else {
      const original = /^materials\/([^/?]+)\/file$/.exec(path);
      if (original)
        blob = await (
          await import("./documents")
        ).loadOriginalBlob(original[1]);
      else
        signedUrl = (await cloudApi<{ url: string }>("asset", "POST", { path }))
          .url;
    }
    const current = await assetContext();
    if (generation !== assetGeneration || current.owner !== owner)
      throw changedAsset();
    const entry: AssetEntry = {
      key,
      path,
      url: blob ? URL.createObjectURL(blob) : signedUrl,
      until: blob ? Infinity : Date.now() + 120000,
      bytes: blob?.size || 0,
      users: 0,
      retired: false,
    };
    assetCache.set(key, entry);
    return entry;
  })();
  assetPending.set(key, loading);
  try {
    return await loading;
  } finally {
    if (assetPending.get(key) === loading) assetPending.delete(key);
  }
}
async function leaseAsset(
  path: string,
  image: boolean,
  ctx: { owner: string; generation: number },
): Promise<AssetLease> {
  let entry = await loadAsset(
    normalizeAssetPath(path),
    image,
    ctx.owner,
    ctx.generation,
  );
  while (entry.retired)
    entry = await loadAsset(
      normalizeAssetPath(path),
      image,
      ctx.owner,
      ctx.generation,
    );
  if (ctx.generation !== assetGeneration || ctx.owner !== assetOwner)
    throw changedAsset();
  entry.users++;
  touchAsset(entry);
  pruneAssets();
  let released = false;
  return {
    url: entry.url,
    release: () => {
      if (released) return;
      released = true;
      entry.users--;
      if (entry.retired && !entry.users) revokeAsset(entry);
      pruneAssets();
    },
  };
}
/** Components keep a lease so eviction never revokes an image still in use. */
export async function acquireImageAsset(path: string) {
  return leaseAsset(path, true, await assetContext());
}
export async function acquireAssetUrl(path: string) {
  return leaseAsset(path, false, await assetContext());
}
export async function assetUrl(path: string) {
  const ctx = await assetContext();
  const entry = await loadAsset(
    normalizeAssetPath(path),
    false,
    ctx.owner,
    ctx.generation,
  );
  if (ctx.generation !== assetGeneration) throw changedAsset();
  pruneAssets(entry);
  return entry.url;
}
/** Small, best-effort batches avoid downloading an entire workbook in advance. */
export async function prefetchImageAssets(paths: readonly string[]) {
  const queue = [...new Set(paths)].slice(0, 12);
  if (!queue.length) return;
  let ctx: Awaited<ReturnType<typeof assetContext>>;
  try {
    ctx = await assetContext();
  } catch {
    return;
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (next < queue.length && ctx.generation === assetGeneration) {
        const path = queue[next++];
        try {
          (await leaseAsset(path, true, ctx)).release();
        } catch {
          /* Opening the image offers its own retry/error. */
        }
      }
    }),
  );
}
export const assetCacheVersion = () => assetGeneration;
export function subscribeAssetCache(listener: () => void) {
  assetListeners.add(listener);
  return () => {
    assetListeners.delete(listener);
  };
}
/** Crop/page edits refresh matching URLs without revoking mounted snapshots. */
export function invalidateAssetCache(prefix = "") {
  assetGeneration++;
  const normalized = normalizeAssetPath(prefix);
  for (const entry of assetCache.values())
    if (entry.path.startsWith(normalized)) retireAsset(entry);
  assetPending.clear();
  notifyAssets();
}
export function clearAssetCache() {
  assetGeneration++;
  for (const entry of [...assetCache.values(), ...retiredAssets])
    retireAsset(entry, true);
  assetCache.clear();
  assetPending.clear();
  assetOwner = undefined;
  notifyAssets();
}
export async function download(path: string) {
  const file = await cloudApi<{
    filename: string;
    content: string;
    mimeType: string;
  }>(path);
  const url = URL.createObjectURL(
    new Blob([file.content], { type: file.mimeType }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function settingsTransport(action: string, payload: any = {}) {
  if (action === "settings") {
    const status = await edgeCall("ai-credentials", { action: "status" }),
      s = status.settings || {};
    return {
      ...status,
      providers: (status.providers || []).map((p: any) => ({
        ...p,
        models: p.credentials
          ? [
              ...new Map(
                p.credentials
                  .flatMap((c: any) => c.models || [])
                  .map((m: any) => [m.id, m]),
              ).values(),
            ]
          : (status.models || []).filter((m: any) => m.provider === p.provider),
      })),
      mode: s.mode || "round_robin",
      dailyLimit: s.daily_limit ?? 20,
      maxRetries: s.max_attempts ?? 3,
      allowPaid: s.allow_paid === true,
      modelRoles: s.modelRoles,
    };
  }
  if (action.startsWith("credential."))
    return edgeCall("ai-credentials", {
      ...payload,
      action: action.split(".")[1],
    });
  if (action === "settings.save")
    return edgeCall("ai-credentials", {
      action: "settings",
      settings: {
        mode: payload.mode,
        daily_limit: payload.dailyLimit,
        max_attempts: payload.maxRetries,
        allow_paid: payload.allowPaid === true,
        modelRoles: payload.modelRoles,
      },
      providers: payload.providers,
    });
  if (action === "job.resume")
    return edgeCall("ai-request", { action: "resume", jobId: payload.id });
  if (action === "account.password")
    return edgeCall("auth-helpers", { action: "password", ...payload });
  if (action === "data.export") return cloudApi("data/export", "POST", payload);
  if (action === "data.restore")
    return cloudApi("data/restore", "POST", payload);
  throw new Error("지원하지 않는 설정 작업입니다.");
}
