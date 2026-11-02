import { describe, expect, it } from "vitest";
import { cacheKey, processJob, toCommitResult, validateRequest } from "../supabase/functions/_shared/ai/jobs.ts";
import { prepareTask } from "../supabase/functions/_shared/ai/service.ts";
import { SuccessfulTaskPersistenceError } from "../supabase/functions/_shared/ai/router.ts";

// Isolated job store: exercises dispatch boundaries without any live credentials/database.
const job = (status = "queued") => ({ id: "job-a", user_id: "owner-a", kind: "generate_questions", status, attempts: 0, data: { input: { kind: "generate_questions", prompt: "테스트", sourceIds: ["concept-a"], count: 1 }, sourceMap: { "concept-a": [{ materialId: "doc-a", page: 3 }] }, conceptId: "concept-a", settings: {} } });
describe("bounded persistent jobs", () => {
  it("rejects overlarge problem batches and question counts before dispatch", () => {
    expect(() => validateRequest({ action: "analyze", problemIds: ["a", "b", "c", "d"] })).toThrow();
    expect(() => validateRequest({ action: "generate", conceptId: "x", count: 6 })).toThrow();
    expect(() => validateRequest({ action: "generate", conceptId: "x", count: 0 })).toThrow();
  });
  it("accepts preserved text concept IDs when the generation unit is bounded", () => {
    expect(validateRequest({ action: "generate", conceptId: "legacy-concept-001", count: 2 })).toMatchObject({ conceptId: "legacy-concept-001", count: 2 });
  });
  it("canonicalizes cache input while preserving analysis versions", async () => {
    expect(await cacheKey({ a: 1, b: 2 })).toBe(await cacheKey({ b: 2, a: 1 }));
    expect(await cacheKey({ version: 1 })).not.toBe(await cacheKey({ version: 2 }));
  });
  it("does not run a completed or concurrently leased job", async () => {
    let calls = 0;
    const store = { claim: async () => null, finish: async () => { throw new Error("must not finish"); }, commit: async () => { throw new Error("must not commit"); } };
    const run = async () => { calls++; throw new Error("must not call provider"); };
    expect(await processJob(job("completed") as any, store, {} as any, run)).toMatchObject({ status: "completed" });
    expect(await processJob(job() as any, store, {} as any, run)).toMatchObject({ status: "queued" });
    expect(calls).toBe(0);
  });
  it("preserves failed providers as a resumable job with the exact lease token", async () => {
    const saved: any[] = [];
    const store = { claim: async () => ({ job: { ...job(), status: "running", lease_token: "lease-a" }, rotation_index: 1 }), finish: async (...args: any[]) => { saved.push(args); return { status: "paused" }; }, commit: async () => { throw new Error("must not commit"); } };
    const result = await processJob(job() as any, store, {} as any, async () => ({ status: "paused", reason: "all_providers_failed", retryAt: 2000000 }));
    expect(result).toMatchObject({ status: "paused" });
    expect(saved[0]).toEqual(["job-a", "lease-a", "paused", expect.objectContaining({ last_error: "all_providers_failed" }), new Date(2000000).toISOString()]);
  });
  it('returns a claimed running job while the durable background task waits for inference',async()=>{
    let resolveRun!:(value:any)=>void,background:Promise<unknown>|undefined,committed=false;
    const store={claim:async()=>({job:{...job(),status:'running',lease_token:'lease-a'},rotation_index:0}),finish:async()=>null,commit:async()=>{committed=true;return{status:'completed'};}};
    const result=await processJob(job()as any,store,{}as any,async()=>await new Promise<any>(resolve=>{resolveRun=resolve;}),promise=>{background=promise;});
    expect(result).toMatchObject({id:'job-a',status:'running'});expect(committed).toBe(false);
    resolveRun({status:'succeeded',provider:'gemini',model:'gemini-3.8-flash',duration_ms:1,usage:{},output:{questions:[]}});
    await background;expect(committed).toBe(true);
  });
  it("creates inactive review items with citations derived from owned sources", () => {
    const result = toCommitResult(job() as any, { status: "succeeded", provider: "gemini", model: "gemini-3.8-flash", duration_ms: 5, usage: {}, output: { questions: [{ type: "multiple_choice", difficulty: "medium", prompt: "테스트", answer: "b", explanation: "해설", options: [{ id: "a", text: "1", explanation: "오답" }, { id: "b", text: "2", explanation: "정답" }], misconception_tags: [], source_citations: ["concept-a"] }] } });
    expect(result.items[0]).toMatchObject({ conceptId: "concept-a", active: false, review_status: "needs_review", answer: "2", sources: [{ materialId: "doc-a", page: 3 }] });
  });
  it("reuses a validated checkpoint after a failed content commit", async () => {
    const savedJob = job(); savedJob.data = { ...savedJob.data, pending_result: { status: "succeeded", provider: "gemini", model: "gemini-3.8-flash", duration_ms: 1, usage: {}, output: { questions: [{ type: "short_answer", difficulty: "easy", prompt: "테스트", answer: "2", explanation: "해설", options: [], misconception_tags: [], source_citations: ["concept-a"] }] } } } as any;
    let commits = 0;
    const store = { claim: async () => ({ job: { ...savedJob, lease_token: "lease-a" }, rotation_index: 0 }), finish: async () => null, commit: async () => { commits++; return { status: "completed" }; } };
    expect(await processJob(savedJob as any, store, {} as any, async () => { throw new Error("must not generate again"); })).toMatchObject({ status: "completed" });
    expect(commits).toBe(1);
  });
  it("preserves a completed provider response if provider-status storage fails", async () => {
    let saved: any;
    const completed = { status: "succeeded" as const, provider: "gemini" as const, model: "gemini-3.8-flash", output: { questions: [] }, usage: {}, duration_ms: 1 };
    const store = { claim: async () => ({ job: { ...job(), lease_token: "lease-a" }, rotation_index: 0 }), finish: async (_id: any, _token: any, _status: any, data: any) => { saved = data; return { status: "paused" }; }, commit: async () => null };
    await processJob(job() as any, store, {} as any, async () => { throw new SuccessfulTaskPersistenceError(completed); });
    expect(saved.pending_result).toMatchObject({ status: "succeeded", provider: "gemini" });
  });
});

