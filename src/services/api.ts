import { currentUser, edgeCall } from "./supabase";
export async function cloudApi<T = any>(
  path: string,
  method = "GET",
  body?: any,
): Promise<T> {
  if (path === "materials" && method === "POST")
    return (await (await import("./documents")).uploadMaterials(body)) as T;
  const part = path.split("/");
  if(part[0]==='questions'&&['merge','split'].includes(part[2])&&method==='POST')return(await(await import('./documents')).editProblemGroup(part[1],part[2]as'merge'|'split',body))as T;
  if(part[0]==='materials'&&part[2]==='reindex'){
    await(await import('./documents')).resumeMaterial(part[1],false,{reindex:true});return{ok:true}as T;
  }
  if (part[0] === "materials" && part[2] === "retry") {
    await (await import("./documents")).resumeMaterial(part[1], body?.force === true,{retryPage:body?.page});
    return { ok: true } as T;
  }
  if (part[0] === "materials" && part[2] === "pause") {
    await (await import("./documents")).pauseMaterial(part[1]);
    return { ok: true } as T;
  }
  if (part[0] === "materials" && part[2] === "resume") {
    await (await import("./documents")).resumeMaterial(part[1]);
    return { ok: true } as T;
  }
  if (
    part[0] === "questions" &&
    (method === "POST" || method === "PATCH") &&
    part.length < 3
  )
    return (await (
      await import("./documents")
    ).saveQuestion(part[1], body)) as T;
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
  return edgeCall("app", { path, method, body });
}
const assetCache = new Map<string, { url: string; until: number }>();
const assetPending = new Map<string, Promise<string>>();
let assetGeneration = 0;
export async function assetUrl(path: string) {
  const generation = assetGeneration;
  const owner = (await currentUser()).id;
  const key = `${owner}:${path}`;
  const cached = assetCache.get(key);
  if (cached && cached.until > Date.now()) return cached.url;
  const pending = assetPending.get(key);
  if (pending) return pending;
  const loading = (async () => {
    const original = /^\/?(?:api\/)?materials\/([^/?]+)\/file$/.exec(path);
    const blob = original ? await (await import("./documents")).loadOriginalBlob(original[1]) : undefined;
    const result = blob ? undefined : await cloudApi<{ url: string }>("asset", "POST", { path });
    if (generation !== assetGeneration || (await currentUser()).id !== owner) throw new Error("로그인 상태가 변경되어 원본 열기를 중단했습니다.");
    const url = blob ? URL.createObjectURL(blob) : result!.url;
    if (cached?.url.startsWith("blob:")) URL.revokeObjectURL(cached.url);
    assetCache.set(key, { url, until: blob ? Infinity : Date.now() + 120000 });
    return url;
  })();
  assetPending.set(key, loading);
  try { return await loading; }
  finally { if (assetPending.get(key) === loading) assetPending.delete(key); }
}
export function clearAssetCache() {
  assetGeneration++;
  for (const { url } of assetCache.values()) if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  assetCache.clear();
  assetPending.clear();
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
        models: p.credentials ? [...new Map(p.credentials.flatMap((c:any)=>c.models||[]).map((m:any)=>[m.id,m])).values()] : (status.models || []).filter((m:any)=>m.provider===p.provider),
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
