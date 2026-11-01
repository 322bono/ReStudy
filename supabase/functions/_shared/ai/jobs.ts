import { runTask, SuccessfulTaskPersistenceError, type RouterContext, type TaskInput, type TaskResult } from "./router.ts";
import { validateOutput, type Json } from "./schemas.ts";
export type Job = { id: string; user_id: string; kind: string; status: string; attempts: number; lease_token?: string; data: Json; [key: string]: unknown };
export type JobStore = { claim(id: string, dailyLimit: number, maxAttempts: number): Promise<{ job: Job; rotation_index: number } | null>; finish(id: string, token: string, status: string, data: Json, availableAt: string): Promise<any>; commit(id: string, token: string, result: Json): Promise<any> };
function stable(value: any): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); }
export async function cacheKey(value: unknown): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value))); return `ai-v1:${Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("")}`; }
export type JobRequest = { action: "analyze" | "generate" | "material" | "resume" | "status"; problemIds?: string[]; conceptId?: string; documentIds?: string[]; count?: number; difficulty?: string; types?: string[]; requestId?: string; jobId?: string; images?: boolean; materials?: { id: string; pages: string }[]; mode?: "quiz" | "memory" | "check" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validId(value: unknown): value is string { return typeof value === "string" && uuid.test(value); }
function validConceptId(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value); }
export function validateRequest(raw: unknown): JobRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_request");
  const value = raw as Json; const action = value.action;
  if (!["analyze", "generate", "material", "resume", "status"].includes(action)) throw new Error("invalid_request");
  if (action === "resume" || action === "status") { if (!validId(value.jobId)) throw new Error("invalid_request"); return { action, jobId: value.jobId }; }
  if (value.requestId !== undefined && !validId(value.requestId)) throw new Error("invalid_request");
  if (action === "material") {
    if (!Array.isArray(value.materials) || !value.materials.length || value.materials.length > 10 || value.materials.some((material: any) => !material || !validId(material.id) || typeof material.pages !== "string" || material.pages.length > 200) || new Set(value.materials.map((material: any) => material.id)).size !== value.materials.length || !["quiz", "memory", "check"].includes(value.mode) || !Number.isInteger(value.count) || value.count < 1 || value.count > 20) throw new Error("invalid_request");
    const typeMap: Record<string, string> = { "객관식": "multiple_choice", "OX": "true_false", "빈칸": "fill_blank", "단답형": "short_answer", "서술형": "free_response", "플래시카드": "flashcard", "문장 가리기": "masked_sentence" };
    const difficultyMap: Record<string, string> = { "기본": "easy", "보통": "medium", "심화": "hard", easy: "easy", medium: "medium", hard: "hard" };
    const difficulty = difficultyMap[value.difficulty];
    if (!difficulty || typeof value.type !== "string" || value.type !== "전체" && !typeMap[value.type]) throw new Error("invalid_request");
    const types = value.type === "전체" ? value.mode === "memory" ? ["flashcard", "masked_sentence", "fill_blank"] : ["multiple_choice", "true_false", "fill_blank", "short_answer"] : [typeMap[value.type]];
    if (value.mode !== "memory" && types.some((type) => ["flashcard", "masked_sentence"].includes(type)) || value.mode === "memory" && types.some((type) => !["flashcard", "masked_sentence", "fill_blank"].includes(type))) throw new Error("invalid_request");
    return { action, materials: value.materials.map((material: any) => ({ id: material.id, pages: material.pages.trim() })).sort((a: any, b: any) => a.id.localeCompare(b.id)), mode: value.mode, count: value.count, difficulty, types, requestId: value.requestId };
  }
  if (action === "analyze") {
    if (!Array.isArray(value.problemIds) || value.problemIds.length < 1 || value.problemIds.length > 3 || !value.problemIds.every(validId) || new Set(value.problemIds).size !== value.problemIds.length) throw new Error("invalid_request");
    return { action, problemIds: [...value.problemIds].sort(), requestId: value.requestId, images: value.images === true };
  }
  if (!validConceptId(value.conceptId) || !Number.isInteger(value.count) || value.count < 1 || value.count > 5) throw new Error("invalid_request");
  if (value.difficulty !== undefined && !["easy", "medium", "hard"].includes(value.difficulty)) throw new Error("invalid_request");
  const allowedTypes = ["multiple_choice", "true_false", "fill_blank", "short_answer", "free_response", "flashcard", "masked_sentence", "application", "data_interpretation", "condition_judgment", "statement_judgment"];
  if (value.types !== undefined && (!Array.isArray(value.types) || value.types.length < 1 || value.types.length > 8 || !value.types.every((type: unknown) => typeof type === "string" && allowedTypes.includes(type)))) throw new Error("invalid_request");
  if (value.documentIds !== undefined && (!Array.isArray(value.documentIds) || value.documentIds.length < 1 || value.documentIds.length > 10 || !value.documentIds.every(validId))) throw new Error("invalid_request");
  return { action, conceptId: value.conceptId, count: value.count, difficulty: value.difficulty ?? "medium", types: value.types ?? ["multiple_choice"], documentIds: value.documentIds ? [...new Set<string>(value.documentIds)].sort() : undefined, requestId: value.requestId };
}
function sources(job: Job, ids: string[]): Json[] { const result = ids.flatMap((id) => job.data.sourceMap?.[id] ?? []); return [...new Map(result.map((source: Json) => [`${source.materialId}:${source.page}`, source])).values()]; }
export function toCommitResult(job: Job, result: Extract<TaskResult, { status: "succeeded" }>): Json {
  if(job.kind==='restudy_v1')return {standard:result.output,standardJobId:job.data.standardJobId};
  const provenance = { provider: result.provider, model: result.model, job_id: job.id, generated_at: new Date().toISOString(), review_status: "needs_review" };
  const concepts = (result.output.concepts ?? []).map((concept: Json) => ({ ...concept, misconceptions: concept.misconceptions.map((entry: Json, index: number) => ({ id: `ai-${index + 1}`, ...entry })), sources: sources(job, concept.source_citations), ...provenance }));
  if (job.kind === "analyze_problem") return {
    concepts, items: [],
    mappings: result.output.analyses.map((analysis: Json) => ({ questionId: analysis.problem_id, conceptKeys: analysis.concept_keys, analysis: { ...analysis, ...provenance } })), source_versions: job.data.source_versions ?? [],
  };
  const types: Record<string, string> = { multiple_choice: "객관식", true_false: "OX", fill_blank: "빈칸", short_answer: "단답형", free_response: "서술형", flashcard: "플래시카드", masked_sentence: "문장 가리기", application: "객관식", data_interpretation: "객관식", condition_judgment: "객관식", statement_judgment: "객관식" };
  return { concepts, mappings: [], source_versions: job.data.source_versions ?? [], items: result.output.questions.map((q: Json) => {
    const chosen = q.options.find((option: Json) => option.id === q.answer); const answer = chosen?.text ?? q.answer;
    return { ...(job.data.conceptId ? { conceptId: job.data.conceptId } : { conceptKey: q.concept_key }), type: ["application", "data_interpretation", "condition_judgment", "statement_judgment"].includes(q.type) && !q.options.length ? "서술형" : types[q.type] ?? "단답형", original_type: q.type, prompt: q.prompt, choices: q.options.map((option: Json) => option.text), answer, acceptedAnswers: [answer], explanation: q.explanation, choiceFeedback: Object.fromEntries(q.options.map((option: Json) => [option.text, { explanation: option.explanation, misconceptionTag: q.misconception_tags[0] ?? "" }])), correction: q.explanation, difficulty: ({ easy: "기본", medium: "보통", hard: "심화" } as Record<string, string>)[q.difficulty], modes: job.data.mode === "memory" ? ["memory"] : ["quiz", "check"], sources: sources(job, q.source_citations), active: false, verification: q.verification ?? null, ...provenance };
  }) };
}
export async function processJob(job: Job, store: JobStore, routing: Omit<RouterContext, "rotationIndex">, run: typeof runTask = runTask): Promise<any> {
  if (job.status === "completed") return { id: job.id, status: job.status, cached: true, result: job.data.result_summary ?? null };
  const settings = job.data.settings ?? {};
  const claim = await store.claim(job.id, settings.daily_limit ?? 20, settings.max_attempts ?? 3);
  if (!claim) return { id: job.id, status: job.status, available_at: job.available_at ?? null, message: "작업이 실행 중이거나 대기 시간·사용 한도에 도달했습니다." };
  const active = claim.job; const token = active.lease_token!;
  let completed: Extract<TaskResult, { status: "succeeded" }> | undefined;
  try {
    const input = active.data.input as TaskInput;
    let result: TaskResult;
    if (active.data.pending_result?.status === "succeeded") {
      const previous = active.data.pending_result;
      result = { ...previous, output: validateOutput(input.kind, previous.output, input.sourceIds, input.count) };
    } else result = await run(input, { ...routing, rotationIndex: claim.rotation_index });
    if (result.status === "paused") return await store.finish(active.id, token, "paused", { ...active.data, last_error: result.reason,last_provider_error:result.lastError??null }, new Date(result.retryAt ?? Date.now()).toISOString()) ?? { id: active.id, status: "running" };
    completed = result;
    return await store.commit(active.id, token, toCommitResult(active, result)) ?? { id: active.id, status: "running" };
  } catch (error) {
    // A DB/worker error never causes another inference call in this invocation.
    if (error instanceof SuccessfulTaskPersistenceError) completed = error.result;
    return await store.finish(active.id, token, "paused", { ...active.data, ...(completed ? { pending_result: completed } : {}), last_error: "processing_failed" }, new Date().toISOString()) ?? { id: active.id, status: "running" };
  }
}
