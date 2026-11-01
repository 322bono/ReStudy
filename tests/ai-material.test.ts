import { describe, expect, it } from "vitest";
import { validateRequest, toCommitResult } from "../supabase/functions/_shared/ai/jobs.ts";
import { prepareMaterialTasks } from "../supabase/functions/_shared/ai/service.ts";
import { validateOutput } from "../supabase/functions/_shared/ai/schemas.ts";
const docA = "00000000-0000-4000-8000-000000000001", docB = "00000000-0000-4000-8000-000000000002";
function fixture() {
  const tables: Record<string, any[]> = {
    documents: [docA, docB].map((id) => ({ id, user_id: "owner-a", subject: "수학", status: "ready", updated_at: "2026-11-01T00:00:00Z", data: { pageCount: 4, title: "테스트 자료" } })),
    document_pages: [docA, docB].flatMap((document_id, index) => [1, 2, 3, 4].map((number) => ({ id: `page-${index}-${number}`, user_id: "owner-a", document_id, number, updated_at: "2026-11-01T00:00:00Z", data: { text: `테스트 ${index} 자료 ${number}쪽 함수 내용`, kind: number === 4 ? "answers" : "content" } }))),
  };
  const db = { from(table: string) {
    let rows = tables[table] ?? [];
    const q: any = { select: () => q, eq: (key: string, value: any) => { rows = rows.filter((row) => row[key] === value); return q; }, in: (key: string, values: any[]) => { rows = rows.filter((row) => values.includes(row[key])); return q; }, order: () => q, limit: () => q, then: (resolve: any, reject: any) => Promise.resolve({ data: rows, error: null }).then(resolve, reject) }; return q;
  } };
  return { tables, ctx: { user: { id: "owner-a" }, db, admin: db } };
}
const request = () => validateRequest({ action: "material", materials: [{ id: docA, pages: "1-4" }, { id: docB, pages: "1-4" }], mode: "memory", type: "전체", difficulty: "보통", count: 6 });
describe("bounded multi-material generation", () => {
  it("accepts the study selection contract and normalizes Korean difficulty", () => {
    expect(request()).toMatchObject({ action: "material", mode: "memory", difficulty: "medium", count: 6 });
  });
  it("snapshots only selected content pages and splits at six pages/five questions", async () => {
    const { ctx } = fixture(); const tasks = await prepareMaterialTasks(request(), ctx);
    expect(tasks).toHaveLength(2);
    expect(tasks.reduce((count: number, task: any) => count + task.input.count, 0)).toBe(6);
    for (const task of tasks) {
      expect(task.input.count).toBeLessThanOrEqual(5); expect(task.input.sourceIds.length).toBeLessThanOrEqual(6);
      expect(task.input.prompt).not.toContain("4쪽");
      expect(task.source_versions.some((v: any) => v.table === "document_pages")).toBe(true);
      const citations = Object.values(task.sourceMap).flat() as any[];
      expect(citations.some((source) => source.materialId === docA)).toBe(true);
      expect(citations.some((source) => source.materialId === docB)).toBe(true);
    }
  });
  it("rejects cross-owner, mixed-subject, reversed and unprocessed ranges", async () => {
    const { ctx, tables } = fixture(); tables.documents[1].user_id = "owner-b";
    await expect(prepareMaterialTasks(request(), ctx)).rejects.toThrow("source_not_found");
    tables.documents[1].user_id = "owner-a"; tables.documents[1].subject = "과학";
    await expect(prepareMaterialTasks(request(), ctx)).rejects.toThrow("mixed_subjects");
    tables.documents[1].subject = "수학";
    await expect(prepareMaterialTasks({ ...request(), materials: [{ id: docA, pages: "3-1" }] }, ctx)).rejects.toThrow("invalid_page_range");
    tables.document_pages = tables.document_pages.filter((row) => row.number !== 2);
    await expect(prepareMaterialTasks(request(), ctx)).rejects.toThrow("page_not_prepared");
  });
  it("creates reviewable concepts and memory items with exact page citations", () => {
    const raw = { concepts: [{ subject: "수학", major: "함수", minor: "", name: "함수", definition: "테스트 정의", properties: [], misconceptions: [], prerequisites: [], source_citations: ["page-a"] }], questions: [{ concept_key: "수학|함수||함수", type: "flashcard", difficulty: "medium", prompt: "테스트 질문", answer: "테스트 답", options: [], explanation: "테스트 해설", misconception_tags: [], source_citations: ["page-a"] }] };
    const output = validateOutput("generate_material" as any, raw, ["page-a"], 1);
    const committed = toCommitResult({ id: "job-a", kind: "generate_material", data: { mode: "memory", sourceMap: { "page-a": [{ materialId: docA, page: 2 }] } } } as any, { status: "succeeded", provider: "gemini", model: "gemini-3.8-flash", duration_ms: 1, usage: {}, output });
    expect(committed.concepts[0]).toMatchObject({ key: "수학|함수||함수", sources: [{ materialId: docA, page: 2 }] });
    expect(committed.items[0]).toMatchObject({ conceptKey: "수학|함수||함수", type: "플래시카드", active: false, modes: ["memory"], sources: [{ materialId: docA, page: 2 }] });
    raw.questions[0].source_citations = ["outside"];
    expect(() => validateOutput("generate_material" as any, raw, ["page-a"], 1)).toThrow();
  });
});