function sourceDb(tables: Record<string, any[]>) {
  return { from(table: string) {
    let rows = tables[table] ?? [];
    const query: any = { select: () => query, eq: (key: string, value: any) => { rows = rows.filter((row) => row[key] === value); return query; }, in: (key: string, values: any[]) => { rows = rows.filter((row) => values.includes(row[key])); return query; }, order: () => query, limit: () => query, then: (resolve: any, reject: any) => Promise.resolve({ data: rows, error: null }).then(resolve, reject), maybeSingle: async () => ({ data: rows[0] ?? null, error: null }) }; return query;
  } };
}
describe("source ownership before inference", () => {
  const a = "00000000-0000-4000-8000-000000000001"; const b = "00000000-0000-4000-8000-000000000002";
  it("refuses another owner's problem ID even with a service client available", async () => {
    const db = sourceDb({ problems: [{ id: a, user_id: "owner-b", document_id: b, data: { text: "private" } }] });
    await expect(prepareTask({ action: "analyze", problemIds: [a] }, { user: { id: "owner-a" }, db, admin: db })).rejects.toThrow("source_not_found");
  });
  it("checks the owner of every concept citation, not just the concept itself", async () => {
    const db = sourceDb({ concepts: [{ id: "legacy-concept", user_id: "owner-a", data: { definition: "test", sources: [{ materialId: b, page: 1 }] } }], documents: [{ id: b, user_id: "owner-b", data: {} }] });
    await expect(prepareTask({ action: "generate", conceptId: "legacy-concept", count: 1, types: ["short_answer"] }, { user: { id: "owner-a" }, db, admin: db })).rejects.toThrow("source_not_found");
  });
  it("refuses a saved crop path outside the authenticated owner's storage prefix", async () => {
    const db = sourceDb({ problems: [{ id: a, user_id: "owner-a", document_id: b, page: 1, data: { text: "test" } }], documents: [{ id: b, user_id: "owner-a", data: {} }], problem_regions: [{ user_id: "owner-a", problem_id: a, image_path: "owner-b/private.png", page: 1, part: 0 }] });
    await expect(prepareTask({ action: "analyze", problemIds: [a], images: true }, { user: { id: "owner-a" }, db, admin: db })).rejects.toThrow("invalid_saved_crop");
  });
});
