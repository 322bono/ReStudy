import { decryptKey, encode64, type Provider } from "./crypto.ts";
import { modelFor } from "./catalog.ts";
import { AiError, checked, loadProviders, readProfile, type AuthContext } from "./credentials.ts";
import { cacheKey, processJob, validId, validateRequest, type Job, type JobRequest, type JobStore } from "./jobs.ts";
import { providerState, sanitizeSettings, type Settings } from "./settings.ts";
import type { Json } from "./schemas.ts";
import type { RouterContext, TaskInput } from "./router.ts";
import {commitPart}from'../standard/service.ts';

const analysisVersion = "2026-11-01-v1";
type Prepared = { input: TaskInput; sourceMap: Json; source_versions: Json[]; conceptId?: string; documentId?: string; problemId?: string; mode?: string };
function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new AiError("source_text_missing");
  if (value.length > max) throw new AiError("source_text_too_large"); return value;
}
function version(table: string, row: Json): Json { return { table, id: row.id, updated_at: row.updated_at }; }
function safeSource(raw: any): {materialId: string; page: number} | null {
  return raw && validId(raw.materialId) && Number.isInteger(raw.page) && raw.page > 0 ? { materialId: raw.materialId, page: raw.page } : null;
}
async function documents(ctx: AuthContext, ids: string[]): Promise<Json[]> {
  if (!ids.length) return [];
  const rows = checked(await ctx.db.from("documents").select("id,subject,status,data,updated_at").eq("user_id", ctx.user.id).in("id", [...new Set(ids)]));
  if (rows.length !== new Set(ids).size) throw new AiError("source_not_found", 404); return rows;
}
function pageRange(value: string, pageCount: number): number[] {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 20000) throw new AiError("invalid_page_range");
  if (!value.trim()) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const pages = new Set<number>();
  for (const part of value.split(",")) {
    const match = /^\s*(\d+)\s*(?:[-~]\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new AiError("invalid_page_range");
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > pageCount) throw new AiError("invalid_page_range");
    for (let page = start; page <= end; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}
export async function prepareMaterialTasks(request: JobRequest, ctx: AuthContext, maxQuestions = 5): Promise<Prepared[]> {
  const selections = request.materials!;
  const docs = await documents(ctx, selections.map((material) => material.id));
  if (new Set(docs.map((doc) => doc.subject ?? doc.data?.subject)).size !== 1) throw new AiError("mixed_subjects");
  if (docs.some((doc) => !["ready", "needs_review"].includes(doc.status ?? doc.data?.status) || doc.data?.archived)) throw new AiError("material_not_ready");
  const selectedPages = selections.map((selection) => {
    const doc = docs.find((doc) => doc.id === selection.id)!;
    return { documentId: selection.id, numbers: pageRange(selection.pages, doc.data?.pageCount ?? doc.data?.page_count) };
  });
  if (selectedPages.reduce((sum, selection) => sum + selection.numbers.length, 0) > 60) throw new AiError("material_page_limit_exceeded");
  const fetched = await Promise.all(selectedPages.map(async (selection) => {
    const pages: Json[] = checked(await ctx.db.from("document_pages").select("id,document_id,number,data,updated_at").eq("user_id", ctx.user.id).eq("document_id", selection.documentId).in("number", selection.numbers));
    if (pages.length !== selection.numbers.length) throw new AiError("page_not_prepared");
    return pages.filter((page) => page.data?.kind !== "answers").map((page): Json => ({ ...page, text: boundedText(page.data?.text, 12000) }));
  }));
  // Interleave source files so a unit can genuinely combine multiple selected materials.
  const pages = fetched.flat().sort((a, b) => a.number - b.number || a.document_id.localeCompare(b.document_id));
  if (!pages.length) throw new AiError("source_text_missing");
  const chunks: Json[][] = []; for (let offset = 0; offset < pages.length; offset += 6) chunks.push(pages.slice(offset, offset + 6));
  const units = Math.max(chunks.length, Math.ceil(request.count! / maxQuestions));
  if (units > request.count!) throw new AiError("material_request_too_broad");
  return Array.from({ length: units }, (_, index) => {
    const chunk = chunks[index % chunks.length]; const sourceMap: Json = {};
    const count = Math.floor(request.count! / units) + (index < request.count! % units ? 1 : 0);
    const entries = chunk.map((page) => { sourceMap[page.id] = [{ materialId: page.document_id, page: page.number }]; return { source_id: page.id, material_id: page.document_id, page: page.number, text: page.text }; });
    const serialized = boundedText(JSON.stringify(entries), 40000);
    const sourceDocs = docs.filter((doc) => chunk.some((page) => page.document_id === doc.id));
    const input: TaskInput = { kind: "generate_material", sourceIds: chunk.map((page) => page.id), count, types: request.types, difficulty: request.difficulty, prompt: `과목: ${docs[0].subject ?? docs[0].data?.subject}. 선택한 자료의 원문만 바탕으로 개념을 중복 통합하고 정확히 ${count}개의 학습 콘텐츠를 만드세요. 같은 자료의 다른 범위나 답안 페이지를 인용하지 마세요. 학습 방식: ${request.mode}, 난이도: ${request.difficulty}, 허용 유형: ${request.types!.join(", ")}. source_citations는 실제 사용한 쪽의 source_id만 포함하세요. 모든 문제의 concept_key는 반환한 concepts의 정규화 subject|major|minor|name 키에 연결하세요. ${index + 1}/${units} 단위로 중복되지 않는 질문을 구성하세요. 인식이 불확실한 수식은 확정하지 마세요. 원문(JSON 데이터):\n${serialized}` };
    return { input, sourceMap, source_versions: [...sourceDocs.map((doc) => version("documents", doc)), ...chunk.map((page) => version("document_pages", page))], documentId: sourceDocs.length === 1 ? sourceDocs[0].id : undefined, mode: request.mode };
  });
}
export async function prepareTask(request: JobRequest, ctx: AuthContext): Promise<Prepared> {
  if (request.action === "analyze") {
    const rows: Json[] = checked(await ctx.db.from("problems").select("id,document_id,number,page,data,updated_at").eq("user_id", ctx.user.id).in("id", request.problemIds!));
    if (rows.length !== request.problemIds!.length) throw new AiError("source_not_found", 404);
    rows.sort((a, b) => a.id.localeCompare(b.id));
    const docs = await documents(ctx, rows.map((row) => row.document_id));
    const sourceMap: Json = {}; const entries: Json[] = []; const source_versions = [...rows.map((row) => version("problems", row)), ...docs.map((row) => version("documents", row))];
    const images: {mimeType: string; data: string}[] = []; let totalImageBytes = 0;
    for (const row of rows) {
      const doc = docs.find((doc) => doc.id === row.document_id)!;
      const text = typeof row.data?.text === "string" ? row.data.text : "";
      if (!text.trim() && !request.images) throw new AiError("source_text_missing");
      if (text.length > 12000) throw new AiError("source_text_too_large");
      sourceMap[row.id] = [{ materialId: row.document_id, page: row.page }];
      const entry: Json = { source_id: row.id, number: row.number, subject: doc.subject ?? doc.data?.subject ?? "미분류", unit: row.data?.unit ?? "", text, ocr_confidence: row.data?.confidence ?? null };
      entries.push(entry);
      if (request.images) {
        entry.image_indices = [];
        const regions: Json[] = checked(await ctx.db.from("problem_regions").select("image_path,page,part").eq("user_id", ctx.user.id).eq("problem_id", row.id).order("part"));
        if (!regions.length) throw new AiError("saved_crop_missing");
        for (const region of regions) {
          if (typeof region.image_path !== "string" || !region.image_path.startsWith(`${ctx.user.id}/`) || region.image_path.includes("..") || images.length >= 6) throw new AiError("invalid_saved_crop");
          const blob = checked(await ctx.admin.storage.from("study-files").download(region.image_path)) as Blob;
          if (!["image/png", "image/jpeg", "image/webp"].includes(blob.type) || blob.size > 1500000 || totalImageBytes + blob.size > 3000000) throw new AiError("saved_crop_too_large", 413);
          totalImageBytes += blob.size;
          entry.image_indices.push(images.length + 1);
          images.push({ mimeType: blob.type, data: encode64(new Uint8Array(await blob.arrayBuffer())) });
          sourceMap[row.id].push({ materialId: row.document_id, page: region.page });
        }
      }
    }
    return { input: { kind: "analyze_problem", sourceIds: rows.map((row) => row.id), prompt: `각 문제의 핵심/세부/선행 개념, 성립 조건과 오개념을 분석하세요. 불확실한 OCR은 추정으로 확정하지 마세요. 개념은 subject|major|minor|name 정규화 키로 중복 통합하고 원문에 없는 개념은 만들지 마세요. 각 입력 source_id마다 analyses 항목 하나를 반환하세요. 원문 자료(JSON 데이터):\n${JSON.stringify(entries)}`, ...(images.length ? { images } : {}) }, sourceMap, source_versions, documentId: new Set(rows.map((row) => row.document_id)).size === 1 ? rows[0].document_id : undefined, problemId: rows.length === 1 ? rows[0].id : undefined };
  }
  const concept = checked(await ctx.db.from("concepts").select("id,subject,major,minor,name,data,updated_at").eq("user_id", ctx.user.id).eq("id", request.conceptId).maybeSingle());
  if (!concept) throw new AiError("source_not_found", 404);
  const allSources = (Array.isArray(concept.data?.sources) ? concept.data.sources : []).map(safeSource).filter((source: any) => !!source) as {materialId: string; page: number}[];
  // Even when a client narrows the scope, validate every saved referenced document.
  const docs = await documents(ctx, [...new Set([...allSources.map((source) => source.materialId), ...(request.documentIds ?? [])])]);
  const sources = request.documentIds?.length ? allSources.filter((source) => request.documentIds!.includes(source.materialId)) : allSources;
  if (!sources.length) throw new AiError("source_citations_missing");
  const pageTexts: Json[] = [];
  const pageVersions: Json[] = [];
  for (const materialId of [...new Set(sources.map((source) => source.materialId))]) {
    const pages = sources.filter((source) => source.materialId === materialId).map((source) => source.page);
    const rows = checked(await ctx.db.from("document_pages").select("id,number,data,updated_at").eq("user_id", ctx.user.id).eq("document_id", materialId).in("number", [...new Set(pages)]).limit(10));
    for (const row of rows) if (typeof row.data?.text === "string" && row.data.text.trim()) { pageTexts.push({ materialId, page: row.number, text: row.data.text }); pageVersions.push(version("document_pages", row)); }
  }
  const source = { source_id: concept.id, subject: concept.subject, major: concept.major, minor: concept.minor, name: concept.name, definition: concept.data?.definition ?? "", properties: concept.data?.properties ?? [], misconceptions: concept.data?.misconceptions ?? [], excerpts: pageTexts };
  const serialized = boundedText(JSON.stringify(source), 40000);
  return { input: { kind: "generate_questions", sourceIds: [concept.id], count: request.count, difficulty: request.difficulty, types: request.types, prompt: `제공한 개념과 원문 범위에서 정확히 ${request.count}개 확인 문제를 만드세요. 난이도: ${request.difficulty}. 유형: ${request.types!.join(", ")}. source_citations에는 source_id만 쓰세요. 선택지가 있으면 모든 선택지에 설명을 제공하세요. 선택지별로 정답이 하나인지 검토하세요. 원문 자료(JSON 데이터):\n${serialized}` }, sourceMap: { [concept.id]: sources }, source_versions: [version("concepts", concept), ...docs.map((row) => version("documents", row)), ...pageVersions], conceptId: concept.id };
}
export async function providerContext(ctx: AuthContext, jobId: string, settings: Settings, master: string, input: TaskInput): Promise<Omit<RouterContext, "rotationIndex">> {
  const rows = await loadProviders(ctx);
  const credentials = checked(await ctx.admin.from("ai_credentials").select("provider").eq("user_id", ctx.user.id));
  const role = input.images?.length ? "vision" : input.kind !== "analyze_problem" ? "generation" : "analysis";
  const choice = settings.modelRoles?.[role]; const selected = choice && modelFor(choice.provider, choice.model);
  return { mode: settings.mode, allowPaid: settings.allow_paid, ...(selected ? { preferredProvider: selected.provider } : {}), providers: (["nvidia", "gemini"] as Provider[]).map((provider) => { const state = providerState(provider, rows.find((row) => row.provider === provider)?.data, credentials.some((row: Json) => row.provider === provider)); return selected?.provider === provider ? { ...state, model: selected.id } : state; }),
    getKey: async (provider) => {
      if (!master) throw new AiError("encryption_not_configured", 503);
      const record = checked(await ctx.admin.from("ai_credentials").select("ciphertext,iv,key_version").eq("user_id", ctx.user.id).eq("provider", provider).maybeSingle());
      if (!record) throw new AiError("credential_not_found", 404); return decryptKey(record, ctx.user.id, provider, master);
    }, updateProvider: async (provider, changes) => {
      const row = checked(await ctx.admin.from("ai_providers").select("data").eq("user_id", ctx.user.id).eq("provider", provider).maybeSingle());
      checked(await ctx.admin.from("ai_providers").upsert({ user_id: ctx.user.id, provider, data: { ...row?.data, ...changes } }, { onConflict: "user_id,provider" }));
    }, log: async (entry) => { checked(await ctx.admin.from("ai_usage_logs").insert({ user_id: ctx.user.id, job_id: jobId, data: entry })); },
  };
}
export function storeFor(ctx: AuthContext): JobStore {
  return {
    claim: async (id, dailyLimit, maxAttempts) => checked(await ctx.admin.rpc("claim_ai_job", { p_user_id: ctx.user.id, p_job_id: id, p_daily_limit: dailyLimit, p_max_attempts: maxAttempts })),
    finish: async (id, token, status, data, availableAt) => {
      const saved = checked(await ctx.admin.rpc("finish_ai_job", { p_user_id: ctx.user.id, p_job_id: id, p_lease_token: token, p_status: status, p_data: data, p_available_at: availableAt }));
      return saved ? { id, status, available_at: availableAt, last_error: data.last_error ?? null } : null;
    }, commit: async (id, token, result) => {
      if(result.standard){const committed=await commitPart(ctx,result.standardJobId,result.standard,false,{id,lease:token});return {...committed,id,status:'completed',review_status:'needs_review'};}
      const saved = checked(await ctx.admin.rpc("commit_ai_result", { p_user_id: ctx.user.id, p_job_id: id, p_lease_token: token, p_result: result }));
      if (saved?.committed) return { ...saved, id, status: "completed", review_status: "needs_review" };
      const current = checked(await ctx.admin.from("ai_jobs").select("id,status,data").eq("user_id", ctx.user.id).eq("id", id).maybeSingle());
      return current ? { id, status: current.status, last_error: current.data?.last_error ?? null } : null;
    },
  };
}
async function enqueuePrepared(prepared: Prepared, request: JobRequest, settings: Settings, ctx: AuthContext, batch?: number): Promise<Job> {
  const key = await cacheKey({ version: analysisVersion, request, input: prepared.input, sourceMap: prepared.sourceMap, batch });
  const existing = checked(await ctx.admin.from("ai_jobs").select("*").eq("user_id", ctx.user.id).eq("cache_key", key).maybeSingle());
  if (existing) return existing;
  const inserted = await ctx.admin.from("ai_jobs").insert({ user_id: ctx.user.id, document_id: prepared.documentId ?? null, problem_id: prepared.problemId ?? null, concept_id: prepared.conceptId ?? null, kind: prepared.input.kind, status: "waiting", cache_key: key, attempts: 0, available_at: new Date().toISOString(), data: { ...prepared, analysis_version: analysisVersion, settings } }).select("*").single();
  if (inserted.error?.code === "23505") return checked(await ctx.admin.from("ai_jobs").select("*").eq("user_id", ctx.user.id).eq("cache_key", key).single());
  return checked(inserted);
}
export async function jobAction(raw: Json, ctx: AuthContext, master: string): Promise<Json> {
  let request: JobRequest;
  try { request = validateRequest(raw); } catch { throw new AiError("invalid_request"); }
  const settings = sanitizeSettings((await readProfile(ctx)).ai_settings);
  if (request.action === "material") {
    const prepared = await prepareMaterialTasks(request, ctx, settings.max_questions);
    const jobs: Job[] = [];
    for (let index = 0; index < prepared.length; index++) jobs.push(await enqueuePrepared(prepared[index], request, settings, ctx, index));
    const summaries = jobs.map((job) => ({ id: job.id, status: job.status, kind: job.kind, attempts: job.attempts, available_at: job.available_at ?? null }));
    const first = jobs.findIndex((job) => job.status !== "completed");
    if (first >= 0) {
      jobs[first].data.settings = settings;
      checked(await ctx.admin.from("ai_jobs").update({ data: jobs[first].data }).eq("user_id", ctx.user.id).eq("id", jobs[first].id).in("status", ["waiting", "paused", "failed", "retry_wait"]));
      const routing = await providerContext(ctx, jobs[first].id, settings, master, jobs[first].data.input);
      summaries[first] = { ...summaries[first], ...await processJob(jobs[first], storeFor(ctx), routing) };
    }
    return { jobs: summaries, queued: summaries.filter((job) => job.status !== "completed").length, completed: summaries.filter((job) => job.status === "completed").length, review_status: "needs_review" };
  }
  let job: Job;
  if (request.action === "status" || request.action === "resume") {
    job = checked(await ctx.admin.from("ai_jobs").select("*").eq("user_id", ctx.user.id).eq("id", request.jobId).maybeSingle());
    if (!job) throw new AiError("job_not_found", 404);
    if (request.action === "status") return { id: job.id, status: job.status, attempts: job.attempts, available_at: job.available_at, last_error: job.data.last_error ?? null };
    // Current policy always takes precedence over the settings snapshot (especially paid off).
    job.data.settings = settings;
    if (["paused", "failed"].includes(job.status)) {
      const resumed = checked(await ctx.admin.from("ai_jobs").update({ status: "waiting", attempts: 0, data: job.data }).eq("user_id", ctx.user.id).eq("id", job.id).in("status", ["paused", "failed"]).select("*").maybeSingle());
      if (resumed) job = resumed;
    }
  } else {
    if (request.count && request.count > settings.max_questions) throw new AiError("question_limit_exceeded");
    const prepared = await prepareTask(request, ctx);
    job = await enqueuePrepared(prepared, request, settings, ctx);
  }
  if (job.status === "completed") return { id: job.id, status: "completed", cached: true };
  job.data.settings = settings;
  checked(await ctx.admin.from("ai_jobs").update({ data: job.data }).eq("user_id", ctx.user.id).eq("id", job.id).in("status", ["waiting", "paused", "failed", "retry_wait"]));
  const routing = await providerContext(ctx, job.id, settings, master, job.data.input);
  return processJob(job, storeFor(ctx), routing);
}
